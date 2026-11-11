// What a Fortress module is, and what the host gives it.
//
// A module is code that is compiled INTO the Fortress binary. The customer
// switches it on with a local gesture (`hx-fortress modules on <id>`); the host
// never loads module code from the relay. What the relay can do to a module is
// exactly two things, and this file is the type of both: send it an ASK from
// the list in its manifest, and offer it a RELEASE that a person on this side
// has to approve before the module ever sees it.

// Everything imported here is free of Node: this file, the shapes and a
// module's manifest are data a console page may import as they are.
import {
  isSecretName,
  SecretMissing,
  SecretUnavailable,
  type SecretProvider,
} from "../secrets/types";
import { MODULE_ID_PATTERN } from "./module-id";
import { shapeDefect, type Shape } from "./shape";
import type { Module, ModuleContext } from "./types";

// ── The manifest ─────────────────────────────────────────────────────────────

/** One thing the relay may ask a module, with the shape of what it sends and
 *  the shape of what comes back. */
export interface AskSpec {
  /** Lower-case words joined by dots: `status`, `audit.read`. */
  name: string;
  /** Always a record: an ask's arguments are named. */
  args: Shape;
  reply: Shape;
}

export interface ModuleManifest {
  /** `host`, `stores`, `data_jobs`. */
  id: string;
  /** Everything the relay may ask this module. An ask that is not here is refused. */
  asks: readonly AskSpec[];
  /** Hosts the module may call. `api.example.com` names one host; `*.example.com`
   *  names every host under it. The console lists them under data paths, and
   *  `ModuleContextV2.fetch` refuses any other. */
  egress: readonly string[];
  /** Names of the secrets the module reads. `ModuleContextV2.secrets` refuses
   *  any other name. */
  secrets: readonly string[];
}

export const MODULE_ID_MAX_CHARS = 64;
export const ASK_NAME_MAX_CHARS = 64;
// The three patterns below repeat a group, which the linter reads as a risk of
// a slow match. None is: each repeat begins with a literal dot that the
// characters before it cannot be, so there is one way to match any input. Every
// use also checks the length first.
// eslint-disable-next-line security/detect-unsafe-regex
export const ASK_NAME_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
/** A key in a module's own state store. One path segment, never a path. */
export const STATE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** An action a module records in the audit trail, after its `module.<id>.`
 *  prefix. Written like an ask's name: lower-case words joined by dots. */
export const MODULE_ACTION_PATTERN = ASK_NAME_PATTERN;
const EGRESS_HOST_PATTERN =
  // eslint-disable-next-line security/detect-unsafe-regex
  /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MANIFEST_MAX_ASKS = 64;
const MANIFEST_MAX_EGRESS = 32;
const MANIFEST_MAX_SECRETS = 32;

export function isModuleId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= MODULE_ID_MAX_CHARS && MODULE_ID_PATTERN.test(value)
  );
}

export function isAskName(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= ASK_NAME_MAX_CHARS && ASK_NAME_PATTERN.test(value)
  );
}

/**
 * What is wrong with a manifest, or null when nothing is.
 *
 * Checked when a module is registered, so a module whose manifest the host
 * cannot enforce never starts: an ask with an open shape, an egress entry that
 * is a URL instead of a host, a secret name the secrets contract would refuse.
 */
export function manifestDefect(manifest: unknown): string | null {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return "the manifest is not an object";
  }
  const m = manifest as Record<string, unknown>;
  if (!isModuleId(m.id)) return "the manifest's id is not a module id";
  if (!Array.isArray(m.asks)) return "the manifest must list its asks";
  if (m.asks.length > MANIFEST_MAX_ASKS) return `a module may list at most ${MANIFEST_MAX_ASKS} asks`;
  const seen = new Set<string>();
  for (const ask of m.asks as unknown[]) {
    if (typeof ask !== "object" || ask === null) return "an ask is not an object";
    const a = ask as Record<string, unknown>;
    if (!isAskName(a.name)) return "an ask's name must be lower-case words joined by dots";
    if (seen.has(a.name)) return `the ask ${a.name} is listed twice`;
    seen.add(a.name);
    const argsDefect = shapeDefect(a.args);
    if (argsDefect) return `the args of ${a.name}: ${argsDefect}`;
    if ((a.args as { kind?: unknown }).kind !== "record") {
      return `the args of ${a.name} must be a record`;
    }
    const replyDefect = shapeDefect(a.reply);
    if (replyDefect) return `the reply of ${a.name}: ${replyDefect}`;
  }
  if (!Array.isArray(m.egress)) return "the manifest must list its egress hosts";
  if (m.egress.length > MANIFEST_MAX_EGRESS) {
    return `a module may list at most ${MANIFEST_MAX_EGRESS} egress hosts`;
  }
  for (const host of m.egress as unknown[]) {
    if (typeof host !== "string" || host.length > 253 || !EGRESS_HOST_PATTERN.test(host)) {
      return "an egress entry must be a lower-case host name, or *.<host> for every host under one";
    }
  }
  if (!Array.isArray(m.secrets)) return "the manifest must list its secret names";
  if (m.secrets.length > MANIFEST_MAX_SECRETS) {
    return `a module may list at most ${MANIFEST_MAX_SECRETS} secrets`;
  }
  for (const name of m.secrets as unknown[]) {
    if (!isSecretName(name)) {
      return "a secret's name must be 1 to 64 characters of a-z, 0-9 and -";
    }
  }
  if (new Set(m.secrets).size !== m.secrets.length) return "a secret name is listed twice";
  return null;
}

