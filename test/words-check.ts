// The words check.
//
// HX Fortress is an open-source program that an organization runs for itself.
// It can connect to a control plane, and it names none: not in a screen, a
// doc, a comment, a test name or a fixture. It also makes no claim about an
// audit attestation. This file holds the repository to both. It fails when a
// file of the repository, or the name of one, holds a word from RULES outside
// the exceptions in ALLOWED.
//
// Two words are held out of what a person reads, and only out of that: the
// link to a control plane is "the connection", and the other side is "the
// control plane". A screen, a doc, a log line, an error and the name of a test
// say neither "tunnel" nor "relay". A name in the code may: see `readOf` for
// what counts as read.
//
// The check reads what is written in a file. It cannot see a value that code
// puts on a screen: what a database stores, or the name of a log's module.
// One stored value holds one of the two words, and `arrivalWords` in
// src/ui/copy.ts gives the words a screen shows for it.
//
//   bun test/words-check.ts           prints every finding, exits 1 on any
//   bun run check                     runs the same scan as a test
//
// What to write instead: "the control plane" for the service a Fortress can
// connect to, and `control.example` wherever an example needs an address.
//
// An exception is one entry in ALLOWED, with its reason. The test fails on an
// entry that hides nothing in a file it names, so the list can only get
// shorter.
//
// The check lives under test/ and not under scripts/: a push to main that
// touches scripts/ starts a release, and shortening this list must not.

import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";

import * as ts from "typescript";

export interface Rule {
  id: string;
  /** Each pattern is searched over a file's whole text and over its name. A
   *  match counts only where it stands as a word of its own: see
   *  `isWholeWord`. */
  patterns: readonly RegExp[];
  /** What the finding tells the person who wrote the line. */
  say: string;
  /** "read": the rule holds only for what a person reads of a file (see
   *  `readOf`), and not for the file's name. Left out, the rule holds for a
   *  file's whole text and for its name. */
  where?: "read";
  /** For a "read" rule: letters that are in a file wherever one of its
   *  patterns could match. A source is parsed only when they are there. Left
   *  out, every source is parsed. */
  quick?: RegExp;
}

/** What may stand between the parts of the audit attestation's name: spaces,
 *  line ends, punctuation, and the marks that start a comment line. */
const GAP = String.raw`[\s._*#/>-]*`;

export const RULES: readonly Rule[] = [
  {
    id: "vendor",
    patterns: [
      // The first control plane's vendor, in the spellings it has had here:
      // its domain, its GitHub owner, its name with an underscore, and its
      // name run together.
      /let[._-]?ai/i,
      // Its name as two words, capitals as written. `let ai = 1` is code.
      /Let AI/,
      // The prefix of its ticket numbers.
      /letair/i,
      // Its domain written backwards, as a service label is.
      /ai\.let/i,
      // Its repository, the package scope of that repository, and the login
      // of its development database.
      /let[-_]?forge/i,
      /@forge\//i,
      /forge:forge/i,
      // Its product.
      /workbench/i,
    ],
    say: 'HX Fortress names no vendor. Write "the control plane", and use control.example in an example.',
  },
  {
    id: "audit-standard",
    patterns: [
      new RegExp(`soc${GAP}(?:2|ii|two)`, "i"),
      new RegExp(`soc${GAP}type${GAP}(?:1|2|i{1,2})`, "i"),
    ],
    say: "HX Fortress says what the program does. It claims no audit attestation: remove the claim.",
  },
  {
    id: "connection-words",
    where: "read",
    quick: /tunnel|relay/i,
    patterns: [
      // The two words, with the endings a sentence gives them, in both
      // spellings: tunneled and tunnelled. The letters before and after
      // decide, not `isWholeWord`: `tunnelUrl` in a sentence is a name of the
      // code, and it is not the word.
      /(?<![A-Za-z0-9_])(?:tunnel|relay)(?:s|l?ed|l?ing|l?ers?)?(?![A-Za-z0-9_])/i,
    ],
    say: 'A person reads "the connection" for the link to a control plane and "the control plane" for the other side. Write the sentence without this word.',
  },
];

