import { useEffect, useRef, useState } from 'react';
import * as Tone from 'tone';
import { useMaistroStore } from '../store.js';

export default function Metronome() {
  const { tempo, enableMetronome, session } = useMaistroStore();
  const [running, setRunning] = useState(false);
  const synthRef = useRef(null);
  const loopRef = useRef(null);

  useEffect(() => {
    Tone.Transport.bpm.value = tempo;
  }, [tempo]);

  useEffect(() => {
    return () => stop();
  }, []);

  async function start() {
    if (!enableMetronome) return;
    await Tone.start();
    synthRef.current = synthRef.current || new Tone.MembraneSynth().toDestination();
    if (loopRef.current) loopRef.current.dispose();
    loopRef.current = new Tone.Loop((time) => {
      synthRef.current.triggerAttackRelease('C5', '8n', time);
    }, '4n').start(0);
    Tone.Transport.start();
    setRunning(true);
  }

  function stop() {
    try {
      Tone.Transport.stop();
      if (loopRef.current) loopRef.current.dispose();
    } catch (_) {}
    loopRef.current = null;
    setRunning(false);
  }

  return (
    <section className="rounded-2xl bg-slate-900/80 p-4 shadow-lg">
      <h2 className="mb-3 text-xl font-semibold text-white">Metronome</h2>
      <div className="flex items-center justify-between rounded-xl border border-slate-700 p-3">
        <div>
          <p className="text-3xl font-bold text-white">{tempo}</p>
          <p className="text-sm text-slate-400">BPM • Tone.js click</p>
        </div>
        <button disabled={!session || !enableMetronome} onClick={running ? stop : start} className="rounded-lg bg-sky-500 px-4 py-2 font-semibold text-white hover:bg-sky-400">
          {running ? 'Stop Click' : 'Start Click'}
        </button>
      </div>
    </section>
  );
}
