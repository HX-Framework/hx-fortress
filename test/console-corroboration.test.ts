// Corroboration: the four states, and the traps each of them exists to avoid.

import { describe, expect, test } from "bun:test";

import {
  AWAITING_CORROBORATION_MS,
  COMMAND_OUTCOME_ACTION,
  commandOutcomeParams,
  commandResultDigest,
  corroborationOf,
  CORROBORATION_COPY,
  disputedCopy,
  parseCommandOutcome,
  parseCommandOutcomes,
  type CommandOutcomeRecord,
} from "../src/ui/corroboration";
import { handleReadRoute, READ_PATHS } from "../src/ui/read-routes";
import type { ConsoleReadPort } from "../src/ui/read-routes";

const NOW = new Date("2026-07-01T12:00:00.000Z");
const LONG_AGO = new Date(NOW.getTime() - 60_000).toISOString();
const JUST_NOW = new Date(NOW.getTime() - 1_000).toISOString();

function record(id: string, status: "done" | "failed" | "rejected", outcome: string | null, error: string | null = null): CommandOutcomeRecord {
  return { commandId: id, terminalStatus: status, resultDigest: commandResultDigest(status, outcome, error) };
}

describe("the match predicate", () => {
  test("matches on status AND payload digest, never on the id alone", () => {
    // The trap: under D7 the daemon writes its outcome record even when its
    // complete_command call was REFUSED because the row was already terminal.
    // An id-only match would render the attacker's payload as corroborated.
    const daemonSaid = record("cmd-1", "done", "rotated key kid-7");
    const verdict = corroborationOf({
      commandId: "cmd-1",
      status: "done",
      outcome: "rotated key kid-ATTACKER",
      error: null,
      completedAt: LONG_AGO,
      records: [daemonSaid],
      now: NOW,
    });
    expect(verdict.state).toBe("disputed");
    expect(verdict.records).toBe(1);
  });

  test("a differing terminal status disputes too", () => {
    const verdict = corroborationOf({
      commandId: "cmd-1",
      status: "done",
      outcome: null,
      error: null,
      completedAt: LONG_AGO,
      records: [record("cmd-1", "failed", null, "the executor refused")],
      now: NOW,
    });
    expect(verdict.state).toBe("disputed");
  });

  test("records for other commands are ignored", () => {
    const verdict = corroborationOf({
      commandId: "cmd-1",
      status: "done",
      outcome: "ok",
      error: null,
      completedAt: LONG_AGO,
      records: [record("cmd-2", "done", "ok")],
      now: NOW,
    });
    expect(verdict.state).toBe("reported-unconfirmed");
    expect(verdict.records).toBe(0);
  });

  test("the digest cannot be collided by moving bytes between outcome and error", () => {
    expect(commandResultDigest("done", "ab", "c")).not.toBe(commandResultDigest("done", "a", "bc"));
  });
});

