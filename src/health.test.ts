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
            snapshot,
          },
        ],
      },
    ],
  });
}

describe('health report', () => {
  it('uses schema 1.1.0 and reports unknown before any camera read', () => {
    const health = report(null, null);

    expect(health.schemaVersion).toBe(HEALTH_SCHEMA_VERSION);
    expect(health.schemaVersion).toBe('1.1.0');
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

  it('reports drift when motion events are off but smart detections are still configured', () => {
    const disabled = {
      ...camera,
      recordingSettings: { enableMotionDetection: false },
    } as unknown as ProtectCamera;
    const health = report(snapshotFromCamera(disabled, now, 1), false);

    expect(health.controllers[0]?.cameras[0]?.readback.status).toBe('mismatch');
    expect(health.controllers[0]?.cameras[0]?.drift).toBe(true);
    expect(health.controllers[0]?.cameras[0]?.smartDetectObjectTypes).toEqual(['person']);
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
  it('keeps home-monitor keys and stores schema 1.1.0 details beside the camera count', () => {
    const health = report(snapshotFromCamera(camera, now, 1), true);
    const persisted = toPersistedHealth(health, now, {
      '10.0.0.5': {
        reconnecting: false,
        consecutiveFailures: 0,
        lastEventAt: '2026-11-08T07:36:00.000Z',
        lastBootstrapAt: '2026-11-08T07:35:00.000Z',
      },
    });

    expect(persisted.schemaVersion).toBe('1.1.0');
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
