import type { MotionDiagnostics } from './api/motion-state.js';
import { motionDrift, readMotionDiagnostics } from './api/motion-state.js';
import type { ProtectCamera, SmartDetectPreferences } from './api/types.js';

/**
 * First health document published by this plugin.
 * Releases through 1.0.9 had no health payload, so 1.1.0 only adds fields.
 */
export const HEALTH_SCHEMA_VERSION = '1.1.0' as const;

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
  /**
   * True when the HomeKit switch and the last successful read disagree.
   * Null when either side is unknown. Stale reads still report drift from that old read.
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

  if (!snapshot) {
    return base;
  }

  if (!snapshot.ok) {
    return {
      ...base,
      readback: {
        status: 'error',
        fetchedAt: null,
        error: snapshot.error ?? 'camera read failed',
        attempts: snapshot.attempts,
      },
    };
  }

  const populated = thisCameraFromSnapshot(base, snapshot);
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
  };
  const drift = motionDrift(camera.intendedMotionEnabled, diagnostics);
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
  };
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
    drift: null,
    readback: {
      status: 'unknown',
      fetchedAt: null,
      error: null,
      attempts: null,
    },
  };
}
