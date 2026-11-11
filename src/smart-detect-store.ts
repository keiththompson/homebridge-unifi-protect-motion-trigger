import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  cloneSmartDetectConfig,
  enforcedPlacesMatch,
  sanitizeSmartDetectConfig,
  type SmartDetectConfig,
  smartDetectConfigActive,
  smartDetectConfigsEqual,
  type SmartDetectEnforcedType,
} from './api/smart-detect.js';
import { SMART_DETECT_SNAPSHOT_FILENAME } from './settings.js';

interface StoredCamera {
  controllerAddress: string;
  cameraId: string;
  name: string;
  savedAt: string;
  config: SmartDetectConfig;
  /** Types a second clear of the same list put back. Omitted on disk when empty. */
  enforced: SmartDetectEnforcedType[];
}

interface SnapshotCameraFile {
  controllerAddress: string;
  cameraId: string;
  name: string;
  savedAt: string;
  config: SmartDetectConfig;
  enforced?: SmartDetectEnforcedType[];
}

interface SnapshotFile {
  version: 1;
  cameras: SnapshotCameraFile[];
}

export interface SnapshotStoreLogger {
  warn(message: string): void;
}

/**
 * Durable per-camera smart-detection snapshots in the Homebridge storage directory.
 * Writes are synchronous and atomic so a restart while the Smart Detection switch
 * is off can still restore. An already-disabled config never replaces an active snapshot.
 */
export class SmartDetectSnapshotStore {
  private loadedFrom: string | null = null;
  private loadErrorLogged = false;
  private readonly cameras = new Map<string, StoredCamera>();

  constructor(
    private readonly directory: () => string | undefined,
    private readonly log?: SnapshotStoreLogger,
  ) {}

  public get(controllerAddress: string, cameraId: string): SmartDetectConfig | null {
    this.ensureLoaded();
    const stored = this.cameras.get(storageKey(controllerAddress, cameraId));
    if (!stored || !smartDetectConfigActive(stored.config)) {
      return null;
    }
    return cloneSmartDetectConfig(stored.config);
  }

  /**
   * Persist `candidate` when it is an active config and differs from the stored one.
   * A null or inactive candidate leaves a good snapshot in place and returns that snapshot.
   */
  public remember(
    controllerAddress: string,
    cameraId: string,
    name: string,
    candidate: SmartDetectConfig | null,
  ): SmartDetectConfig | null {
    this.ensureLoaded();
    const key = storageKey(controllerAddress, cameraId);
    const existing = this.cameras.get(key) ?? null;
    if (!candidate || !smartDetectConfigActive(candidate)) {
      return existing && smartDetectConfigActive(existing.config) ? cloneSmartDetectConfig(existing.config) : null;
    }

    const config = cloneSmartDetectConfig(candidate);
    if (!existing || !smartDetectConfigsEqual(existing.config, config)) {
      this.cameras.set(key, {
        controllerAddress,
        cameraId,
        name,
        savedAt: new Date().toISOString(),
        config,
        enforced: existing?.enforced ?? [],
      });
      this.flush();
    }
    return cloneSmartDetectConfig(config);
  }

  /** Types confirmed by a second clear. Empty when this camera has none. */
  public getEnforced(controllerAddress: string, cameraId: string): SmartDetectEnforcedType[] {
    this.ensureLoaded();
    const stored = this.cameras.get(storageKey(controllerAddress, cameraId));
    return (stored?.enforced ?? []).map((entry) => ({ ...entry, types: [...entry.types] }));
  }

  /** Records types the controller added to a list this plugin wrote without them. */
  public rememberEnforced(
    controllerAddress: string,
    cameraId: string,
    name: string,
    incoming: SmartDetectEnforcedType[],
  ): void {
    this.ensureLoaded();
    const key = storageKey(controllerAddress, cameraId);
    const existing = this.cameras.get(key);
    if (!existing || incoming.length === 0) {
      return;
    }
    const merged = mergeEnforced(existing.enforced, incoming);
    if (enforcedEqual(existing.enforced, merged)) {
      return;
    }
    existing.enforced = merged;
    if (name) {
      existing.name = name;
    }
    this.flush();
  }

  /** Drops recorded types that a later read no longer shows. */
  public dropEnforced(controllerAddress: string, cameraId: string, absent: SmartDetectEnforcedType[]): void {
    this.ensureLoaded();
    const existing = this.cameras.get(storageKey(controllerAddress, cameraId));
    if (!existing || absent.length === 0 || existing.enforced.length === 0) {
      return;
    }
    const next = subtractEnforced(existing.enforced, absent);
    if (enforcedEqual(existing.enforced, next)) {
      return;
    }
    existing.enforced = next;
    this.flush();
  }

