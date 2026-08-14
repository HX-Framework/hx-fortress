// A3 · the fortress embed worker — public surface. An OpenAI embedder, the
// incremental content-addressed pass, the booted debounce scheduler, the
// per-turn secret scrub, and the ingest → worker signal hook.
export { createOpenAIEmbedder, EmbedAccountError, DEFAULT_EMBED_MODEL, DEFAULT_EMBED_DIMENSIONS } from "./openai";
export type { Embedder, OpenAIEmbedderOptions } from "./openai";
export { runEmbedPass, createEmbedWorker, estimateEmbedTokens, isEmbedBudgetExceeded } from "./worker";
export type { EmbedPassResult, EmbedWorker, EmbedWorkerOptions } from "./worker";
export { scrubSecrets } from "./scrub";
export { signalEmbedWork, setEmbedSignalHandler } from "./signal";
