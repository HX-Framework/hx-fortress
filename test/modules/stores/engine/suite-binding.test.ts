// How the engine's suite is bound to this repository's test runner: what it
// may skip here, and the timers it takes in hand.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  countSkip,
  maySkip,
  SAMPLES_LEFT_OUT,
  skipsExpected,
  SUITE_RUNNER,
  suiteHooks,
  timersInHand,
} from "./_bind";
import { engineHost } from "./_host";

// This file's own hooks: the binding sets none by itself.
const hooks = suiteHooks("suite-binding");

const ENGINE = path.join(import.meta.dir, "..", "..", "..", "..", "src", "modules", "stores", "engine");

/** Every file of the engine's suite of tests, in the engine's folder. */
function suiteFiles(folder: string = ENGINE): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const here = path.join(folder, entry.name);
    if (entry.isDirectory()) return suiteFiles(here);
    return entry.name.endsWith(".suite.ts") ? [here] : [];
  });
}

describe("the hooks of a test file that imports the binding", () => {
  // The two tests below are one: the hooks ran once more between them.
  let before = -1;
  test("each test of this file is followed by them", () => {
    before = hooks.ran();
  });
  test("whichever test file loaded the binding first", () => {
    expect(hooks.ran()).toBe(before + 1);
  });
});

