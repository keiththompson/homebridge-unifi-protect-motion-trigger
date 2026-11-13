import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ProtectCamera } from './api/types.js';
import {
  buildHealthReport,
  errorSnapshot,
  HEALTH_SCHEMA_VERSION,
  snapshotFromCamera,
  toPersistedHealth,
  writeHealthFileAtomic,
} from './health.js';
import { HEALTH_FILENAME } from './settings.js';

const now = Date.parse('2026-11-08T07:37:00.000Z');

const camera = {
  id: 'cam1',
  name: 'Front Door',
  recordingSettings: { enableMotionDetection: true },
  motionSettings: null,
  smartDetectSettings: { objectTypes: ['person'], audioTypes: [], autoTrackingObjectTypes: [] },
} as unknown as ProtectCamera;

function report(
  snapshot: ReturnType<typeof snapshotFromCamera> | ReturnType<typeof errorSnapshot> | null,
  intended: boolean | null,
  generatedAt = now,
  intendedSmartDetect: boolean | null = null,
): ReturnType<typeof buildHealthReport> {
  return buildHealthReport({
    pluginVersion: '1.1.0',
    generatedAt,
    controllers: [
      {
        address: '10.0.0.5',
        connected: true,
        throttled: false,
        admin: true,
        lastError: null,
        cameras: [
          {
            id: 'cam1',
            name: 'Front Door',
            intendedMotionEnabled: intended,
            smartDetectPreferencesSaved: false,
            intendedSmartDetect,
            smartDetectSnapshot: null,
            snapshot,
          },
        ],
      },
    ],
  });
}

