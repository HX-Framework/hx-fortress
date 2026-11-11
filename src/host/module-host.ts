// The module host: the one object in the daemon that owns everything the relay
// can do to a module.
//
// It gives the cloud connection two handlers:
//
//   • `asks`     — a `moduleMessage` frame goes to the ask gate
//   • `releases` — a `moduleAdvertise` frame goes to the release shelf, and a
//                  `moduleRemove` frame is refused
//
// and it gives this host's own operator one entry point, which no frame on the
// tunnel can reach:
//
//   • `applyRequests` — carry out what a terminal or the console asked for:
//                       a release decision, or a module's switch having changed
//
// WHAT IS ON is config.json's `modules.enabled`, read live. The runtime starts
// those modules at boot; after that this host follows the file. It never writes
// it: switching a module is a local gesture, made by a verb somebody types.

import { AUDIT_ACTIONS } from "../console/audit-actions";
import { verifyGrant, type ModuleGrantClaims } from "../gateway/capability-token";
import type { MsgData, MsgReply } from "../protocol";
import type { SecretProvider } from "../secrets/types";
import { AskGate, askLimits } from "./ask-gate";
import { FileConfigStore, readEnabledModules } from "./config";
import type { LogBus } from "./logging";
import { ModuleAudit } from "./module-audit";
import { catalogEntry, MODULE_CATALOG, type CatalogEntry } from "./module-catalog";
import { createModuleContext, DeferredSecrets } from "./module-context";
import {
  isFortressModule,
  manifestDefect,
  type FortressModule,
  type ModuleContextV2,
} from "./module-contract";
import type { ModuleRegistry } from "./module-registry";
import { publishModuleSettings } from "./modules-api";
import type { fortressPaths } from "./paths";
import { relayOriginOf } from "./release-fetch";
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

type FortressPaths = ReturnType<typeof fortressPaths>;

export interface ModuleHostDeps {
  paths: FortressPaths;
  registry: ModuleRegistry;
  bus: LogBus;
  /** The Fortress version: what a module with no installed release reports. */
  version: string;
  /** The customer's secret store, built on first use. Rejects while the secrets
   *  setting is one this build cannot read. */
  secrets: () => Promise<SecretProvider>;
  /** `verifyGrant` for purpose `module`, over the pinned key and the enrolled
   *  organization. */
  verifyGrant: (
    token: string,
    bind: { sub: string; scopeHash: string | (() => string) },
  ) => Promise<ModuleGrantClaims>;
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
  askDeadlineMs?: number;
  applyDeadlineMs?: number;
}

/**
 * How the daemon verifies the grant on an ask.
 *
 * The same two facts every other grant on this host is checked against: the
 * per-org key the hub pushed and this fortress PINNED, and the organization it
 * enrolled into. And a purpose no other surface accepts.
 *
 * Throws before a key is pinned or the organization is known. The gate reads
 * any throw as a refusal, so a fortress that cannot verify refuses every ask.
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
    return verifyGrant(token, key, orgId, { purpose: "module", ...bind });
  };
}

/**
 * The relay's own origin: where the self-update already downloads from, derived
 * the same way from the enrolled cloud URL. Null when there is no readable
 * config, in which case no release can be fetched from the relay at all.
 */
export async function relayOrigin(paths: FortressPaths): Promise<string | null> {
  try {
    const config = await new FileConfigStore(paths).load();
    return relayOriginOf(config.cloud.url);
  } catch {
    return null;
  }
}

/** How often this host looks for a changed switch or a waiting request without
 *  being signalled. Each look reads config.json and lists one directory. */
const REQUEST_LOOK_MS = 15_000;

