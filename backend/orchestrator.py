from __future__ import annotations
import asyncio
import random
import re
from typing import AsyncIterator, Awaitable, Callable

import guardrails
from fallback import heuristic_result, try_parse_json
from llm import chat_once, chat_stream, strip_think
from prompts import JUDGE_SYSTEM, build_system_prompt, build_user_message, format_history


USER_REPLY_TIMEOUT = 600  # seconds the real user gets to answer before their turn is passed


def mentioned_agents(content: str, agents: list[dict], exclude: str) -> list[dict]:
    """Personas tagged with @Name in `content` (other than `exclude`), in the order they were tagged."""
    found = []
    for a in agents:
        if a["name"] == exclude:
            continue
        m = re.search(r"@" + re.escape(a["name"]) + r"(?!\w)", content, re.I)
        if m:
            found.append((m.start(), a))
    return [a for _, a in sorted(found, key=lambda x: x[0])]


def pick_next(agents: list[dict], history: list[dict], spoken: dict[str, int], remaining: int = 99) -> dict:
    """Random speaker: never the same person twice in a row; the opposing side is
    3x more likely to jump in; people who have spoken less get a boost."""
    last = history[-1] if history else None
    cands = [a for a in agents if not last or a["name"] != last["speaker"]]
    # Make sure everyone gets heard: when turns are running out, only silent people may speak.
    silent = [a for a in cands if spoken[a["name"]] == 0]
    if silent and remaining <= sum(1 for a in agents if spoken[a["name"]] == 0):
        cands = silent
    weights = []
    for a in cands:
        w = 1.0 / (1 + spoken[a["name"]])
        if last and a["side"] != last["side"]:
            w *= 3
        weights.append(w)
    return random.choices(cands, weights=weights, k=1)[0]


async def run_debate(
    topic: str, agents: list[dict], rounds: int, history: list[dict],
    get_user_reply: Callable[[], Awaitable[str]] | None = None,
) -> AsyncIterator[dict]:
    """Yields turn_start / token / turn_end events. Appends finished turns to `history`.
    A persona flagged `is_human` is the real user: we wait for their typed reply instead of calling the model."""
    total = rounds * len(agents)
    spoken = {a["name"]: 0 for a in agents}
    pending: list[dict] = []  # personas tagged with @Name who still owe a reply; only they may answer
    for n in range(1, total + 1):
        agent = pending.pop(0) if pending else pick_next(agents, history, spoken, total - n + 1)
        spoken[agent["name"]] += 1
        human = bool(agent.get("is_human")) and get_user_reply is not None
        yield {"type": "turn_start", "speaker": agent["name"], "side": agent["side"], "turn": n, "total": total, "human": human}
        if human:
            try:
                content = await asyncio.wait_for(get_user_reply(), USER_REPLY_TIMEOUT)
            except asyncio.TimeoutError:
                content = ""
            content = content or "(passed their turn)"
            history.append({"speaker": agent["name"], "side": agent["side"], "content": content})
            pending = _queue_tags(content, agents, agent["name"], pending)
            yield {"type": "turn_end", "content": content}
            continue
        messages = [
            {"role": "system", "content": build_system_prompt(agent, topic)},
            {"role": "user", "content": build_user_message(agent, topic, history)},
        ]
        parts: list[str] = []
        async for tok in chat_stream(messages):
            parts.append(tok)
            yield {"type": "token", "text": tok}
        content = guardrails.mask(strip_think("".join(parts))) or "(no response)"
        history.append({"speaker": agent["name"], "side": agent["side"], "content": content})
        pending = _queue_tags(content, agents, agent["name"], pending)
        yield {"type": "turn_end", "content": content}


def _queue_tags(content: str, agents: list[dict], speaker: str, old: list[dict]) -> list[dict]:
    new = mentioned_agents(content, agents, speaker)
    return new + [a for a in old if a not in new and a["name"] != speaker]


async def run_judge(topic: str, judge_name: str, history: list[dict]) -> dict:
    messages = [
        {"role": "system", "content": JUDGE_SYSTEM.format(name=judge_name, topic=topic)},
        {"role": "user", "content": f"Full debate transcript:\n{format_history(history)}\n\nGive your verdict as JSON."},
    ]
    parsed = None
    for attempt in range(3):  # small models sometimes emit broken JSON; retry before giving up
        try:
            raw = await chat_once(messages, json_mode=True, temperature=0.2 + 0.2 * attempt)
            parsed = try_parse_json(raw)
        except Exception:
            parsed = None
        if parsed:
            break
    return parsed or heuristic_result(history)
