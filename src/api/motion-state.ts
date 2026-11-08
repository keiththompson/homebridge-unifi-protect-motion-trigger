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
}

export interface MotionWritePlan {
  payload: {
    recordingSettings: { enableMotionDetection: boolean };
    smartDetectSettings?: Partial<SmartDetectPreferences>;
  };
  /** Preferences to keep so a later enable can restore types that were cleared. */
  preferences: SmartDetectPreferences | null;
  /**
   * Lists the next camera read must show.
   * Null when this write did not have a smart-detection record to compare.
   */
  expectedSmartDetect: SmartDetectPreferences | null;
}

export interface MotionReadbackExpectation {
  createMotionEvents?: boolean;
  led?: boolean;
  smartDetect: SmartDetectPreferences | null;
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
  const smartDetect = normalizeSmartDetect(camera.smartDetectSettings);
  const motionSettingsKnown = Object.prototype.hasOwnProperty.call(camera, 'motionSettings');
  const motionSettings = readMotionSettings(camera.motionSettings);

  return {
    createMotionEvents: typeof enableMotionDetection === 'boolean' ? enableMotionDetection : null,
    motionSettingsKnown,
    motionSettings: motionSettingsKnown ? motionSettings : null,
    smartDetect,
  };
}

/**
 * Builds the camera PATCH for a motion toggle.
 *
 * Create Motion Events is `recordingSettings.enableMotionDetection`.
 * Smart detection has no enable flag; the configured types are the preference.
 * Disabling clears only non-empty type lists and remembers them. Enabling writes
 * a saved list back only when the live list is empty, so a type chosen in Protect
 * while the switch was off is kept.
 */
export function planMotionWrite(
  enabled: boolean,
  camera: ProtectCamera | null,
  saved: SmartDetectPreferences | null,
): MotionWritePlan {
  const recordingSettings = { enableMotionDetection: enabled };
  const live = camera ? normalizeSmartDetect(camera.smartDetectSettings) : null;
  const remembered = cloneSmartDetectPreferences(saved) ?? emptySmartDetectPreferences();

  if (!live) {
    return {
      payload: { recordingSettings },
      preferences: smartDetectPreferencesSaved(saved) ? remembered : cloneSmartDetectPreferences(saved),
      expectedSmartDetect: null,
    };
  }

  const patch: Partial<SmartDetectPreferences> = {};
  const expected: SmartDetectPreferences = {
    objectTypes: [...live.objectTypes],
    audioTypes: [...live.audioTypes],
    autoTrackingObjectTypes: [...live.autoTrackingObjectTypes],
  };

  for (const key of SMART_DETECT_LIST_KEYS) {
    if (!enabled) {
      if (live[key].length > 0) {
        remembered[key] = [...live[key]];
        patch[key] = [];
        expected[key] = [];
      }
      continue;
    }

    if (live[key].length === 0 && remembered[key].length > 0) {
      patch[key] = [...remembered[key]];
      expected[key] = [...remembered[key]];
      continue;
    }

    if (live[key].length > 0) {
      remembered[key] = [...live[key]];
      expected[key] = [...live[key]];
    }
  }

  const persist = saved !== null || smartDetectPreferencesSaved(remembered);

  return {
    payload: {
      recordingSettings,
      ...(Object.keys(patch).length > 0 ? { smartDetectSettings: patch } : {}),
    },
    preferences: persist ? remembered : null,
    expectedSmartDetect: expected,
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

  if (expected.smartDetect) {
    const live = normalizeSmartDetect(camera.smartDetectSettings);
    if (!live || !smartDetectListsEqual(live, expected.smartDetect)) {
      return false;
    }
  }

  return true;
}

/**
 * True when the HomeKit switch and the last camera read disagree.
 * Smart-detection lists count only while the switch is off, because that is when
 * they are supposed to be cleared. A missing flag yields null rather than a guess.
 */
export function motionDrift(
  intendedMotionEnabled: boolean | null,
  diagnostics: Pick<MotionDiagnostics, 'createMotionEvents' | 'smartDetect'> | null,
): boolean | null {
  if (intendedMotionEnabled === null || !diagnostics || diagnostics.createMotionEvents === null) {
    return null;
  }

  if (diagnostics.createMotionEvents !== intendedMotionEnabled) {
    return true;
  }

  if (intendedMotionEnabled === false && diagnostics.smartDetect) {
    return SMART_DETECT_LIST_KEYS.some((key) => (diagnostics.smartDetect?.[key].length ?? 0) > 0);
  }

  return false;
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

function normalizeSmartDetect(settings: SmartDetectSettings | null | undefined): SmartDetectPreferences | null {
  if (settings == null) {
    return null;
  }
  return {
    objectTypes: asSmartDetectList(settings.objectTypes),
    audioTypes: asSmartDetectList(settings.audioTypes),
    autoTrackingObjectTypes: asSmartDetectList(settings.autoTrackingObjectTypes),
  };
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
