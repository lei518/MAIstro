from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Optional

from .settings import DB_PATH
from .utils import utc_now_iso


class Database:
    def __init__(self, path: Path = DB_PATH):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.init()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def init(self) -> None:
        with self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS sheets (
                    sheet_id TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    notes_count INTEGER NOT NULL,
                    duration_seconds REAL NOT NULL,
                    difficulty_score REAL NOT NULL,
                    musicxml_data TEXT NOT NULL,
                    notes_json TEXT NOT NULL DEFAULT '[]',
                    uploaded_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    sheet_id TEXT NOT NULL,
                    tempo INTEGER NOT NULL DEFAULT 120,
                    enable_metronome INTEGER NOT NULL DEFAULT 1,
                    enable_feedback INTEGER NOT NULL DEFAULT 1,
                    started_at TEXT NOT NULL,
                    ended_at TEXT,
                    pitch_accuracy REAL DEFAULT 0,
                    timing_drift_ms REAL DEFAULT 0,
                    mistakes_count INTEGER DEFAULT 0,
                    FOREIGN KEY(sheet_id) REFERENCES sheets(sheet_id)
                );

                CREATE TABLE IF NOT EXISTS pitch_data (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    timestamp REAL NOT NULL,
                    frequency REAL NOT NULL,
                    confidence REAL NOT NULL,
                    expected_freq REAL,
                    cent_diff REAL,
                    note_index INTEGER,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(session_id) REFERENCES sessions(session_id)
                );

                CREATE TABLE IF NOT EXISTS mistakes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    note_index INTEGER,
                    expected_freq REAL NOT NULL,
                    actual_freq REAL NOT NULL,
                    cent_diff REAL,
                    error_type TEXT NOT NULL CHECK(error_type IN ('pitch_error', 'timing_error')),
                    timestamp REAL NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(session_id) REFERENCES sessions(session_id)
                );

                CREATE INDEX IF NOT EXISTS idx_pitch_session ON pitch_data(session_id);
                CREATE INDEX IF NOT EXISTS idx_mistakes_session ON mistakes(session_id);
                """
            )

    def insert_sheet(self, sheet: dict[str, Any]) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO sheets(sheet_id, filename, notes_count, duration_seconds, difficulty_score, musicxml_data, notes_json, uploaded_at)
                VALUES(:sheet_id, :filename, :notes_count, :duration_seconds, :difficulty_score, :musicxml_data, :notes_json, :uploaded_at)
                """,
                sheet,
            )

    def get_sheet(self, sheet_id: str) -> Optional[dict[str, Any]]:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM sheets WHERE sheet_id=?", (sheet_id,)).fetchone()
            return dict(row) if row else None

    def get_latest_sheet(self) -> Optional[dict[str, Any]]:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM sheets ORDER BY uploaded_at DESC LIMIT 1").fetchone()
            return dict(row) if row else None

    def create_session(self, session: dict[str, Any]) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO sessions(session_id, sheet_id, tempo, enable_metronome, enable_feedback, started_at)
                VALUES(:session_id, :sheet_id, :tempo, :enable_metronome, :enable_feedback, :started_at)
                """,
                session,
            )

    def get_session(self, session_id: str) -> Optional[dict[str, Any]]:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM sessions WHERE session_id=?", (session_id,)).fetchone()
            return dict(row) if row else None

    def insert_pitch_frame(
        self,
        session_id: str,
        timestamp: float,
        frequency: float,
        confidence: float,
        expected_freq: Optional[float],
        cent_diff: Optional[float],
        note_index: Optional[int],
    ) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO pitch_data(session_id, timestamp, frequency, confidence, expected_freq, cent_diff, note_index, created_at)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (session_id, timestamp, frequency, confidence, expected_freq, cent_diff, note_index, utc_now_iso()),
            )

    def insert_mistake(
        self,
        session_id: str,
        note_index: int,
        expected_freq: float,
        actual_freq: float,
        cent_diff: float,
        timestamp: float,
        error_type: str = "pitch_error",
    ) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO mistakes(session_id, note_index, expected_freq, actual_freq, cent_diff, error_type, timestamp, created_at)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (session_id, note_index, expected_freq, actual_freq, cent_diff, error_type, timestamp, utc_now_iso()),
            )

    def finish_session(self, session_id: str) -> dict[str, Any]:
        stats = self.compute_session_stats(session_id)
        ended_at = utc_now_iso()
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE sessions
                SET ended_at=?, pitch_accuracy=?, timing_drift_ms=?, mistakes_count=?
                WHERE session_id=?
                """,
                (ended_at, stats["pitch_accuracy"], stats["timing_drift_ms"], stats["mistakes_count"], session_id),
            )
        stats["ended_at"] = ended_at
        return stats

    def compute_session_stats(self, session_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            frames = conn.execute(
                "SELECT cent_diff, confidence FROM pitch_data WHERE session_id=? AND cent_diff IS NOT NULL",
                (session_id,),
            ).fetchall()
            mistakes_count = conn.execute(
                "SELECT COUNT(*) AS c FROM mistakes WHERE session_id=?",
                (session_id,),
            ).fetchone()["c"]
            session = conn.execute("SELECT * FROM sessions WHERE session_id=?", (session_id,)).fetchone()
        valid = [abs(float(r["cent_diff"])) <= 50 for r in frames if r["cent_diff"] is not None]
        pitch_accuracy = (sum(valid) / len(valid)) if valid else 0.0
        # Timing drift is reserved for onset tracking. For now, compute frame-to-frame pitch deviation proxy in ms field as 0 until onset detector is enabled.
        timing_drift_ms = 0.0
        return {
            "session_id": session_id,
            "pitch_frames_count": len(frames),
            "pitch_accuracy": float(pitch_accuracy),
            "timing_drift_ms": float(timing_drift_ms),
            "mistakes_count": int(mistakes_count),
            "started_at": session["started_at"] if session else "",
            "ended_at": session["ended_at"] if session else None,
        }

    def get_recent_mistakes(self, session_id: str, limit: int = 25) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT note_index, expected_freq, actual_freq, cent_diff, error_type, timestamp
                FROM mistakes WHERE session_id=? ORDER BY id DESC LIMIT ?
                """,
                (session_id, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    def difficult_measures(self, session_id: str) -> list[dict[str, Any]]:
        session = self.get_session(session_id)
        if not session:
            return []
        sheet = self.get_sheet(session["sheet_id"])
        notes = json.loads(sheet.get("notes_json", "[]")) if sheet else []
        note_to_measure = {int(n["index"]): n.get("measure") for n in notes}
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT note_index, COUNT(*) AS c, AVG(ABS(cent_diff)) AS avg_abs_cents FROM mistakes WHERE session_id=? GROUP BY note_index",
                (session_id,),
            ).fetchall()
        measures: dict[Any, dict[str, Any]] = {}
        for r in rows:
            measure = note_to_measure.get(int(r["note_index"]), None)
            key = measure if measure is not None else "unknown"
            item = measures.setdefault(key, {"measure": key, "mistakes": 0, "avg_abs_cents": 0.0, "notes": []})
            item["mistakes"] += int(r["c"])
            item["notes"].append(int(r["note_index"]))
            item["avg_abs_cents"] = max(float(item["avg_abs_cents"]), float(r["avg_abs_cents"] or 0))
        return sorted(measures.values(), key=lambda x: x["mistakes"], reverse=True)


def decode_notes_json(sheet: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not sheet:
        return []
    try:
        return json.loads(sheet.get("notes_json") or "[]")
    except json.JSONDecodeError:
        return []
