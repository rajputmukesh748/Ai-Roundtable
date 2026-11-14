# AI Roundtable

AI characters debate any topic out loud, and an AI judge scores who argued better. Pick the AI that powers it: a local model (Ollama) or an online one (OpenAI, Google Gemini, or any OpenAI-compatible API with your API key). Stack: Next.js frontend, FastAPI backend, Piper voices and PostgreSQL in Docker.

Powered by Mukesh.

- Project overview for presenting: [docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md)
- Slide deck (PDF): [docs/presentation.pdf](docs/presentation.pdf). The animated version is [docs/presentation.html](docs/presentation.html) (open in a browser, use arrow keys)

## What it does

1. Choose and connect a model on the home page: local (Ollama) or online (OpenAI, Gemini, other).
2. Enter a topic, add 2-6 debaters (For or Against, Male or Female) and choose 5-50 turns per debater.
3. Watch a live, spoken debate: random speakers, short plain replies, a pause between messages.
4. Read the judge's verdict: winner, percentage, scorecard, reasons and key points.

The five latest debates are listed on the home page and reopen with their full verdict.

## Requirements

- Python 3.9+ and Node.js 18+
- Docker (for PostgreSQL)
- A model provider, either:
  - [Ollama](https://ollama.com) with a model pulled, e.g. `ollama pull qwen2.5:7b` (local, free, private), or
  - an API key for OpenAI, Google Gemini, or another OpenAI-compatible service

## Run it

```bash
# 1. Database
docker compose up -d

# 2. Ollama (skip if you only use an online provider)
export OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_NUM_PARALLEL=1
ollama serve &
ollama pull qwen2.5:7b

# 3. Backend (http://localhost:8000)
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# 4. Frontend (http://localhost:3000)
cd frontend
npm install
npm run dev
```

Open http://localhost:3000 and connect a model in the "AI model" card (see below).

## Choosing a model provider

| Provider | Best for | Cost | Where your text goes |
| --- | --- | --- | --- |
| Ollama (local) | Privacy, offline use, no cost | Free | Stays on your computer |
| OpenAI | Highest-quality debates and verdicts | Paid per use | Sent to OpenAI |
| Google Gemini | Fast replies; has a free tier (limits apply) | Free tier, then paid | Sent to Google |
| Other (OpenAI-compatible) | OpenRouter, Groq, LM Studio, vLLM and similar | Varies | Depends on the server |

Which is best? For the best quality, use OpenAI or Gemini. For privacy and zero cost, use Ollama with the largest model your computer can run. Small local models can repeat themselves and judge less reliably.

To connect: choose the provider from the dropdown, paste your API key (not needed for Ollama), press **Test connection**, choose a model from the list, then **Save & connect**. You can switch providers at any time; each provider remembers its own key and model.

API keys are stored only in your local database and sent only to the provider you chose. They are never sent back to the browser. Use **Remove saved key** to delete one.

## Neural voices (Piper)

Download the voices once (about 60 MB each) into `backend/voices`:

```bash
cd backend && source .venv/bin/activate
for v in en_US-ryan-medium en_US-amy-medium en_GB-alan-medium en_US-lessac-medium; do
  python -m piper.download_voices $v --download-dir voices
done
```

Male voices are Ryan and Alan; female voices are Amy and Lessac. The voice is chosen automatically from each debater's gender. Without these files the app falls back to the browser's built-in voices.

## Project structure

```
backend/    FastAPI app: debate orchestration, judge, model providers (llm.py), TTS, database
frontend/   Next.js app: home page, debate page, settings page
docs/       Project overview and slide deck
docker-compose.yml   PostgreSQL
```

## Configuration

| Setting | Where | Default |
| --- | --- | --- |
| `DATABASE_URL` | backend env | `postgresql://debate:debate@localhost:5432/debate` |
| `OLLAMA_URL`, `OLLAMA_MODEL` | backend env defaults for Ollama | `http://localhost:11434`, `qwen2.5:7b` |
| `CORS_ORIGINS` | backend env | `http://localhost:3000` |
| `NEXT_PUBLIC_API_URL` | frontend env | `http://localhost:8000` |

The provider, model and API keys chosen in the app are saved in the database and override the env defaults.

## API

- `WS /ws/debate`: send the config; receives `started`, `turn_start`, `token`, `turn_end`, `judging`, `result`, `error`
- `GET /api/debates?limit=5`, `GET /api/debates/{id}`, `DELETE /api/debates/{id}`
- `POST /api/models/list`: list the models a provider offers (uses the saved key if none is sent)
- `GET/PUT /api/settings`: read/save the provider, URL, model and key (keys are never returned, only whether one is saved)
- `DELETE /api/settings/key/{provider}`: remove a saved API key
- `GET /api/tts/status`, `POST /api/tts`: voices and speech audio
- `GET /api/health`

## How the judge works

The judge scores each side 0-10 on argument, evidence, rebuttal and clarity. The app computes the percentage and winner from those scores (53% or more wins, 47-53% is a draw) and shows a short reason. Malformed judge output is retried up to three times.

## Notes

- A small local model can repeat itself or judge imperfectly; a larger or online model gives better debates.
- Online providers receive the debate text and may charge for usage. Local Ollama keeps everything on your computer.
- The debate length is "turns per debater", so total messages = turns x debaters.
