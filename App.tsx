import React, { useState, useRef, useEffect, useCallback } from 'react';
import { AppState } from './types';
import { Visualizer } from './components/Visualizer';
import { resampleBuffer, float32ToInt16, audioBufferToWav, base64ToUint8Array, uint8ArrayToBase64 } from './services/audioUtils';
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { Upload, Play, Square, Download, Music, Activity, Mic2, AlertCircle } from 'lucide-react';

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [inputBuffer, setInputBuffer] = useState<AudioBuffer | null>(null);
  const [outputBuffer, setOutputBuffer] = useState<AudioBuffer | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  // Audio Context Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const inputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  
  // Processing Refs
  const sessionRef = useRef<any>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const isProcessingRef = useRef<boolean>(false);

  // Initialize Audio Contexts
  useEffect(() => {
    audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: OUTPUT_SAMPLE_RATE // Prefer output rate for main context
    });
    inputAnalyserRef.current = audioContextRef.current.createAnalyser();
    outputAnalyserRef.current = audioContextRef.current.createAnalyser();
    
    inputAnalyserRef.current.fftSize = 256;
    outputAnalyserRef.current.fftSize = 256;

    return () => {
      audioContextRef.current?.close();
    };
  }, []);

  // Handle File Upload
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setFileName(file.name);
    setAppState(AppState.IDLE);
    setOutputBuffer(null);
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
      setErrorMsg("Failed to decode audio file. Please try a valid WAV or MP3.");
      setAppState(AppState.ERROR);
    }
  };

  // Core Logic: Tone Transfer via Gemini Live
  const startToneTransfer = async () => {
    if (!inputBuffer || !process.env.API_KEY) {
      if (!process.env.API_KEY) setErrorMsg("API Key is missing.");
      return;
    }

    setAppState(AppState.PROCESSING);
    chunksRef.current = [];
    isProcessingRef.current = true;

    const client = new GoogleGenAI({ apiKey: process.env.API_KEY });

    // 1. Prepare Input Audio (Resample to 16kHz for Gemini Input)
    const pcmBuffer = await resampleBuffer(inputBuffer, INPUT_SAMPLE_RATE);
    const pcmData = pcmBuffer.getChannelData(0); // Mono
    
    // 2. Connect to Gemini Live
    // Use a promise wrapper to handle the connection and stream logic
    try {
        const sessionPromise = client.live.connect({
            model: 'gemini-2.5-flash-native-audio-preview-09-2025',
            config: {
                responseModalities: [Modality.AUDIO],
                systemInstruction: `
                    You are a world-class virtuoso musical arranger. 
                    TASK: Listen to the incoming audio stream, which is a guitar solo.
                    ACTION: Instantly reproduce the exact melody, phrasing, and dynamics using a **Saxophone** voice.
                    STYLE: Expressive, jazz-influenced, breathy, with realistic vibrato.
                    CONSTRAINT: Do not speak. Do not output words. Only output the musical transformation.
                `,
            },
            callbacks: {
                onopen: async () => {
                    console.log("Gemini Live Connected");
                    // Start streaming audio chunks
                    await streamAudioToGemini(pcmData, sessionPromise);
                },
                onmessage: async (message: LiveServerMessage) => {
                     const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
                     if (base64Audio) {
                         const bytes = base64ToUint8Array(base64Audio);
                         // Decode PCM data (Int16 -> Float32)
                         const int16Data = new Int16Array(bytes.buffer);
                         const float32Data = new Float32Array(int16Data.length);
                         for (let i=0; i<int16Data.length; i++) {
                             float32Data[i] = int16Data[i] / 32768.0;
                         }
                         chunksRef.current.push(float32Data);
                     }
                     
                     if (message.serverContent?.turnComplete) {
                         console.log("Turn complete");
                     }
                },
                onclose: () => {
                    console.log("Connection Closed");
                    finalizeOutput();
                },
                onerror: (e) => {
                    console.error("Gemini Error", e);
                    setErrorMsg("Stream error occurred.");
                    setAppState(AppState.ERROR);
                }
            }
        });
        
        sessionRef.current = sessionPromise;

    } catch (e) {
        console.error(e);
        setErrorMsg("Failed to connect to Gemini API.");
        setAppState(AppState.ERROR);
    }
  };

  // Stream audio in real-time-ish chunks to simulate a live feed
  const streamAudioToGemini = async (data: Float32Array, sessionPromise: Promise<any>) => {
      const CHUNK_SIZE = 4096; // Samples per chunk
      // 16000 samples per second. 4096 samples is approx 256ms.
      // We need to throttle sending to match playback speed roughly, otherwise we flood the socket.
      const intervalTime = (CHUNK_SIZE / INPUT_SAMPLE_RATE) * 1000; 
      
      let offset = 0;

      const intervalId = setInterval(async () => {
          if (offset >= data.length || !isProcessingRef.current) {
              clearInterval(intervalId);
              // End of stream signal? We just close the session after a brief delay to let response finish
              setTimeout(() => {
                   sessionPromise.then(s => s.close());
              }, 2000);
              return;
          }

          const end = Math.min(offset + CHUNK_SIZE, data.length);
          const chunk = data.slice(offset, end);
          const int16Chunk = float32ToInt16(chunk);
          
          // Create Blob/Base64 for the chunk
          // Gemini Live expects raw PCM bytes in base64, wrapped in JSON
          const uint8 = new Uint8Array(int16Chunk.buffer);
          const base64Data = uint8ArrayToBase64(uint8);

          sessionPromise.then(session => {
              session.sendRealtimeInput({
                  media: {
                      mimeType: 'audio/pcm;rate=16000',
                      data: base64Data
                  }
              });
          });

          // Also visualize input locally
          if (audioContextRef.current && inputAnalyserRef.current) {
             // This is a rough visualization hack since we aren't playing the input audibly during processing
             // Ideally we create a buffer source and play it, but to keep it simple we just trust the user waits.
          }

          offset += CHUNK_SIZE;
      }, intervalTime);
  };

  const finalizeOutput = useCallback(async () => {
      if (chunksRef.current.length === 0) {
          setAppState(AppState.ERROR);
          setErrorMsg("No audio generated.");
          return;
      }

      // Flatten chunks into single buffer
      const totalLength = chunksRef.current.reduce((acc, chunk) => acc + chunk.length, 0);
      const combinedBuffer = new Float32Array(totalLength);
      let offset = 0;
      chunksRef.current.forEach(chunk => {
          combinedBuffer.set(chunk, offset);
          offset += chunk.length;
      });

      if (!audioContextRef.current) return;

      // Create AudioBuffer
      const audioBuffer = audioContextRef.current.createBuffer(1, totalLength, OUTPUT_SAMPLE_RATE);
      audioBuffer.copyToChannel(combinedBuffer, 0);

      setOutputBuffer(audioBuffer);
      setAppState(AppState.COMPLETED);
      isProcessingRef.current = false;
  }, []);


  // Playback Handling
  const playAudio = (type: 'input' | 'output') => {
      if (!audioContextRef.current) return;
      const buffer = type === 'input' ? inputBuffer : outputBuffer;
      if (!buffer) return;

      const source = audioContextRef.current.createBufferSource();
      source.buffer = buffer;
      
      const analyser = type === 'input' ? inputAnalyserRef.current : outputAnalyserRef.current;
      if (analyser) {
          source.connect(analyser);
          analyser.connect(audioContextRef.current.destination);
      } else {
          source.connect(audioContextRef.current.destination);
      }

      source.start();
  };

  const downloadOutput = () => {
      if (!outputBuffer) return;
      const blob = audioBufferToWav(outputBuffer);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `virtuoso_sax_${fileName.replace(/\.[^/.]+$/, "")}.wav`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-amber-500/30">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-amber-500 rounded-lg shadow-lg shadow-amber-500/20">
               <Music className="text-black w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Virtuoso Tone Transfer</h1>
              <p className="text-xs text-zinc-400 font-medium">GUITAR TO SAXOPHONE • GEMINI LIVE ENGINE</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs font-mono text-zinc-500">
             <Activity className="w-3 h-3 text-green-500" />
             SYSTEM READY
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12 space-y-12">
        
        {/* Intro / Instructions */}
        <div className="text-center space-y-4">
            <h2 className="text-3xl md:text-5xl font-bold bg-gradient-to-br from-white to-zinc-500 bg-clip-text text-transparent">
                Reimagine your riffs.
            </h2>
            <p className="text-zinc-400 max-w-xl mx-auto text-lg">
                Upload a clean guitar solo. Our AI arranger listens and performs it back on a saxophone, capturing every nuance.
            </p>
        </div>

        {/* Error Banner */}
        {errorMsg && (
            <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-4 rounded-xl flex items-center gap-3">
                <AlertCircle className="w-5 h-5" />
                {errorMsg}
            </div>
        )}

        {/* Main Studio Interface */}
        <div className="grid gap-8">
            
            {/* Input Section */}
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-6 md:p-8 shadow-2xl transition-all hover:border-zinc-700">
                <div className="flex justify-between items-center mb-6">
                    <h3 className="text-lg font-semibold text-zinc-200 flex items-center gap-2">
                        <Mic2 className="w-4 h-4 text-amber-500" /> 
                        Input Source
                    </h3>
                    {fileName && <span className="text-xs px-3 py-1 bg-zinc-800 rounded-full text-zinc-400 font-mono truncate max-w-[200px]">{fileName}</span>}
                </div>

                <div className="space-y-6">
                    {/* Upload Area */}
                    {!inputBuffer ? (
                         <label className="flex flex-col items-center justify-center w-full h-48 border-2 border-zinc-700 border-dashed rounded-xl cursor-pointer bg-zinc-800/30 hover:bg-zinc-800/50 hover:border-amber-500/50 transition-all group">
                            <div className="flex flex-col items-center justify-center pt-5 pb-6">
                                <Upload className="w-10 h-10 mb-3 text-zinc-500 group-hover:text-amber-500 transition-colors" />
                                <p className="mb-2 text-sm text-zinc-400"><span className="font-semibold text-zinc-200">Click to upload</span> or drag and drop</p>
                                <p className="text-xs text-zinc-500">WAV, MP3 (Solo Guitar Recommended)</p>
                            </div>
                            <input type="file" className="hidden" onChange={handleFileUpload} accept="audio/*" />
                        </label>
                    ) : (
                        <div className="space-y-4">
                            <Visualizer analyser={inputAnalyserRef.current} color="#fbbf24" isActive={true} />
                            <div className="flex gap-4">
                                <button onClick={() => playAudio('input')} className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm font-medium transition-colors">
                                    <Play className="w-4 h-4" /> Preview Input
                                </button>
                                <button onClick={() => { setInputBuffer(null); setOutputBuffer(null); setAppState(AppState.IDLE); }} className="text-zinc-500 hover:text-zinc-300 text-sm underline ml-auto">
                                    Replace File
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Action Area */}
            <div className="flex justify-center">
                 {appState === AppState.PROCESSING ? (
                     <div className="flex flex-col items-center gap-3 animate-pulse">
                         <div className="w-16 h-16 rounded-full bg-amber-500/20 flex items-center justify-center border-2 border-amber-500/50">
                             <Activity className="w-8 h-8 text-amber-500 animate-spin" />
                         </div>
                         <p className="text-amber-500 font-mono text-sm">ARRANGING...</p>
                     </div>
                 ) : (
                    <button 
                        onClick={startToneTransfer}
                        disabled={!inputBuffer || appState === AppState.PROCESSING}
                        className={`
                            group relative px-8 py-4 rounded-full font-bold text-lg transition-all shadow-xl
                            ${!inputBuffer 
                                ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed' 
                                : 'bg-amber-500 text-zinc-950 hover:bg-amber-400 hover:scale-105 hover:shadow-amber-500/30'
                            }
                        `}
                    >
                        Transform to Saxophone
                        {inputBuffer && <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full animate-ping" />}
                    </button>
                 )}
            </div>

            {/* Output Section */}
            {outputBuffer && (
                <div className="bg-gradient-to-br from-zinc-900 to-zinc-900/80 border border-amber-500/20 rounded-2xl p-6 md:p-8 shadow-2xl relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-amber-500 via-yellow-300 to-amber-600"></div>
                    <div className="flex justify-between items-center mb-6">
                        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                            <Music className="w-4 h-4 text-amber-400" /> 
                            Saxophone Output
                        </h3>
                        <span className="text-xs font-mono text-amber-500 border border-amber-500/30 px-2 py-1 rounded bg-amber-500/10">GENERATED</span>
                    </div>

                    <div className="space-y-6">
                        <Visualizer analyser={outputAnalyserRef.current} color="#10b981" isActive={true} />
                        <div className="flex flex-wrap gap-4">
                             <button onClick={() => playAudio('output')} className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-white text-black hover:bg-zinc-200 rounded-xl font-bold transition-colors shadow-lg shadow-white/10">
                                <Play className="w-5 h-5" /> Play Result
                            </button>
                            <button onClick={downloadOutput} className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl font-medium transition-colors border border-zinc-700">
                                <Download className="w-5 h-5" /> Download WAV
                            </button>
                        </div>
                    </div>
                </div>
            )}

        </div>
      </main>

      <footer className="border-t border-zinc-900 mt-12 py-8 text-center text-zinc-600 text-sm">
         <p>Powered by Google Gemini 2.5 Flash Live API</p>
      </footer>
    </div>
  );
};

export default App;
