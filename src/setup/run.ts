// One run of the setup: the answers being given, the checks, the enrollment with
// a control plane, and the end that writes everything down.
//
// The browser setup and the terminal both drive this object, and a settings
// file is applied through it. So the three ways in cannot differ in what they
// check or in what they write: they differ only in how a question is put to a
// person.

import { MODULE_CATALOG, type CatalogEntry } from "../host/module-catalog";
import { listAsks } from "../host/modules-api";
import type { fortressPaths } from "../host/paths";
import { withDeadline } from "../host/with-deadline";
import type { SecretProvider } from "../secrets/types";
import { SESSIONS_MODULE_ID } from "../host/config";
import { UsersStore } from "../ui/users";
import path from "node:path";
import {
  cloneAnswers,
  parseSettingsFile,
  setAnswer,
  settingsFileText,
  summaryLines,
  type SetupAnswers,
} from "./answers";
import { applyAnswers, changedSteps, type ApplyDeps, type ApplyResult } from "./apply";
import type { SetupAudit } from "./audit";
import {
  checkAll,
  checkStep,
  keyStoreOf,
  secretsBlockOf,
  refusalsOf,
  type CheckDeps,
  type EnrollmentView,
  type StepCheck,
} from "./checks";
import {
  checkEnrollment,
  controlPlaneHost,
  controlPlaneUrl,
  startEnrollment,
  type Enrollment,
  type EnrollmentDeps,
} from "./control-plane";
import { hostFacts, recordsFacts, updatesFacts } from "./facts";
import { STEP_IDS, visibleList, type StepId } from "./list";
import { reachOf } from "./reach";
import type { AskRow, EnrollmentShown, SetupDerived, SetupFrame } from "./view";

export type { AskRow, ModuleRow, EnrollmentShown, SetupDerived, SetupFrame } from "./view";
import { needsFiles, needsModel, readAnswers, type PresentAnswers, type ReadDeps } from "./read";
import type { SetupWay } from "./state";

type FortressPaths = ReturnType<typeof fortressPaths>;

export interface SetupRunDeps {
  paths: FortressPaths;
  env?: Record<string, string | undefined>;
  catalog?: readonly CatalogEntry[];
  now?: () => Date;
  /** Passed to every check. */
  check?: Partial<Omit<CheckDeps, "paths" | "env" | "present" | "catalog" | "enrollment">>;
  read?: ReadDeps;
  apply?: Pick<ApplyDeps, "updateVaultCredentials">;
  enrollment?: EnrollmentDeps;
  /**
   * The control plane's key at a connection address, as an id and a
   * fingerprint a person can compare. Null when there is nothing to show.
   * Absent in a build that has no such reader, and then no key is shown.
   */
  controlPlaneKey?: (connectionUrl: string) => Promise<{ id: string; fingerprint: string } | null>;
}

export type FinishResult =
  | { ok: false; checks: StepCheck[] }
  | { ok: true; checks: StepCheck[]; applied: ApplyResult };

export interface FinishExtra {
  /** The port a new install's console listens on, when the setup was given one. */
  consolePort?: number | null;
  /** Where the end of the setup is recorded. */
  audit?: SetupAudit;
}

const NO_ENROLLMENT: EnrollmentShown = {
  state: "none",
  code: "",
  signInAt: "",
  signInHost: "",
  reason: "",
  interval: 0,
  key: null,
};

/** How long a question's passing check stands for the same answers. A person
 *  who goes from the last question to the review and presses Finish asks for
 *  every check three times in a few seconds; the outside services are asked
 *  once. A refused check is never kept: the person is putting it right. */
const PASS_KEPT_MS = 30_000;

export class SetupRun {
  /** The answers being given. Starts as the install's present answers. */
  answers: SetupAnswers;
  private enrollment: (Enrollment & { state: EnrollmentView["state"]; reason?: string }) | null = null;
  private enrollmentKey: { id: string; fingerprint: string } | null = null;
  /** The enrollment token that a sign-in brought back. Held here, in memory, until
   *  the setup ends. It is never part of anything a screen is given. */
  private token: string | null = null;
  private keyStoreKept: { of: string; store: Promise<SecretProvider> } | null = null;
  private readonly passed = new Map<StepId, { of: string; at: number; check: StepCheck }>();
  private finishing: Promise<FinishResult> | null = null;

  private constructor(
    private readonly deps: SetupRunDeps,
    readonly present: PresentAnswers,
    private readonly catalog: readonly CatalogEntry[],
  ) {
    this.answers = cloneAnswers(present.answers);
  }

