// One run of the setup: the answers being given, the checks, and the end that
// makes what the answers add up to.
//
// The browser page, the terminal and a settings file all drive this object. So
// the ways in cannot differ in what they check or in what they make: they
// differ only in how a question is put to a person.
//
// TWO PLACES A RUN CAN BE. `hx-fortress setup` runs on the machine that runs
// HX Fortress: its end writes the settings there (`apply.ts`).
// `hx-fortress install` runs on an engineer's computer, before anything
// exists: its end hands everything to a place that makes HX Fortress
// somewhere else (`src/install`), and writes nothing on this computer.
//
// A KEY A PERSON TYPES IS KEPT APART FROM THE ANSWERS. Only the install takes
// one. It stays in this object's memory, under the path of its field, until
// the end hands it to the place. It is in no answer, no settings file, no
// reply to a page and no record. The answer holds the name the key will have.

import path from "node:path";

import { pagesOrigin } from "../host/config";
import { MODULE_CATALOG, type CatalogEntry } from "../host/module-catalog";
import type { fortressPaths } from "../host/paths";
import { withDeadline } from "../host/with-deadline";
import { handOverOf } from "../install/handover";
import { MakeError, type Place, type SignedIn } from "../install/place";
import type { SecretProvider } from "../secrets/types";
import { BOOTSTRAP_TOKEN_DIGEST_ENV, BOOTSTRAP_TOKEN_EXPIRES_ENV, judgeMintedLink } from "../ui/bootstrap-user";
import { mintSetupToken, setupUrl, UsersStore } from "../ui/users";
import {
  answerAt,
  answerText,
  cloneAnswers,
  installAnswers,
  parseSettingsFile,
  publicAddress,
  setAnswer,
  settleAnswers,
  summaryLines,
  type SetupAnswers,
} from "./answers";
import { applyAnswers, changedSteps, type ApplyDeps, type ApplyResult } from "./apply";
import type { SetupAudit } from "./audit";
import { checkStep, keyStoreOf, refusalsOf, secretsBlockOf, type CheckDeps, type StepCheck } from "./checks";
import { controlPlaneAddress, controlPlaneUrl } from "./control-plane";
import {
  auditTrailFacts,
  controlPlaneFacts,
  filesFacts,
  hostFacts,
  installFacts,
  thisInstallFacts,
  updatesFacts,
} from "./facts";
import {
  INSTALL_PLACES,
  LAST_STEP,
  STEP_IDS,
  keyFields,
  placeInfo,
  stepsAsked,
  type PlaceId,
  type StepId,
  type Way,
} from "./list";
import { installPlan, setupPlan } from "./plan";
import { reachOf } from "./reach";
import { FIRST_ACCOUNT_ENV, needsFiles, readAnswers, type PresentAnswers, type ReadDeps } from "./read";
import type { SetupWay } from "./state";
import type { PlaceRow, PlanShown, Progress, SetupDerived, SetupDone, SetupFrame } from "./view";

export type { ModuleRow, SetupDerived, SetupFrame } from "./view";

type FortressPaths = ReturnType<typeof fortressPaths>;

/** A control plane and the one-time install id for it, as the command gave them. */
export interface Connect {
  /** The control plane's address, as a person writes it. */
  address: string;
  /** The one-time install id. */
  id: string;
  /** The origin of the pages the control plane shows to people, when the
   *  command names it. */
  pages?: string;
}

export interface SetupRunDeps {
  paths: FortressPaths;
  env?: Record<string, string | undefined>;
  catalog?: readonly CatalogEntry[];
  now?: () => Date;
  /** How the list is asked. Left out: a setup on the machine itself. */
  way?: Way;
  /** In the install: the places this build can make HX Fortress in. */
  places?: readonly Place[];
  /** What `--connect` gave. */
  connect?: Connect | null;
  /** Passed to every check. */
  check?: Partial<
    Omit<CheckDeps, "paths" | "env" | "present" | "catalog" | "way" | "typed" | "place" | "placeRefusals" | "installId">
  >;
  read?: ReadDeps;
  apply?: Pick<ApplyDeps, "updateVaultCredentials">;
}

