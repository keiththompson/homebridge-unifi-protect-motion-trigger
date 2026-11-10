import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MotionDiagnostics } from './api/motion-state.js';
import { motionDrift, readMotionDiagnostics, smartDetectDrift } from './api/motion-state.js';
import {
  cloneSmartDetectConfig,
  disableSmartDetect,
  type SmartDetectConfig,
  smartDetectConfigActive,
  type SmartDetectZoneSnapshot,
} from './api/smart-detect.js';
import type { ProtectCamera, SmartDetectPreferences } from './api/types.js';
import { HEALTH_FILENAME } from './settings.js';

/**
 * Health document.
 * 1.1.0 added readback and drift. 1.2.0 adds smart-detection expected, actual,
 * and drift on each camera. Older fields are unchanged.
 */
export const HEALTH_SCHEMA_VERSION = '1.2.0' as const;

/** A read older than this is stale. Callers can refresh before trusting it. */
export const HEALTH_READBACK_STALE_MS = 5 * 60 * 1000;

export type HealthReadbackStatus = 'unknown' | 'verified' | 'mismatch' | 'stale' | 'error';

export interface CameraReadbackSnapshot {
  fetchedAt: number | null;
  ok: boolean;
  error: string | null;
  attempts: number;
  createMotionEvents: boolean | null;
  motionSettingsKnown: boolean;
  motionSettings: null | { isEnabled: boolean | null };
  smartDetect: SmartDetectPreferences | null;
  smartDetectConfig: SmartDetectConfig | null;
}

export interface SmartDetectHealthZone {
  id: number | null;
  name: string;
  sensitivity: number | null;
  objectTypes: string[];
  points: number[][];
}

/** Smart detection as reported in the health file. Zone geometry is included; raw controller objects are not. */
export interface SmartDetectHealthState {
  objectTypes: string[];
  audioTypes: string[];
  autoTrackingObjectTypes: string[];
  zones: SmartDetectHealthZone[] | null;
  secondLensZones: SmartDetectHealthZone[] | null;
}

export interface CameraHealth {
  id: string;
  name: string;
  intendedMotionEnabled: boolean | null;
  createMotionEvents: boolean | null;
  smartDetectObjectTypes: string[] | null;
  smartDetectAudioTypes: string[] | null;
  smartDetectAutoTrackingObjectTypes: string[] | null;
  motionSettingsKnown: boolean | null;
  motionSettings: null | { isEnabled: boolean | null };
  smartDetectPreferencesSaved: boolean;
  /** Smart detection the switch should have produced, or null when that is not known. */
  smartDetectExpected: SmartDetectHealthState | null;
  /** Smart detection from the last successful camera read, or null. */
  smartDetectActual: SmartDetectHealthState | null;
  /**
   * True when expected and actual smart detection disagree.
   * Null when either side is unknown. Independent of the motion-flag half of `drift`.
   */
  smartDetectDrift: boolean | null;
  /**
   * True when the HomeKit switch and the last successful read disagree,
   * including smart detection. Null when the motion flag is unknown.
   * Stale reads still report drift from that old read.
   */
  drift: boolean | null;
  readback: {
    status: HealthReadbackStatus;
    fetchedAt: string | null;
    error: string | null;
    attempts: number | null;
  };
}

export interface ControllerHealth {
  address: string;
  connected: boolean;
  throttled: boolean;
  admin: boolean | null;
  /** Fixed phrase. Never a credential, username, or raw controller body. */
  lastError: string | null;
  cameras: CameraHealth[];
}

export interface PluginHealth {
  schemaVersion: typeof HEALTH_SCHEMA_VERSION;
  pluginVersion: string;
  generatedAt: string;
  readbackStaleAfterMs: number;
  controllers: ControllerHealth[];
}

export interface HealthCameraInput {
  id: string;
  name: string;
  intendedMotionEnabled: boolean | null;
  smartDetectPreferencesSaved: boolean;
  /** Smart Detection switch, or null when that switch is hidden or not loaded. */
  intendedSmartDetect: boolean | null;
  /** Active pre-disable snapshot, or null when this camera has nothing to restore. */
  smartDetectSnapshot: SmartDetectConfig | null;
  snapshot: CameraReadbackSnapshot | null;
}

export interface HealthControllerInput {
  address: string;
  connected: boolean;
  throttled: boolean;
  admin: boolean | null;
  lastError: string | null;
  cameras: HealthCameraInput[];
}

export function snapshotFromCamera(camera: ProtectCamera, fetchedAt: number, attempts: number): CameraReadbackSnapshot {
  const diagnostics = readMotionDiagnostics(camera);
  return snapshotFromDiagnostics(diagnostics, fetchedAt, attempts);
}

export function errorSnapshot(message: string, attempts: number): CameraReadbackSnapshot {
  return {
    fetchedAt: null,
    ok: false,
    error: message,
    attempts,
    createMotionEvents: null,
    motionSettingsKnown: false,
    motionSettings: null,
    smartDetect: null,
    smartDetectConfig: null,
  };
}

