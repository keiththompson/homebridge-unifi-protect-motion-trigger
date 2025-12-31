export interface ProtectCamera {
  id: string;
  name: string;
  type: string;
  mac: string;
  host: string;
  lastMotion: number | null;
  ledSettings?: {
    isEnabled: boolean;
    blinkRate: number;
  };
  recordingSettings?: {
    enableMotionDetection: boolean;
  };
}

export interface ProtectBootstrap {
  cameras: ProtectCamera[];
  lastUpdateId: string;
}

export interface ProtectEventPacket {
  action?: {
    action: string;
    modelKey: string;
    id: string;
  };
  payload?: Partial<ProtectCamera>;
}

export interface LedSettings {
  isEnabled: boolean;
  blinkRate?: number;
}

export interface RecordingSettings {
  enableMotionDetection: boolean;
}