export type FinishResult =
  | { ok: false; checks: StepCheck[] }
  | { ok: true; checks: StepCheck[]; applied: ApplyResult };

export interface FinishExtra {
  /** The port a new install's console listens on, when the setup was given one. */
  consolePort?: number | null;
  /** Where the end of the setup is recorded. */
  audit?: SetupAudit;
  /**
   * In the install: false when nothing can show the first administrator's
   * one-time link to a person (the output is a pipe or a file). No token is
   * made then. HX Fortress makes the account itself at its first start, and
   * keeps the link in a file on its own disk that only its user can read.
   */
  showAccountLink?: boolean;
}

/** What the last step of a setup on the machine itself adds to its last
 *  screen: where the console answers, and what a person does next. */
export interface EndWords {
  /** Where the console answers when the answers name no address. */
  consoleBase: string;
  /** One sentence: how HX Fortress gets started from here. */
  next: string;
}

/** The start of the last step. `ended` settles when everything is made, or
 *  when it stopped: `progress()` says which. It never rejects. */
export type CreateStart =
  | { ok: false; checks: StepCheck[] }
  | { ok: true; checks: StepCheck[]; ended: Promise<void> };

/** How long a question's passing check stands for the same answers. A person
 *  who goes from the last question to the last step and says yes asks for
 *  every check more than once in a few seconds; the outside services are
 *  asked once. A refused check is never kept: the person is putting it right. */
const PASS_KEPT_MS = 30_000;

/**
 * How long the first administrator's link lives when the install mints it.
 *
 * HX Fortress refuses a link that ends more than 24 hours ahead of its own
 * clock. The install's clock is the engineer's computer's, and the two clocks
 * may differ. One hour less leaves room for that difference, so that a
 * computer whose clock runs ahead does not leave the new HX Fortress with no
 * account.
 */
export const INSTALL_LINK_LIFE_MS = 23 * 60 * 60 * 1000;

/** What is said of an account that was made for a link this HX Fortress never
 *  held: the link was minted, and shown, where HX Fortress was installed. */
export function linkIsElsewhere(login: string): string {
  return (
    `The account ${login} sets its password from the link that was shown where HX Fortress was installed. ` +
    "No link is kept here."
  );
}

/** The answers that others follow: see `settleAnswers`. */
const SETTLES: readonly string[] = [
  "where.place",
  "model.provider",
  "organization.name",
  "organization.firstAdministrator",
];

/** The longest key a person can type: a connection string or a certificate's
 *  name is far shorter. */
const MAX_TYPED_CHARS = 16_384;

/** True for a value that is longer than the longest key a person may type. */
export function tooLongForAKey(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > MAX_TYPED_CHARS;
}

const ASKING: Progress = { stage: "asking", made: [], now: null, dns: null, failure: null };

export class SetupRun {
  /** The answers being given. Starts as the install's present answers. */
  answers: SetupAnswers;
  /** The keys a person typed, by the path of the field. Never given out. */
  private readonly typedKeys = new Map<string, string>();
  /** The one-time install id. Held here, in memory, until the end. It is never
   *  part of anything a screen is given. */
  private installId: string | null = null;
  private installEnv: Record<string, string | undefined> | null = null;
  /** The first administrator's one-time link of this install. It is minted
   *  once and is the same for every attempt: a second attempt after a failure
   *  hands over the digest the first one did, so an HX Fortress that already
   *  made the account still answers to the link the last screen shows. */
  private accountLink: ({ login: string } & ReturnType<typeof mintSetupToken>) | null = null;
  private keyStoreKept: { of: string; store: Promise<SecretProvider> } | null = null;
  private readonly passed = new Map<StepId, { of: string; at: number; check: StepCheck }>();
  private finishing: Promise<FinishResult> | null = null;
  private readonly placeRows = new Map<PlaceId, PlaceRow>();
  private progressNow: Progress = ASKING;
  private doneNow: SetupDone | null = null;
  private making: Promise<void> | null = null;
  private stopMaking: AbortController | null = null;

