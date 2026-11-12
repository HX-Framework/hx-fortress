// HX Fortress names no vendor and claims no audit attestation.
// `test/words-check.ts` is the scan; this is what makes `bun run check` fail on
// a finding.

import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  ALLOWED,
  RULES,
  describeFinding,
  describeStale,
  isWholeWord,
  scanRepository,
  scanText,
  type Exception,
  type Used,
} from "./words-check";

const ROOT = path.resolve(import.meta.dir, "..");

// The attestation's name is put together here, so that this file does not
// hold it either.
const STANDARD = ["S", "O", "C"].join("");
const lower = STANDARD.toLowerCase();
// The same letters as a name would capitalise them.
const Capitalised = `${STANDARD.slice(0, 1)}${lower.slice(1)}`;

describe("the words check, over this repository", () => {
  const result = scanRepository(ROOT);

  test("it ran", () => {
    // A source archive has no git checkout to list files from, and the check
    // is skipped there. In CI there is always a checkout, so a skip there is a
    // failure.
    if (process.env.CI) expect(result).not.toBeNull();
  });

  test.skipIf(result === null)("no file names a vendor or an audit attestation", () => {
    // The findings are the message: each line says where, what and what to
    // write instead.
    expect(result!.findings.map(describeFinding)).toEqual([]);
  });

  test.skipIf(result === null)("every exception still hides something, in every file it names", () => {
    // An entry that hides nothing is a door left open for the next line that
    // would match. Remove it, or the file it no longer needs, from ALLOWED in
    // test/words-check.ts.
    expect(result!.stale.map(describeStale)).toEqual([]);
  });

  test.skipIf(result === null)("it read the repository, not an empty folder", () => {
    expect(result!.files).toBeGreaterThan(300);
  });

  test("every exception says why", () => {
    for (const e of ALLOWED) expect(e.why.length).toBeGreaterThan(20);
  });

  test("every exception names rules that exist", () => {
    const ids = new Set(RULES.map((rule) => rule.id));
    for (const e of ALLOWED) {
      if ("rules" in e) for (const id of e.rules) expect(ids.has(id)).toBe(true);
    }
  });
});

describe("what the scan finds", () => {
  const none: readonly Exception[] = [];
  const rulesFor = (text: string, file = "src/example.ts"): string[] =>
    scanText(file, text, none).map((f) => f.rule);

  test("the vendor's name, in every spelling it has had here", () => {
    for (const text of [
      "the roster let.ai sent",
      "Let.AI",
      'repoSlug: "let-ai/atlas"',
      "const LETAI_KEYS = []",
      "process.env.LET_AI_TOKEN",
      'origin: "let_ai_cloud"',
      "answer.letaiCopy",
      "counts.alsoAtLetai += 1",
      "counts.alsoAtLetaiAcknowledged",
      "also_at_letai = 3",
      "Copyright (c) 2026 Let AI",
      "// LETAIR-301: a ticket number",
    ]) {
      expect(rulesFor(text)).toEqual(["vendor"]);
    }
  });

  test("the vendor's service label, repository, package scope and product", () => {
    for (const text of [
      'label: "ai.let.example"',
      "lives in let-forge",
      "secrets.LET_FORGE_TOKEN",
      'import { x } from "@forge/session-store"',
      "postgres://forge:forge@localhost:5499/hx-db",
      "the Workbench button",
      "workbenchSub",
      "HX_MIGRATE_FROM_WORKBENCH=1",
    ]) {
      expect(rulesFor(text)).toEqual(["vendor"]);
    }
  });

  test("an audit attestation, however it is written", () => {
    for (const text of [
      `${STANDARD} 2`,
      `${lower}2`,
      `${STANDARD}-2 Type II`,
      `${Capitalised}_2`,
      `${STANDARD} II`,
      `${lower} two`,
      `${STANDARD}  2`,
      `${STANDARD}2_REPORT`,
      `${lower}2Report`,
      `is${Capitalised}2Ready`,
      `${STANDARD}2Type2`,
      `${STANDARD} Type 2`,
      `${STANDARD} Type II`,
      // Wrapped over two lines, in prose and in a comment.
      `holds a ${STANDARD}\n2 report`,
      `// a ${STANDARD}\n// 2 report`,
    ]) {
      expect(rulesFor(text)).toEqual(["audit-standard"]);
    }
  });

  test("words that only look alike are left alone", () => {
    for (const text of [
      "let ai = 1;",
      "the outlet aisle",
      "a retail store",
      "const staleTail = tail(rows);",
      "reconcileTail()",
      "enableTailscaleServe()",
      "outlet.aiSummary",
      "tablet-airplay",
      "bulletAI",
      "mail.letter",
      "associate 2 rows",
      "the socket 2 is closed",
      `${lower}2048`,
      `${STANDARD} type integer`,
      "wss://control.example/fortress",
      "a role that cannot forge an audit row",
      "~/.hx-fortress",
    ]) {
      expect(rulesFor(text)).toEqual([]);
    }
  });

  test("a word ends at punctuation, at an underscore and at a camelCase capital", () => {
    const whole = (text: string, word: string): boolean => {
      const at = text.toLowerCase().indexOf(word.toLowerCase());
      return isWholeWord(text, at, at + word.length);
    };
    expect(whole("letaiCopy", "letai")).toBe(true);
    expect(whole("alsoAtLetai", "letai")).toBe(true);
    expect(whole("LETAI_KEYS", "letai")).toBe(true);
    expect(whole("LetAICopy", "letai")).toBe(true);
    expect(whole("staleTail", "letai")).toBe(false);
    expect(whole("LETAILS", "letai")).toBe(false);
  });

  test("a file's own name is checked", () => {
    const findings = scanText("scripts/migrate-from-workbench.ts", "export {};\n", none);
    expect(findings).toEqual([expect.objectContaining({ line: 0, rule: "vendor" })]);
  });

  test("a finding names the line, and a place is reported once", () => {
    const findings = scanText("a.ts", "one\ntwo let.ai\nthree\n", none);
    expect(findings).toEqual([expect.objectContaining({ file: "a.ts", line: 2, match: "let.ai" })]);
    expect(describeFinding(findings[0]!)).toContain("a.ts:2");
    expect(describeFinding(findings[0]!)).toContain("the control plane");
    // Two patterns of the vendor rule both find this one place.
    expect(scanText("a.ts", "LETAIR-301", none)).toHaveLength(1);
    // A term wrapped over two lines is reported on the line where it starts.
    expect(scanText("a.md", `one\na ${STANDARD}\n2 report\n`, none)).toEqual([
      expect.objectContaining({ line: 2, rule: "audit-standard" }),
    ]);
  });

  test("every rule has something to say", () => {
    for (const rule of RULES) expect(rule.say.length).toBeGreaterThan(20);
  });
});

