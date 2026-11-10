import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { ProtectClient } from './api/client.js';
import {
  readSmartDetectConfig,
  sanitizeSmartDetectConfig,
  type SmartDetectConfig,
  smartDetectConfigActive,
} from './api/smart-detect.js';
import type { LedSettings, ProtectCamera, UpdateResult } from './api/types.js';
import type { ProtectMotionPlatform } from './platform.js';

// Window over which a camera's switch writes are coalesced into one request.
// A scene fires the switches' onSet handlers in the same tick, so a short window
// captures them together while staying imperceptible to HomeKit.
const BATCH_WINDOW_MS = 50;

export class CameraAccessory {
  private readonly motionSensor: Service;
  private readonly motionSwitch: Service;
  private readonly ledSwitch: Service;
  private readonly smartSwitch: Service | null;

  private motionTimeout: NodeJS.Timeout | null = null;
  private lastMotionTime = 0;
  private motionDetected = false;
  private ledEnabled: boolean;

  // Pending switch changes awaiting a coalesced flush.
  private pendingLed?: boolean;
  private pendingMotion?: boolean;
  private pendingSmart?: boolean;
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

    // Create Motion Events is recordingSettings.enableMotionDetection.
    // motionSettings is a sensor field and is null on current cameras, so it must not seed the switch.
    const motionEnabled =
      typeof camera.recordingSettings?.enableMotionDetection === 'boolean'
        ? camera.recordingSettings.enableMotionDetection
        : true;
    this.isMotionEnabled = motionEnabled;
    // The switch shows Protect's current smart detection, including a camera
    // discovered with it already off. That does not save an empty snapshot.
    this.isSmartDetectEnabled = smartDetectConfigActive(readSmartDetectConfig(camera));

    this.configureAccessoryInformation(camera);
    this.motionSensor = this.configureMotionSensor();
    this.motionSwitch = this.configureMotionSwitch();
    this.ledSwitch = this.configureLedSwitch();
    this.smartSwitch = this.platform.showSmartDetection !== false ? this.configureSmartDetectSwitch() : null;
    if (this.platform.showSmartDetection === false) {
      this.removeSmartDetectSwitch();
    }

    // Set initial values
    this.updateMotionSensorState(false);
    this.updateMotionSwitchState(motionEnabled);
    this.updateLedSwitchState(this.ledEnabled);
    if (this.smartSwitch) {
      this.updateSmartSwitchState(this.isSmartDetectEnabled);
    }
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

  public get motionEnabledState(): boolean {
    return this.isMotionEnabled;
  }

  /** Null when the Smart Detection switch is hidden. */
  public get smartDetectState(): boolean | null {
    return this.smartSwitch ? this.isSmartDetectEnabled : null;
  }

  public get savedSmartDetectConfig(): SmartDetectConfig | null {
    return this.smartDetectConfig;
  }

  private get isSmartDetectEnabled(): boolean {
    return this.accessory.context.smartDetectEnabled ?? false;
  }

  private set isSmartDetectEnabled(value: boolean) {
    this.accessory.context.smartDetectEnabled = value;
  }

  private get smartDetectConfig(): SmartDetectConfig | null {
    return sanitizeSmartDetectConfig(this.accessory.context.smartDetectConfig);
  }

  private set smartDetectConfig(value: SmartDetectConfig | null) {
    this.accessory.context.smartDetectConfig = value;
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

  private configureSmartDetectSwitch(): Service {
    const service = this.getOrAddService(this.platform.Service.Switch, 'Smart Detection', 'smart-detect-switch');

    service.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
    service.setCharacteristic(this.platform.Characteristic.ConfiguredName, 'Smart Detection');

    service
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.isSmartDetectEnabled)
      .onSet(this.setSmartDetectEnabled.bind(this));

    return service;
  }

