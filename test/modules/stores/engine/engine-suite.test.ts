// The Store's engine, held to its own suite of tests on this host: the
// module's storage on a real file, under Bun.

import { describe, expect, test } from "bun:test";

import { skipsCounted, skipsExpected, suiteHooks, suiteTestsRun } from "./_bind";
import "../../../../src/modules/stores/engine/store-object/testing/suite/all.js";

// This file's own hooks: the binding sets none by itself.
const hooks = suiteHooks("engine-suite");

describe("the engine's suite on this host", () => {
  // The suite listed every test of its own as its files loaded, above.
  test("skips exactly the tests this host is not held to: as many as before, for each reason", () => {
    expect(skipsCounted()).toEqual(skipsExpected());
  });

  // The two tests below are one: the hooks ran once more between them. The
  // suite's own tests were listed before this file set its hooks, and each of
  // them was followed by the hooks too.
  let before = -1;
  test("each test of this file is followed by the binding's hooks", () => {
    before = hooks.ran();
    expect(before).toBeGreaterThanOrEqual(suiteTestsRun());
  });
  test("whichever test file loaded the binding first", () => {
    expect(hooks.ran()).toBe(before + 1);
  });
});