export function buildHealthReport(input: {
  pluginVersion: string;
  generatedAt: number;
  staleAfterMs?: number;
  controllers: HealthControllerInput[];
}): PluginHealth {
  const staleAfterMs = input.staleAfterMs ?? HEALTH_READBACK_STALE_MS;

  return {
    schemaVersion: HEALTH_SCHEMA_VERSION,
    pluginVersion: input.pluginVersion,
    generatedAt: new Date(input.generatedAt).toISOString(),
    readbackStaleAfterMs: staleAfterMs,
    controllers: input.controllers.map((controller) => ({
      address: controller.address,
      connected: controller.connected,
      throttled: controller.throttled,
      admin: controller.admin,
      lastError: controller.lastError,
      cameras: controller.cameras.map((camera) => interpretCameraHealth(camera, input.generatedAt, staleAfterMs)),
    })),
  };
}

export function interpretCameraHealth(
  camera: HealthCameraInput,
  now: number,
  staleAfterMs: number = HEALTH_READBACK_STALE_MS,
): CameraHealth {
  const snapshot = camera.snapshot;
  const base = emptyCameraHealth(camera);
  const smart = smartDetectFields(camera, snapshot);

  if (!snapshot) {
    return { ...base, ...smart };
  }

  if (!snapshot.ok) {
    return {
      ...base,
      ...smart,
      readback: {
        status: 'error',
        fetchedAt: null,
        error: snapshot.error ?? 'camera read failed',
        attempts: snapshot.attempts,
      },
    };
  }

  const populated = { ...thisCameraFromSnapshot(base, snapshot), ...smart };
  if (snapshot.createMotionEvents === null) {
    return {
      ...populated,
      drift: null,
      readback: {
        status: 'unknown',
        fetchedAt: snapshot.fetchedAt === null ? null : new Date(snapshot.fetchedAt).toISOString(),
        error: 'recordingSettings.enableMotionDetection was absent',
        attempts: snapshot.attempts,
      },
    };
  }

  const diagnostics: MotionDiagnostics = {
    createMotionEvents: snapshot.createMotionEvents,
    motionSettingsKnown: snapshot.motionSettingsKnown,
    motionSettings: snapshot.motionSettings,
    smartDetect: snapshot.smartDetect,
    smartDetectConfig: snapshot.smartDetectConfig,
  };
  const motionDisagrees = motionDrift(camera.intendedMotionEnabled, diagnostics);
  const smartDisagrees = smart.smartDetectDrift;
  const drift = motionDisagrees === null ? null : motionDisagrees || smartDisagrees === true;
  const age = snapshot.fetchedAt === null ? Number.POSITIVE_INFINITY : now - snapshot.fetchedAt;
  const stale = age > staleAfterMs;
  let status: HealthReadbackStatus = 'verified';
  if (stale) {
    status = 'stale';
  } else if (drift) {
    status = 'mismatch';
  }

  return {
    ...populated,
    drift,
    readback: {
      status,
      fetchedAt: snapshot.fetchedAt === null ? null : new Date(snapshot.fetchedAt).toISOString(),
      error: null,
      attempts: snapshot.attempts,
    },
  };
}

function thisCameraFromSnapshot(base: CameraHealth, snapshot: CameraReadbackSnapshot): CameraHealth {
  return {
    ...base,
    createMotionEvents: snapshot.createMotionEvents,
    smartDetectObjectTypes: snapshot.smartDetect?.objectTypes ?? null,
    smartDetectAudioTypes: snapshot.smartDetect?.audioTypes ?? null,
    smartDetectAutoTrackingObjectTypes: snapshot.smartDetect?.autoTrackingObjectTypes ?? null,
    motionSettingsKnown: snapshot.motionSettingsKnown,
    motionSettings: snapshot.motionSettings,
  };
}

function snapshotFromDiagnostics(
  diagnostics: MotionDiagnostics,
  fetchedAt: number,
  attempts: number,
): CameraReadbackSnapshot {
  return {
    fetchedAt,
    ok: true,
    error: null,
    attempts,
    createMotionEvents: diagnostics.createMotionEvents,
    motionSettingsKnown: diagnostics.motionSettingsKnown,
    motionSettings: diagnostics.motionSettings,
    smartDetect: diagnostics.smartDetect
      ? {
          objectTypes: [...diagnostics.smartDetect.objectTypes],
          audioTypes: [...diagnostics.smartDetect.audioTypes],
          autoTrackingObjectTypes: [...diagnostics.smartDetect.autoTrackingObjectTypes],
        }
      : null,
    smartDetectConfig: diagnostics.smartDetectConfig ? cloneSmartDetectConfig(diagnostics.smartDetectConfig) : null,
  };
}

