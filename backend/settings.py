from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.getenv("MAISTRO_DATA_DIR", BASE_DIR / "data"))
UPLOAD_DIR = Path(os.getenv("MAISTRO_UPLOAD_DIR", DATA_DIR / "uploads"))
SHEET_DIR = Path(os.getenv("MAISTRO_SHEET_DIR", DATA_DIR / "sheets"))
DB_PATH = Path(os.getenv("MAISTRO_DB_PATH", DATA_DIR / "maistro.db"))
MODEL_DIR = Path(os.getenv("MAISTRO_MODEL_DIR", BASE_DIR / "models"))
CREPE_TFLITE_PATH = Path(os.getenv("MAISTRO_CREPE_TFLITE", MODEL_DIR / "crepe.tflite"))

# browser = frontend sends audio frames over WebSocket.
# hardware = Raspberry Pi captures I2S mic through sounddevice/ALSA and pushes pitch updates to frontend.
AUDIO_SOURCE = os.getenv("MAISTRO_AUDIO_SOURCE", "browser").lower().strip()
AUDIO_DEVICE = os.getenv("MAISTRO_AUDIO_DEVICE", "") or None
AUDIO_SAMPLE_RATE = int(os.getenv("MAISTRO_AUDIO_SAMPLE_RATE", "48000"))
PITCH_SAMPLE_RATE = int(os.getenv("MAISTRO_PITCH_SAMPLE_RATE", "16000"))
PITCH_FRAME_MS = int(os.getenv("MAISTRO_PITCH_FRAME_MS", "25"))
PITCH_TOLERANCE_CENTS = float(os.getenv("MAISTRO_PITCH_TOLERANCE_CENTS", "50"))
PITCH_CONFIDENCE_MIN = float(os.getenv("MAISTRO_PITCH_CONFIDENCE_MIN", "0.30"))

# Audiveris can run either locally through CLI or remotely through a laptop OMR microservice.
AUDIVERIS_CMD = os.getenv("AUDIVERIS_CMD", "Audiveris")
AUDIVERIS_TIMEOUT_SECONDS = int(os.getenv("AUDIVERIS_TIMEOUT_SECONDS", "180"))
OMR_SERVICE_URL = os.getenv("OMR_SERVICE_URL", "").strip()

MAX_UPLOAD_BYTES = int(os.getenv("MAISTRO_MAX_UPLOAD_BYTES", str(10 * 1024 * 1024)))
CORS_ALLOW_ORIGINS = [x.strip() for x in os.getenv("MAISTRO_CORS_ALLOW_ORIGINS", "*").split(",") if x.strip()]

for directory in (DATA_DIR, UPLOAD_DIR, SHEET_DIR, MODEL_DIR):
    directory.mkdir(parents=True, exist_ok=True)
