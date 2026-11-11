import type { ProtectCamera, SmartDetectPreferences, SmartDetectSettings } from './types.js';

const LIST_KEYS = ['objectTypes', 'audioTypes', 'autoTrackingObjectTypes'] as const;

/**
 * UniFi Protect cameras have no smart-detection enable flag.
 * Detection runs when `smartDetectSettings` lists types and when a zone's
 * `objectTypes` is non-empty. Turning it off clears those lists and leaves
 * every other zone field (name, points, sensitivity, color, id) untouched.
 * Restore writes the snapshotted objects back. Nothing here is a default zone.
 *
 * A controller may put types back on a list this plugin saved as empty
 * (a second-lens zone is one case). Those types are not part of the snapshot.
 * A later off copies the live camera again, but it does not copy types on a
 * list the previous snapshot left empty. If a snapshot already absorbed such
 * a type, and a clear puts that list straight back while other saved types
 * do clear, the type is dropped from the snapshot.
 * Off still succeeds when every saved type is gone. On still succeeds when
 * every saved type is back. The extra types are reported, not stored.
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

/** A detection type present on the camera that the saved snapshot does not contain. */
export interface SmartDetectEnforcedType {
  /** Which list the controller filled in. */
  list: 'objectTypes' | 'audioTypes' | 'autoTrackingObjectTypes' | 'zone' | 'secondLensZone';
  zoneId: number | null;
  zoneName: string | null;
  types: string[];
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
 * A live camera whose saved types are already gone, and whose only remaining
 * types sit on lists the snapshot left empty, does not replace the snapshot.
 * When the live camera is still on, types on a list the previous snapshot
 * left empty are left out of the new snapshot.
 * Settings lists that were already cleared (1.0.11 only cleared those) are kept
 * from the saved snapshot when the live zones are still the user's zones.
 */
export function retainSmartDetectSnapshot(
  saved: SmartDetectConfig | null,
  live: SmartDetectConfig | null,
): SmartDetectConfig | null {
  if (live && smartDetectConfigActive(live)) {
    if (saved && smartDetectConfigActive(saved) && liveHasOnlyUnsavedTypes(saved, live)) {
      return cloneSmartDetectConfig(saved);
    }
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
      return omitTypesSavedAsEmpty(chosen, saved);
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

/**
 * True when the plugin's saved types are in the state the switch asked for.
 * Off: every saved type is absent. On: every saved type is present, and a list
 * that already had saved types did not gain more. Types on a list the snapshot
 * left empty are ignored here; {@link listSmartDetectEnforcedTypes} reports them.
 */
export function smartDetectObligationMet(
  enabled: boolean,
  baseline: SmartDetectConfig,
  actual: SmartDetectConfig,
): boolean {
  if (!settingsObligationMet(enabled, baseline, actual)) {
    return false;
  }
  if (!zonesObligationMet(enabled, baseline.zones, actual.zones)) {
    return false;
  }
  return zonesObligationMet(enabled, baseline.secondLensZones, actual.secondLensZones);
}

/** Types on `actual` that `baseline` does not contain, for lists whose zones still line up. */
export function listSmartDetectEnforcedTypes(
  baseline: SmartDetectConfig,
  actual: SmartDetectConfig,
): SmartDetectEnforcedType[] {
  const enforced: SmartDetectEnforcedType[] = [];
  if (baseline.settingsPresent) {
    for (const key of LIST_KEYS) {
      const types = extraTypes(baseline[key], actual[key]);
      if (types.length > 0) {
        enforced.push({ list: key, zoneId: null, zoneName: null, types });
      }
    }
  }
  appendZoneExtras(enforced, 'zone', baseline.zones, actual.zones);
  appendZoneExtras(enforced, 'secondLensZone', baseline.secondLensZones, actual.secondLensZones);
  return enforced;
}

/**
 * Switch position. With a saved snapshot, only that snapshot's types count.
 * Types the controller adds on its own do not turn the switch on.
 */
export function smartDetectEffectivelyEnabled(
  live: SmartDetectConfig | null | undefined,
  saved: SmartDetectConfig | null | undefined,
): boolean {
  if (!live) {
    return false;
  }
  if (saved && smartDetectConfigActive(saved)) {
    return smartDetectOwnedTypesRemain(saved, live);
  }
  return smartDetectConfigActive(live);
}

/**
 * Drops types `actual` has that `baseline` does not, so a confirmed readback
 * cannot fold controller-added types into the snapshot.
 */
/**
 * Owned types that came back in full on a list we cleared, while some other
 * saved type did clear. A zone counts only when another zone cleared; a
 * settings list clearing while its zone stays on is not this case. Null when
 * the clear did not apply, or a list was only partly cleared. The caller drops
 * the returned types from the snapshot.
 */
export function refilledAfterClear(
  baseline: SmartDetectConfig,
  actual: SmartDetectConfig,
): SmartDetectEnforcedType[] | null {
  if (!structuresAlign(baseline, actual)) {
    return null;
  }
  const refilled: SmartDetectEnforcedType[] = [];
  let clearedSomething = false;
  let partial = false;
  if (baseline.settingsPresent) {
    for (const key of LIST_KEYS) {
      const outcome = classifyClear(baseline[key], actual[key]);
      if (outcome === 'cleared') {
        clearedSomething = true;
      } else if (outcome === 'partial') {
        partial = true;
      } else if (outcome === 'refilled') {
        refilled.push({ list: key, zoneId: null, zoneName: null, types: [...baseline[key]].sort() });
      }
    }
  }
  const zoneRefill = collectZoneRefill(baseline.zones, actual.zones, 'zone');
  const secondRefill = collectZoneRefill(baseline.secondLensZones, actual.secondLensZones, 'secondLensZone');
  if (!zoneRefill || !secondRefill) {
    return null;
  }
  clearedSomething = clearedSomething || zoneRefill.clearedSomething || secondRefill.clearedSomething;
  partial = partial || zoneRefill.partial || secondRefill.partial;
  const zoneRefilled = [...zoneRefill.refilled, ...secondRefill.refilled];
  const zoneCleared = zoneRefill.clearedSomething || secondRefill.clearedSomething;
  // A settings list clearing while the zone stays on is the old failure mode:
  // the zone was not refilled, the zone write did not apply. A refilled zone
  // counts only when some other zone did clear.
  if (partial || zoneRefilled.length + refilled.length === 0) {
    return null;
  }
  if (zoneRefilled.length > 0 && !zoneCleared) {
    return null;
  }
  if (zoneRefilled.length === 0 && !clearedSomething) {
    return null;
  }
  return [...refilled, ...zoneRefilled];
}

/** Snapshot with the refilled types removed, so the next off does not try to clear them. */
export function withoutRefilledTypes(
  baseline: SmartDetectConfig,
  refilled: SmartDetectEnforcedType[],
): SmartDetectConfig {
  const next = cloneSmartDetectConfig(baseline);
  for (const entry of refilled) {
    if (entry.list === 'objectTypes' || entry.list === 'audioTypes' || entry.list === 'autoTrackingObjectTypes') {
      const drop = new Set(entry.types);
      next[entry.list] = next[entry.list].filter((type) => !drop.has(type));
      continue;
    }
    const zones = entry.list === 'secondLensZone' ? next.secondLensZones : next.zones;
    if (!zones) {
      continue;
    }
    const index = zones.findIndex(
      (zone) =>
        (entry.zoneId !== null && zone.id === entry.zoneId) ||
        (entry.zoneName !== null && zone.name === entry.zoneName),
    );
    const zone = index >= 0 ? zones[index] : undefined;
    if (!zone) {
      continue;
    }
    const drop = new Set(entry.types);
    zones[index] = withObjectTypes(
      zone,
      zone.objectTypes.filter((type) => !drop.has(type)),
    );
  }
  return next;
}

export function withoutUnsavedSmartDetectTypes(
  actual: SmartDetectConfig,
  baseline: SmartDetectConfig,
): SmartDetectConfig {
  const next = cloneSmartDetectConfig(actual);
  if (baseline.settingsPresent) {
    for (const key of LIST_KEYS) {
      next[key] = intersection(baseline[key], actual[key]);
    }
    next.settingsPresent = true;
  }
  next.zones = restrictZoneTypes(actual.zones, baseline.zones);
  next.secondLensZones = restrictZoneTypes(actual.secondLensZones, baseline.secondLensZones);
  return next;
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
    // Saved types are already gone. Another clear would only poke lists the
    // controller refills, and the readback would never match an empty list.
    if (snapshot && liveHasOnlyUnsavedTypes(snapshot, live)) {
      return {
        patch: {},
        config: snapshot,
        expectedConfig: disableSmartDetect(snapshot),
        nothingToRestore: false,
      };
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
  const raw = controllerZoneRecord(value as Record<string, unknown>);
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

/**
 * Saved types are gone, and every type still on the camera sits on a list the
 * snapshot left empty. That is the controller refilling a list, not a new user config.
 */
function omitTypesSavedAsEmpty(chosen: SmartDetectConfig, saved: SmartDetectConfig): SmartDetectConfig {
  if (saved.settingsPresent) {
    for (const key of LIST_KEYS) {
      if (saved[key].length === 0) {
        chosen[key] = [];
      }
    }
  }
  chosen.zones = emptyTypesWhereBaselineEmpty(chosen.zones, saved.zones);
  chosen.secondLensZones = emptyTypesWhereBaselineEmpty(chosen.secondLensZones, saved.secondLensZones);
  return chosen;
}

function emptyTypesWhereBaselineEmpty(
  live: SmartDetectZoneSnapshot[] | null,
  saved: SmartDetectZoneSnapshot[] | null,
): SmartDetectZoneSnapshot[] | null {
  if (live === null || saved === null) {
    return live;
  }
  return live.map((zone) => {
    const match =
      saved.find((item) => zoneStructureEqual(zone, item)) ?? saved.find((item) => sameZoneIdentity(zone, item));
    if (!match || match.objectTypes.length > 0) {
      return zone;
    }
    return withObjectTypes(zone, []);
  });
}

type ClearOutcome = 'empty' | 'cleared' | 'refilled' | 'partial';

function classifyClear(owned: string[], actual: string[]): ClearOutcome {
  if (owned.length === 0) {
    return 'empty';
  }
  const ownedSet = new Set(owned);
  if (!actual.every((type) => ownedSet.has(type))) {
    return 'partial';
  }
  const kept = actual.filter((type) => ownedSet.has(type));
  if (kept.length === 0) {
    return 'cleared';
  }
  if (kept.length === owned.length) {
    return 'refilled';
  }
  return 'partial';
}

function collectZoneRefill(
  baseline: SmartDetectZoneSnapshot[] | null,
  actual: SmartDetectZoneSnapshot[] | null,
  list: 'zone' | 'secondLensZone',
): { clearedSomething: boolean; partial: boolean; refilled: SmartDetectEnforcedType[] } | null {
  if (baseline === null) {
    return { clearedSomething: false, partial: false, refilled: [] };
  }
  const pairs = pairZones(baseline, actual);
  if (!pairs) {
    return null;
  }
  const refilled: SmartDetectEnforcedType[] = [];
  let clearedSomething = false;
  let partial = false;
  for (const pair of pairs) {
    const outcome = classifyClear(pair.baseline.objectTypes, pair.actual.objectTypes);
    if (outcome === 'cleared') {
      clearedSomething = true;
    } else if (outcome === 'partial') {
      partial = true;
    } else if (outcome === 'refilled') {
      refilled.push({
        list,
        zoneId: pair.actual.id,
        zoneName: pair.actual.name || null,
        types: [...pair.baseline.objectTypes].sort(),
      });
    }
  }
  return { clearedSomething, partial, refilled };
}

function liveHasOnlyUnsavedTypes(baseline: SmartDetectConfig, actual: SmartDetectConfig): boolean {
  if (!structuresAlign(baseline, actual) || smartDetectOwnedTypesRemain(baseline, actual)) {
    return false;
  }
  return listSmartDetectEnforcedTypes(baseline, actual).every((entry) => enforcedListWasEmpty(baseline, entry));
}

function structuresAlign(baseline: SmartDetectConfig, actual: SmartDetectConfig): boolean {
  return (
    pairZones(baseline.zones, actual.zones) !== null &&
    pairZones(baseline.secondLensZones, actual.secondLensZones) !== null
  );
}

function smartDetectOwnedTypesRemain(baseline: SmartDetectConfig, actual: SmartDetectConfig): boolean {
  if (baseline.settingsPresent) {
    for (const key of LIST_KEYS) {
      if (intersection(baseline[key], actual[key]).length > 0) {
        return true;
      }
    }
  }
  return (
    zoneOwnedTypesRemain(baseline.zones, actual.zones) ||
    zoneOwnedTypesRemain(baseline.secondLensZones, actual.secondLensZones)
  );
}

function zoneOwnedTypesRemain(
  baseline: SmartDetectZoneSnapshot[] | null,
  actual: SmartDetectZoneSnapshot[] | null,
): boolean {
  if (!baseline || !actual) {
    return false;
  }
  const pairs = pairZones(baseline, actual);
  if (pairs) {
    return pairs.some((pair) => intersection(pair.baseline.objectTypes, pair.actual.objectTypes).length > 0);
  }
  return baseline.some((zone) => {
    const candidate = actual.find((item) => sameZoneIdentity(zone, item));
    return candidate ? intersection(zone.objectTypes, candidate.objectTypes).length > 0 : false;
  });
}

function settingsObligationMet(enabled: boolean, baseline: SmartDetectConfig, actual: SmartDetectConfig): boolean {
  if (!baseline.settingsPresent) {
    if (!enabled && LIST_KEYS.some((key) => actual[key].length > 0)) {
      return false;
    }
    return true;
  }
  return LIST_KEYS.every((key) => listObligationMet(enabled, baseline[key], actual[key]));
}

function zonesObligationMet(
  enabled: boolean,
  baseline: SmartDetectZoneSnapshot[] | null,
  actual: SmartDetectZoneSnapshot[] | null,
): boolean {
  if (baseline === null) {
    if (!enabled && zonesHaveTypes(actual)) {
      return false;
    }
    return true;
  }
  const pairs = pairZones(baseline, actual);
  if (!pairs) {
    return false;
  }
  return pairs.every((pair) => listObligationMet(enabled, pair.baseline.objectTypes, pair.actual.objectTypes));
}

function listObligationMet(enabled: boolean, owned: string[], actual: string[]): boolean {
  if (enabled) {
    if (!typesPresent(owned, actual)) {
      return false;
    }
    return owned.length === 0 || extraTypes(owned, actual).length === 0;
  }
  return typesCleared(owned, actual);
}

function zonesHaveTypes(zones: SmartDetectZoneSnapshot[] | null): boolean {
  return (zones ?? []).some((zone) => zone.objectTypes.length > 0);
}

function typesPresent(owned: string[], actual: string[]): boolean {
  const actualSet = new Set(actual);
  return owned.every((type) => actualSet.has(type));
}

function typesCleared(owned: string[], actual: string[]): boolean {
  const actualSet = new Set(actual);
  return owned.every((type) => !actualSet.has(type));
}

function extraTypes(owned: string[], actual: string[]): string[] {
  const ownedSet = new Set(owned);
  return [...new Set(actual.filter((type) => !ownedSet.has(type)))].sort();
}

function intersection(owned: string[], actual: string[]): string[] {
  const actualSet = new Set(actual);
  return owned.filter((type) => actualSet.has(type));
}

function appendZoneExtras(
  enforced: SmartDetectEnforcedType[],
  list: 'zone' | 'secondLensZone',
  baseline: SmartDetectZoneSnapshot[] | null,
  actual: SmartDetectZoneSnapshot[] | null,
): void {
  const pairs = pairZones(baseline, actual);
  if (!pairs) {
    return;
  }
  for (const pair of pairs) {
    const types = extraTypes(pair.baseline.objectTypes, pair.actual.objectTypes);
    if (types.length === 0) {
      continue;
    }
    enforced.push({
      list,
      zoneId: pair.actual.id,
      zoneName: pair.actual.name || null,
      types,
    });
  }
}

function enforcedListWasEmpty(baseline: SmartDetectConfig, entry: SmartDetectEnforcedType): boolean {
  if (entry.list === 'objectTypes' || entry.list === 'audioTypes' || entry.list === 'autoTrackingObjectTypes') {
    return baseline[entry.list].length === 0;
  }
  const zones = entry.list === 'secondLensZone' ? baseline.secondLensZones : baseline.zones;
  const zone = zones?.find(
    (item) =>
      (entry.zoneId !== null && item.id === entry.zoneId) || (entry.zoneName !== null && item.name === entry.zoneName),
  );
  return (zone?.objectTypes.length ?? 0) === 0;
}

interface ZonePair {
  baseline: SmartDetectZoneSnapshot;
  actual: SmartDetectZoneSnapshot;
}

function pairZones(
  baseline: SmartDetectZoneSnapshot[] | null,
  actual: SmartDetectZoneSnapshot[] | null,
): ZonePair[] | null {
  if (baseline === null || actual === null) {
    return baseline === actual ? [] : null;
  }
  if (baseline.length !== actual.length) {
    return null;
  }
  const used = new Set<number>();
  const pairs: ZonePair[] = [];
  for (const zone of baseline) {
    const match = actual.findIndex((candidate, index) => !used.has(index) && zoneStructureEqual(zone, candidate));
    if (match < 0) {
      return null;
    }
    used.add(match);
    const paired = actual[match];
    if (!paired) {
      return null;
    }
    pairs.push({ baseline: zone, actual: paired });
  }
  return pairs;
}

function restrictZoneTypes(
  actual: SmartDetectZoneSnapshot[] | null,
  baseline: SmartDetectZoneSnapshot[] | null,
): SmartDetectZoneSnapshot[] | null {
  if (actual === null || baseline === null) {
    return cloneZones(actual);
  }
  return actual.map((zone) => {
    const match =
      baseline.find((item) => zoneStructureEqual(zone, item)) ?? baseline.find((item) => sameZoneIdentity(zone, item));
    return withObjectTypes(zone, match ? intersection(match.objectTypes, zone.objectTypes) : []);
  });
}

function withObjectTypes(zone: SmartDetectZoneSnapshot, objectTypes: string[]): SmartDetectZoneSnapshot {
  const raw = cloneRecord(zone.raw);
  raw.objectTypes = [...objectTypes];
  return {
    ...zone,
    objectTypes: [...objectTypes],
    points: zone.points ? zone.points.map((point) => [...point]) : null,
    raw,
  };
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
  return zoneStructureEqual(left, right) && sameStringList(left.objectTypes, right.objectTypes);
}

function zoneStructureEqual(left: SmartDetectZoneSnapshot, right: SmartDetectZoneSnapshot): boolean {
  if (left.id !== null && right.id !== null && left.id !== right.id) {
    return false;
  }
  if (left.name !== right.name || left.sensitivity !== right.sensitivity) {
    return false;
  }
  if (left.points === null || right.points === null) {
    return JSON.stringify(left.raw.points) === JSON.stringify(right.raw.points);
  }
  return pointsEqual(left.points, right.points);
}

function sameZoneIdentity(left: SmartDetectZoneSnapshot, right: SmartDetectZoneSnapshot): boolean {
  if (left.id !== null && right.id !== null) {
    return left.id === right.id;
  }
  return left.name !== '' && left.name === right.name;
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

/**
 * The controller zone, without a snapshot wrapper.
 * Re-reading a saved zone used to store that wrapper as `raw`, so each save
 * nested another copy. Walk to the innermost zone record and drop `raw`.
 */
function controllerZoneRecord(value: Record<string, unknown>): Record<string, unknown> {
  let current = value;
  const seen = new Set<unknown>();
  while (!seen.has(current)) {
    seen.add(current);
    const inner = current.raw;
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) {
      break;
    }
    const record = inner as Record<string, unknown>;
    if (!looksLikeZoneRecord(record)) {
      break;
    }
    current = record;
  }
  const flat = cloneRecord(current);
  if ('raw' in flat) {
    delete flat.raw;
  }
  return flat;
}

function looksLikeZoneRecord(value: Record<string, unknown>): boolean {
  const hasIdentity = typeof value.id === 'number' || typeof value.name === 'string';
  return hasIdentity && (Array.isArray(value.objectTypes) || Array.isArray(value.points));
}

function asList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}