export type Exception =
  /** Every match of the named rules in this file's text and in its name. */
  | { file: string; rules: readonly string[]; why: string }
  /** Every match of the named rules in the files under this folder. The
   *  folder's name ends with a slash. */
  | { folder: string; rules: readonly string[]; why: string }
  /** This exact text, where it stands as a word of its own, in these files. */
  | { text: string; files: readonly string[]; why: string };

const APPLIED_MIGRATION = "an applied migration is never edited";
const UNTIL_PROTOCOL_RENAME =
  "the protocol package's name, until its owner picks a new one and the package is renamed";
const UNTIL_FOLDER_RENAME =
  "the service label of an install on a host, renamed together with the Fortress's folder";
const UNTIL_DISPATCH_SETTINGS =
  "the release workflow's fallback, until this repository holds DOWNSTREAM_DISPATCH_REPOSITORY and DOWNSTREAM_DISPATCH_TOKEN";

export const ALLOWED: readonly Exception[] = [
  // ── The check itself ──────────────────────────────────────────────────────
  {
    file: "test/words-check.ts",
    rules: ["vendor", "connection-words"],
    why: "the check names what it looks for, and its list of exceptions quotes what it lets through",
  },
  {
    file: "test/words-check.test.ts",
    rules: ["vendor", "connection-words"],
    why: "the check's own test names what it looks for",
  },

  // ── What a pinned digest holds ────────────────────────────────────────────
  // The development seed describes one of its cases by the channel values the
  // database holds. The seed's digest is pinned (test/dev-seed.test.ts), and
  // it changes only when the seeded world does, not for a word.
  {
    text: "sessions on tunnel, gateway, reconciled and NULL provenance",
    files: ["src/dev/corpus.ts"],
    why: "the development seed's description of a case, which is part of the seed's pinned digest",
  },

  // ── A folder that is written from elsewhere ───────────────────────────────
  // The data runner's files come from its home repository, by a script, and
  // are not edited here (data-runner/VENDORED.md). Its word is also another
  // thing: the way a hosted runner reaches a database, which this build of the
  // runner leaves out.
  {
    folder: "data-runner/",
    rules: ["connection-words"],
    why: "the data runner is written into this folder from its home repository and is not edited here",
  },

  // ── Names that travel between two sides ───────────────────────────────────
  // One flag of the protocol's residency answer holds the vendor's name. The
  // Fortress reads it in one file and says `controlPlaneCopy` everywhere else.
  // Renaming the field is a change to the protocol.
  {
    text: "letaiCopy",
    files: ["src/console/audit-witness.ts", "test/audit-engine.test.ts"],
    why: "a field of the protocol's residency answer: read in one file, and written by that file's test as a control plane sends it",
  },
  {
    text: "@let-ai/hx-protocol",
    files: ["package.json", "eslint.config.js", "src/protocol/index.ts", "src/protocol/VENDORED.md"],
    why: UNTIL_PROTOCOL_RENAME,
  },
  {
    text: "ai.let.hx-fortress",
    files: [
      "src/modules/session-vault/supervised-restart.test.ts",
      "src/service/types.ts",
      "src/ui/service-control.ts",
      "test/cli-lifecycle.test.ts",
      "test/cli.test.ts",
      "test/service-control.test.ts",
      "test/service-managers.test.ts",
    ],
    why: UNTIL_FOLDER_RENAME,
  },

  // ── What a database already holds ─────────────────────────────────────────
  { file: "src/host/postgres/migrations/0014_backfill_session_titles.sql", rules: ["vendor"], why: APPLIED_MIGRATION },
  { file: "src/host/postgres/migrations/0021_audit_engine.sql", rules: ["vendor"], why: APPLIED_MIGRATION },
  { file: "src/host/postgres/migrations/0022_roster.sql", rules: ["vendor"], why: APPLIED_MIGRATION },
  { file: "src/host/postgres/migrations/0024_residency_unchecked.sql", rules: ["vendor"], why: APPLIED_MIGRATION },
  { file: "src/host/postgres/migrations/0026_cloud_witness_default.sql", rules: ["vendor"], why: APPLIED_MIGRATION },
  { file: "src/host/postgres/migrations/0028_residency_unwitnessable.sql", rules: ["vendor"], why: APPLIED_MIGRATION },
  { file: "src/host/postgres/migrations/0030_copy_unchecked.sql", rules: ["vendor"], why: APPLIED_MIGRATION },
  {
    text: "also_at_letai",
    files: [
      "src/host/postgres/migrations/0032_also_at_control_plane.sql",
      "test/also-at-control-plane-migration-db.test.ts",
    ],
    why: "the migration that moves a count and a verdict off this name, and its test, have to name what they move",
  },

  // ── Settings only the repository's owner can make ─────────────────────────
  {
    text: "let-ai/let-forge",
    files: [".github/workflows/release.yml"],
    why: UNTIL_DISPATCH_SETTINGS,
  },
  {
    text: "LET_FORGE_REPO_DISPATCH_TOKEN",
    files: [".github/workflows/release.yml"],
    why: UNTIL_DISPATCH_SETTINGS,
  },
  {
    text: "Let AI",
    files: ["LICENSE"],
    why: "the copyright holder the licence names: who holds the copyright is the owner's decision, not a choice of words",
  },
];

