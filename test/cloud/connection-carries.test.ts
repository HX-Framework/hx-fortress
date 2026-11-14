// What the connection carries, refuses, drops and counts.
//
// The real connection against a stand-in control plane on loopback. Each test
// says what HX Fortress carries (whether Agentic Sessions is on, and whether session
// content may travel), sends frames as a control plane would, and looks at
// three things: what was dispatched, what went back, and what was counted.

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import {
  errorWord,
  idForLog,
  parseFrameCapOverride,
  refusalReason,
  SUPPORTED_PROTOCOL_VERSION,
  versionForMessage,
  WsCloudConnection,
  type WsCloudConnectionDeps,
} from "../../src/cloud/connection";
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
  controlPlane: FakeHub;
  conn: WsCloudConnection;
  /** Every `rpc` the dispatcher was handed. */
  dispatched: MsgData[];
  /** Every ask the gate was handed. */
  asked: MsgData[];
  rosters: number;
  toolCalls: number;
  refusedCalls: [string, string][];
  logged: string[];
  /** What was logged beside each message, in the same order. */
  loggedWith: unknown[];
  counts: { in: Record<string, number>; out: Record<string, number>; refused: Record<string, number>; dropped: Record<DropReason, number> };
}

let rigs: Rig[] = [];

afterEach(async () => {
  // A test below moves the clock.
  setSystemTime();
  for (const rig of rigs) {
    await rig.conn.close().catch(() => {});
    await rig.controlPlane.stop();
  }
  rigs = [];
});

