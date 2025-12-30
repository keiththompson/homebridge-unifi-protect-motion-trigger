import type { API, Characteristic, Logging, PlatformAccessory, Service } from 'homebridge';
import { vi } from 'vitest';

import type { ProtectMotionPlatformConfig } from '../settings.js';

export function createMockLogger(): Logging {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
    success: vi.fn(),
  } as unknown as Logging;
}

export function createMockCharacteristic(): Characteristic {
  const mock = {
    onGet: vi.fn().mockReturnThis(),
    onSet: vi.fn().mockReturnThis(),
    setProps: vi.fn().mockReturnThis(),
    updateValue: vi.fn().mockReturnThis(),
    value: null,
  };
  return mock as unknown as Characteristic;
}

export function createMockService(): Service {
  const characteristics = new Map<string, Characteristic>();

  const mock = {
    getCharacteristic: vi.fn((type: unknown) => {
      const key = String(type);
      if (!characteristics.has(key)) {
        characteristics.set(key, createMockCharacteristic());
      }
      return characteristics.get(key);
    }),
    setCharacteristic: vi.fn().mockReturnThis(),
    addOptionalCharacteristic: vi.fn().mockReturnThis(),
    updateCharacteristic: vi.fn().mockReturnThis(),
  };

  return mock as unknown as Service;
}

export function createMockAccessory(displayName: string, uuid: string): PlatformAccessory {
  const services = new Map<string, Service>();

  const mock = {
    displayName,
    UUID: uuid,
    context: {},
    getService: vi.fn((type: unknown) => services.get(String(type))),
    getServiceById: vi.fn((_type: unknown, _subtype: string) => undefined),
    addService: vi.fn((type: unknown, name: string, subtype: string) => {
      const service = createMockService();
      services.set(`${type}-${subtype}`, service);
      return service;
    }),
  };

  return mock as unknown as PlatformAccessory;
}

export function createMockAPI(): API {
  const accessories: PlatformAccessory[] = [];
  const eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>();

  const mock = {
    hap: {
      Service: {
        AccessoryInformation: 'AccessoryInformation',
        MotionSensor: 'MotionSensor',
        Switch: 'Switch',
      },
      Characteristic: {
        Manufacturer: 'Manufacturer',
        Model: 'Model',
        SerialNumber: 'SerialNumber',
        Name: 'Name',
        ConfiguredName: 'ConfiguredName',
        On: 'On',
        MotionDetected: 'MotionDetected',
        StatusActive: 'StatusActive',
      },
      uuid: {
        generate: vi.fn((input: string) => `uuid-${input}`),
      },
    },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, []);
      }
      eventHandlers.get(event)!.push(handler);
    }),
    platformAccessory: vi.fn((name: string, uuid: string) => createMockAccessory(name, uuid)),
    registerPlatformAccessories: vi.fn((_pluginName: string, _platformName: string, accs: PlatformAccessory[]) => {
      accessories.push(...accs);
    }),
    updatePlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
    emit: (event: string, ...args: unknown[]) => {
      const handlers = eventHandlers.get(event) || [];
      for (const handler of handlers) {
        handler(...args);
      }
    },
  };

  return mock as unknown as API;
}

export function createMockConfig(overrides: Partial<ProtectMotionPlatformConfig> = {}): ProtectMotionPlatformConfig {
  return {
    platform: 'UniFi Protect Motion Trigger',
    name: 'Test Platform',
    controllers: [
      {
        address: '192.168.1.1',
        username: 'testuser',
        password: 'testpass',
      },
    ],
    motionDuration: 10,
    debug: false,
    ...overrides,
  };
}

export function createMockCamera(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'camera-1',
    name: 'Test Camera',
    type: 'UVC G4 Pro',
    mac: 'AA:BB:CC:DD:EE:FF',
    host: '192.168.1.100',
    lastMotion: null,
    ledSettings: {
      isEnabled: true,
      blinkRate: 0,
    },
    ...overrides,
  };
}
