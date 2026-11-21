// The store's suite of tests runs on whatever host it is handed. A host is what a store runs on:
// on Cloudflare a Durable Object's storage and R2, elsewhere a SQLite file and a folder on a disk,
// and in this repository's own test run the stand-ins in testing/fakes.ts.
//
// A caller binds a host and its test runner once, before it imports any suite file:
//
//   import { describe, it } from "node:test";            // or the runner the host's tests use
//   import { bindSuite } from "…/testing/suite/host.js";
//   bindSuite(myHost, { describe, it, skip: (name, why) => it(name, { skip: why }, () => {}) });
//   await import("…/testing/suite/all.js");               // every suite file, or one of them
//
// A suite file is an ordinary test file, except that `describe` and `it` come from here and a new
// store's storage comes from `host()`. So a store behaves the same on every host the suite passes.

import type { StoreState, StoreStorage } from "../../src/core.js";
import type { StoreFiles } from "../../src/store-files.js";
import type { MemoryFiles } from "./stand-ins.js";

// ── What a host hands in ─────────────────────────────────────────────────────

/** One statement of a database, as a test runs it directly: the members of Node's own SQLite statement the tests use. */
export interface HostStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  /** The first row, or undefined when the statement answers none. */
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): unknown;
  /** Reads every integer as a bigint: an integer past 2^53 reads no other way. */
  setReadBigInts(on: boolean): void;
}

/** A SQLite database as a test reads and writes it directly, past the store and its count of rows written. */
export interface HostDatabase {
  prepare(sql: string): HostStatement;
  /** Runs every statement of `sql`, with no values bound. */
  exec(sql: string): void;
}

/**
 * A store's storage, with what a test needs beside it. The first part is what the store itself is
 * handed (`StoreStorage`); the rest is how a test looks at it and plays the platform.
 *
 * A test may replace one of the storage's methods with its own, to stand in for a platform call
 * that fails. So each is a plain method of the object, not a private field's.
 */
export interface HostStorage extends StoreStorage {
  sql: StoreStorage["sql"] & {
    /** The database itself. */
    readonly db: HostDatabase;
    /** Every statement `exec` took, in order. */
    readonly statements: string[];
  };
  /**
   * The alarm's time, or null. The suite runs a store's alarm by hand (`store.alarm()`), so a
   * host under test never fires one by itself.
   */
  alarm: number | null;
  /** The clock a bookmark takes its time from. A test sets it to its own clock. */
  now: () => number;
  /**
   * Whether the storage keeps bookmarks. A test sets it to false to stand in for a platform with
   * no way back: `getCurrentBookmark` then answers a bookmark of zeros, and the other two throw.
   */
  pointInTime: boolean;
  /** What the platform does when the store starts again: a restore that was asked for is applied. */
  restart(): void;
}

/** The state a store is handed, and why it asked to be stopped. */
export interface HostState extends StoreState {
  readonly storage: HostStorage;
  aborted: string | null;
}

/** A bucket of a store's files, with what a test reads directly: every object, and every upload in progress. */
export type HostFiles = Pick<MemoryFiles, "objects" | "uploads" | "get" | "head" | "put" | "delete" | "list" | "createMultipartUpload" | "resumeMultipartUpload"> & {
  /** The bucket as a store takes it. */
  asBucket(): StoreFiles;
};

/**
 * Where hosts differ on purpose. A test that holds only on some hosts names the trait it needs, and
 * a host without it gets the test listed as skipped, with the reason. A host is held to every
 * trait it claims (host-rules.suite.ts).
 */
export interface HostTraits {
  /**
   * The host counts the rows a statement wrote as Cloudflare bills them: an index's entry is a row,
   * and so is each row a new table or a new index is made from. A host that counts as SQLite does
   * (`total_changes()` before and after) says false: a store's daily write limit then counts
   * SQLite's own number, and the suite leaves out the checks of an exact billed count.
   */
  billedWrites: boolean;
  /**
   * The limits workerd puts on SQLite, each true where this host refuses what is past it, in
   * SQLite's own words. A store keeps its own caps under these limits, so it behaves the same on a
   * host that holds none; a host that holds one refuses a statement SQLite itself would run.
   */
  limits: {
    /** 100 columns in a table or a result: "too many columns". */
    column: boolean;
    /** 2,000,000 bytes in a value or a row: "string or blob too big". */
    length: boolean;
    /** 100 bound values in a statement: "too many SQL variables". */
    variableNumber: boolean;
    /** 100,000 bytes in a statement: "statement too long". */
    sqlLength: boolean;
    /** 50 bytes in a LIKE or GLOB pattern: "LIKE or GLOB pattern too complex". */
    likePatternLength: boolean;
    /** 5 SELECTs in a chain of UNION, INTERSECT and EXCEPT: "too many terms in compound SELECT". */
    compoundSelect: boolean;
  };
  /**
   * The host keeps bookmarks: a moment of the database to go back to (`getCurrentBookmark`,
   * `getBookmarkForTime`, `onNextSessionRestoreBookmark`). A host that keeps none answers a
   * bookmark of zeros from the first and throws from the other two, and its stores offer no
   * restore; the suite leaves out the tests of a restore there.
   */
  bookmarks: boolean;
}

/**
 * Rule 1: a statement reaches only its own store's file. A host says how the rule is held:
 * by the host itself, and then the suite attacks it; or by the platform under it, in words.
 */
