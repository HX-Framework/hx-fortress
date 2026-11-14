// Whose a record is: the one place that says it.
//
// A record of the Fortress's own organization says nothing about organizations.
// A record of another organization carries its id. The module host's audit
// writer is the only thing that sets that mark, and these tests hold it to
// three things: a writer made for an organization marks everything it writes,
// nothing else can set or forge the mark, and refusals that are counted instead
// of written are never counted for the wrong organization.

import { afterEach, describe, expect, test } from "bun:test";

import { AuditSpool } from "../../src/console/audit-spool";
import { ModuleAudit } from "../../src/host/module-audit";
import {
  OrganizationMarkInvalid,
  organizationOfParams,
  withOrganization,
  type Organization,
} from "../../src/host/organization-id";
import type { HxDb } from "../../src/host/postgres/db";
import { AuditTrail } from "../../src/modules/host/audit-trail";
import { spoolRecords, tempRoot, type Paths } from "./_module-rig";

// Made-up organizations. Northstar runs the Fortress; the others are held by it.
const OWN: Organization = {
  get id(): string {
    throw new Error("nothing here may read the own organization's id");
  },
  own: true,
};
const ALDER: Organization = { id: "alder-dental", own: false };
const BIRCH: Organization = { id: "birch-books", own: false };

let audit: ModuleAudit | null = null;
let cleanup: (() => Promise<void>) | null = null;
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

/** Each record as: its action, its kind, how it ended, and its parameters. */
async function written(paths: Paths): Promise<unknown[]> {
  return (await spoolRecords(paths)).map((r) => [r.action, r.kind, r.outcome, r.params]);
}

/** The reader the `host` module uses, over the same spool and an empty table. */
function trailOver(paths: Paths): AuditTrail {
  const emptyTable = { execute: async () => [] } as unknown as HxDb;
  return new AuditTrail({ spoolDir: paths.auditSpool, db: () => emptyTable });
}

const DAY = { from: "2027-03-14T00:00:00.000Z", to: "2027-03-15T00:00:00.000Z" };

describe("a record's organization", () => {
  test("is on everything a writer made for that organization writes, and on nothing the own writer writes", async () => {
    const { paths, audit } = await setup();
    const alder = audit.for(ALDER);
    const pair = await alder.intent("control_plane.ask", { actor: "control plane", params: { module: "host", ask: "status" } });
    await alder.outcome(pair, "ok");
    await alder.event("module.ledger.entry.added", { params: { target: "ledger" }, outcome: "done" });
    await alder.refused("control_plane.ask", { module: "host", ask: "status", rule: "module_off" });

    const own = await audit.intent("control_plane.ask", { actor: "control plane", params: { module: "host", ask: "status" } });
    await audit.outcome(own, "ok");
    await audit.event("module.ledger.entry.added", { params: { target: "ledger" }, outcome: "done" });
    await audit.refused("control_plane.ask", { module: "host", ask: "status", rule: "module_off" });

    expect(await written(paths)).toEqual([
      ["control_plane.ask", "intent", null, { module: "host", ask: "status", organization: "alder-dental" }],
      // The outcome says whose it is, and nothing else: it is its intent's.
      ["control_plane.ask", "outcome", "ok", { organization: "alder-dental" }],
      ["module.ledger.entry.added", "outcome", "done", { target: "ledger", organization: "alder-dental" }],
      ["control_plane.ask", "outcome", "refused", { module: "host", ask: "status", rule: "module_off", organization: "alder-dental" }],
      // The Fortress's own: as every record was before there could be a second organization.
      ["control_plane.ask", "intent", null, { module: "host", ask: "status" }],
      ["control_plane.ask", "outcome", "ok", null],
      ["module.ledger.entry.added", "outcome", "done", { target: "ledger" }],
      ["control_plane.ask", "outcome", "refused", { module: "host", ask: "status", rule: "module_off" }],
    ]);
  });

  test("the own organization's writer is the audit writer itself, and its id is never read", async () => {
    const { audit } = await setup();
    // `OWN.id` throws when read: writing for the own organization must not make it an id.
    expect(audit.for(OWN)).toBe(audit);
  });

  test("is written under every action, whatever that action's list of parameters allows", async () => {
    const { paths, audit } = await setup();
    const alder = audit.for(ALDER);
    // An action with no list of parameters at all, and one whose list has no
    // such name. The mark is not a parameter a caller passes.
    await alder.event("system.release.install", { params: { release: "rel-1" }, outcome: "installed" });
    await alder.event("not.an.action.this.build.lists", { params: { anything: "dropped" }, outcome: "done" });
    expect(await written(paths)).toEqual([
      ["system.release.install", "outcome", "installed", { release: "rel-1", organization: "alder-dental" }],
      ["not.an.action.this.build.lists", "outcome", "done", { organization: "alder-dental" }],
    ]);
  });

  test("cannot be set, changed or removed through a record's own parameters", async () => {
    const { paths, audit } = await setup();
    // A module's own record may name its detail fields freely. One called
    // `organization` is dropped, for the own organization and for another.
    await audit.event("module.ledger.entry.added", {
      params: { target: "ledger", organization: "birch-books" },
      outcome: "done",
    });
    await audit.for(ALDER).event("module.ledger.entry.added", {
      params: { target: "ledger", organization: "birch-books" },
      outcome: "done",
    });
    await audit.for(ALDER).refused("control_plane.ask", { module: "host", ask: "status", rule: "x", organization: "birch-books" });
    expect(await written(paths)).toEqual([
      ["module.ledger.entry.added", "outcome", "done", { target: "ledger" }],
      ["module.ledger.entry.added", "outcome", "done", { target: "ledger", organization: "alder-dental" }],
      ["control_plane.ask", "outcome", "refused", { module: "host", ask: "status", rule: "x", organization: "alder-dental" }],
    ]);
    expect(JSON.stringify(await spoolRecords(paths))).not.toContain("birch-books");
  });

  test("is written as it is, and not as the redactor would rewrite text that looks like a credential", async () => {
    const { paths, audit } = await setup();
    // The list refuses such an id (see module-organizations.test.ts). The
    // writer does not depend on that: a mark is never rewritten into another.
    const id = "acme-sk-northstar-holdings-europe";
    await audit.for({ id, own: false }).event("control_plane.ask", { params: { module: "host" }, outcome: "ok" });
    expect(await written(paths)).toEqual([["control_plane.ask", "outcome", "ok", { module: "host", organization: id }]]);
  });

  test("a mark that is not an id writes no record: an intent throws, and so the act does not run", async () => {
    const { paths, audit, errors } = await setup();
    const broken = audit.for({ id: "Not An Id", own: false });
    await expect(broken.intent("control_plane.ask", { params: { module: "host" } })).rejects.toBeInstanceOf(
      OrganizationMarkInvalid,
    );
    // A single record is reported and not written. It is never written unmarked.
    expect(await broken.event("control_plane.ask", { params: { module: "host" }, outcome: "ok" })).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(OrganizationMarkInvalid);
    expect(await written(paths)).toEqual([]);
  });

  test("an outcome is its intent's, also when another writer of the spool appends it", async () => {
    const { paths, audit } = await setup();
    const intent = await audit.for(ALDER).intent("control_plane.ask", { params: { module: "host", ask: "status" } });
    // The spool copies the mark from the intent: no caller passes it twice.
    const spool = new AuditSpool({ dir: paths.auditSpool, writer: "modules" });
    const outcome = await spool.outcome(intent, "ok");
    expect(outcome.params).toEqual({ organization: "alder-dental" });
  });
});

