import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PlatformAccessory, Service } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProtectMotionPlatform } from './platform.js';
import { HEALTH_FILENAME, SMART_DETECT_SNAPSHOT_FILENAME } from './settings.js';
import { SmartDetectSnapshotStore } from './smart-detect-store.js';
import { createMockAPI, createMockConfig, createMockLogger } from './test/mocks.js';

const openPlatforms: Array<{ emit: (event: string) => void }> = [];

function createdApi(options?: { storagePath: string }): ReturnType<typeof createMockAPI> {
  const hap = options ? createMockAPI(options) : createMockAPI();
  openPlatforms.push(hap as unknown as { emit: (event: string) => void });
  return hap;
}

afterEach(() => {
  for (const hap of openPlatforms) {
    hap.emit('shutdown');
  }
  openPlatforms.length = 0;
});

const apiState = vi.hoisted(() => {
  const listeners = new Map<string, (packet: unknown) => void>();
  const camera = {
    id: 'cam1',
    name: 'Front Door',
    type: 'UVC G4 Pro',
    mac: 'AA:BB:CC:DD:EE:FF',
    host: '192.168.1.50',
    lastMotion: null as number | null,
    ledSettings: { isEnabled: true },
    recordingSettings: { enableMotionDetection: true, mode: 'always' },
    motionSettings: null as null | { isEnabled?: boolean },
    smartDetectSettings: {
      objectTypes: ['person'],
      audioTypes: [] as string[],
      autoTrackingObjectTypes: [] as string[],
    },
  };
  return {
    listeners,
    camera,
    sessionUp: true,
    admin: true,
    login: vi.fn(async (_address: string, _username: string, _password: string) => true),
    api: {
      login: (address: string, username: string, password: string) => apiState.login(address, username, password),
      getBootstrap: vi.fn(async () => {
        apiState.sessionUp = true;
        return true;
      }),
      get bootstrap() {
        return apiState.sessionUp ? { cameras: [apiState.camera], lastUpdateId: '1' } : null;
      },
      isThrottled: false,
      get isAdminUser() {
        return apiState.sessionUp && apiState.admin;
      },
      get _eventsWs() {
        return apiState.sessionUp ? { readyState: 1 } : null;
      },
      updateDevice: vi.fn(async () => apiState.camera),
      getApiEndpoint: vi.fn(() => 'https://nvr.example/proxy/protect/api/cameras'),
      retrieve: vi.fn(async () => ({
        statusCode: 200,
        body: { json: async () => structuredClone(apiState.camera) },
      })),
      on: vi.fn((event: string, handler: (packet: unknown) => void) => {
        apiState.listeners.set(event, handler);
      }),
      reset: vi.fn(),
    },
  };
});

vi.mock('unifi-protect', () => ({
  ProtectApi: vi.fn().mockImplementation(function () {
    return apiState.api;
  }),
}));

function switchValue(accessory: PlatformAccessory): unknown {
  const service = (
    accessory as PlatformAccessory & { getServiceBySubtype: (subtype: string) => Service }
  ).getServiceBySubtype('motion-switch');
  return (service.getCharacteristic('On' as unknown as never) as unknown as { invokeGet: () => unknown }).invokeGet();
}

