import type { ProtectCamera, SmartDetectPreferences, SmartDetectSettings } from './types.js';

const LIST_KEYS = ['objectTypes', 'audioTypes', 'autoTrackingObjectTypes'] as const;

/**
 * UniFi Protect cameras have no smart-detection enable flag.
 * Detection runs when `smartDetectSettings` lists types and when a zone's
 * `objectTypes` is non-empty. Turning it off clears those lists and leaves
 * every other zone field (name, points, sensitivity, color, id) untouched.
 * Restore writes the snapshotted objects back. Nothing here is a default zone.
 */

export interface SmartDetectZoneSnapshot {
  id: number | null;
  name: string;
  points: number[][] | null;
  sensitivity: number | null;
  objectTypes: string[];
  /** Controller object, deep-copied. Restore sends this rather than a rebuilt zone. */
  raw: Record<string, unknown>;
}

export interface SmartDetectConfig {
  objectTypes: string[];
  audioTypes: string[];
  autoTrackingObjectTypes: string[];
  /** False when the camera record had no `smartDetectSettings` object. */
  settingsPresent: boolean;
  /** Null when the camera record omitted `smartDetectZones`. */
  zones: SmartDetectZoneSnapshot[] | null;
  /** Null when the camera record omitted `secondLensSmartDetectZones`. */
  secondLensZones: SmartDetectZoneSnapshot[] | null;
}

export interface SmartDetectPatch {
  smartDetectSettings?: SmartDetectPreferences;
  smartDetectZones?: Record<string, unknown>[];
  secondLensSmartDetectZones?: Record<string, unknown>[];
}

export function emptySmartDetectConfig(): SmartDetectConfig {
  return {
    objectTypes: [],
    audioTypes: [],
    autoTrackingObjectTypes: [],
    settingsPresent: false,
    zones: null,
    secondLensZones: null,
  };
}

export function configFromPreferences(
  preferences: SmartDetectPreferences | null | undefined,
): SmartDetectConfig | null {
  if (!preferences) {
    return null;
  }
  return {
    objectTypes: asList(preferences.objectTypes),
    audioTypes: asList(preferences.audioTypes),
    autoTrackingObjectTypes: asList(preferences.autoTrackingObjectTypes),
    settingsPresent: true,
    zones: null,
    secondLensZones: null,
  };
}

export function preferencesFromConfig(config: SmartDetectConfig | null | undefined): SmartDetectPreferences | null {
  if (!config) {
    return null;
  }
  return {
    objectTypes: [...config.objectTypes],
    audioTypes: [...config.audioTypes],
    autoTrackingObjectTypes: [...config.autoTrackingObjectTypes],
  };
}

export function readSmartDetectConfig(camera: ProtectCamera): SmartDetectConfig {
  const settings = normalizeSettings(camera.smartDetectSettings);
  return {
    objectTypes: settings?.objectTypes ?? [],
    audioTypes: settings?.audioTypes ?? [],
    autoTrackingObjectTypes: settings?.autoTrackingObjectTypes ?? [],
    settingsPresent: settings !== null,
    zones: readZoneField(camera, 'smartDetectZones'),
    secondLensZones: readZoneField(camera, 'secondLensSmartDetectZones'),
  };
}

export function smartDetectConfigActive(config: SmartDetectConfig | null | undefined): boolean {
  if (!config) {
    return false;
  }
  if (LIST_KEYS.some((key) => config[key].length > 0)) {
    return true;
  }
  return zoneLists(config).some((zone) => zone.objectTypes.length > 0);
}

export function cloneSmartDetectConfig(config: SmartDetectConfig): SmartDetectConfig {
  return {
    objectTypes: [...config.objectTypes],
    audioTypes: [...config.audioTypes],
    autoTrackingObjectTypes: [...config.autoTrackingObjectTypes],
    settingsPresent: config.settingsPresent,
    zones: cloneZones(config.zones),
    secondLensZones: cloneZones(config.secondLensZones),
  };
}

/** Same geometry and settings, with every detection list cleared. */
export function disableSmartDetect(config: SmartDetectConfig): SmartDetectConfig {
  return {
    objectTypes: [],
    audioTypes: [],
    autoTrackingObjectTypes: [],
    settingsPresent: config.settingsPresent,
    zones: config.zones === null ? null : config.zones.map((zone) => withClearedTypes(zone)),
    secondLensZones:
      config.secondLensZones === null ? null : config.secondLensZones.map((zone) => withClearedTypes(zone)),
  };
}

