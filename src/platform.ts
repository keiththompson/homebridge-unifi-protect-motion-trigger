import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { ProtectClient } from './api/client.js';
import { ProtectApiError } from './api/errors.js';
import { smartDetectConfigActive } from './api/smart-detect.js';
import type { ProtectCamera, ProtectEventPacket } from './api/types.js';
import { CameraAccessory } from './camera-accessory.js';
import type { HealthControllerInput, PluginHealth } from './health.js';
import { buildHealthReport, HEALTH_SESSION_LOST_ERROR, toPersistedHealth, writeHealthFileAtomic } from './health.js';
import type { ControllerConfig, ProtectMotionPlatformConfig } from './settings.js';
import {
  DEFAULT_MOTION_DURATION,
  HEALTH_WRITE_INTERVAL_MS,
  PLATFORM_NAME,
  PLUGIN_NAME,
  PLUGIN_VERSION,
} from './settings.js';
import { SmartDetectSnapshotStore } from './smart-detect-store.js';

interface ControllerSession {
  client: ProtectClient;
  connected: boolean;
  /** Fixed phrase safe for health output. Never a credential. */
  lastError: string | null;
  reconnecting: boolean;
  consecutiveFailures: number;
  lastEventAt: number | null;
  lastBootstrapAt: number | null;
}

export class ProtectMotionPlatform implements DynamicPlatformPlugin {
  public readonly accessories: PlatformAccessory[] = [];
  private readonly configuredAccessories: Map<string, CameraAccessory> = new Map();
  private readonly sessions = new Map<string, ControllerSession>();
  private readonly motionDuration: number;
  private readonly debug: boolean;
  public readonly showSmartDetection: boolean;
  private healthWriter: ReturnType<typeof setInterval> | null = null;
  private readonly smartDetectStore = new SmartDetectSnapshotStore(() => this.healthStoragePath(), {
    warn: (message: string) => {
      this.log.warn(message);
    },
  });

  public get Service(): typeof this.api.hap.Service {
    return this.api.hap.Service;
  }

  public get Characteristic(): typeof this.api.hap.Characteristic {
    return this.api.hap.Characteristic;
  }

  constructor(
    public readonly log: Logging,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    const platformConfig = config as ProtectMotionPlatformConfig;
    this.motionDuration = platformConfig.motionDuration ?? DEFAULT_MOTION_DURATION;
    this.debug = platformConfig.debug ?? false;
    this.showSmartDetection = platformConfig.showSmartDetection !== false;

    this.log.info('Initializing platform:', PLATFORM_NAME);

    this.api.on('didFinishLaunching', () => {
      this.debugLog('Finished launching, discovering controllers...');
      void this.discoverControllers(platformConfig.controllers ?? []).then(() => {
        this.startHealthReporting();
      });
    });

    this.api.on('shutdown', () => {
      this.log.info('Shutting down, closing API connections...');
      this.stopHealthReporting();
      for (const session of this.sessions.values()) {
        session.client.disconnect();
        session.connected = false;
      }
      this.persistHealthFile();
    });
  }

  /**
   * Health snapshot for routine checks.
   * `refresh` re-reads each camera with GET and does not change camera settings.
   * The document has no usernames, passwords, or tokens.
   */
  public async getHealth(options?: { refresh?: boolean; now?: number }): Promise<PluginHealth> {
    const now = options?.now ?? Date.now();
    if (options?.refresh) {
      for (const [address, session] of this.sessions) {
        if (!session.connected) {
          continue;
        }
        for (const camera of this.refreshTargets(address, session.client)) {
          await session.client.refreshCamera(camera);
        }
      }
    }

    const controllers: HealthControllerInput[] = [];
    for (const [address, session] of this.sessions) {
      this.syncSessionHealth(session);
      const live = session.connected && session.client.hasLiveSession;
      controllers.push({
        address,
        connected: live,
        throttled: session.connected ? session.client.isThrottled : false,
        admin: live ? session.client.isAdminUser : null,
        lastError: session.lastError,
        cameras: this.healthCameras(address, session.client),
      });
    }

    return buildHealthReport({
      pluginVersion: PLUGIN_VERSION,
      generatedAt: now,
      controllers,
    });
  }

