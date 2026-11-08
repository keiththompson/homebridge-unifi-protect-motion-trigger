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
 * - `unauthorized`: the configured account lacks admin privileges required to change device settings.
 * - `failed`: the write was rejected, the client is not connected, or the camera could not be read back.
 */
export type UpdateResult = 'ok' | 'mismatch' | 'throttled' | 'unauthorized' | 'failed';

export interface UpdateOutcome {
  result: UpdateResult;
  /** Smart-detection types to persist for a later re-enable. Null when there is nothing to restore. */
  smartDetectPreferences: SmartDetectPreferences | null;
}
