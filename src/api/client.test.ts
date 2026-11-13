import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildHealthReport } from '../health.js';
import { SMART_DETECT_SNAPSHOT_FILENAME } from '../settings.js';
import { SmartDetectSnapshotStore } from '../smart-detect-store.js';
import { createMockLogger } from '../test/mocks.js';
import { EVENTS_SOCKET_GRACE_MS, ProtectClient, SESSION_WATCHDOG_BASE_MS, SESSION_WATCHDOG_MAX_MS } from './client.js';
import { readSmartDetectConfig } from './smart-detect.js';
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
  smartDetectZones?: Record<string, unknown>[];
  secondLensSmartDetectZones?: Record<string, unknown>[];
}

const apiState = vi.hoisted(() => ({
  isThrottled: false,
  isAdminUser: true,
  honorPatch: true,
  lieInPatchBody: false,
  failReads: 0,
  bootstrap: { cameras: [] as unknown[], lastUpdateId: '1' } as { cameras: unknown[]; lastUpdateId: string } | null,
  eventsWs: { readyState: 1 } as { readyState?: number } | null,
  updateDevice: vi.fn(),
  retrieve: vi.fn(),
  getApiEndpoint: vi.fn(),
  getBootstrap: vi.fn(async () => true),
  login: vi.fn(async (..._args: unknown[]) => true),
  reset: vi.fn(),
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
      get bootstrap() {
        return apiState.bootstrap;
      },
      get _eventsWs() {
        return apiState.eventsWs;
      },
      updateDevice: (...args: unknown[]) => apiState.updateDevice(...args),
      retrieve: (...args: unknown[]) => apiState.retrieve(...args),
      getApiEndpoint: (...args: unknown[]) => apiState.getApiEndpoint(...args),
      getBootstrap: () => apiState.getBootstrap(),
      login: (...args: unknown[]) => apiState.login(...args),
      on: vi.fn(),
      reset: () => apiState.reset(),
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
  if (Array.isArray(payload.smartDetectZones)) {
    target.smartDetectZones = payload.smartDetectZones as Record<string, unknown>[];
  }
  if (Array.isArray(payload.secondLensSmartDetectZones)) {
    target.secondLensSmartDetectZones = payload.secondLensSmartDetectZones as Record<string, unknown>[];
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
  apiState.bootstrap = { cameras: [], lastUpdateId: '1' };
  apiState.eventsWs = { readyState: 1 };
  apiState.getBootstrap = vi.fn(async () => true);
  apiState.login = vi.fn(async (..._args: unknown[]) => true);
  apiState.reset = vi.fn();
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

  it('confirms Create Motion Events without changing smart detection', async () => {
    const client = connectedClient();
    const original = { ...store.smartDetectSettings };
    store.recordingSettings.enableMotionDetection = false;

    const outcome = await client.updateCameraMotionDetection(camera, true);

    expect(outcome.result).toBe('ok');
    expect(outcome.smartDetectResult).toBeNull();
    expect(store.recordingSettings.enableMotionDetection).toBe(true);
    expect(store.smartDetectSettings).toEqual(original);
    expect(apiState.updateDevice.mock.calls[0]?.[1]).toEqual({
      recordingSettings: { enableMotionDetection: true },
    });
  });

  it('turns motion off without writing smart detection or motionSettings', async () => {
    const client = connectedClient();
    const original = { ...store.smartDetectSettings };

    const outcome = await client.updateCameraMotionDetection(camera, false);

    expect(outcome.result).toBe('ok');
    expect(store.recordingSettings.enableMotionDetection).toBe(false);
    expect(store.recordingSettings.mode).toBe('always');
    expect(store.smartDetectSettings).toEqual(original);
    const payload = apiState.updateDevice.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('motionSettings');
    expect(payload).not.toHaveProperty('smartDetectSettings');
    expect(payload).not.toHaveProperty('smartDetectZones');
  });

  it('restores the saved smart detection snapshot instead of types set while it was off', async () => {
    store.smartDetectSettings = {
      objectTypes: ['animal'],
      audioTypes: [],
      autoTrackingObjectTypes: [],
    };
    const client = connectedClient();

    const outcome = await client.updateCameraSmartDetection(camera, true, {
      objectTypes: ['person'],
      audioTypes: ['bark'],
      autoTrackingObjectTypes: [],
      settingsPresent: true,
      zones: null,
      secondLensZones: null,
    });

    expect(outcome.smartDetectResult).toBe('ok');
    expect(store.smartDetectSettings).toEqual({
      objectTypes: ['person'],
      audioTypes: ['bark'],
      autoTrackingObjectTypes: [],
    });
    const payload = apiState.updateDevice.mock.calls[0]?.[1] as {
      smartDetectSettings?: SmartDetectPreferences;
      recordingSettings?: unknown;
    };
    expect(payload.recordingSettings).toBeUndefined();
    expect(payload.smartDetectSettings).toEqual({
      objectTypes: ['person'],
      audioTypes: ['bark'],
      autoTrackingObjectTypes: [],
    });
  });

  it('retries readback on a bounded schedule and then confirms the later camera record', async () => {
    const sleeps: number[] = [];
    let reads = 0;
    apiState.honorPatch = false;
    apiState.retrieve = vi.fn(async () => {
      reads += 1;
      const enabled = reads >= 3 ? false : store.recordingSettings.enableMotionDetection;
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
    expect(apiState.retrieve).toHaveBeenCalledTimes(3);
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

  it('returns unauthorized after a fresh bootstrap confirms the account is not an admin', async () => {
    apiState.isAdminUser = false;
    const client = connectedClient();

    const outcome = await client.updateCameraMotionDetection(camera, true);

    expect(outcome.result).toBe('unauthorized');
    expect(apiState.getBootstrap).toHaveBeenCalledTimes(1);
    expect(apiState.updateDevice).not.toHaveBeenCalled();
    expect(apiState.retrieve).not.toHaveBeenCalled();
  });

  it('leaves Protect unchanged when smart detection is turned on with nothing saved', async () => {
    store.smartDetectSettings = { objectTypes: [], audioTypes: [], autoTrackingObjectTypes: [] };
    const log = createMockLogger();
    const client = new ProtectClient(log, { sleep: async () => undefined });
    (client as unknown as { connected: boolean }).connected = true;

    const outcome = await client.updateCameraSmartDetection(camera, true);

    expect(outcome.smartDetectResult).toBe('failed');
    expect(apiState.updateDevice).not.toHaveBeenCalled();
    expect(store.smartDetectSettings.objectTypes).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('No saved smart detection configuration'));
  });

  it('sends motion and smart detection in one serialized update', async () => {
    const client = connectedClient();

    const outcome = await client.updateCameraSettings(camera, { motion: false, smartDetect: false });

    expect(outcome.result).toBe('ok');
    expect(outcome.smartDetectResult).toBe('ok');
    expect(apiState.updateDevice).toHaveBeenCalledTimes(1);
    const payload = apiState.updateDevice.mock.calls[0]?.[1] as {
      recordingSettings?: { enableMotionDetection: boolean };
      smartDetectSettings?: { objectTypes: string[] };
    };
    expect(payload.recordingSettings).toEqual({ enableMotionDetection: false });
    expect(payload.smartDetectSettings?.objectTypes).toEqual([]);
    expect(store.recordingSettings.enableMotionDetection).toBe(false);
    expect(store.smartDetectSettings.objectTypes).toEqual([]);
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

function doorbellRecord(secondLensTypes: string[]): CameraStore {
  return cameraRecord({
    id: 'doorbell',
    name: 'Doorbell',
    type: 'UVC G4 Doorbell Pro PoE',
    smartDetectSettings: {
      objectTypes: [],
      audioTypes: [],
      autoTrackingObjectTypes: [],
    },
    smartDetectZones: [
      {
        id: 1,
        name: 'Zone A',
        color: '#123456',
        points: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        sensitivity: 70,
        objectTypes: ['person', 'vehicle'],
      },
    ],
    secondLensSmartDetectZones: [
      {
        id: 2,
        name: 'Down',
        color: '#abcdef',
        points: [
          [0.1, 0.8],
          [0.9, 0.8],
          [0.9, 1],
        ],
        sensitivity: 40,
        objectTypes: [...secondLensTypes],
      },
    ],
  });
}

const AGGREGATE_AUDIO_TYPES = ['smoke', 'siren', 'bark', 'speak'];
const AGGREGATE_OBJECT_TYPES = ['person', 'vehicle', 'package'];

function aggregateDoorbell(objectTypes: string[], secondTypes: string[]): CameraStore {
  const zone = (id: number, types: string[]): Record<string, unknown> => ({
    id,
    name: 'Default',
    points: [
      [0, 0],
      [1, 0],
      [1, 1],
    ],
    sensitivity: 50,
    objectTypes: [...types],
  });
  return cameraRecord({
    id: 'doorbell',
    name: 'Doorbell',
    smartDetectSettings: {
      objectTypes: [...objectTypes],
      audioTypes: objectTypes.length > 0 ? [...AGGREGATE_AUDIO_TYPES] : [],
      autoTrackingObjectTypes: [],
    },
    smartDetectZones: [zone(1, [])],
    secondLensSmartDetectZones: [zone(2, secondTypes)],
  });
}

function keepForcedPackage(target: CameraStore): void {
  const lens = target.secondLensSmartDetectZones?.[0];
  if (lens && Array.isArray(lens.objectTypes) && lens.objectTypes.length === 0) {
    target.secondLensSmartDetectZones = [{ ...lens, objectTypes: ['package'] }];
  }
}

function refillEmptySecondLens(target: CameraStore): void {
  const zones = target.secondLensSmartDetectZones;
  const zone = zones?.[0];
  if (!zones || !zone) {
    return;
  }
  const types = Array.isArray(zone.objectTypes) ? zone.objectTypes : [];
  if (types.length === 0) {
    zones[0] = { ...zone, objectTypes: ['package'] };
  }
}

function readConfig(camera: CameraStore): ReturnType<typeof readSmartDetectConfig> {
  return readSmartDetectConfig(camera as unknown as ProtectCamera);
}

function zone(name: string, sensitivity: number, objectTypes: string[], points: number[][]): Record<string, unknown> {
  return {
    id: name === 'Street' ? 7 : 3,
    name,
    color: '#123456',
    points,
    sensitivity,
    objectTypes: [...objectTypes],
  };
}

function zonedCamera(
  id: string,
  name: string,
  zoneName: string,
  sensitivity: number,
  objectTypes: string[],
  points: number[][],
): CameraStore {
  return cameraRecord({
    id,
    name,
    smartDetectSettings: {
      objectTypes: [...objectTypes],
      audioTypes: [],
      autoTrackingObjectTypes: [],
    },
    smartDetectZones: [zone(zoneName, sensitivity, objectTypes, points)],
  });
}

describe('smart detection snapshots', () => {
  it('disables every camera, restores each zone after a restart, and does not save the disabled config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'protect-smart-'));
    const file = join(dir, SMART_DETECT_SNAPSHOT_FILENAME);
    const driveway = zonedCamera(
      'driveway',
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
    const yard = zonedCamera(
      'yard',
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
    const cameras = new Map<string, CameraStore>([
      ['driveway', driveway],
      ['yard', yard],
    ]);
    apiState.updateDevice = vi.fn(async (camera: { id: string }, payload: Record<string, unknown>) => {
      const target = cameras.get(camera.id);
      if (!target) {
        return null;
      }
      applyPatch(target, payload);
      return structuredClone(target);
    });
    apiState.retrieve = vi.fn(async (url: string) => {
      const id = url.split('/').pop() ?? '';
      const target = cameras.get(id);
      return target ? jsonResponse(structuredClone(target)) : null;
    });

    const store = new SmartDetectSnapshotStore(() => dir);
    const client = new ProtectClient(createMockLogger(), {
      sleep: async () => undefined,
      smartDetectStore: store,
      controllerAddress: '10.0.0.5',
    });
    (client as unknown as { connected: boolean }).connected = true;

    const disabledDriveway = await client.updateCameraSmartDetection(
      { id: 'driveway', name: 'Driveway' } as ProtectCamera,
      false,
    );
    const disabledYard = await client.updateCameraSmartDetection(
      { id: 'yard', name: 'Backyard' } as ProtectCamera,
      false,
    );

    expect(disabledDriveway.smartDetectResult).toBe('ok');
    expect(disabledYard.smartDetectResult).toBe('ok');
    expect(driveway.recordingSettings.enableMotionDetection).toBe(true);
    expect(yard.smartDetectZones?.[0]?.sensitivity).toBe(50);
    expect(driveway.smartDetectZones?.[0]?.objectTypes).toEqual([]);
    expect(yard.smartDetectZones?.[0]?.objectTypes).toEqual([]);
    expect(driveway.smartDetectSettings.objectTypes).toEqual([]);
    expect(yard.smartDetectSettings.objectTypes).toEqual([]);

    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      cameras: Array<{ cameraId: string; config: { objectTypes: string[]; zones: Array<Record<string, unknown>> } }>;
    };
    const savedDriveway = saved.cameras.find((entry) => entry.cameraId === 'driveway');
    const savedYard = saved.cameras.find((entry) => entry.cameraId === 'yard');
    expect(savedDriveway?.config.objectTypes).toEqual(['person']);
    expect(savedDriveway?.config.zones[0]).toMatchObject({ name: 'Street', sensitivity: 75, objectTypes: ['person'] });
    expect(savedYard?.config.zones[0]).toMatchObject({
      name: 'Yard',
      sensitivity: 50,
      objectTypes: ['person', 'vehicle'],
    });
    expect(JSON.stringify(saved)).not.toContain('password');

    const restarted = new SmartDetectSnapshotStore(() => dir);
    const restartedClient = new ProtectClient(createMockLogger(), {
      sleep: async () => undefined,
      smartDetectStore: restarted,
      controllerAddress: '10.0.0.5',
    });
    (restartedClient as unknown as { connected: boolean }).connected = true;
    apiState.updateDevice.mockClear();

    const stillDown = await restartedClient.updateCameraSmartDetection(
      { id: 'driveway', name: 'Driveway' } as ProtectCamera,
      false,
    );
    expect(stillDown.result).toBe('ok');
    const afterDown = JSON.parse(readFileSync(file, 'utf8')) as typeof saved;
    expect(afterDown.cameras.find((entry) => entry.cameraId === 'driveway')?.config.zones[0]).toMatchObject({
      sensitivity: 75,
      objectTypes: ['person'],
    });

    const upDriveway = await restartedClient.updateCameraSmartDetection(
      { id: 'driveway', name: 'Driveway' } as ProtectCamera,
      true,
    );
    const upYard = await restartedClient.updateCameraSmartDetection(
      { id: 'yard', name: 'Backyard' } as ProtectCamera,
      true,
    );

    expect(upDriveway.smartDetectResult).toBe('ok');
    expect(upYard.smartDetectResult).toBe('ok');
    const payloads = apiState.updateDevice.mock.calls.map((call) => call[1] as Record<string, unknown>);
    const drivewayPayload = payloads.find((payload) => {
      const zones = payload.smartDetectZones as Array<Record<string, unknown>> | undefined;
      return zones?.[0]?.name === 'Street';
    });
    const yardPayload = payloads.find((payload) => {
      const zones = payload.smartDetectZones as Array<Record<string, unknown>> | undefined;
      return zones?.[0]?.name === 'Yard';
    });
    expect(drivewayPayload?.smartDetectZones).toEqual([
      expect.objectContaining({
        name: 'Street',
        sensitivity: 75,
        objectTypes: ['person'],
        points: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      }),
    ]);
    expect(yardPayload?.smartDetectZones).toEqual([
      expect.objectContaining({
        name: 'Yard',
        sensitivity: 50,
        objectTypes: ['person', 'vehicle'],
      }),
    ]);
    expect(driveway.smartDetectZones?.[0]?.objectTypes).toEqual(['person']);
    expect(yard.smartDetectSettings.objectTypes).toEqual(['person', 'vehicle']);
    expect(driveway.smartDetectZones?.[0]?.sensitivity).toBe(75);
    expect(yard.smartDetectZones?.[0]?.sensitivity).toBe(50);
  });

  it('still changes motion on one camera when smart detection is rejected, and continues with the next camera', async () => {
    const driveway = zonedCamera(
      'driveway',
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
    const yard = zonedCamera(
      'yard',
      'Backyard',
      'Yard',
      50,
      ['vehicle'],
      [
        [0.1, 0.1],
        [0.4, 0.1],
        [0.4, 0.4],
      ],
    );
    const cameras = new Map<string, CameraStore>([
      ['driveway', driveway],
      ['yard', yard],
    ]);
    apiState.updateDevice = vi.fn(async (camera: { id: string }, payload: Record<string, unknown>) => {
      if (camera.id === 'driveway' && payload.smartDetectZones) {
        throw new Error('zone rejected');
      }
      const target = cameras.get(camera.id);
      if (!target) {
        return null;
      }
      applyPatch(target, payload);
      return structuredClone(target);
    });
    apiState.retrieve = vi.fn(async (url: string) => {
      const id = url.split('/').pop() ?? '';
      const target = cameras.get(id);
      return target ? jsonResponse(structuredClone(target)) : null;
    });
    const client = connectedClient();

    const first = await client.updateCameraSettings({ id: 'driveway', name: 'Driveway' } as ProtectCamera, {
      motion: false,
      smartDetect: false,
    });
    const second = await client.updateCameraSettings({ id: 'yard', name: 'Backyard' } as ProtectCamera, {
      motion: false,
      smartDetect: false,
    });

    expect(first.result).toBe('ok');
    expect(first.smartDetectResult).not.toBe('ok');
    expect(second.result).toBe('ok');
    expect(second.smartDetectResult).toBe('ok');
    expect(driveway.recordingSettings.enableMotionDetection).toBe(false);
    expect(driveway.smartDetectZones?.[0]?.objectTypes).toEqual(['person']);
    expect(yard.recordingSettings.enableMotionDetection).toBe(false);
    expect(yard.smartDetectZones?.[0]).toMatchObject({ sensitivity: 50, objectTypes: [] });
    expect(yard.smartDetectSettings.objectTypes).toEqual([]);
  });

  it('records smart detection readback drift when zones stay enabled', async () => {
    store = zonedCamera(
      'cam1',
      'Front Door',
      'Porch',
      75,
      ['person', 'vehicle'],
      [
        [0, 0],
        [0.5, 0],
        [0.5, 0.5],
      ],
    );
    apiState.updateDevice = vi.fn(async (_camera: unknown, payload: Record<string, unknown>) => {
      applyPatch(store, payload);
      if (store.smartDetectZones) {
        store.smartDetectZones = store.smartDetectZones.map((entry) => ({
          ...entry,
          objectTypes: ['person', 'vehicle'],
        }));
      }
      return structuredClone(store);
    });
    apiState.retrieve = vi.fn(async () => jsonResponse(structuredClone(store)));
    const client = connectedClient();

    const outcome = await client.updateCameraSmartDetection(camera, false);

    expect(outcome.smartDetectResult).toBe('mismatch');
    expect(store.recordingSettings.enableMotionDetection).toBe(true);
    const snapshot = client.getCameraSnapshot('cam1');
    const health = buildHealthReport({
      pluginVersion: '1.0.12',
      generatedAt: 1_700_000_000_000,
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
              intendedMotionEnabled: true,
              intendedSmartDetect: false,
              smartDetectPreferencesSaved: true,
              smartDetectSnapshot: outcome.smartDetectConfig,
              snapshot,
            },
          ],
        },
      ],
    });
    const cameraHealth = health.controllers[0]?.cameras[0];
    expect(cameraHealth?.drift).toBe(true);
    expect(cameraHealth?.smartDetectDrift).toBe(true);
    expect(cameraHealth?.readback.status).toBe('mismatch');
    expect(cameraHealth?.smartDetectExpected?.zones?.[0]).toMatchObject({
      name: 'Porch',
      sensitivity: 75,
      objectTypes: [],
    });
    expect(cameraHealth?.smartDetectActual?.zones?.[0]?.objectTypes).toEqual(['person', 'vehicle']);
  });

  it('turns smart detection off when the controller refills an empty second-lens list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'protect-doorbell-'));
    store = doorbellRecord([]);
    const log = createMockLogger();
    const client = new ProtectClient(log, {
      sleep: async () => undefined,
      smartDetectStore: new SmartDetectSnapshotStore(() => dir),
      controllerAddress: '10.0.0.5',
    });
    (client as unknown as { connected: boolean }).connected = true;
    apiState.updateDevice = vi.fn(async (_camera: unknown, payload: Record<string, unknown>) => {
      applyPatch(store, payload);
      refillEmptySecondLens(store);
      return structuredClone(store);
    });

    const doorbell = { id: 'doorbell', name: 'Doorbell' } as ProtectCamera;
    const outcome = await client.updateCameraSmartDetection(doorbell, false);

    expect(outcome.smartDetectResult).toBe('ok');
    expect(apiState.updateDevice).toHaveBeenCalledTimes(1);
    expect(apiState.retrieve).toHaveBeenCalledTimes(2);
    expect(store.smartDetectZones?.[0]?.objectTypes).toEqual([]);
    expect(store.secondLensSmartDetectZones?.[0]?.objectTypes).toEqual(['package']);
    expect(store.smartDetectSettings.objectTypes).toEqual([]);
    expect(store.recordingSettings.enableMotionDetection).toBe(true);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('confirmed by camera readback'));
    expect(apiState.updateDevice.mock.calls[0]?.[1]).not.toHaveProperty('secondLensSmartDetectZones');

    const saved = JSON.parse(readFileSync(join(dir, SMART_DETECT_SNAPSHOT_FILENAME), 'utf8')) as {
      cameras: Array<{
        config: { zones: Array<Record<string, unknown>>; secondLensZones: Array<Record<string, unknown>> };
      }>;
    };
    expect(saved.cameras[0]?.config.zones[0]).toMatchObject({ objectTypes: ['person', 'vehicle'] });
    expect(saved.cameras[0]?.config.secondLensZones[0]).toMatchObject({ objectTypes: [] });
    expect(JSON.stringify(saved.cameras[0]?.config.secondLensZones[0])).not.toContain('package');

    const snapshot = client.getCameraSnapshot('doorbell');
    const health = buildHealthReport({
      pluginVersion: '1.0.13',
      generatedAt: 1_700_000_000_000,
      controllers: [
        {
          address: '10.0.0.5',
          connected: true,
          throttled: false,
          admin: true,
          lastError: null,
          cameras: [
            {
              id: 'doorbell',
              name: 'Doorbell',
              intendedMotionEnabled: true,
              intendedSmartDetect: false,
              smartDetectPreferencesSaved: true,
              smartDetectSnapshot: outcome.smartDetectConfig,
              snapshot,
            },
          ],
        },
      ],
    });
    const cameraHealth = health.controllers[0]?.cameras[0];
    expect(cameraHealth?.drift).toBe(false);
    expect(cameraHealth?.smartDetectDrift).toBe(false);
    expect(cameraHealth?.readback.status).toBe('verified');
    expect(cameraHealth?.readback.attempts).toBe(1);
    expect(cameraHealth?.smartDetectEnforcedTypes).toEqual([]);
    expect(cameraHealth?.smartDetectExpected?.secondLensZones?.[0]?.objectTypes).toEqual([]);
    expect(cameraHealth?.smartDetectActual?.secondLensZones?.[0]?.objectTypes).toEqual(['package']);

    apiState.updateDevice.mockClear();
    const second = await client.updateCameraSmartDetection(doorbell, false);
    expect(second.smartDetectResult).toBe('ok');
    expect(apiState.updateDevice.mock.calls[0]?.[1]).toMatchObject({
      smartDetectSettings: { objectTypes: ['package'] },
    });
    expect(store.secondLensSmartDetectZones?.[0]?.objectTypes).toEqual(['package']);
    expect(store.smartDetectSettings.objectTypes).toEqual(['package']);
    const stillSaved = JSON.parse(readFileSync(join(dir, SMART_DETECT_SNAPSHOT_FILENAME), 'utf8')) as typeof saved;
    expect(stillSaved.cameras[0]?.config.zones[0]).toMatchObject({ objectTypes: ['person', 'vehicle'] });
    expect(stillSaved.cameras[0]?.config.secondLensZones[0]).toMatchObject({ objectTypes: [] });
  });

  it('restores the saved snapshot when the controller keeps or drops the refilled type', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'protect-doorbell-on-'));
    const snapshotStore = new SmartDetectSnapshotStore(() => dir);
    const saved = doorbellRecord([]);
    snapshotStore.remember('10.0.0.5', 'doorbell', 'Doorbell', readConfig(saved));
    store = doorbellRecord(['package']);
    store.smartDetectZones = (store.smartDetectZones ?? []).map((zone) => ({ ...zone, objectTypes: [] }));
    const log = createMockLogger();
    const client = new ProtectClient(log, {
      sleep: async () => undefined,
      smartDetectStore: snapshotStore,
      controllerAddress: '10.0.0.5',
    });
    (client as unknown as { connected: boolean }).connected = true;
    apiState.updateDevice = vi.fn(async (_camera: unknown, payload: Record<string, unknown>) => {
      applyPatch(store, payload);
      refillEmptySecondLens(store);
      return structuredClone(store);
    });

    const kept = await client.updateCameraSmartDetection({ id: 'doorbell', name: 'Doorbell' } as ProtectCamera, true);

    expect(kept.smartDetectResult).toBe('ok');
    expect(apiState.updateDevice).toHaveBeenCalledTimes(1);
    expect(store.smartDetectZones?.[0]?.objectTypes).toEqual(['person', 'vehicle']);
    expect(store.secondLensSmartDetectZones?.[0]?.objectTypes).toEqual(['package']);
    const keptFile = JSON.parse(readFileSync(join(dir, SMART_DETECT_SNAPSHOT_FILENAME), 'utf8')) as {
      cameras: Array<{
        config: {
          zones: Array<{ objectTypes: string[] }>;
          secondLensZones: Array<{ objectTypes: string[]; raw: { objectTypes: string[] } }>;
        };
      }>;
    };
    expect(keptFile.cameras[0]?.config.zones[0]?.objectTypes).toEqual(['person', 'vehicle']);
    expect(keptFile.cameras[0]?.config.secondLensZones[0]?.objectTypes).toEqual([]);
    expect(keptFile.cameras[0]?.config.secondLensZones[0]?.raw.objectTypes).toEqual([]);
    expect(apiState.updateDevice.mock.calls[0]?.[1]).not.toHaveProperty('secondLensSmartDetectZones');

    const keptHealth = buildHealthReport({
      pluginVersion: '1.0.13',
      generatedAt: 1_700_000_000_000,
      controllers: [
        {
          address: '10.0.0.5',
          connected: true,
          throttled: false,
          admin: true,
          lastError: null,
          cameras: [
            {
              id: 'doorbell',
              name: 'Doorbell',
              intendedMotionEnabled: true,
              intendedSmartDetect: true,
              smartDetectPreferencesSaved: true,
              smartDetectSnapshot: snapshotStore.get('10.0.0.5', 'doorbell'),
              snapshot: client.getCameraSnapshot('doorbell'),
            },
          ],
        },
      ],
    });
    expect(keptHealth.controllers[0]?.cameras[0]?.smartDetectDrift).toBe(false);
    expect(keptHealth.controllers[0]?.cameras[0]?.drift).toBe(false);
    expect(keptHealth.controllers[0]?.cameras[0]?.readback.status).toBe('verified');

    store = doorbellRecord(['package']);
    store.smartDetectZones = (store.smartDetectZones ?? []).map((zone) => ({ ...zone, objectTypes: [] }));
    apiState.updateDevice = vi.fn(async (_camera: unknown, payload: Record<string, unknown>) => {
      applyPatch(store, payload);
      return structuredClone(store);
    });
    const dropped = await client.updateCameraSmartDetection(
      { id: 'doorbell', name: 'Doorbell' } as ProtectCamera,
      true,
    );
    expect(dropped.smartDetectResult).toBe('ok');
    expect(store.smartDetectZones?.[0]?.objectTypes).toEqual(['person', 'vehicle']);
    expect(store.secondLensSmartDetectZones?.[0]?.objectTypes).toEqual(['package']);
    const droppedHealth = buildHealthReport({
      pluginVersion: '1.0.13',
      generatedAt: 1_700_000_000_000,
      controllers: [
        {
          address: '10.0.0.5',
          connected: true,
          throttled: false,
          admin: true,
          lastError: null,
          cameras: [
            {
              id: 'doorbell',
              name: 'Doorbell',
              intendedMotionEnabled: true,
              intendedSmartDetect: true,
              smartDetectPreferencesSaved: true,
              smartDetectSnapshot: snapshotStore.get('10.0.0.5', 'doorbell'),
              snapshot: client.getCameraSnapshot('doorbell'),
            },
          ],
        },
      ],
    });
    expect(droppedHealth.controllers[0]?.cameras[0]?.smartDetectDrift).toBe(false);
    expect(droppedHealth.controllers[0]?.cameras[0]?.smartDetectEnforcedTypes).toEqual([]);
  });

  it('drops a second-lens type the controller puts back after a clear', async () => {
    store = doorbellRecord(['package']);
    apiState.updateDevice = vi.fn(async (_camera: unknown, payload: Record<string, unknown>) => {
      applyPatch(store, payload);
      refillEmptySecondLens(store);
      return structuredClone(store);
    });
    const client = connectedClient();

    const outcome = await client.updateCameraSmartDetection(
      { id: 'doorbell', name: 'Doorbell' } as ProtectCamera,
      false,
    );

    expect(outcome.smartDetectResult).toBe('ok');
    expect(store.smartDetectZones?.[0]?.objectTypes).toEqual([]);
    expect(store.secondLensSmartDetectZones?.[0]?.objectTypes).toEqual(['package']);
    expect(outcome.smartDetectConfig?.zones?.[0]?.objectTypes).toEqual(['person', 'vehicle']);
    expect(outcome.smartDetectConfig?.secondLensZones?.[0]?.objectTypes).toEqual(['package']);
    expect(apiState.updateDevice.mock.calls[0]?.[1]).not.toHaveProperty('secondLensSmartDetectZones');
  });
});

describe('controller-enforced detection types', () => {
  const address = '192.0.2.1';
  const camera = { id: 'cam-1', name: 'Test Camera' } as ProtectCamera;

  function dualLens(mainTypes: string[], secondTypes: string[]): CameraStore {
    const zone = (id: number, name: string, objectTypes: string[]): Record<string, unknown> => ({
      id,
      name,
      points: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      sensitivity: 50,
      objectTypes: [...objectTypes],
    });
    return cameraRecord({
      id: 'cam-1',
      name: 'Test Camera',
      host: '192.0.2.10',
      smartDetectSettings: { objectTypes: [], audioTypes: [], autoTrackingObjectTypes: [] },
      smartDetectZones: [zone(1, 'Main', mainTypes)],
      secondLensSmartDetectZones: [zone(2, 'Lens 2', secondTypes)],
    });
  }

  function readSaved(dir: string): {
    cameras: Array<{
      config: { zones: Array<{ objectTypes: string[] }>; secondLensZones: Array<{ objectTypes: string[] }> };
    }>;
  } {
    return JSON.parse(readFileSync(join(dir, SMART_DETECT_SNAPSHOT_FILENAME), 'utf8')) as ReturnType<typeof readSaved>;
  }

  function openClient(dir: string): { client: ProtectClient; snapshots: SmartDetectSnapshotStore } {
    const snapshots = new SmartDetectSnapshotStore(() => dir);
    const client = new ProtectClient(createMockLogger(), {
      sleep: async () => undefined,
      smartDetectStore: snapshots,
      controllerAddress: address,
    });
    (client as unknown as { connected: boolean }).connected = true;
    apiState.retrieve = vi.fn(async () => jsonResponse(structuredClone(store)));
    return { client, snapshots };
  }

  it('turns detection off when the controller refills a cleared second lens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'protect-enforced-'));
    store = dualLens(['person', 'vehicle'], ['package']);
    apiState.updateDevice = vi.fn(async (_camera: unknown, payload: Record<string, unknown>) => {
      applyPatch(store, payload);
      const zone = store.secondLensSmartDetectZones?.[0];
      if (zone && Array.isArray(zone.objectTypes) && zone.objectTypes.length === 0) {
        store.secondLensSmartDetectZones = [{ ...zone, objectTypes: ['package'] }];
      }
      return structuredClone(store);
    });
    const { client } = openClient(dir);

    const outcome = await client.updateCameraSmartDetection(camera, false);

    expect(outcome.smartDetectResult).toBe('ok');
    expect(store.smartDetectZones?.[0]?.objectTypes).toEqual([]);
    expect(store.secondLensSmartDetectZones?.[0]?.objectTypes).toEqual(['package']);
    const saved = readSaved(dir);
    expect(saved.cameras[0]?.config.zones[0]?.objectTypes).toEqual(['person', 'vehicle']);
    expect(saved.cameras[0]?.config.secondLensZones[0]?.objectTypes).toEqual(['package']);
  });

  it('does not replace a saved snapshot with a half-off camera', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'protect-half-'));
    const { client, snapshots } = openClient(dir);
    snapshots.remember(address, 'cam-1', 'Test Camera', readConfig(dualLens(['person', 'vehicle'], ['package'])));
    store = dualLens([], ['package']);

    const outcome = await client.updateCameraSmartDetection(camera, false);

    expect(outcome.smartDetectResult).toBe('ok');
    expect(store.smartDetectZones?.[0]?.objectTypes).toEqual([]);
    expect(store.smartDetectSettings.objectTypes).toEqual(['package']);
    expect(store.secondLensSmartDetectZones?.[0]?.objectTypes).toEqual(['package']);
    const saved = readSaved(dir);
    expect(saved.cameras[0]?.config.zones[0]?.objectTypes).toEqual(['person', 'vehicle']);
    expect(saved.cameras[0]?.config.secondLensZones[0]?.objectTypes).toEqual(['package']);
  });

  it('writes the saved types when turning detection on from a half-off camera', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'protect-restore-'));
    const { client, snapshots } = openClient(dir);
    snapshots.remember(address, 'cam-1', 'Test Camera', readConfig(dualLens(['person', 'vehicle'], [])));
    store = dualLens([], ['package']);
    apiState.updateDevice = vi.fn(async (_camera: unknown, payload: Record<string, unknown>) => {
      applyPatch(store, payload);
      const zone = store.secondLensSmartDetectZones?.[0];
      if (zone && Array.isArray(zone.objectTypes) && zone.objectTypes.length === 0) {
        store.secondLensSmartDetectZones = [{ ...zone, objectTypes: ['package'] }];
      }
      return structuredClone(store);
    });

    const outcome = await client.updateCameraSmartDetection(camera, true);

    expect(outcome.smartDetectResult).toBe('ok');
    expect(apiState.updateDevice).toHaveBeenCalled();
    const payload = apiState.updateDevice.mock.calls[0]?.[1] as {
      smartDetectZones?: Array<{ objectTypes: string[] }>;
    };
    expect(payload.smartDetectZones?.[0]?.objectTypes).toEqual(['person', 'vehicle']);
    expect(store.smartDetectZones?.[0]?.objectTypes).toEqual(['person', 'vehicle']);
    const saved = readSaved(dir);
    expect(saved.cameras[0]?.config.zones[0]?.objectTypes).toEqual(['person', 'vehicle']);
    expect(saved.cameras[0]?.config.secondLensZones[0]?.objectTypes).toEqual([]);
    expect(JSON.stringify(saved)).not.toContain('package');
  });

  it('records nothing when the controller ignores the clear', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'protect-ignored-'));
    const { client, snapshots } = openClient(dir);
    snapshots.remember(address, 'cam-1', 'Test Camera', readConfig(dualLens(['person', 'vehicle'], [])));
    store = dualLens(['person', 'vehicle'], ['package']);
    apiState.updateDevice = vi.fn(async () => structuredClone(store));

    const outcome = await client.updateCameraSmartDetection(camera, false);

    expect(outcome.smartDetectResult).toBe('mismatch');
    expect(store.smartDetectZones?.[0]?.objectTypes).toEqual(['person', 'vehicle']);
    expect(store.secondLensSmartDetectZones?.[0]?.objectTypes).toEqual(['package']);
    const saved = readSaved(dir);
    expect(saved.cameras[0]?.config.zones[0]?.objectTypes).toEqual(['person', 'vehicle']);
    expect(saved.cameras[0]?.config.secondLensZones[0]?.objectTypes).toEqual([]);
    expect(JSON.stringify(saved)).not.toContain('package');
  });
});

