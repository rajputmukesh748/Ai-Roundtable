"""One interface for every model provider: Ollama (local), OpenAI, Google Gemini, or any
OpenAI-compatible server (OpenRouter, Groq, LM Studio, ...). Gemini and OpenAI both speak the
OpenAI chat-completions protocol, so they share one implementation."""
from __future__ import annotations

import json
import os
import re
from typing import AsyncIterator, Optional

import httpx

PROVIDERS = {
    "ollama": {"label": "Ollama (local)", "url": "http://localhost:11434", "needs_key": False, "url_editable": True,
               "hint": "Private and free. Runs on this computer."},
    "openai": {"label": "OpenAI", "url": "https://api.openai.com/v1", "needs_key": True, "url_editable": False,
               "hint": "Highest quality. Needs an API key; usage is billed."},
    "gemini": {"label": "Google Gemini", "url": "https://generativelanguage.googleapis.com/v1beta/openai",
               "needs_key": True, "url_editable": False, "hint": "Fast, with a free tier. Needs an API key."},
    "custom": {"label": "Other (OpenAI-compatible)", "url": "", "needs_key": False, "url_editable": True,
               "hint": "Any OpenAI-compatible server: OpenRouter, Groq, LM Studio, vLLM..."},
}

# Runtime state (loaded from the database at startup, changed via /api/settings).
state: dict = {
    "provider": "ollama",
    "profiles": {p: {"url": v["url"], "model": "", "api_key": ""} for p, v in PROVIDERS.items()},
}
state["profiles"]["ollama"]["url"] = os.getenv("OLLAMA_URL", "http://localhost:11434")
state["profiles"]["ollama"]["model"] = os.getenv("OLLAMA_MODEL", "qwen2.5:7b")


class LLMError(Exception):
    """A readable error that is safe to show the user (never contains the API key)."""


def active() -> tuple[str, dict]:
    p = state["provider"]
    return p, state["profiles"][p]


def model_label() -> str:
    p, prof = active()
    return f"{p}:{prof['model']}"


def normalize_url(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    if url and not url.startswith(("http://", "https://")):
        url = "http://" + url
    return url


THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)


def strip_think(text: str) -> str:
    return THINK_RE.sub("", text).strip()


def _scrub(text: str, key: str) -> str:
    return text.replace(key, "***") if key else text


def _explain(status: int, body: str, key: str) -> LLMError:
    if status in (401, 403) or (status == 400 and "api key" in body.lower()):  # Gemini answers 400 for a bad key
        return LLMError("The API key was rejected. Check that it is correct and has access to this model.")
    if status == 404:
        return LLMError("Model or endpoint not found. Check the model name and URL.")
    if status == 429:
        return LLMError("Rate limit or quota exceeded for this API key.")
    return LLMError(f"The model service returned an error ({status}): {_scrub(body, key)[:200]}")


def _conn_error(e: Exception) -> LLMError:
    return LLMError("Cannot reach the model service. Check the URL, your internet connection, or that Ollama is running.")


# ---------------------------------------------------------------- model listing
async def list_models(provider: str, url: str, api_key: str) -> list[str]:
    base = normalize_url(url) or PROVIDERS[provider]["url"]
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as c:
            if provider == "ollama":
                r = await c.get(f"{base}/api/tags")
                if r.status_code >= 400:
                    raise _explain(r.status_code, r.text, api_key)
                return sorted(m["name"] for m in r.json().get("models", []))
            headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
            r = await c.get(f"{base}/models", headers=headers)
            if r.status_code >= 400:
                raise _explain(r.status_code, r.text, api_key)
            data = r.json()
            ids = [str(m.get("id") or m.get("name", "")).removeprefix("models/") for m in data.get("data", data.get("models", []))]
            ids = [i for i in ids if i]
            if provider == "openai":
                bad = ("embedding", "whisper", "tts", "dall-e", "moderation", "image", "audio", "realtime", "transcribe", "search")
                ids = [i for i in ids if i.startswith(("gpt-", "o1", "o3", "o4", "chatgpt")) and not any(b in i for b in bad)]
            elif provider == "gemini":
                ids = [i for i in ids if "gemini" in i and "embedding" not in i]
            return sorted(set(ids))
    except LLMError:
        raise
    except httpx.HTTPError as e:
        raise _conn_error(e)


