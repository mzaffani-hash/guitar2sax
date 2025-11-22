
// Utility to resample audio buffer to target sample rate (e.g., 16kHz for Gemini Input)
export async function resampleBuffer(audioBuffer: AudioBuffer, targetSampleRate: number): Promise<AudioBuffer> {
  const offlineContext = new OfflineAudioContext(
    1, // Mono is sufficient for tone transfer input to save bandwidth
    (audioBuffer.length * targetSampleRate) / audioBuffer.sampleRate,
    targetSampleRate
  );
  
  const bufferSource = offlineContext.createBufferSource();
  bufferSource.buffer = audioBuffer;
  bufferSource.connect(offlineContext.destination);
  bufferSource.start();
  
  return offlineContext.startRendering();
}

// Convert Float32Array to Int16Array (PCM)
export function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
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
      // interleave channels
      sample = Math.max(-1, Math.min(1, channels[i][pos])); // clamp
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; // scale to 16-bit signed int
      view.setInt16(44 + offset, sample, true); // write 16-bit sample
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

// Helper to decode base64 to Uint8Array
export function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Helper to encode Uint8Array to base64
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Generates a synthetic impulse response for Reverb convolution.
 * Approximates a room decay without needing external .wav files.
 */
export function createImpulseResponse(context: AudioContext, duration: number, decay: number, reverse: boolean = false): AudioBuffer {
  const sampleRate = context.sampleRate;
  const length = sampleRate * duration;
  const impulse = context.createBuffer(2, length, sampleRate);
  const left = impulse.getChannelData(0);
  const right = impulse.getChannelData(1);

  for (let i = 0; i < length; i++) {
    let n = reverse ? length - i : i;
    // Exponential decay function
    const amplitude = Math.pow(1 - n / length, decay);
    
    // White noise shaped by decay
    left[i] = (Math.random() * 2 - 1) * amplitude;
    right[i] = (Math.random() * 2 - 1) * amplitude;
  }

  return impulse;
}

/**
 * Analyzes AudioBuffer to extract pitch and generates a MIDI file.
 * Uses improved AMDF with Median Filtering and Duration Thresholding for accuracy.
 */
export function generateMidiFromBuffer(buffer: AudioBuffer): Blob | null {
    const data = buffer.getChannelData(0); // Analyze mono
    const sampleRate = buffer.sampleRate;
    
    // 1. Analysis Parameters
    const windowSize = 1024; // ~42ms at 24kHz
    const hopSize = 512;     // 50% Overlap
    const rmsThreshold = 0.015; // Silence threshold
    
    const pitchFrames: number[] = [];
    const timeSteps: number[] = [];

    // 2. Frame-based Pitch Extraction
    for (let i = 0; i < data.length - windowSize; i += hopSize) {
        const chunk = data.slice(i, i + windowSize);
        
        // Calculate RMS
        let sumSq = 0;
        for (let s = 0; s < chunk.length; s++) sumSq += chunk[s] * chunk[s];
        const rms = Math.sqrt(sumSq / chunk.length);

        let midiNote = 0;
        
        if (rms > rmsThreshold) {
             const freq = detectPitchAMDF(chunk, sampleRate);
             if (freq > 0) {
                 // Convert to MIDI note: 69 + 12*log2(freq/440)
                 const floatNote = 69 + 12 * Math.log2(freq / 440);
                 midiNote = Math.round(floatNote);
                 
                 // Clamp to reasonable instrument range (approx C2 to C7)
                 // to avoid octave errors in low/high extremes
                 if (midiNote < 36 || midiNote > 96) midiNote = 0;
             }
        }
        
        pitchFrames.push(midiNote);
        timeSteps.push(i / sampleRate);
    }

    // 3. Post-Processing: Median Filtering
    // Removes single-frame glitches by looking at neighbors (window size 5)
    const smoothedNotes = medianFilter(pitchFrames, 5);

    // 4. Note Segmentation
    const notes: {note: number, start: number, duration: number}[] = [];
    
    let currentNote = 0;
    let currentStart = 0;
    const frameDuration = hopSize / sampleRate;

    // Iterate smoothed frames to build discrete Note events
    for (let i = 0; i < smoothedNotes.length; i++) {
        const note = smoothedNotes[i];
        
        if (note !== currentNote) {
            // Status Change
            if (currentNote > 0) {
                // End previous note
                // Calculate start time based on frame index
                const startTime = timeSteps[Math.floor(currentStart / frameDuration)] || 0;
                const duration = (i * frameDuration) - currentStart;
                
                // Minimum Duration Filter: Ignore notes shorter than 60ms (likely noise or transient)
                if (duration > 0.06) { 
                     notes.push({
                        note: currentNote,
                        start: startTime,
                        duration: duration
                    });
                }
            }
            
            // Start new note
            currentNote = note;
            currentStart = i * frameDuration;
        }
    }
    
    // Handle final note if active
    if (currentNote > 0) {
         const duration = (smoothedNotes.length * frameDuration) - currentStart;
         if (duration > 0.06) {
            notes.push({
                note: currentNote,
                start: timeSteps[Math.floor(currentStart / frameDuration)] || 0,
                duration: duration
            });
         }
    }

    if (notes.length === 0) return null;

    return createMidiFile(notes);
}