describe("the four states", () => {
  test("CONFIRMED when any record agrees", () => {
    const verdict = corroborationOf({
      commandId: "cmd-1",
      status: "done",
      outcome: "ok",
      error: null,
      completedAt: LONG_AGO,
      records: [record("cmd-1", "done", "ok")],
      now: NOW,
    });
    expect(verdict.state).toBe("confirmed");
    expect(CORROBORATION_COPY.confirmed).toContain("own record matches");
  });

  test("AWAITING inside the bound, neutral", () => {
    const verdict = corroborationOf({
      commandId: "cmd-1",
      status: "done",
      outcome: "ok",
      error: null,
      completedAt: JUST_NOW,
      records: [],
      now: NOW,
    });
    expect(verdict.state).toBe("awaiting");
    expect(CORROBORATION_COPY.awaiting).not.toContain("unconfirmed");
    expect(AWAITING_CORROBORATION_MS).toBe(5_000);
  });

  test("REPORTED (UNCONFIRMED) past the bound with no record, and it never reads as success", () => {
    const verdict = corroborationOf({
      commandId: "cmd-1",
      status: "done",
      outcome: "ok",
      error: null,
      completedAt: LONG_AGO,
      records: [],
      now: NOW,
    });
    expect(verdict.state).toBe("reported-unconfirmed");
    const copy = CORROBORATION_COPY["reported-unconfirmed"];
    expect(copy).toContain("reported (unconfirmed)");
    expect(copy).toContain("never confirmed");
    expect(copy).not.toMatch(/\bsucceeded\b/);
  });

  test("DISPUTED needs a disagreeing record AND the bound to have passed", () => {
    const args = {
      commandId: "cmd-1",
      status: "done" as const,
      outcome: "ok",
      error: null,
      records: [record("cmd-1", "done", "something else")],
      now: NOW,
    };
    expect(corroborationOf({ ...args, completedAt: JUST_NOW }).state).toBe("awaiting");
    expect(corroborationOf({ ...args, completedAt: LONG_AGO }).state).toBe("disputed");
  });

  test("a row with no completion timestamp is never accused", () => {
    const verdict = corroborationOf({
      commandId: "cmd-1",
      status: "done",
      outcome: "ok",
      error: null,
      completedAt: null,
      records: [record("cmd-1", "done", "different")],
      now: NOW,
    });
    expect(verdict.state).toBe("awaiting");
  });
});

describe("crash recovery is not tampering", () => {
  test("two records, one stale, reads CONFIRMED", () => {
    // Work done, crash before complete_command, boot re-drives and completes
    // with a second result. A single-record predicate would raise the tamper
    // alarm on an ordinary reboot.
    const stale = record("cmd-1", "failed", null, "interrupted");
    const fresh = record("cmd-1", "done", "rotated key kid-7");
    for (const records of [[stale, fresh], [fresh, stale]]) {
      const verdict = corroborationOf({
        commandId: "cmd-1",
        status: "done",
        outcome: "rotated key kid-7",
        error: null,
        completedAt: LONG_AGO,
        records,
        now: NOW,
      });
      expect(verdict.state).toBe("confirmed");
      expect(verdict.records).toBe(2);
    }
  });
});

describe("tail-first with fallback", () => {
  test("a command corroborated before the drain still reads CONFIRMED once its spool file is gone", () => {
    // The spool tail is empty - the file rotated and was reclaimed - and the
    // only surviving record is the drained one. A tail-only source would render
    // this as REPORTED (UNCONFIRMED), which is the state that means an adversary
    // fabricated an outcome: indistinguishable from the attack it signals.
    const tail: CommandOutcomeRecord[] = [];
    const drained = parseCommandOutcomes([
      {
        action: COMMAND_OUTCOME_ACTION,
        kind: "outcome",
        sessionRef: "cmd-old",
        params: commandOutcomeParams({
          commandKind: "rotate_credentials",
          status: "done",
          outcome: "rotated",
          error: null,
        }),
      },
    ]);
    const verdict = corroborationOf({
      commandId: "cmd-old",
      status: "done",
      outcome: "rotated",
      error: null,
      completedAt: LONG_AGO,
      records: [...tail, ...drained],
      now: NOW,
    });
    expect(verdict.state).toBe("confirmed");
  });

  test("only genuine command-outcome records parse", () => {
    const good = {
      action: COMMAND_OUTCOME_ACTION,
      kind: "outcome",
      sessionRef: "cmd-1",
      params: commandOutcomeParams({ commandKind: "run_audit", status: "done", outcome: null, error: null }),
    };
    expect(parseCommandOutcome(good)).toMatchObject({ commandId: "cmd-1", terminalStatus: "done" });
    expect(parseCommandOutcome({ ...good, kind: "intent" })).toBeNull();
    expect(parseCommandOutcome({ ...good, action: "console.sign-in" })).toBeNull();
    expect(parseCommandOutcome({ ...good, sessionRef: null })).toBeNull();
    expect(parseCommandOutcome({ ...good, params: { terminalStatus: "done" } })).toBeNull();
    expect(parseCommandOutcome({ ...good, params: null })).toBeNull();
  });
});