  private constructor(
    private readonly deps: SetupRunDeps,
    readonly present: PresentAnswers,
    private readonly catalog: readonly CatalogEntry[],
  ) {
    this.answers = cloneAnswers(present.answers);
  }

  static async open(deps: SetupRunDeps): Promise<SetupRun> {
    const catalog = deps.catalog ?? MODULE_CATALOG;
    const ids = catalog.map((entry) => entry.id);
    const on = catalog.filter((entry) => entry.defaultOn).map((entry) => entry.id);
    let present: PresentAnswers;
    if (deps.way === "install") {
      // Nothing exists yet, and nothing on this computer is HX Fortress's: the
      // run starts on the install's own answers, for the first place.
      present = {
        answers: installAnswers(INSTALL_PLACES[0] as PlaceId, ids, { on }),
        pinned: {},
        kept: { modelKey: false, databaseAddress: false, filesKeys: false },
        setUp: false,
        disconnectedFrom: null,
        consoleOn: false,
      };
    } else {
      present = await readAnswers(deps.paths, deps.env ?? process.env, { catalog, ...deps.read });
      // A new install starts with the modules this build switches on.
      if (!present.setUp) {
        for (const id of on) {
          if (!Object.hasOwn(present.pinned, `modules.${id}`)) present.answers.modules[id] = true;
        }
      }
    }
    const run = new SetupRun(deps, present, catalog);
    run.takeConnect(deps.connect ?? null);
    if (deps.way === "install") await run.startAtFirstPlace();
    return run;
  }

  get way(): Way {
    return this.deps.way ?? "setup";
  }

  private get install(): boolean {
    return this.way === "install";
  }

