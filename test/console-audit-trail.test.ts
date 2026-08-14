// The audit trail end to end: what reaches the spool, what reaches the table,
// and the two things the drain is allowed to shout about.
//
// The fake database below is a real one in the only respect that matters here:
// it enforces UNIQUE (spool_file_id, seq) and answers ON CONFLICT DO NOTHING, so
// the idempotency and payload-compare tests exercise the behaviour rather than
// a mock of it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import { cliAuditAct, CliAudit, CLI_ACTOR } from "../src/cli-audit";
import { AUDIT_ACTIONS, MAX_ACTOR_CHARS, sanitizeParams } from "../src/console/audit-actions";
import {
  assertSpoolOwnership,
  AuditSpool,
  listSpoolFiles,
  overSpoolCap,
  readSpool,
  resolveIntent,
  spoolOwnershipRefusal,
  spoolUsage,
  userNameFromPasswd,
  type AuditRecord,
} from "../src/console/audit-spool";
import { DaemonAudit } from "../src/console/daemon-audit";
import { pollCommands, runBootFence, type CommandGateway, type CommandRow } from "../src/console/commands";
import { EntryContexts } from "../src/ui/sso-grant";
import { AuditDrain, payloadFingerprint, type DrainDb } from "../src/ui/audit-drain";
import { ConsoleAudit } from "../src/ui/audit-writer";
import { disabledWindowMarkers } from "../src/ui/audit-markers";
import { commandResultDigest } from "../src/ui/corroboration";
import { handleAuthRoute } from "../src/ui/auth-routes";
import { handleReadRoute, READ_AUDITED_PATHS, READ_PATHS, READ_ROUTES } from "../src/ui/read-routes";
import { PUBLIC_ROUTES } from "../src/ui/routes";
import { AUDIT_RETENTION_LINE } from "../src/ui/identity";
import { verifySessionResidency } from "../src/ui/residency-verify";

const dialect = new PgDialect();

interface AuditTableRow {
  id: string;
  spoolFileId: string;
  seq: number;
  ts: string;
  origin: string;
  actor: string | null;
  sessionRef: string | null;
  tier: string | null;
  action: string;
  params: unknown;
  kind: string;
  refFileId: string | null;
  refSeq: number | null;
  outcome: string | null;
  error: string | null;
}

interface CommandRecord {
  id: string;
  kind: string;
  status: string;
  requestedAt: string;
  requestedBy: string | null;
  completedAt: string | null;
  outcome: string | null;
  error: string | null;
}

/** hx.admin_audit and hx.console_commands, in memory, with the one constraint
 *  the drain's correctness rests on. */
class FakeDb implements DrainDb {
  readonly audit: AuditTableRow[] = [];
  readonly commands: CommandRecord[] = [];
  conflicts = 0;

  async execute(query: unknown): Promise<unknown> {
    const { sql: text, params } = dialect.sqlToQuery(query as SQL);
    if (text.includes("INSERT INTO")) return this.insert(params as unknown[]);
    if (text.includes("hx.console_commands")) return this.commands;
    if (text.includes("DISTINCT a.session_ref")) {
      const ids = new Set((params as string[]).slice(1));
      return this.audit
        .filter((r) => r.action === AUDIT_ACTIONS.commandDisputed && r.sessionRef && ids.has(r.sessionRef))
        .map((r) => ({ sessionRef: r.sessionRef }));
    }
    if (text.includes("a.kind = 'outcome'")) {
      const ids = new Set(params as string[]);
      return this.audit
        .filter((r) => r.kind === "outcome" && r.sessionRef && ids.has(r.sessionRef))
        .map((r) => ({ sessionRef: r.sessionRef, action: r.action, kind: r.kind, params: r.params }));
    }
    if (text.includes("a.spool_file_id =")) {
      const [fileId] = params as string[];
      return this.audit.filter((r) => r.spoolFileId === fileId);
    }
    return [];
  }

  private insert(params: readonly unknown[]): unknown[] {
    for (let i = 0; i < params.length; i += 14) {
      const row = params.slice(i, i + 14);
      const spoolFileId = String(row[0]);
      const seq = Number(row[1]);
      if (this.audit.some((r) => r.spoolFileId === spoolFileId && r.seq === seq)) {
        // ON CONFLICT DO NOTHING: the FIRST version stays, which is exactly why
        // the drain compares payloads instead of trusting the key.
        this.conflicts += 1;
        continue;
      }
      this.audit.push({
        id: `row-${this.audit.length + 1}`,
        spoolFileId,
        seq,
        ts: String(row[2]),
        origin: String(row[3]),
        actor: (row[4] ?? null) as string | null,
        sessionRef: (row[5] ?? null) as string | null,
        tier: (row[6] ?? null) as string | null,
        action: String(row[7]),
        params: row[8] === null ? null : JSON.parse(String(row[8])),
        kind: String(row[9]),
        refFileId: (row[10] ?? null) as string | null,
        refSeq: row[11] === null ? null : Number(row[11]),
        outcome: (row[12] ?? null) as string | null,
        error: (row[13] ?? null) as string | null,
      });
    }
    return [];
  }
}

let root = "";
let dir = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hx-trail-"));
  dir = path.join(root, "ui", "spool");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function consoleAudit(
  options: { now?: () => Date; ceiling?: number; exportCeiling?: number } = {},
  spoolOptions: { rotateBytes?: number } = {},
): {
  audit: ConsoleAudit;
  spool: AuditSpool;
} {
  const spool: AuditSpool = new AuditSpool({
    dir,
    writer: "ui",
    ...(options.now ? { clock: options.now } : {}),
    ...(spoolOptions.rotateBytes ? { rotateBytes: spoolOptions.rotateBytes } : {}),
    beforeRotate: (): Promise<void> => audit.flushFailures(true).then(() => undefined),
  });
  const audit: ConsoleAudit = new ConsoleAudit(spool, options);
  return { audit, spool };
}

function drainOf(db: FakeDb | null, audit: ConsoleAudit, now?: () => Date): AuditDrain {
  return new AuditDrain({
    dir,
    db: () => db,
    audit,
    ...(now ? { now } : {}),
    retentionMs: 60 * 60 * 1000,
    // A drain that swallowed its own failure would make every assertion below
    // pass for the wrong reason.
    onWarn: (message, fields) => {
      throw new Error(`${message}: ${JSON.stringify(fields)}`);
    },
  });
}

