// What a REPLAYED sidecar does to the one already in the bucket.
//
// A parked sidecar is a whole composition the gateway made from the sidecar as
// it stood before the pause — not a delta. Reads stay open through a pause, so
// every deferred commit in one episode composed from the SAME pre-pause text,
// and replaying those verbatim let the last one erase everything the earlier
// ones had added. The merge is what makes a replay additive again.

import { describe, expect, test } from "bun:test";

import {
  mergeReplayedMetadata,
  parseSessionMetadata,
} from "../src/modules/session-vault/store/session-metadata";
import type { SessionMetadata } from "../src/modules/session-vault/store/types";

function meta(over: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    family: "claude",
    sessionId: "s1",
    title: null,
    titleSource: null,
    bytesUploaded: 0,
    eventCount: 0,
    userTextCount: 0,
    assistantCount: 0,
    lastActivityAt: null,
    firstSeenAt: "2026-08-05T04:00:00.000Z",
    updatedAt: "2026-08-05T04:00:00.000Z",
    cwd: null,
    gitBranch: null,
    sourcePath: null,
    repoSlug: null,
    deviceName: null,
    ...over,
  };
}

describe("mergeReplayedMetadata", () => {
  test("a later replay never erases what an earlier one set", () => {
    // Two commits inside one pause: the first carries the title (an hx client
    // titles a from-zero upload), the second does not — and composed from the
    // same pre-pause text, so its own title field is null.
    const afterFirst = meta({
      title: "Fixing the migration",
      titleSource: "ai",
      eventCount: 17,
      bytesUploaded: 900,
      lastActivityAt: "2026-08-05T04:01:00.000Z",
      updatedAt: "2026-08-05T04:01:00.000Z",
      cwd: "/w/repo",
    });
    const second = meta({
      eventCount: 31,
      bytesUploaded: 1500,
      lastActivityAt: "2026-08-05T04:02:00.000Z",
      firstSeenAt: "2026-08-05T04:02:00.000Z",
      updatedAt: "2026-08-05T04:02:00.000Z",
    });

    const merged = mergeReplayedMetadata(afterFirst, second);
    expect(merged.title).toBe("Fixing the migration");
    expect(merged.titleSource).toBe("ai");
    expect(merged.cwd).toBe("/w/repo");
    // Counts move forward only.
    expect(merged.eventCount).toBe(31);
    expect(merged.bytesUploaded).toBe(1500);
    expect(merged.lastActivityAt).toBe("2026-08-05T04:02:00.000Z");
    // …and first-seen moves backward only.
    expect(merged.firstSeenAt).toBe("2026-08-05T04:00:00.000Z");
  });

  test("an OUT-OF-ORDER replay does not regress the bucket", () => {
    // The ordering by parkedAt is a belt; this is the brace. Replaying the older
    // composition after the newer one must still leave the newer facts standing.
    const newer = meta({ eventCount: 31, lastActivityAt: "2026-08-05T04:02:00.000Z" });
    const older = meta({ eventCount: 17, lastActivityAt: "2026-08-05T04:01:00.000Z", title: "T" });
    const merged = mergeReplayedMetadata(newer, older);
    expect(merged.eventCount).toBe(31);
    expect(merged.lastActivityAt).toBe("2026-08-05T04:02:00.000Z");
    // …while still recovering what only the older one carried.
    expect(merged.title).toBe("T");
  });

  test("nothing in the bucket means the replay lands as parked", () => {
    const only = meta({ title: "T", eventCount: 3 });
    expect(mergeReplayedMetadata(null, only)).toEqual(only);
  });

  test("a REPLACE is authoritative — its totals may legitimately be smaller", () => {
    // The gateway composes a replace's totals verbatim, and the hub's
    // destination bookkeeping says the same: "a canonical really can shrink".
    // Merging them forward pinned the sidecar to the pre-replace numbers.
    const bucket = meta({ bytesUploaded: 4096, eventCount: 42, title: "old" });
    const replaced = meta({
      bytesUploaded: 120,
      eventCount: 2,
      title: "new",
      updatedAt: "2026-08-05T04:05:00.000Z",
    });
    const merged = mergeReplayedMetadata(bucket, replaced, true);
    expect(merged.bytesUploaded).toBe(120);
    expect(merged.eventCount).toBe(2);
    expect(merged.title).toBe("new");
    // …and an APPEND still moves forward only.
    expect(mergeReplayedMetadata(bucket, replaced, false).eventCount).toBe(42);
  });

  test("a replace that is OLDER than the bucket does not walk it back", () => {
    // A replace is authoritative over what it superseded, not over whatever is
    // in the bucket now — and a parked sidecar waits out the pause and any
    // migration, hours on a real one, with writes open throughout. Taking it
    // verbatim then reverted the customer's only copy to a pre-pause snapshot.
    const bucket = meta({
      title: "Q3 payroll audit",
      titleSource: "user",
      bytesUploaded: 940_000,
      eventCount: 812,
      updatedAt: "2026-08-05T09:30:00.000Z",
      lastActivityAt: "2026-08-05T09:30:00.000Z",
    });
    const staleReplace = meta({
      title: "re-upload",
      titleSource: "ai",
      bytesUploaded: 120,
      eventCount: 2,
      updatedAt: "2026-08-05T04:01:00.000Z",
      lastActivityAt: "2026-08-05T04:01:00.000Z",
    });
    const merged = mergeReplayedMetadata(bucket, staleReplace, true);
    expect(merged.eventCount).toBe(812);
    expect(merged.bytesUploaded).toBe(940_000);
    expect(merged.title).toBe("Q3 payroll audit");
    expect(merged.titleSource).toBe("user");

    // A replace that IS the later statement still wins outright.
    const freshReplace = meta({ ...staleReplace, updatedAt: "2026-08-05T10:00:00.000Z" });
    expect(mergeReplayedMetadata(bucket, freshReplace, true).eventCount).toBe(2);
  });

  test("a re-stated title does not downgrade its provenance", () => {
    // The pair fired on "incoming has a title" rather than "incoming has a
    // DIFFERENT title", so a legacy sidecar re-stating the same text with no
    // source dropped a `user` provenance to null.
    const merged = mergeReplayedMetadata(
      meta({ title: "same title", titleSource: "user" }),
      meta({ title: "same title", titleSource: null }),
    );
    expect(merged.title).toBe("same title");
    expect(merged.titleSource).toBe("user");
  });

  test("title and its PROVENANCE move together", () => {
    // Resolved from different sides, an AI-derived title ended up labelled
    // operator-set: the source is a claim about the value, not a value of its
    // own.
    const merged = mergeReplayedMetadata(
      meta({ title: "Q3 payroll", titleSource: "ai" }),
      meta({ title: null, titleSource: "user" }),
    );
    expect(merged.title).toBe("Q3 payroll");
    expect(merged.titleSource).toBe("ai");

    // …and the direction the `??` pair could not fail on, because it
    // short-circuits on its first operand: the bucket holds the WINNING title
    // with no provenance, and the stale replay carries a different title that
    // an operator really did type. Crossed, the sidecar asserts that somebody
    // named a title they never typed — and `titleSource` is what the corrective
    // pass keys on, so the false `user` is self-pinning.
    const crossed = mergeReplayedMetadata(
      meta({
        title: "Kubernetes upgrade plan",
        titleSource: null,
        updatedAt: "2026-08-05T12:00:00.000Z",
      }),
      meta({ title: "My private notes", titleSource: "user", updatedAt: "2026-08-05T09:00:00.000Z" }),
    );
    expect(crossed.title).toBe("Kubernetes upgrade plan");
    expect(crossed.titleSource).toBeNull();
  });

  test("a TIE on updatedAt falls to the bucket", () => {
    // A replay is never the newer statement on a tie: the parked composition was
    // made before the pause, so anything the bucket holds carrying the same
    // stamp landed at least as late. Resolving a tie toward the replay let a
    // parked replace discard a newer append's totals outright.
    const stamp = "2026-08-05T12:00:00.000Z";
    const bucket = meta({ bytesUploaded: 5000, eventCount: 500, title: "Appended title", updatedAt: stamp });
    const parked = meta({ bytesUploaded: 40, eventCount: 4, title: null, updatedAt: stamp });
    const merged = mergeReplayedMetadata(bucket, parked, true);
    expect(merged.bytesUploaded).toBe(5000);
    expect(merged.eventCount).toBe(500);
    expect(merged.title).toBe("Appended title");
  });

  test("a stale replay does not walk back the working directory, branch or device", () => {
    // The five descriptive fields took `incoming` unconditionally, so the exact
    // rewind the title and the replace arm are guarded against still landed on
    // them — and on a session list they are just as visible.
    const bucket = meta({
      updatedAt: "2026-08-05T12:00:00.000Z",
      cwd: "/home/dev/current-repo",
      gitBranch: "release/2.0",
      repoSlug: "acme/current",
      sourcePath: "/new/path.jsonl",
      deviceName: "workstation",
    });
    const stale = meta({
      updatedAt: "2026-08-05T09:00:00.000Z",
      cwd: "/home/dev/old-repo",
      gitBranch: "main",
      repoSlug: "acme/old",
      sourcePath: "/old/path.jsonl",
      deviceName: "laptop-1",
    });
    const merged = mergeReplayedMetadata(bucket, stale);
    expect(merged.cwd).toBe("/home/dev/current-repo");
    expect(merged.gitBranch).toBe("release/2.0");
    expect(merged.repoSlug).toBe("acme/current");
    expect(merged.sourcePath).toBe("/new/path.jsonl");
    expect(merged.deviceName).toBe("workstation");

    // The loser still fills a genuine absence, in both directions.
    expect(mergeReplayedMetadata(meta({ ...bucket, cwd: null }), stale).cwd).toBe("/home/dev/old-repo");
    expect(mergeReplayedMetadata(stale, meta({ ...bucket, cwd: null })).cwd).toBe("/home/dev/old-repo");
  });

  test("an unorderable stamp in the bucket is healed, not propagated", () => {
    // Every ordering test here is a Date.parse, and every comparison against NaN
    // is false — so a bucket row whose stamp cannot be read would pin itself
    // forever AND lock out the replace that could correct it. This merge is the
    // one writer that reads what it finds rather than composing fresh, so it is
    // the one place positioned to fix it.
    const torn = meta({ updatedAt: "not-a-date", firstSeenAt: "also-not-a-date", title: "Stuck" });
    const good = meta({
      updatedAt: "2026-08-05T12:00:00.000Z",
      firstSeenAt: "2026-08-05T11:00:00.000Z",
      title: "Real title",
      titleSource: "ai",
    });
    const merged = mergeReplayedMetadata(torn, good);
    expect(merged.updatedAt).toBe("2026-08-05T12:00:00.000Z");
    expect(merged.firstSeenAt).toBe("2026-08-05T11:00:00.000Z");
    expect(merged.title).toBe("Real title");
    expect(merged.titleSource).toBe("ai");
    // …and a replace can now correct it outright.
    expect(mergeReplayedMetadata(torn, good, true).updatedAt).toBe("2026-08-05T12:00:00.000Z");
    // The reverse still holds: a readable bucket is not overwritten by a torn
    // replay's stamps.
    const back = mergeReplayedMetadata(good, torn);
    expect(back.updatedAt).toBe("2026-08-05T12:00:00.000Z");
    expect(back.firstSeenAt).toBe("2026-08-05T11:00:00.000Z");
  });

  test("the merge is over PARSED metadata, so a torn sidecar is not merged into", () => {
    expect(parseSessionMetadata(JSON.parse("null"))).toBeNull();
    expect(parseSessionMetadata({ family: "claude" })).toBeNull();
    // The shape this test's title actually claims: unparseable TEXT, which is
    // what a torn object in the bucket is. It must not throw — the replay
    // callback treats an unreadable current as absent rather than re-parking the
    // entry forever.
    expect(() => JSON.parse("{ not json")).toThrow();
    const readTorn = (raw: string | null): ReturnType<typeof parseSessionMetadata> => {
      try {
        return parseSessionMetadata(JSON.parse(raw ?? "null") as unknown);
      } catch {
        return null;
      }
    };
    expect(readTorn("{ not json")).toBeNull();
    expect(readTorn(null)).toBeNull();
  });
});
