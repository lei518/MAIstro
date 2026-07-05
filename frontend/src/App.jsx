import { useEffect } from 'react';
import Header from './components/Header.jsx';
import Controls from './components/Controls.jsx';
import ScoreViewer from './components/ScoreViewer.jsx';
import Metronome from './components/Metronome.jsx';
import FeedbackOverlay from './components/FeedbackOverlay.jsx';
import { getHealth } from './api/client.js';
import { useMaistroStore } from './store.js';

export default function App() {
  const { sheet, setHealth, setError } = useMaistroStore();

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
  }, []);

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 p-4">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <Header />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_1fr_360px]">
          <div className="space-y-4">
            <Controls />
            <Metronome />
            {sheet && (
              <section className="rounded-2xl bg-slate-900/80 p-4 shadow-lg">
                <h2 className="mb-3 text-xl font-semibold text-white">Sheet Metadata</h2>
                <div className="space-y-2 text-sm text-slate-300">
                  <p><span className="text-slate-500">ID:</span> {sheet.sheet_id.slice(0, 8)}</p>
                  <p><span className="text-slate-500">Notes:</span> {sheet.notes_count}</p>
                  <p><span className="text-slate-500">Duration:</span> {sheet.duration_seconds.toFixed(1)} s @ 120 BPM</p>
                  <p><span className="text-slate-500">Difficulty:</span> {(sheet.difficulty_score * 100).toFixed(0)}%</p>
                </div>
              </section>
            )}
          </div>
          <ScoreViewer />
          <FeedbackOverlay />
        </div>
      </div>
    </main>
  );
}
