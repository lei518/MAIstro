// SCORE CURSOR VERSION: REPEAT_AWARE_V2
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { useMaistroStore } from '../store.js';
import { buildScoreTimeline } from '../utils/scoreTimeline.js';

const CURSOR_OPTIONS = {
  /*
   * OSMD's native cursor provides exact note geometry and iterator
   * timing. It is hidden visually; MAIstro draws the neon dash.
   */
  type: 0,
  color: '#2563eb',
  alpha: 0.001,
  follow: false,
};

function getCursorElement(osmd, container) {
  const directCursor = osmd?.cursor?.cursorElement;

  if (directCursor?.isConnected) {
    return directCursor;
  }

  if (!container) return null;

  return (
    container.querySelector('.osmd-cursor') ||
    container.querySelector('[id^="cursorImg"]') ||
    container.querySelector('[id*="cursor"]') ||
    container.querySelector('[class*="cursor"]')
  );
}

function hideNativeCursor(osmd, container) {
  const cursorElement = getCursorElement(osmd, container);

  if (!cursorElement) return;

  cursorElement.style.setProperty(
    'opacity',
    '0',
    'important',
  );

  cursorElement.style.setProperty(
    'background',
    'transparent',
    'important',
  );

  cursorElement.style.setProperty(
    'border',
    '0',
    'important',
  );

  cursorElement.style.setProperty(
    'box-shadow',
    'none',
    'important',
  );

  cursorElement.style.pointerEvents = 'none';
  cursorElement.style.zIndex = '80';
}

function getGraphicalNoteRect(osmd) {
  try {
    const graphicalNotes =
      osmd?.cursor?.GNotesUnderCursor?.() || [];

    const rectangles = graphicalNotes
      .map((graphicalNote) =>
        graphicalNote?.getSVGGElement?.(),
      )
      .filter((element) => element?.isConnected)
      .map((element) => element.getBoundingClientRect())
      .filter(
        (rectangle) =>
          Number.isFinite(rectangle.left) &&
          Number.isFinite(rectangle.top) &&
          rectangle.width >= 0 &&
          rectangle.height >= 0,
      );

    if (rectangles.length === 0) {
      return null;
    }

    return {
      left: Math.min(
        ...rectangles.map((rectangle) => rectangle.left),
      ),
      right: Math.max(
        ...rectangles.map((rectangle) => rectangle.right),
      ),
      top: Math.min(
        ...rectangles.map((rectangle) => rectangle.top),
      ),
      bottom: Math.max(
        ...rectangles.map((rectangle) => rectangle.bottom),
      ),
      width:
        Math.max(
          ...rectangles.map((rectangle) => rectangle.right),
        ) -
        Math.min(
          ...rectangles.map((rectangle) => rectangle.left),
        ),
      height:
        Math.max(
          ...rectangles.map((rectangle) => rectangle.bottom),
        ) -
        Math.min(
          ...rectangles.map((rectangle) => rectangle.top),
        ),
    };
  } catch {
    return null;
  }
}

function getIteratorProperty(iterator, names) {
  for (const name of names) {
    if (iterator?.[name] !== undefined) {
      return iterator[name];
    }
  }

  return undefined;
}

function iteratorReachedEnd(iterator) {
  return Boolean(
    getIteratorProperty(iterator, [
      'EndReached',
      'endReached',
    ]),
  );
}

function moveIteratorNext(iterator) {
  const move =
    iterator?.moveToNext ||
    iterator?.MoveToNext;

  if (typeof move !== 'function') {
    return false;
  }

  move.call(iterator);
  return true;
}

function getIteratorTimestampRealValue(iterator) {
  const timestamp = getIteratorProperty(iterator, [
    'currentTimeStamp',
    'CurrentTimeStamp',
  ]);

  const realValue = getIteratorProperty(timestamp, [
    'realValue',
    'RealValue',
  ]);

  const numericValue = Number(realValue);

  return Number.isFinite(numericValue)
    ? numericValue
    : null;
}

