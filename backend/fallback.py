from __future__ import annotations
import json
import re

from llm import strip_think


CRITERIA = ("argument", "evidence", "rebuttal", "clarity")


def _scores(d) -> dict | None:
    try:
        out = {k: max(0.0, min(10.0, float(d[k]))) for k in CRITERIA}
        return out
    except (KeyError, TypeError, ValueError):
        return None


def try_parse_json(text: str):
    text = strip_think(text or "")
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
        sf, sa = _scores(d["for"]), _scores(d["against"])
        if not sf or not sa:
            return None
        kf, ka = d["key_points_for"], d["key_points_against"]
        if not isinstance(kf, list) or not isinstance(ka, list):
            return None
        tf, ta = sum(sf.values()), sum(sa.values())
        # Percentage and winner are computed here from the scores, not trusted from the model.
        pct = round(100 * tf / (tf + ta)) if (tf + ta) > 0 else 50
        winner = "for" if pct >= 53 else "against" if pct <= 47 else "draw"
        return {
            "winner": winner,
            "percentage": pct,
            "scores": {"for": sf, "against": sa},
            "key_points_for": [str(x) for x in kf][:4],
            "key_points_against": [str(x) for x in ka][:4],
            "reason": str(d.get("reason", "")),
            "summary": str(d.get("summary", "")),
            "fallback": False,
        }
    except (KeyError, ValueError, TypeError, json.JSONDecodeError):
        return None


def heuristic_result(history: list[dict]) -> dict:
    f = sum(1 for m in history if m["side"] == "for")
    a = sum(1 for m in history if m["side"] == "against")
    total = max(f + a, 1)
    pct = round(100 * f / total)
    winner = "draw" if f == a else ("for" if f > a else "against")
    return {
        "winner": winner,
        "percentage": pct,
        "key_points_for": [],
        "key_points_against": [],
        "summary": "The judge's output could not be parsed, so this result is based only on turn counts.",
        "fallback": True,
    }
