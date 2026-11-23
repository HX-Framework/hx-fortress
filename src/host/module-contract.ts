// What an HX Fortress module is, and what the host gives it.
//
// A module is code that is compiled INTO HX Fortress binary. The customer
// switches it on with a local gesture (`hx-fortress modules on <id>`); the host
// never loads module code from the control plane. What the control plane can do
// to a module is exactly two things, and this file is the type of both: send it
// an ASK from the list in its manifest, and offer it a RELEASE that a person on
// this side has to approve before the module ever sees it.

// Everything imported here is free of Node: this file, the shapes and a
// module's manifest are data a console page may import as they are.
import {
  isSecretName,
  SecretMissing,
  SecretUnavailable,
  type SecretProvider,
} from "../secrets/types";
import { MODULE_ID_PATTERN } from "./module-id";
import { PROCESS_WORD_PATTERN, processWordFor } from "./process-words";
import type { Organization } from "./organization-id";
import { shapeDefect, type Shape } from "./shape";
import type { Module, ModuleContext } from "./types";

// ── The manifest ─────────────────────────────────────────────────────────────

/** One thing the control plane may ask a module, with the shape of what it
 *  sends and the shape of what comes back. */
export interface AskSpec {
  /** Lower-case words joined by dots: `status`, `audit.read`. */
  name: string;
  /** Always a record: an ask's arguments are named. */
  args: Shape;
  reply: Shape;
}

/** Who may do an act: every person signed in to this HX Fortress's console
 *  (`readonly`), or an operator only. */
export type ActRole = "operator" | "readonly";

export const ACT_ROLES: readonly ActRole[] = ["operator", "readonly"];

/**
 * One thing a person signed in to this HX Fortress's console may have a module
 * do, with the shape of what the person sends and of what comes back.
 *
 * THE ROLE SAYS WHAT THE ACT MAY CHANGE. An act that any signed-in person may
 * do (`readonly`) reads and changes nothing: the host hands it a context that
 * can add no host and no secret's name, and writes no record of it one by one.
 * An act of an operator may change things, and the host records each one.
 */
export interface ActSpec {
  /** Lower-case words joined by dots, as an ask's name: `connection.add`. */
  name: string;
  role: ActRole;
  /** Always a record. No free text and no bytes, as for an ask. */
  args: Shape;
  reply: Shape;
}

export interface ModuleManifest {
  /** `host`, `stores`, `data_jobs`. */
  id: string;
  /** Everything the control plane may ask this module. An ask that is not here
   *  is refused. */
  asks: readonly AskSpec[];
  /** Everything a person at this HX Fortress's console may have this module
   *  do. An act that is not here is refused. Left out by a module that takes
   *  none. The control plane cannot send an act: it has no frame for one. */
  acts?: readonly ActSpec[];
  /** Hosts the module may call. `api.example.com` names one host; `*.example.com`
   *  names every host under it. The console lists them under data paths, and
   *  `ModuleContextV2.fetch` refuses any other. */
  egress: readonly string[];
  /** Names of the secrets the module reads. `ModuleContextV2.secrets` refuses
   *  any other name. */
  secrets: readonly string[];
  /** The processes of its own that the module may have started: each a word
   *  that the host's closed list gives to this module (process-words.ts).
   *  `ModuleContextV2.processes` refuses any other. Left out by a module that
   *  has none started. */
  processes?: readonly ProcessSpec[];
}

/** One process a module may have started: a word of this program's own
 *  command line. A module gives no argument and no path. */