  public configureAccessory(accessory: PlatformAccessory): void {
    this.debugLog(`Loading accessory from cache: ${accessory.displayName}`);
    this.accessories.push(accessory);
  }

  private async discoverControllers(controllers: ControllerConfig[]): Promise<void> {
    if (!controllers || controllers.length === 0) {
      this.log.warn('No controllers configured. Please add a controller in the config.');
      return;
    }

    for (const controller of controllers) {
      if (!this.validateControllerConfig(controller)) {
        continue;
      }

      await this.connectToController(controller);
    }
  }

  private validateControllerConfig(controller: ControllerConfig): boolean {
    if (!controller.address) {
      this.log.error('Controller configuration missing address');
      return false;
    }
    if (!controller.username) {
      this.log.error('Controller configuration missing username');
      return false;
    }
    if (!controller.password) {
      this.log.error('Controller configuration missing password');
      return false;
    }
    return true;
  }

  private async connectToController(controller: ControllerConfig): Promise<void> {
    const client = new ProtectClient(this.log, {
      onHealthChange: () => {
        this.persistHealthFile();
      },
      smartDetectStore: this.smartDetectStore,
      controllerAddress: controller.address,
    });

    try {
      const success = await client.connect(controller.address, controller.username, controller.password);

      if (!success) {
        this.rememberSession(controller.address, {
          client,
          connected: false,
          lastError: 'connection failed',
        });
        this.persistHealthFile();
        return;
      }

      this.rememberSession(controller.address, {
        client,
        connected: true,
        lastError: null,
        reconnecting: false,
        consecutiveFailures: 0,
        lastBootstrapAt: Date.now(),
      });

      const cameras = client.cameras;
      if (cameras.length === 0) {
        this.log.warn(`No cameras found on controller ${controller.address}`);
        this.persistHealthFile();
        return;
      }

      this.log.info(`Found ${cameras.length} cameras on ${controller.address}`);
      this.configureCameras(client, cameras, controller.address);

      // Subscribe to real-time events
      client.onMessage((packet: ProtectEventPacket) => {
        this.handleProtectMessage(controller.address, packet);
      });
      this.persistHealthFile();
    } catch (error) {
      const authenticationFailed = error instanceof ProtectApiError && error.isAuthError;
      this.rememberSession(controller.address, {
        client,
        connected: false,
        lastError: authenticationFailed ? 'authentication failed' : 'connection failed',
      });
      if (authenticationFailed) {
        this.log.error(`Authentication failed for ${controller.address}. Check your credentials.`);
      } else if (error instanceof ProtectApiError) {
        this.log.error(`API error for ${controller.address}: ${error.message}`);
      } else {
        this.log.error(`Error connecting to ${controller.address}:`, error);
      }
      this.persistHealthFile();
    }
  }

  private rememberSession(
    address: string,
    patch: Partial<ControllerSession> & Pick<ControllerSession, 'client' | 'connected' | 'lastError'>,
  ): void {
    const previous = this.sessions.get(address);
    const failed = !patch.connected;
    this.sessions.set(address, {
      client: patch.client,
      connected: patch.connected,
      lastError: patch.lastError,
      reconnecting: patch.reconnecting ?? previous?.reconnecting ?? false,
      consecutiveFailures:
        patch.consecutiveFailures ??
        (failed ? (previous?.consecutiveFailures ?? 0) + 1 : (previous?.consecutiveFailures ?? 0)),
      lastEventAt: patch.lastEventAt ?? previous?.lastEventAt ?? null,
      lastBootstrapAt: patch.lastBootstrapAt ?? previous?.lastBootstrapAt ?? null,
    });
  }

  private smartDetectSnapshot(
    address: string,
    cameraId: string,
    accessory: CameraAccessory | undefined,
  ): HealthControllerInput['cameras'][number]['smartDetectSnapshot'] {
    return this.smartDetectStore.get(address, cameraId) ?? accessory?.savedSmartDetectConfig ?? null;
  }

