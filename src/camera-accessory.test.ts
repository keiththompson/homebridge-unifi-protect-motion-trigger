import type { Characteristic, PlatformAccessory, Service } from 'homebridge';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProtectClient } from './api/client.js';
import type { ProtectCamera, UpdateOutcome } from './api/types.js';
import { CameraAccessory } from './camera-accessory.js';
import type { ProtectMotionPlatform } from './platform.js';
import { createMockAccessory, createMockAPI, createMockLogger } from './test/mocks.js';

function platform(log = createMockLogger(), showSmartDetection = true): ProtectMotionPlatform {
  const api = createMockAPI();
  return {
    log,
    api,
    showSmartDetection,
    Service: api.hap.Service,
    Characteristic: api.hap.Characteristic,
    debugLog: vi.fn(),
  } as unknown as ProtectMotionPlatform;
}

function camera(enableMotionDetection: boolean | undefined): ProtectCamera {
  return {
    id: 'cam1',
    name: 'Front Door',
    type: 'UVC G4 Pro',
    mac: 'AA:BB:CC:DD:EE:FF',
    host: '192.168.1.50',
    lastMotion: null,
    ledSettings: { isEnabled: true },
    recordingSettings: enableMotionDetection === undefined ? undefined : { enableMotionDetection, mode: 'always' },
    motionSettings: null,
    smartDetectSettings: {
      objectTypes: ['person'],
      audioTypes: [],
      autoTrackingObjectTypes: [],
    },
  };
}

function outcome(
  result: UpdateOutcome['result'],
  preferences: UpdateOutcome['smartDetectPreferences'] = null,
): UpdateOutcome {
  return {
    result,
    smartDetectResult: null,
    smartDetectPreferences: preferences,
    smartDetectConfig: null,
    camera: null,
  };
}

function namedSwitch(
  accessory: PlatformAccessory,
  subtype: string,
): Characteristic & {
  invokeGet: () => unknown;
  invokeSet: (value: unknown) => unknown;
} {
  const service = (
    accessory as PlatformAccessory & { getServiceBySubtype: (subtype: string) => Service }
  ).getServiceBySubtype(subtype);
  return service.getCharacteristic('On' as unknown as never) as Characteristic & {
    invokeGet: () => unknown;
    invokeSet: (value: unknown) => unknown;
  };
}

function motionSwitch(accessory: PlatformAccessory): Characteristic & {
  invokeGet: () => unknown;
  invokeSet: (value: unknown) => unknown;
} {
  return namedSwitch(accessory, 'motion-switch');
}