/** True when `host` is one the manifest lets the module call. */
export function egressAllows(egress: readonly string[], host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  for (const entry of egress) {
    if (entry.startsWith("*.")) {
      // `*.example.com` covers `a.example.com` and `a.b.example.com`, and not
      // `example.com` itself or `badexample.com`.
      if (name.endsWith(entry.slice(1)) && name.length > entry.length - 1) return true;
    } else if (name === entry) {
      return true;
    }
  }
  return false;
}

// ── What a module gets ───────────────────────────────────────────────────────

export interface ModuleAuditPort {
  /** Write one record to the Fortress's audit trail, as `module.<id>.<action>`.
   *  `detail` is evidence, not a payload: names, counts and flags. Never a
   *  secret, a row value or a file byte. */
  record(action: string, detail: Record<string, string | number | boolean>): void;
}

export interface ModuleStatePort {
  /** The value last written under `key`, or null. */
  read<T>(key: string): Promise<T | null>;
  /** Replace the value under `key`. The value must be JSON. State is kept in a
   *  0600 file under the Fortress root; it is not a place for secrets. */
  write<T>(key: string, value: T): Promise<void>;
}

export interface ModuleContextV2 extends ModuleContext {
  /** The customer's secret store, narrowed to the names in the manifest. */
  readonly secrets: SecretProvider;
  readonly audit: ModuleAuditPort;
  readonly state: ModuleStatePort;
  /** `fetch`, over https only, to a host in the manifest's egress list only.
   *  Of `init`, only `method`, `headers`, `body` and `signal` are used, and
   *  `redirect: "manual"` to be handed a redirect. Anything else is dropped. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/** A release a person on this side approved, handed to the module to apply. */
export interface ApprovedRelease {
  id: string;
  moduleId: string;
  version: string;
  /** Lower-case hex sha256 of `artifact`, checked again just before this call. */
  checksum: string;
  /** The trust anchor whose signature over `artifact` verified. */
  signedBy: string;
  approvedBy: string;
  approvedAt: string;
  /** The bytes that were signed. Opaque to the host. */
  artifact: Uint8Array;
}

export interface FortressModule extends Module {
  readonly manifest: ModuleManifest;
  /** Answer one ask. `args` already has the shape the manifest declares. The
   *  value returned is rebuilt against the declared reply shape before it
   *  leaves, and refused whole if it does not fit.
   *
   *  To fail with a code the relay may see, throw `AskFailure`. A failure of
   *  one of the context's own ports has a code of its own (`failureCode`).
   *  Anything else thrown reaches the relay as `failed:internal`: its message is
   *  not sent and not recorded, and the log holds only what `failureForLog`
   *  allows. */
  onAsk(ask: string, args: unknown, ctx: ModuleContextV2): Promise<unknown>;
  /** Apply a release. Called only after a person approved it. A module without
   *  this method takes no releases, and an offer for it is refused. */
  applyRelease?(release: ApprovedRelease, ctx: ModuleContextV2): Promise<void>;
}

export function isFortressModule(module: Module | undefined | null): module is FortressModule {
  if (!module) return false;
  const candidate = module as Partial<FortressModule>;
  return typeof candidate.onAsk === "function" && typeof candidate.manifest === "object";
}

const FAILURE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

/**
 * A failure a module is willing to name to the relay.
 *
 * The code is one lower-case word and is all that travels: `failed:<code>`. A
 * message would be free text chosen at the moment something went wrong, which
 * is the moment a value from a row is most likely to be in it.
 */
export class AskFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`ask failed: ${FAILURE_CODE_PATTERN.test(code) ? code : "internal"}`);
    this.name = "AskFailure";
    this.code = FAILURE_CODE_PATTERN.test(code) ? code : "internal";
  }
}

