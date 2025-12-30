import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { ProtectClient } from './api/client.js';
import { ProtectApiError } from './api/errors.js';
import type { ProtectCamera, ProtectEventPacket } from './api/types.js';
import { CameraAccessory } from './camera-accessory.js';
import type { ControllerConfig, ProtectMotionPlatformConfig } from './settings.js';
import { DEFAULT_MOTION_DURATION, PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export class ProtectMotionPlatform implements DynamicPlatformPlugin {
  public readonly accessories: PlatformAccessory[] = [];
  private readonly configuredAccessories: Map<string, CameraAccessory> = new Map();
  private readonly clients: Map<string, ProtectClient> = new Map();
  private readonly motionDuration: number;
  private readonly debug: boolean;

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

    this.log.info('Initializing platform:', PLATFORM_NAME);

    this.api.on('didFinishLaunching', () => {
      this.debugLog('Finished launching, discovering controllers...');
      this.discoverControllers(platformConfig.controllers ?? []);
    });

    this.api.on('shutdown', () => {
      this.log.info('Shutting down, closing API connections...');
      for (const client of this.clients.values()) {
        client.disconnect();
      }
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
    const client = new ProtectClient(this.log);

    try {
      const success = await client.connect(controller.address, controller.username, controller.password);

      if (!success) {
        return;
      }

      this.clients.set(controller.address, client);

      const cameras = client.cameras;
      if (cameras.length === 0) {
        this.log.warn(`No cameras found on controller ${controller.address}`);
        return;
      }

      this.log.info(`Found ${cameras.length} cameras on ${controller.address}`);
      this.configureCameras(client, cameras, controller.address);

      // Subscribe to real-time events
      client.onMessage((packet: ProtectEventPacket) => {
        this.handleProtectMessage(controller.address, packet);
      });
    } catch (error) {
      if (error instanceof ProtectApiError) {
        if (error.isAuthError) {
          this.log.error(`Authentication failed for ${controller.address}. Check your credentials.`);
        } else {
          this.log.error(`API error for ${controller.address}: ${error.message}`);
        }
      } else {
        this.log.error(`Error connecting to ${controller.address}:`, error);
      }
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
      accessory.context.motionEnabled = accessory.context.motionEnabled ?? true;

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

  private handleProtectMessage(_controllerAddress: string, packet: ProtectEventPacket): void {
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
