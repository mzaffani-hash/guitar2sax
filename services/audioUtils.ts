
import { NoteEvent, InstrumentType } from '../types';

// Utility to resample audio buffer to target sample rate
export async function resampleBuffer(audioBuffer: AudioBuffer, targetSampleRate: number): Promise<AudioBuffer> {
  const offlineContext = new OfflineAudioContext(
    1, 
    (audioBuffer.length * targetSampleRate) / audioBuffer.sampleRate,
    targetSampleRate
  );
  
  const bufferSource = offlineContext.createBufferSource();
  bufferSource.buffer = audioBuffer;
  bufferSource.connect(offlineContext.destination);
  bufferSource.start();
  
  return offlineContext.startRendering();
}

// Trim silence from start and end of buffer
export function trimSilence(input: AudioBuffer, ctx: AudioContext): AudioBuffer {
  const channelData = input.getChannelData(0);
  const threshold = 0.005; // -46dB roughly
  let start = 0;
  let end = channelData.length;

  // Find start
  for (let i = 0; i < channelData.length; i++) {
    if (Math.abs(channelData[i]) > threshold) {
      start = i;
      break;
    }
  }

  // Find end
  for (let i = channelData.length - 1; i > start; i--) {
    if (Math.abs(channelData[i]) > threshold) {
      end = i + 1; // Include the sample
      break;
    }
  }

  const padding = Math.floor(input.sampleRate * 0.05);
  start = Math.max(0, start - padding);
  end = Math.min(channelData.length, end + padding);
  
  const length = end - start;
  if (length <= 0 || length >= input.length) return input;

  const newBuffer = ctx.createBuffer(input.numberOfChannels, length, input.sampleRate);
  for (let ch = 0; ch < input.numberOfChannels; ch++) {
    const oldData = input.getChannelData(ch);
    const newData = newBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      newData[i] = oldData[start + i];
    }
  }
  return newBuffer;
}

// Convert AudioBuffer to WAV Blob for download
export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const bufferArr = new ArrayBuffer(length);
  const view = new DataView(bufferArr);
  const channels = [];
  let i;
  let sample;
  let offset = 0;
  let pos = 0;

  // write WAVE header
  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8); // file length - 8
  setUint32(0x45564157); // "WAVE"

  setUint32(0x20746d66); // "fmt " chunk
  setUint32(16); // length = 16
  setUint16(1); // PCM (uncompressed)
  setUint16(numOfChan);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
  setUint16(numOfChan * 2); // block-align
  setUint16(16); // 16-bit (hardcoded in this writer)

  setUint32(0x61746164); // "data" - chunk
  setUint32(length - pos - 4); // chunk length

  // write interleaved data
  for (i = 0; i < buffer.numberOfChannels; i++)
    channels.push(buffer.getChannelData(i));

  while (pos < buffer.length) {
    for (i = 0; i < numOfChan; i++) {
      sample = Math.max(-1, Math.min(1, channels[i][pos])); 
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
      view.setInt16(44 + offset, sample, true);
      offset += 2;
    }
    pos++;
  }

  return new Blob([bufferArr], { type: 'audio/wav' });

  function setUint16(data: any) {
    view.setUint16(pos, data, true);
    pos += 2;
  }

  function setUint32(data: any) {
    view.setUint32(pos, data, true);
    pos += 4;
  }
}

export function createImpulseResponse(context: AudioContext, duration: number, decay: number, reverse: boolean = false): AudioBuffer {
  const sampleRate = context.sampleRate;
  const length = sampleRate * duration;
  const impulse = context.createBuffer(2, length, sampleRate);
  const left = impulse.getChannelData(0);
  const right = impulse.getChannelData(1);

  for (let i = 0; i < length; i++) {
    let n = reverse ? length - i : i;
    const amplitude = Math.pow(1 - n / length, decay);
    left[i] = (Math.random() * 2 - 1) * amplitude;
    right[i] = (Math.random() * 2 - 1) * amplitude;
  }

  return impulse;
}

