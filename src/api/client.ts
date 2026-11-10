import type { Logging } from 'homebridge';
import { ProtectApi } from 'unifi-protect';

import { type CameraReadbackSnapshot, errorSnapshot, snapshotFromCamera } from '../health.js';
import type { SmartDetectSnapshotStore } from '../smart-detect-store.js';
import { ProtectApiError } from './errors.js';
import {
  MOTION_READBACK_DELAYS_MS,
  type MotionReadbackExpectation,
  motionReadbackMatches,
  planMotionWrite,
  readMotionDiagnostics,
} from './motion-state.js';
import {
  minimalSmartDetectPatch,
  planSmartDetectWrite,
  preferencesFromConfig,
  readSmartDetectConfig,
  type SmartDetectConfig,
  smartDetectConfigActive,
  type SmartDetectPatch,
  type SmartDetectWritePlan,
} from './smart-detect.js';
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
  /** Fired after a settings readback so the platform can persist health. */
  onHealthChange?: () => void;
  /** Durable pre-disable smart-detection snapshots. Optional in tests. */
  smartDetectStore?: SmartDetectSnapshotStore;
  /** Used with the snapshot store. `connect` sets this from the controller address. */
  controllerAddress?: string;
}

export class ProtectClient {
  private api: ProtectApiLike;
  private messageHandlers: MessageHandler[] = [];
  private connected = false;
  private readonly snapshots = new Map<string, CameraReadbackSnapshot>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly onHealthChange?: () => void;
  private readonly smartDetectStore?: SmartDetectSnapshotStore;
  private controllerAddress: string | undefined;

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
    this.onHealthChange = options.onHealthChange;
    this.smartDetectStore = options.smartDetectStore;
    this.controllerAddress = options.controllerAddress;
  }

  private emitHealthChange(): void {
    try {
      this.onHealthChange?.();
    } catch {
      // Monitoring must never break a settings write.
    }
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
      this.controllerAddress = address;
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

  public updateCameraMotionDetection(camera: ProtectCamera, enabled: boolean): Promise<UpdateOutcome> {
    return this.updateCameraSettings(camera, { motion: enabled });
  }

  public updateCameraSmartDetection(
    camera: ProtectCamera,
    enabled: boolean,
    smartDetectConfig: SmartDetectConfig | null = null,
  ): Promise<UpdateOutcome> {
    return this.updateCameraSettings(camera, { smartDetect: enabled, smartDetectConfig });
  }

  /**
   * Applies LED and/or motion settings in one controller request, then reads the camera
   * back. A truthy PATCH is not success: Protect can accept `motionSettings` on a camera
   * and leave `recordingSettings.enableMotionDetection` unchanged.
   */
  public updateCameraSettings(camera: ProtectCamera, settings: CameraSettingsUpdate): Promise<UpdateOutcome> {
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
  private updateDevice(camera: ProtectCamera, settings: CameraSettingsUpdate): Promise<UpdateOutcome> {
    const run = this.writeQueue.then(() => this.performUpdate(camera, settings));
    // Keep the chain alive regardless of individual outcomes.
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async performUpdate(camera: ProtectCamera, settings: CameraSettingsUpdate): Promise<UpdateOutcome> {
    const wantsLed = settings.led !== undefined;
    const wantsMotion = settings.motion !== undefined;
    const wantsSmart = settings.smartDetect !== undefined;
    const changes: string[] = [];
    if (wantsLed) {
      changes.push(`LED ${settings.led ? 'enabled' : 'disabled'}`);
    }
    if (wantsMotion) {
      changes.push(`motion detection ${settings.motion ? 'enabled' : 'disabled'}`);
    }
    if (wantsSmart) {
      changes.push(`smart detection ${settings.smartDetect ? 'restored' : 'disabled'}`);
    }

    const keptConfig = this.resolveSavedSmartDetect(camera, settings);
    const finish = (
      result: UpdateResult,
      smartDetectResult: UpdateResult | null = wantsSmart ? result : null,
      config: SmartDetectConfig | null = keptConfig,
      confirmed: ProtectCamera | null = null,
    ): UpdateOutcome => ({
      result,
      smartDetectResult,
      smartDetectPreferences: preferencesFromConfig(config),
      smartDetectConfig: config,
      camera: confirmed,
    });

    if (!wantsLed && !wantsMotion && !wantsSmart) {
      return finish('ok', null);
    }
    if (!this.connected) {
      this.log.error(`Cannot update ${camera.name}: not connected`);
      return finish('failed');
    }
    if (this.api.isThrottled) {
      return finish('throttled');
    }
    if (!this.api.isAdminUser) {
      return finish('unauthorized');
    }

    let liveCamera: ProtectCamera | null = null;
    if (wantsSmart) {
      liveCamera = await this.readCameraBeforeChange(camera, true);
    }

    let smartPlan: SmartDetectWritePlan | null = null;
    let smartSkipped = false;
    if (wantsSmart) {
      try {
        smartPlan = planSmartDetectWrite(settings.smartDetect === true, liveCamera, keptConfig);
        if (settings.smartDetect === false) {
          // Save the active snapshot before the PATCH so a crash can still restore it.
          this.persistSmartDetectSnapshot(camera, smartPlan.config);
        }
        if (!liveCamera) {
          this.log.warn(
            `Could not read ${camera.name} before changing smart detection. Smart detection was left unchanged.`,
          );
          smartSkipped = true;
        } else if (smartPlan.nothingToRestore) {
          this.log.warn(
            `No saved smart detection configuration for ${camera.name}. ` +
              `The Smart Detection switch was left off and Protect was not given a default zone.`,
          );
          smartSkipped = true;
        }
      } catch (error) {
        this.log.error(
          `Smart detection update for ${camera.name} could not be prepared (${errorText(error)}). ` +
            `Other camera settings in this request will still be changed.`,
        );
        smartSkipped = true;
        smartPlan = null;
      }
    }

    const config = smartPlan?.config ?? keptConfig;
    const controlsRequested = wantsLed || wantsMotion;
    if (smartSkipped && !controlsRequested) {
      return finish('failed', 'failed', config);
    }

    const payload = this.buildPayload(settings, smartSkipped ? null : smartPlan);
    if (!payloadHasChanges(payload)) {
      const already =
        !wantsSmart ||
        !smartPlan?.expectedConfig ||
        (liveCamera !== null &&
          motionReadbackMatches(liveCamera, { smartDetectConfig: smartPlan.expectedConfig, smartDetect: null }));
      const smartResult: UpdateResult | null = wantsSmart ? (already ? 'ok' : 'mismatch') : null;
      return finish(controlsRequested ? 'ok' : (smartResult ?? 'ok'), smartResult, config);
    }
    const expected: MotionReadbackExpectation = {
      smartDetect: null,
      smartDetectConfig: smartSkipped ? null : (smartPlan?.expectedConfig ?? null),
    };
    if (wantsLed) {
      expected.led = settings.led;
    }
    if (wantsMotion) {
      expected.createMotionEvents = settings.motion;
    }

    const done = (
      result: UpdateResult,
      smartDetectResult: UpdateResult | null,
      confirmed: ProtectCamera | null = null,
    ): UpdateOutcome => ({
      result,
      smartDetectResult,
      smartDetectPreferences: preferencesFromConfig(config),
      smartDetectConfig: config,
      camera: confirmed,
    });

    try {
      let wrote = await this.writeDevice(camera, payload);
      let smartFailed = smartSkipped;
      if (!wrote.ok && wrote.result === 'failed' && payloadHasSmartDetect(payload)) {
        const narrowed = narrowPayload(payload);
        if (narrowed) {
          this.log.warn(
            `Smart detection update for ${camera.name} was rejected (${wrote.error}). ` +
              `Retrying with the zone fields Protect accepts.`,
          );
          wrote = await this.writeDevice(camera, narrowed);
        }
      }
      if (!wrote.ok && wrote.result === 'failed' && payloadHasSmartDetect(payload) && controlsRequested) {
        this.log.error(
          `Smart detection update failed for ${camera.name} (${wrote.error}). ` +
            `Motion detection and LED will still be updated.`,
        );
        wrote = await this.writeDevice(camera, withoutSmartDetect(payload));
        smartFailed = true;
        expected.smartDetectConfig = null;
      }
      if (!wrote.ok) {
        if (wrote.result === 'failed') {
          this.log.error(`Error updating ${camera.name}: ${wrote.error}`);
        }
        await this.refreshCamera(camera);
        return done(wrote.result, wantsSmart ? wrote.result : null);
      }

      const readback = await this.readUntilMatch(camera, expected);
      if (readback.camera) {
        this.snapshots.set(camera.id, snapshotFromCamera(readback.camera, this.now(), readback.attempts));
        const controlsMatch =
          !controlsRequested ||
          motionReadbackMatches(readback.camera, { ...expected, smartDetect: null, smartDetectConfig: null });
        const smartAsserted = Boolean(expected.smartDetectConfig);
        const smartMatch =
          !smartAsserted ||
          motionReadbackMatches(readback.camera, {
            smartDetect: null,
            smartDetectConfig: expected.smartDetectConfig ?? null,
          });
        const controlResult: UpdateResult = controlsMatch ? 'ok' : 'mismatch';
        let smartResult: UpdateResult | null = wantsSmart ? 'ok' : null;
        if (smartFailed) {
          smartResult = 'failed';
        } else if (wantsSmart && !smartMatch) {
          smartResult = 'mismatch';
        }
        if (controlsRequested && !controlsMatch) {
          this.logReadbackMismatch(camera, expected, readback.camera);
        } else if (wantsSmart && smartResult !== 'ok') {
          this.log.error(
            `Smart detection for ${camera.name} did not match the camera readback. ` +
              `The saved snapshot was kept. The PATCH response was not the source of success.`,
          );
        }
        if ((!controlsRequested || controlsMatch) && (!wantsSmart || smartResult === 'ok')) {
          if (settings.smartDetect === true && readback.camera) {
            const confirmed = readSmartDetectConfig(readback.camera);
            if (smartDetectConfigActive(confirmed)) {
              this.persistSmartDetectSnapshot(camera, confirmed);
            }
          }
          this.log.info(`${changes.join(', ')} for ${camera.name} (confirmed by camera readback)`);
        }
        const result = controlsRequested ? controlResult : (smartResult ?? 'failed');
        return done(result, smartResult, readback.camera);
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
      return done('failed', wantsSmart ? 'failed' : null);
    } finally {
      this.emitHealthChange();
    }
  }

  private resolveSavedSmartDetect(
    camera: ProtectCamera,
    settings: { smartDetectConfig?: SmartDetectConfig | null },
  ): SmartDetectConfig | null {
    if (this.smartDetectStore && this.controllerAddress) {
      const stored = this.smartDetectStore.get(this.controllerAddress, camera.id);
      if (stored) {
        return stored;
      }
    }
    if (settings.smartDetectConfig && smartDetectConfigActive(settings.smartDetectConfig)) {
      return settings.smartDetectConfig;
    }
    return null;
  }

  private buildPayload(settings: CameraSettingsUpdate, smartPlan: SmartDetectWritePlan | null): CameraWritePayload {
    const payload: CameraWritePayload = {};
    if (settings.led !== undefined) {
      payload.ledSettings = { isEnabled: settings.led };
    }
    if (settings.motion !== undefined) {
      payload.recordingSettings = planMotionWrite(settings.motion).payload.recordingSettings;
    }
    applySmartPatch(payload, smartPlan?.patch);
    return payload;
  }

  private persistSmartDetectSnapshot(camera: ProtectCamera, config: SmartDetectConfig | null): void {
    if (!this.smartDetectStore || !this.controllerAddress) {
      return;
    }
    try {
      this.smartDetectStore.remember(this.controllerAddress, camera.id, camera.name, config);
    } catch (error) {
      this.log.error(`Could not save the smart detection snapshot for ${camera.name}: ${errorText(error)}`);
    }
  }

  private async writeDevice(
    camera: ProtectCamera,
    payload: CameraWritePayload,
  ): Promise<{ ok: true } | { ok: false; result: UpdateResult; error: string }> {
    try {
      const result = await this.api.updateDevice(camera as never, payload as never);
      if (!result) {
        return {
          ok: false,
          result: this.api.isThrottled ? 'throttled' : 'failed',
          error: 'controller rejected the update',
        };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, result: 'failed', error: errorText(error) };
    }
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

  private async readCameraBeforeChange(
    camera: ProtectCamera,
    includesSmartDetect: boolean,
  ): Promise<ProtectCamera | null> {
    try {
      const record = await this.fetchCameraRecord(camera);
      if (record) {
        return record;
      }
      if (!includesSmartDetect) {
        this.log.warn(`Could not read ${camera.name} before changing motion detection.`);
      }
      return null;
    } catch (error) {
      if (!includesSmartDetect) {
        this.log.warn(`Could not read ${camera.name} before changing motion detection (${errorText(error)}).`);
      }
      return null;
    }
  }

  private logReadbackMismatch(camera: ProtectCamera, expected: MotionReadbackExpectation, actual: ProtectCamera): void {
    const diagnostics = readMotionDiagnostics(actual);
    const actualTypes = describeSmartDetect(diagnostics.smartDetectConfig);
    const expectedTypes = expected.smartDetectConfig
      ? describeSmartDetect(expected.smartDetectConfig)
      : expected.smartDetect
        ? `object=${expected.smartDetect.objectTypes.join('|') || 'none'}`
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

interface CameraSettingsUpdate {
  led?: boolean;
  motion?: boolean;
  smartDetect?: boolean;
  smartDetectConfig?: SmartDetectConfig | null;
}

interface CameraWritePayload {
  ledSettings?: LedSettings;
  recordingSettings?: { enableMotionDetection: boolean };
  smartDetectSettings?: SmartDetectPreferences;
  smartDetectZones?: Record<string, unknown>[];
  secondLensSmartDetectZones?: Record<string, unknown>[];
}

function applySmartPatch(payload: CameraWritePayload, patch: SmartDetectPatch | undefined): void {
  if (!patch) {
    return;
  }
  if (patch.smartDetectSettings) {
    payload.smartDetectSettings = patch.smartDetectSettings;
  }
  if (patch.smartDetectZones) {
    payload.smartDetectZones = patch.smartDetectZones;
  }
  if (patch.secondLensSmartDetectZones) {
    payload.secondLensSmartDetectZones = patch.secondLensSmartDetectZones;
  }
}

function narrowPayload(payload: CameraWritePayload): CameraWritePayload | null {
  if (!payloadHasSmartDetect(payload)) {
    return null;
  }
  const narrowed: CameraWritePayload = {
    ...(payload.ledSettings ? { ledSettings: payload.ledSettings } : {}),
    ...(payload.recordingSettings ? { recordingSettings: payload.recordingSettings } : {}),
  };
  applySmartPatch(
    narrowed,
    minimalSmartDetectPatch({
      smartDetectSettings: payload.smartDetectSettings,
      smartDetectZones: payload.smartDetectZones,
      secondLensSmartDetectZones: payload.secondLensSmartDetectZones,
    }),
  );
  if (JSON.stringify(narrowed) === JSON.stringify(payload)) {
    return null;
  }
  return narrowed;
}

function payloadHasChanges(payload: CameraWritePayload): boolean {
  return Boolean(
    payload.ledSettings ||
    payload.recordingSettings ||
    payload.smartDetectSettings ||
    payload.smartDetectZones ||
    payload.secondLensSmartDetectZones,
  );
}

function payloadHasSmartDetect(payload: CameraWritePayload): boolean {
  return Boolean(payload.smartDetectSettings || payload.smartDetectZones || payload.secondLensSmartDetectZones);
}

function withoutSmartDetect(payload: CameraWritePayload): CameraWritePayload {
  return {
    ...(payload.ledSettings ? { ledSettings: payload.ledSettings } : {}),
    ...(payload.recordingSettings ? { recordingSettings: payload.recordingSettings } : {}),
  };
}

function describeSmartDetect(config: SmartDetectConfig | null | undefined): string {
  if (!config) {
    return 'unavailable';
  }
  const zones = (config.zones ?? [])
    .map((zone) => `${zone.name || 'zone'}:${zone.sensitivity ?? '?'}:${zone.objectTypes.join('+') || 'none'}`)
    .join(',');
  return `object=${config.objectTypes.join('|') || 'none'}, zones=${zones || 'none'}`;
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
