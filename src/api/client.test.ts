import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockLogger } from '../test/mocks.js';
import { ProtectClient } from './client.js';
import type { ProtectCamera } from './types.js';

// Mutable state backing the mocked ProtectApi instance. Declared via vi.hoisted so
// it is initialized before the hoisted vi.mock factory below references it.
const apiState = vi.hoisted(() => ({
  isThrottled: false,
  isAdminUser: true,
  updateDevice: vi.fn(),
}));

vi.mock('unifi-protect', () => ({
  // A regular function (not an arrow) so it can be invoked with `new`.
  ProtectApi: vi.fn().mockImplementation(function () {
    return {
      get isThrottled() {
        return apiState.isThrottled;
      },
      get isAdminUser() {
        return apiState.isAdminUser;
      },
      updateDevice: (...args: unknown[]) => apiState.updateDevice(...args),
      on: vi.fn(),
      reset: vi.fn(),
    };
  }),
}));

const camera = { id: 'cam1', name: 'Test Camera' } as ProtectCamera;

function connectedClient(): ProtectClient {
  const client = new ProtectClient(createMockLogger());
  // Mark connected without exercising the real login flow.
  (client as unknown as { connected: boolean }).connected = true;
  return client;
}

beforeEach(() => {
  apiState.isThrottled = false;
  apiState.isAdminUser = true;
  apiState.updateDevice = vi.fn().mockResolvedValue({});
});

describe('ProtectClient device writes', () => {
  it('returns "ok" and calls the API when the controller accepts the change', async () => {
    const client = connectedClient();

    const result = await client.updateCameraLed(camera, true);

    expect(result).toBe('ok');
    expect(apiState.updateDevice).toHaveBeenCalledWith(camera, { ledSettings: { isEnabled: true } });
  });

  it('returns "failed" without calling the API when not connected', async () => {
    const client = new ProtectClient(createMockLogger());

    const result = await client.updateCameraMotionDetection(camera, true);

    expect(result).toBe('failed');
    expect(apiState.updateDevice).not.toHaveBeenCalled();
  });

  it('returns "throttled" without calling the API while throttled', async () => {
    apiState.isThrottled = true;
    const client = connectedClient();

    const result = await client.updateCameraLed(camera, false);

    expect(result).toBe('throttled');
    expect(apiState.updateDevice).not.toHaveBeenCalled();
  });

  it('returns "unauthorized" without calling the API when the account is not an admin', async () => {
    apiState.isAdminUser = false;
    const client = connectedClient();

    const result = await client.updateCameraMotionDetection(camera, true);

    expect(result).toBe('unauthorized');
    expect(apiState.updateDevice).not.toHaveBeenCalled();
  });

  it('merges LED and motion into a single updateDevice call', async () => {
    const client = connectedClient();

    const result = await client.updateCameraSettings(camera, { led: true, motion: false });

    expect(result).toBe('ok');
    expect(apiState.updateDevice).toHaveBeenCalledTimes(1);
    expect(apiState.updateDevice).toHaveBeenCalledWith(camera, {
      ledSettings: { isEnabled: true },
      motionSettings: { isEnabled: false },
    });
  });

  it('makes no API call when no settings are provided', async () => {
    const client = connectedClient();

    const result = await client.updateCameraSettings(camera, {});

    expect(result).toBe('ok');
    expect(apiState.updateDevice).not.toHaveBeenCalled();
  });

  it('returns "failed" when the controller rejects the write', async () => {
    apiState.updateDevice = vi.fn().mockResolvedValue(null);
    const client = connectedClient();

    const result = await client.updateCameraLed(camera, true);

    expect(result).toBe('failed');
  });

  it('serializes writes so they never run concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    apiState.updateDevice = vi.fn().mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return {};
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
    apiState.updateDevice = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({});
    const client = connectedClient();

    const first = await client.updateCameraLed(camera, true);
    const second = await client.updateCameraLed(camera, false);

    expect(first).toBe('failed');
    expect(second).toBe('ok');
  });
});
