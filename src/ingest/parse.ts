// Pure NDJSON chunk parser — one pass over the staged session chunk that
// produces everything the ingestion path writes to Postgres:
//   • session rollups (counts, tokens, cost, last texts/activity/model)
//   • turns[]      — one row per classified content block/item (incl.
//                    tool_use/tool_result/thinking/image), with the 10-value
//                    `kind` and projected, capped, searchable `text`
//   • toolCalls[]  — tool_use / tool_result projected for hx.tool_calls
//
// Counts and turns intentionally use different granularity, matching the cloud:
//   counts  — per text-bearing EVENT  (a multi-block reply is one reply)
//   turns   — per classified BLOCK    (each block is its own searchable row)
//
// Classification + turn projection is delegated to the shared `classifyChunk`
// (src/ingest/classify.ts — the parseTranscript port, also used by the read
// path); parseChunk keeps the rollup/token/cost math + the structured
// hx.tool_calls extraction (tool events → hx.tool_calls, keyed by tool_use_id).

import type { HxTurnKind, HxTurnRole } from "../host/postgres/schema/transcript";
import { classifyChunk } from "./classify";
import { costUsd } from "./pricing";

const MAX_BODY = 4000; // session last-text preview cap
const MAX_TEXT = 40_000; // per-turn text cap

export type ParsedTurnRole = HxTurnRole;

export interface ParsedTurn {
  role: ParsedTurnRole;
  kind: HxTurnKind;
  eventTs: string | null;
  // Null for text-less kinds (e.g. image); otherwise the capped searchable text.
  text: string | null;
  rawEvent: Record<string, unknown>;
}

export interface ParsedToolCall {
  toolUseId: string;
  toolName: string | null;
  input: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  isError: boolean;
  eventTs: string | null;
}