export type ReachRule =
  | {
      held: "host";
      /** A SQLite file outside every store of this host, holding a table `other_rows` with one row: what an attacker tries to open. */
      otherFile(): string;
    }
  | { held: "platform"; how: string };

/** One store that runs apart from its caller, for rule 2. */
export interface ApartStore {
  /** Runs one statement and answers its rows. Rejects when the host stopped the statement. */
  exec(sql: string, ...bindings: unknown[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/**
 * Rule 2: a statement that never ends is stopped, and the host still answers meanwhile. A host
 * that holds the rule itself opens stores the way it runs them, apart from its own loop; one whose
 * platform holds it says how.
 */
export type RunawayRule =
  | {
      held: "host";
      /** The longest the host lets one statement run, in ms. A test waits about this long, so a host under test sets it short. */
      limitMs: number;
      open(): Promise<ApartStore>;
    }
  | { held: "platform"; how: string };

export interface StoreHost {
  /** The host's name, for a test's title and a skipped test's reason. */
  readonly name: string;
  /** A new, empty store's storage. */
  storage(): HostStorage;
  /** The state a store gets around a storage. Left out, the suite's own stand-in is used. */
  state?(storage: HostStorage): HostState;
  /** A bucket for a store's files. Left out, the suite keeps files in memory. */
  files?(): HostFiles;
  /** A database of the host's own SQLite, apart from every store: empty, or holding a SQLite file's bytes. */
  database(bytes?: Uint8Array): HostDatabase;
  readonly traits: HostTraits;
  readonly reach: ReachRule;
  readonly runaway: RunawayRule;
}

// ── The test runner ──────────────────────────────────────────────────────────

/** The few things the suite asks of a test runner. Node's own and Bun's both have them. */
export interface SuiteRunner {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => void | Promise<void>): void;
  /** Lists a test as skipped, with the reason. */
  skip(name: string, why: string): void;
  /**
   * Runs `fn` with `setTimeout` in the test's hand: nothing set with it fires until `tick` moves
   * the time on. A runner with no such timers leaves it out, and the one test that needs it is skipped.
   */
  fakeTimers?(fn: (timers: { tick(ms: number): void }) => Promise<void>): Promise<void>;
}

// ── Binding ──────────────────────────────────────────────────────────────────

let bound: { host: StoreHost; runner: SuiteRunner } | null = null;

/** Hands the suite its host and its test runner. Call it once, before importing a suite file. */
export function bindSuite(host: StoreHost, runner: SuiteRunner): void {
  bound = { host, runner };
}

function need(): { host: StoreHost; runner: SuiteRunner } {
  if (!bound) throw new Error("The store's suite has no host yet: call bindSuite(host, runner) before importing a suite file.");
  return bound;
}

/** The host the suite runs on. */
export function host(): StoreHost {
  return need().host;
}

export function describe(name: string, fn: () => void): void {
  need().runner.describe(name, fn);
}

export function it(name: string, fn: () => void | Promise<void>): void {
  need().runner.it(name, fn);
}

/** `it`, for a test that holds only where `holds` is true: elsewhere the test is listed as skipped, with `why`. */
export function itWhere(holds: boolean, why: string): (name: string, fn: () => void | Promise<void>) => void {
  return holds ? it : (name) => need().runner.skip(name, why);
}

/**
 * Runs a check that holds only where the host counts written rows as Cloudflare bills them
 * (`HostTraits.billedWrites`): an exact count of rows written. On a host that counts as SQLite
 * does, the number is smaller and the host's own, so the check is left out there.
 */
export function whereBilled(check: () => void): void {
  if (need().host.traits.billedWrites) check();
}

/**
 * Runs a check that holds only where the host keeps bookmarks (`HostTraits.bookmarks`): that a
 * change left a moment to restore to. On a host that keeps none the check is left out.
 */
export function whereBookmarks(check: () => void): void {
  if (need().host.traits.bookmarks) check();
}

/** `it`, for a test of a restore: listed as skipped on a host that keeps no bookmarks. */
export function itRestores(name: string, fn: () => void | Promise<void>): void {
  itWhere(need().host.traits.bookmarks, "this host keeps no bookmarks, so its stores have no moment to restore to")(name, fn);
}

/** Whether the bound runner can put `setTimeout` in a test's hand. */
export function hasFakeTimers(): boolean {
  return typeof need().runner.fakeTimers === "function";
}

/** Runs `fn` with `setTimeout` in the test's hand (SuiteRunner.fakeTimers). */
export function fakeTimers(fn: (timers: { tick(ms: number): void }) => Promise<void>): Promise<void> {
  const run = need().runner.fakeTimers;
  if (!run) throw new Error("This test runner has no fake timers: guard the test with hasFakeTimers().");
  return run(fn);
}

// ── A new store's parts, with the suite's own stand-ins where a host has none ──

import { FakeState, MemoryFiles as Memory } from "./stand-ins.js";

/** The state a store gets around `storage`: the host's, or the suite's stand-in. */
export function stateOf(storage: HostStorage): HostState {
  return host().state?.(storage) ?? new FakeState(storage);
}

/** A bucket for a store's files: the host's, or one in memory. */
export function filesOf(): HostFiles {
  return host().files?.() ?? new Memory();
}
