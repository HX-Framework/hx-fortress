// Nothing the console renders, logs or throws may carry credential material.
//
// The rule is stated absolutely in the threat model, and it has to be enforced
// at the LAST step rather than at each source: a DSN reaches a rendered page
// through pg.json, through ui.json, through a driver's error message and through
// an exception nobody wrote, and only the last of those is a place a reviewer
// would think to look. So every value that leaves the console goes through here.
//
// It does not try to recognise secrets by entropy. It recognises the SHAPES the
// fortress actually holds - a connection string with a password, a bearer token,
// a base64url credential in a query string - and replaces the secret part while
// leaving enough of the value to be useful in a diagnosis.

/** What a redacted value reads as. One string, so a reader learns to see it. */
export const REDACTED = "[redacted]";

// EVERY run here is bounded, and the password run cannot cross a `//`.
//
// An unbounded `*` after a `\b`, or after a `://` that may not be followed by an
// `@`, rescans to the end of the whitespace-free token from each starting
// position — quadratic, and measured through the real chain on a 128 KB line:
// 8.8 s for a dotted run against the scheme, 3.6 s for repeated `a://` and 1.2 s
// for repeated `redis://h:1/` against the credential runs, with every later open
// of the Logs tab paying it again. No scheme is thirty characters long; a
// password may legitimately contain one `/` and does here, but never a `//`,
// which is what bounds the last two. All three are now ≤6 ms.
//
// The user run is `{0,256}`, not `{1,...}`: `redis://:secret@host` carries no
// user, and requiring one left that password in the clear.
const DSN = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)([^\s:/@]{0,256}):((?:[^\s@/]|\/(?!\/)){0,256})@/gi;
const BEARER = /\b(bearer|token|authorization)(\s*[=:]\s*|\s+)([A-Za-z0-9._~+/=-]{8,})/gi;
const QUERY_SECRET = /([?&](?:password|passwd|pwd|token|secret|credential|key)=)([^&\s]+)/gi;

// ── the secret-named field, in the two grammars it is written in ────────────
//
// A field's value ENDS DIFFERENTLY in each, and one rule cannot serve both:
// a delimiter set wide enough for an env line (`password=a,b host=c`) runs off
// the end of a compact JSON line and deletes everything after the secret, while
// one narrow enough for JSON leaves the tail of a comma-bearing env value in the
// clear. Both of those shipped, in successive attempts at a single rule. So
// there are two rules, each with its own value grammar, and neither has to guess
// which grammar it is in.
//
// The names cover the `<prefix>_password` spellings too (`dsn_password`,
// `POSTGRES_PASSWORD`), which the bare `\b(password)` could never match — a `_`
// is a word character, so there is no boundary before the name.
const SECRET_FIELD = String.raw`(?:[a-z0-9]+[_-])?(?:password|passwd|pwd)|secret[_-]?access[_-]?key|aws[_-]?secret[_-]?access[_-]?key|session[_-]?token|private[_-]?key[_-]?id`;

/** A JSON value, in the order the arms must be tried. */
const JSON_VALUE = [
  // Escaped-quoted FIRST, and it stops at the first `\"` — the shape
  // `JSON.stringify` produces for a driver error embedded as a string. Treating
  // that closing `\"` as an ordinary escape ran the match to the last plain
  // quote on the line and deleted every field of the embedded error after the
  // secret.
  String.raw`(?<esc>\\")(?:(?!\\")[\s\S])*\\"`,
  String.raw`(?<q>")(?:[^"\\]|\\.)*"`,
  // Structures, consumed whole to three levels; deeper falls to the bare arm,
  // which is bounded by the JSON delimiters below rather than by whitespace.
  String.raw`\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}`,
  String.raw`\[(?:[^\[\]]|\[(?:[^\[\]]|\[[^\[\]]*\])*\])*\]`,
  // ANCHORED. Unanchored, `null` matched the head of `nullS3cretValue` and the
  // passthrough below then emitted the whole credential untouched.
  String.raw`(?:null|true|false)(?![^\s,;}\])])`,
  String.raw`-?\d+(?:\.\d+)?`,
  String.raw`[^\s,;}\])]+`,
].join("|");

/** An env / DSN value: ended by whitespace, `;`, `&` or a CLOSING BRACKET —
 *  never by a comma, which is a legal character in one, and stopping at it left
 *  the tail of the credential in the clear. The bracket matters because these
 *  fields turn up inside parenthesised diagnostics ("rotate failed
 *  (password=… ) at 10:00"), where swallowing the `)` deletes what follows. */
const ENV_END = String.raw`\s;&)\]}`;
const ENV_VALUE = [
  String.raw`'[^']*'`,
  String.raw`(?<q>")(?:[^"\\]|\\.)*"`,
  String.raw`(?:null|true|false)(?![^${ENV_END}])`,
  String.raw`[^${ENV_END}]+`,
].join("|");

