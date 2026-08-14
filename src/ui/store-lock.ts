// The single-writer protocol for the console's two state files, <root>/ui/users.json
// and <root>/ui/ui.json.
//
// Both are read LIVE — the ui server re-reads them per request, the container
// supervisor per tick, the daemon per connection attempt — while the CLI writes
// them from a different process entirely. So a writer cannot simply rewrite the
// file: it takes an O_EXCL lock, re-reads under it, and renames a complete
// replacement into place with a monotonically increasing `version`. A concurrent
// writer that advanced the version between the read and the rename loses the CAS
// and retries, so no write is silently dropped.
//
// The lock is LIVENESS-AWARE, deliberately. A lock nobody can clear blocks
// sign-in, every CLI verb and the console's own enablement flip — worse than the
// interleaving it prevents. A lock whose owner is gone is reclaimed at once, one
// whose owner is merely slow only after it is provably older than any real
// critical section, and every reclaim is REPORTED so the caller can audit it.
// `--force-unlock` is the documented escape when even that is not enough.
//
// A file that does not parse is never rebuilt from a whitelist: the writer
// refuses and names the remediation. Rebuilding would silently drop the keys the
// parser does not know about — which on users.json means dropping accounts.

import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** Identifies THIS process in a lock file, so a stale lock can name its owner. */
const BOOT_ID = randomUUID();

/** A lock held longer than this — by an owner that is still ALIVE — is treated
 *  as abandoned. Well above the ~150ms an argon2id hash costs inside a user-store
 *  write. */
export const LOCK_STALE_MS = 10_000;
/** How long a writer waits for a live lock before refusing. */
export const LOCK_WAIT_MS = 5_000;
/** CAS attempts before the write fails loudly. Retrying forever turns a
 *  contended verb into a hang with no diagnostic. */
export const MAX_CAS_RETRIES = 5;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface LockOwner {
  pid: number;
  bootId: string;
  at: string;
}

/** What a reclaim looked like, for the audit record. Never thrown away silently. */
export interface LockReclaim {
  owner: LockOwner | null;
  reason: "owner-gone" | "stale" | "unreadable";
}

export type StoreState = "absent" | "ok" | "corrupt";

export interface StoreRead<T> {
  state: StoreState;
  doc: T | null;
}

export interface JsonCasStoreOptions<T> {
  /** Absolute path to the JSON file. */
  file: string;
  /** Name used in error messages — the file the operator has to fix. */
  label: string;
  /** Returns null for a document that parsed as JSON but is not this shape.
   *  Null is CORRUPT, never "absent": a half-written file must refuse, not reset. */
  parse: (raw: unknown) => T | null;
  /** Reported when a lock is reclaimed. */
  onReclaim?: (reclaim: LockReclaim) => void;
}

export class StoreCorruptError extends Error {
  constructor(label: string, file: string) {
    super(
      `${label} at ${file} is not readable as JSON. Nothing was written. ` +
        `Restore it from a backup, or move it aside and re-create the accounts it held — ` +
        `it is never rebuilt automatically, because a rebuild would drop every key this build does not know about.`,
    );
    this.name = "StoreCorruptError";
  }
}

export class StoreLockedError extends Error {
  constructor(label: string, owner: LockOwner | null) {
    super(
      `${label} is locked by another writer${owner ? ` (pid ${owner.pid}, since ${owner.at})` : ""}. ` +
        `Retry; if it never clears, pass --force-unlock.`,
    );
    this.name = "StoreLockedError";
  }
}

function lockPathFor(file: string): string {
  return `${file}.lock`;
}

function parseOwner(raw: string): LockOwner | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const owner = value as Record<string, unknown>;
    if (typeof owner.pid !== "number" || typeof owner.bootId !== "string") return null;
    return { pid: owner.pid, bootId: owner.bootId, at: String(owner.at ?? "") };
  } catch {
    return null;
  }
}

/** True when a pid is running. A pid this process may not signal still counts as
 *  alive — EPERM means something holds it. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a lock somebody else holds may be taken, and why. Null means respect
 * it.
 *
 * THE one stale-lock rule in this build, for every file that uses the protocol.
 * Liveness first, then age: a lock whose owner is GONE is reclaimed at once,
 * because waiting out a timer for a process that no longer exists blocks a verb
 * for nothing; a lock whose owner is still running is respected until it is
 * provably older than any real critical section. Two copies of this rule is how
 * one file ends up waiting a timer the other does not.
 */