describe("the write-ahead order", () => {
  test("the intent is on disk before the mutation runs, and a crash leaves it alone", async () => {
    const audit = new CliAudit({ dir });
    const seenDuringWork: AuditRecord[] = [];
    await expect(
      audit.run(`${AUDIT_ACTIONS.cliPrefix}user_create`, { login: "erik" }, async () => {
        // The mutation is running: whatever is on disk now was written BEFORE it.
        seenDuringWork.push(...(await readSpool(dir)));
        throw new Error("the host died here");
      }),
    ).rejects.toThrow("the host died here");
    expect(seenDuringWork.map((r) => r.kind)).toEqual(["intent"]);
    expect(seenDuringWork[0].action).toBe("cli.ui.user_create");
    const after = await readSpool(dir);
    expect(after.map((r) => r.kind)).toEqual(["intent", "outcome"]);
    expect(after[1].error).toBe("the host died here");
  });

  test("a crash between the halves leaves an intent nothing answers", async () => {
    const spool = new AuditSpool({ dir, writer: "cli" });
    await spool.intent("cli.ui.user_delete", { actor: CLI_ACTOR, params: { login: "erik" } });
    const records = await readSpool(dir);
    expect(records).toHaveLength(1);
    expect(records[0].kind).toBe("intent");
    expect(resolveIntent({ fileId: records[0].fileId, refFileId: null, refSeq: null }, records)).toBeNull();
  });

  test("an outcome resolves its intent ACROSS a rotation", async () => {
    // The straddle: a long mutation outlives the file its intent went into. seq
    // restarts in the new file, so the file id is what makes the pair resolvable
    // at all - and rotation is never blocked waiting for the mutation.
    const spool = new AuditSpool({ dir, writer: "ui" });
    const intent = await spool.intent("console.rotate_credentials", { sessionRef: "cmd-1" });
    await spool.rotate();
    const outcome = await spool.outcome(intent, "done");
    expect(outcome.fileId).not.toBe(intent.fileId);
    expect(outcome.seq).toBe(1);
    expect(outcome.refFileId).toBe(intent.fileId);
    const files = await listSpoolFiles(dir);
    expect(files).toHaveLength(2);
    const all = await readSpool(dir);
    expect(resolveIntent(outcome, all)?.seq).toBe(intent.seq);
    // The trap the file id closes: the new file's own record 1 is the outcome
    // itself, so a seq-only reference would resolve to the wrong record.
    expect(resolveIntent({ fileId: outcome.fileId, refFileId: null, refSeq: 1 }, all)).toBeNull();
  });
});

describe("the drain", () => {
  test("is idempotent, and re-draining the same file inserts nothing twice", async () => {
    const { audit } = consoleAudit();
    const db = new FakeDb();
    await audit.signIn({ login: "erik", role: "operator", remoteKey: "10.0.0.1" });
    const drain = drainOf(db, audit);
    const first = await drain.run();
    expect(first.inserted).toBe(1);
    const second = await drain.run();
    expect(second.inserted).toBe(0);
    expect(db.audit).toHaveLength(1);
    expect(db.conflicts).toBe(0);
  });

  test("a rewritten record is a LOUD integrity error, not a silent no-op", async () => {
    const { audit } = consoleAudit();
    const db = new FakeDb();
    await audit.signIn({ login: "erik", role: "operator", remoteKey: "10.0.0.1" });
    const drain = drainOf(db, audit);
    await drain.run();

    // Somebody edits the file under the console. ON CONFLICT DO NOTHING would
    // keep the drained version and say nothing at all.
    const [file] = await listSpoolFiles(dir);
    const lines = (await readFile(file.path, "utf8")).trim().split("\n");
    const tampered = JSON.parse(lines[0]) as AuditRecord;
    tampered.actor = "someone-else";
    await writeFile(file.path, `${JSON.stringify(tampered)}\n`);

    const second = await drain.run();
    expect(second.mismatches).toBe(1);
    await drain.run();
    const errors = db.audit.filter((r) => r.action === AUDIT_ACTIONS.integrityError);
    // Raised once, not once per tick for as long as the file survives.
    expect(errors).toHaveLength(1);
    expect(errors[0].params).toMatchObject({ seq: 1 });
  });

  test("fires only on a genuine payload difference", async () => {
    const record = {
      ts: "2026-07-31T12:00:00.000Z",
      origin: "cli",
      actor: CLI_ACTOR,
      sessionRef: null,
      tier: null,
      action: "cli.ui.user_create",
      params: { login: "erik", role: "operator" },
      kind: "intent",
      refFileId: null,
      refSeq: null,
      outcome: null,
      error: null,
    };
    // The two differences a driver introduces on the way back: a Date instead of
    // a string, and jsonb key order. Neither is a difference in what was
    // recorded, and treating either as one would raise a tamper alarm on every
    // ordinary re-drain.
    const roundTripped = {
      ...record,
      ts: new Date(record.ts),
      params: { role: "operator", login: "erik" },
      refSeq: null,
    };
    expect(payloadFingerprint(roundTripped)).toBe(payloadFingerprint(record));
    expect(payloadFingerprint({ ...record, actor: "mallory" })).not.toBe(payloadFingerprint(record));

    // The THIRD difference, and the one that actually shipped: this driver hands
    // `jsonb` back as raw JSON TEXT, not as an object. Fingerprinted directly,
    // every drained record disagreed with its own spooled twin — one
    // integrity_error per record per drain, each accusing the operator's disk of
    // having been altered. A fortress holding 35 sessions had 83,397 audit rows,
    // 83,388 of them that false alarm, 45 MB of database, still climbing.
    const asText = { ...record, ts: new Date(record.ts), params: '{"role":"operator","login":"erik"}' };
    expect(payloadFingerprint(asText)).toBe(payloadFingerprint(record));
    // …and it is still a VALUE comparison: different params must still differ.
    const otherText = { ...record, params: '{"role":"readonly","login":"erik"}' };
    expect(payloadFingerprint(otherText)).not.toBe(payloadFingerprint(record));
    // Text that is not JSON compares as itself rather than throwing.
    expect(payloadFingerprint({ ...record, params: "{ not json" })).not.toBe(payloadFingerprint(record));
  });

  test("records written while Postgres is down drain when it comes back", async () => {
    const { audit } = consoleAudit();
    await audit.signIn({ login: "erik", role: "operator", remoteKey: "10.0.0.1" });
    const down = drainOf(null, audit);
    expect((await down.run()).drained).toBe(false);
    // Nothing was lost: the spool still holds it.
    expect(await readSpool(dir)).toHaveLength(1);
    const db = new FakeDb();
    expect((await drainOf(db, audit).run()).inserted).toBe(1);
  });
});

describe("what the pre-login door says back", () => {
  test("a failed setup completion says one sentence, never the exception's", async () => {
    const { audit } = consoleAudit();
    const runtime = {
      readConfig: async () => ({ marker: null, sessionTtlHours: 12, sessionIdleMinutes: 60 }),
      completeSetup: async () => {
        // What a corrupt store throws: its own path on disk, to a caller
        // holding nothing but a setup token that did not work.
        throw new Error("users.json is corrupt at /srv/fortress/ui/users.json");
      },
      entries: new EntryContexts(),
    };
    const res = await handleAuthRoute(
      new Request("http://console.local/ui/api/setup/complete", {
        method: "POST",
        headers: { "x-setup-token": "nope" },
        body: JSON.stringify({ password: "a-long-enough-password" }),
      }),
      { runtime: runtime as never, remoteKey: "10.0.0.1", remoteAddr: "10.0.0.1", audit },
    );
    expect(res?.status).toBe(400);
    const body = (await res?.json()) as { error: string };
    expect(body.error).toBe("this setup link is no longer valid");
    // Every reason this throws is the same answer to this caller; saying which
    // would enumerate, and the path is not theirs to learn.
    expect(JSON.stringify(body)).not.toContain("/srv/fortress");
  });
});