/** Files the scan never opens: generated lockfiles. They hold package names
 *  and long hashes, no words a person wrote, and a hash can spell anything. */
const SKIPPED: ReadonlySet<string> = new Set(["bun.lock", "ui/bun.lock"]);

export interface Finding {
  file: string;
  /** 1-based. 0 when the finding is the file's own name. */
  line: number;
  rule: string;
  /** The text that matched. */
  match: string;
  say: string;
}

/** Which exceptions hid something, and in which files. */
export type Used = Map<Exception, Set<string>>;

const isFileException = (e: Exception): e is Extract<Exception, { file: string }> => "file" in e;
const isFolderException = (e: Exception): e is Extract<Exception, { folder: string }> => "folder" in e;
const isTextException = (e: Exception): e is Extract<Exception, { text: string }> => "text" in e;

const isUpper = (c: string): boolean => c >= "A" && c <= "Z";
const isLower = (c: string): boolean => c >= "a" && c <= "z";
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isAlnum = (c: string): boolean => isUpper(c) || isLower(c) || isDigit(c);

/**
 * Whether text[start, end) stands as a word of its own.
 *
 * A word ends at punctuation, at an underscore, and at the capital that starts
 * the next part of a camelCase name. So `letaiCopy`, `alsoAtLetai` and
 * `LETAI_KEYS` each hold the word, and `staleTail` and `outlet.aiSummary` do
 * not: without this, an ordinary name that happens to run those letters
 * together would fail the build.
 */
export function isWholeWord(text: string, start: number, end: number): boolean {
  const first = text[start] ?? "";
  const last = text[end - 1] ?? "";
  const before = text[start - 1] ?? "";
  const after = text[end] ?? "";
  const afterNext = text[end + 1] ?? "";
  const startsWord =
    !isAlnum(first) || !isAlnum(before) || ((isLower(before) || isDigit(before)) && isUpper(first));
  const endsWord =
    !isAlnum(last) ||
    !isAlnum(after) ||
    (isUpper(after) && (isLower(last) || isDigit(last) || isLower(afterNext)));
  return startsWord && endsWord;
}

export interface Span {
  start: number;
  end: number;
}

/** A part of a source that a person reads. In the text of a string or of a
 *  template a backslash starts an escape, which is no text: `\n` is a line
 *  end and not the letter n. The text between two JSX tags has no escapes. */