export interface ProcessSpec {
  verb: string;
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
const MANIFEST_MAX_ACTS = 64;
const MANIFEST_MAX_EGRESS = 32;
const MANIFEST_MAX_SECRETS = 32;
const MANIFEST_MAX_PROCESSES = 4;

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
  if (m.acts !== undefined) {
    if (!Array.isArray(m.acts)) return "the manifest's acts must be a list";
    if (m.acts.length > MANIFEST_MAX_ACTS) return `a module may list at most ${MANIFEST_MAX_ACTS} acts`;
    const acts = new Set<string>();
    for (const act of m.acts as unknown[]) {
      if (typeof act !== "object" || act === null) return "an act is not an object";
      const a = act as Record<string, unknown>;
      if (!isAskName(a.name)) return "an act's name must be lower-case words joined by dots";
      if (acts.has(a.name)) return `the act ${a.name} is listed twice`;
      acts.add(a.name);
      if (!(ACT_ROLES as readonly unknown[]).includes(a.role)) {
        return `the role of ${a.name} must be operator or readonly`;
      }
      const argsDefect = shapeDefect(a.args);
      if (argsDefect) return `the args of ${a.name}: ${argsDefect}`;
      if ((a.args as { kind?: unknown }).kind !== "record") {
        return `the args of ${a.name} must be a record`;
      }
      const replyDefect = shapeDefect(a.reply);
      if (replyDefect) return `the reply of ${a.name}: ${replyDefect}`;
    }
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
  if (m.processes !== undefined) {
    if (!Array.isArray(m.processes)) return "the manifest's processes must be a list";
    if (m.processes.length > MANIFEST_MAX_PROCESSES) {
      return `a module may list at most ${MANIFEST_MAX_PROCESSES} processes`;
    }
    const words = new Set<string>();
    for (const entry of m.processes as unknown[]) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return "a process is not an object";
      const { verb, ...rest } = entry as Record<string, unknown>;
      // A word and nothing else: a manifest gives a process no argument, no
      // path and no environment.
      if (Object.keys(rest).length > 0) return "a process names its word and nothing else";
      if (typeof verb !== "string" || !PROCESS_WORD_PATTERN.test(verb)) {
        return "a process's word must be lower-case letters, digits and hyphens";
      }
      if (words.has(verb)) return `the process ${verb} is listed twice`;
      words.add(verb);
      // The host's own list says which words exist, and for which module.
      if (!processWordFor(m.id, verb)) return `this build starts no process ${verb} for this module`;
    }
  }
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
  /** Write one record to HX Fortress's audit trail, as `module.<id>.<action>`.
   *  `detail` is evidence, not a payload: names, counts and flags. Never a
   *  secret, a row value or a file byte. A text is kept when it is a `name` or
   *  an `email` as a shape takes one (shape.ts), and is left out otherwise.
   *
   *  The record is the context's organization's. The host says whose it is: a
   *  detail field called `organization` is the host's to write, and one a
   *  module passes is dropped.
   *
   *  A record written here names NO PERSON, on every context. The context of
   *  an act has `recordAct` beside it for a record of what the person is
   *  having the module do. */
  record(action: string, detail: Record<string, string | number | boolean>): void;
}

/** The audit port of an act's context. */
export interface ModuleActAuditPort extends ModuleAuditPort {
  /**
   * Write one record of what THE PERSON is having the module do in this act:
   * "a connection was added". It is written under that person's login, with
   * the console's own id for the sign-in, as the act's own two records are.
   *
   * THE HOST SAYS WHO. A module passes no login, and no detail field takes a
   * person's place. So a record that names a person names the one the
   * console's sign-in vouched for.
   *
   * THE MODULE SAYS WHICH RECORD. Only a record written here names the
   * person. `record` names nobody, also while the act runs: a module does
   * other work during an act (it closes a job that another caller started and
   * that was lost), and a line of that work is not the person's.
   *
   * ONLY WHILE THE ACT'S WORK HAS NOT ENDED. Through a context that a module
   * kept, after that, this writes the record under nobody's login: a job that
   * an act started and that ends later is such a case.
   */
  recordAct(action: string, detail: Record<string, string | number | boolean>): void;
}

export interface ModuleStatePort {
  /** The value last written under `key`, or null. */
  read<T>(key: string): Promise<T | null>;
  /** Replace the value under `key`. The value must be JSON. State is kept in a
   *  0600 file under HX Fortress root; it is not a place for secrets. */
  write<T>(key: string, value: T): Promise<void>;
  /** Remove the value under `key`, and its file with it. Removing a key that
   *  holds nothing changes nothing. */
  remove(key: string): Promise<void>;
}

