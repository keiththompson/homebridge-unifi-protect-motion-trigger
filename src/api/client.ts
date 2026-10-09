import type { Logging } from 'homebridge';
import { ProtectApi } from 'unifi-protect';

import { ProtectApiError } from './errors.js';
import type {
  LedSettings,
  MotionSettings,
  ProtectBootstrap,
  ProtectCamera,
  ProtectEventPacket,
  UpdateResult,
} from './types.js';

export type MessageHandler = (packet: ProtectEventPacket) => void;

/** How often the watchdog evaluates the connection, and how often it proactively
 *  re-bootstraps a connection that looks healthy. Both are overridable so tests
 *  can drive the watchdog without real timers. */
export interface ClientOptions {
  healthCheckIntervalMs?: number;
  bootstrapRefreshMs?: number;
}

const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 60_000; // 1 minute
const DEFAULT_BOOTSTRAP_REFRESH_MS = 300_000; // 5 minutes

/** A point-in-time snapshot of a controller connection, surfaced so the platform
 *  can expose it (e.g. to an external monitor) without reaching into internals. */
export interface ClientHealth {
  address: string | null;
  connected: boolean;
  reconnecting: boolean;
  consecutiveFailures: number;
  lastEventAt: number | null;
  lastBootstrapAt: number | null;
  cameras: number;
}

export class ProtectClient {
  private api: ProtectApi;
  private messageHandlers: MessageHandler[] = [];
  private connected = false;

  // The realtime events websocket silently dies on controller reboots, session
  // expiry, or network blips, and nothing re-establishes it on its own. The
  // watchdog below periodically re-bootstraps (which the library documents as
  // reconnecting an expired session and rebuilding the websocket) and falls back
  // to a full re-login, so the plugin heals itself instead of going quiet until
  // Homebridge is manually restarted.
  private readonly healthCheckIntervalMs: number;
  private readonly bootstrapRefreshMs: number;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private reconnecting = false;
  private consecutiveFailures = 0;
  private lastEventAt: number | null = null;
  private lastBootstrapAt: number | null = null;

  // Stored so the watchdog can perform a full re-login when a bootstrap refresh
  // isn't enough to recover.
  private address: string | null = null;
  private username: string | null = null;
  private password: string | null = null;

  // The library keeps EventEmitter listeners across logout()/login(), so the
  // `message` subscription must be attached exactly once or events double-fire.
  private messageSubscribed = false;

