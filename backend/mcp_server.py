from __future__ import annotations

import json
from typing import Any

from mcp.server.fastmcp import FastMCP

from .db import Database, decode_notes_json

mcp = FastMCP("MAIstro MCP")
db = Database()


@mcp.tool()
def get_sheet_metadata(sheet_id: str) -> dict[str, Any]:
    """Return metadata and parsed note events for one uploaded sheet."""
    sheet = db.get_sheet(sheet_id)
    if not sheet:
        return {"error": "sheet_not_found", "sheet_id": sheet_id}
    return {
        "sheet_id": sheet["sheet_id"],
        "filename": sheet["filename"],
        "notes_count": sheet["notes_count"],
        "duration_seconds": sheet["duration_seconds"],
        "difficulty_score": sheet["difficulty_score"],
        "uploaded_at": sheet["uploaded_at"],
        "notes": decode_notes_json(sheet),
    }


@mcp.tool()
def get_session_summary(session_id: str) -> dict[str, Any]:
    """Return summarized performance statistics and recent mistakes for a session."""
    session = db.get_session(session_id)
    if not session:
        return {"error": "session_not_found", "session_id": session_id}
    stats = db.compute_session_stats(session_id)
    stats["recent_mistakes"] = db.get_recent_mistakes(session_id, limit=20)
    return stats


@mcp.tool()
def get_difficult_measures(session_id: str) -> list[dict[str, Any]]:
    """Return measures with the most logged pitch mistakes."""
    return db.difficult_measures(session_id)


@mcp.tool()
def generate_practice_feedback(session_id: str) -> dict[str, Any]:
    """Generate deterministic practice feedback from stored MAIstro session data."""
    session = db.get_session(session_id)
    if not session:
        return {"error": "session_not_found", "session_id": session_id}
    stats = db.compute_session_stats(session_id)
    difficult = db.difficult_measures(session_id)
    accuracy_pct = stats["pitch_accuracy"] * 100
    advice: list[str] = []
    if accuracy_pct >= 90:
        advice.append("Pitch accuracy is strong. Increase tempo by 5 BPM only if the same accuracy is maintained twice in a row.")
    elif accuracy_pct >= 75:
        advice.append("Pitch accuracy is acceptable but still unstable. Repeat the most difficult measures at 10–15 BPM slower.")
    else:
        advice.append("Pitch accuracy needs focused slow practice. Reduce tempo by 20 BPM and isolate one difficult measure at a time.")
    if difficult:
        top = difficult[0]
        advice.append(f"Start with measure {top['measure']} because it has the highest mistake count ({top['mistakes']}).")
    if stats["mistakes_count"] == 0 and stats["pitch_frames_count"] > 0:
        advice.append("No pitch mistakes were logged within the configured ±50-cent tolerance.")
    return {"session_id": session_id, "stats": stats, "difficult_measures": difficult[:5], "recommendations": advice}


@mcp.resource("maistro://sheet/{sheet_id}/musicxml")
def sheet_musicxml(sheet_id: str) -> str:
    """Expose MusicXML data for one sheet as an MCP resource."""
    sheet = db.get_sheet(sheet_id)
    if not sheet:
        return ""
    return sheet["musicxml_data"]


@mcp.resource("maistro://session/{session_id}/mistakes")
def session_mistakes(session_id: str) -> str:
    """Expose session mistakes as JSON."""
    return json.dumps(db.get_recent_mistakes(session_id, limit=100), indent=2)


if __name__ == "__main__":
    # Stdio transport is the simplest way for MCP hosts such as Claude Desktop or MCP Inspector to connect.
    mcp.run()
