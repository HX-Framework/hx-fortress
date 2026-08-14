// A3 · the OpenAI embedding client. Fetch-based (no SDK dependency) so it
// compiles cleanly into the `bun build --compile` binary — the only network
// surface is `fetch`, already in the Bun runtime. Calls the embeddings endpoint
// with `text-embedding-3-large` @ `dimensions:1024` (Matryoshka — the native
// width is 3072, so the param is REQUIRED or a 3072-vector would overflow the
// vector(1024) column). Retries 429 / 5xx with capped exponential backoff.
//
// POISON-INPUT ISOLATION (the one-bad-input-stalls-everything hazard): the model
// caps input at ~8191 TOKENS, and a char cap can't bound tokens (dense code/CJK
// is ~1 char/token). A single over-long turn would 400 the whole batch, the pass
// would throw before any INSERT, and the anti-join would re-claim the same set
// forever — permanently halting ALL embedding for the org. So `embed()` NEVER
// throws on an input-level error: it splits a failing batch to isolate the
// offender, shrinks a single over-long input, and finally maps a truly
// unembeddable input to `null` (the worker dead-letters just that one). Only an
// ACCOUNT-level error (quota exhausted / bad key) throws — that SHOULD stop the
// pass, since nothing in it can succeed.

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  /** Embed a batch of texts; returns a vector per input IN INPUT ORDER. An input
   *  that cannot be embedded even after length-shrinking (a "poison" input) maps
   *  to `null` at its index so the caller can dead-letter just that one — the
   *  whole batch never fails for one bad input. Account-level failures
   *  (insufficient_quota / 401 / 403) still THROW (`EmbedAccountError`): the pass
   *  should stop rather than silently drop every turn. */
  embed(texts: string[]): Promise<(number[] | null)[]>;
}

export interface OpenAIEmbedderOptions {
  apiKey: string;
  model?: string;
  dimensions?: number;
  /** Endpoint base (override for a zero-retention / DPA OpenAI endpoint). */
  baseUrl?: string;
  /** Initial per-input char cap — a coarse pre-guard under the model's TOKEN cap.
   *  NOT authoritative: the adaptive split+shrink below is what actually keeps a
   *  pathological (dense/CJK/code) turn from tripping the token limit. */
  maxChars?: number;
  maxRetries?: number;
  /** MC-2517 · per-attempt request timeout (ms). When set, each OpenAI HTTP attempt
   *  is bounded by `AbortSignal.timeout` and a timed-out / transport-faulted attempt
   *  is retried (up to `maxRetries`) before failing — so the QUERY-path embedder
   *  fails fast with a typed error instead of hanging a semantic search on a stalled
   *  socket. Omit (the background worker) to keep the prior unbounded behavior. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_EMBED_MODEL = "text-embedding-3-large";
export const DEFAULT_EMBED_DIMENSIONS = 1024;
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
// ~24k chars sits comfortably under the 8191-token cap for English/code
// (~3 chars/token). Denser inputs (CJK ≈ 1 char/token) are caught by the
// adaptive shrink, not this cap.
const DEFAULT_MAX_CHARS = 24_000;
const DEFAULT_MAX_RETRIES = 4;
// Stop shrinking a single over-long input below this and dead-letter it (null).
const MIN_SHRINK_CHARS = 500;

interface EmbeddingResponse {
  data: Array<{ index: number; embedding: number[] }>;
}

/** Thrown for an error the worker must treat as PASS-FATAL (stop the pass), not
 *  a per-input drop: an unfunded / over-quota account, or a bad/again key. */
export class EmbedAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbedAccountError";
  }
}

