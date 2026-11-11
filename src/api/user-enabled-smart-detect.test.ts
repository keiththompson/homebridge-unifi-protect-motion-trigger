import { describe, expect, it } from 'vitest';

import { planSmartDetectWrite, type SmartDetectConfig, type SmartDetectZoneSnapshot } from './smart-detect.js';
import type { ProtectCamera } from './types.js';

const porch = [
  [0, 0],
  [1, 0],
  [1, 1],
];
const drive = [
  [0.1, 0.8],
  [0.9, 0.8],
  [0.9, 1],
];

function zone(id: number, name: string, types: string[], points: number[][]): SmartDetectZoneSnapshot {
  return {
    id,
    name,
    points,
    sensitivity: 50,
    objectTypes: [...types],
    raw: { id, name, points, sensitivity: 50, objectTypes: [...types] },
  };
}

function config(overrides: Partial<SmartDetectConfig>): SmartDetectConfig {
  return {
    objectTypes: [],
    audioTypes: [],
    autoTrackingObjectTypes: [],
    settingsPresent: true,
    zones: null,
    secondLensZones: null,
    ...overrides,
  };
}

function camera(value: SmartDetectConfig, type = 'UVC G4 Bullet'): ProtectCamera {
  return {
    id: 'c',
    name: 'Cam',
    type,
    mac: 'AA',
    host: '1.2.3.4',
    lastMotion: null,
    recordingSettings: { enableMotionDetection: true, mode: 'always' },
    motionSettings: null,
    smartDetectSettings: {
      objectTypes: [...value.objectTypes],
      audioTypes: [...value.audioTypes],
      autoTrackingObjectTypes: [...value.autoTrackingObjectTypes],
    },
    smartDetectZones: value.zones?.map((entry) => ({ ...entry.raw, objectTypes: [...entry.objectTypes] })),
    secondLensSmartDetectZones: value.secondLensZones?.map((entry) => ({
      ...entry.raw,
      objectTypes: [...entry.objectTypes],
    })),
  };
}

describe('user-enabled types on a list the previous snapshot left empty', () => {
  it('keeps an audio type the user enabled on a single-lens camera', () => {
    const saved = config({ objectTypes: ['person'], zones: [zone(1, 'Yard', ['person'], porch)] });
    const live = config({
      objectTypes: ['person'],
      audioTypes: ['alrmSmoke'],
      zones: [zone(1, 'Yard', ['person'], porch)],
    });
    const plan = planSmartDetectWrite(false, camera(live), saved);

    expect(plan.patch.smartDetectSettings?.audioTypes ?? []).toEqual([]);
    expect(plan.config?.audioTypes).toEqual(['alrmSmoke']);
  });

  it('keeps a second zone the user switched from empty to vehicle', () => {
    const saved = config({
      zones: [zone(1, 'Yard', ['person'], porch), zone(2, 'Drive', [], drive)],
    });
    const live = config({
      zones: [zone(1, 'Yard', ['person'], porch), zone(2, 'Drive', ['vehicle'], drive)],
    });
    const plan = planSmartDetectWrite(false, camera(live), saved);

    expect(plan.config?.zones?.[1]?.objectTypes).toEqual(['vehicle']);
  });

  it('keeps person the user added on a doorbell second lens', () => {
    const saved = config({
      zones: [zone(1, 'Entrance', ['person', 'vehicle'], porch)],
      secondLensZones: [zone(2, 'Down', [], drive)],
    });
    const live = config({
      zones: [zone(1, 'Entrance', ['person', 'vehicle'], porch)],
      secondLensZones: [zone(2, 'Down', ['package', 'person'], drive)],
    });
    const plan = planSmartDetectWrite(false, camera(live, 'UVC G4 Doorbell Pro PoE'), saved);

    expect(plan.config?.secondLensZones?.[0]?.objectTypes).toContain('person');
  });
});