/**
 * Picks the config to keep so the Smart Detection switch can turn it back on.
 * An active camera read replaces the saved snapshot. A disabled read does not.
 * Settings lists that were already cleared (1.0.11 only cleared those) are kept
 * from the saved snapshot when the live zones are still the user's zones.
 */
export function retainSmartDetectSnapshot(
  saved: SmartDetectConfig | null,
  live: SmartDetectConfig | null,
): SmartDetectConfig | null {
  if (live && smartDetectConfigActive(live)) {
    const chosen = cloneSmartDetectConfig(live);
    if (saved && smartDetectConfigActive(saved)) {
      if (settingsCleared(live) && !settingsCleared(saved)) {
        chosen.objectTypes = [...saved.objectTypes];
        chosen.audioTypes = [...saved.audioTypes];
        chosen.autoTrackingObjectTypes = [...saved.autoTrackingObjectTypes];
        chosen.settingsPresent = saved.settingsPresent || live.settingsPresent;
      }
      if (chosen.zones === null && saved.zones) {
        chosen.zones = cloneZones(saved.zones);
      }
      if (chosen.secondLensZones === null && saved.secondLensZones) {
        chosen.secondLensZones = cloneZones(saved.secondLensZones);
      }
    }
    return chosen;
  }

  if (saved && smartDetectConfigActive(saved)) {
    return cloneSmartDetectConfig(saved);
  }

  return null;
}

/**
 * Readback comparison. Zone arrays are asserted only when the expected config
 * has them; a settings-only snapshot must not fail because the camera also has zones.
 */
export function smartDetectStateMatches(expected: SmartDetectConfig, actual: SmartDetectConfig): boolean {
  if (expected.settingsPresent) {
    const expectedLists = preferencesFromConfig(expected);
    const actualLists = preferencesFromConfig(actual);
    if (!expectedLists || !actualLists || !listsEqual(expectedLists, actualLists)) {
      return false;
    }
  }
  if (expected.zones !== null && !zonesEqual(expected.zones, actual.zones)) {
    return false;
  }
  if (expected.secondLensZones !== null && !zonesEqual(expected.secondLensZones, actual.secondLensZones)) {
    return false;
  }
  return true;
}

export function smartDetectConfigsEqual(left: SmartDetectConfig, right: SmartDetectConfig): boolean {
  if (left.settingsPresent !== right.settingsPresent) {
    return false;
  }
  if (!listsEqual(preferencesFromConfig(left), preferencesFromConfig(right))) {
    return false;
  }
  return zonesEqual(left.zones, right.zones) && zonesEqual(left.secondLensZones, right.secondLensZones);
}

export function smartDetectPatch(config: SmartDetectConfig, mode: 'restore' | 'disable'): SmartDetectPatch {
  const source = mode === 'disable' ? disableSmartDetect(config) : config;
  const patch: SmartDetectPatch = {};
  if (source.settingsPresent) {
    patch.smartDetectSettings = preferencesFromConfig(source) ?? {
      objectTypes: [],
      audioTypes: [],
      autoTrackingObjectTypes: [],
    };
  }
  if (source.zones !== null) {
    patch.smartDetectZones = source.zones.map((zone) => zonePayload(zone));
  }
  if (source.secondLensZones !== null) {
    patch.secondLensSmartDetectZones = source.secondLensZones.map((zone) => zonePayload(zone));
  }
  return patch;
}

export interface SmartDetectWritePlan {
  patch: SmartDetectPatch;
  /** Active snapshot to keep. Null when this camera has nothing to restore. */
  config: SmartDetectConfig | null;
  /** State the next camera read must show. Null when this write could not be checked. */
  expectedConfig: SmartDetectConfig | null;
  /** The switch was turned on and this camera has no saved configuration to restore. */
  nothingToRestore: boolean;
}

/**
 * Builds the smart-detection PATCH for the Smart Detection switch.
 * Off clears object types and remembers the camera's own zones.
 * On writes that snapshot back. It does not invent a default zone.
 */