  private removeSmartDetectSwitch(): void {
    const existing = this.accessory.getServiceById(this.platform.Service.Switch, 'smart-detect-switch');
    if (existing && this.accessory.removeService) {
      this.accessory.removeService(existing);
    }
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

  private setSmartDetectEnabled(value: CharacteristicValue): Promise<void> {
    this.pendingSmart = value as boolean;
    return this.scheduleFlush();
  }

  /**
   * Opens (or joins) a short coalescing window and returns a promise HomeKit awaits.
   * The first pending change starts the window; further changes on any switch
   * within it share the same flush and the same serialized camera write.
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
    const smart = this.pendingSmart;
    this.flushTimer = null;
    this.flushPromise = null;
    this.flushResolve = null;
    this.pendingLed = undefined;
    this.pendingMotion = undefined;
    this.pendingSmart = undefined;

    // Only send settings that actually differ from the current state. HomeKit
    // re-syncs and scenes routinely set the value that is already active.
    const settings: { led?: boolean; motion?: boolean; smartDetect?: boolean } = {};
    if (led !== undefined && led !== this.ledEnabled) {
      settings.led = led;
    }
    if (motion !== undefined && motion !== this.isMotionEnabled) {
      settings.motion = motion;
    }
    if (smart !== undefined && smart !== this.isSmartDetectEnabled) {
      settings.smartDetect = smart;
    }

    try {
      if (settings.led === undefined && settings.motion === undefined && settings.smartDetect === undefined) {
        return;
      }

      this.platform.debugLog(`Applying settings for ${this.camera.name}: ${JSON.stringify(settings)}`);
      const outcome = await this.client.updateCameraSettings(this.camera, {
        ...settings,
        smartDetectConfig: settings.smartDetect !== undefined ? this.smartDetectConfig : undefined,
      });
      if (outcome.camera) {
        this.accessory.context.camera = outcome.camera;
      }
      if (settings.smartDetect !== undefined && outcome.smartDetectConfig) {
        this.smartDetectConfig = outcome.smartDetectConfig;
      }

      const controlsRequested = settings.led !== undefined || settings.motion !== undefined;
      if (!controlsRequested || outcome.result === 'ok') {
        this.applySettings(settings);
      } else {
        this.revertSettings(settings, outcome.result);
      }
      if (settings.smartDetect !== undefined && outcome.smartDetectResult !== 'ok') {
        this.revertSmartDetect(outcome.smartDetectResult ?? 'failed');
      } else if (settings.smartDetect !== undefined && outcome.smartDetectResult === 'ok') {
        this.isSmartDetectEnabled = settings.smartDetect;
      }
    } finally {
      resolve?.();
    }
  }

  private applySettings(settings: { led?: boolean; motion?: boolean; smartDetect?: boolean }): void {
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

  private revertSmartDetect(result: UpdateResult): void {
    this.warnUpdateFailure('smart detection', result);
    setTimeout(() => {
      this.smartSwitch?.updateCharacteristic(this.platform.Characteristic.On, this.isSmartDetectEnabled);
    }, 100);
  }

  private revertSettings(
    settings: { led?: boolean; motion?: boolean; smartDetect?: boolean },
    result: UpdateResult,
  ): void {
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
      case 'mismatch':
        this.platform.log.warn(
          `Unable to update ${setting} for ${this.camera.name}: Protect readback does not match the ` +
            `requested state. The change was not applied in HomeKit.`,
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

  public handleCreateMotionEventsUpdate(isEnabled: boolean): void {
    this.isMotionEnabled = isEnabled;
    this.updateMotionSwitchState(isEnabled);
    this.motionSensor.updateCharacteristic(this.platform.Characteristic.StatusActive, isEnabled);

    if (!isEnabled && this.motionDetected) {
      this.clearMotion();
    }
  }

  public handleSmartDetectUpdate(partial: Partial<ProtectCamera>): void {
    const merged = mergeSmartDetectUpdate(this.camera, partial);
    this.accessory.context.camera = merged;
    if (!this.smartSwitch) {
      return;
    }
    const active = smartDetectConfigActive(readSmartDetectConfig(merged));
    this.isSmartDetectEnabled = active;
    this.updateSmartSwitchState(active);
  }

  private updateSmartSwitchState(enabled: boolean): void {
    this.smartSwitch?.updateCharacteristic(this.platform.Characteristic.On, enabled);
  }

  private updateMotionSwitchState(enabled: boolean): void {
    this.motionSwitch.updateCharacteristic(this.platform.Characteristic.On, enabled);
  }

  private updateLedSwitchState(enabled: boolean): void {
    this.ledSwitch.updateCharacteristic(this.platform.Characteristic.On, enabled);
  }
}

/**
 * Applies a websocket smart-detection update onto the last confirmed camera.
 * Settings lists merge field by field. Zone arrays are replaced only when the
 * event includes them. A settings update that clears every list and omits zones
 * also clears cached zone object types, so an older zone list cannot turn the
 * switch back on.
 */
export function mergeSmartDetectUpdate(current: ProtectCamera, partial: Partial<ProtectCamera>): ProtectCamera {
  const merged: ProtectCamera = { ...current };
  if (partial.smartDetectSettings) {
    merged.smartDetectSettings = { ...(current.smartDetectSettings ?? {}), ...partial.smartDetectSettings };
  }
  if (Object.prototype.hasOwnProperty.call(partial, 'smartDetectZones')) {
    merged.smartDetectZones = partial.smartDetectZones;
  } else if (partial.smartDetectSettings && settingsListsCleared(merged.smartDetectSettings)) {
    merged.smartDetectZones = clearZoneObjectTypes(current.smartDetectZones);
  }
  if (Object.prototype.hasOwnProperty.call(partial, 'secondLensSmartDetectZones')) {
    merged.secondLensSmartDetectZones = partial.secondLensSmartDetectZones;
  } else if (partial.smartDetectSettings && settingsListsCleared(merged.smartDetectSettings)) {
    merged.secondLensSmartDetectZones = clearZoneObjectTypes(current.secondLensSmartDetectZones);
  }
  return merged;
}

function settingsListsCleared(settings: ProtectCamera['smartDetectSettings']): boolean {
  if (!settings) {
    return false;
  }
  return (
    (settings.objectTypes?.length ?? 0) === 0 &&
    (settings.audioTypes?.length ?? 0) === 0 &&
    (settings.autoTrackingObjectTypes?.length ?? 0) === 0
  );
}

function clearZoneObjectTypes(zones: ProtectCamera['smartDetectZones']): ProtectCamera['smartDetectZones'] {
  if (!Array.isArray(zones)) {
    return zones;
  }
  return zones.map((zone) => {
    if (!zone || typeof zone !== 'object' || Array.isArray(zone)) {
      return zone;
    }
    return { ...(zone as Record<string, unknown>), objectTypes: [] };
  });
}