export interface ReadPart extends Span {
  escapes: boolean;
}

/** The endings of a program source: a file the TypeScript parser reads. */
const SOURCE: ReadonlySet<string> = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * Whether the text of one string is something a person reads.
 *
 * A sentence, a label of several words and a piece of either hold a space,
 * at an end too: `" relays"` is the end of a sentence that code puts
 * together. A label of one word starts with a capital: "Relay", "Status:". A
 * string of one lower-case word is a value the code compares or stores
 * (`"tunnel"`, `"gateway"`), and so is a path, an id and the name of a
 * variable of the environment.
 */
export function isReadText(value: string): boolean {
  return /\s/.test(value) || /^[A-Z][a-z]+(?![A-Za-z0-9_])/.test(value);
}

/**
 * The parts of a file that a person reads, as ranges of its text. "all" when
 * that is the whole file, "none" when it is nothing of it.
 *
 * IN A PROGRAM SOURCE a person reads:
 *
 *   - the text of a string or of a template that `isReadText` takes for a
 *     sentence or a label. That is what a screen shows, what a log line and
 *     an error say, and what a test is called. A template is judged by its
 *     own text without its expressions. Strings joined with `+` are judged
 *     together: when one of them is a sentence, each of them is a piece of it;
 *   - the text between two JSX tags, always: a page shows it, whatever it is.
 *
 * Nobody but the next programmer reads a name in the code, a comment, a
 * regular expression, or what names a module: the path of an import, of an
 * export, of `require(…)` and of `import(…)`. Two more things are left out.
 * The expressions inside a template are code, and are read on their own
 * terms. And a template with the tag `sql` is a statement for the database:
 * it holds the values a database stores, in the spelling the rows already
 * have. A statement that is written as a plain string is read like any other
 * string.
 *
 * A source that the parser cannot read to its end is read whole: nothing in
 * it is taken for a name or a comment on the word of a parse that failed.
 *
 * AN APPLIED MIGRATION is read by nobody: it ran, and it is never edited.
 * EVERY OTHER FILE is read whole: a doc, a script, a workflow, a template for
 * a deployment.
 */
