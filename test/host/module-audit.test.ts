import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { CliAudit } from "../../src/cli-audit";
import { listSpoolFiles, spoolUsage } from "../../src/console/audit-spool";
import {
  MODULE_SPOOL_CAPS,
  MODULE_SPOOL_STALE_MS,
  ModuleAudit,
  REFUSAL_KINDS_PER_WINDOW,
  REFUSALS_OVER_BUDGET,
} from "../../src/host/module-audit";
import { spoolRecords, tempRoot, type Paths } from "./_module-rig";

let cleanup: (() => Promise<void>) | null = null;
let audit: ModuleAudit | null = null;
afterEach(async () => {
  await audit?.stop();
  await cleanup?.();
  audit = null;
  cleanup = null;
});

async function setup(options: Partial<ConstructorParameters<typeof ModuleAudit>[0]> = {}) {
  const root = await tempRoot();
  cleanup = root.cleanup;
  const now = { value: new Date("2027-03-14T09:00:00.000Z") };
  const errors: unknown[] = [];
  audit = new ModuleAudit({
    dir: root.paths.auditSpool,
    clock: () => new Date(now.value.getTime()),
    onError: (error) => void errors.push(error),
    ...options,
  });
  return { paths: root.paths, now, errors, audit };
}

const params = (paths: Paths) => spoolRecords(paths).then((records) => records.map((r) => r.params));

describe("refusals collapse", () => {
  test("the first is written at once, the rest as one count when the window closes", async () => {
    const { paths, audit, now } = await setup();
    const key = { module: "probe", ask: "unknown", rule: "grant_missing" };
    await audit.refused("relay.ask", key);
    expect(await params(paths)).toEqual([key]);
    for (let i = 0; i < 40; i += 1) {
      now.value = new Date(now.value.getTime() + 1_000);
      await audit.refused("relay.ask", key);
    }
    expect(await params(paths)).toHaveLength(1);
    // The window has run out: the next refusal closes it and opens another.
    now.value = new Date(now.value.getTime() + 30_000);
    await audit.refused("relay.ask", key);
    expect(await params(paths)).toEqual([
      key,
      { ...key, attempts: 40, from: "2027-03-14T09:00:01.000Z", to: "2027-03-14T09:00:40.000Z" },
      key,
    ]);
  });

  test("a different rule, module or ask is its own window", async () => {
    const { paths, audit } = await setup();
    await audit.refused("relay.ask", { module: "probe", ask: "unknown", rule: "grant_missing" });
    await audit.refused("relay.ask", { module: "probe", ask: "unknown", rule: "grant_signature" });
    await audit.refused("relay.ask", { module: "host", ask: "unknown", rule: "grant_missing" });
    await audit.refused("relay.release.offer", { module: "probe", rule: "signature_missing" });
    expect(await params(paths)).toHaveLength(4);
  });

  test("two refusals arriving together write one first record, not two", async () => {
    const { paths, audit } = await setup();
    const key = { module: "probe", ask: "unknown", rule: "grant_missing" };
    await Promise.all(Array.from({ length: 20 }, () => audit.refused("relay.ask", key)));
    await audit.flush();
    expect(await params(paths)).toEqual([key, expect.objectContaining({ attempts: 19 })]);
  });

  test("stopping writes every open window", async () => {
    const { paths, audit } = await setup();
    const key = { module: "probe", ask: "unknown", rule: "grant_missing" };
    await audit.refused("relay.ask", key);
    await audit.refused("relay.ask", key);
    await audit.stop();
    expect((await params(paths)).at(-1)).toMatchObject({ attempts: 1 });
  });

  test("a lone refusal leaves no second record", async () => {
    const { paths, audit } = await setup();
    await audit.refused("relay.ask", { module: "probe", ask: "unknown", rule: "grant_missing" });
    await audit.flush();
    expect(await params(paths)).toHaveLength(1);
  });

  test("the timer closes a window nobody refuses into again", async () => {
    const root = await tempRoot();
    cleanup = root.cleanup;
    audit = new ModuleAudit({ dir: root.paths.auditSpool, windowMs: 40 });
    audit.start();
    const key = { module: "probe", ask: "unknown", rule: "grant_missing" };
    await audit.refused("relay.ask", key);
    await audit.refused("relay.ask", key);
    await Bun.sleep(600);
    expect(await params(root.paths)).toEqual([key, expect.objectContaining({ attempts: 1 })]);
  });
});

