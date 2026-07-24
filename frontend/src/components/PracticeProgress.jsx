import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useMaistroStore } from '../store.js';
import {
  buildScoreTimeline,
  getScoreStateAtBeat,
} from '../utils/scoreTimeline.js';

function formatTime(seconds) {
  const safeSeconds = Number.isFinite(seconds)
    ? Math.max(0, Math.round(seconds))
    : 0;

  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;

  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

export default function PracticeProgress() {
  const {
    sheet,
    tempo,
    practiceBusy,
  } = useMaistroStore();

  const animationFrameRef = useRef(null);
  const clockRef = useRef(null);

  const [elapsedBeats, setElapsedBeats] = useState(0);
  const [beatInMeasure, setBeatInMeasure] = useState(0);
  const [scoreComplete, setScoreComplete] = useState(false);

  const timeline = useMemo(
    () => buildScoreTimeline(sheet?.musicxml),
    [sheet?.musicxml],
  );

  function cancelAnimation() {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }

  function resetProgress() {
    cancelAnimation();
    clockRef.current = null;
    setElapsedBeats(0);
    setBeatInMeasure(0);
    setScoreComplete(false);
  }

  useEffect(() => {
    resetProgress();
  }, [sheet?.sheet_id]);

  useEffect(() => {
    function animateProgress() {
      const clock = clockRef.current;

      if (!clock) return;

      const millisecondsPerBeat = 60000 / clock.tempo;

      const nextElapsedBeats = Math.min(
        clock.totalBeats,
        Math.max(
          0,
          (performance.now() - clock.startPerformanceMs) /
            millisecondsPerBeat,
        ),
      );

      setElapsedBeats(nextElapsedBeats);

      const scoreState = getScoreStateAtBeat(
        timeline,
        nextElapsedBeats,
      );

      setBeatInMeasure(scoreState.beatInMeasure);

      if (
        nextElapsedBeats < clock.totalBeats &&
        clock.running
      ) {
        animationFrameRef.current =
          requestAnimationFrame(animateProgress);
      }
    }

    function handlePracticeStart(event) {
      cancelAnimation();

      const totalBeats =
        Number(event?.detail?.totalBeats) ||
        timeline.totalBeats;

      const eventTempo =
        Number(event?.detail?.tempo) || tempo;

      const startPerformanceMs =
        Number(event?.detail?.startPerformanceMs) ||
        performance.now();

      clockRef.current = {
        running: true,
        totalBeats,
        tempo: eventTempo,
        startPerformanceMs,
      };

      setElapsedBeats(0);
      setScoreComplete(false);

      animationFrameRef.current =
        requestAnimationFrame(animateProgress);
    }

    function handleBeat(event) {
      const nextBeatInMeasure =
        Number(event?.detail?.beatInMeasure) || 0;

      setBeatInMeasure(nextBeatInMeasure);
    }

    function handleComplete(event) {
      cancelAnimation();

      const completedTotal =
        Number(event?.detail?.totalBeats) ||
        timeline.totalBeats;

      setElapsedBeats(completedTotal);
      setScoreComplete(true);

      if (clockRef.current) {
        clockRef.current.running = false;
      }
    }

    function handleStop() {
      cancelAnimation();

      if (clockRef.current) {
        clockRef.current.running = false;
      }
    }

    window.addEventListener(
      'maistro:practice-reset',
      resetProgress,
    );

    window.addEventListener(
      'maistro:practice-start',
      handlePracticeStart,
    );

    window.addEventListener(
      'maistro:beat',
      handleBeat,
    );

    window.addEventListener(
      'maistro:score-complete',
      handleComplete,
    );

    window.addEventListener(
      'maistro:practice-stop',
      handleStop,
    );

    return () => {
      cancelAnimation();

      window.removeEventListener(
        'maistro:practice-reset',
        resetProgress,
      );

      window.removeEventListener(
        'maistro:practice-start',
        handlePracticeStart,
      );

      window.removeEventListener(
        'maistro:beat',
        handleBeat,
      );

      window.removeEventListener(
        'maistro:score-complete',
        handleComplete,
      );

      window.removeEventListener(
        'maistro:practice-stop',
        handleStop,
      );
    };
  }, [timeline, tempo]);

  const totalBeats = timeline.totalBeats;

  const clampedElapsedBeats = Math.min(
    elapsedBeats,
    totalBeats,
  );

  const progress =
    totalBeats > 0
      ? Math.min(
          100,
          (clampedElapsedBeats / totalBeats) * 100,
        )
      : 0;

  const scoreState = getScoreStateAtBeat(
    timeline,
    clampedElapsedBeats,
  );

  const secondsPerBeat =
    tempo > 0 ? 60 / tempo : 0;

  const elapsedSeconds =
    clampedElapsedBeats * secondsPerBeat;

  const totalSeconds =
    totalBeats * secondsPerBeat;

  const displayedBeatInMeasure =
    beatInMeasure || scoreState.beatInMeasure;

  return (
    <section
      className="mb-4 rounded-2xl border border-indigo-400/30 bg-slate-950/50 p-4"
      aria-label="Practice progress"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-white">
            Practice Progress
          </h3>

          <p
            className="text-sm text-slate-400"
            aria-live="polite"
          >
            {scoreComplete
              ? 'You reached the end of the score.'
              : practiceBusy
                ? `Measure ${scoreState.measureNumber} of ${timeline.totalMeasures}`
                : 'Practice has not started.'}
          </p>
        </div>

        <div className="text-right">
          <p className="text-2xl font-bold text-white">
            {Math.round(progress)}%
          </p>

          <p className="text-xs text-slate-400">
            {formatTime(elapsedSeconds)}
            {' / '}
            {formatTime(totalSeconds)}
          </p>
        </div>
      </div>

      <div
        className="relative my-2"
        role="progressbar"
        aria-label="Score progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
      >
        <div className="h-4 overflow-hidden rounded-full bg-slate-800">
          <div
            className="h-full rounded-full bg-indigo-500 transition-[width] duration-75 ease-linear"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div
          className="pointer-events-none absolute top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-white bg-indigo-500 shadow-lg transition-[left] duration-75 ease-linear"
          style={{
            left: `${Math.min(
              99,
              Math.max(1, progress),
            )}%`,
          }}
          aria-hidden="true"
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex gap-2">
          {Array.from(
            { length: scoreState.beatsPerMeasure },
            (_, index) => index + 1,
          ).map((beat) => {
            const active =
              practiceBusy &&
              !scoreComplete &&
              beat === displayedBeatInMeasure;

            return (
              <span
                key={beat}
                className={[
                  'flex h-9 w-9 items-center justify-center rounded-full border',
                  'text-sm font-bold transition-transform duration-100',
                  active
                    ? 'scale-110 border-indigo-300 bg-indigo-500 text-white'
                    : 'border-slate-600 bg-slate-800 text-slate-400',
                ].join(' ')}
              >
                {beat}
              </span>
            );
          })}
        </div>

        <div className="text-right text-sm text-slate-400">
          <p>
            Beat{' '}
            <span className="font-semibold text-white">
              {displayedBeatInMeasure || '—'}
            </span>
            {' / '}
            {scoreState.beatsPerMeasure}
          </p>

          <p>
            {timeline.timeSignature}
            {' • '}
            <span className="font-semibold text-white">
              {tempo} BPM
            </span>
          </p>

          <p className="text-xs text-slate-500">
            Score beat {clampedElapsedBeats.toFixed(1)}
            {' / '}
            {totalBeats.toFixed(1)}
          </p>
        </div>
      </div>

      {totalBeats === 0 && (
        <p className="mt-3 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-200">
          MAIstro could not calculate the score duration from this
          MusicXML file.
        </p>
      )}
    </section>
  );
}