  static async open(deps: SetupRunDeps): Promise<SetupRun> {
    const catalog = deps.catalog ?? MODULE_CATALOG;
    const present = await readAnswers(deps.paths, deps.env ?? process.env, { catalog, ...deps.read });
    return new SetupRun(deps, present, catalog);
  }

  private get env(): Record<string, string | undefined> {
    return this.deps.env ?? process.env;
  }

  /** What a screen needs once: the list, the modules and what was found. */
  async frame(): Promise<SetupFrame> {
    return {
      list: visibleList(),
      modules: this.catalog.map((entry) => ({
        id: entry.id,
        title: entry.title,
        // A module's summary is written to follow its name in a sentence. Here
        // it is a line of its own.
        summary: entry.summary.charAt(0).toUpperCase() + entry.summary.slice(1),
      })),
      facts: {
        host: await hostFacts({ paths: this.deps.paths, env: this.env }),
        records: recordsFacts({ paths: this.deps.paths }),
        updates: updatesFacts(),
      },
      pinned: { ...this.present.pinned },
      setUp: this.present.setUp,
    };
  }

  /** Change one answer. False when the path names no answer, when the value is
   *  of the wrong kind, or when the host's environment decides it. Text is kept
   *  without the spaces around it, whichever way it arrives: a pasted address
   *  with a space after it is the same address. */
  set(path: string, value: unknown): boolean {
    if (Object.hasOwn(this.present.pinned, path)) return false;
    return setAnswer(this.answers, path, typeof value === "string" ? value.trim() : value);
  }

  /** True while the answers are being checked for the last time and written. */
  get busy(): boolean {
    return this.finishing !== null;
  }

  /** Take the answers a settings file gives. */
  takeFile(text: string): { ok: true; given: StepId[] } | { ok: false; refusals: string[] } {
    const parsed = parseSettingsFile(text, this.answers, { moduleIds: this.catalog.map((entry) => entry.id) });
    if (!parsed.ok) return parsed;
    this.answers = parsed.answers;
    return { ok: true, given: parsed.given };
  }

  private enrollmentView(): EnrollmentView | null {
    if (!this.enrollment) return null;
    return {
      url: this.enrollment.url,
      state: this.enrollment.state,
      ...(this.enrollment.reason ? { reason: this.enrollment.reason } : {}),
    };
  }

  /**
   * The key store that the answers name. It is built once and kept for as long
   * as the Keys answer stays the same: a check runs on every pause in typing,
   * and a key store that asks this host's identity for a token would otherwise
   * ask for a new one each time.
   */
  private keyStore(answers: SetupAnswers): Promise<SecretProvider> {
    const injected = this.deps.check?.keyStore;
    if (injected) return Promise.resolve(injected(answers));
    const of = JSON.stringify(secretsBlockOf(answers.keys));
    if (this.keyStoreKept?.of !== of) {
      const store = keyStoreOf(answers, { paths: this.deps.paths, env: this.env });
      // A store that could not be built is built again on the next ask.
      store.catch(() => {
        if (this.keyStoreKept?.store === store) this.keyStoreKept = null;
      });
      this.keyStoreKept = { of, store };
    }
    return this.keyStoreKept.store;
  }

  private checkDeps(): CheckDeps {
    return {
      ...(this.deps.read?.vaultCredentials ? { vaultCredentials: this.deps.read.vaultCredentials } : {}),
      ...this.deps.check,
      paths: this.deps.paths,
      env: this.env,
      present: this.present,
      catalog: this.catalog,
      enrollment: this.enrollmentView(),
      keyStore: (answers) => this.keyStore(answers),
    };
  }

  /** What a kept pass is good for: these answers, and this state of the
   *  enrollment. Anything else is another question. */
  private passKey(answers: SetupAnswers): string {
    return JSON.stringify([answers, this.enrollment?.url ?? "", this.enrollment?.state ?? "", this.token !== null]);
  }

  private keep(answers: SetupAnswers, checks: readonly StepCheck[]): void {
    const of = this.passKey(answers);
    const at = Date.now();
    for (const check of checks) {
      if (check.ok) this.passed.set(check.step, { of, at, check });
      else this.passed.delete(check.step);
    }
  }

  private keptPass(step: StepId, answers: SetupAnswers): StepCheck | null {
    const kept = this.passed.get(step);
    if (!kept || kept.of !== this.passKey(answers) || Date.now() - kept.at > PASS_KEPT_MS) return null;
    return kept.check;
  }