describe("a count is written once, whatever else is happening", () => {
  /** The timer's own pass over the windows, called directly. */
  const flushExpired = (a: ModuleAudit): Promise<void> =>
    (a as unknown as { flushExpired(): Promise<void> }).flushExpired();

  test("a refusal that arrives while the timer is writing does not get its count written twice", async () => {
    const { paths, audit, now } = await setup();
    const a = { module: "probe", ask: "unknown", rule: "grant_missing" };
    const b = { module: "probe", ask: "unknown", rule: "grant_signature" };
    for (const kind of [a, a, a, b, b]) await audit.refused("relay.ask", kind);
    // Both windows have closed. The timer starts writing them...
    now.value = new Date(now.value.getTime() + 61_000);
    const timer = flushExpired(audit);
    // ...and before it reaches the second, another refusal of that kind arrives.
    await audit.refused("relay.ask", b);
    await audit.refused("relay.ask", b);
    await timer;
    await audit.flush();
    // What the trail adds up to, by kind: a record with no count is one
    // refusal, and a record with a count is that many. Three of kind A were
    // refused and four of kind B. A count written twice, or a window dropped
    // unwritten and opened again, makes these numbers wrong.
    const total: Record<string, number> = {};
    for (const p of await params(paths)) {
      const { rule, attempts } = p as { rule: string; attempts?: number };
      total[rule] = (total[rule] ?? 0) + (attempts ?? 1);
    }
    expect(total).toEqual({ grant_missing: 3, grant_signature: 4 });
    // Kind B: its first refusal, the count of its first window, the refusal
    // that opened its second window, and that window's count. Four records.
    const b2 = (await params(paths)).filter((p) => (p as { rule: string }).rule === "grant_signature");
    expect(b2.map((p) => (p as { attempts?: number }).attempts ?? null)).toEqual([null, 1, null, 1]);
  });

  test("a file that is retired during the timer's pass does not write the rest again", async () => {
    const kinds = ["a", "b", "c", "d"].map((rule) => ({ module: "probe", ask: "unknown", rule }));
    // How large four first records are. A file with room for exactly those is
    // due to be retired at the next record, which is the timer's first count,
    // and retiring a file writes every window that is still open.
    const measured = await setup();
    for (const kind of kinds) await measured.audit.refused("relay.ask", kind);
    const fourRecords = (await listSpoolFiles(measured.paths.auditSpool))[0]?.bytes ?? 0;
    expect(fourRecords).toBeGreaterThan(400);
    await measured.audit.stop();
    await cleanup?.();

    const { paths, audit, now } = await setup({ rotateBytes: fourRecords });
    for (const kind of kinds) await audit.refused("relay.ask", kind);
    for (const kind of kinds) await audit.refused("relay.ask", kind);
    expect(await listSpoolFiles(paths.auditSpool)).toHaveLength(1);
    now.value = new Date(now.value.getTime() + 61_000);
    await flushExpired(audit);
    await audit.flush();
    // The pass did retire the file: there are two now.
    expect((await listSpoolFiles(paths.auditSpool)).length).toBe(2);
    const counted = (await params(paths))
      .filter((p) => (p as { attempts?: number }).attempts !== undefined)
      .map((p) => [(p as { rule: string }).rule, (p as { attempts: number }).attempts]);
    expect(counted.sort()).toEqual([
      ["a", 1],
      ["b", 1],
      ["c", 1],
      ["d", 1],
    ]);
  });
});

