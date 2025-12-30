import type { PlatformConfig } from 'homebridge';

export const PLUGIN_NAME = 'homebridge-unifi-protect-motion-trigger';
export const PLATFORM_NAME = 'UniFi Protect Motion Trigger';

export const DEFAULT_MOTION_DURATION = 10; // seconds

export interface ControllerConfig {
  address: string;
  username: string;
  password: string;
}

export interface ProtectMotionPlatformConfig extends PlatformConfig {
  controllers?: ControllerConfig[];
  motionDuration?: number;
  debug?: boolean;
}
