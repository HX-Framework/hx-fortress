// What the host hands a module: its secrets, its audit port, its state and its
// way out to the network — each one narrowed to what the module's manifest
// declares.
//
// A CONTEXT BELONGS TO ONE ORGANIZATION. Its secrets, its audit records and its
// state are that organization's. The host builds one context for each
// organization a module works for, and the module is handed the right one: the
// one of the organization an ask is for, or HX Fortress's own when it starts.
// Nothing here takes an organization's id from the module, so a module cannot
// ask for another organization's by passing the wrong one. Only the context a
// module is started with can list the others (`createModuleStartContext`).
//
// The manifest is what the module declares in the open: it is compiled into the
// binary, `hx-fortress modules list` prints it, and the console lists it under
// data paths. This file is where the host holds the module to it: a secret name
// the manifest does not list is refused, and so is a host the manifest does not
// list.
//
// WHAT THIS IS NOT. A module is code inside this process, so these ports do not
// confine it: nothing in the process stops code from importing `node:net`. Two
// other things do the confining. A lint rule over `src/modules/` fails the
// build when a module reaches the network any other way (see eslint.config.js).
// And module code only ever arrives inside HX Fortress binary, never from the
// control plane. Who made the binary is therefore the boundary against code
// written to get out; SECURITY.md says how far a release of the binary is
// verified today.

// Every path this file opens is a module's own state directory for one
// organization, and the file name is a state key that passed the key pattern:
// one segment, never a path. The one folder it makes is a module's own folder
// for one organization, and every level under it passed the folder pattern.
/* eslint-disable security/detect-non-literal-fs-filename */