describe("refusals have a budget", () => {
  test("past it a refusal is counted, not written, and one marker says how many", async () => {
    const { paths, audit, now } = await setup({ kindsPerWindow: 5 });
    // Forty DIFFERENT refusals in one window: the case collapsing alone cannot bound.
    for (let i = 0; i < 40; i += 1) {
      now.value = new Date(now.value.getTime() + 100);
      await audit.refused("relay.ask", { module: "probe", ask: "unknown", rule: `rule_${i}` });
    }
    expect(await params(paths)).toHaveLength(5);
    await audit.flush();
    const all = await params(paths);
    expect(all).toHaveLength(6);
    expect(all.at(-1)).toEqual({
      rule: REFUSALS_OVER_BUDGET,
      attempts: 35,
      from: "2027-03-14T09:00:00.600Z",
      to: "2027-03-14T09:00:04.000Z",
    });
  });

  test("a refusal that already has a window is still counted into it", async () => {
    const { paths, audit } = await setup({ kindsPerWindow: 1 });
    const key = { module: "probe", ask: "unknown", rule: "grant_missing" };
    await audit.refused("relay.ask", key);
    await audit.refused("relay.ask", { ...key, rule: "grant_signature" });
    await audit.refused("relay.ask", key);
    await audit.flush();
    expect(await params(paths)).toEqual([
      key,
      expect.objectContaining({ rule: "grant_missing", attempts: 1 }),
      expect.objectContaining({ rule: REFUSALS_OVER_BUDGET, attempts: 1 }),
    ]);
  });

  test("the budget refills with the next window", async () => {
    const { paths, audit, now } = await setup({ kindsPerWindow: 2 });
    for (const rule of ["a", "b", "c"]) await audit.refused("relay.ask", { rule });
    now.value = new Date(now.value.getTime() + 61_000);
    await audit.refused("relay.ask", { rule: "d" });
    await audit.flush();
    const rules = (await params(paths)).map((p) => (p as { rule: string }).rule);
    expect(rules).toEqual(["a", "b", "d", REFUSALS_OVER_BUDGET]);
  });

  test("no window holds more different refusals than the budget, wherever it starts", async () => {
    const { paths, audit, now } = await setup({ kindsPerWindow: 2 });
    const start = now.value.getTime();
    const at = (ms: number) => void (now.value = new Date(start + ms));
    await audit.refused("relay.ask", { rule: "a" });
    at(59_000);
    await audit.refused("relay.ask", { rule: "b" });
    // 61 s: "a" has left the last minute and "b" has not. One more may be
    // written. A count that was reset each minute would write two here, which
    // is three different refusals in two seconds.
    at(61_000);
    await audit.refused("relay.ask", { rule: "c" });
    await audit.refused("relay.ask", { rule: "d" });
    await audit.flush();
    const rules = (await params(paths)).map((p) => (p as { rule: string }).rule);
    expect(rules).toEqual(["a", "b", "c", REFUSALS_OVER_BUDGET]);
  });

  test("each action gets its own marker", async () => {
    const { paths, audit } = await setup({ kindsPerWindow: 1 });
    await audit.refused("relay.ask", { rule: "a" });
    await audit.refused("relay.ask", { rule: "b" });
    await audit.refused("relay.release.offer", { rule: "c" });
    await audit.flush();
    const records = (await spoolRecords(paths)).map((r) => [r.action, (r.params as { rule: string }).rule]);
    expect(records).toEqual([
      ["relay.ask", "a"],
      ["relay.ask", REFUSALS_OVER_BUDGET],
      ["relay.release.offer", REFUSALS_OVER_BUDGET],
    ]);
  });

  test("whatever is sent, a window writes a bounded number of records", async () => {
    const { paths, audit, now } = await setup();
    for (let i = 0; i < 5_000; i += 1) {
      if (i % 100 === 0) now.value = new Date(now.value.getTime() + 1_000);
      await audit.refused(i % 2 ? "relay.ask" : "relay.release.offer", { rule: `r${i}` });
    }
    await audit.flush();
    // First records for the budget, and one marker for each of the two actions.
    expect(await params(paths)).toHaveLength(REFUSAL_KINDS_PER_WINDOW + 2);
  });
});