describe('camera-level list and a forced second lens', () => {
  const address = '10.0.0.5';
  const doorbell = { id: 'doorbell', name: 'Doorbell' } as ProtectCamera;

  function readSaved(dir: string): {
    objectTypes: string[];
    audioTypes: string[];
    zones: Array<{ objectTypes: string[] }>;
    secondLensZones: Array<{ objectTypes: string[]; raw: { objectTypes: string[] } }>;
  } {
    const parsed = JSON.parse(readFileSync(join(dir, SMART_DETECT_SNAPSHOT_FILENAME), 'utf8')) as {
      cameras: Array<{ config: ReturnType<typeof readSaved> }>;
    };
    const config = parsed.cameras[0]?.config;
    if (!config) {
      throw new Error('missing snapshot');
    }
    return config;
  }

  function health(
    intendedSmartDetect: boolean,
    smartDetectSnapshot: ReturnType<SmartDetectSnapshotStore['get']>,
    snapshot: ReturnType<ProtectClient['getCameraSnapshot']>,
  ): ReturnType<typeof buildHealthReport>['controllers'][number]['cameras'][number] | undefined {
    return buildHealthReport({
      pluginVersion: '1.0.15',
      generatedAt: 1_700_000_000_000,
      controllers: [
        {
          address,
          connected: true,
          throttled: false,
          admin: true,
          lastError: null,
          cameras: [
            {
              id: 'doorbell',
              name: 'Doorbell',
              intendedMotionEnabled: true,
              intendedSmartDetect,
              smartDetectPreferencesSaved: true,
              smartDetectSnapshot,
              snapshot,
            },
          ],
        },
      ],
    }).controllers[0]?.cameras[0];
  }

  function clientFor(dir: string): {
    client: ProtectClient;
    snapshots: SmartDetectSnapshotStore;
    log: ReturnType<typeof createMockLogger>;
  } {
    const log = createMockLogger();
    const snapshots = new SmartDetectSnapshotStore(() => dir);
    const client = new ProtectClient(log, {
      sleep: async () => undefined,
      smartDetectStore: snapshots,
      controllerAddress: address,
    });
    (client as unknown as { connected: boolean }).connected = true;
    apiState.updateDevice = vi.fn(async (_camera: unknown, payload: Record<string, unknown>) => {
      applyPatch(store, payload);
      keepForcedPackage(store);
      return structuredClone(store);
    });
    return { client, snapshots, log };
  }

  it('turns detection off and restores the kept snapshot, ignoring the forced second-lens type', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'protect-aggregate-'));
    store = aggregateDoorbell(AGGREGATE_OBJECT_TYPES, ['package']);
    const { client, snapshots, log } = clientFor(dir);

    const off = await client.updateCameraSmartDetection(doorbell, false);

    expect(off.smartDetectResult).toBe('ok');
    expect(apiState.updateDevice.mock.calls[0]?.[1]).toMatchObject({
      smartDetectSettings: { objectTypes: ['package'], audioTypes: [] },
    });
    expect(apiState.updateDevice.mock.calls[0]?.[1]).not.toHaveProperty('secondLensSmartDetectZones');
    expect(store.smartDetectSettings.objectTypes).toEqual(['package']);
    expect(store.smartDetectSettings.audioTypes).toEqual([]);
    expect(store.smartDetectZones?.[0]?.objectTypes).toEqual([]);
    expect(store.secondLensSmartDetectZones?.[0]?.objectTypes).toEqual(['package']);
    const kept = readSaved(dir);
    expect(kept.objectTypes).toEqual(AGGREGATE_OBJECT_TYPES);
    expect(kept.audioTypes).toEqual(AGGREGATE_AUDIO_TYPES);
    expect(kept.zones[0]?.objectTypes).toEqual([]);
    expect(kept.secondLensZones[0]?.objectTypes).toEqual(['package']);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    const offHealth = health(false, snapshots.get(address, 'doorbell'), client.getCameraSnapshot('doorbell'));
    expect(offHealth?.drift).toBe(false);
    expect(offHealth?.smartDetectDrift).toBe(false);
    expect(offHealth?.readback.status).toBe('verified');
    expect(offHealth?.smartDetectEnforcedTypes).toEqual([]);
    expect(offHealth?.smartDetectExpected?.objectTypes).toEqual(['package']);
    expect(offHealth?.smartDetectActual?.objectTypes).toEqual(['package']);
    expect(offHealth?.smartDetectActual?.secondLensZones?.[0]?.objectTypes).toEqual(['package']);

    apiState.updateDevice.mockClear();
    const again = await client.updateCameraSmartDetection(doorbell, false);
    expect(again.smartDetectResult).toBe('ok');
    expect(apiState.updateDevice).not.toHaveBeenCalled();

    store.smartDetectSettings.objectTypes = [];
    store.smartDetectSettings.audioTypes = [];
    const half = await client.updateCameraSmartDetection(doorbell, false);
    expect(half.smartDetectResult).toBe('ok');
    expect(apiState.updateDevice.mock.calls[0]?.[1]).toMatchObject({
      smartDetectSettings: { objectTypes: ['package'] },
    });
    expect(apiState.updateDevice.mock.calls[0]?.[1]).not.toHaveProperty('secondLensSmartDetectZones');
    expect(store.smartDetectSettings.objectTypes).toEqual(['package']);
    expect(store.secondLensSmartDetectZones?.[0]?.objectTypes).toEqual(['package']);
    expect(readSaved(dir).objectTypes).toEqual(AGGREGATE_OBJECT_TYPES);
    expect(readSaved(dir).secondLensZones[0]?.objectTypes).toEqual(['package']);

    const on = await client.updateCameraSmartDetection(doorbell, true);

    expect(on.smartDetectResult).toBe('ok');
    expect(apiState.updateDevice.mock.calls.at(-1)?.[1]).toMatchObject({
      smartDetectSettings: { objectTypes: AGGREGATE_OBJECT_TYPES, audioTypes: AGGREGATE_AUDIO_TYPES },
    });
    expect(apiState.updateDevice.mock.calls.at(-1)?.[1]).not.toHaveProperty('secondLensSmartDetectZones');
    expect(store.smartDetectSettings.objectTypes).toEqual(AGGREGATE_OBJECT_TYPES);
    expect(store.smartDetectSettings.audioTypes).toEqual(AGGREGATE_AUDIO_TYPES);
    expect(store.smartDetectZones?.[0]?.objectTypes).toEqual([]);
    expect(store.secondLensSmartDetectZones?.[0]?.objectTypes).toEqual(['package']);
    const restored = readSaved(dir);
    expect(restored.objectTypes).toEqual(AGGREGATE_OBJECT_TYPES);
    expect(restored.audioTypes).toEqual(AGGREGATE_AUDIO_TYPES);
    expect(restored.secondLensZones[0]?.objectTypes).toEqual(['package']);
    const onHealth = health(true, snapshots.get(address, 'doorbell'), client.getCameraSnapshot('doorbell'));
    expect(onHealth?.drift).toBe(false);
    expect(onHealth?.smartDetectDrift).toBe(false);
    expect(onHealth?.readback.status).toBe('verified');
    expect(onHealth?.smartDetectEnforcedTypes).toEqual([]);
  });

  it('restores a kept snapshot when the camera-level lists were already cleared', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'protect-aggregate-on-'));
    const { client, snapshots } = clientFor(dir);
    snapshots.remember(
      address,
      'doorbell',
      'Doorbell',
      readSmartDetectConfig(aggregateDoorbell(AGGREGATE_OBJECT_TYPES, ['package']) as unknown as ProtectCamera),
    );
    store = aggregateDoorbell([], ['package']);

    const on = await client.updateCameraSmartDetection(doorbell, true);

    expect(on.smartDetectResult).toBe('ok');
    expect(store.smartDetectSettings.objectTypes).toEqual(AGGREGATE_OBJECT_TYPES);
    expect(store.smartDetectSettings.audioTypes).toEqual(AGGREGATE_AUDIO_TYPES);
    expect(store.secondLensSmartDetectZones?.[0]?.objectTypes).toEqual(['package']);
    const saved = readSaved(dir);
    expect(saved.objectTypes).toEqual(AGGREGATE_OBJECT_TYPES);
    expect(saved.audioTypes).toEqual(AGGREGATE_AUDIO_TYPES);
    expect(saved.secondLensZones[0]?.objectTypes).toEqual(['package']);
    const report = health(true, snapshots.get(address, 'doorbell'), client.getCameraSnapshot('doorbell'));
    expect(report?.drift).toBe(false);
    expect(report?.smartDetectDrift).toBe(false);
    expect(report?.readback.status).toBe('verified');
    expect(report?.smartDetectExpected?.objectTypes).toEqual(AGGREGATE_OBJECT_TYPES);
    expect(report?.smartDetectActual?.objectTypes).toEqual(AGGREGATE_OBJECT_TYPES);
  });
});