describe("what the engine's suite may skip here", () => {
  test("no test of a restore: this host keeps a moment to go back to, and is held to them", () => {
    expect(engineHost.traits.bookmarks).toBe(true);
    for (const why of [
      "HX Fortress keeps no bookmarks",
      "this host keeps no bookmarks, so its stores have no moment to restore to",
    ]) {
      expect([why, maySkip(why)]).toEqual([why, false]);
      // Only a host that keeps none may skip them.
      expect([why, maySkip(why, false)]).toEqual([why, true]);
    }
  });

  test("the one test of a host that keeps no such moment", () => {
    // The suite's own words for it, with the host's name in front.
    const why = `${engineHost.name} keeps bookmarks`;
    expect(maySkip(why)).toBe(true);
    expect(maySkip(why, false)).toBe(false);
    expect(skipsExpected()).toEqual({ no_bookmarks: 0, keeps_bookmarks: 1, no_sample: 27 });
    expect(skipsExpected(false)).toEqual({ no_bookmarks: 10, keeps_bookmarks: 0, no_sample: 27 });
  });

  test("the tests that load a sample file which is not text, by the file's name", () => {
    for (const name of SAMPLES_LEFT_OUT) {
      expect([name, maySkip(`this copy of the suite has no sample file ${name}`)]).toEqual([name, true]);
    }
  });

  test("every sample file the suite names is in the engine's folder, or on the list of those left out", () => {
    // Every file of the suite that has tests of sample files: each has its
    // own `sampled`, which lists a test as skipped where a file is missing.
    const files = suiteFiles().filter((file) => /\bfunction sampled\(\.\.\.names\b/.test(readFileSync(file, "utf8")));
    expect(files.map((file) => path.relative(ENGINE, file)).sort()).toEqual([
      "store-object/src/file-tables.suite.ts",
      "store-object/src/jobs/load.suite.ts",
      "store-object/src/jobs/read.suite.ts",
    ]);
    const named = new Set<string>();
    /** The calls whose names are not written in the call itself. */
    const unread: string[] = [];
    for (const file of files) {
      for (const call of readFileSync(file, "utf8").matchAll(/\bsampled\(([^)]*)\)\(/g)) {
        const names = [...(call[1] ?? "").matchAll(/"([^"]+)"/g)].map((name) => name[1] as string);
        if (names.length === 0) unread.push(`${path.basename(file)}: ${call[0]}`);
        for (const name of names) named.add(name);
      }
    }
    expect(named.size).toBeGreaterThan(20);
    // One call takes its names from a list of two, and both are also written
    // in other calls of the same file. A new call of this kind is looked at by
    // a person, who then writes it here: this test cannot read its names.
    expect(unread).toEqual(["read.suite.ts: sampled(sample)("]);
    const missing = [...named].filter((name) => !existsSync(path.join(ENGINE, "store-readers", "fixtures", name)));
    expect(missing.sort()).toEqual([...SAMPLES_LEFT_OUT].sort());
  });

  test("each skip is counted for its reason, so one more or one less than before is a difference", () => {
    // A count of this test's own: the suite's is compared in engine-suite.test.ts.
    const counts = { no_bookmarks: 0, keeps_bookmarks: 0, no_sample: 0 };
    countSkip(counts, "loads a town's files", "this copy of the suite has no sample file permits.xlsx");
    // As on a host that keeps no moment to go back to.
    countSkip(counts, "restores a table", "this host keeps no bookmarks, so its stores have no moment to restore to", false);
    countSkip(counts, "goes back to a bookmark", "HX Fortress keeps no bookmarks", false);
    expect(counts).toEqual({ no_bookmarks: 2, keeps_bookmarks: 0, no_sample: 1 });
    countSkip(counts, "keeps no bookmark", "HX Fortress keeps bookmarks");
    expect(counts).toEqual({ no_bookmarks: 2, keeps_bookmarks: 1, no_sample: 1 });
    // A test of a restore that the suite skipped here would fail the run.
    expect(() =>
      countSkip(counts, "restores a table", "this host keeps no bookmarks, so its stores have no moment to restore to"),
    ).toThrow("for a reason this host does not give");
    // A reason that is not on the list is counted for nothing.
    expect(() => countSkip(counts, "holds a limit", "HX Fortress does not hold this limit")).toThrow(
      "for a reason this host does not give",
    );
    expect(counts).toEqual({ no_bookmarks: 2, keeps_bookmarks: 1, no_sample: 1 });
    // What the folder skips today, written down.
    expect(skipsExpected()).toEqual({ no_bookmarks: 0, keeps_bookmarks: 1, no_sample: 27 });
  });

  test("nothing else: another sample file, another reason, or a reason that only looks like one", () => {
    for (const why of [
      // A text sample that the folder holds today. Left out of a later folder,
      // its tests would be skipped: that must show.
      "this copy of the suite has no sample file permits-utf8.csv",
      "this copy of the suite has no sample file permits.xlsx and no other",
      "the host does not hold this limit",
      "this test runner cannot put setTimeout in a test's hand",
      "HX Fortress does not hold this limit",
      "",
    ]) {
      expect([why, maySkip(why)]).toEqual([why, false]);
    }
  });

  test("a reason that is not on the list fails the run where the suite gives it", () => {
    expect(() => SUITE_RUNNER.skip("loads a town's files", "this copy of the suite has no sample file permits-utf8.csv")).toThrow(
      "for a reason this host does not give",
    );
  });
});

describe("the timers a test of the suite takes in hand", () => {
  test("nothing set with setTimeout fires until the test moves the time on, and then in the order of their times", async () => {
    const fired: string[] = [];
    await timersInHand(async ({ tick }) => {
      setTimeout(() => fired.push("at 30"), 30);
      setTimeout(() => fired.push("at 10"), 10);
      const cleared = setTimeout(() => fired.push("cleared"), 5);
      setTimeout((word: string) => fired.push(word), 10, "at 10, set second");
      clearTimeout(cleared);
      // The runtime goes on meanwhile: a turn of its own queue passes.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fired).toEqual([]);
      tick(9);
      expect(fired).toEqual([]);
      tick(1);
      expect(fired).toEqual(["at 10", "at 10, set second"]);
      // One that is set while another fires, inside the same move.
      setTimeout(() => {
        fired.push("at 15");
        setTimeout(() => fired.push("at 20"), 5);
      }, 5);
      tick(15);
      expect(fired).toEqual(["at 10", "at 10, set second", "at 15", "at 20"]);
      tick(5);
      expect(fired).toEqual(["at 10", "at 10, set second", "at 15", "at 20", "at 30"]);
    });
  });

  test("afterwards the runtime's own timers are back, also when the test threw", async () => {
    const runtime = globalThis.setTimeout;
    await expect(
      timersInHand(() => {
        expect(globalThis.setTimeout).not.toBe(runtime);
        return Promise.reject(new Error("the test failed"));
      }),
    ).rejects.toThrow("the test failed");
    expect(globalThis.setTimeout).toBe(runtime);
    const began = Date.now();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(Date.now() - began).toBeGreaterThanOrEqual(15);
  });

  // The two tests below are one: the first leaves a wait that never ends, as
  // a test that ran out of time does, and the second finds the runtime's
  // timers back, because the binding puts them back after each test.
  const runtime = globalThis.setTimeout;
  test("a test that never ends its wait does not keep the timers", () => {
    void timersInHand(() => new Promise<void>(() => undefined));
    expect(globalThis.setTimeout).not.toBe(runtime);
  });
  test("the next test has the runtime's own", () => {
    expect(globalThis.setTimeout).toBe(runtime);
  });
});
