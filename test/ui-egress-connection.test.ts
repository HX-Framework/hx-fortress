// The page of data paths: the row of the connection, and the row of session calls.
//
// Both are computed from what the running daemon published and counted. These
// tests give the page each state the connection can be in and read what a
// person is told.

import { describe, expect, test } from "bun:test";

import { connectionView, type ConnectionView } from "../src/cloud/counts";
import { MESSAGE_KINDS } from "../src/cloud/kinds";
import { UI_CONFIG_DEFAULTS } from "../src/ui/config";
import { dataPathRows, type DataPathRow, type EgressInputs } from "../src/ui/egress";

function inputs(overrides: Partial<EgressInputs> = {}): EgressInputs {
  return {
    ui: { ...UI_CONFIG_DEFAULTS, bind: "127.0.0.1", trustedProxies: [] },
    boundPort: 8788,
    postgres: { mode: "embedded", host: "127.0.0.1", port: 54329, database: "hx" },
    cloudUrl: "wss://control.example/v1/connection",
    downloadBase: "https://control.example/download",
    postgresBinariesUrl: "https://repo.example/binaries",
    bucket: null,
    embeddingEndpoint: null,
    ssoAdvertised: false,
    rosterRetentionDays: 90,
    ...overrides,
  };
}

const row = (id: string, given: EgressInputs): DataPathRow => {
  const found = dataPathRows(given).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
};
const text = (found: DataPathRow): string => [found.carries, found.gate, ...(found.notes ?? [])].join("\n");

const COUNTED: ConnectionView = connectionView("off", "2027-03-14", {
  in: { enrolled: 1, moduleMessage: 12, heartbeatAck: 2880 },
  out: { enroll: 1, moduleReply: 12, heartbeat: 2880, rpcError: 3 },
  refused: { rpc: 3, rosterSync: 1 },
  dropped: { too_large: 1, unreadable: 0, unknown: 2 },
});

