import { describe, expect, test } from "bun:test";

import { parseChunk } from "../../src/ingest/parse";

const CLAUDE_CHUNK = [
  JSON.stringify({
    type: "user",
    timestamp: "2026-06-29T10:00:00Z",
    message: { content: [{ type: "text", text: "hello world" }] },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-29T10:00:01Z",
    message: {
      model: "claude-opus-4-8",
      content: [
        { type: "text", text: "hi there" },
        { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 20,
      },
    },
  }),
  JSON.stringify({
    type: "user",
    timestamp: "2026-06-29T10:00:02Z",
    message: {
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file1\nfile2", is_error: false }],
    },
  }),
  JSON.stringify({ type: "summary", summary: "did stuff", timestamp: "2026-06-29T10:00:03Z" }),
  "not json at all",
  "",
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-06-29T10:00:04Z",
    payload: { type: "user_message", message: "codex hi" },
  }),
].join("\n");

describe("parseChunk — rollup counts", () => {
  const p = parseChunk(CLAUDE_CHUNK);

  test("eventCount counts every parseable line (malformed/empty skipped)", () => {
    expect(p.eventCount).toBe(5);
  });

  test("userTextCount / assistantCount are per text-bearing event", () => {
    // user("hello world") + event_msg user_message; the tool_result-only line is not a prompt.
    expect(p.userTextCount).toBe(2);
    expect(p.assistantCount).toBe(1);
  });

  test("toolCallCount counts tool_use blocks", () => {
    expect(p.toolCallCount).toBe(1);
  });

  test("sums token usage from message.usage", () => {
    expect(p.inputTokens).toBe(100);
    expect(p.outputTokens).toBe(50);
    expect(p.cacheReadTokens).toBe(10);
    expect(p.cacheCreationTokens).toBe(20);
  });

  test("accumulates est cost from the per-event model", () => {
    // (100*5 + 50*25 + 10*0.5 + 20*6.25) / 1e6
    expect(p.costUsd).toBeCloseTo(0.00188, 8);
  });

  test("tracks first/last activity, last texts, and model", () => {
    expect(p.firstActivityAt).toBe("2026-06-29T10:00:00Z");
    expect(p.lastUserText).toBe("codex hi");
    expect(p.lastAssistantText).toBe("hi there");
    expect(p.lastActivityAt).toBe("2026-06-29T10:00:04Z");
    expect(p.lastModel).toBe("claude-opus-4-8");
  });
});

describe("parseChunk — turns (one row per classified block)", () => {
  const p = parseChunk(CLAUDE_CHUNK);

  test("emits a turn per content block incl. tool_use/tool_result, with the 10-value kind", () => {
    expect(p.turns.map((t) => t.kind)).toEqual([
      "user_text",
      "assistant_text",
      "tool_use",
      "tool_result",
      "system_notice",
      "user_text",
    ]);
    // role is vestigial: conversational rows keep user/assistant, the rest system.
    expect(p.turns.map((t) => t.role)).toEqual([
      "user",
      "assistant",
      "system",
      "system",
      "system",
      "user",
    ]);
  });

  test("projects tool text into the searchable turn text (broad tsv coverage)", () => {
    const firstOf = (k: string) => p.turns.find((t) => t.kind === k)?.text ?? "";
    expect(firstOf("user_text")).toBe("hello world");
    expect(firstOf("assistant_text")).toBe("hi there");
    expect(firstOf("tool_use")).toContain("Bash");
    expect(firstOf("tool_result")).toContain("file1");
    expect(firstOf("system_notice")).toBe("Compacted: did stuff");
  });

  test("carries eventTs and the verbatim rawEvent", () => {
    expect(p.turns[0].eventTs).toBe("2026-06-29T10:00:00Z");
    expect(p.turns[0].rawEvent.type).toBe("user");
  });
});

describe("parseChunk — tool calls", () => {
  const p = parseChunk(CLAUDE_CHUNK);

  test("projects tool_use and tool_result as separate entries keyed by tool_use_id", () => {
    expect(p.toolCalls).toHaveLength(2);
    const call = p.toolCalls[0];
    expect(call.toolUseId).toBe("tu_1");
    expect(call.toolName).toBe("Bash");
    expect(call.input).toEqual({ command: "ls" });
    expect(call.result).toBeNull();

    const res = p.toolCalls[1];
    expect(res.toolUseId).toBe("tu_1");
    expect(res.toolName).toBeNull();
    expect(res.isError).toBe(false);
    expect(res.result).not.toBeNull();
  });
});

describe("parseChunk — assistant string content + Codex agent_message", () => {
  test("handles string message.content and Codex agent_message", () => {
    const chunk = [
      JSON.stringify({ type: "assistant", message: { content: "plain reply" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "codex reply" } }),
    ].join("\n");
    const p = parseChunk(chunk);
    expect(p.assistantCount).toBe(2);
    expect(p.turns.map((t) => t.text)).toEqual(["plain reply", "codex reply"]);
    expect(p.turns.map((t) => t.kind)).toEqual(["assistant_text", "assistant_text"]);
    expect(p.lastAssistantText).toBe("codex reply");
  });
});

describe("parseChunk — empty input", () => {
  test("returns zeroed rollups and no rows", () => {
    const p = parseChunk("");
    expect(p.eventCount).toBe(0);
    expect(p.turns).toEqual([]);
    expect(p.toolCalls).toEqual([]);
    expect(p.lastModel).toBeNull();
  });
});
