import { describe, expect, test } from "bun:test";

import { GcsStore } from "../src/modules/session-vault/store/gcs-store";
import { canonicalObject, stagingObject } from "../src/modules/session-vault/store/keys";
import type { SessionKey } from "../src/modules/session-vault/store/types";

// GCS Compose is a READ-MODIFY-WRITE on a mutable object. Two commits that both
// observe generation N both compose onto N, and the loser's bytes are acked to its
// client and then overwritten. The bucket is versioned, so the orphaned generation
// survives and the canonical still resolves — the loss is SILENT, and invisible to
// every byte gate because the watermark advanced anyway. These tests pin the
// preconditions that make that race impossible.

const KEY: SessionKey = { userId: "u-1", family: "claude-cli", sessionId: "s-1" };

interface Obj {
  size: number;
  generation: number;
  cc: number;
}
type Call = { op: string; src?: string; dest?: string; ifGen?: number | string };

/** A bucket that enforces ifGenerationMatch the way GCS does, and records calls. */
function fakeWorld(opts?: { compactionFails?: boolean; loseComposeResponse?: boolean }) {
  const objects = new Map<string, Obj>();
  const calls: Call[] = [];
  let nextGen = 100;
  const precondition = (name: string, ifGen: number | string | undefined) => {
    if (ifGen === undefined) return;
    const have = objects.get(name)?.generation ?? 0;
    if (Number(ifGen) !== have) {
      const err = new Error("Precondition Failed") as Error & { code: number };
      err.code = 412;
      throw err;
    }
  };
  const file = (name: string) => ({
    name,
    async getMetadata() {
      const o = objects.get(name);
      if (!o) {
        const err = new Error("No such object") as Error & { code: number };
        err.code = 404;
        throw err;
      }
      return [{ size: String(o.size), generation: String(o.generation), componentCount: o.cc }];
    },
    async exists() {
      return [objects.has(name)];
    },
    async copy(dest: { name: string }, o?: { preconditionOpts?: { ifGenerationMatch?: number } }) {
      const ifGen = o?.preconditionOpts?.ifGenerationMatch;
      calls.push({ op: "copy", src: name, dest: dest.name, ifGen });
      if (opts?.compactionFails && name.includes(".compact-")) {
        throw new Error("copy timed out");
      }
      precondition(dest.name, ifGen);
      const src = objects.get(name);
      if (!src) throw new Error(`copy from missing ${name}`);
      objects.set(dest.name, { size: src.size, generation: (nextGen += 1), cc: 1 });
    },
    async delete() {
      calls.push({ op: "delete", src: name });
      objects.delete(name);
    },
  });
  const bucket = {
    file,
    async combine(
      sources: Array<{ name: string }>,
      dest: { name: string },
      o?: { ifGenerationMatch?: number },
    ) {
      calls.push({ op: "combine", dest: dest.name, ifGen: o?.ifGenerationMatch });
      precondition(dest.name, o?.ifGenerationMatch);
      const total = sources.reduce((n, s) => n + (objects.get(s.name)?.size ?? 0), 0);
      const cc = sources.reduce((n, s) => n + (objects.get(s.name)?.cc ?? 1), 0);
      objects.set(dest.name, { size: total, generation: (nextGen += 1), cc });
      if (opts?.loseComposeResponse && calls.filter((c) => c.op === "combine").length === 1) {
        // The write LANDED and the response did not come back — what the SDK's
        // noResponseRetries turns into a retry, and what GCS then answers 412 to
        // because our own first attempt moved the generation.
        const err = new Error("Precondition Failed") as Error & { code: number };
        err.code = 412;
        throw err;
      }
    },
  };
  return { objects, calls, bucket };
}

function storeWith(bucket: unknown): GcsStore {
  const store = new GcsStore({ projectId: "p", bucketName: "b" });
  (store as unknown as { _bucket: unknown })._bucket = bucket;
  return store;
}