# ---------------------------------------------------------------- chat
def _reasoning_model(provider: str, model: str) -> bool:
    return provider == "openai" and bool(re.match(r"^(o\d|gpt-5)", model))


def _oa_request(provider: str, prof: dict, messages, stream: bool, json_mode: bool, max_tokens: int, temperature: float):
    base = normalize_url(prof["url"]) or PROVIDERS[provider]["url"]
    headers = {"Content-Type": "application/json"}
    if prof["api_key"]:
        headers["Authorization"] = f"Bearer {prof['api_key']}"
    body: dict = {"model": prof["model"], "messages": messages, "stream": stream}
    if provider == "openai":
        # Newer OpenAI models count hidden reasoning in this limit and only allow default temperature.
        body["max_completion_tokens"] = max(max_tokens * 10, 1500) if _reasoning_model(provider, prof["model"]) else max_tokens
    else:
        body["max_tokens"] = max_tokens
    if not _reasoning_model(provider, prof["model"]):
        body["temperature"] = temperature
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    return f"{base}/chat/completions", headers, body


def _ollama_request(prof: dict, messages, stream: bool, json_mode: bool, max_tokens: int, num_ctx: int, temperature: float):
    base = normalize_url(prof["url"])
    body: dict = {
        "model": prof["model"], "messages": messages, "stream": stream,
        "think": False,  # top level, NOT inside options
        "options": {"num_predict": max_tokens, "num_ctx": num_ctx, "temperature": temperature},
    }
    if json_mode:
        body["format"] = "json"
    return f"{base}/api/chat", {}, body


async def chat_stream(messages, num_predict: int = 110) -> AsyncIterator[str]:
    provider, prof = active()
    if not prof["model"]:
        raise LLMError("No model selected. Connect a model on the home page first.")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=15.0)) as c:
            if provider == "ollama":
                url, headers, body = _ollama_request(prof, messages, True, False, num_predict, 4096, 0.8)
            else:
                url, headers, body = _oa_request(provider, prof, messages, True, False, num_predict, 0.8)
            async with c.stream("POST", url, json=body, headers=headers) as r:
                if r.status_code >= 400:
                    raise _explain(r.status_code, (await r.aread()).decode("utf-8", "ignore"), prof["api_key"])
                async for line in r.aiter_lines():
                    if not line:
                        continue
                    if provider == "ollama":
                        d = json.loads(line)
                        tok = d.get("message", {}).get("content", "")
                        if tok:
                            yield tok
                        if d.get("done"):
                            break
                    else:
                        if not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if payload == "[DONE]":
                            break
                        try:
                            ch = json.loads(payload).get("choices") or []
                        except json.JSONDecodeError:
                            continue
                        tok = (ch[0].get("delta") or {}).get("content") if ch else None
                        if tok:
                            yield tok
    except LLMError:
        raise
    except httpx.HTTPError as e:
        raise _conn_error(e)


async def chat_once(messages, json_mode: bool = False, num_predict: int = 700, num_ctx: int = 8192, temperature: float = 0.2) -> str:
    provider, prof = active()
    if not prof["model"]:
        raise LLMError("No model selected. Connect a model on the home page first.")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=15.0)) as c:
            if provider == "ollama":
                url, headers, body = _ollama_request(prof, messages, False, json_mode, num_predict, num_ctx, temperature)
            else:
                url, headers, body = _oa_request(provider, prof, messages, False, json_mode, num_predict, temperature)
            r = await c.post(url, json=body, headers=headers)
            if r.status_code >= 400:
                raise _explain(r.status_code, r.text, prof["api_key"])
            d = r.json()
            text = d.get("message", {}).get("content", "") if provider == "ollama" else (d["choices"][0]["message"].get("content") or "")
            return strip_think(text)
    except LLMError:
        raise
    except httpx.HTTPError as e:
        raise _conn_error(e)
