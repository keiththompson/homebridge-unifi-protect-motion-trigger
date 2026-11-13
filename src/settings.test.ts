import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MOTION_DURATION,
  HEALTH_FILENAME,
  HEALTH_WRITE_INTERVAL_MS,
  PLATFORM_NAME,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  SMART_DETECT_SNAPSHOT_FILENAME,
} from './settings.js';

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
    expect(PLUGIN_VERSION).toBe('1.0.17');
  });

  it('names the health file home-monitor reads and refreshes inside its stale window', () => {
    expect(HEALTH_FILENAME).toBe('.unifi-protect-motion-trigger-health.json');
    expect(SMART_DETECT_SNAPSHOT_FILENAME).toBe('.unifi-protect-motion-trigger-smart-detect.json');
    expect(HEALTH_WRITE_INTERVAL_MS).toBe(60_000);
    expect(HEALTH_WRITE_INTERVAL_MS).toBeLessThan(300_000);
  });
});