describe('ProtectMotionPlatform health', () => {
  beforeEach(() => {
    apiState.listeners.clear();
    apiState.sessionUp = true;
    apiState.admin = true;
    apiState.login.mockResolvedValue(true);
    apiState.camera.recordingSettings.enableMotionDetection = true;
    apiState.camera.motionSettings = null;
    apiState.camera.smartDetectSettings = {
      objectTypes: ['person'],
      audioTypes: [],
      autoTrackingObjectTypes: [],
    };
    delete (apiState.camera as { smartDetectZones?: unknown }).smartDetectZones;
    delete (apiState.camera as { secondLensSmartDetectZones?: unknown }).secondLensSmartDetectZones;
    apiState.api.updateDevice.mockClear();
  });

  it('reports effective motion state without credentials and ignores sensor motionSettings', async () => {
    const hap = createdApi();
    const platform = new ProtectMotionPlatform(
      createMockLogger(),
      createMockConfig({
        controllers: [
          {
            address: '10.0.0.5',
            username: 'homebridge-user',
            password: 'super-secret-password',
          },
        ],
      }),
      hap,
    );

    (hap as unknown as { emit: (event: string) => void }).emit('didFinishLaunching');
    await vi.waitFor(async () => {
      const health = await platform.getHealth();
      expect(health.controllers[0]?.cameras).toHaveLength(1);
    });

    const health = await platform.getHealth();
    const text = JSON.stringify(health);
    expect(text).not.toContain('super-secret-password');
    expect(text).not.toContain('homebridge-user');
    expect(text).toContain('10.0.0.5');
    expect(health.schemaVersion).toBe('1.2.0');
    expect(health.pluginVersion).toBe('1.0.16');
    expect(health.controllers[0]?.cameras[0]).toMatchObject({
      id: 'cam1',
      createMotionEvents: true,
      motionSettings: null,
      motionSettingsKnown: true,
      intendedMotionEnabled: true,
      drift: false,
      readback: { status: 'verified' },
    });

    const created = (hap.platformAccessory as unknown as { mock: { results: { value: PlatformAccessory }[] } }).mock
      .results[0]?.value;
    expect(created).toBeDefined();
    if (!created) {
      return;
    }

    apiState.listeners.get('message')?.({
      action: { action: 'update', modelKey: 'camera', id: 'cam1' },
      payload: { motionSettings: { isEnabled: false } },
    });
    expect(switchValue(created)).toBe(true);

    apiState.listeners.get('message')?.({
      action: { action: 'update', modelKey: 'camera', id: 'cam1' },
      payload: { recordingSettings: { enableMotionDetection: false } },
    });
    expect(switchValue(created)).toBe(false);

    apiState.camera.recordingSettings.enableMotionDetection = false;
    const refreshed = await platform.getHealth({ refresh: true });
    expect(refreshed.controllers[0]?.cameras[0]?.createMotionEvents).toBe(false);
    expect(refreshed.controllers[0]?.cameras[0]?.drift).toBe(false);
    expect(refreshed.controllers[0]?.cameras[0]?.readback.status).toBe('verified');
    expect(apiState.api.updateDevice).not.toHaveBeenCalled();
  });

  it('stays off after restart when the controller left a type on an empty second lens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'protect-restart-'));
    const entrance = [
      [0, 0],
      [1, 0],
      [1, 1],
    ];
    const down = [
      [0.1, 0.8],
      [0.9, 0.8],
      [0.9, 1],
    ];
    new SmartDetectSnapshotStore(() => dir).remember('10.0.0.5', 'cam1', 'Front Door', {
      objectTypes: [],
      audioTypes: [],
      autoTrackingObjectTypes: [],
      settingsPresent: true,
      zones: [
        {
          id: 1,
          name: 'Zone A',
          points: entrance,
          sensitivity: 70,
          objectTypes: ['person', 'vehicle'],
          raw: { id: 1, name: 'Zone A', points: entrance, sensitivity: 70, objectTypes: ['person', 'vehicle'] },
        },
      ],
      secondLensZones: [
        {
          id: 2,
          name: 'Down',
          points: down,
          sensitivity: 40,
          objectTypes: [],
          raw: { id: 2, name: 'Down', points: down, sensitivity: 40, objectTypes: [] },
        },
      ],
    });
    apiState.camera.smartDetectSettings = { objectTypes: [], audioTypes: [], autoTrackingObjectTypes: [] };
    Object.assign(apiState.camera, {
      smartDetectZones: [{ id: 1, name: 'Zone A', points: entrance, sensitivity: 70, objectTypes: [] }],
      secondLensSmartDetectZones: [{ id: 2, name: 'Down', points: down, sensitivity: 40, objectTypes: ['package'] }],
    });

    const hap = createdApi({ storagePath: dir });
    const platform = new ProtectMotionPlatform(
      createMockLogger(),
      createMockConfig({
        controllers: [{ address: '10.0.0.5', username: 'homebridge-user', password: 'super-secret-password' }],
      }),
      hap,
    );
    (hap as unknown as { emit: (event: string) => void }).emit('didFinishLaunching');
    await vi.waitFor(async () => {
      const health = await platform.getHealth();
      expect(health.controllers[0]?.cameras).toHaveLength(1);
    });

    const created = (hap.platformAccessory as unknown as { mock: { results: { value: PlatformAccessory }[] } }).mock
      .results[0]?.value;
    const smart = (
      created as PlatformAccessory & { getServiceBySubtype: (subtype: string) => Service }
    ).getServiceBySubtype('smart-detect-switch');
    expect(
      (smart.getCharacteristic('On' as unknown as never) as unknown as { invokeGet: () => unknown }).invokeGet(),
    ).toBe(false);
    expect(apiState.api.updateDevice).not.toHaveBeenCalled();

    const health = await platform.getHealth();
    expect(health.controllers[0]?.cameras[0]).toMatchObject({
      smartDetectDrift: false,
      drift: false,
      smartDetectEnforcedTypes: [],
      readback: { status: 'verified' },
    });
    const saved = JSON.parse(readFileSync(join(dir, SMART_DETECT_SNAPSHOT_FILENAME), 'utf8')) as {
      cameras: Array<{
        config: { zones: Array<{ objectTypes: string[] }>; secondLensZones: Array<{ objectTypes: string[] }> };
      }>;
    };
    expect(saved.cameras[0]?.config.zones[0]?.objectTypes).toEqual(['person', 'vehicle']);
    expect(saved.cameras[0]?.config.secondLensZones[0]?.objectTypes).toEqual([]);
  });

  it('records an authentication failure without the password', async () => {
    apiState.login.mockResolvedValue(false);
    const hap = createdApi();
    const platform = new ProtectMotionPlatform(
      createMockLogger(),
      createMockConfig({
        controllers: [{ address: '10.0.0.5', username: 'homebridge-user', password: 'super-secret-password' }],
      }),
      hap,
    );

    (hap as unknown as { emit: (event: string) => void }).emit('didFinishLaunching');
    await vi.waitFor(async () => {
      const health = await platform.getHealth();
      expect(health.controllers[0]?.lastError).toBe('authentication failed');
    });

    const health = await platform.getHealth();
    expect(health.controllers[0]?.connected).toBe(false);
    expect(JSON.stringify(health)).not.toContain('super-secret-password');
    expect(JSON.stringify(health)).not.toContain('homebridge-user');
  });
});

