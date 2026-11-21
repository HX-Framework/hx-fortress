// The act gate: every act of a person at this HX Fortress's console passes
// through here on its way to a module, and nothing else reaches `onAct`.
//
// An act is what a signed-in person has a module do: add a connection, start a
// test, read a list. It is not an ask. An ask comes from the control plane with
// a grant, and this file has nothing to do with it: no frame on the connection
// leads here.
//
// WHO IS TRUSTED FOR WHAT. The console is a process of its own. It signs a
// person in, and it hands this gate the act with who the person is. This gate
// takes that one thing on the console's word: the login, the email and the
// role. Everything else it checks itself, in this order, stopping at the first
// that fails:
//
//    1. the request is well formed, and so is the person
//    2. the module is one this build ships, and the act's name is a name
//    3. the module is switched on, and running
//    4. the act is in the module's manifest
//    5. the person's role may do it
//    6. the arguments have the shape the manifest declares, and none of them
//       looks like a credential
//    7. there is room for one more act
//
// Then the module runs, and one more check stands between its answer and the
// person:
//
//    8. the reply has the shape the manifest declares, and what is shown is a
//       value REBUILT from that shape, never the object the module returned
//
// WHAT IS RECORDED. An act the manifest gives to operators may change things:
// it is a pair in the audit trail, under the person's login, and its first
// half is on disk before the module is called. An act that cannot be recorded
// does not run. An act that any signed-in person may do is not recorded one
// by one, as the console's own reads are not: its manifest says that it only
// reads, and this gate gives its context no way to change the two lists.
// Every act that this gate turns away is recorded, with the rule that decided
// it; a run of the same refusal is two records.
//
// AN ACT THAT RUNS PAST ITS DEADLINE IS NOT STOPPED. The person is answered
// `failed:timeout` and the pair ends `failed`, while the module's work goes
// on. When that work ends, one more record says how
// (`console.module.act.ended_late`), so the trail does not hold only "failed"
// for an act that then did what was asked.
//
// NO ARGUMENT MAY LOOK LIKE A CREDENTIAL. A secret's value is never an act's
// argument: a module is told the NAME of a secret. And the audit trail and
// the console replace what looks like a credential, also inside a name. So a
// thing saved under such a name would be shown with a part of its name
// replaced, and no later act could name it. Such an argument is refused here,
// for every module at once, before anything is saved under it.
//
// AN ACT IS FOR THIS HX FORTRESS'S OWN ORGANIZATION. Its console signs in that
// organization's people and nobody else's.
//
// FAIL CLOSED, everywhere. A module the catalog does not know, a switch that
// cannot be read, a record that cannot be written: each one is a refusal.

import { AUDIT_ACTIONS, MAX_ACTOR_CHARS } from "../console/audit-actions";
import type { AuditParams, AuditWriter } from "./module-audit";
import type { Acting } from "./module-context";
import {
  ACT_ROLES,
  failureCode,
  failureForLog,
  isAskName,
  isFortressModule,
  isModuleId,
  type ActAnswer,
  type ActError,
  type ActRole,
  type ActSpec,
  type FortressModule,
  type ModuleActContext,
  type Person,
} from "./module-contract";
import { recordable } from "./module-lists";
import { RateWindow } from "./rate-window";
import { conform, isEmail, withinShapeLimits, type ShapeIssue } from "./shape";
import type { Module, ScopedLogger } from "./types";
import { withDeadline } from "./with-deadline";

/** How long one act may run before the person is answered `failed:timeout`.
 *  Under the 30 seconds the console waits for the daemon. */
export const ACT_DEADLINE_MS = 25_000;
/** Acts that may be running at once, across every module. */
export const ACT_MAX_IN_FLIGHT = 16;
/** Acts of operators that may START in any minute. Each is at least two
 *  records in the audit trail. What an act then changes is recorded as well,
 *  one pair for each change, and a refusal is held to the audit writer's own
 *  budget (module-audit.ts). */
export const ACT_MAX_RECORDED_PER_MINUTE = 120;
/** The largest reply an act may show, as JSON. */
export const ACT_REPLY_MAX_BYTES = 256 * 1024;