// Improved AMDF (Average Magnitude Difference Function) Detection
function detectPitchAMDF(buffer: Float32Array, sampleRate: number): number {
    let rms = 0;
    for (let i = 0; i < buffer.length; i++) rms += buffer[i] * buffer[i];
    rms = Math.sqrt(rms / buffer.length);
    // Double check RMS inside detector just in case
    if (rms < 0.01) return 0; 

    const minFreq = 70;   // ~C2
    const maxFreq = 1100; // ~C6
    const minPeriod = Math.floor(sampleRate / maxFreq);
    const maxPeriod = Math.floor(sampleRate / minFreq);

    let minVal = Infinity;
    let bestPeriod = 0;
    
    // We only compare up to the length allowed by the max period shift
    const len = buffer.length - maxPeriod;
    
    for (let tau = minPeriod; tau <= maxPeriod; tau++) {
        let currentSum = 0;
        
        // Optimization: Check every 2nd sample for performance without losing much accuracy
        for (let i = 0; i < len; i += 2) {
            const delta = buffer[i] - buffer[i + tau];
            currentSum += Math.abs(delta);
        }
        
        if (currentSum < minVal) {
            minVal = currentSum;
            bestPeriod = tau;
        }
    }

    // Confidence Check:
    // If the "difference" (minVal) is high relative to the signal amplitude, it's likely not periodic (noise).
    // Normalize minVal by number of samples checked (~len/2)
    const numSamples = len / 2;
    const avgDiff = minVal / numSamples;
    
    // If average difference is > 80% of RMS, confidence is low
    if (avgDiff > rms * 0.8) return 0;

    return sampleRate / bestPeriod;
}

// Simple 1D Median Filter to smooth note trajectory
function medianFilter(data: number[], windowSize: number): number[] {
    const result = new Array(data.length).fill(0);
    const half = Math.floor(windowSize / 2);
    
    for (let i = 0; i < data.length; i++) {
        const windowValues = [];
        // Collect neighbors
        for (let j = -half; j <= half; j++) {
            const idx = i + j;
            if (idx >= 0 && idx < data.length) {
                windowValues.push(data[idx]);
            }
        }
        // Sort and pick middle
        windowValues.sort((a, b) => a - b);
        result[i] = windowValues[Math.floor(windowValues.length / 2)];
    }
    return result;
}

// Internal: Create MIDI Blob (Format 0)
function createMidiFile(notes: {note: number, start: number, duration: number}[]): Blob {
    const timeBase = 480; // Ticks per quarter note
    const tempo = 500000; // 120 BPM (microseconds per beat)

    // Convert time (seconds) to ticks
    // ticks = seconds * (beats/sec) * (ticks/beat)
    // beats/sec = 120/60 = 2
    // ticks = seconds * 2 * 480 = seconds * 960
    const ticksPerSecond = 960;

    const events: number[] = [];

    // Variable Length Quantity Writer
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

    // Add Tempo Meta Event at start
    events.push(0x00); // Delta time 0
    events.push(0xFF, 0x51, 0x03);
    events.push((tempo >> 16) & 0xFF, (tempo >> 8) & 0xFF, tempo & 0xFF);
    
    // Track Name
    const trackName = "Virtuoso Sax";
    events.push(0x00, 0xFF, 0x03, trackName.length, ...trackName.split('').map(c => c.charCodeAt(0)));

    // Flatten events
    type MidiEvent = { tick: number, type: 'on'|'off', note: number };
    const midiEvents: MidiEvent[] = [];

    notes.forEach(n => {
        const startTick = Math.round(n.start * ticksPerSecond);
        const endTick = Math.round((n.start + n.duration) * ticksPerSecond);
        midiEvents.push({ tick: startTick, type: 'on', note: n.note });
        midiEvents.push({ tick: endTick, type: 'off', note: n.note });
    });

    midiEvents.sort((a, b) => a.tick - b.tick);

    // Encode Events
    midiEvents.forEach(e => {
        const delta = Math.max(0, e.tick - lastTick);
        writeVLQ(delta);
        lastTick = e.tick;

        if (e.type === 'on') {
            events.push(0x90, e.note, 90); // Note On, Vel 90
        } else {
            events.push(0x80, e.note, 0); // Note Off
        }
    });

    // End of Track
    events.push(0x00, 0xFF, 0x2F, 0x00);

    // Header Chunk
    const header = [
        0x4D, 0x54, 0x68, 0x64, // MThd
        0, 0, 0, 6,             // Length
        0, 0,                   // Format 0
        0, 1,                   // Tracks 1
        (timeBase >> 8) & 0xFF, timeBase & 0xFF
    ];

    // Track Chunk
    const trackLen = events.length;
    const trackHeader = [
        0x4D, 0x54, 0x72, 0x6B, // MTrk
        (trackLen >> 24) & 0xFF,
        (trackLen >> 16) & 0xFF,
        (trackLen >> 8) & 0xFF,
        trackLen & 0xFF
    ];

    const fileData = new Uint8Array([...header, ...trackHeader, ...events]);
    return new Blob([fileData], { type: "audio/midi" });
}
