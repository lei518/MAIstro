from __future__ import annotations

import json
import time
from pathlib import Path
from uuid import uuid4

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import settings
from .audio import AudioStreamer
from .db import Database, decode_notes_json
from .model import AudiverisOMR, MusicXMLAnalyzer, PitchEstimator, expected_note_at_elapsed
from .schemas import (
    EndSessionResponse,
    HealthResponse,
    SessionStartResponse,
    SheetMetadataResponse,
    SheetUploadResponse,
    StartSessionRequest,
    StatsResponse,
)
from .utils import cents_difference, frequency_to_note_name, utc_now_iso

app = FastAPI(title="MAIstro API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ALLOW_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

db = Database()
pitch_estimator = PitchEstimator()
audio_streamer = AudioStreamer()
omr = AudiverisOMR()
analyzer = MusicXMLAnalyzer()

ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg"}


@app.exception_handler(RuntimeError)
async def runtime_error_handler(_, exc: RuntimeError):  # noqa: ANN001
    return JSONResponse(status_code=500, content={"detail": {"message": str(exc)}})


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    audio_state = audio_streamer.state()
    audio_state.update(pitch_estimator.audio_state())
    return HealthResponse(status="ok", timestamp=utc_now_iso(), audio_state=audio_state)


@app.post("/upload-sheet", response_model=SheetUploadResponse)
async def upload_sheet(file: UploadFile = File(...)) -> SheetUploadResponse:
    filename = file.filename or "sheet.png"
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Invalid file format. Upload PNG or JPG only.")

    data = await file.read()
    if len(data) > settings.MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds 10 MB upload limit.")
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    sheet_id = str(uuid4())
    safe_name = f"{sheet_id}{ext}"
    image_path = settings.UPLOAD_DIR / safe_name
    image_path.write_bytes(data)

    musicxml = await omr.transcribe(image_path)
    if "<score-partwise" not in musicxml and "<score-timewise" not in musicxml:
        raise RuntimeError("Audiveris returned data, but it does not look like valid MusicXML.")

    analysis = analyzer.analyze(musicxml)
    uploaded_at = utc_now_iso()
    db.insert_sheet(
        {
            "sheet_id": sheet_id,
            "filename": filename,
            "notes_count": analysis["notes_count"],
            "duration_seconds": analysis["duration_seconds"],
            "difficulty_score": analysis["difficulty_score"],
            "musicxml_data": musicxml,
            "notes_json": analysis["notes_json"],
            "uploaded_at": uploaded_at,
        }
    )
    (settings.SHEET_DIR / f"{sheet_id}.musicxml").write_text(musicxml, encoding="utf-8")
    return SheetUploadResponse(
        sheet_id=sheet_id,
        filename=filename,
        notes_count=analysis["notes_count"],
        duration_seconds=analysis["duration_seconds"],
        difficulty_score=analysis["difficulty_score"],
        musicxml=musicxml,
        notes=analysis["notes"],
        timestamp=uploaded_at,
    )


@app.get("/sheet/{sheet_id}", response_model=SheetMetadataResponse)
def get_sheet(sheet_id: str) -> SheetMetadataResponse:
    sheet = db.get_sheet(sheet_id)
    if not sheet:
        raise HTTPException(status_code=404, detail="Sheet not found")
    return SheetMetadataResponse(
        sheet_id=sheet["sheet_id"],
        filename=sheet["filename"],
        notes_count=sheet["notes_count"],
        duration_seconds=sheet["duration_seconds"],
        difficulty_score=sheet["difficulty_score"],
        uploaded_at=sheet["uploaded_at"],
        notes=decode_notes_json(sheet),
    )


@app.get("/sheet/{sheet_id}/musicxml")
def get_sheet_musicxml(sheet_id: str) -> dict:
    sheet = db.get_sheet(sheet_id)
    if not sheet:
        raise HTTPException(status_code=404, detail="Sheet not found")
    return {"sheet_id": sheet_id, "musicxml": sheet["musicxml_data"]}


@app.post("/session/start", response_model=SessionStartResponse)
def start_session(payload: StartSessionRequest) -> SessionStartResponse:
    sheet = db.get_sheet(payload.sheet_id) if payload.sheet_id else db.get_latest_sheet()
    if not sheet:
        raise HTTPException(status_code=400, detail="Upload a sheet first, or provide a valid sheet_id.")
    session_id = str(uuid4())
    started_at = utc_now_iso()
    config = {
        "tempo": payload.tempo,
        "enable_metronome": payload.enable_metronome,
        "enable_feedback": payload.enable_feedback,
    }
    db.create_session(
        {
            "session_id": session_id,
            "sheet_id": sheet["sheet_id"],
            "tempo": payload.tempo,
            "enable_metronome": 1 if payload.enable_metronome else 0,
            "enable_feedback": 1 if payload.enable_feedback else 0,
            "started_at": started_at,
        }
    )
    return SessionStartResponse(session_id=session_id, sheet_id=sheet["sheet_id"], config=config, started_at=started_at)


@app.post("/session/{session_id}/end", response_model=EndSessionResponse)
def end_session(session_id: str) -> EndSessionResponse:
    session = db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    stats = db.finish_session(session_id)
    return EndSessionResponse(
        session_id=session_id,
        pitch_accuracy=stats["pitch_accuracy"],
        timing_drift_ms=stats["timing_drift_ms"],
        mistakes_count=stats["mistakes_count"],
        ended_at=stats["ended_at"],
    )


@app.get("/stats/{session_id}", response_model=StatsResponse)
def get_stats(session_id: str) -> StatsResponse:
    session = db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    stats = db.compute_session_stats(session_id)
    stats["recent_mistakes"] = db.get_recent_mistakes(session_id)
    return StatsResponse(**stats)


def _build_pitch_messages(session: dict, notes: list[dict], elapsed: float, frequency: float, confidence: float) -> list[dict]:
    tempo = int(session.get("tempo") or 120)
    expected = expected_note_at_elapsed(notes, elapsed, tempo)
    expected_freq = expected.get("frequency") if expected else None
    note_index = expected.get("index") if expected else None
    cent_diff = cents_difference(frequency, expected_freq) if expected_freq else None
    db.insert_pitch_frame(session["session_id"], elapsed, frequency, confidence, expected_freq, cent_diff, note_index)
    pitch_update = {
        "type": "pitch_update",
        "frequency": frequency,
        "note_name": frequency_to_note_name(frequency),
        "confidence": confidence,
        "expected_freq": expected_freq,
        "cent_diff": cent_diff,
        "note_index": note_index,
        "timestamp": elapsed,
        "engine": pitch_estimator.engine,
    }
    messages = [pitch_update]
    if (
        expected_freq is not None
        and cent_diff is not None
        and confidence >= settings.PITCH_CONFIDENCE_MIN
        and abs(cent_diff) > settings.PITCH_TOLERANCE_CENTS
    ):
        db.insert_mistake(session["session_id"], int(note_index or 0), float(expected_freq), float(frequency), float(cent_diff), elapsed)
        direction = "high" if cent_diff > 0 else "low"
        messages.append(
            {
                "type": "mistake",
                "message": f"Pitch {direction} by {abs(cent_diff):.1f} cents",
                "note_index": note_index,
                "expected_freq": expected_freq,
                "actual_freq": frequency,
                "cent_diff": cent_diff,
                "timestamp": elapsed,
            }
        )
    return messages


@app.websocket("/ws/practice/{session_id}")
async def practice_ws(websocket: WebSocket, session_id: str):
    await websocket.accept()
    session = db.get_session(session_id)
    if not session:
        await websocket.send_json({"type": "error", "code": "SESSION_NOT_FOUND", "message": "Session not found"})
        await websocket.close(code=1008)
        return
    sheet = db.get_sheet(session["sheet_id"])
    notes = decode_notes_json(sheet)
    start_monotonic = time.monotonic()
    await websocket.send_json({"type": "ready", "session_id": session_id, "audio_source": settings.AUDIO_SOURCE})

    try:
        if settings.AUDIO_SOURCE == "hardware":
            audio_streamer.start()
            while True:
                frame = await audio_streamer.read_frame(timeout=1.0)
                if frame is None:
                    await websocket.send_json({"type": "warning", "message": "No audio frame received from hardware microphone."})
                    continue
                result = pitch_estimator.estimate(frame, audio_streamer.sample_rate)
                if result is None:
                    continue
                elapsed = time.monotonic() - start_monotonic
                for msg in _build_pitch_messages(session, notes, elapsed, result.frequency, result.confidence):
                    await websocket.send_json(msg)
        else:
            while True:
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    await websocket.send_json({"type": "error", "code": "BAD_JSON", "message": "Message is not valid JSON"})
                    continue
                msg_type = msg.get("type")
                if msg_type == "end":
                    await websocket.close()
                    return
                if msg_type == "metronome_click":
                    await websocket.send_json({"type": "metronome_ack", "timestamp": utc_now_iso()})
                    continue
                if msg_type != "audio_frame":
                    await websocket.send_json({"type": "error", "code": "UNKNOWN_MESSAGE", "message": f"Unknown message type: {msg_type}"})
                    continue
                audio = msg.get("audio") or []
                sample_rate = int(msg.get("sample_rate") or settings.AUDIO_SAMPLE_RATE)
                result = pitch_estimator.estimate(np.asarray(audio, dtype=np.float32), sample_rate)
                if result is None:
                    await websocket.send_json({"type": "error", "code": "PITCH_ESTIMATION_FAILED", "message": "Could not estimate pitch from audio frame"})
                    continue
                elapsed = time.monotonic() - start_monotonic
                for out in _build_pitch_messages(session, notes, elapsed, result.frequency, result.confidence):
                    await websocket.send_json(out)
    except WebSocketDisconnect:
        return
    finally:
        if settings.AUDIO_SOURCE == "hardware":
            audio_streamer.stop()