describe("a spool directory that cannot be made at first", () => {
  test("is tried again at the next record, with no restart", async () => {
    const root = await tempRoot();
    cleanup = root.cleanup;
    // A FILE where the spool's parent directory should be: making the spool
    // directory fails, as it does on a full or read-only disk.
    const parent = path.dirname(root.paths.auditSpool);
    await mkdir(path.dirname(parent), { recursive: true });
    await writeFile(parent, "in the way");
    const errors: unknown[] = [];
    audit = new ModuleAudit({ dir: root.paths.auditSpool, onError: (error) => void errors.push(error) });
    await expect(audit.intent("relay.ask", { params: { module: "probe", ask: "x" } })).rejects.toThrow();
    await expect(audit.intent("relay.ask", { params: { module: "probe", ask: "x" } })).rejects.toThrow();

    // Somebody fixes it. The very next record is written.
    await rm(parent);
    const intent = await audit.intent("relay.ask", { params: { module: "probe", ask: "x" } });
    expect(intent.seq).toBeGreaterThan(0);
    expect(await spoolRecords(root.paths)).toHaveLength(1);
  });
});

describe("pairs", () => {
  test("an intent that cannot be written throws, so the act does not run", async () => {
    const { paths, audit } = await setup();
    // A FILE where the spool directory belongs: nothing can be written there.
    await mkdir(path.dirname(paths.auditSpool), { recursive: true });
    await writeFile(paths.auditSpool, "not a directory");
    await expect(audit.intent("relay.ask", { params: { module: "probe", ask: "x" } })).rejects.toThrow();
  });

  test("an event that cannot be written is reported, and does not throw", async () => {
    const { paths, audit, errors } = await setup();
    await mkdir(path.dirname(paths.auditSpool), { recursive: true });
    await writeFile(paths.auditSpool, "not a directory");
    expect(await audit.event("relay.ask", { outcome: "refused" })).toBeNull();
    expect(errors).toHaveLength(1);
  });

  test("records carry the system origin, in owner-only files of their own kind", async () => {
    const { paths, audit } = await setup();
    const intent = await audit.intent("relay.ask", { actor: "relay", params: { module: "probe", ask: "x" } });
    await audit.outcome(intent, "ok");
    const records = await spoolRecords(paths);
    expect(records.map((r) => [r.origin, r.kind, r.outcome, r.refSeq])).toEqual([
      ["system", "intent", null, null],
      ["system", "outcome", "ok", 1],
    ]);
    const [name] = await readdir(paths.auditSpool);
    expect(name).toMatch(/^20270314T090000Z-modules-[0-9a-f]{32}\.jsonl$/);
    expect((await Bun.file(path.join(paths.auditSpool, name as string)).stat()).mode & 0o777).toBe(0o600);
    // The console's drain and its file listing recognize the kind.
    const [listed] = await listSpoolFiles(paths.auditSpool);
    expect(listed).toMatchObject({ writer: "modules", fileId: intent.fileId });
  });
});

