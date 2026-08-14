// The seed's two promises: the world is the same every time, and every fixture
// in it is there for a named acceptance.
//
// The digest is pinned rather than merely compared between two in-process
// builds. A build that read the clock once and memoized it would pass an
// A-vs-B comparison forever; only a value fixed in the source catches it.

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runDevCommand } from "../src/cli-dev";
import {
  buildSeedCorpus,
  corpusDigest,
  SEED_ACCEPTANCES,
  SEED_EPOCH,
  seedInventory,
  seedUuid,
} from "../src/dev/corpus";
import { DEV_DISABLED_REFUSAL, DEV_ENROLLED_REFUSAL, devGateVerdict } from "../src/dev/gate";
import { applySeedObjects, directoryObjectWriter, materializeSeed } from "../src/dev/seed";

/** The corpus's identity. Update it deliberately, in the same commit that
 *  changes the world — never to make a red test green. */
const PINNED_DIGEST = "c77333f1407c4a1f07f42edac2ea386713342b0d9cfe9c240db0f6f5adfc3fd5";

describe("seed determinism", () => {
  test("the corpus digest is pinned", () => {
    expect(corpusDigest(buildSeedCorpus())).toBe(PINNED_DIGEST);
  });

  test("two builds are byte-identical", () => {
    expect(JSON.stringify(buildSeedCorpus())).toBe(JSON.stringify(buildSeedCorpus()));
  });

  test("derived ids are stable and well-formed", () => {
    expect(seedUuid("session/x")).toBe(seedUuid("session/x"));
    expect(seedUuid("session/x")).not.toBe(seedUuid("session/y"));
    expect(seedUuid("session/x")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("every timestamp sits at or before the fixed epoch", () => {
    const corpus = buildSeedCorpus();
    const epoch = Date.parse(SEED_EPOCH);
    for (const session of corpus.sessions) {
      expect(Date.parse(session.lastActivityAt)).toBeLessThanOrEqual(epoch);
      expect(Date.parse(session.firstEventAt)).toBeLessThanOrEqual(epoch);
    }
    expect(Date.parse(corpus.roster.asOf)).toBeLessThanOrEqual(epoch);
  });
});

describe("fixture inventory", () => {
  const corpus = buildSeedCorpus();
  const inventory = seedInventory(corpus);

  test("every fixture names at least one acceptance", () => {
    const known = new Set<string>(Object.values(SEED_ACCEPTANCES));
    for (const fixture of corpus.fixtures) {
      expect(fixture.acceptances.length).toBeGreaterThan(0);
      for (const acceptance of fixture.acceptances) expect(known.has(acceptance)).toBe(true);
    }
  });

  test("every declared acceptance is claimed by a fixture", () => {
    const claimed = new Set(inventory.acceptances);
    for (const acceptance of Object.values(SEED_ACCEPTANCES)) {
      expect(claimed.has(acceptance)).toBe(true);
    }
  });

  test("multi-user, multi-device, multi-session — including the empty arms", () => {
    expect(inventory.users).toBeGreaterThanOrEqual(5);
    expect(inventory.sessions).toBeGreaterThanOrEqual(10);
    // A person with no device at all, and a device that has never reported.
    expect(corpus.users.some((u) => u.devices.length === 0)).toBe(true);
    expect(corpus.users.some((u) => u.devices.some((d) => d.lastSeenAt === null))).toBe(true);
    // Somebody with two machines, so per-person device collapse is exercised.
    expect(corpus.users.some((u) => u.devices.length > 1)).toBe(true);
  });

  test("every ingest_channel arm is present, NULL included", () => {
    for (const channel of ["tunnel", "gateway", "reconciled", "unknown"]) {
      expect(inventory.sessionsByChannel[channel]).toBeGreaterThan(0);
    }
    expect(corpus.sessions.some((s) => s.ingestChannel === null)).toBe(true);
  });

  test("all four broken-residency fixtures exist", () => {
    const kinds = corpus.faults.map((f) => f.kind).sort();
    expect(kinds).toEqual([
      "byte_mismatch",
      "missing_object",
      "orphaned_staging",
      "tombstoned_present_in_target",
    ]);
  });

  test("the missing-object fault really has no canonical object", () => {
    const fault = corpus.faults.find((f) => f.kind === "missing_object");
    const name = `${fault?.session.userExternalId}/${fault?.session.family}/${fault?.session.sessionId}/log.jsonl`;
    expect(corpus.objects.some((o) => o.bucket === "primary" && o.objectName === name)).toBe(false);
    expect(corpus.sessions.some((s) => s.sessionId === fault?.session.sessionId)).toBe(true);
  });

  test("the byte-mismatch fault disagrees with its row", () => {
    const fault = corpus.faults.find((f) => f.kind === "byte_mismatch");
    const session = corpus.sessions.find((s) => s.sessionId === fault?.session.sessionId);
    const name = `${session?.userExternalId}/${session?.family}/${session?.sessionId}/log.jsonl`;
    const object = corpus.objects.find((o) => o.bucket === "primary" && o.objectName === name);
    expect(object).toBeDefined();
    expect(Buffer.byteLength(object?.text ?? "")).not.toBe(session?.bytesUploaded);
  });

  test("the orphaned staging chunk belongs to no session row", () => {
    const fault = corpus.faults.find((f) => f.kind === "orphaned_staging");
    expect(corpus.sessions.some((s) => s.sessionId === fault?.session.sessionId)).toBe(false);
    expect(corpus.objects.some((o) => o.objectName.includes("/.staging/"))).toBe(true);
  });

  test("the tombstoned session is still present in the migration target", () => {
    const fault = corpus.faults.find((f) => f.kind === "tombstoned_present_in_target");
    const name = `${fault?.session.userExternalId}/${fault?.session.family}/${fault?.session.sessionId}/log.jsonl`;
    expect(corpus.tombstones.some((t) => t.sessionId === fault?.session.sessionId)).toBe(true);
    expect(corpus.objects.some((o) => o.bucket === "secondary" && o.objectName === name)).toBe(true);
  });

  test("the migration fixture has a partially-populated target", () => {
    expect(corpus.migration.copied.length).toBeGreaterThan(0);
    expect(corpus.migration.copied).not.toContain(corpus.migration.checksumAbort);
    expect(inventory.objects.secondary).toBeGreaterThan(0);
    expect(inventory.objects.primary).toBeGreaterThan(inventory.objects.secondary);
  });

  test("the roster is a payload of ACTIVE members only", () => {
    const rostered = corpus.users.filter((u) => u.rostered).map((u) => u.externalId).sort();
    expect(corpus.roster.members.map((m) => m.externalId).sort()).toEqual(rostered);
    // Somebody the roster does not know is still ingested here — the funnel's
    // non-rostered arm.
    expect(corpus.users.some((u) => !u.rostered)).toBe(true);
    for (const member of corpus.roster.members) expect(Array.isArray(member.teams)).toBe(true);
  });
});

describe("materialization", () => {
  test("writes objects per bucket plus the roster payload", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hx-seed-"));
    try {
      const corpus = buildSeedCorpus();
      const written = await materializeSeed(dir, corpus);
      expect(written.objects).toBe(corpus.objects.length);
      const roster: unknown = JSON.parse(await readFile(written.rosterFile, "utf8"));
      expect((roster as { members: unknown[] }).members.length).toBe(corpus.roster.members.length);
      const first = corpus.objects[0];
      const onDisk = await stat(path.join(dir, "objects", first.bucket, first.objectName));
      expect(onDisk.size).toBe(Buffer.byteLength(first.text));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a writer never escapes its bucket directory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hx-seed-"));
    try {
      const writer = directoryObjectWriter(path.join(dir, "objects"));
      await expect(writer.put("primary", "../../escaped.jsonl", "x")).rejects.toThrow(
        /refusing to write outside/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("applySeedObjects hands every object to the writer once", async () => {
    const seen: string[] = [];
    const count = await applySeedObjects(buildSeedCorpus(), {
      async put(bucket, objectName) {
        seen.push(`${bucket}:${objectName}`);
      },
    });
    expect(seen.length).toBe(count);
    expect(new Set(seen).size).toBe(count);
  });
});

describe("the dev gate", () => {
  test("refuses without the development opt-in", () => {
    const verdict = devGateVerdict({ env: {}, enrolled: false });
    expect(verdict).toEqual({ ok: false, reason: DEV_DISABLED_REFUSAL });
  });

  test("a release build never reports enrollment state", () => {
    const verdict = devGateVerdict({ env: {}, enrolled: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.reason).toBe(DEV_DISABLED_REFUSAL);
  });

  test("refuses on an enrolled fortress even with the opt-in", () => {
    const verdict = devGateVerdict({ env: { FORTRESS_DEV: "1" }, enrolled: true });
    expect(verdict).toEqual({ ok: false, reason: DEV_ENROLLED_REFUSAL });
  });

  test("allows a development, unenrolled fortress", () => {
    expect(devGateVerdict({ env: { FORTRESS_DEV: "1" }, enrolled: false })).toEqual({ ok: true });
  });
});

describe("the dev verb group", () => {
  async function run(args: string[], env: Record<string, string | undefined>, enrolled: boolean) {
    const lines: string[] = [];
    const dir = await mkdtemp(path.join(os.tmpdir(), "hx-seed-cli-"));
    const code = await runDevCommand(args, {
      writeLine: (line) => lines.push(line),
      env,
      fortressRoot: dir,
      isEnrolled: async () => enrolled,
    });
    return { code, out: lines.join("\n"), dir };
  }

  test("seed refuses on a release build and writes nothing", async () => {
    const { code, out, dir } = await run(["seed"], {}, false);
    try {
      expect(code).toBe(1);
      expect(out).toContain(DEV_DISABLED_REFUSAL);
      await expect(stat(path.join(dir, "dev"))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("seed refuses on an enrolled fortress and writes nothing", async () => {
    const { code, out, dir } = await run(["seed"], { FORTRESS_DEV: "1" }, true);
    try {
      expect(code).toBe(1);
      expect(out).toContain(DEV_ENROLLED_REFUSAL);
      await expect(stat(path.join(dir, "dev"))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("seed materializes under the fortress root and names its acceptances", async () => {
    const { code, out, dir } = await run(["seed"], { FORTRESS_DEV: "1" }, false);
    try {
      expect(code).toBe(0);
      expect(out).toContain(SEED_ACCEPTANCES.rosterLands);
      expect(out).toContain("residency-tombstoned-present-in-target");
      const written = await stat(path.join(dir, "dev", "seed", "roster-sync.json"));
      expect(written.isFile()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("inventory reports without writing", async () => {
    const { code, out, dir } = await run(["inventory"], { FORTRESS_DEV: "1" }, false);
    try {
      expect(code).toBe(0);
      expect(out).toContain("people");
      await expect(stat(path.join(dir, "dev"))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