export function readOf(file: string, text: string): ReadPart[] | "all" | "none" {
  const ending = path.extname(file).toLowerCase();
  if (ending === ".sql" && /(?:^|\/)migrations\//.test(file)) return "none";
  if (!SOURCE.has(ending)) return "all";
  const kept = PARSED.get(file);
  if (kept && kept.text === text) return kept.parts;
  const parts = readOfSource(file, text, ending);
  PARSED.set(file, { text, parts });
  return parts;
}

/** What `readOf` worked out for a source, by the file's name: the parser is
 *  the slow part of the check, and one run scans the repository more than
 *  once. An entry counts only for the very text it was made from. */
const PARSED = new Map<string, { text: string; parts: ReadPart[] | "all" }>();

function readOfSource(file: string, text: string, ending: string): ReadPart[] | "all" {
  const kind =
    ending === ".tsx" || ending === ".jsx"
      ? ts.ScriptKind.TSX
      : ending === ".ts" || ending === ".mts" || ending === ".cts"
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  // The parser goes on after a fault, and what it makes of the rest is a
  // guess: a string that never closes takes the lines after it with it.
  const faults = (source as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
  if (faults === undefined || faults.length > 0) return "all";

  const parts: ReadPart[] = [];
  /** The text of a literal lies between its two marks: a quote, a backtick,
   *  or the braces that open and close an expression of a template. */
  const inner = (node: ts.Node, closing: number): ReadPart => ({
    start: node.getStart(source) + 1,
    end: node.end - closing,
    escapes: true,
  });
  const nameOf = (node: ts.Expression): string | null =>
    ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : null;
  /** `sql`, `db.sql`, and either of them called first: sql(options)`…`. */
  const isSql = (tag: ts.Expression): boolean =>
    nameOf(ts.isCallExpression(tag) ? tag.expression : tag)?.toLowerCase() === "sql";
  const textOfTemplate = (node: ts.TemplateExpression): string =>
    node.head.text + node.templateSpans.map((part) => part.literal.text).join("");
  /** What `a + (b + c)` joins: a, b and c. */
  const joined = (node: ts.Expression): ts.Expression[] => {
    if (ts.isParenthesizedExpression(node)) return joined(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return [...joined(node.left), ...joined(node.right)];
    }
    return [node];
  };
  const isSentence = (node: ts.Expression): boolean =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      ? isReadText(node.text)
      : ts.isTemplateExpression(node) && isReadText(textOfTemplate(node));

  /** `statement`: inside a statement for the database. `piece`: one of the
   *  strings of a sentence that is joined with `+`. */
  const visit = (node: ts.Node, statement: boolean, piece: boolean): void => {
    // What names a module is a path and not a text.
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isExternalModuleReference(node) ||
      ts.isImportTypeNode(node)
    ) {
      return;
    }
    if (ts.isModuleDeclaration(node)) {
      if (node.body) visit(node.body, statement, false);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      for (const argument of node.arguments.slice(1)) visit(argument, statement, false);
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const operands = joined(node);
      const sentence = piece || operands.some(isSentence);
      for (const operand of operands) visit(operand, statement, sentence);
      return;
    }
    // Brackets and a choice between two strings pass on what they stand in.
    if (ts.isParenthesizedExpression(node)) {
      visit(node.expression, statement, piece);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      visit(node.condition, statement, false);
      visit(node.whenTrue, statement, piece);
      visit(node.whenFalse, statement, piece);
      return;
    }
    if (ts.isTaggedTemplateExpression(node)) {
      visit(node.tag, statement, false);
      visit(node.template, statement || isSql(node.tag), false);
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!statement && (piece || isReadText(node.text))) parts.push(inner(node, 1));
      return;
    }
    if (ts.isTemplateExpression(node)) {
      if (!statement && (piece || isReadText(textOfTemplate(node)))) {
        parts.push(inner(node.head, 2));
        for (const part of node.templateSpans) parts.push(inner(part.literal, ts.isTemplateTail(part.literal) ? 1 : 2));
      }
      // What an expression of the template holds is read on its own terms.
      for (const part of node.templateSpans) visit(part.expression, false, false);
      return;
    }
    if (ts.isJsxText(node)) {
      if (node.text.trim().length > 0) parts.push({ start: node.getFullStart(), end: node.end, escapes: false });
      return;
    }
    ts.forEachChild(node, (child) => visit(child, statement, false));
  };
  visit(source, false, false);
  return parts.sort((a, b) => a.start - b.start);
}

/** A backslash and what it takes with it, in the text of a string. */
const ESCAPE = /\\(?:u\{[0-9A-Fa-f]*\}|u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2}|[0-7]{1,3}|\r\n|[\s\S])/g;

/**
 * A file as the rules for what a person reads see it: a text of the same
 * length, in which everything that is not read is a blank. A line end stays
 * where it is, so a place in this text is the same place in the file.
 *
 * An escape inside a string is a blank too. The `n` of `\nTunnel` is no
 * letter in front of the word, and `\tunnel` is a tab and five letters.
 *
 * Null when nothing of the file is read.
 */
export function readView(file: string, text: string): string | null {
  const parts = readOf(file, text);
  if (parts === "none") return null;
  if (parts === "all") return text;
  const blank = (piece: string): string => piece.replace(/[^\n]/g, " ");
  let view = "";
  let at = 0;
  for (const part of parts) {
    if (part.start < at) continue;
    const piece = text.slice(part.start, part.end);
    view += blank(text.slice(at, part.start)) + (part.escapes ? piece.replace(ESCAPE, blank) : piece);
    at = part.end;
  }
  return view + blank(text.slice(at));
}

