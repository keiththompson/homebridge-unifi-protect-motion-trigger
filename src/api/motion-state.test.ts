import { describe, expect, it } from 'vitest';

import {
  motionDrift,
  motionReadbackMatches,
  observeSmartDetectPreferences,
  planMotionWrite,
  readMotionDiagnostics,
  smartDetectDrift,
} from './motion-state.js';
import { planSmartDetectWrite, type SmartDetectConfig } from './smart-detect.js';
import type { ProtectCamera } from './types.js';

const camera = {
  id: 'cam1',
  name: 'Driveway',
  recordingSettings: { enableMotionDetection: true, mode: 'always' },
  motionSettings: null,
  smartDetectSettings: {
    objectTypes: ['person'],
    audioTypes: [],
    autoTrackingObjectTypes: ['person'],
  },
} as unknown as ProtectCamera;

describe('motion state', () => {
  it('reads Create Motion Events separately from a null motionSettings object', () => {
    const diagnostics = readMotionDiagnostics(camera);

    expect(diagnostics.createMotionEvents).toBe(true);
    expect(diagnostics.motionSettingsKnown).toBe(true);
    expect(diagnostics.motionSettings).toBeNull();
    expect(diagnostics.smartDetect?.objectTypes).toEqual(['person']);
  });

  it('plans a motion disable that only changes Create Motion Events', () => {
    const plan = planMotionWrite(false);

    expect(plan.payload).toEqual({
      recordingSettings: { enableMotionDetection: false },
    });
    expect(plan.payload).not.toHaveProperty('motionSettings');
    expect(plan.payload).not.toHaveProperty('smartDetectSettings');
    expect(plan.payload).not.toHaveProperty('smartDetectZones');
  });

  it('restores the saved snapshot exactly, including a type chosen while smart detection was off', () => {
    const live = {
      ...camera,
      recordingSettings: { enableMotionDetection: false },
      smartDetectSettings: { objectTypes: ['animal'], audioTypes: [], autoTrackingObjectTypes: [] },
    } as unknown as ProtectCamera;
    const saved: SmartDetectConfig = {
      objectTypes: ['person'],
      audioTypes: ['bark'],
      autoTrackingObjectTypes: ['person'],
      settingsPresent: true,
      zones: null,
      secondLensZones: null,
    };

    const plan = planSmartDetectWrite(true, live, saved);

    expect(plan.patch.smartDetectSettings).toEqual({
      objectTypes: ['person'],
      audioTypes: ['bark'],
      autoTrackingObjectTypes: ['person'],
    });
    expect(plan.expectedConfig?.objectTypes).toEqual(['person']);
    expect(plan.patch).not.toHaveProperty('smartDetectZones');
  });

  it('disables and restores each camera zone without borrowing another camera defaults', () => {
    const driveway = cameraWithZone(
      'Driveway',
      'Street',
      75,
      ['person'],
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    );
    const yard = cameraWithZone(
      'Backyard',
      'Yard',
      50,
      ['person', 'vehicle'],
      [
        [0.2, 0.2],
        [0.8, 0.2],
        [0.8, 0.8],
      ],
    );

    const drivewayOff = planSmartDetectWrite(false, driveway, null);
    const yardOff = planSmartDetectWrite(false, yard, null);

    expect(drivewayOff.patch.smartDetectZones).toEqual([
      expect.objectContaining({
        name: 'Street',
        sensitivity: 75,
        objectTypes: [],
        points: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      }),
    ]);
    expect(yardOff.patch.smartDetectZones).toEqual([
      expect.objectContaining({
        name: 'Yard',
        sensitivity: 50,
        objectTypes: [],
        points: [
          [0.2, 0.2],
          [0.8, 0.2],
          [0.8, 0.8],
        ],
      }),
    ]);
    expect(drivewayOff.patch.smartDetectZones?.[0]).not.toHaveProperty('mergeId');
    expect(drivewayOff.config?.zones?.[0]?.sensitivity).toBe(75);
    expect(yardOff.config?.zones?.[0]?.objectTypes).toEqual(['person', 'vehicle']);

    const drivewayOn = planSmartDetectWrite(true, disabledCamera(driveway), drivewayOff.config);
    const yardOn = planSmartDetectWrite(true, disabledCamera(yard), yardOff.config);

    expect(drivewayOn.patch.smartDetectZones?.[0]).toMatchObject({
      name: 'Street',
      sensitivity: 75,
      objectTypes: ['person'],
    });
    expect(yardOn.patch.smartDetectZones?.[0]).toMatchObject({
      name: 'Yard',
      sensitivity: 50,
      objectTypes: ['person', 'vehicle'],
    });
    expect(drivewayOn.patch.smartDetectSettings?.objectTypes).toEqual(['person']);
    expect(yardOn.patch.smartDetectSettings?.objectTypes).toEqual(['person', 'vehicle']);
  });

  it('rejects readback that still has Create Motion Events enabled', () => {
    expect(
      motionReadbackMatches(camera, {
        createMotionEvents: false,
        smartDetect: { objectTypes: [], audioTypes: [], autoTrackingObjectTypes: [] },
      }),
    ).toBe(false);
  });

  it('does not treat remaining smart detection as motion drift', () => {
    const drift = motionDrift(false, {
      createMotionEvents: false,
    });

    expect(drift).toBe(false);
  });

  it('reports drift when zone object types remain after settings lists were cleared', () => {
    const actual = readMotionDiagnostics(
      cameraWithZone(
        'Driveway',
        'Street',
        75,
        ['person'],
        [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      ),
    );
    actual.createMotionEvents = false;
    if (actual.smartDetectConfig) {
      actual.smartDetectConfig.objectTypes = [];
      actual.smartDetectConfig.autoTrackingObjectTypes = [];
    }

    expect(smartDetectDrift(false, actual.smartDetectConfig, null)).toBe(true);
    expect(motionDrift(false, actual)).toBe(false);
  });

  it('keeps saved settings lists when a previous version cleared them but left zones on', () => {
    const live = cameraWithZone(
      'Driveway',
      'Street',
      75,
      ['person'],
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    );
    live.smartDetectSettings = { objectTypes: [], audioTypes: [], autoTrackingObjectTypes: [] };
    const saved: SmartDetectConfig = {
      objectTypes: ['person', 'vehicle'],
      audioTypes: ['bark'],
      autoTrackingObjectTypes: [],
      settingsPresent: true,
      zones: null,
      secondLensZones: null,
    };

    const plan = planSmartDetectWrite(false, live, saved);

    expect(plan.config?.objectTypes).toEqual(['person', 'vehicle']);
    expect(plan.config?.audioTypes).toEqual(['bark']);
    expect(plan.config?.zones?.[0]).toMatchObject({ name: 'Street', sensitivity: 75, objectTypes: ['person'] });
    expect(plan.patch.smartDetectSettings?.objectTypes).toEqual([]);
    expect(plan.patch.smartDetectZones?.[0]).toMatchObject({ sensitivity: 75, objectTypes: [] });
  });

  it('clears and restores a second-lens zone without using the primary zone sensitivity', () => {
    const camera = cameraWithZone(
      'Doorbell',
      'Porch',
      75,
      ['person'],
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    );
    camera.secondLensSmartDetectZones = [
      {
        id: 2,
        name: 'Package',
        color: '#abcdef',
        points: [
          [0.1, 0.1],
          [0.2, 0.1],
          [0.2, 0.3],
        ],
        sensitivity: 40,
        objectTypes: ['package'],
      },
    ];

    const disabled = planSmartDetectWrite(false, camera, null);
    expect(disabled.patch.secondLensSmartDetectZones?.[0]).toMatchObject({
      name: 'Package',
      sensitivity: 40,
      objectTypes: [],
    });
    expect(disabled.patch.smartDetectZones?.[0]).toMatchObject({ sensitivity: 75, objectTypes: [] });

    const restored = planSmartDetectWrite(true, disabledCamera(camera), disabled.config);
    expect(restored.patch.secondLensSmartDetectZones?.[0]).toMatchObject({
      name: 'Package',
      sensitivity: 40,
      objectTypes: ['package'],
    });
    expect(restored.patch.smartDetectZones?.[0]).toMatchObject({ sensitivity: 75, objectTypes: ['person'] });
  });

  it('does not replace a saved zone snapshot when the live camera is already disabled', () => {
    const saved = planSmartDetectWrite(
      false,
      cameraWithZone(
        'Driveway',
        'Street',
        75,
        ['person'],
        [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      ),
      null,
    ).config;
    const disabled = disabledCamera(
      cameraWithZone(
        'Driveway',
        'Street',
        75,
        ['person'],
        [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      ),
    );

    const plan = planSmartDetectWrite(false, disabled, saved);

    expect(plan.config?.zones?.[0]?.objectTypes).toEqual(['person']);
    expect(plan.config?.zones?.[0]?.sensitivity).toBe(75);
    expect(plan.patch).not.toHaveProperty('smartDetectZones');
  });

  it('does not let an empty event erase saved types while smart detection is off', () => {
    const saved = observeSmartDetectPreferences(
      { objectTypes: ['person'], audioTypes: ['bark'], autoTrackingObjectTypes: [] },
      { objectTypes: [], audioTypes: ['siren'] },
      false,
    );

    expect(saved).toEqual({
      objectTypes: ['person'],
      audioTypes: ['siren'],
      autoTrackingObjectTypes: [],
    });
  });
});

function cameraWithZone(
  name: string,
  zoneName: string,
  sensitivity: number,
  objectTypes: string[],
  points: number[][],
): ProtectCamera {
  return {
    id: name,
    name,
    type: 'UVC G4',
    mac: 'AA:BB:CC:DD:EE:FF',
    host: '192.168.1.50',
    lastMotion: null,
    recordingSettings: { enableMotionDetection: true, mode: 'always' },
    motionSettings: null,
    smartDetectSettings: {
      objectTypes: [...objectTypes],
      audioTypes: [],
      autoTrackingObjectTypes: [],
    },
    smartDetectZones: [
      {
        id: 1,
        name: zoneName,
        color: '#2c3e50',
        points,
        sensitivity,
        objectTypes: [...objectTypes],
        mergeId: 'read-only',
      },
    ],
  };
}

function disabledCamera(source: ProtectCamera): ProtectCamera {
  const copy = structuredClone(source);
  copy.recordingSettings = { enableMotionDetection: false, mode: source.recordingSettings?.mode };
  if (copy.smartDetectSettings) {
    copy.smartDetectSettings = {
      objectTypes: [],
      audioTypes: [],
      autoTrackingObjectTypes: [],
    };
  }
  if (Array.isArray(copy.smartDetectZones)) {
    copy.smartDetectZones = copy.smartDetectZones.map((zone) => {
      const record = zone as Record<string, unknown>;
      return { ...record, objectTypes: [] };
    });
  }
  return copy;
}