describe('ProtectMotionPlatform health file', () => {
  beforeEach(() => {
    apiState.listeners.clear();
    apiState.sessionUp = true;
    apiState.admin = true;
    apiState.login.mockResolvedValue(true);
    apiState.camera.recordingSettings.enableMotionDetection = true;
    apiState.camera.motionSettings = null;
    apiState.camera.smartDetectSettings = {
      objectTypes: ['person'],
      audioTypes: [],
      autoTrackingObjectTypes: [],
    };
    delete (apiState.camera as { smartDetectZones?: unknown }).smartDetectZones;
    delete (apiState.camera as { secondLensSmartDetectZones?: unknown }).secondLensSmartDetectZones;
  });

  it('writes a home-monitor-compatible snapshot after bootstrap and marks disconnect on shutdown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'protect-health-platform-'));
    const hap = createdApi({ storagePath: dir });
    new ProtectMotionPlatform(
      createMockLogger(),
      createMockConfig({
        controllers: [
          {
            address: '10.0.0.5',
            username: 'homebridge-user',
            password: 'super-secret-password',
          },
        ],
      }),
      hap,
    );

    (hap as unknown as { emit: (event: string) => void }).emit('didFinishLaunching');
    const file = join(dir, HEALTH_FILENAME);
    await vi.waitFor(() => {
      expect(existsSync(file)).toBe(true);
    });

    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      pluginVersion: string;
      schemaVersion: string;
      updatedAtEpoch: number;
      controllers: Array<{
        connected: boolean;
        cameras: number;
        cameraHealth: Array<{ readback: { status: string }; drift: boolean | null }>;
      }>;
    };
    expect(parsed.pluginVersion).toBe('1.0.16');
    expect(parsed.schemaVersion).toBe('1.2.0');
    expect(typeof parsed.updatedAtEpoch).toBe('number');
    expect(parsed.controllers[0]?.connected).toBe(true);
    expect(parsed.controllers[0]?.cameras).toBe(1);
    expect(typeof parsed.controllers[0]?.cameras).toBe('number');
    expect(parsed.controllers.map((controller) => controller.cameras).reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(parsed.controllers[0]?.cameraHealth[0]).toMatchObject({
      readback: { status: 'verified' },
      drift: false,
    });
    expect(JSON.stringify(parsed)).not.toContain('super-secret-password');
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    (hap as unknown as { emit: (event: string) => void }).emit('shutdown');
    await vi.waitFor(() => {
      const after = JSON.parse(readFileSync(file, 'utf8')) as typeof parsed;
      expect(after.controllers[0]?.connected).toBe(false);
    });
  });

  it('keeps camera health when the Protect session is lost and clears it after recovery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'protect-health-session-'));
    const hap = createdApi({ storagePath: dir });
    const platform = new ProtectMotionPlatform(
      createMockLogger(),
      createMockConfig({
        controllers: [{ address: '10.0.0.5', username: 'homebridge-user', password: 'super-secret-password' }],
      }),
      hap,
    );

    (hap as unknown as { emit: (event: string) => void }).emit('didFinishLaunching');
    const file = join(dir, HEALTH_FILENAME);
    await vi.waitFor(() => {
      expect(existsSync(file)).toBe(true);
    });

    apiState.sessionUp = false;
    const lost = await platform.getHealth();
    expect(lost.schemaVersion).toBe('1.2.0');
    expect(lost.controllers[0]?.connected).toBe(false);
    expect(lost.controllers[0]?.admin).toBeNull();
    expect(lost.controllers[0]?.lastError).toBe('protect session lost');
    expect(lost.controllers[0]?.cameras).toHaveLength(1);
    expect(lost.controllers[0]?.cameras[0]).toMatchObject({
      id: 'cam1',
      name: 'Front Door',
      smartDetectObjectTypes: ['person'],
    });
    const stillLost = await platform.getHealth();
    expect(stillLost.controllers[0]?.lastError).toBe('protect session lost');

    apiState.listeners.get('message')?.({
      action: { action: 'update', modelKey: 'camera', id: 'cam1' },
      payload: { recordingSettings: { enableMotionDetection: true } },
    });
    await vi.waitFor(() => {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        schemaVersion: string;
        updatedAtEpoch: number;
        controllers: Array<{
          connected: boolean;
          admin: boolean | null;
          lastError: string | null;
          reconnecting: boolean;
          consecutiveFailures: number;
          cameras: number;
          cameraHealth: Array<{ id: string; smartDetectObjectTypes: string[] | null }>;
        }>;
      };
      expect(parsed.schemaVersion).toBe('1.2.0');
      expect(typeof parsed.updatedAtEpoch).toBe('number');
      expect(parsed.controllers[0]?.connected).toBe(false);
      expect(parsed.controllers[0]?.admin).toBeNull();
      expect(parsed.controllers[0]?.lastError).toBe('protect session lost');
      expect(parsed.controllers[0]?.reconnecting).toBe(true);
      expect(parsed.controllers[0]?.consecutiveFailures).toBe(1);
      expect(parsed.controllers[0]?.cameras).toBe(1);
      expect(parsed.controllers[0]?.cameraHealth).toHaveLength(1);
      expect(parsed.controllers[0]?.cameraHealth[0]?.smartDetectObjectTypes).toEqual(['person']);
    });

    apiState.sessionUp = true;
    apiState.admin = true;
    const restored = await platform.getHealth();
    expect(restored.controllers[0]?.connected).toBe(true);
    expect(restored.controllers[0]?.admin).toBe(true);
    expect(restored.controllers[0]?.lastError).toBeNull();
    expect(restored.controllers[0]?.cameras).toHaveLength(1);
  });
});
