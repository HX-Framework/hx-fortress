// Hands the engine's suite of tests its host and this repository's test
// runner. Imported before any file of the suite: a suite file asks for both
// as soon as it loads.
//
// A TEST FILE THAT IMPORTS THIS SETS ITS OWN HOOKS, with `suiteHooks`. The
// runner loads a file that two test files import once, and a hook that is set
// while such a file loads belongs to the test file that loaded it first. The
// other one then runs with none (measured on Bun 1.3.14, in either order).

import { afterAll, afterEach, describe, it } from "bun:test";

import { bindSuite, type SuiteRunner } from "../../../../src/modules/stores/engine/store-object/testing/suite/host.js";
import { cleanFolders, endProcesses } from "../_rig";
import { closeStorages, engineHost } from "./_host";

/** The longest one test of the suite may take. Three of them wait out the
 *  limit of a statement that never ends, on the real clock. */
const TEST_LIMIT_MS = 60_000;

// ── What the suite may skip here ─────────────────────────────────────────────
//
// A test of the suite that is skipped is one this host is not held to. So the
// reasons the suite may give here are a closed list, and any other reason
// fails the run. How many tests it skips for each reason is counted, and
// `engine-suite.test.ts` holds the counts to `skipsExpected`: a folder that
// is written again and skips more tests than before, or fewer, does not pass
// unseen.

/**
 * The sample files the suite names and has no copy of in this repository. The
 * script that writes the engine's folder leaves out a file that is not text:
 * its bytes cannot be read for what a public repository must not hold. The
 * tests that load one of them are the suite's tests of the readers for these
 * formats, and they do not run here. `suite-binding.test.ts` holds this list
 * to the folder: every sample the suite names is in the folder or here.
 */
export const SAMPLES_LEFT_OUT: readonly string[] = [
  "permits.xlsx",
  "permits-2010.accdb",
  "permits-vfp.dbf",
  "permits-vfp.fpt",
  "permits-libre.ods",
  "town.sqlite",
  "permits-snappy.parquet",
  "town-export.zip",
  "owners-says-1251.dbf",
  "owners-1251.dbf",
  "cafes-437-says-1252.dbf",
];

/** The reasons the suite may skip a test for here. */
export type SkipReason = "no_bookmarks" | "keeps_bookmarks" | "no_sample";

/** Which of the reasons `why` is, or null for one this host does not give. */
function skipReason(why: string, keepsBookmarks: boolean): SkipReason | null {
  // The host says of itself whether it keeps a moment to take a Store back to
  // (`traits.bookmarks`). While it keeps none, the tests of a restore are
  // skipped. Once it keeps them, the one test of a host that keeps none is.
  if (/keeps no bookmarks\b/.test(why)) return keepsBookmarks ? null : "no_bookmarks";
  if (/ keeps bookmarks$/.test(why)) return keepsBookmarks ? "keeps_bookmarks" : null;
  const sample = /^this copy of the suite has no sample file (\S+)$/.exec(why)?.[1];
  return sample !== undefined && SAMPLES_LEFT_OUT.includes(sample) ? "no_sample" : null;
}

/** Whether the suite may skip a test here for this reason. */
export function maySkip(why: string, keepsBookmarks: boolean = engineHost.traits.bookmarks): boolean {
  return skipReason(why, keepsBookmarks) !== null;
}

/**
 * How many tests the suite skips here, for each reason. Counted by hand from
 * the folder as it is written now: seven tests that load a sample file the
 * folder leaves out, and the one test of a host that keeps no moment to go
 * back to. This host keeps such moments, so it is held to the ten tests of a
 * restore: a host that kept none would skip those ten in the one's place. A
 * folder that moves a number is looked at by a person, who then writes the
 * new number here.
 */
export function skipsExpected(keepsBookmarks: boolean = engineHost.traits.bookmarks): Record<SkipReason, number> {
  return keepsBookmarks
    ? { no_bookmarks: 0, keeps_bookmarks: 1, no_sample: 7 }
    : { no_bookmarks: 10, keeps_bookmarks: 0, no_sample: 7 };
}

/**
 * Count one skip of the suite for its reason. THROWS for a reason this host
 * does not give, so that the run fails where the suite gives it.
 */
export function countSkip(
  counts: Record<SkipReason, number>,
  name: string,
  why: string,
  keepsBookmarks: boolean = engineHost.traits.bookmarks,
): void {
  const reason = skipReason(why, keepsBookmarks);
  if (reason === null) {
    throw new Error(
      `The engine's suite skips "${name}" here for a reason this host does not give: ${why}. ` +
        "The reasons it may give here are listed in test/modules/stores/engine/_bind.ts.",
    );
  }
  // eslint-disable-next-line security/detect-object-injection -- one of this file's own three names
  counts[reason] += 1;
}

