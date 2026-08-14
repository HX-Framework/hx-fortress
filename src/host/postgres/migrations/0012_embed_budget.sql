-- 0012 · durable daily OpenAI embed-token budget (M-9e). One row per UTC day
-- accumulates the estimated tokens the embed worker has sent to OpenAI; the
-- worker reads today's spend before a pass and stops claiming for the day once
-- it crosses FORTRESS_EMBED_DAILY_TOKEN_BUDGET. Durable so the ceiling survives a
-- restart (an in-memory counter would reset and blow the budget on every crash).
-- The `day` key is the UTC date — the worker reads/upserts on
-- `(now() at time zone 'utc')::date`, NOT server-local CURRENT_DATE — so the
-- rollover is timezone-independent.
CREATE TABLE IF NOT EXISTS "hx"."embed_budget" (
	"day" date PRIMARY KEY NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL
);