describe("the row of the connection", () => {
  test("is on the page before the row of session calls, whatever the state", () => {
    for (const connection of [undefined, { state: null, counts: null }, { state: "off" as const, counts: COUNTED }]) {
      const ids = dataPathRows(inputs(connection ? { connection } : {})).map((found) => found.id);
      expect(ids.indexOf("connection")).toBeGreaterThan(-1);
      expect(ids.indexOf("connection-session-calls")).toBe(ids.indexOf("connection") + 1);
      expect(ids).not.toContain("relay-tunnel");
    }
  });

  test("names every kind of message the connection knows, with its frames and what it holds", () => {
    const found = row("connection", inputs({ sessions: "off", connection: { state: "off", counts: null } }));
    for (const kind of MESSAGE_KINDS) {
      expect(text(found)).toContain(kind.title);
      expect(text(found)).toContain(kind.holds);
      for (const frame of kind.in) expect(text(found)).toContain(`${frame} in`);
      for (const frame of kind.out) expect(text(found)).toContain(`${frame} out`);
    }
    expect(found.peer).toBe("wss://control.example/v1/connection");
    expect(found.gate).toContain("the control plane opens no connection to this host");
  });

  test("with session content off and Sessions off, it carries four kinds and says which five it does not", () => {
    const found = row("connection", inputs({ sessions: "off", connection: { state: "off", counts: null } }));
    expect(found.carries).toBe(
      "4 of 9 kinds of message: the greeting; heartbeats; asks and their answers; release offers and their results",
    );
    expect(text(found)).toContain("Session content is off on this connection.");
    expect(text(found)).toContain("No frame over 256 KiB is taken in.");
    expect(text(found)).toContain(
      "Not carried now: the member list; counts of sessions, and that a session changed; questions this fortress asks; " +
        "calls that read or write a session; calls of this fortress's tools.",
    );
  });

  test("with session content off and Sessions on, the three kinds of Sessions travel", () => {
    const found = row("connection", inputs({ sessions: "on", connection: { state: "off", counts: null } }));
    expect(found.carries).toStartWith("7 of 9 kinds of message:");
    expect(text(found)).toContain("Not carried now: calls that read or write a session; calls of this fortress's tools.");
  });

  test("with session content on, everything travels and every session call needs a grant", () => {
    const found = row("connection", inputs({ sessions: "on", connection: { state: "on", counts: null } }));
    expect(found.carries).toStartWith("9 of 9 kinds of message:");
    expect(text(found)).toContain("Every call that reads or writes a session must carry a grant");
    expect(text(found)).toContain("No frame over 32 MiB is taken in.");
    expect(text(found)).not.toContain("Not carried now");
  });

  test("where nobody chose, it says so, and names the variable that chooses", () => {
    const found = row("connection", inputs({ sessions: "off", connection: { state: "not_set", counts: null } }));
    expect(found.carries).toStartWith("9 of 9 kinds of message:");
    expect(text(found)).toContain("Nobody chose whether session content may travel on this connection");
    expect(text(found)).toContain("FORTRESS_CONNECTION_SESSION_CONTENT");
  });

  test("when the daemon has not said, it claims no state", () => {
    for (const given of [inputs(), inputs({ connection: { state: null, counts: null } })]) {
      const found = row("connection", given);
      expect(text(found)).toContain("The running daemon has not said whether session content may travel");
      expect(text(found)).not.toContain("Session content is off");
      expect(text(found)).not.toContain("Not carried now");
    }
  });

  test("shows the day's counts by the name of each message, and what was refused or dropped", () => {
    const found = row("connection", inputs({ sessions: "off", connection: { state: "off", counts: COUNTED } }));
    const notes = found.notes ?? [];
    expect(notes).toContain("Counted since 2027-03-14T00:00:00.000Z (UTC), on this host, by the name of each message:");
    expect(notes).toContain("The greeting - enrolled in 1; enroll out 1");
    expect(notes).toContain("Heartbeats - heartbeatAck in 2880; heartbeat out 2880");
    expect(notes).toContain("Asks and their answers - moduleMessage in 12; moduleReply out 12");
    expect(notes).toContain("The member list - rosterSync in 0, refused 1");
    expect(notes).toContain("Calls that read or write a session - rpc in 0, refused 3; rpcError out 3");
    expect(notes).toContain(
      "Dropped without an answer - over the cap 1, not readable as a message 0, a name this build does not know 2",
    );
  });

  test("says when nothing was counted yet, and when the counts cannot be read", () => {
    expect(text(row("connection", inputs({ connection: { state: "off", counts: null } })))).toContain(
      "Nothing was counted on this connection yet.",
    );
    expect(text(row("connection", inputs({ connection: { state: "off", counts: "unreadable" } })))).toContain(
      "The counts of this connection's messages are on this host and could not be read.",
    );
  });
});

describe("the row of session calls", () => {
  test("with session content off, nothing is served and the row says who refuses", () => {
    const found = row("connection-session-calls", inputs({ sessions: "on", connection: { state: "off", counts: null } }));
    expect(found.carries).toBe(
      "nothing - session content is off on the connection, so the connection refuses each method below",
    );
    expect(text(found)).toContain("None of these methods is served, and each refusal is recorded.");
  });

  test("with session content on, it says a grant is needed on every call", () => {
    const found = row("connection-session-calls", inputs({ sessions: "on", connection: { state: "on", counts: null } }));
    expect(found.gate).toBe("a grant on every call, signed by the control plane and verified against the organization key");
    expect(found.carries).toContain("session bytes on four of these methods");
  });

  test("where nobody chose, it does not claim that every call needs a grant", () => {
    for (const connection of [undefined, { state: "not_set" as const, counts: null }]) {
      const found = row("connection-session-calls", inputs({ sessions: "on", ...(connection ? { connection } : {}) }));
      expect(found.gate).toContain("a call with no grant is served unless the daemon runs with FORTRESS_TUNNEL_GRANT_ENFORCE");
      expect(found.gate).not.toContain("on every call");
    }
  });

  test("says that this fortress's tools are called over the same connection", () => {
    const found = row("connection-session-calls", inputs({ sessions: "on" }));
    expect(text(found)).toContain("This fortress's tools are called over the same connection (`mcpRpc`)");
    expect(text(found)).toContain("The answer of a tool is free text.");
  });
});