  // Serializes device writes so a burst (e.g. a HomeKit scene toggling every
  // camera at once) never fans out into dozens of concurrent API calls, which
  // would trip the controller's error throttling.
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly log: Logging,
    options: ClientOptions = {},
  ) {
    this.api = new ProtectApi();
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this.bootstrapRefreshMs = options.bootstrapRefreshMs ?? DEFAULT_BOOTSTRAP_REFRESH_MS;
  }

  /** True while the underlying API is pausing calls after repeated errors. */
  public get isThrottled(): boolean {
    return this.api.isThrottled;
  }

  /** True if the logged-in account can modify device settings. */
  public get isAdminUser(): boolean {
    return this.api.isAdminUser;
  }

  public async connect(address: string, username: string, password: string): Promise<boolean> {
    try {
      this.log.info(`Connecting to UniFi Protect controller at ${address}...`);

      const loggedIn = await this.api.login(address, username, password);

      if (!loggedIn) {
        throw new ProtectApiError(`Failed to login to controller at ${address}`, 401);
      }

      this.log.info(`Successfully logged in to ${address}`);

      const bootstrapSuccess = await this.api.getBootstrap();
      if (!bootstrapSuccess) {
        throw new ProtectApiError(`Failed to get bootstrap from ${address}`);
      }

      // Remember credentials so the watchdog can re-login if needed.
      this.address = address;
      this.username = username;
      this.password = password;
      this.markConnected();

      if (!this.api.isAdminUser) {
        this.log.warn(
          `The account "${username}" is not an admin on ${address}. ` +
            `UniFi Protect requires an admin/full-management account to change LED and motion ` +
            `detection settings, so every such change will fail. Grant this account admin ` +
            `privileges (or use one that has them) to control cameras from HomeKit.`,
        );
      }

      // Set up event listener (once — survives re-logins).
      this.subscribeToMessages();

      this.startWatchdog();

      return true;
    } catch (error) {
      if (error instanceof ProtectApiError) {
        throw error;
      }
      throw new ProtectApiError(
        `Error connecting to ${address}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  public get bootstrap(): ProtectBootstrap | null {
    if (!this.connected || !this.api.bootstrap) {
      return null;
    }
    return this.api.bootstrap as unknown as ProtectBootstrap;
  }

  public get cameras(): ProtectCamera[] {
    return this.bootstrap?.cameras ?? [];
  }

  public get isConnected(): boolean {
    return this.connected;
  }

  /** A snapshot of this connection's health, for status reporting/monitoring. */
  public get health(): ClientHealth {
    return {
      address: this.address,
      connected: this.connected,
      reconnecting: this.reconnecting,
      consecutiveFailures: this.consecutiveFailures,
      lastEventAt: this.lastEventAt,
      lastBootstrapAt: this.lastBootstrapAt,
      cameras: this.cameras.length,
    };
  }

  public onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  public updateCameraLed(camera: ProtectCamera, enabled: boolean): Promise<UpdateResult> {
    return this.updateCameraSettings(camera, { led: enabled });
  }

  public updateCameraMotionDetection(camera: ProtectCamera, enabled: boolean): Promise<UpdateResult> {
    return this.updateCameraSettings(camera, { motion: enabled });
  }

  /**
   * Applies LED and/or motion detection settings in a single controller request.
   *
   * A scene that toggles both switches on a camera would otherwise fire two separate
   * PATCHes to the same `/cameras/{id}` endpoint; merging them halves the request count.
   */
  public updateCameraSettings(
    camera: ProtectCamera,
    settings: { led?: boolean; motion?: boolean },
  ): Promise<UpdateResult> {
    const payload: { ledSettings?: LedSettings; motionSettings?: MotionSettings } = {};
    const changes: string[] = [];

    if (settings.led !== undefined) {
      payload.ledSettings = { isEnabled: settings.led };
      changes.push(`LED ${settings.led ? 'enabled' : 'disabled'}`);
    }
    if (settings.motion !== undefined) {
      payload.motionSettings = { isEnabled: settings.motion };
      changes.push(`motion detection ${settings.motion ? 'enabled' : 'disabled'}`);
    }

    if (changes.length === 0) {
      return Promise.resolve('ok');
    }

    return this.updateDevice(camera, payload, `${changes.join(', ')} for ${camera.name}`);
  }

  /**
   * Applies a settings payload to a camera, serialized behind {@link writeQueue}.
   *
   * Short-circuits (without hitting the network) when disconnected, when the API is
   * already throttling, or when the account lacks admin rights — so a burst of writes
   * against a throttled/unauthorized controller no longer piles up more failing calls.
   */
  private updateDevice(camera: ProtectCamera, payload: object, successMessage: string): Promise<UpdateResult> {
    const run = this.writeQueue.then(() => this.performUpdate(camera, payload, successMessage));
    // Keep the chain alive regardless of individual outcomes.
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async performUpdate(camera: ProtectCamera, payload: object, successMessage: string): Promise<UpdateResult> {
    if (!this.connected) {
      this.log.error(`Cannot update ${camera.name}: not connected`);
      return 'failed';
    }

    if (this.api.isThrottled) {
      return 'throttled';
    }

    if (!this.api.isAdminUser) {
      return 'unauthorized';
    }

    try {
      const result = await this.api.updateDevice(camera as never, payload as never);

      if (result) {
        this.log.info(successMessage);
        return 'ok';
      }

      // A null result right after a call usually means throttling kicked in.
      return this.api.isThrottled ? 'throttled' : 'failed';
    } catch (error) {
      this.log.error(`Error updating ${camera.name}:`, error);
      return 'failed';
    }
  }

  public disconnect(): void {
    this.stopWatchdog();
    if (this.connected) {
      this.api.reset();
      this.connected = false;
      this.messageHandlers = [];
      this.messageSubscribed = false;
    }
  }

  /**
   * Evaluates the connection and heals it if needed. Runs on the watchdog timer,
   * but is public so it can be invoked directly (e.g. in tests).
   *
   * A healthy connection is re-bootstrapped once it ages past {@link bootstrapRefreshMs}
   * to keep the session and websocket fresh; a connection that is down (or whose
   * refresh fails) triggers a full re-login.
   */
  public async checkConnection(): Promise<void> {
    if (this.reconnecting || !this.address) {
      return;
    }

    const stale = this.lastBootstrapAt === null || Date.now() - this.lastBootstrapAt > this.bootstrapRefreshMs;
    if (this.connected && !stale) {
      return;
    }

    this.reconnecting = true;
    try {
      await this.refreshConnection();
    } finally {
      this.reconnecting = false;
    }
  }

  private async refreshConnection(): Promise<void> {
    try {
      // getBootstrap reconnects an expired session and re-establishes the events
      // websocket, so it recovers the common case without a full re-login.
      const ok = await this.api.getBootstrap();
      if (ok) {
        this.markConnected();
        return;
      }
      this.log.warn(`Bootstrap refresh failed for ${this.address}; attempting a full re-login...`);
      await this.fullReconnect();
    } catch (error) {
      this.recordFailure(error instanceof Error ? error.message : 'unknown error');
    }
  }

  private async fullReconnect(): Promise<void> {
    if (!this.address || !this.username || !this.password) {
      return;
    }

    // Drop the dead session before re-authenticating. Listeners are preserved
    // across logout(), so we don't re-subscribe afterwards.
    this.api.logout();

    const loggedIn = await this.api.login(this.address, this.username, this.password);
    if (!loggedIn) {
      this.recordFailure('re-login rejected credentials or was unreachable');
      return;
    }

    const bootstrapped = await this.api.getBootstrap();
    if (!bootstrapped) {
      this.recordFailure('bootstrap after re-login failed');
      return;
    }

    this.markConnected();
  }

  private markConnected(): void {
    const wasDown = !this.connected;
    this.connected = true;
    this.lastBootstrapAt = Date.now();
    if (wasDown || this.consecutiveFailures > 0) {
      this.log.info(`Connection to ${this.address} is healthy.`);
    }
    this.consecutiveFailures = 0;
  }

  private recordFailure(reason: string): void {
    this.connected = false;
    this.consecutiveFailures += 1;
    this.log.warn(
      `UniFi Protect connection to ${this.address} is down (attempt ${this.consecutiveFailures}): ${reason}. ` +
        `Will retry in ${Math.round(this.healthCheckIntervalMs / 1000)}s.`,
    );
  }

  private startWatchdog(): void {
    if (this.watchdog) {
      return;
    }
    this.watchdog = setInterval(() => {
      void this.checkConnection();
    }, this.healthCheckIntervalMs);
    // Don't keep the Node process alive solely for this timer.
    this.watchdog.unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private subscribeToMessages(): void {
    if (this.messageSubscribed) {
      return;
    }
    this.messageSubscribed = true;
    this.api.on('message', (packet: unknown) => {
      this.handleMessage(packet as ProtectEventPacket);
    });
  }

  private handleMessage(packet: ProtectEventPacket): void {
    // Any realtime packet proves the websocket is alive.
    this.lastEventAt = Date.now();
    for (const handler of this.messageHandlers) {
      try {
        handler(packet);
      } catch (error) {
        this.log.error('Error in message handler:', error);
      }
    }
  }
}
