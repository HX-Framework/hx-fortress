// The audit trail as the `host` module reads it, against a real Postgres.
//
// Everything the relay learns from `audit.read` and `audit.count` is assembled
// from two places — the spool on disk and `hx.admin_audit` — and the part that
// matters is that each record is counted once, whatever the drain has and has
// not moved. That is a property of SQL joined to file reads, so it is proved
// here against the real table rather than a stand-in.
//
// Gated like every DB-backed suite: FORTRESS_DATABASE_URL, one database per file.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";

import { AuditSpool, listSpoolFiles, readSpoolFile, type AuditRecord } from "../src/console/audit-spool";
import type { Organization } from "../src/host/organization-id";
import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { AuditTrail, TrailUnavailable } from "../src/modules/host/audit-trail";
import { drainInsertQuery, type DrainableRecord } from "../src/query/console/audit";
import { tempRoot, type Paths } from "./host/_module-rig";

const DSN = process.env.FORTRESS_DATABASE_URL;

/** The fortress's own organization: the one every test here read for, before a
 *  fortress could hold a second. Its id is never needed to read its records. */
const OWN: Organization = { id: "the-own-organization", own: true };

describe.skipIf(!DSN)("the audit trail over the spool and hx.admin_audit", () => {
  const dsn = DSN as string;
  let db: HxDb;
  let paths: Paths;
  let cleanup: () => Promise<void>;
  let trail: AuditTrail;
  /** Each test gets a day of its own, so nothing another test wrote is in range. */
  let day = 0;
  let range: { from: string; to: string };
  const at = (time: string): string => `${range.from.slice(0, 10)}T${time}Z`;

  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db = createHxDb(dsn);
    const root = await tempRoot();
    paths = root.paths;
    cleanup = root.cleanup;
    trail = new AuditTrail({ spoolDir: paths.auditSpool, db: () => db });
  });
  afterAll(async () => {
    await cleanup?.();
  });
  beforeEach(async () => {
    day += 1;
    // A year nobody else writes in, and a different one on every run, so a
    // database that is not fresh cannot put an old row into this test's day.
    const year = 2100 + Math.floor(Math.random() * 7000);
    const date = `${year}-${String(Math.floor(Math.random() * 12) + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    range = { from: `${date}T00:00:00.000Z`, to: `${date}T23:59:59.999Z` };
    // The spool directory is this suite's own: start each test with it empty.
    await rm(paths.auditSpool, { recursive: true, force: true });
  });

  /** Write records the way a process does, each at the time given. */
  async function spool(
    writer: "ui" | "cli" | "modules",
    write: (file: AuditSpool, clock: { now: string }) => Promise<void>,
    fileId: string = randomBytes(16).toString("hex"),
  ): Promise<string> {
    const clock = { now: at("09:00:00.000") };
    const file = new AuditSpool({ dir: paths.auditSpool, writer, fileId, clock: () => new Date(clock.now) });
    await write(file, clock);
    return fileId;
  }

  async function onDisk(): Promise<AuditRecord[]> {
    const records: AuditRecord[] = [];
    for (const file of await listSpoolFiles(paths.auditSpool)) records.push(...(await readSpoolFile(file.path)));
    return records;
  }

  /** What the console's drain does: copy records into the table. */
  async function drain(records: readonly AuditRecord[]): Promise<void> {
    if (records.length === 0) return;
    const rows: DrainableRecord[] = records.map((r) => ({
      fileId: r.fileId,
      seq: r.seq,
      ts: r.ts,
      origin: r.origin,
      actor: r.actor,
      sessionRef: r.sessionRef,
      tier: r.tier,
      action: r.action,
      params: r.params,
      kind: r.kind,
      refFileId: r.refFileId,
      refSeq: r.refSeq,
      outcome: r.outcome,
      error: r.error,
    }));
    await db.execute(drainInsertQuery(rows));
  }

  /** What the console does an hour after a file is drained: remove it. */
  async function removeFile(fileId: string): Promise<void> {
    for (const file of await listSpoolFiles(paths.auditSpool)) {
      if (file.fileId === fileId) await rm(file.path);
    }
  }

  const signIn = (file: AuditSpool, login: string) =>
    file.event("console.signin", { actor: login, params: { login }, outcome: "signed in" });

  const read = async (args: Partial<Parameters<AuditTrail["read"]>[0]> = {}) =>
    trail.read({ ...range, limit: 100, ...args }, OWN);

  test("each record is one line, wherever the drain has got to", async () => {
    // A: drained and removed. Only the table has it.
    const a = await spool("ui", async (file) => {
      await signIn(file, "a1");
      await signIn(file, "a2");
    });
    await drain(await onDisk());
    await removeFile(a);
    // B: drained and still on disk. Both have it.
    await spool("ui", async (file, clock) => {
      clock.now = at("10:00:00.000");
      await signIn(file, "b1");
      await signIn(file, "b2");
    });
    await drain(await onDisk());
    // C: half drained. The table has its first record, the disk has both.
    await spool("ui", async (file, clock) => {
      clock.now = at("11:00:00.000");
      await signIn(file, "c1");
      await drain(await onDisk());
      await signIn(file, "c2");
    });
    // D: never drained. Only the disk has it.
    await spool("ui", async (file, clock) => {
      clock.now = at("12:00:00.000");
      await signIn(file, "d1");
    });

    const { lines, next } = await read();
    expect(lines.map((line) => line.actor)).toEqual(["d1", "c2", "c1", "b2", "b1", "a2", "a1"]);
    expect(next).toBeUndefined();
    expect(await trail.count(range, OWN)).toMatchObject({ signIns: 7 });
  });

  test("a writer that appends after its drained file was removed is still counted once", async () => {
    // The console removes a file an hour after emptying it. A long-lived writer
    // then appends under the same file id, so the disk holds only the later
    // records and the table only the earlier ones.
    const id = randomBytes(16).toString("hex");
    const file = new AuditSpool({
      dir: paths.auditSpool,
      writer: "modules",
      fileId: id,
      clock: () => new Date(at("09:00:00.000")),
    });
    await file.event("relay.ask", { actor: "relay", params: { module: "host", ask: "status", rule: "grant_missing" }, outcome: "refused" });
    await file.event("relay.ask", { actor: "relay", params: { module: "host", ask: "status", rule: "grant_scope" }, outcome: "refused" });
    await drain(await onDisk());
    await removeFile(id);
    await file.event("relay.ask", { actor: "relay", params: { module: "host", ask: "status", rule: "grant_expired" }, outcome: "refused" });
    await file.event("relay.ask", { actor: "relay", params: { module: "host", ask: "status", rule: "grant_replayed" }, outcome: "refused" });
    // And the later two are drained as well, while still on disk.
    await drain(await onDisk());

    const { lines } = await read({ kind: "ask" });
    expect(lines).toHaveLength(4);
    expect(new Set(lines.map((line) => line.id)).size).toBe(4);
    expect(await trail.count(range, OWN)).toMatchObject({ asksRefused: 4, asksAllowed: 0 });
  });

  test("pages never repeat or skip a line, across both places and equal times", async () => {
    // Twelve records in the same millisecond, split between table and disk.
    const first = await spool("ui", async (file) => {
      for (let i = 0; i < 6; i += 1) await signIn(file, `t${i}`);
    });
    await drain(await onDisk());
    await removeFile(first);
    await spool("ui", async (file) => {
      for (let i = 0; i < 6; i += 1) await signIn(file, `d${i}`);
    });

    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await read({ limit: 5, ...(before ? { before } : {}) });
      expect(result.lines.length).toBeLessThanOrEqual(5);
      seen.push(...result.lines.map((line) => line.actor));
      before = result.next;
      if (!before) break;
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    // One full read gives the same order the pages gave.
    expect((await read()).lines.map((line) => line.actor)).toEqual(seen);
  });

  test("the kind of line is the same question in SQL and on disk", async () => {
    const actions = [
      "relay.ask",
      "relay.release.offer",
      "system.release.install",
      "cli.release.approve",
      "cli.module.on",
      "system.module.switch",
      "module.stores.job.started",
      "console.signin",
      "console.sso.exchange",
      "console.command.submit",
      "console.service.restart",
      "console.export.audit",
      "cli.update",
      "system.roster_purge",
    ];
    const write = async (file: AuditSpool): Promise<void> => {
      for (const action of actions) await file.event(action, { outcome: "done" });
    };
    const drained = await spool("ui", write);
    await drain(await onDisk());
    await removeFile(drained);
    const fromTable = Object.fromEntries(
      await Promise.all(
        (["ask", "release", "module", "sign_in", "command", "other"] as const).map(async (kind) => [
          kind,
          (await read({ kind })).lines.map((line) => line.action).sort(),
        ]),
      ),
    ) as Record<string, string[]>;
    expect(fromTable).toEqual({
      ask: ["relay.ask"],
      release: ["cli.release.approve", "relay.release.offer", "system.release.install"],
      module: ["cli.module.on", "module.stores.job.started", "system.module.switch"],
      sign_in: ["console.signin", "console.sso.exchange"],
      command: ["console.command.submit", "console.service.restart"],
      other: ["cli.update", "console.export.audit", "system.roster_purge"],
    });

    // The same records, read from disk instead: the same answer.
    await db.execute(`DELETE FROM hx.admin_audit WHERE spool_file_id = '${drained}'` as never).catch(() => {});
    await rm(paths.auditSpool, { recursive: true, force: true });
    await spool("ui", write);
    for (const [kind, expected] of Object.entries(fromTable)) {
      const lines = (await read({ kind: kind as "ask" })).lines.map((line) => line.action).sort();
      expect([kind, lines]).toEqual([kind, expected]);
    }
  });

  test("a line says what an act was done to, from the intent it answers", async () => {
    // A pair in one file, drained: the table joins the outcome to its intent.
    const paired = await spool("modules", async (file, clock) => {
      const intent = await file.intent("relay.ask", { actor: "relay", params: { module: "host", ask: "audit.read" } });
      clock.now = at("09:00:00.250");
      await file.outcome(intent, "ok");
    });
    await drain(await onDisk());
    await removeFile(paired);
    // A pair whose intent was drained and removed, and whose outcome is on disk.
    let straddling: AuditRecord | null = null;
    const older = await spool("modules", async (file, clock) => {
      clock.now = at("10:00:00.000");
      straddling = await file.intent("system.release.install", {
        params: { release: "rel-0123456789abcdef", module: "stores", version: "1.4.1" },
      });
    });
    await drain(await onDisk());
    await removeFile(older);
    await spool("modules", async (file, clock) => {
      clock.now = at("10:00:05.000");
      await file.outcome(straddling as AuditRecord, "installed");
    });
    // A pair wholly on disk.
    await spool("cli", async (file, clock) => {
      clock.now = at("11:00:00.000");
      const intent = await file.intent("cli.module.off", {
        actor: "root operator (terminal)",
        params: { module: "host", state: "off" },
      });
      await file.outcome(intent, "done");
    });

    const { lines } = await read();
    expect(lines.map((line) => [line.action, line.target, line.actorKind, line.outcome])).toEqual([
      ["cli.module.off", "host", "person", "ok"],
      ["system.release.install", "stores@1.4.1", "fortress", "ok"],
      ["relay.ask", "host:audit.read", "relay", "ok"],
    ]);
    // An intent nothing answered is not a line.
    await spool("modules", async (file, clock) => {
      clock.now = at("12:00:00.000");
      await file.intent("relay.ask", { actor: "relay", params: { module: "host", ask: "status" } });
    });
    expect((await read()).lines).toHaveLength(3);
    expect(await trail.count(range, OWN)).toMatchObject({ asksAllowed: 1, releasesInstalled: 1 });
  });

  test("counts weigh a collapsed run of refusals by what it stands for", async () => {
    const drained = await spool("modules", async (file) => {
      await file.event("relay.ask", { actor: "relay", params: { module: "host", ask: "status", rule: "grant_missing" }, outcome: "refused" });
      await file.event("relay.ask", {
        actor: "relay",
        params: { module: "host", ask: "status", rule: "grant_missing", attempts: 249 },
        outcome: "refused",
      });
      const intent = await file.intent("relay.ask", { actor: "relay", params: { module: "host", ask: "status" } });
      await file.outcome(intent, "ok");
      const failed = await file.intent("relay.ask", { actor: "relay", params: { module: "host", ask: "status" } });
      await file.outcome(failed, "failed", "timeout");
      const leaked = await file.intent("relay.ask", { actor: "relay", params: { module: "stores", ask: "x" } });
      await file.outcome(leaked, "refused", "reply_not_a_name at name");
    });
    const expected = { asksAllowed: 2, asksRefused: 251, releasesInstalled: 0, signIns: 0 };
    // On disk only.
    expect(await trail.count(range, OWN)).toEqual(expected);
    // In both.
    await drain(await onDisk());
    expect(await trail.count(range, OWN)).toEqual(expected);
    // In the table only.
    await removeFile(drained);
    expect(await trail.count(range, OWN)).toEqual(expected);
  });

  test("a row's parameters are read the same however the column holds them", async () => {
    // The drain writes the parameters as JSON text inside a jsonb string. A row
    // written as a jsonb object is the same parameters, and must count the same.
    const fileId = randomBytes(16).toString("hex");
    const objectRow = (seq: number, params: string, action = "relay.ask", outcome = "refused"): string =>
      `('${fileId}', ${seq}, '${at("09:00:00.000")}'::timestamptz, 'system', 'relay', '${action}', ` +
      `'${params}'::jsonb, 'outcome', '${outcome}')`;
    await db.execute(
      (`INSERT INTO hx.admin_audit (spool_file_id, seq, ts, origin, actor, action, params, kind, outcome) VALUES ` +
        [
          objectRow(1, '{"module":"host","ask":"status","rule":"grant_missing","attempts":40}'),
          objectRow(2, '{"module":"host","ask":"status","rule":"grant_missing"}'),
          // Not a whole number, not a number at all, and less than one: one each.
          objectRow(3, '{"module":"host","ask":"status","rule":"x","attempts":2.9}'),
          objectRow(4, '{"module":"host","ask":"status","rule":"x","attempts":"many"}'),
          objectRow(5, '{"module":"host","ask":"status","rule":"x","attempts":0}'),
        ].join(", ")) as never,
    );
    const stored = await db.execute(
      `SELECT jsonb_typeof(params) AS t FROM hx.admin_audit WHERE spool_file_id = '${fileId}' LIMIT 1` as never,
    );
    expect(JSON.stringify(stored)).toContain("object");
    // 40 + 1 + 2 + 1 + 1.
    expect(await trail.count(range, OWN)).toMatchObject({ asksRefused: 45 });
    const { lines } = await read({ kind: "ask" });
    expect(lines.map((line) => line.target)).toEqual(Array.from({ length: 5 }, () => "host:status"));

    // And as the drain writes it today.
    const drained = await spool("modules", async (file) => {
      await file.event("relay.ask", {
        actor: "relay",
        params: { module: "probe", ask: "unknown", rule: "grant_missing", attempts: 10 },
        outcome: "refused",
      });
    });
    await drain(await onDisk());
    await removeFile(drained);
    const text = await db.execute(
      `SELECT jsonb_typeof(params) AS t FROM hx.admin_audit WHERE spool_file_id = '${drained}'` as never,
    );
    expect(JSON.stringify(text)).toContain("string");
    expect(await trail.count(range, OWN)).toMatchObject({ asksRefused: 55 });
    expect((await read({ kind: "ask" })).lines.map((line) => line.target)).toContain("probe:unknown");
  });

  test("the period is held to, in both places", async () => {
    const drained = await spool("ui", async (file, clock) => {
      clock.now = range.from;
      await signIn(file, "first-instant");
      clock.now = range.to;
      await signIn(file, "last-instant");
      clock.now = new Date(Date.parse(range.to) + 1).toISOString();
      await signIn(file, "one-ms-late");
      clock.now = new Date(Date.parse(range.from) - 1).toISOString();
      await signIn(file, "one-ms-early");
    });
    const inRange = ["last-instant", "first-instant"];
    expect((await read()).lines.map((line) => line.actor)).toEqual(inRange);
    await drain(await onDisk());
    await removeFile(drained);
    expect((await read()).lines.map((line) => line.actor)).toEqual(inRange);
    expect(await trail.count(range, OWN)).toMatchObject({ signIns: 2 });
  });

  test("a line's time is the record's time, to the millisecond, from either place", async () => {
    const drained = await spool("ui", async (file, clock) => {
      clock.now = at("13:14:15.167");
      await signIn(file, "exact");
    });
    const fromDisk = (await read()).lines[0];
    await drain(await onDisk());
    await removeFile(drained);
    const fromTable = (await read()).lines[0];
    expect(fromDisk?.at).toBe(at("13:14:15.167"));
    expect(fromTable).toEqual(fromDisk);
  });

  // ── One organization at a time ─────────────────────────────────────────────
  //
  // A record of the fortress's own organization carries no organization. A
  // record of another one carries its id as `organization`: on a single event, and on
  // both halves of a pair. The trail is read one organization at a time, and
  // the answer may not depend on where the drain has got to.

  const ALDER = "alder-dental";
  const BIRCH = "birch-books";
  /** Another organization this fortress holds, by its id. */
  const held = (id: string): Organization => ({ id, own: false });

  /** What each organization is told, as plain values to compare. */
  async function told(organization: Organization) {
    const { lines } = await trail.read({ ...range, limit: 100 }, organization);
    return {
      lines: lines.map((line) => `${line.actor} ${line.action} ${line.target} ${line.outcome}`),
      counts: await trail.count(range, organization),
    };
  }

  test("each organization is told its own records and no other's, wherever the drain has got to", async () => {
    const fileId = await spool("modules", async (file, clock) => {
      // The fortress's own ask: nothing says whose.
      const own = await file.intent("relay.ask", { actor: "relay", params: { module: "host", ask: "status" } });
      await file.outcome(own, "ok");
      clock.now = at("09:00:01.000");
      // Alder's ask: both halves say whose.
      const alder = await file.intent("relay.ask", {
        actor: "relay",
        params: { module: "stores", ask: "tables.list" },
        organization: ALDER,
      });
      await file.outcome(alder, "ok");
      clock.now = at("09:00:02.000");
      // A run of refusals for Birch, as one record that stands for seven.
      await file.event("relay.ask", {
        actor: "relay",
        params: { module: "stores", ask: "tables.list", rule: "module_off", attempts: 7 },
        organization: BIRCH,
        outcome: "refused",
      });
      clock.now = at("09:00:03.000");
      // A module's own records.
      await file.event("module.stores.table.loaded", { params: { target: "orders" }, organization: ALDER, outcome: "done" });
      await file.event("module.stores.table.loaded", { params: { target: "invoices" }, outcome: "done" });
    });
    await spool("ui", async (file, clock) => {
      clock.now = at("09:00:04.000");
      await signIn(file, "marta");
    });

    const expected = {
      own: {
        lines: [
          "marta console.signin marta ok",
          "fortress module.stores.table.loaded invoices ok",
          "relay relay.ask host:status ok",
        ],
        counts: { asksAllowed: 1, asksRefused: 0, releasesInstalled: 0, signIns: 1 },
      },
      alder: {
        lines: ["fortress module.stores.table.loaded orders ok", "relay relay.ask stores:tables.list ok"],
        counts: { asksAllowed: 1, asksRefused: 0, releasesInstalled: 0, signIns: 0 },
      },
      birch: {
        lines: ["relay relay.ask stores:tables.list refused"],
        counts: { asksAllowed: 0, asksRefused: 7, releasesInstalled: 0, signIns: 0 },
      },
    };
    const all = async () => ({ own: await told(OWN), alder: await told(held(ALDER)), birch: await told(held(BIRCH)) });

    // On disk only.
    expect(await all()).toEqual(expected);
    // Drained, and still on disk: every record is in both places.
    await drain(await onDisk());
    expect(await all()).toEqual(expected);
    // Drained and removed: the table alone.
    for (const file of await listSpoolFiles(paths.auditSpool)) await rm(file.path);
    expect(await all()).toEqual(expected);
    // An organization nothing was written for is told nothing.
    expect(await told(held("cedar-labs"))).toEqual({
      lines: [],
      counts: { asksAllowed: 0, asksRefused: 0, releasesInstalled: 0, signIns: 0 },
    });
    expect(fileId).toBeString();
  });

  test("a row says whose it is the same however the column holds its parameters", async () => {
    // As a jsonb object, where the drain writes a jsonb string.
    const fileId = randomBytes(16).toString("hex");
    const row = (seq: number, params: string | null, kind: string, outcome: string | null, ref: number | null): string =>
      `('${fileId}', ${seq}, '${at("09:00:00.000")}'::timestamptz, 'system', 'relay', 'relay.ask', ` +
      `${params === null ? "NULL" : `'${params}'::jsonb`}, '${kind}', ${outcome === null ? "NULL" : `'${outcome}'`}, ` +
      `${ref === null ? "NULL" : ref})`;
    await db.execute(
      (`INSERT INTO hx.admin_audit (spool_file_id, seq, ts, origin, actor, action, params, kind, outcome, ref_seq) VALUES ` +
        [
          row(1, `{"module":"stores","ask":"tables.list","organization":"${ALDER}"}`, "intent", null, null),
          row(2, `{"organization":"${ALDER}"}`, "outcome", "ok", 1),
          row(3, '{"module":"host","ask":"status"}', "intent", null, null),
          row(4, null, "outcome", "ok", 3),
          // A value that is no organization's id, in three ways: not a string,
          // an empty string, and a null. Each is the fortress's own record.
          row(5, '{"module":"host","ask":"status","rule":"x","organization":7}', "outcome", "refused", null),
          row(6, '{"module":"host","ask":"status","rule":"y","organization":""}', "outcome", "refused", null),
          row(7, '{"module":"host","ask":"status","rule":"z","organization":null}', "outcome", "refused", null),
          // The console's own records carry an `org` that means something else.
          // It is not this mark, and the record stays the own organization's.
          row(8, `{"module":"host","ask":"status","rule":"w","org":"${ALDER}"}`, "outcome", "refused", null),
        ].join(", ")) as never,
    );
    expect(await told(held(ALDER))).toEqual({
      lines: ["relay relay.ask stores:tables.list ok"],
      counts: { asksAllowed: 1, asksRefused: 0, releasesInstalled: 0, signIns: 0 },
    });
    const own = await told(OWN);
    expect(own.lines).toEqual([
      ...Array.from({ length: 4 }, () => "relay relay.ask host:status refused"),
      "relay relay.ask host:status ok",
    ]);
    expect(own.counts).toEqual({ asksAllowed: 1, asksRefused: 4, releasesInstalled: 0, signIns: 0 });
    // And nobody else is told them, whatever id is tried.
    for (const id of ["7", "", "null"]) expect((await told(held(id))).lines).toEqual([]);
  });

  test("a row whose parameters Postgres will not take as jsonb breaks nobody's read", async () => {
    // What the drain stores: a jsonb STRING that holds the JSON text. Text that
    // jsonb rejects can be in there, because a person can type it into the
    // console: a zero character, or half of a two-part character where a long
    // value was cut. A statement that parsed these rows would fail for every
    // row of the period, and for good, because nothing is ever deleted here.
    const fileId = randomBytes(16).toString("hex");
    const text = (json: string): string => `to_jsonb('${json.replaceAll("'", "''")}'::text)`;
    const row = (seq: number, action: string, params: string, outcome: string): string =>
      `('${fileId}', ${seq}, '${at("09:00:00.000")}'::timestamptz, 'system', 'relay', '${action}', ` +
      `${params}, 'outcome', '${outcome}')`;
    await db.execute(
      (`INSERT INTO hx.admin_audit (spool_file_id, seq, ts, origin, actor, action, params, kind, outcome) VALUES ` +
        [
          row(1, "console.export.logs_export", text('{"actor":"\\u0000"}'), "ok"),
          row(2, "console.export.logs_export", text('{"actor":"aaa\\ud83d"}'), "ok"),
          // The same two, on rows the count has to weigh.
          row(3, "relay.ask", text('{"module":"host","ask":"status","rule":"\\u0000","attempts":3}'), "refused"),
          row(4, "relay.ask", text(`{"module":"host","ask":"status","rule":"\\ud83d","organization":"${ALDER}","attempts":5}`), "refused"),
          // A value that holds the text of the mark is not the mark: inside a
          // value every quote is escaped.
          row(5, "relay.ask", text(`{"module":"host","ask":"status","rule":",\\"organization\\":\\"${BIRCH}\\""}`), "refused"),
          // An ordinary marked row, in the same form.
          row(6, "relay.ask", text(`{"module":"host","ask":"status","rule":"module_off","organization":"${BIRCH}"}`), "refused"),
        ].join(", ")) as never,
    );
    const stored = (await db.execute(
      `SELECT jsonb_typeof(params) AS t FROM hx.admin_audit WHERE spool_file_id = '${fileId}'` as never,
    )) as unknown as { t: string }[];
    expect(stored.map((r) => r.t)).toEqual(Array.from({ length: 6 }, () => "string"));

    expect((await told(OWN)).counts).toEqual({ asksAllowed: 0, asksRefused: 4, releasesInstalled: 0, signIns: 0 });
    expect((await told(OWN)).lines).toHaveLength(4);
    expect(await told(held(ALDER))).toEqual({
      lines: ["relay relay.ask host:status refused"],
      counts: { asksAllowed: 0, asksRefused: 5, releasesInstalled: 0, signIns: 0 },
    });
    expect(await told(held(BIRCH))).toEqual({
      lines: ["relay relay.ask host:status refused"],
      counts: { asksAllowed: 0, asksRefused: 1, releasesInstalled: 0, signIns: 0 },
    });
  });

  test("a record stands for the same number of refusals on disk and once it is drained, whatever `attempts` holds", async () => {
    // What `attempts` can hold, and how many refusals the record stands for.
    // Only a whole number from 1 to the largest one JavaScript counts exactly
    // counts. The two readers must agree on every one of them.
    const cases: [unknown, number][] = [
      [7, 7],
      [1, 1],
      [0, 1],
      [-3, 1],
      [2.5, 1],
      ["7", 1],
      [null, 1],
      [true, 1],
      [1000000000000000, 1000000000000000],
      [9007199254740991, 9007199254740991],
      [9007199254740992, 1],
      [1e21, 1],
    ];
    for (const [attempts, weight] of cases) {
      const fileId = await spool("modules", async (file) => {
        await file.event("relay.ask", {
          actor: "relay",
          params: { module: "host", ask: "status", rule: "module_off", attempts: attempts as never },
          outcome: "refused",
        });
      });
      // On disk.
      expect([attempts, (await trail.count(range, OWN)).asksRefused]).toEqual([attempts, weight]);
      // In the table alone, as the drain writes a row.
      await drain(await onDisk());
      await removeFile(fileId);
      expect([attempts, (await trail.count(range, OWN)).asksRefused]).toEqual([attempts, weight]);
      await db.execute(`DELETE FROM hx.admin_audit WHERE spool_file_id = '${fileId}'` as never);
    }
  });

  test("the notice that old records were removed is shown to every organization", async () => {
    const mine = await spool("modules", async (file) => {
      await file.event("relay.ask", { actor: "relay", params: { module: "host", ask: "status" }, organization: ALDER, outcome: "ok" });
      await file.event("console.spool.reclaimed", { params: { files: 2, records: 40, bytes: 9000 }, error: "removed" });
    });
    const actions = async (organization: Organization): Promise<string[]> =>
      (await trail.read({ ...range, limit: 100 }, organization)).lines.map((line) => line.action).sort();
    const expected = {
      own: ["console.spool.reclaimed"],
      alder: ["console.spool.reclaimed", "relay.ask"],
      birch: ["console.spool.reclaimed"],
    };
    const all = async () => ({ own: await actions(OWN), alder: await actions(held(ALDER)), birch: await actions(held(BIRCH)) });
    expect(await all()).toEqual(expected);
    await drain(await onDisk());
    await removeFile(mine);
    expect(await all()).toEqual(expected);
  });

  test("an outcome says whose it is when its intent is in the table and it is on disk", async () => {
    // A pair that a rotation split. The first file was drained and removed; the
    // second is still on disk.
    let intent: AuditRecord | null = null;
    const first = await spool("modules", async (file) => {
      intent = await file.intent("relay.ask", {
        actor: "relay",
        params: { module: "stores", ask: "tables.list" },
        organization: ALDER,
      });
    });
    await drain(await onDisk());
    await removeFile(first);
    await spool("modules", async (file, clock) => {
      clock.now = at("09:00:05.000");
      await file.outcome(intent as AuditRecord, "ok");
    });
    // Alder's, with what it was done to found in the table.
    expect((await told(held(ALDER))).lines).toEqual(["relay relay.ask stores:tables.list ok"]);
    expect((await told(OWN)).lines).toEqual([]);
    expect((await told(held(ALDER))).counts.asksAllowed).toBe(1);
    expect((await told(OWN)).counts.asksAllowed).toBe(0);
  });

  test("a database that cannot answer is an error, never a shorter trail", async () => {
    await spool("ui", async (file) => {
      await signIn(file, "on-disk");
    });
    const broken = new AuditTrail({
      spoolDir: paths.auditSpool,
      // Nothing listens on the discard port, so every statement fails to connect.
      db: () =>
        createHxDb("postgresql://nobody:wrong@127.0.0.1:9/none", {
          max: 1,
          connectionTimeout: 2,
          idleTimeout: 0,
          maxLifetime: 0,
        }),
    });
    await expect(broken.read({ ...range, limit: 10 }, OWN)).rejects.toBeInstanceOf(TrailUnavailable);
    await expect(broken.count(range, OWN)).rejects.toMatchObject({ code: "database_unavailable" });
  });
});
