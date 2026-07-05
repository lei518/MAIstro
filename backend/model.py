from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4

import httpx
import numpy as np
from music21 import converter, note as music21_note, chord as music21_chord

from . import settings
from .utils import midi_to_frequency, midi_to_note_name


@dataclass
class PitchResult:
    frequency: float
    confidence: float
    engine: str


class PitchEstimator:
    """CREPE-TFLite first, deterministic YIN fallback for development.

    This class never returns random/mock pitch. If a CREPE .tflite model is present,
    it is used. If not present, a real YIN autocorrelation detector is used so the
    rest of the system can be tested before the CREPE model file is copied to Pi.
    """

    def __init__(self, model_path: Path = settings.CREPE_TFLITE_PATH, sample_rate: int = settings.PITCH_SAMPLE_RATE):
        self.model_path = Path(model_path)
        self.sample_rate = int(sample_rate)
        self.interpreter = None
        self.input_details = None
        self.output_details = None
        self.engine = "yin"
        if self.model_path.exists():
            self._load_tflite()

    def _load_tflite(self) -> None:
        try:
            try:
                from tflite_runtime.interpreter import Interpreter
            except ImportError:  # desktop dev may have tensorflow instead
                from tensorflow.lite.python.interpreter import Interpreter  # type: ignore
            self.interpreter = Interpreter(model_path=str(self.model_path))
            self.interpreter.allocate_tensors()
            self.input_details = self.interpreter.get_input_details()
            self.output_details = self.interpreter.get_output_details()
            self.engine = "crepe-tflite"
        except Exception as exc:
            raise RuntimeError(f"Failed to load CREPE TFLite model at {self.model_path}: {exc}") from exc

    def audio_state(self) -> dict[str, Any]:
        return {
            "pitch_engine": self.engine,
            "crepe_model_path": str(self.model_path),
            "crepe_model_loaded": self.interpreter is not None,
            "pitch_sample_rate": self.sample_rate,
        }

    def estimate(self, audio: list[float] | np.ndarray, input_sample_rate: int) -> Optional[PitchResult]:
        arr = np.asarray(audio, dtype=np.float32).flatten()
        if arr.size < 64:
            return None
        arr = np.nan_to_num(arr)
        if np.max(np.abs(arr)) > 1.5:
            # tolerate int PCM-looking input
            arr = arr / max(float(np.max(np.abs(arr))), 1.0)
        if input_sample_rate != self.sample_rate:
            arr = self._resample_linear(arr, input_sample_rate, self.sample_rate)
        if arr.size == 0:
            return None
        arr = arr - np.mean(arr)
        peak = float(np.max(np.abs(arr)))
        if peak < 1e-4:
            return None
        arr = arr / peak
        if self.interpreter is not None:
            return self._estimate_crepe(arr)
        return self._estimate_yin(arr, self.sample_rate)

    @staticmethod
    def _resample_linear(audio: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
        if src_rate == dst_rate or audio.size == 0:
            return audio.astype(np.float32)
        duration = audio.size / float(src_rate)
        dst_len = max(1, int(round(duration * dst_rate)))
        src_x = np.linspace(0.0, duration, num=audio.size, endpoint=False)
        dst_x = np.linspace(0.0, duration, num=dst_len, endpoint=False)
        return np.interp(dst_x, src_x, audio).astype(np.float32)

    def _estimate_crepe(self, audio: np.ndarray) -> Optional[PitchResult]:
        assert self.interpreter is not None and self.input_details and self.output_details
        input_info = self.input_details[0]
        shape = input_info.get("shape", [1, 1024])
        frame_len = int(shape[-1]) if len(shape) >= 2 else 1024
        if audio.size < frame_len:
            audio = np.pad(audio, (0, frame_len - audio.size))
        else:
            audio = audio[-frame_len:]
        x = audio.astype(np.float32).reshape(shape)
        if input_info["dtype"] == np.int8:
            scale, zero_point = input_info.get("quantization", (1.0, 0))
            x = (x / max(scale, 1e-9) + zero_point).astype(np.int8)
        elif input_info["dtype"] == np.uint8:
            scale, zero_point = input_info.get("quantization", (1.0, 0))
            x = (x / max(scale, 1e-9) + zero_point).astype(np.uint8)
        self.interpreter.set_tensor(input_info["index"], x)
        self.interpreter.invoke()
        output = self.interpreter.get_tensor(self.output_details[0]["index"])
        bins = np.asarray(output).reshape(-1).astype(np.float32)
        if bins.size < 10:
            return None
        idx = int(np.argmax(bins))
        confidence = float(np.max(bins))
        # CREPE bins: 20-cent spacing starting at ~C1. This mirrors the original CREPE conversion.
        cents = 1997.3794084376191 + 20.0 * idx
        if 4 <= idx < bins.size - 4:
            weights = bins[idx - 4 : idx + 5]
            offsets = np.arange(idx - 4, idx + 5)
            if np.sum(weights) > 1e-6:
                cents = 1997.3794084376191 + 20.0 * float(np.sum(offsets * weights) / np.sum(weights))
        frequency = float(10.0 * (2.0 ** (cents / 1200.0)))
        if not (20 <= frequency <= 5000):
            return None
        return PitchResult(frequency=frequency, confidence=max(0.0, min(1.0, confidence)), engine=self.engine)

    @staticmethod
    def _estimate_yin(audio: np.ndarray, sample_rate: int, fmin: float = 60.0, fmax: float = 1600.0, threshold: float = 0.15) -> Optional[PitchResult]:
        # Use at least 40 ms for stable monophonic pitch. This is a detector, not a mock.
        min_len = int(sample_rate * 0.04)
        if audio.size < min_len:
            audio = np.pad(audio, (0, min_len - audio.size))
        max_tau = min(int(sample_rate / fmin), audio.size - 2)
        min_tau = max(2, int(sample_rate / fmax))
        if max_tau <= min_tau + 2:
            return None
        taus = np.arange(1, max_tau + 1)
        diff = np.zeros(max_tau + 1, dtype=np.float64)
        # This loop is acceptable for 25-50 ms chunks on Pi 5 for development fallback.
        for tau in range(min_tau, max_tau + 1):
            delta = audio[:-tau] - audio[tau:]
            diff[tau] = float(np.dot(delta, delta))
        cmnd = np.ones_like(diff)
        running_sum = 0.0
        for tau in range(1, max_tau + 1):
            running_sum += diff[tau]
            cmnd[tau] = diff[tau] * tau / running_sum if running_sum > 0 else 1.0
        tau_est = None
        for tau in range(min_tau, max_tau):
            if cmnd[tau] < threshold and cmnd[tau] <= cmnd[tau + 1]:
                tau_est = tau
                break
        if tau_est is None:
            tau_est = int(np.argmin(cmnd[min_tau:max_tau]) + min_tau)
            if cmnd[tau_est] > 0.45:
                return None
        # Parabolic interpolation around tau estimate.
        if 1 < tau_est < max_tau - 1:
            s0, s1, s2 = cmnd[tau_est - 1], cmnd[tau_est], cmnd[tau_est + 1]
            denom = 2 * (2 * s1 - s2 - s0)
            if abs(denom) > 1e-9:
                tau_est = tau_est + float((s2 - s0) / denom)
        frequency = float(sample_rate / tau_est)
        confidence = float(max(0.0, min(1.0, 1.0 - cmnd[int(round(tau_est))])))
        if not (fmin <= frequency <= fmax):
            return None
        return PitchResult(frequency=frequency, confidence=confidence, engine="yin")


class AudiverisOMR:
    def __init__(self, command: str = settings.AUDIVERIS_CMD, service_url: str = settings.OMR_SERVICE_URL):
        self.command = command
        self.service_url = service_url.rstrip("/") if service_url else ""

    async def transcribe(self, image_path: Path) -> str:
        if self.service_url:
            return await self._transcribe_remote(image_path)
        return self._transcribe_cli(image_path)

    async def _transcribe_remote(self, image_path: Path) -> str:
        async with httpx.AsyncClient(timeout=settings.AUDIVERIS_TIMEOUT_SECONDS) as client:
            with image_path.open("rb") as fh:
                files = {"file": (image_path.name, fh, self._mime_for(image_path))}
                response = await client.post(self.service_url, files=files)
        if response.status_code >= 400:
            raise RuntimeError(f"Remote Audiveris service failed ({response.status_code}): {response.text[:1000]}")
        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            data = response.json()
            for key in ("musicxml", "musicxml_data", "xml"):
                if key in data and data[key]:
                    return str(data[key])
            if "detail" in data:
                raise RuntimeError(str(data["detail"]))
            raise RuntimeError("Remote Audiveris service returned JSON without a musicxml field.")
        return response.text

    def _transcribe_cli(self, image_path: Path) -> str:
        if not shutil.which(self.command) and not Path(self.command).exists():
            raise RuntimeError(
                "Audiveris command not found. Set AUDIVERIS_CMD to the full Audiveris executable path, "
                "or set OMR_SERVICE_URL to your laptop OMR microservice URL."
            )
        with tempfile.TemporaryDirectory(prefix="maistro_audiveris_") as tmp:
            out_dir = Path(tmp)
            cmd = [self.command, "-batch", "-transcribe", "-export", "-output", str(out_dir), str(image_path)]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=settings.AUDIVERIS_TIMEOUT_SECONDS)
            if proc.returncode != 0:
                raise RuntimeError(
                    "Audiveris failed to transcribe/export MusicXML. "
                    f"Command: {' '.join(cmd)}\nSTDOUT:\n{proc.stdout[-2000:]}\nSTDERR:\n{proc.stderr[-2000:]}"
                )
            candidates = list(out_dir.rglob("*.musicxml")) + list(out_dir.rglob("*.xml")) + list(out_dir.rglob("*.mxl"))
            candidates = [p for p in candidates if p.is_file()]
            if not candidates:
                raise RuntimeError(
                    "Audiveris finished but did not produce .musicxml/.xml/.mxl. "
                    "Open the image manually in Audiveris, correct recognition, then export MusicXML."
                )
            return self._read_musicxml(candidates[0])

    @staticmethod
    def _read_musicxml(path: Path) -> str:
        if path.suffix.lower() == ".mxl":
            with zipfile.ZipFile(path, "r") as zf:
                names = [n for n in zf.namelist() if n.lower().endswith((".xml", ".musicxml")) and not n.startswith("META-INF/")]
                if not names:
                    raise RuntimeError("Compressed .mxl did not contain a MusicXML score file.")
                return zf.read(names[0]).decode("utf-8", errors="replace")
        return path.read_text(encoding="utf-8", errors="replace")

    @staticmethod
    def _mime_for(path: Path) -> str:
        ext = path.suffix.lower()
        if ext in (".jpg", ".jpeg"):
            return "image/jpeg"
        if ext == ".png":
            return "image/png"
        return "application/octet-stream"


