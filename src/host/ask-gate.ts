// The ask gate: every `moduleMessage` frame from the relay passes through here,
// and nothing reaches a module any other way.
//
// The relay can ask a module a question. Before the module hears it, the gate
// checks, in this order and stopping at the first that fails:
//
//    1. the frame is a request, and its envelope is well formed
//    2. it carries a grant
//    3. the grant's signature verifies against the per-org key this host pinned
//    4. the grant's purpose is `module`                 ┐
//    5. the grant names this organization              │ `verifyGrant`
//    6. the grant's `sub` is this module and this ask   │
//    7. the grant's scope hash is over these arguments  │
//    8. the grant has not expired, and lives a minute   ┘
//    9. the grant has not been used before
//   10. the module is switched on
//   11. the ask is in the module's manifest
//   12. the arguments have the shape the manifest declares
//
// Then the module runs, and one more check stands between its answer and the
// wire:
//
//   13. the reply has the shape the manifest declares — and what is sent is a
//       value REBUILT from that shape, never the object the module returned
//
// Every outcome is written to the audit trail with the rule that decided it.
// The relay is told far less than the trail records: one of eight words. It
// learns that a grant was refused, not why, and it learns nothing about which
// modules exist or are switched on until it has shown a grant that is good for
// the module it is asking about — which is why "is the module on" comes after
// every grant check rather than before.
//
// FAIL CLOSED, everywhere. No pinned key, an unknown organization, a module the
// catalog does not know, an audit record that cannot be written: each one is a
// refusal. There is no flag that turns a check into a warning.

import { AUDIT_ACTIONS } from "../console/audit-actions";
import { GrantRefused, type ModuleGrantClaims } from "../gateway/capability-token";
import type { MsgData, MsgReply } from "../protocol";
import { askScopeHash, askSubject } from "./ask-scope";
import { RELAY_ACTOR, type AuditParams, type ModuleAudit } from "./module-audit";
import { RateWindow } from "./rate-window";
import {
  failureCode,
  failureForLog,
  isAskName,
  isFortressModule,
  isModuleId,
  type AskError,
  type AskSpec,
  type FortressModule,
  type ModuleContextV2,
} from "./module-contract";
import { conform, withinShapeLimits, type ShapeIssue } from "./shape";
import { withDeadline } from "./with-deadline";
import type { Module, ScopedLogger } from "./types";

/** Longest correlation id a frame may carry. It is echoed back on the reply. */
const MESSAGE_ID_MAX_CHARS = 128;

/** How long one ask may run before the relay is answered `failed:timeout`. Under
 *  the 30 seconds the tunnel allows a call, so the answer arrives while the
 *  caller is still listening. */
export const ASK_DEADLINE_MS = 25_000;
/** Asks that may be running at once, across every module. */
export const ASK_MAX_IN_FLIGHT = 16;
/** Asks that may START in any minute, counted exactly (see rate-window.ts).
 *  Every ask that starts is two records in the audit trail, so this is also the
 *  most the relay can make that trail grow: about 430,000 asks a day. */
export const ASK_MAX_PER_MINUTE = 300;
/** The most an operator may raise the two limits above to. A setting past one
 *  of these is held to it, so "at most" has a known ceiling on every host. */
export const ASK_MAX_IN_FLIGHT_CEILING = 256;
export const ASK_MAX_PER_MINUTE_CEILING = 6_000;

/** A limit an operator set: a whole number of one or more, held to `ceiling`.
 *  Anything else is not a limit, and the default applies. */
function limitSetting(raw: string | undefined, fallback: number, ceiling: number): number {
  const text = raw?.trim() ?? "";
  if (!/^[0-9]{1,15}$/.test(text)) return fallback;
  const value = Number(text);
  return value > 0 ? Math.min(value, ceiling) : fallback;
}

/** The two limits this host runs with, from FORTRESS_ASK_MAX_IN_FLIGHT and
 *  FORTRESS_ASK_MAX_PER_MINUTE. */
