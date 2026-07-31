import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { ProtectClient } from './api/client.js';
import type { LedSettings, ProtectCamera, UpdateResult } from './api/types.js';
import type { ProtectMotionPlatform } from './platform.js';

// Window over which a camera's LED and motion writes are coalesced into one request.
// A scene fires both switches' onSet handlers in the same tick, so a short window
// captures them together while staying imperceptible to HomeKit.
const BATCH_WINDOW_MS = 50;

export class CameraAccessory {
  private readonly motionSensor: Service;
  private readonly motionSwitch: Service;
  private readonly ledSwitch: Service;

  private motionTimeout: NodeJS.Timeout | null = null;
  private lastMotionTime = 0;
  private motionDetected = false;
  private ledEnabled: boolean;

  // Pending switch changes awaiting a coalesced flush.
  private pendingLed?: boolean;
  private pendingMotion?: boolean;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> | null = null;
  private flushResolve: (() => void) | null = null;

  constructor(
    private readonly platform: ProtectMotionPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: ProtectClient,
    private readonly motionDuration: number,
  ) {
    const camera = this.camera;
    this.ledEnabled = camera.ledSettings?.isEnabled ?? true;

    // Initialize motion enabled state from camera's actual settings
    const motionEnabled = camera.motionSettings?.isEnabled ?? true;
    this.isMotionEnabled = motionEnabled;

    this.configureAccessoryInformation(camera);
    this.motionSensor = this.configureMotionSensor();
    this.motionSwitch = this.configureMotionSwitch();
    this.ledSwitch = this.configureLedSwitch();

    // Set initial values
    this.updateMotionSensorState(false);
    this.updateMotionSwitchState(motionEnabled);
    this.updateLedSwitchState(this.ledEnabled);
  }

  private get camera(): ProtectCamera {
    return this.accessory.context.camera as ProtectCamera;
  }

  private get isMotionEnabled(): boolean {
    return this.accessory.context.motionEnabled ?? true;
  }

  private set isMotionEnabled(value: boolean) {
    this.accessory.context.motionEnabled = value;
  }

