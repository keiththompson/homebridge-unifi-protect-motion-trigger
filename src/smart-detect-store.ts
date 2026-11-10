import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  cloneSmartDetectConfig,
  sanitizeSmartDetectConfig,
  type SmartDetectConfig,
  smartDetectConfigActive,
  smartDetectConfigsEqual,
} from './api/smart-detect.js';
import { SMART_DETECT_SNAPSHOT_FILENAME } from './settings.js';

interface StoredCamera {
  controllerAddress: string;
  cameraId: string;
  name: string;
  savedAt: string;
  config: SmartDetectConfig;
}

interface SnapshotFile {
  version: 1;
  cameras: StoredCamera[];
}

/**
 * Durable per-camera smart-detection snapshots in the Homebridge storage directory.
 * Writes are synchronous and atomic so a crash after shields go down can still restore.
 * An already-disabled config never replaces an active snapshot.
 */
export class SmartDetectSnapshotStore {
  private loadedFrom: string | null = null;
  private readonly cameras = new Map<string, StoredCamera>();

  constructor(private readonly directory: () => string | undefined) {}

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
      });
      this.flush();
    }
    return cloneSmartDetectConfig(config);
  }

  private ensureLoaded(): void {
    const dir = this.directory() || '';
    if (this.loadedFrom === dir) {
      return;
    }
    this.cameras.clear();
    this.loadedFrom = dir;
    if (!dir) {
      return;
    }
    const path = join(dir, SMART_DETECT_SNAPSHOT_FILENAME);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') {
      return;
    }
    const cameras = (parsed as { cameras?: unknown }).cameras;
    if (!Array.isArray(cameras)) {
      return;
    }
    for (const entry of cameras) {
      const stored = sanitizeEntry(entry);
      if (!stored) {
        continue;
      }
      this.cameras.set(storageKey(stored.controllerAddress, stored.cameraId), stored);
    }
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
  };
}