/**
 * HIGH PRECISION NOTE EXTRACTION
 */
export function extractNotesFromBuffer(buffer: AudioBuffer): NoteEvent[] {
    const rawData = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;
    
    // Stronger Low Pass for guitar fundamental extraction
    const data = applyLowPassFilter(rawData, 700, sampleRate);

    const windowSize = 1024; 
    const hopSize = 256; 
    const rmsThreshold = 0.02; 
    
    const pitchFrames: number[] = [];
    const rmsFrames: number[] = [];
    const timeSteps: number[] = [];

    for (let i = 0; i < data.length - windowSize; i += hopSize) {
        let sumSqRaw = 0;
        for (let s = 0; s < windowSize; s++) {
            const val = rawData[i + s];
            sumSqRaw += val * val;
        }
        const rms = Math.sqrt(sumSqRaw / windowSize);

        let midiNote = 0;
        if (rms > rmsThreshold) {
             const chunk = data.slice(i, i + windowSize);
             const freq = detectPitchAMDF(chunk, sampleRate);
             // Stricter range to avoid sub-bass rumble or high squeaks
             if (freq > 75 && freq < 1200) { 
                 const floatNote = 69 + 12 * Math.log2(freq / 440);
                 midiNote = Math.round(floatNote);
             }
        }
        
        pitchFrames.push(midiNote);
        rmsFrames.push(rms);
        timeSteps.push(i / sampleRate);
    }

    // Median filter 7 frames ~ 40ms
    const smoothedNotes = medianFilter(pitchFrames, 7);

    const notes: NoteEvent[] = [];
    let currentNote = 0;
    let currentStartIndex = 0;
    const frameDuration = hopSize / sampleRate;

    const addNote = (noteNumber: number, startIndex: number, endIndex: number) => {
        const startTime = timeSteps[startIndex];
        const duration = (endIndex - startIndex) * frameDuration;
        
        // Discard very short glitches < 60ms
        if (duration > 0.06) { 
            let maxRms = 0;
            for(let j = startIndex; j < endIndex && j < rmsFrames.length; j++) {
                if (rmsFrames[j] > maxRms) maxRms = rmsFrames[j];
            }
            
            const normalized = Math.min(1.0, maxRms * 4); 
            const velocity = Math.max(0.3, normalized);

            notes.push({
                note: noteNumber,
                start: startTime,
                duration: duration,
                velocity: velocity
            });
        }
    };

    for (let i = 0; i < smoothedNotes.length; i++) {
        const note = smoothedNotes[i];
        if (note !== currentNote) {
            if (currentNote > 0) addNote(currentNote, currentStartIndex, i);
            currentNote = note;
            currentStartIndex = i;
        }
    }
    
    if (currentNote > 0) addNote(currentNote, currentStartIndex, smoothedNotes.length);
    return notes;
}

function applyLowPassFilter(data: Float32Array, cutoff: number, sampleRate: number): Float32Array {
    const rc = 1.0 / (cutoff * 2 * Math.PI);
    const dt = 1.0 / sampleRate;
    const alpha = dt / (rc + dt);
    const output = new Float32Array(data.length);
    let lastVal = 0;
    for (let i = 0; i < data.length; i++) {
        lastVal = lastVal + alpha * (data[i] - lastVal);
        output[i] = lastVal;
    }
    return output;
}

function createOfflineContext(sampleRate: number, totalDuration: number): { offlineCtx: OfflineAudioContext, mainBus: GainNode } {
    const safeDuration = Math.max(1, totalDuration + 2.0); 
    const length = Math.ceil(safeDuration * sampleRate);
    
    const offlineCtx = new OfflineAudioContext(1, length, sampleRate);
    
    const limiter = offlineCtx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 10;
    limiter.ratio.value = 15;
    limiter.attack.value = 0.005;
    limiter.release.value = 0.1;
    
    limiter.connect(offlineCtx.destination);
    
    const mainBus = offlineCtx.createGain();
    mainBus.gain.value = 0.9; // High gain input to limiter
    mainBus.connect(limiter);
    return { offlineCtx, mainBus };
}

