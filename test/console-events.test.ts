// The events stream: its caps, its revocation, and the framing the client reads.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  EVENTS_BACKOFF_MS,
  EVENTS_GLOBAL_CEILING,
  EVENTS_HEARTBEAT_MS,
  EVENTS_IDLE_TIMEOUT_S,
  EVENTS_PATH,
  EVENTS_PER_SESSION_CAP,
  EVENTS_PER_USER_CAP,
  EVENTS_RETRY_MS,
  EVENT_STREAM_CLIENT_CONTRACT,
  EventStreamRegistry,
  type EventProducer,
} from "../src/ui/events";
import { createLogEventProducer } from "../src/ui/log-events";
import { SessionTable } from "../src/ui/sessions";
import type { UiUser, UsersFile } from "../src/ui/users";

/** A producer that never ends on its own, so a stream stays open until something
 *  closes it - which is what every test here is about. */
const idle: EventProducer = {
  start(_sink, signal) {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  },
};

function open(registry: EventStreamRegistry, sessionId: string, userLogin: string, extra: Record<string, unknown> = {}) {
  return registry.open({ sessionId, userLogin, producer: idle, ...extra });
}

async function readSome(response: Response, bytes = 1): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let out = "";
  for (let i = 0; i < bytes; i += 1) {
    const chunk = await reader.read();
    if (chunk.done) break;
    out += decoder.decode(chunk.value);
  }
  void reader.cancel();
  return out;
}

describe("caps", () => {
  test("a session may hold its own budget and no more", () => {
    const registry = new EventStreamRegistry();
    for (let i = 0; i < EVENTS_PER_SESSION_CAP; i += 1) {
      expect(open(registry, "sess-a", "marta").ok).toBe(true);
    }
    const refused = open(registry, "sess-a", "marta");
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.status).toBe(429);
    registry.closeAll();
  });

  test("a user at their cap does not starve another user", () => {
    const registry = new EventStreamRegistry();
    // Marta opens across several tabs until her per-USER cap is spent.
    let opened = 0;
    for (let tab = 0; opened < EVENTS_PER_USER_CAP; tab += 1) {
      for (let i = 0; i < EVENTS_PER_SESSION_CAP && opened < EVENTS_PER_USER_CAP; i += 1) {
        expect(open(registry, `marta-${tab}`, "marta").ok).toBe(true);
        opened += 1;
      }
    }
    expect(open(registry, "marta-99", "marta").ok).toBe(false);
    // Raj is unaffected. This is the whole reason the cap is not global-only.
    expect(open(registry, "raj-0", "raj").ok).toBe(true);
    registry.closeAll();
  });

  test("the global ceiling still bounds the process", () => {
    const registry = new EventStreamRegistry();
    let opened = 0;
    for (let user = 0; opened < EVENTS_GLOBAL_CEILING; user += 1) {
      for (let i = 0; i < EVENTS_PER_SESSION_CAP && opened < EVENTS_GLOBAL_CEILING; i += 1) {
        const verdict = open(registry, `u${user}-s${i}`, `u${user}`);
        expect(verdict.ok).toBe(true);
        opened += 1;
      }
    }
    expect(registry.size).toBe(EVENTS_GLOBAL_CEILING);
    const refused = open(registry, "late-s", "late");
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.reason).toContain("all the live connections it can");
    registry.closeAll();
  });

  test("a closed stream returns its slot", () => {
    const registry = new EventStreamRegistry();
    const first = open(registry, "sess-a", "marta");
    expect(first.ok).toBe(true);
    if (first.ok) first.handle.close("client");
    expect(registry.countForSession("sess-a")).toBe(0);
    expect(open(registry, "sess-a", "marta").ok).toBe(true);
    registry.closeAll();
  });
});

describe("framing", () => {
  test("the first bytes carry the retry floor and an open event", async () => {
    const registry = new EventStreamRegistry();
    const verdict = open(registry, "sess-a", "marta");
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.response.headers.get("content-type")).toBe("text/event-stream");
    expect(verdict.response.headers.get("x-accel-buffering")).toBe("no");
    const text = await readSome(verdict.response, 2);
    expect(text).toContain(`retry: ${EVENTS_RETRY_MS}`);
    expect(text).toContain("event: open");
    registry.closeAll();
  });

  test("last-event-id reaches the producer untouched", async () => {
    const registry = new EventStreamRegistry();
    let seen: string | null | undefined;
    const verdict = registry.open({
      sessionId: "sess-a",
      userLogin: "marta",
      lastEventId: "offset-4211",
      producer: {
        start(_sink, signal, lastEventId) {
          seen = lastEventId;
          return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        },
      },
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) await readSome(verdict.response, 1);
    expect(seen).toBe("offset-4211");
    registry.closeAll();
  });

  test("the client contract is stated in one place", () => {
    expect(EVENT_STREAM_CLIENT_CONTRACT.path).toBe(EVENTS_PATH);
    expect(EVENT_STREAM_CLIENT_CONTRACT.header).toBe("x-fortress-ui-token");
    expect(EVENT_STREAM_CLIENT_CONTRACT.tokenMedium).toBe("sessionStorage");
    expect(EVENT_STREAM_CLIENT_CONTRACT.closeOn).toBe("visibilitychange");
    expect(EVENT_STREAM_CLIENT_CONTRACT.backoffMs).toEqual(EVENTS_BACKOFF_MS);
    expect(EVENTS_BACKOFF_MS[EVENTS_BACKOFF_MS.length - 1]).toBeGreaterThanOrEqual(EVENTS_RETRY_MS);
  });
});

