import type { PlatformConfig } from 'homebridge';

export const PLUGIN_NAME = 'homebridge-unifi-protect-motion-trigger';
export const PLATFORM_NAME = 'UniFi Protect Motion Trigger';
export const PLUGIN_VERSION = '1.0.17';

export const DEFAULT_MOTION_DURATION = 10; // seconds

// Written into the Homebridge storage dir so an external monitor can read the
// plugin's connection health without the Homebridge UI API (which needs auth).
export const HEALTH_FILENAME = '.unifi-protect-motion-trigger-health.json';

// Saved before the Smart Detection switch turns a camera off, so a restart
// can restore that camera's own zones and object types.
export const SMART_DETECT_SNAPSHOT_FILENAME = '.unifi-protect-motion-trigger-smart-detect.json';

// home-monitor treats a snapshot older than 300s as stale (HEALTH_STALE_SECS).
// Refresh well inside that window so a live plugin is never reported as wedged.
export const HEALTH_WRITE_INTERVAL_MS = 60_000;

export interface ControllerConfig {
  address: string;
  username: string;
  password: string;
}

export interface ProtectMotionPlatformConfig extends PlatformConfig {
  controllers?: ControllerConfig[];
  motionDuration?: number;
  debug?: boolean;
  /**
   * When false, cameras are not given a Smart Detection switch.
   * Omitted or true shows the switch.
   */
  showSmartDetection?: boolean;
}
