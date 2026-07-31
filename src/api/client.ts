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

export class ProtectClient {
  private api: ProtectApi;
  private messageHandlers: MessageHandler[] = [];
  private connected = false;

  // Serializes device writes so a burst (e.g. a HomeKit scene toggling every
  // camera at once) never fans out into dozens of concurrent API calls, which
  // would trip the controller's error throttling.
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly log: Logging) {
    this.api = new ProtectApi();
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

      this.connected = true;

      if (!this.api.isAdminUser) {
        this.log.warn(
          `The account "${username}" is not an admin on ${address}. ` +
            `UniFi Protect requires an admin/full-management account to change LED and motion ` +
            `detection settings, so every such change will fail. Grant this account admin ` +
            `privileges (or use one that has them) to control cameras from HomeKit.`,
        );
      }

      // Set up event listener
      this.api.on('message', (packet: unknown) => {
        this.handleMessage(packet as ProtectEventPacket);
      });

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

  private async performUpdate(
    camera: ProtectCamera,
    payload: object,
    successMessage: string,
  ): Promise<UpdateResult> {
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
    if (this.connected) {
      this.api.reset();
      this.connected = false;
      this.messageHandlers = [];
    }
  }

  private handleMessage(packet: ProtectEventPacket): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(packet);
      } catch (error) {
        this.log.error('Error in message handler:', error);
      }
    }
  }
}
