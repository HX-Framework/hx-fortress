// The kinds of message on the connection.
//
// The table in src/cloud/kinds.ts is what the connection carries by, what it
// counts by and what the page of data paths lists. These tests hold it to the
// protocol's own list of frames, read here from the package's source, and
// walk every state the connection can be in.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  FRAME_CAP_BYTES,
  FRAME_CAP_WITHOUT_SESSION_CONTENT_BYTES,
  frameCapBytes,
  isCarried,
  kindOfFrame,
  MESSAGE_KINDS,
  MODE_AS_BEFORE,
  SESSION_CALL_METHODS,
  sessionCallMethod,
  type ConnectionMode,
  type KindId,
} from "../../src/cloud/kinds";
import { sessionCallMethodNames } from "../../src/ui/egress";

/**
 * The protocol package's own source of its frames.
 *
 * The package is named in one place, src/protocol/index.ts, and it is found
 * here through that file: the list this test holds the table to is then the
 * one the fortress is built against, whatever the package is called.
 */
async function protocolFrames(): Promise<string> {
  const reexport = await Bun.file(`${import.meta.dir}/../../src/protocol/index.ts`).text();
  const name = /export \* from "([^"]+)"/.exec(reexport)?.[1];
  if (!name) throw new Error("src/protocol/index.ts no longer re-exports one package");
  let dir = path.dirname(Bun.resolveSync(name, import.meta.dir));
  while (!existsSync(path.join(dir, "package.json"))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error("the protocol package has no package.json above its entry");
    dir = up;
  }
  return Bun.file(path.join(dir, "src", "frames.ts")).text();
}

/** The names of a union's frames, read from the protocol's source. */
async function framesOfUnion(name: string): Promise<string[]> {
  const source = await protocolFrames();
  const start = source.indexOf(`export type ${name}`);
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const end = rest.search(/\nexport /);
  const body = end === -1 ? rest : rest.slice(0, end);
  return [...new Set([...body.matchAll(/\bt: "([A-Za-z]+)"/g)].map((match) => match[1] as string))].sort();
}

describe("every frame of the protocol belongs to one kind", () => {
  test("the frames the control plane sends", async () => {
    const listed = MESSAGE_KINDS.flatMap((kind) => kind.in).sort();
    expect(listed).toEqual(await framesOfUnion("HubToFortressFrame"));
    expect(new Set(listed).size).toBe(listed.length);
  });

  test("the frames this fortress sends", async () => {
    const listed = MESSAGE_KINDS.flatMap((kind) => kind.out).sort();
    expect(listed).toEqual(await framesOfUnion("FortressToHubFrame"));
    expect(new Set(listed).size).toBe(listed.length);
  });

  test("a name is a frame in one direction only", () => {
    const incoming = new Set(MESSAGE_KINDS.flatMap((kind) => kind.in));
    for (const frame of MESSAGE_KINDS.flatMap((kind) => kind.out)) expect(incoming.has(frame)).toBe(false);
  });

  test("a frame is found by its name and its direction, and by nothing else", () => {
    expect(kindOfFrame("moduleMessage", "in")?.id).toBe("ask");
    expect(kindOfFrame("moduleReply", "out")?.id).toBe("ask");
    // The right name in the wrong direction is no frame of that direction.
    expect(kindOfFrame("moduleMessage", "out")).toBeNull();
    expect(kindOfFrame("rpcResult", "in")).toBeNull();
    // A name the control plane invented, and things that are not names.
    expect(kindOfFrame("rowsRead", "in")).toBeNull();
    expect(kindOfFrame("constructor", "in")).toBeNull();
    expect(kindOfFrame("__proto__", "in")).toBeNull();
    expect(kindOfFrame(undefined, "in")).toBeNull();
    expect(kindOfFrame(7, "in")).toBeNull();
    expect(kindOfFrame({ toString: () => "rpc" }, "in")).toBeNull();
  });
});

