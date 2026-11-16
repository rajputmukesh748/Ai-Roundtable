from __future__ import annotations
from typing import Optional
import json
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
import tts

import db
import guardrails
import llm
from llm import LLMError, PROVIDERS, list_models, normalize_url
from orchestrator import run_debate, run_judge


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_db()
    await load_llm_settings()
    yield
    await db.close_db()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:3000").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


def moderation_error(cfg: dict) -> str | None:
    """Guardrails over every free-text field the user typed."""
    fields = [("Topic", cfg.get("topic")), ("Judge name", cfg.get("judge_name"))]
    for a in cfg.get("agents") or []:
        if isinstance(a, dict):
            fields += [("Persona name", a.get("name")), ("Custom prompt", a.get("custom_prompt"))]
    for label, text in fields:
        warn = guardrails.check(str(text or ""))
        if warn:
            return f"{label}: {warn}"
    return None


def validate(cfg: dict) -> str | None:
    """Return an error message or None. Never trust the client."""
    topic = (cfg.get("topic") or "").strip()
    agents = cfg.get("agents") or []
    if not topic:
        return "Topic is required"
    bad = moderation_error(cfg)
    if bad:
        return bad
    if not isinstance(agents, list) or not (1 <= len(agents) <= 6):
        return "Max 6 debaters (and at least 1)"
    names = []
    for a in agents:
        n = (a.get("name") or "").strip()
        if not n:
            return "Persona names must be non-empty"
        if a.get("gender", "male") not in ("male", "female"):
            return "Gender must be 'male' or 'female'"
        if a.get("side") not in ("for", "against"):
            return "Side must be 'for' or 'against'"
        names.append(n.lower())
    if sum(1 for a in agents if a.get("is_human")) > 1:
        return "Only one persona can be a real user"
    if len(set(names)) != len(names):
        return "Persona names must be unique"
    sides = {a["side"] for a in agents}
    if sides != {"for", "against"}:
        return "Need at least one 'for' and one 'against' persona"
    try:
        r = int(cfg.get("rounds", 2))
    except (TypeError, ValueError):
        return "Rounds must be a number"
    if not (5 <= r <= 50):
        return "Turns per persona must be between 5 and 50"
    if not (cfg.get("judge_name") or "").strip():
        return "Judge name is required"
    return None


async def load_llm_settings():
    rows = {r["key"]: r["value"] for r in await db.pool().fetch("SELECT key, value FROM settings")}
    # Older versions stored only the Ollama url/model.
    if "ollama_url" in rows:
        llm.state["profiles"]["ollama"]["url"] = rows["ollama_url"]
    if "ollama_model" in rows:
        llm.state["profiles"]["ollama"]["model"] = rows["ollama_model"]
    for prov in PROVIDERS:
        if f"llm_{prov}" in rows:
            try:
                llm.state["profiles"][prov].update(json.loads(rows[f"llm_{prov}"]))
            except (ValueError, TypeError):
                pass
    if rows.get("llm_provider") in PROVIDERS:
        llm.state["provider"] = rows["llm_provider"]


def public_settings() -> dict:
    """What the browser may see. API keys are never sent back, only whether one is saved."""
    prov, prof = llm.active()
    return {
        "provider": prov,
        "url": prof["url"],
        "model": prof["model"],
        "has_key": {p: bool(v["api_key"]) for p, v in llm.state["profiles"].items()},
        "profiles": {p: {"url": v["url"], "model": v["model"]} for p, v in llm.state["profiles"].items()},
        "providers": [{"id": k, **v} for k, v in PROVIDERS.items()],
    }


@app.get("/api/health")
async def health():
    return {"ok": True, "provider": llm.state["provider"], "model": llm.active()[1]["model"]}


@app.post("/api/moderate")
async def moderate(cfg: dict):
    """Pre-flight check so the home page can warn before a debate starts."""
    return {"ok": (err := moderation_error(cfg)) is None, "message": err}


@app.get("/api/tts/status")
async def tts_status():
    vs = tts.available_voices()
    return {"available": bool(vs), "voices": vs}


@app.post("/api/tts")
async def tts_speak(body: dict):
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text required")
    try:
        audio = await tts.speak(text, str(body.get("voice", "")))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"TTS unavailable: {e}")
    return Response(content=audio, media_type="audio/wav")


@app.get("/api/settings")
async def get_settings():
    return public_settings()


@app.post("/api/models/list")
async def models(body: dict):
    """List the models a provider offers. A blank key falls back to the key already saved for that provider."""
    prov = body.get("provider", "ollama")
    if prov not in PROVIDERS:
        raise HTTPException(400, "Unknown provider")
    saved = llm.state["profiles"][prov]
    url = body.get("url") or saved["url"]
    key = (body.get("api_key") or "").strip() or saved["api_key"]
    if PROVIDERS[prov]["needs_key"] and not key:
        return {"ok": False, "models": [], "error": "Enter your API key first."}
    try:
        return {"ok": True, "models": await list_models(prov, url, key)}
    except LLMError as e:
        return {"ok": False, "models": [], "error": str(e)}


