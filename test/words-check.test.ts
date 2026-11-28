// HX Fortress names no vendor and claims no audit attestation, and what a
// person reads of it says "the connection" and "the control plane".
// `test/words-check.ts` is the scan; this is what makes `bun run check` fail on
// a finding.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ALLOWED,
  RULES,
  describeFinding,
  describeStale,
  isReadText,
  isWholeWord,
  readOf,
  readView,
  scanRepository,
  scanText,
  textOf,
  type Exception,
  type ReadPart,
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

  test.skipIf(result === null)("no file holds a word the rules keep out", () => {
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

  test("an excepted folder is named with its closing slash", () => {
    // Without it, the entry for one folder would also cover a folder whose
    // name only starts the same.
    for (const e of ALLOWED) {
      if ("folder" in e) expect(e.folder.endsWith("/")).toBe(true);
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

  test("the two words for the link and the other side, where a person reads them", () => {
    for (const text of [
      // A label, a sentence with a value in it, a log line and a test's name.
      'const label = "Relayed by the control plane";',
      "const hint = `The tunnel reconnects with ${it}.`;",
      'log.info("the relay answered");',
      'test("over the tunnel, every identity reaches the tools", () => {});',
      // A label of one word.
      'const title = "Tunnel";',
      'const column = "Relays:";',
      // A sentence inside an expression of a statement for the database.
      'const q = sql`SELECT ${note("the relay answered")} FROM hx.sessions`;',
      // Both spellings, and the one who does it.
      'log.info("tunnelling to the control plane");',
      'log.info("the request was tunnelled");',
      'log.info("a relayer answered");',
      'log.info("two tunnelers are open");',
    ]) {
      expect(rulesFor(text)).toEqual(["connection-words"]);
    }
    // Every line of a file that is not a program source.
    expect(rulesFor("so the relay alone gets at most 200 ids\n", "SECURITY.md")).toEqual(["connection-words"]);
    expect(rulesFor("# the tunnel opens here\n", "install.sh")).toEqual(["connection-words"]);
    expect(rulesFor("name: open the tunnel\n", ".github/workflows/ci.yml")).toEqual(["connection-words"]);
    // A file of statements that is no applied migration is one of them.
    expect(rulesFor("-- the tunnel's rows\n", "scripts/seed.sql")).toEqual(["connection-words"]);
  });

  test("a page shows what stands between two JSX tags, whatever it is", () => {
    const inPage = (text: string): string[] => rulesFor(text, "ui/src/a.tsx");
    expect(inPage("const a = <b>Relayed by the control plane</b>;")).toEqual(["connection-words"]);
    // One lower-case word is a value in a string, and a word on a page between two tags.
    expect(inPage('const a = <div className="m">tunnel</div>;')).toEqual(["connection-words"]);
    // An attribute is a string like any other: a label is read, a value is not.
    expect(inPage('const a = <Stat label="Tunnels open" />;')).toEqual(["connection-words"]);
    expect(inPage('const a = <span data-channel="tunnel" />;')).toEqual([]);
  });

  test("a sentence that code puts together is read as one", () => {
    for (const text of [
      // A template's own text, without its expressions.
      "const line = `${count} relays`;",
      "const line = `Tunnel:${state}`;",
      // Strings joined with +: when one is a sentence, each is a piece of it.
      'const line = "which keeps the " + "tunnel.";',
      'const line = count + " relays";',
      'const line = "Status: " + (isOpen ? "open" : "tunnel");',
      'const line = "The connection " + ("is a " + "tunnel");',
    ]) {
      expect(rulesFor(text)).toEqual(["connection-words"]);
    }
    for (const text of [
      // An address, an id and a key are values, with an expression in them or joined.
      "const url = `ws://127.0.0.1:${port}/_api/hx-gateway/vault-tunnel`;",
      "const key = `relay:${org}:${id}`;",
      'const key = "relay:" + id;',
      'const address = base + "/vault-tunnel";',
    ]) {
      expect(rulesFor(text)).toEqual([]);
    }
  });

  test("an escape in a string is no letter: it neither hides the word nor makes one", () => {
    for (const text of [
      'log.info("\\nTunnel closed, opening again");',
      'log.info("Status:\\ttunnel open");',
      "log.info(`\\nTunnel closed after ${ms} ms`);",
      'log.info("\\x41 tunnel");',
    ]) {
      expect(rulesFor(text)).toEqual(["connection-words"]);
    }
    // A tab and five letters.
    expect(rulesFor('log.info("a \\tunnel b");')).toEqual([]);
  });

  test("the same two words where only a programmer reads them", () => {
    for (const text of [
      // A name, a value the code compares, and a comment.
      "const tunnel = open(relay);",
      'if (channel === "tunnel") count += 1;',
      "// the tunnel reconnects here, and the relay answers",
      "/** Relayed sessions are counted apart. */",
      // A name of the code inside a sentence is not the word.
      'log.info("tunnelUrl is not set");',
      // An expression inside a template.
      "const line = `${totals.tunnel} sessions`;",
      // A regular expression says what a text must not hold.
      "expect(page).not.toMatch(/tunnel|relay/i);",
      // A statement for the database, with and without a value put into it,
      // and however its tag is reached.
      "const q = sql`SELECT count(*) FILTER (WHERE s.ingest_channel = 'tunnel') AS \"tunnel\" FROM hx.sessions s`;",
      "const q = sql`SELECT ${column} FROM hx.sessions s WHERE s.ingest_channel = 'tunnel' AND s.note = 'a relay'`;",
      "const q = db.sql`SELECT 1 WHERE note = 'a relay'`;",
      "const q = sql(options)`SELECT 1 WHERE note = 'a relay'`;",
      "const q = SQL`SELECT 1 WHERE note = 'a relay'`;",
      // What names a module.
      'import { relay } from "./the relay/tunnel";',
      'export { relay } from "./the relay/tunnel";',
      'const relay = require("./the relay/tunnel");',
      'async function load() { return import("./the relay/tunnel"); }',
      'import relay = require("./the relay/tunnel");',
      'declare module "the relay" {}',
      'type Relay = import("./the relay/tunnel").Relay;',
    ]) {
      expect([text, rulesFor(text)]).toEqual([text, []]);
    }
    // A migration ran, and an applied migration is never edited.
    expect(rulesFor("-- the cloud tunnel's ingestCommit\n", "src/host/postgres/migrations/0017_chunk_intents.sql")).toEqual(
      [],
    );
    // A file's name is a name of the code too.
    expect(rulesFor("export {};\n", "src/cloud/tunnel.ts")).toEqual([]);
  });

  test("every kind of program source is parsed: a comment is not read, and a sentence is", () => {
    const source = '// the tunnel opens here\nconst a = "the relay answered";\n';
    for (const ending of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
      const found = scanText(`src/a${ending}`, source, none).map((f) => [f.line, f.match]);
      expect([ending, found]).toEqual([ending, [[2, "relay"]]]);
    }
  });

  test("a source that the parser cannot read to its end is read whole", () => {
    // The string never closes. What the parser makes of the lines after it is
    // a guess, so nothing in the file is taken for a comment.
    const source = 'const s = "the tunnel\n// a relay stands here\nconst t = 1;\n';
    expect(readOf("src/b.ts", source)).toBe("all");
    expect(scanText("src/b.ts", source, none).map((f) => [f.line, f.match])).toEqual([
      [1, "tunnel"],
      [2, "relay"],
    ]);
  });

  test("a finding in what a person reads names its line, and the vendor rule still reads the whole file", () => {
    const text = '// as let.ai sends them\nconst a = 1;\nconst label = "Relayed by the control plane";\n';
    expect(scanText("src/a.ts", text, none)).toEqual([
      expect.objectContaining({ line: 1, rule: "vendor" }),
      expect.objectContaining({ line: 3, rule: "connection-words", match: "Relayed" }),
    ]);
  });

  test("findings come in the order of their places, whichever rule found them", () => {
    const text =
      'const label = "The relay, as let.ai sends it";\n// as let.ai sends them\nconst other = "a tunnel";\n';
    expect(scanText("src/let-ai.ts", text, none).map((f) => [f.line, f.rule])).toEqual([
      // The file's own name comes first.
      [0, "vendor"],
      [1, "connection-words"],
      [1, "vendor"],
      [2, "vendor"],
      [3, "connection-words"],
    ]);
  });

  test("a rule for what a person reads parses a source only where its letters are", () => {
    const cable = { id: "cable", where: "read" as const, patterns: [/cable/], say: "A made-up rule of this test." };
    const text = 'const a = "the cable";\n';
    expect(scanText("src/a.ts", text, none, new Map(), [cable])).toHaveLength(1);
    expect(scanText("src/a.ts", text, none, new Map(), [{ ...cable, quick: /cable/ }])).toHaveLength(1);
    // Letters that are not in the file: the source is not looked at for this rule.
    expect(scanText("src/a.ts", text, none, new Map(), [{ ...cable, quick: /wire/ }])).toEqual([]);
    // The real rule's letters cover each of its spellings.
    const real = RULES.find((rule) => rule.id === "connection-words");
    for (const word of ["Tunnel", "RELAYED", "tunnelling", "relayers"]) expect([word, real?.quick?.test(word)]).toEqual([word, true]);
  });

  test("which texts count as read", () => {
    for (const text of ["two words", "Relay", "Status:", "Not known", " a padded sentence ", " relays", "tunnel "]) {
      expect([text, isReadText(text)]).toEqual([text, true]);
    }
    for (const text of ["tunnel", "gateway", "FORTRESS_UPDATE_URL", "src/cloud/tunnel.ts", "hx-fortress", "SIGTERM", "camelCase", ""]) {
      expect([text, isReadText(text)]).toEqual([text, false]);
    }
  });

  test("which parts of a file a person reads", () => {
    expect(readOf("README.md", "any text")).toBe("all");
    expect(readOf("install.sh", "any text")).toBe("all");
    expect(readOf("src/host/postgres/migrations/0001_first.sql", "any text")).toBe("none");
    expect(readOf("scripts/seed.sql", "any text")).toBe("all");
    const source =
      'const a = "one sentence here"; // a comment\nconst b = `two ${a} words ${a} more`;\nconst c = "value";\nconst d = <p> between tags </p>;\n';
    const read = readOf("src/a.tsx", source) as ReadPart[];
    expect(read.map((part) => [source.slice(part.start, part.end), part.escapes])).toEqual([
      ["one sentence here", true],
      ["two ", true],
      [" words ", true],
      [" more", true],
      [" between tags ", false],
    ]);
    // The same file and text are worked out once. Another text is worked out anew.
    expect(readOf("src/a.tsx", source)).toBe(read);
    const other = 'const a = "another sentence";\n';
    expect((readOf("src/a.tsx", other) as ReadPart[]).map((part) => other.slice(part.start, part.end))).toEqual([
      "another sentence",
    ]);
  });

  test("the rules for what a person reads see a file with everything else blank, each place where it was", () => {
    const source = 'const tunnel = "a\\tb c"; // relay\nlog(`x ${tunnel} y`);\n';
    const view = readView("src/a.ts", source) as string;
    expect(view).toHaveLength(source.length);
    // The escape is a blank, and so are the name, the comment and the expression.
    expect(view.split("\n").map((line) => line.trim())).toEqual(["a  b c", `x${" ".repeat(11)}y`, ""]);
    expect(view.indexOf("x")).toBe(source.indexOf("x "));
    // A file that is read whole is itself, and a migration is nothing.
    expect(readView("README.md", "the text")).toBe("the text");
    expect(readView("src/host/postgres/migrations/0001_first.sql", "the text")).toBeNull();
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

  test("an excepted folder is let through for the rules it names, in every file under it", () => {
    const allowed: Exception[] = [{ folder: "vendored/", rules: ["connection-words"], why: "written from elsewhere" }];
    const used: Used = new Map();
    expect(scanText("vendored/README.md", "through a tunnel", allowed, used)).toEqual([]);
    expect(scanText("vendored/internal/run.go", "// starts no tunnel client", allowed, used)).toEqual([]);
    expect([...(used.get(allowed[0]!) ?? [])]).toEqual(["vendored/README.md", "vendored/internal/run.go"]);
    // A file beside the folder, and a folder whose name only starts the same.
    expect(scanText("README.md", "through a tunnel", allowed)).toHaveLength(1);
    expect(scanText("vendored-too/README.md", "through a tunnel", allowed)).toHaveLength(1);
    // Another rule still holds in the folder.
    expect(scanText("vendored/README.md", "as let.ai holds them", allowed)).toEqual([
      expect.objectContaining({ rule: "vendor" }),
    ]);
  });

  test.skipIf(scanRepository(ROOT) === null)("an exception with nothing left to hide is reported, per file", () => {
    // The text is put together here so that this file does not hold it.
    const nowhere = ["a text that occurs", "in no file at all"].join(" ");
    const stale: Exception[] = [
      { file: "no-such-file.txt", rules: ["vendor"], why: "an entry nobody removed" },
      { text: nowhere, files: ["package.json"], why: "an entry nobody removed" },
      { folder: "no-such-folder/", rules: ["vendor"], why: "an entry nobody removed" },
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
      { exception: stale[2]!, files: ["no-such-folder/"] },
      { exception: half, files: ["tsconfig.json"] },
    ]);
  }, 60_000);

  test("an exception that hides nothing is named by what it is", () => {
    const why = "an entry of this test";
    expect(describeStale({ exception: { folder: "vendored/", rules: ["vendor"], why }, files: ["vendored/"] })).toBe(
      "the folder vendored/ (vendor)",
    );
    expect(
      describeStale({ exception: { file: "a.sql", rules: ["vendor", "audit-standard"], why }, files: ["a.sql"] }),
    ).toBe("the file a.sql (vendor, audit-standard)");
    expect(describeStale({ exception: { text: "two words", files: ["a.ts", "b.ts"], why }, files: ["b.ts"] })).toBe(
      '"two words" in b.ts',
    );
  });

  test("the list of exceptions in the check's own file does not keep an exception alive", () => {
    // Every allowed text is written out in ALLOWED. If that counted as a use,
    // no text exception could ever be reported as stale.
    for (const e of ALLOWED) {
      if ("text" in e) expect(e.files).not.toContain("test/words-check.ts");
    }
  });
});

describe("what the scan reads of a file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "words-check-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const at = (name: string): string => path.join(dir, name);

  test("a text file is read whole", () => {
    writeFileSync(at("plain.md"), "one\ntwo\n");
    expect(textOf(at("plain.md"))).toBe("one\ntwo\n");
  });

  test("a file with a NUL byte is not text", () => {
    writeFileSync(at("image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    expect(textOf(at("image.bin"))).toBe("");
  });

  test("a link is not followed, whether it points to a file, to a folder or to nothing", () => {
    writeFileSync(at("target.md"), "the text of another file\n");
    mkdirSync(at("folder"));
    symlinkSync(at("target.md"), at("to-a-file"));
    symlinkSync(at("folder"), at("to-a-folder"));
    symlinkSync(at("no-such-file"), at("to-nothing"));
    expect(textOf(at("to-a-file"))).toBe("");
    expect(textOf(at("to-a-folder"))).toBe("");
    expect(textOf(at("to-nothing"))).toBe("");
  });

  test("a folder has no text, and a file that is gone is left out", () => {
    expect(textOf(at("folder"))).toBe("");
    expect(textOf(at("deleted.md"))).toBeNull();
  });
});
