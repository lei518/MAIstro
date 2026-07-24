import { useEffect, useMemo, useRef, useState } from 'react';
import PracticeProgress from './PracticeProgress.jsx';
import {
  buildScoreTimeline,
  getScoreStateAtBeat,
} from '../utils/scoreTimeline.js';
import {
  endSession,
  getStats,
  openPracticeSocket,
  startSession,
  uploadSheet,
} from '../api/client.js';
import { useMaistroStore } from '../store.js';

let micContext = null;
let micStream = null;
let processor = null;
let source = null;
let activeSocket = null;
let clickContext = null;
let practiceClockGeneration = 0;
const practiceTimerIds = new Set();
const scheduledClickNodes = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureClickContext() {
  if (!clickContext) {
    clickContext = new AudioContext({
      latencyHint: 'interactive',
    });
  }

  if (clickContext.state === 'suspended') {
    await clickContext.resume();
  }

  return clickContext;
}

function playClick(accent = false, scheduledTime = null) {
  if (!clickContext) return;

  const startTime = Math.max(
    scheduledTime ?? clickContext.currentTime,
    clickContext.currentTime,
  );

  const oscillator = clickContext.createOscillator();
  const gain = clickContext.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(
    accent ? 1200 : 850,
    startTime,
  );

  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(
    0.35,
    startTime + 0.01,
  );
  gain.gain.exponentialRampToValueAtTime(
    0.0001,
    startTime + 0.11,
  );

  oscillator.connect(gain);
  gain.connect(clickContext.destination);

  scheduledClickNodes.add(oscillator);

  oscillator.onended = () => {
    scheduledClickNodes.delete(oscillator);
  };

  oscillator.start(startTime);
  oscillator.stop(startTime + 0.12);
}

async function prepareMicPermission() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });

  stream.getTracks().forEach((track) => track.stop());
}

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

function stopMetronomeLoop() {
  practiceClockGeneration += 1;

  practiceTimerIds.forEach((timerId) => {
    window.clearTimeout(timerId);
  });

  practiceTimerIds.clear();

  scheduledClickNodes.forEach((oscillator) => {
    try {
      oscillator.stop();
    } catch {
      // The oscillator may already have ended.
    }
  });

  scheduledClickNodes.clear();
}

