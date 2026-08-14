// Shared transcript classifier — the fortress's single source of truth for the
// 10-value `kind` taxonomy. A faithful port of workbench's
// apps/workbench/api/src/agent/tools/hx-vision/parse-transcript.ts (`parseTranscript`),
// adapted to emit one classified item per content block/item in dense emission
// order. Used by BOTH the write path (`parseChunk` persists `kind` + projected
// text) and, later, `hx_session_read_events`'s whole-object re-parse — so
// get-by-type (sourced from the persisted `kind`) and the re-parsed full text
// stay aligned across the same family shapes (claude-cli/desktop, codex-cli/desktop).
//
// It classifies + projects searchable text; it does NOT cap (the write path caps
// to hx.turns.text's MAX_TEXT; the read path serves windows past the cap), and it
// does NOT count/sum tokens (parseChunk keeps that math).

import type { HxTurnKind, HxTurnRole } from "../host/postgres/schema/transcript";

/** One classified content block/item, in emission order (= the turn `seq`). */
export interface ClassifiedEvent {
  kind: HxTurnKind;
  /** Derived from kind: user_text→user, assistant_text→assistant, else system. */
  role: HxTurnRole;
  ts: string | null;
  /** Full (uncapped) projected searchable text; "" for text-less kinds (image). */
  text: string;
  /** Tool linkage for tool_use/tool_result (null otherwise). */
  toolUseId: string | null;
  toolName: string | null;
  isError: boolean;
  /** The source event line this item was derived from (for hx.turns.raw_event). */
  raw: Record<string, unknown>;
}

interface TodoEntry {
  content: string;
  status: string;
  activeForm: string | null;
}

// Intermediate, pre-projection shape — mirrors parseTranscript's emitted events
// plus the suppression flags it filters on and the raw source line.
interface Pending {
  kind: HxTurnKind;
  ts: string | null;
  text?: string;
  name?: string;
  input?: string;
  content?: string;
  isError?: boolean;
  toolUseId?: string | null;
  attachmentKind?: string;
  items?: TodoEntry[];
  raw: Record<string, unknown>;
  codexFallback?: boolean;
  codexCompletionFallback?: boolean;
  consumed?: boolean;
}

function compactInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function flattenToolResultContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);
  const parts: string[] = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (!b) continue;
    if (typeof b === "string") parts.push(b);
    else if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "image") parts.push("[image]");
    else if (typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

function flattenCodexTextBlocks(content: unknown, role: "user" | "assistant"): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const types =
    role === "assistant" ? new Set(["output_text", "text"]) : new Set(["input_text", "text"]);
  return (content as Array<Record<string, unknown>>)
    .filter((b) => b && types.has(String(b.type ?? "")) && typeof b.text === "string")
    .map((b) => String(b.text))
    .join("\n\n");
}