  /**
   * Check one question's answer. `quick` is the check made while a person is
   * still typing: no request leaves this host, and its result is not kept.
   */
  async check(step: StepId, options: { quick?: boolean } = {}): Promise<StepCheck> {
    if (options.quick) return checkStep(step, this.answers, { ...this.checkDeps(), when: "typing" });
    return (await this.checkThese([step], this.answers))[0] as StepCheck;
  }

  checkAll(): Promise<StepCheck[]> {
    return this.checkThese(STEP_IDS, this.answers);
  }

  /** The checks of these questions, in order. A question that passed with
   *  these same answers a moment ago is not asked of the outside again. */
  private async checkThese(steps: readonly StepId[], answers: SetupAnswers): Promise<StepCheck[]> {
    const kept = new Map(steps.map((step) => [step, this.keptPass(step, answers)]));
    const due = steps.filter((step) => kept.get(step) === null);
    // One after another, so that the key store is asked for one thing at a
    // time and its first answer (a token for this host's identity, where it
    // needs one) serves the rest.
    let fresh: StepCheck[] = [];
    if (due.length === STEP_IDS.length) fresh = await checkAll(answers, this.checkDeps());
    else for (const step of due) fresh.push(await checkStep(step, answers, this.checkDeps()));
    this.keep(answers, fresh);
    const made = new Map(fresh.map((check) => [check.step, check]));
    return steps.map((step) => (kept.get(step) ?? made.get(step)) as StepCheck);
  }

  /** The enrollment as a screen shows it, for the address in the answers. A
   *  enrollment made for another address is not this one's. */
  private enrollmentShown(): EnrollmentShown {
    const parsed = controlPlaneUrl(this.answers.controlPlane.address);
    const enrollment = this.enrollment;
    if (!enrollment || !parsed.ok || parsed.url !== enrollment.url || this.answers.controlPlane.connect !== "yes") {
      return NO_ENROLLMENT;
    }
    return {
      state: enrollment.state,
      code: enrollment.code,
      signInAt: enrollment.signInAt,
      signInHost: controlPlaneHost(enrollment.signInAt),
      reason: enrollment.reason ?? "",
      interval: enrollment.state === "waiting" ? enrollment.interval : 0,
      key: this.enrollmentKey,
    };
  }

  derived(): SetupDerived {
    const files = needsFiles(this.answers);
    const reach = reachOf(this.answers, { needsFiles: files, needsModel: needsModel(this.answers) });
    const titles = Object.fromEntries(this.catalog.map((entry) => [entry.id, entry.title]));
    const byModule = new Map<string, string[]>();
    for (const ask of listAsks({ catalog: this.catalog })) {
      byModule.set(ask.module, [...(byModule.get(ask.module) ?? []), ask.name]);
    }
    const asks: AskRow[] = this.catalog
      .filter((entry) => this.answers.modules[entry.id] === true || byModule.has(entry.id))
      .map((entry) => ({
        module: entry.id,
        title: entry.title,
        on: this.answers.modules[entry.id] === true,
        asks: byModule.get(entry.id) ?? [],
        // Sessions takes no asks. Its transcripts travel through the control
        // plane's connection on their way to and from this Fortress, and a
        // person who connects one is told so.
        note:
          entry.id === SESSIONS_MODULE_ID
            ? "Session transcripts travel through it, to and from this Fortress"
            : "",
      }));
    return {
      reach,
      asks,
      summary: summaryLines(this.answers, { moduleTitles: titles, reachCount: reach.length }),
      file: settingsFileText(this.answers),
      needsFiles: files,
      enrollment: this.enrollmentShown(),
    };
  }

  /** Ask the control plane in the answers for a code to sign in with. Throws one plain
   *  sentence when the address is not one, or when nothing there answers. */
  async enroll(): Promise<EnrollmentShown> {
    const parsed = controlPlaneUrl(this.answers.controlPlane.address);
    if (!parsed.ok) throw new Error(parsed.reason);
    // The new code is asked for first. Only when it came does it take the
    // place of what was held: a request that fails leaves an earlier sign-in,
    // and its token, exactly as they were.
    const next = await startEnrollment(parsed.url, this.enrollmentDeps());
    const key = (await this.deps.controlPlaneKey?.(parsed.url).catch(() => null)) ?? null;
    this.token = null;
    this.enrollment = { ...next, state: "waiting" };
    this.enrollmentKey = key;
    return this.enrollmentShown();
  }

