import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockLogger } from '../test/mocks.js';
import { ProtectClient } from './client.js';
import type { ProtectCamera } from './types.js';

// Mutable state backing the mocked ProtectApi instance. Declared via vi.hoisted so
// it is initialized before the hoisted vi.mock factory below references it.
const apiState = vi.hoisted(() => ({
  isThrottled: false,
  isAdminUser: true,
  bootstrap: { cameras: [] } as unknown,
  updateDevice: vi.fn(),
  login: vi.fn(),
  getBootstrap: vi.fn(),
  logout: vi.fn(),
  reset: vi.fn(),
  handlers: new Map<string, (arg: unknown) => void>(),
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
      get bootstrap() {
        return apiState.bootstrap;
      },
      login: (...args: unknown[]) => apiState.login(...args),
      getBootstrap: (...args: unknown[]) => apiState.getBootstrap(...args),
      logout: (...args: unknown[]) => apiState.logout(...args),
      updateDevice: (...args: unknown[]) => apiState.updateDevice(...args),
      reset: (...args: unknown[]) => apiState.reset(...args),
      on: (event: string, handler: (arg: unknown) => void) => apiState.handlers.set(event, handler),
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
  apiState.bootstrap = { cameras: [] };
  apiState.updateDevice = vi.fn().mockResolvedValue({});
  apiState.login = vi.fn().mockResolvedValue(true);
  apiState.getBootstrap = vi.fn().mockResolvedValue(true);
  apiState.logout = vi.fn();
  apiState.reset = vi.fn();
  apiState.handlers = new Map();
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

describe('ProtectClient connection watchdog', () => {
  // bootstrapRefreshMs: -1 makes every tick consider the (fresh) connection stale,
  // so checkConnection() always exercises the refresh path without timers.
  const alwaysRefresh = { healthCheckIntervalMs: 1_000_000, bootstrapRefreshMs: -1 };

  it('does nothing while the connection is healthy and recently bootstrapped', async () => {
    const client = new ProtectClient(createMockLogger(), { bootstrapRefreshMs: 1_000_000 });
    await client.connect('10.0.0.1', 'user', 'pass');
    apiState.getBootstrap.mockClear();

    await client.checkConnection();

    expect(apiState.getBootstrap).not.toHaveBeenCalled();
    expect(client.isConnected).toBe(true);
    client.disconnect();
  });

  it('re-bootstraps a stale connection without a full re-login', async () => {
    const client = new ProtectClient(createMockLogger(), alwaysRefresh);
    await client.connect('10.0.0.1', 'user', 'pass');
    apiState.getBootstrap.mockClear();

    await client.checkConnection();

    expect(apiState.getBootstrap).toHaveBeenCalledTimes(1);
    expect(apiState.logout).not.toHaveBeenCalled();
    expect(apiState.login).toHaveBeenCalledTimes(1); // only the initial connect
    expect(client.isConnected).toBe(true);
    client.disconnect();
  });

  it('falls back to a full re-login when the bootstrap refresh fails', async () => {
    const client = new ProtectClient(createMockLogger(), alwaysRefresh);
    await client.connect('10.0.0.1', 'user', 'pass');
    // Next refresh: bootstrap fails, then the re-login + bootstrap succeed.
    apiState.getBootstrap.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await client.checkConnection();

    expect(apiState.logout).toHaveBeenCalledTimes(1);
    expect(apiState.login).toHaveBeenCalledTimes(2);
    expect(client.isConnected).toBe(true);
    expect(client.health.consecutiveFailures).toBe(0);
    client.disconnect();
  });

  it('records a failure when the re-login cannot recover the connection', async () => {
    const client = new ProtectClient(createMockLogger(), alwaysRefresh);
    await client.connect('10.0.0.1', 'user', 'pass');
    apiState.getBootstrap.mockResolvedValueOnce(false); // refresh fails
    apiState.login.mockResolvedValueOnce(false); // re-login fails

    await client.checkConnection();

    expect(client.isConnected).toBe(false);
    expect(client.health.consecutiveFailures).toBe(1);
    client.disconnect();
  });

  it('tracks realtime events and forwards them to handlers', async () => {
    const client = new ProtectClient(createMockLogger());
    await client.connect('10.0.0.1', 'user', 'pass');
    const received: unknown[] = [];
    client.onMessage((packet) => received.push(packet));

    const packet = { header: { action: 'update', modelKey: 'camera', id: 'cam1' }, payload: {} };
    apiState.handlers.get('message')?.(packet);

    expect(received).toEqual([packet]);
    expect(client.health.lastEventAt).not.toBeNull();
    client.disconnect();
  });

  it('exposes connection health and stops the watchdog on disconnect', async () => {
    const client = new ProtectClient(createMockLogger());
    await client.connect('10.0.0.1', 'user', 'pass');

    expect(client.health).toMatchObject({ address: '10.0.0.1', connected: true, reconnecting: false });

    client.disconnect();
    expect(client.isConnected).toBe(false);
  });
});