// ── What a person adds to a module ───────────────────────────────────────────
//
// Two lists belong to one module and one organization, and only a person can
// add to them: the hosts a helper program of the module may be sent to, and
// the names of secrets the module may have read. Every context can read both.
// Only the context of an operator's act can change them (`ModuleActContext`).

/** A person signed in to this HX Fortress's console, as its sign-in says. */
export interface Person {
  /** The console login. */
  login: string;
  /** The person's login when that login is an email address, in lower case.
   *  Null for every other login. */
  email: string | null;
  role: ActRole;
}

/** A reach: a host and a port that a person added to this module, under a
 *  name. A module reads its reaches with `ctx.reach.list()`. The host is to
 *  hand one to a helper program that it starts for the module, which this
 *  build does not do yet. */
export interface ReachEntry {
  name: string;
  host: string;
  port: number;
  /** The console login of the person who added it. */
  addedBy: string;
  addedAt: string;
}

export type ReachRefusal =
  | "reach_name_invalid"
  | "reach_name_taken"
  | "reach_host_invalid"
  | "reach_port_invalid"
  | "reach_address_refused"
  | "reach_list_full"
  /** The list is on the disk and cannot be read, so nothing is written over it. */
  | "reach_list_unreadable"
  /** The context is not one of an operator's act. */
  | "not_allowed";

/** The host refused to add an entry to its list of hosts, or to read it. */
export class ReachRefused extends Error {
  readonly rule: ReachRefusal;

  constructor(rule: ReachRefusal) {
    // What was ASKED FOR is not repeated: a name or a host that was refused
    // may be a value from somewhere it should not have come from.
    super(`the list of hosts refused: ${rule}`);
    this.name = "ReachRefused";
    this.rule = rule;
  }
}

/** The entries of this module for the context's organization, and no other's. */
export interface ReachListPort {
  list(): Promise<ReachEntry[]>;
}

export interface ReachPort extends ReachListPort {
  /** A name is one address: the host never changes the address under a name.
   *  A change is a remove and an add. */
  add(name: string, to: { host: string; port: number }): Promise<void>;
  /** Removing a name that is not on the list changes nothing. */
  remove(name: string): Promise<void>;
}

export type SecretNameRefusal =
  | "secret_name_invalid"
  | "secret_names_full"
  /** The name is one this HX Fortress's own settings read, or one another
   *  module's manifest lists. A person cannot hand it to a module. */
  | "secret_name_reserved"
  /** The list, or the settings that say which names are taken, cannot be read. */
  | "secret_names_unreadable"
  | "not_allowed";

export class SecretNameRefused extends Error {
  readonly rule: SecretNameRefusal;

  constructor(rule: SecretNameRefusal) {
    super(`the list of secret names refused: ${rule}`);
    this.name = "SecretNameRefused";
    this.rule = rule;
  }
}

/** The names added to this module for the context's organization, and no other's. */
export interface SecretNameListPort {
  list(): Promise<string[]>;
}