/** What the gate needs to know about the modules on this host. Implemented by
 *  the module host; a seam here so the gate is testable without one. */
export interface ActDirectory {
  /** True when this build ships a module with this id. */
  known(moduleId: string): boolean;
  /** True when this build's manifest for the module lists the act. Used ONLY
   *  to decide whether the act may be written to the audit trail by name. */
  knownAct(moduleId: string, act: string): boolean;
  /** True when the module is switched on for this HX Fortress's own
   *  organization. Read live. */
  isOn(moduleId: string): Promise<boolean>;
  /** The registered module, whether or not it is running. */
  get(moduleId: string): Module | undefined;
  isRunning(moduleId: string): boolean;
  /** The context of one act of one person. `mayChange` is asked at each
   *  change: it says whether the context's two lists can be added to.
   *  `running` is asked at each record the module writes of the act
   *  (`audit.recordAct`): it says whether the act's work has not ended, and
   *  so whether the record is written under the person's login. */
  contextFor(
    module: FortressModule,
    acting: Acting,
    mayChange: () => boolean,
    running: () => boolean,
  ): ModuleActContext;
}

export interface ActGateDeps {
  modules: ActDirectory;
  /** The writer of this HX Fortress's own organization. */
  audit: AuditWriter;
  logger: ScopedLogger;
  clock?: () => Date;
  deadlineMs?: number;
  maxInFlight?: number;
  maxRecordedPerMinute?: number;
}

/** The rule a refusal is recorded under. A fixed vocabulary: it is part of the
 *  key refusals are collapsed on, so it never carries a value from a request. */
export type ActRule =
  | "request_malformed"
  | "person_malformed"
  | "module_unknown"
  | "act_malformed"
  | "module_off"
  | "module_not_running"
  | "module_takes_no_acts"
  | "act_not_in_manifest"
  | "role"
  | "args_not_an_object"
  | "args_too_large"
  | `args_${ShapeIssue["rule"]}`
  | "args_look_like_a_credential"
  | "busy_in_flight"
  | "busy_rate";

interface Refusal {
  error: ActError;
  rule: ActRule;
  /** Where in the declared shape, with list positions removed. */
  field?: string;
}

/** A person as the console may name one, or null. */
function personOf(value: unknown): Person | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { login, email, role } = value as Record<string, unknown>;
  if (typeof login !== "string" || login.length === 0 || login.length > MAX_ACTOR_CHARS) return null;
  // No control character: a login is written into the audit trail and the log.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(login)) return null;
  // An email as a shape takes one (shape.ts): so the address of a person that
  // a module is handed always fits a field of that kind. The console names an
  // email only for a login that is an address by its own, narrower rule.
  if (email !== null && !isEmail(email)) return null;
  if (!(ACT_ROLES as readonly unknown[]).includes(role)) return null;
  return { login, email, role: role as ActRole };
}

/** The console's own id for a sign-in: 32 hex characters. Null for anything
 *  else, and then the record names no sign-in. */
function sessionOf(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value) ? value : null;
}

export class ActGate {
  private readonly deps: ActGateDeps;
  private inFlight = 0;
  private readonly recorded: RateWindow;

  constructor(deps: ActGateDeps) {
    this.deps = deps;
    this.recorded = new RateWindow(deps.maxRecordedPerMinute ?? ACT_MAX_RECORDED_PER_MINUTE);
  }

  private now(): number {
    return (this.deps.clock ?? ((): Date => new Date()))().getTime();
  }

  private get maxInFlight(): number {
    return this.deps.maxInFlight ?? ACT_MAX_IN_FLIGHT;
  }

  /**
   * One act, as the console handed it over:
   * `{ v: 1, person, session, module, act, args }`. Always answers.
   */
  async handle(request: unknown): Promise<ActAnswer> {
    // ── 1. The request, and the person ───────────────────────────────────────
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      return this.refuse(null, null, null, { error: "failed:request_invalid", rule: "request_malformed" });
    }
    const envelope = request as Record<string, unknown>;
    if (envelope.v !== 1) {
      return this.refuse(null, null, null, { error: "failed:request_invalid", rule: "request_malformed" });
    }
    const person = personOf(envelope.person);
    if (!person) {
      return this.refuse(null, null, null, { error: "failed:request_invalid", rule: "person_malformed" });
    }
    const acting: Acting = { person, session: sessionOf(envelope.session) };