describe("a spool nothing drains", () => {
  /**
   * Whole spool files from earlier runs, oldest first. Each was last written at
   * `touchedAt`; left out, that is the real time, which is months before the
   * clock these tests run on, so the files are old.
   */
  async function seed(
    paths: Paths,
    writer: "modules" | "daemon" | "cli",
    count: number,
    options: { touchedAt?: Date; start?: number } = {},
  ) {
    await mkdir(paths.auditSpool, { recursive: true });
    const names: string[] = [];
    const start = options.start ?? 0;
    for (let i = start; i < start + count; i += 1) {
      const fileId = `${writer === "modules" ? "a" : writer === "daemon" ? "d" : "c"}${i
        .toString(16)
        .padStart(31, "0")}`;
      const name = `20270301T0000${String(i).padStart(2, "0")}Z-${writer}-${fileId}.jsonl`;
      const record = {
        fileId,
        seq: 1,
        ts: `2027-03-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        actor: "relay",
        sessionRef: null,
        tier: null,
        action: "relay.ask",
        params: null,
        kind: "outcome",
        refFileId: null,
        refSeq: null,
        outcome: "ok",
        error: null,
        origin: "system",
      };
      const file = path.join(paths.auditSpool, name);
      await writeFile(file, `${JSON.stringify(record)}\n`);
      if (options.touchedAt) await utimes(file, options.touchedAt, options.touchedAt);
      names.push(name);
    }
    return names;
  }
  const reclaims = async (paths: Paths) =>
    (await spoolRecords(paths)).filter((r) => r.action === "console.spool.reclaimed");

  test("old files are brought back inside the cap, oldest first, and the loss is announced first", async () => {
    const { paths, audit } = await setup({ caps: { maxFiles: 4, maxBytes: 1024 * 1024 } });
    const names = await seed(paths, "modules", 8);
    await audit.enforceCap();
    const left = (await readdir(paths.auditSpool)).sort();
    // Four old files stay, beside the file this writer announced into.
    expect(left.filter((name) => names.includes(name))).toEqual(names.slice(4));
    expect(left).toHaveLength(5);
    const [announced] = await reclaims(paths);
    expect(announced?.params).toEqual({
      files: 4,
      records: 4,
      bytes: expect.any(Number),
      from: "2027-03-01T00:00:00.000Z",
      to: "2027-03-01T00:00:03.000Z",
    });
    // What it says is what this writer knows, and no more.
    expect(announced?.error).toContain("4 module records in 4 spool files were removed from this host's disk");
    expect(announced?.error).toContain("more than 65 minutes without a write and no console had removed them");
    expect(announced?.error).toContain("Any of these records that a console did drain are in the audit table");
  });

  test("a file a running console would still remove is left alone, however many there are", async () => {
    const { paths, audit, now } = await setup({ caps: { maxFiles: 2, maxBytes: 1024 } });
    // Thirty files, last written half an hour ago. A running console has drained
    // each of them and removes it when it is an hour old. Removing one here
    // would record its records as lost when they are in the table.
    const halfAnHourAgo = new Date(now.value.getTime() - 30 * 60_000);
    const names = await seed(paths, "modules", 30, { touchedAt: halfAnHourAgo });
    await audit.enforceCap();
    expect((await readdir(paths.auditSpool)).sort()).toEqual(names);
    expect(await reclaims(paths)).toEqual([]);

    // Forty minutes on, nothing has removed them: no console is draining this
    // host. Now they are this writer's to bound.
    now.value = new Date(now.value.getTime() + 40 * 60_000);
    await audit.enforceCap();
    const left = await readdir(paths.auditSpool);
    expect(left.filter((name) => names.includes(name))).toEqual(names.slice(28));
    expect((await reclaims(paths)).map((r) => (r.params as { files: number }).files)).toEqual([28]);
  });

  test("the line between the two is 65 minutes without a write", async () => {
    expect(MODULE_SPOOL_STALE_MS).toBe(65 * 60_000);
    const { paths, audit, now } = await setup({ caps: { maxFiles: 0, maxBytes: 0 } });
    const at = (minutes: number) => new Date(now.value.getTime() - minutes * 60_000);
    const [young] = await seed(paths, "modules", 1, { touchedAt: at(64), start: 0 });
    const [old] = await seed(paths, "modules", 1, { touchedAt: at(66), start: 1 });
    await audit.enforceCap();
    const left = await readdir(paths.auditSpool);
    expect(left).toContain(young as string);
    expect(left).not.toContain(old as string);
  });

  test("counts and removes only its own files", async () => {
    const { paths, audit } = await setup({ caps: { maxFiles: 2, maxBytes: 1024 * 1024 } });
    // The daemon's command records and the terminal's records are not this
    // writer's: they are never counted against its cap and never removed by it.
    const daemon = await seed(paths, "daemon", 6);
    const cli = await seed(paths, "cli", 6);
    await audit.enforceCap();
    expect((await readdir(paths.auditSpool)).sort()).toEqual([...daemon, ...cli].sort());
    const mine = await seed(paths, "modules", 4);
    await audit.enforceCap();
    const left = await readdir(paths.auditSpool);
    for (const name of [...daemon, ...cli]) expect(left).toContain(name);
    expect(left.filter((name) => mine.includes(name))).toEqual(mine.slice(2));
  });

  test("never removes the file it is writing to", async () => {
    const { paths, audit } = await setup({ caps: { maxFiles: 0, maxBytes: 0 }, staleMs: 0 });
    await audit.event("relay.ask", { outcome: "refused" });
    await audit.enforceCap();
    await audit.enforceCap();
    const left = await readdir(paths.auditSpool);
    expect(left).toHaveLength(1);
    expect((await spoolRecords(paths)).map((r) => r.action)).toEqual(["relay.ask"]);
  });

  test("two checks at once drop a file once and announce it once", async () => {
    const { paths, audit } = await setup({ caps: { maxFiles: 4, maxBytes: 1024 * 1024 } });
    await seed(paths, "modules", 8);
    await Promise.all([audit.enforceCap(), audit.enforceCap(), audit.enforceCap()]);
    expect((await reclaims(paths)).map((r) => (r.params as { files: number }).files)).toEqual([4]);
  });

  test("is checked again each time a file is retired, with no timer and no caller", async () => {
    // What a relay that keeps asking does to a fortress with no console: record
    // after record, for as long as it likes. Nothing here starts the timer or
    // calls the check; retiring a file is what runs it. `staleMs: 0` makes every
    // finished file old at once, as an hour of this would.
    const caps = { maxFiles: 64, maxBytes: 4000 };
    const { paths, audit, now, errors } = await setup({ caps, rotateBytes: 1000, staleMs: 0 });
    const written = new Set<string>();
    for (let i = 0; i < 160; i += 1) {
      now.value = new Date(now.value.getTime() + 1000);
      const record = await audit.event("relay.ask", {
        params: { module: "host", ask: "status" },
        outcome: "ok",
      });
      if (record) written.add(record.fileId);
    }
    expect(written.size).toBeGreaterThan(20);

    const modulesFiles = async () =>
      (await listSpoolFiles(paths.auditSpool)).filter((file) => file.writer === "modules");
    // Every file but the one being written, which is the newest.
    const finishedBytes = async () =>
      (await modulesFiles()).slice(0, -1).reduce((sum, file) => sum + file.bytes, 0);
    // The last retired file's check runs on a timeout; give it a moment.
    const deadline = Date.now() + 3000;
    while ((await finishedBytes()) > caps.maxBytes && Date.now() < deadline) await Bun.sleep(10);

    // About 48,000 bytes were written. The finished files are inside the cap.
    expect(await finishedBytes()).toBeLessThanOrEqual(caps.maxBytes);
    expect(errors).toEqual([]);

    // Every file that is gone was announced, and none twice.
    const announced = await reclaims(paths);
    expect(announced.length).toBeGreaterThan(0);
    const left = await modulesFiles();
    // Announcements that were themselves in a dropped file are gone with it, so
    // the ones still on disk account for at most the files that are gone.
    const dropped = announced.reduce((sum, r) => sum + (r.params as { files: number }).files, 0);
    expect(dropped).toBeGreaterThan(0);
    expect(dropped).toBeLessThanOrEqual(written.size + announced.length - left.length);
  });

  test("does nothing while its old files are inside the cap", async () => {
    const { paths, audit } = await setup();
    const names = await seed(paths, "modules", 3);
    await audit.enforceCap();
    expect((await readdir(paths.auditSpool)).sort()).toEqual(names);
    expect(MODULE_SPOOL_CAPS).toEqual({ maxFiles: 16, maxBytes: 16 * 1024 * 1024 });
  });

  test("the terminal's ceiling does not count this writer's files, so they push no terminal record out", async () => {
    const { paths } = await setup();
    const caps = { maxFiles: 5, maxBytes: 1024 * 1024 };
    const cli = await seed(paths, "cli", 3);
    const mine = await seed(paths, "modules", 40);
    // Forty-three files in a directory whose ceiling is five, and three count.
    expect(await spoolUsage(paths.auditSpool)).toMatchObject({ files: 3 });
    const act = (): Promise<unknown> =>
      new CliAudit({ dir: paths.auditSpool, caps }).run(
        "cli.module.on",
        { module: "host", state: "on" },
        async () => ({}),
      );
    await act();
    const left = await readdir(paths.auditSpool);
    for (const name of [...cli, ...mine]) expect(left).toContain(name);
    expect(await reclaims(paths)).toEqual([]);

    // The same number of files that DO count does push the oldest terminal
    // records out, as it did before this writer existed.
    await seed(paths, "daemon", 40);
    await act();
    const after = await readdir(paths.auditSpool);
    expect(cli.filter((name) => after.includes(name))).toEqual([]);
    for (const name of mine) expect(after).toContain(name);
    expect((await reclaims(paths)).map((r) => r.origin)).toEqual(["cli"]);
  });
});
