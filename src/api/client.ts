import type { Logging } from 'homebridge';
import { ProtectApi } from 'unifi-protect';

import { type CameraReadbackSnapshot, errorSnapshot, snapshotFromCamera } from '../health.js';
import { ProtectApiError } from './errors.js';
import {
  MOTION_READBACK_DELAYS_MS,
  type MotionReadbackExpectation,
  motionReadbackMatches,
  planMotionWrite,
  readMotionDiagnostics,
} from './motion-state.js';
import type {
  LedSettings,
  ProtectBootstrap,
  ProtectCamera,
  ProtectEventPacket,
  SmartDetectPreferences,
  UpdateOutcome,
  UpdateResult,
} from './types.js';

export type MessageHandler = (packet: ProtectEventPacket) => void;

interface ProtectResponse {
  statusCode?: number;
  body?: { json: () => Promise<unknown> };
}

interface ProtectApiLike {
  login: (address: string, username: string, password: string) => Promise<boolean>;
  getBootstrap: () => Promise<boolean>;
  readonly bootstrap: unknown;
  readonly isThrottled: boolean;
  readonly isAdminUser: boolean;
  updateDevice: (device: unknown, payload: unknown) => Promise<unknown>;
  getApiEndpoint: (endpoint: 'camera') => string;
  retrieve: (url: string, options?: { method?: string }) => Promise<ProtectResponse | null>;
  on: (event: string, handler: (packet: unknown) => void) => void;
  reset: () => void;
}

export interface ProtectClientOptions {
  /** Test hook. Production waits with a timer. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class ProtectClient {
  private api: ProtectApiLike;
  private messageHandlers: MessageHandler[] = [];
  private connected = false;
  private readonly snapshots = new Map<string, CameraReadbackSnapshot>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  // Serializes device writes so a burst (e.g. a HomeKit scene toggling every
  // camera at once) never fans out into dozens of concurrent API calls, which
  // would trip the controller's error throttling.
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly log: Logging,
    options: ProtectClientOptions = {},
  ) {
    this.api = new ProtectApi() as unknown as ProtectApiLike;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  /** True while the underlying API is pausing calls after repeated errors. */
  public get isThrottled(): boolean {
    return this.api.isThrottled;
  }

  /** True if the logged-in account can modify device settings. */
  public get isAdminUser(): boolean {
    return this.api.isAdminUser;
  }

