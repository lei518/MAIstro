import { useMaistroStore } from '../store.js';

function pct(value) {
  if (value == null || Number.isNaN(value)) return '--';
  return `${Math.round(value * 100)}%`;
}

function statusFromPitch(latestPitch) {
  if (!latestPitch?.frequency) {
    return {
      label: 'Waiting for sound',
      cls: 'bg-slate-700 text-slate-300',
      helper: 'Start practice and play your instrument.',
    };
  }

  if (!latestPitch?.expected_freq) {
    return {
      label: 'Listening',
      cls: 'bg-sky-500/20 text-sky-300',
      helper: 'Pitch detected. Waiting for the current target note.',
    };
  }

  if (latestPitch?.is_correct === true) {
    return {
      label: 'Correct',
      cls: 'bg-emerald-500/20 text-emerald-300',
      helper: 'Your pitch matches the target note.',
    };
  }

  if (latestPitch?.is_correct === false && latestPitch?.pitch_direction === 'high') {
    return {
      label: 'Too high',
      cls: 'bg-rose-500/20 text-rose-300',
      helper: 'Lower your pitch slightly.',
    };
  }

  if (latestPitch?.is_correct === false && latestPitch?.pitch_direction === 'low') {
    return {
      label: 'Too low',
      cls: 'bg-rose-500/20 text-rose-300',
      helper: 'Raise your pitch slightly.',
    };
  }

  return {
    label: 'Checking',
    cls: 'bg-amber-500/20 text-amber-300',
    helper: 'The system is checking your pitch.',
  };
}

export default function FeedbackOverlay() {
  const { latestPitch, mistakes, stats, error } = useMaistroStore();
  const status = statusFromPitch(latestPitch);

  return (
    <section className="rounded-2xl bg-slate-900/80 p-4 shadow-lg">
      <h2 className="mb-3 text-xl font-semibold text-white">Live Feedback</h2>

      {error && (
        <div className="mb-3 rounded-lg bg-rose-500/20 p-3 text-sm text-rose-200">
          {String(error)}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-slate-700 p-3">
          <p className="text-sm text-slate-400">Detected Pitch</p>
          <p className="text-2xl font-bold text-white">
            {latestPitch?.frequency ? latestPitch.frequency.toFixed(2) : '--'} Hz
          </p>
          <p className="text-sm text-slate-400">
            {latestPitch?.note_name || '--'}
          </p>
        </div>

        <div className="rounded-xl border border-slate-700 p-3">
          <p className="text-sm text-slate-400">Target Note</p>
          <p className="text-2xl font-bold text-white">
            {latestPitch?.expected_note || '--'}
          </p>
          <p className="text-sm text-slate-400">
            {latestPitch?.expected_freq ? `${latestPitch.expected_freq.toFixed(2)} Hz` : 'from uploaded score'}
          </p>
        </div>

        <div className="rounded-xl border border-slate-700 p-3">
          <p className="text-sm text-slate-400">Pitch Status</p>
          <span className={`inline-block rounded-full px-3 py-1 text-sm font-semibold ${status.cls}`}>
            {status.label}
          </span>
          <p className="mt-2 text-sm text-slate-400">
            {status.helper}
          </p>
        </div>

        <div className="rounded-xl border border-slate-700 p-3">
          <p className="text-sm text-slate-400">Confidence</p>
          <p className="text-2xl font-bold text-white">
            {pct(latestPitch?.confidence)}
          </p>
          <div className="mt-2 h-2 rounded-full bg-slate-700">
            <div
              className="h-2 rounded-full bg-emerald-400"
              style={{ width: `${Math.round((latestPitch?.confidence || 0) * 100)}%` }}
            />
          </div>
        </div>

        <div className="rounded-xl border border-slate-700 p-3">
          <p className="text-sm text-slate-400">Mistakes</p>
          <p className="text-2xl font-bold text-white">{mistakes.length}</p>
          <p className="text-sm text-slate-400">during this live session</p>
        </div>
      </div>

      {stats && (
        <div className="mt-4 rounded-xl border border-slate-700 p-3">
          <h3 className="mb-2 font-semibold text-white">Session Summary</h3>
          <div className="grid grid-cols-2 gap-2 text-sm text-slate-300">
            <span>Accuracy</span>
            <span>{pct(stats.pitch_accuracy)}</span>

            <span>Pitch frames</span>
            <span>{stats.pitch_frames_count}</span>

            <span>Mistakes</span>
            <span>{stats.mistakes_count}</span>

            <span>Timing drift</span>
            <span>{stats.timing_drift_ms} ms</span>
          </div>
        </div>
      )}

      <div className="mt-4 max-h-44 overflow-auto rounded-xl border border-slate-700 p-3">
        <h3 className="mb-2 font-semibold text-white">Recent Issues</h3>

        {mistakes.length === 0 && (
          <p className="text-sm text-slate-400">No mistakes logged yet.</p>
        )}

        {mistakes.map((m, i) => (
          <div
            key={`${m.timestamp}-${i}`}
            className="mb-2 rounded-lg bg-rose-500/10 p-2 text-sm text-rose-100"
          >
            Note {m.note_index}: {m.message}
          </div>
        ))}
      </div>
    </section>
  );
}