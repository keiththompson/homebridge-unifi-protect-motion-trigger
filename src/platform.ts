import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';
import { ProtectApi } from 'unifi-protect';

import { PLATFORM_NAME, PLUGIN_NAME, DEFAULT_MOTION_DURATION } from './settings.js';
import type { ProtectMotionPlatformConfig, ControllerConfig } from './settings.js';
import { CameraAccessory } from './camera-accessory.js';

interface ProtectCamera {
  id: string;
  name: string;
  type: string;
  mac: string;
  host: string;
  lastMotion: number | null;
  ledSettings?: {
    isEnabled: boolean;
    blinkRate: number;
  };
}

interface ProtectBootstrap {
  cameras: ProtectCamera[];
  lastUpdateId: string;
}

export class ProtectMotionPlatform implements DynamicPlatformPlugin {
  public readonly accessories: PlatformAccessory[] = [];
  private readonly configuredAccessories: Map<string, CameraAccessory> = new Map();

  private protectApis: Map<string, ProtectApi> = new Map();
  private readonly motionDuration: number;
  private readonly debug: boolean;

  public get Service() {
    return this.api.hap.Service;
  }

  public get Characteristic() {
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

    this.log.info('Initializing platform:', PLATFORM_NAME);

    this.api.on('didFinishLaunching', () => {
      this.debugLog('Finished launching, discovering controllers...');
      this.discoverControllers(platformConfig.controllers ?? []);
    });

    this.api.on('shutdown', () => {
      this.log.info('Shutting down, closing API connections...');
      for (const protectApi of this.protectApis.values()) {
        protectApi.reset();
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.debugLog(`Loading accessory from cache: ${accessory.displayName}`);
    this.accessories.push(accessory);
  }

  private async discoverControllers(controllers: ControllerConfig[]): Promise<void> {
    if (!controllers || controllers.length === 0) {
      this.log.warn('No controllers configured. Please add a controller in the config.');
      return;
    }

    for (const controller of controllers) {
      if (!controller.address || !controller.username || !controller.password) {
        this.log.warn('Skipping controller with missing credentials');
        continue;
      }

      await this.connectToController(controller);
    }
  }

  private async connectToController(controller: ControllerConfig): Promise<void> {
    this.log.info(`Connecting to UniFi Protect controller at ${controller.address}...`);

    const protectApi = new ProtectApi();

    try {
      const loggedIn = await protectApi.login(
        controller.address,
        controller.username,
        controller.password,
      );

      if (!loggedIn) {
        this.log.error(`Failed to login to controller at ${controller.address}`);
        return;
      }

      this.log.info(`Successfully logged in to ${controller.address}`);
      this.protectApis.set(controller.address, protectApi);

      const bootstrapSuccess = await protectApi.getBootstrap();
      if (!bootstrapSuccess) {
        this.log.error(`Failed to get bootstrap from ${controller.address}`);
        return;
      }

      const bootstrap = protectApi.bootstrap as unknown as ProtectBootstrap;
      if (!bootstrap?.cameras) {
        this.log.warn(`No cameras found on controller ${controller.address}`);
        return;
      }

      this.log.info(`Found ${bootstrap.cameras.length} cameras on ${controller.address}`);
      this.configureCameras(protectApi, bootstrap.cameras, controller.address);

      // Subscribe to real-time events
      protectApi.on('message', (packet: unknown) => {
        this.handleProtectMessage(controller.address, packet);
      });

    } catch (error) {
      this.log.error(`Error connecting to ${controller.address}:`, error);
    }
  }

  private configureCameras(
    protectApi: ProtectApi,
    cameras: ProtectCamera[],
    controllerAddress: string,
  ): void {
    for (const camera of cameras) {
      const uuid = this.api.hap.uuid.generate(`${controllerAddress}:${camera.id}`);

      let accessory = this.accessories.find(acc => acc.UUID === uuid);
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
      accessory.context.motionEnabled = accessory.context.motionEnabled ?? true;

      const cameraAccessory = new CameraAccessory(
        this,
        accessory,
        protectApi,
        this.motionDuration,
      );

      this.configuredAccessories.set(camera.id, cameraAccessory);

      if (!isNew) {
        this.api.updatePlatformAccessories([accessory]);
      }
    }

    // Remove accessories that no longer exist
    const validUUIDs = new Set(
      cameras.map(camera => this.api.hap.uuid.generate(`${controllerAddress}:${camera.id}`))
    );

    const accessoriesToRemove = this.accessories.filter(
      acc =>
        acc.context.controllerAddress === controllerAddress &&
        !validUUIDs.has(acc.UUID)
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

  private handleProtectMessage(controllerAddress: string, packet: unknown): void {
    const payload = packet as {
      action?: { action: string; modelKey: string; id: string };
      payload?: ProtectCamera;
    };

    if (!payload.action || !payload.payload) {
      return;
    }

    const { action, modelKey, id } = payload.action;

    if (modelKey !== 'camera' || action !== 'update') {
      return;
    }

    const cameraAccessory = this.configuredAccessories.get(id);
    if (!cameraAccessory) {
      return;
    }

    const cameraPayload = payload.payload;

    // Check for motion update
    if (cameraPayload.lastMotion !== undefined) {
      this.debugLog(`Motion detected on camera ${id}`);
      cameraAccessory.handleMotionEvent(cameraPayload.lastMotion);
    }

    // Check for LED settings update
    if (cameraPayload.ledSettings !== undefined) {
      this.debugLog(`LED settings updated on camera ${id}`);
      cameraAccessory.handleLedSettingsUpdate(cameraPayload.ledSettings);
    }
  }

  public debugLog(message: string, ...args: unknown[]): void {
    if (this.debug) {
      this.log.debug(message, ...args);
    }
  }
}