export function askLimits(env: Record<string, string | undefined>): {
  maxInFlight: number;
  maxPerMinute: number;
} {
  return {
    maxInFlight: limitSetting(
      env.FORTRESS_ASK_MAX_IN_FLIGHT,
      ASK_MAX_IN_FLIGHT,
      ASK_MAX_IN_FLIGHT_CEILING,
    ),
    maxPerMinute: limitSetting(
      env.FORTRESS_ASK_MAX_PER_MINUTE,
      ASK_MAX_PER_MINUTE,
      ASK_MAX_PER_MINUTE_CEILING,
    ),
  };
}

/** Longest grant the gate hands to the verifier. A module grant is a few hundred
 *  characters; anything near this is not one. */
const GRANT_MAX_CHARS = 4096;
/** How long a used grant is remembered past its expiry. The grant's expiry is
 *  judged by a clock read before its signature is checked, and by a library
 *  that rounds to whole seconds; and a host clock can be set back. Forgetting a
 *  grant at the instant it expires would let one that still verifies run again. */
export const SPENT_GRACE_MS = 5 * 60_000;
/** The longest a grant can still verify after the moment it was used: it lives
 *  at most 60 seconds from `iat`, and `iat` may be up to 60 seconds ahead. */
const GRANT_MAX_REMAINING_MS = 120_000;
/** Used grants remembered at once. At the highest limit an operator may set,
 *  6,000 asks a minute for the seven minutes one is kept, that is 42,000. */
const SINGLE_USE_MAX = 64_000;

/**
 * What is remembered of a used grant, and written to the trail beside the ask
 * it ran: a digest of its id, never the id. The digest is this host's own
 * computation, so it is not text the relay chose, and it is what lets a daemon
 * that restarts know which grants were already used (see `restoreSpent`).
 */
export function grantDigest(jti: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(`hx-fortress module grant\n${jti}`)
    .digest("base64url")
    .slice(0, 22);
}

/** What the gate needs to know about the modules on this host. Implemented by
 *  the module host; a seam here so the gate is testable without one. */
export interface ModuleDirectory {
  /** True when this build ships a module with this id. Used ONLY to decide
   *  whether the id may be written to the audit trail by name. */
  known(moduleId: string): boolean;
  /** True when this build's manifest for the module lists the ask. Used ONLY to
   *  decide whether the ask may be written to the audit trail by name. */
  knownAsk(moduleId: string, ask: string): boolean;
  /** True when the operator has switched the module on. Read live: switching a
   *  module off must refuse the very next ask. */
  isOn(moduleId: string): Promise<boolean>;
  /** The registered module, whether or not it is running. */
  get(moduleId: string): Module | undefined;
  isRunning(moduleId: string): boolean;
  contextFor(module: FortressModule): ModuleContextV2;
}

export interface AskGateDeps {
  modules: ModuleDirectory;
  /** `verifyGrant` with purpose `module`, closed over the pinned key and the
   *  enrolled organization. Throws to refuse. */
  verifyGrant: (
    token: string,
    bind: { sub: string; scopeHash: string | (() => string) },
  ) => Promise<ModuleGrantClaims>;
  audit: ModuleAudit;
  logger: ScopedLogger;
  clock?: () => Date;
  deadlineMs?: number;
  maxInFlight?: number;
  maxPerMinute?: number;
}

/** The rule a refusal is recorded under. A fixed vocabulary: it is part of the
 *  key refusals are collapsed on, so it must never carry a value from a frame. */
export type AskRule =
  | "not_a_request"
  | "frame_malformed"
  | "envelope_malformed"
  | "envelope_version"
  | "ask_malformed"
  | "args_not_an_object"
  | "args_too_large"
  | "grant_missing"
  | "grant_too_long"
  | "grant_unverifiable"
  | "grant_signature"
  | "grant_time_claims"
  | `grant_${GrantRefused["rule"]}`
  | "grant_replayed"
  | "module_unknown"
  | "module_off"
  | "module_not_running"
  | "module_takes_no_asks"
  | "ask_not_in_manifest"
  | `args_${ShapeIssue["rule"]}`
  | "busy_in_flight"
  | "busy_rate"
  | "busy_single_use_table";

