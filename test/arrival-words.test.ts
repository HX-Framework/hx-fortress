// How a session reached this host, as a person reads it.
//
// The database and the console's API hold a short value for each way a
// session's transcript arrives. A page, a check's result and a terminal show
// words for it (`arrivalWords` in src/ui/copy.ts), never the stored value: the
// words check reads what is written in a file, and cannot see a value that
// code puts on a screen. This test holds the places that show one.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Glob } from "bun";

import { arrivalWords } from "../src/ui/copy";
import { verifySessionResidency } from "../src/ui/residency-verify";
import { RULES } from "./words-check";

const ROOT = path.resolve(import.meta.dir, "..");
/** The values `hx.sessions.ingest_channel` holds (src/host/postgres/schema/sessions.ts). */
const STORED = ["tunnel", "gateway", "reconciled"] as const;

describe("the words for how a session arrived", () => {
  test("each stored value has words of its own, which read after the word arrived", () => {
    expect(STORED.map(arrivalWords)).toEqual([
      "from the control plane",
      "directly at the gateway",
      "by a route that was not recorded",
    ]);
  });

  test("the words hold none of the words a person no longer reads", () => {
    const kept = RULES.filter((rule) => rule.where === "read").flatMap((rule) => rule.patterns);
    expect(kept.length).toBeGreaterThan(0);
    for (const stored of STORED) {
      for (const pattern of kept) expect([stored, pattern.test(arrivalWords(stored))]).toEqual([stored, false]);
    }
  });

  test("a value this build does not know is shown as it is stored", () => {
    expect(arrivalWords("a-later-way")).toBe('by "a-later-way"');
  });

  test("a session's residency check says how it arrived in those words", () => {
    const detailFor = (ingestChannel: string | null): string | undefined =>
      verifySessionResidency({
        family: "claude-cli",
        sessionId: "session-1",
        row: { bytesUploaded: 10, ingestChannel, lastActivityAt: null },
        storeUnavailable: "no store in this test",
      }).checks.find((check) => check.name === "Metadata row")?.detail;
    expect(detailFor("tunnel")).toBe("in this HX Fortress's own database, arrived from the control plane");
    expect(detailFor("gateway")).toBe("in this HX Fortress's own database, arrived directly at the gateway");
    expect(detailFor(null)).toBe("in this HX Fortress's own database");
  });

  test("no page and no route puts the stored value itself into a text", () => {
    // The three shapes that put a value on a screen as it is: inside a
    // template, between two JSX tags, and as the fallback of `??`.
    const asItIs = [/\$\{\s*[\w.?]*ingestChannel\s*\}/, /[>{]\s*\{?\s*[\w.?]*ingestChannel\s*\}/, /ingestChannel\s*\?\?\s*["'`]/];
    const files = [
      ...new Glob("ui/src/**/*.{ts,tsx}").scanSync({ cwd: ROOT }),
      ...new Glob("src/ui/**/*.ts").scanSync({ cwd: ROOT }),
      ...new Glob("src/tui/**/*.ts").scanSync({ cwd: ROOT }),
    ].filter((file) => !file.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      for (const shape of asItIs) expect([file, String(shape), shape.test(text)]).toEqual([file, String(shape), false]);
    }
    // The session's page, the residency page's rows and the check's result each ask for the words.
    for (const file of ["ui/src/views/Sessions.tsx", "ui/src/views/Residency.tsx", "src/ui/residency-verify.ts"]) {
      expect([file, readFileSync(path.join(ROOT, file), "utf8").includes("arrivalWords(")]).toEqual([file, true]);
    }
  });
});
