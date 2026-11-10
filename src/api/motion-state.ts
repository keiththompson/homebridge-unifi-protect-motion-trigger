import type { SmartDetectConfig } from './smart-detect.js';
import {
  disableSmartDetect,
  preferencesFromConfig,
  readSmartDetectConfig,
  smartDetectConfigActive,
  smartDetectStateMatches,
} from './smart-detect.js';
import type { ProtectCamera, SmartDetectPreferences, SmartDetectSettings } from './types.js';

/** Independent reads after a motion PATCH. The first attempt is immediate. */
export const MOTION_READBACK_DELAYS_MS = [0, 250, 500] as const;

export const SMART_DETECT_LIST_KEYS = ['objectTypes', 'audioTypes', 'autoTrackingObjectTypes'] as const;

export type SmartDetectListKey = (typeof SMART_DETECT_LIST_KEYS)[number];

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
}

export function emptySmartDetectPreferences(): SmartDetectPreferences {
  return {
    objectTypes: [],
    audioTypes: [],
    autoTrackingObjectTypes: [],
  };
}

export function asSmartDetectList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

export function cloneSmartDetectPreferences(
  preferences: SmartDetectPreferences | null | undefined,
): SmartDetectPreferences | null {
  if (!preferences) {
    return null;
  }
  return {
    objectTypes: asSmartDetectList(preferences.objectTypes),
    audioTypes: asSmartDetectList(preferences.audioTypes),
    autoTrackingObjectTypes: asSmartDetectList(preferences.autoTrackingObjectTypes),
  };
}

export function smartDetectListsEqual(left: SmartDetectPreferences, right: SmartDetectPreferences): boolean {
  return SMART_DETECT_LIST_KEYS.every((key) => sameStringList(left[key], right[key]));
}

export function smartDetectPreferencesSaved(preferences: SmartDetectPreferences | null | undefined): boolean {
  const cloned = cloneSmartDetectPreferences(preferences);
  if (!cloned) {
    return false;
  }
  return SMART_DETECT_LIST_KEYS.some((key) => cloned[key].length > 0);
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
    if (!smartDetectStateMatches(expected.smartDetectConfig, live)) {
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
    if (smartDetectConfigActive(actual)) {
      return true;
    }
    if (saved && smartDetectConfigActive(saved)) {
      return !smartDetectStateMatches(disableSmartDetect(saved), actual);
    }
    return false;
  }

  if (saved && smartDetectConfigActive(saved)) {
    return !smartDetectStateMatches(saved, actual);
  }

  return !smartDetectConfigActive(actual);
}

/**
 * Updates saved type lists from a controller event.
 * While the Smart Detection switch is off, an empty list is the cleared state
 * and must not erase the types saved for restore. Keys omitted from the event are left alone.
 */
export function observeSmartDetectPreferences(
  saved: SmartDetectPreferences | null,
  observed: Partial<SmartDetectSettings> | null | undefined,
  motionEnabled: boolean,
): SmartDetectPreferences | null {
  if (!observed) {
    return cloneSmartDetectPreferences(saved);
  }

  const next = cloneSmartDetectPreferences(saved) ?? emptySmartDetectPreferences();
  let touched = false;

  for (const key of SMART_DETECT_LIST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(observed, key)) {
      continue;
    }
    const list = asSmartDetectList(observed[key]);
    if (!motionEnabled && list.length === 0) {
      continue;
    }
    next[key] = list;
    touched = true;
  }

  if (!touched) {
    return cloneSmartDetectPreferences(saved);
  }

  return smartDetectPreferencesSaved(next) ? next : null;
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
