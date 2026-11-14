// The daemon gives its connection what the connection needs to refuse, to
// count and to record.
//
// The connection has its own tests, and so has each part it is given. This
// one composes the daemon, as it composes itself at a start, and looks at what
// it handed to the connection: a mode read from the daemon's own settings, the
// counts, the recorder of a refusal, and a tool handler that goes by the same
// mode. A part that is left out here is left out of every fortress.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { WsCloudConnectionDeps } from "../src/cloud";
import { fortressPaths } from "../src/host/paths";
import { runFortressHost } from "../src/host/main";
import type { CloudConnection } from "../src/host/types";

const VARIABLES = ["FORTRESS_OPENAI_API_KEY", "FORTRESS_CONNECTION_SESSION_CONTENT", "FORTRESS_SESSIONS"] as const;

describe("what the daemon hands its connection", () => {
  let root = "";
  const before: Record<string, string | undefined> = {};

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "hx-host-main-connection-"));
    for (const name of VARIABLES) before[name] = process.env[name];
    // The daemon refuses to start with Sessions on and no embedding key.
    process.env.FORTRESS_OPENAI_API_KEY = "sk-test-fortress-openai-key";
    delete process.env.FORTRESS_CONNECTION_SESSION_CONTENT;
    delete process.env.FORTRESS_SESSIONS;
  });

  afterEach(async () => {
    for (const name of VARIABLES) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
    await rm(root, { recursive: true, force: true });
  });

  /** Compose the daemon, and run `during` while it is composed. */
  async function composed<T>(during: (deps: WsCloudConnectionDeps) => Promise<T>): Promise<T> {
    let captured: WsCloudConnectionDeps | null = null;
    let result: T | undefined;
    await runFortressHost({
      root,
      version: "0.0.0-test",
      createConnection(dependencies) {
        captured = dependencies;
        const connection: CloudConnection = {
          state: () => "offline",
          status: () => ({ state: "offline", reason: null, message: null }),
          open: async () => {},
          close: async () => {},
          notifyIngest: () => {},
        };
        return connection;
      },
      run: async () => {
        if (!captured) throw new Error("the daemon made no connection");
        result = await during(captured);
      },
    });
    return result as T;
  }

  const toolCall = {
    method: "callTool",
    name: "hx_sessions_list",
    arguments: { scope: { kind: "self" } },
    userId: "u1",
  } as never;

  test("where nobody chose: a mode that carries everything, as before the setting", async () => {
    await composed(async (deps) => {
      expect(deps.mode?.()).toEqual({ sessions: true, sessionContent: null });
      expect(deps.counts).toBeDefined();
      expect(deps.onRefusedCall).toBeDefined();
      // A tool call with no grant reaches the tool, as it did.
      const answer = await deps.mcp?.handle(toolCall);
      expect(JSON.stringify(answer)).not.toContain("grant_required");
    });
  });

  test("the variable set to off: the mode says off", async () => {
    process.env.FORTRESS_CONNECTION_SESSION_CONTENT = "off";
    await composed(async (deps) => {
      expect(deps.mode?.()).toEqual({ sessions: true, sessionContent: "off" });
    });
  });

  test("config.json set to off, and Sessions off: the mode says both", async () => {
    const paths = fortressPaths(root);
    await mkdir(path.dirname(paths.config), { recursive: true });
    await writeFile(
      paths.config,
      JSON.stringify({
        schemaVersion: 1,
        cloud: { url: "wss://control.example/v1/connection" },
        gateway: { publicUrl: "http://localhost:8787" },
        modules: { enabled: [] },
        moduleDefaultsApplied: 1,
        connection: { sessionContent: "off" },
      }),
    );
    await composed(async (deps) => {
      expect(deps.mode?.()).toEqual({ sessions: false, sessionContent: "off" });
    });
  });

  test("the variable set to on: the tool handler refuses a call with no grant, by the same mode", async () => {
    process.env.FORTRESS_CONNECTION_SESSION_CONTENT = "on";
    await composed(async (deps) => {
      expect(deps.mode?.()).toEqual({ sessions: true, sessionContent: "on" });
      const answer = await deps.mcp?.handle(toolCall);
      expect(answer).toMatchObject({ method: "callTool", isError: true });
      expect(JSON.stringify(answer)).toContain("grant_required");
    });
  });

  test("a refused call that is handed on is written to the audit trail, by its method and its rule", async () => {
    process.env.FORTRESS_CONNECTION_SESSION_CONTENT = "off";
    await composed(async (deps) => {
      await deps.onRefusedCall?.("rpc", "readChunkText");
      await deps.onRefusedCall?.("mcpRpc", "");
    });
    // The spool is closed by now: the daemon stopped.
    const spool = fortressPaths(root).auditSpool;
    const lines: { action: string; outcome: string; params: unknown }[] = [];
    for (const name of (await readdir(spool)).sort()) {
      for (const line of (await readFile(path.join(spool, name), "utf8")).split("\n")) {
        if (line.trim()) lines.push(JSON.parse(line));
      }
    }
    const refused = lines.filter((line) => line.action.startsWith("control_plane."));
    expect(refused.map((line) => [line.action, line.outcome, line.params])).toEqual([
      ["control_plane.session_call", "refused", { method: "readChunkText", rule: "session_content_off" }],
      ["control_plane.tool_call", "refused", { rule: "session_content_off" }],
    ]);
  });

  test("the runtime is refused a config that says off when the start decided nobody chose", async () => {
    // The start reads config.json, decides, and the runtime loads the file
    // again before it connects. Here the file gains the choice in between.
    const paths = fortressPaths(root);
    await mkdir(path.dirname(paths.config), { recursive: true });
    const config = {
      schemaVersion: 1,
      cloud: { url: "wss://control.example/v1/connection" },
      gateway: { publicUrl: "http://localhost:8787" },
      modules: { enabled: [] },
      moduleDefaultsApplied: 1,
    };
    await writeFile(paths.config, JSON.stringify(config));
    let failure: unknown = null;
    await runFortressHost({
      root,
      version: "0.0.0-test",
      createConnection: () => ({
        state: () => "offline",
        status: () => ({ state: "offline", reason: null, message: null }),
        open: async () => {},
        close: async () => {},
        notifyIngest: () => {},
      }),
      run: async (runtime) => {
        await writeFile(paths.config, JSON.stringify({ ...config, connection: { sessionContent: "off" } }));
        failure = await runtime.start().then(
          () => null,
          (error: unknown) => error,
        );
        await runtime.stop().catch(() => {});
      },
    });
    expect(String(failure)).toContain("what config.json says about session content changed while this fortress was starting");
  });
});