describe('CameraAccessory motion lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('seeds the switch from Create Motion Events when motionSettings is null', () => {
    const accessory = createMockAccessory('Front Door', 'uuid-1');
    accessory.context.camera = camera(false);
    const client = { updateCameraSettings: vi.fn() } as unknown as ProtectClient;
    new CameraAccessory(platform(), accessory, client, 10);

    expect(motionSwitch(accessory).invokeGet()).toBe(false);
    expect(accessory.context.motionEnabled).toBe(false);
  });

  it('tells a confirmed non-admin apart from a lost session', async () => {
    vi.useFakeTimers();
    const accessory = createMockAccessory('Front Door', 'uuid-1');
    accessory.context.camera = camera(true);
    const log = createMockLogger();
    const client = {
      updateCameraSettings: vi.fn().mockResolvedValue(outcome('unauthorized')),
    } as unknown as ProtectClient;
    new CameraAccessory(platform(log), accessory, client, 10);

    const pending = motionSwitch(accessory).invokeSet(false);
    await vi.advanceTimersByTimeAsync(50);
    await pending;

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not a Protect admin'));
  });

  it('does not describe a lost session as a missing admin role', async () => {
    vi.useFakeTimers();
    const accessory = createMockAccessory('Front Door', 'uuid-1');
    accessory.context.camera = camera(true);
    const log = createMockLogger();
    const client = {
      updateCameraSettings: vi.fn().mockResolvedValue(outcome('failed')),
    } as unknown as ProtectClient;
    new CameraAccessory(platform(log), accessory, client, 10);

    const pending = motionSwitch(accessory).invokeSet(false);
    await vi.advanceTimersByTimeAsync(50);
    await pending;

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('restore the session'));
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('not a Protect admin'));
  });

  it('does not keep a motion change that readback rejected', async () => {
    vi.useFakeTimers();
    const accessory = createMockAccessory('Front Door', 'uuid-1');
    accessory.context.camera = camera(true);
    const log = createMockLogger();
    const host = platform(log);
    const client = {
      updateCameraSettings: vi.fn().mockResolvedValue(outcome('mismatch')),
    } as unknown as ProtectClient;
    const cameraAccessory = new CameraAccessory(host, accessory, client, 10);
    accessory.context.smartDetectPreferences = {
      objectTypes: ['person'],
      audioTypes: [],
      autoTrackingObjectTypes: [],
    };

    const pending = motionSwitch(accessory).invokeSet(false);
    await vi.advanceTimersByTimeAsync(50);
    await pending;

    expect(client.updateCameraSettings).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cam1' }),
      expect.objectContaining({ motion: false }),
    );
    expect(client.updateCameraSettings).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cam1' }),
      expect.not.objectContaining({ smartDetect: expect.anything() }),
    );
    expect(cameraAccessory.motionEnabledState).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('readback does not match'));
  });

  it('keeps a confirmed motion change from changing smart detection', async () => {
    vi.useFakeTimers();
    const accessory = createMockAccessory('Front Door', 'uuid-1');
    accessory.context.camera = camera(true);
    const client = {
      updateCameraSettings: vi.fn().mockResolvedValue(outcome('ok')),
    } as unknown as ProtectClient;
    const cameraAccessory = new CameraAccessory(platform(), accessory, client, 10);

    const pending = motionSwitch(accessory).invokeSet(false);
    await vi.advanceTimersByTimeAsync(50);
    await pending;

    expect(cameraAccessory.motionEnabledState).toBe(false);
    expect(cameraAccessory.smartDetectState).toBe(true);
  });

  it('follows Create Motion Events events and ignores sensor motionSettings', () => {
    const accessory = createMockAccessory('Front Door', 'uuid-1');
    accessory.context.camera = camera(true);
    const cameraAccessory = new CameraAccessory(platform(), accessory, {} as ProtectClient, 10);

    cameraAccessory.handleCreateMotionEventsUpdate(false);
    expect(cameraAccessory.motionEnabledState).toBe(false);
    expect(cameraAccessory.smartDetectState).toBe(true);

    cameraAccessory.handleSmartDetectUpdate({
      smartDetectSettings: { objectTypes: [], audioTypes: [], autoTrackingObjectTypes: [] },
    });
    expect(cameraAccessory.smartDetectState).toBe(false);
    expect(cameraAccessory.motionEnabledState).toBe(false);
  });

  it('sends Motion Enabled and Smart Detection together when a scene flips both', async () => {
    vi.useFakeTimers();
    const accessory = createMockAccessory('Front Door', 'uuid-1');
    accessory.context.camera = camera(true);
    const client = {
      updateCameraSettings: vi.fn().mockResolvedValue({ ...outcome('ok'), smartDetectResult: 'ok' }),
    } as unknown as ProtectClient;
    new CameraAccessory(platform(), accessory, client, 10);

    const pendingMotion = motionSwitch(accessory).invokeSet(false);
    const pendingSmart = namedSwitch(accessory, 'smart-detect-switch').invokeSet(false);
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([pendingMotion, pendingSmart]);

    expect(client.updateCameraSettings).toHaveBeenCalledTimes(1);
    expect(client.updateCameraSettings).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cam1' }),
      expect.objectContaining({ motion: false, smartDetect: false }),
    );
  });

  it('seeds the Smart Detection switch off when the camera is already off', () => {
    const accessory = createMockAccessory('Front Door', 'uuid-1');
    const off = camera(true);
    off.smartDetectSettings = { objectTypes: [], audioTypes: [], autoTrackingObjectTypes: [] };
    accessory.context.camera = off;
    const cameraAccessory = new CameraAccessory(platform(), accessory, {} as ProtectClient, 10);

    expect(cameraAccessory.smartDetectState).toBe(false);
    expect(cameraAccessory.savedSmartDetectConfig).toBeNull();
  });

  it('uses the confirmed camera read so a later event that omits zones cannot turn Smart Detection back on', async () => {
    vi.useFakeTimers();
    const accessory = createMockAccessory('Front Door', 'uuid-1');
    const zone = {
      id: 1,
      name: 'Gate',
      points: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      sensitivity: 75,
      objectTypes: ['person'],
    };
    const initial = camera(true);
    initial.smartDetectZones = [zone];
    accessory.context.camera = initial;
    const confirmed: ProtectCamera = {
      ...initial,
      smartDetectSettings: { objectTypes: [], audioTypes: [], autoTrackingObjectTypes: [] },
      smartDetectZones: [{ ...zone, objectTypes: [] }],
    };
    const client = {
      updateCameraSettings: vi.fn().mockResolvedValue({
        ...outcome('ok'),
        smartDetectResult: 'ok',
        camera: confirmed,
      }),
    } as unknown as ProtectClient;
    const cameraAccessory = new CameraAccessory(platform(), accessory, client, 10);

    const pending = namedSwitch(accessory, 'smart-detect-switch').invokeSet(false);
    await vi.advanceTimersByTimeAsync(50);
    await pending;

    expect(accessory.context.camera).toBe(confirmed);
    expect(cameraAccessory.smartDetectState).toBe(false);

    cameraAccessory.handleSmartDetectUpdate({
      smartDetectSettings: { objectTypes: [], audioTypes: [], autoTrackingObjectTypes: [] },
    });

    expect(cameraAccessory.smartDetectState).toBe(false);
    const cached = accessory.context.camera as ProtectCamera;
    expect((cached.smartDetectZones?.[0] as { objectTypes: string[] }).objectTypes).toEqual([]);
  });

  it('clears cached zone object types when a settings event omits zones', () => {
    const accessory = createMockAccessory('Front Door', 'uuid-1');
    const initial = camera(true);
    initial.smartDetectZones = [
      {
        id: 1,
        name: 'Gate',
        points: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        sensitivity: 75,
        objectTypes: ['person'],
      },
    ];
    accessory.context.camera = initial;
    const cameraAccessory = new CameraAccessory(platform(), accessory, {} as ProtectClient, 10);

    expect(cameraAccessory.smartDetectState).toBe(true);
    cameraAccessory.handleSmartDetectUpdate({
      smartDetectSettings: { objectTypes: [], audioTypes: [], autoTrackingObjectTypes: [] },
    });

    expect(cameraAccessory.smartDetectState).toBe(false);
    const cached = accessory.context.camera as ProtectCamera;
    expect((cached.smartDetectZones?.[0] as { name: string; sensitivity: number; objectTypes: string[] }).name).toBe(
      'Gate',
    );
    expect((cached.smartDetectZones?.[0] as { sensitivity: number }).sensitivity).toBe(75);
    expect((cached.smartDetectZones?.[0] as { objectTypes: string[] }).objectTypes).toEqual([]);
  });

  it('removes a Smart Detection service that was already added when the switch is hidden', () => {
    const accessory = createMockAccessory('Front Door', 'uuid-1');
    accessory.context.camera = camera(true);
    new CameraAccessory(platform(), accessory, {} as ProtectClient, 10);
    expect(
      (accessory as PlatformAccessory & { getServiceBySubtype: (subtype: string) => Service }).getServiceBySubtype(
        'smart-detect-switch',
      ),
    ).toBeDefined();

    new CameraAccessory(platform(createMockLogger(), false), accessory, {} as ProtectClient, 10);

    expect(
      (accessory as PlatformAccessory & { getServiceBySubtype: (subtype: string) => Service }).getServiceBySubtype(
        'smart-detect-switch',
      ),
    ).toBeUndefined();
  });
});