function StepBadge({ number, label, active, done }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${active
        ? 'bg-indigo-500 text-white'
        : done
          ? 'bg-emerald-500/20 text-emerald-300'
          : 'bg-slate-800 text-slate-400'
        }`}
    >
      <span>{number}</span>
      <span>{label}</span>
    </div>
  );
}

export default function Controls() {
  const inputRef = useRef(null);
  const [tempoConfirmed, setTempoConfirmed] = useState(false);
  const [countInBusy, setCountInBusy] = useState(false);
  const [countInNumber, setCountInNumber] = useState(null);

  const {
    sheet,
    session,
    tempo,
    enableMetronome,
    enableFeedback,
    uploadBusy,
    practiceBusy,
    audioSource,
    stats,
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

  const scoreTimeline = useMemo(
    () => buildScoreTimeline(sheet?.musicxml),
    [sheet?.musicxml],
  );

  const timeSignature = {
    beats: scoreTimeline.beatsPerMeasure,
    beatType: scoreTimeline.beatType,
    label: scoreTimeline.timeSignature,
    detected: scoreTimeline.totalMeasures > 0,
  };

  useEffect(() => {
    setTempoConfirmed(false);
    setCountInBusy(false);
    setCountInNumber(null);
  }, [sheet?.sheet_id]);

  useEffect(() => {
    return () => {
      stopMetronomeLoop();
      stopBrowserMic();

      if (
        activeSocket?.readyState === WebSocket.OPEN
      ) {
        activeSocket.close();
      }
    };
  }, []);

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
      setTempoConfirmed(false);
    } catch (err) {
      setError(err.response?.data?.detail?.message || err.response?.data?.detail || err.message);
    } finally {
      setUploadBusy(false);
    }
  }

  async function openBackendPracticeSession() {
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

    ws.onerror = () => {
      setError('WebSocket connection failed.');
    };

    return newSession;
  }

  function schedulePracticeEvent(
    eventName,
    detail,
    audioTime,
    generation,
  ) {
    const delayMs = Math.max(
      0,
      (audioTime - clickContext.currentTime) * 1000,
    );

    const timerId = window.setTimeout(() => {
      practiceTimerIds.delete(timerId);

      if (generation !== practiceClockGeneration) {
        return;
      }

      window.dispatchEvent(
        new CustomEvent(eventName, {
          detail,
        }),
      );
    }, delayMs);

    practiceTimerIds.add(timerId);
  }

  async function startMetronomeLoop() {
    stopMetronomeLoop();

    if (scoreTimeline.totalBeats <= 0) {
      throw new Error(
        'MAIstro could not calculate the score duration.',
      );
    }

    await ensureClickContext();

    const generation = practiceClockGeneration;
    const secondsPerBeat = 60 / tempo;
    const leadInSeconds = 0.08;

    const startAudioTime =
      clickContext.currentTime + leadInSeconds;

    const startPerformanceMs =
      performance.now() + leadInSeconds * 1000;

    const wholeBeatCount = Math.ceil(
      scoreTimeline.totalBeats - 0.000001,
    );

    for (
      let beatIndex = 0;
      beatIndex < wholeBeatCount;
      beatIndex += 1
    ) {
      const scoreBeat = beatIndex;

      const scoreState = getScoreStateAtBeat(
        scoreTimeline,
        scoreBeat,
      );

      const scheduledTime =
        startAudioTime + scoreBeat * secondsPerBeat;

      const accent = scoreState.beatInMeasure === 1;

      if (enableMetronome) {
        playClick(accent, scheduledTime);
      }

      schedulePracticeEvent(
        'maistro:beat',
        {
          beatNumber: beatIndex + 1,
          elapsedBeats: scoreBeat,
          beatInMeasure: scoreState.beatInMeasure,
          beatsPerMeasure: scoreState.beatsPerMeasure,
          measureNumber: scoreState.measureNumber,
          tempo,
        },
        scheduledTime,
        generation,
      );
    }

    const completionAudioTime =
      startAudioTime +
      scoreTimeline.totalBeats * secondsPerBeat;

    schedulePracticeEvent(
      'maistro:score-complete',
      {
        totalBeats: scoreTimeline.totalBeats,
        tempo,
      },
      completionAudioTime,
      generation,
    );

    return {
      startAudioTime,
      startPerformanceMs,
      totalBeats: scoreTimeline.totalBeats,
      tempo,
      beatType: scoreTimeline.beatType,
      timeSignature: scoreTimeline.timeSignature,
    };
  }

  async function onStartWithCountIn() {
    if (!sheet?.sheet_id) {
      setError('Upload and convert a beginner sheet first.');
      return;
    }

    if (!tempoConfirmed) {
      setError('Confirm the tempo first before starting practice.');
      return;
    }

    setError('');
    resetPractice();

    try {
      await ensureClickContext();

      if (audioSource === 'browser') {
        await prepareMicPermission();
      }

      setCountInBusy(true);

      const intervalMs = 60000 / tempo;
      const countBeats = timeSignature.beats || 4;

      window.dispatchEvent(new CustomEvent('maistro:practice-reset'));

      for (let i = 1; i <= countBeats; i += 1) {
        setCountInNumber(i);
        playClick(i === 1);

        window.dispatchEvent(
          new CustomEvent('maistro:count-in', {
            detail: {
              count: i,
              total: countBeats,
              timeSignature: timeSignature.label,
              tempo,
            },
          })
        );

        await sleep(intervalMs);
      }

      setCountInNumber(null);
      setCountInBusy(false);

      await openBackendPracticeSession();

      setPracticeBusy(true);

      const practiceClock = await startMetronomeLoop();

      window.dispatchEvent(
        new CustomEvent('maistro:practice-start', {
          detail: practiceClock,
        }),
      );
    } catch (err) {
      setCountInBusy(false);
      setPracticeBusy(false);
      setError(err.response?.data?.detail || err.message);
    }
  }

  async function onEnd() {
    if (!session?.session_id) return;

    setError('');

    try {
      stopMetronomeLoop();
      window.dispatchEvent(new CustomEvent('maistro:practice-stop'));

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

  function onChangeSheet() {
    if (practiceBusy || countInBusy) {
      setError('End the current practice session before uploading another sheet.');
      return;
    }

    stopMetronomeLoop();
    window.dispatchEvent(new CustomEvent('maistro:practice-reset'));

    setTempoConfirmed(false);
    setSheet(null);
    setSession(null);
    setStats(null);
    resetPractice();
  }

  function onChangeTempo() {
    if (practiceBusy || countInBusy) {
      setError('End the current practice session before changing tempo.');
      return;
    }

    setTempoConfirmed(false);
    setSession(null);
    setStats(null);
    resetPractice();
    window.dispatchEvent(new CustomEvent('maistro:practice-reset'));
  }

  if (!sheet) {
    return (
      <section className="rounded-2xl bg-slate-900/80 p-5 shadow-lg">
        <div className="mb-4 flex flex-wrap gap-2">
          <StepBadge number="1" label="Upload" active />
          <StepBadge number="2" label="Tempo" />
          <StepBadge number="3" label="Practice" />
        </div>

        <h2 className="mb-2 text-2xl font-semibold text-white">Upload Music Sheet</h2>

        <p className="mb-4 text-sm text-slate-300">
          Upload a clean beginner sheet image. MAIstro will preprocess it, send it to Audiveris,
          and convert it into MusicXML.
        </p>

        <div className="rounded-xl border border-slate-700 p-4">
          <label className="mb-2 block text-sm font-medium text-slate-300">
            PNG/JPG image only
          </label>

          <input
            ref={inputRef}
            type="file"
            accept=".png,.jpg,.jpeg,image/png,image/jpeg"
            className="mb-3 block w-full text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-500 file:px-3 file:py-2 file:text-white"
          />

          <button
            onClick={onUpload}
            disabled={uploadBusy}
            className="w-full rounded-lg bg-indigo-500 px-4 py-3 font-semibold text-white hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {uploadBusy ? 'Converting with Audiveris...' : 'Upload and Convert Sheet'}
          </button>
        </div>

        <div className="mt-4 rounded-xl bg-slate-950/50 p-3 text-sm text-slate-400">
          Recommended: beginner single-staff melody, no chords, no lyrics, no piano grand staff,
          and not handwritten.
        </div>
      </section>
    );
  }

  if (countInBusy) {
    return (
      <section className="rounded-2xl bg-slate-900/80 p-5 shadow-lg">
        <div className="mb-4 flex flex-wrap gap-2">
          <StepBadge number="1" label="Upload" done />
          <StepBadge number="2" label="Tempo" done />
          <StepBadge number="3" label="Practice" active />
        </div>

        <h2 className="mb-4 text-2xl font-semibold text-white">Count-In</h2>

        <div className="rounded-2xl bg-indigo-500/10 p-6 text-center">
          <p className="text-sm text-indigo-200">
            {timeSignature.label} time at {tempo} BPM
          </p>

          <p className="my-4 text-7xl font-bold text-white">
            {countInNumber}
          </p>

          <p className="text-sm text-indigo-200">
            Practice starts after {timeSignature.beats} clicks.
          </p>
        </div>
      </section>
    );
  }

  if (practiceBusy) {
    return (
      <section className="rounded-2xl bg-slate-900/80 p-5 shadow-lg">
        <div className="mb-4 flex flex-wrap gap-2">
          <StepBadge number="1" label="Upload" done />
          <StepBadge number="2" label="Tempo" done />
          <StepBadge number="3" label="Practice" active />
        </div>

        <h2 className="mb-2 text-2xl font-semibold text-white">Practice Running</h2>

        <p className="mb-4 text-sm text-slate-300">
          Follow the score cursor and play with the metronome.
        </p>

        <PracticeProgress />

        <div className="mb-4 rounded-xl border border-slate-700 p-4 text-sm text-slate-300">
          <p>
            <span className="text-slate-500">Tempo:</span> {tempo} BPM
          </p>
          <p>
            <span className="text-slate-500">Time signature:</span> {timeSignature.label}
          </p>
          <p>
            <span className="text-slate-500">Metronome:</span> {enableMetronome ? 'Enabled' : 'Disabled'}
          </p>
          <p>
            <span className="text-slate-500">Feedback:</span> {enableFeedback ? 'Enabled' : 'Disabled'}
          </p>
        </div>

        <button
          onClick={onEnd}
          disabled={!session}
          className="w-full rounded-lg bg-rose-500 px-4 py-3 font-semibold text-white hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          End Practice
        </button>
      </section>
    );
  }

  if (!tempoConfirmed) {
    return (
      <section className="rounded-2xl bg-slate-900/80 p-5 shadow-lg">
        <div className="mb-4 flex flex-wrap gap-2">
          <StepBadge number="1" label="Upload" done />
          <StepBadge number="2" label="Tempo" active />
          <StepBadge number="3" label="Practice" />
        </div>

        <h2 className="mb-2 text-2xl font-semibold text-white">Set Practice Tempo</h2>

        <p className="mb-4 text-sm text-slate-300">
          MAIstro detected the time signature as{' '}
          <span className="font-semibold text-white">{timeSignature.label}</span>.
          After confirming tempo, the system will count{' '}
          <span className="font-semibold text-white">{timeSignature.beats}</span> beats before practice starts.
        </p>

        <div className="rounded-xl border border-slate-700 p-4">
          <div className="mb-4 rounded-xl bg-indigo-500/10 p-4 text-center">
            <p className="text-sm text-indigo-200">Selected Tempo</p>
            <p className="text-5xl font-bold text-white">{tempo}</p>
            <p className="text-sm text-indigo-200">BPM</p>
          </div>

          <input
            type="range"
            min="40"
            max="200"
            value={tempo}
            onChange={(e) => setTempo(Number(e.target.value))}
            className="w-full"
          />

          <div className="mt-2 flex justify-between text-xs text-slate-500">
            <span>40 BPM</span>
            <span>200 BPM</span>
          </div>

          <button
            onClick={() => setTempoConfirmed(true)}
            className="mt-4 w-full rounded-lg bg-indigo-500 px-4 py-3 font-semibold text-white hover:bg-indigo-400"
          >
            Confirm Tempo
          </button>

          <button
            onClick={onChangeSheet}
            className="mt-3 w-full rounded-lg bg-slate-700 px-4 py-3 font-semibold text-white hover:bg-slate-600"
          >
            Change Sheet
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl bg-slate-900/80 p-5 shadow-lg">
      <div className="mb-4 flex flex-wrap gap-2">
        <StepBadge number="1" label="Upload" done />
        <StepBadge number="2" label="Tempo" done />
        <StepBadge number="3" label="Practice" active />
      </div>

      <h2 className="mb-2 text-2xl font-semibold text-white">Ready to Practice</h2>

      <p className="mb-4 text-sm text-slate-300">
        Press Start Practice. MAIstro will count {timeSignature.beats} beats in {timeSignature.label} time,
        then practice will begin.
      </p>

      {scoreTimeline.hasRecognizedRepeats && (
        <div className="mb-4 rounded-xl border border-sky-400/30 bg-sky-500/10 p-3 text-sm text-sky-200">
          MAIstro found {scoreTimeline.totalRepeatCount}{' '}
          repeat section
          {scoreTimeline.totalRepeatCount === 1 ? '' : 's'}.
          The metronome, progress bar, and score cursor will follow
          the repeated playback order.
          {scoreTimeline.inferredRepeatCount > 0 && (
            <>
              {' '}
              {scoreTimeline.inferredRepeatCount} closing repeat
              {scoreTimeline.inferredRepeatCount === 1 ? ' was' : 's were'} inferred
              from an unmatched forward repeat and a final heavy barline.
            </>
          )}
        </div>
      )}

      {!scoreTimeline.hasRecognizedRepeats &&
        scoreTimeline.doubleBarMeasures.length > 0 && (
          <div className="mb-4 rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-200">
            A plain double barline was detected at measure{' '}
            {scoreTimeline.doubleBarMeasures.join(', ')}, but the
            MusicXML contains no repeat instruction. A double
            barline separates sections; it does not automatically
            repeat them. If the source image has repeat dots,
            Audiveris did not recognize them.
          </div>
        )}

      <div className="mb-4 rounded-xl border border-slate-700 p-4 text-sm text-slate-300">
        <p className="mb-2">
          <span className="text-slate-500">Confirmed tempo:</span>{' '}
          <span className="font-semibold text-white">{tempo} BPM</span>
        </p>

        <p className="mb-3">
          <span className="text-slate-500">Detected time signature:</span>{' '}
          <span className="font-semibold text-white">{timeSignature.label}</span>
        </p>

        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={enableMetronome}
              onChange={(e) => setEnableMetronome(e.target.checked)}
            />
            Enable metronome during practice
          </label>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={enableFeedback}
              onChange={(e) => setEnableFeedback(e.target.checked)}
            />
            Enable feedback
          </label>
        </div>
      </div>

      <button
        onClick={onStartWithCountIn}
        className="w-full rounded-lg bg-emerald-500 px-4 py-3 font-semibold text-white hover:bg-emerald-400"
      >
        Start Practice
      </button>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <button
          onClick={onChangeTempo}
          className="rounded-lg bg-slate-700 px-4 py-3 font-semibold text-white hover:bg-slate-600"
        >
          Change Tempo
        </button>

        <button
          onClick={onChangeSheet}
          className="rounded-lg bg-slate-700 px-4 py-3 font-semibold text-white hover:bg-slate-600"
        >
          Change Sheet
        </button>
      </div>

      {stats && (
        <div className="mt-4 rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-200">
          Previous session saved. You may start another practice session using the same sheet.
        </div>
      )}
    </section>
  );
}
