from __future__ import annotations

import math
import statistics
from datetime import datetime, timezone
from typing import Iterable, Optional

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def midi_to_frequency(midi: int, a4: float = 440.0) -> float:
    return float(a4 * (2.0 ** ((int(midi) - 69) / 12.0)))


def frequency_to_midi(freq: float, a4: float = 440.0) -> Optional[int]:
    if freq is None or freq <= 0:
        return None
    return int(round(69 + 12 * math.log2(freq / a4)))


def frequency_to_note_name(freq: float) -> str:
    midi = frequency_to_midi(freq)
    if midi is None:
        return "--"
    octave = midi // 12 - 1
    return f"{NOTE_NAMES[midi % 12]}{octave}"


def midi_to_note_name(midi: int) -> str:
    octave = int(midi) // 12 - 1
    return f"{NOTE_NAMES[int(midi) % 12]}{octave}"


def cents_difference(actual_freq: float, expected_freq: float) -> float:
    if actual_freq is None or expected_freq is None or actual_freq <= 0 or expected_freq <= 0:
        return 0.0
    return float(1200.0 * math.log2(actual_freq / expected_freq))


def safe_mean(values: Iterable[float], default: float = 0.0) -> float:
    values = [v for v in values if v is not None]
    return float(statistics.fmean(values)) if values else default


def safe_std(values: Iterable[float], default: float = 0.0) -> float:
    values = [v for v in values if v is not None]
    if len(values) < 2:
        return default
    return float(statistics.pstdev(values))
