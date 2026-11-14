// What the connection carries, refuses, drops and counts.
//
// The real connection against a stand-in control plane on loopback. Each test
// says what the fortress carries (whether Sessions is on, and whether session
// content may travel), sends frames as a control plane would, and looks at
// three things: what was dispatched, what went back, and what was counted.

import { afterEach, describe, expect, test } from "bun:test";

import { SUPPORTED_PROTOCOL_VERSION, WsCloudConnection, type WsCloudConnectionDeps } from "../../src/cloud/connection";
import { FortressQueryUnavailable } from "../../src/cloud/fortress-query";
import type { ConnectionMode, DropReason } from "../../src/cloud/kinds";
import type { FortressConfig } from "../../src/host/types";
import type { FortressToHubFrame, HubToFortressFrame, MsgData, MsgReply } from "../../src/protocol";
import { FakeHub } from "../fake-hub";

const CONFIG: FortressConfig = {
  schemaVersion: 1,
  cloud: { url: "" },
  gateway: { publicUrl: "http://localhost:8787" },
  modules: { enabled: [] },
};
const CREDENTIAL = { orgId: "northstar", fortressId: "fortress-1", credential: "made-up-credential" };

interface Rig {
  hub: FakeHub;
  conn: WsCloudConnection;
  /** Every `rpc` the dispatcher was handed. */
  dispatched: MsgData[];
  /** Every ask the gate was handed. */
  asked: MsgData[];
  rosters: number;
  toolCalls: number;
  refusedCalls: [string, string][];
  logged: string[];
  counts: { in: Record<string, number>; out: Record<string, number>; refused: Record<string, number>; dropped: Record<DropReason, number> };
}

let rigs: Rig[] = [];

afterEach(async () => {
  for (const rig of rigs) {
    await rig.conn.close().catch(() => {});
    await rig.hub.stop();
  }
  rigs = [];
});

async function open(mode: ConnectionMode | null, extra: Partial<WsCloudConnectionDeps> = {}): Promise<Rig> {
  const hub = await FakeHub.create({ orgId: CREDENTIAL.orgId });
  const counted = { in: {}, out: {}, refused: {}, dropped: { too_large: 0, unreadable: 0, unknown: 0 } } as Rig["counts"];
  const bump = (into: Record<string, number>, key: string): void => {
    into[key] = (into[key] ?? 0) + 1;
  };
  const rig: Rig = {
    hub,
    conn: undefined as unknown as WsCloudConnection,
    dispatched: [],
    asked: [],
    rosters: 0,
    toolCalls: 0,
    refusedCalls: [],
    logged: [],
    counts: counted,
  };
  rig.conn = new WsCloudConnection({
    dispatcher: {
      async dispatch(data: MsgData): Promise<MsgReply> {
        rig.dispatched.push(data);
        return { ok: true, payload: { served: true } };
      },
    },
    credentialStore: { load: async () => CREDENTIAL, save: async () => {} },
    logger: { error: (message) => void rig.logged.push(message) },
    identity: { version: "0.0.0-test", protocolVersion: SUPPORTED_PROTOCOL_VERSION },
    asks: {
      async handle(data: MsgData): Promise<MsgReply> {
        rig.asked.push(data);
        return { ok: true, payload: {} };
      },
    },
    mcp: {
      async handle() {
        rig.toolCalls += 1;
        return { method: "callTool", content: "tool answer", isError: false };
      },
    },
    onRoster: async () => {
      rig.rosters += 1;
    },
    collectionStats: async () => ({ sessions: 1, chunks: 2, bytes: 3 }) as never,
    counts: {
      received: (frame) => bump(counted.in, frame),
      sent: (frame) => bump(counted.out, frame),
      refused: (frame) => bump(counted.refused, frame),
      dropped: (reason) => bump(counted.dropped, reason),
    },
    onRefusedCall: (frame, method) => void rig.refusedCalls.push([frame, method]),
    ...(mode ? { mode: () => mode } : {}),
    heartbeatMs: 20,
    reconnectMinMs: 10,
    reconnectMaxMs: 50,
    ...extra,
  });
  rigs.push(rig);
  await rig.conn.open({ ...CONFIG, cloud: { url: hub.url } });
  return rig;
}