describe("what a record may name as its actor", () => {
  test("an actor beyond the bound is clamped where it is written", async () => {
    const spool = new AuditSpool({ dir, writer: "ui" });
    const written = await spool.append({
      action: AUDIT_ACTIONS.signInFailed,
      // The one field an anonymous caller influences. Clamped at the SPOOL, under
      // every caller, rather than only at the door it came through.
      actor: "A".repeat(200_000),
      sessionRef: null,
      tier: null,
      params: null,
      kind: "outcome",
      refFileId: null,
      refSeq: null,
      outcome: null,
      error: "1 failed attempt",
    });
    expect(written.actor?.length).toBe(MAX_ACTOR_CHARS + 1);
    const [onDisk] = (await readSpool(dir)).filter((r) => r.action === AUDIT_ACTIONS.signInFailed);
    expect(onDisk?.actor).toBe(written.actor);
  });
});

describe("who owns the signal", () => {
  test("starting the drain registers no process handler", () => {
    const { audit } = consoleAudit();
    const drain = drainOf(null, audit);
    const before = {
      term: process.listenerCount("SIGTERM"),
      int: process.listenerCount("SIGINT"),
    };
    drain.start(60_000);
    try {
      // A handler here is worse than none: under Bun a registered listener
      // SUPPRESSES the default termination, and this component cannot end the
      // process — so the console flushed its spool on SIGTERM and went on
      // serving the admin surface for the whole grace period, with the operator
      // already told it had stopped.
      expect({
        term: process.listenerCount("SIGTERM"),
        int: process.listenerCount("SIGINT"),
      }).toEqual(before);
    } finally {
      drain.stop();
    }
  });
});

describe("the same-uid spool", () => {
  test("refuses a writer that is not the owning user, by name", async () => {
    const owner = "fortress";
    expect(spoolOwnershipRefusal(owner)).toContain(`run as ${owner}`);
    // The refusal has to name a user, so the uid is resolved out of the passwd
    // file: there is no portable API for the name of a uid that is not mine.
    expect(userNameFromPasswd("root:x:0:0::/root:/bin/sh\nfortress:x:1001:1001::/srv:/bin/sh", 1001)).toBe(
      "fortress",
    );
    expect(userNameFromPasswd("root:x:0:0::/root:/bin/sh", 1001)).toBeNull();
  });

  test("a spool owned by this user is writable, and its modes are the stated ones", async () => {
    await assertSpoolOwnership(dir);
    const spool = new AuditSpool({ dir, writer: "cli" });
    await spool.intent("cli.ui.enable", { actor: CLI_ACTOR });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(spool.filePath)).mode & 0o777).toBe(0o600);
  });

  test("a spool under another user's directory is REFUSED, naming that user", async () => {
    // Root owns /proc on every Linux host, so this is the real refusal rather
    // than a mocked one. Skipped when the suite itself runs as root, where there
    // is no second uid to be refused as.
    if ((process.getuid?.() ?? 0) === 0) return;
    let refused: Error | null = null;
    await assertSpoolOwnership("/proc/hx-fortress-spool").catch((err: Error) => {
      refused = err;
    });
    expect((refused as unknown as Error | null)?.message ?? "").toContain("run as root");
  });

  test("the ownership check runs against the nearest existing ancestor", async () => {
    // A root CLI on a fortress whose spool directory does not exist yet would
    // otherwise create it root-owned and pass its own test.
    const absent = path.join(root, "ui", "spool", "deeper");
    await expect(assertSpoolOwnership(absent)).resolves.toBeUndefined();
  });
});

describe("terminal acts", () => {
  test("are recorded with origin=cli and the terminal actor, and drain", async () => {
    const audit = new CliAudit({ dir });
    await audit.run(`${AUDIT_ACTIONS.cliPrefix}user_create`, { login: "erik", role: "operator" }, async () => 0);
    const records = await readSpool(dir);
    expect(records.map((r) => r.origin)).toEqual(["cli", "cli"]);
    expect(records[0].actor).toBe("root operator (terminal)");
    expect(records[0].params).toEqual({ login: "erik", role: "operator" });

    const db = new FakeDb();
    const { audit: consoleSide } = consoleAudit();
    expect((await drainOf(db, consoleSide).run()).inserted).toBe(2);
    expect(db.audit[0].origin).toBe("cli");
    expect(db.audit[0].action).toBe("cli.ui.user_create");
  });

  test("every mutating verb is audited by default; only the two reads opt out", () => {
    expect(cliAuditAct(["config"])).toBeNull();
    expect(cliAuditAct(["user", "list"])).toBeNull();
    expect(cliAuditAct(["user", "create", "erik", "--role", "operator"])).toEqual({
      action: "cli.ui.user_create",
      params: { login: "erik", role: "operator" },
    });
    expect(cliAuditAct(["enable"])?.action).toBe(AUDIT_ACTIONS.cliEnable);
    expect(cliAuditAct(["disable"])?.action).toBe(AUDIT_ACTIONS.cliDisable);
    expect(cliAuditAct(["sso", "on"])?.action).toBe("cli.ui.sso_on");
    // A verb nobody enumerated is recorded, exactly as an unclassified route is
    // a mutation - and its name cannot be an arbitrary string.
    expect(cliAuditAct(["something-new"])?.action).toBe("cli.ui.something-new");
    expect(cliAuditAct(["../../etc/passwd"])?.action).toBe("cli.ui.unknown");
  });

  test("the DSN never reaches the record, even though the key does", () => {
    const act = cliAuditAct(["config", "set", "databaseUrl", "--stdin"]);
    expect(act?.params).toEqual({ key: "databaseUrl" });
    expect(cliAuditAct(["config", "set", "port", "8788"])?.params).toEqual({
      key: "port",
      value: "8788",
    });
  });

  test("secrets are dropped from params even when an action declares them", async () => {
    const spool = new AuditSpool({ dir, writer: "cli" });
    const record = await spool.intent("cli.ui.user_create", {
      actor: CLI_ACTOR,
      params: {
        login: "erik",
        password: "hunter2",
        token: "abc",
        value: "postgres://u:secret@db/x",
      },
    });
    expect(record.params).toEqual({ login: "erik", value: "postgres://u:[redacted]@db/x" });
  });

  test("stays inside the cap on a fortress whose console never runs, and says what it dropped", async () => {
    const caps = { maxFiles: 3, maxBytes: 4096 };
    for (let i = 0; i < 6; i += 1) {
      const audit = new CliAudit({ dir, caps });
      await audit.run(`${AUDIT_ACTIONS.cliPrefix}marker`, { phrase: `run ${i}` }, async () => 0);
    }
    const usage = await spoolUsage(dir);
    expect(overSpoolCap(usage, caps)).toBe(false);
    const records = await readSpool(dir);
    const reclaimed = records.filter((r) => r.action === AUDIT_ACTIONS.spoolReclaimed);
    // The loss is bounded AND it is in the trail: a reclaim nobody can see is
    // indistinguishable from a trail that was never written.
    expect(reclaimed.length).toBeGreaterThan(0);
    expect(reclaimed[0].params).toMatchObject({ files: expect.any(Number), records: expect.any(Number) });
    expect(reclaimed[0].error).toContain("before any console drained them");
  });

  test("a console-disabled window is derivable from the trail, pruning included", () => {
    const rows = [
      { ts: "2026-07-01T10:00:00.000Z", action: AUDIT_ACTIONS.cliDisable, origin: "cli", kind: "intent", params: null },
      { ts: "2026-07-01T10:05:00.000Z", action: "cli.ui.user_create", origin: "cli", kind: "intent", params: null },
      { ts: "2026-07-01T10:05:01.000Z", action: "cli.ui.user_create", origin: "cli", kind: "outcome", params: null },
      { ts: "2026-07-01T10:06:00.000Z", action: AUDIT_ACTIONS.spoolReclaimed, origin: "cli", kind: "outcome", params: { records: 12 } },
      { ts: "2026-07-01T11:00:00.000Z", action: AUDIT_ACTIONS.cliEnable, origin: "cli", kind: "intent", params: null },
    ];
    const [marker] = disabledWindowMarkers(rows);
    expect(marker.cliActs).toBe(1);
    expect(marker.pruned).toBe(12);
    expect(marker.text).toContain("1 CLI act recorded");
    expect(marker.text).toContain("12 pruned before drain");
  });
});