  private configureAccessoryInformation(camera: ProtectCamera): void {
    const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation);
    if (infoService) {
      infoService
        .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ubiquiti')
        .setCharacteristic(this.platform.Characteristic.Model, camera.type || 'UniFi Camera')
        .setCharacteristic(this.platform.Characteristic.SerialNumber, camera.mac || camera.id);
    }
  }

  private configureMotionSensor(): Service {
    const service = this.getOrAddService(this.platform.Service.MotionSensor, 'Motion', 'motion-sensor');

    service.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
    service.setCharacteristic(this.platform.Characteristic.ConfiguredName, 'Motion');

    service.getCharacteristic(this.platform.Characteristic.MotionDetected).onGet(() => this.motionDetected);

    service.getCharacteristic(this.platform.Characteristic.StatusActive).onGet(() => this.isMotionEnabled);

    return service;
  }

  private configureMotionSwitch(): Service {
    const service = this.getOrAddService(this.platform.Service.Switch, 'Motion Enabled', 'motion-switch');

    service.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
    service.setCharacteristic(this.platform.Characteristic.ConfiguredName, 'Motion Enabled');

    service
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.isMotionEnabled)
      .onSet(this.setMotionEnabled.bind(this));

    return service;
  }

  private configureLedSwitch(): Service {
    const service = this.getOrAddService(this.platform.Service.Switch, 'Status LED', 'led-switch');

    service.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
    service.setCharacteristic(this.platform.Characteristic.ConfiguredName, 'Status LED');

    service
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.ledEnabled)
      .onSet(this.setLedEnabled.bind(this));

    return service;
  }

  private getOrAddService(
    serviceType: typeof this.platform.Service.MotionSensor | typeof this.platform.Service.Switch,
    displayName: string,
    subtype: string,
  ): Service {
    const existingService = this.accessory.getServiceById(serviceType, subtype);
    if (existingService) {
      existingService.setCharacteristic(this.platform.Characteristic.Name, displayName);
      return existingService;
    }
    return this.accessory.addService(serviceType, displayName, subtype);
  }

  private setMotionEnabled(value: CharacteristicValue): Promise<void> {
    this.pendingMotion = value as boolean;
    return this.scheduleFlush();
  }

  private setLedEnabled(value: CharacteristicValue): Promise<void> {
    this.pendingLed = value as boolean;
    return this.scheduleFlush();
  }

  /**
   * Opens (or joins) a short coalescing window and returns a promise HomeKit awaits.
   * The first pending change starts the window; further changes on either switch
   * within it share the same flush.
   */
  private scheduleFlush(): Promise<void> {
    if (!this.flushPromise) {
      this.flushPromise = new Promise<void>((resolve) => {
        this.flushResolve = resolve;
      });
      this.flushTimer = setTimeout(() => {
        void this.flush();
      }, BATCH_WINDOW_MS);
    }
    return this.flushPromise;
  }

  private async flush(): Promise<void> {
    const resolve = this.flushResolve;
    const led = this.pendingLed;
    const motion = this.pendingMotion;
    this.flushTimer = null;
    this.flushPromise = null;
    this.flushResolve = null;
    this.pendingLed = undefined;
    this.pendingMotion = undefined;

    // Only send settings that actually differ from the current state. HomeKit
    // re-syncs and scenes routinely set the value that is already active.
    const settings: { led?: boolean; motion?: boolean } = {};
    if (led !== undefined && led !== this.ledEnabled) {
      settings.led = led;
    }
    if (motion !== undefined && motion !== this.isMotionEnabled) {
      settings.motion = motion;
    }

    try {
      if (settings.led === undefined && settings.motion === undefined) {
        return;
      }

      this.platform.debugLog(`Applying settings for ${this.camera.name}: ${JSON.stringify(settings)}`);
      const result = await this.client.updateCameraSettings(this.camera, settings);

      if (result === 'ok') {
        this.applySettings(settings);
      } else {
        this.revertSettings(settings, result);
      }
    } finally {
      resolve?.();
    }
  }

  private applySettings(settings: { led?: boolean; motion?: boolean }): void {
    if (settings.led !== undefined) {
      this.ledEnabled = settings.led;
    }
    if (settings.motion !== undefined) {
      this.isMotionEnabled = settings.motion;
      this.motionSensor.updateCharacteristic(this.platform.Characteristic.StatusActive, settings.motion);

      // If motion is disabled and currently detecting, clear it
      if (!settings.motion && this.motionDetected) {
        this.clearMotion();
      }
    }
  }

  private revertSettings(settings: { led?: boolean; motion?: boolean }, result: UpdateResult): void {
    const labels: string[] = [];
    if (settings.led !== undefined) {
      labels.push('LED');
    }
    if (settings.motion !== undefined) {
      labels.push('motion detection');
    }
    this.warnUpdateFailure(labels.join(' and '), result);

    // Revert whichever switches we attempted to change.
    setTimeout(() => {
      if (settings.led !== undefined) {
        this.ledSwitch.updateCharacteristic(this.platform.Characteristic.On, this.ledEnabled);
      }
      if (settings.motion !== undefined) {
        this.motionSwitch.updateCharacteristic(this.platform.Characteristic.On, this.isMotionEnabled);
      }
    }, 100);
  }

  private warnUpdateFailure(setting: string, result: UpdateResult): void {
    switch (result) {
      case 'throttled':
        this.platform.log.warn(
          `Unable to update ${setting} for ${this.camera.name}: the Protect API is paused after ` +
            `repeated errors. It will resume automatically; no action needed.`,
        );
        break;
      case 'unauthorized':
        this.platform.log.warn(
          `Unable to update ${setting} for ${this.camera.name}: the configured account is not a ` +
            `Protect admin and cannot change device settings.`,
        );
        break;
      default:
        this.platform.log.warn(
          `Unable to update ${setting} for ${this.camera.name}. The Protect API may be unreachable. ` +
            `If this persists, restart Homebridge.`,
        );
    }
  }

  public handleMotionEvent(lastMotion: number | null): void {
    if (lastMotion === null) {
      return;
    }

    // Check if this is a new motion event
    if (lastMotion <= this.lastMotionTime) {
      return;
    }

    this.lastMotionTime = lastMotion;

    // Only trigger if motion is enabled
    if (!this.isMotionEnabled) {
      this.platform.debugLog(`Motion detected but disabled for ${this.camera.name}, ignoring`);
      return;
    }

    this.platform.log.info(`Motion detected on ${this.camera.name}`);
    this.triggerMotion();
  }

  private triggerMotion(): void {
    // Clear any existing timeout
    if (this.motionTimeout) {
      clearTimeout(this.motionTimeout);
      this.motionTimeout = null;
    }

    // Set motion detected
    this.updateMotionSensorState(true);

    // Set timeout to clear motion
    this.motionTimeout = setTimeout(() => {
      this.clearMotion();
    }, this.motionDuration * 1000);
  }

  private clearMotion(): void {
    if (this.motionTimeout) {
      clearTimeout(this.motionTimeout);
      this.motionTimeout = null;
    }
    this.updateMotionSensorState(false);
  }

  private updateMotionSensorState(detected: boolean): void {
    this.motionDetected = detected;
    this.motionSensor.updateCharacteristic(this.platform.Characteristic.MotionDetected, detected);
  }

  public handleLedSettingsUpdate(ledSettings: LedSettings): void {
    this.ledEnabled = ledSettings.isEnabled;
    this.updateLedSwitchState(ledSettings.isEnabled);
  }

  public handleMotionSettingsUpdate(isEnabled: boolean): void {
    this.isMotionEnabled = isEnabled;
    this.updateMotionSwitchState(isEnabled);
    this.motionSensor.updateCharacteristic(this.platform.Characteristic.StatusActive, isEnabled);

    // If motion is disabled and currently detecting, clear it
    if (!isEnabled && this.motionDetected) {
      this.clearMotion();
    }
  }

  private updateMotionSwitchState(enabled: boolean): void {
    this.motionSwitch.updateCharacteristic(this.platform.Characteristic.On, enabled);
  }

  private updateLedSwitchState(enabled: boolean): void {
    this.ledSwitch.updateCharacteristic(this.platform.Characteristic.On, enabled);
  }
}
