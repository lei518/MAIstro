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
            chord_count = 0
            dotted_count = 0
            tuplet_count = 0

            midi_values: list[int] = []

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

                try:
                    if el.duration.dots and el.duration.dots > 0:
                        dotted_count += 1
                except Exception:
                    pass

                try:
                    if el.duration.tuplets:
                        tuplet_count += len(el.duration.tuplets)
                except Exception:
                    pass

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
                    # MAIstro is intended for monophonic beginner sheets.
                    # If a chord appears, use the highest pitch for playback comparison,
                    # but count it as added difficulty.
                    chord_count += 1
                    pitch_obj = max(el.pitches, key=lambda p: p.midi)

                if pitch_obj is None:
                    continue

                midi = int(pitch_obj.midi)
                midi_values.append(midi)

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
            total_quarters = max(
                (n["start_quarter"] + n["duration_quarter"] for n in notes),
                default=0.0,
            )
            duration_seconds = float(total_quarters * 60.0 / default_tempo)

            difficulty = self._classify_difficulty(
                score=score,
                notes_count=notes_count,
                duration_seconds=duration_seconds,
                accidentals=accidentals,
                intervals=intervals,
                smallest_duration=smallest_duration,
                dotted_count=dotted_count,
                tuplet_count=tuplet_count,
                chord_count=chord_count,
                midi_values=midi_values,
            )

            return {
                "notes": notes,
                "notes_count": notes_count,
                "duration_seconds": duration_seconds,
                "difficulty_score": difficulty["difficulty_score"],
                "difficulty_label": difficulty["difficulty_label"],
                "estimated_grade": difficulty["estimated_grade"],
                "omr_disclaimer_required": difficulty["omr_disclaimer_required"],
                "difficulty_reasons": difficulty["difficulty_reasons"],
                "difficulty_features": difficulty["difficulty_features"],
                "notes_json": json.dumps(notes),
            }

        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass

    @staticmethod
    def _safe_measure_count(score) -> int:
        try:
            measures = list(score.recurse().getElementsByClass("Measure"))
            return len(measures)
        except Exception:
            return 0

    @staticmethod
    def _extract_time_signatures(score) -> list[str]:
        found: list[str] = []

        try:
            for ts in score.recurse().getElementsByClass("TimeSignature"):
                ratio = getattr(ts, "ratioString", None)
                if ratio and ratio not in found:
                    found.append(str(ratio))
        except Exception:
            pass

        return found or ["4/4"]

    @staticmethod
    def _extract_key_fifths(score) -> list[int]:
        fifths_values: list[int] = []

        try:
            for ks in score.recurse().getElementsByClass("KeySignature"):
                sharps = getattr(ks, "sharps", None)
                if sharps is not None:
                    fifths_values.append(int(sharps))
        except Exception:
            pass

        return fifths_values or [0]

    @staticmethod
    def _time_signature_to_tuple(value: str) -> tuple[int, int] | None:
        try:
            top, bottom = value.split("/")
            return int(top), int(bottom)
        except Exception:
            return None

    def _classify_difficulty(
        self,
        score,
        notes_count: int,
        duration_seconds: float,
        accidentals: int,
        intervals: list[int],
        smallest_duration: float,
        dotted_count: int,
        tuplet_count: int,
        chord_count: int,
        midi_values: list[int],
    ) -> dict[str, Any]:
        """
        MAIstro difficulty classifier.

        Mapping:
        Beginner     = Grade 1–2
        Intermediate = Grade 3
        Advanced     = Grade 4+

        This is a rule-based thesis prototype classifier based on automatically
        extractable MusicXML features.
        """

        points = 0
        reasons: list[str] = []

        measure_count = self._safe_measure_count(score)
        time_signatures = self._extract_time_signatures(score)
        time_tuples = [
            parsed for parsed in [self._time_signature_to_tuple(ts) for ts in time_signatures]
            if parsed is not None
        ]

        key_fifths_values = self._extract_key_fifths(score)
        max_abs_key_fifths = max([abs(v) for v in key_fifths_values], default=0)
        key_change_count = max(0, len(set(key_fifths_values)) - 1)
        meter_change_count = max(0, len(set(time_signatures)) - 1)

        pitch_range = 0
        if midi_values:
            pitch_range = max(midi_values) - min(midi_values)

        density = notes_count / max(duration_seconds, 1.0)
        average_interval = float(np.mean(intervals)) if intervals else 0.0

        beginner_meters = {
            (2, 4),
            (3, 4),
            (4, 4),
            (2, 2),
            (6, 8),
        }

        intermediate_meters = {
            (9, 8),
            (12, 8),
            (3, 8),
        }

        has_asymmetrical_meter = any(top in {5, 7, 11, 13} for top, _ in time_tuples)
        has_uncommon_meter = any(
            ts not in beginner_meters and ts not in intermediate_meters
            for ts in time_tuples
        )

        # 1. Meter / time signature
        if has_asymmetrical_meter:
            points += 28
            reasons.append("Contains asymmetrical meter, which is beyond beginner level.")
        elif has_uncommon_meter:
            points += 18
            reasons.append("Contains uncommon meter.")
        elif any(ts in intermediate_meters for ts in time_tuples):
            points += 10
            reasons.append("Contains compound or less common beginner meter.")
        else:
            reasons.append("Uses beginner-friendly meter.")

        if meter_change_count > 0:
            points += 12
            reasons.append("Contains meter changes.")

        # 2. Key signature
        if max_abs_key_fifths <= 3:
            reasons.append("Key signature is within beginner range.")
        elif max_abs_key_fifths <= 5:
            points += 14
            reasons.append("Key signature is wider than beginner range.")
        else:
            points += 24
            reasons.append("Key signature is advanced.")

        if key_change_count > 0:
            points += 10
            reasons.append("Contains key changes.")

        # 3. Rhythm / note values
        if smallest_duration <= 0.125:
            points += 30
            reasons.append("Contains 32nd notes or shorter rhythmic values.")
        elif smallest_duration <= 0.25:
            points += 18
            reasons.append("Contains 16th-note rhythmic values.")
        elif smallest_duration <= 0.5:
            points += 6
            reasons.append("Contains eighth-note movement.")
        else:
            reasons.append("Uses simple note/rest values.")

        if tuplet_count > 0:
            points += 14
            reasons.append("Contains tuplets or triplet rhythms.")

        dotted_ratio = dotted_count / max(notes_count, 1)
        if dotted_ratio >= 0.20:
            points += 10
            reasons.append("Contains frequent dotted rhythms.")
        elif dotted_count > 0:
            points += 4
            reasons.append("Contains some dotted rhythms.")

        # 4. Pitch range
        if pitch_range >= 24:
            points += 22
            reasons.append("Uses a wide pitch range.")
        elif pitch_range >= 16:
            points += 10
            reasons.append("Uses a moderate pitch range.")
        else:
            reasons.append("Pitch range is beginner-friendly.")

        # 5. Leaps / intervals
        if average_interval >= 9:
            points += 12
            reasons.append("Contains larger melodic leaps.")
        elif average_interval >= 6:
            points += 6
            reasons.append("Contains moderate melodic movement.")

        # 6. Accidentals
        accidental_ratio = accidentals / max(notes_count, 1)
        if accidentals >= 8 or accidental_ratio >= 0.18:
            points += 10
            reasons.append("Contains frequent accidentals.")
        elif accidentals > 0:
            points += 4
            reasons.append("Contains some accidentals.")

        # 7. Chords / polyphony
        if chord_count > 0:
            points += 20
            reasons.append("Contains chord symbols or polyphonic note events, which exceed the monophonic beginner scope.")

        # 8. Density
        if density >= 3.5:
            points += 14
            reasons.append("Contains high note density.")
        elif density >= 2.3:
            points += 7
            reasons.append("Contains moderate note density.")

        # 9. Length
        if measure_count >= 48:
            points += 12
            reasons.append("Longer piece length increases difficulty.")
        elif measure_count >= 24:
            points += 6
            reasons.append("Moderate piece length.")

        difficulty_score = float(max(0.0, min(1.0, points / 100.0)))

        if points < 30:
            difficulty_label = "Beginner"
            estimated_grade = "Grade 1–2"
        elif points < 60:
            difficulty_label = "Intermediate"
            estimated_grade = "Grade 3"
        else:
            difficulty_label = "Advanced"
            estimated_grade = "Grade 4+"

        # Keep reasons short for the dashboard.
        cleaned_reasons = []
        for reason in reasons:
            if reason not in cleaned_reasons:
                cleaned_reasons.append(reason)

        return {
            "difficulty_score": difficulty_score,
            "difficulty_label": difficulty_label,
            "estimated_grade": estimated_grade,
            "omr_disclaimer_required": difficulty_label in {"Intermediate", "Advanced"},
            "difficulty_reasons": cleaned_reasons[:7],
            "difficulty_features": {
                "points": points,
                "notes_count": notes_count,
                "measure_count": measure_count,
                "duration_seconds": duration_seconds,
                "time_signatures": time_signatures,
                "meter_changes": meter_change_count,
                "max_abs_key_fifths": max_abs_key_fifths,
                "key_changes": key_change_count,
                "smallest_duration_quarter": smallest_duration,
                "dotted_notes": dotted_count,
                "tuplets": tuplet_count,
                "accidentals": accidentals,
                "chords": chord_count,
                "pitch_range_semitones": pitch_range,
                "average_interval_semitones": average_interval,
                "note_density_per_second": density,
            },
        }

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
