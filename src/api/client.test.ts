import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockLogger } from '../test/mocks.js';
import { ProtectClient } from './client.js';
import type { ProtectCamera, SmartDetectPreferences } from './types.js';

interface CameraStore {
  id: string;
  name: string;
  type: string;
  mac: string;
  host: string;
  lastMotion: null;
  ledSettings: { isEnabled: boolean };
  recordingSettings: { enableMotionDetection: boolean; mode: string };
  motionSettings: null | { isEnabled?: boolean };
  smartDetectSettings: SmartDetectPreferences;
}

const apiState = vi.hoisted(() => ({
  isThrottled: false,
  isAdminUser: true,
  honorPatch: true,
  lieInPatchBody: false,
  failReads: 0,
  updateDevice: vi.fn(),
  retrieve: vi.fn(),
  getApiEndpoint: vi.fn(),
}));

vi.mock('unifi-protect', () => ({
  ProtectApi: vi.fn().mockImplementation(function () {
    return {
      get isThrottled() {
        return apiState.isThrottled;
      },
      get isAdminUser() {
        return apiState.isAdminUser;
      },
      updateDevice: (...args: unknown[]) => apiState.updateDevice(...args),
      retrieve: (...args: unknown[]) => apiState.retrieve(...args),
      getApiEndpoint: (...args: unknown[]) => apiState.getApiEndpoint(...args),
      on: vi.fn(),
      reset: vi.fn(),
    };
  }),
}));

function cameraRecord(overrides: Partial<CameraStore> = {}): CameraStore {
  return {
    id: 'cam1',
    name: 'Front Door',
    type: 'UVC G4 Pro',
    mac: 'AA:BB:CC:DD:EE:FF',
    host: '192.168.1.50',
    lastMotion: null,
    ledSettings: { isEnabled: true },
    recordingSettings: { enableMotionDetection: true, mode: 'always' },
    motionSettings: null,
    smartDetectSettings: {
      objectTypes: ['person', 'vehicle'],
      audioTypes: ['bark'],
      autoTrackingObjectTypes: ['person'],
    },
    ...overrides,
  };
}

let store: CameraStore;

function applyPatch(target: CameraStore, payload: Record<string, unknown>): void {
  const led = payload.ledSettings as { isEnabled?: boolean } | undefined;
  if (led && typeof led.isEnabled === 'boolean') {
    target.ledSettings = { ...target.ledSettings, isEnabled: led.isEnabled };
  }
  const recording = payload.recordingSettings as { enableMotionDetection?: boolean } | undefined;
  if (recording && typeof recording.enableMotionDetection === 'boolean') {
    target.recordingSettings = {
      ...target.recordingSettings,
      enableMotionDetection: recording.enableMotionDetection,
    };
  }
  const smart = payload.smartDetectSettings as Partial<SmartDetectPreferences> | undefined;
  if (smart) {
    target.smartDetectSettings = { ...target.smartDetectSettings, ...smart };
  }
}

function jsonResponse(body: unknown): { statusCode: number; body: { json: () => Promise<unknown> } } {
  return { statusCode: 200, body: { json: async () => body } };
}

beforeEach(() => {
  store = cameraRecord();
  apiState.isThrottled = false;
  apiState.isAdminUser = true;
  apiState.honorPatch = true;
  apiState.lieInPatchBody = false;
  apiState.failReads = 0;
  apiState.getApiEndpoint = vi.fn(() => 'https://nvr.example/proxy/protect/api/cameras');
  apiState.updateDevice = vi.fn(async (_camera: unknown, payload: Record<string, unknown>) => {
    const echo = structuredClone(store);
    applyPatch(echo, payload);
    if (apiState.honorPatch) {
      applyPatch(store, payload);
    }
    return apiState.lieInPatchBody ? echo : structuredClone(store);
  });
  apiState.retrieve = vi.fn(async () => {
    if (apiState.failReads > 0) {
      apiState.failReads -= 1;
      return null;
    }
    return jsonResponse(structuredClone(store));
  });
});

function connectedClient(sleep: (ms: number) => Promise<void> = async () => undefined): ProtectClient {
  const client = new ProtectClient(createMockLogger(), { sleep });
  (client as unknown as { connected: boolean }).connected = true;
  return client;
}

const camera = { id: 'cam1', name: 'Front Door' } as ProtectCamera;