function wordsMatching(pattern: RegExp, text: string): Array<Span & { match: string }> {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const out: Array<Span & { match: string }> = [];
  for (const m of text.matchAll(global)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (m[0].length > 0 && isWholeWord(text, start, end)) out.push({ start, end, match: m[0] });
  }
  return out;
}

function occurrences(needle: string, text: string): Span[] {
  const out: Span[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    if (isWholeWord(text, at, at + needle.length)) out.push({ start: at, end: at + needle.length });
  }
  return out;
}

/**
 * The findings in one file's name and text, in the order of their places.
 *
 * A match is let through when it lies wholly inside an allowed text, or when
 * the file is excepted for the match's rule. `used` collects which exceptions
 * hid something and where, so the caller can tell which entries are still
 * needed.
 */
export function scanText(
  file: string,
  text: string,
  exceptions: readonly Exception[],
  used: Used = new Map(),
  rules: readonly Rule[] = RULES,
): Finding[] {
  const waived = exceptions.filter(
    (e): e is Extract<Exception, { rules: readonly string[] }> =>
      (isFileException(e) && e.file === file) || (isFolderException(e) && file.startsWith(e.folder)),
  );
  const texts = exceptions.filter(isTextException).filter((e) => e.files.includes(file));
  const mark = (e: Exception): void => {
    const files = used.get(e) ?? new Set<string>();
    files.add(file);
    used.set(e, files);
  };

  const everywhere = rules.filter((rule) => rule.where !== "read");
  const read = rules.filter((rule) => rule.where === "read");

  const lineStarts = [0];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lineStarts.push(at + 1);
  const lineOf = (index: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((lineStarts[middle] ?? 0) <= index) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };

  // Each finding with its place in the file. The file's own name comes first.
  const placed: Array<{ at: number; finding: Finding }> = [];
  const scan = (value: string, among: readonly Rule[], inName = false): void => {
    const found: Array<Span & { match: string; rule: Rule }> = [];
    for (const rule of among) {
      for (const pattern of rule.patterns) {
        for (const word of wordsMatching(pattern, value)) found.push({ ...word, rule });
      }
    }
    if (found.length === 0) return;
    const allowed = texts.flatMap((e) => occurrences(e.text, value).map((span) => ({ ...span, e })));
    found.sort((a, b) => a.start - b.start || a.end - b.end);
    let reported = -1;
    for (const word of found) {
      const inside = allowed.find((span) => span.start <= word.start && word.end <= span.end);
      if (inside) {
        mark(inside.e);
        continue;
      }
      const waiver = waived.find((e) => e.rules.includes(word.rule.id));
      if (waiver) {
        mark(waiver);
        continue;
      }
      // Two patterns of one rule can find the same place. Say it once.
      if (word.start < reported) continue;
      reported = word.end;
      placed.push({
        at: inName ? -1 : word.start,
        finding: { file, line: inName ? 0 : lineOf(word.start), rule: word.rule.id, match: word.match, say: word.rule.say },
      });
    }
  };

  scan(file, everywhere, true);
  scan(text, everywhere);

  // The rules for what a person reads. Most files hold none of their words,
  // and the parser is the slow part of the check: a source is parsed only for
  // a rule whose `quick` letters are somewhere in the file.
  const wanted = read.filter((rule) => rule.quick === undefined || rule.quick.test(text));
  if (wanted.length > 0) {
    const view = readView(file, text);
    if (view !== null) scan(view, wanted);
  }
  return placed.sort((a, b) => a.at - b.at).map((entry) => entry.finding);
}

/**
 * What a commit would hold: tracked files, and files not yet added that no
 * ignore rule covers. Null outside a git checkout, where nothing says which
 * files those are.
 */