interface Refusal {
  error: AskError;
  rule: AskRule;
  /** Where in the declared shape, with list positions removed. */
  field?: string;
}

export class AskGate {
  private readonly deps: AskGateDeps;
  private inFlight = 0;
  private readonly started: RateWindow;
  /** Digest of a used grant's id → when it may be forgotten, in milliseconds. */
  private readonly used = new Map<string, number>();
  private usedPrunedAt = 0;

  constructor(deps: AskGateDeps) {
    this.deps = deps;
    this.started = new RateWindow(deps.maxPerMinute ?? ASK_MAX_PER_MINUTE);
  }

  private now(): number {
    return (this.deps.clock ?? ((): Date => new Date()))().getTime();
  }

  private get maxInFlight(): number {
    return this.deps.maxInFlight ?? ASK_MAX_IN_FLIGHT;
  }

  /**
   * One `moduleMessage` frame's data. Returns the reply to send, or undefined
   * when nothing is sent back (an event, or a frame with no usable id).
   */
  async handle(data: MsgData): Promise<MsgReply | undefined> {
    if (typeof data !== "object" || data === null) {
      // A frame with nothing in it: no module named, and no id to answer under.
      await this.recordRefusal(null, null, { error: "ask_unknown", rule: "frame_malformed" });
      return undefined;
    }
    const frame = data as Partial<Record<keyof MsgData, unknown>>;
    const moduleId = isModuleId(frame.module) ? frame.module : null;
    // The name the trail may print: an id this build ships, or nothing.
    const moduleLabel = moduleId && this.deps.modules.known(moduleId) ? moduleId : null;

    if (frame.kind !== "request") {
      // An event has no reply by protocol, and no module here takes events from
      // the relay. Recorded, then dropped.
      await this.recordRefusal(moduleLabel, null, { error: "ask_unknown", rule: "not_a_request" });
      return undefined;
    }
    if (
      typeof frame.id !== "string" ||
      frame.id.length === 0 ||
      frame.id.length > MESSAGE_ID_MAX_CHARS
    ) {
      // No id to answer under. Replying with whatever arrived would echo a
      // string of the relay's choosing, of the relay's chosen size.
      await this.recordRefusal(moduleLabel, null, { error: "ask_unknown", rule: "frame_malformed" });
      return undefined;
    }

    return this.decide(moduleId, moduleLabel, frame.payload);
  }

