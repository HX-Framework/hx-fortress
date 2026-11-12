// The words check.
//
// HX Fortress is an open-source program that an organization runs for itself.
// It can connect to a control plane, and it names none: not in a screen, a
// doc, a comment, a test name or a fixture. It also makes no claim about an
// audit attestation. This file holds the repository to both. It fails when a
// file of the repository, or the name of one, holds a word from RULES outside
// the exceptions in ALLOWED.
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

export interface Rule {
  id: string;
  /** Each pattern is searched over a file's whole text and over its name. A
   *  match counts only where it stands as a word of its own: see
   *  `isWholeWord`. */
  patterns: readonly RegExp[];
  /** What the finding tells the person who wrote the line. */
  say: string;
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
];

export type Exception =
  /** Every match of the named rules in this file's text and in its name. */
  | { file: string; rules: readonly string[]; why: string }
  /** This exact text, where it stands as a word of its own, in these files. */
  | { text: string; files: readonly string[]; why: string };

const APPLIED_MIGRATION = "an applied migration is never edited";
const UNTIL_PROTOCOL_RENAME =
  "the protocol package's name, until its owner picks a new one and the package is renamed";
const UNTIL_FOLDER_RENAME =
  "the service label of an install on a host, renamed together with the Fortress's folder";
const REWRITTEN_NEXT =
  "rewritten by the change that moves install, update and trust off a control plane";
const UNTIL_DISPATCH_SETTINGS =
  "the release workflow's fallback, until this repository holds DOWNSTREAM_DISPATCH_REPOSITORY and DOWNSTREAM_DISPATCH_TOKEN";

export const ALLOWED: readonly Exception[] = [
  // ── The check itself ──────────────────────────────────────────────────────
  { file: "test/words-check.ts", rules: ["vendor"], why: "the check names what it looks for" },
  { file: "test/words-check.test.ts", rules: ["vendor"], why: "the check's own test names what it looks for" },

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

  // ── Not yet rewritten ─────────────────────────────────────────────────────
  { file: "README.md", rules: ["vendor"], why: REWRITTEN_NEXT },
  { file: "SECURITY.md", rules: ["vendor"], why: REWRITTEN_NEXT },
  { file: "RELEASING.md", rules: ["vendor"], why: REWRITTEN_NEXT },
  { file: "install-from-source.sh", rules: ["vendor"], why: REWRITTEN_NEXT },
  { file: "src/update.ts", rules: ["vendor"], why: REWRITTEN_NEXT },
  { file: "src/host/trust/signing-keys.ts", rules: ["vendor"], why: REWRITTEN_NEXT },
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

interface Span {
  start: number;
  end: number;
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
 * The findings in one file's name and text.
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
  const waived = exceptions.filter(isFileException).filter((e) => e.file === file);
  const texts = exceptions.filter(
    (e): e is Extract<Exception, { text: string }> => !isFileException(e) && e.files.includes(file),
  );
  const mark = (e: Exception): void => {
    const files = used.get(e) ?? new Set<string>();
    files.add(file);
    used.set(e, files);
  };

  const findings: Finding[] = [];
  const scan = (value: string, lineOf: (index: number) => number): void => {
    const allowed = texts.flatMap((e) => occurrences(e.text, value).map((span) => ({ ...span, e })));
    const found: Array<Span & { match: string; rule: Rule }> = [];
    for (const rule of rules) {
      for (const pattern of rule.patterns) {
        for (const word of wordsMatching(pattern, value)) found.push({ ...word, rule });
      }
    }
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
      findings.push({ file, line: lineOf(word.start), rule: word.rule.id, match: word.match, say: word.rule.say });
    }
  };

  scan(file, () => 0);
  const lineStarts = [0];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lineStarts.push(at + 1);
  scan(text, (index) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((lineStarts[middle] ?? 0) <= index) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  });
  return findings;
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
    const named = isFileException(e) ? [e.file] : e.files;
    const idle = named.filter((file) => !used.get(e)?.has(file));
    if (idle.length > 0) stale.push({ exception: e, files: idle });
  }
  return { findings, stale, files };
}

export function describeStale(s: Stale): string {
  const e = s.exception;
  if (isFileException(e)) return `the file ${e.file} (${e.rules.join(", ")})`;
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