function buildOsmdCursorTimeline(osmd, beatType) {
  const sourceIterator =
    osmd?.cursor?.Iterator ||
    osmd?.cursor?.iterator;

  const iterator = sourceIterator?.clone?.();

  if (!iterator) {
    return [0];
  }

  const positions = [];
  const maximumSteps = 100000;
  let steps = 0;

  while (
    !iteratorReachedEnd(iterator) &&
    steps < maximumSteps
  ) {
    const timestampRealValue =
      getIteratorTimestampRealValue(iterator);

    if (timestampRealValue !== null) {
      /*
       * OSMD timestamps use whole-note fractions:
       * 0.25 is one quarter note.
       *
       * Multiplying by beatType converts the timestamp into the
       * denominator beat used by the metronome. For 4/4:
       * quarter = 1 beat, half = 2 beats, whole = 4 beats.
       */
      const onsetBeat =
        timestampRealValue * beatType;

      const previous =
        positions[positions.length - 1];

      if (
        previous === undefined ||
        Math.abs(onsetBeat - previous) > 0.000001
      ) {
        positions.push(onsetBeat);
      }
    }

    if (!moveIteratorNext(iterator)) {
      break;
    }

    steps += 1;
  }

  return positions.length > 0 ? positions : [0];
}

function buildPlaybackCursorTimeline(
  sourceCursorBeats,
  scoreTimeline,
) {
  const playbackSteps = [];
  const playbackMeasures =
    scoreTimeline?.measures || [];

  playbackMeasures.forEach(
    (measureOccurrence) => {
      const sourceStart =
        measureOccurrence.sourceStartBeat;

      const sourceEnd =
        measureOccurrence.sourceEndBeat;

      sourceCursorBeats.forEach(
        (sourceBeat, sourceCursorIndex) => {
          const belongsToMeasure =
            sourceBeat >=
              sourceStart - 0.000001 &&
            sourceBeat <
              sourceEnd - 0.000001;

          if (!belongsToMeasure) {
            return;
          }

          playbackSteps.push({
            playbackBeat:
              measureOccurrence.startBeat +
              (sourceBeat - sourceStart),
            sourceBeat,
            sourceCursorIndex,
            sourceMeasureIndex:
              measureOccurrence.sourceIndex,
            repeatPass:
              measureOccurrence.repeatPass || 1,
          });
        },
      );
    },
  );

  playbackSteps.sort(
    (a, b) =>
      a.playbackBeat - b.playbackBeat,
  );

  return playbackSteps.length > 0
    ? playbackSteps
    : [
        {
          playbackBeat: 0,
          sourceBeat: 0,
          sourceCursorIndex: 0,
          sourceMeasureIndex: 0,
          repeatPass: 1,
        },
      ];
}

function findCursorIndexAtBeat(
  cursorBeatTimeline,
  elapsedBeats,
) {
  let low = 0;
  let high = cursorBeatTimeline.length - 1;
  let result = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);

    const middleValue =
      typeof cursorBeatTimeline[middle] ===
      'number'
        ? cursorBeatTimeline[middle]
        : cursorBeatTimeline[middle]
            ?.playbackBeat ?? 0;

    if (
      middleValue <=
      elapsedBeats + 0.000001
    ) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return result;
}