describe("public auth failures collapse; everything else does not", () => {
  test("N failures from M sources in one window are at most M+1 records", async () => {
    let clock = new Date("2026-07-01T12:00:00.000Z");
    const { audit } = consoleAudit({ now: () => clock });
    for (let i = 0; i < 40; i += 1) {
      audit.noteFailure(AUDIT_ACTIONS.signInFailed, { login: "erik", remoteKey: "10.0.0.1" });
      audit.noteFailure(AUDIT_ACTIONS.signInFailed, { login: "erik", remoteKey: "10.0.0.2" });
    }
    // Nothing is written until the window closes.
    expect(await readSpool(dir)).toEqual([]);
    clock = new Date(clock.getTime() + 6 * 60_000);
    const written = await audit.flushFailures();
    expect(written).toHaveLength(2);
    expect(written.length).toBeLessThanOrEqual(2 + 1);
  });

  test("the attempt count is the OBSERVED count, written once at window close", async () => {
    let clock = new Date("2026-07-01T12:00:00.000Z");
    const { audit } = consoleAudit({ now: () => clock });
    for (let i = 0; i < 17; i += 1) {
      audit.noteFailure(AUDIT_ACTIONS.signInFailed, { login: "erik", remoteKey: "10.0.0.1" });
      clock = new Date(clock.getTime() + 1_000);
    }
    clock = new Date(clock.getTime() + 6 * 60_000);
    const [record] = await audit.flushFailures();
    expect(record.params).toMatchObject({ attempts: 17, login: "erik", remote: "10.0.0.1" });
    // ONE record, never an amend and never a second under the same key: the
    // drain is ON CONFLICT DO NOTHING, so a corrected copy would be discarded in
    // silence and the table would keep the stale count.
    const onDisk = await readSpool(dir);
    expect(onDisk.filter((r) => r.action === AUDIT_ACTIONS.signInFailed)).toHaveLength(1);
  });

  test("a flood past the ceiling adds ONE marker, not a record per source", async () => {
    let clock = new Date("2026-07-01T12:00:00.000Z");
    const { audit } = consoleAudit({ now: () => clock, ceiling: 3 });
    for (let i = 0; i < 50; i += 1) {
      audit.noteFailure(AUDIT_ACTIONS.signInFailed, { login: "erik", remoteKey: `10.0.0.${i}` });
    }
    clock = new Date(clock.getTime() + 6 * 60_000);
    const written = await audit.flushFailures();
    expect(written.filter((r) => r.action === AUDIT_ACTIONS.authOverflow)).toHaveLength(1);
    expect(written).toHaveLength(4);
  });

  test("an attempt a rate bucket refused appends nothing at all", async () => {
    const runtime = {
      readConfig: async () => ({ marker: null, sessionTtlHours: 12, sessionIdleMinutes: 60 }),
      signIn: async () => ({ ok: false as const, status: 429 as const, reason: "too many attempts", retryAfterMs: 1000 }),
      entries: new EntryContexts(),
    };
    const { audit } = consoleAudit();
    const res = await handleAuthRoute(
      new Request("http://console.local/ui/api/session", {
        method: "POST",
        body: JSON.stringify({ login: "erik", password: "x" }),
      }),
      { runtime: runtime as never, remoteKey: "10.0.0.1", remoteAddr: "10.0.0.1", audit },
    );
    expect(res?.status).toBe(429);
    expect(audit.openWindows).toBe(0);
    await audit.flushFailures(true);
    expect(await readSpool(dir)).toEqual([]);
  });

  test("crossing the size bound with an OPEN window does not deadlock the spool", async () => {
    // The trap: production wires beforeRotate to flushFailures, which APPENDS.
    // Rotating from inside appendOne made that append wait on `tail` - the very
    // call that was rotating - so the chain never settled and every later
    // mutation on the admin plane (stop/start, rotate, submit, sign-in) hung
    // silently until restart. Rotation therefore happens BETWEEN records.
    const { audit } = consoleAudit({}, { rotateBytes: 400 });
    audit.noteFailure(AUDIT_ACTIONS.signInFailed, { login: "erik", remoteKey: "10.0.0.1" });
    expect(audit.openWindows).toBe(1);

    const deadline = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("DEADLOCK: the spool chain never settled")), 5_000),
    );
    for (let i = 0; i < 12; i += 1) {
      await Promise.race([
        audit.run(`${AUDIT_ACTIONS.servicePrefix}start`, { actor: null }, async () => undefined),
        deadline,
      ]);
    }
    // The flush really ran (the window is closed), and it landed in the retired
    // file rather than being lost.
    expect(audit.openWindows).toBe(0);
    const records = await readSpool(dir);
    expect(records.some((r) => r.action === AUDIT_ACTIONS.signInFailed)).toBe(true);
    expect((await listSpoolFiles(dir)).length).toBeGreaterThan(1);
  });

  test("the file AFTER a rotation gets the whole bound, not what the flush left", async () => {
    // `beforeRotate` appends, and its records belong to the file being retired
    // — whose byte count is already spent. Counting them against it re-armed the
    // rotation immediately, so every later file was retired after a record or
    // two and the spool filled the directory with stubs.
    const { audit, spool } = consoleAudit({}, { rotateBytes: 300 });
    for (let round = 0; round < 4; round += 1) {
      audit.noteFailure(AUDIT_ACTIONS.signInFailed, { login: "erik", remoteKey: `10.0.0.${round}` });
      await audit.run(`${AUDIT_ACTIONS.servicePrefix}start`, { actor: null }, async () => undefined);
      await audit.run(`${AUDIT_ACTIONS.servicePrefix}stop`, { actor: null }, async () => undefined);
    }
    await spool.rotate();
    const files = await listSpoolFiles(dir);
    expect(files.length).toBeGreaterThan(1);
    // Every retired file but the last carries a real load — no file is retired
    // after a single record.
    for (const file of files.slice(0, -1)) expect(file.bytes).toBeGreaterThan(300);
  });

  test("an open window is closed when the file rotates", async () => {
    const { audit, spool } = consoleAudit();
    audit.noteFailure(AUDIT_ACTIONS.signInFailed, { login: "erik", remoteKey: "10.0.0.1" });
    expect(audit.openWindows).toBe(1);
    await spool.rotate();
    expect(audit.openWindows).toBe(0);
    const records = await readSpool(dir);
    expect(records).toHaveLength(1);
    expect(records[0].action).toBe(AUDIT_ACTIONS.signInFailed);
  });
});