describe('health report', () => {
  it('uses schema 1.2.0 and reports unknown before any camera read', () => {
    const health = report(null, null);

    expect(health.schemaVersion).toBe(HEALTH_SCHEMA_VERSION);
    expect(health.schemaVersion).toBe('1.2.0');
    const cameraHealth = health.controllers[0]?.cameras[0];
    expect(cameraHealth?.readback.status).toBe('unknown');
    expect(cameraHealth?.createMotionEvents).toBeNull();
    expect(cameraHealth?.drift).toBeNull();
    expect(JSON.stringify(health)).not.toContain('password');
  });

  it('verifies a fresh read that matches the switch', () => {
    const health = report(snapshotFromCamera(camera, now, 1), true);
    const cameraHealth = health.controllers[0]?.cameras[0];

    expect(cameraHealth?.readback.status).toBe('verified');
    expect(cameraHealth?.createMotionEvents).toBe(true);
    expect(cameraHealth?.motionSettingsKnown).toBe(true);
    expect(cameraHealth?.motionSettings).toBeNull();
    expect(cameraHealth?.drift).toBe(false);
    expect(cameraHealth?.readback.fetchedAt).toBe('2026-11-08T07:37:00.000Z');
  });

  it('reports mismatch when the switch is off but Create Motion Events is still on', () => {
    const health = report(snapshotFromCamera(camera, now, 2), false);
    const cameraHealth = health.controllers[0]?.cameras[0];

    expect(cameraHealth?.readback.status).toBe('mismatch');
    expect(cameraHealth?.drift).toBe(true);
    expect(cameraHealth?.readback.attempts).toBe(2);
  });

  it('does not treat active smart detection as motion drift', () => {
    const disabled = {
      ...camera,
      recordingSettings: { enableMotionDetection: false },
    } as unknown as ProtectCamera;
    const health = report(snapshotFromCamera(disabled, now, 1), false);

    expect(health.controllers[0]?.cameras[0]?.readback.status).toBe('verified');
    expect(health.controllers[0]?.cameras[0]?.drift).toBe(false);
    expect(health.controllers[0]?.cameras[0]?.smartDetectDrift).toBeNull();
    expect(health.controllers[0]?.cameras[0]?.smartDetectObjectTypes).toEqual(['person']);
  });

  it('reports smart detection drift when that switch is off but object types remain', () => {
    const health = report(snapshotFromCamera(camera, now, 1), true, now, false);
    const cameraHealth = health.controllers[0]?.cameras[0];

    expect(cameraHealth?.readback.status).toBe('mismatch');
    expect(cameraHealth?.drift).toBe(true);
    expect(cameraHealth?.smartDetectDrift).toBe(true);
    expect(cameraHealth?.smartDetectExpected?.objectTypes).toEqual([]);
    expect(cameraHealth?.smartDetectActual?.objectTypes).toEqual(['person']);
  });

  it('reports zone drift separately from a cleared settings list', () => {
    const disabled = {
      ...camera,
      recordingSettings: { enableMotionDetection: false },
      smartDetectSettings: { objectTypes: [], audioTypes: [], autoTrackingObjectTypes: [] },
      smartDetectZones: [
        {
          id: 4,
          name: 'Street',
          points: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
          sensitivity: 75,
          objectTypes: ['person', 'vehicle'],
        },
      ],
    } as unknown as ProtectCamera;
    const health = report(snapshotFromCamera(disabled, now, 2), false, now, false);
    const cameraHealth = health.controllers[0]?.cameras[0];

    expect(cameraHealth?.smartDetectObjectTypes).toEqual([]);
    expect(cameraHealth?.smartDetectDrift).toBe(true);
    expect(cameraHealth?.drift).toBe(true);
    expect(cameraHealth?.readback.status).toBe('mismatch');
    expect(cameraHealth?.smartDetectExpected?.zones?.[0]).toMatchObject({
      name: 'Street',
      sensitivity: 75,
      objectTypes: [],
    });
    expect(cameraHealth?.smartDetectActual?.zones?.[0]).toMatchObject({
      name: 'Street',
      sensitivity: 75,
      objectTypes: ['person', 'vehicle'],
    });
  });

  it('does not call controller-added types on an empty saved list drift', () => {
    const saved = {
      objectTypes: [],
      audioTypes: [],
      autoTrackingObjectTypes: [],
      settingsPresent: true,
      zones: [
        {
          id: 1,
          name: 'Entrance',
          points: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
          sensitivity: 70,
          objectTypes: ['person', 'vehicle'],
          raw: { id: 1, name: 'Entrance', sensitivity: 70, objectTypes: ['person', 'vehicle'] },
        },
      ],
      secondLensZones: [
        {
          id: 2,
          name: 'Down',
          points: [
            [0.1, 0.8],
            [0.9, 0.8],
            [0.9, 1],
          ],
          sensitivity: 40,
          objectTypes: [],
          raw: { id: 2, name: 'Down', sensitivity: 40, objectTypes: [] },
        },
      ],
    };
    const live = {
      id: 'cam1',
      name: 'Doorbell',
      recordingSettings: { enableMotionDetection: true },
      motionSettings: null,
      smartDetectSettings: { objectTypes: [], audioTypes: [], autoTrackingObjectTypes: [] },
      smartDetectZones: [
        {
          id: 1,
          name: 'Entrance',
          points: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
          sensitivity: 70,
          objectTypes: [],
        },
      ],
      secondLensSmartDetectZones: [
        {
          id: 2,
          name: 'Down',
          points: [
            [0.1, 0.8],
            [0.9, 0.8],
            [0.9, 1],
          ],
          sensitivity: 40,
          objectTypes: ['package'],
        },
      ],
    } as unknown as ProtectCamera;
    const health = buildHealthReport({
      pluginVersion: '1.0.13',
      generatedAt: now,
      controllers: [
        {
          address: '10.0.0.5',
          connected: true,
          throttled: false,
          admin: true,
          lastError: null,
          cameras: [
            {
              id: 'cam1',
              name: 'Doorbell',
              intendedMotionEnabled: true,
              smartDetectPreferencesSaved: true,
              intendedSmartDetect: false,
              smartDetectSnapshot: saved,
              snapshot: snapshotFromCamera(live, now, 1),
            },
          ],
        },
      ],
    });
    const cameraHealth = health.controllers[0]?.cameras[0];

    expect(cameraHealth?.smartDetectDrift).toBe(false);
    expect(cameraHealth?.drift).toBe(false);
    expect(cameraHealth?.readback.status).toBe('verified');
    expect(cameraHealth?.smartDetectEnforcedTypes).toEqual([]);
  });

  it('marks an old successful read stale without turning it into a fresh verification', () => {
    const health = report(snapshotFromCamera(camera, now, 1), true, now + 5 * 60 * 1000 + 1);
    const cameraHealth = health.controllers[0]?.cameras[0];

    expect(cameraHealth?.readback.status).toBe('stale');
    expect(cameraHealth?.createMotionEvents).toBe(true);
    expect(cameraHealth?.drift).toBe(false);
  });

  it('reports error without reusing the previous effective values', () => {
    const health = report(errorSnapshot('controller timeout', 1), false);
    const cameraHealth = health.controllers[0]?.cameras[0];

    expect(cameraHealth?.readback.status).toBe('error');
    expect(cameraHealth?.readback.error).toBe('controller timeout');
    expect(cameraHealth?.createMotionEvents).toBeNull();
    expect(cameraHealth?.drift).toBeNull();
    expect(cameraHealth?.motionSettingsKnown).toBeNull();
  });

  it('stays unknown when the camera record omits the Create Motion Events flag', () => {
    const missing = { id: 'cam1', name: 'Front Door', motionSettings: null } as unknown as ProtectCamera;
    const health = report(snapshotFromCamera(missing, now, 1), true);

    expect(health.controllers[0]?.cameras[0]?.readback.status).toBe('unknown');
    expect(health.controllers[0]?.cameras[0]?.createMotionEvents).toBeNull();
    expect(health.controllers[0]?.cameras[0]?.readback.error).toContain('enableMotionDetection');
  });
});

