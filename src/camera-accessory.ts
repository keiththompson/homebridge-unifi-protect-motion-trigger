import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { ProtectClient } from './api/client.js';
import type { LedSettings, ProtectCamera } from './api/types.js';
import type { ProtectMotionPlatform } from './platform.js';

export class CameraAccessory {
  private readonly motionSensor: Service;
  private readonly motionSwitch: Service;
  private readonly ledSwitch: Service;

  private motionTimeout: NodeJS.Timeout | null = null;
  private lastMotionTime = 0;
  private motionDetected = false;
  private ledEnabled: boolean;

  constructor(
    private readonly platform: ProtectMotionPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: ProtectClient,
    private readonly motionDuration: number,
  ) {
    const camera = this.camera;
    this.ledEnabled = camera.ledSettings?.isEnabled ?? true;

    this.configureAccessoryInformation(camera);
    this.motionSensor = this.configureMotionSensor();
    this.motionSwitch = this.configureMotionSwitch();
    this.ledSwitch = this.configureLedSwitch();

    // Set initial values
    this.updateMotionSensorState(false);
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

  private setMotionEnabled(value: CharacteristicValue): void {
    const enabled = value as boolean;
    this.isMotionEnabled = enabled;
    this.platform.debugLog(`Motion ${enabled ? 'enabled' : 'disabled'} for ${this.camera.name}`);

    // Update StatusActive on motion sensor
    this.motionSensor.updateCharacteristic(this.platform.Characteristic.StatusActive, enabled);

    // If motion is disabled and currently detecting, clear it
    if (!enabled && this.motionDetected) {
      this.clearMotion();
    }
  }

  private async setLedEnabled(value: CharacteristicValue): Promise<void> {
    const enabled = value as boolean;
    this.platform.debugLog(`Setting LED ${enabled ? 'on' : 'off'} for ${this.camera.name}`);

    const success = await this.client.updateCameraLed(this.camera, enabled);

    if (success) {
      this.ledEnabled = enabled;
    } else {
      // Revert the switch state on failure
      setTimeout(() => {
        this.ledSwitch.updateCharacteristic(this.platform.Characteristic.On, this.ledEnabled);
      }, 100);
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

  private updateLedSwitchState(enabled: boolean): void {
    this.ledSwitch.updateCharacteristic(this.platform.Characteristic.On, enabled);
  }
}