  private enrollmentDeps(): EnrollmentDeps {
    const timeoutMs = this.deps.check?.timeoutMs;
    return { ...(timeoutMs ? { timeoutMs } : {}), ...this.deps.enrollment };
  }

  /** Ask once whether a person has signed in and confirmed the code. */
  async enrollCheck(): Promise<EnrollmentShown> {
    const enrollment = this.enrollment;
    if (!enrollment || enrollment.state !== "waiting") return this.enrollmentShown();
    const result = await checkEnrollment(enrollment, this.enrollmentDeps());
    if (result.state === "ready") {
      this.token = result.token;
      enrollment.state = "ready";
    } else if (result.state === "refused") {
      enrollment.state = "refused";
      enrollment.reason = result.reason;
    } else if (result.state === "expired") {
      enrollment.state = "expired";
    }
    return this.enrollmentShown();
  }

  /** The questions the setup would write now. The audit record names them. */
  changedSteps(): StepId[] {
    return changedSteps(this.answers, this.present);
  }

  /** The login of the first administrator's account, when ending the setup
   *  with these answers would make it. Null when no account would be made. */
  private async accountToMake(answers: SetupAnswers): Promise<string | null> {
    const login = answers.organization.firstAdministrator;
    if (!login || !changedSteps(answers, this.present).includes("organization")) return null;
    const users = await (
      this.deps.check?.users ?? (() => new UsersStore(path.join(this.deps.paths.uiRoot, "users.json")).load())
    )().catch(() => null);
    return users?.users.some((user) => user.login === login) ? null : login;
  }

  /**
   * End the setup: check every answer once more, and write them down only when
   * none is refused.
   *
   * WHAT IS WRITTEN IS WHAT WAS CHECKED. The answers are copied when the end
   * begins, and the checks and the writing both work on that copy. A request
   * that changes an answer while the checks run changes the live answers and
   * not the copy, so nothing is written that no check saw.
   *
   * ONE END AT A TIME. A second call while one is under way gets the first
   * one's result: the answers are written once, and the first administrator's
   * one-time link is handed out once.
   *
   * THE AUDIT RECORD IS WRITTEN FROM THE SAME COPY. Given an `audit`, the end
   * is wrapped in its pair of records, and what the record names (the
   * questions, the account) is worked out from the copy that is written.
   */
  finish(way: SetupWay, extra: FinishExtra = {}): Promise<FinishResult> {
    this.finishing ??= this.finishOnce(way, extra).finally(() => {
      this.finishing = null;
    });
    return this.finishing;
  }

  private async finishOnce(way: SetupWay, extra: FinishExtra): Promise<FinishResult> {
    // First, before anything is awaited: from here on nothing that changes the
    // live answers reaches what is checked and written.
    const answers = cloneAnswers(this.answers);
    const work = (): Promise<FinishResult> => this.checkAndWrite(answers, way, extra);
    if (!extra.audit) return work();
    return extra.audit.finish(way, changedSteps(answers, this.present), await this.accountToMake(answers), work);
  }

  private async checkAndWrite(answers: SetupAnswers, way: SetupWay, extra: FinishExtra): Promise<FinishResult> {
    const checks = await this.checkThese(STEP_IDS, answers);
    if (refusalsOf(checks).length > 0) return { ok: false, checks };

    let enrollmentToken = this.token;
    const parsed = controlPlaneUrl(answers.controlPlane.address);
    // A token must be the one given for this address, not for an earlier one.
    if (this.enrollment && parsed.ok && this.enrollment.url !== parsed.url) enrollmentToken = null;
    if (answers.controlPlane.connect !== "yes") enrollmentToken = null;
    // An enrollment token given by name is read here, once, and goes nowhere
    // but to the first connection.
    const named = answers.controlPlane.token;
    if (!enrollmentToken && named && answers.controlPlane.connect === "yes") {
      enrollmentToken = await withDeadline(
        (await this.keyStore(answers)).get(named),
        this.deps.check?.timeoutMs ?? 8_000,
        "the key store did not answer in time",
      );
    }
    const applied = await applyAnswers(answers, {
      paths: this.deps.paths,
      present: this.present,
      way,
      enrollmentToken,
      catalog: this.catalog,
      ...(this.deps.now ? { now: this.deps.now } : {}),
      ...(extra.consolePort ? { consolePort: extra.consolePort } : {}),
      ...this.deps.apply,
    });
    this.token = null;
    return { ok: true, checks, applied };
  }
}