describe("GCS compose is generation-conditioned", () => {
  const canonical = canonicalObject(KEY);
  const staging = (id: string) => stagingObject(KEY, id);

  test("a FIRST chunk may only create — never clobber a racing winner", async () => {
    const w = fakeWorld();
    w.objects.set(staging("c1"), { size: 10, generation: 1, cc: 1 });
    const res = await storeWith(w.bucket).appendChunkToCanonical(KEY, "c1");

    const copy = w.calls.find((c) => c.op === "copy");
    // 0 is GCS's "only if this object does not exist". Unconditioned, the loser of
    // a first-chunk race overwrites the winner's canonical wholesale.
    expect(copy?.ifGen).toBe(0);
    expect(res.totalBytes).toBe(10);
  });

  test("an APPEND composes only onto the generation it read", async () => {
    const w = fakeWorld();
    w.objects.set(canonical, { size: 100, generation: 777, cc: 5 });
    w.objects.set(staging("c2"), { size: 20, generation: 1, cc: 1 });

    const res = await storeWith(w.bucket).appendChunkToCanonical(KEY, "c2");
    const combine = w.calls.find((c) => c.op === "combine");
    expect(combine?.ifGen).toBe(777);
    expect(res.totalBytes).toBe(120);
    expect(res.componentCount).toBe(6);
  });

  test("a LOST generation race retries against what is there now, and keeps staging", async () => {
    const w = fakeWorld();
    w.objects.set(canonical, { size: 100, generation: 777, cc: 5 });
    w.objects.set(staging("c3"), { size: 20, generation: 1, cc: 1 });

    // A competing commit lands between our getMetadata and our combine.
    const realCombine = w.bucket.combine.bind(w.bucket);
    let first = true;
    w.bucket.combine = async (sources, dest, o) => {
      if (first) {
        first = false;
        w.objects.set(canonical, { size: 150, generation: 888, cc: 7 });
      }
      return realCombine(sources, dest, o);
    };

    const res = await storeWith(w.bucket).appendChunkToCanonical(KEY, "c3");
    const combines = w.calls.filter((c) => c.op === "combine");
    expect(combines.map((c) => c.ifGen)).toEqual([777, 888]);
    // Deleting staging before a write LANDS would strand the chunk on retry.
    const firstDelete = w.calls.findIndex((c) => c.op === "delete");
    const lastCombine = w.calls.map((c) => c.op).lastIndexOf("combine");
    expect(firstDelete).toBeGreaterThan(lastCombine);
    expect(res.totalBytes).toBe(170); // composed onto the WINNER, nothing lost
  });

  test("compaction failure must not fail an append whose bytes are already durable", async () => {
    const w = fakeWorld({ compactionFails: true });
    // Past the 800 threshold, so compaction is attempted and (here) throws.
    w.objects.set(canonical, { size: 100, generation: 500, cc: 900 });
    w.objects.set(staging("c4"), { size: 20, generation: 1, cc: 1 });

    const res = await storeWith(w.bucket).appendChunkToCanonical(KEY, "c4");
    // The compose landed and is acked. Throwing here would make the client retry a
    // chunk the canonical already holds — appending the same bytes twice.
    expect(res.totalBytes).toBe(120);
    expect(res.componentCount).toBe(901); // reported un-compacted, so a detector can see it
  });

  test("compaction overwrites only the generation it snapshotted", async () => {
    const w = fakeWorld();
    w.objects.set(canonical, { size: 100, generation: 500, cc: 900 });
    w.objects.set(staging("c5"), { size: 20, generation: 1, cc: 1 });

    const res = await storeWith(w.bucket).appendChunkToCanonical(KEY, "c5");
    const back = w.calls.filter((c) => c.op === "copy" && c.dest === canonical);
    expect(back).toHaveLength(1);
    // Unconditioned, this write would silently discard every append that landed
    // while the snapshot was being taken — the widest loss window in the path.
    expect(typeof back[0]!.ifGen).toBe("number");
    expect(res.componentCount).toBe(1); // compaction reset the counter
  });
});

describe("a 412 is interrogated, not assumed to be someone else's write", () => {
  const canonical = canonicalObject(KEY);
  const staging = (id: string) => stagingObject(KEY, id);

  test("our own landed-but-unacked compose must NOT be composed again", async () => {
    // Setting ifGenerationMatch makes the SDK retry compose (Bucket#combine zeroes its
    // retries ONLY when no precondition is set, and util.js then overrides both
    // `retries` and `noResponseRetries` from that). So a compose that lands while its
    // response is lost gets retried, GCS answers 412, and reading that as "someone else
    // won" appends the same chunk twice — into the source of truth, where every rebuild
    // reproduces it.
    const w = fakeWorld({ loseComposeResponse: true });
    w.objects.set(canonical, { size: 100, generation: 777, cc: 5 });
    w.objects.set(staging("c6"), { size: 20, generation: 1, cc: 1 });

    const res = await storeWith(w.bucket).appendChunkToCanonical(KEY, "c6");

    // Exactly ONE append of 20 bytes is reflected, not two.
    expect(res.totalBytes).toBe(120);
    expect(w.objects.get(canonical)!.size).toBe(120);
    // And it did not blindly re-compose after the 412.
    expect(w.calls.filter((c) => c.op === "combine")).toHaveLength(1);
    // Staging is still cleaned up, so a client retry cannot re-send it either.
    expect(w.objects.has(staging("c6"))).toBe(false);
  });

  test("a 412 from a DIFFERENT writer still retries against the winner", async () => {
    // The discriminator must not swallow genuine races: a foreign write of a different
    // size is not ours, and the append must rebuild on top of it.
    const w = fakeWorld();
    w.objects.set(canonical, { size: 100, generation: 777, cc: 5 });
    w.objects.set(staging("c7"), { size: 20, generation: 1, cc: 1 });
    const real = w.bucket.combine.bind(w.bucket);
    let first = true;
    w.bucket.combine = async (sources, dest, o) => {
      if (first) {
        first = false;
        w.objects.set(canonical, { size: 555, generation: 888, cc: 9 }); // not 100+20
      }
      return real(sources, dest, o);
    };
    const res = await storeWith(w.bucket).appendChunkToCanonical(KEY, "c7");
    expect(w.calls.filter((c) => c.op === "combine")).toHaveLength(2);
    expect(res.totalBytes).toBe(575); // composed onto the winner
  });
});
