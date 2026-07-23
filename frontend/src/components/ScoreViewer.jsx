import { useEffect, useRef, useState } from 'react';
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { useMaistroStore } from '../store.js';

function fitSvgToContainer(container) {
  if (!container) return;

  const svgs = container.querySelectorAll('svg');

  svgs.forEach((svg) => {
    svg.style.width = '100%';
    svg.style.maxWidth = '100%';
    svg.style.height = 'auto';
    svg.style.display = 'block';
  });
}

function findCursorElement(container) {
  if (!container) return null;

  return (
    container.querySelector('.osmd-cursor') ||
    container.querySelector('[class*="cursor"]') ||
    container.querySelector('[id*="cursor"]')
  );
}

export default function ScoreViewer() {
  const containerRef = useRef(null);
  const scrollRef = useRef(null);
  const osmdRef = useRef(null);
  const beatCounterRef = useRef(0);

  const { sheet } = useMaistroStore();

  const [renderState, setRenderState] = useState('idle');
  const [renderError, setRenderError] = useState('');

  function keepCursorVisible() {
    const container = containerRef.current;
    const scrollBox = scrollRef.current;

    if (!container || !scrollBox) return;

    const cursor = findCursorElement(container);

    if (!cursor) return;

    const cursorRect = cursor.getBoundingClientRect();
    const boxRect = scrollBox.getBoundingClientRect();

    const isAbove = cursorRect.top < boxRect.top + 120;
    const isBelow = cursorRect.bottom > boxRect.bottom - 120;

    if (isAbove || isBelow) {
      cursor.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
        inline: 'nearest',
      });
    }
  }

  function resetCursor() {
    const osmd = osmdRef.current;

    if (!osmd?.cursor) return;

    beatCounterRef.current = 0;

    try {
      osmd.cursor.reset();
      osmd.cursor.show();
      keepCursorVisible();
    } catch {
      // Cursor reset can fail on invalid MusicXML. Rendering error will show separately.
    }
  }

  function moveCursorByBeat(event) {
    const osmd = osmdRef.current;

    if (!osmd?.cursor) return;

    const beatNumber = event?.detail?.beatNumber || 1;

    try {
      if (beatNumber === 1) {
        osmd.cursor.reset();
        osmd.cursor.show();
      } else {
        osmd.cursor.next();
      }

      beatCounterRef.current = beatNumber;

      setTimeout(keepCursorVisible, 30);
    } catch {
      // If the cursor reaches the end, stop moving.
    }
  }

  useEffect(() => {
    async function renderScore() {
      if (!sheet?.musicxml || !containerRef.current) return;

      setRenderState('loading');
      setRenderError('');

      try {
        containerRef.current.innerHTML = '';

        const osmd = new OpenSheetMusicDisplay(containerRef.current, {
          autoResize: true,
          backend: 'svg',
          drawTitle: true,
          drawComposer: false,
        });

        osmdRef.current = osmd;

        /*
          Keep this close to 1.0 because we are fitting the SVG to the container.
          If this is too large, the score may become cropped.
        */
        osmd.zoom = 1.0;

        await osmd.load(sheet.musicxml);
        await osmd.render();

        fitSvgToContainer(containerRef.current);

        if (osmd.cursor) {
          osmd.cursor.show();
          osmd.cursor.reset();
        }

        setRenderState('ready');
      } catch (err) {
        setRenderError(err.message || String(err));
        setRenderState('error');
      }
    }

    renderScore();
  }, [sheet?.musicxml]);

  useEffect(() => {
    window.addEventListener('maistro:practice-reset', resetCursor);
    window.addEventListener('maistro:practice-start', resetCursor);
    window.addEventListener('maistro:beat', moveCursorByBeat);

    return () => {
      window.removeEventListener('maistro:practice-reset', resetCursor);
      window.removeEventListener('maistro:practice-start', resetCursor);
      window.removeEventListener('maistro:beat', moveCursorByBeat);
    };
  }, []);

  if (!sheet) {
    return (
      <section className="rounded-2xl bg-white p-6 shadow-lg">
        <h2 className="text-xl font-semibold text-slate-900">Score Viewer</h2>
        <p className="mt-2 text-sm text-slate-600">
          Upload a beginner sheet image to render the score here.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl bg-white p-4 shadow-lg">
      <div className="mb-4 border-b border-slate-200 pb-3">
        <h2 className="text-2xl font-bold text-slate-900">Rendered Music Sheet</h2>
        <p className="text-sm text-slate-600">
          The score stays fixed on screen. During practice, the cursor follows the metronome beat and the view moves automatically when needed.
        </p>
      </div>

      {renderState === 'loading' && (
        <div className="rounded-xl bg-slate-100 p-4 text-sm text-slate-700">
          Rendering MusicXML score...
        </div>
      )}

      {renderState === 'error' && (
        <div className="rounded-xl bg-rose-100 p-4 text-sm text-rose-700">
          Score rendering failed: {renderError}
        </div>
      )}

      <div
        ref={scrollRef}
        className="h-[72vh] w-full overflow-y-auto overflow-x-hidden rounded-xl border border-slate-200 bg-white"
      >
        <div
          ref={containerRef}
          className="mx-auto min-h-[650px] w-full max-w-[1250px] p-6"
        />
      </div>

      <p className="mt-3 text-sm text-slate-500">
        No horizontal scrolling is needed. MAIstro will keep the active cursor area visible during practice.
      </p>
    </section>
  );
}