const JSON_FIELD = new RegExp(
  String.raw`(?<label>\\?"(?:${SECRET_FIELD})\\?")(?<sep>\s*:\s*)(?<value>${JSON_VALUE})`,
  "gi",
);
const ENV_FIELD = new RegExp(
  String.raw`\b(?<label>${SECRET_FIELD})(?<sep>\s*[=:]\s*)(?<value>${ENV_VALUE})`,
  "gi",
);

/** The groups a field rule binds. Read by NAME: the arms carry a different
 *  number of positional groups depending on which one matched, and binding those
 *  by index is how a replacement ends up emitting the wrong text. */
interface FieldGroups {
  label?: string;
  sep?: string;
  value?: string;
  q?: string;
  esc?: string;
}

function groupsOf(args: unknown[]): FieldGroups {
  const last = args[args.length - 1];
  return (typeof last === "object" && last !== null ? last : {}) as FieldGroups;
}

/** Replace a JSON field's value, keeping the line parseable. A structure, a
 *  number or a bare token becomes a QUOTED redaction — a bare `[redacted]` where
 *  a value was is a line no reader accepts, and the Logs tab's whole value is
 *  that a machine can read it back. */
function redactJsonField(...args: unknown[]): string {
  const g = groupsOf(args);
  const label = g.label ?? "";
  const sep = g.sep ?? "";
  const raw = g.value ?? "";
  // `null`, `true` and `false` are STATES — whether something is configured —
  // and they carry nothing. A NUMBER is not on that list: none of these fields
  // has a numeric state, so a number under one is a value somebody chose.
  if (/^(?:null|true|false)$/i.test(raw)) return `${label}${sep}${raw}`;
  const quote = g.esc ? String.raw`\"` : '"';
  return `${label}${sep}${quote}${REDACTED}${quote}`;
}

/** Replace an env / DSN field's value. No quoting is added: the grammar has
 *  none, and inventing a quote would change what the line says. */
function redactEnvField(...args: unknown[]): string {
  const g = groupsOf(args);
  const label = g.label ?? "";
  const sep = g.sep ?? "";
  const raw = g.value ?? "";
  if (/^(?:null|true|false)$/i.test(raw)) return `${label}${sep}${raw}`;
  const quote = g.q ?? "";
  return `${label}${sep}${quote}${REDACTED}${quote}`;
}

