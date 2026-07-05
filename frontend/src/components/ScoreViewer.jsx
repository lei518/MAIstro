import { useEffect, useRef, useState } from 'react';
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { useMaistroStore } from '../store.js';

export default function ScoreViewer() {
  const containerRef = useRef(null);
  const osmdRef = useRef(null);
  const [renderError, setRenderError] = useState('');
  const { sheet, currentNoteIndex, mistakes } = useMaistroStore();
  const notes = sheet?.notes || [];
  const mistakeIndexes = new Set(mistakes.map((m) => m.note_index));

  useEffect(() => {
    let cancelled = false;
    async function renderScore() {
      setRenderError('');
      if (!sheet?.musicxml || !containerRef.current) return;
      containerRef.current.innerHTML = '';
      try {
        const osmd = new OpenSheetMusicDisplay(containerRef.current, {
          autoResize: true,
          drawTitle: true,
          followCursor: true,
          drawingParameters: 'compacttight',
        });
        osmdRef.current = osmd;
        await osmd.load(sheet.musicxml);
        if (cancelled) return;
        osmd.render();
        if (osmd.cursor) osmd.cursor.show();
      } catch (err) {
        setRenderError(err.message || 'OSMD could not render the MusicXML.');
      }
    }
    renderScore();
    return () => { cancelled = true; };
  }, [sheet?.sheet_id]);

  useEffect(() => {
    const osmd = osmdRef.current;
    if (!osmd?.cursor || currentNoteIndex == null) return;
    try {
      osmd.cursor.show();
      // OSMD cursors advance by rendered timestamps, not direct database note IDs.
      // The note timeline below is the exact index-based feedback overlay used by MAIstro.
    } catch (_) {
      // Cursor movement failure should not stop practice feedback.
    }
  }, [currentNoteIndex]);

  return (
    <section className="rounded-2xl bg-white p-4 text-slate-900 shadow-lg">
      <div className="mb-3 flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Score Viewer</h2>
          <p className="text-sm text-slate-500">MusicXML rendered by OpenSheetMusicDisplay. Red note boxes show detected pitch mistakes.</p>
        </div>
        {sheet && <span className="rounded-full bg-slate-100 px-3 py-1 text-sm">{sheet.filename}</span>}
      </div>
      {!sheet && <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-500">Upload a sheet to render the score.</div>}
      {renderError && <div className="mb-3 rounded-lg bg-rose-100 p-3 text-sm text-rose-700">{renderError}</div>}
      <div ref={containerRef} className="score-box max-h-[520px] overflow-auto rounded-xl border border-slate-200 bg-white p-3" />

      {notes.length > 0 && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="mb-2 flex items-center justify-between text-sm text-slate-600">
            <span>Practice note timeline</span>
            <span>Current note: {currentNoteIndex ?? '--'}</span>
          </div>
          <div className="flex max-h-32 flex-wrap gap-2 overflow-auto">
            {notes.slice(0, 240).map((n) => {
              const isCurrent = n.index === currentNoteIndex;
              const isMistake = mistakeIndexes.has(n.index);
              const cls = isMistake
                ? 'border-rose-600 bg-rose-500 text-white'
                : isCurrent
                  ? 'border-amber-500 bg-amber-100 text-amber-900'
                  : n.is_rest
                    ? 'border-slate-300 bg-slate-200 text-slate-500'
                    : 'border-slate-300 bg-white text-slate-700';
              return (
                <span key={n.index} className={`rounded-lg border px-2 py-1 text-xs font-semibold ${cls}`} title={`Measure ${n.measure ?? '?'} • ${n.name}`}>
                  {n.index}:{n.name}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
