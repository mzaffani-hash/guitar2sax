
import React, { useState, useRef, useEffect } from 'react';
import { AppState, AudioEffects, InstrumentType } from './types';
import { Visualizer } from './components/Visualizer';
import { 
    trimSilence, 
    audioBufferToWav, 
    createImpulseResponse, 
    extractNotesFromBuffer,
    renderLocalSaxophoneSolo,
    renderLocalViolinSolo,
    renderLocalPianoSolo,
    createMidiBlobFromNotes
} from './services/audioUtils';
import { Upload, Play, Music, Activity, Mic2, AlertCircle, Sliders, Volume2, FileAudio, FileCode, CheckCircle2, XCircle, Sparkles, Cpu, Wand2, Piano, Guitar } from 'lucide-react';

// Changed to standard 44.1kHz to prevent timing/speed mismatches on most devices
const OUTPUT_SAMPLE_RATE = 44100;

const DEFAULT_EFFECTS: AudioEffects = {
    reverbMix: 0.3,
    reverbDecay: 2.5,
    eqLow: 3,    
    eqMid: 0,
    eqHigh: -2,  
    compressorThreshold: -24
};

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [inputBuffer, setInputBuffer] = useState<AudioBuffer | null>(null);
  const [outputBuffer, setOutputBuffer] = useState<AudioBuffer | null>(null);
  const [midiBlob, setMidiBlob] = useState<Blob | null>(null); 
  const [fileName, setFileName] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const [statusText, setStatusText] = useState<string>(""); 
  const [selectedInstrument, setSelectedInstrument] = useState<InstrumentType>('sax');
  // Track which instrument was last used to generate the output
  const [generatedInstrument, setGeneratedInstrument] = useState<InstrumentType | null>(null);
  
  const [effects, setEffects] = useState<AudioEffects>(DEFAULT_EFFECTS);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const inputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const reverbNodeRef = useRef<ConvolverNode | null>(null);
  const wetGainNodeRef = useRef<GainNode | null>(null);
  const dryGainNodeRef = useRef<GainNode | null>(null);
  const eqLowRef = useRef<BiquadFilterNode | null>(null);
  const eqMidRef = useRef<BiquadFilterNode | null>(null);
  const eqHighRef = useRef<BiquadFilterNode | null>(null);
  const compressorRef = useRef<DynamicsCompressorNode | null>(null);

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
    };
  }, []);

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
    setGeneratedInstrument(null);
    setProgress(0);

    try {
      const arrayBuffer = await file.arrayBuffer();
      if (!audioContextRef.current) return;
      
      const decodedBuffer = await audioContextRef.current.decodeAudioData(arrayBuffer);
      const trimmedBuffer = trimSilence(decodedBuffer, audioContextRef.current);
      
      setInputBuffer(trimmedBuffer);
      setAppState(AppState.READY);
      setErrorMsg(null);
      if (trimmedBuffer.length < decodedBuffer.length) {
        setStatusText("Audio ottimizzato (silenzio rimosso)");
      }
    } catch (err) {
      console.error(err);
      setErrorMsg("Impossibile decodificare il file audio. Usa un file WAV o MP3 valido.");
      setAppState(AppState.ERROR);
    }
  };

  const generateTestAudio = async () => {
    if (!audioContextRef.current) return;
    const sampleRate = audioContextRef.current.sampleRate;
    const duration = 4; 
    
    const offlineCtx = new OfflineAudioContext(1, sampleRate * duration, sampleRate);
    const notes = [196.00, 233.08, 261.63, 277.18, 293.66, 349.23, 392.00]; 
    const startTime = 0.5;
    const noteDuration = 0.4; 
    
    notes.forEach((freq, i) => {
        const osc = offlineCtx.createOscillator();
        const gain = offlineCtx.createGain();
        osc.type = 'sawtooth'; 
        osc.frequency.value = freq;
        osc.connect(gain);
        gain.connect(offlineCtx.destination);
        const time = startTime + (i * noteDuration);
        osc.start(time);
        osc.stop(time + noteDuration);
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.6, time + 0.02); 
        gain.gain.exponentialRampToValueAtTime(0.4, time + 0.1);
        gain.gain.setValueAtTime(0.4, time + noteDuration - 0.05); 
        gain.gain.exponentialRampToValueAtTime(0.001, time + noteDuration);
    });
    
    const buffer = await offlineCtx.startRendering();
    setInputBuffer(buffer);
    setFileName("Synthesized_Blues_Demo.wav");
    setAppState(AppState.READY);
    setErrorMsg(null);
    setStatusText("Input di Test Generato Correttamente");
  };

  const startToneTransfer = async () => {
    if (!inputBuffer) return;
    
    // Use the currently selected instrument
    const targetInstrument = selectedInstrument;

    setAppState(AppState.PROCESSING);
    setMidiBlob(null);
    setErrorMsg(null);
    stopAudio();
    
    setStatusText("Analisi Dinamica & Estrazione Note...");
    setProgress(15);
    
    setTimeout(async () => {
        try {
            if (!audioContextRef.current) throw new Error("Audio Context lost");
            
            // 1. Extract Notes with improved velocity detection
            const notes = extractNotesFromBuffer(inputBuffer);
            setStatusText(`Sintesi High-Fidelity (${targetInstrument.toUpperCase()})...`);
            setProgress(50);

            // 2. Synthesize Locally based on selection
            let synthBuffer: AudioBuffer;
            
            // Short delay to allow UI to paint progress
            await new Promise(r => setTimeout(r, 100));

            switch (targetInstrument) {
                case 'violin':
                    synthBuffer = await renderLocalViolinSolo(notes, OUTPUT_SAMPLE_RATE, inputBuffer.duration);
                    break;
                case 'piano':
                    synthBuffer = await renderLocalPianoSolo(notes, OUTPUT_SAMPLE_RATE, inputBuffer.duration);
                    break;
                case 'sax':
                default:
                    synthBuffer = await renderLocalSaxophoneSolo(notes, OUTPUT_SAMPLE_RATE, inputBuffer.duration);
                    break;
            }
            
            setOutputBuffer(synthBuffer);
            setGeneratedInstrument(targetInstrument);

            // 3. Generate Meta (MIDI)
            const generatedMidi = createMidiBlobFromNotes(notes, `Virtuoso ${targetInstrument}`);
            setMidiBlob(generatedMidi || null);

            setProgress(100);
            setAppState(AppState.COMPLETED);
            setStatusText("Elaborazione Completata");

        } catch (e) {
            console.error(e);
            setErrorMsg("Errore durante la sintesi locale.");
            setAppState(AppState.ERROR);
        }
    }, 100); // Allow UI update
  };

  const handleInstrumentChange = (inst: InstrumentType) => {
      // Simply update the selection state. 
      // The user must click the main button to apply changes.
      setSelectedInstrument(inst);
  };

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
    a.download = fileName ? `virtuoso_${selectedInstrument}_${fileName.replace(/\.[^/.]+$/, "")}.wav` : `virtuoso_${selectedInstrument}.wav`;
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

  // Determine button text state
  const isRegeneration = appState === AppState.COMPLETED;
  const isDifferentInstrument = isRegeneration && selectedInstrument !== generatedInstrument;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">
      <header className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-500 rounded-lg shadow-lg shadow-emerald-500/20">
               <Music className="text-black w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Virtuoso Tone Transfer</h1>
              <p className="text-xs text-zinc-400 font-medium">LOCAL BROWSER SYNTHESIS (44.1kHz)</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs font-mono text-zinc-500">
             <Activity className="w-3 h-3 text-green-500" />
             ENGINE READY
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12 space-y-12">
        
        <div className="text-center space-y-4">
            <h2 className="text-3xl md:text-5xl font-bold bg-gradient-to-br from-white to-zinc-500 bg-clip-text text-transparent">
                Arrangiamento Virtuoso
            </h2>
            <p className="text-zinc-400 max-w-xl mx-auto text-lg">
                Trasforma il tuo assolo di chitarra in <span className="text-emerald-400 font-semibold">Sax, Violino o Piano</span> usando il motore di sintesi integrato.
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
                        <Mic2 className="w-4 h-4 text-emerald-500" /> 
                        Sorgente Audio
                    </h3>
                    {fileName && <span className="text-xs px-3 py-1 bg-zinc-800 rounded-full text-zinc-400 font-mono truncate max-w-[200px]">{fileName}</span>}
                </div>

                <div className="space-y-6">
                    {!inputBuffer ? (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <label className="flex flex-col items-center justify-center w-full h-48 border-2 border-zinc-700 border-dashed rounded-xl cursor-pointer bg-zinc-800/30 hover:bg-zinc-800/50 hover:border-emerald-500/50 transition-all group relative overflow-hidden">
                                <div className="flex flex-col items-center justify-center pt-5 pb-6 relative z-10">
                                    <Upload className="w-10 h-10 mb-3 text-zinc-500 group-hover:text-emerald-500 transition-colors" />
                                    <p className="mb-2 text-sm text-zinc-400 text-center"><span className="font-semibold text-zinc-200">Clicca per caricare</span><br/>(Auto-Trim Silenzio)</p>
                                </div>
                                <input type="file" className="hidden" onChange={handleFileUpload} accept="audio/*" />
                            </label>

                            <button 
                                onClick={generateTestAudio}
                                className="flex flex-col items-center justify-center w-full h-48 border-2 border-zinc-700/50 border-dashed rounded-xl cursor-pointer bg-gradient-to-br from-indigo-900/20 to-zinc-800/30 hover:from-indigo-900/40 hover:to-zinc-800/50 hover:border-indigo-500/50 transition-all group text-zinc-400 hover:text-indigo-300"
                            >
                                <Wand2 className="w-10 h-10 mb-3 text-indigo-500/70 group-hover:text-indigo-400 transition-colors" />
                                <p className="text-sm font-semibold">Non hai un file?</p>
                                <p className="text-xs opacity-70 mt-1">Genera Esempio Virtuoso (Debug)</p>
                            </button>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <Visualizer analyser={inputAnalyserRef.current} color="#10b981" isActive={true} />
                            <div className="flex gap-4 justify-between items-center">
                                <button onClick={() => playAudio('input')} className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm font-medium transition-colors">
                                    <Play className="w-4 h-4" /> Anteprima Originale
                                </button>
                                <button onClick={() => { stopAudio(); setInputBuffer(null); setOutputBuffer(null); setMidiBlob(null); setAppState(AppState.IDLE); }} className="text-zinc-500 hover:text-zinc-300 text-sm underline">
                                    Carica Altro / Reset
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Instrument Selection & Action Section */}
            <div className="flex flex-col items-center gap-8">
                 
                 {/* Instrument Selector */}
                 <div className="bg-zinc-900/80 p-1.5 rounded-full border border-zinc-800 inline-flex relative">
                    {(['sax', 'piano', 'violin'] as InstrumentType[]).map((inst) => (
                        <button
                            key={inst}
                            onClick={() => handleInstrumentChange(inst)}
                            className={`
                                relative z-10 flex items-center gap-2 px-6 py-2 rounded-full text-sm font-bold transition-all
                                ${selectedInstrument === inst 
                                    ? 'bg-zinc-800 text-white shadow-md ring-1 ring-emerald-500/50' 
                                    : 'text-zinc-500 hover:text-zinc-300'
                                }
                            `}
                        >
                            {inst === 'sax' && <Music className="w-4 h-4" />}
                            {inst === 'piano' && <Piano className="w-4 h-4" />}
                            {inst === 'violin' && <Guitar className="w-4 h-4" />}
                            {inst.charAt(0).toUpperCase() + inst.slice(1)}
                        </button>
                    ))}
                 </div>

                 {appState === AppState.PROCESSING ? (
                     <div className="w-full max-w-md mx-auto space-y-6">
                         {/* Processing Gauge */}
                         <div className="space-y-2">
                            <div className="flex justify-between text-xs uppercase font-mono text-emerald-500 tracking-wider">
                                <span className="flex items-center gap-2">
                                     <Cpu className="w-3 h-3 animate-pulse" /> Processing
                                </span>
                                <span>{progress}%</span>
                            </div>
                            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden border border-zinc-700 relative">
                                <div 
                                    className="h-full bg-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.6)] transition-all duration-200 ease-linear"
                                    style={{ width: `${progress}%` }}
                                />
                            </div>
                         </div>
                         
                         <div className="text-center pt-2">
                            <p className="text-zinc-400 text-sm animate-pulse font-mono">
                                {statusText || "Elaborazione..."}
                            </p>
                         </div>
                     </div>
                 ) : (
                     <button 
                        onClick={startToneTransfer}
                        disabled={!inputBuffer || appState === AppState.PROCESSING}
                        className={`
                            group relative px-12 py-5 rounded-full font-bold text-lg transition-all shadow-xl flex items-center gap-3
                            ${!inputBuffer || appState === AppState.PROCESSING
                                ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed' 
                                : isDifferentInstrument 
                                    ? 'bg-gradient-to-r from-amber-400 to-amber-600 text-black hover:scale-105 hover:shadow-amber-500/40'
                                    : 'bg-gradient-to-r from-emerald-400 to-emerald-600 text-black hover:scale-105 hover:shadow-emerald-500/40'
                            }
                        `}
                    >
                        <Sparkles className={`w-6 h-6 ${!inputBuffer ? 'text-zinc-600' : 'text-black animate-pulse'}`} />
                        {inputBuffer 
                            ? (isRegeneration 
                                ? `Rigenera come ${selectedInstrument.charAt(0).toUpperCase() + selectedInstrument.slice(1)}` 
                                : `Sintetizza ${selectedInstrument.charAt(0).toUpperCase() + selectedInstrument.slice(1)}`) 
                            : 'Carica audio per iniziare'}
                    </button>
                 )}
            </div>

            {/* Output & Studio Rack */}
            {outputBuffer && (
                <div className="bg-gradient-to-br from-zinc-900 to-zinc-900/80 border border-emerald-500/20 rounded-2xl p-6 md:p-8 shadow-2xl relative overflow-hidden animate-in fade-in slide-in-from-bottom-4">
                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-emerald-500 via-green-300 to-emerald-600"></div>
                    <div className="flex justify-between items-center mb-6">
                        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                            <Sliders className="w-4 h-4 text-emerald-400" /> 
                            Virtuoso {generatedInstrument ? generatedInstrument.charAt(0).toUpperCase() + generatedInstrument.slice(1) : ''} Rack
                        </h3>
                    </div>

                    <Visualizer analyser={outputAnalyserRef.current} color="#10b981" isActive={true} />
                    
                    {/* MIDI Status */}
                    <div className="mt-1 mb-6 flex items-center justify-between px-4 py-3 bg-black/40 border-x border-b border-zinc-800/50 rounded-b-lg backdrop-blur-sm">
                        <div className="flex items-center gap-3">
                            <div className="flex flex-col">
                                <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-0.5">Conversion Status</span>
                                {midiBlob ? (
                                    <div className="flex items-center gap-2 text-xs font-bold text-emerald-400">
                                        <CheckCircle2 className="w-3 h-3" />
                                        MIDI READY
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
                             <span className="text-[10px] font-mono text-zinc-500">AUDIO + MIDI</span>
                        </div>
                    </div>

                    {/* Knobs & Sliders */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6 bg-black/30 p-4 rounded-xl border border-zinc-800">
                         {/* EQ Section */}
                         <div className="space-y-3">
                             <p className="text-xs font-mono text-zinc-400 flex items-center gap-1"><Volume2 className="w-3 h-3"/> EQUALIZER</p>
                             <div className="space-y-2">
                                 <input type="range" min="-10" max="10" value={effects.eqLow} onChange={e => setEffects({...effects, eqLow: Number(e.target.value)})} className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-emerald-500" />
                                 <input type="range" min="-10" max="10" value={effects.eqMid} onChange={e => setEffects({...effects, eqMid: Number(e.target.value)})} className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-emerald-500" />
                                 <input type="range" min="-10" max="10" value={effects.eqHigh} onChange={e => setEffects({...effects, eqHigh: Number(e.target.value)})} className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-emerald-500" />
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
                                    <Play className="w-5 h-5" /> Play Output
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
         <p>Powered by Local Virtuoso Synth Engine</p>
      </footer>
    </div>
  );
};

export default App;