interface HttpEmbedError extends Error {
  status?: number;
  detail?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A 400 caused by an input exceeding the model's token limit. Messages vary by
 *  API version, so match the stable phrases rather than an exact string. */
function isLengthError(status: number | undefined, detail: string): boolean {
  return (
    status === 400 &&
    /maximum context length|reduce (?:your |the )?(?:input|message|prompt)|too many (?:input )?tokens|maximum.*tokens|longer than the (?:model'?s )?maximum/i.test(
      detail,
    )
  );
}

/** Build an OpenAI-backed embedder. `embed()` resolves to a vector-or-null per
 *  input; only account-level failures reject. */
export function createOpenAIEmbedder(options: OpenAIEmbedderOptions): Embedder {
  const model = options.model ?? DEFAULT_EMBED_MODEL;
  const dimensions = options.dimensions ?? DEFAULT_EMBED_DIMENSIONS;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs;

  // One raw embed call for `inputs`, retrying 429 / 5xx with backoff. On a
  // non-retryable failure it THROWS — EmbedAccountError for quota/auth (the
  // caller lets it abort the pass), an HttpEmbedError (with status/detail) for
  // everything else (the caller isolates the offending input).
  async function embedOnce(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({ model, input: inputs, dimensions }),
          // MC-2517 · bound each attempt so a stalled/hung connection can't wedge a
          // semantic search forever. Only the query-path embedder sets timeoutMs; the
          // background worker leaves it undefined (unbounded, as before).
          signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
        });
      } catch (netErr) {
        // A timed-out (AbortSignal.timeout ⇒ name "TimeoutError") or otherwise
        // faulted transport. The bounded (query-path) embedder retries it up to
        // maxRetries with the same capped backoff, then throws a clear timeout error;
        // the unbounded worker embedder (no timeoutMs) propagates at once, preserving
        // its prior abort-the-pass-and-retry-next-pass behavior.
        if (timeoutMs && attempt < maxRetries) {
          await sleep(Math.min(1000 * 2 ** attempt, 8000));
          attempt += 1;
          continue;
        }
        const timedOut =
          netErr instanceof Error && (netErr.name === "TimeoutError" || netErr.name === "AbortError");
        if (timedOut) {
          // No `status` ⇒ embedBatch re-throws (it only splits on 400) ⇒ the
          // hxSemanticSearch catch maps it to unavailable("openai_temporarily_unavailable").
          throw new Error(`openai embeddings request timed out after ${timeoutMs}ms`, { cause: netErr });
        }
        throw netErr;
      }

      if (res.ok) {
        const json = (await res.json()) as EmbeddingResponse;
        // The API may not preserve order under retries — sort by `index`.
        const ordered = [...json.data].sort((a, b) => a.index - b.index);
        return ordered.map((d) => d.embedding);
      }

      const detail = await res.text().catch(() => "");
      // insufficient_quota (unfunded account) and 401/403 (bad key) are NOT
      // transient and NOT per-input — every call in the pass will fail the same
      // way, so abort the whole pass fast rather than retry or drop silently.
      const quotaExhausted = res.status === 429 && /insufficient_quota/.test(detail);
      const authError = res.status === 401 || res.status === 403;
      if (quotaExhausted || authError) {
        // The error body is OpenAI's own JSON (never the key); truncate anyway.
        throw new EmbedAccountError(`openai embeddings ${res.status}: ${detail.slice(0, 200)}`);
      }

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= maxRetries) {
        const err: HttpEmbedError = new Error(`openai embeddings ${res.status}: ${detail.slice(0, 200)}`);
        err.status = res.status;
        err.detail = detail;
        throw err;
      }
      const backoff = Math.min(1000 * 2 ** attempt, 8000);
      await sleep(backoff);
      attempt += 1;
    }
  }

  // Embed a batch, isolating any input-level failure. Returns a vector per input
  // in order; an input that can't be embedded even after shrinking maps to null.
  // Account errors propagate (pass-fatal).
  async function embedBatch(inputs: string[]): Promise<(number[] | null)[]> {
    if (inputs.length === 0) return [];
    try {
      return await embedOnce(inputs);
    } catch (err) {
      if (err instanceof EmbedAccountError) throw err; // pass-fatal — let it abort

      // Only an HTTP 400 is INPUT-specific (over-long / malformed for this input).
      // A 5xx, a non-quota 429 rate-limit, a 404 (bad base url / model), or a raw
      // network throw (no status) is TRANSIENT or GLOBAL — re-throw so the pass
      // aborts and retries next pass, instead of splitting and dead-lettering good
      // turns for an infra blip (which would silently drop the whole in-flight
      // backlog after deadLetterThreshold passes, mislabeled "unembeddable input").
      const httpErr = err as HttpEmbedError;
      if (httpErr.status !== 400) throw err;

      if (inputs.length > 1) {
        // A 400 on a multi-input batch: split to isolate the offending input(s)
        // without dropping the good ones alongside it.
        const mid = Math.floor(inputs.length / 2);
        const [left, right] = await Promise.all([
          embedBatch(inputs.slice(0, mid)),
          embedBatch(inputs.slice(mid)),
        ]);
        return [...left, ...right];
      }

      // Single 400. If it's an over-length error, shrink and retry down to a floor
      // before giving up; a non-length 400 (genuinely malformed for this one input)
      // is dead-lettered (null). The worker counts consecutive nulls and stops
      // re-claiming a turn after a threshold, so a poison input can't stall forever.
      if (isLengthError(httpErr.status, String(httpErr.detail ?? httpErr.message ?? ""))) {
        let text = inputs[0];
        while (text.length > MIN_SHRINK_CHARS) {
          text = text.slice(0, Math.floor(text.length / 2));
          try {
            const [vec] = await embedOnce([text]);
            return [vec ?? null];
          } catch (retryErr) {
            if (retryErr instanceof EmbedAccountError) throw retryErr;
            // A transient/global error mid-shrink → abort the pass (retry next pass)
            // rather than dead-letter; only a persistent 400 keeps shrinking.
            if ((retryErr as HttpEmbedError).status !== 400) throw retryErr;
          }
        }
      }
      return [null];
    }
  }

  async function embed(texts: string[]): Promise<(number[] | null)[]> {
    if (texts.length === 0) return [];
    const input = texts.map((t) => (t.length > maxChars ? t.slice(0, maxChars) : t));
    return embedBatch(input);
  }

  return { model, dimensions, embed };
}