function compactCodexToolOutput(payload: Record<string, unknown>): string {
  const raw = payload?.output ?? payload?.result ?? payload?.tools ?? "";
  if (typeof raw !== "string") return compactInput(raw);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof (parsed as { output?: string }).output === "string") {
      return (parsed as { output: string }).output;
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

function codexToolErrored(payload: Record<string, unknown>, outputText: string): boolean {
  if (payload?.status === "failed" || payload?.status === "error") return true;
  if (typeof payload?.output === "string") {
    try {
      const parsed = JSON.parse(payload.output);
      const exit = Number((parsed?.metadata as Record<string, unknown>)?.exit_code ?? 0);
      if (exit > 0) return true;
    } catch {
      /* ignore */
    }
  }
  return /Process exited with code [1-9]\d*/.test(outputText || "");
}

function isInjectedCodexUserMessage(text: string): boolean {
  return text.trimStart().startsWith("# AGENTS.md instructions for ");
}

/** kind → 3-value role (role is vestigial; kind is the discriminator). */
export function roleForKind(kind: HxTurnKind): HxTurnRole {
  if (kind === "user_text") return "user";
  if (kind === "assistant_text") return "assistant";
  return "system";
}

/** Project a classified item to its searchable text (full, uncapped). Tool rows
 *  flatten to text so the broad `text_tsv` covers tool output/logs/code. */
function projectText(p: Pending): string {
  switch (p.kind) {
    case "user_text":
    case "assistant_text":
    case "thinking":
    case "system_notice":
    case "queue_enqueue":
      return p.text ?? "";
    case "tool_use": {
      const head = `tool_use ${p.name ?? ""}`.trimEnd();
      return p.input ? `${head}\n${p.input}` : head;
    }
    case "tool_result": {
      const head = `tool_result${p.isError ? " (error)" : ""}`;
      return p.content ? `${head}\n${p.content}` : head;
    }
    case "attachment_notice":
      return p.attachmentKind ? `attachment ${p.attachmentKind}` : "attachment";
    case "todo_reminder":
      return (p.items ?? [])
        .map((i) => i.content)
        .filter((c) => c.trim())
        .join("\n");
    case "image":
      return "";
  }
}

/** Classify a raw NDJSON chunk into ordered content-block items (the 10-value
 *  taxonomy). Order is the dense emission ordinal the turn `seq` follows. */
export function classifyChunk(jsonl: string): ClassifiedEvent[] {
  const pending: Pending[] = [];
  const seenTextEvents = new Set<string>();
  const seenAssistantTexts = new Set<string>();
  let hasCodexVisibleMessages = false;
  const pendingEnqueues: Pending[] = [];

  // Dedup the conversational text kinds exactly as parseTranscript does (Codex
  // fallback + repeated completion suppression); other kinds push directly.
  const pushText = (event: Pending): void => {
    const text = event.text || "";
    if (!text.trim()) return;
    const source = event.codexFallback ? "fallback" : "visible";
    const key = `${source}:${event.kind}:${event.ts || ""}:${text.trim()}`;
    if (seenTextEvents.has(key)) return;
    if (event.kind === "assistant_text") {
      const textKey = text.trim();
      if (event.codexCompletionFallback && seenAssistantTexts.has(textKey)) return;
      if (!event.codexCompletionFallback) seenAssistantTexts.add(textKey);
    }
    seenTextEvents.add(key);
    pending.push(event);
  };

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const ts = (d.timestamp as string | null | undefined) ?? null;

    switch (d.type) {
      case "event_msg": {
        const p = (d.payload ?? {}) as Record<string, unknown>;
        if (p.type === "user_message") {
          hasCodexVisibleMessages = true;
          pushText({ kind: "user_text", ts, text: String(p.message ?? ""), raw: d });
        } else if (p.type === "agent_message") {
          hasCodexVisibleMessages = true;
          pushText({ kind: "assistant_text", ts, text: String(p.message ?? ""), raw: d });
        } else if (p.type === "task_complete" && typeof p.last_agent_message === "string") {
          pushText({
            kind: "assistant_text",
            ts,
            text: p.last_agent_message,
            codexCompletionFallback: true,
            raw: d,
          });
        }
        break;
      }
      case "response_item": {
        const p = (d.payload ?? {}) as Record<string, unknown>;
        if (p.type === "message") {
          if (p.role === "user") {
            const text = flattenCodexTextBlocks(p.content, "user");
            if (!isInjectedCodexUserMessage(text)) {
              pushText({ kind: "user_text", ts, text, codexFallback: true, raw: d });
            }
          } else if (p.role === "assistant") {
            pushText({
              kind: "assistant_text",
              ts,
              text: flattenCodexTextBlocks(p.content, "assistant"),
              codexFallback: true,
              raw: d,
            });
          }
        } else if (
          p.type === "function_call" ||
          p.type === "custom_tool_call" ||
          p.type === "tool_search_call"
        ) {
          const callId = (p.call_id as string | undefined) ?? (p.id as string | undefined) ?? null;
          pending.push({
            kind: "tool_use",
            ts,
            toolUseId: callId,
            name:
              (p.name as string | undefined) ??
              (p.type === "tool_search_call" ? "tool_search" : "(tool)"),
            input: compactInput(p.arguments ?? p.input ?? {}),
            raw: d,
          });
        } else if (
          p.type === "function_call_output" ||
          p.type === "custom_tool_call_output" ||
          p.type === "tool_search_output"
        ) {
          const callId = (p.call_id as string | undefined) ?? (p.id as string | undefined) ?? null;
          const output = compactCodexToolOutput(p);
          pending.push({
            kind: "tool_result",
            ts,
            toolUseId: callId,
            isError: codexToolErrored(p, output),
            content: output,
            raw: d,
          });
        } else if (p.type === "reasoning") {
          const summary = Array.isArray(p.summary)
            ? (p.summary as Array<Record<string, unknown>>)
                .map((x) => (typeof x?.text === "string" ? x.text : x))
                .filter(Boolean)
                .join("\n")
            : "";
          if (typeof summary === "string" && summary.trim()) {
            pending.push({ kind: "thinking", ts, text: summary, raw: d });
          }
        }
        break;
      }
      case "user": {
        const msg = (d.message ?? {}) as Record<string, unknown>;
        const c = msg.content;
        if (typeof c === "string") {
          if (c.trim()) pending.push({ kind: "user_text", ts, text: c, raw: d });
        } else if (Array.isArray(c)) {
          for (const b of c as Array<Record<string, unknown>>) {
            if (!b) continue;
            if (b.type === "tool_result") {
              pending.push({
                kind: "tool_result",
                ts,
                toolUseId: (b.tool_use_id as string | undefined) ?? null,
                isError: !!b.is_error,
                content: flattenToolResultContent(b.content),
                raw: d,
              });
            } else if (b.type === "text" && typeof b.text === "string") {
              pending.push({ kind: "user_text", ts, text: b.text, raw: d });
            } else if (b.type === "image") {
              pending.push({ kind: "image", ts, raw: d });
            }
          }
        }
        break;
      }
      case "assistant": {
        const msg = (d.message ?? {}) as Record<string, unknown>;
        const c = msg.content;
        if (Array.isArray(c)) {
          for (const b of c as Array<Record<string, unknown>>) {
            if (!b) continue;
            if (b.type === "text" && typeof b.text === "string") {
              pending.push({ kind: "assistant_text", ts, text: b.text, raw: d });
            } else if (b.type === "thinking" || b.type === "redacted_thinking") {
              const txt = typeof b.thinking === "string" ? b.thinking : "";
              if (txt.trim()) pending.push({ kind: "thinking", ts, text: txt, raw: d });
            } else if (b.type === "tool_use") {
              pending.push({
                kind: "tool_use",
                ts,
                toolUseId: (b.id as string | undefined) ?? null,
                name: (b.name as string | undefined) ?? "(tool)",
                input: compactInput(b.input),
                raw: d,
              });
            }
          }
        } else if (typeof c === "string" && c.trim()) {
          pending.push({ kind: "assistant_text", ts, text: c, raw: d });
        }
        break;
      }
      case "system": {
        const msg = (d.message ?? d) as Record<string, unknown>;
        const text =
          typeof msg.content === "string"
            ? msg.content
            : typeof msg.subtype === "string"
              ? `system: ${msg.subtype}`
              : typeof d.subtype === "string"
                ? `system: ${d.subtype}`
                : "system event";
        pending.push({ kind: "system_notice", ts, text, raw: d });
        break;
      }
      case "attachment": {
        const a = (d.attachment ?? {}) as Record<string, unknown>;
        const kind = (a.type as string | undefined) ?? "attachment";
        if (kind === "deferred_tools_delta" || kind === "mcp_instructions_delta") break;
        if (kind === "todo_reminder") {
          const items: TodoEntry[] = Array.isArray(a.content)
            ? (a.content as Array<Record<string, unknown>>).map((it) => ({
                content: typeof it?.content === "string" ? it.content : "",
                status: typeof it?.status === "string" ? it.status : "pending",
                activeForm: typeof it?.activeForm === "string" ? it.activeForm : null,
              }))
            : [];
          if (items.length === 0) break;
          pending.push({ kind: "todo_reminder", ts, items, raw: d });
        } else {
          pending.push({ kind: "attachment_notice", ts, attachmentKind: kind, raw: d });
        }
        break;
      }
      case "summary": {
        pending.push({
          kind: "system_notice",
          ts,
          text: `Compacted: ${String(d.summary ?? "(no summary)")}`,
          raw: d,
        });
        break;
      }
      case "queue-operation": {
        if (d.operation === "enqueue" && typeof d.content === "string") {
          const ev: Pending = { kind: "queue_enqueue", ts, text: d.content, raw: d };
          pending.push(ev);
          pendingEnqueues.push(ev);
        } else if (d.operation === "dequeue" || d.operation === "remove") {
          const consumed = pendingEnqueues.shift();
          if (consumed) consumed.consumed = true;
        }
        break;
      }
      default:
        break;
    }
  }

  return pending
    .filter((e) => !(e.kind === "queue_enqueue" && e.consumed))
    .filter((e) => !(hasCodexVisibleMessages && e.codexFallback))
    .map<ClassifiedEvent>((p) => ({
      kind: p.kind,
      role: roleForKind(p.kind),
      ts: p.ts,
      text: projectText(p),
      toolUseId: p.toolUseId ?? null,
      toolName: p.name ?? null,
      isError: p.isError ?? false,
      raw: p.raw,
    }));
}