export interface ParsedChunk {
  eventCount: number;
  userTextCount: number;
  assistantCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  lastUserText: string | null;
  lastAssistantText: string | null;
  firstActivityAt: string | null;
  lastActivityAt: string | null;
  lastModel: string | null;
  turns: ParsedTurn[];
  toolCalls: ParsedToolCall[];
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function bodyText(text: string): string {
  const t = text.trim();
  return t.length > MAX_BODY ? `${t.slice(0, MAX_BODY)}\n\n…` : t;
}

function clip(text: string): string {
  const t = text.trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n\n[truncated ${t.length - MAX_TEXT} chars]` : t;
}

/** Join the text of blocks whose type is in `types` (or a bare string). */
function blocksText(content: unknown, types: string[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (b && typeof b === "object" && types.includes(String(b.type ?? "")) && typeof b.text === "string") {
      out.push(b.text);
    }
  }
  return out.join("\n\n");
}

function eventTimestamp(d: Record<string, unknown>): string | null {
  if (typeof d.timestamp === "string") return d.timestamp;
  const msg = d.message as { timestamp?: unknown } | undefined;
  return msg && typeof msg.timestamp === "string" ? msg.timestamp : null;
}

export function parseChunk(jsonl: string): ParsedChunk {
  const out: ParsedChunk = {
    eventCount: 0,
    userTextCount: 0,
    assistantCount: 0,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    lastUserText: null,
    lastAssistantText: null,
    firstActivityAt: null,
    lastActivityAt: null,
    lastModel: null,
    turns: [],
    toolCalls: [],
  };

  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    out.eventCount += 1;

    const ts = eventTimestamp(d);
    if (ts) {
      if (!out.firstActivityAt) out.firstActivityAt = ts;
      out.lastActivityAt = ts;
    }

    // Token usage + cost — Claude Code carries `usage`/`model` on d.message for
    // assistant events; sum every event that has it.
    const msgForUsage = (d.message ?? {}) as { model?: unknown; usage?: unknown };
    const usageRaw = msgForUsage.usage;
    if (usageRaw && typeof usageRaw === "object") {
      const u = usageRaw as Record<string, unknown>;
      const usage = {
        inputTokens: num(u.input_tokens),
        outputTokens: num(u.output_tokens),
        cacheReadTokens: num(u.cache_read_input_tokens),
        cacheCreationTokens: num(u.cache_creation_input_tokens),
      };
      out.inputTokens += usage.inputTokens;
      out.outputTokens += usage.outputTokens;
      out.cacheReadTokens += usage.cacheReadTokens;
      out.cacheCreationTokens += usage.cacheCreationTokens;
      const model = typeof msgForUsage.model === "string" ? msgForUsage.model : null;
      if (model) out.lastModel = model;
      out.costUsd += costUsd(model, usage);
    }

    const type = String(d.type ?? "");
    if (type === "user") {
      const msg = (d.message ?? {}) as { content?: unknown };
      handleUser(out, msg.content, ts);
    } else if (type === "assistant") {
      const msg = (d.message ?? {}) as { content?: unknown };
      handleAssistant(out, msg.content, ts);
    } else if (type === "event_msg" && d.payload) {
      const p = d.payload as { type?: string; message?: unknown };
      if (p.type === "user_message" && typeof p.message === "string") {
        out.userTextCount += 1;
        out.lastUserText = bodyText(p.message);
      } else if (p.type === "agent_message" && typeof p.message === "string") {
        out.assistantCount += 1;
        out.lastAssistantText = bodyText(p.message);
      }
    } else if (type === "response_item" && d.payload) {
      const p = d.payload as { type?: string; role?: string; content?: unknown };
      if (p.type === "message" && p.role === "user") {
        handleUser(out, p.content, ts, ["input_text", "text"]);
      } else if (p.type === "message" && p.role === "assistant") {
        handleAssistant(out, p.content, ts, ["output_text", "text"]);
      }
    }
  }

  // Turns: one row per classified content block/item, in dense emission order
  // (the shared classifier — the same the read path re-parses with). Tool/thinking/
  // image rows carry role='system'; their text is projected + capped here so the
  // broad text_tsv covers tool output. Text-less kinds (image) store null text.
  out.turns = classifyChunk(jsonl).map((ev) => {
    const text = clip(ev.text);
    return {
      role: ev.role,
      kind: ev.kind,
      eventTs: ev.ts,
      text: text.length > 0 ? text : null,
      rawEvent: ev.raw,
    };
  });

  return out;
}

// User event: count the per-event text (a multi-block message counts once) and
// project tool_result blocks into hx.tool_calls. Turn rows are emitted by the
// shared classifier, not here. `textTypes` lets Codex response_items reuse this
// with input_text.
function handleUser(
  out: ParsedChunk,
  content: unknown,
  ts: string | null,
  textTypes: string[] = ["text"],
): void {
  const joined = blocksText(content, textTypes).trim();
  if (joined) {
    out.userTextCount += 1;
    out.lastUserText = bodyText(joined);
  }
  if (!Array.isArray(content)) return;
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== "object") continue;
    if (String(block.type ?? "") === "tool_result") {
      out.toolCalls.push({
        toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
        toolName: null,
        input: null,
        result: { content: block.content ?? null },
        isError: block.is_error === true,
        eventTs: ts,
      });
    }
  }
}

// Assistant event: count the per-event text and project tool_use blocks into
// hx.tool_calls (with toolCallCount). Turn rows are emitted by the classifier.
function handleAssistant(
  out: ParsedChunk,
  content: unknown,
  ts: string | null,
  textTypes: string[] = ["text"],
): void {
  const joined = blocksText(content, textTypes).trim();
  if (joined) {
    out.assistantCount += 1;
    out.lastAssistantText = bodyText(joined);
  }
  if (!Array.isArray(content)) return;
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== "object") continue;
    if (String(block.type ?? "") === "tool_use") {
      out.toolCallCount += 1;
      out.toolCalls.push({
        toolUseId: typeof block.id === "string" ? block.id : "",
        toolName: typeof block.name === "string" ? block.name : null,
        input:
          block.input && typeof block.input === "object" && !Array.isArray(block.input)
            ? (block.input as Record<string, unknown>)
            : null,
        result: null,
        isError: false,
        eventTs: ts,
      });
    }
  }
}