// The shapes THIS appliance holds, which the four above do not recognise at all:
// a GCS service-account JSON, an AWS access key pair, a presigned signature, and
// PGPASSWORD. credentials.json is made of exactly these, and the daemon log
// quotes raw SDK errors. Kept in step with `command-params.ts`, which has had
// the same list all along on the parameter path and did not share it — including
// its high-entropy catch-all, ported below.
// BOUNDED BODY. A lazy unbounded `[\s\S]*?` restarts from every `BEGIN` marker
// and rescans to the end of the input, which is quadratic in the marker count —
// measured through the real chain: 291 ms at 128 KB, 4.0 s at 512 KB, 16.3 s at
// 1 MB, on the console's event loop, and `logsExport` hands this rule the WHOLE
// blob. 16 KiB is four times the largest real PEM this appliance holds.
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,16384}?-----END [A-Z ]*PRIVATE KEY-----/g;
const SERVICE_ACCOUNT = /("private_key"\s*:\s*")((?:[^"\\]|\\.)*)(")/g;
const AWS_ACCESS_KEY = /\bA(?:KIA|SIA|ROA|IDA)[0-9A-Z]{12,}\b/g;
const PRESIGNED_SIGNATURE = /\b(X-(?:Goog|Amz)-Signature=)([A-Fa-f0-9]{16,})/gi;
const PG_PASSWORD_ENV = /\b(PGPASSWORD)(\s*=\s*)(\S+)/g;
const API_KEY_FIELD = /\b(sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[0-9A-Za-z-]{10,})/g;
/** The catch-all `command-params.ts` has always carried and this file did not:
 *  a long, dense, non-word run inside quotes is a raw key whatever it is called.
 *
 *  DELIBERATELY NARROW, because the console's Logs tab is the surface that says
 *  what is broken and a redactor that blanks ordinary values makes it useless.
 *  Excluded, measured against real log lines:
 *    • anything containing `/` — an object key, a session key, a bucket path;
 *    • pure hex — a checksum, a request id, a fileId (the migration's own
 *      "checksum mismatch: <sha256>" line is the case that made this concrete);
 *    • pure decimal, and anything with a `-`-separated word shape
 *      (`expired-after-3600-seconds`), which is prose, not a key.
 *  What is left is a base64-ish run mixing cases and digits, which is what a raw
 *  key looks like and what almost nothing else does. */
const HIGH_ENTROPY_QUOTED = /"([A-Za-z0-9+/=_-]{40,})"/g;
function looksLikeRawKey(value: string): boolean {
  if (value.includes("/")) return false;
  if (/^[0-9a-fA-F]+$/.test(value)) return false;
  if (/^[0-9]+$/.test(value)) return false;
  if (/-/.test(value) && /[a-z]{3,}-[a-z0-9]/i.test(value)) return false;
  // Mixed case AND digits: the shape of a generated secret.
  return /[a-z]/.test(value) && /[A-Z0-9+/=_]/.test(value);
}

/**
 * Redact every credential shape in a string.
 *
 * Applied to response bodies, to log lines and to error messages alike. The
 * error path matters most: a driver's connect failure quotes the whole DSN, and
 * that message reaches a rendered page through no code anybody wrote.
 */
export function redactCredentials(value: string): string {
  return value
    .replace(DSN, (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`)
    .replace(QUERY_SECRET, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(BEARER, (_m, label: string, sep: string) => `${label}${sep}${REDACTED}`)
    // ONE pass per grammar, covering every secret-named field. JSON first: an
    // escaped `\"password\":` inside a stringified record is JSON too, and the
    // env rule would otherwise take its head.
    .replace(JSON_FIELD, redactJsonField)
    .replace(ENV_FIELD, redactEnvField)
    .replace(PRIVATE_KEY_BLOCK, REDACTED)
    .replace(SERVICE_ACCOUNT, (_m, open: string, _key: string, close: string) => `${open}${REDACTED}${close}`)
    .replace(AWS_ACCESS_KEY, REDACTED)
    .replace(PRESIGNED_SIGNATURE, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(PG_PASSWORD_ENV, (_m, label: string, sep: string) => `${label}${sep}${REDACTED}`)
    .replace(API_KEY_FIELD, REDACTED)
    .replace(HIGH_ENTROPY_QUOTED, (whole: string, inner: string) =>
      looksLikeRawKey(inner) ? `"${REDACTED}"` : whole,
    );
}

/** A property NAME that makes its value a secret whatever SHAPE the value takes.
 *
 *  Every rule above needs name, separator and value inside ONE string, which is
 *  how a log line or an error message is shaped. A structured body is not: the
 *  name is the object key and the value is a bare leaf, so `{"secretAccessKey":
 *  "wJal…"}` went through every rule untouched — on the very path `redactValue`
 *  exists for. Matched on the key here, and kept in step with the field rules
 *  above and with `command-params.ts`. */
const SECRET_KEY_NAME =
  /^(?:.*_)?(?:password|passwd|pwd|secret|secret[_-]?access[_-]?key|session[_-]?token|private[_-]?key(?:[_-]?id)?|api[_-]?key|apikey|dsn|database[_-]?url|signing[_-]?key|client[_-]?secret|(?:password|pwd|passwd)[_-]?hash)$/i;

// DELIBERATELY NOT on that list: a bare `token`, and `credentialRef`. The
// console MINTS both and has to hand them back — the sign-in response carries
// the session token, the setup link carries its own, and a credentialRef names
// an indirection precisely so the secret it points at never travels. Redacting
// them by name broke sign-in outright (measured: the token came back as
// "[redacted]"), which is the shape of over-redaction that makes a redactor get
// switched off. `session_token` IS on the list — that one is AWS's, at rest in
// credentials.json, and nothing serves it to a caller.

/**
 * Redact recursively through a response body. Keys are left alone - the SHAPE of
 * a payload is not a secret and hiding it makes a diagnosis impossible - but a
 * key whose NAME says its value is a credential redacts that value outright.
 *
 * A value whose data lives somewhere other than its own enumerable properties is
 * passed through UNTOUCHED. A Date is the one that matters: the driver hands
 * timestamptz columns back as Date objects, and rebuilding one from
 * Object.entries produces `{}` - so every instant in every response would arrive
 * at the browser as an empty object, and every "last activity" on every page
 * would read as unknown. There is no credential shape inside a Date to look for.
 */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactCredentials(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as unknown as T;
  if (value instanceof Date) return value;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      // A named secret goes whatever its shape: the name is the whole evidence,
      // and null/absent stays as it is so "not configured" and "withheld" do not
      // read alike.
      // A named secret goes whatever its shape — a string, and an object or an
      // array too, because this is the LAST belt on a response body and the
      // shape rules cannot reach a bare leaf nested under it.
      //
      // Except the primitives that are facts about configuration rather than
      // secrets: a `hasPassword: false` or a `passwordSet: true` says whether
      // something is set, and replacing it with a string changes its type as
      // well as its meaning — the same reason `null` is left alone, so "not
      // configured" and "withheld" never read alike.
      const named = SECRET_KEY_NAME.test(camelToSnake(key));
      // `null`, `undefined` and a boolean are "is it configured" facts. A NUMBER is
  // not — none of these fields has a numeric state, so a number under one is a
  // value somebody chose, and the string path already redacts it. The two halves
  // of this file had disagreed about that.
  const primitive = inner === null || inner === undefined || typeof inner === "boolean";
      out[key] = named && !primitive ? REDACTED : redactValue(inner);
    }
    return out as unknown as T;
  }
  return value;
}

/** The message form of an unknown throw, redacted. Stack traces are dropped
 *  entirely: they carry file paths and, on a connect failure, the DSN again. */
export function redactedMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactCredentials(raw);
}

/** `secretAccessKey` → `secret_access_key`, so one pattern covers both spellings
 *  rather than two that drift. */
function camelToSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
