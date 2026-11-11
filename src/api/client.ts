import type { Logging } from 'homebridge';
import { ProtectApi } from 'unifi-protect';

import {
  type CameraReadbackSnapshot,
  errorSnapshot,
  HEALTH_SESSION_LOST_ERROR,
  snapshotFromCamera,
} from '../health.js';
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
  addedByController,
  enforcedTypesAbsent,
  listSmartDetectEnforcedTypes,
  minimalSmartDetectPatch,
  novelResidualTypes,
  patchForResidualLists,
  planSmartDetectWrite,
  preferencesFromConfig,
  readSmartDetectConfig,
  type SmartDetectConfig,
  smartDetectConfigActive,
  smartDetectConfigsEqual,
  type SmartDetectEnforcedType,
  type SmartDetectPatch,
  type SmartDetectWritePlan,
  typesStillOwned,
  withoutRefilledTypes,
  withoutUnsavedSmartDetectTypes,
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

/** How often a live client checks for a dropped bootstrap or events websocket. */
export const SESSION_WATCHDOG_BASE_MS = 3 * 60 * 1000;

/** Longest delay between session recovery attempts after repeated failures. */
export const SESSION_WATCHDOG_MAX_MS = 15 * 60 * 1000;

/**
 * A dropped events websocket stays "connected" until it has been down this long.
 * A missing bootstrap is reported immediately.
 */
export const EVENTS_SOCKET_GRACE_MS = 30_000;

/** Base delay before another login after a failed refresh. Doubles with each failure. */
const RECOVERY_FAILURE_FLOOR_MS = 5_000;

/** One settings update, including smart-detection fallbacks, may refresh the session once. */
const UPDATE_RECOVERY_BUDGET = 1;

/** WebSocket.OPEN. The unifi-protect events socket is private and only present while connected. */
const WEBSOCKET_OPEN = 1;

