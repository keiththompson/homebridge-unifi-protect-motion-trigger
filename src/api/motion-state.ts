import type { SmartDetectConfig, SmartDetectPatch } from './smart-detect.js';
import {
  cloneSmartDetectConfig,
  disableSmartDetect,
  preferencesFromConfig,
  readSmartDetectConfig,
  retainSmartDetectSnapshot,
  smartDetectConfigActive,
  smartDetectPatch,
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
  } & SmartDetectPatch;
  /** Type lists to keep so a later enable can restore what was cleared. */
  preferences: SmartDetectPreferences | null;
  /** Full pre-disable snapshot. Null when there is nothing active to restore. */
  config: SmartDetectConfig | null;
  /**
   * Lists the next camera read must show.
   * Null when this write did not have a smart-detection record to compare.
   */
  expectedSmartDetect: SmartDetectPreferences | null;
  /** Full smart-detection state the next camera read must show, including zones. */
  expectedConfig: SmartDetectConfig | null;
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
 * Builds the camera PATCH for a motion toggle.
 *
 * Create Motion Events is `recordingSettings.enableMotionDetection`.
 * Smart detection has no enable flag. Disabling clears object, audio, and
 * auto-tracking lists and each zone's `objectTypes`, and keeps the caller's
 * snapshot for restore. Enabling writes that snapshot back exactly.
 */
export function planMotionWrite(
  enabled: boolean,
  camera: ProtectCamera | null,
  saved: SmartDetectConfig | null,
): MotionWritePlan {
  const recordingSettings = { enableMotionDetection: enabled };
  const live = camera ? readSmartDetectConfig(camera) : null;
  const snapshot = enabled
    ? saved && smartDetectConfigActive(saved)
      ? cloneSmartDetectConfig(saved)
      : null
    : retainSmartDetectSnapshot(saved, live);
  const kept = basePlan(recordingSettings, snapshot);

  if (!live) {
    return kept;
  }

  if (!enabled) {
    if (!smartDetectConfigActive(live)) {
      const disabled = disableSmartDetect(live);
      return {
        ...kept,
        expectedSmartDetect: live.settingsPresent ? preferencesFromConfig(disabled) : null,
        expectedConfig: hasSmartDetectRecord(live) ? disabled : null,
      };
    }
    const disabled = disableSmartDetect(live);
    return {
      payload: { recordingSettings, ...smartDetectPatch(live, 'disable') },
      preferences: preferencesFromConfig(snapshot),
      config: snapshot,
      expectedSmartDetect: disabled.settingsPresent ? preferencesFromConfig(disabled) : null,
      expectedConfig: disabled,
    };
  }

  if (!snapshot) {
    return kept;
  }

  return {
    payload: { recordingSettings, ...smartDetectPatch(snapshot, 'restore') },
    preferences: preferencesFromConfig(snapshot),
    config: snapshot,
    expectedSmartDetect: snapshot.settingsPresent ? preferencesFromConfig(snapshot) : null,
    expectedConfig: snapshot,
  };
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
 * True when the HomeKit switch and the last camera read disagree.
 * While the switch is off, any remaining smart-detection type (settings or zone)
 * is drift. While it is on, drift is a saved snapshot that was not restored.
 * A missing flag yields null rather than a guess.
 */
export function motionDrift(
  intendedMotionEnabled: boolean | null,
  diagnostics:
    | (Pick<MotionDiagnostics, 'createMotionEvents' | 'smartDetect'> & {
        smartDetectConfig?: SmartDetectConfig | null;
      })
    | null,
  saved: SmartDetectConfig | null = null,
): boolean | null {
  if (intendedMotionEnabled === null || !diagnostics || diagnostics.createMotionEvents === null) {
    return null;
  }

  if (diagnostics.createMotionEvents !== intendedMotionEnabled) {
    return true;
  }

  const smart = smartDetectDrift(intendedMotionEnabled, diagnostics.smartDetectConfig, diagnostics.smartDetect, saved);
  return smart === true;
}

/**
 * Smart-detection portion of drift. Null when the camera read did not include
 * smart detection and a comparison was required.
 */
export function smartDetectDrift(
  intendedMotionEnabled: boolean | null,
  actual: SmartDetectConfig | null | undefined,
  actualLists: SmartDetectPreferences | null | undefined,
  saved: SmartDetectConfig | null,
): boolean | null {
  if (intendedMotionEnabled === null) {
    return null;
  }

  if (intendedMotionEnabled === false) {
    if (actual) {
      if (smartDetectConfigActive(actual)) {
        return true;
      }
      if (saved && smartDetectConfigActive(saved)) {
        return !smartDetectStateMatches(disableSmartDetect(saved), actual);
      }
      return false;
    }
    if (actualLists) {
      return SMART_DETECT_LIST_KEYS.some((key) => actualLists[key].length > 0);
    }
    return null;
  }

  if (saved && smartDetectConfigActive(saved)) {
    if (!actual) {
      return null;
    }
    return !smartDetectStateMatches(saved, actual);
  }

  return null;
}

/**
 * Updates the restore snapshot from a controller event.
 * While motion is off, an empty list is the suppressed state and must not erase
 * the types saved for re-enable. Keys omitted from the event are left alone.
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

function basePlan(
  recordingSettings: { enableMotionDetection: boolean },
  snapshot: SmartDetectConfig | null,
): MotionWritePlan {
  return {
    payload: { recordingSettings },
    preferences: preferencesFromConfig(snapshot),
    config: snapshot,
    expectedSmartDetect: null,
    expectedConfig: null,
  };
}

function hasSmartDetectRecord(config: SmartDetectConfig): boolean {
  return config.settingsPresent || config.zones !== null || config.secondLensZones !== null;
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