describe('ProtectClient device writes', () => {
  it('does not treat a successful PATCH as success when readback is unchanged', async () => {
    apiState.honorPatch = false;
    apiState.lieInPatchBody = true;
    const log = createMockLogger();
    const client = new ProtectClient(log, { sleep: async () => undefined });
    (client as unknown as { connected: boolean }).connected = true;

    const outcome = await client.updateCameraMotionDetection(camera, false);

    expect(outcome.result).toBe('mismatch');
    expect(apiState.updateDevice).toHaveBeenCalledTimes(1);
    const payload = apiState.updateDevice.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('motionSettings');
    expect(payload.recordingSettings).toEqual({ enableMotionDetection: false });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Readback mismatch for Front Door'));
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('was not treated as success'));
    expect(store.recordingSettings.enableMotionDetection).toBe(true);
    expect(store.motionSettings).toBeNull();
  });

  it('confirms Create Motion Events and restores smart detection types from the camera read', async () => {
    const client = connectedClient();
    const saved: SmartDetectPreferences = {
      objectTypes: ['person', 'vehicle'],
      audioTypes: ['bark'],
      autoTrackingObjectTypes: ['person'],
    };
    store.smartDetectSettings = {
      objectTypes: [],
      audioTypes: [],
      autoTrackingObjectTypes: [],
    };
    store.recordingSettings.enableMotionDetection = false;

    const outcome = await client.updateCameraMotionDetection(camera, true, saved);

    expect(outcome.result).toBe('ok');
    expect(store.recordingSettings.enableMotionDetection).toBe(true);
    expect(store.smartDetectSettings).toEqual(saved);
    expect(outcome.smartDetectPreferences).toEqual(saved);
    const payload = apiState.updateDevice.mock.calls[0]?.[1];
    expect(payload).toEqual({
      recordingSettings: { enableMotionDetection: true },
      smartDetectSettings: saved,
    });
  });

  it('clears smart detection lists while remembering them, without writing motionSettings', async () => {
    const client = connectedClient();

    const outcome = await client.updateCameraMotionDetection(camera, false);

    expect(outcome.result).toBe('ok');
    expect(store.recordingSettings.enableMotionDetection).toBe(false);
    expect(store.recordingSettings.mode).toBe('always');
    expect(store.smartDetectSettings).toEqual({
      objectTypes: [],
      audioTypes: [],
      autoTrackingObjectTypes: [],
    });
    expect(outcome.smartDetectPreferences).toEqual({
      objectTypes: ['person', 'vehicle'],
      audioTypes: ['bark'],
      autoTrackingObjectTypes: ['person'],
    });
    expect(apiState.updateDevice.mock.calls[0]?.[1]).not.toHaveProperty('motionSettings');
  });

  it('keeps smart detection types the controller gained while motion was off', async () => {
    store.recordingSettings.enableMotionDetection = false;
    store.smartDetectSettings = {
      objectTypes: ['animal'],
      audioTypes: [],
      autoTrackingObjectTypes: [],
    };
    const client = connectedClient();

    const outcome = await client.updateCameraMotionDetection(camera, true, {
      objectTypes: ['person'],
      audioTypes: ['bark'],
      autoTrackingObjectTypes: [],
    });

    expect(outcome.result).toBe('ok');
    expect(store.smartDetectSettings.objectTypes).toEqual(['animal']);
    expect(store.smartDetectSettings.audioTypes).toEqual(['bark']);
    const payload = apiState.updateDevice.mock.calls[0]?.[1] as {
      smartDetectSettings?: SmartDetectPreferences;
    };
    expect(payload.smartDetectSettings?.objectTypes).toBeUndefined();
    expect(payload.smartDetectSettings?.audioTypes).toEqual(['bark']);
  });

  it('retries readback on a bounded schedule and then confirms the later camera record', async () => {
    const sleeps: number[] = [];
    let reads = 0;
    apiState.honorPatch = false;
    apiState.retrieve = vi.fn(async () => {
      reads += 1;
      const enabled = reads >= 4 ? false : store.recordingSettings.enableMotionDetection;
      return jsonResponse({
        ...structuredClone(store),
        recordingSettings: { ...store.recordingSettings, enableMotionDetection: enabled },
        smartDetectSettings: {
          objectTypes: [],
          audioTypes: [],
          autoTrackingObjectTypes: [],
        },
      });
    });
    const client = connectedClient(async (ms) => {
      sleeps.push(ms);
    });

    const outcome = await client.updateCameraMotionDetection(camera, false);

    expect(outcome.result).toBe('ok');
    expect(sleeps).toEqual([250, 500]);
    expect(apiState.retrieve).toHaveBeenCalledTimes(4);
    expect(apiState.retrieve.mock.calls[0]?.[0]).toBe('https://nvr.example/proxy/protect/api/cameras/cam1');
  });

  it('returns failed when the controller rejects the write', async () => {
    apiState.updateDevice = vi.fn().mockResolvedValue(null);
    const log = createMockLogger();
    const client = new ProtectClient(log, { sleep: async () => undefined });
    (client as unknown as { connected: boolean }).connected = true;

    const outcome = await client.updateCameraLed(camera, true);

    expect(outcome.result).toBe('failed');
    expect(log.info).not.toHaveBeenCalled();
  });

  it('returns failed when readback never returns a camera', async () => {
    apiState.retrieve = vi.fn().mockResolvedValue(null);
    const client = connectedClient();

    const outcome = await client.updateCameraLed(camera, false);

    expect(outcome.result).toBe('failed');
  });

  it('returns failed without calling the API when not connected', async () => {
    const client = new ProtectClient(createMockLogger());

    const outcome = await client.updateCameraMotionDetection(camera, true);

    expect(outcome.result).toBe('failed');
    expect(apiState.updateDevice).not.toHaveBeenCalled();
    expect(apiState.retrieve).not.toHaveBeenCalled();
  });

  it('returns throttled without calling the API while throttled', async () => {
    apiState.isThrottled = true;
    const client = connectedClient();

    const outcome = await client.updateCameraLed(camera, false);

    expect(outcome.result).toBe('throttled');
    expect(apiState.updateDevice).not.toHaveBeenCalled();
  });

  it('returns unauthorized without calling the API when the account is not an admin', async () => {
    apiState.isAdminUser = false;
    const client = connectedClient();

    const outcome = await client.updateCameraMotionDetection(camera, true);

    expect(outcome.result).toBe('unauthorized');
    expect(apiState.updateDevice).not.toHaveBeenCalled();
    expect(apiState.retrieve).not.toHaveBeenCalled();
  });

  it('merges LED and motion into a single update and confirms both by readback', async () => {
    const client = connectedClient();

    const outcome = await client.updateCameraSettings(camera, { led: false, motion: false });

    expect(outcome.result).toBe('ok');
    expect(apiState.updateDevice).toHaveBeenCalledTimes(1);
    expect(apiState.updateDevice).toHaveBeenCalledWith(
      camera,
      expect.objectContaining({
        ledSettings: { isEnabled: false },
        recordingSettings: { enableMotionDetection: false },
      }),
    );
    expect(store.ledSettings.isEnabled).toBe(false);
    expect(store.recordingSettings.enableMotionDetection).toBe(false);
  });

  it('makes no API call when no settings are provided', async () => {
    const client = connectedClient();

    const outcome = await client.updateCameraSettings(camera, {});

    expect(outcome.result).toBe('ok');
    expect(apiState.updateDevice).not.toHaveBeenCalled();
    expect(apiState.retrieve).not.toHaveBeenCalled();
  });

  it('serializes writes so they never run concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    apiState.updateDevice = vi.fn(async (_camera: unknown, payload: Record<string, unknown>) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      applyPatch(store, payload);
      return structuredClone(store);
    });
    const client = connectedClient();

    await Promise.all([
      client.updateCameraLed(camera, true),
      client.updateCameraLed(camera, false),
      client.updateCameraMotionDetection(camera, true),
    ]);

    expect(maxActive).toBe(1);
    expect(apiState.updateDevice).toHaveBeenCalledTimes(3);
  });

  it('keeps the queue alive after a rejected write', async () => {
    apiState.updateDevice = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementation(async (_camera: unknown, payload: Record<string, unknown>) => {
        applyPatch(store, payload);
        return structuredClone(store);
      });
    const client = connectedClient();

    const first = await client.updateCameraLed(camera, true);
    const second = await client.updateCameraLed(camera, false);

    expect(first.result).toBe('failed');
    expect(second.result).toBe('ok');
  });

  it('refresh replaces a good snapshot with an error instead of keeping stale success', async () => {
    const client = connectedClient();
    client.seedSnapshots([store], 1_000);
    apiState.retrieve = vi.fn().mockRejectedValue(new Error('controller timeout'));

    const snapshot = await client.refreshCamera(camera);

    expect(snapshot.ok).toBe(false);
    expect(snapshot.error).toBe('controller timeout');
    expect(snapshot.createMotionEvents).toBeNull();
    expect(client.getCameraSnapshot('cam1')?.ok).toBe(false);
  });
});