export function planSmartDetectWrite(
  enabled: boolean,
  camera: ProtectCamera | null,
  saved: SmartDetectConfig | null,
): SmartDetectWritePlan {
  const live = camera ? readSmartDetectConfig(camera) : null;

  if (!enabled) {
    const snapshot = retainSmartDetectSnapshot(saved, live);
    if (!live || !hasSmartDetectRecord(live)) {
      return { patch: {}, config: snapshot, expectedConfig: null, nothingToRestore: false };
    }
    if (!smartDetectConfigActive(live)) {
      return {
        patch: {},
        config: snapshot,
        expectedConfig: disableSmartDetect(live),
        nothingToRestore: false,
      };
    }
    return {
      patch: smartDetectPatch(live, 'disable'),
      config: snapshot,
      expectedConfig: disableSmartDetect(live),
      nothingToRestore: false,
    };
  }

  const snapshot = saved && smartDetectConfigActive(saved) ? cloneSmartDetectConfig(saved) : null;
  if (!snapshot) {
    return { patch: {}, config: null, expectedConfig: null, nothingToRestore: true };
  }
  return {
    patch: smartDetectPatch(snapshot, 'restore'),
    config: snapshot,
    expectedConfig: snapshot,
    nothingToRestore: false,
  };
}

function hasSmartDetectRecord(config: SmartDetectConfig): boolean {
  return config.settingsPresent || config.zones !== null || config.secondLensZones !== null;
}

/**
 * Accepts a snapshot read from disk or accessory context.
 * Returns null when the value is not a smart-detection config.
 * Inactive configs are returned so callers can refuse to persist them.
 */
export function sanitizeSmartDetectConfig(value: unknown): SmartDetectConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const hasSettings =
    record.settingsPresent === true || LIST_KEYS.some((key) => Object.prototype.hasOwnProperty.call(record, key));
  const zones = sanitizeZoneList(record.zones);
  const secondLensZones = sanitizeZoneList(record.secondLensZones);
  if (!hasSettings && zones === null && secondLensZones === null) {
    return null;
  }
  return {
    objectTypes: asList(record.objectTypes),
    audioTypes: asList(record.audioTypes),
    autoTrackingObjectTypes: asList(record.autoTrackingObjectTypes),
    settingsPresent: hasSettings,
    zones,
    secondLensZones,
  };
}

function settingsCleared(config: SmartDetectConfig): boolean {
  return LIST_KEYS.every((key) => config[key].length === 0);
}

function listsEqual(left: SmartDetectPreferences | null, right: SmartDetectPreferences | null): boolean {
  if (!left || !right) {
    return left === right;
  }
  return LIST_KEYS.every((key) => sameStringList(left[key], right[key]));
}

function normalizeSettings(settings: SmartDetectSettings | null | undefined): SmartDetectPreferences | null {
  if (settings == null) {
    return null;
  }
  return {
    objectTypes: asList(settings.objectTypes),
    audioTypes: asList(settings.audioTypes),
    autoTrackingObjectTypes: asList(settings.autoTrackingObjectTypes),
  };
}

function readZoneField(
  camera: ProtectCamera,
  key: 'smartDetectZones' | 'secondLensSmartDetectZones',
): SmartDetectZoneSnapshot[] | null {
  if (!Object.prototype.hasOwnProperty.call(camera, key)) {
    return null;
  }
  const value = camera[key];
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((zone) => parseZone(zone)).filter((zone): zone is SmartDetectZoneSnapshot => zone !== null);
}

function sanitizeZoneList(value: unknown): SmartDetectZoneSnapshot[] | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((zone) => parseZone(zone)).filter((zone): zone is SmartDetectZoneSnapshot => zone !== null);
}

function parseZone(value: unknown): SmartDetectZoneSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = cloneRecord(value as Record<string, unknown>);
  const parsedPoints = parsePoints(raw.points);
  return {
    id: typeof raw.id === 'number' && Number.isFinite(raw.id) ? raw.id : null,
    name: typeof raw.name === 'string' ? raw.name : '',
    points: parsedPoints,
    sensitivity: typeof raw.sensitivity === 'number' && Number.isFinite(raw.sensitivity) ? raw.sensitivity : null,
    objectTypes: asList(raw.objectTypes),
    raw,
  };
}

function parsePoints(value: unknown): number[][] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const points: number[][] = [];
  for (const point of value) {
    if (!Array.isArray(point) || point.length < 2) {
      return null;
    }
    const x = point[0];
    const y = point[1];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    points.push([x, y]);
  }
  return points;
}

function withClearedTypes(zone: SmartDetectZoneSnapshot): SmartDetectZoneSnapshot {
  const raw = zonePayload({ ...zone, objectTypes: [] });
  return {
    ...zone,
    objectTypes: [],
    raw,
  };
}

