// The module host: the one object in the daemon that owns everything the
// control plane can do to a module.
//
// It gives the connection two handlers:
//
//   • `asks`     — a `moduleMessage` frame goes to the ask gate
//   • `releases` — a `moduleAdvertise` frame goes to the release shelf, and a
//                  `moduleRemove` frame is refused
//
// and it gives this host's own operator one entry point, which no frame on the
// connection can reach:
//
//   • `applyRequests` — carry out what a terminal or the console asked for:
//                       a release decision, or a module's switch having changed
//
// and it gives a person signed in to the console one way to a module, which no
// frame on the connection can reach either:
//
//   • `door` — the listener on this machine that the console hands a person's
//              act to, and `acts`, the gate every act passes through. The door
//              is open only while a module that is switched on lists acts.
//
// WHAT IS ON is config.json's `modules.enabled`, read live. The runtime starts
// those modules at boot; after that this host follows the file. It never writes
// it: switching a module is a local gesture, made by a verb somebody types.
//
// WHOSE IT IS. Every ask is for one organization. Almost every HX Fortress holds
// one, its own, and for it everything below reads as it did before there could
// be a second. Where an HX Fortress holds more (module-organizations.ts), a module
// is on for another organization only if it is on for HX Fortress and that
// organization's entry lists it, and the module is handed that organization's
// context and no other. That rule is written once, in `onFor`.

import { AUDIT_ACTIONS } from "../console/audit-actions";
import { verifyGrant, type ModuleGrantClaims } from "../gateway/capability-token";
import type { MsgData, MsgReply } from "../protocol";
import type { SecretProvider } from "../secrets/types";
import { ActGate } from "./act-gate";
import { AskGate, askLimits, type ModuleGrantBind } from "./ask-gate";
import { FileConfigStore, readEnabledModules } from "./config";
import { LocalDoor } from "./local-door";
import type { LogBus } from "./logging";
import { ModuleAudit } from "./module-audit";
import { catalogEntry, MODULE_CATALOG, type CatalogEntry } from "./module-catalog";
import {
  createModuleActContext,
  createModuleContext,
  createModuleStartContext,
  DeferredSecrets,
  type Acting,
} from "./module-context";
import {
  isFortressModule,
  manifestDefect,
  type FortressModule,
  type ModuleActContext,
  type ModuleContextV2,
  type ModuleStartContext,
  type ReleaseRecord,
} from "./module-contract";
import { ModuleLists } from "./module-lists";
import { ModuleProcesses, selfCommand, type SpawnChild } from "./module-processes";
import { ModulePrograms, type SpawnProgram } from "./module-programs";
import type { ReachLookup } from "./reach-resolve";
import { Organizations, OrganizationsUnusable, type Organization } from "./module-organizations";
import type { ModuleRegistry } from "./module-registry";
import { publishModuleSettings } from "./modules-api";
import type { fortressPaths } from "./paths";
import { controlPlaneOriginOf } from "./release-fetch";
import {
  answerReleaseDecision,
  DECISION_REQUEST_TTL_MS,
  sweepReleaseAnswers,
  takeReleaseDecisions,
} from "./release-intents";
import {
  installedVersions,
  ReleaseShelf,
  type InstallResult,
  type OfferFrame,
} from "./release-shelf";
import type { TrustedSigningKey } from "./trust/signing-keys";
import type { Module, ModuleContext, ScopedLogger } from "./types";
import { SettingUnreadable } from "./own-secret-names";
import { withDeadline } from "./with-deadline";

type FortressPaths = ReturnType<typeof fortressPaths>;

export interface ModuleHostDeps {
  paths: FortressPaths;
  registry: ModuleRegistry;
  bus: LogBus;
  /** HX Fortress version: what a module with no installed release reports. */
  version: string;
  /** The customer's secret store, built on first use. Rejects while the secrets
   *  setting is one this build cannot read. */
  secrets: () => Promise<SecretProvider>;
  /** `verifyGrant` for purpose `module`, over the pinned key and the
   *  organization this HX Fortress enrolled as. `holds` is this host telling
   *  the verifier which other organizations it holds. */
  verifyGrant: (token: string, bind: ModuleGrantBind) => Promise<ModuleGrantClaims>;
  /** The organization this HX Fortress enrolled as: the one `verifyGrant`
   *  holds a grant's `aud` to. Null before it has enrolled. The list of
   *  other organizations may not name it. Required, so that no host is built
   *  without the rule. It REJECTS when the id cannot be read, and never answers
   *  null for that: see `OrganizationsDeps.enrolledAs`. */
  enrolledAs: () => Promise<string | null>;
  /**
   * The names of the secrets this HX Fortress's own settings read: its
   * database's, its sign-in's. A person cannot hand one of them to a module.
   * It REJECTS when a setting cannot be read, and then no name is added.
   * Left out, the names that manifests list are the only ones kept back.
   */
  reservedSecretNames?: () => Promise<readonly string[]>;
  catalog?: readonly CatalogEntry[];
  /** For a module whose switch the daemon reads only when it starts (`startOnly`
   *  in the catalog): whether THIS run began with it on. The daemon decides that
   *  once, early in its boot, and tells this host here. Left out, or answering
   *  undefined, the switch as config.json held it when this host started is used. */
  startedWith?: (moduleId: string) => boolean | undefined;
  env?: Record<string, string | undefined>;
  clock?: () => Date;
  /** Seams for tests: the transport a module's `ctx.fetch` uses, the transport a
   *  release artifact is fetched over, and the trust anchors. */
  fetchImpl?: typeof fetch;
  releaseFetchImpl?: typeof fetch;
  trustedKeys?: readonly TrustedSigningKey[];
  /** This program as a command that starts it again, for a module's own
   *  process. Left out, the running program's own, which is none in a test:
   *  what runs there is the test and not this program. A test names a
   *  stand-in. */
  self?: () => readonly string[] | null;
  /** A seam for tests: what starts a child. */
  spawnProcess?: SpawnChild;
  /** A seam for tests: how long the end of a module's process is waited for. */
  processEndWaitMs?: number;
  /** A seam for tests: what starts a helper program. */
  spawnProgram?: SpawnProgram;
  /** A seam for tests: how long a program that was asked to stop has before
   *  it is killed, and how long the host then waits for it. */
  programStopGraceMs?: number;
  programEndWaitMs?: number;
  /** A seam for tests: how the name of a host is looked up before a program is
   *  sent there. The machine's own resolver when left out. */
  reachLookup?: ReachLookup;
  askDeadlineMs?: number;
  actDeadlineMs?: number;
  applyDeadlineMs?: number;
}

