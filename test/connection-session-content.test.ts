// Session content on the connection, with the whole daemon.
//
// The real daemon in a child process, against a stand-in control plane on
// loopback. These tests say what a fortress does when it is told that session
// content may not travel on its connection: what it answers, what it records,
// what it counts and what it publishes for its console.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseCounts, utcDay } from "../src/cloud/counts";
import type { FortressToHubFrame } from "../src/protocol";
import { bootHost, UNREACHABLE_DATABASE_URL, type HostBoot } from "./rig/host-boot";

let boot: HostBoot | null = null;

afterEach(async () => {
  await boot?.cleanup();
  boot = null;
});

const frames = <T extends FortressToHubFrame["t"]>(kind: T): Extract<FortressToHubFrame, { t: T }>[] =>
  (boot?.report.frames ?? []).filter((f): f is Extract<FortressToHubFrame, { t: T }> => f.t === kind);

/** What the daemon's status file says its connection carries. */
const carries = (status: Record<string, unknown> | null | undefined): unknown =>
  (status?.connection as { sessionContent?: unknown } | undefined)?.sessionContent;

/** Every audit record the daemon left in its spool, oldest file first. */
async function spoolRecords(): Promise<{ action: string; actor: string | null; outcome: string | null; params: unknown }[]> {
  if (!boot) return [];
  const dir = boot.paths.auditSpool;
  const records = [];
  for (const name of (await readdir(dir).catch(() => [])).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    for (const line of (await readFile(path.join(dir, name), "utf8")).split("\n")) {
      if (line.trim()) records.push(JSON.parse(line));
    }
  }
  return records;
}

const SESSION_FRAMES = [
  { t: "rpc", id: "rpc-1", req: { method: "readChunkText", key: { userId: "u1", sessionId: "s1" }, chunkId: "c1" } },
  { t: "mcpRpc", id: "mcp-1", req: { method: "callTool", name: "hx_session_search", arguments: {} } },
  { t: "rosterSync", roster: { asOf: "2027-03-14T09:00:00.000Z", members: [] } },
  { t: "rowsRead", table: "permits" },
] as never[];

