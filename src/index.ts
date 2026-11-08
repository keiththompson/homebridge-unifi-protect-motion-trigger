import type { API } from 'homebridge';

import { ProtectMotionPlatform } from './platform.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export type { CameraHealth, ControllerHealth, PluginHealth } from './health.js';
export { HEALTH_READBACK_STALE_MS, HEALTH_SCHEMA_VERSION } from './health.js';

export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, ProtectMotionPlatform);
};
