
export enum AppState {
  IDLE = 'IDLE',
  READY = 'READY',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR',
}

export type InstrumentType = 'sax' | 'piano' | 'violin';

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

export interface NoteEvent {
  note: number;     // MIDI note number (e.g., 60 for C4)
  start: number;    // Start time in seconds
  duration: number; // Duration in seconds
  velocity: number; // 0.0 to 1.0, derived from RMS amplitude
  name?: string;    // Note name (e.g., "C4")
}