describe("an acknowledgement keeps its reason", () => {
  test("the reason survives sanitizeParams — it is the record's whole value", async () => {
    // The allowlist carried a `console.command.submit.acknowledge` key, and the
    // action a submission records is exactly `console.command.submit`, so the
    // longer key matched nothing and the reason was stripped from every
    // acknowledgement in the trail.
    const spool = new AuditSpool({ dir, writer: "ui" });
    await spool.intent(AUDIT_ACTIONS.commandSubmitted, {
      actor: "denis",
      params: {
        commandKind: "acknowledge_finding",
        org: "org-1",
        sessionId: "sess-1",
        reason: "pre-fortress history, signed off by the DPO",
      },
    });
    const [record] = await readSpool(dir);
    expect(record.params).toMatchObject({
      commandKind: "acknowledge_finding",
      org: "org-1",
      sessionId: "sess-1",
      reason: "pre-fortress history, signed off by the DPO",
    });
  });
});

describe("the audited routes", () => {
  test("the four public auth routes are marked audited and nothing else is", () => {
    const audited = PUBLIC_ROUTES.filter((r) => r.audited).map((r) => `${r.method} ${r.path}`);
    expect(audited).toEqual([
      "POST /ui/api/session",
      "POST /ui/api/sso/exchange",
      "GET /ui/api/setup/status",
      "POST /ui/api/setup/complete",
    ]);
    // The shell, the hashed assets, /healthz and the probe carry no principal.
    expect(PUBLIC_ROUTES.filter((r) => !r.audited).map((r) => r.path)).toEqual([
      "/",
      "/assets/",
      "/fonts/",
      "/healthz",
      "/ui/api/instance",
    ]);
  });

  test("a successful sign-in, a sign-out and a setup completion each leave a record", async () => {
    const { audit } = consoleAudit();
    const session = { id: "sess-1", userLogin: "erik", role: "operator" as const, workbenchSub: null, createdAt: Date.now() };
    const runtime = {
      readConfig: async () => ({ marker: null, sessionTtlHours: 12, sessionIdleMinutes: 60 }),
      signIn: async () => ({ ok: true as const, token: "t", session }),
      readUsers: async () => ({ users: [] }),
      sessions: { validate: () => ({ ok: true as const, session }), revoke: () => {} },
      completeSetup: async () => ({ login: "erik", role: "operator" }),
      entries: new EntryContexts(),
    };
    const ctx = { runtime: runtime as never, remoteKey: "10.0.0.1", remoteAddr: "10.0.0.1", audit };
    await handleAuthRoute(
      new Request("http://console.local/ui/api/session", {
        method: "POST",
        // A login that could name an account: one that could not is refused at
        // the door, before anything is written down.
        body: JSON.stringify({ login: "erik", password: "a-long-enough-password" }),
      }),
      ctx,
    );
    await handleAuthRoute(
      new Request("http://console.local/ui/api/session", { method: "DELETE" }),
      ctx,
    );
    await handleAuthRoute(
      new Request("http://console.local/ui/api/setup/complete", {
        method: "POST",
        body: JSON.stringify({ password: "a-long-enough-password" }),
      }),
      ctx,
    );
    const actions = (await readSpool(dir)).map((r) => r.action);
    expect(actions).toEqual([AUDIT_ACTIONS.signIn, AUDIT_ACTIONS.signOut, AUDIT_ACTIONS.setupCompleted]);
  });

  test("the five exports are the read-audited set, and each drains with its own params", async () => {
    const { audit } = consoleAudit();
    const db = new FakeDb();
    for (const [what, params] of [
      ["report payload", { format: "json" }],
      ["report PDF", { format: "pdf" }],
      ["logs export", { lines: 500 }],
      ["audit export", { from: "2026-07-01T00:00:00.000Z", to: "2026-07-02T00:00:00.000Z" }],
      ["proof-copy ack", { session: "s-1" }],
    ] as const) {
      await audit.recordExport({ what, actor: "erik", sessionRef: "sess-1", params });
    }
    await drainOf(db, audit).run();
    const exports = db.audit.filter((r) => r.action.startsWith(AUDIT_ACTIONS.exportPrefix));
    expect(exports).toHaveLength(5);
    expect(exports.map((r) => r.action)).toEqual([
      "console.export.report_payload",
      "console.export.report_PDF",
      "console.export.logs_export",
      "console.export.audit_export",
      "console.export.proof-copy_ack",
    ]);
    // Never collapsed: the parameters ARE the answer to which copy left.
    expect(exports[3].params).toMatchObject({ from: "2026-07-01T00:00:00.000Z" });
    expect(exports[2].params).toMatchObject({ lines: 500 });
  });

  test("past the per-session/day ceiling there is ONE marker", async () => {
    const { audit } = consoleAudit({ exportCeiling: 3 });
    for (let i = 0; i < 9; i += 1) {
      await audit.recordExport({ what: "report payload", actor: "erik", sessionRef: "sess-1", params: {} });
    }
    const records = await readSpool(dir);
    expect(records.filter((r) => r.action === "console.export.report_payload")).toHaveLength(3);
    expect(records.filter((r) => r.action === AUDIT_ACTIONS.exportOverflow)).toHaveLength(1);
  });

  test("N reads of the audit and spool panels record NOTHING", async () => {
    const { audit } = consoleAudit();
    const port = {
      audit: async () => ({ rows: [] }),
      spoolTail: async () => [],
    };
    for (let i = 0; i < 25; i += 1) {
      await handleReadRoute(new Request(`http://console.local${READ_PATHS.audit}`), {
        port: port as never,
        audit,
        actor: "erik",
        sessionId: "sess-1",
      });
      await handleReadRoute(new Request(`http://console.local${READ_PATHS.spool}`), {
        port: port as never,
        audit,
        actor: "erik",
        sessionId: "sess-1",
      });
    }
    // A self-auditing panel on a poll would grow a table nothing deletes.
    expect(await readSpool(dir)).toEqual([]);
  });

  test("the full-range audit export DOES record, with its range", async () => {
    const { audit } = consoleAudit();
    const port = { auditExport: async () => ({ rows: [], truncated: false }) };
    const res = await handleReadRoute(
      new Request(
        `http://console.local${READ_AUDITED_PATHS.auditExport}?from=2026-01-01&to=2026-07-01`,
      ),
      { port: port as never, audit, actor: "erik", sessionId: "sess-1" },
    );
    expect(res?.status).toBe(200);
    const records = await readSpool(dir);
    expect(records).toHaveLength(1);
    expect(records[0].action).toBe("console.export.audit_export");
    expect(records[0].params).toEqual({ from: "2026-01-01", to: "2026-07-01" });
  });

  test("the read-audited set is exactly five routes", () => {
    const audited = READ_ROUTES.filter((r) => r.cls === "read-audited").map((r) => r.path);
    expect(audited).toEqual(Object.values(READ_AUDITED_PATHS));
    expect(audited).toHaveLength(5);
  });
});

