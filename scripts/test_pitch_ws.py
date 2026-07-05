"""Send a real generated 440 Hz sine wave to the MAIstro WebSocket for pipeline testing.
Usage:
  python scripts/test_pitch_ws.py <session_id>
"""
from __future__ import annotations

import asyncio
import json
import math
import sys

import websockets


async def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python scripts/test_pitch_ws.py <session_id>")
    session_id = sys.argv[1]
    uri = f"ws://localhost:8000/ws/practice/{session_id}"
    sample_rate = 48000
    frame_len = 2048
    async with websockets.connect(uri) as ws:
        print(await ws.recv())
        for frame_no in range(50):
            audio = [0.25 * math.sin(2 * math.pi * 440.0 * (frame_no * frame_len + i) / sample_rate) for i in range(frame_len)]
            await ws.send(json.dumps({"type": "audio_frame", "sample_rate": sample_rate, "audio": audio}))
            print(await ws.recv())
            await asyncio.sleep(0.025)
        await ws.send(json.dumps({"type": "end"}))


if __name__ == "__main__":
    asyncio.run(main())