function loggedOutLibrary(): void {
  apiState.bootstrap = null;
  apiState.isAdminUser = false;
  apiState.eventsWs = null;
}

function restoreLibrarySession(): void {
  apiState.bootstrap = { cameras: [store], lastUpdateId: '2' };
  apiState.isAdminUser = true;
  apiState.eventsWs = { readyState: 1 };
}

describe('Protect session recovery', () => {
  it('refreshes the bootstrap once when a six-camera burst hits a stale session', async () => {
    const cameras = Array.from({ length: 6 }, (_, index) =>
      cameraRecord({
        id: `cam-${index}`,
        name: `Camera ${index}`,
        recordingSettings: { enableMotionDetection: true, mode: 'always' },
      }),
    );
    const byId = new Map(cameras.map((entry) => [entry.id, entry]));
    let patches = 0;
    apiState.updateDevice = vi.fn(async (camera: { id: string }, payload: Record<string, unknown>) => {
      patches += 1;
      if (patches === 1) {
        loggedOutLibrary();
        return null;
      }
      const target = byId.get(camera.id);
      if (!target) {
        return null;
      }
      applyPatch(target, payload);
      return structuredClone(target);
    });
    apiState.retrieve = vi.fn(async (url: string) => {
      const id = decodeURIComponent(url.split('/').pop() ?? '');
      const target = byId.get(id);
      return target ? jsonResponse(structuredClone(target)) : null;
    });
    apiState.getBootstrap = vi.fn(async () => {
      await apiState.login('10.0.0.5', 'stored-user', 'stored-password');
      apiState.bootstrap = { cameras, lastUpdateId: '2' };
      apiState.isAdminUser = true;
      apiState.eventsWs = { readyState: 1 };
      return true;
    });
    const client = connectedClient();

    const outcomes = await Promise.all(
      cameras.map((entry) => client.updateCameraMotionDetection(entry as unknown as ProtectCamera, false)),
    );

    expect(outcomes.map((outcome) => outcome.result)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(apiState.login).toHaveBeenCalledTimes(1);
    expect(apiState.getBootstrap).toHaveBeenCalledTimes(1);
    expect(apiState.updateDevice).toHaveBeenCalledTimes(7);
    for (const entry of cameras) {
      expect(byId.get(entry.id)?.recordingSettings.enableMotionDetection).toBe(false);
    }
  });

  it('retries a smart detection write once after the session is lost', async () => {
    let patches = 0;
    apiState.updateDevice = vi.fn(async (_camera: unknown, payload: Record<string, unknown>) => {
      patches += 1;
      if (patches === 1) {
        loggedOutLibrary();
        return null;
      }
      applyPatch(store, payload);
      return structuredClone(store);
    });
    apiState.getBootstrap = vi.fn(async () => {
      restoreLibrarySession();
      return true;
    });
    const client = connectedClient();

    const outcome = await client.updateCameraSmartDetection(camera, false);

    expect(outcome.smartDetectResult).toBe('ok');
    expect(apiState.getBootstrap).toHaveBeenCalledTimes(1);
    expect(apiState.updateDevice).toHaveBeenCalledTimes(2);
    expect(store.smartDetectSettings.objectTypes).toEqual([]);
    expect(store.recordingSettings.enableMotionDetection).toBe(true);
  });

  it('retries the confirmation read once after the session is lost', async () => {
    let reads = 0;
    apiState.updateDevice = vi.fn(async (_camera: unknown, payload: Record<string, unknown>) => {
      applyPatch(store, payload);
      return structuredClone(store);
    });
    apiState.retrieve = vi.fn(async () => {
      reads += 1;
      if (reads === 1) {
        loggedOutLibrary();
        return null;
      }
      return jsonResponse(structuredClone(store));
    });
    apiState.getBootstrap = vi.fn(async () => {
      restoreLibrarySession();
      return true;
    });
    const client = connectedClient();

    const outcome = await client.updateCameraMotionDetection(camera, false);

    expect(outcome.result).toBe('ok');
    expect(apiState.getBootstrap).toHaveBeenCalledTimes(1);
    expect(reads).toBe(2);
    expect(store.recordingSettings.enableMotionDetection).toBe(false);
  });

  it('reports unauthorized only when a fresh bootstrap still says the account is not an admin', async () => {
    loggedOutLibrary();
    apiState.getBootstrap = vi.fn(async () => {
      apiState.bootstrap = { cameras: [], lastUpdateId: '9' };
      apiState.eventsWs = { readyState: 1 };
      apiState.isAdminUser = false;
      return true;
    });
    const log = createMockLogger();
    const client = new ProtectClient(log, { sleep: async () => undefined });
    (client as unknown as { connected: boolean }).connected = true;

    const outcome = await client.updateCameraMotionDetection(camera, true);

    expect(outcome.result).toBe('unauthorized');
    expect(apiState.getBootstrap).toHaveBeenCalledTimes(1);
    expect(apiState.updateDevice).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('cannot change device settings'));
    expect(log.error).not.toHaveBeenCalledWith(expect.stringContaining('not a Protect admin'));
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('not a Protect admin'));
    expect(log.error).not.toHaveBeenCalledWith(expect.stringContaining('not an admin'));
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('not an admin'));
  });

  it('does not report a lost session as a missing admin role when bootstrap refresh fails', async () => {
    loggedOutLibrary();
    apiState.getBootstrap = vi.fn(async () => false);
    const log = createMockLogger();
    const client = new ProtectClient(log, { sleep: async () => undefined });
    (client as unknown as { connected: boolean }).connected = true;

    const outcome = await client.updateCameraMotionDetection(camera, true);

    expect(outcome.result).toBe('failed');
    expect(apiState.getBootstrap).toHaveBeenCalledTimes(1);
    expect(apiState.updateDevice).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('session is unavailable'));
    expect(log.error).not.toHaveBeenCalledWith(expect.stringContaining('not a Protect admin'));
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('not a Protect admin'));
    expect(log.error).not.toHaveBeenCalledWith(expect.stringContaining('not an admin'));
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('not an admin'));
  });

  it('shares one in-flight bootstrap refresh across concurrent reads', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    loggedOutLibrary();
    apiState.getBootstrap = vi.fn(async () => {
      await gate;
      restoreLibrarySession();
      return true;
    });
    const client = connectedClient();

    const pending = Promise.all([client.refreshCamera(camera), client.refreshCamera(camera)]);
    expect(apiState.getBootstrap).toHaveBeenCalledTimes(1);
    release();
    const snapshots = await pending;

    expect(apiState.getBootstrap).toHaveBeenCalledTimes(1);
    expect(snapshots.every((snapshot) => snapshot.ok)).toBe(true);
  });

  it('watchdog restores a logged-out session and backs off when refresh keeps failing', async () => {
    vi.useFakeTimers();
    const log = createMockLogger();
    apiState.getBootstrap = vi.fn(async () => {
      restoreLibrarySession();
      return true;
    });
    const client = new ProtectClient(log, { sleep: async () => undefined });
    try {
      await client.connect('10.0.0.5', 'stored-user', 'stored-password');
      apiState.getBootstrap.mockClear();
      apiState.login.mockClear();

      loggedOutLibrary();
      expect(client.hasLiveSession).toBe(false);
      await vi.advanceTimersByTimeAsync(SESSION_WATCHDOG_BASE_MS);

      expect(apiState.getBootstrap).toHaveBeenCalledTimes(1);
      expect(client.hasLiveSession).toBe(true);
      expect(client.sessionLossError).toBeNull();

      apiState.getBootstrap.mockClear();
      apiState.eventsWs = null;
      await vi.advanceTimersByTimeAsync(SESSION_WATCHDOG_BASE_MS);
      expect(apiState.getBootstrap).toHaveBeenCalledTimes(1);
      expect(client.hasLiveSession).toBe(true);

      apiState.getBootstrap.mockReset();
      apiState.getBootstrap.mockResolvedValue(false);
      loggedOutLibrary();
      await vi.advanceTimersByTimeAsync(SESSION_WATCHDOG_BASE_MS);
      expect(apiState.getBootstrap).toHaveBeenCalledTimes(1);
      expect(client.hasLiveSession).toBe(false);
      expect(client.sessionLossError).toBe('protect session lost');
      expect(client.consecutiveRecoveryFailures).toBe(1);

      await vi.advanceTimersByTimeAsync(SESSION_WATCHDOG_BASE_MS);
      expect(apiState.getBootstrap).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(SESSION_WATCHDOG_BASE_MS);
      expect(apiState.getBootstrap).toHaveBeenCalledTimes(2);
    } finally {
      client.disconnect();
      vi.useRealTimers();
    }
  });

  it('backs off repeated login attempts after a refresh keeps failing', async () => {
    vi.useFakeTimers();
    apiState.getBootstrap = vi.fn(async () => false);
    const client = connectedClient();
    try {
      loggedOutLibrary();
      await client.updateCameraMotionDetection(camera, false);
      expect(apiState.getBootstrap).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4_000);
      await client.updateCameraMotionDetection(camera, false);
      expect(apiState.getBootstrap).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_000);
      await client.updateCameraMotionDetection(camera, false);
      expect(apiState.getBootstrap).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(9_000);
      await client.updateCameraMotionDetection(camera, false);
      expect(apiState.getBootstrap).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(2_000);
      await client.updateCameraMotionDetection(camera, false);
      expect(apiState.getBootstrap).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes the session once when every write in one update loses it again', async () => {
    store = zonedCamera(
      'cam1',
      'Front Door',
      'Porch',
      75,
      ['person'],
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    );
    apiState.bootstrap = { cameras: [store], lastUpdateId: '1' };
    apiState.updateDevice = vi.fn(async () => {
      loggedOutLibrary();
      return null;
    });
    apiState.retrieve = vi.fn(async () => jsonResponse(structuredClone(store)));
    apiState.getBootstrap = vi.fn(async () => {
      apiState.bootstrap = { cameras: [store], lastUpdateId: '2' };
      apiState.isAdminUser = true;
      apiState.eventsWs = { readyState: 1 };
      return true;
    });
    const client = connectedClient();

    await client.updateCameraSettings(camera, { motion: false, smartDetect: false });

    expect(apiState.getBootstrap).toHaveBeenCalledTimes(1);
    expect(apiState.updateDevice.mock.calls.length).toBeGreaterThan(1);
  });

  it('closes a socket the library opens after disconnect and does not restart the watchdog', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new ProtectClient(createMockLogger(), { sleep: async () => undefined });
    try {
      await client.connect('10.0.0.5', 'stored-user', 'stored-password');
      apiState.reset.mockClear();
      apiState.getBootstrap.mockClear();
      apiState.reset = vi.fn(() => {
        apiState.eventsWs = null;
        apiState.bootstrap = null;
      });
      apiState.getBootstrap = vi.fn(async () => {
        await gate;
        apiState.bootstrap = { cameras: [store], lastUpdateId: '3' };
        apiState.isAdminUser = true;
        apiState.eventsWs = { readyState: 1 };
        return true;
      });
      loggedOutLibrary();

      const pending = client.refreshCamera(camera);
      expect(apiState.getBootstrap).toHaveBeenCalledTimes(1);
      client.disconnect();
      release();
      await pending;

      expect(apiState.eventsWs).toBeNull();
      expect(apiState.reset).toHaveBeenCalledTimes(2);
      expect(client.isConnected).toBe(false);
      apiState.getBootstrap.mockClear();
      await vi.advanceTimersByTimeAsync(SESSION_WATCHDOG_MAX_MS);
      expect(apiState.getBootstrap).not.toHaveBeenCalled();
    } finally {
      client.disconnect();
      vi.useRealTimers();
    }
  });

  it('keeps a live session through a short events-socket blip and reports a lost bootstrap immediately', async () => {
    let now = 1_700_000_000_000;
    const client = new ProtectClient(createMockLogger(), {
      sleep: async () => undefined,
      now: () => now,
    });
    try {
      await client.connect('10.0.0.5', 'stored-user', 'stored-password');
      apiState.eventsWs = null;
      expect(client.hasLiveSession).toBe(true);

      now += EVENTS_SOCKET_GRACE_MS - 1;
      expect(client.hasLiveSession).toBe(true);
      apiState.eventsWs = { readyState: 1 };
      expect(client.hasLiveSession).toBe(true);

      apiState.eventsWs = null;
      expect(client.hasLiveSession).toBe(true);
      now += EVENTS_SOCKET_GRACE_MS;
      expect(client.hasLiveSession).toBe(false);
      expect(client.sessionLossError).toBe('protect session lost');

      apiState.bootstrap = null;
      apiState.eventsWs = { readyState: 1 };
      expect(client.hasLiveSession).toBe(false);
    } finally {
      client.disconnect();
    }
  });
});
