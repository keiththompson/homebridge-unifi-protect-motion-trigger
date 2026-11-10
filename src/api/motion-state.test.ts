import { describe, expect, it } from 'vitest';

import {
  motionDrift,
  motionReadbackMatches,
  observeSmartDetectPreferences,
  planMotionWrite,
  readMotionDiagnostics,
  smartDetectDrift,
} from './motion-state.js';
import type { SmartDetectConfig } from './smart-detect.js';
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

  it('plans a disable that remembers types and does not use motionSettings', () => {
    const plan = planMotionWrite(false, camera, null);

    expect(plan.payload).toEqual({
      recordingSettings: { enableMotionDetection: false },
      smartDetectSettings: {
        objectTypes: [],
        audioTypes: [],
        autoTrackingObjectTypes: [],
      },
    });
    expect(plan.payload).not.toHaveProperty('motionSettings');
    expect(plan.preferences).toEqual({
      objectTypes: ['person'],
      audioTypes: [],
      autoTrackingObjectTypes: ['person'],
    });
    expect(plan.expectedSmartDetect).toEqual({
      objectTypes: [],
      audioTypes: [],
      autoTrackingObjectTypes: [],
    });
  });

  it('restores the saved snapshot exactly, including a type chosen while shields were down', () => {
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

    const plan = planMotionWrite(true, live, saved);

    expect(plan.payload.smartDetectSettings).toEqual({
      objectTypes: ['person'],
      audioTypes: ['bark'],
      autoTrackingObjectTypes: ['person'],
    });
    expect(plan.expectedSmartDetect?.objectTypes).toEqual(['person']);
    expect(plan.payload).not.toHaveProperty('smartDetectZones');
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

    const drivewayOff = planMotionWrite(false, driveway, null);
    const yardOff = planMotionWrite(false, yard, null);

    expect(drivewayOff.payload.smartDetectZones).toEqual([
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
    expect(yardOff.payload.smartDetectZones).toEqual([
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
    expect(drivewayOff.config?.zones?.[0]?.sensitivity).toBe(75);
    expect(yardOff.config?.zones?.[0]?.objectTypes).toEqual(['person', 'vehicle']);

    const drivewayOn = planMotionWrite(true, disabledCamera(driveway), drivewayOff.config);
    const yardOn = planMotionWrite(true, disabledCamera(yard), yardOff.config);

    expect(drivewayOn.payload.smartDetectZones?.[0]).toMatchObject({
      name: 'Street',
      sensitivity: 75,
      objectTypes: ['person'],
    });
    expect(yardOn.payload.smartDetectZones?.[0]).toMatchObject({
      name: 'Yard',
      sensitivity: 50,
      objectTypes: ['person', 'vehicle'],
    });
    expect(drivewayOn.payload.smartDetectSettings?.objectTypes).toEqual(['person']);
    expect(yardOn.payload.smartDetectSettings?.objectTypes).toEqual(['person', 'vehicle']);
  });

  it('rejects readback that still has Create Motion Events enabled', () => {
    expect(
      motionReadbackMatches(camera, {
        createMotionEvents: false,
        smartDetect: { objectTypes: [], audioTypes: [], autoTrackingObjectTypes: [] },
      }),
    ).toBe(false);
  });

  it('reports drift when motion events are off but a smart detection type remains', () => {
    const drift = motionDrift(false, {
      createMotionEvents: false,
      smartDetect: { objectTypes: ['person'], audioTypes: [], autoTrackingObjectTypes: [] },
    });

    expect(drift).toBe(true);
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

    expect(smartDetectDrift(false, actual.smartDetectConfig, actual.smartDetect, null)).toBe(true);
    expect(motionDrift(false, actual)).toBe(true);
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

    const plan = planMotionWrite(false, live, saved);

    expect(plan.config?.objectTypes).toEqual(['person', 'vehicle']);
    expect(plan.config?.audioTypes).toEqual(['bark']);
    expect(plan.config?.zones?.[0]).toMatchObject({ name: 'Street', sensitivity: 75, objectTypes: ['person'] });
    expect(plan.payload.smartDetectSettings?.objectTypes).toEqual([]);
    expect(plan.payload.smartDetectZones?.[0]).toMatchObject({ sensitivity: 75, objectTypes: [] });
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

    const disabled = planMotionWrite(false, camera, null);
    expect(disabled.payload.secondLensSmartDetectZones?.[0]).toMatchObject({
      name: 'Package',
      sensitivity: 40,
      objectTypes: [],
    });
    expect(disabled.payload.smartDetectZones?.[0]).toMatchObject({ sensitivity: 75, objectTypes: [] });

    const restored = planMotionWrite(true, disabledCamera(camera), disabled.config);
    expect(restored.payload.secondLensSmartDetectZones?.[0]).toMatchObject({
      name: 'Package',
      sensitivity: 40,
      objectTypes: ['package'],
    });
    expect(restored.payload.smartDetectZones?.[0]).toMatchObject({ sensitivity: 75, objectTypes: ['person'] });
  });

  it('does not replace a saved zone snapshot when the live camera is already disabled', () => {
    const saved = planMotionWrite(
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

    const plan = planMotionWrite(false, disabled, saved);

    expect(plan.config?.zones?.[0]?.objectTypes).toEqual(['person']);
    expect(plan.config?.zones?.[0]?.sensitivity).toBe(75);
    expect(plan.payload).not.toHaveProperty('smartDetectZones');
  });

  it('does not let an empty event erase saved types while motion is off', () => {
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