// --- INSTRUMENT SYNTHESIS ---

/**
 * SAXOPHONE: FM-Assisted Subtractive
 * Rich, breathy, and slightly "growling".
 */
export async function renderLocalSaxophoneSolo(notes: NoteEvent[], sampleRate: number, totalDuration: number): Promise<AudioBuffer> {
    const { offlineCtx, mainBus } = createOfflineContext(sampleRate, totalDuration);
    
    // Room Reverb
    const reverb = createSimpleReverb(offlineCtx, sampleRate, 1.2);
    const reverbGain = offlineCtx.createGain();
    reverbGain.gain.value = 0.15;
    reverb.connect(reverbGain).connect(mainBus);

    notes.forEach(note => {
        const freq = 440 * Math.pow(2, (note.note - 69) / 12);
        const t = note.start;
        const d = note.duration;
        const vel = note.velocity; 

        // Main Tone: Square wave (Hollow sound)
        const osc = offlineCtx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = freq;

        // Sub-Oscillator for body
        const subOsc = offlineCtx.createOscillator();
        subOsc.type = 'sawtooth';
        subOsc.frequency.value = freq;
        const subGain = offlineCtx.createGain();
        subGain.gain.value = 0.4;

        // Growl FM: Adds texture (simulates throat)
        const growlOsc = offlineCtx.createOscillator();
        growlOsc.frequency.value = freq * 0.5; // Subharmonic
        const growlGain = offlineCtx.createGain();
        growlGain.gain.value = 15; // Modulation depth
        growlOsc.connect(growlGain).connect(osc.frequency);

        // Filter Envelope (Wah-like for expression)
        const filter = offlineCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.Q.value = 2;
        
        const startCutoff = 300;
        const peakCutoff = 800 + (vel * 1200);
        
        filter.frequency.setValueAtTime(startCutoff, t);
        filter.frequency.linearRampToValueAtTime(peakCutoff, t + 0.05); // Attack
        filter.frequency.exponentialRampToValueAtTime(startCutoff + 200, t + d); // Sustain level

        // Amplitude
        const amp = offlineCtx.createGain();
        amp.gain.setValueAtTime(0, t);
        amp.gain.linearRampToValueAtTime(vel * 0.5, t + 0.05);
        amp.gain.setValueAtTime(vel * 0.4, t + d - 0.05);
        amp.gain.linearRampToValueAtTime(0, t + d + 0.1);

        // Breath Noise
        const noise = createNoiseBuffer(offlineCtx);
        const noiseSrc = offlineCtx.createBufferSource();
        noiseSrc.buffer = noise;
        const noiseFilter = offlineCtx.createBiquadFilter();
        noiseFilter.type = 'bandpass';
        noiseFilter.frequency.value = 2000;
        const noiseAmp = offlineCtx.createGain();
        noiseAmp.gain.value = 0.03 * vel;
        
        noiseSrc.connect(noiseFilter).connect(noiseAmp).connect(amp);
        
        growlOsc.start(t); growlOsc.stop(t + d + 0.1);
        osc.connect(filter);
        subOsc.connect(subGain).connect(filter);
        filter.connect(amp);
        amp.connect(mainBus);
        amp.connect(reverb);

        osc.start(t); osc.stop(t + d + 0.1);
        subOsc.start(t); subOsc.stop(t + d + 0.1);
        noiseSrc.start(t); noiseSrc.stop(t + d + 0.1);
    });

    return offlineCtx.startRendering();
}

/**
 * VIOLIN: "Ensemble" Synthesis
 * Addresses the "8-bit" issue by using 3 detuned oscillators to create width.
 * Includes "Bow Noise" for realism.
 */