/** A module asked for a secret its manifest does not name. */
export class SecretNotDeclared extends Error {
  constructor(moduleId: string, declared: readonly string[]) {
    // What was ASKED FOR is not repeated: a caller that passes a value where a
    // name belongs has made a mistake, and many values look exactly like names.
    // What the manifest DOES list is safe to print, and is what fixes the call.
    super(
      `module ${moduleId} asked for a secret its manifest does not list. ` +
        (declared.length === 0 ? "It lists none." : `It lists: ${declared.join(", ")}.`),
    );
    this.name = "SecretNotDeclared";
  }
}

export type EgressRule =
  | "egress_not_https"
  | "egress_not_declared"
  | "egress_private_address"
  | "egress_malformed";

/** A module tried to call something its manifest does not allow. */
export class EgressRefused extends Error {
  readonly rule: EgressRule;

  constructor(moduleId: string, rule: EgressRule) {
    super(`module ${moduleId} may not make this call: ${rule}`);
    this.name = "EgressRefused";
    this.rule = rule;
  }
}

/**
 * The one word a failure is known by outside this host.
 *
 * A failure the module named keeps its name. A failure of one of the host's own
 * ports gets that port's word, so "the secret is not set" and "the manifest does
 * not allow that call" are told apart without a message. Everything else is
 * `internal`.
 */
export function failureCode(thrown: unknown): string {
  if (thrown instanceof AskFailure) return thrown.code;
  if (thrown instanceof SecretMissing) return "secret_missing";
  if (thrown instanceof SecretUnavailable) return "secret_unavailable";
  if (thrown instanceof SecretNotDeclared) return "secret_not_declared";
  if (thrown instanceof EgressRefused) return thrown.rule;
  return "internal";
}

/**
 * What this host's own log may say about a failure.
 *
 * For the failures above, the message: each is written by this host from names
 * and fixed words, and none can hold a value. For anything else, only its kind
 * and where it was thrown — a message written at the moment something broke is
 * where a value from a row is most likely to be, and the log is read by people
 * who may not read rows.
 */
export function failureForLog(thrown: unknown): Record<string, string> {
  if (
    thrown instanceof SecretMissing ||
    thrown instanceof SecretUnavailable ||
    thrown instanceof SecretNotDeclared ||
    thrown instanceof EgressRefused
  ) {
    return { code: failureCode(thrown), error: thrown.message };
  }
  if (thrown instanceof AskFailure) return { code: thrown.code };
  const out: Record<string, string> = { code: "internal" };
  if (thrown instanceof Error) {
    out.kind = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(thrown.name) ? thrown.name : "Error";
    // The first frame, never the first line: the first line is the message.
    const frame = (thrown.stack ?? "").split("\n").find((line) => /^\s+at /.test(line));
    if (frame) out.where = frame.trim().slice(0, 200);
  } else {
    out.kind = typeof thrown;
  }
  const code = (thrown as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code)) out.errno = code;
  return out;
}

// ── The wire, inside the existing moduleMessage frame ────────────────────────
//
// An ask is the `payload` of a `moduleMessage` frame: `{ v: 1, ask, args, grant }`.
// The ask gate reads and checks each of the four (ask-gate.ts).

export type AskError =
  | "module_off"
  | "ask_unknown"
  | "grant_missing"
  | "grant_invalid"
  | "args_invalid"
  | "reply_invalid"
  | "busy"
  | `failed:${string}`;

// ── Releases ─────────────────────────────────────────────────────────────────

export type ReleaseState = "waiting" | "approved" | "installed" | "failed" | "refused";

export const RELEASE_STATES: readonly ReleaseState[] = [
  "waiting",
  "approved",
  "installed",
  "failed",
  "refused",
];

export interface ReleaseRecord {
  id: string;
  moduleId: string;
  version: string;
  /** Lower-case hex sha256 of the artifact. */
  checksum: string;
  /** The key id that verified it. */
  signedBy: string;
  offeredAt: string;
  state: ReleaseState;
  decidedBy?: string;
  decidedAt?: string;
  /** When the release was last handed to its module, if it ever was. A release
   *  that failed after this may have been applied in part or in whole. */
  handedAt?: string;
  /** A short code, set when the state is `failed`. Never a message. */
  error?: string;
}