  /**
   * A lost session clears the live bootstrap, which used to report zero cameras.
   * Configured accessories keep the camera list and the last readback.
   */
  private healthCameras(address: string, client: ProtectClient): HealthControllerInput['cameras'] {
    const known: Array<{ id: string; name: string }> = [];
    const seen = new Set<string>();
    const push = (id: string, name: string): void => {
      if (!id || seen.has(id)) {
        return;
      }
      seen.add(id);
      known.push({ id, name });
    };
    for (const camera of client.cameras) {
      push(camera.id, camera.name);
    }
    for (const accessory of this.accessories) {
      if (accessory.context.controllerAddress !== address) {
        continue;
      }
      const camera = accessory.context.camera as Partial<ProtectCamera> | undefined;
      if (!camera?.id) {
        continue;
      }
      push(camera.id, camera.name || accessory.displayName);
    }
    return known.map(({ id, name }) => {
      const accessory = this.configuredAccessories.get(id);
      const smartDetectSnapshot = this.smartDetectSnapshot(address, id, accessory);
      return {
        id,
        name,
        intendedMotionEnabled: accessory ? accessory.motionEnabledState : null,
        smartDetectPreferencesSaved: smartDetectConfigActive(smartDetectSnapshot),
        intendedSmartDetect: accessory ? accessory.smartDetectState : null,
        smartDetectSnapshot,
        snapshot: client.getCameraSnapshot(id),
      };
    });
  }

  private refreshTargets(address: string, client: ProtectClient): ProtectCamera[] {
    if (client.cameras.length > 0) {
      return client.cameras;
    }
    const cameras: ProtectCamera[] = [];
    for (const accessory of this.accessories) {
      if (accessory.context.controllerAddress !== address) {
        continue;
      }
      const camera = accessory.context.camera as ProtectCamera | undefined;
      if (camera?.id) {
        cameras.push(camera);
      }
    }
    return cameras;
  }

  /** Reflects a dropped bootstrap or events websocket without counting it on every read. */
  private syncSessionHealth(session: ControllerSession): void {
    if (!session.connected) {
      return;
    }
    const live = session.client.hasLiveSession;
    const recoveredAt = session.client.lastSessionRecoveryAt;
    if (recoveredAt !== null && (session.lastBootstrapAt === null || recoveredAt > session.lastBootstrapAt)) {
      session.lastBootstrapAt = recoveredAt;
    }
    if (!live) {
      if (session.lastError !== HEALTH_SESSION_LOST_ERROR) {
        session.consecutiveFailures += 1;
      }
      session.lastError = HEALTH_SESSION_LOST_ERROR;
      session.reconnecting = true;
      if (session.client.consecutiveRecoveryFailures > session.consecutiveFailures) {
        session.consecutiveFailures = session.client.consecutiveRecoveryFailures;
      }
      return;
    }
    if (session.reconnecting || session.lastError === HEALTH_SESSION_LOST_ERROR) {
      session.lastError = null;
      session.reconnecting = false;
      session.consecutiveFailures = 0;
    }
  }