import { chmod, lstat, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import { AUDIT_ACTIONS } from "../console/audit-actions";
import { SecretMissing, SecretUnavailable, type SecretProvider } from "../secrets/types";
import { bareHost, isPrivateAddressLiteral } from "./address-literal";
import type { AuditRecord } from "../console/audit-spool";
import type { AuditParams, AuditWriter, ModuleAudit } from "./module-audit";
import {
  AskFailure,
  egressAllows,
  EgressRefused,
  failureForLog,
  FOLDER_MAX_DEPTH,
  FOLDER_NAME_PATTERN,
  FolderRefused,
  MODULE_ACTION_PATTERN,
  ProcessRefused,
  PROGRAM_JOB_MAX_BYTES,
  PROGRAM_SECRET_FIELDS,
  ReachRefused,
  SecretNameRefused,
  SecretNotDeclared,
  STATE_KEY_PATTERN,
  type EgressRule,
  type FolderRule,
  type ModuleActContext,
  type ModuleContextV2,
  type ModuleManifest,
  type ModuleProcess,
  type ModuleStartContext,
  type ModuleStatePort,
  type Person,
  type ProcessRule,
  type ProgramFailureCode,
  type ProgramOutcome,
  type ProgramRun,
  type ProgramSecretField,
  type ReachEntry,
  type ReachRefusal,
  type SecretNameRefusal,
} from "./module-contract";
import {
  isAddableSecretName,
  isReachName,
  SECRET_NAMES_MAX_ENTRIES,
  ListUnreadable,
  recordable,
  type ModuleLists,
  type ReachAddRefusal,
} from "./module-lists";
import type { Organizations } from "./module-organizations";
import { ModuleNotRunning, ProcessNotStarted, ProcessesBusy, type ModuleProcesses } from "./module-processes";
import { processWordFor } from "./process-words";
import { programInstalled, type ModulePrograms } from "./module-programs";
import { programFor } from "./program-list";
import { isReachPort, reachHostRefusal } from "./reach-address";
import { resolveReach, type ReachLookup } from "./reach-resolve";
import type { Organization } from "./organization-id";
import { removeLeftIn, writePrivateJson } from "./private-json";
import type { EnrolledIdentity, ScopedLogger } from "./types";

/** Largest value one state key may hold, as JSON. State is bookkeeping — a
 *  cursor, a deployment id, a version — not a place to keep data. */
export const MODULE_STATE_MAX_BYTES = 1024 * 1024;

/**
 * The customer's secret store, built the first time something needs it.
 *
 * Which store this HX Fortress uses is a setting, and building one reads that
 * setting. Doing it on first use means an HX Fortress whose modules read no secret
 * never fails over a store it never needed, and a setting that was wrong at
 * boot is read again the next time a module asks.
 *
 * `kind` is the store's kind once it has been built. Until then, and while the
 * setting cannot be read, it is `env`: the kind an HX Fortress has when nothing is
 * set. `store()` is the way to ask and be told when the answer is not known.
 */
export class DeferredSecrets implements SecretProvider {
  private built: SecretProvider | null = null;

  constructor(private readonly build: () => Promise<SecretProvider>) {}

  get kind(): SecretProvider["kind"] {
    return this.built?.kind ?? "env";
  }

  /** The store itself. Rejects while the secrets setting is one this build
   *  cannot read; the next call tries again. */
  async store(): Promise<SecretProvider> {
    this.built = await this.build();
    return this.built;
  }

  async get(name: string): Promise<string> {
    return (await this.store()).get(name);
  }

  async has(name: string): Promise<boolean> {
    return (await this.store()).has(name);
  }
}

export interface ModuleContextDeps {
  logger: (moduleId: string) => ScopedLogger;
  identity: () => EnrolledIdentity | null;
  secrets: SecretProvider;
  audit: ModuleAudit;
  fetchImpl?: typeof fetch;
  /** The organizations of this HX Fortress, and what each one's are. */
  organizations: Organizations;
  /** The two lists a person adds to. Left out, a context reads both as empty. */
  lists?: ModuleLists;
  /**
   * The names of secrets that no person can hand to a module: the ones this
   * HX Fortress's own settings read, and the ones a manifest lists. Asked at
   * each read of a name a person added. REJECTS when the settings cannot be
   * read, and then no added name is read. Left out, no name is kept back.
   */
  reservedSecretNames?: () => Promise<ReadonlySet<string>>;
  /** What starts a process for a module. Left out, no context starts one. */
  processes?: ModuleProcesses;
  /** What runs a helper program for a module. Left out, no context has one
   *  run. */
  programs?: ModulePrograms;
  /** The daemon's own environment, read at each run: the variable that holds
   *  a program's path, and the few variables a program is given. The
   *  process's own when left out. */
  programEnv?: () => Readonly<Record<string, string | undefined>>;
  /** How the name of a host is looked up before a program is sent there. The
   *  machine's own resolver when left out. A seam for tests. */
  reachLookup?: ReachLookup;
}

/** The variables of the daemon's own environment that a program is given,
 *  when the daemon has them. `PATH`, and where a program finds a company's own
 *  certificate authorities on Linux. Nothing else of the daemon's is passed
 *  on: no proxy, no secret, no address of a database. */
const PROGRAM_PASSED_VARIABLES = ["PATH", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const;

/** The ends of a recorded run that are a rule's refusal, and no failure:
 *  nothing went wrong, and the host would not send a program there or then. */
const PROGRAM_REFUSALS: ReadonlySet<ProgramFailureCode> = new Set([
  "secret_not_added",
  "reach_address_refused",
  "module_not_running",
  "busy",
]);

/** A value that JSON writes as an object: not null, not a list. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A store's failure to read a stored name, as a failure to read the name the
 *  module asked for. The module declared that name and knows no other. Where
 *  the store looked stays on the error for this host's own log. */
function underDeclaredName(thrown: unknown, declared: string): unknown {
  if (thrown instanceof SecretMissing) return new SecretMissing(declared, thrown.source);
  if (thrown instanceof SecretUnavailable) {
    return new SecretUnavailable(declared, thrown.reason, {
      transient: thrown.transient,
      source: thrown.source,
    });
  }
  return thrown;
}

/** The context of one organization for one module, built from the module's
 *  manifest. */
export function createModuleContext(
  manifest: ModuleManifest,
  deps: ModuleContextDeps,
  organization: Organization,
): ModuleContextV2 {
  const moduleId = manifest.id;
  const declaredSecrets = new Set(manifest.secrets);
  const doFetch = deps.fetchImpl ?? fetch;
  // This organization's writer. Every record below goes through it, so none
  // can be written without saying whose it is.
  const audit = deps.audit.for(organization);

  // A REFUSAL'S RECORD IS WRITTEN BEFORE THE REFUSAL IS HANDED BACK. So whoever
  // is told "refused" finds the record of it. Only the first of a run of the
  // same refusal is a write: the rest are counted. Writing it does not reject:
  // a record that cannot be written is reported by the writer, and the
  // refusal stands either way.
  const refuseSecret = async (): Promise<never> => {
    await audit.refused(
      AUDIT_ACTIONS.moduleRefused,
      { module: moduleId, rule: "secret_not_declared" },
      null,
    );
    throw new SecretNotDeclared(moduleId, manifest.secrets);
  };

  /** A name is not read: it is one a person added and is reserved now, or
   *  the list of added names or the settings that say which names are
   *  reserved cannot be read. */
  const refuseAdded = async (rule: "secret_name_reserved" | "secret_names_unreadable"): Promise<never> => {
    await audit.refused(AUDIT_ACTIONS.moduleRefused, { module: moduleId, rule }, null);
    throw new SecretNameRefused(rule);
  };

  // What a person added to this module for this organization.
  const listsDir = deps.organizations.listsDir(organization, moduleId);
  const reaches = deps.lists?.reaches(listsDir) ?? null;
  const addedNames = deps.lists?.secretNames(listsDir) ?? null;

  /**
   * Whether a name is one a person added for this module and organization
   * that may be read now. Read from the list as it is at this moment. Writes
   * no record.
   *
   * Only this HX Fortress's own organization has such names: its console
   * signs in that organization's people, and nobody else can add one.
   */
  const addedNameState = async (name: string): Promise<"added" | "not_added" | "reserved" | "unreadable"> => {
    if (!(organization.own && addedNames && isAddableSecretName(name))) return "not_added";
    let added: boolean;
    try {
      added = (await addedNames.list()).some((entry) => entry.name === name);
    } catch (thrown) {
      // A list that cannot be read holds no name.
      if (thrown instanceof ListUnreadable) return "unreadable";
      throw thrown;
    }
    if (!added) return "not_added";
    // Checked again at each read, and not only when the name was added. A
    // person can add a name before this HX Fortress's own settings come to
    // read it: the name the sign-in's secret will later be kept under, for
    // one. Such a name is not read for a module from then on.
    let reserved: ReadonlySet<string>;
    try {
      reserved = (await deps.reservedSecretNames?.()) ?? new Set<string>();
    } catch {
      return "unreadable";
    }
    return reserved.has(name) ? "reserved" : "added";
  };

  /** The name this organization's secret is stored under, for a name the
   *  manifest declares or one a person added. */
  const storedName = async (declared: string): Promise<string | null> => {
    if (declaredSecrets.has(declared)) return deps.organizations.keyName(organization, moduleId, declared);
    const state = await addedNameState(declared);
    if (state === "added") return declared;
    // The word says why the read was refused: the list, and not the module's
    // manifest.
    if (state === "unreadable") return refuseAdded("secret_names_unreadable");
    if (state === "reserved") return refuseAdded("secret_name_reserved");
    return refuseSecret();
  };

  const secrets: SecretProvider = {
    get kind(): SecretProvider["kind"] {
      return deps.secrets.kind;
    },
    // `async`, so a refusal is a rejected promise like every other failure of
    // these two, and never a throw out of the call itself.
    async get(name: string): Promise<string> {
      const stored = await storedName(name);
      // An organization with no name for this secret has no such secret.
      // HX Fortress's own is never read in its place.
      if (stored === null) throw new SecretMissing(name);
      try {
        return await deps.secrets.get(stored);
      } catch (thrown) {
        throw stored === name ? thrown : underDeclaredName(thrown, name);
      }
    },
    async has(name: string): Promise<boolean> {
      const stored = await storedName(name);
      if (stored === null) return false;
      try {
        return await deps.secrets.has(stored);
      } catch (thrown) {
        throw stored === name ? thrown : underDeclaredName(thrown, name);
      }
    },
  };

  const refuseEgress = async (rule: EgressRule): Promise<never> => {
    await audit.refused(AUDIT_ACTIONS.moduleRefused, { module: moduleId, rule }, null);
    throw new EgressRefused(moduleId, rule);
  };

  const refuseFolder = async (rule: FolderRule): Promise<never> => {
    await audit.refused(AUDIT_ACTIONS.moduleRefused, { module: moduleId, rule }, null);
    throw new FolderRefused(moduleId, rule);
  };

  const refuseProcess = async (rule: ProcessRule): Promise<never> => {
    await audit.refused(AUDIT_ACTIONS.moduleRefused, { module: moduleId, rule }, null);
    throw new ProcessRefused(moduleId, rule);
  };

  // ── A helper program ───────────────────────────────────────────────────────
  //
  // THE ORDER IS: every check that reads nothing, then the record, then what
  // is read, then the start. A run that fails a check leaves one record with
  // the word and nothing of what was asked for. A run that passes them is a
  // pair in the audit trail, and its first half is on the disk before a secret
  // is read, before the host's name is looked up and before anything is
  // started.

  const failedRun = (code: ProgramFailureCode): ProgramOutcome => ({ ok: false, code });

  /** A run that is refused before anything is read. `rule` is the record's
   *  word where it says more than the answer's: which list could not be read. */
  const refuseRun = async (code: ProgramFailureCode, rule: string = code): Promise<ProgramOutcome> => {
    await audit.refused(AUDIT_ACTIONS.moduleRefused, { module: moduleId, rule }, null);
    return failedRun(code);
  };

  /** The values of the secrets a run names, by the job's field. */
  const readProgramSecrets = async (
    names: Readonly<Partial<Record<ProgramSecretField, string>>>,
  ): Promise<{ ok: true; values: Partial<Record<ProgramSecretField, string>> } | { ok: false; code: ProgramFailureCode }> => {
    const values: Partial<Record<ProgramSecretField, string>> = {};
    for (const field of Object.keys(PROGRAM_SECRET_FIELDS) as ProgramSecretField[]) {
      // `field` is one of two words written in this build.
      // eslint-disable-next-line security/detect-object-injection
      const name = names[field];
      if (name === undefined) continue;
      try {
        // The context's own read: it looks at the list again at this moment,
        // so a name that was taken off since the check is not read.
        // eslint-disable-next-line security/detect-object-injection
        values[field] = await secrets.get(name);
      } catch (thrown) {
        if (thrown instanceof SecretMissing) return { ok: false, code: "secret_missing" };
        if (thrown instanceof SecretNotDeclared || thrown instanceof SecretNameRefused) {
          return { ok: false, code: "secret_not_added" };
        }
        // What a store threw can name where it looked. Nothing of it is kept.
        return { ok: false, code: "secret_unavailable" };
      }
    }
    return { ok: true, values };
  };

  const runProgram = async (program: unknown, given: unknown): Promise<ProgramOutcome> => {
    // The program is one the module's own manifest names, and one the host's
    // list gives to this module. Either alone is not enough.
    const launcher = deps.programs;
    const listed =
      typeof program === "string" && (manifest.programs ?? []).some((entry) => entry.id === program)
        ? programFor(moduleId, program)
        : null;
    if (typeof program !== "string" || !listed || !launcher) return refuseRun("program_not_declared");
    // Nothing is looked up for a module that is not running, or that runs as
    // many programs as it may. The launcher asks again at the start.
    const early = launcher.refusal(moduleId);
    if (early !== null) return refuseRun(early);

    // WHAT THE MODULE HANDED OVER IS COPIED HERE, before anything is waited
    // for. What is checked below is the copy, and the job is built from the
    // copy: a caller that changes its own object afterwards changes nothing.
    const run = (given ?? {}) as Partial<Record<keyof ProgramRun, unknown>>;
    const { reach: reachName, onOutput, signal, timeoutMs } = run;
    if (typeof onOutput !== "function") return refuseRun("job_invalid");
    if (signal !== undefined && !(signal instanceof AbortSignal)) return refuseRun("job_invalid");
    const names: Partial<Record<ProgramSecretField, string>> = {};
    if (!isJsonObject(run.secrets)) return refuseRun("job_invalid");
    for (const [field, name] of Object.entries(run.secrets)) {
      if (!Object.hasOwn(PROGRAM_SECRET_FIELDS, field) || typeof name !== "string") return refuseRun("job_invalid");
      names[field as ProgramSecretField] = name;
    }
    for (const [field, needed] of Object.entries(PROGRAM_SECRET_FIELDS)) {
      if (needed && names[field as ProgramSecretField] === undefined) return refuseRun("job_invalid");
    }
    let input: unknown;
    try {
      const text = JSON.stringify(run.input);
      // The finished job is larger than this, so a job that is too large
      // already is refused before anything is read for it.
      if (typeof text !== "string" || Buffer.byteLength(text) > PROGRAM_JOB_MAX_BYTES) return refuseRun("job_invalid");
      input = JSON.parse(text);
    } catch {
      // A value that JSON cannot write: one that holds itself, or a number
      // too large for a number.
      return refuseRun("job_invalid");
    }
    if (!isJsonObject(input)) return refuseRun("job_invalid");
    // A MODULE PASSES NO ADDRESS, NO PASSWORD AND NO CERTIFICATE. The host
    // puts those in, from the list of hosts and from the key store.
    if (Object.hasOwn(input, "server") || Object.hasOwn(input, "reach")) return refuseRun("job_invalid");
    const login = input.login;
    if (!isJsonObject(login) || Object.hasOwn(login, "password")) return refuseRun("job_invalid");
    const tls = Object.hasOwn(input, "tls") ? input.tls : {};
    if (!isJsonObject(tls) || Object.hasOwn(tls, "caCertificate")) return refuseRun("job_invalid");
    // The address a program sends rows to is one that a door of this machine
    // gave out. This build has no such door yet, so no job names one.
    if (Object.hasOwn(input, "store") && (!isJsonObject(input.store) || Object.hasOwn(input.store, "gatewayUrl"))) {
      return refuseRun("job_invalid");
    }

    // The host a person added under this name, as the list has it now.
    if (typeof reachName !== "string" || !reaches) return refuseRun("reach_not_listed");
    let entry: ReachEntry | undefined;
    try {
      entry = (await reaches.list()).find((listed) => listed.name === reachName);
    } catch (thrown) {
      // A list that cannot be read holds no host.
      if (thrown instanceof ListUnreadable) return refuseRun("reach_not_listed", "reach_list_unreadable");
      throw thrown;
    }
    if (!entry) return refuseRun("reach_not_listed");

    // Each secret's name is one a person added for this module. A name from
    // the manifest is the module's own secret, and is handed to no program.
    for (const name of Object.values(names)) {
      const state = await addedNameState(name);
      if (state === "unreadable") return refuseRun("secret_not_added", "secret_names_unreadable");
      if (state === "reserved") return refuseRun("secret_not_added", "secret_name_reserved");
      if (state !== "added") return refuseRun("secret_not_added");
    }

    // A HOST WITH NO SUCH PROGRAM READS NO SECRET FOR IT. The path is the
    // install's own setting. No module, ask or act names it. The launcher
    // looks again at the moment of the start.
    const env = (deps.programEnv ?? ((): Readonly<Record<string, string | undefined>> => process.env))();
    const set = env[listed.pathVariable];
    const file = typeof set === "string" ? set.trim() : "";
    if (!programInstalled(file)) return refuseRun("program_not_installed");

    // THE RECORD, before a secret is read and before anything is started. A
    // run that cannot be recorded is not made.
    let intent: AuditRecord;
    try {
      intent = await audit.intent(AUDIT_ACTIONS.moduleProgram, {
        params: { module: moduleId, program, reach: entry.name },
      });
    } catch {
      return failedRun("audit_unavailable");
    }
    let end: ProgramOutcome = failedRun("program_failed");
    try {
      end = await startProgram(launcher, program, listed, file, env, entry, input, login, tls, names, {
        onOutput: onOutput as ProgramRun["onOutput"],
        ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
        ...(signal === undefined ? {} : { signal }),
      });
    } finally {
      // The run has happened, or it has not: a second half that cannot be
      // written changes neither. The writer reports it.
      await audit
        .outcome(intent, end.ok ? "ok" : PROGRAM_REFUSALS.has(end.code) ? "refused" : "failed", end.ok ? null : end.code)
        .catch(() => {});
    }
    return end;
  };

  /** What is read for a run, and the run itself. Everything here is after the
   *  record's first half. */
  const startProgram = async (
    launcher: ModulePrograms,
    program: string,
    listed: NonNullable<ReturnType<typeof programFor>>,
    file: string,
    env: Readonly<Record<string, string | undefined>>,
    entry: ReachEntry,
    input: Record<string, unknown>,
    login: Record<string, unknown>,
    tls: Record<string, unknown>,
    names: Readonly<Partial<Record<ProgramSecretField, string>>>,
    how: Pick<ProgramRun, "onOutput" | "timeoutMs" | "signal">,
  ): Promise<ProgramOutcome> => {
    const read = await readProgramSecrets(names);
    if (!read.ok) return failedRun(read.code);
    // Where the host's name leads, looked up now and held to the rule for a
    // host. The program is given the address that was checked.
    const resolved = await resolveReach(entry.host, deps.reachLookup ? { lookup: deps.reachLookup } : {});
    if (!resolved.ok) return failedRun(resolved.code);
    const job = {
      ...input,
      // The host as the person added it: the name the server's certificate is
      // checked against.
      server: { host: entry.host, port: entry.port },
      // The address the program connects to.
      reach: { kind: "direct", host: resolved.address, port: entry.port },
      login: { ...login, password: read.values.password },
      ...(read.values.caCertificate === undefined && !Object.hasOwn(input, "tls")
        ? {}
        : {
            tls:
              read.values.caCertificate === undefined ? tls : { ...tls, caCertificate: read.values.caCertificate },
          }),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(job));
    if (bytes.byteLength > PROGRAM_JOB_MAX_BYTES) {
      bytes.fill(0);
      return failedRun("job_invalid");
    }
    const passed: Record<string, string> = {};
    for (const name of PROGRAM_PASSED_VARIABLES) {
      // `name` is one of three words written in this file.
      // eslint-disable-next-line security/detect-object-injection
      const value = env[name];
      // eslint-disable-next-line security/detect-object-injection
      if (typeof value === "string" && value !== "") passed[name] = value;
    }
    return launcher.run({
      moduleId,
      program,
      path: file,
      args: listed.args,
      // The list's own variables last: nothing of the daemon's replaces one.
      env: { ...passed, ...listed.env },
      input: bytes,
      onOutput: how.onOutput,
      ...(how.timeoutMs === undefined ? {} : { timeoutMs: how.timeoutMs }),
      ...(how.signal === undefined ? {} : { signal: how.signal }),
    });
  };

  /**
   * Where a folder of this module and this organization is, level by level.
   * Makes nothing on the disk, and looks at no folder there. `refuse` says how
   * a name or a depth that is not taken is refused: as a folder, or as a
   * process.
   *
   * The names are copied before anything is asked of them, and the path is
   * built from the copy. What is waited for in between is long enough for a
   * caller to change its own list, and a path built from the list would then
   * be one that was never checked.
   */
  const folderPlace = async (
    given: readonly unknown[],
    refuse: (rule: FolderRule) => Promise<never>,
  ): Promise<{ dir: string; base: string; levels: readonly string[]; names: readonly string[] }> => {
    // One more than may be asked for is enough to tell that it is too many.
    const names = given.slice(0, FOLDER_MAX_DEPTH + 1);
    if (names.length > FOLDER_MAX_DEPTH) return refuse("folder_too_deep");
    const held: string[] = [];
    for (const name of names) {
      if (typeof name !== "string" || !FOLDER_NAME_PATTERN.test(name)) return refuse("folder_name_invalid");
      held.push(name);
    }
    // An organization that left the list, or whose entry stopped listing the
    // module, gets no new folder and no path to an old one. What it left on
    // the disk stays there until a person removes it.
    if (!(await deps.organizations.worksFor(organization, moduleId))) return refuse("organization_not_held");
    const levels = deps.organizations.dataLevels(organization, moduleId);
    const base = levels[levels.length - 1] as string;
    // Absolute also where this HX Fortress's folder was given as a path
    // from the daemon's working folder.
    return { dir: path.resolve(base, ...held), base, levels, names: held };
  };

  /** A list that is on the disk and cannot be read, said as a refusal. The
   *  record is written before the refusal is handed back. */
  const unreadable = <T>(refusal: () => ReachRefused | SecretNameRefused) =>
    async (thrown: unknown): Promise<T> => {
      if (!(thrown instanceof ListUnreadable)) throw thrown;
      const refused = refusal();
      await audit.refused(AUDIT_ACTIONS.moduleRefused, { module: moduleId, rule: refused.rule }, null);
      throw refused;
    };

  return {
    moduleId,
    logger: deps.logger(moduleId),
    // Read when asked, not when the context was built: a module initialized
    // before enrollment completes must not keep answering "not enrolled". The
    // identity is the enrollment's, and the enrollment is the own
    // organization's: another organization's context has none.
    get fortressIdentity(): EnrolledIdentity | null {
      return organization.own ? deps.identity() : null;
    },
    organization,
    secrets,
    audit: {
      // No person, on every context: see `recordAct` of an act's context.
      record: (action, detail) => writeModuleRecord(audit, moduleId, action, detail, null),
    },
    state: createModuleState(deps.organizations.stateDir(organization, moduleId)),
    reach: {
      list: async (): Promise<ReachEntry[]> =>
        reaches
          ? reaches.list().catch(unreadable<ReachEntry[]>(() => new ReachRefused("reach_list_unreadable")))
          : [],
    },
    secretNames: {
      list: async (): Promise<string[]> =>
        addedNames
          ? addedNames
              .list()
              .then((entries) => entries.map((entry) => entry.name))
              .catch(unreadable<string[]>(() => new SecretNameRefused("secret_names_unreadable")))
          : [],
    },
    // `async`, so a refusal is a rejected promise and never a throw out of the
    // call itself.
    async folder(...names: string[]): Promise<string> {
      const { dir, base, levels } = await folderPlace(names, refuseFolder);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // The mode above is a request: it is given only to a level that is made
      // now. A level that was already there keeps the mode it had, which a
      // copy from a backup can have widened.
      //
      // The module's folder and every level under it are set to the user's
      // own. The levels above it hold other things too (a module's state, the
      // releases), so they keep their mode but for one thing: nobody else may
      // write there. A user who could would be able to put another folder in
      // this one's place.
      for (const above of levels.slice(0, -1)) {
        const mode = (await stat(above)).mode & 0o777;
        if ((mode & 0o022) !== 0) await chmod(above, mode & ~0o022);
      }
      let level = path.resolve(base);
      await chmod(level, 0o700);
      for (const name of names) {
        level = path.join(level, name);
        await chmod(level, 0o700);
      }
      return dir;
    },
    processes: {
      // `async`, so a refusal is a rejected promise and never a throw out of
      // the call itself.
      async start(verb, options): Promise<ModuleProcess> {
        // The word is one the module's own manifest names, and one the host's
        // list gives to this module. Either alone is not enough.
        const declared =
          typeof verb === "string" && (manifest.processes ?? []).some((process) => process.verb === verb);
        if (!declared || !processWordFor(moduleId, verb) || !deps.processes) {
          return refuseProcess("process_not_declared");
        }
        const given: unknown = (options as { folder?: unknown } | null | undefined)?.folder;
        const onMessage: unknown = (options as { onMessage?: unknown } | null | undefined)?.onMessage;
        if (!Array.isArray(given)) return refuseProcess("folder_name_invalid");
        if (typeof onMessage !== "function") throw new TypeError("a process needs a listener for what it sends");
        const { dir, base, names } = await folderPlace(given, refuseProcess);
        // THE FOLDER IS THERE ALREADY, OR NOTHING IS STARTED. Nothing is made
        // here and no mode is set: the module made the folder, and a start
        // that ends late must not put back one that the module removed.
        //
        // EVERY LEVEL IS A FOLDER ITSELF, from the module's own folder down.
        // A link is not followed at any of them: a link at an upper level
        // would lead the process into a folder that is not this module's, or
        // not this organization's.
        let level = path.resolve(base);
        for (const name of [null, ...names]) {
          if (name !== null) level = path.join(level, name);
          let found;
          try {
            found = await lstat(level);
          } catch (thrown) {
            const code = (thrown as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ENOTDIR") return refuseProcess("folder_missing");
            throw thrown;
          }
          if (!found.isDirectory()) return refuseProcess("folder_missing");
        }
        try {
          return deps.processes.start(moduleId, verb, dir, onMessage as (message: unknown) => unknown);
        } catch (thrown) {
          // Each of these is a start that was not made, and is recorded.
          if (thrown instanceof ModuleNotRunning) return refuseProcess("module_not_running");
          if (thrown instanceof ProcessesBusy) return refuseProcess("processes_unavailable");
          if (thrown instanceof ProcessNotStarted) return refuseProcess("process_start_failed");
          throw thrown;
        }
      },
    },
    programs: {
      // Never rejects: a failure on this side is one more way a run can end.
      async run(program, run): Promise<ProgramOutcome> {
        try {
          return await runProgram(program, run);
        } catch (thrown) {
          deps.logger(moduleId).error("a run of a module's program failed on this side", failureForLog(thrown));
          return failedRun("program_failed");
        }
      },
    },
    async fetch(url: string, init?: RequestInit): Promise<Response> {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        return refuseEgress("egress_malformed");
      }
      if (target.protocol !== "https:") return refuseEgress("egress_not_https");
      if (target.username || target.password) return refuseEgress("egress_malformed");
      const host = bareHost(target.hostname);
      if (!egressAllows(manifest.egress, host)) return refuseEgress("egress_not_declared");
      // A host written as an address in a private range is refused even when a
      // manifest lists it. A NAME is not checked this way: the manifest is the
      // control for names, and what a name resolves to is not looked at.
      if (isPrivateAddressLiteral(host)) return refuseEgress("egress_private_address");
      // Only these four things of `init` are passed on. The runtime's `fetch`
      // takes more (a proxy, a Unix socket, TLS settings), and each of those is
      // a way to send the request somewhere the checks above never saw.
      const passed: RequestInit = {
        ...(init?.method !== undefined ? { method: init.method } : {}),
        ...(init?.headers !== undefined ? { headers: init.headers } : {}),
        ...(init?.body !== undefined ? { body: init.body } : {}),
        ...(init?.signal !== undefined ? { signal: init.signal } : {}),
        // A redirect is the other side choosing the next host. Following it
        // could reach a host the manifest does not list, so a redirect is an
        // error unless the module asked to see the redirect itself.
        redirect: init?.redirect === "manual" ? "manual" : "error",
      };
      return doFetch(target, passed);
    },
  };
}

/**
 * The context a module is started with: the own organization's context, and the
 * way to the contexts of the other organizations it is on for.
 *
 * A separate object from the context an ask is given, so that an ask's context
 * cannot list anybody.
 */
export function createModuleStartContext(
  own: ModuleContextV2,
  contexts: () => Promise<ModuleContextV2[]>,
): ModuleStartContext {
  return {
    moduleId: own.moduleId,
    logger: own.logger,
    get fortressIdentity(): EnrolledIdentity | null {
      return own.fortressIdentity;
    },
    organization: own.organization,
    secrets: own.secrets,
    audit: own.audit,
    state: own.state,
    reach: own.reach,
    secretNames: own.secretNames,
    // The same function, not a second call of it: a refusal is then always a
    // rejected promise, whatever was passed.
    folder: own.folder,
    processes: own.processes,
    programs: own.programs,
    fetch: (url: string, init?: RequestInit) => own.fetch(url, init),
    organizations: contexts,
  };
}

// ── The context of a person's act ────────────────────────────────────────────

export interface ActContextDeps {
  moduleId: string;
  /** The two lists of this module for this HX Fortress's own organization. */
  lists: ModuleLists;
  listsDir: string;
  /** The own organization's writer. */
  audit: AuditWriter;
  /**
   * The names of secrets a person cannot hand to a module: the ones this
   * HX Fortress's own settings read, and the ones a manifest lists. REJECTS
   * when the settings cannot be read, and then no name is added.
   */
  reservedSecretNames: () => Promise<ReadonlySet<string>>;
  clock?: () => Date;
}

/** Who is acting, as the console's sign-in says. */
export interface Acting {
  person: Person;
  /** The console's own id for the person's sign-in, for the record. */
  session: string | null;
}

const REACH_RULE: Record<ReachAddRefusal, ReachRefusal> = {
  name_taken: "reach_name_taken",
  too_many: "reach_list_full",
  not_a_host: "reach_host_invalid",
  host_not_allowed: "reach_address_refused",
  list_unreadable: "reach_list_unreadable",
};

/** How a change to a list ended when the list already was as asked. */
const UNCHANGED = Symbol("unchanged");

/** Who a module's record is written under: a person's login, and the
 *  console's own id for that person's sign-in. */
interface RecordedUnder {
  actor: string;
  sessionRef: string | null;
}

/**
 * Write one record of a module's own, `module.<id>.<action>`.
 *
 * WHO A RECORD NAMES IS THE HOST'S TO SAY. `who` is the person it is written
 * under, or null for nobody. A module passes no person: a detail field cannot
 * become the record's actor.
 *
 * WHOSE A RECORD IS, is the writer's to say too: the spool drops a detail
 * called `organization` and writes its own.
 */
function writeModuleRecord(
  audit: AuditWriter,
  moduleId: string,
  action: string,
  detail: Record<string, string | number | boolean>,
  who: RecordedUnder | null,
): void {
  if (action.length > 64 || !MODULE_ACTION_PATTERN.test(action)) {
    throw new TypeError("a module's audit action must be lower-case words joined by dots");
  }
  void audit.event(`${AUDIT_ACTIONS.modulePrefix}${moduleId}.${action}`, {
    ...(who === null ? {} : { actor: who.actor, sessionRef: who.sessionRef }),
    params: detail,
    outcome: "done",
  });
}

/**
 * The context of one act of one person: the own organization's context, and
 * the two lists.
 *
 * `mayChange` is asked at each change. It answers yes only in an act that the
 * manifest gives to operators, and only while that act runs. Otherwise `add`
 * and `remove` reject with `not_allowed`: in an act that every signed-in
 * person may do, and on a context that a module kept after its act had ended.
 * Such a try is recorded as the module's own refused call, with no person.
 *
 * `running` is asked at each record the module writes with
 * `ctx.audit.recordAct`: a record of what the person is having it do. While
 * the act's work has not ended, such a record is written under the person's
 * login, as the act's own pair is, whichever role the act is given to. So a
 * line such as "a connection was added" names who added it, and the module
 * passes no login for that. Written through a context that a module kept,
 * after the act's work had ended, it names no person: nobody is acting any
 * more. A job that an act started and that ends later is such a case.
 *
 * `ctx.audit.record` names nobody here too, also while the act runs. A module
 * does other work in an act: the Databases module closes a test that another
 * caller started and that was lost. A line of that work is not the person's,
 * so the module says which of its records are.
 *
 * EVERY CHANGE IS RECORDED BEFORE IT IS MADE, under the person's login. The
 * record of a change is a pair: its first half is on the disk before the list
 * is written, and a change that cannot be recorded is not made. A request
 * that is refused before it gets that far (a name or a host that is not one)
 * leaves one `refused` record with the rule. What was asked for is not in it.
 */
export function createModuleActContext(
  base: ModuleContextV2,
  deps: ActContextDeps,
  acting: Acting,
  mayChange: () => boolean,
  running: () => boolean,
): ModuleActContext {
  const { moduleId, audit } = deps;
  const clock = deps.clock ?? ((): Date => new Date());
  const actor = acting.person.login;
  const reaches = deps.lists.reaches(deps.listsDir);
  const names = deps.lists.secretNames(deps.listsDir);

  /**
   * A change that is not this context's to make: in an act that every
   * signed-in person may do, or after the act had ended. The MODULE tried it.
   * The person asked for an act that changes neither list, or asked for
   * nothing at all any more. So the record is the module's own refused call,
   * like a call to a host its manifest does not list, and it names no person.
   */
  const notThisContexts = async (refusal: ReachRefused | SecretNameRefused): Promise<never> => {
    await audit.refused(AUDIT_ACTIONS.moduleRefused, { module: moduleId, rule: "list_change_not_allowed" }, null);
    throw refusal;
  };

  // A refusal is on the disk before it is handed back, so whoever is told
  // "refused" can find the record of it.
  const refuseReach = async (action: string, rule: ReachRefusal): Promise<never> => {
    await audit.refused(action, { module: moduleId, rule }, actor);
    throw new ReachRefused(rule);
  };
  const refuseName = async (action: string, rule: SecretNameRefusal): Promise<never> => {
    await audit.refused(action, { module: moduleId, rule }, actor);
    throw new SecretNameRefused(rule);
  };

  /**
   * Make one change inside its record. `change` says how it ended: null for
   * done, the rule that refused it, or `UNCHANGED` when the list already was
   * as asked. That last one happens when two acts ask for the same change at
   * the same moment: both looked before either wrote, and only one of them
   * changed the list. The other's record ends `unchanged`, so the records on
   * this host hold one `ok` for one change. The lines that the `host` module
   * gives the control plane have three words for how a thing ended, and such
   * a record reads `ok` there.
   *
   * An add of a host under a name that is taken does not come here: it is
   * refused with `reach_name_taken`, also when the other act added the same
   * host a moment before.
   */
  const recorded = async (
    action: string,
    params: AuditParams,
    change: () => Promise<string | null | typeof UNCHANGED>,
  ): Promise<string | null> => {
    let intent;
    try {
      intent = await audit.intent(action, { actor, sessionRef: acting.session, params });
    } catch {
      // A change that cannot be recorded is not made.
      throw new AskFailure("audit_unavailable");
    }
    let ended: string | null | typeof UNCHANGED;
    try {
      ended = await change();
    } catch (thrown) {
      await audit.outcome(intent, "failed", thrown instanceof ListUnreadable ? "list_unreadable" : "internal");
      throw thrown;
    }
    if (ended === UNCHANGED) {
      await audit.outcome(intent, "unchanged");
      return null;
    }
    await audit.outcome(intent, ended === null ? "ok" : "refused", ended);
    return ended;
  };

  const reachUnreadable = (action: string) => (thrown: unknown): Promise<never> => {
    if (thrown instanceof ListUnreadable) return refuseReach(action, "reach_list_unreadable");
    throw thrown;
  };
  const namesUnreadable = (action: string) => (thrown: unknown): Promise<never> => {
    if (thrown instanceof ListUnreadable) return refuseName(action, "secret_names_unreadable");
    throw thrown;
  };

  return {
    moduleId: base.moduleId,
    logger: base.logger,
    get fortressIdentity(): EnrolledIdentity | null {
      return base.fortressIdentity;
    },
    organization: base.organization,
    secrets: base.secrets,
    audit: {
      record: (action, detail) => base.audit.record(action, detail),
      recordAct: (action, detail) =>
        writeModuleRecord(audit, moduleId, action, detail, running() ? { actor, sessionRef: acting.session } : null),
    },
    state: base.state,
    folder: base.folder,
    processes: base.processes,
    programs: base.programs,
    fetch: (url: string, init?: RequestInit) => base.fetch(url, init),
    reach: {
      list: () => base.reach.list(),
      async add(name: string, to: { host: string; port: number }): Promise<void> {
        const action = AUDIT_ACTIONS.consoleModuleReachAdd;
        if (!mayChange()) return notThisContexts(new ReachRefused("not_allowed"));
        if (!isReachName(name)) return refuseReach(action, "reach_name_invalid");
        const host: unknown = (to as { host?: unknown } | null)?.host;
        const port: unknown = (to as { port?: unknown } | null)?.port;
        const refusal = reachHostRefusal(host);
        if (refusal) return refuseReach(action, refusal);
        if (typeof host !== "string" || !recordable(host)) return refuseReach(action, "reach_host_invalid");
        if (!isReachPort(port)) return refuseReach(action, "reach_port_invalid");
        const rule = await recorded(action, { module: moduleId, name, host, port }, async () => {
          const added = await reaches.add({ name, host, port, addedBy: actor, addedAt: clock().toISOString() });
          // The list's own word for a refusal, said as this port's.
          return added.ok ? null : REACH_RULE[added.reason];
        });
        if (rule !== null) throw new ReachRefused(rule as ReachRefusal);
      },
      async remove(name: string): Promise<void> {
        const action = AUDIT_ACTIONS.consoleModuleReachRemove;
        if (!mayChange()) return notThisContexts(new ReachRefused("not_allowed"));
        // A name that is not one is on no list.
        if (!isReachName(name)) return;
        const entry = (await reaches.list().catch(reachUnreadable(action))).find(
          (candidate) => candidate.name === name,
        );
        if (!entry) return;
        await recorded(action, { module: moduleId, name, host: entry.host, port: entry.port }, async () =>
          (await reaches.remove(name)) ? null : UNCHANGED,
        ).catch(reachUnreadable(action));
      },
    },
    secretNames: {
      list: () => base.secretNames.list(),
      async add(name: string): Promise<void> {
        const action = AUDIT_ACTIONS.consoleModuleSecretAdd;
        if (!mayChange()) return notThisContexts(new SecretNameRefused("not_allowed"));
        if (!isAddableSecretName(name)) return refuseName(action, "secret_name_invalid");
        let reserved: ReadonlySet<string>;
        try {
          reserved = await deps.reservedSecretNames();
        } catch {
          return refuseName(action, "secret_names_unreadable");
        }
        if (reserved.has(name)) return refuseName(action, "secret_name_reserved");
        const held = await names.list().catch(namesUnreadable(action));
        // Adding a name twice is one entry, and one record.
        if (held.some((entry) => entry.name === name)) return;
        if (held.length >= SECRET_NAMES_MAX_ENTRIES) return refuseName(action, "secret_names_full");
        const rule = await recorded(action, { module: moduleId, name }, async () => {
          const added = await names.add({ name, addedBy: actor, addedAt: clock().toISOString() });
          if (added.ok) return added.added ? null : UNCHANGED;
          return added.reason === "too_many" ? "secret_names_full" : "secret_names_unreadable";
        });
        if (rule !== null) throw new SecretNameRefused(rule as SecretNameRefusal);
      },
      async remove(name: string): Promise<void> {
        const action = AUDIT_ACTIONS.consoleModuleSecretRemove;
        if (!mayChange()) return notThisContexts(new SecretNameRefused("not_allowed"));
        if (!isAddableSecretName(name)) return;
        const held = await names.list().catch(namesUnreadable(action));
        if (!held.some((entry) => entry.name === name)) return;
        await recorded(action, { module: moduleId, name }, async () =>
          (await names.remove(name)) ? null : UNCHANGED,
        ).catch(namesUnreadable(action));
      },
    },
  };
}

/** The folder, inside a module's state folder, that the temporary files of its
 *  writes are made in. No key's file can have this name: a key has no dot. */
export const STATE_WRITING_FOLDER = ".writing";

/** The state folders whose temporary files this process has cleared once of
 *  what earlier runs left. */
const cleared = new Set<string>();

/**
 * A module's state: one 0600 JSON file per key, under HX Fortress root.
 *
 * WHAT A KEY HELD IS GONE WHEN THE KEY IS REMOVED. A value is written under a
 * temporary name and renamed, and a daemon that stops between the two leaves
 * the temporary file with the value in it. A module removes a key because what
 * it held must not stay: a page of a database's table names, after its
 * connection was removed. So:
 *
 *   - The temporary files of a state folder are made in a folder of their own
 *     inside it, `.writing`. It holds one file for each write that is under
 *     way and one for each write that never ended, so it can be listed at a
 *     cost that does not grow with the number of keys.
 *   - `remove` removes the key's file and every temporary file of that key
 *     that no write of this process is using. It REJECTS when it could not
 *     make sure: the folder could not be listed, or a file could not be
 *     removed. A module whose removal failed removes again.
 *   - The first use of a state folder by a process clears the folder of what
 *     earlier runs left for any key. When that fails, the next use tries again.
 */
export function createModuleState(dir: string): ModuleStatePort {
  const writing = path.join(dir, STATE_WRITING_FOLDER);
  const fileFor = (key: string): string => {
    if (!STATE_KEY_PATTERN.test(key)) {
      throw new TypeError("a state key is 1 to 64 characters of a-z, 0-9, _ and -");
    }
    return path.join(dir, `${key}.json`);
  };
  const clearOnce = async (): Promise<void> => {
    if (cleared.has(dir)) return;
    try {
      await removeLeftIn(writing);
      cleared.add(dir);
    } catch {
      // Not cleared: the next use of this folder tries again.
    }
  };
  return {
    async read<T>(key: string): Promise<T | null> {
      const file = fileFor(key);
      await clearOnce();
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      return (JSON.parse(text) as { value: T }).value;
    },
    async write<T>(key: string, value: T): Promise<void> {
      const file = fileFor(key);
      const body = JSON.stringify({ value });
      if (Buffer.byteLength(body) > MODULE_STATE_MAX_BYTES) {
        throw new RangeError(`a state value may be at most ${MODULE_STATE_MAX_BYTES} bytes of JSON`);
      }
      await clearOnce();
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writePrivateJson(file, { value }, { temporaryIn: writing });
    },
    async remove(key: string): Promise<void> {
      const file = fileFor(key);
      await clearOnce();
      // `force`: a key that holds nothing has no file, and that is the state
      // this call is asked to reach.
      await rm(file, { force: true });
      // And what a write of this key left behind, whichever run made it. A
      // failure here is the caller's to know: the key's value may still be on
      // the disk.
      await removeLeftIn(writing, path.basename(file));
    },
  };
}
