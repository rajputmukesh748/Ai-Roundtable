from __future__ import annotations
import os
import asyncpg

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://debate:debate@localhost:5432/debate")
_pool: asyncpg.Pool | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS debates (
    id SERIAL PRIMARY KEY,
    topic TEXT NOT NULL,
    judge_name TEXT NOT NULL,
    rounds INT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agents (
    id SERIAL PRIMARY KEY,
    debate_id INT NOT NULL REFERENCES debates(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    side TEXT NOT NULL,
    custom_prompt TEXT
);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS gender TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS voice TEXT;
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    debate_id INT NOT NULL REFERENCES debates(id) ON DELETE CASCADE,
    seq INT NOT NULL,
    speaker TEXT NOT NULL,
    side TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""


async def init_db():
    global _pool
    _pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=5)
    async with _pool.acquire() as c:
        await c.execute(SCHEMA)


async def close_db():
    if _pool:
        await _pool.close()


def pool() -> asyncpg.Pool:
    assert _pool is not None, "DB not initialised"
    return _pool