interface SessionRecoveryBudget {
  remaining: number;
}

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
  // would trip the controller's error throttling. The first write in the burst
  // refreshes a lost session; the rest then use that restored login.
  private writeQueue: Promise<unknown> = Promise.resolve();

  /** One shared refresh so overlapping reads, writes, and the watchdog log in once. */
  private recoveryInFlight: Promise<boolean> | null = null;
  private recoveryFailures = 0;
  private lastRecoveryAttemptAt: number | null = null;
  private lastRecoverySucceeded = false;
  private sessionRecoveredAt: number | null = null;
  /** True after the current bootstrap has been checked for admin rights. */
  private adminConfirmed = false;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogDelayMs: number = SESSION_WATCHDOG_BASE_MS;
  /** Set by disconnect so an in-flight bootstrap cannot reopen the socket or the watchdog. */
  private stopped = false;
  /** When the events socket was first observed down, while the bootstrap was still present. */
  private eventsDownSince: number | null = null;

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
      this.adminConfirmed = true;
      this.recoveryFailures = 0;
      this.lastRecoverySucceeded = true;
      this.startWatchdog();

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

  /**
   * True when this login still has a bootstrap. A brief events-socket drop stays
   * live until {@link EVENTS_SOCKET_GRACE_MS}. Logout clears the bootstrap and is
   * not live immediately. A logged-in non-admin still counts.
   */
  public get hasLiveSession(): boolean {
    if (!this.connected || !this.hasBootstrap()) {
      this.eventsDownSince = null;
      return false;
    }
    return this.eventsSocketTolerated();
  }

  /** True after a successful login whose bootstrap or events websocket later disappeared. */
  public get isReconnecting(): boolean {
    return this.connected && !this.hasLiveSession;
  }

  /** Fixed health phrase, or null while the session is up or login never succeeded. */
  public get sessionLossError(): string | null {
    return this.isReconnecting ? HEALTH_SESSION_LOST_ERROR : null;
  }

  /** Failed bootstrap refreshes since the last successful one. */
  public get consecutiveRecoveryFailures(): number {
    return this.recoveryFailures;
  }

  /** Timestamp of the last successful session refresh, excluding the initial connect. */
  public get lastSessionRecoveryAt(): number | null {
    return this.sessionRecoveredAt;
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
  public async refreshCamera(
    camera: ProtectCamera,
    budget: SessionRecoveryBudget = { remaining: 1 },
  ): Promise<CameraReadbackSnapshot> {
    try {
      const record = await this.fetchCameraRecord(camera, budget);
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
   * Short-circuits (without hitting the network) when disconnected or when the API is
   * already throttling, so a burst of writes against a throttled controller no longer
   * piles up more failing calls. A missing bootstrap or a logout (admin cleared) is
   * refreshed once before the write; a non-admin result is reported only after that
   * fresh bootstrap still lacks admin rights.
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
    const budget: SessionRecoveryBudget = { remaining: UPDATE_RECOVERY_BUDGET };
    const session = await this.ensureWritableSession(budget);
    if (session === 'unauthorized') {
      return finish('unauthorized');
    }
    if (session !== 'ok') {
      this.log.error(`Cannot update ${camera.name}: the UniFi Protect session is unavailable. Recovery will continue.`);
      return finish('failed');
    }

    let liveCamera: ProtectCamera | null = null;
    if (wantsSmart) {
      liveCamera = await this.readCameraBeforeChange(camera, true, budget);
    }

    let smartPlan: SmartDetectWritePlan | null = null;
    let smartSkipped = false;
    if (wantsSmart) {
      try {
        smartPlan = planSmartDetectWrite(
          settings.smartDetect === true,
          liveCamera,
          keptConfig,
          this.enforcedTypes(camera),
        );
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

    let config = smartPlan?.config ?? keptConfig;
    const controlsRequested = wantsLed || wantsMotion;
    if (smartSkipped && !controlsRequested) {
      return finish('failed', 'failed', config);
    }

    const expected: MotionReadbackExpectation = {
      smartDetect: null,
      smartDetectConfig: smartSkipped ? null : (smartPlan?.expectedConfig ?? null),
      smartDetectBaseline: smartSkipped ? null : (smartPlan?.config ?? null),
      smartDetectEnabling: settings.smartDetect === true,
    };
    if (wantsLed) {
      expected.led = settings.led;
    }
    if (wantsMotion) {
      expected.createMotionEvents = settings.motion;
    }

    const payload = this.buildPayload(settings, smartSkipped ? null : smartPlan);
    if (!payloadHasChanges(payload)) {
      const already =
        !wantsSmart ||
        !expected.smartDetectConfig ||
        (liveCamera !== null && motionReadbackMatches(liveCamera, expected));
      const smartResult: UpdateResult | null = wantsSmart ? (already ? 'ok' : 'mismatch') : null;
      return finish(controlsRequested ? 'ok' : (smartResult ?? 'ok'), smartResult, config);
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
      let wrote = await this.writeDevice(camera, payload, budget);
      let smartFailed = smartSkipped;
      if (!wrote.ok && wrote.result === 'failed' && payloadHasSmartDetect(payload)) {
        const narrowed = narrowPayload(payload);
        if (narrowed) {
          this.log.warn(
            `Smart detection update for ${camera.name} was rejected (${wrote.error}). ` +
              `Retrying with the zone fields Protect accepts.`,
          );
          wrote = await this.writeDevice(camera, narrowed, budget);
        }
      }
      if (!wrote.ok && wrote.result === 'failed' && payloadHasSmartDetect(payload) && controlsRequested) {
        this.log.error(
          `Smart detection update failed for ${camera.name} (${wrote.error}). ` +
            `Motion detection and LED will still be updated.`,
        );
        wrote = await this.writeDevice(camera, withoutSmartDetect(payload), budget);
        smartFailed = true;
        expected.smartDetectConfig = null;
      }
      if (!wrote.ok) {
        if (wrote.result === 'failed') {
          this.log.error(`Error updating ${camera.name}: ${wrote.error}`);
        }
        await this.refreshCamera(camera, budget);
        return done(wrote.result, wantsSmart ? wrote.result : null);
      }

      const readback = await this.readUntilMatch(camera, expected, budget);
      let observed = readback.camera;
      let droppedRefill = false;
      if (observed && settings.smartDetect === false && smartPlan?.expectedConfig && liveCamera && !smartFailed) {
        const confirmedCamera = await this.confirmEnforcedTypes(
          camera,
          smartPlan,
          liveCamera,
          observed,
          expected,
          budget,
        );
        if (confirmedCamera) {
          observed = confirmedCamera.camera;
          if (confirmedCamera.dropped) {
            config = confirmedCamera.config;
            droppedRefill = true;
          }
        }
      }
      if (observed) {
        this.dropAbsentEnforcedTypes(camera, readSmartDetectConfig(observed));
      }
      if (observed) {
        this.snapshots.set(camera.id, snapshotFromCamera(observed, this.now(), readback.attempts));
        const controlsMatch =
          !controlsRequested ||
          motionReadbackMatches(observed, { ...expected, smartDetect: null, smartDetectConfig: null });
        const smartAsserted = Boolean(expected.smartDetectConfig);
        const smartMatch =
          !smartAsserted ||
          motionReadbackMatches(observed, {
            smartDetect: null,
            smartDetectConfig: expected.smartDetectConfig ?? null,
            smartDetectBaseline: expected.smartDetectBaseline ?? null,
            smartDetectEnabling: expected.smartDetectEnabling,
          });
        const controlResult: UpdateResult = controlsMatch ? 'ok' : 'mismatch';
        let smartResult: UpdateResult | null = wantsSmart ? 'ok' : null;
        if (smartFailed) {
          smartResult = 'failed';
        } else if (wantsSmart && !smartMatch) {
          smartResult = 'mismatch';
        }
        if (controlsRequested && !controlsMatch) {
          this.logReadbackMismatch(camera, expected, observed);
        } else if (wantsSmart && smartResult !== 'ok') {
          this.log.error(
            `Smart detection for ${camera.name} did not match the camera readback. ` +
              `The saved snapshot was kept. The PATCH response was not the source of success.`,
          );
        }
        if ((!controlsRequested || controlsMatch) && (!wantsSmart || smartResult === 'ok')) {
          if (settings.smartDetect === true && observed) {
            const confirmed = readSmartDetectConfig(observed);
            const cleaned = config ? withoutUnsavedSmartDetectTypes(confirmed, config) : confirmed;
            if (smartDetectConfigActive(cleaned)) {
              this.persistSmartDetectSnapshot(camera, cleaned);
            }
          }
          this.log.info(this.confirmedReadbackMessage(camera, changes, config, observed, droppedRefill));
        }
        const result = controlsRequested ? controlResult : (smartResult ?? 'failed');
        return done(result, smartResult, observed);
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

  private enforcedTypes(camera: ProtectCamera): SmartDetectEnforcedType[] {
    if (!this.smartDetectStore || !this.controllerAddress) {
      return [];
    }
    return this.smartDetectStore.getEnforced(this.controllerAddress, camera.id);
  }

  /**
   * Types the controller adds to a list this write left empty are recorded.
   * Types that were already there are cleared once more. If they remain, the
   * readback does not match and the snapshot is left alone.
   */
  private async confirmEnforcedTypes(
    camera: ProtectCamera,
    plan: SmartDetectWritePlan,
    beforeWriteCamera: ProtectCamera,
    observed: ProtectCamera,
    expected: MotionReadbackExpectation,
    budget: SessionRecoveryBudget,
  ): Promise<{ camera: ProtectCamera; config: SmartDetectConfig | null; dropped: boolean } | null> {
    if (!plan.expectedConfig) {
      return null;
    }
    const beforeWrite = readSmartDetectConfig(beforeWriteCamera);
    const written = plan.expectedConfig;
    let current = observed;
    const stuck = novelResidualTypes(
      typesStillOwned(beforeWrite, written, readSmartDetectConfig(current)),
      this.enforcedTypes(camera),
    );
    const follow: CameraWritePayload = {};
    applySmartPatch(follow, patchForResidualLists(plan.patch, stuck));
    if (payloadHasSmartDetect(follow)) {
      const wrote = await this.writeDevice(camera, follow, budget);
      if (wrote.ok) {
        const again = await this.fetchCameraRecord(camera, budget);
        if (again) {
          current = again;
        }
      }
    }
    const added = novelResidualTypes(
      addedByController(beforeWrite, written, readSmartDetectConfig(current)),
      this.enforcedTypes(camera),
    );
    if (added.length === 0) {
      return { camera: current, config: null, dropped: false };
    }
    this.persistEnforcedTypes(camera, added);
    const baseline = expected.smartDetectBaseline;
    if (!baseline) {
      return { camera: current, config: null, dropped: false };
    }
    const stripped = withoutRefilledTypes(baseline, added);
    if (
      (smartDetectConfigActive(baseline) && !smartDetectConfigActive(stripped)) ||
      smartDetectConfigsEqual(stripped, baseline)
    ) {
      return { camera: current, config: baseline, dropped: false };
    }
    this.persistSmartDetectSnapshot(camera, stripped);
    expected.smartDetectBaseline = stripped;
    return { camera: current, config: stripped, dropped: true };
  }

  private dropAbsentEnforcedTypes(camera: ProtectCamera, actual: SmartDetectConfig): void {
    const absent = enforcedTypesAbsent(this.enforcedTypes(camera), actual);
    if (absent.length === 0 || !this.smartDetectStore || !this.controllerAddress) {
      return;
    }
    try {
      this.smartDetectStore.dropEnforced(this.controllerAddress, camera.id, absent);
    } catch (error) {
      this.log.error(`Could not update enforced smart detection types for ${camera.name}: ${errorText(error)}`);
    }
  }

  private persistEnforcedTypes(camera: ProtectCamera, enforced: SmartDetectEnforcedType[]): void {
    if (!this.smartDetectStore || !this.controllerAddress) {
      return;
    }
    try {
      this.smartDetectStore.rememberEnforced(this.controllerAddress, camera.id, camera.name, enforced);
    } catch (error) {
      this.log.error(`Could not save enforced smart detection types for ${camera.name}: ${errorText(error)}`);
    }
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
    budget: SessionRecoveryBudget,
  ): Promise<{ ok: true } | { ok: false; result: UpdateResult; error: string }> {
    const first = await this.writeDeviceOnce(camera, payload);
    // A rejected PATCH is retried only after the library has logged itself out.
    // The payload sets fixed values, so one retry cannot apply a second change.
    if (first.ok || !this.sessionLost() || budget.remaining <= 0) {
      return first;
    }
    budget.remaining -= 1;
    const restored = await this.recoverSession();
    if (restored && this.hasBootstrap() && !this.api.isAdminUser) {
      this.logConfirmedNonAdmin();
      return { ok: false, result: 'unauthorized', error: 'account cannot change device settings' };
    }
    if (!restored || !this.api.isAdminUser) {
      return { ok: false, result: 'failed', error: first.error };
    }
    this.log.warn(`Retrying the update for ${camera.name} after refreshing the UniFi Protect session.`);
    return this.writeDeviceOnce(camera, payload);
  }

  private async writeDeviceOnce(
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
    this.stopped = true;
    this.eventsDownSince = null;
    this.stopWatchdog();
    if (this.connected) {
      this.api.reset();
      this.connected = false;
      this.adminConfirmed = false;
      this.messageHandlers = [];
    }
  }

  private async readUntilMatch(
    camera: ProtectCamera,
    expected: MotionReadbackExpectation,
    budget: SessionRecoveryBudget = { remaining: 1 },
  ): Promise<{ matched: boolean; camera: ProtectCamera | null; attempts: number; error: string | null }> {
    let lastCamera: ProtectCamera | null = null;
    let error: string | null = null;

    for (let index = 0; index < MOTION_READBACK_DELAYS_MS.length; index += 1) {
      const delay = MOTION_READBACK_DELAYS_MS[index] ?? 0;
      if (delay > 0) {
        await this.sleep(delay);
      }
      try {
        const record = await this.fetchCameraRecord(camera, budget);
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

  private async fetchCameraRecord(
    camera: ProtectCamera,
    budget: SessionRecoveryBudget = { remaining: 1 },
  ): Promise<ProtectCamera | null> {
    if (this.connected && !this.hasBootstrap() && budget.remaining > 0) {
      budget.remaining -= 1;
      await this.recoverSession();
    }
    const record = await this.retrieveCameraRecord(camera);
    if (record) {
      return record;
    }
    // A 401 clears the bootstrap inside the library before this null comes back.
    if (this.connected && !this.hasBootstrap() && budget.remaining > 0 && !this.api.isThrottled) {
      budget.remaining -= 1;
      const restored = await this.recoverSession();
      if (!restored) {
        return null;
      }
      this.log.warn(`Retrying the camera read for ${camera.name} after refreshing the UniFi Protect session.`);
      return this.retrieveCameraRecord(camera);
    }
    return null;
  }

  private async retrieveCameraRecord(camera: ProtectCamera): Promise<ProtectCamera | null> {
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
    budget: SessionRecoveryBudget,
  ): Promise<ProtectCamera | null> {
    try {
      const record = await this.fetchCameraRecord(camera, budget);
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

  /**
   * Logout clears the bootstrap and admin flag together. A non-admin account keeps
   * its bootstrap, so a missing bootstrap is the lost-session signal.
   */
  private sessionLost(): boolean {
    if (this.api.isThrottled) {
      return false;
    }
    return !this.hasBootstrap() || !this.api.isAdminUser;
  }

  private hasBootstrap(): boolean {
    return Boolean(this.api.bootstrap);
  }

  /**
   * unifi-protect keeps the events socket on a private `_eventsWs` field and sets it
   * to null on logout or when the socket closes. Test doubles that omit the field are
   * treated as open so they are not refreshed on every check.
   */
  /** A missing socket is tolerated until it has been down through the grace period. */
  private eventsSocketTolerated(): boolean {
    if (this.eventsWebsocketOpen()) {
      this.eventsDownSince = null;
      return true;
    }
    const observedAt = this.now();
    if (this.eventsDownSince === null) {
      this.eventsDownSince = observedAt;
    }
    return observedAt - this.eventsDownSince < EVENTS_SOCKET_GRACE_MS;
  }

  private eventsWebsocketOpen(): boolean {
    const api: object = this.api;
    if (!Object.prototype.hasOwnProperty.call(api, '_eventsWs')) {
      return true;
    }
    const socket = (api as { _eventsWs?: unknown })._eventsWs;
    if (!socket || typeof socket !== 'object') {
      return false;
    }
    if ('readyState' in socket && typeof socket.readyState === 'number') {
      return socket.readyState === WEBSOCKET_OPEN;
    }
    return true;
  }

  /**
   * Refreshes a logged-out session before a write. `unauthorized` is returned only
   * when the new bootstrap still says this account cannot change devices.
   */
  private async ensureWritableSession(budget: SessionRecoveryBudget): Promise<'ok' | 'unauthorized' | 'failed'> {
    const loggedOut = !this.hasBootstrap();
    if (!loggedOut && this.api.isAdminUser) {
      return 'ok';
    }
    // The current bootstrap already said this account cannot change devices.
    if (!loggedOut && this.adminConfirmed && !this.api.isAdminUser) {
      return 'unauthorized';
    }
    if (budget.remaining <= 0) {
      return 'failed';
    }
    budget.remaining -= 1;
    const restored = await this.recoverSession();
    if (restored && this.hasBootstrap() && !this.api.isAdminUser) {
      this.logConfirmedNonAdmin();
      return 'unauthorized';
    }
    if (!restored || !this.hasBootstrap() || !this.api.isAdminUser) {
      return 'failed';
    }
    return 'ok';
  }

  private recoveryBackoffMs(): number {
    const exponent = Math.max(this.recoveryFailures, 1) - 1;
    const scaled = RECOVERY_FAILURE_FLOOR_MS * 2 ** exponent;
    return Math.min(scaled, SESSION_WATCHDOG_MAX_MS);
  }

  private recoveryBlockedByBackoff(): boolean {
    return (
      !this.lastRecoverySucceeded &&
      this.lastRecoveryAttemptAt !== null &&
      this.now() - this.lastRecoveryAttemptAt < this.recoveryBackoffMs()
    );
  }

  /** Keeps the watchdog from logging in sooner than the write path's failure backoff. */
  private extendWatchdogAfterFailure(): void {
    const backoff = this.recoveryBackoffMs();
    if (backoff <= this.watchdogDelayMs) {
      return;
    }
    this.watchdogDelayMs = backoff;
    if (this.watchdogTimer) {
      this.scheduleWatchdog();
    }
  }

  private logConfirmedNonAdmin(): void {
    this.log.warn('UniFi Protect refreshed the session, and this account cannot change device settings.');
  }

  private recoverSession(): Promise<boolean> {
    if (this.recoveryInFlight) {
      return this.recoveryInFlight;
    }
    if (this.stopped || !this.connected) {
      return Promise.resolve(false);
    }
    if (this.recoveryBlockedByBackoff()) {
      return Promise.resolve(false);
    }
    this.recoveryInFlight = this.recoverSessionOnce().finally(() => {
      this.recoveryInFlight = null;
    });
    return this.recoveryInFlight;
  }

  /**
   * `getBootstrap` logs in again with the credentials stored by the library,
   * reloads the bootstrap, re-checks admin, and reopens the events websocket.
   */
  private async recoverSessionOnce(): Promise<boolean> {
    this.lastRecoveryAttemptAt = this.now();
    this.log.warn('UniFi Protect session is unavailable. Refreshing the controller bootstrap.');
    let restored = false;
    try {
      const ok = await this.api.getBootstrap();
      if (this.shutdownWon()) {
        return false;
      }
      restored = Boolean(ok && this.api.bootstrap);
    } catch (error) {
      if (this.shutdownWon()) {
        return false;
      }
      this.log.error(`Unable to refresh the UniFi Protect bootstrap: ${errorText(error)}`);
      restored = false;
    }
    this.lastRecoverySucceeded = restored;
    if (restored) {
      this.recoveryFailures = 0;
      this.adminConfirmed = true;
      this.sessionRecoveredAt = this.now();
      this.watchdogDelayMs = SESSION_WATCHDOG_BASE_MS;
      if (!this.stopped && this.watchdogTimer) {
        this.scheduleWatchdog();
      }
      this.log.info('UniFi Protect session restored.');
    } else {
      this.recoveryFailures += 1;
      this.adminConfirmed = false;
      this.extendWatchdogAfterFailure();
      this.log.warn('UniFi Protect session could not be restored. Another attempt will follow.');
    }
    this.emitHealthChange();
    return restored;
  }

  private startWatchdog(): void {
    this.watchdogDelayMs = SESSION_WATCHDOG_BASE_MS;
    this.scheduleWatchdog();
  }

  /** True when disconnect already won. Closes anything the in-flight bootstrap reopened. */
  private shutdownWon(): boolean {
    if (!this.stopped && this.connected) {
      return false;
    }
    this.stopWatchdog();
    this.api.reset();
    return true;
  }

  private scheduleWatchdog(): void {
    if (this.stopped || !this.connected) {
      this.clearWatchdogTimer();
      return;
    }
    this.clearWatchdogTimer();
    const timer = setTimeout(() => {
      void this.onWatchdog();
    }, this.watchdogDelayMs);
    timer.unref?.();
    this.watchdogTimer = timer;
  }

  private clearWatchdogTimer(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private stopWatchdog(): void {
    this.clearWatchdogTimer();
  }

  /** Recovers a missing bootstrap or events websocket so motion events resume without a write. */
  private async onWatchdog(): Promise<void> {
    this.watchdogTimer = null;
    if (this.stopped || !this.connected) {
      return;
    }
    try {
      if (!this.hasBootstrap() || !this.eventsWebsocketOpen()) {
        if (this.recoveryBlockedByBackoff()) {
          this.watchdogDelayMs = Math.min(
            Math.max(this.watchdogDelayMs, this.recoveryBackoffMs()),
            SESSION_WATCHDOG_MAX_MS,
          );
        } else {
          const restored = await this.recoverSession();
          this.watchdogDelayMs =
            restored && this.hasLiveSession
              ? SESSION_WATCHDOG_BASE_MS
              : Math.min(this.watchdogDelayMs * 2, SESSION_WATCHDOG_MAX_MS);
        }
      } else {
        this.watchdogDelayMs = SESSION_WATCHDOG_BASE_MS;
      }
    } catch (error) {
      this.watchdogDelayMs = Math.min(this.watchdogDelayMs * 2, SESSION_WATCHDOG_MAX_MS);
      this.log.error(`Protect session watchdog failed: ${errorText(error)}`);
    }
    if (!this.stopped && this.connected) {
      this.scheduleWatchdog();
    }
  }

  private confirmedReadbackMessage(
    camera: ProtectCamera,
    changes: string[],
    baseline: SmartDetectConfig | null,
    actual: ProtectCamera | null,
    droppedRefill: boolean,
  ): string {
    const confirmed = `${changes.join(', ')} for ${camera.name} (confirmed by camera readback)`;
    if (!baseline || !actual) {
      return confirmed;
    }
    const enforced = listSmartDetectEnforcedTypes(baseline, readSmartDetectConfig(actual));
    if (enforced.length === 0) {
      return confirmed;
    }
    const snapshotNote = droppedRefill
      ? 'Those types were removed from the saved snapshot.'
      : 'The saved snapshot was not changed.';
    return (
      `${confirmed}. Protect kept smart-detection types this plugin did not save ` +
      `(${formatEnforcedTypes(enforced)}). ${snapshotNote}`
    );
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

function formatEnforcedTypes(enforced: SmartDetectEnforcedType[]): string {
  return enforced
    .map((entry) => {
      const place =
        entry.list === 'secondLensZone'
          ? `second lens${entry.zoneName ? ` ${entry.zoneName}` : ''}`
          : entry.list === 'zone'
            ? `zone${entry.zoneName ? ` ${entry.zoneName}` : ''}`
            : entry.list;
      return `${place}: ${entry.types.join(', ')}`;
    })
    .join('; ');
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
