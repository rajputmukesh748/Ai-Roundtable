from __future__ import annotations

import asyncio
import io
import wave
from pathlib import Path

VOICE_DIR = Path(__file__).parent / "voices"
# Mixed male/female so personas sound distinct. Downloaded with: python -m piper.download_voices <name> --download-dir voices
VOICES = [
    {"id": "en_US-ryan-medium", "label": "Ryan", "gender": "male"},
    {"id": "en_GB-alan-medium", "label": "Alan (British)", "gender": "male"},
    {"id": "en_US-amy-medium", "label": "Amy", "gender": "female"},
    {"id": "en_US-lessac-medium", "label": "Lessac", "gender": "female"},
]

_loaded: dict = {}
_lock = asyncio.Lock()


def available_voices() -> list[dict]:
    return [v for v in VOICES if (VOICE_DIR / f"{v['id']}.onnx").exists()]


def _synth(name: str, text: str, length_scale: float) -> bytes:
    from piper import PiperVoice, SynthesisConfig

    if name not in _loaded:
        _loaded[name] = PiperVoice.load(str(VOICE_DIR / f"{name}.onnx"))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        _loaded[name].synthesize_wav(text, w, syn_config=SynthesisConfig(length_scale=length_scale))
    return buf.getvalue()


async def speak(text: str, voice_id: str) -> bytes:
    ids = {v["id"] for v in available_voices()}
    if not ids:
        raise RuntimeError("No Piper voices installed")
    name = voice_id if voice_id in ids else sorted(ids)[0]
    async with _lock:  # one synthesis at a time; keeps CPU free for the LLM
        return await asyncio.to_thread(_synth, name, text.strip()[:500], 1.08)  # slightly slower = calmer