function smartDetectFields(
  camera: HealthCameraInput,
  snapshot: CameraReadbackSnapshot | null,
): Pick<CameraHealth, 'smartDetectExpected' | 'smartDetectActual' | 'smartDetectDrift'> {
  const actual = snapshot?.ok ? snapshot.smartDetectConfig : null;
  const saved = camera.smartDetectSnapshot;
  const expected = expectedSmartDetect(camera.intendedSmartDetect, saved, actual);
  return {
    smartDetectExpected: toSmartDetectHealthState(expected),
    smartDetectActual: toSmartDetectHealthState(actual),
    smartDetectDrift: smartDetectDrift(camera.intendedSmartDetect, actual, saved),
  };
}

function expectedSmartDetect(
  intended: boolean | null,
  saved: SmartDetectConfig | null,
  actual: SmartDetectConfig | null,
): SmartDetectConfig | null {
  if (intended === null) {
    return null;
  }
  if (!intended) {
    if (saved && smartDetectConfigActive(saved)) {
      return disableSmartDetect(saved);
    }
    if (actual) {
      return disableSmartDetect(actual);
    }
    return null;
  }
  if (saved && smartDetectConfigActive(saved)) {
    return cloneSmartDetectConfig(saved);
  }
  return null;
}

export function toSmartDetectHealthState(config: SmartDetectConfig | null | undefined): SmartDetectHealthState | null {
  if (!config) {
    return null;
  }
  return {
    objectTypes: [...config.objectTypes],
    audioTypes: [...config.audioTypes],
    autoTrackingObjectTypes: [...config.autoTrackingObjectTypes],
    zones: toHealthZones(config.zones),
    secondLensZones: toHealthZones(config.secondLensZones),
  };
}

function toHealthZones(zones: SmartDetectZoneSnapshot[] | null): SmartDetectHealthZone[] | null {
  if (zones === null) {
    return null;
  }
  return zones.map((zone) => ({
    id: zone.id,
    name: zone.name,
    sensitivity: zone.sensitivity,
    objectTypes: [...zone.objectTypes],
    points: zone.points ? zone.points.map((point) => [...point]) : [],
  }));
}

function emptyCameraHealth(camera: HealthCameraInput): CameraHealth {
  return {
    id: camera.id,
    name: camera.name,
    intendedMotionEnabled: camera.intendedMotionEnabled,
    createMotionEvents: null,
    smartDetectObjectTypes: null,
    smartDetectAudioTypes: null,
    smartDetectAutoTrackingObjectTypes: null,
    motionSettingsKnown: null,
    motionSettings: null,
    smartDetectPreferencesSaved: camera.smartDetectPreferencesSaved,
    smartDetectExpected: null,
    smartDetectActual: null,
    smartDetectDrift: null,
    drift: null,
    readback: {
      status: 'unknown',
      fetchedAt: null,
      error: null,
      attempts: null,
    },
  };
}

export interface HealthFileCompat {
  reconnecting: boolean;
  consecutiveFailures: number;
  lastEventAt: string | null;
  lastBootstrapAt: string | null;
}

/**
 * On-disk document for home-monitor. `controllers[].cameras` stays a count because
 * home-monitor sums that field (`[.controllers[]?.cameras] | add`). Per-camera
 * schema details live on `cameraHealth`.
 */
export interface PersistedControllerHealth extends HealthFileCompat {
  address: string;
  connected: boolean;
  throttled: boolean;
  admin: boolean | null;
  lastError: string | null;
  cameras: number;
  cameraHealth: CameraHealth[];
}

export interface PersistedPluginHealth {
  schemaVersion: typeof HEALTH_SCHEMA_VERSION;
  pluginVersion: string;
  generatedAt: string;
  updatedAt: string;
  updatedAtEpoch: number;
  readbackStaleAfterMs: number;
  controllers: PersistedControllerHealth[];
}

export function toPersistedHealth(
  health: PluginHealth,
  now: number,
  compat: Record<string, Partial<HealthFileCompat>> = {},
): PersistedPluginHealth {
  return {
    schemaVersion: health.schemaVersion,
    pluginVersion: health.pluginVersion,
    generatedAt: health.generatedAt,
    updatedAt: new Date(now).toISOString(),
    updatedAtEpoch: Math.floor(now / 1000),
    readbackStaleAfterMs: health.readbackStaleAfterMs,
    controllers: health.controllers.map((controller) => {
      const extra = compat[controller.address] ?? {};
      return {
        address: controller.address,
        connected: controller.connected,
        throttled: controller.throttled,
        admin: controller.admin,
        lastError: controller.lastError,
        reconnecting: extra.reconnecting ?? false,
        consecutiveFailures: extra.consecutiveFailures ?? 0,
        cameras: controller.cameras.length,
        lastEventAt: extra.lastEventAt ?? null,
        lastBootstrapAt: extra.lastBootstrapAt ?? null,
        cameraHealth: controller.cameras,
      };
    }),
  };
}

/** Best-effort atomic write: temp file in the same directory, then rename. */
export function writeHealthFileAtomic(
  storagePath: string,
  document: PersistedPluginHealth,
  filename: string = HEALTH_FILENAME,
): void {
  const dest = join(storagePath, filename);
  const tmp = `${dest}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`);
  try {
    renameSync(tmp, dest);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}