export class ModuleHost {
  readonly audit: ModuleAudit;
  readonly gate: AskGate;
  readonly shelf: ReleaseShelf;
  private readonly deps: ModuleHostDeps;
  private readonly catalog: readonly CatalogEntry[];
  private readonly log: ScopedLogger;
  private readonly contexts = new Map<string, ModuleContextV2>();
  /** The modules of this build that can be switched on, by id. */
  private readonly provided = new Map<string, FortressModule>();
  private readonly secrets: DeferredSecrets;
  /** The switch as this host last acted on it. Null until `start`. */
  private followed: ReadonlySet<string> | null = null;
  /** The switch as it stood when this host started. */
  private atStart: ReadonlySet<string> = new Set();
  /** True while config.json cannot be read, so that is logged once. */
  private switchUnreadable = false;
  private following: Promise<void> | null = null;
  private applying: Promise<void> | null = null;
  /** A request arrived while one pass was running: run one more. */
  private applyAgain = false;
  /** True once the runtime has started the modules. Until then this host only
   *  answers: it starts nothing, stops nothing and carries out no request. */
  private ready = false;
  private requestTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: ModuleHostDeps) {
    this.deps = deps;
    this.catalog = deps.catalog ?? MODULE_CATALOG;
    this.log = deps.bus.scopeFor("modules");
    this.secrets = new DeferredSecrets(deps.secrets);
    const env = deps.env ?? process.env;
    this.audit = new ModuleAudit({
      dir: deps.paths.auditSpool,
      ...(deps.clock ? { clock: deps.clock } : {}),
      onError: (error) =>
        this.log.warn("an audit record could not be spooled", {
          error: error instanceof Error ? error.name : typeof error,
        }),
    });
    const directory = {
      known: (moduleId: string): boolean => this.known(moduleId),
      knownAsk: (moduleId: string, ask: string): boolean =>
        catalogEntry(moduleId, this.catalog)?.manifest?.asks.some((spec) => spec.name === ask) ??
        false,
      takesReleases: (moduleId: string): boolean =>
        typeof this.provided.get(moduleId)?.applyRelease === "function",
      isOn: (moduleId: string): Promise<boolean> => this.isOn(moduleId),
      get: (moduleId: string): Module | undefined => deps.registry.get(moduleId),
      isRunning: (moduleId: string): boolean => deps.registry.isRunning(moduleId),
      contextFor: (module: FortressModule): ModuleContextV2 => this.contextFor(module),
    };
    this.gate = new AskGate({
      modules: directory,
      verifyGrant: deps.verifyGrant,
      audit: this.audit,
      logger: this.log,
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.askDeadlineMs !== undefined ? { deadlineMs: deps.askDeadlineMs } : {}),
      ...askLimits(env),
    });
    this.shelf = new ReleaseShelf({
      paths: deps.paths,
      audit: this.audit,
      logger: this.log,
      modules: directory,
      relayOrigin: () => relayOrigin(deps.paths),
      env,
      ...(deps.trustedKeys ? { trustedKeys: deps.trustedKeys } : {}),
      ...(deps.releaseFetchImpl ? { fetchImpl: deps.releaseFetchImpl } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.applyDeadlineMs !== undefined ? { applyDeadlineMs: deps.applyDeadlineMs } : {}),
    });
    // A module with a manifest is initialized with the same context it is later
    // asked with. Every other module gets what it always got.
    deps.registry.setContextFactory((module: Module, base: ModuleContext): ModuleContext =>
      isFortressModule(module) ? this.contextFor(module) : base,
    );
  }

  // ── The modules of this build ──────────────────────────────────────────────

  /**
   * Make a module that ships in this build available to be switched on.
   *
   * AVAILABLE IS NOT REGISTERED. A module enters the registry — and so the
   * daemon's published status, and everything that reads it — only while it is
   * switched on. A fortress that has switched nothing on publishes exactly the
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

  private contextFor(module: FortressModule): ModuleContextV2 {
    const id = module.manifest.id;
    let context = this.contexts.get(id);
    if (!context) {
      context = createModuleContext(module.manifest, {
        paths: this.deps.paths,
        logger: (moduleId) => this.deps.bus.scopeFor(moduleId),
        identity: () => this.deps.registry.fortressIdentity(),
        secrets: this.secrets,
        audit: this.audit,
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      });
      this.contexts.set(id, context);
    }
    return context;
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
   *  A switch that cannot be read is not on: the ask or the offer is refused. */
  async isOn(moduleId: string): Promise<boolean> {
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
    return enabled.has(moduleId);
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
    const enabled = await this.enabledNow();
    if (enabled === null) return;
    const before = this.followed ?? enabled;
    this.followed = enabled;
    for (const entry of this.catalog) {
      if (entry.startOnly) continue;
      const { id } = entry;
      const turnedOn = enabled.has(id) && !before.has(id);
      const turnedOff = !enabled.has(id) && before.has(id);
      if (turnedOn) {
        this.ensureRegistered(id);
        if (!this.deps.registry.has(id) || this.deps.registry.isRunning(id)) continue;
        const result = await this.deps.registry.startOne(id);
        await this.audit.event(AUDIT_ACTIONS.moduleSwitched, {
          params: { module: id, state: "on" },
          outcome: result.ok ? "done" : "failed",
          error: result.ok ? null : "start_failed",
        });
        this.log.info("module switched on", { module: id, started: result.ok });
      } else if (turnedOff && this.deps.registry.has(id)) {
        const wasRunning = this.deps.registry.isRunning(id);
        const result = await this.deps.registry.stopOne(id);
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
    // What is on at boot is registered now, so the runtime starts it with the
    // rest. What is off is not registered at all.
    for (const id of this.provided.keys()) {
      if (atBoot.has(id)) this.ensureRegistered(id);
    }
    // Which grants ran an ask in the minutes before this start. The gate's own
    // table was memory and is empty now; the trail kept each one's digest.
    await this.audit
      .recentIntents(AUDIT_ACTIONS.relayAsk, AskGate.SPENT_LOOKBACK_MS)
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
      this.log.error("the secret store could not be built from this fortress's settings", {
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
    this.ready = true;
    if (!this.requestTimer) {
      this.requestTimer = setInterval(() => void this.applyRequests(), REQUEST_LOOK_MS);
      (this.requestTimer as { unref?: () => void }).unref?.();
    }
    return this.applyRequests();
  }

  /** Stop looking for requests and write every open refusal count. Never
   *  rejects: it runs first in the daemon's shutdown, and what comes after it
   *  there (the gateway, the workers, the database pools) must still be stopped. */
  async stop(): Promise<void> {
    this.ready = false;
    if (this.requestTimer) clearInterval(this.requestTimer);
    this.requestTimer = null;
    await this.audit.stop().catch(() => {});
  }

  // ── What the relay may do ──────────────────────────────────────────────────

  /** Handles `moduleMessage` frames. */
  readonly asks = {
    handle: (data: MsgData): Promise<MsgReply | undefined> => this.gate.handle(data),
  };

  /** Handles `moduleAdvertise` and `moduleRemove` frames. */
  readonly releases = {
    offer: (frame: OfferFrame): Promise<InstallResult | null> => this.shelf.offer(frame),
    /**
     * The relay asked for a module to be removed. It cannot: a module is part
     * of this build, and whether it is on is decided on this host. Recorded,
     * and answered with a refusal.
     */
    remove: async (moduleId: unknown): Promise<{ moduleId: string; error: string } | null> => {
      const label = typeof moduleId === "string" && this.known(moduleId) ? moduleId : null;
      await this.audit.refused(AUDIT_ACTIONS.relayModuleRemove, {
        module: label ?? "unknown",
        rule: "not_supported",
      });
      return label ? { moduleId: label, error: "refused:not_supported" } : null;
    },
  };

  /** Called on every authenticated connect: tell the relay what it missed. */
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

  /** Where this Fortress reads its secrets from. Rejects while the secrets
   *  setting cannot be read: there is then no true answer to give. */
  async secretsKind(): Promise<SecretProvider["kind"]> {
    return (await this.secrets.store()).kind;
  }

  /**
   * Every module this build ships, with whether it is on and its version.
   *
   * `on` is what this running Fortress does, which is what the relay is told.
   * For most modules that is the switch as it reads now: this host follows it.
   * For a module whose switch is read only at start, it is what this run began
   * with: a switch changed since then is not in effect, and is not reported as
   * if it were. It shows after the restart that applies it.
   */
  async modulesView(): Promise<{ id: string; on: boolean; version: string }[]> {
    const [enabled, releases] = await Promise.all([this.enabledNow(), this.shelf.list().catch(() => [])]);
    const installed = installedVersions(releases);
    return this.catalog.map((entry) => ({
      id: entry.id,
      on: entry.startOnly
        ? (this.deps.startedWith?.(entry.id) ?? this.atStart.has(entry.id))
        : // A switch that cannot be read is reported as off, as an ask treats it.
          (enabled?.has(entry.id) ?? false),
      version: installed.get(entry.id) ?? this.deps.version,
    }));
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}
