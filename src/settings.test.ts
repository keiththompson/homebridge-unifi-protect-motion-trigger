import { describe, expect, it } from 'vitest';

import { DEFAULT_MOTION_DURATION, PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

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
});