@app.put("/api/settings")
async def save_settings(body: dict):
    prov = body.get("provider", "ollama")
    if prov not in PROVIDERS:
        raise HTTPException(400, "Unknown provider")
    prof = llm.state["profiles"][prov]
    url = normalize_url(body.get("url", "")) or PROVIDERS[prov]["url"]
    model = (body.get("model") or "").strip()
    key = (body.get("api_key") or "").strip() or prof["api_key"]  # blank = keep the saved key
    if not url or not model:
        raise HTTPException(400, "URL and model are required")
    if PROVIDERS[prov]["needs_key"] and not key:
        raise HTTPException(400, "An API key is required for this provider")
    if not PROVIDERS[prov]["url_editable"]:
        url = PROVIDERS[prov]["url"]
    prof.update(url=url, model=model, api_key=key)
    llm.state["provider"] = prov
    p = db.pool()
    await p.execute(
        "INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2",
        f"llm_{prov}", json.dumps(prof),
    )
    await p.execute(
        "INSERT INTO settings (key, value) VALUES ('llm_provider',$1) ON CONFLICT (key) DO UPDATE SET value=$1", prov
    )
    return public_settings()


@app.delete("/api/settings/key/{provider}")
async def delete_key(provider: str):
    if provider not in PROVIDERS:
        raise HTTPException(404, "Unknown provider")
    prof = llm.state["profiles"][provider]
    prof["api_key"] = ""
    await db.pool().execute("UPDATE settings SET value=$2 WHERE key=$1", f"llm_{provider}", json.dumps(prof))
    return public_settings()


@app.get("/api/debates")
async def list_debates(limit: int = 50):
    rows = await db.pool().fetch(
        "SELECT id, topic, status, rounds, result, created_at FROM debates ORDER BY id DESC LIMIT $1",
        max(1, min(limit, 100)),
    )
    return [
        {**dict(r), "result": json.loads(r["result"]) if r["result"] else None, "created_at": r["created_at"].isoformat()}
        for r in rows
    ]


@app.get("/api/debates/{debate_id}")
async def get_debate(debate_id: int):
    p = db.pool()
    d = await p.fetchrow("SELECT * FROM debates WHERE id=$1", debate_id)
    if not d:
        raise HTTPException(404, "Debate not found")
    msgs = await p.fetch(
        "SELECT speaker, side, content FROM messages WHERE debate_id=$1 ORDER BY seq", debate_id
    )
    agents = await p.fetch("SELECT name, side, is_human FROM agents WHERE debate_id=$1 ORDER BY id", debate_id)
    return {
        "id": d["id"],
        "topic": d["topic"],
        "judge_name": d["judge_name"],
        "rounds": d["rounds"],
        "status": d["status"],
        "result": json.loads(d["result"]) if d["result"] else None,
        "agents": [dict(a) for a in agents],
        "messages": [dict(m) for m in msgs],
    }


@app.delete("/api/debates/{debate_id}")
async def delete_debate(debate_id: int):
    await db.pool().execute("DELETE FROM debates WHERE id=$1", debate_id)
    return {"ok": True}


@app.websocket("/ws/debate")
async def ws_debate(ws: WebSocket):
    await ws.accept()
    debate_id = None
    try:
        cfg = await ws.receive_json()
        err = validate(cfg)
        if err:
            await ws.send_json({"type": "error", "message": err})
            await ws.close()
            return

        topic = cfg["topic"].strip()
        judge = cfg["judge_name"].strip()
        rounds = int(cfg.get("rounds", 2))
        agents = [
            {"name": a["name"].strip(), "side": a["side"], "custom_prompt": (a.get("custom_prompt") or "").strip() or None,
             "gender": a.get("gender", "male"), "voice": a.get("voice") or None, "is_human": bool(a.get("is_human"))}
            for a in cfg["agents"]
        ]

        p = db.pool()
        debate_id = await p.fetchval(
            "INSERT INTO debates (topic, judge_name, rounds, model) VALUES ($1,$2,$3,$4) RETURNING id",
            topic, judge, rounds, llm.model_label(),
        )
        await p.executemany(
            "INSERT INTO agents (debate_id, name, side, custom_prompt, gender, voice, is_human) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [(debate_id, a["name"], a["side"], a["custom_prompt"], a["gender"], a["voice"], a["is_human"]) for a in agents],
        )
        await ws.send_json({"type": "started", "debate_id": debate_id})

        history: list[dict] = []
        saved = 0
        async def get_user_reply() -> str:
            """Wait for the real user's message; ignore anything else the client sends meanwhile."""
            while True:
                msg = await ws.receive_json()
                if isinstance(msg, dict) and msg.get("type") == "user_reply":
                    text = str(msg.get("content") or "").strip()[:1000]
                    warn = guardrails.check(text)
                    if warn:  # reject and keep waiting for a clean reply
                        await ws.send_json({"type": "user_warning", "message": warn})
                        continue
                    return text

        async for ev in run_debate(topic, agents, rounds, history, get_user_reply):
            await ws.send_json(ev)
            if ev["type"] == "turn_end":
                m = history[-1]
                saved += 1
                await p.execute(
                    "INSERT INTO messages (debate_id, seq, speaker, side, content) VALUES ($1,$2,$3,$4,$5)",
                    debate_id, saved, m["speaker"], m["side"], m["content"],
                )

        await ws.send_json({"type": "judging"})
        result = await run_judge(topic, judge, history)
        await p.execute(
            "UPDATE debates SET status='finished', result=$2::jsonb WHERE id=$1",
            debate_id, json.dumps(result),
        )
        await ws.send_json({"type": "result", "data": result})
        await ws.close()
    except WebSocketDisconnect:
        if debate_id:
            await db.pool().execute("UPDATE debates SET status='aborted' WHERE id=$1 AND status='running'", debate_id)
    except Exception as e:  # noqa: BLE001
        if debate_id:
            await db.pool().execute("UPDATE debates SET status='error' WHERE id=$1", debate_id)
        try:
            await ws.send_json({"type": "error", "message": str(e) if isinstance(e, LLMError) else f"{type(e).__name__}: {e}"})
            await ws.close()
        except Exception:
            pass
