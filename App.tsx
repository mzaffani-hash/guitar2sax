import React, { useState, useRef, useEffect, useCallback } from 'react';
import { AppState, AudioEffects } from './types';
import { Visualizer } from './components/Visualizer';
import { resampleBuffer, float32ToInt16, audioBufferToWav, base64ToUint8Array, uint8ArrayToBase64, createImpulseResponse, generateMidiFromBuffer } from './services/audioUtils';
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { Upload, Play, Download, Music, Activity, Mic2, AlertCircle, Sliders, Volume2, FileAudio, FileCode, CheckCircle2, XCircle, User, Users, Sparkles, StopCircle, Radio, Clock } from 'lucide-react';

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const SERVER_WATCHDOG_MS = 15000; // Extended to 15s to allow for longer generation start

// Default Studio Settings
const DEFAULT_EFFECTS: AudioEffects = {
    reverbMix: 0.3,
    reverbDecay: 2.5,
    eqLow: 3,    // Boost warmth
    eqMid: 0,
    eqHigh: -2,  // Cut harshness
    compressorThreshold: -24
};

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [inputBuffer, setInputBuffer] = useState<AudioBuffer | null>(null);
  const [outputBuffer, setOutputBuffer] = useState<AudioBuffer | null>(null);
  const [midiBlob, setMidiBlob] = useState<Blob | null>(null); // State for MIDI
  const [fileName, setFileName] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const [generationProgress, setGenerationProgress] = useState<number>(0);
  const [statusText, setStatusText] = useState<string>(""); // Detailed status feedback
  const [bytesSent, setBytesSent] = useState<number>(0); // Track data transfer
  
  // Studio Effects State
  const [effects, setEffects] = useState<AudioEffects>(DEFAULT_EFFECTS);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  // Audio Context Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  
  // Playback Graph Refs
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const reverbNodeRef = useRef<ConvolverNode | null>(null);
  const wetGainNodeRef = useRef<GainNode | null>(null);
  const dryGainNodeRef = useRef<GainNode | null>(null);
  const eqLowRef = useRef<BiquadFilterNode | null>(null);
  const eqMidRef = useRef<BiquadFilterNode | null>(null);
  const eqHighRef = useRef<BiquadFilterNode | null>(null);
  const compressorRef = useRef<DynamicsCompressorNode | null>(null);

  // Processing Refs
  const sessionRef = useRef<any>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const isStreamingRef = useRef<boolean>(false);
  const streamTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initialize Audio Contexts
  useEffect(() => {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    audioContextRef.current = new AudioContextClass({
        sampleRate: OUTPUT_SAMPLE_RATE
    });
    inputAnalyserRef.current = audioContextRef.current.createAnalyser();
    outputAnalyserRef.current = audioContextRef.current.createAnalyser();
    
    inputAnalyserRef.current.fftSize = 256;
    outputAnalyserRef.current.fftSize = 256;

    return () => {
      audioContextRef.current?.close();
      if (streamTimeoutRef.current) clearTimeout(streamTimeoutRef.current);
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
    };
  }, []);

  // Apply Effect Changes in Real-time
  useEffect(() => {
      if (!audioContextRef.current) return;
      const ctx = audioContextRef.current;

      if (eqLowRef.current) eqLowRef.current.gain.setTargetAtTime(effects.eqLow, ctx.currentTime, 0.1);
      if (eqMidRef.current) eqMidRef.current.gain.setTargetAtTime(effects.eqMid, ctx.currentTime, 0.1);
      if (eqHighRef.current) eqHighRef.current.gain.setTargetAtTime(effects.eqHigh, ctx.currentTime, 0.1);

      if (wetGainNodeRef.current) wetGainNodeRef.current.gain.setTargetAtTime(effects.reverbMix, ctx.currentTime, 0.1);
      if (dryGainNodeRef.current) dryGainNodeRef.current.gain.setTargetAtTime(1 - effects.reverbMix * 0.5, ctx.currentTime, 0.1);
  }, [effects]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setFileName(file.name);
    setAppState(AppState.IDLE);
    setOutputBuffer(null);
    setMidiBlob(null);
    setProgress(0);
    setGenerationProgress(0);
    setBytesSent(0);
    chunksRef.current = [];

    try {
      const arrayBuffer = await file.arrayBuffer();
      if (!audioContextRef.current) return;
      
      const decodedBuffer = await audioContextRef.current.decodeAudioData(arrayBuffer);
      setInputBuffer(decodedBuffer);
      setAppState(AppState.READY);
      setErrorMsg(null);
    } catch (err) {
      console.error(err);
      setErrorMsg("Impossibile decodificare il file audio. Usa un file WAV o MP3 valido.");
      setAppState(AppState.ERROR);
    }
  };

  const handleServerTimeout = useCallback(() => {
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      isStreamingRef.current = false;
      if (sessionRef.current) {
          sessionRef.current.then((s: any) => s.close());
      }
      // Only show error if we haven't received any chunks
      if (chunksRef.current.length === 0) {
        setAppState(AppState.ERROR);
        setErrorMsg("TIMEOUT SERVER: Il modello non sta rispondendo. Prova ad aumentare il volume dell'input o riprova.");
        setStatusText("Timeout Operazione");
      } else {
        // If we have chunks, finalize what we have
        finalizeOutput();
      }
  }, []);

  const stopProcessingManual = async () => {
      if (streamTimeoutRef.current) clearTimeout(streamTimeoutRef.current);
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      
      isStreamingRef.current = false;
      setStatusText("Arresto manuale in corso...");
      
      if (sessionRef.current) {
          try {
              const session = await sessionRef.current;
              session.close();
          } catch(e) {
              console.log("Session already closed or invalid");
          }
      }
      // Force finalize after a brief delay
      setTimeout(() => finalizeOutput(), 500);
  };

  const startToneTransfer = async () => {
    if (!inputBuffer || !process.env.API_KEY) {
      if (!process.env.API_KEY) setErrorMsg("API Key mancante.");
      return;
    }

    if (audioContextRef.current?.state === 'suspended') {
      await audioContextRef.current.resume();
    }

    setAppState(AppState.PROCESSING);
    setStatusText("Inizializzazione Protocollo Real-Time...");
    setProgress(0);
    setGenerationProgress(0);
    setBytesSent(0);
    chunksRef.current = [];
    isStreamingRef.current = true;
    setErrorMsg(null);
    setMidiBlob(null);

    const client = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const pcmBuffer = await resampleBuffer(inputBuffer, INPUT_SAMPLE_RATE);
    const pcmData = pcmBuffer.getChannelData(0); // Mono
    
    // 1. Aggressive Normalization / Gain Boost
    // Gemini VAD needs a clear signal. We normalize to 0.98 and then boost slightly more to ensure presence.
    let maxVal = 0;
    for (let i = 0; i < pcmData.length; i++) {
        if (Math.abs(pcmData[i]) > maxVal) maxVal = Math.abs(pcmData[i]);
    }

    if (maxVal < 0.00001) {
        setAppState(AppState.ERROR);
        setErrorMsg("File vuoto o digitalmente silenzioso.");
        return;
    }

    // Apply gain (Normalize + Boost)
    const gain = (1.0 / maxVal) * 1.2; // 20% boost over normalization to ensure VAD pickup
    for (let i = 0; i < pcmData.length; i++) {
        pcmData[i] = Math.max(-1, Math.min(1, pcmData[i] * gain));
    }

    const adaptiveInstruction = `
        SEI UN MUSICISTA VIRTUOSO. NON PARLARE MAI. SUONA SOLO.
        
        IL TUO COMPITO:
        Ascolta l'audio in input (assolo di chitarra o melodia).
        Appena l'input finisce, devi IMMEDIATAMENTE suonare la stessa melodia riarrangiata con il SASSOFONO o una SEZIONE FIATI.
        
        REGOLE CRITICHE:
        1. NON RISPONDERE CON TESTO.
        2. NON DIRE "Certamente" o "Ecco la musica".
        3. GENERARE SOLO AUDIO STRUMENTALE.
        4. INIZIA A SUONARE APPENA RICEVI IL COMANDO "PLAY".
    `;

    try {
        const sessionPromise = client.live.connect({
            model: 'gemini-2.5-flash-native-audio-preview-09-2025',
            config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } 
                },
                systemInstruction: adaptiveInstruction,
            },
            callbacks: {
                onopen: async () => {
                    console.log("Gemini Live Connected");
                    setStatusText("Connesso. Avvio Pipeline Dati...");
                    await streamAudioToGemini(pcmData, sessionPromise);
                },
                onmessage: async (message: LiveServerMessage) => {
                     // CLEAR WATCHDOG ON ANY ACTIVITY
                     if (watchdogRef.current) {
                         clearTimeout(watchdogRef.current);
                         watchdogRef.current = null;
                     }

                     // Check for Text Response (Error/Refusal)
                     const parts = message.serverContent?.modelTurn?.parts;
                     if (parts) {
                         for (const part of parts) {
                             if (part.text) {
                                 console.warn("Model sent text:", part.text);
                                 setStatusText(`Nota AI: "${part.text.substring(0, 50)}..."`);
                                 // If model talks, it might not play audio. Wait a bit but keep this in mind.
                             }
                             if (part.inlineData?.data) {
                                 setStatusText("Ricezione Stream Audio AI...");
                                 const base64Audio = part.inlineData.data;
                                 const bytes = base64ToUint8Array(base64Audio);
                                 const int16Data = new Int16Array(bytes.buffer);
                                 const float32Data = new Float32Array(int16Data.length);
                                 for (let i=0; i<int16Data.length; i++) {
                                     float32Data[i] = int16Data[i] / 32768.0;
                                 }
                                 chunksRef.current.push(float32Data);
                             }
                         }
                         
                         if (chunksRef.current.length > 0) {
                             // Estimate progress roughly based on input length
                             const expectedOutputSamples = Math.floor(pcmData.length * (OUTPUT_SAMPLE_RATE / INPUT_SAMPLE_RATE));
                             const currentTotal = chunksRef.current.reduce((acc, c) => acc + c.length, 0);
                             const genPerc = Math.min(100, Math.round((currentTotal / expectedOutputSamples) * 100));
                             setGenerationProgress(genPerc);
                         }
                     }
                     if (message.serverContent?.turnComplete) {
                         console.log("Turn Complete received");
                         setStatusText("Turno Completato. Finalizzazione...");
                         if (streamTimeoutRef.current) clearTimeout(streamTimeoutRef.current);
                         if (watchdogRef.current) clearTimeout(watchdogRef.current);
                         
                         isStreamingRef.current = false;
                         sessionPromise.then(s => s.close());
                     }
                },
                onclose: () => {
                    console.log("Session closed");
                    if (streamTimeoutRef.current) clearTimeout(streamTimeoutRef.current);
                    if (watchdogRef.current) clearTimeout(watchdogRef.current);
                    finalizeOutput();
                },
                onerror: (e) => {
                    console.error("Gemini Error", e);
                    if (streamTimeoutRef.current) clearTimeout(streamTimeoutRef.current);
                    if (watchdogRef.current) clearTimeout(watchdogRef.current);
                    setErrorMsg("Connessione Interrotta dal Server.");
                    setAppState(AppState.ERROR);
                }
            }
        });
        sessionRef.current = sessionPromise;

    } catch (e) {
        console.error(e);
        setErrorMsg("Impossibile connettersi all'API Gemini.");
        setAppState(AppState.ERROR);
    }
  };

  const streamAudioToGemini = async (data: Float32Array, sessionPromise: Promise<any>) => {
      // PRECISE VAD SYNCHRONIZATION ENGINE + WATCHDOG
      
      const CHUNK_SIZE = 4096; // Optimized chunk size
      const TARGET_DURATION = (CHUNK_SIZE / 16000) * 1000; 
      
      let offset = 0;
      let startTime = performance.now();
      let chunksSent = 0;

      if (streamTimeoutRef.current) clearTimeout(streamTimeoutRef.current);

      const pushChunk = async () => {
          if (!isStreamingRef.current) return;

          // 1. End of File Handling (IMMEDIATE HANDSHAKE)
          if (offset >= data.length) {
              // CRITICAL CHANGE: Do NOT send silence loop.
              // Immediately send the trigger and STOP streaming to let the model reply.
              
              setStatusText("Invio Completato. Attesa Virtuoso...");
              
              // Start Watchdog timer: If server doesn't reply in X seconds, kill it.
              watchdogRef.current = setTimeout(handleServerTimeout, SERVER_WATCHDOG_MS);

              sessionPromise.then(session => {
                  try {
                      // Send a very explicit command to switch turns immediately
                      if (session.send) {
                        session.send({ parts: [{ text: "[INPUT ENDED] PLAY SAXOPHONE SOLO NOW." }] });
                      }
                  } catch(e) {
                      console.warn("Force trigger failed", e);
                  }
              });

              // Stop the loop completely. Do NOT schedule next pushChunk.
              streamTimeoutRef.current = null;
              return;
          }

          // 2. Normal Audio Streaming
          const percentage = Math.min(100, Math.round((offset / data.length) * 100));
          
          // Only update UI heavily every ~5% to avoid jank
          if (chunksSent % 5 === 0) {
             setProgress(percentage);
             setStatusText(`Streaming Audio: ${percentage}%`);
          }

          const end = Math.min(offset + CHUNK_SIZE, data.length);
          const chunk = data.slice(offset, end);
          
          const int16Chunk = float32ToInt16(chunk);
          const uint8 = new Uint8Array(int16Chunk.buffer);
          const base64Data = uint8ArrayToBase64(uint8);

          sessionPromise.then(session => {
              try {
                session.sendRealtimeInput({
                    media: { mimeType: 'audio/pcm;rate=16000', data: base64Data }
                });
                setBytesSent(prev => prev + uint8.byteLength);
              } catch(e) {
                  console.warn("Chunk send failed", e);
                  isStreamingRef.current = false;
              }
          });

          offset += CHUNK_SIZE;
          chunksSent++;

          // 3. Drift Correction Scheduling
          const targetTime = startTime + (chunksSent * TARGET_DURATION);
          const delay = Math.max(0, targetTime - performance.now());
          
          streamTimeoutRef.current = setTimeout(pushChunk, delay);
      };

      pushChunk();
  };

  const finalizeOutput = useCallback(async () => {
      isStreamingRef.current = false;
      
      if (chunksRef.current.length === 0) {
          // Analyze WHY it failed
          if (appState !== AppState.ERROR) { 
            setAppState(AppState.ERROR);
            // If statusText showed a text response, user already knows. Otherwise:
            setErrorMsg("Nessun audio ricevuto. Verifica che l'input non sia silenzioso o riprova.");
          }
          return;
      }
      
      const totalLength = chunksRef.current.reduce((acc, chunk) => acc + chunk.length, 0);
      const combinedBuffer = new Float32Array(totalLength);
      let offset = 0;
      chunksRef.current.forEach(chunk => {
          combinedBuffer.set(chunk, offset);
          offset += chunk.length;
      });

      if (!audioContextRef.current) return;
      try {
          const audioBuffer = audioContextRef.current.createBuffer(1, totalLength, OUTPUT_SAMPLE_RATE);
          audioBuffer.copyToChannel(combinedBuffer, 0);
          setOutputBuffer(audioBuffer);
          
          // Generate MIDI
          const generatedMidi = generateMidiFromBuffer(audioBuffer);
          if (generatedMidi) {
              setMidiBlob(generatedMidi);
          } else {
              console.warn("MIDI generation failed");
          }
          setAppState(AppState.COMPLETED);
          setStatusText("Completato");
      } catch(e) {
          setAppState(AppState.ERROR);
          setErrorMsg("Errore durante l'elaborazione dell'audio finale.");
      }
  }, [appState]);

  const playAudio = (type: 'input' | 'output') => {
      if (!audioContextRef.current) return;
      const ctx = audioContextRef.current;
      if (ctx.state === 'suspended') ctx.resume();

      if (sourceNodeRef.current) {
          sourceNodeRef.current.stop();
          sourceNodeRef.current.disconnect();
      }

      const buffer = type === 'input' ? inputBuffer : outputBuffer;
      if (!buffer) return;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      sourceNodeRef.current = source;
      
      setIsPlaying(true);
      source.onended = () => setIsPlaying(false);

      const analyser = type === 'input' ? inputAnalyserRef.current : outputAnalyserRef.current;
      const destination = analyser || ctx.destination;

      if (type === 'input') {
          source.connect(destination);
          if (analyser) analyser.connect(ctx.destination);
      } else {
          const compressor = ctx.createDynamicsCompressor();
          compressor.threshold.value = effects.compressorThreshold;
          compressorRef.current = compressor;

          const low = ctx.createBiquadFilter();
          low.type = "lowshelf";
          low.frequency.value = 320;
          low.gain.value = effects.eqLow;
          eqLowRef.current = low;

          const mid = ctx.createBiquadFilter();
          mid.type = "peaking";
          mid.frequency.value = 1000;
          mid.gain.value = effects.eqMid;
          eqMidRef.current = mid;

          const high = ctx.createBiquadFilter();
          high.type = "highshelf";
          high.frequency.value = 3200;
          high.gain.value = effects.eqHigh;
          eqHighRef.current = high;

          const convolver = ctx.createConvolver();
          convolver.buffer = createImpulseResponse(ctx, effects.reverbDecay, 2.0);
          reverbNodeRef.current = convolver;

          const dryGain = ctx.createGain();
          dryGain.gain.value = 1 - effects.reverbMix * 0.5;
          dryGainNodeRef.current = dryGain;

          const wetGain = ctx.createGain();
          wetGain.gain.value = effects.reverbMix;
          wetGainNodeRef.current = wetGain;

          const masterGain = ctx.createGain();
          masterGain.gain.value = 1.0;
          gainNodeRef.current = masterGain;

          source.connect(low);
          low.connect(mid);
          mid.connect(high);
          high.connect(compressor);

          compressor.connect(dryGain);
          compressor.connect(convolver);
          convolver.connect(wetGain);

          dryGain.connect(masterGain);
          wetGain.connect(masterGain);
          
          masterGain.connect(destination);
          if (analyser) analyser.connect(ctx.destination);
      }

      source.start();
  };

  const stopAudio = () => {
      if (sourceNodeRef.current) {
          sourceNodeRef.current.stop();
          setIsPlaying(false);
      }
  };

  const downloadOutput = () => {
    if (!outputBuffer) return;
    const wavBlob = audioBufferToWav(outputBuffer);
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName ? `virtuoso_ai_${fileName.replace(/\.[^/.]+$/, "")}.wav` : 'virtuoso_output.wav';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const downloadMidi = () => {
      if (!midiBlob) return;
      const url = URL.createObjectURL(midiBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName ? `midi_extract_${fileName.replace(/\.[^/.]+$/, "")}.mid` : 'extracted_solo.mid';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-amber-500/30">
      <header className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-amber-500 rounded-lg shadow-lg shadow-amber-500/20">
               <Music className="text-black w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Virtuoso Tone Transfer</h1>
              <p className="text-xs text-zinc-400 font-medium">AI ADAPTIVE INSTRUMENTATION</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs font-mono text-zinc-500">
             <Activity className="w-3 h-3 text-green-500" />
             SYSTEM READY
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12 space-y-12">
        
        <div className="text-center space-y-4">
            <h2 className="text-3xl md:text-5xl font-bold bg-gradient-to-br from-white to-zinc-500 bg-clip-text text-transparent">
                Arrangiamento Virtuoso AI
            </h2>
            <p className="text-zinc-400 max-w-xl mx-auto text-lg">
                Carica il tuo audio. L'IA deciderà autonomamente se generare un assolo di sax jazz o un'intera orchestra di ottoni.
            </p>
        </div>

        {errorMsg && (
            <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-4 rounded-xl flex items-center gap-3 animate-in fade-in slide-in-from-top-4">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <span className="font-medium">{errorMsg}</span>
            </div>
        )}

        <div className="grid gap-8">
            {/* Input Section */}
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-6 md:p-8 shadow-2xl">
                <div className="flex justify-between items-center mb-6">
                    <h3 className="text-lg font-semibold text-zinc-200 flex items-center gap-2">
                        <Mic2 className="w-4 h-4 text-amber-500" /> 
                        Sorgente Audio
                    </h3>
                    {fileName && <span className="text-xs px-3 py-1 bg-zinc-800 rounded-full text-zinc-400 font-mono truncate max-w-[200px]">{fileName}</span>}
                </div>

                <div className="space-y-6">
                    {!inputBuffer ? (
                         <label className="flex flex-col items-center justify-center w-full h-48 border-2 border-zinc-700 border-dashed rounded-xl cursor-pointer bg-zinc-800/30 hover:bg-zinc-800/50 hover:border-amber-500/50 transition-all group">
                            <div className="flex flex-col items-center justify-center pt-5 pb-6">
                                <Upload className="w-10 h-10 mb-3 text-zinc-500 group-hover:text-amber-500 transition-colors" />
                                <p className="mb-2 text-sm text-zinc-400"><span className="font-semibold text-zinc-200">Clicca per caricare MP3/WAV</span></p>
                            </div>
                            <input type="file" className="hidden" onChange={handleFileUpload} accept="audio/*" />
                        </label>
                    ) : (
                        <div className="space-y-4">
                            <Visualizer analyser={inputAnalyserRef.current} color="#fbbf24" isActive={true} />
                            <div className="flex gap-4">
                                <button onClick={() => playAudio('input')} className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm font-medium transition-colors">
                                    <Play className="w-4 h-4" /> Anteprima Originale
                                </button>
                                <button onClick={() => { stopAudio(); setInputBuffer(null); setOutputBuffer(null); setMidiBlob(null); setAppState(AppState.IDLE); }} className="text-zinc-500 hover:text-zinc-300 text-sm underline ml-auto">
                                    Reset
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Action Section */}
            <div className="flex flex-col items-center gap-6">
                 {appState === AppState.PROCESSING ? (
                     <div className="w-full max-w-md mx-auto space-y-6">
                         {/* Gauge 1: Input Analysis */}
                         <div className="space-y-2">
                            <div className="flex justify-between text-xs uppercase font-mono text-zinc-400 tracking-wider">
                                <span className="flex items-center gap-2">
                                    {bytesSent > 0 && <Radio className="w-3 h-3 text-red-500 animate-pulse" />}
                                    Uplink
                                </span>
                                <span>{progress}% <span className="text-zinc-600 mx-1">|</span> {(bytesSent / 1024).toFixed(0)}KB</span>
                            </div>
                            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden border border-zinc-700 relative">
                                <div 
                                    className="h-full bg-zinc-500 shadow-[0_0_10px_rgba(113,113,122,0.4)] transition-all duration-200 ease-linear"
                                    style={{ width: `${progress}%` }}
                                />
                            </div>
                         </div>

                         {/* Gauge 2: Output Generation */}
                         <div className="space-y-2">
                            <div className="flex justify-between text-xs uppercase font-mono text-amber-500 tracking-wider">
                                <span>Generazione Strumentale</span>
                                <span>{generationProgress}%</span>
                            </div>
                            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden border border-zinc-700 relative">
                                <div 
                                    className="h-full bg-amber-500 shadow-[0_0_15px_rgba(245,158,11,0.6)] transition-all duration-200 ease-linear"
                                    style={{ width: `${generationProgress}%` }}
                                />
                            </div>
                         </div>
                         
                         <div className="text-center pt-2 flex flex-col items-center gap-3">
                            <p className="text-zinc-400 text-sm animate-pulse font-mono bg-zinc-900/50 px-4 py-2 rounded-lg border border-zinc-800 min-w-[300px] flex items-center justify-center gap-2">
                                {statusText.includes("Watchdog") && <Clock className="w-3 h-3 text-red-500" />}
                                {statusText || "Connessione..."}
                            </p>
                            <button 
                                onClick={stopProcessingManual}
                                className="flex items-center gap-2 px-6 py-2 bg-red-500/20 border border-red-500/50 text-red-400 rounded-full hover:bg-red-500/30 transition-colors text-sm"
                            >
                                <StopCircle className="w-4 h-4" />
                                Stop & Finalizza
                            </button>
                         </div>
                     </div>
                 ) : (
                     <button 
                        onClick={startToneTransfer}
                        disabled={!inputBuffer || appState === AppState.COMPLETED}
                        className={`
                            group relative px-12 py-5 rounded-full font-bold text-lg transition-all shadow-xl flex items-center gap-3
                            ${!inputBuffer || appState === AppState.COMPLETED
                                ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed' 
                                : 'bg-gradient-to-r from-amber-200 to-amber-500 text-black hover:scale-105 hover:shadow-amber-500/40'
                            }
                        `}
                    >
                        <Sparkles className={`w-6 h-6 ${!inputBuffer ? 'text-zinc-600' : 'text-black animate-pulse'}`} />
                        {inputBuffer ? (appState === AppState.COMPLETED ? 'Arrangiamento Completato' : 'Genera Arrangiamento (AI Auto-Detect)') : 'Carica audio per iniziare'}
                    </button>
                 )}
            </div>

            {/* Output & Studio Rack */}
            {outputBuffer && (
                <div className="bg-gradient-to-br from-zinc-900 to-zinc-900/80 border border-amber-500/20 rounded-2xl p-6 md:p-8 shadow-2xl relative overflow-hidden animate-in fade-in slide-in-from-bottom-4">
                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-amber-500 via-yellow-300 to-amber-600"></div>
                    <div className="flex justify-between items-center mb-6">
                        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                            <Sliders className="w-4 h-4 text-amber-400" /> 
                            Virtuoso AI Output & FX Rack
                        </h3>
                    </div>

                    <Visualizer analyser={outputAnalyserRef.current} color="#10b981" isActive={true} />
                    
                    {/* MIDI Status Indicator */}
                    <div className="mt-1 mb-6 flex items-center justify-between px-4 py-3 bg-black/40 border-x border-b border-zinc-800/50 rounded-b-lg backdrop-blur-sm">
                        <div className="flex items-center gap-3">
                            <div className="flex flex-col">
                                <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-0.5">MIDI Conversion Status</span>
                                {midiBlob ? (
                                    <div className="flex items-center gap-2 text-xs font-bold text-emerald-400">
                                        <CheckCircle2 className="w-3 h-3" />
                                        MIDI GENERATED
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2 text-xs font-bold text-red-400">
                                        <XCircle className="w-3 h-3" />
                                        MIDI FAILED
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="text-right">
                             <span className="text-[10px] font-mono text-zinc-600 block">MODE: ADAPTIVE AI</span>
                             {midiBlob ? (
                                <span className="text-[10px] font-mono text-zinc-500">1 TRACK • FORMAT 0</span>
                             ) : (
                                <span className="text-[10px] font-mono text-red-500/50">
                                    COMPLEX POLYPHONY DETECTED
                                </span>
                             )}
                        </div>
                    </div>

                    {/* Knobs & Sliders */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6 bg-black/30 p-4 rounded-xl border border-zinc-800">
                         {/* EQ Section */}
                         <div className="space-y-3">
                             <p className="text-xs font-mono text-zinc-400 flex items-center gap-1"><Volume2 className="w-3 h-3"/> EQUALIZER</p>
                             <div className="space-y-2">
                                 <input type="range" min="-10" max="10" value={effects.eqLow} onChange={e => setEffects({...effects, eqLow: Number(e.target.value)})} className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-amber-500" />
                                 <input type="range" min="-10" max="10" value={effects.eqMid} onChange={e => setEffects({...effects, eqMid: Number(e.target.value)})} className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-amber-500" />
                                 <input type="range" min="-10" max="10" value={effects.eqHigh} onChange={e => setEffects({...effects, eqHigh: Number(e.target.value)})} className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-amber-500" />
                             </div>
                         </div>

                         {/* Reverb Section */}
                         <div className="space-y-3">
                             <p className="text-xs font-mono text-zinc-400">REVERB</p>
                             <div className="space-y-4 pt-2">
                                 <input type="range" min="0" max="0.8" step="0.01" value={effects.reverbMix} onChange={e => setEffects({...effects, reverbMix: Number(e.target.value)})} className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-green-500" />
                                 <input type="range" min="0.5" max="5" step="0.1" value={effects.reverbDecay} onChange={e => setEffects({...effects, reverbDecay: Number(e.target.value)})} className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-green-500" />
                             </div>
                         </div>

                         {/* Dynamics */}
                         <div className="space-y-3">
                             <p className="text-xs font-mono text-zinc-400">COMPRESSOR</p>
                             <div className="pt-2">
                                 <input type="range" min="-60" max="0" value={effects.compressorThreshold} onChange={e => setEffects({...effects, compressorThreshold: Number(e.target.value)})} className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                             </div>
                         </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                            {isPlaying ? (
                                <button onClick={stopAudio} className="flex items-center justify-center gap-2 px-4 py-3 bg-red-500 text-white hover:bg-red-600 rounded-xl font-bold transition-colors shadow-lg">
                                    Stop
                                </button>
                            ) : (
                                <button onClick={() => playAudio('output')} className="flex items-center justify-center gap-2 px-4 py-3 bg-white text-black hover:bg-zinc-200 rounded-xl font-bold transition-colors shadow-lg shadow-white/10">
                                    <Play className="w-5 h-5" /> Play AI Output
                                </button>
                            )}
                        <button onClick={downloadOutput} className="flex items-center justify-center gap-2 px-4 py-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl font-medium transition-colors border border-zinc-700">
                            <FileAudio className="w-5 h-5" /> WAV
                        </button>
                        
                        {midiBlob && (
                             <button onClick={downloadMidi} className="col-span-1 md:col-span-2 lg:col-span-1 flex items-center justify-center gap-2 px-4 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-medium transition-colors shadow-lg shadow-indigo-500/20">
                                <FileCode className="w-5 h-5" /> MIDI
                            </button>
                        )}
                    </div>
                </div>
            )}

        </div>
      </main>

      <footer className="border-t border-zinc-900 mt-12 py-8 text-center text-zinc-600 text-sm">
         <p>Powered by Gemini 2.5 Flash Live (Neural Audio) & Client-side MIDI Conversion</p>
      </footer>
    </div>
  );
};

export default App;