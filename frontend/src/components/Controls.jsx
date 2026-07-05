import { useRef } from 'react';
import { endSession, getStats, openPracticeSocket, startSession, uploadSheet } from '../api/client.js';
import { useMaistroStore } from '../store.js';

let micContext = null;
let micStream = null;
let processor = null;
let source = null;
let activeSocket = null;

async function startBrowserMic(ws) {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });
  micContext = new AudioContext({ latencyHint: 'interactive' });
  source = micContext.createMediaStreamSource(micStream);
  processor = micContext.createScriptProcessor(2048, 1, 1);
  processor.onaudioprocess = (event) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const input = event.inputBuffer.getChannelData(0);
    ws.send(JSON.stringify({
      type: 'audio_frame',
      sample_rate: micContext.sampleRate,
      audio: Array.from(input),
    }));
  };
  source.connect(processor);
  processor.connect(micContext.destination);
}

function stopBrowserMic() {
  if (processor) processor.disconnect();
  if (source) source.disconnect();
  if (micStream) micStream.getTracks().forEach((track) => track.stop());
  if (micContext) micContext.close();
  micContext = null;
  micStream = null;
  processor = null;
  source = null;
}

export default function Controls() {
  const inputRef = useRef(null);
  const {
    sheet,
    session,
    tempo,
    enableMetronome,
    enableFeedback,
    uploadBusy,
    practiceBusy,
    audioSource,
    setTempo,
    setEnableMetronome,
    setEnableFeedback,
    setSheet,
    setSession,
    setStats,
    setWsStatus,
    setError,
    setUploadBusy,
    setPracticeBusy,
    setLatestPitch,
    addMistake,
    resetPractice,
  } = useMaistroStore();

  async function onUpload() {
    const file = inputRef.current?.files?.[0];

    if (!file) {
      setError('Choose a PNG or JPG sheet image first.');
      return;
    }

    const allowedTypes = ['image/png', 'image/jpeg'];
    const allowedExtensions = ['.png', '.jpg', '.jpeg'];
    const filename = file.name.toLowerCase();
    const hasAllowedExtension = allowedExtensions.some((ext) => filename.endsWith(ext));

    if (!allowedTypes.includes(file.type) || !hasAllowedExtension) {
      setError('Invalid file. Please upload a PNG or JPG image only.');
      inputRef.current.value = '';
      return;
    }

    setUploadBusy(true);
    setError('');

    try {
      const uploaded = await uploadSheet(file);
      setSheet(uploaded);
    } catch (err) {
      setError(err.response?.data?.detail?.message || err.response?.data?.detail || err.message);
    } finally {
      setUploadBusy(false);
    }
  }

  async function onStart() {
    if (!sheet?.sheet_id) {
      setError('Upload and convert a sheet first.');
      return;
    }
    setPracticeBusy(true);
    setError('');
    resetPractice();
    try {
      const newSession = await startSession({
        sheet_id: sheet.sheet_id,
        tempo,
        enable_metronome: enableMetronome,
        enable_feedback: enableFeedback,
      });
      setSession(newSession);
      const ws = openPracticeSocket(newSession.session_id);
      activeSocket = ws;
      setWsStatus('connecting');
      ws.onopen = async () => {
        setWsStatus('connected');
        if (audioSource === 'browser') {
          await startBrowserMic(ws);
        }
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'pitch_update') setLatestPitch(msg);
        if (msg.type === 'mistake') addMistake(msg);
        if (msg.type === 'error') setError(msg.message || msg.code);
      };
      ws.onclose = () => {
        setWsStatus('disconnected');
        stopBrowserMic();
      };
      ws.onerror = () => setError('WebSocket connection failed.');
    } catch (err) {
      setError(err.response?.data?.detail || err.message);
      setPracticeBusy(false);
    }
  }

  async function onEnd() {
    if (!session?.session_id) return;
    setError('');
    try {
      if (activeSocket?.readyState === WebSocket.OPEN) {
        activeSocket.send(JSON.stringify({ type: 'end' }));
        activeSocket.close();
      }
      stopBrowserMic();
      const ended = await endSession(session.session_id);
      const fullStats = await getStats(session.session_id);
      setStats({ ...fullStats, ...ended });
    } catch (err) {
      setError(err.response?.data?.detail || err.message);
    } finally {
      setPracticeBusy(false);
      setWsStatus('disconnected');
    }
  }

  return (
    <section className="rounded-2xl bg-slate-900/80 p-4 shadow-lg">
      <h2 className="mb-3 text-xl font-semibold text-white">Controls</h2>
      <div className="space-y-4">
        <div className="rounded-xl border border-slate-700 p-3">
          <label className="mb-2 block text-sm font-medium text-slate-300">1. Upload PNG/JPG sheet</label>
          <input
            ref={inputRef}
            type="file"
            accept=".png,.jpg,.jpeg,image/png,image/jpeg"
            className="mb-3 block w-full text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-500 file:px-3 file:py-2 file:text-white"
          />
          <button onClick={onUpload} disabled={uploadBusy || practiceBusy} className="rounded-lg bg-indigo-500 px-4 py-2 font-semibold text-white hover:bg-indigo-400">
            {uploadBusy ? 'Converting with Audiveris...' : 'Upload + Convert'}
          </button>
        </div>

        <div className="rounded-xl border border-slate-700 p-3">
          <label className="mb-2 block text-sm font-medium text-slate-300">Tempo: {tempo} BPM</label>
          <input type="range" min="40" max="200" value={tempo} onChange={(e) => setTempo(Number(e.target.value))} className="w-full" />
          <div className="mt-3 flex flex-col gap-2 text-sm text-slate-300">
            <label><input type="checkbox" checked={enableMetronome} onChange={(e) => setEnableMetronome(e.target.checked)} /> Enable metronome</label>
            <label><input type="checkbox" checked={enableFeedback} onChange={(e) => setEnableFeedback(e.target.checked)} /> Enable feedback</label>
            <span className="text-slate-400">Audio source: {audioSource}</span>
          </div>
        </div>

        <div className="flex gap-3">
          <button onClick={onStart} disabled={!sheet || practiceBusy} className="flex-1 rounded-lg bg-emerald-500 px-4 py-2 font-semibold text-white hover:bg-emerald-400">Start Practice</button>
          <button onClick={onEnd} disabled={!session || !practiceBusy} className="flex-1 rounded-lg bg-rose-500 px-4 py-2 font-semibold text-white hover:bg-rose-400">End Practice</button>
        </div>
      </div>
    </section>
  );
}
