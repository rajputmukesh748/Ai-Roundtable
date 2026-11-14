# Implementation Plan: AI Multi-Agent Debate Platform

> Give this file to any AI coding assistant to implement the project end-to-end.

---

## 1. Project Summary

Build a local web application where a user:
1. Enters a debate topic.
2. Manually creates N AI personas (name + side: For/Against + optional custom prompt).
3. Assigns one persona as the Judge.
4. Clicks Start -> personas debate in a chat-style UI (streaming bubbles).
5. After the debate ends, the Judge outputs a percentage result + key points in a visual card.

Hard constraints:
- Use only ONE Ollama model for all roles (e.g., qwen2.5:7b or ministral-3:3b).
- All inference is local via Ollama (http://localhost:11434).
- No cloud APIs.
- Frontend must show the debate as chat bubbles.

---

## 2. Tech Stack (fixed)

| Layer | Choice |
|-------|--------|
| Model runtime | Ollama (single model) |
| Backend | Python 3.11 + FastAPI + ollama Python SDK |
| Streaming | WebSocket (fastapi.WebSocket) |
| Frontend | Plain HTML + CSS + vanilla JS (no build step) |
| Storage | In-memory Python dict (no DB) |

Do NOT introduce React, Next.js, Docker, or databases.

---

## 3. File Structure (create exactly this)

debate-app/
  backend/
    main.py
    orchestrator.py
    ollama_client.py
    prompts.py
    fallback.py
  frontend/
    index.html
    debate.html
    style.css
    app.js
  requirements.txt
  README.md

---

## 4. Environment Setup

### 4.1 requirements.txt

fastapi==0.115.0
uvicorn[standard]==0.30.6
ollama==0.3.3
pydantic==2.9.2

### 4.2 Ollama env vars

export OLLAMA_MAX_LOADED_MODELS=1
export OLLAMA_NUM_PARALLEL=1
ollama serve
ollama pull qwen2.5:7b

### 4.3 Run command

cd backend
uvicorn main:app --reload --port 8000

Open http://localhost:8000

---

## 5. Backend Specification

### 5.1 ollama_client.py

See full code in the chat message above (sections 5.1 through 5.5).
Key rules:
- think: False at TOP LEVEL of payload (not inside options).
- num_predict: 512, num_ctx: 4096, temperature: 0.8.
- Strip <think>...</think> tags before returning.
- Use format: "json" for the judge call.

### 5.2 prompts.py
- FOR_SYSTEM: defend the topic; rebut opposing side; never concede; under 120 words.
- AGAINST_SYSTEM: ruthless skeptic; attack premise; never say "you're right"; under 120 words.
- JUDGE_SYSTEM: output ONLY valid JSON with winner, percentage, key_points_for, key_points_against, summary.
- STANCE_REMINDER: prepended to every user message to prevent persona collapse.
- build_system_prompt(agent, topic): returns custom prompt or default template.
- build_user_message(agent, topic, history): includes last 10 messages only.

### 5.3 fallback.py
- try_parse_json(text): strips <think> tags, extracts first {...}, validates schema. Returns None on failure.
- heuristic_result(history): counts turns per side, returns a result dict with fallback=True.

### 5.4 orchestrator.py
- run_debate(topic, agents, rounds): async generator yielding turn_start, token, turn_end events.
- run_judge(topic, judge_name, history): builds judge messages, calls chat_once with json_mode=True, parses, falls back to heuristic if invalid.

### 5.5 main.py
- FastAPI app.
- Serve frontend/ as static files at /static.
- GET / -> index.html
- GET /debate -> debate.html
- WebSocket /ws/debate:
  - Receives JSON config on connect.
  - Validates: 1-6 agents, at least one for and one against, unique names.
  - Streams run_debate events to client.
  - Sends {"type": "judging"} then run_judge result.
  - On any exception: send {"type": "error", "message": ...} and close.

---

## 6. Frontend Specification

### 6.1 index.html (setup form)
- textarea#topic
- Dynamic persona rows: name input, side select (for/against), optional custom prompt (collapsed), remove button.
- "Add persona" button.
- judge_name input (default "Moderator").
- rounds number input (default 2, min 1, max 5).
- Start Debate button: validates then saves config to sessionStorage["debateConfig"] and navigates to /debate.
- Inline validation messages for: empty topic, missing for/against, duplicate names, >6 personas.

### 6.2 debate.html
- div#chat for bubbles.
- div#result (hidden initially).
- div#status for connection/state text.

### 6.3 app.js
- Read sessionStorage["debateConfig"]; redirect to / if missing.
- Open WebSocket to ws://<host>/ws/debate.
- On open: send config.
- Handle events:
  - turn_start: create bubble div.bubble.side-<side> with <span.speaker> and <div.content>. Set as active.
  - token: append text to active .content. Scroll into view.
  - turn_end: clear active refs.
  - judging: status = "Judge is deliberating..."
  - result: render result card (progress bar + two columns + summary). If data.fallback, show yellow warning.
  - error: show in status.
- ALWAYS escape HTML in model output.

### 6.4 style.css
- .bubble.side-for: green-tinted, left-aligned.
- .bubble.side-against: red-tinted, right-aligned.
- .bubble .speaker: bold, small, colored.
- .bar: flex; .bar-for green; .bar-against red; centered percentage.
- .warn: yellow background, dark text.
- .hidden: display none.

---

## 7. Validation Rules (enforce both frontend and backend)
- Topic not empty.
- 1 <= persona count <= 6.
- At least one for and one against.
- Persona names unique and non-empty.

Backend must re-validate; never trust client.

---

## 8. Testing Checklist

| # | Test | Expected |
|---|------|----------|
| 1 | ollama pull qwen2.5:7b; ollama serve | Model available |
| 2 | 1 For + 1 Against, rounds=1 | Two bubbles, streaming tokens |
| 3 | 2 For + 2 Against, rounds=2 | 8 turns in order; no persona concedes |
| 4 | Judge outputs valid JSON | Result card shows winner, %, key points |
| 5 | Force bad judge output (num_predict=5) | Fallback triggers; yellow warning |
| 6 | Only For personas | Backend returns error |
| 7 | 7 personas | Backend returns "Max 6 debaters" |
| 8 | Duplicate names | Frontend blocks submission |
| 9 | Persona collapses | Strengthen AGAINST_SYSTEM prompt, re-run test 3 |
| 10 | 3-role x 2-round debate | < 90 seconds |

---

## 9. Known Risks & Required Mitigations

| Risk | Mitigation |
|------|-----------|
| Persona collapse | Use exact AGAINST_SYSTEM prompt; prepend STANCE_REMINDER every turn |
| JSON parse failure | format="json" + try_parse_json + heuristic_result fallback |
| Context overflow | Slice history[-10:]; num_ctx=4096 |
| Empty response from reasoning model | think=False at top level; strip <think> tags |
| Slow generation | Stream tokens; status indicator |
| XSS via model output | escapeHtml on all model text before DOM insert |

---

## 10. Out of Scope (do NOT implement)
- User accounts / auth
- Database persistence
- Multiple model selection
- Mobile app
- CSS frameworks (Tailwind, Bootstrap)
- Docker
- Deployment scripts

Keep the MVP minimal.

---

## 11. Definition of Done

1. uvicorn main:app starts without errors.
2. index.html renders and lets the user add/remove personas.
3. Submitting navigates to /debate and streams chat bubbles.
4. After the final round, a result card appears with winner, percentage bar, and key points.
5. Tests 1-8 in Section 8 pass.
6. Test 9 passes (persona does not collapse).
7. No unhandled exceptions in the server console during a full debate.

---

End of implementation plan.