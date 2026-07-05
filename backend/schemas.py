from __future__ import annotations

from typing import Any, Literal, Optional
from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str
    timestamp: str
    audio_state: dict[str, Any]


class NoteEvent(BaseModel):
    index: int
    name: str
    midi: Optional[int] = None
    frequency: Optional[float] = None
    start_quarter: float
    duration_quarter: float
    is_rest: bool = False
    measure: Optional[int] = None


class SheetUploadResponse(BaseModel):
    sheet_id: str
    filename: str
    notes_count: int
    duration_seconds: float
    difficulty_score: float
    musicxml: str
    notes: list[NoteEvent]
    timestamp: str


class SheetMetadataResponse(BaseModel):
    sheet_id: str
    filename: str
    notes_count: int
    duration_seconds: float
    difficulty_score: float
    uploaded_at: str
    notes: list[NoteEvent] = []


class StartSessionRequest(BaseModel):
    sheet_id: Optional[str] = None
    tempo: int = Field(default=120, ge=40, le=200)
    enable_metronome: bool = True
    enable_feedback: bool = True


class SessionStartResponse(BaseModel):
    session_id: str
    sheet_id: str
    config: dict[str, Any]
    started_at: str


class EndSessionResponse(BaseModel):
    session_id: str
    pitch_accuracy: float
    timing_drift_ms: float
    mistakes_count: int
    ended_at: str


class StatsResponse(BaseModel):
    session_id: str
    pitch_frames_count: int
    pitch_accuracy: float
    timing_drift_ms: float
    mistakes_count: int
    started_at: str
    ended_at: Optional[str]
    recent_mistakes: list[dict[str, Any]] = []


class PitchFrame(BaseModel):
    timestamp: float
    frequency: float
    confidence: float


class FeedbackMessage(BaseModel):
    type: Literal["pitch_error", "timing_error"]
    note_index: int
    frequency_expected: float
    frequency_actual: float
    message: str
    timestamp: float