  private async decide(
    moduleId: string | null,
    moduleLabel: string | null,
    payload: unknown,
  ): Promise<MsgReply> {
    // ── 1. The envelope ──────────────────────────────────────────────────────
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return this.refuse(moduleLabel, null, { error: "ask_unknown", rule: "envelope_malformed" });
    }
    const envelope = payload as Record<string, unknown>;
    if (envelope.v !== 1) {
      return this.refuse(moduleLabel, null, { error: "ask_unknown", rule: "envelope_version" });
    }
    if (moduleId === null) {
      return this.refuse(null, null, { error: "ask_unknown", rule: "frame_malformed" });
    }
    if (!isAskName(envelope.ask)) {
      return this.refuse(moduleLabel, null, { error: "ask_unknown", rule: "ask_malformed" });
    }
    const ask = envelope.ask;
    // The name the trail may print for the ask: one this build's manifest lists.
    const askLabel = moduleLabel && this.deps.modules.knownAsk(moduleLabel, ask) ? ask : null;
    // ── 2. A grant is required. There is no mode in which it is optional. ────
    if (typeof envelope.grant !== "string" || envelope.grant.length === 0) {
      return this.refuse(moduleLabel, askLabel, { error: "grant_missing", rule: "grant_missing" });
    }
    if (envelope.grant.length > GRANT_MAX_CHARS) {
      return this.refuse(moduleLabel, askLabel, { error: "grant_invalid", rule: "grant_too_long" });
    }
    const args = envelope.args;
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      return this.refuse(moduleLabel, askLabel, {
        error: "args_invalid",
        rule: "args_not_an_object",
      });
    }

    // ── 3–8. The grant, bound to exactly this module, ask and arguments ──────
    let claims: ModuleGrantClaims;
    try {
      claims = await this.deps.verifyGrant(envelope.grant, {
        sub: askSubject(moduleId, ask),
        // Hashing the arguments is work that grows with them, and the relay
        // chooses how large they are. So the verifier calls this only once the
        // signature, the purpose, the organization and `sub` have passed: a
        // caller with no valid grant cannot make this host hash anything. And
        // arguments too large to be a value of any shape are refused unhashed.
        scopeHash: () => {
          if (!withinShapeLimits(args)) throw new ArgsRefused("args_too_large");
          try {
            return askScopeHash({ module: moduleId, ask, args: args as Record<string, unknown> });
          } catch {
            // Arguments that are not plain JSON cannot arrive over the tunnel,
            // which parses JSON. Reached only by a caller inside this process.
            throw new ArgsRefused("args_not_an_object");
          }
        },
      });
    } catch (thrown) {
      if (thrown instanceof ArgsRefused) {
        return this.refuse(moduleLabel, askLabel, { error: "args_invalid", rule: thrown.rule });
      }
      return this.refuse(moduleLabel, askLabel, {
        error: "grant_invalid",
        rule: grantRule(thrown),
      });
    }

    // ── 9. Once. A grant that verified is spent, whatever happens next. ──────
    const spent = this.spend(claims);
    if (typeof spent === "string") {
      return this.refuse(
        moduleLabel,
        askLabel,
        spent === "replayed"
          ? { error: "grant_invalid", rule: "grant_replayed" }
          : { error: "busy", rule: "busy_single_use_table" },
      );
    }

    // From here on the caller holds a grant that is good for this module and
    // this ask, so it may be told whether they exist.

    // ── 10. The module is switched on ────────────────────────────────────────
    if (!this.deps.modules.known(moduleId)) {
      return this.refuse(null, null, { error: "module_off", rule: "module_unknown" });
    }
    if (!(await this.deps.modules.isOn(moduleId))) {
      return this.refuse(moduleId, askLabel, { error: "module_off", rule: "module_off" });
    }
    const module = this.deps.modules.get(moduleId);
    if (!module || !this.deps.modules.isRunning(moduleId)) {
      return this.refuse(moduleId, askLabel, {
        error: "failed:module_not_running",
        rule: "module_not_running",
      });
    }
    if (!isFortressModule(module)) {
      // Switched on, running, and not something the relay may ask anything of.
      return this.refuse(moduleId, null, { error: "ask_unknown", rule: "module_takes_no_asks" });
    }

    // ── 11. The ask is in the manifest ───────────────────────────────────────
    const spec = module.manifest.asks.find((candidate) => candidate.name === ask);
    if (!spec) {
      return this.refuse(moduleId, null, { error: "ask_unknown", rule: "ask_not_in_manifest" });
    }

    // ── 12. The arguments have their shape ───────────────────────────────────
    const checked = conform(spec.args, args);
    if (!checked.ok) {
      return this.refuse(moduleId, ask, {
        error: "args_invalid",
        rule: `args_${checked.issue.rule}`,
        field: withoutPositions(checked.issue.path),
      });
    }

    // ── Capacity. After every check, so a caller cannot spend it without a
    //    grant, a module that is on, and an ask that exists. ──────────────────
    if (this.inFlight >= this.maxInFlight) {
      return this.refuse(moduleId, ask, { error: "busy", rule: "busy_in_flight" });
    }
    if (!this.takeToken()) {
      return this.refuse(moduleId, ask, { error: "busy", rule: "busy_rate" });
    }
    // The slot is taken here, in the same step as the two checks above and with
    // nothing awaited in between. Asks that arrive together then each see the
    // ones before them. `run` gives the slot back.
    this.inFlight += 1;

    return this.run(module, spec, checked.value, spent.digest);
  }

  /** Run one admitted ask: the intent on disk, the module, the reply rebuilt.
   *  The caller has taken a slot for it. It is given back when the module's
   *  work settles, or at once when the ask does not reach the module. */
  private async run(
    module: FortressModule,
    spec: AskSpec,
    args: unknown,
    grant: string,
  ): Promise<MsgReply> {
    const moduleId = module.manifest.id;
    const params: AuditParams = { module: moduleId, ask: spec.name, grant };
    let intent;
    try {
      intent = await this.deps.audit.intent(AUDIT_ACTIONS.relayAsk, { actor: RELAY_ACTOR, params });
    } catch (thrown) {
      // An ask that cannot be recorded does not run.
      this.inFlight -= 1;
      this.say("error", "refused an ask: its audit record could not be written", {
        module: moduleId,
        ask: spec.name,
        ...failureForLog(thrown),
      });
      return fail("failed:audit_unavailable");
    }

    let work: Promise<unknown>;
    try {
      work = Promise.resolve(module.onAsk(spec.name, args, this.deps.modules.contextFor(module)));
    } catch (thrown) {
      work = Promise.reject(thrown);
    }
    // The slot is held until the module's own work settles, not until the
    // deadline answers for it: a handler still running is still using it.
    void work.then(
      () => {
        this.inFlight -= 1;
      },
      () => {
        this.inFlight -= 1;
      },
    );

    // The intent is on disk. From here every way out writes its outcome: an
    // intent with nothing after it reads as a daemon that stopped mid-ask.
    let recorded = false;
    const record = (outcome: string, error: string | null = null): Promise<void> => {
      recorded = true;
      return this.deps.audit.outcome(intent, outcome, error);
    };
    try {
      let result: unknown;
      try {
        result = await withDeadline(work, this.deps.deadlineMs ?? ASK_DEADLINE_MS, "deadline", {
          error: () => new AskDeadline("deadline"),
        });
      } catch (thrown) {
        // One word: a fixed one, one of the host's own ports', or one the module
        // chose to name. The thrown MESSAGE does not go to the relay or to the
        // trail, and reaches the log only for the failures this host words itself.
        const timedOut = thrown instanceof AskDeadline;
        const code = timedOut ? "timeout" : failureCode(thrown);
        await record("failed", code);
        if (timedOut) {
          // The relay has its answer; the module is still working. Its slot stays
          // taken until it returns, so a module that never does shows up here
          // first, and as `busy` once every slot is held.
          this.say("warn", "an ask ran past its deadline and is still running", {
            module: moduleId,
            ask: spec.name,
            inFlight: this.inFlight,
            slots: this.maxInFlight,
          });
        } else {
          this.say("error", "a module failed while answering an ask", {
            module: moduleId,
            ask: spec.name,
            ...failureForLog(thrown),
          });
        }
        return fail(`failed:${code}`);
      }

      // ── 13. The reply has its shape, and is rebuilt from it ────────────────
      const reply = conform(spec.reply, result);
      if (!reply.ok) {
        const where = withoutPositions(reply.issue.path);
        await record("refused", `reply_${reply.issue.rule}${where ? ` at ${where}` : ""}`);
        this.say("error", "refused a module's reply: it does not have its declared shape", {
          module: moduleId,
          ask: spec.name,
          rule: reply.issue.rule,
          field: where,
        });
        return fail("reply_invalid");
      }
      await record("ok");
      return { ok: true, payload: reply.value };
    } catch {
      // Nothing in the block above is meant to throw: the module's own failure
      // is caught where it is awaited. This is for what was not foreseen (a log
      // that cannot be written, a thrown value that fails when it is looked
      // at). What was thrown is not looked at again and goes nowhere.
      if (!recorded) await record("failed", "internal");
      return fail("failed:internal");
    }
  }

  // ── Bookkeeping ────────────────────────────────────────────────────────────

  /** Write to the log, and carry on if it cannot be written. An ask's answer
   *  and its audit record do not depend on the log. */
  private say(level: "warn" | "error", message: string, fields: Record<string, unknown>): void {
    try {
      // `level` is one of two method names, both written in this file.
      // eslint-disable-next-line security/detect-object-injection
      this.deps.logger[level](message, fields);
    } catch {
      // A log that is full or gone. The trail has the outcome.
    }
  }

  private async refuse(
    moduleLabel: string | null,
    ask: string | null,
    refusal: Refusal,
  ): Promise<MsgReply> {
    await this.recordRefusal(moduleLabel, ask, refusal);
    return fail(refusal.error);
  }

  private async recordRefusal(
    moduleLabel: string | null,
    ask: string | null,
    refusal: Refusal,
  ): Promise<void> {
    // `module` and `ask` are written by name only once this build knows them.
    // Before that they are a string the relay sent, and a trail that copied it
    // would be a place the relay can write to.
    const params: AuditParams = {
      module: moduleLabel ?? "unknown",
      ask: ask ?? "unknown",
      rule: refusal.rule,
      ...(refusal.field ? { field: refusal.field } : {}),
    };
    await this.deps.audit.refused(AUDIT_ACTIONS.relayAsk, params);
  }

  /** Mark a verified grant used. A second sight of the same id is a replay. */
  private spend(claims: ModuleGrantClaims): { digest: string } | "replayed" | "full" {
    const now = this.now();
    // Once a second, and at once when the clock has gone back: a clock that was
    // set back must not stop the pruning until it catches up again.
    if (now - this.usedPrunedAt >= 1_000 || now < this.usedPrunedAt) {
      this.usedPrunedAt = now;
      for (const [digest, forgetAt] of this.used) {
        if (forgetAt <= now) this.used.delete(digest);
      }
    }
    const digest = grantDigest(claims.jti);
    if (this.used.has(digest)) return "replayed";
    if (this.used.size >= SINGLE_USE_MAX) return "full";
    this.used.set(digest, claims.exp * 1000 + SPENT_GRACE_MS);
    return { digest };
  }

  /**
   * Remember grants that ran an ask before this process started.
   *
   * The table above is memory, and a restart empties it. The trail is not: each
   * ask that ran left an intent record with its grant's digest. Called once at
   * start with those records from the last few minutes, so a frame that is sent
   * again after a restart is still a replay.
   *
   * A grant that was refused after it verified (the module was off, the host
   * was busy) left no such record. Sent again after a restart it may run: once,
   * and it is an ask let.ai authorized that never ran.
   */
  restoreSpent(records: readonly { digest: string; usedAt: number }[]): void {
    const now = this.now();
    for (const { digest, usedAt } of records) {
      const forgetAt = usedAt + GRANT_MAX_REMAINING_MS + SPENT_GRACE_MS;
      if (forgetAt <= now || this.used.size >= SINGLE_USE_MAX) continue;
      this.used.set(digest, Math.max(forgetAt, this.used.get(digest) ?? 0));
    }
  }

  /** How far back `restoreSpent` needs records from. */
  static readonly SPENT_LOOKBACK_MS = GRANT_MAX_REMAINING_MS + SPENT_GRACE_MS;

  private takeToken(): boolean {
    return this.started.take(this.now());
  }
}