export async function renderLocalViolinSolo(notes: NoteEvent[], sampleRate: number, totalDuration: number): Promise<AudioBuffer> {
    const { offlineCtx, mainBus } = createOfflineContext(sampleRate, totalDuration);

    // Larger Hall Reverb for Violin
    const reverb = createSimpleReverb(offlineCtx, sampleRate, 2.0);
    const reverbGain = offlineCtx.createGain();
    reverbGain.gain.value = 0.3;
    reverb.connect(reverbGain).connect(mainBus);

    notes.forEach(note => {
        const freq = 440 * Math.pow(2, (note.note - 69) / 12);
        const t = note.start;
        const d = note.duration;
        const vel = note.velocity;

        // Master Vibrato LFO
        const vibOsc = offlineCtx.createOscillator();
        vibOsc.frequency.value = 5.5; // Classical vibrato rate
        const vibGain = offlineCtx.createGain();
        vibGain.gain.value = freq * 0.02; // Depth
        
        // ENSEMBLE: 3 Oscillators to remove "buzzy/8-bit" sound
        // 1. Center
        const osc1 = offlineCtx.createOscillator();
        osc1.type = 'sawtooth';
        osc1.frequency.value = freq;
        vibOsc.connect(vibGain).connect(osc1.frequency);

        // 2. Left (Detuned Flat)
        const osc2 = offlineCtx.createOscillator();
        osc2.type = 'sawtooth';
        osc2.frequency.value = freq * 0.998; 
        vibOsc.connect(vibGain).connect(osc2.frequency);

        // 3. Right (Detuned Sharp)
        const osc3 = offlineCtx.createOscillator();
        osc3.type = 'sawtooth';
        osc3.frequency.value = freq * 1.002;
        vibOsc.connect(vibGain).connect(osc3.frequency);

        // Mix Oscillators
        const mixGain = offlineCtx.createGain();
        mixGain.gain.value = 0.2; // Lower individual gain to prevent clipping

        // Formant Filters (The Body of the Violin)
        // This cuts the high "buzz" and boosts "wooden" frequencies
        const bodyFilter = offlineCtx.createBiquadFilter();
        bodyFilter.type = 'lowpass';
        bodyFilter.frequency.value = 2200; // Cut harsh highs
        bodyFilter.Q.value = 0.7;

        const woodResonance = offlineCtx.createBiquadFilter();
        woodResonance.type = 'peaking';
        woodResonance.frequency.value = 1000; // Wooden body resonance
        woodResonance.Q.value = 2;
        woodResonance.gain.value = 5;

        // Bow Noise (The Scratch) - only on attack
        const bowNoise = createNoiseBuffer(offlineCtx);
        const bowSrc = offlineCtx.createBufferSource();
        bowSrc.buffer = bowNoise;
        const bowFilter = offlineCtx.createBiquadFilter();
        bowFilter.type = 'highpass';
        bowFilter.frequency.value = 1500;
        const bowEnv = offlineCtx.createGain();
        bowEnv.gain.setValueAtTime(0.1, t);
        bowEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.15); // Short scratch
        bowSrc.connect(bowFilter).connect(bowEnv).connect(bodyFilter);
        bowSrc.start(t);

        // Volume Envelope (Swell)
        const amp = offlineCtx.createGain();
        amp.gain.setValueAtTime(0, t);
        amp.gain.linearRampToValueAtTime(vel * 0.8, t + 0.15); // Slow attack (Bowing)
        amp.gain.setValueAtTime(vel * 0.8, t + d);
        amp.gain.linearRampToValueAtTime(0, t + d + 0.25); // Release

        // Connect Graph
        osc1.connect(mixGain);
        osc2.connect(mixGain);
        osc3.connect(mixGain);
        
        mixGain.connect(woodResonance).connect(bodyFilter).connect(amp);
        amp.connect(mainBus);
        amp.connect(reverb);

        vibOsc.start(t); vibOsc.stop(t + d + 0.25);
        osc1.start(t); osc1.stop(t + d + 0.25);
        osc2.start(t); osc2.stop(t + d + 0.25);
        osc3.start(t); osc3.stop(t + d + 0.25);
    });

    return offlineCtx.startRendering();
}

