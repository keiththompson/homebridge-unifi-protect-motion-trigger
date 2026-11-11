import type { SmartDetectConfig } from './smart-detect.js';
import {
  preferencesFromConfig,
  readSmartDetectConfig,
  smartDetectConfigActive,
  smartDetectObligationMet,
  smartDetectStateMatches,
} from './smart-detect.js';
import type { ProtectCamera, SmartDetectPreferences } from './types.js';

/** Independent reads after a motion PATCH. The first attempt is immediate. */
export const MOTION_READBACK_DELAYS_MS = [0, 250, 500] as const;

export const SMART_DETECT_LIST_KEYS = ['objectTypes', 'audioTypes', 'autoTrackingObjectTypes'] as const;

export interface MotionDiagnostics {
  /** `recordingSettings.enableMotionDetection`. Null when the camera record omits it. */
  createMotionEvents: boolean | null;
  /** False when the camera record has no `motionSettings` key at all. */
  motionSettingsKnown: boolean;
  /** Null when the key is missing or the controller sent JSON null. */
  motionSettings: null | { isEnabled: boolean | null };
  smartDetect: SmartDetectPreferences | null;
  /** Settings lists plus zones. Null only when the camera record could not be read. */
  smartDetectConfig: SmartDetectConfig | null;
}

export interface MotionWritePlan {
  payload: {
    recordingSettings: { enableMotionDetection: boolean };
  };
}

export interface MotionReadbackExpectation {
  createMotionEvents?: boolean;
  led?: boolean;
  smartDetect: SmartDetectPreferences | null;
  smartDetectConfig?: SmartDetectConfig | null;
  /**
   * Saved user snapshot. Types the controller adds on lists this snapshot left
   * empty do not fail the readback. Exact list equality is used when this is absent.
   */
  smartDetectBaseline?: SmartDetectConfig | null;
  /** True when restoring the snapshot. False when clearing the snapshot's types. */
  smartDetectEnabling?: boolean;
}

export function smartDetectListsEqual(left: SmartDetectPreferences, right: SmartDetectPreferences): boolean {
  return SMART_DETECT_LIST_KEYS.every((key) => sameStringList(left[key], right[key]));
}

/**
 * Reads the fields that decide whether Protect is still creating motion or smart-detection events.
 * `motionSettings` is reported for diagnostics. It is not the camera Create Motion Events control.
 */
export function readMotionDiagnostics(camera: ProtectCamera): MotionDiagnostics {
  const enableMotionDetection = camera.recordingSettings?.enableMotionDetection;
  const smartDetectConfig = readSmartDetectConfig(camera);
  const smartDetect = smartDetectConfig.settingsPresent ? preferencesFromConfig(smartDetectConfig) : null;
  const motionSettingsKnown = Object.prototype.hasOwnProperty.call(camera, 'motionSettings');
  const motionSettings = readMotionSettings(camera.motionSettings);

  return {
    createMotionEvents: typeof enableMotionDetection === 'boolean' ? enableMotionDetection : null,
    motionSettingsKnown,
    motionSettings: motionSettingsKnown ? motionSettings : null,
    smartDetect,
    smartDetectConfig,
  };
}

/**
 * Builds the camera PATCH for the Motion Enabled switch.
 * Create Motion Events is `recordingSettings.enableMotionDetection`.
 * This switch does not change smart detection.
 */
export function planMotionWrite(enabled: boolean): MotionWritePlan {
  return { payload: { recordingSettings: { enableMotionDetection: enabled } } };
}

export function motionReadbackMatches(camera: ProtectCamera, expected: MotionReadbackExpectation): boolean {
  if (expected.createMotionEvents !== undefined) {
    if (camera.recordingSettings?.enableMotionDetection !== expected.createMotionEvents) {
      return false;
    }
  }

  if (expected.led !== undefined) {
    if (camera.ledSettings?.isEnabled !== expected.led) {
      return false;
    }
  }

  if (expected.smartDetectConfig) {
    const live = readSmartDetectConfig(camera);
    if (expected.smartDetectBaseline) {
      if (!smartDetectObligationMet(expected.smartDetectEnabling === true, expected.smartDetectBaseline, live)) {
        return false;
      }
    } else if (!smartDetectStateMatches(expected.smartDetectConfig, live)) {
      return false;
    }
  } else if (expected.smartDetect) {
    const live = readSmartDetectConfig(camera);
    const actual = live.settingsPresent ? preferencesFromConfig(live) : null;
    if (!actual || !smartDetectListsEqual(actual, expected.smartDetect)) {
      return false;
    }
  }

  return true;
}

/**
 * True when the Motion Enabled switch and the last camera read disagree.
 * Smart detection has its own switch and is not part of this comparison.
 * A missing flag yields null rather than a guess.
 */
export function motionDrift(
  intendedMotionEnabled: boolean | null,
  diagnostics: Pick<MotionDiagnostics, 'createMotionEvents'> | null,
): boolean | null {
  if (intendedMotionEnabled === null || !diagnostics || diagnostics.createMotionEvents === null) {
    return null;
  }

  return diagnostics.createMotionEvents !== intendedMotionEnabled;
}

/**
 * True when the Smart Detection switch and the last camera read disagree.
 * Null when the switch state or the camera read is unknown.
 */
export function smartDetectDrift(
  intendedSmartDetect: boolean | null,
  actual: SmartDetectConfig | null | undefined,
  saved: SmartDetectConfig | null,
): boolean | null {
  if (intendedSmartDetect === null || !actual) {
    return null;
  }

  if (!intendedSmartDetect) {
    if (saved && smartDetectConfigActive(saved)) {
      return !smartDetectObligationMet(false, saved, actual);
    }
    if (smartDetectConfigActive(actual)) {
      return true;
    }
    return false;
  }

  if (saved && smartDetectConfigActive(saved)) {
    return !smartDetectObligationMet(true, saved, actual);
  }

  return !smartDetectConfigActive(actual);
}

function readMotionSettings(settings: ProtectCamera['motionSettings']): null | { isEnabled: boolean | null } {
  if (settings == null) {
    return null;
  }
  return {
    isEnabled: typeof settings.isEnabled === 'boolean' ? settings.isEnabled : null,
  };
}

function sameStringList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