    // ── 2. The module and the act are names this build could know ────────────
    const moduleId = isModuleId(envelope.module) && this.deps.modules.known(envelope.module) ? envelope.module : null;
    if (moduleId === null) {
      return this.refuse(person, null, null, { error: "act_unknown", rule: "module_unknown" });
    }
    if (!isAskName(envelope.act)) {
      return this.refuse(person, moduleId, null, { error: "act_unknown", rule: "act_malformed" });
    }
    const act = envelope.act;
    // The name the trail may print for the act: one this build's manifest lists.
    const actLabel = this.deps.modules.knownAct(moduleId, act) ? act : null;

    // ── 3. The module is switched on, and running ────────────────────────────
    if (!(await this.deps.modules.isOn(moduleId))) {
      return this.refuse(person, moduleId, actLabel, { error: "module_off", rule: "module_off" });
    }
    const module = this.deps.modules.get(moduleId);
    if (!module || !this.deps.modules.isRunning(moduleId)) {
      return this.refuse(person, moduleId, actLabel, {
        error: "failed:module_not_running",
        rule: "module_not_running",
      });
    }
    if (!isFortressModule(module) || typeof module.onAct !== "function") {
      return this.refuse(person, moduleId, null, { error: "act_unknown", rule: "module_takes_no_acts" });
    }

    // ── 4. The act is in the manifest ────────────────────────────────────────
    const spec = module.manifest.acts?.find((candidate) => candidate.name === act);
    if (!spec) {
      return this.refuse(person, moduleId, null, { error: "act_unknown", rule: "act_not_in_manifest" });
    }

    // ── 5. The person's role may do it ───────────────────────────────────────
    if (spec.role === "operator" && person.role !== "operator") {
      return this.refuse(person, moduleId, act, { error: "not_allowed", rule: "role" });
    }