  private ensureLoaded(): void {
    const dir = this.directory() || '';
    if (this.loadedFrom === dir) {
      return;
    }
    if (!dir) {
      this.loadedFrom = dir;
      return;
    }
    const path = join(dir, SMART_DETECT_SNAPSHOT_FILENAME);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.cameras.clear();
        this.loadedFrom = dir;
        this.loadErrorLogged = false;
        return;
      }
      this.warnUnreadable(error instanceof Error ? error.message : 'unreadable snapshot file');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { cameras?: unknown }).cameras)) {
      this.warnUnreadable('snapshot file is not a smart detection snapshot');
      return;
    }
    this.cameras.clear();
    let healedNesting = false;
    for (const entry of (parsed as { cameras: unknown[] }).cameras) {
      if (entryHasNestedZoneRaw(entry)) {
        healedNesting = true;
      }
      const stored = sanitizeEntry(entry);
      if (!stored) {
        continue;
      }
      this.cameras.set(storageKey(stored.controllerAddress, stored.cameraId), stored);
    }
    this.loadedFrom = dir;
    this.loadErrorLogged = false;
    // A re-parsed snapshot used to wrap the previous raw inside the new one.
    // Rewrite once so the file stops growing.
    if (healedNesting) {
      this.flush();
    }
  }

  private warnUnreadable(message: string): void {
    if (this.loadErrorLogged) {
      return;
    }
    this.loadErrorLogged = true;
    this.log?.warn(`Could not read saved smart detection snapshots (${message}). The next attempt will try again.`);
  }

  private flush(): void {
    const dir = this.directory() || '';
    if (!dir) {
      return;
    }
    const document: SnapshotFile = {
      version: 1,
      cameras: [...this.cameras.values()].map((entry) => ({
        controllerAddress: entry.controllerAddress,
        cameraId: entry.cameraId,
        name: entry.name,
        savedAt: entry.savedAt,
        config: cloneSmartDetectConfig(entry.config),
        ...(entry.enforced.length > 0
          ? { enforced: entry.enforced.map((item) => ({ ...item, types: [...item.types] })) }
          : {}),
      })),
    };
    const dest = join(dir, SMART_DETECT_SNAPSHOT_FILENAME);
    const tmp = `${dest}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`);
    try {
      renameSync(tmp, dest);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // ignore cleanup failure
      }
      throw error;
    }
  }
}

function entryHasNestedZoneRaw(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const config = (value as { config?: unknown }).config;
  if (!config || typeof config !== 'object') {
    return false;
  }
  const record = config as { zones?: unknown; secondLensZones?: unknown };
  return zoneListHasNestedRaw(record.zones) || zoneListHasNestedRaw(record.secondLensZones);
}

function zoneListHasNestedRaw(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((zone) => {
    if (!zone || typeof zone !== 'object') {
      return false;
    }
    const raw = (zone as { raw?: unknown }).raw;
    return !!raw && typeof raw === 'object' && !Array.isArray(raw) && 'raw' in raw;
  });
}

function storageKey(controllerAddress: string, cameraId: string): string {
  return `${controllerAddress}\n${cameraId}`;
}

function sanitizeEntry(value: unknown): StoredCamera | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.controllerAddress !== 'string' || typeof record.cameraId !== 'string') {
    return null;
  }
  const config = sanitizeSmartDetectConfig(record.config);
  if (!config || !smartDetectConfigActive(config)) {
    return null;
  }
  return {
    controllerAddress: record.controllerAddress,
    cameraId: record.cameraId,
    name: typeof record.name === 'string' ? record.name : record.cameraId,
    savedAt: typeof record.savedAt === 'string' ? record.savedAt : '',
    config,
    enforced: sanitizeEnforced(record.enforced),
  };
}

const ENFORCED_LISTS = new Set(['objectTypes', 'audioTypes', 'autoTrackingObjectTypes', 'zone', 'secondLensZone']);

function sanitizeEnforced(value: unknown): SmartDetectEnforcedType[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const enforced: SmartDetectEnforcedType[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.list !== 'string' || !ENFORCED_LISTS.has(record.list)) {
      continue;
    }
    const types = Array.isArray(record.types)
      ? record.types.filter((item): item is string => typeof item === 'string')
      : [];
    if (types.length === 0) {
      continue;
    }
    enforced.push({
      list: record.list as SmartDetectEnforcedType['list'],
      zoneId: typeof record.zoneId === 'number' && Number.isFinite(record.zoneId) ? record.zoneId : null,
      zoneName: typeof record.zoneName === 'string' ? record.zoneName : null,
      types,
    });
  }
  return enforced;
}

function subtractEnforced(
  current: SmartDetectEnforcedType[],
  absent: SmartDetectEnforcedType[],
): SmartDetectEnforcedType[] {
  const next: SmartDetectEnforcedType[] = [];
  for (const entry of current) {
    const gone = absent.find((item) => enforcedPlacesMatch(item, entry));
    if (!gone) {
      next.push({ ...entry, types: [...entry.types] });
      continue;
    }
    const drop = new Set(gone.types);
    const types = entry.types.filter((type) => !drop.has(type));
    if (types.length > 0) {
      next.push({ ...entry, types });
    }
  }
  return next;
}

function mergeEnforced(
  current: SmartDetectEnforcedType[],
  incoming: SmartDetectEnforcedType[],
): SmartDetectEnforcedType[] {
  const merged = current.map((entry) => ({ ...entry, types: [...entry.types] }));
  for (const entry of incoming) {
    const existing = merged.find((item) => enforcedPlacesMatch(item, entry));
    if (!existing) {
      merged.push({ ...entry, types: [...entry.types].sort() });
      continue;
    }
    existing.types = [...new Set([...existing.types, ...entry.types])].sort();
  }
  return merged;
}

function enforcedEqual(left: SmartDetectEnforcedType[], right: SmartDetectEnforcedType[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry) => {
    const other = right.find((item) => enforcedPlacesMatch(item, entry));
    if (!other || other.types.length !== entry.types.length) {
      return false;
    }
    const types = [...entry.types].sort();
    const otherTypes = [...other.types].sort();
    return types.every((type, index) => type === otherTypes[index]);
  });
}
