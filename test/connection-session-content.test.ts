// Session content on the connection, with the whole daemon.
//
// The real daemon in a child process, against a stand-in control plane on
// loopback. These tests say what a fortress does when it is told that session
// content may not travel on its connection: what it answers, what it records,
// what it counts and what it publishes for its console.

import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
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
    // Nothing that only travels while Sessions is on was sent.
    expect(frames("collectionStats")).toEqual([]);
    expect(frames("fortressQuery")).toEqual([]);
    expect(frames("hxInvalidate")).toEqual([]);
    expect(frames("rpcResult")).toEqual([]);
    expect(frames("mcpRpcResult")).toEqual([]);

    // What this run does, for the console to read.
    const status = await boot.status();
    expect(status?.sessions).toBe("off");
    expect(status?.sessionContent).toBe("off");
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
    expect((await boot.status())?.sessionContent).toBe("off");
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
    expect((await boot.status())?.sessionContent).toBe("not_set");
    // No record of the connection's own: nothing was refused by it.
    expect((await spoolRecords()).filter((record) => record.action.startsWith("control_plane.session_call"))).toEqual([]);
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
});