describe('persisted health file', () => {
  it('keeps home-monitor keys and stores schema 1.2.0 details beside the camera count', () => {
    const health = report(snapshotFromCamera(camera, now, 1), true);
    const persisted = toPersistedHealth(health, now, {
      '10.0.0.5': {
        reconnecting: false,
        consecutiveFailures: 0,
        lastEventAt: '2026-11-08T07:36:00.000Z',
        lastBootstrapAt: '2026-11-08T07:35:00.000Z',
      },
    });

    expect(persisted.schemaVersion).toBe('1.2.0');
    expect(persisted.pluginVersion).toBe('1.1.0');
    expect(persisted.updatedAt).toBe('2026-11-08T07:37:00.000Z');
    expect(persisted.updatedAtEpoch).toBe(Math.floor(now / 1000));
    expect(persisted.controllers).toHaveLength(1);
    expect(persisted.controllers[0]?.connected).toBe(true);
    expect(persisted.controllers[0]?.cameras).toBe(1);
    expect(typeof persisted.controllers[0]?.cameras).toBe('number');
    // home-monitor: jq '[.controllers[]?.cameras] | add'
    const cameraCount = persisted.controllers
      .map((controller) => controller.cameras)
      .reduce((sum, count) => sum + count, 0);
    expect(cameraCount).toBe(1);
    expect(persisted.controllers[0]?.lastEventAt).toBe('2026-11-08T07:36:00.000Z');
    expect(persisted.controllers[0]?.lastBootstrapAt).toBe('2026-11-08T07:35:00.000Z');
    expect(persisted.controllers[0]?.cameraHealth).toHaveLength(1);
    expect(persisted.controllers[0]?.cameraHealth[0]).toMatchObject({
      id: 'cam1',
      drift: false,
      readback: { status: 'verified' },
    });
  });

  it('writes atomically via a temp file then rename', () => {
    const health = report(snapshotFromCamera(camera, now, 1), true);
    const persisted = toPersistedHealth(health, now);
    const dir = mkdtempSync(join(tmpdir(), 'protect-health-'));
    writeHealthFileAtomic(dir, persisted);
    const dest = join(dir, HEALTH_FILENAME);
    expect(existsSync(dest)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const parsed = JSON.parse(readFileSync(dest, 'utf8')) as typeof persisted;
    expect(parsed.updatedAtEpoch).toBe(Math.floor(now / 1000));
    expect(parsed.controllers[0]?.cameras).toBe(1);
    expect(parsed.controllers[0]?.cameraHealth[0]?.readback.status).toBe('verified');
  });
});