/**
 * PIANO: FM Synthesis (Rhodes Style)
 * Much louder and cleaner than acoustic approximations.
 * Uses Frequency Modulation to create bell-like tones.
 */
export async function renderLocalPianoSolo(notes: NoteEvent[], sampleRate: number, totalDuration: number): Promise<AudioBuffer> {
    const { offlineCtx, mainBus } = createOfflineContext(sampleRate, totalDuration);

    // Clean Plate Reverb
    const reverb = createSimpleReverb(offlineCtx, sampleRate, 1.5);
    const reverbGain = offlineCtx.createGain();
    reverbGain.gain.value = 0.15;
    reverb.connect(reverbGain).connect(mainBus);

    notes.forEach(note => {
        const freq = 440 * Math.pow(2, (note.note - 69) / 12);
        const t = note.start;
        const d = note.duration;
        const vel = Math.max(0.4, note.velocity); // Ensure minimum volume

        // FM ALGORITHM: Modulator -> Carrier -> Output
        
        // 1. Carrier (The fundamental tone)
        const carrier = offlineCtx.createOscillator();
        carrier.type = 'sine'; // Pure tone
        carrier.frequency.value = freq;

        // 2. Modulator (Adds harmonics/brightness)
        const modulator = offlineCtx.createOscillator();
        modulator.type = 'sine';
        // Ratio 2.0 = Octave up (clean), 14.0 = Bell. 
        // We mix a bit of both for an electric piano sound.
        modulator.frequency.value = freq * 2.0; 

        // Modulation Depth (Index) - Controlled by Envelope
        const modGain = offlineCtx.createGain();
        // Louder notes = Brighter sound (more modulation)
        const modulationIndex = 500 * vel; 
        
        modGain.gain.setValueAtTime(modulationIndex, t);
        modGain.gain.exponentialRampToValueAtTime(1, t + 0.4); // Brightness decays fast

        modulator.connect(modGain);
        modGain.connect(carrier.frequency);

        // Amplitude Envelope (Percussive)
        const amp = offlineCtx.createGain();
        amp.gain.setValueAtTime(0, t);
        amp.gain.linearRampToValueAtTime(vel, t + 0.01); // Instant Attack
        amp.gain.exponentialRampToValueAtTime(vel * 0.2, t + 1.0); // Decay
        amp.gain.linearRampToValueAtTime(0, t + d + 0.2); // Release

        carrier.connect(amp);
        amp.connect(mainBus);
        amp.connect(reverb);

        carrier.start(t); carrier.stop(t + d + 1.5);
        modulator.start(t); modulator.stop(t + d + 1.5);
    });

    return offlineCtx.startRendering();
}

// --- UTILS ---

function createSimpleReverb(ctx: BaseAudioContext, sampleRate: number, seconds: number): ConvolverNode {
    const length = sampleRate * seconds;
    const impulse = ctx.createBuffer(2, length, sampleRate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);
    for(let i=0; i<length; i++) {
        // Exponential decay is more natural than linear
        const decay = Math.pow(0.01, i / length); 
        left[i] = (Math.random() * 2 - 1) * decay;
        right[i] = (Math.random() * 2 - 1) * decay;
    }
    const convolver = ctx.createConvolver();
    convolver.buffer = impulse;
    return convolver;
}

function createNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
    const bufferSize = ctx.sampleRate * 2; 
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        output[i] = (Math.random() * 2 - 1) * 0.5;
    }
    return buffer;
}

function medianFilter(data: number[], windowSize: number): number[] {
    const result = new Array(data.length).fill(0);
    const half = Math.floor(windowSize / 2);
    for (let i = 0; i < data.length; i++) {
        const windowValues = [];
        for (let j = -half; j <= half; j++) {
            const idx = i + j;
            if (idx >= 0 && idx < data.length) windowValues.push(data[idx]);
        }
        windowValues.sort((a, b) => a - b);
        result[i] = windowValues[Math.floor(windowValues.length / 2)];
    }
    return result;
}