describe("revocation", () => {
  function usersFile(user: Partial<UiUser> = {}): UsersFile {
    const base: UiUser = {
      login: "marta",
      role: "operator",
      pwdHash: null,
      pwdVersion: 1,
      credentialEpoch: 0,
      lockoutEpoch: 0,
      createdAt: "2026-07-01T00:00:00.000Z",
      disabledAt: null,
      deletedAt: null,
      setupTokens: [],
      ...user,
    } as UiUser;
    return { version: 1, sessionEpoch: 0, users: [base] } as UsersFile;
  }

  test("a dropped session takes its streams with it", () => {
    const registry = new EventStreamRegistry();
    const sessions = new SessionTable();
    registry.attachRevocation((listener) => sessions.onDrop((session) => listener(session)));

    const file = usersFile();
    const issued = sessions.issue({ user: file.users[0], file, remoteAddr: "127.0.0.1" });
    expect(open(registry, issued.session.id, "marta").ok).toBe(true);
    expect(registry.size).toBe(1);

    // `ui user disable` in another process bumps the record; the next validated
    // request drops the session, and the stream goes with it.
    sessions.validate(issued.token, usersFile({ disabledAt: "2026-07-01T01:00:00.000Z" }), {
      ttlHours: 12,
      idleMinutes: 60,
    });
    expect(registry.size).toBe(0);
  });

  test("an explicit revoke closes the stream too", () => {
    const registry = new EventStreamRegistry();
    const sessions = new SessionTable();
    registry.attachRevocation((listener) => sessions.onDrop((session) => listener(session)));
    const file = usersFile();
    const issued = sessions.issue({ user: file.users[0], file, remoteAddr: "127.0.0.1" });
    open(registry, issued.session.id, "marta");
    sessions.revoke(issued.session.id);
    expect(registry.size).toBe(0);
  });

  test("the heartbeat closes a stream whose user is gone, within one beat", async () => {
    const registry = new EventStreamRegistry();
    let valid = true;
    const verdict = registry.open({
      sessionId: "sess-a",
      userLogin: "marta",
      producer: idle,
      stillValid: () => valid,
      heartbeatMs: 10,
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const reader = verdict.response.body?.getReader();
    const decoder = new TextDecoder();
    // Drain the opening frames.
    await reader?.read();
    await reader?.read();
    valid = false;
    let text = "";
    for (let i = 0; i < 6; i += 1) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      text += decoder.decode(chunk.value);
      if (text.includes("event: closed")) break;
    }
    expect(text).toContain("event: closed");
    expect(text).toContain("disabled");
    expect(registry.size).toBe(0);
  });

  test("a THROWING belt closes the stream instead of killing the process", async () => {
    // `stillValid` reads the user store, which throws on any unreadable file.
    // Unhandled, that rejection is fatal to the console process — the one whose
    // job is to say what is broken on a broken fortress. It must hang up the
    // stream and stay alive.
    const registry = new EventStreamRegistry();
    const verdict = registry.open({
      sessionId: "sess-a",
      userLogin: "marta",
      producer: idle,
      stillValid: () => Promise.reject(new Error("users.json is unreadable")),
      heartbeatMs: 10,
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const reader = verdict.response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (let i = 0; i < 8; i += 1) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      text += decoder.decode(chunk.value);
      if (text.includes("event: closed")) break;
    }
    expect(text).toContain("event: closed");
    expect(text).toContain("disabled");
    expect(registry.size).toBe(0);
  });

  test("the belt applies the EPOCH predicates, not just eligibility", () => {
    // `reset` — the console's standing remedy for a locked-out operator — bumps
    // the credential epoch and touches none of the account flags, so a belt that
    // asked only "may this login sign in" kept the live daemon log flowing to a
    // principal every ordinary request already refuses.
    const sessions = new SessionTable();
    const file = usersFile({ pwdHash: "x" });
    const issued = sessions.issue({ user: file.users[0], file, remoteAddr: "127.0.0.1" });
    expect(sessions.revocationCheck(issued.session.id, file)).toBe(true);

    const afterReset: UsersFile = {
      ...file,
      users: [{ ...file.users[0], credentialEpoch: file.users[0].credentialEpoch + 1 }],
    };
    // signInEligible still says yes — present, not deleted, not disabled, has a
    // hash — which is exactly why the weaker predicate was the defect.
    expect(afterReset.users[0].disabledAt).toBeNull();
    expect(sessions.revocationCheck(issued.session.id, afterReset)).toBe(false);
    // Dropped, so the request path agrees with the belt.
    expect(sessions.revocationCheck(issued.session.id, file)).toBe(false);
  });

  test("the belt also catches a session-epoch bump and a disabled account", () => {
    const sessions = new SessionTable();
    const file = usersFile({ pwdHash: "x" });

    const a = sessions.issue({ user: file.users[0], file, remoteAddr: "127.0.0.1" });
    expect(sessions.revocationCheck(a.session.id, { ...file, sessionEpoch: file.sessionEpoch + 1 })).toBe(false);

    const b = sessions.issue({ user: file.users[0], file, remoteAddr: "127.0.0.1" });
    const disabled: UsersFile = {
      ...file,
      users: [{ ...file.users[0], disabledAt: "2026-08-01T00:00:00.000Z" }],
    };
    expect(sessions.revocationCheck(b.session.id, disabled)).toBe(false);

    // An id the table never held is not valid either.
    expect(sessions.revocationCheck("no-such-session", file)).toBe(false);
  });

  test("closing every stream is one call, and it is idempotent", () => {
    const registry = new EventStreamRegistry();
    open(registry, "a", "marta");
    open(registry, "b", "raj");
    expect(registry.closeAll()).toBe(2);
    expect(registry.closeAll()).toBe(0);
  });
});


describe("the log producer", () => {
  async function withLog(lines: string[], fn: (logPath: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hx-logs-"));
    try {
      const logPath = path.join(dir, "fortress.jsonl");
      await writeFile(logPath, `${lines.join("\n")}\n`);
      await fn(logPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const lines = [
    JSON.stringify({ ts: "2026-07-01T00:00:00.000Z", module: "host", level: "info", msg: "a" }),
    JSON.stringify({ ts: "2026-07-01T00:00:01.000Z", module: "host", level: "info", msg: "b" }),
    "a torn line",
  ];

  test("backfills history, ids each record by its own timestamp", async () => {
    await withLog(lines, async (logPath) => {
      const events: Array<{ event: string; id?: string }> = [];
      const controller = new AbortController();
      const producer = createLogEventProducer({ logPath, pollMs: 5 });
      const running = producer.start((event) => {
        events.push(event);
        if (event.event === "log-backfill-complete") controller.abort();
      }, controller.signal, null);
      await running;
      const logs = events.filter((e) => e.event === "log");
      expect(logs).toHaveLength(3);
      expect(logs[0].id).toBe("2026-07-01T00:00:00.000Z");
      // A line that does not parse still arrives, and carries no resume id.
      expect(logs[2].id).toBeUndefined();
    });
  });

  test("a reconnect with last-event-id does not replay what the client has", async () => {
    await withLog(lines, async (logPath) => {
      const events: Array<{ event: string; id?: string }> = [];
      const controller = new AbortController();
      const producer = createLogEventProducer({ logPath, pollMs: 5 });
      await producer.start((event) => {
        events.push(event);
        if (event.event === "log-backfill-complete") controller.abort();
      }, controller.signal, "2026-07-01T00:00:00.000Z");
      const logs = events.filter((e) => e.event === "log");
      expect(logs.map((l) => l.id)).toEqual(["2026-07-01T00:00:01.000Z", undefined]);
    });
  });
});

describe("the server's idle timeout against the heartbeat", () => {
  test("a stream survives a heartbeat interval — and a MISSED one", () => {
    // The bug this pins: Bun.serve's idleTimeout defaulted to 10s while the
    // heartbeat is 15s, so an SSE stream — idle BY DESIGN between heartbeats —
    // was closed by the server ~12s in, every time. The client reconnected a
    // second later and the console flashed "Reconnecting the live feed" on a
    // 12-second loop against a completely healthy fortress. Measured in a
    // browser: nine banner transitions in 45 seconds.
    expect(EVENTS_IDLE_TIMEOUT_S * 1000).toBeGreaterThan(EVENTS_HEARTBEAT_MS);
    // Two full heartbeats, so ONE lost heartbeat does not close a live stream.
    expect(EVENTS_IDLE_TIMEOUT_S * 1000).toBeGreaterThan(EVENTS_HEARTBEAT_MS * 2);
    // Bun refuses anything above 255 seconds.
    expect(EVENTS_IDLE_TIMEOUT_S).toBeLessThanOrEqual(255);
  });

  test("it is DERIVED from the heartbeat, and the server actually applies it", async () => {
    // A heartbeat raised without this constant following it would reintroduce
    // the loop, so the relationship is asserted over the source itself — and so
    // is the one line that makes it reach Bun.
    const events = await Bun.file(new URL("../src/ui/events.ts", import.meta.url)).text();
    expect(events).toMatch(/EVENTS_IDLE_TIMEOUT_S\s*=\s*Math\.min\(255,[\s\S]{0,120}EVENTS_HEARTBEAT_MS/);
    const server = await Bun.file(new URL("../src/ui/server.ts", import.meta.url)).text();
    expect(server).toMatch(/idleTimeout:\s*EVENTS_IDLE_TIMEOUT_S/);
  });
});
