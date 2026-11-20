// What every part of a store's object shares: its SQLite database and storage, its files bucket,
// the clock, randomness, and the history it keeps of itself.

import type { JobHandler } from "./jobs/types.js";
import type { LiveSocket } from "./live.js";
import { MeteredSql } from "./metered-sql.js";
import { getMeta } from "./schema.js";
import type { SqlLike } from "./sql.js";
import type { StoreFiles } from "./store-files.js";
import type { SharedWrites, WriteBudget } from "./types.js";

/** The `_meta` key of the organization a caller's token named first (handler.ts `admit`). */
export const ORG_KEY = "org";

/**
 * The storage a store asks its host for. On Cloudflare it is the Durable Object's own
 * (`DurableObjectStorage` has every member here). Another host answers the same calls on a SQLite
 * file of its own, and a test stands in for both.
 */
export interface StoreStorage {
  sql: SqlLike & { readonly databaseSize: number };
  transactionSync<T>(closure: () => T): T;
  deleteAll(): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
  getCurrentBookmark(): Promise<string>;
  getBookmarkForTime(timestamp: number): Promise<string>;
  onNextSessionRestoreBookmark(bookmark: string): Promise<string>;
}

/** The state a store asks its host for: on Cloudflare, the parts of `DurableObjectState` a store uses. */
export interface StoreState {
  readonly storage: StoreStorage;
  abort(reason?: string): void;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  /** The hibernation API's sockets, for live rows (live.ts); a stand-in may have none. */
  acceptWebSocket?(ws: LiveSocket, tags?: string[]): void;
  getWebSockets?(tag?: string): LiveSocket[];
}

/** What a store needs besides its own storage: the bucket its files live in (store-files.ts), and the settings it reads. */
export interface StoreEnv {
  FILES: StoreFiles;
  /** How soon the store parks a LOAD's table a SHAPE read, in seconds (park-time.ts PARK_AFTER_MS when unset). */
  STORES_PARK_AFTER_SECONDS?: string;
  /**
   * The rows a store writes a day (write-limit.ts); 2,000,000 when unset. A store whose host keeps
   * its organization's budget (`StoreDeps.writeBudget`) holds itself to the budget's limit instead,
   * and to this one only until the budget first answers.
   */
  STORE_DAILY_WRITE_LIMIT?: string;
  /** Who may raise the daily write limit, in the deployer's words, added to the refusal past it. */
  STORE_WRITE_LIMIT_HINT?: string;
}

export interface StoreDeps {
  now(): number;
  /** A line for the platform's logs (Workers Logs); a test leaves it out or keeps the lines. */
  log?(line: Record<string, unknown>): void;
  /** `bytes` random bytes, as lowercase hex. */
  randomHex(bytes: number): string;
  /** The job handlers, by kind (jobs/index.ts). */
  jobs: ReadonlyMap<string, JobHandler>;
  /** How long after a SHAPE read a LOAD's table the store parks it (park.ts PARK_AFTER_MS when left out). */
  parkAfterMs?: number;
  /**
   * The daily write budget of an organization, which every store of it shares (write-limit.ts): a
   * deployment's gateway may keep one per organization. A host that keeps none (an app on its own
   * account) leaves it out, and each store holds itself to `STORE_DAILY_WRITE_LIMIT` alone.
   */
  writeBudget?(org: string): WriteBudget;
}

/**
 * What this object last heard from its organization's budget, and what it has not told it yet. Its
 * own memory: a store that wakes asks again before its first write.
 */
export interface BudgetState {
  /** The day, count and limit of the budget's last answer; null before the first. */
  answer: SharedWrites | null;
  /** When that answer came, in epoch ms. */
  answeredAt: number | null;
  /** Rows kept in `_meta` but not yet told to the budget, by UTC day. */
  untold: Map<string, number>;
  /** The report under way, so two never go at once. */
  telling: Promise<void> | null;
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Lowercase hex SHA-256 of text, as drizzle hashes a migration. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A refusal the store answers with a status, a code and plain words. */
export class StoreError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "StoreError";
    this.status = status;
    this.code = code;
  }
}

export class StoreCore {
  readonly state: StoreState;
  readonly env: StoreEnv;
  readonly deps: StoreDeps;
  /** The store's SQL, counting the rows each statement writes (the daily write limit, write-limit.ts). */
  readonly meter: MeteredSql;
  /** What the organization's write budget last answered, and what it has not heard yet (write-limit.ts). */
  readonly budget: BudgetState = { answer: null, answeredAt: null, untold: new Map(), telling: null };

  constructor(state: StoreState, env: StoreEnv, deps: StoreDeps) {
    this.state = state;
    this.env = env;
    this.deps = deps;
    this.meter = new MeteredSql(state.storage.sql);
  }

  /** Every statement of the store goes through here, so each row it writes is counted. */
  get sql(): SqlLike & { readonly databaseSize: number } {
    return this.meter;
  }

  get storage(): StoreStorage {
    return this.state.storage;
  }

  /** The store id this object holds, once a caller named it. */
  get storeId(): string | null {
    return getMeta(this.sql, "store_id");
  }

  /** The organization this store belongs to, once a caller's token named it (handler.ts `admit`). */
  get org(): string | null {
    return getMeta(this.sql, ORG_KEY);
  }

  nowIso(): string {
    return new Date(this.deps.now()).toISOString();
  }

  /** `<prefix>_` and 24 hex digits. */
  newId(prefix: "fil" | "fld" | "job" | "his" | "usr" | "fix"): string {
    return `${prefix}_${this.deps.randomHex(12)}`;
  }

  transaction<T>(closure: () => T): T {
    return this.storage.transactionSync(closure);
  }

  history(event: { kind: "migration" | "table" | "restore" | "job" | "files"; by: string; note: string; restorePoint?: string | null; ref?: string | null; id?: string }): string {
    const id = event.id ?? this.newId("his");
    this.sql.exec(
      "INSERT INTO _history (id, at, kind, by_sub, note, restore_point, ref) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      this.nowIso(),
      event.kind,
      event.by,
      event.note,
      event.restorePoint ?? null,
      event.ref ?? null,
    );
    return id;
  }

  /** A bookmark of this moment, for "Restore to Here"; null where the platform keeps none. */
  async bookmark(): Promise<string | null> {
    try {
      const mark = await this.storage.getCurrentBookmark();
      return mark && !/^[0-]+$/.test(mark) ? mark : null;
    } catch {
      return null;
    }
  }

  /** Sets the object's alarm to `at`, unless one is already set sooner. */
  async wakeAt(at: number): Promise<void> {
    const current = await this.storage.getAlarm();
    if (current === null || current > at) await this.storage.setAlarm(at);
  }
}
