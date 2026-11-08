import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DEFAULT_MOTION_DURATION, PLATFORM_NAME, PLUGIN_NAME, PLUGIN_VERSION } from './settings.js';

describe('settings', () => {
  it('should export correct plugin name', () => {
    expect(PLUGIN_NAME).toBe('homebridge-unifi-protect-motion-trigger');
  });

  it('should export correct platform name', () => {
    expect(PLATFORM_NAME).toBe('UniFi Protect Motion Trigger');
  });

  it('should export default motion duration', () => {
    expect(DEFAULT_MOTION_DURATION).toBe(10);
  });

  it('matches package.json so health reports the published version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(PLUGIN_VERSION).toBe(pkg.version);
    expect(PLUGIN_VERSION).toBe('1.1.0');
  });
});
