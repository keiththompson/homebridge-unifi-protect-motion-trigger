import type { Logging } from 'homebridge';
import { ProtectApi } from 'unifi-protect';

import { ProtectApiError } from './errors.js';
import type {
  LedSettings,
  ProtectBootstrap,
  ProtectCamera,
  ProtectEventPacket,
  RecordingSettings,
} from './types.js';

export type MessageHandler = (packet: ProtectEventPacket) => void;

export class ProtectClient {
  private api: ProtectApi;
  private messageHandlers: MessageHandler[] = [];
  private connected = false;

  constructor(private readonly log: Logging) {
    this.api = new ProtectApi();
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

  public onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  public async updateCameraLed(camera: ProtectCamera, enabled: boolean): Promise<boolean> {
    if (!this.connected) {
      this.log.error('Cannot update camera LED: not connected');
      return false;
    }

    try {
      const payload: { ledSettings: LedSettings } = {
        ledSettings: { isEnabled: enabled },
      };

      const result = await this.api.updateDevice(camera as never, payload as never);

      if (result) {
        this.log.info(`LED ${enabled ? 'enabled' : 'disabled'} for ${camera.name}`);
        return true;
      }

      this.log.error(`Failed to update LED settings for ${camera.name}`);
      return false;
    } catch (error) {
      this.log.error(`Error updating LED for ${camera.name}:`, error);
      return false;
    }
  }

  public async updateCameraMotionDetection(camera: ProtectCamera, enabled: boolean): Promise<boolean> {
    if (!this.connected) {
      this.log.error('Cannot update motion detection: not connected');
      return false;
    }

    try {
      const payload: { recordingSettings: RecordingSettings } = {
        recordingSettings: { enableMotionDetection: enabled },
      };

      const result = await this.api.updateDevice(camera as never, payload as never);

      if (result) {
        this.log.info(`Motion detection ${enabled ? 'enabled' : 'disabled'} for ${camera.name}`);
        return true;
      }

      this.log.error(`Failed to update motion detection settings for ${camera.name}`);
      return false;
    } catch (error) {
      this.log.error(`Error updating motion detection for ${camera.name}:`, error);
      return false;
    }
  }

  public disconnect(): void {
    if (this.connected) {
      this.api.reset();
      this.connected = false;
      this.messageHandlers = [];
    }
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