  /**
   * The environment the answers are read from and checked against.
   *
   * In the install it holds no variable that is addressed to HX Fortress. The
   * install runs in an engineer's own shell, and what that shell holds is not
   * the new HX Fortress's settings: a key in `FORTRESS_OPENAI_API_KEY` there
   * is not the key a person typed, and an address in a variable is not the
   * address the answers name. A check that read them would send the wrong key
   * to the wrong place and say that the typed one works.
   */
  private get env(): Record<string, string | undefined> {
    const env = this.deps.env ?? process.env;
    if (!this.install) return env;
    this.installEnv ??= Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("FORTRESS_")));
    return this.installEnv;
  }

  private get places(): readonly Place[] {
    return this.deps.places ?? [];
  }

  /** The control plane the command named, and its one-time install id. */
  private takeConnect(connect: Connect | null): void {
    if (!connect) return;
    if (Object.hasOwn(this.present.pinned, "controlPlane.connect")) return;
    const parsed = controlPlaneUrl(connect.address);
    this.answers.controlPlane = {
      connect: "yes",
      address: parsed.ok ? controlPlaneAddress(parsed.url) : connect.address,
      token: "",
      connected: "on",
      // Kept as it was given: the check says so when it is not one origin.
      pages: connect.pages ? (pagesOrigin(connect.pages) ?? connect.pages) : this.answers.controlPlane.pages,
    };
    this.installId = connect.id;
  }

  // ── The places of an install ───────────────────────────────────────────────

  /** One place as this computer sees it, asked of the place itself. */
  private async lookAt(id: PlaceId): Promise<PlaceRow> {
    const info = placeInfo(id);
    const place = this.places.find((p) => p.id === id);
    let who: SignedIn | null = null;
    if (place) who = await place.signedIn(this.answers).catch(() => null);
    const row: PlaceRow = {
      id,
      offered: place !== undefined,
      signedInAs: who?.as ?? "",
      needsSignIn: place?.needsSignIn ?? false,
      signInCommand: info.signInCommand ?? "",
    };
    this.placeRows.set(id, row);
    // What the place knows about who is installing fills in the first answers,
    // where a person has given none.
    if (who && id === this.answers.where.place) {
      if (who.organization && !this.answers.organization.name) this.set("organization.name", who.organization);
      if (who.person && !this.answers.organization.firstAdministrator) {
        this.set("organization.firstAdministrator", who.person.toLowerCase());
      }
    }
    return row;
  }

  /** The install opens on the first place this computer is signed in to, or
   *  else on the first one this build can make HX Fortress in. */
  private async startAtFirstPlace(): Promise<void> {
    const rows: PlaceRow[] = [];
    for (const id of INSTALL_PLACES) rows.push(await this.lookAt(id));
    const first =
      rows.find((row) => row.offered && row.needsSignIn && row.signedInAs) ?? rows.find((row) => row.offered);
    if (!first) return;
    this.answers.where.place = first.id;
    settleAnswers(this.answers, "where.place", undefined, { install: true });
    await this.lookAt(first.id);
  }

  // ── The answers ────────────────────────────────────────────────────────────

  /** What a screen needs once: the modules, what was found, the last words. */
  async frame(): Promise<SetupFrame> {
    return {
      way: this.way,
      modules: this.catalog.map((entry) => ({
        id: entry.id,
        title: entry.title,
        // A module's summary is written to follow its name in a sentence. Here
        // it is a sentence of its own.
        summary: `${entry.summary.charAt(0).toUpperCase()}${entry.summary.slice(1)}${/[.!?]$/.test(entry.summary) ? "" : "."}`,
      })),
      facts: {
        host: this.install ? [] : await hostFacts({ paths: this.deps.paths, env: this.env }),
        auditTrail: this.install ? [] : auditTrailFacts({ paths: this.deps.paths }),
        updates: updatesFacts({
          updates: this.answers.updates,
          ...(this.present.pinned["updates.address"] ? { setBy: this.present.pinned["updates.address"] } : {}),
        }),
      },
      pinned: { ...this.present.pinned },
      setUp: this.present.setUp,
      last: LAST_STEP[this.install ? "install" : "setup"],
    };
  }

  /** Change one answer. False when the path names no answer, when the value is
   *  of the wrong kind, or when the host's environment decides it. Text is kept
   *  without the spaces around it, whichever way it arrives: a pasted address
   *  with a space after it is the same address. The answers that follow the
   *  one that changed move with it. */
  set(at: string, value: unknown): boolean {
    if (Object.hasOwn(this.present.pinned, at)) return false;
    // Where it runs is the install's to answer. On the machine itself it is a
    // fact, and no request changes it.
    if (!this.install && (at === "where" || at.startsWith("where."))) return false;
    // Where a new version comes from decides where the program itself comes
    // from. It is named on the host: by a settings file that a command there
    // takes, in config.json, or in the environment. No page and no terminal
    // question sets it, so a request that tries is refused here.
    if (at === "updates.from" || at === "updates.address") return false;
    const follows = SETTLES.includes(at);
    const before = follows ? cloneAnswers(this.answers) : null;
    if (!setAnswer(this.answers, at, typeof value === "string" ? value.trim() : value)) return false;
    if (before && answerText(this.answers, at) !== answerText(before, at)) {
      settleAnswers(this.answers, at, undefined, { before, install: this.install });
    }
    this.forgetTypedWithoutName();
    return true;
  }

  /**
   * A key that was typed for a field has the name the field gives it. When
   * the answer there names another key, or none any more (the provider the
   * key was typed for was given up), the typed key is forgotten: it is never
   * offered to anything it was not typed for.
   */
  private forgetTypedWithoutName(): void {
    for (const at of [...this.typedKeys.keys()]) {
      if (answerText(this.answers, at) === keyFields().get(at)?.typedAs) continue;
      this.typedKeys.delete(at);
      this.passed.clear();
    }
  }

  /**
   * Keep a key a person typed, for the field at this path. Only the install
   * takes one, and only for a field that holds a key. An empty value forgets
   * the key. The answer at the path becomes the name the key will have, when
   * it holds none.
   */
  setTyped(at: string, value: unknown): boolean {
    if (!this.install || typeof value !== "string") return false;
    const field = keyFields().get(at);
    if (!field?.typedAs) return false;
    // Kept without the spaces around it, like every answer: the key that is
    // checked is the key that is handed over.
    const key = value.trim();
    if (key.length > MAX_TYPED_CHARS) return false;
    this.passed.clear();
    if (key === "") {
      this.typedKeys.delete(at);
      // The answer named the typed key. With the key gone, it names nothing.
      if (answerText(this.answers, at) === field.typedAs) setAnswer(this.answers, at, "");
      return true;
    }
    this.typedKeys.set(at, key);
    return this.typedAt(at);
  }

  /** Whether the field at this path takes a key a person types: only in the
   *  install, and only a field that holds a key. */
  takesTyped(at: string): boolean {
    return this.install && keyFields().get(at)?.typedAs !== undefined;
  }

  /** After a key was typed: its answer holds the name it will have. */
  private typedAt(at: string): boolean {
    const field = keyFields().get(at);
    if (!field?.typedAs) return false;
    return setAnswer(this.answers, at, field.typedAs);
  }

  /** The paths of the fields for which a key was typed. */
  typedPaths(): string[] {
    return [...this.typedKeys.keys()];
  }

  /** True while the answers are being checked for the last time and made. */
  get busy(): boolean {
    return this.finishing !== null || this.progressNow.stage === "making";
  }

  /** Take the answers a settings file gives. */
  takeFile(text: string): { ok: true; given: StepId[] } | { ok: false; refusals: string[] } {
    const parsed = parseSettingsFile(text, this.answers, {
      moduleIds: this.catalog.map((entry) => entry.id),
      install: this.install,
    });
    if (!parsed.ok) return parsed;
    // A file gives a question whole, and a field it leaves out is empty. An
    // answer that the host's environment decides is not the file's to empty:
    // it stays what the environment says. A file that gives it ANOTHER value
    // is refused by that answer's check, which names the variable.
    for (const at of Object.keys(this.present.pinned)) {
      const given = answerAt(parsed.answers, at);
      const left = given === undefined || given === "" || (Array.isArray(given) && given.length === 0);
      const decided = answerAt(this.present.answers, at);
      if (left && decided !== undefined) setAnswer(parsed.answers, at, decided);
    }
    this.answers = parsed.answers;
    return { ok: true, given: parsed.given };
  }

  // ── The checks ─────────────────────────────────────────────────────────────

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

  private checkDeps(typed: ReadonlyMap<string, string> = this.typedKeys): CheckDeps {
    return {
      ...(this.deps.read?.vaultCredentials ? { vaultCredentials: this.deps.read.vaultCredentials } : {}),
      ...this.deps.check,
      paths: this.deps.paths,
      env: this.env,
      present: this.present,
      catalog: this.catalog,
      way: this.way,
      installId: this.installId !== null,
      keyStore: (answers) => this.keyStore(answers),
      ...(this.install
        ? {
            typed: { has: (at: string) => typed.has(at), get: (at: string) => typed.get(at) },
            place: (id: PlaceId) => this.lookAt(id),
            placeRefusals: async (answers: SetupAnswers) => {
              const place = this.places.find((p) => p.id === answers.where.place);
              return (await place?.refusals?.(answers)) ?? [];
            },
          }
        : {}),
    };
  }

  /** The questions a run checks: the ones its way asks, and the control
   *  plane, which nobody is asked and which may still be named. */
  private steps(): StepId[] {
    const asked = new Set<StepId>([...stepsAsked(this.way), "controlPlane"]);
    if (!this.install) for (const step of STEP_IDS) if (step !== "where") asked.add(step);
    return STEP_IDS.filter((step) => asked.has(step));
  }

  /** What a kept pass is good for: these answers, with these keys typed. */
  private passKey(answers: SetupAnswers): string {
    return JSON.stringify([answers, [...this.typedKeys.keys()].sort(), this.installId !== null]);
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
   * still typing: no request leaves this computer, and its result is not kept.
   */
  async check(step: StepId, options: { quick?: boolean } = {}): Promise<StepCheck> {
    if (options.quick) return checkStep(step, this.answers, { ...this.checkDeps(), when: "typing" });
    // Asking again whether this computer is signed in is the point of
    // checking the first page again.
    if (step === "where") this.passed.delete("where");
    return (await this.checkThese([step], this.answers))[0] as StepCheck;
  }

  checkAll(): Promise<StepCheck[]> {
    return this.checkThese(this.steps(), this.answers);
  }

  /** The checks of these questions, in order. A question that passed with
   *  these same answers a moment ago is not asked of the outside again. */
  private async checkThese(
    steps: readonly StepId[],
    answers: SetupAnswers,
    typed: ReadonlyMap<string, string> = this.typedKeys,
  ): Promise<StepCheck[]> {
    const kept = new Map(steps.map((step) => [step, this.keptPass(step, answers)]));
    const due = steps.filter((step) => kept.get(step) === null);
    // One after another, so that the key store is asked for one thing at a
    // time and its first answer (a token for this host's identity, where it
    // needs one) serves the rest.
    const deps = this.checkDeps(typed);
    const fresh: StepCheck[] = [];
    for (const step of due) fresh.push(await checkStep(step, answers, deps));
    this.keep(answers, fresh);
    const made = new Map(fresh.map((check) => [check.step, check]));
    return steps.map((step) => (kept.get(step) ?? made.get(step)) as StepCheck);
  }

  // ── What a screen draws ────────────────────────────────────────────────────

  /** The plan of the last step, for these answers. */
  private plan(answers: SetupAnswers, account: string | null): PlanShown {
    if (this.install) return installPlan(answers, { needsFiles: needsFiles(answers) });
    return setupPlan(answers, {
      folder: this.deps.paths.root,
      account,
      connects: this.installId !== null && answers.controlPlane.connect === "yes",
    });
  }

  derived(): SetupDerived {
    const files = needsFiles(this.answers);
    const reach = reachOf(this.answers, { needsFiles: files });
    const titles = Object.fromEntries(this.catalog.map((entry) => [entry.id, entry.title]));
    const login = this.answers.organization.firstAdministrator;
    return {
      reach,
      summary: summaryLines(this.answers, { moduleTitles: titles, reachCount: reach.length, needsFiles: files }),
      needsFiles: files,
      places: INSTALL_PLACES.map(
        (id) =>
          this.placeRows.get(id) ?? {
            id,
            offered: false,
            signedInAs: "",
            needsSignIn: false,
            signInCommand: placeInfo(id).signInCommand ?? "",
          },
      ),
      plan: this.plan(this.answers, this.present.setUp || this.answers.signIn.provider !== "local" ? null : login || null),
      typed: this.typedPaths(),
      facts: {
        install: installFacts(this.answers),
        files: filesFacts(this.answers),
        controlPlane: controlPlaneFacts(this.answers),
        thisInstall: thisInstallFacts(this.answers),
      },
    };
  }

  progress(): Progress {
    return { ...this.progressNow, made: [...this.progressNow.made] };
  }

  /** What the last screen is given, once everything is made. */
  done(): SetupDone | null {
    return this.doneNow;
  }

  // ── The end, on the machine itself ─────────────────────────────────────────

  /** The questions the setup would write now. The audit record names them. */
  changedSteps(): StepId[] {
    return changedSteps(this.answers, this.present);
  }

  /** The login of the first administrator's account, when ending the setup
   *  with these answers would make it. Null when no account would be made. */
  private async accountToMake(answers: SetupAnswers): Promise<string | null> {
    // The rule `applyAnswers` makes the account by, so that the record names
    // an account exactly when one is made: whichever way people sign in, for a
    // login that has no account yet, and not from a minted link that this
    // HX Fortress refuses.
    const login = answers.organization.firstAdministrator;
    if (!login) return null;
    if (!changedSteps(answers, this.present).includes("organization")) return null;
    const users = await (
      this.deps.check?.users ?? (() => new UsersStore(path.join(this.deps.paths.uiRoot, "users.json")).load())
    )().catch(() => null);
    if (!users || users.users.some((user) => user.login === login)) return null;
    const minted = this.mintedLink();
    if (!minted) return login;
    const judged = judgeMintedLink({
      tokenDigest: minted.digest,
      tokenExpires: minted.expires,
      accounts: users.users.length,
      now: (this.deps.now ?? ((): Date => new Date()))(),
    });
    return judged.use === "refused" ? null : login;
  }

  /** A link for the first administrator that was minted where HX Fortress was
   *  installed. It rides beside the login in the environment, and counts only
   *  for the login the environment names. */
  private mintedLink(): { digest: string | undefined; expires: string | undefined } | null {
    if (this.present.pinned["organization.firstAdministrator"] !== FIRST_ACCOUNT_ENV) return null;
    const env = this.env;
    // eslint-disable-next-line security/detect-object-injection
    return { digest: env[BOOTSTRAP_TOKEN_DIGEST_ENV], expires: env[BOOTSTRAP_TOKEN_EXPIRES_ENV] };
  }

  /**
   * End a setup on the machine itself: check every answer once more, and
   * write them down only when none is refused.
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
    const checks = await this.checkThese(this.steps(), answers);
    if (refusalsOf(checks).length > 0) return { ok: false, checks };

    let enrollmentToken = this.installId;
    if (answers.controlPlane.connect !== "yes") enrollmentToken = null;
    // An install id given by name is read here, once, and goes nowhere but to
    // the first connection.
    const named = answers.controlPlane.token;
    if (!enrollmentToken && named && answers.controlPlane.connect === "yes") {
      enrollmentToken = await withDeadline(
        (await this.keyStore(answers)).get(named),
        this.deps.check?.timeoutMs ?? 8_000,
        "the key store did not answer in time",
      );
    }
    const minted = this.mintedLink();
    const applied = await applyAnswers(answers, {
      paths: this.deps.paths,
      present: this.present,
      way,
      enrollmentToken,
      catalog: this.catalog,
      ...(this.deps.now ? { now: this.deps.now } : {}),
      ...(extra.consolePort ? { consolePort: extra.consolePort } : {}),
      ...(minted ? { mintedLink: minted } : {}),
      ...this.deps.apply,
    });
    this.installId = null;
    return { ok: true, checks, applied };
  }

  // ── The last step ──────────────────────────────────────────────────────────

  /**
   * The last step: check every answer once more and, when none is refused,
   * start making what they add up to. It answers as soon as the making has
   * started; `progress()` says how far it is, and `done()` what there is at
   * the end.
   *
   * On the machine itself the making is the writing of the settings, and
   * `words` says where the console answers and what a person does next. In
   * the install it is the place's work, and it can take minutes.
   *
   * ONE AT A TIME, AND ONCE. While one is under way, and after one is done, a
   * second call starts nothing: it gets the first one's progress. After a
   * failure a person may say yes again, and what exists by then is kept.
   */
  async create(way: SetupWay, words: EndWords | null, extra: FinishExtra = {}): Promise<CreateStart> {
    if (this.making && this.progressNow.stage !== "failed") return { ok: true, checks: [], ended: this.making };

    if (!this.install) {
      // Nothing is awaited before `finish`: it copies the answers as its first
      // act, so an answer that changes from here on is not what is written.
      const answers = cloneAnswers(this.answers);
      const connects = this.installId !== null && answers.controlPlane.connect === "yes";
      this.progressNow = { stage: "making", made: [], now: "settings", dns: null, failure: null };
      const ending = this.finish(way, extra);
      let result: FinishResult;
      try {
        result = await ending;
      } catch (error) {
        this.progressNow = {
          stage: "failed",
          made: [],
          now: null,
          dns: null,
          // This program's own words: `apply.ts` writes its refusals itself.
          failure: { row: "settings", text: error instanceof Error ? error.message : "It could not be saved" },
        };
        this.making = Promise.resolve();
        return { ok: true, checks: [], ended: this.making };
      }
      if (!result.ok) {
        this.progressNow = ASKING;
        return { ok: false, checks: result.checks };
      }
      const base = publicAddress(answers) || words?.consoleBase || "";
      const made = result.applied.firstAccount;
      const plan = setupPlan(answers, { folder: this.deps.paths.root, account: made?.login ?? null, connects });
      this.doneNow = {
        address: base,
        firstAccount: made?.token ? { login: made.login, link: setupUrl(base, made.token) } : null,
        notes: [...result.applied.notes, ...(made && !made.token ? [linkIsElsewhere(made.login)] : [])],
        next: words?.next ?? "",
      };
      this.progressNow = { stage: "done", made: plan.rows.map((row) => row.id), now: null, dns: null, failure: null };
      this.making = Promise.resolve();
      return { ok: true, checks: result.checks, ended: this.making };
    }

    // The install. First, before anything is awaited: a copy of the answers
    // and of the typed keys. What is made is what was checked.
    const answers = cloneAnswers(this.answers);
    const typed = new Map(this.typedKeys);
    const checks = await this.checkThese(this.steps(), answers, typed);
    if (refusalsOf(checks).length > 0) return { ok: false, checks };
    if (this.making && this.progressNow.stage !== "failed") return { ok: true, checks, ended: this.making };

    const place = this.places.find((p) => p.id === answers.where.place);
    const plan = installPlan(answers, { needsFiles: needsFiles(answers) });
    if (!place) {
      // The check of the first page refuses a place this build cannot make
      // anything in, so this is reached only if the places changed under it.
      return { ok: false, checks: [{ step: "where", ok: false, lines: [{ ok: false, text: "This build cannot make HX Fortress there" }] }] };
    }

    // The first administrator's one-time token is made here and stays here.
    // HX Fortress gets its digest, and the last screen gets the link.
    const login = answers.organization.firstAdministrator;
    const now = (this.deps.now ?? ((): Date => new Date()))();
    if (!login || answers.signIn.provider !== "local" || extra.showAccountLink === false) {
      this.accountLink = null;
    } else if (this.accountLink?.login !== login || Date.parse(this.accountLink.record.expiresAt) <= now.getTime()) {
      // The first attempt, another login, or a link that has ended meanwhile.
      this.accountLink = { login, ...mintSetupToken(now, INSTALL_LINK_LIFE_MS) };
    }
    const account = this.accountLink;
    const handOver = handOverOf({
      answers,
      typed,
      installId: this.installId,
      account: account ? { digest: account.record.digest, expires: account.record.expiresAt } : null,
      rows: plan.rows,
    });

    const known = new Set(plan.rows.map((row) => row.id));
    const progress: Progress = { stage: "making", made: [], now: plan.rows[0]?.id ?? null, dns: null, failure: null };
    this.progressNow = progress;
    this.stopMaking = new AbortController();
    const sink = {
      begin: (row: string): void => {
        if (known.has(row)) progress.now = row;
      },
      done: (row: string): void => {
        if (!known.has(row)) return;
        if (!progress.made.includes(row)) progress.made.push(row);
        if (progress.now === row) progress.now = null;
        if (row === "dns") progress.dns = null;
      },
      waitingForDns: (record: { name: string; target: string }): void => {
        progress.now = "dns";
        progress.dns = { name: String(record.name), target: String(record.target) };
      },
    };
    this.making = place.make(handOver, sink, this.stopMaking.signal).then(
      (made) => {
        this.doneNow = {
          address: made.address,
          firstAccount: account && login ? { login, link: setupUrl(made.address, account.token) } : null,
          notes: [
            ...(made.notes ?? []),
            ...(login && answers.signIn.provider === "local" && !account
              ? [
                  `The link that sets the password of ${login} is in a file on HX Fortress's own disk, ` +
                    "which only its user can read. It is not shown here.",
                ]
              : []),
          ],
          next: "",
        };
        this.progressNow = { stage: "done", made: plan.rows.map((row) => row.id), now: null, dns: null, failure: null };
        // Everything is handed over. Nothing of it stays in this process: the
        // link is on the last screen, and nowhere else.
        this.typedKeys.clear();
        this.installId = null;
        this.accountLink = null;
      },
      (error: unknown) => {
        this.progressNow = {
          ...progress,
          stage: "failed",
          dns: null,
          failure:
            error instanceof MakeError
              ? { row: known.has(error.row) ? error.row : (progress.now ?? ""), text: error.text }
              : // Anything else may quote what an outside service sent, so
                // nothing of it is shown, here or in the terminal.
                { row: progress.now ?? "", text: "It could not be made" },
        };
      },
    );
    return { ok: true, checks, ended: this.making };
  }

  /** Stop a making that is under way: the place is told, and it ends as failed. */
  stop(): void {
    this.stopMaking?.abort();
  }
}
