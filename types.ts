export enum AppState {
  IDLE = 'IDLE',
  READY = 'READY',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR',
}

export interface AudioChunk {
  data: Float32Array;
  timestamp: number;
}

export interface VisualizerProps {
  analyser: AnalyserNode | null;
  color: string;
  isActive: boolean;
}

export interface AudioEffects {
  reverbMix: number; // 0 to 1
  reverbDecay: number; // seconds
  eqLow: number; // dB
  eqMid: number; // dB
  eqHigh: number; // dB
  compressorThreshold: number; // dB
}