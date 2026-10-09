import type { Mock } from 'vitest';
import { describe, expect, it, vi } from 'vitest';

import type { ProtectEventPacket } from './api/types.js';
import { ProtectMotionPlatform } from './platform.js';
import { createMockAPI, createMockConfig, createMockLogger } from './test/mocks.js';

const fsState = vi.hoisted(() => ({ writeFileSync: vi.fn() }));
vi.mock('node:fs', () => ({ writeFileSync: (...args: unknown[]) => fsState.writeFileSync(...args) }));

interface FakeAccessory {
  handleMotionEvent: Mock;
  handleLedSettingsUpdate: Mock;
  handleMotionSettingsUpdate: Mock;
}

// Minimal stand-in for a configured CameraAccessory so we can assert how the
// platform routes realtime packets to it.
function fakeAccessory(): FakeAccessory {
  return {
    handleMotionEvent: vi.fn(),
    handleLedSettingsUpdate: vi.fn(),
    handleMotionSettingsUpdate: vi.fn(),
  };
}

// Builds a platform with a single camera ("cam1") already registered, so
// handleProtectMessage has somewhere to route to.
function platformWithCamera(): { accessory: FakeAccessory; dispatch: (packet: ProtectEventPacket) => void } {
  const platform = new ProtectMotionPlatform(createMockLogger(), createMockConfig(), createMockAPI());
  const accessory = fakeAccessory();
  (platform as unknown as { configuredAccessories: Map<string, unknown> }).configuredAccessories.set('cam1', accessory);
  const dispatch = (packet: ProtectEventPacket): void =>
    (
      platform as unknown as { handleProtectMessage: (addr: string, p: ProtectEventPacket) => void }
    ).handleProtectMessage('192.168.1.1', packet);
  return { accessory, dispatch };
}

describe('ProtectMotionPlatform.handleProtectMessage', () => {
  it('routes a header-shaped camera motion packet to the accessory', () => {
    const { accessory, dispatch } = platformWithCamera();

    // Shape the unifi-protect library actually emits: { header, payload }.
    dispatch({
      header: { action: 'update', modelKey: 'camera', id: 'cam1' },
      payload: { lastMotion: 1_700_000_000_000 },
    });

    expect(accessory.handleMotionEvent).toHaveBeenCalledWith(1_700_000_000_000);
  });

  it('ignores the legacy { action } packet shape (regression guard)', () => {
    const { accessory, dispatch } = platformWithCamera();

    // The pre-fix code read packet.action; the library never populates it, so a
    // packet with only `action` must not be mistaken for a valid one.
    dispatch({
      action: { action: 'update', modelKey: 'camera', id: 'cam1' },
      payload: { lastMotion: 1_700_000_000_000 },
    } as unknown as ProtectEventPacket);

    expect(accessory.handleMotionEvent).not.toHaveBeenCalled();
  });

  it('routes led and motion setting updates from the header shape', () => {
    const { accessory, dispatch } = platformWithCamera();

    dispatch({
      header: { action: 'update', modelKey: 'camera', id: 'cam1' },
      payload: {
        ledSettings: { isEnabled: false, blinkRate: 0 },
        motionSettings: { isEnabled: false, sensitivity: 0 },
      },
    });

    expect(accessory.handleLedSettingsUpdate).toHaveBeenCalledWith({ isEnabled: false, blinkRate: 0 });
    expect(accessory.handleMotionSettingsUpdate).toHaveBeenCalledWith(false);
  });

  it('ignores packets for non-camera models and unknown cameras', () => {
    const { accessory, dispatch } = platformWithCamera();

    dispatch({ header: { action: 'update', modelKey: 'nvr', id: 'cam1' }, payload: { lastMotion: 1 } });
    dispatch({ header: { action: 'update', modelKey: 'camera', id: 'unknown' }, payload: { lastMotion: 1 } });

    expect(accessory.handleMotionEvent).not.toHaveBeenCalled();
  });
});

describe('ProtectMotionPlatform health file', () => {
  it('writes a snapshot of every controller to the storage dir', () => {
    fsState.writeFileSync.mockClear();
    const platform = new ProtectMotionPlatform(createMockLogger(), createMockConfig(), createMockAPI());
    const clients = (platform as unknown as { clients: Map<string, unknown> }).clients;
    clients.set('10.0.0.1', {
      health: {
        address: '10.0.0.1',
        connected: true,
        reconnecting: false,
        consecutiveFailures: 0,
        lastEventAt: 1_700_000_000_000,
        lastBootstrapAt: 1_700_000_000_000,
        cameras: 3,
      },
    });

    (platform as unknown as { writeHealthFile: () => void }).writeHealthFile();

    expect(fsState.writeFileSync).toHaveBeenCalledTimes(1);
    const [path, body] = fsState.writeFileSync.mock.calls[0] as [string, string];
    expect(path).toContain('.unifi-protect-motion-trigger-health.json');

    const parsed = JSON.parse(body);
    expect(typeof parsed.updatedAtEpoch).toBe('number');
    expect(parsed.controllers).toHaveLength(1);
    expect(parsed.controllers[0]).toMatchObject({ address: '10.0.0.1', connected: true, cameras: 3 });
    expect(parsed.controllers[0].lastEventAt).toBe(new Date(1_700_000_000_000).toISOString());
  });
});