export interface SecretNamesPort extends SecretNameListPort {
  /** Adding a name does not read the secret. Adding one twice is one entry. */
  add(name: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/**
 * What the host hands a module for ONE ORGANIZATION.
 *
 * Its `secrets`, its `audit` and its `state` are that organization's, and
 * nothing on it reaches another's. The context `onAsk` is given is the one of
 * the organization the ask is for. On an HX Fortress that holds one organization
 * that is always the same one, HX Fortress's own.
 *
 * A MODULE KEYS WHAT IT KEEPS BY `organization.id`. Every row of every table it
 * makes has a column for it that is never null, and every object it writes
 * to a store of its own has it in its path. A file in the folder the host
 * gives it (`folder`) needs no id: the host builds that folder's path for the
 * organization. No call here takes an organization's id, so a module cannot
 * reach another organization's state, secrets, files or records by passing
 * the wrong one.
 *
 * A module that keeps a context after the ask it came with (for a run that
 * goes on) keeps one organization's context, and works for that organization
 * with it.
 */
export interface ModuleContextV2 extends ModuleContext {
  /** Whose context this is. Reading `id` for HX Fortress's own organization
   *  makes that id the first time: read it when there is something to key. */
  readonly organization: Organization;
  /**
   * The identity this HX Fortress enrolled with. It is the own organization's,
   * so only the own organization's context has it. On another organization's
   * context it is always null: nothing there is keyed by the enrollment.
   */
  readonly fortressIdentity: ModuleContext["fortressIdentity"];
  /** The organization's secrets, narrowed to the names in the manifest and the
   *  names a person added for this module and organization (`secretNames`). A
   *  name from the manifest is what a module passes, for every organization. */
  readonly secrets: SecretProvider;
  readonly audit: ModuleAuditPort;
  readonly state: ModuleStatePort;
  /** The hosts a person added to this module for this organization. This
   *  context can read the list. Only the context of an operator's act can
   *  change it. */
  readonly reach: ReachListPort;
  /** The names of secrets a person added to this module for this
   *  organization. `secrets` takes a name from the manifest or one of these. */
  readonly secretNames: SecretNameListPort;
  /**
   * A folder on this host's disk that belongs to this module and this
   * organization, as an absolute path. It is made when it is not there. The
   * folder and every level under it are readable by this HX Fortress's own
   * user only.
   *
   * With no name it is the module's whole folder for the organization. Each
   * name is one more level, at most `FOLDER_MAX_DEPTH`. A name is 1 to 64
   * characters of a-z, 0-9, `_` and `-`, starting with a letter or a digit, so
   * a dot, a slash, a colon, an upper-case letter and `..` are refused.
   *
   * AN ID FROM AN ASK IS NOT A NAME. It can hold dots, colons and upper-case
   * letters, and this refuses those. Give what the id names a name of the
   * module's own first (a number the module counts, kept in its state), and
   * never put an id into a path by hand.
   *
   * The host builds the path. A module never passes an organization's id, and
   * needs none to keep two organizations' files apart in this folder. State is
   * for small JSON values; this is for a database file and the files beside
   * it.
   *
   * Rejects with `FolderRefused` for a name or a depth it does not take, and
   * for an organization this HX Fortress no longer holds. An error of the
   * disk rejects as it is.
   */
  folder(...names: string[]): Promise<string>;
  /** A process of the module's own, which the host starts for it. A module
   *  starts none itself. */
  readonly processes: ModuleProcessPort;
  /** `fetch`, over https only, to a host in the manifest's egress list only.
   *  Of `init`, only `method`, `headers`, `body` and `signal` are used, and
   *  `redirect: "manual"` to be handed a redirect. Anything else is dropped. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/**
 * What a module is handed when it starts: the context of HX Fortress's own
 * organization, and the one thing that is not one organization's.
 *
 * `organizations()` is for work that no ask started: finding the runs that were
 * going when HX Fortress stopped, a timer. The context of an ask does not have
 * it. An ask is for one organization, and a module answering it is handed that
 * organization and no other.
 */
export interface ModuleStartContext extends ModuleContextV2 {
  /**
   * The context of every organization this module is on for now,
   * HX Fortress's own first. Empty while the module is switched off.
   */
  organizations(): Promise<ModuleContextV2[]>;
}

/**
 * The context of a person's act: the organization's context, and the two
 * lists.
 *
 * `add` and `remove` work only in an act that the manifest gives to operators,
 * and only while that act runs. In an act any signed-in person may do they
 * reject with `not_allowed`, and so they do on a context that a module kept
 * after its act had ended. The context of an ask has neither, so no ask from
 * the control plane has a path to either list.
 *
 * `audit.recordAct` writes a record under the person's login while the act
 * runs, whichever role the act is given to, and under nobody's after it has
 * ended. `audit.record` names nobody, as on every context.
 *
 * An act is for this HX Fortress's own organization: its console signs in
 * that organization's people.
 */
export interface ModuleActContext extends ModuleContextV2 {
  readonly audit: ModuleActAuditPort;
  readonly reach: ReachPort;
  readonly secretNames: SecretNamesPort;
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
  /** Called once, before `start`, with the context the module keeps for
   *  HX Fortress's own organization. */
  init?(context: ModuleStartContext): Promise<void> | void;
  /** Answer one ask. `args` already has the shape the manifest declares. The
   *  value returned is rebuilt against the declared reply shape before it
   *  leaves, and refused whole if it does not fit.
   *
   *  To fail with a code the control plane may see, throw `AskFailure`. A
   *  failure of one of the context's own ports has a code of its own
   *  (`failureCode`). Anything else thrown reaches the control plane as
   *  `failed:internal`: its message is not sent and not recorded, and the log
   *  holds only what `failureForLog` allows. */
  onAsk(ask: string, args: unknown, ctx: ModuleContextV2): Promise<unknown>;
  /** Carry out one act of a signed-in person. `args` already has the shape
   *  the manifest declares, and the host has checked that the module is on,
   *  that the act is on its list and that the person's role may do it. The
   *  value returned is rebuilt against the declared reply shape before it is
   *  shown, as an ask's is.
   *
   *  It fails as `onAsk` does: `AskFailure` names a code a person may see, and
   *  anything else thrown is shown as `failed:internal`. A module whose
   *  manifest lists acts has this method. */
  onAct?(act: string, args: unknown, ctx: ModuleActContext, person: Person): Promise<unknown>;
  /** Apply a release. Called only after a person approved it. A module without
   *  this method takes no releases, and an offer for it is refused. A release
   *  is for the whole HX Fortress, so the context is the own organization's. */
  applyRelease?(release: ApprovedRelease, ctx: ModuleContextV2): Promise<void>;
}

export function isFortressModule(module: Module | undefined | null): module is FortressModule {
  if (!module) return false;
  const candidate = module as Partial<FortressModule>;
  return typeof candidate.onAsk === "function" && typeof candidate.manifest === "object";
}

/** A failure's code: one lower-case word of at most 48 characters. */
export const FAILURE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

/**
 * A failure a module is willing to name to the control plane.
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

/** One level of a module's folder: lower case, so that two names are never
 *  one folder on a disk that ignores case. */
export const FOLDER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** How many levels a module may ask for under its folder. */
export const FOLDER_MAX_DEPTH = 4;

export type FolderRule = "folder_name_invalid" | "folder_too_deep" | "organization_not_held";

// ── A process of the module's own ────────────────────────────────────────────

/** How a process ended: its exit code, or the signal that ended it. */
export type ProcessEnd = { code: number } | { signal: string };

/** A started process, as a module holds it. */
export interface ModuleProcess {
  /**
   * Send one value to the process.
   *
   * A value sent to a process that is gone is dropped: `exited` says that it
   * is gone. Where the process is still there and the value could not be
   * handed to it, this throws `ProcessSendFailed`: the channel cannot carry
   * the value (a function, a symbol), or the process has closed its side of
   * the channel. What is thrown holds nothing of the value.
   *
   * A value reaches the process once its code listens. The word's own code
   * must listen before its first `await`: what arrives before it listens is
   * lost.
   */
  send(message: unknown): void;
  /** End the process now. It cannot refuse. */
  kill(): void;
  /** Settles when the process is gone, with how it ended. Never rejects. */
  readonly exited: Promise<ProcessEnd>;
}

/**
 * Why a value was not handed to a process that is still there.
 *
 *   value_unsendable  the channel cannot carry the value
 *   channel_closed    the process has closed its side of the channel
 */
export type ProcessSendRule = "value_unsendable" | "channel_closed";

/** Thrown by `ModuleProcess.send`. Its message is the rule and nothing of the
 *  value, so it can be logged. */
export class ProcessSendFailed extends Error {
  readonly rule: ProcessSendRule;

  constructor(rule: ProcessSendRule) {
    super(`a value could not be sent to the process: ${rule}`);
    this.name = "ProcessSendFailed";
    this.rule = rule;
  }
}

/**
 * Why the host did not start a process.
 *
 *   process_not_declared   the module's manifest does not list the word, or
 *                          the host's list does not give it to this module
 *   folder_missing         the folder is not there, or a level of its path is
 *                          something else than a folder: a file, or a link. A
 *                          start makes nothing on the disk
 *   module_not_running     the module is not running: it is off, or its own
 *                          start has not ended, or its stop has begun
 *   processes_unavailable  the module runs as many processes as it may, or
 *                          the daemon is stopping
 *   process_start_failed   the program could not be started: the machine
 *                          refused, or what runs here is not this program's
 *                          own command line (a test)
 *
 * and the three rules of a folder's names, as `ModuleContextV2.folder` has them.
 */
export type ProcessRule =
  | FolderRule
  | "process_not_declared"
  | "folder_missing"
  | "module_not_running"
  | "processes_unavailable"
  | "process_start_failed";

/** A module asked for a process it may not have, or cannot have now. */
export class ProcessRefused extends Error {
  readonly rule: ProcessRule;

  constructor(moduleId: string, rule: ProcessRule) {
    // What was ASKED FOR is not repeated: a name that was refused may be a
    // value from an ask.
    super(`module ${moduleId} may not have this process: ${rule}`);
    this.name = "ProcessRefused";
    this.rule = rule;
  }
}

export interface ModuleProcessPort {
  /**
   * Start a process of the module's own: this same program, started again with
   * the word `verb`, for this context's organization.
   *
   * `folder` is the folder the process is given, level by level, as for
   * `ModuleContextV2.folder`. The host builds its path and hands it to the
   * process as the value of its one variable, `SQLITE_TMPDIR`. The names are
   * taken as they are when `start` is called: a list that is changed
   * afterwards changes nothing. IT MAKES NOTHING ON THE DISK: the module made
   * the folder before, and a start is refused where a level of the path is
   * not there, or is a file or a link. So a start that ends late, after the
   * module removed the folder on purpose, leaves nothing behind.
   *
   * The process does not run in that folder. It runs in the machine's root
   * folder, because a runtime reads settings and code from the folder a
   * program starts in, and a module's folder holds what was written for a
   * client. The word's own code names every file by its full path.
   *
   * `onMessage` is called with each value the process sends. The host passes
   * every value through as it is, both ways, and looks at none. A listener
   * that fails, at once or through a promise it answers, fails for itself:
   * the host's log says that it did, and nothing of why.
   *
   * A process is started only for a module that is running, and the host ends
   * it when the module is switched off and when the daemon stops. It cannot
   * end it when the daemon itself is killed: the word's own code must end
   * when its channel closes.
   *
   * Rejects with `ProcessRefused` for every start it does not make: see
   * `ProcessRule`.
   */
  start(
    verb: string,
    options: { folder: readonly string[]; onMessage(message: unknown): void },
  ): Promise<ModuleProcess>;
}

/** A module asked for a folder it may not have. */
export class FolderRefused extends Error {
  readonly rule: FolderRule;

  constructor(moduleId: string, rule: FolderRule) {
    // What was ASKED FOR is not repeated: a name that was refused may be a
    // value from an ask.
    super(`module ${moduleId} may not have this folder: ${rule}`);
    this.name = "FolderRefused";
    this.rule = rule;
  }
}

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
  if (thrown instanceof FolderRefused) return thrown.rule;
  if (thrown instanceof ProcessRefused) return thrown.rule;
  if (thrown instanceof ReachRefused) return thrown.rule;
  if (thrown instanceof SecretNameRefused) return thrown.rule;
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
    thrown instanceof EgressRefused ||
    thrown instanceof FolderRefused ||
    thrown instanceof ProcessRefused ||
    thrown instanceof ReachRefused ||
    thrown instanceof SecretNameRefused
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

/** What a person is told when an act did not give a reply. One word, or
 *  `failed:` and one word. */
export type ActError =
  | "not_allowed"
  | "module_off"
  | "act_unknown"
  | "args_invalid"
  | "reply_invalid"
  | "busy"
  | `failed:${string}`;

export type ActAnswer = { ok: true; reply: unknown } | { ok: false; error: ActError };

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