export function repositoryFiles(root: string): string[] | null {
  if (!existsSync(path.join(root, ".git"))) return null;
  const result = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const reason = (result.stderr || result.error?.message || "it gave no reason").trim();
    throw new Error(`The words check lists the repository's files with git, and git failed: ${reason}`);
  }
  return [...new Set(result.stdout.split("\0").filter((name) => name.length > 0))].sort();
}

/** An exception that hid nothing in `files`: an entry, or a file of an entry,
 *  to remove. */
export interface Stale {
  exception: Exception;
  files: readonly string[];
}

export interface ScanResult {
  findings: Finding[];
  stale: Stale[];
  files: number;
}

/**
 * The text of one file, for the scan.
 *
 * Null when the file is listed by git and gone from disk: a deletion that is
 * not staged yet. An empty text for what has a name and no text of its own: a
 * link, the folder of a submodule, and a file with a NUL byte, which is not
 * text. The name of each of those is still checked.
 *
 * The file is opened once and everything after that goes through the open
 * descriptor, so the file that is checked is the file that is read. A link is
 * not followed: what it points to is either another file of the repository,
 * which is read under its own name, or no file of the repository at all.
 */
export function textOf(absolute: string): string | null {
  let fd: number;
  try {
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    // What opening a link without following it answers, on Linux and macOS
    // (ELOOP) and on the BSDs (EMLINK).
    if (code === "ELOOP" || code === "EMLINK") return "";
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) return "";
    const bytes = readFileSync(fd);
    return bytes.includes(0) ? "" : bytes.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Null outside a git checkout: see `repositoryFiles`. */
export function scanRepository(
  root: string,
  exceptions: readonly Exception[] = ALLOWED,
  rules: readonly Rule[] = RULES,
): ScanResult | null {
  const names = repositoryFiles(root);
  if (names === null) return null;
  const used: Used = new Map();
  const findings: Finding[] = [];
  let files = 0;
  for (const file of names) {
    if (SKIPPED.has(file)) continue;
    const text = textOf(path.join(root, file));
    if (text === null) continue;
    files += 1;
    findings.push(...scanText(file, text, exceptions, used, rules));
  }
  const stale: Stale[] = [];
  for (const e of exceptions) {
    // A folder is needed while one file under it is.
    if (isFolderException(e)) {
      if ((used.get(e)?.size ?? 0) === 0) stale.push({ exception: e, files: [e.folder] });
      continue;
    }
    const named = isFileException(e) ? [e.file] : e.files;
    const idle = named.filter((file) => !used.get(e)?.has(file));
    if (idle.length > 0) stale.push({ exception: e, files: idle });
  }
  return { findings, stale, files };
}

export function describeStale(s: Stale): string {
  const e = s.exception;
  if (isFileException(e)) return `the file ${e.file} (${e.rules.join(", ")})`;
  if (isFolderException(e)) return `the folder ${e.folder} (${e.rules.join(", ")})`;
  return `"${e.text}" in ${s.files.join(", ")}`;
}

export function describeFinding(f: Finding): string {
  const where = f.line === 0 ? `${f.file} (the file's name)` : `${f.file}:${f.line}`;
  return `${where}: "${f.match.replace(/\s+/g, " ")}". ${f.say}`;
}

if (import.meta.main) {
  const result = scanRepository(path.resolve(import.meta.dir, ".."));
  if (result === null) {
    console.log("The words check reads the files git lists, and this folder is not a git checkout.");
    process.exitCode = 1;
  } else {
    for (const finding of result.findings) console.log(describeFinding(finding));
    for (const s of result.stale) {
      console.log(`The exception for ${describeStale(s)} hides nothing now. Remove it from ALLOWED.`);
    }
    if (result.findings.length > 0 || result.stale.length > 0) {
      console.log(
        `\n${result.findings.length} finding(s), ${result.stale.length} exception(s) to remove, in ${result.files} files.`,
      );
      process.exitCode = 1;
    } else {
      console.log(`The words check passed: ${result.files} files, ${ALLOWED.length} exceptions.`);
    }
  }
}