describe("what is carried", () => {
  const carried = (mode: ConnectionMode): KindId[] =>
    MESSAGE_KINDS.filter((kind) => isCarried(kind, mode)).map((kind) => kind.id);
  const FOUR: KindId[] = ["greeting", "heartbeat", "ask", "release"];
  const WITH_SESSIONS: KindId[] = [...FOUR, "members", "session_notice", "question"];
  const ALL: KindId[] = [...WITH_SESSIONS, "session_call", "tool_call"];

  test("session content off, Sessions off: four kinds", () => {
    expect(carried({ sessions: false, sessionContent: "off" })).toEqual(FOUR);
  });

  test("session content off, Sessions on: the member list, the notices and the questions too", () => {
    expect(carried({ sessions: true, sessionContent: "off" })).toEqual(WITH_SESSIONS);
  });

  test("session content on: session calls and tool calls are carried, whatever Sessions is", () => {
    expect(carried({ sessions: true, sessionContent: "on" })).toEqual(ALL);
    expect(carried({ sessions: false, sessionContent: "on" })).toEqual([...FOUR, "session_call", "tool_call"]);
  });

  test("not set: everything the build before the setting carried, whatever Sessions is", () => {
    expect(carried({ sessions: true, sessionContent: null })).toEqual(ALL);
    expect(carried({ sessions: false, sessionContent: null })).toEqual(ALL);
    expect(carried(MODE_AS_BEFORE)).toEqual(ALL);
  });
});

describe("the largest frame taken in", () => {
  test("is 256 KiB while session content is off, and 32 MiB otherwise", () => {
    expect(FRAME_CAP_WITHOUT_SESSION_CONTENT_BYTES).toBe(256 * 1024);
    expect(FRAME_CAP_BYTES).toBe(32 * 1024 * 1024);
    expect(frameCapBytes({ sessions: false, sessionContent: "off" })).toBe(256 * 1024);
    expect(frameCapBytes({ sessions: true, sessionContent: "off" })).toBe(256 * 1024);
    expect(frameCapBytes({ sessions: true, sessionContent: "on" })).toBe(32 * 1024 * 1024);
    expect(frameCapBytes({ sessions: true, sessionContent: null })).toBe(32 * 1024 * 1024);
  });

  test("FORTRESS_MAX_FRAME_BYTES lowers the cap that goes with off, and never raises it", () => {
    const off: ConnectionMode = { sessions: false, sessionContent: "off" };
    expect(frameCapBytes(off, 1000)).toBe(1000);
    expect(frameCapBytes(off, 64 * 1024 * 1024)).toBe(256 * 1024);
  });

  test("in the other two states it is the cap, as before the setting", () => {
    expect(frameCapBytes({ sessions: true, sessionContent: null }, 1000)).toBe(1000);
    expect(frameCapBytes({ sessions: true, sessionContent: null }, 64 * 1024 * 1024)).toBe(64 * 1024 * 1024);
    expect(frameCapBytes({ sessions: true, sessionContent: "on" }, 64 * 1024 * 1024)).toBe(64 * 1024 * 1024);
  });
});

describe("the methods of a session call", () => {
  test("are the ones the Sessions module serves", async () => {
    // The dispatcher's switch is the authority, as it is for the page of data
    // paths. A method that is added there has to be added here, or its refusal
    // would be recorded as `unknown`.
    const source = await Bun.file(`${import.meta.dir}/../../src/modules/session-vault/store/rpc.ts`).text();
    const switchBody = source.slice(source.indexOf("switch (req.method)"));
    const served = [...switchBody.matchAll(/case "([A-Za-z]+)":/g)].map((match) => match[1] as string).sort();
    expect(served.length).toBeGreaterThan(10);
    expect([...SESSION_CALL_METHODS].sort()).toEqual(served);
    expect([...SESSION_CALL_METHODS].sort()).toEqual(sessionCallMethodNames());
  });

  test("a name the control plane invented is never written down", () => {
    expect(sessionCallMethod("readChunkText")).toBe("readChunkText");
    expect(sessionCallMethod("selfTest")).toBe("selfTest");
    expect(sessionCallMethod("readEverything")).toBe("unknown");
    expect(sessionCallMethod("Okafor, Samuel")).toBe("unknown");
    expect(sessionCallMethod("")).toBe("unknown");
    expect(sessionCallMethod(undefined)).toBe("unknown");
    expect(sessionCallMethod(["readChunkText"])).toBe("unknown");
    expect(sessionCallMethod({ toString: () => "readChunkText" })).toBe("unknown");
  });
});
