import { describe, expect, it } from 'vitest';

import {
  motionDrift,
  motionReadbackMatches,
  observeSmartDetectPreferences,
  planMotionWrite,
  readMotionDiagnostics,
} from './motion-state.js';
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

  it('does not restore over smart detection types configured while the switch was off', () => {
    const live = {
      ...camera,
      recordingSettings: { enableMotionDetection: false },
      smartDetectSettings: { objectTypes: ['animal'], audioTypes: [], autoTrackingObjectTypes: [] },
    } as unknown as ProtectCamera;

    const plan = planMotionWrite(true, live, {
      objectTypes: ['person'],
      audioTypes: ['bark'],
      autoTrackingObjectTypes: ['person'],
    });

    expect(plan.payload.smartDetectSettings).toEqual({
      audioTypes: ['bark'],
      autoTrackingObjectTypes: ['person'],
    });
    expect(plan.expectedSmartDetect?.objectTypes).toEqual(['animal']);
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