export default function ScoreViewer() {
  const containerRef = useRef(null);
  const scrollRef = useRef(null);
  const indicatorRef = useRef(null);

  const osmdRef = useRef(null);
  const cursorIndexRef = useRef(0);
  const cursorBeatTimelineRef = useRef([0]);
  const playbackCursorTimelineRef =
    useRef([
      {
        playbackBeat: 0,
        sourceCursorIndex: 0,
      },
    ]);
  const renderIdRef = useRef(0);
  const cursorRefreshTimerRef = useRef(null);
  const cursorAnimationFrameRef = useRef(null);
  const practiceClockRef = useRef(null);
  const practiceBusyRef = useRef(false);

  const {
    sheet,
    practiceBusy,
  } = useMaistroStore();

  const scoreTimeline = useMemo(
    () => buildScoreTimeline(sheet?.musicxml),
    [sheet?.musicxml],
  );

  const [renderState, setRenderState] =
    useState('idle');

  const [renderError, setRenderError] =
    useState('');

  const [
    disclaimerAccepted,
    setDisclaimerAccepted,
  ] = useState(false);

  const needsDisclaimer =
    sheet?.omr_disclaimer_required ||
    sheet?.difficulty_label === 'Intermediate' ||
    sheet?.difficulty_label === 'Advanced';

  useEffect(() => {
    setDisclaimerAccepted(false);
    setRenderState('idle');
    setRenderError('');

    cursorIndexRef.current = 0;
    cursorBeatTimelineRef.current = [0];
    playbackCursorTimelineRef.current = [
      {
        playbackBeat: 0,
        sourceCursorIndex: 0,
      },
    ];
    practiceClockRef.current = null;
  }, [sheet?.sheet_id]);

  function cancelCursorAnimation() {
    if (cursorAnimationFrameRef.current !== null) {
      cancelAnimationFrame(
        cursorAnimationFrameRef.current,
      );

      cursorAnimationFrameRef.current = null;
    }
  }

  function syncNeonIndicator() {
    const indicator = indicatorRef.current;

    if (!practiceBusyRef.current) {
      if (indicator) {
        indicator.style.display = 'none';
      }

      return;
    }

    const scrollBox = scrollRef.current;
    const container = containerRef.current;
    const osmd = osmdRef.current;

    if (
      !scrollBox ||
      !container ||
      !indicator ||
      !osmd?.cursor
    ) {
      return;
    }

    hideNativeCursor(osmd, container);

    const noteRect =
      getGraphicalNoteRect(osmd) ||
      getCursorElement(
        osmd,
        container,
      )?.getBoundingClientRect();

    if (!noteRect) {
      indicator.style.display = 'none';
      return;
    }

    const scrollRect =
      scrollBox.getBoundingClientRect();

    const noteCenterX =
      noteRect.left -
      scrollRect.left +
      scrollBox.scrollLeft +
      noteRect.width / 2;

    const noteBottom =
      noteRect.bottom -
      scrollRect.top +
      scrollBox.scrollTop;

    const dashWidth = Math.max(
      28,
      Math.min(48, noteRect.width + 16),
    );

    const left = noteCenterX - dashWidth / 2;

    /*
     * The note SVG bounding box includes the notehead, stem, flag,
     * and beam. Ten pixels below its bottom keeps the dash outside
     * the notation instead of crossing the staff or notehead.
     */
    const top = noteBottom + 10;

    Object.assign(indicator.style, {
      display: 'block',
      left: `${Math.max(0, left)}px`,
      top: `${Math.max(0, top)}px`,
      width: `${dashWidth}px`,
      height: '5px',
    });
  }

  function keepIndicatorVisible() {
    const scrollBox = scrollRef.current;
    const indicator = indicatorRef.current;

    if (
      !scrollBox ||
      !indicator ||
      indicator.style.display === 'none'
    ) {
      return;
    }

    const indicatorRect =
      indicator.getBoundingClientRect();

    const scrollRect =
      scrollBox.getBoundingClientRect();

    const isAbove =
      indicatorRect.top < scrollRect.top + 100;

    const isBelow =
      indicatorRect.bottom > scrollRect.bottom - 100;

    if (!isAbove && !isBelow) return;

    const indicatorTopInsideBox =
      indicatorRect.top -
      scrollRect.top +
      scrollBox.scrollTop;

    scrollBox.scrollTo({
      top: Math.max(
        0,
        indicatorTopInsideBox -
          scrollBox.clientHeight / 2,
      ),
      behavior: 'smooth',
    });
  }

  function refreshCursorVisual(delay = 0) {
    if (cursorRefreshTimerRef.current) {
      window.clearTimeout(
        cursorRefreshTimerRef.current,
      );
    }

    cursorRefreshTimerRef.current =
      window.setTimeout(() => {
        const osmd = osmdRef.current;
        const container = containerRef.current;

        if (!osmd?.cursor || !container) {
          return;
        }

        hideNativeCursor(osmd, container);
        syncNeonIndicator();
        keepIndicatorVisible();
      }, delay);
  }

  function resetCursor() {
    const osmd = osmdRef.current;
    const container = containerRef.current;

    if (!osmd?.cursor || !container) {
      return;
    }

    cursorIndexRef.current = 0;

    try {
      osmd.cursor.reset();
      osmd.cursor.show();
      osmd.cursor.update();

      hideNativeCursor(osmd, container);
      syncNeonIndicator();
      refreshCursorVisual(40);
    } catch {
      // Invalid MusicXML can prevent cursor initialization.
    }
  }

  function moveCursorToIndex(targetIndex) {
    const osmd = osmdRef.current;
    const container = containerRef.current;

    if (!osmd?.cursor || !container) {
      return;
    }

    const safeTarget = Math.max(
      0,
      Math.min(
        targetIndex,
        cursorBeatTimelineRef.current.length - 1,
      ),
    );

    try {
      if (safeTarget < cursorIndexRef.current) {
        osmd.cursor.reset();
        cursorIndexRef.current = 0;
      }

      while (
        cursorIndexRef.current < safeTarget
      ) {
        osmd.cursor.next();
        cursorIndexRef.current += 1;
      }

      osmd.cursor.show();
      osmd.cursor.update();

      hideNativeCursor(osmd, container);
      syncNeonIndicator();
      refreshCursorVisual(30);
    } catch {
      // Cursor has reached the end of the rendered score.
    }
  }

  function runCursorClock() {
    const clock = practiceClockRef.current;

    if (
      !clock ||
      !clock.running ||
      !practiceBusyRef.current
    ) {
      return;
    }

    const millisecondsPerBeat =
      60000 / clock.tempo;

    const elapsedBeats = Math.min(
      clock.totalBeats,
      Math.max(
        0,
        (performance.now() -
          clock.startPerformanceMs) /
          millisecondsPerBeat,
      ),
    );

    const playbackStepIndex =
      findCursorIndexAtBeat(
        playbackCursorTimelineRef.current,
        elapsedBeats,
      );

    const targetSourceCursorIndex =
      playbackCursorTimelineRef.current[
        playbackStepIndex
      ]?.sourceCursorIndex ?? 0;

    if (
      targetSourceCursorIndex !==
      cursorIndexRef.current
    ) {
      moveCursorToIndex(
        targetSourceCursorIndex,
      );
    }

    if (elapsedBeats < clock.totalBeats) {
      cursorAnimationFrameRef.current =
        requestAnimationFrame(runCursorClock);
    }
  }

  function handlePracticeStart(event) {
    cancelCursorAnimation();

    practiceBusyRef.current = true;

    practiceClockRef.current = {
      running: true,
      startPerformanceMs:
        Number(
          event?.detail?.startPerformanceMs,
        ) || performance.now(),
      totalBeats:
        Number(event?.detail?.totalBeats) ||
        scoreTimeline.totalBeats,
      tempo:
        Number(event?.detail?.tempo) || 120,
    };

    resetCursor();

    cursorAnimationFrameRef.current =
      requestAnimationFrame(runCursorClock);
  }

  function stopCursorClock({ hideIndicator = true } = {}) {
    cancelCursorAnimation();

    if (practiceClockRef.current) {
      practiceClockRef.current.running = false;
    }

    if (hideIndicator && indicatorRef.current) {
      indicatorRef.current.style.display = 'none';
    }
  }

  useEffect(() => {
    if (
      !sheet?.musicxml ||
      !containerRef.current
    ) {
      return undefined;
    }

    if (
      needsDisclaimer &&
      !disclaimerAccepted
    ) {
      return undefined;
    }

    const container = containerRef.current;
    const renderId = renderIdRef.current + 1;

    renderIdRef.current = renderId;

    let cancelled = false;
    let osmd = null;

    /*
     * React.StrictMode runs effects twice in development.
     * A dedicated host and cleanup prevent duplicate scores.
     */
    const renderHost =
      document.createElement('div');

    renderHost.className = 'relative w-full';
    renderHost.style.width = '100%';

    container.replaceChildren(renderHost);

    osmdRef.current = null;
    cursorIndexRef.current = 0;
    cursorBeatTimelineRef.current = [0];
    playbackCursorTimelineRef.current = [
      {
        playbackBeat: 0,
        sourceCursorIndex: 0,
      },
    ];

    setRenderState('loading');
    setRenderError('');

    async function renderScore() {
      try {
        osmd = new OpenSheetMusicDisplay(
          renderHost,
          {
            autoResize: true,
            backend: 'svg',
            drawTitle: true,
            drawComposer: false,
            disableCursor: false,
            followCursor: false,
            cursorsOptions: [
              CURSOR_OPTIONS,
            ],
          },
        );

        osmd.zoom = 1.0;

        await osmd.load(sheet.musicxml);

        if (
          cancelled ||
          renderId !== renderIdRef.current ||
          !renderHost.isConnected
        ) {
          return;
        }

        await osmd.render();

        if (
          cancelled ||
          renderId !== renderIdRef.current ||
          !renderHost.isConnected
        ) {
          return;
        }

        osmdRef.current = osmd;

        if (osmd.cursor) {
          osmd.cursor.SkipInvisibleNotes = true;
          osmd.cursor.reset();
          osmd.cursor.show();
          osmd.cursor.update();

          cursorBeatTimelineRef.current =
            buildOsmdCursorTimeline(
              osmd,
              scoreTimeline.beatType,
            );

          playbackCursorTimelineRef.current =
            buildPlaybackCursorTimeline(
              cursorBeatTimelineRef.current,
              scoreTimeline,
            );

          hideNativeCursor(osmd, container);
        }

        setRenderState('ready');

        refreshCursorVisual(80);

        if (
          practiceBusyRef.current &&
          practiceClockRef.current?.running
        ) {
          cancelCursorAnimation();

          cursorAnimationFrameRef.current =
            requestAnimationFrame(runCursorClock);
        }
      } catch (error) {
        if (
          cancelled ||
          renderId !== renderIdRef.current
        ) {
          return;
        }

        setRenderError(
          error.message || String(error),
        );

        setRenderState('error');
      }
    }

    renderScore();

    return () => {
      cancelled = true;

      cancelCursorAnimation();

      if (cursorRefreshTimerRef.current) {
        window.clearTimeout(
          cursorRefreshTimerRef.current,
        );

        cursorRefreshTimerRef.current = null;
      }

      if (osmdRef.current === osmd) {
        osmdRef.current = null;
      }

      if (indicatorRef.current) {
        indicatorRef.current.style.display = 'none';
      }

      try {
        osmd?.cursor?.Dispose?.();
      } catch {
        // Cursor may already be removed.
      }

      try {
        osmd?.clear?.();
      } catch {
        // OSMD backend may already be cleared.
      }

      if (container.contains(renderHost)) {
        renderHost.remove();
      }
    };
  }, [
    sheet?.musicxml,
    needsDisclaimer,
    disclaimerAccepted,
    scoreTimeline.beatType,
  ]);

  useEffect(() => {
    practiceBusyRef.current = practiceBusy;

    if (!practiceBusy) {
      stopCursorClock({
        hideIndicator: true,
      });
    }
  }, [practiceBusy]);

  useEffect(() => {
    function handleReset() {
      resetCursor();

      if (!practiceBusyRef.current) {
        if (indicatorRef.current) {
          indicatorRef.current.style.display = 'none';
        }
      }
    }

    function handleComplete() {
      stopCursorClock({
        hideIndicator: false,
      });

      const finalPlaybackStep =
        playbackCursorTimelineRef.current[
          playbackCursorTimelineRef.current
            .length - 1
        ];

      moveCursorToIndex(
        finalPlaybackStep
          ?.sourceCursorIndex ?? 0,
      );
    }

    function handleStop() {
      practiceBusyRef.current = false;

      stopCursorClock({
        hideIndicator: true,
      });
    }

    window.addEventListener(
      'maistro:practice-reset',
      handleReset,
    );

    window.addEventListener(
      'maistro:practice-start',
      handlePracticeStart,
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
      cancelCursorAnimation();

      window.removeEventListener(
        'maistro:practice-reset',
        handleReset,
      );

      window.removeEventListener(
        'maistro:practice-start',
        handlePracticeStart,
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
  }, [scoreTimeline.totalBeats]);

  if (!sheet) {
    return (
      <section className="rounded-2xl bg-white p-6 shadow-lg">
        <h2 className="text-xl font-semibold text-slate-900">
          Score Viewer
        </h2>

        <p className="mt-2 text-sm text-slate-600">
          Upload a beginner sheet image to render the score here.
        </p>
      </section>
    );
  }

  if (
    needsDisclaimer &&
    !disclaimerAccepted
  ) {
    return (
      <section className="rounded-2xl bg-white p-6 shadow-lg">
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-6">
          <p className="mb-2 text-sm font-semibold uppercase tracking-[0.2em] text-amber-700">
            OMR Accuracy Disclaimer
          </p>

          <h2 className="mb-3 text-2xl font-bold text-amber-950">
            This sheet was classified as{' '}
            {sheet.difficulty_label}.
          </h2>

          <p className="mb-4 text-sm leading-6 text-amber-900">
            MAIstro is optimized for beginner, single-staff music
            sheets. Since this uploaded sheet was classified as{' '}
            {sheet.difficulty_label}, Audiveris may render some
            notes, rhythms, articulations, or measures less
            accurately. Please review the rendered sheet before
            starting practice.
          </p>

          {sheet.difficulty_reasons?.length > 0 && (
            <div className="mb-4 rounded-xl bg-white/70 p-4">
              <p className="mb-2 font-semibold text-amber-950">
                Why this was classified as{' '}
                {sheet.difficulty_label}:
              </p>

              <ul className="list-disc space-y-1 pl-5 text-sm text-amber-900">
                {sheet.difficulty_reasons.map(
                  (reason, index) => (
                    <li key={`${reason}-${index}`}>
                      {reason}
                    </li>
                  ),
                )}
              </ul>
            </div>
          )}

          <button
            type="button"
            onClick={() =>
              setDisclaimerAccepted(true)
            }
            className="rounded-lg bg-amber-500 px-4 py-3 font-semibold text-white hover:bg-amber-400"
          >
            I understand, render the sheet
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl bg-white p-4 shadow-lg">
      <div className="mb-4 border-b border-slate-200 pb-3">
        <h2 className="text-2xl font-bold text-slate-900">
          Rendered Music Sheet
        </h2>

        <p className="text-sm text-slate-600">
          The neon-blue dash uses the score's real note timings
          and follows MusicXML repeat instructions when they are
          present.
        </p>
      </div>

      {renderState === 'loading' && (
        <div className="mb-3 rounded-xl bg-slate-100 p-4 text-sm text-slate-700">
          Rendering MusicXML score...
        </div>
      )}

      {renderState === 'error' && (
        <div className="mb-3 rounded-xl bg-rose-100 p-4 text-sm text-rose-700">
          Score rendering failed: {renderError}
        </div>
      )}

      <div
        ref={scrollRef}
        className="relative h-[72vh] w-full overflow-y-auto overflow-x-hidden rounded-xl border border-slate-200 bg-white"
      >
        <div
          ref={containerRef}
          className="mx-auto min-h-[650px] w-full max-w-[1250px] p-6"
        />

        <div
          ref={indicatorRef}
          className="pointer-events-none absolute z-[120] hidden rounded-full bg-sky-400 shadow-[0_0_4px_rgba(56,189,248,1),0_0_10px_rgba(37,99,235,0.95),0_0_20px_rgba(37,99,235,0.8)] transition-[left,top,width] duration-75 ease-linear"
          aria-hidden="true"
        />
      </div>

      <p className="mt-3 text-sm text-slate-500">
        The dash is positioned from the active note's SVG
        bounding box, so it stays below the complete note shape.
      </p>
    </section>
  );
}