    // ── 6. The arguments have their shape ────────────────────────────────────
    const args = envelope.args;
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      return this.refuse(person, moduleId, act, { error: "args_invalid", rule: "args_not_an_object" });
    }
    if (!withinShapeLimits(args)) {
      return this.refuse(person, moduleId, act, { error: "args_invalid", rule: "args_too_large" });
    }
    const checked = conform(spec.args, args);
    if (!checked.ok) {
      return this.refuse(person, moduleId, act, {
        error: "args_invalid",
        rule: `args_${checked.issue.rule}`,
        field: withoutPositions(checked.issue.path),
      });
    }
    const credential = credentialLike(checked.value);
    if (credential !== null) {
      return this.refuse(person, moduleId, act, {
        error: "args_invalid",
        rule: "args_look_like_a_credential",
        field: credential,
      });
    }

    // ── 7. Capacity. After every check, so that nothing but an act that would
    //       run can use it up. ────────────────────────────────────────────────
    if (this.inFlight >= this.maxInFlight) {
      return this.refuse(person, moduleId, act, { error: "busy", rule: "busy_in_flight" });
    }
    const changes = spec.role === "operator";
    if (changes && !this.recorded.take(this.now())) {
      return this.refuse(person, moduleId, act, { error: "busy", rule: "busy_rate" });
    }
    // Taken here, in the same step as the checks above and with nothing
    // awaited in between. `run` gives the slot back.
    this.inFlight += 1;

    return this.run(module, spec, checked.value, acting, changes);
  }

  /** Run one admitted act. The caller has taken a slot for it. It is given
   *  back when the module's work settles, or at once when the act does not
   *  reach the module. */
  private async run(
    module: FortressModule,
    spec: ActSpec,
    args: unknown,
    acting: Acting,
    /** True for an act the manifest gives to operators: it is recorded, and
     *  its context can add to the two lists. */
    changes: boolean,
  ): Promise<ActAnswer> {
    const moduleId = module.manifest.id;
    const { audit } = this.deps;
    let intent: Awaited<ReturnType<AuditWriter["intent"]>> | null = null;
    if (changes) {
      try {
        intent = await audit.intent(AUDIT_ACTIONS.consoleModuleAct, {
          actor: acting.person.login,
          sessionRef: acting.session,
          params: { module: moduleId, act: spec.name },
        });
      } catch (thrown) {
        // An act that cannot be recorded does not run.
        this.inFlight -= 1;
        this.say("error", "refused an act: its audit record could not be written", {
          module: moduleId,
          act: spec.name,
          ...failureForLog(thrown),
        });
        return fail("failed:audit_unavailable");
      }
    }

    // The context can add to the two lists only in an act of operators, and
    // only while that act runs. A module that keeps the context cannot use it
    // later, outside of any act, to add a host under this person's login. The
    // same holds for a record the module writes of the act: it is under this
    // person's login only while the act runs, whichever role the act is given
    // to.
    let running = true;
    /** How the module's work ended, once it has. */
    let ended: { how: "ok" | "failed"; code: string | null } | null = null;
    /** True once the deadline has answered for this act and that is in the
     *  trail: from then on the end of its work is owed a record of its own. */
    let lateOwed = false;
    let lateWritten = false;
    /** Write that record once both are true: it is owed, and the work has
     *  ended. Called where either becomes true. */
    const late = (): void => {
      if (!lateOwed || lateWritten || ended === null) return;
      lateWritten = true;
      void this.endedLate(moduleId, spec.name, acting, ended.how, ended.code);
    };
    let work: Promise<unknown>;
    try {
      const context = this.deps.modules.contextFor(
        module,
        acting,
        () => changes && running,
        () => running,
      );
      // `onAct` was checked to be a function before the slot was taken.
      work = Promise.resolve((module.onAct as NonNullable<FortressModule["onAct"]>)(spec.name, args, context, acting.person));
    } catch (thrown) {
      work = Promise.reject(thrown);
    }
    // The slot is held until the module's own work settles, not until the
    // deadline answers for it: a handler still running is still using it. For
    // the same reason the context stays usable until then.
    const settle = (how: "ok" | "failed", code: string | null): void => {
      running = false;
      this.inFlight -= 1;
      ended = { how, code };
      late();
    };
    void work.then(
      () => settle("ok", null),
      (thrown: unknown) => settle("failed", failureCode(thrown)),
    );

    // From here every way out of a recorded act writes its outcome: an intent
    // with nothing after it reads as a daemon that stopped in the middle.
    let recorded = false;
    const record = async (outcome: string, error: string | null = null): Promise<void> => {
      recorded = true;
      if (intent) await audit.outcome(intent, outcome, error);
    };
    try {
      let result: unknown;
      try {
        result = await withDeadline(work, this.deps.deadlineMs ?? ACT_DEADLINE_MS, "deadline", {
          error: () => new ActDeadline("deadline"),
        });
      } catch (thrown) {
        // One word: a fixed one, one of the host's own ports', or one the
        // module chose to name. The thrown MESSAGE goes neither to the person
        // nor to the trail, and reaches the log only for the failures this
        // host words itself.
        const timedOut = thrown instanceof ActDeadline;
        const code = timedOut ? "timeout" : failureCode(thrown);
        await record("failed", code);
        // Only for an act that is recorded at all, and only once its pair has
        // ended `failed`, so that the record of the late end comes after it.
        // The work may have ended while that was being written.
        if (timedOut && intent) {
          lateOwed = true;
          late();
        }
        if (timedOut) {
          this.say("warn", "an act ran past its deadline and is still running", {
            module: moduleId,
            act: spec.name,
            inFlight: this.inFlight,
            slots: this.maxInFlight,
          });
        } else {
          this.say("error", "a module failed while carrying out an act", {
            module: moduleId,
            act: spec.name,
            ...failureForLog(thrown),
          });
        }
        return fail(`failed:${code}`);
      }

      // ── 8. The reply has its shape, and is rebuilt from it ─────────────────
      const reply = conform(spec.reply, result);
      if (!reply.ok) {
        const where = withoutPositions(reply.issue.path);
        await record("refused", `reply_${reply.issue.rule}${where ? ` at ${where}` : ""}`);
        this.say("error", "refused a module's reply to an act: it does not have its declared shape", {
          module: moduleId,
          act: spec.name,
          rule: reply.issue.rule,
          field: where,
        });
        return fail("reply_invalid");
      }
      if (Buffer.byteLength(JSON.stringify(reply.value) ?? "") > ACT_REPLY_MAX_BYTES) {
        await record("refused", "reply_too_large");
        this.say("error", "refused a module's reply to an act: it is too large", {
          module: moduleId,
          act: spec.name,
        });
        return fail("reply_invalid");
      }
      await record("ok");
      return { ok: true, reply: reply.value };
    } catch {
      // Nothing in the block above is meant to throw: the module's own failure
      // is caught where it is awaited. This is for what was not foreseen. What
      // was thrown is not looked at again and goes nowhere.
      if (!recorded) await record("failed", "internal").catch(() => {});
      return fail("failed:internal");
    }
  }

  /**
   * One more record for an operator's act that was answered `failed:timeout`
   * and whose work has ended since: how it ended. Written once for such an
   * act, by whichever of the two sees the other first: the deadline or the
   * end of the work. Never rejects.
   */
  private async endedLate(
    moduleId: string,
    act: string,
    acting: Acting,
    how: "ok" | "failed",
    code: string | null,
  ): Promise<void> {
    const written = await this.deps.audit
      .event(AUDIT_ACTIONS.consoleModuleActEndedLate, {
        actor: acting.person.login,
        sessionRef: acting.session,
        params: { module: moduleId, act },
        outcome: how,
        error: code,
      })
      .catch(() => null);
    this.say(written === null ? "error" : "warn", written === null
      ? "an act that ran past its deadline has ended, and the record of that could not be written"
      : "an act that ran past its deadline has ended", {
      module: moduleId,
      act,
      ended: how,
      ...(code === null ? {} : { code }),
    });
  }

  /** Write to the log, and carry on if it cannot be written. An act's answer
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

  /**
   * Turn an act away, and record that.
   *
   * `module` and `act` are written by name only once this build knows them.
   * Before that they are a text somebody sent, and a trail that copied it
   * would be a place anybody at the door can write to. The actor is the
   * person's login as the console gave it, or `console` when there is none.
   */
  private async refuse(
    person: Person | null,
    moduleLabel: string | null,
    act: string | null,
    refusal: Refusal,
  ): Promise<ActAnswer> {
    const params: AuditParams = {
      module: moduleLabel ?? "unknown",
      act: act ?? "unknown",
      rule: refusal.rule,
      ...(refusal.field ? { field: refusal.field } : {}),
    };
    await this.deps.audit.refused(AUDIT_ACTIONS.consoleModuleAct, params, person?.login ?? "console");
    return fail(refusal.error);
  }
}

function fail(error: ActError): ActAnswer {
  return { ok: false, error };
}

/** `lines[3].name` → `lines[].name`. A position is a number the caller picks;
 *  left in, it would make every position its own refusal window. */
function withoutPositions(path: string): string {
  return path.replace(/\[\d+\]/g, "[]");
}

/**
 * Where in arguments that have their shape a text looks like a credential, or
 * null when none does.
 *
 * The answer is a path of the shape's own field names, with no position in a
 * list: the value was rebuilt from its declared shape, so it has no other
 * field. What the text was is not in the answer.
 */
function credentialLike(value: unknown, path = ""): string | null {
  if (typeof value === "string") return recordable(value) ? null : path;
  if (Array.isArray(value)) {
    for (const item of value) {
      const at = credentialLike(item, `${path}[]`);
      if (at !== null) return at;
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    for (const [field, item] of Object.entries(value)) {
      const at = credentialLike(item, path ? `${path}.${field}` : field);
      if (at !== null) return at;
    }
  }
  return null;
}

class ActDeadline extends Error {}