function detectPitchAMDF(buffer: Float32Array, sampleRate: number): number {
    let rms = 0;
    for (let i = 0; i < buffer.length; i++) rms += buffer[i] * buffer[i];
    rms = Math.sqrt(rms / buffer.length);
    if (rms < 0.01) return 0; 

    const minFreq = 75;   
    const maxFreq = 1200; 
    const minPeriod = Math.floor(sampleRate / maxFreq);
    const maxPeriod = Math.floor(sampleRate / minFreq);

    let minVal = Infinity;
    let bestPeriod = 0;
    const len = buffer.length;
    
    for (let tau = minPeriod; tau <= maxPeriod; tau++) {
        let currentSum = 0;
        for (let i = 0; i < len - tau; i += 2) {
            currentSum += Math.abs(buffer[i] - buffer[i + tau]);
            if (currentSum >= minVal) break; // Optimization: early exit
        }
        if (currentSum < minVal) {
            minVal = currentSum;
            bestPeriod = tau;
        }
    }
    
    if (bestPeriod === 0) return 0;
    return sampleRate / bestPeriod;
}

// MIDI Generation
export function createMidiBlobFromNotes(notes: NoteEvent[], instrumentName: string = "Virtuoso Instrument"): Blob | null {
    if (notes.length === 0) return null;
    
    const timeBase = 480; 
    const tempo = 500000; 
    const ticksPerSecond = 960; 

    const events: number[] = [];

    const writeVLQ = (value: number) => {
        const buffer = [];
        let v = value;
        do {
            buffer.push(v & 0x7F);
            v >>= 7;
        } while (v > 0);
        for (let i = buffer.length - 1; i > 0; i--) events.push(buffer[i] | 0x80);
        events.push(buffer[0]);
    };

    let lastTick = 0;

    events.push(0x00, 0xFF, 0x51, 0x03);
    events.push((tempo >> 16) & 0xFF, (tempo >> 8) & 0xFF, tempo & 0xFF);
    
    events.push(0x00, 0xFF, 0x03, instrumentName.length, ...instrumentName.split('').map(c => c.charCodeAt(0)));

    type MidiEvent = { tick: number, type: 'on'|'off', note: number, velocity: number };
    const midiEvents: MidiEvent[] = [];

    notes.forEach(n => {
        const startTick = Math.round(n.start * ticksPerSecond);
        const endTick = Math.round((n.start + n.duration) * ticksPerSecond);
        const midVel = Math.floor(Math.max(10, Math.min(127, n.velocity * 127)));
        
        midiEvents.push({ tick: startTick, type: 'on', note: n.note, velocity: midVel });
        midiEvents.push({ tick: endTick, type: 'off', note: n.note, velocity: 0 });
    });

    midiEvents.sort((a, b) => a.tick - b.tick);

    midiEvents.forEach(e => {
        const delta = Math.max(0, e.tick - lastTick);
        writeVLQ(delta);
        lastTick = e.tick;

        if (e.type === 'on') {
            events.push(0x90, e.note, e.velocity); 
        } else {
            events.push(0x80, e.note, 0); 
        }
    });

    events.push(0x00, 0xFF, 0x2F, 0x00);

    const header = [
        0x4D, 0x54, 0x68, 0x64, 
        0, 0, 0, 6,             
        0, 0,                   
        0, 1,                   
        (timeBase >> 8) & 0xFF, timeBase & 0xFF
    ];

    const trackLen = events.length;
    const trackHeader = [
        0x4D, 0x54, 0x72, 0x6B, 
        (trackLen >> 24) & 0xFF,
        (trackLen >> 16) & 0xFF,
        (trackLen >> 8) & 0xFF,
        trackLen & 0xFF
    ];

    const fileData = new Uint8Array([...header, ...trackHeader, ...events]);
    return new Blob([fileData], { type: "audio/midi" });
}