// ── the daemon side ─────────────────────────────────────────────────────────

function fakeGateway(rows: CommandRow[], options: { refuseComplete?: boolean } = {}): CommandGateway & {
  rows: CommandRow[];
} {
  return {
    rows,
    listOpen: async () => rows.filter((r) => r.status === "requested" || r.status === "running"),
    claim: async (id) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return false;
      row.status = "running";
      return true;
    },
    complete: async (id, status) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return false;
      // The adversary arm: the row is already terminal, so the routine refuses -
      // and the daemon records what it did anyway.
      if (options.refuseComplete) return false;
      row.status = status;
      return true;
    },
    reject: async (id) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return false;
      row.status = "rejected";
      return true;
    },
  };
}

function commandRow(over: Partial<CommandRow> = {}): CommandRow {
  return {
    id: "cmd-1",
    kind: "self_test",
    params: {},
    status: "requested",
    requestedAt: new Date(Date.now() - 1000),
    deadlineAt: null,
    credentialRef: null,
    ...over,
  };
}

function daemonDeps(gateway: CommandGateway, audit: DaemonAudit, outcome: string | null = "ok") {
  return {
    gateway,
    inFlightPath: path.join(root, "runtime", "commands-inflight.json"),
    claimedBy: "pid:boot",
    onTransition: audit.onTransition,
    executors: {
      self_test: async () => outcome,
      update_apply: async () => outcome,
      rotate_credentials: async () => outcome,
      ingest_pause: async () => outcome,
      ingest_resume: async () => outcome,
      service_restart: async () => outcome,
      run_checkup: async () => outcome,
      storage_migration: async () => outcome,
    } as never,
  };
}