/**
 * How the daemon verifies the grant on an ask.
 *
 * The same two facts every other grant on this host is checked against: the
 * per-org key the control plane pushed and this HX Fortress PINNED, and the
 * organization it enrolled into. And a purpose no other surface accepts.
 *
 * The grant must be addressed to that organization (`aud`). The organization
 * the ask is for (`org`) is that one, or one this host holds: `bind.holds` is
 * how the module host says which.
 *
 * Throws before a key is pinned or the organization is known. The gate reads
 * any throw as a refusal, so an HX Fortress that cannot verify refuses every ask.
 */
export function createModuleGrantVerifier(source: {
  pinnedKey: () => Promise<string | null>;
  orgId: () => Promise<string | null>;
}): ModuleHostDeps["verifyGrant"] {
  return async (token, bind) => {
    const key = await source.pinnedKey();
    if (!key) throw new Error("no pinned signing key");
    const orgId = await source.orgId();
    if (!orgId) throw new Error("fortress org id unknown");
    return verifyGrant(token, key, orgId, moduleGrantOptions(bind, orgId));
  };
}

/**
 * The options `verifyGrant` is given for an ask, from what the gate binds.
 *
 * `enrolledAs` is the organization the grant is held to. The gate's `holds` is
 * told that same id, so the list of other organizations is checked against the
 * id the grant was checked against, and not against a second reading of it.
 */
export function moduleGrantOptions(
  bind: ModuleGrantBind,
  enrolledAs: string,
): {
  purpose: "module";
  sub: string;
  scopeHash: string | (() => string);
  holds: (org: string) => Promise<boolean>;
} {
  return {
    purpose: "module",
    sub: bind.sub,
    scopeHash: bind.scopeHash,
    holds: (org) => bind.holds(org, enrolledAs),
  };
}

/**
 * The control plane's own origin: the host and port of the enrolled cloud URL,
 * over https. Null when there is no readable config, in which case no release
 * can be fetched from the control plane at all.
 */
export async function controlPlaneOrigin(paths: FortressPaths): Promise<string | null> {
  try {
    const config = await new FileConfigStore(paths).load();
    // An HX Fortress with no control plane has no origin to fetch a release from.
    return config.cloud ? controlPlaneOriginOf(config.cloud.url) : null;
  } catch {
    return null;
  }
}

/** How often this host looks for a changed switch or a waiting request without
 *  being signalled. Each look reads config.json and lists one directory, and
 *  looks for the list of other organizations. */
const REQUEST_LOOK_MS = 15_000;
/** How long the daemon's stop waits for a look at the module switch that is
 *  under way, before it goes on to stop the modules. */
const BEGIN_STOP_WAIT_MS = 5_000;

