import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SMART_DETECT_SNAPSHOT_FILENAME } from './settings.js';
import { SmartDetectSnapshotStore } from './smart-detect-store.js';

const savedConfig = {
  objectTypes: ['person'],
  audioTypes: [],
  autoTrackingObjectTypes: [],
  settingsPresent: true,
  zones: [
    {
      id: 1,
      name: 'Gate',
      points: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      sensitivity: 75,
      objectTypes: ['person'],
      raw: {
        id: 1,
        name: 'Gate',
        points: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        sensitivity: 75,
        objectTypes: ['person'],
      },
    },
  ],
  secondLensZones: null,
};

describe('smart detection snapshot file', () => {
  it('logs a corrupt file and retries the read instead of ignoring later repairs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'protect-smart-corrupt-'));
    const file = join(dir, SMART_DETECT_SNAPSHOT_FILENAME);
    writeFileSync(file, '{not json');
    const warnings: string[] = [];
    const store = new SmartDetectSnapshotStore(() => dir, { warn: (message) => warnings.push(message) });

    expect(store.get('10.0.0.5', 'cam1')).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Could not read saved smart detection snapshots');

    writeFileSync(
      file,
      `${JSON.stringify({
        version: 1,
        cameras: [
          {
            controllerAddress: '10.0.0.5',
            cameraId: 'cam1',
            name: 'Gate Camera',
            savedAt: '2026-11-10T00:00:00.000Z',
            config: savedConfig,
          },
        ],
      })}\n`,
    );

    expect(store.get('10.0.0.5', 'cam1')?.zones?.[0]?.sensitivity).toBe(75);
    expect(warnings).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toContain('"sensitivity":75');
  });

  it('does not replace a saved snapshot when the camera is already off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'protect-smart-keep-'));
    const warnings: string[] = [];
    const store = new SmartDetectSnapshotStore(() => dir, { warn: (message) => warnings.push(message) });
    store.remember('10.0.0.5', 'cam1', 'Gate Camera', savedConfig);
    const before = readFileSync(join(dir, SMART_DETECT_SNAPSHOT_FILENAME), 'utf8');

    const kept = store.remember('10.0.0.5', 'cam1', 'Gate Camera', {
      ...savedConfig,
      objectTypes: [],
      zones: savedConfig.zones.map((zone) => ({ ...zone, objectTypes: [] })),
    });

    expect(kept?.objectTypes).toEqual(['person']);
    expect(readFileSync(join(dir, SMART_DETECT_SNAPSHOT_FILENAME), 'utf8')).toBe(before);
    expect(warnings).toEqual([]);
  });
});
