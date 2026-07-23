import { useEffect } from 'react';
import Header from './components/Header.jsx';
import Controls from './components/Controls.jsx';
import ScoreViewer from './components/ScoreViewer.jsx';
import FeedbackOverlay from './components/FeedbackOverlay.jsx';
import { getHealth } from './api/client.js';
import { useMaistroStore } from './store.js';

function SheetMetadataCard() {
  const { sheet } = useMaistroStore();

  if (!sheet) return null;

  return (
    <section className="rounded-2xl bg-slate-900/80 p-4 shadow-lg">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Uploaded Sheet</h2>
          <p className="text-sm text-slate-400">
            Converted by Audiveris and ready for practice setup.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm text-slate-300 md:grid-cols-4">
          <div className="rounded-xl border border-slate-700 p-3">
            <p className="text-slate-500">File</p>
            <p className="max-w-[180px] truncate font-semibold text-white">
              {sheet.filename}
            </p>
          </div>

          <div className="rounded-xl border border-slate-700 p-3">
            <p className="text-slate-500">Notes</p>
            <p className="font-semibold text-white">{sheet.notes_count}</p>
          </div>

          <div className="rounded-xl border border-slate-700 p-3">
            <p className="text-slate-500">Duration</p>
            <p className="font-semibold text-white">
              {sheet.duration_seconds.toFixed(1)} s
            </p>
          </div>

          <div className="rounded-xl border border-slate-700 p-3">
            <p className="text-slate-500">Difficulty</p>
            <p className="font-semibold text-white">
              {sheet.difficulty_label || 'Beginner'}
            </p>
            <p className="text-xs text-slate-400">
              {sheet.estimated_grade || `${(sheet.difficulty_score * 100).toFixed(0)}%`}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function App() {
  const {
    sheet,
    session,
    practiceBusy,
    stats,
    setHealth,
    setError,
  } = useMaistroStore();

  useEffect(() => {
    async function loadHealth() {
      try {
        setHealth(await getHealth());
      } catch (err) {
        setError(`Backend health check failed: ${err.message}`);
      }
    }

    loadHealth();

    const id = setInterval(loadHealth, 5000);

    return () => clearInterval(id);
  }, [setHealth, setError]);

  const isWelcomeStep = !sheet;
  const shouldShowFeedback = practiceBusy || session || stats;

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 p-4">
      <div className="mx-auto flex max-w-[1700px] flex-col gap-4">
        <Header />

        {isWelcomeStep ? (
          <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-6 py-8 lg:grid-cols-[1fr_430px]">
            <section className="flex flex-col justify-center rounded-3xl bg-slate-900/80 p-8 shadow-lg">
              <p className="mb-3 text-sm font-semibold uppercase tracking-[0.3em] text-indigo-300">
                Welcome to MAIstro
              </p>

              <h1 className="mb-4 text-4xl font-bold leading-tight text-white md:text-5xl">
                Upload a beginner music sheet to start your AI-assisted practice.
              </h1>

              <p className="mb-6 max-w-2xl text-slate-300">
                MAIstro converts a beginner-friendly printed sheet image into MusicXML using Audiveris.
                After the sheet is rendered, you will set the tempo before starting guided practice.
              </p>

              <div className="grid grid-cols-1 gap-3 text-sm text-slate-300 md:grid-cols-3">
                <div className="rounded-2xl border border-slate-700 bg-slate-950/40 p-4">
                  <p className="font-semibold text-white">1. Upload</p>
                  <p>PNG or JPG beginner sheet only.</p>
                </div>

                <div className="rounded-2xl border border-slate-700 bg-slate-950/40 p-4">
                  <p className="font-semibold text-white">2. Set Tempo</p>
                  <p>Choose the practice speed.</p>
                </div>

                <div className="rounded-2xl border border-slate-700 bg-slate-950/40 p-4">
                  <p className="font-semibold text-white">3. Practice</p>
                  <p>Start playing with guided feedback.</p>
                </div>
              </div>
            </section>

            <Controls />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <SheetMetadataCard />

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_390px]">
              <div className="min-w-0">
                <ScoreViewer />
              </div>

              <div className="space-y-4">
                <Controls />

                {shouldShowFeedback ? (
                  <FeedbackOverlay />
                ) : (
                  <section className="rounded-2xl bg-slate-900/80 p-4 shadow-lg">
                    <h2 className="mb-3 text-xl font-semibold text-white">
                      Next Step
                    </h2>
                    <p className="text-sm text-slate-300">
                      Review the rendered sheet, set the tempo, then start practice.
                    </p>
                  </section>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}