describe("the DISPUTED copy", () => {
  test("names the command, the arm, the trail entry and the remediation", () => {
    const lines = disputedCopy({
      commandId: "cmd-1",
      commandKind: "rotate_credentials",
      arm: "fabricated",
      auditLink: "/ui/api/audit?action=console.command.outcome",
      externalPostgres: false,
    }).join("\n");
    expect(lines).toContain("cmd-1");
    expect(lines).toContain("rotate_credentials");
    expect(lines).toContain("recorded as a success");
    expect(lines).toContain("/ui/api/audit?action=console.command.outcome");
    expect(lines).toContain("rotate the hx_app_rw database credential");
    // The pointer has to RESOLVE: the section it names is a heading in that file.
    expect(lines).toContain('"Command outcomes are corroborated, not trusted" in SECURITY.md');
  });

  test("the denied arm reads differently", () => {
    const lines = disputedCopy({
      commandId: "cmd-2",
      commandKind: "run_migration",
      arm: "denied",
      auditLink: "/ui/api/audit",
      externalPostgres: false,
    }).join("\n");
    expect(lines).toContain("recorded as a failure or a refusal");
  });

  test("external Postgres adds the non-owning-role note", () => {
    const lines = disputedCopy({
      commandId: "cmd-3",
      commandKind: "self_test",
      arm: "fabricated",
      auditLink: "/ui/api/audit",
      externalPostgres: true,
    }).join("\n");
    expect(lines).toContain("external Postgres");
    expect(lines).toContain("non-owning role");
  });
});

describe("the commands endpoint", () => {
  function portWith(rows: Array<Record<string, unknown>>, records: CommandOutcomeRecord[], externalPostgres = false): ConsoleReadPort {
    return {
      commands: async () => ({ rows: rows as never, records, externalPostgres }),
    } as unknown as ConsoleReadPort;
  }

  async function read(port: ConsoleReadPort) {
    const res = await handleReadRoute(new Request(`http://console.local${READ_PATHS.commands}`), {
      port,
      audit: { async recordExport() {} },
      actor: "auditor",
      sessionId: "sess-1",
    });
    return (await res?.json()) as { commands: Array<{ corroboration: { state: string }; copy: string[]; id: string; kind: string }> };
  }

  test("an uncorroborated terminal row renders reported (unconfirmed)", async () => {
    const body = await read(
      portWith(
        [
          {
            id: "cmd-1",
            kind: "run_checkup",
            status: "done",
            requestedAt: LONG_AGO,
            requestedBy: "auditor",
            completedAt: LONG_AGO,
            outcome: "ok",
            error: null,
          },
        ],
        [],
      ),
    );
    expect(body.commands[0].corroboration.state).toBe("reported-unconfirmed");
    expect(body.commands[0].copy).toEqual([]);
  });

  test("a non-terminal row is neutral, never accused", async () => {
    const body = await read(
      portWith(
        [
          {
            id: "cmd-2",
            kind: "run_audit",
            status: "running",
            requestedAt: LONG_AGO,
            requestedBy: "auditor",
            completedAt: null,
            outcome: null,
            error: null,
          },
        ],
        [],
      ),
    );
    expect(body.commands[0].corroboration.state).toBe("awaiting");
  });

  test("a disputed row carries the full block, and the endpoint writes nothing", async () => {
    const body = await read(
      portWith(
        [
          {
            id: "cmd-3",
            kind: "rotate_credentials",
            status: "done",
            requestedAt: LONG_AGO,
            requestedBy: "auditor",
            completedAt: LONG_AGO,
            outcome: "rotated key kid-ATTACKER",
            error: null,
          },
        ],
        [record("cmd-3", "done", "rotated key kid-7")],
      ),
    );
    const row = body.commands[0];
    expect(row.corroboration.state).toBe("disputed");
    expect(row.copy.join("\n")).toContain("cmd-3");
    expect(row.copy.join("\n")).toContain("rotate_credentials");
    expect(row.copy.join("\n")).toContain("Audit trail entry:");
  });
});
