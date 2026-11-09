import type { PlatformAccessory, Service } from 'homebridge';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProtectMotionPlatform } from './platform.js';
import { createMockAPI, createMockConfig, createMockLogger } from './test/mocks.js';

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
    login: vi.fn(async (_address: string, _username: string, _password: string) => true),
    api: {
      login: (address: string, username: string, password: string) => apiState.login(address, username, password),
      getBootstrap: vi.fn(async () => true),
      get bootstrap() {
        return { cameras: [apiState.camera], lastUpdateId: '1' };
      },
      isThrottled: false,
      isAdminUser: true,
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
    apiState.login.mockResolvedValue(true);
    apiState.camera.recordingSettings.enableMotionDetection = true;
    apiState.camera.motionSettings = null;
    apiState.camera.smartDetectSettings = {
      objectTypes: ['person'],
      audioTypes: [],
      autoTrackingObjectTypes: [],
    };
  });

  it('reports effective motion state without credentials and ignores sensor motionSettings', async () => {
    const hap = createMockAPI();
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
    expect(health.schemaVersion).toBe('1.1.0');
    expect(health.pluginVersion).toBe('1.0.10');
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
    apiState.camera.smartDetectSettings.objectTypes = [];
    const refreshed = await platform.getHealth({ refresh: true });
    expect(refreshed.controllers[0]?.cameras[0]?.createMotionEvents).toBe(false);
    expect(refreshed.controllers[0]?.cameras[0]?.drift).toBe(false);
    expect(refreshed.controllers[0]?.cameras[0]?.readback.status).toBe('verified');
    expect(apiState.api.updateDevice).not.toHaveBeenCalled();
  });

  it('records an authentication failure without the password', async () => {
    apiState.login.mockResolvedValue(false);
    const hap = createMockAPI();
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