export async function reclaimableLock(lock: string): Promise<LockReclaim | null> {
  // ONE open, then both facts off that handle. Resolving the path twice — stat
  // it, then read it — let the two answers describe DIFFERENT files: the holder
  // releases and a new owner takes the lock in between, and the age test then
  // runs the departed holder's mtime against the newcomer's identity and calls
  // a lock that is seconds old stale. Reclaiming a live lock is the one outcome
  // this protocol exists to prevent, since every writer above it (users.json,
  // ui.json, the credential store) rests on single-writer.
  const held = await open(lock, "r").catch(() => null);
  if (!held) return null; // vanished — the retry will take it
  try {
    const [info, text] = await Promise.all([
      held.stat(),
      held.readFile("utf8").catch(() => ""),
    ]);
    const owner = parseOwner(text);
    if (!owner) return { owner: null, reason: "unreadable" };
    if (owner.bootId !== BOOT_ID && !pidAlive(owner.pid)) {
      return { owner, reason: "owner-gone" };
    }
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) return { owner, reason: "stale" };
    return null;
  } finally {
    await held.close().catch(() => {});
  }
}

/** Remove a lock file whatever its state. The `--force-unlock` implementation. */
export async function forceUnlock(file: string): Promise<boolean> {
  try {
    await unlink(lockPathFor(file));
    return true;
  } catch {
    return false;
  }
}

/**
 * A JSON document guarded by the protocol above. Readers are free (and lock-free);
 * every writer goes through `update`.
 */
export class JsonCasStore<T extends { version?: number }> {
  private readonly opts: JsonCasStoreOptions<T>;

  constructor(options: JsonCasStoreOptions<T>) {
    this.opts = options;
  }

  get file(): string {
    return this.opts.file;
  }

  /** Read without taking the lock. `corrupt` is distinct from `absent`: absent is
   *  a fresh install, corrupt is a file the caller must not overwrite. */
  async read(): Promise<StoreRead<T>> {
    let contents: string;
    try {
      contents = await readFile(this.opts.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent", doc: null };
      return { state: "corrupt", doc: null };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(contents);
    } catch {
      return { state: "corrupt", doc: null };
    }
    const doc = this.opts.parse(raw);
    return doc ? { state: "ok", doc } : { state: "corrupt", doc: null };
  }

  private async acquire(waitMs: number): Promise<void> {
    const lock = lockPathFor(this.opts.file);
    await mkdir(path.dirname(this.opts.file), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + waitMs;
    for (;;) {
      const owner: LockOwner = { pid: process.pid, bootId: BOOT_ID, at: new Date().toISOString() };
      try {
        await writeFile(lock, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const reclaim = await reclaimableLock(lock);
        if (reclaim) {
          await unlink(lock).catch(() => {});
          this.opts.onReclaim?.(reclaim);
          continue;
        }
        if (Date.now() >= deadline) {
          const held = await readFile(lock, "utf8").catch(() => "");
          throw new StoreLockedError(this.opts.label, parseOwner(held));
        }
        await sleep(25);
      }
    }
  }


  private async release(): Promise<void> {
    await unlink(lockPathFor(this.opts.file)).catch(() => {});
  }

  private async writeAtomic(doc: T): Promise<void> {
    await mkdir(path.dirname(this.opts.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.opts.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => {});
    await rename(tmp, this.opts.file);
  }

  /**
   * The ONLY door for mutating the file. Hands `mutate` the current document
   * (null when the file is absent), stamps the next version, and renames the
   * result into place — re-reading immediately before the rename so a writer that
   * ignored the lock is caught rather than overwritten.
   */
  async update(mutate: (current: T | null) => T | Promise<T>, waitMs = LOCK_WAIT_MS): Promise<T> {
    let observed = 0;
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
      await this.acquire(waitMs);
      try {
        const current = await this.read();
        if (current.state === "corrupt") {
          throw new StoreCorruptError(this.opts.label, this.opts.file);
        }
        const expected = versionOf(current.doc);
        const next = await mutate(current.doc);
        const confirm = await this.read();
        if (confirm.state === "corrupt") {
          throw new StoreCorruptError(this.opts.label, this.opts.file);
        }
        if (versionOf(confirm.doc) !== expected) {
          observed = versionOf(confirm.doc);
          continue;
        }
        const written = { ...next, version: expected + 1 };
        await this.writeAtomic(written);
        return written;
      } finally {
        await this.release();
      }
    }
    throw new Error(
      `${this.opts.label} write lost ${MAX_CAS_RETRIES} version races (last observed version ${observed})`,
    );
  }
}

/** An absent or nonsensical `version` reads as 0, so a file written before the
 *  field existed is stamped 1 in place rather than refused. */
export function versionOf(doc: { version?: number } | null): number {
  const v = doc?.version;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
}
