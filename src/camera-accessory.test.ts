import type { Characteristic, PlatformAccessory, Service } from 'homebridge';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProtectClient } from './api/client.js';
import type { ProtectCamera, UpdateOutcome } from './api/types.js';
import { CameraAccessory } from './camera-accessory.js';
import type { ProtectMotionPlatform } from './platform.js';
import { createMockAccessory, createMockAPI, createMockLogger } from './test/mocks.js';

function platform(log = createMockLogger()): ProtectMotionPlatform {
  const api = createMockAPI();
  return {
    log,
    api,
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
  return { result, smartDetectPreferences: preferences };
}

function motionSwitch(accessory: PlatformAccessory): Characteristic & {
  invokeGet: () => unknown;
  invokeSet: (value: unknown) => unknown;
} {
  const service = (
    accessory as PlatformAccessory & { getServiceBySubtype: (subtype: string) => Service }
  ).getServiceBySubtype('motion-switch');
  return service.getCharacteristic('On' as unknown as never) as Characteristic & {
    invokeGet: () => unknown;
    invokeSet: (value: unknown) => unknown;
  };
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
      expect.objectContaining({
        motion: false,
        smartDetectPreferences: {
          objectTypes: ['person'],
          audioTypes: [],
          autoTrackingObjectTypes: [],
        },
      }),
    );
    expect(cameraAccessory.motionEnabledState).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('readback does not match'));
  });

  it('applies a confirmed disable and keeps the smart detection snapshot', async () => {
    vi.useFakeTimers();
    const accessory = createMockAccessory('Front Door', 'uuid-1');
    accessory.context.camera = camera(true);
    const client = {
      updateCameraSettings: vi.fn().mockResolvedValue(
        outcome('ok', {
          objectTypes: ['person'],
          audioTypes: [],
          autoTrackingObjectTypes: [],
        }),
      ),
    } as unknown as ProtectClient;
    const cameraAccessory = new CameraAccessory(platform(), accessory, client, 10);

    const pending = motionSwitch(accessory).invokeSet(false);
    await vi.advanceTimersByTimeAsync(50);
    await pending;

    expect(cameraAccessory.motionEnabledState).toBe(false);
    expect(cameraAccessory.savedSmartDetectPreferences).toEqual({
      objectTypes: ['person'],
      audioTypes: [],
      autoTrackingObjectTypes: [],
    });
  });

  it('follows Create Motion Events events and ignores sensor motionSettings', () => {
    const accessory = createMockAccessory('Front Door', 'uuid-1');
    accessory.context.camera = camera(true);
    const cameraAccessory = new CameraAccessory(platform(), accessory, {} as ProtectClient, 10);

    cameraAccessory.handleCreateMotionEventsUpdate(false);
    expect(cameraAccessory.motionEnabledState).toBe(false);

    cameraAccessory.handleSmartDetectSettingsUpdate({ objectTypes: [], audioTypes: ['siren'] });
    expect(cameraAccessory.savedSmartDetectPreferences?.objectTypes).toEqual([]);
    expect(cameraAccessory.savedSmartDetectPreferences?.audioTypes).toEqual(['siren']);
  });
});