  private configureCameras(client: ProtectClient, cameras: ProtectCamera[], controllerAddress: string): void {
    for (const camera of cameras) {
      const uuid = this.api.hap.uuid.generate(`${controllerAddress}:${camera.id}`);

      let accessory = this.accessories.find((acc) => acc.UUID === uuid);
      const isNew = !accessory;

      if (!accessory) {
        this.log.info(`Adding new camera: ${camera.name}`);
        accessory = new this.api.platformAccessory(camera.name, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
      } else {
        this.debugLog(`Restoring existing camera: ${camera.name}`);
      }

      accessory.context.camera = camera;
      accessory.context.controllerAddress = controllerAddress;

      const cameraAccessory = new CameraAccessory(this, accessory, client, this.motionDuration);

      this.configuredAccessories.set(camera.id, cameraAccessory);

      if (!isNew) {
        this.api.updatePlatformAccessories([accessory]);
      }
    }

    this.removeStaleAccessories(cameras, controllerAddress);
  }

  private removeStaleAccessories(cameras: ProtectCamera[], controllerAddress: string): void {
    const validUUIDs = new Set(
      cameras.map((camera) => this.api.hap.uuid.generate(`${controllerAddress}:${camera.id}`)),
    );

    const accessoriesToRemove = this.accessories.filter(
      (acc) => acc.context.controllerAddress === controllerAddress && !validUUIDs.has(acc.UUID),
    );

    if (accessoriesToRemove.length > 0) {
      this.log.info(`Removing ${accessoriesToRemove.length} stale accessories`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessoriesToRemove);
      for (const acc of accessoriesToRemove) {
        const index = this.accessories.indexOf(acc);
        if (index > -1) {
          this.accessories.splice(index, 1);
        }
      }
    }
  }

  private handleProtectMessage(controllerAddress: string, packet: ProtectEventPacket): void {
    if (!packet.action || !packet.payload) {
      return;
    }

    const { action, modelKey, id } = packet.action;

    if (modelKey !== 'camera' || action !== 'update') {
      return;
    }

    const cameraAccessory = this.configuredAccessories.get(id);
    if (!cameraAccessory) {
      return;
    }

    const cameraPayload = packet.payload;
    const session = this.sessions.get(controllerAddress);
    let settingsChanged = false;

    // Check for motion update
    if (cameraPayload.lastMotion !== undefined) {
      this.debugLog(`Motion detected on camera ${id}`);
      cameraAccessory.handleMotionEvent(cameraPayload.lastMotion);
      if (session) {
        session.lastEventAt = Date.now();
      }
    }

    // Check for LED settings update
    if (cameraPayload.ledSettings !== undefined) {
      this.debugLog(`LED settings updated on camera ${id}`);
      cameraAccessory.handleLedSettingsUpdate(cameraPayload.ledSettings);
      settingsChanged = true;
    }

    // Sensor-shaped motionSettings is ignored. Create Motion Events arrives as recordingSettings.
    if (typeof cameraPayload.recordingSettings?.enableMotionDetection === 'boolean') {
      this.debugLog(`Create Motion Events updated on camera ${id}`);
      cameraAccessory.handleCreateMotionEventsUpdate(cameraPayload.recordingSettings.enableMotionDetection);
      settingsChanged = true;
    }

    if (
      cameraPayload.smartDetectSettings ||
      cameraPayload.smartDetectZones ||
      cameraPayload.secondLensSmartDetectZones
    ) {
      this.debugLog(`Smart detection updated on camera ${id}`);
      cameraAccessory.handleSmartDetectUpdate(cameraPayload);
      settingsChanged = true;
    }

    if (settingsChanged) {
      if (session) {
        session.lastEventAt = Date.now();
      }
      this.persistHealthFile();
    }
  }

  private startHealthReporting(): void {
    if (this.healthWriter) {
      return;
    }
    this.persistHealthFile();
    if (!this.healthStoragePath()) {
      return;
    }
    this.healthWriter = setInterval(() => {
      this.persistHealthFile();
    }, HEALTH_WRITE_INTERVAL_MS);
    this.healthWriter.unref?.();
  }

  private stopHealthReporting(): void {
    if (this.healthWriter) {
      clearInterval(this.healthWriter);
      this.healthWriter = null;
    }
  }

  private healthStoragePath(): string | undefined {
    const storagePath = this.api.user?.storagePath?.();
    return storagePath || undefined;
  }

  private healthCompat(): Record<
    string,
    { reconnecting: boolean; consecutiveFailures: number; lastEventAt: string | null; lastBootstrapAt: string | null }
  > {
    const toIso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
    const compat: Record<
      string,
      { reconnecting: boolean; consecutiveFailures: number; lastEventAt: string | null; lastBootstrapAt: string | null }
    > = {};
    for (const [address, session] of this.sessions) {
      compat[address] = {
        reconnecting: session.reconnecting,
        consecutiveFailures: session.consecutiveFailures,
        lastEventAt: toIso(session.lastEventAt),
        lastBootstrapAt: toIso(session.lastBootstrapAt),
      };
    }
    return compat;
  }

  /**
   * Flushes an aggregated health snapshot to the Homebridge storage dir.
   * Best-effort: failures (or a host API without a storage path, as in tests)
   * are swallowed so monitoring never affects the plugin's operation.
   */
  private persistHealthFile(): void {
    void this.flushHealthFile();
  }

  private async flushHealthFile(): Promise<void> {
    const storagePath = this.healthStoragePath();
    if (!storagePath) {
      return;
    }
    try {
      const now = Date.now();
      const health = await this.getHealth({ now });
      writeHealthFileAtomic(storagePath, toPersistedHealth(health, now, this.healthCompat()));
    } catch (error) {
      this.debugLog(`Could not write health file: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  public debugLog(message: string, ...args: unknown[]): void {
    if (this.debug) {
      this.log.debug(message, ...args);
    }
  }
}