class MusicXMLAnalyzer:
    def analyze(self, musicxml: str, default_tempo: int = 120) -> dict[str, Any]:
        with tempfile.NamedTemporaryFile("w", suffix=".musicxml", encoding="utf-8", delete=False) as fh:
            fh.write(musicxml)
            tmp_path = Path(fh.name)
        try:
            score = converter.parse(str(tmp_path))
            flat = score.flatten()
            notes: list[dict[str, Any]] = []
            note_index = 0
            accidentals = 0
            intervals: list[int] = []
            last_midi: Optional[int] = None
            smallest_duration = 4.0
            for el in flat.notesAndRests:
                start_q = float(el.offset)
                duration_q = float(el.duration.quarterLength or 0.0)
                measure_number = None
                try:
                    measure_number = el.measureNumber
                except Exception:
                    pass
                if duration_q > 0:
                    smallest_duration = min(smallest_duration, duration_q)
                if isinstance(el, music21_note.Rest):
                    notes.append(
                        {
                            "index": note_index,
                            "name": "Rest",
                            "midi": None,
                            "frequency": None,
                            "start_quarter": start_q,
                            "duration_quarter": duration_q,
                            "is_rest": True,
                            "measure": measure_number,
                        }
                    )
                    note_index += 1
                    continue
                pitch_obj = None
                if isinstance(el, music21_note.Note):
                    pitch_obj = el.pitch
                elif isinstance(el, music21_chord.Chord) and el.pitches:
                    # MAIstro is monophonic; choose highest pitch but count this as difficulty.
                    pitch_obj = max(el.pitches, key=lambda p: p.midi)
                    accidentals += 1
                if pitch_obj is None:
                    continue
                midi = int(pitch_obj.midi)
                if pitch_obj.accidental is not None:
                    accidentals += 1
                if last_midi is not None:
                    intervals.append(abs(midi - last_midi))
                last_midi = midi
                notes.append(
                    {
                        "index": note_index,
                        "name": midi_to_note_name(midi),
                        "midi": midi,
                        "frequency": midi_to_frequency(midi),
                        "start_quarter": start_q,
                        "duration_quarter": duration_q,
                        "is_rest": False,
                        "measure": measure_number,
                    }
                )
                note_index += 1
            notes_count = len([n for n in notes if not n.get("is_rest")])
            total_quarters = max((n["start_quarter"] + n["duration_quarter"] for n in notes), default=0.0)
            duration_seconds = float(total_quarters * 60.0 / default_tempo)
            difficulty_score = self._difficulty_score(notes_count, duration_seconds, accidentals, intervals, smallest_duration)
            return {
                "notes": notes,
                "notes_count": notes_count,
                "duration_seconds": duration_seconds,
                "difficulty_score": difficulty_score,
                "notes_json": json.dumps(notes),
            }
        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass

    @staticmethod
    def _difficulty_score(notes_count: int, duration_seconds: float, accidentals: int, intervals: list[int], smallest_duration: float) -> float:
        density = notes_count / max(duration_seconds, 1.0)
        density_score = min(1.0, density / 4.0)
        accidental_score = min(1.0, accidentals / max(notes_count, 1) * 4.0)
        interval_score = min(1.0, (float(np.mean(intervals)) if intervals else 0.0) / 12.0)
        rhythm_score = 0.0
        if smallest_duration <= 0.25:
            rhythm_score = 1.0
        elif smallest_duration <= 0.5:
            rhythm_score = 0.65
        elif smallest_duration <= 1.0:
            rhythm_score = 0.35
        return float(max(0.0, min(1.0, 0.40 * density_score + 0.20 * accidental_score + 0.20 * interval_score + 0.20 * rhythm_score)))


def expected_note_at_elapsed(notes: list[dict[str, Any]], elapsed_seconds: float, tempo: int) -> Optional[dict[str, Any]]:
    if not notes:
        return None
    elapsed_quarters = elapsed_seconds / (60.0 / max(tempo, 1))
    candidate = None
    for n in notes:
        start = float(n.get("start_quarter", 0.0))
        end = start + float(n.get("duration_quarter", 0.0))
        if start <= elapsed_quarters < end:
            candidate = n
            break
    if candidate is None and elapsed_quarters >= 0:
        # If user is slightly past final note, hold the last non-rest target.
        non_rests = [n for n in notes if not n.get("is_rest")]
        return non_rests[-1] if non_rests else None
    if candidate and candidate.get("is_rest"):
        return None
    return candidate