describe("command outcomes are corroborated by records the daemon wrote", () => {
  test("every transition the daemon performs reaches the spool, claim first", async () => {
    const audit = new DaemonAudit({ dir, consoleEnabled: async () => true });
    const gateway = fakeGateway([commandRow()]);
    await pollCommands(daemonDeps(gateway, audit, "self test passed"));
    const records = await readSpool(dir);
    expect(records.map((r) => r.kind)).toEqual(["intent", "outcome"]);
    expect(records[0].sessionRef).toBe("cmd-1");
    expect(records[1].params).toMatchObject({
      terminalStatus: "done",
      resultDigest: commandResultDigest("done", "self test passed", null),
      accepted: true,
    });
    // The outcome points back at the claim, so a reader can see the pair.
    expect(records[1].refSeq).toBe(records[0].seq);
  });

  test("a terminal row fabricated in Postgres alone produces no record at all", async () => {
    // Nobody ran anything: the adversary called complete_command directly, and
    // the daemon has nothing to say about a command it never executed. The
    // console renders that as REPORTED (unconfirmed) - the absence IS the
    // signal, and calling it disputed would need a record that disagrees.
    const db = new FakeDb();
    db.commands.push({
      id: "cmd-9",
      kind: "rotate_credentials",
      status: "done",
      requestedAt: "2026-07-01T11:00:00.000Z",
      requestedBy: "erik",
      completedAt: "2026-07-01T11:00:05.000Z",
      outcome: "rotated",
      error: null,
    });
    const { audit: consoleSide } = consoleAudit();
    const drain = drainOf(db, consoleSide, () => new Date("2026-07-01T11:30:00.000Z"));
    expect((await drain.run()).disputed).toBe(0);
    expect(await readSpool(dir)).toEqual([]);
    expect(db.audit).toEqual([]);
  });

  test("the daemon records a transition its routine REFUSED, which is the tamper evidence", async () => {
    const audit = new DaemonAudit({ dir, consoleEnabled: async () => true });
    const gateway = fakeGateway([commandRow({ id: "cmd-2" })], { refuseComplete: true });
    await pollCommands(daemonDeps(gateway, audit, "the daemon's real result"));
    const records = await readSpool(dir);
    const outcome = records[records.length - 1];
    expect(outcome.params).toMatchObject({ accepted: false });
    expect(outcome.outcome).toBe("the daemon's real result");
  });

  test("adversary fabricates a success ⇒ DISPUTED; adversary denies one ⇒ DISPUTED", async () => {
    for (const arm of ["fabricated", "denied"] as const) {
      await rm(dir, { recursive: true, force: true });
      const audit = new DaemonAudit({ dir, consoleEnabled: async () => true });
      const gateway = fakeGateway([commandRow({ id: "cmd-3" })], { refuseComplete: true });
      await pollCommands(daemonDeps(gateway, audit, "the daemon's real result"));

      const db = new FakeDb();
      db.commands.push({
        id: "cmd-3",
        kind: "self_test",
        status: arm === "fabricated" ? "done" : "rejected",
        requestedAt: "2026-07-01T11:00:00.000Z",
        requestedBy: "erik",
        completedAt: "2026-07-01T11:00:05.000Z",
        outcome: arm === "fabricated" ? "an outcome nobody produced" : null,
        error: arm === "fabricated" ? null : "denied by the adversary",
      });
      const { audit: consoleSide } = consoleAudit();
      const drain = drainOf(db, consoleSide, () => new Date("2026-07-01T11:30:00.000Z"));
      expect((await drain.run()).disputed).toBe(1);
      // The record is durable the moment it is raised; it reaches the table on
      // the next pass, like everything else the console writes.
      await drain.run();
      const raised = db.audit.filter((r) => r.action === AUDIT_ACTIONS.commandDisputed);
      expect(raised).toHaveLength(1);
      expect(raised[0].params).toMatchObject({ arm });
    }
  });

  test("exactly ONE disputed record per command id, however often the drain runs", async () => {
    const daemon = new DaemonAudit({ dir, consoleEnabled: async () => true });
    const gateway = fakeGateway([commandRow({ id: "cmd-4" })], { refuseComplete: true });
    await pollCommands(daemonDeps(gateway, daemon, "what the daemon actually did"));
    const db = new FakeDb();
    db.commands.push({
      id: "cmd-4",
      kind: "self_test",
      status: "done",
      requestedAt: "2026-07-01T11:00:00.000Z",
      requestedBy: "erik",
      completedAt: "2026-07-01T11:00:05.000Z",
      outcome: "updated",
      error: null,
    });
    const { audit } = consoleAudit();
    const drain = drainOf(db, audit, () => new Date("2026-07-01T11:30:00.000Z"));
    await drain.run();
    await drain.run();
    await drain.run();
    expect(db.audit.filter((r) => r.action === AUDIT_ACTIONS.commandDisputed)).toHaveLength(1);
    // A second console process, with no memory of the first, reads the table.
    const fresh = drainOf(db, consoleAudit().audit, () => new Date("2026-07-01T11:30:00.000Z"));
    await fresh.run();
    expect(db.audit.filter((r) => r.action === AUDIT_ACTIONS.commandDisputed)).toHaveLength(1);
  });

  test("a crash-recovery re-drive produces TWO records and ZERO disputes", async () => {
    // The false alarm the ANY-MATCH rule exists to prevent: work done, crash
    // before complete, boot re-drive completes with a second result. A
    // record-at-a-time comparison would see the stale one and shout.
    const audit = new DaemonAudit({ dir, consoleEnabled: async () => true });
    const first = fakeGateway([commandRow({ id: "cmd-5" })], { refuseComplete: true });
    await pollCommands(daemonDeps(first, audit, "result from the attempt that crashed"));
    const second = fakeGateway([commandRow({ id: "cmd-5", status: "running" })]);
    await pollCommands(daemonDeps(second, audit, "result from the re-drive"), new Set(["cmd-5"]));

    const records = await readSpool(dir);
    expect(records.filter((r) => r.kind === "outcome")).toHaveLength(2);

    const db = new FakeDb();
    db.commands.push({
      id: "cmd-5",
      kind: "self_test",
      status: "done",
      requestedAt: "2026-07-01T11:00:00.000Z",
      requestedBy: "erik",
      completedAt: "2026-07-01T11:00:05.000Z",
      outcome: "result from the re-drive",
      error: null,
    });
    const { audit: consoleSide } = consoleAudit();
    const result = await drainOf(db, consoleSide, () => new Date("2026-07-01T11:30:00.000Z")).run();
    expect(result.disputed).toBe(0);
    expect(db.audit.filter((r) => r.action === AUDIT_ACTIONS.commandDisputed)).toHaveLength(0);
  });

  test("a command executed while the console was DISABLED still corroborates when it returns", async () => {
    // Ungated on purpose: a console_commands row existing already implies a
    // console, and a rotation performed after `ui disable` would otherwise
    // render forever as reported-but-unconfirmed - indistinguishable from the
    // fabrication arm.
    const audit = new DaemonAudit({ dir, consoleEnabled: async () => false });
    const gateway = fakeGateway([commandRow({ id: "cmd-6" })]);
    await pollCommands(daemonDeps(gateway, audit, "rotated"));
    expect((await readSpool(dir)).filter((r) => r.kind === "outcome")).toHaveLength(1);

    const db = new FakeDb();
    db.commands.push({
      id: "cmd-6",
      kind: "self_test",
      status: "done",
      requestedAt: "2026-07-01T11:00:00.000Z",
      requestedBy: "erik",
      completedAt: "2026-07-01T11:00:05.000Z",
      outcome: "rotated",
      error: null,
    });
    const { audit: consoleSide } = consoleAudit();
    const result = await drainOf(db, consoleSide, () => new Date("2026-07-01T11:30:00.000Z")).run();
    expect(result.disputed).toBe(0);
    expect(db.audit.some((r) => r.sessionRef === "cmd-6" && r.kind === "outcome")).toBe(true);
  });

  test("with the console disabled the daemon's GENERAL writer adds nothing", async () => {
    const audit = new DaemonAudit({ dir, consoleEnabled: async () => false });
    expect(await audit.record("system.artifact_replay", { params: { count: 3 } })).toBeNull();
    await audit.run("system.command_fence", { engine: "command fence" }, async () => 0);
    expect(await listSpoolFiles(dir)).toEqual([]);
  });

  test("with the console enabled an engine run drains as origin=system", async () => {
    const audit = new DaemonAudit({ dir, consoleEnabled: async () => true });
    const gateway = fakeGateway([commandRow({ id: "cmd-7", status: "requested" })]);
    await audit.run("system.command_fence", { engine: "command fence" }, async () =>
      runBootFence({ ...daemonDeps(gateway, audit), logger: undefined }),
    );
    const db = new FakeDb();
    const { audit: consoleSide } = consoleAudit();
    await drainOf(db, consoleSide).run();
    const fence = db.audit.filter((r) => r.action === "system.command_fence");
    expect(fence).toHaveLength(2);
    expect(fence.every((r) => r.origin === "system")).toBe(true);
    expect(fence[0].params).toEqual({ engine: "command fence" });
  });
});