describe("exceptions", () => {
  test("an allowed text is let through only in the files it names, and the rest of the line is still read", () => {
    const allowed: Exception[] = [{ text: "letaiCopy", files: ["src/a.ts"], why: "a field of a protocol" }];
    const used: Used = new Map();
    expect(scanText("src/a.ts", "x.letaiCopy", allowed, used)).toEqual([]);
    expect([...(used.get(allowed[0]!) ?? [])]).toEqual(["src/a.ts"]);
    // The same text in another file is a finding.
    expect(scanText("src/b.ts", "x.letaiCopy", allowed)).toHaveLength(1);
    // And it does not hide a second name on the same line.
    expect(scanText("src/a.ts", "x.letaiCopy // from let.ai", allowed)).toEqual([
      expect.objectContaining({ match: "let.ai" }),
    ]);
  });

  test("an allowed text does not let a longer name through, nor a name that only overlaps it", () => {
    const copy: Exception[] = [{ text: "letaiCopy", files: ["src/a.ts"], why: "a field of a protocol" }];
    expect(scanText("src/a.ts", "x.letaiCopyright", copy)).toHaveLength(1);
    const label: Exception[] = [{ text: "ai.let.hx-fortress", files: ["src/a.ts"], why: "a service label" }];
    expect(scanText("src/a.ts", 'label = "ai.let.hx-fortress"', label)).toEqual([]);
    // The allowed text starts in the middle of the vendor's domain here.
    expect(scanText("src/a.ts", 'host = "let.ai.let.hx-fortress"', label)).toEqual([
      expect.objectContaining({ match: "let.ai" }),
    ]);
  });

  test("an excepted file is let through for the rules it names and for no other", () => {
    const allowed: Exception[] = [{ file: "old.sql", rules: ["vendor"], why: "an applied migration" }];
    const used: Used = new Map();
    expect(scanText("old.sql", "-- as let.ai reports them", allowed, used)).toEqual([]);
    expect(used.size).toBe(1);
    const unused: Used = new Map();
    expect(scanText("old.sql", "-- nothing to hide", allowed, unused)).toEqual([]);
    expect(unused.size).toBe(0);
    expect(scanText("old.sql", `-- a ${STANDARD} 2 report, as let.ai holds`, allowed)).toEqual([
      expect.objectContaining({ rule: "audit-standard" }),
    ]);
  });

  test.skipIf(scanRepository(ROOT) === null)("an exception with nothing left to hide is reported, per file", () => {
    // The text is put together here so that this file does not hold it.
    const nowhere = ["a text that occurs", "in no file at all"].join(" ");
    const stale: Exception[] = [
      { file: "no-such-file.txt", rules: ["vendor"], why: "an entry nobody removed" },
      { text: nowhere, files: ["package.json"], why: "an entry nobody removed" },
    ];
    // An entry that is needed in one file and listed for two. It stands in for
    // the real entry of the same text: beside it, it would hide nothing at all.
    const half: Exception = {
      text: "@let-ai/hx-protocol",
      files: ["package.json", "tsconfig.json"],
      why: "an entry with one file too many",
    };
    const others = ALLOWED.filter((e) => !("text" in e && e.text === half.text));
    const result = scanRepository(ROOT, [...others, ...stale, half])!;
    expect(result.stale).toEqual([
      { exception: stale[0]!, files: ["no-such-file.txt"] },
      { exception: stale[1]!, files: ["package.json"] },
      { exception: half, files: ["tsconfig.json"] },
    ]);
  });

  test("the list of exceptions in the check's own file does not keep an exception alive", () => {
    // Every allowed text is written out in ALLOWED. If that counted as a use,
    // no text exception could ever be reported as stale.
    for (const e of ALLOWED) {
      if ("text" in e) expect(e.files).not.toContain("test/words-check.ts");
    }
  });
});