const skipped: Record<SkipReason, number> = { no_bookmarks: 0, keeps_bookmarks: 0, no_sample: 0 };

/** How many tests the suite has skipped so far, for each reason. The suite
 *  lists its tests as its files load, so the counts are whole before the
 *  first test runs. */
export function skipsCounted(): Record<SkipReason, number> {
  return { ...skipped };
}

/** How many tests of the suite have run so far. */
let suiteTests = 0;
export function suiteTestsRun(): number {
  return suiteTests;
}

// ── `setTimeout` in a test's hand ────────────────────────────────────────────

/** `setTimeout` and `clearTimeout` as the runtime has them, while a test holds
 *  its own in their place. Null while they are the runtime's. */
let runtimeTimers: { set: typeof setTimeout; clear: typeof clearTimeout } | null = null;

function timersBack(): void {
  if (!runtimeTimers) return;
  globalThis.setTimeout = runtimeTimers.set;
  globalThis.clearTimeout = runtimeTimers.clear;
  runtimeTimers = null;
}

/**
 * Run `fn` with `setTimeout` in its hand: nothing set with it fires until
 * `tick` moves the time on.
 *
 * ONLY THESE TWO FUNCTIONS ARE REPLACED, and nothing of the runtime's own
 * clock. The runner's own fake timers (`jest.useFakeTimers`) also stop the
 * timer that ends a test at its limit (measured on Bun 1.3.14): a wait that
 * never ends there holds the whole run, with no failure told. With the two
 * functions replaced, such a test still ends at its limit. Its `finally` does
 * not run then, so the hook that `suiteHooks` sets after each test puts the
 * runtime's functions back.
 */
export async function timersInHand(fn: (timers: { tick(ms: number): void }) => Promise<void>): Promise<void> {
  timersBack();
  runtimeTimers = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  let now = 0;
  let made = 0;
  const waiting = new Map<number, { at: number; fire(): void }>();
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    made += 1;
    const id = made;
    waiting.set(id, { at: now + Math.max(0, Number(ms) || 0), fire: () => handler(...args) });
    // What the runtime's own answers, as far as code that holds one uses it.
    const timer = { ref: () => timer, unref: () => timer, hasRef: () => true, [Symbol.toPrimitive]: () => id };
    return timer;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: unknown) => {
    waiting.delete(Number(timer));
  }) as unknown as typeof clearTimeout;
  try {
    await fn({
      tick(ms: number): void {
        const until = now + ms;
        for (;;) {
          // The one that is due first. One that was set while another fired
          // is seen too, and one of the same time fires in the order it was set.
          let first: { id: number; at: number; fire(): void } | null = null;
          for (const [id, one] of waiting) {
            if (one.at <= until && (first === null || one.at < first.at)) first = { id, ...one };
          }
          if (first === null) break;
          waiting.delete(first.id);
          now = Math.max(now, first.at);
          first.fire();
        }
        now = until;
      },
    });
  } finally {
    timersBack();
  }
}

/** What the suite is run with here. */
export const SUITE_RUNNER: SuiteRunner = {
  describe: (name, fn) => void describe(name, fn),
  it: (name, fn) =>
    void it(
      name,
      () => {
        suiteTests += 1;
        return fn();
      },
      TEST_LIMIT_MS,
    ),
  skip: (name, why) => {
    countSkip(skipped, name, why);
    it.skip(`${name} (${why})`, () => undefined);
  },
  fakeTimers: timersInHand,
};

bindSuite(engineHost, SUITE_RUNNER);

// ── The hooks of a test file ─────────────────────────────────────────────────

/** How often the hooks of each test file ran after a test, by the file's own
 *  name for itself. */
const hookRuns = new Map<string, number>();

/**
 * Set the hooks a test file needs that imports this file: after each test the
 * runtime's timers are back and the test's storages are closed, and at the
 * file's end its processes and folders are gone.
 *
 * CALLED BY EACH TEST FILE ITSELF, at its top: see the head of this file.
 * Answers how often the file's own hooks ran, for the file's test of them.
 */
export function suiteHooks(file: string): { ran(): number } {
  afterEach(() => {
    hookRuns.set(file, (hookRuns.get(file) ?? 0) + 1);
    timersBack();
    closeStorages();
  });
  afterAll(async () => {
    closeStorages();
    await endProcesses();
    cleanFolders();
  });
  return { ran: () => hookRuns.get(file) ?? 0 };
}
