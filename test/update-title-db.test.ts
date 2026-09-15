import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "bun:test";

import { createHxDb, type HxDb } from "../src/host/postgres/db";
import { runMigrations } from "../src/host/postgres/migrate";
import { migrations } from "../src/host/postgres/migrations/manifest";
import { makeMigrationExec } from "../src/host/postgres/sql-exec";
import { updateSessionTitle } from "../src/ingest/update-title";
import { hxSessions } from "../src/host/postgres/schema/sessions";
import { hxUsers } from "../src/host/postgres/schema/dimensions";
import type { SessionKey } from "../src/modules/session-vault/store/types";

// LETAIR-481 · bytes-free title backfill, exercised against a real hx schema.
// Pins the CAS contract the daemon/queue relies on: a fallback/empty/null title
// is UPGRADED ("applied"), a real user/AI title is LEFT ("noop"), and a missing
// or soft-deleted row is "absent" (never inserted, never resurrected).
const DSN = process.env.FORTRESS_DATABASE_URL;

describe.skipIf(!DSN)("updateSessionTitle — bytes-free title backfill (LETAIR-481)", () => {
  const dsn = DSN as string;
  let db: HxDb;
  beforeAll(async () => {
    await runMigrations(makeMigrationExec(dsn), migrations);
    db = createHxDb(dsn);
  });

  // Seed one minimal valid session row; only title/titleSource/deleted vary.
  const seed = async (opts: {
    title: string | null;
    titleSource: "user" | "ai" | "fallback" | null;
    deleted?: boolean;
  }): Promise<SessionKey> => {
    const ext = `ut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [u] = await db.insert(hxUsers).values({ externalId: ext }).returning({ id: hxUsers.id });
    const key: SessionKey = { userId: ext, family: "codex-cli", sessionId: crypto.randomUUID() };
    await db.insert(hxSessions).values({
      userId: u.id,
      family: key.family,
      sessionId: key.sessionId,
      title: opts.title,
      titleSource: opts.titleSource,
      ...(opts.deleted ? { deletedAt: new Date().toISOString() } : {}),
    });
    return key;
  };

  const titleOf = async (key: SessionKey) => {
    const [row] = await db
      .select({ title: hxSessions.title, titleSource: hxSessions.titleSource })
      .from(hxSessions)
      .innerJoin(hxUsers, eq(hxUsers.id, hxSessions.userId))
      .where(and(eq(hxUsers.externalId, key.userId), eq(hxSessions.sessionId, key.sessionId)))
      .limit(1);
    return row;
  };

  test("upgrades a fallback title (applied)", async () => {
    const key = await seed({ title: "<recommended_plugins>…", titleSource: "fallback" });
    expect(await updateSessionTitle(db, { key, title: "Fix the login bug", titleSource: "ai" })).toBe(
      "applied",
    );
    expect(await titleOf(key)).toEqual({ title: "Fix the login bug", titleSource: "ai" });
  });

  test("upgrades a null/absent title (applied)", async () => {
    const key = await seed({ title: null, titleSource: null });
    expect(await updateSessionTitle(db, { key, title: "My session", titleSource: "user" })).toBe(
      "applied",
    );
    expect(await titleOf(key)).toEqual({ title: "My session", titleSource: "user" });
  });

  test("upgrades an empty-string title (applied)", async () => {
    const key = await seed({ title: "", titleSource: "fallback" });
    expect(await updateSessionTitle(db, { key, title: "Real", titleSource: "ai" })).toBe("applied");
    expect(await titleOf(key)).toEqual({ title: "Real", titleSource: "ai" });
  });

  test("never clobbers a real user title (noop)", async () => {
    const key = await seed({ title: "Renamed by me", titleSource: "user" });
    expect(await updateSessionTitle(db, { key, title: "auto derived", titleSource: "ai" })).toBe(
      "noop",
    );
    expect(await titleOf(key)).toEqual({ title: "Renamed by me", titleSource: "user" });
  });

  test("never clobbers a real ai title (noop)", async () => {
    const key = await seed({ title: "An AI title", titleSource: "ai" });
    expect(await updateSessionTitle(db, { key, title: "something else", titleSource: "ai" })).toBe(
      "noop",
    );
    expect(await titleOf(key)).toEqual({ title: "An AI title", titleSource: "ai" });
  });

  test("no row for the session (absent)", async () => {
    const key: SessionKey = {
      userId: `ut-none-${Date.now()}`,
      family: "codex-cli",
      sessionId: crypto.randomUUID(),
    };
    expect(await updateSessionTitle(db, { key, title: "x", titleSource: "ai" })).toBe("absent");
  });

  test("a soft-deleted session is absent — never resurrected", async () => {
    const key = await seed({ title: null, titleSource: "fallback", deleted: true });
    expect(await updateSessionTitle(db, { key, title: "x", titleSource: "ai" })).toBe("absent");
  });

  test("is idempotent — a second apply of the same title is a noop", async () => {
    const key = await seed({ title: "junk", titleSource: "fallback" });
    expect(await updateSessionTitle(db, { key, title: "First", titleSource: "ai" })).toBe("applied");
    expect(await updateSessionTitle(db, { key, title: "First", titleSource: "ai" })).toBe("noop");
    expect(await titleOf(key)).toEqual({ title: "First", titleSource: "ai" });
  });
});
