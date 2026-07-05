from __future__ import annotations

import asyncio
import queue
import threading
from typing import Optional

import numpy as np

from . import settings


class AudioStreamer:
    """Raspberry Pi hardware audio reader using sounddevice/ALSA.

    The callback is intentionally small: it only copies mono samples into a queue.
    Pitch inference happens outside the callback so the audio driver is not blocked.
    """

    def __init__(self, sample_rate: int = settings.AUDIO_SAMPLE_RATE, device: Optional[str] = settings.AUDIO_DEVICE):
        self.sample_rate = int(sample_rate)
        self.device = device
        self._q: queue.Queue[np.ndarray] = queue.Queue(maxsize=128)
        self._stream = None
        self._lock = threading.Lock()
        self._running = False

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def queue_size(self) -> int:
        return self._q.qsize()

    def state(self) -> dict:
        return {
            "sample_rate": self.sample_rate,
            "device": self.device or "default",
            "is_running": self.is_running,
            "queue_size": self.queue_size,
            "source": settings.AUDIO_SOURCE,
        }

    def start(self) -> None:
        with self._lock:
            if self._running:
                return
            try:
                import sounddevice as sd
            except ImportError as exc:
                raise RuntimeError("sounddevice is not installed. Install backend requirements on the Pi.") from exc

            def callback(indata, frames, time_info, status):  # noqa: ANN001
                if status:
                    # Do not print inside callback. Status is intentionally ignored to avoid RT glitches.
                    pass
                mono = np.asarray(indata, dtype=np.float32)
                if mono.ndim > 1:
                    mono = mono[:, 0]
                try:
                    self._q.put_nowait(mono.copy())
                except queue.Full:
                    try:
                        self._q.get_nowait()
                        self._q.put_nowait(mono.copy())
                    except queue.Empty:
                        pass

            self._stream = sd.InputStream(
                samplerate=self.sample_rate,
                channels=1,
                dtype="float32",
                blocksize=max(256, int(self.sample_rate * settings.PITCH_FRAME_MS / 1000)),
                device=self.device,
                callback=callback,
            )
            self._stream.start()
            self._running = True

    def stop(self) -> None:
        with self._lock:
            if self._stream is not None:
                self._stream.stop()
                self._stream.close()
            self._stream = None
            self._running = False
            while not self._q.empty():
                try:
                    self._q.get_nowait()
                except queue.Empty:
                    break

    async def read_frame(self, timeout: float = 0.5) -> Optional[np.ndarray]:
        loop = asyncio.get_running_loop()
        try:
            return await loop.run_in_executor(None, self._q.get, True, timeout)
        except queue.Empty:
            return None


if __name__ == "__main__":
    import time
    from .model import PitchEstimator

    streamer = AudioStreamer()
    estimator = PitchEstimator()
    streamer.start()
    print("Listening. Press Ctrl+C to stop.")
    try:
        while True:
            frame = streamer._q.get()
            result = estimator.estimate(frame, streamer.sample_rate)
            if result:
                print(f"{result.frequency:8.2f} Hz  confidence={result.confidence:.2f}  engine={result.engine}")
            time.sleep(0.025)
    except KeyboardInterrupt:
        pass
    finally:
        streamer.stop()