  public async connect(address: string, username: string, password: string): Promise<boolean> {
    try {
      this.log.info(`Connecting to UniFi Protect controller at ${address}...`);

      const loggedIn = await this.api.login(address, username, password);

      if (!loggedIn) {
        throw new ProtectApiError(`Failed to login to controller at ${address}`, 401);
      }

      this.log.info(`Successfully logged in to ${address}`);

      const bootstrapSuccess = await this.api.getBootstrap();
      if (!bootstrapSuccess) {
        throw new ProtectApiError(`Failed to get bootstrap from ${address}`);
      }

      this.connected = true;

      if (!this.api.isAdminUser) {
        this.log.warn(
          `The account "${username}" is not an admin on ${address}. ` +
            `UniFi Protect requires an admin/full-management account to change LED and motion ` +
            `detection settings, so every such change will fail. Grant this account admin ` +
            `privileges (or use one that has them) to control cameras from HomeKit.`,
        );
      }

      this.seedSnapshots(this.cameras);

      // Set up event listener
      this.api.on('message', (packet: unknown) => {
        this.handleMessage(packet as ProtectEventPacket);
      });

      return true;
    } catch (error) {
      if (error instanceof ProtectApiError) {
        throw error;
      }
      throw new ProtectApiError(
        `Error connecting to ${address}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  public get bootstrap(): ProtectBootstrap | null {
    if (!this.connected || !this.api.bootstrap) {
      return null;
    }
    return this.api.bootstrap as unknown as ProtectBootstrap;
  }

  public get cameras(): ProtectCamera[] {
    return this.bootstrap?.cameras ?? [];
  }

  public get isConnected(): boolean {
    return this.connected;
  }

  public getCameraSnapshot(cameraId: string): CameraReadbackSnapshot | null {
    return this.snapshots.get(cameraId) ?? null;
  }

  /** Records a bootstrap (or other full camera list) as a successful read. */
  public seedSnapshots(cameras: ProtectCamera[], fetchedAt = this.now()): void {
    for (const camera of cameras) {
      this.snapshots.set(camera.id, snapshotFromCamera(camera, fetchedAt, 1));
    }
  }

  public onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  public updateCameraLed(camera: ProtectCamera, enabled: boolean): Promise<UpdateOutcome> {
    return this.updateCameraSettings(camera, { led: enabled });
  }

  public updateCameraMotionDetection(
    camera: ProtectCamera,
    enabled: boolean,
    smartDetectPreferences: SmartDetectPreferences | null = null,
  ): Promise<UpdateOutcome> {
    return this.updateCameraSettings(camera, { motion: enabled, smartDetectPreferences });
  }

  /**
   * Applies LED and/or motion settings in one controller request, then reads the camera
   * back. A truthy PATCH is not success: Protect can accept `motionSettings` on a camera
   * and leave `recordingSettings.enableMotionDetection` unchanged.
   */
  public updateCameraSettings(
    camera: ProtectCamera,
    settings: { led?: boolean; motion?: boolean; smartDetectPreferences?: SmartDetectPreferences | null },
  ): Promise<UpdateOutcome> {
    return this.updateDevice(camera, settings);
  }

  /**
   * Read-only refresh for health checks. Replaces the last snapshot, including on failure,
   * so an error is not reported as the previous successful state.
   */
  public async refreshCamera(camera: ProtectCamera): Promise<CameraReadbackSnapshot> {
    try {
      const record = await this.fetchCameraRecord(camera);
      if (!record) {
        const snapshot = errorSnapshot(`No camera record returned for ${camera.name}`, 1);
        this.snapshots.set(camera.id, snapshot);
        return snapshot;
      }
      const snapshot = snapshotFromCamera(record, this.now(), 1);
      this.snapshots.set(camera.id, snapshot);
      return snapshot;
    } catch (error) {
      const snapshot = errorSnapshot(errorText(error), 1);
      this.snapshots.set(camera.id, snapshot);
      return snapshot;
    }
  }

  /**
   * Applies a settings payload to a camera, serialized behind {@link writeQueue}.
   *
   * Short-circuits (without hitting the network) when disconnected, when the API is
   * already throttling, or when the account lacks admin rights — so a burst of writes
   * against a throttled/unauthorized controller no longer piles up more failing calls.
   */
  private updateDevice(
    camera: ProtectCamera,
    settings: { led?: boolean; motion?: boolean; smartDetectPreferences?: SmartDetectPreferences | null },
  ): Promise<UpdateOutcome> {
    const run = this.writeQueue.then(() => this.performUpdate(camera, settings));
    // Keep the chain alive regardless of individual outcomes.
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async performUpdate(
    camera: ProtectCamera,
    settings: { led?: boolean; motion?: boolean; smartDetectPreferences?: SmartDetectPreferences | null },
  ): Promise<UpdateOutcome> {
    const changes: string[] = [];
    if (settings.led !== undefined) {
      changes.push(`LED ${settings.led ? 'enabled' : 'disabled'}`);
    }
    if (settings.motion !== undefined) {
      changes.push(`motion detection ${settings.motion ? 'enabled' : 'disabled'}`);
    }
    if (changes.length === 0) {
      return { result: 'ok', smartDetectPreferences: settings.smartDetectPreferences ?? null };
    }

    const keptPreferences = settings.smartDetectPreferences ?? null;
    if (!this.connected) {
      this.log.error(`Cannot update ${camera.name}: not connected`);
      return { result: 'failed', smartDetectPreferences: keptPreferences };
    }
    if (this.api.isThrottled) {
      return { result: 'throttled', smartDetectPreferences: keptPreferences };
    }
    if (!this.api.isAdminUser) {
      return { result: 'unauthorized', smartDetectPreferences: keptPreferences };
    }

    let liveCamera: ProtectCamera | null = null;
    if (settings.motion !== undefined) {
      liveCamera = await this.readCameraBeforeMotionChange(camera);
    }

    const motionPlan =
      settings.motion === undefined ? null : planMotionWrite(settings.motion, liveCamera, keptPreferences);
    const preferences = motionPlan?.preferences ?? keptPreferences;
    const payload: {
      ledSettings?: LedSettings;
      recordingSettings?: { enableMotionDetection: boolean };
      smartDetectSettings?: Partial<SmartDetectPreferences>;
    } = {};
    if (settings.led !== undefined) {
      payload.ledSettings = { isEnabled: settings.led };
    }
    if (motionPlan) {
      payload.recordingSettings = motionPlan.payload.recordingSettings;
      if (motionPlan.payload.smartDetectSettings) {
        payload.smartDetectSettings = motionPlan.payload.smartDetectSettings;
      }
    }

    const expected: MotionReadbackExpectation = {
      smartDetect: motionPlan?.expectedSmartDetect ?? null,
    };
    if (settings.led !== undefined) {
      expected.led = settings.led;
    }
    if (settings.motion !== undefined) {
      expected.createMotionEvents = settings.motion;
    }

    try {
      const result = await this.api.updateDevice(camera as never, payload as never);
      if (!result) {
        const resultName: UpdateResult = this.api.isThrottled ? 'throttled' : 'failed';
        await this.refreshCamera(camera);
        return { result: resultName, smartDetectPreferences: preferences };
      }
    } catch (error) {
      this.log.error(`Error updating ${camera.name}:`, errorText(error));
      await this.refreshCamera(camera);
      return { result: 'failed', smartDetectPreferences: preferences };
    }

    const readback = await this.readUntilMatch(camera, expected);
    if (readback.camera) {
      this.snapshots.set(camera.id, snapshotFromCamera(readback.camera, this.now(), readback.attempts));
      const controlsMatch = motionReadbackMatches(readback.camera, { ...expected, smartDetect: null });
      const smartMatch =
        !expected.smartDetect || motionReadbackMatches(readback.camera, { smartDetect: expected.smartDetect });
      if (controlsMatch && smartMatch) {
        this.log.info(`${changes.join(', ')} for ${camera.name} (confirmed by camera readback)`);
        return { result: 'ok', smartDetectPreferences: preferences };
      }
      if (controlsMatch && !smartMatch) {
        this.log.error(
          `Create Motion Events for ${camera.name} matched the camera readback, but smart detection ` +
            `types did not. Saved preferences were kept. The PATCH response was not the source of success.`,
        );
        return { result: 'ok', smartDetectPreferences: preferences };
      }
      this.logReadbackMismatch(camera, expected, readback.camera);
      return { result: 'mismatch', smartDetectPreferences: preferences };
    }

    this.snapshots.set(
      camera.id,
      errorSnapshot(readback.error ?? `Unable to read ${camera.name} after update`, readback.attempts),
    );
    this.log.error(
      `Unable to confirm settings for ${camera.name}: camera readback failed` +
        (readback.error ? ` (${readback.error})` : '') +
        `. The PATCH response was not treated as success.`,
    );
    return { result: 'failed', smartDetectPreferences: preferences };
  }

  public disconnect(): void {
    if (this.connected) {
      this.api.reset();
      this.connected = false;
      this.messageHandlers = [];
    }
  }

  private async readUntilMatch(
    camera: ProtectCamera,
    expected: MotionReadbackExpectation,
  ): Promise<{ matched: boolean; camera: ProtectCamera | null; attempts: number; error: string | null }> {
    let lastCamera: ProtectCamera | null = null;
    let error: string | null = null;

    for (let index = 0; index < MOTION_READBACK_DELAYS_MS.length; index += 1) {
      const delay = MOTION_READBACK_DELAYS_MS[index] ?? 0;
      if (delay > 0) {
        await this.sleep(delay);
      }
      try {
        const record = await this.fetchCameraRecord(camera);
        if (record) {
          lastCamera = record;
          error = null;
          if (motionReadbackMatches(record, expected)) {
            return { matched: true, camera: record, attempts: index + 1, error: null };
          }
        } else {
          error = `No camera record returned for ${camera.name}`;
        }
      } catch (caught) {
        error = errorText(caught);
      }
    }

    return {
      matched: false,
      camera: lastCamera,
      attempts: MOTION_READBACK_DELAYS_MS.length,
      error,
    };
  }

  private async fetchCameraRecord(camera: ProtectCamera): Promise<ProtectCamera | null> {
    const endpoint = this.api.getApiEndpoint('camera');
    const response = await this.api.retrieve(`${endpoint}/${encodeURIComponent(camera.id)}`, { method: 'GET' });
    if (!response) {
      return null;
    }
    if (response.statusCode !== undefined && (response.statusCode < 200 || response.statusCode >= 300)) {
      return null;
    }
    if (!response.body?.json) {
      return null;
    }
    const body = await response.body.json();
    if (!isCameraRecord(body) || body.id !== camera.id) {
      return null;
    }
    return body;
  }

  private async readCameraBeforeMotionChange(camera: ProtectCamera): Promise<ProtectCamera | null> {
    try {
      const record = await this.fetchCameraRecord(camera);
      if (record) {
        return record;
      }
      this.log.warn(
        `Could not read ${camera.name} before changing motion detection. ` +
          `Smart detection types will be left unchanged.`,
      );
      return null;
    } catch (error) {
      this.log.warn(
        `Could not read ${camera.name} before changing motion detection (${errorText(error)}). ` +
          `Smart detection types will be left unchanged.`,
      );
      return null;
    }
  }

  private logReadbackMismatch(camera: ProtectCamera, expected: MotionReadbackExpectation, actual: ProtectCamera): void {
    const diagnostics = readMotionDiagnostics(actual);
    const actualTypes = diagnostics.smartDetect
      ? `object=${diagnostics.smartDetect.objectTypes.join('|') || 'none'}, ` +
        `audio=${diagnostics.smartDetect.audioTypes.join('|') || 'none'}`
      : 'unavailable';
    const expectedTypes = expected.smartDetect
      ? `object=${expected.smartDetect.objectTypes.join('|') || 'none'}, ` +
        `audio=${expected.smartDetect.audioTypes.join('|') || 'none'}`
      : 'not asserted';

    this.log.error(
      `Readback mismatch for ${camera.name}: requested Create Motion Events ` +
        `${String(expected.createMotionEvents)}, controller reports ` +
        `${String(diagnostics.createMotionEvents)}. Smart detections expected ${expectedTypes}; ` +
        `controller has ${actualTypes}. motionSettings=${JSON.stringify(diagnostics.motionSettings)}. ` +
        `The PATCH response was not treated as success.`,
    );
  }

  private handleMessage(packet: ProtectEventPacket): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(packet);
      } catch (error) {
        this.log.error('Error in message handler:', error);
      }
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function isCameraRecord(value: unknown): value is ProtectCamera {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return typeof (value as ProtectCamera).id === 'string' && typeof (value as ProtectCamera).name === 'string';
}
