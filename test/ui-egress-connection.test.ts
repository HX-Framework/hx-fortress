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
      expect(ids.indexOf("session-calls")).toBe(ids.indexOf("connection") + 1);
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
    // The page prints a gate after the words "authorized by".
    expect(found.gate).toBe(
      "this HX Fortress's enrolled credential, on a connection that this HX Fortress opens outbound; " +
        "the control plane opens no connection to this host",
    );
  });

  test("with session content off and Agentic Sessions off, it carries four kinds and says which five it does not", () => {
    const found = row("connection", inputs({ sessions: "off", connection: { state: "off", counts: null } }));
    expect(found.carries).toBe(
      "4 of 9 kinds of message: the greeting; heartbeats; asks and their answers; release offers and their results",
    );
    expect(text(found)).toContain("Session content is off on this connection.");
    expect(text(found)).toContain("is refused by the connection itself, and each refusal is recorded.");
    expect(text(found)).toContain("A message over 256 KiB is dropped before it is parsed.");
    expect(text(found)).toContain(
      "Not carried now: the member list; counts of sessions, and that a session changed; questions this HX Fortress asks; " +
        "calls that read or write a session; calls of this HX Fortress's tools.",
    );
  });

  test("with session content off and Agentic Sessions on, the three kinds of Agentic Sessions travel", () => {
    const found = row("connection", inputs({ sessions: "on", connection: { state: "off", counts: null } }));
    expect(found.carries).toStartWith("7 of 9 kinds of message:");
    expect(text(found)).toContain("Not carried now: calls that read or write a session; calls of this HX Fortress's tools.");
    // The member list is one large frame, so the small cap does not hold here.
    expect(text(found)).not.toContain("256 KiB");
  });

  test("with session content off and Agentic Sessions not known, it does not say what Agentic Sessions decides", () => {
    const found = row("connection", inputs({ connection: { state: "off", counts: null } }));
    // Six kinds are known: the four that always travel are carried, the two of
    // session content are not. The three of Agentic Sessions are not claimed either way.
    expect(found.carries).toStartWith("7 of 9 kinds of message:");
    expect(text(found)).toContain("Not carried now: calls that read or write a session; calls of this HX Fortress's tools.");
    expect(text(found)).not.toContain("256 KiB");
  });

  test("with session content on, everything travels and every session call needs a grant", () => {
    const found = row("connection", inputs({ sessions: "on", connection: { state: "on", counts: null } }));
    expect(found.carries).toStartWith("9 of 9 kinds of message:");
    expect(text(found)).toContain("is served only with a grant signed by the control plane.");
    // The two calls that need none are named, so "every call" is not claimed.
    expect(text(found)).toContain("Two calls need no grant and read no session: `selfTest`, and the list of this HX Fortress's tools.");
    expect(text(found)).not.toContain("Not carried now");
    // The page does not know FORTRESS_MAX_FRAME_BYTES, so it states no size here.
    expect(text(found)).not.toContain("MiB");
  });

  test("with session content on and Agentic Sessions off, the three kinds of Agentic Sessions do not travel", () => {
    const found = row("connection", inputs({ sessions: "off", connection: { state: "on", counts: null } }));
    expect(found.carries).toStartWith("6 of 9 kinds of message:");
    expect(text(found)).toContain(
      "Not carried now: the member list; counts of sessions, and that a session changed; questions this HX Fortress asks.",
    );
  });

  test("where nobody chose, it says so, and names the variable that chooses", () => {
    const found = row("connection", inputs({ sessions: "off", connection: { state: "not_set", counts: null } }));
    expect(found.carries).toStartWith("9 of 9 kinds of message:");
    expect(text(found)).toContain("Nobody chose whether session content may travel on this connection");
    // Both ways to choose, and where the variable has to be set to be read.
    expect(text(found)).toContain("`connection.sessionContent` in config.json");
    expect(text(found)).toContain("FORTRESS_CONNECTION_SESSION_CONTENT in the daemon's own environment");
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
    expect(notes).toContain("Counted today, 2027-03-14 (a day in UTC), on this host, by the name of each message:");
    expect(notes).toContain("The greeting - enrolled in 1; enroll out 1");
    expect(notes).toContain("Heartbeats - heartbeatAck in 2880; heartbeat out 2880");
    expect(notes).toContain("Asks and their answers - moduleMessage in 12; moduleReply out 12");
    expect(notes).toContain("The member list - rosterSync in 0, refused 1");
    expect(notes).toContain("Calls that read or write a session - rpc in 0, refused 3; rpcError out 3");
    expect(notes).toContain(
      "Dropped without an answer - over the size limit 1, not readable as a message 0, a name this build does not know 2",
    );
  });

  test("says when nothing was counted today, and when the counts cannot be read", () => {
    expect(text(row("connection", inputs({ connection: { state: "off", counts: null } })))).toContain(
      "Nothing was counted on this connection today.",
    );
    expect(text(row("connection", inputs({ connection: { state: "off", counts: "unreadable" } })))).toContain(
      "The counts of this connection's messages are on this host and could not be read.",
    );
  });
});

describe("the row of session calls", () => {
  test("with session content off, nothing is served and the row says who refuses", () => {
    const found = row("session-calls", inputs({ sessions: "on", connection: { state: "off", counts: null } }));
    expect(found.carries).toBe(
      "nothing - session content is off on the connection, so the connection refuses each method below",
    );
    expect(text(found)).toContain("None of these methods is served, and each refusal is recorded.");
    // No grant is looked at, so the row does not say that one is.
    expect(found.gate).toBe("nothing: the connection refuses each of these calls before a grant is looked at");
    expect(text(found)).toContain("and the connection refuses those calls too.");
    expect(text(found)).not.toContain("listing the tools needs no grant");
    // Each method is still named, with what it would carry. What would
    // authorize it is left out: nothing is looked at.
    expect(found.notes).toContain("readChunkText (session bytes)");
    expect(found.notes).toContain("selfTest (control)");
    expect(text(found)).not.toContain("a capability grant");
    expect(text(found)).not.toContain("a grant from the control plane");
  });

  test("with session content on, it says a grant is needed on every call but the probe", () => {
    const found = row("session-calls", inputs({ sessions: "on", connection: { state: "on", counts: null } }));
    expect(found.gate).toBe(
      "a grant signed by the control plane and verified against the organization key, on every call but `selfTest`",
    );
    expect(found.carries).toContain("session bytes on four of these methods");
    expect(text(found)).toContain("except that listing the tools needs no grant");
  });

  test("the probe's own line does not say it needs a grant", () => {
    const found = row("session-calls", inputs({ sessions: "on", connection: { state: "on", counts: null } }));
    const probe = (found.notes ?? []).find((note) => note.startsWith("selfTest "));
    expect(probe).toBe(
      "selfTest (control) - no grant; writes, reads and deletes one throwaway probe object, and reads no session",
    );
  });

  test("where nobody chose, it does not claim that every call needs a grant", () => {
    for (const connection of [undefined, { state: "not_set" as const, counts: null }]) {
      const found = row("session-calls", inputs({ sessions: "on", ...(connection ? { connection } : {}) }));
      expect(found.gate).toContain("a call with no grant is served unless the daemon runs with FORTRESS_TUNNEL_GRANT_ENFORCE");
      expect(found.gate).not.toContain("on every call");
    }
  });

  test("says that this HX Fortress's tools are called over the same connection", () => {
    const found = row("session-calls", inputs({ sessions: "on" }));
    expect(text(found)).toContain("This HX Fortress's tools are called over the same connection (`mcpRpc`)");
    expect(text(found)).toContain("The answer of a tool is free text.");
  });
});