export class ModuleHost {
  readonly audit: ModuleAudit;
  readonly gate: AskGate;
  /** Every act of a person at the console passes through here. */
  readonly acts: ActGate;
  /** The listener on this machine that the console hands an act to. */
  readonly door: LocalDoor;
  readonly shelf: ReleaseShelf;
  /** The organizations this HX Fortress holds: its own, and any on its list. */
  readonly organizations: Organizations;
  private readonly deps: ModuleHostDeps;
  private readonly catalog: readonly CatalogEntry[];
  private readonly log: ScopedLogger;
  private readonly contexts = new Map<string, ModuleContextV2>();
  /** The modules of this build that can be switched on, by id. */
  private readonly provided = new Map<string, FortressModule>();
  private readonly secrets: DeferredSecrets;
  /** What a person added to a module: its hosts, and its secret names. */
  private readonly lists = new ModuleLists();
  /** The processes this host runs for modules. */
  readonly processes: ModuleProcesses;
  /** The helper programs this host runs for modules. */
  readonly programs: ModulePrograms;
  /** The daemon's own environment: where a program's path is set. */
  private readonly env: Record<string, string | undefined>;
  /** The switch as this host last acted on it. Null until `start`. */
  private followed: ReadonlySet<string> | null = null;
  /** The switch as it stood when this host started. */
  private atStart: ReadonlySet<string> = new Set();
  /** True while config.json cannot be read, so that is logged once. */
  private switchUnreadable = false;
  /** True while a place that names a secret of this HX Fortress's own cannot
   *  be read, so that is logged once. */
  private reservedUnreadable = false;
  private following: Promise<void> | null = null;
  private applying: Promise<void> | null = null;
  /** A request arrived while one pass was running: run one more. */
  private applyAgain = false;
  /** True from the first step of the daemon's stop until the next start: no
   *  module is started, and one that finishes starting is stopped again. */
  private stopping = false;
  /** True once the runtime has started the modules. Until then this host only
   *  answers: it starts nothing, stops nothing and carries out no request. */
  private ready = false;
  private requestTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: ModuleHostDeps) {
    this.deps = deps;
    this.catalog = deps.catalog ?? MODULE_CATALOG;
    this.log = deps.bus.scopeFor("modules");
    this.secrets = new DeferredSecrets(deps.secrets);
    this.organizations = new Organizations({
      paths: deps.paths,
      enrolledAs: deps.enrolledAs,
      logger: this.log,
    });
    const env = deps.env ?? process.env;
    this.env = env;
    this.programs = new ModulePrograms({
      // As for a process: a program is run only for a module that is running.
      running: (moduleId) => deps.registry.isRunning(moduleId),
      logger: this.log,
      ...(deps.spawnProgram ? { spawn: deps.spawnProgram } : {}),
      ...(deps.programStopGraceMs === undefined ? {} : { stopGraceMs: deps.programStopGraceMs }),
      ...(deps.programEndWaitMs === undefined ? {} : { endWaitMs: deps.programEndWaitMs }),
    });
    this.processes = new ModuleProcesses({
      self: deps.self ?? (() => selfCommand()),
      // A process is started only for a module that is running. A module that
      // is switched off has stopped before its processes are ended, so from
      // its stop on nothing is started for it: not by a context it kept, and
      // not by a start that was on its way.
      running: (moduleId) => deps.registry.isRunning(moduleId),
      logger: this.log,
      ...(deps.spawnProcess ? { spawn: deps.spawnProcess } : {}),
      ...(deps.processEndWaitMs === undefined ? {} : { endWaitMs: deps.processEndWaitMs }),
    });
    this.audit = new ModuleAudit({
      dir: deps.paths.auditSpool,
      ...(deps.clock ? { clock: deps.clock } : {}),
      onError: (error) =>
        this.log.warn("an audit record could not be spooled", {
          error: error instanceof Error ? error.name : typeof error,
        }),
    });
    const { own } = this.organizations;
    const modules = {
      known: (moduleId: string): boolean => this.known(moduleId),
      knownAsk: (moduleId: string, ask: string): boolean =>
        catalogEntry(moduleId, this.catalog)?.manifest?.asks.some((spec) => spec.name === ask) ??
        false,
      takesReleases: (moduleId: string): boolean =>
        typeof this.provided.get(moduleId)?.applyRelease === "function",
      get: (moduleId: string): Module | undefined => deps.registry.get(moduleId),
      isRunning: (moduleId: string): boolean => deps.registry.isRunning(moduleId),
    };
    this.gate = new AskGate({
      modules: {
        ...modules,
        isOn: (moduleId: string, organization: Organization): Promise<boolean> =>
          this.isOn(moduleId, organization),
        contextFor: (module: FortressModule, organization: Organization): ModuleContextV2 =>
          this.contextFor(module, organization),
        own,
        held: (org: string, enrolledAs: string): Promise<Organization | null> =>
          this.organizations.held(org, enrolledAs),
      },
      verifyGrant: deps.verifyGrant,
      audit: this.audit,
      logger: this.log,
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.askDeadlineMs !== undefined ? { deadlineMs: deps.askDeadlineMs } : {}),
      ...askLimits(env),
    });
    this.acts = new ActGate({
      modules: {
        known: modules.known,
        knownAct: (moduleId: string, act: string): boolean =>
          catalogEntry(moduleId, this.catalog)?.manifest?.acts?.some((spec) => spec.name === act) ??
          false,
        // An act is for this HX Fortress's own organization.
        isOn: (moduleId: string): Promise<boolean> => this.isOn(moduleId, own),
        get: modules.get,
        isRunning: modules.isRunning,
        contextFor: (
          module: FortressModule,
          acting: Acting,
          mayChange: () => boolean,
          running: () => boolean,
        ): ModuleActContext => this.actContextFor(module, acting, mayChange, running),
      },
      audit: this.audit,
      logger: this.log,
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.actDeadlineMs !== undefined ? { deadlineMs: deps.actDeadlineMs } : {}),
    });
    this.door = new LocalDoor({
      file: deps.paths.localDoor,
      act: (request: unknown) => this.acts.handle(request),
      // Nobody is named: a call that was turned away has shown nothing that
      // says who made it.
      refused: (rule) => void this.audit.refused(AUDIT_ACTIONS.localDoorRefused, { rule }, null),
      logger: this.log,
      ...(deps.clock ? { clock: deps.clock } : {}),
    });
    this.shelf = new ReleaseShelf({
      paths: deps.paths,
      audit: this.audit,
      logger: this.log,
      // A release is for the whole HX Fortress, so the shelf asks about
      // HX Fortress's own organization and hands a module that one's context.
      modules: {
        ...modules,
        isOn: (moduleId: string): Promise<boolean> => this.isOn(moduleId, own),
        contextFor: (module: FortressModule): ModuleContextV2 => this.contextFor(module, own),
      },
      controlPlaneOrigin: () => controlPlaneOrigin(deps.paths),
      env,
      ...(deps.trustedKeys ? { trustedKeys: deps.trustedKeys } : {}),
      ...(deps.releaseFetchImpl ? { fetchImpl: deps.releaseFetchImpl } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.applyDeadlineMs !== undefined ? { applyDeadlineMs: deps.applyDeadlineMs } : {}),
    });
    // A module with a manifest is initialized with the context of
    // HX Fortress's own organization, the one an ask for that organization is
    // later given, and with the way to the others'. Every other module gets
    // what it always got.
    deps.registry.setContextFactory((module: Module, base: ModuleContext): ModuleContext =>
      isFortressModule(module) ? this.startContextFor(module) : base,
    );
  }

  // ── The modules of this build ──────────────────────────────────────────────

  /**
   * Make a module that ships in this build available to be switched on.
   *
   * AVAILABLE IS NOT REGISTERED. A module enters the registry — and so the
   * daemon's published status, and everything that reads it — only while it is
   * switched on. An HX Fortress that has switched nothing on publishes exactly the
   * modules it published before this build.
   *
   * Refused unless the catalog lists the module with the same manifest it
   * carries, and unless that manifest is one the host can enforce. A module the
   * terminal describes one way and the daemon runs another way is the drift
   * this check stops at boot.
   */
  provide(module: FortressModule): void {
    const entry = catalogEntry(module.id, this.catalog);
    if (!entry) throw new Error(`module ${module.id} is not in this build's catalog`);
    const defect = manifestDefect(module.manifest);
    if (defect) throw new Error(`module ${module.id} cannot be provided: ${defect}`);
    if (module.manifest.id !== module.id) {
      throw new Error(`module ${module.id} carries a manifest for ${module.manifest.id}`);
    }
    if (!entry.manifest || JSON.stringify(entry.manifest) !== JSON.stringify(module.manifest)) {
      throw new Error(`module ${module.id} does not carry the manifest the catalog lists for it`);
    }
    if (this.provided.has(module.id)) throw new Error(`module ${module.id} was provided twice`);
    this.provided.set(module.id, module);
  }

  /** Put a provided module into the registry, replacing the "not registered"
   *  placeholder the runtime leaves for an id it was asked to start and did not
   *  have. No-op for a module that is already there. */
  private ensureRegistered(moduleId: string): void {
    const module = this.provided.get(moduleId);
    if (!module || this.deps.registry.has(moduleId)) return;
    this.deps.registry.unregister(moduleId);
    this.deps.registry.register(module);
  }

  private known(moduleId: string): boolean {
    return this.catalog.some((entry) => entry.id === moduleId);
  }

  /**
   * A module's context for one organization.
   *
   * The own organization's context is built once for each module: it is the one
   * a module is started with and keeps. Another organization's is built each
   * time it is asked for. It holds nothing but the organization and the
   * module's manifest, and an HX Fortress may hold many organizations.
   */
  private contextFor(module: FortressModule, organization: Organization): ModuleContextV2 {
    const id = module.manifest.id;
    const build = (): ModuleContextV2 =>
      createModuleContext(
        module.manifest,
        {
          logger: (moduleId) => this.deps.bus.scopeFor(moduleId),
          identity: () => this.deps.registry.fortressIdentity(),
          secrets: this.secrets,
          audit: this.audit,
          organizations: this.organizations,
          lists: this.lists,
          reservedSecretNames: () => this.reservedSecretNames(),
          processes: this.processes,
          programs: this.programs,
          programEnv: () => this.env,
          ...(this.deps.reachLookup ? { reachLookup: this.deps.reachLookup } : {}),
          ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        },
        organization,
      );
    if (!organization.own) return build();
    let context = this.contexts.get(id);
    if (!context) {
      context = build();
      this.contexts.set(id, context);
    }
    return context;
  }

  /**
   * The context of one act of one person: the own organization's context, and
   * the two lists a person adds to. Built for each act, because who is acting
   * is part of it.
   */
  private actContextFor(
    module: FortressModule,
    acting: Acting,
    mayChange: () => boolean,
    running: () => boolean,
  ): ModuleActContext {
    const { own } = this.organizations;
    const moduleId = module.manifest.id;
    return createModuleActContext(
      this.contextFor(module, own),
      {
        moduleId,
        lists: this.lists,
        listsDir: this.organizations.listsDir(own, moduleId),
        audit: this.audit.for(own),
        reservedSecretNames: () => this.reservedSecretNames(),
        ...(this.deps.clock ? { clock: this.deps.clock } : {}),
      },
      acting,
      mayChange,
      running,
    );
  }

  /**
   * The names of secrets a person cannot hand to a module: every name a
   * manifest of this build lists, every name this HX Fortress's own settings
   * read, and every name the list of organizations keeps another
   * organization's secret under. Rejects when the settings or that list
   * cannot be read: which names are taken is then not known.
   *
   * Without this rule a person who may add a connection could name the secret
   * that holds this HX Fortress's own database password, or another
   * organization's login, and have it presented as a login to a server of
   * their choosing.
   */
  private async reservedSecretNames(): Promise<ReadonlySet<string>> {
    const names = new Set<string>();
    for (const entry of this.catalog) {
      for (const name of entry.manifest?.secrets ?? []) names.add(name);
    }
    try {
      for (const name of (await this.deps.reservedSecretNames?.()) ?? []) names.add(name);
      for (const name of await this.organizations.storedKeyNames()) names.add(name);
    } catch (error) {
      // Said once, when it starts: a person who is refused is told one word,
      // and this line is where the reason is.
      if (!this.reservedUnreadable) {
        this.reservedUnreadable = true;
        this.log.error(
          "a place that names a secret of this HX Fortress's own cannot be read, so which names are " +
            "taken is not known. Until it can be read, no name that a person added is read for a module, " +
            "and none is added",
          {
            place:
              error instanceof SettingUnreadable
                ? error.place
                : error instanceof OrganizationsUnusable
                  ? "organizations.json"
                  : "unknown",
          },
        );
      }
      throw error;
    }
    this.reservedUnreadable = false;
    return names;
  }

  /**
   * Open the door on this machine while a module that is switched on lists
   * acts, and close it otherwise.
   *
   * So an HX Fortress with no such module listens nowhere new and writes no
   * new file. `enabled` is the switch as the pass that calls this has just
   * read it. A switch that could not be read (null) changes nothing here: the
   * door stays as it is, and the act gate refuses every act until the switch
   * can be read.
   */
  private async syncDoor(enabled: ReadonlySet<string> | null): Promise<void> {
    if (enabled === null) return;
    // The daemon may have begun to stop while the modules were being
    // switched. Its stop has closed the door by now, and the door stays
    // closed: opening it here would leave it open on a daemon that is
    // stopping, and its listener would keep the process from ending. Nothing
    // is awaited between this look and the open below.
    if (!this.ready) return;
    const wanted = [...this.provided.values()].some(
      (module) => enabled.has(module.id) && (module.manifest.acts?.length ?? 0) > 0,
    );
    if (!wanted) {
      // A call the door holds gets its answer. One of them may be the act
      // that noticed the switch: it is answered `module_off`, and is not cut.
      // A file that an earlier close could not remove is tried again here.
      if (this.door.isOpen || this.door.fileLeftBehind) await this.door.close("let_end");
      return;
    }
    // On a door that is open this looks at its file, and writes it again when
    // it is gone.
    await this.door.open().catch((error: unknown) =>
      this.log.error(
        "the door on this machine could not be opened, so no act of a person reaches a module. " +
          "It is tried again within seconds.",
        { error: error instanceof Error ? error.name : typeof error },
      ),
    );
  }

  /** What a module is started with: the own organization's context, and the way
   *  to the contexts of the other organizations it is on for. */
  private startContextFor(module: FortressModule): ModuleStartContext {
    return createModuleStartContext(this.contextFor(module, this.organizations.own), () =>
      this.contextsFor(module),
    );
  }

  /** The context of every organization a module is on for, HX Fortress's own
   *  first. Empty while the module is switched off for HX Fortress. One look
   *  at the list, however many organizations are on it. */
  private async contextsFor(module: FortressModule): Promise<ModuleContextV2[]> {
    const id = module.manifest.id;
    if (!(await this.enabledNow())?.has(id)) return [];
    return (await this.organizations.all())
      .filter((organization) => this.onFor(id, organization))
      .map((organization) => this.contextFor(module, organization));
  }

  /**
   * Whether a module that is on for HX Fortress is on for an organization.
   *
   * The one place this rule is written. For HX Fortress's own organization
   * HX Fortress's switch is the only one. For another, its entry in the list has
   * to name the module, whatever kind of module it is.
   */
  private onFor(moduleId: string, organization: Organization): boolean {
    return this.organizations.listsModule(organization, moduleId);
  }

  // ── The switch ─────────────────────────────────────────────────────────────

  /** The ids switched on, read from config.json now. Never remembered: the
   *  file is small, and a switch that was read a moment ago is not the switch.
   *  Null when the file cannot be read. */
  private async enabledNow(): Promise<ReadonlySet<string> | null> {
    const enabled = await readEnabledModules(this.deps.paths);
    if (enabled === null) {
      // Said once, when it starts, and not on every ask while it lasts.
      if (!this.switchUnreadable) {
        this.switchUnreadable = true;
        this.log.error(
          "config.json cannot be read, so the module switches cannot be read. Every ask is " +
            "refused until it can. No running module is stopped.",
        );
      }
      return null;
    }
    this.switchUnreadable = false;
    return new Set(enabled);
  }

  /** Whether a module is switched on, as of this call. Notices a changed switch
   *  on its own: the terminal signals the daemon, and a signal that never
   *  arrived must not leave a module answering after it was switched off.
   *
   *  A switch that cannot be read is not on: the ask or the offer is refused.
   *
   *  For another organization than HX Fortress's own, the module has to be on
   *  for HX Fortress AND on that organization's own list (`onFor`). */
  async isOn(moduleId: string, organization: Organization): Promise<boolean> {
    const enabled = await this.enabledNow();
    if (enabled === null) return false;
    if (this.ready && this.followed !== null && !sameSet(enabled, this.followed)) {
      // Starting or stopping a module can fail. That is logged, and it is not a
      // reason for the ask that happened to notice the change to go unanswered.
      await this.follow().catch((error: unknown) =>
        this.log.error("could not follow the module switch", {
          error: error instanceof Error ? error.name : typeof error,
        }),
      );
    }
    return enabled.has(moduleId) && this.onFor(moduleId, organization);
  }

  /**
   * Start what was switched on and stop what was switched off, since the last
   * time this host looked.
   *
   * Only the DIFFERENCE is acted on. A module that was already on and failed to
   * start at boot is not started again here: nobody changed its switch, and a
   * second start on no one's word is not this function's to make.
   *
   * Two things are never acted on. A switch that cannot be read: a config.json
   * with a typo in it is not somebody switching every module off, so nothing is
   * stopped and the last switch that could be read stands. And a module whose
   * switch the daemon reads only when it starts (`startOnly` in the catalog).
   */
  follow(): Promise<void> {
    this.following ??= this.followOnce().finally(() => {
      this.following = null;
    });
    return this.following;
  }

  private async followOnce(): Promise<void> {
    const enabled = await this.followSwitch();
    // After the modules, so the door opens once a module that takes acts has
    // started, and closes once the last one has stopped.
    await this.syncDoor(enabled);
  }

  /** Start and stop what the switch says, and answer the switch as it was
   *  read: null when it could not be read. */
  private async followSwitch(): Promise<ReadonlySet<string> | null> {
    const enabled = await this.enabledNow();
    if (enabled === null) return null;
    const before = this.followed ?? enabled;
    this.followed = enabled;
    for (const entry of this.catalog) {
      if (entry.startOnly) continue;
      const { id } = entry;
      const turnedOn = enabled.has(id) && !before.has(id);
      const turnedOff = !enabled.has(id) && before.has(id);
      if (turnedOn) {
        // The daemon has begun to stop: nothing is started from here. The
        // switch is as the person set it, and the next start acts on it.
        if (this.stopping) continue;
        this.ensureRegistered(id);
        if (!this.deps.registry.has(id) || this.deps.registry.isRunning(id)) continue;
        const result = await this.deps.registry.startOne(id);
        await this.audit.event(AUDIT_ACTIONS.moduleSwitched, {
          params: { module: id, state: "on" },
          outcome: result.ok ? "done" : "failed",
          error: result.ok ? null : "start_failed",
        });
        this.log.info("module switched on", { module: id, started: result.ok });
        // The stop began while this module was starting. The runtime stops
        // only what was running when it looked, so this one is stopped here:
        // a module left running would keep its timers and sockets, and the
        // process with them.
        if (this.stopping && result.ok) {
          const stopped = await this.deps.registry.stopOne(id);
          this.log.info("a module that finished starting after the stop had begun was stopped again", {
            module: id,
            stopped: stopped.ok,
          });
        }
      } else if (turnedOff && this.deps.registry.has(id)) {
        const wasRunning = this.deps.registry.isRunning(id);
        const result = await this.deps.registry.stopOne(id);
        // After the module's own stop, which closes what it holds in its own
        // order. What it left running is ended here, and from its stop on
        // nothing is started for it. The wait for each end has a limit, so a
        // process that the machine does not let go does not hold up the
        // switch.
        // The same for a program that the module had the host run: it is asked
        // to stop, and killed a few seconds later if it is still there. The
        // two at once, so that the switch waits for the slower of them.
        await Promise.all([this.processes.endAll(id), this.programs.endAll(id)]);
        // A module of this build leaves the registry with its switch, so the
        // daemon's status lists it only while it is on.
        if (this.provided.has(id)) {
          try {
            this.deps.registry.unregister(id);
          } catch {
            // Still stopping. It stays listed, and stays off.
          }
        }
        if (!wasRunning) continue;
        await this.audit.event(AUDIT_ACTIONS.moduleSwitched, {
          params: { module: id, state: "off" },
          outcome: result.ok ? "done" : "failed",
          error: result.ok ? null : "stop_failed",
        });
        this.log.info("module switched off", { module: id, stopped: result.ok });
      }
    }
    return enabled;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Before the runtime starts modules: remember the switch as it is at boot,
   *  settle the shelf, and start the audit writer's timers. */
  async start(): Promise<void> {
    // The daemon has just loaded this file to get this far. If it cannot be
    // read now, nothing of this host's is registered, and the first switch
    // that can be read is followed from there.
    const atBoot = (await this.enabledNow()) ?? new Set<string>();
    this.followed = atBoot;
    this.atStart = atBoot;
    // A run that did not stop cleanly left its door's file. The secret in it
    // opens nothing now, and the file must not say that a door is there. A
    // file that names another process that is running is left: see
    // `LocalDoor.clearStale`.
    await this.door.clearStale();
    // What is on at boot is registered now, so the runtime starts it with the
    // rest. What is off is not registered at all.
    for (const id of this.provided.keys()) {
      if (atBoot.has(id)) this.ensureRegistered(id);
    }
    // Which grants ran an ask in the minutes before this start. The gate's own
    // table was memory and is empty now; the trail kept each one's digest.
    await this.audit
      .recentIntents(AUDIT_ACTIONS.controlPlaneAsk, AskGate.SPENT_LOOKBACK_MS)
      .then((intents) =>
        this.gate.restoreSpent(
          intents.flatMap((intent) => {
            const digest = (intent.params as { grant?: unknown } | null)?.grant;
            return typeof digest === "string" ? [{ digest, usedAt: Date.parse(intent.ts) }] : [];
          }),
        ),
      )
      .catch((error: unknown) =>
        this.log.error(
          "could not read which grants were used before this start. A grant used in the last " +
            "few minutes could be used once more.",
          { error: error instanceof Error ? error.name : typeof error },
        ),
      );
    this.audit.start();
    // Built now so a secrets setting this build cannot read is in the log at
    // boot, not first seen when a module fails. Not fatal: no module may need
    // it, and it is read again the next time one does.
    await this.secrets.store().catch((error: unknown) =>
      this.log.error("the secret store could not be built from this HX Fortress's settings", {
        // Written by the secrets code from fixed words and setting names.
        error: error instanceof Error ? error.message.slice(0, 300) : typeof error,
      }),
    );
    await this.shelf.recover().catch((error: unknown) =>
      this.log.error("the release shelf could not be read at boot", {
        error: error instanceof Error ? error.name : typeof error,
      }),
    );
    await sweepReleaseAnswers(this.deps.paths).catch(() => {});
    // For the console, which may be another process with another environment:
    // the hosts THIS process will fetch a release file from.
    await publishModuleSettings(this.deps.paths, this.deps.env ?? process.env).catch(
      (error: unknown) =>
        this.log.error("could not publish the module settings the console reads", {
          error: error instanceof Error ? error.name : typeof error,
        }),
    );
  }

  /**
   * The runtime has started the modules. From here on this host follows the
   * switch and carries out requests: at once, for anything that changed or was
   * asked for while the daemon was coming up, and then whenever it is signalled.
   *
   * It also looks on its own every few seconds. The signal is how a request is
   * carried out promptly; the look is why one is still carried out when the
   * signal never arrived.
   */
  started(): Promise<void> {
    this.stopping = false;
    this.ready = true;
    if (!this.requestTimer) {
      this.requestTimer = setInterval(() => void this.applyRequests(), REQUEST_LOOK_MS);
      (this.requestTimer as { unref?: () => void }).unref?.();
    }
    return this.applyRequests();
  }

  /** Stop looking for requests and write every open refusal count. Never
   *  rejects, and waits for the end of a module's process no longer than its
   *  limit: it runs first in the daemon's shutdown, and what comes after it
   *  there (the gateway, the workers, the database pools) must still be stopped. */
  async stop(): Promise<void> {
    await this.beginStop();
    // The modules have stopped by now: the runtime stops them between the
    // first step of the stop and this one. What a module left running is
    // ended here, and nothing is started after it.
    // The two at once, so that the daemon's stop waits for the slower of them
    // and not for both in turn. A program that is ended here has the second
    // half of its record on the disk before `endEvery` answers: the launcher
    // waits for what follows each run. The writer's stop then writes what is
    // still counted.
    await Promise.all([this.processes.endEvery(), this.programs.endEvery()]);
    await this.audit.stop().catch(() => {});
  }

  /**
   * The first step of the daemon's stop, before any module is stopped: from
   * here no act of a person is taken, and no module is started.
   *
   * The door is closed and every call it holds is cut. A person whose act was
   * running is told that it was interrupted.
   *
   * A look at the switch that is under way is waited for, for a few seconds
   * at most. A module that it was starting has then started and been stopped
   * again, so the runtime's own stop of the modules finds nothing half
   * started. A start that takes longer is not waited for: the look stops that
   * module when its start ends.
   *
   * Never rejects, and may be called more than once.
   */
  async beginStop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    if (this.requestTimer) clearInterval(this.requestTimer);
    this.requestTimer = null;
    await this.door.close("cut");
    const underWay = this.following;
    if (underWay) {
      await withDeadline(underWay, BEGIN_STOP_WAIT_MS, "a look at the module switch did not end in time", {
        unref: true,
      }).catch(() => {});
    }
  }

  // ── What the control plane may do ──────────────────────────────────────────

  /** Handles `moduleMessage` frames. */
  readonly asks = {
    handle: (data: MsgData): Promise<MsgReply | undefined> => this.gate.handle(data),
  };

  /** Handles `moduleAdvertise` and `moduleRemove` frames. */
  readonly releases = {
    offer: (frame: OfferFrame): Promise<InstallResult | null> => this.shelf.offer(frame),
    /**
     * The control plane asked for a module to be removed. It cannot: a module
     * is part of this build, and whether it is on is decided on this host.
     * Recorded, and answered with a refusal.
     */
    remove: async (moduleId: unknown): Promise<{ moduleId: string; error: string } | null> => {
      const label = typeof moduleId === "string" && this.known(moduleId) ? moduleId : null;
      await this.audit.refused(AUDIT_ACTIONS.controlPlaneModuleRemove, {
        module: label ?? "unknown",
        rule: "not_supported",
      });
      return label ? { moduleId: label, error: "refused:not_supported" } : null;
    },
  };

  /** Called on every authenticated connect: tell the control plane what it
   *  missed. */
  onConnected(): void {
    void this.shelf.reportPending().catch(() => {});
  }

  // ── What this host's operator asked for ────────────────────────────────────

  /**
   * Carry out every pending request from a terminal or the console: follow the
   * switch, then decide each release that has a request waiting.
   */
  applyRequests(): Promise<void> {
    if (this.applying) {
      // A pass already read the switch and the request directory. Whatever
      // prompted this call may have been written after that, so the pass runs
      // once more when it ends.
      this.applyAgain = true;
      return this.applying;
    }
    this.applying = (async (): Promise<void> => {
      do {
        this.applyAgain = false;
        await this.applyOnce();
      } while (this.applyAgain);
    })()
      // Called from a timer and from a signal handler, with nobody waiting.
      .catch((error: unknown) =>
        this.log.error("carrying out a request failed", {
          error: error instanceof Error ? error.name : typeof error,
        }),
      )
      .finally(() => {
        this.applying = null;
      });
    return this.applying;
  }

  private async applyOnce(): Promise<void> {
    // Before the modules have started there is nothing to hand a release to,
    // and starting one early would race the runtime's own start. A request
    // written now waits where it is, and `started` picks it up.
    if (!this.ready) return;
    await this.follow().catch((error: unknown) =>
      this.log.error("could not follow the module switch", {
        error: error instanceof Error ? error.name : typeof error,
      }),
    );
    // The list of other organizations is looked at on every pass too. So one
    // that cannot be used is in the log within a pass of being written, and
    // not only when an ask for another organization arrives. With no list this
    // looks for one file and finds none.
    await this.organizations.look();
    const now = (this.deps.clock ?? ((): Date => new Date()))();
    // Nothing in this loop may reject: it runs from a timer and from a signal
    // handler, where nobody is waiting for it, and a rejection nobody observes
    // ends the process.
    const requests = await takeReleaseDecisions(this.deps.paths).catch(() => []);
    for (const request of requests) {
      const at = now.toISOString();
      if (now.getTime() - Date.parse(request.at) > DECISION_REQUEST_TTL_MS) {
        await answerReleaseDecision(this.deps.paths, {
          requestId: request.requestId,
          ok: false,
          reason: "expired",
          at,
        }).catch(() => {});
        continue;
      }
      try {
        const result = await this.shelf.decide(request);
        const release = result.release;
        await answerReleaseDecision(this.deps.paths, {
          requestId: request.requestId,
          ok: result.ok,
          ...(result.ok ? {} : { reason: result.reason }),
          ...(release
            ? {
                state: release.state,
                moduleId: release.moduleId,
                version: release.version,
                ...(release.error ? { error: release.error } : {}),
              }
            : {}),
          at,
        });
      } catch (error) {
        this.log.error("a release decision could not be carried out", {
          release: request.id,
          error: error instanceof Error ? error.name : typeof error,
        });
        await answerReleaseDecision(this.deps.paths, {
          requestId: request.requestId,
          ok: false,
          reason: "internal",
          at,
        }).catch(() => {});
      }
    }
  }

  // ── What `status` reports ──────────────────────────────────────────────────

  /** The kind of key store this HX Fortress reads its secrets from: the name the
   *  store this process built gives itself. Rejects while the secrets setting
   *  cannot be read: there is then no true answer to give. */
  async secretsKind(): Promise<string> {
    return (await this.secrets.store()).kind;
  }

  /**
   * Every module this build ships, with whether it is on and its version.
   *
   * `on` is what this running HX Fortress does, which is what the control plane is
   * told. For most modules that is the switch as it reads now: this host
   * follows it. For a module whose switch is read only at start, it is what
   * this run began with: a switch changed since then is not in effect, and is
   * not reported as if it were. It shows after the restart that applies it.
   *
   * For another organization than HX Fortress's own, `on` is whether the
   * module is on for THAT organization: on for HX Fortress, and named in that
   * organization's entry (`onFor`). The version is the same for everybody: it
   * is the version of the module that answers that organization's asks.
   */
  async modulesView(
    organization: Organization,
  ): Promise<{ id: string; on: boolean; version: string }[]> {
    const [enabled, releases] = await Promise.all([this.enabledNow(), this.shelf.list().catch(() => [])]);
    const installed = installedVersions(releases);
    return this.catalog.map((entry) => {
      const onForFortress = entry.startOnly
        ? (this.deps.startedWith?.(entry.id) ?? this.atStart.has(entry.id))
        : // A switch that cannot be read is reported as off, as an ask treats it.
          (enabled?.has(entry.id) ?? false);
      return {
        id: entry.id,
        on: onForFortress && this.onFor(entry.id, organization),
        version: installed.get(entry.id) ?? this.deps.version,
      };
    });
  }

  /**
   * The release shelf as one organization may see it, newest offer first.
   *
   * A release of a module is for the whole HX Fortress, and a person of
   * HX Fortress's own organization decides it. So the shelf is the own
   * organization's, and another organization sees none of it.
   */
  releasesFor(organization: Organization): Promise<ReleaseRecord[]> {
    return organization.own ? this.shelf.list() : Promise.resolve([]);
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}