/**
 * Fields Protect accepts on a smart-detection zone write.
 * A camera GET can include extra fields (for example `mergeId`). Those are kept
 * in the snapshot and omitted here so the PATCH is not rejected.
 */
const ZONE_PATCH_KEYS = [
  'id',
  'name',
  'color',
  'points',
  'sensitivity',
  'objectTypes',
  'isTriggerLightEnabled',
] as const;

const MINIMAL_ZONE_PATCH_KEYS = ['id', 'name', 'points', 'sensitivity', 'objectTypes'] as const;

function zonePayload(zone: SmartDetectZoneSnapshot): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const key of ZONE_PATCH_KEYS) {
    if (key === 'objectTypes') {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(zone.raw, key) && zone.raw[key] !== undefined) {
      payload[key] = structuredClone(zone.raw[key]);
    }
  }
  if (payload.id === undefined && zone.id !== null) {
    payload.id = zone.id;
  }
  if (payload.name === undefined && zone.name) {
    payload.name = zone.name;
  }
  if (payload.points === undefined && zone.points) {
    payload.points = zone.points.map((point) => [...point]);
  }
  if (payload.sensitivity === undefined && zone.sensitivity !== null) {
    payload.sensitivity = zone.sensitivity;
  }
  payload.objectTypes = [...zone.objectTypes];
  return payload;
}

/** Drops optional zone fields after a rejected write. Settings lists are unchanged. */
export function minimalSmartDetectPatch(patch: SmartDetectPatch): SmartDetectPatch {
  const next: SmartDetectPatch = {};
  if (patch.smartDetectSettings) {
    next.smartDetectSettings = {
      objectTypes: [...patch.smartDetectSettings.objectTypes],
      audioTypes: [...patch.smartDetectSettings.audioTypes],
      autoTrackingObjectTypes: [...patch.smartDetectSettings.autoTrackingObjectTypes],
    };
  }
  if (patch.smartDetectZones) {
    next.smartDetectZones = patch.smartDetectZones.map((zone) => minimalZoneRecord(zone));
  }
  if (patch.secondLensSmartDetectZones) {
    next.secondLensSmartDetectZones = patch.secondLensSmartDetectZones.map((zone) => minimalZoneRecord(zone));
  }
  return next;
}

function minimalZoneRecord(zone: Record<string, unknown>): Record<string, unknown> {
  const minimal: Record<string, unknown> = {};
  for (const key of MINIMAL_ZONE_PATCH_KEYS) {
    if (zone[key] !== undefined) {
      minimal[key] = zone[key];
    }
  }
  return minimal;
}

function cloneZones(zones: SmartDetectZoneSnapshot[] | null): SmartDetectZoneSnapshot[] | null {
  if (zones === null) {
    return null;
  }
  return zones.map((zone) => ({
    id: zone.id,
    name: zone.name,
    points: zone.points ? zone.points.map((point) => [...point]) : null,
    sensitivity: zone.sensitivity,
    objectTypes: [...zone.objectTypes],
    raw: cloneRecord(zone.raw),
  }));
}

function zoneLists(config: SmartDetectConfig): SmartDetectZoneSnapshot[] {
  return [...(config.zones ?? []), ...(config.secondLensZones ?? [])];
}

function zonesEqual(left: SmartDetectZoneSnapshot[] | null, right: SmartDetectZoneSnapshot[] | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  if (left.length !== right.length) {
    return false;
  }
  const used = new Set<number>();
  for (const zone of left) {
    const match = right.findIndex((candidate, index) => !used.has(index) && zoneEqual(zone, candidate));
    if (match < 0) {
      return false;
    }
    used.add(match);
  }
  return true;
}

function zoneEqual(left: SmartDetectZoneSnapshot, right: SmartDetectZoneSnapshot): boolean {
  if (left.id !== null && right.id !== null && left.id !== right.id) {
    return false;
  }
  if (left.name !== right.name || left.sensitivity !== right.sensitivity) {
    return false;
  }
  if (!sameStringList(left.objectTypes, right.objectTypes)) {
    return false;
  }
  if (left.points === null || right.points === null) {
    return JSON.stringify(left.raw.points) === JSON.stringify(right.raw.points);
  }
  return pointsEqual(left.points, right.points);
}

function pointsEqual(left: number[][], right: number[][]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((point, index) => point[0] === right[index]?.[0] && point[1] === right[index]?.[1]);
}

function sameStringList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(record);
}

function asList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}