describe("a fortress told that session content may not travel on its connection", () => {
  test("refuses a session call and a tool call itself, records both and counts everything", async () => {
    boot = await bootHost({
      env: {
        FORTRESS_SESSIONS: "off",
        FORTRESS_CONNECTION_SESSION_CONTENT: "off",
        FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL,
      },
      scenario: { hubSends: SESSION_FRAMES, waitForFrames: ["rpcError", "mcpRpcError"] },
    });
    expect(boot.report.error).toBeNull();

    // One fixed word, under the id the control plane sent.
    expect(frames("rpcError")).toEqual([{ t: "rpcError", id: "rpc-1", error: "session_content_off" }]);
    expect(frames("mcpRpcError")).toEqual([{ t: "mcpRpcError", id: "mcp-1", error: "session_content_off" }]);
    // Four kinds crossed, and no frame of any other: the greeting, heartbeats,
    // and the two answers that say the call was refused.
    const crossed = new Set((boot.report.frames ?? []).map((frame) => frame.t));
    crossed.delete("heartbeat");
    expect([...crossed].sort()).toEqual(["enroll", "mcpRpcError", "rpcError"]);

    // What this run does, for the console to read.
    const status = await boot.status();
    expect(status?.sessions).toBe("off");
    expect(carries(status)).toBe("off");
    expect(boot.stdout).toContain("Session content is off on the connection");

    // The two refusals are in the audit trail, as the control plane's acts.
    const refused = (await spoolRecords()).filter((record) => record.action.startsWith("control_plane."));
    expect(refused.map((record) => [record.action, record.actor, record.outcome, record.params])).toEqual([
      ["control_plane.session_call", "control plane", "refused", { method: "readChunkText", rule: "session_content_off" }],
      ["control_plane.tool_call", "control plane", "refused", { rule: "session_content_off" }],
    ]);

    // And everything that crossed, or did not, is counted on this host.
    const counts = parseCounts(await readFile(boot.paths.connectionCounts, "utf8"));
    const today = counts?.days[utcDay(new Date())];
    expect(today?.refused).toMatchObject({ rpc: 1, mcpRpc: 1, rosterSync: 1 });
    expect(today?.dropped).toEqual({ too_large: 0, unreadable: 0, unknown: 1 });
    expect(today?.in.enrolled).toBe(1);
    expect(today?.out).toMatchObject({ enroll: 1, rpcError: 1, mcpRpcError: 1 });
    expect(today?.in.rpc).toBeUndefined();
    expect(today?.in.rosterSync).toBeUndefined();
    // The fortress did not try to send anything that is not carried either:
    // what is counted as refused is what the control plane sent, and no more.
    expect(Object.keys(today?.refused ?? {}).sort()).toEqual(["mcpRpc", "rosterSync", "rpc"]);
    // Only names from this build's own list are ever a key.
    expect(JSON.stringify(counts)).not.toContain("rowsRead");
  }, 30_000);

  test("is told by config.json too, and the choice survives the enrollment that rewrites the file", async () => {
    boot = await bootHost({
      env: { FORTRESS_SESSIONS: "off", FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      scenario: { hubSends: SESSION_FRAMES, waitForFrames: ["rpcError", "mcpRpcError"] },
      prepare: async (paths) => {
        await writeFile(
          paths.config,
          JSON.stringify({
            schemaVersion: 1,
            cloud: { url: "ws://127.0.0.1:1" },
            gateway: { publicUrl: "http://localhost:8787" },
            modules: { enabled: [] },
            moduleDefaultsApplied: 1,
            connection: { sessionContent: "off" },
          }),
        );
      },
    });
    expect(boot.report.error).toBeNull();
    expect(frames("rpcError")).toEqual([{ t: "rpcError", id: "rpc-1", error: "session_content_off" }]);
    expect(carries(await boot.status())).toBe("off");
    const config = JSON.parse(await readFile(boot.paths.config, "utf8")) as { connection?: unknown; cloud: { url: string } };
    expect(config.connection).toEqual({ sessionContent: "off" });
    // The enrollment did rewrite the file: the address is the stand-in's now.
    expect(config.cloud.url).toBe(boot.report.hubUrl);
  }, 30_000);

  test("where nobody chose, a fortress with Sessions off answers as it did before the setting", async () => {
    boot = await bootHost({
      env: { FORTRESS_SESSIONS: "off", FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      scenario: {
        hubSends: [{ t: "rpc", id: "rpc-1", req: { method: "selfTest" } } as never],
        waitForFrames: ["rpcError"],
      },
    });
    expect(boot.report.error).toBeNull();
    expect(frames("rpcError")).toEqual([{ t: "rpcError", id: "rpc-1", error: "Module not running: session_vault" }]);
    expect(carries(await boot.status())).toBe("not_set");
    // No record of the connection's own: nothing was refused by it.
    expect((await spoolRecords()).filter((record) => record.action.startsWith("control_plane.session_call"))).toEqual([]);
  }, 30_000);

  test("takes up the counts of the run before it, and adds its own", async () => {
    const today = utcDay(new Date());
    boot = await bootHost({
      env: {
        FORTRESS_SESSIONS: "off",
        FORTRESS_CONNECTION_SESSION_CONTENT: "off",
        FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL,
      },
      scenario: { hubSends: SESSION_FRAMES, waitForFrames: ["rpcError", "mcpRpcError"] },
      prepare: async (paths) => {
        await mkdir(path.dirname(paths.connectionCounts), { recursive: true });
        await writeFile(
          paths.connectionCounts,
          JSON.stringify({
            version: 1,
            days: {
              "2020-01-01": { in: { welcome: 9 }, out: {}, refused: {}, dropped: { too_large: 0, unreadable: 0, unknown: 0 } },
              [today]: {
                in: { moduleMessage: 40 },
                out: { moduleReply: 40 },
                refused: { rpc: 5 },
                dropped: { too_large: 0, unreadable: 0, unknown: 2 },
              },
            },
          }),
        );
      },
    });
    expect(boot.report.error).toBeNull();
    const counts = parseCounts(await readFile(boot.paths.connectionCounts, "utf8"));
    const day = counts?.days[today];
    // What the earlier run counted is still there, and this run's is added to it.
    expect(day?.in.moduleMessage).toBe(40);
    expect(day?.out.moduleReply).toBe(40);
    expect(day?.refused.rpc).toBe(6);
    expect(day?.dropped.unknown).toBe(3);
    expect(day?.in.enrolled).toBe(1);
    // A day older than the ninety that are kept is gone.
    expect(counts?.days["2020-01-01"]).toBeUndefined();
  }, 30_000);
});

describe("a fortress told that session content may travel on its connection", () => {
  test("serves no session call without a grant, and says so in one word", async () => {
    boot = await bootHost({
      env: {
        FORTRESS_SESSIONS: "off",
        FORTRESS_CONNECTION_SESSION_CONTENT: "on",
        FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL,
      },
      scenario: {
        hubSends: [
          { t: "rpc", id: "rpc-1", req: { method: "readChunkText", key: { userId: "u1", sessionId: "s1" }, chunkId: "c1" } },
          // The probe reads no session and needs no grant, so it reaches the
          // module, which is not running on this fortress.
          { t: "rpc", id: "rpc-2", req: { method: "selfTest" } },
        ] as never[],
        waitForFrames: ["rpcError", "rpcError"],
      },
    });
    expect(boot.report.error).toBeNull();
    const errors = frames("rpcError");
    expect(errors).toContainEqual({ t: "rpcError", id: "rpc-1", error: "grant_required" });
    expect(errors).toContainEqual({ t: "rpcError", id: "rpc-2", error: "Module not running: session_vault" });
    expect(carries(await boot.status())).toBe("on");
    // Both calls were carried: the kind is allowed, and nothing was refused by the connection.
    const today = parseCounts(await readFile(boot.paths.connectionCounts, "utf8"))?.days[utcDay(new Date())];
    expect(today?.in.rpc).toBe(2);
    expect(today?.refused).toEqual({});
    expect((await spoolRecords()).filter((record) => record.action === "control_plane.session_call")).toEqual([]);
  }, 30_000);
});

describe("the setting is about the connection, and the daemon says so where it matters", () => {
  const GATEWAY_WARNING = "Session content is off on the connection, and the ingest gateway is on";
  /** A port nothing listens on, for a gateway that these tests never call. */
  const freePort = (): number => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const { port } = server;
    server.stop(true);
    return port;
  };
  // Sessions on, with a gateway. The start itself is not what is looked at:
  // the warning is said while the daemon is put together, before it connects.
  const withGateway = (sessionContent: "off" | "on" | null): Record<string, string> => ({
    FORTRESS_SESSIONS: "on",
    FORTRESS_OPENAI_API_KEY: "sk-test-fortress-openai-key",
    FORTRESS_PUBLIC_URL: "https://fortress.northstar.example",
    FORTRESS_GATEWAY_PORT: String(freePort()),
    FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL,
    ...(sessionContent ? { FORTRESS_CONNECTION_SESSION_CONTENT: sessionContent } : {}),
  });

  test("with session content off and the gateway on, it warns that the gateway still serves session reads", async () => {
    boot = await bootHost({ env: withGateway("off") });
    expect(boot.stdout).toContain(GATEWAY_WARNING);
    expect(boot.stdout).toContain("The gateway still serves session reads to a caller with a token the control plane signed");
  }, 30_000);

  test("it does not warn where session content is on, or where nobody chose", async () => {
    boot = await bootHost({ env: withGateway("on") });
    expect(boot.stdout).not.toContain(GATEWAY_WARNING);
    await boot.cleanup();
    boot = await bootHost({ env: withGateway(null) });
    expect(boot.stdout).not.toContain(GATEWAY_WARNING);
  }, 60_000);

  test("it does not warn with Sessions off, where no gateway is started", async () => {
    boot = await bootHost({
      env: { ...withGateway("off"), FORTRESS_SESSIONS: "off" },
      scenario: { waitForFrames: ["enroll"] },
    });
    expect(boot.report.error).toBeNull();
    expect(boot.stdout).not.toContain(GATEWAY_WARNING);
  }, 30_000);
});

describe("a choice that cannot be read stops the start", () => {
  test("a wrong value of the variable", async () => {
    boot = await bootHost({
      env: {
        FORTRESS_SESSIONS: "off",
        FORTRESS_CONNECTION_SESSION_CONTENT: "of",
        FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL,
      },
    });
    expect(boot.report.error).toBe("FORTRESS_CONNECTION_SESSION_CONTENT must be on or off");
    expect(boot.report.started).toBe(false);
    expect(boot.report.frames).toEqual([]);
    expect(boot.stdout).toContain("FORTRESS_CONNECTION_SESSION_CONTENT is not valid, so this fortress will not start");
  }, 30_000);

  test("a variable that is set and empty", async () => {
    boot = await bootHost({
      env: {
        FORTRESS_SESSIONS: "off",
        FORTRESS_CONNECTION_SESSION_CONTENT: "",
        FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL,
      },
    });
    expect(boot.report.error).toBe("FORTRESS_CONNECTION_SESSION_CONTENT is set and empty: it must be on or off");
    expect(boot.report.started).toBe(false);
    expect(boot.report.frames).toEqual([]);
  }, 30_000);

  test("a wrong value in config.json, which an enrollment must not quietly drop", async () => {
    boot = await bootHost({
      env: { FORTRESS_SESSIONS: "off", FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      prepare: async (paths) => {
        await writeFile(
          paths.config,
          JSON.stringify({
            schemaVersion: 1,
            cloud: { url: "ws://127.0.0.1:1" },
            gateway: { publicUrl: "http://localhost:8787" },
            modules: { enabled: [] },
            moduleDefaultsApplied: 1,
            connection: { sessionContent: "of" },
          }),
        );
      },
    });
    expect(boot.report.error).toContain('connection.sessionContent must be "on" or "off"');
    expect(boot.report.started).toBe(false);
    expect(boot.report.frames).toEqual([]);
    // The file is as the operator left it, for them to fix.
    const config = JSON.parse(await readFile(boot.paths.config, "utf8")) as { connection?: unknown };
    expect(config.connection).toEqual({ sessionContent: "of" });
  }, 30_000);

  test("a mistyped key in config.json", async () => {
    boot = await bootHost({
      env: { FORTRESS_SESSIONS: "off", FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      prepare: async (paths) => {
        await writeFile(
          paths.config,
          JSON.stringify({
            schemaVersion: 1,
            cloud: { url: "ws://127.0.0.1:1" },
            gateway: { publicUrl: "http://localhost:8787" },
            modules: { enabled: [] },
            moduleDefaultsApplied: 1,
            connection: { session_content: "off" },
          }),
        );
      },
    });
    expect(boot.report.error).toContain('connection has a key this build does not know, "session_content"');
    expect(boot.report.started).toBe(false);
    expect(boot.report.frames).toEqual([]);
  }, 30_000);

  test("a config.json that an editor left as no JSON, with the choice in it", async () => {
    // A trailing comma. Before this was refused, the enrollment at start wrote
    // a fresh file over it, and the fortress ran as if nobody had chosen.
    const text = '{\n  "schemaVersion": 1,\n  "connection": { "sessionContent": "off" },\n}\n';
    boot = await bootHost({
      env: { FORTRESS_SESSIONS: "off", FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      prepare: async (paths) => {
        await writeFile(paths.config, text);
      },
    });
    expect(boot.report.error).toContain("config.json is not valid JSON and it mentions session content");
    expect(boot.report.started).toBe(false);
    expect(boot.report.frames).toEqual([]);
    expect(await readFile(boot.paths.config, "utf8")).toBe(text);
  }, 30_000);
});