describe("two writers, one spool", () => {
  test("a CLI act and a console act drain together, with zero conflicts", async () => {
    // Per-process files: neither writer holds a lock, neither can tear the
    // other's line, and (fileId, seq) keeps the drain's key unique across both.
    const cli = new CliAudit({ dir });
    const { audit } = consoleAudit();
    await Promise.all([
      cli.run(`${AUDIT_ACTIONS.cliPrefix}user_delete`, { login: "erik" }, async () => 0),
      audit.recordExport({ what: "report payload", actor: "dana", sessionRef: "sess-1", params: { format: "json" } }),
    ]);
    const files = await listSpoolFiles(dir);
    expect(files).toHaveLength(2);
    expect(new Set(files.map((f) => f.writer))).toEqual(new Set(["cli", "ui"]));

    const db = new FakeDb();
    const result = await drainOf(db, audit).run();
    expect(result.inserted).toBe(3);
    expect(db.conflicts).toBe(0);
    expect(new Set(db.audit.map((r) => r.origin))).toEqual(new Set(["cli", "console"]));
  });

  test("a terminal act on a console that has never run drains at the first boot", async () => {
    const { runUiVerb } = await import("../src/cli-ui-verbs");
    const lines: string[] = [];
    const deps = { writeLine: (line: string) => lines.push(line), env: {}, fortressRoot: root };
    await runUiVerb(["marker", "the fourth floor"], deps);
    // Enablement is false and no console is running: the act is still recorded,
    // which is the blind window this writer exists to close.
    const spooled = await readSpool(dir);
    expect(spooled.map((r) => r.action)).toEqual(["cli.ui.marker", "cli.ui.marker"]);
    expect(spooled[0].origin).toBe("cli");

    // The first console boot drains it.
    const db = new FakeDb();
    const { audit } = consoleAudit();
    expect((await drainOf(db, audit).run()).inserted).toBe(2);
    expect(db.audit[0].actor).toBe(CLI_ACTOR);
    expect(db.audit[0].params).toEqual({ phrase: "the fourth floor" });
  });

  test("a verb refused because the console is not serving is recorded as refused", async () => {
    const { runUiVerb } = await import("../src/cli-ui-verbs");
    const deps = { writeLine: () => {}, env: {}, fortressRoot: root };
    await expect(
      runUiVerb(["user", "create", "erik", "--role", "operator"], deps),
    ).rejects.toThrow();
    const spooled = await readSpool(dir);
    expect(spooled.map((r) => r.kind)).toEqual(["intent", "outcome"]);
    expect(spooled[0].params).toEqual({ login: "erik", role: "operator" });
    expect(spooled[1].outcome).toBe("failed");
  });
});

describe("the residency verdict matrix", () => {
  const base = { family: "claude-cli", sessionId: "s-1" };
  const row = { bytesUploaded: 1024, ingestChannel: "tunnel", lastActivityAt: null };

  test("healthy is only ever the row AND the object AND the size agreeing", () => {
    const result = verifySessionResidency({ ...base, row, canonicalBytes: 1024, stagingOrphans: 0 });
    expect(result.verdict).toBe("healthy");
    expect(result.checks.filter((c) => c.state === "passed")).toHaveLength(4);
  });

  test("missing, mismatch and orphan are three different facts", () => {
    expect(verifySessionResidency({ ...base, row, canonicalBytes: null }).verdict).toBe("missing");
    expect(verifySessionResidency({ ...base, row, canonicalBytes: 2048 }).verdict).toBe("mismatch");
    expect(verifySessionResidency({ ...base, row: null, canonicalBytes: 1024 }).verdict).toBe("orphan");
    expect(
      verifySessionResidency({ ...base, row, canonicalBytes: 1024, stagingOrphans: 3 }).verdict,
    ).toBe("orphan");
  });

  test("a check that could not run is never reported as one that passed", () => {
    const result = verifySessionResidency({ ...base, row, storeUnavailable: "the bucket did not answer" });
    expect(result.verdict).toBe("witness-unavailable");
    expect(result.checks.find((c) => c.name === "Transcript object")).toMatchObject({
      state: "not-checked",
      detail: "the bucket did not answer",
    });
    expect(result.proof.join("\n")).toContain("Transcript object: not checked");
  });

  test("every verdict says the cloud was not asked", () => {
    for (const input of [
      { ...base, row, canonicalBytes: 1024, stagingOrphans: 0 },
      { ...base, row, canonicalBytes: null },
      { ...base, row: null, canonicalBytes: 1024 },
      { ...base, row },
    ]) {
      const result = verifySessionResidency(input);
      // The attested arm belongs to the task that owns the witness. Silence here
      // would read as "asked, and found nothing".
      expect(result.checks.at(-1)).toMatchObject({ name: "let.ai copy", state: "not-checked" });
      expect(result.proof.join("\n")).toContain("let.ai was not asked");
    }
  });
});

describe("the console's own surfaces", () => {
  const spa = (file: string): string =>
    readFileSync(path.join(fileURLToPath(new URL("..", import.meta.url)), "ui", "src", file), "utf8");

  test("the audit panel is MOUNTED now, not merely written", () => {
    // It was built with the drain missing and deliberately left unmounted: a
    // panel that rendered an empty trail on a fortress that had been recording
    // all along is the one thing an audit surface must never do.
    const compliance = spa("views/Compliance.tsx");
    expect(compliance).toContain("AuditTrailPanel");
    expect(compliance).toMatch(/<AuditTrailPanel[^>]*\/>/);
  });

  test("it renders the server's retention truth and states no number of its own", () => {
    const panel = spa("views/AuditTrail.tsx");
    expect(panel).toContain("retention.auditTrail");
    expect(panel).not.toMatch(/\b\d+\s*-?\s*day\b/i);
    // Life-of-the-database, derived from the absence of a sweep.
    expect(AUDIT_RETENTION_LINE).toContain("retained for the life of the database");
    expect(AUDIT_RETENTION_LINE).toContain("no role holds DELETE");
  });

  test("with Postgres down it renders the spool tail under a degraded header", () => {
    const panel = spa("views/AuditTrail.tsx");
    expect(panel).toContain("api.spool");
    expect(panel).toContain("banner warn");
    expect(panel).toContain("write-ahead spool");
    // And the retention row is greyed, because it describes the drained trail.
    expect(panel).toContain("greyed because it describes the drained trail");
  });

  test("the verify dialog is on the session page and on Residency, and its copy is audited", () => {
    expect(spa("views/Sessions.tsx")).toContain("<VerifyResidencyPanel");
    expect(spa("views/Residency.tsx")).toContain("<VerifyResidencyPanel");
    const verify = spa("views/Verify.tsx");
    expect(verify).toContain("api.proofCopyAck");
    // The checks-performed text is the SERVER's, never invented in the tab.
    expect(verify).toContain("check.detail");
    expect(verify).toContain("check.state");
  });
});


describe("what a command submission is allowed to record", () => {
  test("the credential REFERENCE reaches the trail, because it is not the credential", () => {
    // D15's corroboration is two-sided or it is nothing: the daemon records
    // consuming a reference, and the console's submission record has to carry
    // the same id or the two cannot be tied together. The reference names a
    // 0600 file; the secret it points at never travels on the command.
    const out = sanitizeParams("console.command.submit", {
      commandKind: "rotate_credentials",
      credentialRef: "0123456789abcdef0123456789abcdef",
    });
    expect(out?.credentialRef).toBe("0123456789abcdef0123456789abcdef");
  });

  test("the secret-shaped belt still holds for everything else", () => {
    const out = sanitizeParams("console.command.submit", {
      commandKind: "rotate_credentials",
      // Neither is on the allowlist, and both are secret-shaped: two independent
      // reasons to drop them, and the carve-out above must not have loosened either.
      secret: "hunter2",
      apiKey: "sk-live-not-a-real-key",
    });
    expect(out?.secret).toBeUndefined();
    expect(out?.apiKey).toBeUndefined();
    expect(Object.keys(out ?? {})).toEqual(["commandKind"]);
  });
});