describe("reading the mark", () => {
  test("only an organization's id counts as a mark", () => {
    expect(organizationOfParams({ organization: "alder-dental" })).toBe("alder-dental");
    for (const params of [
      null,
      undefined,
      "alder-dental",
      [],
      {},
      { organization: "" },
      { organization: 5 },
      { organization: null },
      { organization: ["alder-dental"] },
      { organization: "Alder Dental" },
      { org: "alder-dental" },
      Object.create({ organization: "alder-dental" }) as object,
    ]) {
      expect(organizationOfParams(params)).toBeNull();
    }
  });

  test("the written form drops the caller's own and adds the writer's", () => {
    expect(withOrganization(null, null)).toBeNull();
    expect(withOrganization({ organization: "birch-books" }, null)).toBeNull();
    expect(withOrganization({ a: 1, organization: "birch-books" }, undefined)).toEqual({ a: 1 });
    expect(withOrganization({ a: 1, organization: "birch-books" }, "alder-dental")).toEqual({
      a: 1,
      organization: "alder-dental",
    });
    expect(withOrganization(null, "alder-dental")).toEqual({ organization: "alder-dental" });
    expect(() => withOrganization({ a: 1 }, "")).toThrow(OrganizationMarkInvalid);
    expect(() => withOrganization({ a: 1 }, "../northstar")).toThrow(OrganizationMarkInvalid);
  });
});

