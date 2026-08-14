// Per-model API price map (USD per 1M tokens), ported verbatim from the cloud
// gateway's hx-pricing so fortress accumulates the same est_cost_usd the cloud
// would. The same rates seed the hx.models per-Mtok columns (single source of
// truth). Prices change; this map is the one place to update.
//
// Cache rates follow Anthropic's published multipliers: cache-read ≈ 0.1× input,
// 5-minute cache-write ≈ 1.25× input.

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ModelPrice {
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheWritePerMtok: number;
}

/** input/output per 1M tokens; cache rates derived from Anthropic multipliers. */
function anthropic(inputPerMtok: number, outputPerMtok: number): ModelPrice {
  return {
    inputPerMtok,
    outputPerMtok,
    cacheReadPerMtok: inputPerMtok / 10,
    cacheWritePerMtok: inputPerMtok * 1.25,
  };
}

export const PRICES: Record<string, ModelPrice> = {
  // Anthropic (authoritative — claude-api skill)
  "claude-fable-5": anthropic(10, 50),
  "claude-opus-4-8": anthropic(5, 25),
  "claude-opus-4-7": anthropic(5, 25),
  "claude-opus-4-6": anthropic(5, 25),
  "claude-opus-4-5": anthropic(5, 25),
  "claude-sonnet-4-6": anthropic(3, 15),
  "claude-sonnet-4-5": anthropic(3, 15),
  "claude-haiku-4-5": anthropic(1, 5),
  // OpenAI (Codex sessions) — no separate cache-write tier, so cacheWrite == input.
  "gpt-5": { inputPerMtok: 1.25, outputPerMtok: 10, cacheReadPerMtok: 0.125, cacheWritePerMtok: 1.25 },
  "gpt-5-codex": { inputPerMtok: 1.25, outputPerMtok: 10, cacheReadPerMtok: 0.125, cacheWritePerMtok: 1.25 },
  // Z.AI / Zhipu GLM — cache-read at published cached-input rate; cacheWrite == input.
  "glm-4.5": { inputPerMtok: 0.6, outputPerMtok: 2.2, cacheReadPerMtok: 0.11, cacheWritePerMtok: 0.6 },
  "glm-4.6": { inputPerMtok: 0.6, outputPerMtok: 2.2, cacheReadPerMtok: 0.11, cacheWritePerMtok: 0.6 },
  "glm-5.2": { inputPerMtok: 0.6, outputPerMtok: 2.2, cacheReadPerMtok: 0.11, cacheWritePerMtok: 0.6 },
};

/** Exact match first; then case-insensitive prefix match (handles dated suffixes). */
export function priceForModel(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const exact = PRICES[model];
  if (exact) return exact;
  const lower = model.toLowerCase();
  for (const [key, price] of Object.entries(PRICES)) {
    if (lower.startsWith(key)) return price;
  }
  return null;
}

/** Estimated USD for one usage record. Unmapped model → 0 (never a wrong number). */
export function costUsd(model: string | null | undefined, usage: TokenUsage): number {
  const price = priceForModel(model);
  if (!price) return 0;
  return (
    (usage.inputTokens * price.inputPerMtok +
      usage.outputTokens * price.outputPerMtok +
      usage.cacheReadTokens * price.cacheReadPerMtok +
      usage.cacheCreationTokens * price.cacheWritePerMtok) /
    1_000_000
  );
}