async function open(
  mode: ConnectionMode | null,
  extra: Partial<WsCloudConnectionDeps> = {},
  controlPlaneOptions: Parameters<typeof FakeHub.create>[0] = {},
): Promise<Rig> {
  const controlPlane = await FakeHub.create({ orgId: CREDENTIAL.orgId, ...controlPlaneOptions });
  const counted = { in: {}, out: {}, refused: {}, dropped: { too_large: 0, unreadable: 0, unknown: 0 } } as Rig["counts"];
  const bump = (into: Record<string, number>, key: string): void => {
    into[key] = (into[key] ?? 0) + 1;
  };
  const rig: Rig = {
    controlPlane,
    conn: undefined as unknown as WsCloudConnection,
    dispatched: [],
    asked: [],
    rosters: 0,
    toolCalls: 0,
    refusedCalls: [],
    logged: [],
    loggedWith: [],
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
    logger: {
      error: (message, fields) => {
        rig.logged.push(message);
        rig.loggedWith.push(fields);
      },
    },
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
  await rig.conn.open({ ...CONFIG, cloud: { url: controlPlane.url } });
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
  rig.controlPlane.received().filter((frame): frame is Extract<FortressToHubFrame, { t: T }> => frame.t === t);

const OFF: ConnectionMode = { sessions: false, sessionContent: "off" };
const OFF_WITH_SESSIONS: ConnectionMode = { sessions: true, sessionContent: "off" };
const ON: ConnectionMode = { sessions: true, sessionContent: "on" };

const rpc = (id: unknown, method: unknown): HubToFortressFrame =>
  ({ t: "rpc", id, req: { method, key: { userId: "u1", sessionId: "s1" }, chunkId: "c1" } }) as never;
const ROSTER: HubToFortressFrame = { t: "rosterSync", roster: { asOf: "2027-03-14T09:00:00.000Z", members: [] } } as never;

describe("with session content off, the connection refuses a session call itself", () => {
  test("nothing is dispatched, and the control plane is told one fixed word under its id", async () => {
    const rig = await open(OFF);
    rig.controlPlane.send(rpc("rpc-1", "readChunkText"));
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
      rig.controlPlane.send(rpc(id, method));
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
    rig.controlPlane.send(rpc("rpc-1", "readEverything-Okafor"));
    rig.controlPlane.send({ t: "rpc", id: "rpc-2", req: null } as never);
    rig.controlPlane.send({ t: "rpc", id: "rpc-3" } as never);
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
    rig.controlPlane.send({ t: "mcpRpc", id: "mcp-1", req: { method: "callTool", name: "hx_session_search", arguments: {} } } as never);
    rig.controlPlane.send({ t: "mcpRpc", id: "mcp-2", req: { method: "listTools" } } as never);
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

  test("an id this HX Fortress cannot repeat back gets no answer, and the call is refused all the same", async () => {
    const rig = await open(OFF);
    rig.controlPlane.send(rpc(42, "readChunkText"));
    rig.controlPlane.send(rpc("x".repeat(129), "readChunkText"));
    rig.controlPlane.send(rpc("", "readChunkText"));
    await until(() => rig.refusedCalls.length === 3, "three refusals handed on");
    // An ask, so there is a frame to wait for that comes after all three.
    rig.controlPlane.send({ t: "moduleMessage", data: { module: "host", id: "ask-1", kind: "request", payload: {} } } as never);
    await until(() => sent(rig, "moduleReply").length === 1, "the ask's reply");
    expect(sent(rig, "rpcError")).toEqual([]);
    expect(rig.dispatched).toEqual([]);
    expect(rig.counts.refused).toEqual({ rpc: 3 });
  });

  test("an id of 128 characters is the longest that is answered", async () => {
    const rig = await open(OFF);
    const longest = "x".repeat(128);
    rig.controlPlane.send(rpc(longest, "readChunkText"));
    const [answer] = await until(() => sent(rig, "rpcError").length > 0 && sent(rig, "rpcError"), "the refusal");
    expect(answer).toEqual({ t: "rpcError", id: longest, error: "session_content_off" });
  });

  test("a refusal that cannot be recorded is still a refusal, and the connection goes on", async () => {
    const rig = await open(OFF, {
      onRefusedCall: () => {
        throw new Error("the audit trail is full");
      },
    });
    rig.controlPlane.send(rpc("rpc-1", "readChunkText"));
    await until(() => sent(rig, "rpcError").length === 1, "the refusal");
    await until(() => rig.logged.includes("a refused call could not be recorded"), "the log line");
    expect(rig.dispatched).toEqual([]);
    rig.controlPlane.send({ t: "moduleMessage", data: { module: "host", id: "ask-1", kind: "request", payload: {} } } as never);
    await until(() => sent(rig, "moduleReply").length === 1, "the ask's reply");
  });

  test("it refuses the same way after the connection was lost and made again", async () => {
    const rig = await open(OFF);
    rig.controlPlane.send(rpc("rpc-1", "readChunkText"));
    await until(() => sent(rig, "rpcError").length === 1, "the first refusal");
    rig.controlPlane.dropConnection();
    await until(() => sent(rig, "hello").length === 2, "the second greeting");
    await until(() => rig.conn.state() === "connected", "the connection");
    rig.controlPlane.send(rpc("rpc-2", "readChunkText"));
    await until(() => sent(rig, "rpcError").length === 2, "the second refusal");
    expect(sent(rig, "rpcError").map((frame) => frame.error)).toEqual(["session_content_off", "session_content_off"]);
    expect(rig.dispatched).toEqual([]);
    expect(rig.counts.refused).toEqual({ rpc: 2 });
  });

  test("an ask is carried as ever", async () => {
    const rig = await open(OFF);
    rig.controlPlane.send({ t: "moduleMessage", data: { module: "host", id: "ask-1", kind: "request", payload: { v: 1 } } } as never);
    await until(() => sent(rig, "moduleReply").length === 1, "the reply");
    expect(rig.asked.map((data) => data.id)).toEqual(["ask-1"]);
    expect(rig.counts.in.moduleMessage).toBe(1);
    expect(rig.counts.out.moduleReply).toBe(1);
  });
});

const bigAsk = (id: string, kib: number): string =>
  JSON.stringify({
    t: "moduleMessage",
    data: { module: "host", id, kind: "request", payload: { filler: "x".repeat(kib * 1024) } },
  });
const overTheCap = (rig: Rig): string[] => rig.logged.filter((line) => line.includes("over the cap"));

describe("with session content off and Agentic Sessions off, no frame over 256 KiB is parsed", () => {
  test("a larger frame is dropped, counted, and logged once with its name", async () => {
    const rig = await open(OFF);
    rig.controlPlane.sendRaw(bigAsk("big-1", 300));
    rig.controlPlane.sendRaw(bigAsk("big-2", 300));
    // A frame under the cap, of the same kind, still reaches the gate.
    rig.controlPlane.sendRaw(bigAsk("fits-1", 200));
    await until(() => sent(rig, "moduleReply").length === 1, "the reply to the frame that fits");
    expect(rig.asked.map((data) => data.id)).toEqual(["fits-1"]);
    expect(rig.counts.dropped.too_large).toBe(2);
    expect(overTheCap(rig)).toHaveLength(1);
    expect(overTheCap(rig)[0]).toMatch(
      new RegExp(`over the cap: frame=moduleMessage bytes=\\d+ cap=${256 * 1024}$`),
    );
  });

  test("it is logged again once a minute has passed", async () => {
    const rig = await open(OFF);
    rig.controlPlane.sendRaw(bigAsk("big-1", 300));
    await until(() => rig.counts.dropped.too_large === 1, "the first drop");
    setSystemTime(new Date(Date.now() + 59_000));
    rig.controlPlane.sendRaw(bigAsk("big-2", 300));
    await until(() => rig.counts.dropped.too_large === 2, "the second drop");
    expect(overTheCap(rig)).toHaveLength(1);
    setSystemTime(new Date(Date.now() + 2_000));
    rig.controlPlane.sendRaw(bigAsk("big-3", 300));
    await until(() => rig.counts.dropped.too_large === 3, "the third drop");
    expect(overTheCap(rig)).toHaveLength(2);
  });

  test("the same frame is taken where nobody chose, as before the setting", async () => {
    const rig = await open(null);
    rig.controlPlane.sendRaw(bigAsk("big-1", 300));
    await until(() => sent(rig, "moduleReply").length === 1, "the reply");
    expect(rig.counts.dropped.too_large).toBe(0);
  });

  test("the log names a frame and a method only when this build knows them", async () => {
    const rig = await open(OFF);
    const text = "x".repeat(300 * 1024);
    rig.controlPlane.sendRaw(JSON.stringify({ t: "rpc", id: "r", req: { method: "Okafor-invented", text } }));
    await until(() => rig.counts.dropped.too_large === 1, "the first drop");
    expect(overTheCap(rig)[0]).toContain("frame=rpc method=unknown bytes=");
    setSystemTime(new Date(Date.now() + 61_000));
    rig.controlPlane.sendRaw(JSON.stringify({ t: "rpc", id: "r", req: { method: "ingestCommit", text } }));
    await until(() => rig.counts.dropped.too_large === 2, "the second drop");
    expect(overTheCap(rig)[1]).toContain("frame=rpc method=ingestCommit bytes=");
    setSystemTime(new Date(Date.now() + 61_000));
    rig.controlPlane.sendRaw(JSON.stringify({ t: "Okafor-invented", text }));
    await until(() => rig.counts.dropped.too_large === 3, "the third drop");
    expect(overTheCap(rig)[2]).toContain("frame=unknown bytes=");
    expect(rig.logged.join("\n")).not.toContain("Okafor");
  });
});

describe("with Agentic Sessions on, the member list is one large frame and it is taken", () => {
  const bigRoster = (kib: number): string =>
    JSON.stringify({
      t: "rosterSync",
      roster: { asOf: "2027-03-14T09:00:00.000Z", members: [], filler: "x".repeat(kib * 1024) },
    });

  test("with session content off, a member list over 256 KiB is applied", async () => {
    const rig = await open(OFF_WITH_SESSIONS);
    rig.controlPlane.sendRaw(bigRoster(900));
    await until(() => rig.rosters === 1, "the member list");
    expect(rig.counts.dropped.too_large).toBe(0);
    expect(rig.counts.in.rosterSync).toBe(1);
  });

  test("with Agentic Sessions off it is not carried at all, and one over the cap is named in the log", async () => {
    const rig = await open(OFF);
    rig.controlPlane.sendRaw(bigRoster(900));
    await until(() => rig.counts.dropped.too_large === 1, "the drop");
    expect(rig.rosters).toBe(0);
    expect(overTheCap(rig)[0]).toContain("frame=rosterSync bytes=");
  });
});

describe("FORTRESS_MAX_FRAME_BYTES", () => {
  test("is a whole number of bytes of at least one, or it is not a cap", () => {
    expect(parseFrameCapOverride(undefined)).toBeNull();
    expect(parseFrameCapOverride("")).toBeNull();
    expect(parseFrameCapOverride("many")).toBeNull();
    expect(parseFrameCapOverride("0")).toBeNull();
    expect(parseFrameCapOverride("-5")).toBeNull();
    // A fraction under one is not a cap of zero bytes, which would drop every frame.
    expect(parseFrameCapOverride("0.5")).toBeNull();
    expect(parseFrameCapOverride("1")).toBe(1);
    expect(parseFrameCapOverride("1000.9")).toBe(1000);
    expect(parseFrameCapOverride("33554432")).toBe(33554432);
  });
});

describe("what travels only while Agentic Sessions is on", () => {
  test("with Agentic Sessions off, the member list is dropped and nothing about sessions is sent", async () => {
    const rig = await open(OFF);
    rig.controlPlane.send(ROSTER);
    rig.conn.notifyIngest({ userExternalId: "u1", orgExternalId: "northstar" });
    // The question is refused at once, as a control plane that cannot be
    // asked: it does not wait out its two seconds.
    const asked = performance.now();
    const refused: unknown = await rig.conn.request({ kind: "routingPosture" } as never, 2_000).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(FortressQueryUnavailable);
    expect((refused as FortressQueryUnavailable).cause_).toBe("offline");
    expect(performance.now() - asked).toBeLessThan(1_000);
    // Long enough for several heartbeats, each of which would carry the counts.
    await until(() => sent(rig, "heartbeat").length >= 3, "three heartbeats");
    expect(rig.rosters).toBe(0);
    expect(sent(rig, "hxInvalidate")).toEqual([]);
    expect(sent(rig, "collectionStats")).toEqual([]);
    expect(sent(rig, "fortressQuery")).toEqual([]);
    expect(rig.counts.refused).toMatchObject({ rosterSync: 1, hxInvalidate: 1, fortressQuery: 1 });
    expect(rig.counts.refused.collectionStats).toBeGreaterThanOrEqual(1);
  });

  test("a question that is carried is asked, and its answer comes back", async () => {
    const rig = await open(OFF_WITH_SESSIONS);
    const answer = rig.conn.request({ kind: "routingPosture" } as never, 2_000);
    const [question] = await until(() => sent(rig, "fortressQuery").length > 0 && sent(rig, "fortressQuery"), "the question");
    rig.controlPlane.send({ t: "fortressQueryError", id: question?.id ?? "", error: "not_now" } as never);
    const refused: unknown = await answer.catch((error: unknown) => error);
    expect((refused as FortressQueryUnavailable).cause_).toBe("error");
    expect(rig.counts.refused.fortressQuery).toBeUndefined();
  });

  test("with Agentic Sessions on and session content off, they travel, and a session call still does not", async () => {
    const rig = await open(OFF_WITH_SESSIONS);
    rig.controlPlane.send(ROSTER);
    rig.conn.notifyIngest({ userExternalId: "u1", orgExternalId: "northstar" });
    rig.controlPlane.send(rpc("rpc-1", "readChunkText"));
    await until(() => rig.rosters === 1 && sent(rig, "hxInvalidate").length === 1, "the member list and the notice");
    await until(() => sent(rig, "collectionStats").length >= 1, "the counts of sessions");
    await until(() => sent(rig, "rpcError").length === 1, "the refusal");
    expect(rig.dispatched).toEqual([]);
    expect(rig.counts.refused).toEqual({ rpc: 1 });
  });

  test("where nobody chose, the member list is taken whether Agentic Sessions is on or off, as before", async () => {
    const rig = await open({ sessions: false, sessionContent: null });
    rig.controlPlane.send(ROSTER);
    await until(() => rig.rosters === 1, "the member list");
    expect(rig.counts.refused).toEqual({});
  });
});

describe("with session content on, every session call needs a grant", () => {
  test("a call with no grant is refused as grant_required, and is not dispatched", async () => {
    const rig = await open(ON);
    rig.controlPlane.send(rpc("rpc-1", "readChunkText"));
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
    rig.controlPlane.send({ ...rpc("rpc-1", "readChunkText"), grant: "not-a-grant" } as never);
    const [answer] = await until(() => sent(rig, "rpcError").length > 0 && sent(rig, "rpcError"), "the refusal");
    expect(answer).toEqual({ t: "rpcError", id: "rpc-1", error: "unauthorized" });
    expect(rig.dispatched).toEqual([]);
  });

  test("a call whose grant verifies is served, and the probe that touches no session needs none", async () => {
    const rig = await open(ON, {
      verifyGrant: async () => ({ v: 2, purpose: "read", org: "northstar", aud: "northstar", sub: "u1" }),
    });
    rig.controlPlane.send({ ...rpc("rpc-1", "readChunkText"), grant: "a-grant" } as never);
    rig.controlPlane.send({ t: "rpc", id: "rpc-2", req: { method: "selfTest" } } as never);
    await until(() => sent(rig, "rpcResult").length === 2, "two results");
    expect(rig.dispatched.map((data) => data.id)).toEqual(["rpc-1", "rpc-2"]);
    expect((rig.dispatched[0] as { authz?: unknown }).authz).toEqual({ sub: "u1", scopeHash: undefined });
  });

  test("where nobody chose, a call with no grant is served, as before the setting", async () => {
    const rig = await open(null);
    rig.controlPlane.send(rpc("rpc-1", "readChunkText"));
    await until(() => sent(rig, "rpcResult").length === 1, "the result");
    expect(rig.dispatched.map((data) => data.id)).toEqual(["rpc-1"]);
  });
});

describe("text the control plane chose stays out of the log and the status file", () => {
  test("a session call that fails is logged by its method and the first word of its error", async () => {
    // What the Agentic Sessions module answers for a method it does not know: the whole request.
    const error = 'unknown_vault_method:{"method":"readEverything","text":"what Okafor said in a session"}';
    const rig = await open(null, {
      dispatcher: { dispatch: async () => ({ ok: false, error }) },
    });
    rig.controlPlane.send(rpc("rpc-1", "readEverything"));
    const [answer] = await until(() => sent(rig, "rpcError").length > 0 && sent(rig, "rpcError"), "the error");
    // The control plane gets back what it got before.
    expect(answer).toEqual({ t: "rpcError", id: "rpc-1", error });
    expect(rig.logged).toContain("a session call failed: method=unknown error=unknown_vault_method");
    expect(rig.logged.join("\n")).not.toContain("Okafor");
    expect(rig.logged.join("\n")).not.toContain("readEverything");
  });

  test("a known method is named, and an error of several words is cut to its first", () => {
    expect(errorWord("unknown_vault_method:{}")).toBe("unknown_vault_method");
    expect(errorWord("failed:internal")).toBe("failed");
    expect(errorWord("ingest paused until 2027-03-14")).toBe("ingest");
    expect(errorWord("x".repeat(200))).toBe("x".repeat(64));
    expect(errorWord("")).toBe("error");
    expect(errorWord(": starts with no word")).toBe("error");
    expect(errorWord(undefined)).toBe("error");
  });

  test("a refusal's reason is kept when it is one word, and replaced when it is not", async () => {
    expect(refusalReason("invalid_credential")).toBe("invalid_credential");
    expect(refusalReason("protocol.version:2")).toBe("protocol.version:2");
    expect(refusalReason("x".repeat(128))).toBe("x".repeat(128));
    expect(refusalReason("x".repeat(129))).toBe("reason_withheld");
    expect(refusalReason("your credential, Okafor, was revoked")).toBe("reason_withheld");
    expect(refusalReason("")).toBe("reason_withheld");
    expect(refusalReason(undefined)).toBe("reason_withheld");
    expect(refusalReason({ toString: () => "invalid_credential" })).toBe("reason_withheld");

    const rig = await open(OFF);
    rig.controlPlane.send({ t: "fatal", reason: `revoked: ${"Okafor ".repeat(400)}` } as never);
    await until(() => rig.conn.status().reason !== null, "the refusal");
    expect(rig.conn.status()).toMatchObject({
      reason: "reason_withheld",
      message: "The control plane refused the connection: reason_withheld",
    });
    expect(rig.logged).toContain("the control plane refused the connection: reason_withheld");
    expect(rig.logged.join("\n")).not.toContain("Okafor");
  });

  test("a reason of one word is kept as it was", async () => {
    const rig = await open(OFF);
    rig.controlPlane.send({ t: "fatal", reason: "invalid_credential" } as never);
    await until(() => rig.conn.status().reason !== null, "the refusal");
    expect(rig.conn.status()).toMatchObject({
      reason: "invalid_credential",
      message: "The control plane refused the connection: invalid_credential",
    });
  });
});

describe("a frame the control plane filled with text of its own", () => {
  const TEXT = `Okafor's session said ${"so and so ".repeat(400)}`;

  test("a protocol version that is not a number is not repeated, in the error or in the log", async () => {
    expect(versionForMessage(1)).toBe("1");
    expect(versionForMessage(99)).toBe("99");
    expect(versionForMessage("99")).toBe("not a version number");
    expect(versionForMessage(1.5)).toBe("not a version number");
    expect(versionForMessage(TEXT)).toBe("not a version number");
    expect(versionForMessage(undefined)).toBe("not a version number");
    expect(versionForMessage({ toString: () => "1" })).toBe("not a version number");

    const refused: unknown = await open(OFF, {}, { protocolVersion: TEXT as never }).then(
      () => null,
      (error: unknown) => error,
    );
    expect((refused as Error).message).toBe(
      "Unsupported protocol version from the control plane: not a version number (client supports 1)",
    );
    const rig = rigs[rigs.length - 1] as Rig;
    expect(rig.logged).toContain(
      "Unsupported protocol version from the control plane: not a version number (client supports 1)",
    );
    expect(JSON.stringify([rig.logged, rig.loggedWith])).not.toContain("Okafor");
  });

  test("an organization's id that is not an id is logged as a fixed word", async () => {
    expect(idForLog("northstar")).toBe("northstar");
    expect(idForLog("org_9f2c1d6e-0b7a")).toBe("org_9f2c1d6e-0b7a");
    expect(idForLog("x".repeat(128))).toBe("x".repeat(128));
    expect(idForLog("x".repeat(129))).toBe("not_an_id");
    expect(idForLog(TEXT)).toBe("not_an_id");
    expect(idForLog("")).toBe("not_an_id");
    expect(idForLog(undefined)).toBe("not_an_id");

    // This HX Fortress pinned one key. The control plane pushes another with no
    // proof, under an organization id that is a page of text. The change of key
    // is refused, and the log names no part of that text.
    const rig = await open(
      OFF,
      {
        signingKeyStore: {
          loadRecord: async () => ({ key: "the-key-pinned-before", pinnedAt: "2027-03-01T00:00:00.000Z", rootVerified: false, notBefore: null }),
          saveRecord: async () => {
            throw new Error("a refused key must not be saved");
          },
        },
      },
      { orgId: TEXT, signingPublicKey: "another-key" },
    );
    await until(() => rig.logged.includes("signing_key_rotation_rejected"), "the refusal of the key");
    const at = rig.logged.indexOf("signing_key_rotation_rejected");
    expect(rig.loggedWith[at]).toEqual({ orgId: "not_an_id" });
    expect(JSON.stringify([rig.logged, rig.loggedWith])).not.toContain("Okafor");
  });
});

describe("no frame ends the daemon", () => {
  const ask = (id: string): HubToFortressFrame =>
    ({ t: "moduleMessage", data: { module: "host", id, kind: "request", payload: {} } }) as never;

  test("a session call with no request to read is answered, and nothing is dispatched", async () => {
    for (const mode of [null, ON]) {
      const rig = await open(mode);
      rig.controlPlane.send({ t: "rpc", id: "none" } as never);
      rig.controlPlane.send({ t: "rpc", id: "null", req: null } as never);
      rig.controlPlane.send({ t: "rpc", id: "text", req: "readChunkText" } as never);
      rig.controlPlane.send({ t: "rpc", id: "list", req: ["readChunkText"] } as never);
      await until(() => sent(rig, "rpcError").length === 4, "four answers");
      expect(sent(rig, "rpcError").map((frame) => [frame.id, frame.error])).toEqual([
        ["none", "invalid_request"],
        ["null", "invalid_request"],
        ["text", "invalid_request"],
        ["list", "invalid_request"],
      ]);
      expect(rig.dispatched).toEqual([]);
      // With an id it cannot repeat back there is no answer, and the connection goes on.
      rig.controlPlane.send({ t: "rpc", id: 42 } as never);
      rig.controlPlane.send(ask("after"));
      await until(() => sent(rig, "moduleReply").length === 1, "the ask's reply");
      expect(sent(rig, "rpcError")).toHaveLength(4);
      expect(rig.conn.state()).toBe("connected");
    }
  });

  test("a request with no method is served as before: the module refuses it", async () => {
    const rig = await open(null);
    rig.controlPlane.send({ t: "rpc", id: "rpc-1", req: {} } as never);
    await until(() => sent(rig, "rpcResult").length === 1, "the result");
    // The rig's module answers everything. What matters is that it was asked.
    expect(rig.dispatched.map((data) => data.id)).toEqual(["rpc-1"]);
  });

  test("a handler that throws is caught: the log names the frame and the kind of error, not its text", async () => {
    const rig = await open(null, {
      dispatcher: {
        dispatch: async () => {
          throw new TypeError("could not read what Okafor said in session s-permits");
        },
      },
    });
    rig.controlPlane.send(rpc("rpc-1", "readChunkText"));
    await until(
      () => rig.logged.includes("a frame from the control plane could not be handled: rpc"),
      "the log line",
    );
    const at = rig.logged.indexOf("a frame from the control plane could not be handled: rpc");
    expect(rig.loggedWith[at]).toEqual({ kind: "TypeError" });
    expect(JSON.stringify([rig.logged, rig.loggedWith])).not.toContain("Okafor");
    // The connection goes on.
    rig.controlPlane.send(ask("after"));
    await until(() => sent(rig, "moduleReply").length === 1, "the ask's reply");
  });
});

describe("what the connection says about itself", () => {
  test("its status holds the state it goes by, and nothing where nobody gave it one", async () => {
    expect((await open(OFF)).conn.status().sessionContent).toBe("off");
    expect((await open(ON)).conn.status().sessionContent).toBe("on");
    expect((await open({ sessions: true, sessionContent: null })).conn.status().sessionContent).toBe("not_set");
    expect("sessionContent" in (await open(null)).conn.status()).toBe(false);
  });
});

describe("a frame that is no frame of this build", () => {
  test("a name this build does not know is dropped, counted, and logged once", async () => {
    const rig = await open(OFF);
    rig.controlPlane.send({ t: "rowsRead", table: "permits" } as never);
    rig.controlPlane.send({ t: "rowsRead", table: "permits" } as never);
    rig.controlPlane.send({ t: "moduleMessage", data: { module: "host", id: "ask-1", kind: "request", payload: {} } } as never);
    await until(() => sent(rig, "moduleReply").length === 1, "the ask's reply");
    expect(rig.counts.dropped.unknown).toBe(2);
    expect(rig.logged.filter((line) => line.includes("rowsRead"))).toHaveLength(1);
    expect(rig.counts.in.rowsRead).toBeUndefined();
    expect(rig.counts.refused.rowsRead).toBeUndefined();
  });

  test("text that is not a frame is dropped and counted", async () => {
    const rig = await open(OFF);
    rig.controlPlane.sendRaw("not json");
    rig.controlPlane.sendRaw(JSON.stringify({ kind: "no name" }));
    rig.controlPlane.sendRaw(JSON.stringify(["rpc"]));
    rig.controlPlane.send({ t: "moduleMessage", data: { module: "host", id: "ask-1", kind: "request", payload: {} } } as never);
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