describe("refusals past the budget", () => {
  test("a run of one refusal is counted for each organization on its own", async () => {
    const { paths, audit } = await setup();
    const refusal = { module: "host", ask: "status", rule: "module_off" };
    for (let i = 0; i < 3; i += 1) await audit.refused("control_plane.ask", refusal);
    for (let i = 0; i < 5; i += 1) await audit.for(ALDER).refused("control_plane.ask", refusal);
    for (let i = 0; i < 2; i += 1) await audit.for(BIRCH).refused("control_plane.ask", refusal);
    await audit.flush();
    const counts = (await spoolRecords(paths)).map((r) => {
      const p = r.params as { organization?: string; attempts?: number };
      return [p.organization ?? "own", p.attempts ?? 1];
    });
    expect(counts).toEqual([
      ["own", 1],
      ["alder-dental", 1],
      ["birch-books", 1],
      ["own", 2],
      ["alder-dental", 4],
      ["birch-books", 1],
    ]);
  });

  test("another organization's are counted apart from the own organization's, and as nobody's", async () => {
    const { paths, audit } = await setup({ kindsPerWindow: 1 });
    // The one refusal the budget has room for.
    await audit.refused("control_plane.ask", { module: "host", ask: "status", rule: "module_off" });
    // Past the budget: two more of the own organization's, five of two others'.
    for (const rule of ["a", "b"]) await audit.refused("control_plane.ask", { module: "host", ask: "status", rule });
    for (const rule of ["a", "b", "c"]) await audit.for(ALDER).refused("control_plane.ask", { module: "host", ask: "status", rule });
    for (const rule of ["a", "b"]) await audit.for(BIRCH).refused("control_plane.ask", { module: "host", ask: "status", rule });
    await audit.for(ALDER).refused("system.module.refused", { module: "ledger", rule: "egress_not_declared" }, null);
    await audit.flush();

    const span = { from: "2027-03-14T09:00:00.000Z", to: "2027-03-14T09:00:00.000Z" };
    expect(await written(paths)).toEqual([
      ["control_plane.ask", "outcome", "refused", { module: "host", ask: "status", rule: "module_off" }],
      // The own organization's: under the action itself, as before.
      ["control_plane.ask", "outcome", "refused", { rule: "refusals_over_budget", attempts: 2, ...span }],
      // Everybody else's together, under an action of its own, naming nobody.
      ["control_plane.ask.overflow", "outcome", "refused", { rule: "refusals_over_budget", attempts: 5, ...span }],
      ["system.module.refused.overflow", "outcome", "refused", { rule: "refusals_over_budget", attempts: 1, ...span }],
    ]);

    // What each organization is told. The five are in nobody's count: not the
    // own organization's, whose they were not, and not Alder's or Birch's,
    // because one record cannot be split between them.
    const trail = trailOver(paths);
    expect((await trail.count(DAY, OWN)).asksRefused).toBe(3);
    expect((await trail.count(DAY, ALDER)).asksRefused).toBe(0);
    expect((await trail.count(DAY, BIRCH)).asksRefused).toBe(0);
    // The own organization, which runs the Fortress, is shown that it happened.
    const own = await trail.read({ ...DAY, limit: 100 }, OWN);
    expect(own.lines.map((line) => `${line.action} ${line.outcome}`).sort()).toEqual([
      "control_plane.ask refused",
      "control_plane.ask refused",
      "control_plane.ask.overflow refused",
      "system.module.refused.overflow refused",
    ]);
    expect((await trail.read({ ...DAY, limit: 100 }, ALDER)).lines).toEqual([]);
  });

  test("the number of records stays bounded however many organizations are refused", async () => {
    const { paths, audit } = await setup({ kindsPerWindow: 2 });
    for (let i = 0; i < 500; i += 1) {
      await audit
        .for({ id: `organization-${i}`, own: false })
        .refused("control_plane.ask", { module: "host", ask: "status", rule: "busy_rate" });
    }
    await audit.flush();
    const records = await spoolRecords(paths);
    // Two refusals within the budget, and one count for the other 498.
    expect(records).toHaveLength(3);
    expect(records.at(-1)).toMatchObject({
      action: "control_plane.ask.overflow",
      params: { rule: "refusals_over_budget", attempts: 498 },
    });
  });
});

describe("the notice that old records were removed", () => {
  test("is shown to every organization, and the terminal's own is not", async () => {
    const { paths, audit, now } = await setup();
    await audit.for(ALDER).event("control_plane.ask", { params: { module: "host", ask: "status" }, outcome: "ok" });
    // What this writer records before it removes old files of its own.
    await audit.event("console.spool.reclaimed", {
      params: { files: 2, records: 40, bytes: 9000 },
      error: "40 module records in 2 spool files were removed from this host's disk.",
    });
    // The terminal's writer says the same of ITS files. Those hold the own
    // organization's records only.
    const cli = new AuditSpool({ dir: paths.auditSpool, writer: "cli", clock: () => now.value });
    await cli.event("console.spool.reclaimed", { params: { files: 1, records: 3, bytes: 100 }, error: "removed" });

    const trail = trailOver(paths);
    const lines = async (organization: Organization): Promise<string[]> =>
      (await trail.read({ ...DAY, limit: 100 }, organization)).lines.map(
        (line) => `${line.actorKind} ${line.action} ${line.outcome}`,
      );
    expect((await lines(ALDER)).sort()).toEqual(["control_plane control_plane.ask ok", "fortress console.spool.reclaimed failed"]);
    expect(await lines(BIRCH)).toEqual(["fortress console.spool.reclaimed failed"]);
    expect((await lines(OWN)).sort()).toEqual([
      "fortress console.spool.reclaimed failed",
      "person console.spool.reclaimed failed",
    ]);
  });
});