async function until<T>(read: () => T | undefined | false, what: string, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

const sent = <T extends FortressToHubFrame["t"]>(rig: Rig, t: T): Extract<FortressToHubFrame, { t: T }>[] =>
  rig.hub.received().filter((frame): frame is Extract<FortressToHubFrame, { t: T }> => frame.t === t);

const OFF: ConnectionMode = { sessions: false, sessionContent: "off" };
const OFF_WITH_SESSIONS: ConnectionMode = { sessions: true, sessionContent: "off" };
const ON: ConnectionMode = { sessions: true, sessionContent: "on" };

const rpc = (id: unknown, method: unknown): HubToFortressFrame =>
  ({ t: "rpc", id, req: { method, key: { userId: "u1", sessionId: "s1" }, chunkId: "c1" } }) as never;
const ROSTER: HubToFortressFrame = { t: "rosterSync", roster: { asOf: "2027-03-14T09:00:00.000Z", members: [] } } as never;

describe("with session content off, the connection refuses a session call itself", () => {
  test("nothing is dispatched, and the control plane is told one fixed word under its id", async () => {
    const rig = await open(OFF);
    rig.hub.send(rpc("rpc-1", "readChunkText"));
    const [answer] = await until(() => sent(rig, "rpcError").length > 0 && sent(rig, "rpcError"), "the refusal");
    expect(answer).toEqual({ t: "rpcError", id: "rpc-1", error: "session_content_off" });
    expect(rig.dispatched).toEqual([]);
    await until(() => rig.refusedCalls.length > 0, "the refusal to be handed on");
    expect(rig.refusedCalls).toEqual([["rpc", "readChunkText"]]);
    expect(rig.counts.refused).toEqual({ rpc: 1 });
    expect(rig.counts.in.rpc).toBeUndefined();
    // The refusal that went out is counted as sent.
    expect(rig.counts.out.rpcError).toBe(1);
  });

  test("every method is refused the same way, the liveness probe included", async () => {
    const rig = await open(OFF);
    for (const [id, method] of [["a", "ingestCommit"], ["b", "deleteSession"], ["c", "selfTest"]] as const) {
      rig.hub.send(rpc(id, method));
    }
    await until(() => sent(rig, "rpcError").length === 3, "three refusals");
    expect(sent(rig, "rpcError").map((frame) => [frame.id, frame.error])).toEqual([
      ["a", "session_content_off"],
      ["b", "session_content_off"],
      ["c", "session_content_off"],
    ]);
    expect(rig.dispatched).toEqual([]);
  });

  test("a method the control plane invented is handed on as `unknown`, never as its text", async () => {
    const rig = await open(OFF);
    rig.hub.send(rpc("rpc-1", "readEverything-Okafor"));
    rig.hub.send({ t: "rpc", id: "rpc-2", req: null } as never);
    rig.hub.send({ t: "rpc", id: "rpc-3" } as never);
    await until(() => rig.refusedCalls.length === 3, "three refusals handed on");
    expect(rig.refusedCalls).toEqual([
      ["rpc", "unknown"],
      ["rpc", "unknown"],
      ["rpc", "unknown"],
    ]);
    expect(sent(rig, "rpcError")).toHaveLength(3);
  });

  test("a tool call is refused too, and no tool runs", async () => {
    const rig = await open(OFF);
    rig.hub.send({ t: "mcpRpc", id: "mcp-1", req: { method: "callTool", name: "hx_session_search", arguments: {} } } as never);
    rig.hub.send({ t: "mcpRpc", id: "mcp-2", req: { method: "listTools" } } as never);
    await until(() => sent(rig, "mcpRpcError").length === 2, "two refusals");
    expect(sent(rig, "mcpRpcError")).toEqual([
      { t: "mcpRpcError", id: "mcp-1", error: "session_content_off" },
      { t: "mcpRpcError", id: "mcp-2", error: "session_content_off" },
    ]);
    expect(rig.toolCalls).toBe(0);
    await until(() => rig.refusedCalls.length === 2, "two refusals handed on");
    expect(rig.refusedCalls).toEqual([
      ["mcpRpc", ""],
      ["mcpRpc", ""],
    ]);
    expect(rig.counts.refused).toEqual({ mcpRpc: 2 });
  });

  test("an id this host cannot repeat back gets no answer, and the call is refused all the same", async () => {
    const rig = await open(OFF);
    rig.hub.send(rpc(42, "readChunkText"));
    rig.hub.send(rpc("x".repeat(129), "readChunkText"));
    rig.hub.send(rpc("", "readChunkText"));
    await until(() => rig.refusedCalls.length === 3, "three refusals handed on");
    // An ask, so there is a frame to wait for that comes after all three.
    rig.hub.send({ t: "moduleMessage", data: { module: "host", id: "ask-1", kind: "request", payload: {} } } as never);
    await until(() => sent(rig, "moduleReply").length === 1, "the ask's reply");
    expect(sent(rig, "rpcError")).toEqual([]);
    expect(rig.dispatched).toEqual([]);
    expect(rig.counts.refused).toEqual({ rpc: 3 });
  });

  test("an ask is carried as ever", async () => {
    const rig = await open(OFF);
    rig.hub.send({ t: "moduleMessage", data: { module: "host", id: "ask-1", kind: "request", payload: { v: 1 } } } as never);
    await until(() => sent(rig, "moduleReply").length === 1, "the reply");
    expect(rig.asked.map((data) => data.id)).toEqual(["ask-1"]);
    expect(rig.counts.in.moduleMessage).toBe(1);
    expect(rig.counts.out.moduleReply).toBe(1);
  });
});

describe("with session content off, no frame over 256 KiB is taken in", () => {
  test("a larger frame is dropped before it is read, counted, and logged once", async () => {
    const rig = await open(OFF);
    const big = JSON.stringify({
      t: "moduleMessage",
      data: { module: "host", id: "big-1", kind: "request", payload: { filler: "x".repeat(300 * 1024) } },
    });
    rig.hub.sendRaw(big);
    rig.hub.sendRaw(big);
    // A frame under the cap, of the same kind, still reaches the gate.
    rig.hub.sendRaw(
      JSON.stringify({
        t: "moduleMessage",
        data: { module: "host", id: "fits-1", kind: "request", payload: { filler: "x".repeat(200 * 1024) } },
      }),
    );
    await until(() => sent(rig, "moduleReply").length === 1, "the reply to the frame that fits");
    expect(rig.asked.map((data) => data.id)).toEqual(["fits-1"]);
    expect(rig.counts.dropped.too_large).toBe(2);
    expect(rig.logged.filter((line) => line.includes("over the cap"))).toHaveLength(1);
    expect(rig.logged.find((line) => line.includes("over the cap"))).toContain(`cap=${256 * 1024}`);
  });

  test("the same frame is taken where nobody chose, as before the setting", async () => {
    const rig = await open(null);
    rig.hub.sendRaw(
      JSON.stringify({
        t: "moduleMessage",
        data: { module: "host", id: "big-1", kind: "request", payload: { filler: "x".repeat(300 * 1024) } },
      }),
    );
    await until(() => sent(rig, "moduleReply").length === 1, "the reply");
    expect(rig.counts.dropped.too_large).toBe(0);
  });

  test("the log names a method only when it is one this build knows", async () => {
    const rig = await open(OFF);
    rig.hub.sendRaw(JSON.stringify({ t: "rpc", id: "r", req: { method: "Okafor-invented", text: "x".repeat(300 * 1024) } }));
    await until(() => rig.counts.dropped.too_large === 1, "the drop");
    const line = rig.logged.find((entry) => entry.includes("over the cap")) ?? "";
    expect(line).toContain("method=unknown");
    expect(line).not.toContain("Okafor");
  });
});

describe("what travels only while Sessions is on", () => {
  test("with Sessions off, the member list is dropped and nothing about sessions is sent", async () => {
    const rig = await open(OFF);
    rig.hub.send(ROSTER);
    rig.conn.notifyIngest({ userExternalId: "u1", orgExternalId: "northstar" });
    await expect(rig.conn.request({ kind: "routingPosture" } as never, 200)).rejects.toBeInstanceOf(
      FortressQueryUnavailable,
    );
    // Long enough for several heartbeats, each of which would carry the counts.
    await until(() => sent(rig, "heartbeat").length >= 3, "three heartbeats");
    expect(rig.rosters).toBe(0);
    expect(sent(rig, "hxInvalidate")).toEqual([]);
    expect(sent(rig, "collectionStats")).toEqual([]);
    expect(sent(rig, "fortressQuery")).toEqual([]);
    expect(rig.counts.refused).toMatchObject({ rosterSync: 1, hxInvalidate: 1, fortressQuery: 1 });
    expect(rig.counts.refused.collectionStats).toBeGreaterThanOrEqual(1);
  });

  test("with Sessions on and session content off, they travel, and a session call still does not", async () => {
    const rig = await open(OFF_WITH_SESSIONS);
    rig.hub.send(ROSTER);
    rig.conn.notifyIngest({ userExternalId: "u1", orgExternalId: "northstar" });
    rig.hub.send(rpc("rpc-1", "readChunkText"));
    await until(() => rig.rosters === 1 && sent(rig, "hxInvalidate").length === 1, "the member list and the notice");
    await until(() => sent(rig, "collectionStats").length >= 1, "the counts of sessions");
    await until(() => sent(rig, "rpcError").length === 1, "the refusal");
    expect(rig.dispatched).toEqual([]);
    expect(rig.counts.refused).toEqual({ rpc: 1 });
  });

  test("where nobody chose, the member list is taken whether Sessions is on or off, as before", async () => {
    const rig = await open({ sessions: false, sessionContent: null });
    rig.hub.send(ROSTER);
    await until(() => rig.rosters === 1, "the member list");
    expect(rig.counts.refused).toEqual({});
  });
});

describe("with session content on, every session call needs a grant", () => {
  test("a call with no grant is refused as grant_required, and is not dispatched", async () => {
    const rig = await open(ON);
    rig.hub.send(rpc("rpc-1", "readChunkText"));
    const [answer] = await until(() => sent(rig, "rpcError").length > 0 && sent(rig, "rpcError"), "the refusal");
    expect(answer).toEqual({ t: "rpcError", id: "rpc-1", error: "grant_required" });
    expect(rig.dispatched).toEqual([]);
    // It was carried: the kind is allowed, the call was not.
    expect(rig.counts.in.rpc).toBe(1);
    expect(rig.counts.refused).toEqual({});
  });

  test("a grant that does not verify is refused as unauthorized", async () => {
    const rig = await open(ON, {
      verifyGrant: async () => {
        throw new Error("bad signature");
      },
    });
    rig.hub.send({ ...rpc("rpc-1", "readChunkText"), grant: "not-a-grant" } as never);
    const [answer] = await until(() => sent(rig, "rpcError").length > 0 && sent(rig, "rpcError"), "the refusal");
    expect(answer).toEqual({ t: "rpcError", id: "rpc-1", error: "unauthorized" });
    expect(rig.dispatched).toEqual([]);
  });

  test("a call whose grant verifies is served, and the probe that touches no session needs none", async () => {
    const rig = await open(ON, {
      verifyGrant: async () => ({ v: 2, purpose: "read", org: "northstar", aud: "northstar", sub: "u1" }),
    });
    rig.hub.send({ ...rpc("rpc-1", "readChunkText"), grant: "a-grant" } as never);
    rig.hub.send({ t: "rpc", id: "rpc-2", req: { method: "selfTest" } } as never);
    await until(() => sent(rig, "rpcResult").length === 2, "two results");
    expect(rig.dispatched.map((data) => data.id)).toEqual(["rpc-1", "rpc-2"]);
    expect((rig.dispatched[0] as { authz?: unknown }).authz).toEqual({ sub: "u1", scopeHash: undefined });
  });

  test("where nobody chose, a call with no grant is served, as before the setting", async () => {
    const rig = await open(null);
    rig.hub.send(rpc("rpc-1", "readChunkText"));
    await until(() => sent(rig, "rpcResult").length === 1, "the result");
    expect(rig.dispatched.map((data) => data.id)).toEqual(["rpc-1"]);
  });
});

describe("a frame that is no frame of this build", () => {
  test("a name this build does not know is dropped, counted, and logged once", async () => {
    const rig = await open(OFF);
    rig.hub.send({ t: "rowsRead", table: "permits" } as never);
    rig.hub.send({ t: "rowsRead", table: "permits" } as never);
    rig.hub.send({ t: "moduleMessage", data: { module: "host", id: "ask-1", kind: "request", payload: {} } } as never);
    await until(() => sent(rig, "moduleReply").length === 1, "the ask's reply");
    expect(rig.counts.dropped.unknown).toBe(2);
    expect(rig.logged.filter((line) => line.includes("rowsRead"))).toHaveLength(1);
    expect(rig.counts.in.rowsRead).toBeUndefined();
    expect(rig.counts.refused.rowsRead).toBeUndefined();
  });

  test("text that is not a frame is dropped and counted", async () => {
    const rig = await open(OFF);
    rig.hub.sendRaw("not json");
    rig.hub.sendRaw(JSON.stringify({ kind: "no name" }));
    rig.hub.sendRaw(JSON.stringify(["rpc"]));
    rig.hub.send({ t: "moduleMessage", data: { module: "host", id: "ask-1", kind: "request", payload: {} } } as never);
    await until(() => sent(rig, "moduleReply").length === 1, "the ask's reply");
    expect(rig.counts.dropped.unreadable).toBe(3);
  });
});

describe("the counts", () => {
  test("hold the greeting and every heartbeat, by name and direction", async () => {
    const rig = await open(OFF);
    await until(() => (rig.counts.in.heartbeatAck ?? 0) >= 2, "two heartbeats answered");
    expect(rig.counts.out.hello).toBe(1);
    expect(rig.counts.in.welcome).toBe(1);
    expect(rig.counts.out.heartbeat).toBeGreaterThanOrEqual(2);
    expect(Object.keys(rig.counts.in).sort()).toEqual(["heartbeatAck", "welcome"]);
    expect(Object.keys(rig.counts.out).sort()).toEqual(["heartbeat", "hello"]);
  });
});