function fail(error: AskError): MsgReply {
  return { ok: false, error };
}

/** `lines[3].actor` → `lines[].actor`. A position is a number the caller picks;
 *  left in, it would make every position its own refusal window. */
function withoutPositions(path: string): string {
  return path.replace(/\[\d+\]/g, "[]");
}

/** Which rule refused the grant. A `GrantRefused` names its own; anything the
 *  JOSE library threw is a bad signature, a bad encoding or a bad time claim,
 *  told apart by its stable `code` — never by a class name, which a minified
 *  build rewrites. */
function grantRule(thrown: unknown): AskRule {
  if (thrown instanceof GrantRefused) return `grant_${thrown.rule}`;
  const code = (thrown as { code?: unknown } | null)?.code;
  if (code === "ERR_JWT_EXPIRED") return "grant_expired";
  if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") return "grant_time_claims";
  if (typeof code === "string" && code.startsWith("ERR_J")) return "grant_signature";
  // No pinned key, no enrolled organization, a key that will not import.
  return "grant_unverifiable";
}

class AskDeadline extends Error {}

/** Arguments the gate refuses before the grant's scope is compared. */
class ArgsRefused extends Error {
  constructor(readonly rule: "args_too_large" | "args_not_an_object") {
    super(rule);
  }
}

