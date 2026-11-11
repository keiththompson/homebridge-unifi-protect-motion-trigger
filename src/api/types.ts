import type { SmartDetectConfig } from './smart-detect.js';

export interface SmartDetectPreferences {
  objectTypes: string[];
  audioTypes: string[];
  autoTrackingObjectTypes: string[];
}

export interface SmartDetectSettings {
  objectTypes?: string[];
  audioTypes?: string[];
  autoTrackingObjectTypes?: string[];
}

export interface ProtectCamera {
  id: string;
  name: string;
  type: string;
  mac: string;
  host: string;
  lastMotion: number | null;
  ledSettings?: {
    isEnabled: boolean;
    blinkRate?: number;
  };
  /**
   * Create Motion Events. This is the camera recording flag Protect still honors.
   * Absent means the read did not say, which is unknown rather than off.
   */
  recordingSettings?: {
    enableMotionDetection?: boolean;
    mode?: string;
  };
  /**
   * Sensor motion control (`isEnabled` / `sensitivity` on `modelKey: "sensor"`).
   * Current camera records return null. A camera PATCH of this object can succeed
   * without changing Create Motion Events.
   */
  motionSettings?: {
    isEnabled?: boolean;
    sensitivity?: number;
  } | null;
  smartDetectSettings?: SmartDetectSettings | null;
  /**
   * Per-zone smart detection. There is no enable flag; a zone detects when
   * `objectTypes` is non-empty. Absent means this read did not include the field.
   */
  smartDetectZones?: unknown[] | null;
  /** Zones for the second lens on dual-lens cameras. Same shape as `smartDetectZones`. */
  secondLensSmartDetectZones?: unknown[] | null;
}

export interface ProtectBootstrap {
  cameras: ProtectCamera[];
  lastUpdateId: string;
}

export interface ProtectEventPacket {
  action?: {
    action: string;
    modelKey: string;
    id: string;
  };
  payload?: Partial<ProtectCamera>;
}

export interface LedSettings {
  isEnabled: boolean;
  blinkRate?: number;
}

/**
 * Outcome of a device settings write.
 *
 * - `ok`: an independent camera read showed the requested effective state.
 * - `mismatch`: the PATCH returned a device, but the following read did not match.
 * - `throttled`: the Protect API is pausing calls after repeated errors; the write was not attempted.
 * - `unauthorized`: a fresh bootstrap confirmed the account cannot change device settings.
 * - `failed`: the write was rejected, the client is not connected, the session could not be restored, or the camera could not be read back.
 */
export type UpdateResult = 'ok' | 'mismatch' | 'throttled' | 'unauthorized' | 'failed';

export interface UpdateOutcome {
  result: UpdateResult;
  /**
   * Result of a Smart Detection switch write. Null when that switch was not part of the request.
   * Motion and LED use `result`, so one can succeed when the other does not.
   */
  smartDetectResult: UpdateResult | null;
  /** Type lists from the saved smart-detection snapshot. Null when there is nothing to restore. */
  smartDetectPreferences: SmartDetectPreferences | null;
  /**
   * Full snapshot saved before smart detection was turned off, including zones.
   * Null when there is nothing to restore. An already-disabled config is not returned here.
   */
  smartDetectConfig: SmartDetectConfig | null;
  /** Camera from the confirmed GET, when this write read the device back. */
  camera: ProtectCamera | null;
}
