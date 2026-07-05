import { useMaistroStore } from '../store.js';

export default function Header() {
  const { session, wsStatus, health } = useMaistroStore();
  const connected = wsStatus === 'connected';
  return (
    <header className="flex flex-col gap-3 rounded-2xl bg-slate-900/80 p-4 shadow-lg md:flex-row md:items-center md:justify-between">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white">MAIstro</h1>
        <p className="text-sm text-slate-300">AI-Powered Music Practice Assistant</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={`rounded-full px-3 py-1 ${connected ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-700 text-slate-300'}`}>
          WebSocket: {wsStatus}
        </span>
        <span className="rounded-full bg-slate-800 px-3 py-1 text-slate-300">
          Session: {session?.session_id ? session.session_id.slice(0, 8) : 'none'}
        </span>
        <span className="rounded-full bg-indigo-500/20 px-3 py-1 text-indigo-200">
          Pitch: {health?.audio_state?.pitch_engine || 'checking'}
        </span>
      </div>
    </header>
  );
}
