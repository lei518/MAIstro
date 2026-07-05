from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from preprocess import preprocess_for_audiveris, PreprocessError

APP_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = APP_DIR / "uploads"
OUTPUT_DIR = APP_DIR / "outputs"
PREPROCESSED_DIR = APP_DIR / "preprocessed"

UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)
PREPROCESSED_DIR.mkdir(exist_ok=True)

AUDIVERIS_CMD = os.getenv("AUDIVERIS_CMD", r"C:\Program Files\Audiveris\Audiveris.exe")
AUDIVERIS_TIMEOUT_SECONDS = int(os.getenv("AUDIVERIS_TIMEOUT_SECONDS", "240"))
ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg"}

app = FastAPI(title="MAIstro Laptop Audiveris OMR Service", version="1.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def read_musicxml(path: Path) -> str:
    if path.suffix.lower() == ".mxl":
        with zipfile.ZipFile(path, "r") as zf:
            names = [
                n
                for n in zf.namelist()
                if n.lower().endswith((".xml", ".musicxml")) and not n.startswith("META-INF/")
            ]
            if not names:
                raise RuntimeError("Audiveris produced .mxl, but no MusicXML file was found inside it.")

            return zf.read(names[0]).decode("utf-8", errors="replace")

    return path.read_text(encoding="utf-8", errors="replace")


def audiveris_exists() -> bool:
    return Path(AUDIVERIS_CMD).exists() or shutil.which(AUDIVERIS_CMD) is not None


def find_musicxml_outputs(out_dir: Path) -> list[Path]:
    candidates = (
        list(out_dir.rglob("*.musicxml"))
        + list(out_dir.rglob("*.xml"))
        + list(out_dir.rglob("*.mxl"))
    )

    return [p for p in candidates if p.is_file()]


def run_audiveris(
    image_path: Path,
    out_dir: Path,
) -> tuple[subprocess.CompletedProcess[str], list[Path], list[str]]:
    cmd = [
        AUDIVERIS_CMD,
        "-batch",
        "-transcribe",
        "-export",
        "-output",
        str(out_dir),
        str(image_path),
    ]

    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=AUDIVERIS_TIMEOUT_SECONDS,
    )

    candidates = find_musicxml_outputs(out_dir)
    output_files = [str(p) for p in out_dir.rglob("*")]

    return proc, candidates, output_files


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "audiveris_cmd": AUDIVERIS_CMD,
        "audiveris_found": audiveris_exists(),
        "preprocessing_enabled": True,
    }


@app.post("/convert-sheet")
async def convert_sheet(file: UploadFile = File(...)) -> dict:
    filename = file.filename or "sheet.png"
    ext = Path(filename).suffix.lower()

    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Upload PNG/JPG only.")

    if not audiveris_exists():
        raise HTTPException(
            status_code=500,
            detail={
                "message": f"Audiveris not found at {AUDIVERIS_CMD}. Set AUDIVERIS_CMD.",
            },
        )

    job_id = str(uuid4())
    image_path = UPLOAD_DIR / f"{job_id}{ext}"
    image_path.write_bytes(await file.read())

    preprocessed_path = PREPROCESSED_DIR / f"{job_id}_preprocessed.png"

    try:
        preprocess_info = preprocess_for_audiveris(image_path, preprocessed_path)
    except PreprocessError as exc:
        raise HTTPException(
            status_code=500,
            detail={
                "message": "Image preprocessing failed before Audiveris could run.",
                "error": str(exc),
                "uploaded_image": str(image_path),
            },
        )

    attempts: list[dict] = []

    with tempfile.TemporaryDirectory(prefix="maistro_omr_") as tmp:
        tmp_root = Path(tmp)

        # First attempt: Audiveris uses the cleaned/preprocessed image.
        first_out = tmp_root / "preprocessed_attempt"
        first_out.mkdir(parents=True, exist_ok=True)

        first_proc, first_candidates, first_output_files = run_audiveris(
            preprocessed_path,
            first_out,
        )

        attempts.append(
            {
                "name": "preprocessed_image",
                "image_path": str(preprocessed_path),
                "returncode": first_proc.returncode,
                "stdout_tail": first_proc.stdout[-3000:],
                "stderr_tail": first_proc.stderr[-3000:],
                "output_files": first_output_files,
            }
        )

        if first_proc.returncode == 0 and first_candidates:
            musicxml = read_musicxml(first_candidates[0])

            saved = OUTPUT_DIR / f"{job_id}.musicxml"
            saved.write_text(musicxml, encoding="utf-8")

            return {
                "job_id": job_id,
                "filename": filename,
                "musicxml": musicxml,
                "saved_to": str(saved),
                "uploaded_image": str(image_path),
                "preprocessed_image": str(preprocessed_path),
                "preprocess_info": preprocess_info,
                "omr_attempt_used": "preprocessed_image",
            }

        # Second attempt: fallback to original image, in case preprocessing removed useful details.
        second_out = tmp_root / "original_attempt"
        second_out.mkdir(parents=True, exist_ok=True)

        second_proc, second_candidates, second_output_files = run_audiveris(
            image_path,
            second_out,
        )

        attempts.append(
            {
                "name": "original_image_fallback",
                "image_path": str(image_path),
                "returncode": second_proc.returncode,
                "stdout_tail": second_proc.stdout[-3000:],
                "stderr_tail": second_proc.stderr[-3000:],
                "output_files": second_output_files,
            }
        )

        if second_proc.returncode == 0 and second_candidates:
            musicxml = read_musicxml(second_candidates[0])

            saved = OUTPUT_DIR / f"{job_id}.musicxml"
            saved.write_text(musicxml, encoding="utf-8")

            return {
                "job_id": job_id,
                "filename": filename,
                "musicxml": musicxml,
                "saved_to": str(saved),
                "uploaded_image": str(image_path),
                "preprocessed_image": str(preprocessed_path),
                "preprocess_info": preprocess_info,
                "omr_attempt_used": "original_image_fallback",
            }

    raise HTTPException(
        status_code=500,
        detail={
            "message": (
                "Audiveris still failed to produce MusicXML after preprocessing. "
                "Try a cleaner printed single-staff image, or open the saved "
                "preprocessed image manually in Audiveris to inspect it."
            ),
            "uploaded_image": str(image_path),
            "preprocessed_image": str(preprocessed_path),
            "preprocess_info": preprocess_info,
            "attempts": attempts,
        },
    )