// The console's Settings page: what a signed-in administrator can change from
// a browser, and nothing more.
//
// IT IS THE SETUP'S OWN LIST, ASKED A THIRD WAY. The sections are steps of
// `src/setup/list.ts` whose `asked` names "settings". A section's answer is
// read from where HX Fortress keeps that setting, checked by the same check
// that ran when it was first given, and written by the same function. So
// Settings cannot disagree with the setup about what an answer means.
//
// A REQUEST CHANGES ONE SECTION, AND ONLY WHAT IT ASKS. A check and a save
// name their section, and only the answers that section asks are taken from
// the request (`SetupRun.settableIn`): an answer of another section that a
// request carries is dropped, and so is everything Settings does not ask:
// where HX Fortress runs, its key store, its address, its database, the
// control plane's address and the origin of its pages, and every field that
// names an address a key is sent to (the identity provider's own issuer and
// client secret, a model address of the organization's own). Those change on
// the host, or with the install command. So no request to the console can make
// HX Fortress send a key to an address that somebody typed into a page. A save
// also names the version of its section that the page read
// (`SettingsState.versions`), and is refused when the saved answers changed
// since: a page that is behind cannot put its reading over another save.
//
// A KEY GOES ONLY WHERE IT IS USED ALREADY. A check from the page is the check
// made while a person types, whatever the request says: nothing goes to a
// model's provider, an identity provider, a database or a control plane. A
// save checks its section in full, and the model's check still reads no key
// and asks no model: in this way it looks at the provider, the key's name, and
// whether the key store holds a key of that name (`checks.ts`). Otherwise a
// session could name any key of the key store as the model's key and have
// HX Fortress send it out. The model's key may not be a key that another answer
// names for something else, in any way. A save that switches on a module that
// keeps files checks the Database step in full, as the setup does: the
// database's connection string is read and the database opened, and a test
// file is written to the file store. Those keys go where HX Fortress already
// sends them, to places a page cannot change.
//
// A SAVE IS AN OPERATOR'S, AND A PERSON'S. The routes that check and save are
// of the `mutate` class: an auditor's read-only session reads Settings and
// changes nothing. While the console requires the second step, a save from an
// account of this console also takes the current code from that person's
// authenticator app, unless the session gave one in the last few minutes (at
// sign-in, or before an earlier save). A session through the identity provider
// is asked to sign in there again once its sign-in is older than those few
// minutes. So a session that somebody else got hold of cannot save by itself.
// The code is judged where a code at sign-in is (`UiRuntime.confirmWithCode`),
// and a wrong one counts the same.
//
// EVERY SAVE THAT REACHES THE CHECKS IS RECORDED, as a pair around the checks
// and the writing: who, which section, which questions it writes, and which of
// them wait for a start. A save the checks refuse ends the pair as `refused`.
// No answer is recorded, but for Sign-in's: the provider chosen and the four
// group lists, as names, as the terminal's `ui oidc set` records its value.
//
// A FAILED SAVE SAYS THIS PROGRAM'S SENTENCE. The writer's sentences meant for
// a person are of one class (`SetupRefusal`), and only that class is repeated,
// in the reply and in the record. Anything else that goes wrong is said as
// "The settings could not be saved": an error's own words can be the file
// system's, or tomorrow a service's, and are kept out of both.
//
// A NEW INSTALL ID IS A CREDENTIAL. It is in no record, no reply, no error and
// no line of a log. It is taken only after the control plane refused the
// connection, as the daemon's status says, and it is written as the pending
// enrollment, the way the install command writes one.

import { FilePendingEnrollmentStore } from "../cloud/credentials";
import { AUDIT_ACTIONS } from "../console/audit-actions";
import { ConsoleStatusUnavailable, readConsoleStatus } from "../console/connection-shown";
import type { fortressPaths } from "../host/paths";
import { isInstallId } from "../setup/connect";
import { controlPlaneUrl } from "../setup/control-plane";
import { SETTINGS_ORDER, isStepId, type StepId } from "../setup/list";
import type { SetupAnswers } from "../setup/answers";
import { SetupRefusal } from "../setup/apply";
import {
  refusedAt,
  sectionVersion,
  settingOrder,
  SetupRun,
  type FinishResult,
  type SetupRunDeps,
} from "../setup/run";
import type { ConsoleAudit } from "./audit-writer";
import { redactValue } from "./redact";
import type { RouteSpec } from "./routes";
import type { CodeVerdict } from "./runtime";
import {
  SETTINGS_PATHS,
  type ConnectionShown,
  type SettingsChecked,
  type SettingsSaved,
  type SettingsState,
} from "./settings-wire";

export { SETTINGS_PATHS };
export type { ConnectionShown, SettingsChecked, SettingsSaved, SettingsState };

type FortressPaths = ReturnType<typeof fortressPaths>;

/**
 * Reading Settings changes nothing and sends nothing, so any console role may.
 * A check sends nothing either, and stays an operator's with the two writes:
 * it is the first half of a change. It draws from a budget of its own, sized
 * for typing: on `control`, a page that checks at each pause would soon leave
 * every write of the console refused, for everybody behind the same proxy.
 */
export const SETTINGS_ROUTES: readonly RouteSpec[] = [
  { method: "GET", path: SETTINGS_PATHS.read, cls: "read" },
  { method: "POST", path: SETTINGS_PATHS.check, cls: "mutate", bucket: "settingsCheck" },
  { method: "POST", path: SETTINGS_PATHS.save, cls: "mutate", bucket: "control" },
  { method: "POST", path: SETTINGS_PATHS.installId, cls: "mutate", bucket: "control" },
];

// This program's own words.
const NOT_A_SECTION = "Not a section of Settings";
const NOT_AN_INSTALL_ID = "This is not an install id. Copy it again from the control plane's page";
export const NOT_SAVED = "The settings could not be saved";
export const INSTALL_ID_NOT_SAVED = "The install id could not be kept. Give it again";
export const CODE_NEEDED = "Type the code from your authenticator app to save";
export const CODE_REFUSED = "That code did not work. Wait for the next one and try again";
export const NO_APP =
  "This account has no authenticator app set up, so it cannot save. Ask an administrator for a new setup link";
export const ID_ONLY_AFTER_REFUSAL = "A new install id is taken only after the control plane refused the connection";
// CODE_PASS_MS is five minutes: a test holds the two together.
export const SIGN_IN_NEEDED =
  "Sign in again through your identity provider to save. A sign-in counts for 5 minutes";
export const STALE = "These settings changed since this page read them. Look again, then save";

/** "a minute", "3 minutes": how long a wait is, said to a person. */
function minutes(ms: number): string {
  const count = Math.max(1, Math.ceil(ms / 60_000));
  return count === 1 ? "a minute" : `${count} minutes`;
}

/** The sentence for a refusal that names how long to wait. */
export function codeClosed(ms: number): string {
  return `Too many wrong codes were entered for this account. Wait ${minutes(ms)}, then try again`;
}
export function tooManyAttempts(ms: number): string {
  return `Too many attempts from this network. Wait ${minutes(ms)}, then try again`;
}

/** What a record says of a save: which section, which questions were written,
 *  and which of them wait for a start. A record holds words, not lists. */
function recorded(section: StepId, changed: readonly StepId[], restart: readonly StepId[]): Record<string, string> {
  return { section, changed: changed.join(",") || "nothing", restart: restart.join(",") || "nothing" };
}

/**
 * What a record of a Sign-in save adds: who may sign in how, as names. The
 * provider chosen, and while it is the identity provider, its four group
 * lists, each written as `ui oidc set` writes one (names joined by commas),
 * since that is the value the terminal's record keeps. Each list is recorded
 * whole, however long, so that no cut hides a group (`LIST_PARAM_CHARS` in
 * src/console/audit-actions.ts). None of them is an address or a key's name:
 * those are not Settings' to change.
 */
function signInRecorded(answers: SetupAnswers): Record<string, string> {
  const signIn = answers.signIn;
  if (signIn.provider !== "openid-connect") return { provider: signIn.provider };
  return {
    provider: signIn.provider,
    administratorGroups: signIn.administratorGroups.join(","),
    operatorGroups: signIn.operatorGroups.join(","),
    readonlyGroups: signIn.readonlyGroups.join(","),
    viewerGroups: signIn.viewerGroups.join(","),
  };
}

/** The proof before a save: whether this session is asked for a code now, the
 *  judge of one it typed, and whether it is asked to sign in again. */
export interface SettingsCode {
  asks: () => Promise<boolean>;
  /** `UiRuntime.confirmWithCode` for this session. */
  confirm: (code: unknown) => Promise<CodeVerdict>;
  /** `UiRuntime.asksSignIn` for this session. */
  asksSignIn: () => Promise<boolean>;
}

export interface SettingsRouteContext {
  paths: FortressPaths;
  env: Record<string, string | undefined>;
  audit: ConsoleAudit;
  actor: string;
  sessionId: string;
  code: SettingsCode;
  /** Tells the running daemon to read its settings again. */
  signalDaemon: () => Promise<void>;
  /** Injected in tests: fakes for the outside calls of a check. */
  run?: Partial<SetupRunDeps>;
  /** Injected in tests. */
  connection?: () => Promise<ConnectionShown>;
}

function json(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(redactValue(body))}\n`, {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** What a failed save may say: a refusal's own sentence, or `fallback`. */
function sayable(error: unknown, fallback: string): string {
  return error instanceof SetupRefusal ? error.message : fallback;
}

/** The writing of a save, with its failure said in words this program may
 *  repeat: the record of a failed save keeps the thrown error's words. */
function inOwnWords<T>(work: () => Promise<T>, fallback: string): () => Promise<T> {
  return async () => {
    try {
      return await work();
    } catch (error) {
      throw error instanceof SetupRefusal ? error : new Error(fallback);
    }
  };
}

/** A failed save, answered. A refusal is a conflict with what the settings
 *  hold; anything else is this program's failure. */
function failedSave(error: unknown, fallback: string): Response {
  return json({ error: sayable(error, fallback) }, error instanceof SetupRefusal ? 409 : 500);
}

/** One save at a time in this process. Two saves that ran together would each
 *  read the settings, change their own part, and write: the second would put
 *  back what the first changed. */
let saving: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const next = saving.then(work, work);
  saving = next.catch(() => undefined);
  return next;
}

/**
 * Take the answers a page sends for one section, one path at a time, through
 * the run's own `set`. A path the section does not ask now is not looked at:
 * of another section, one Settings never asks, or a field that is not in
 * effect for the answers as they are. `set` refuses every value of the wrong
 * kind and every answer the host's environment decides. So a request cannot
 * add a key to the answers, change a field's type, reach an answer of another
 * section, or set a field that no check looks at.
 *
 * The paths are set in `settingOrder`, whatever order the request holds them
 * in: an answer that others follow, then one that decides which fields are in
 * effect, then the fields.
 */
function takeAnswers(run: SetupRun, section: StepId, incoming: unknown): void {
  const given: { at: string; value: string | boolean | unknown[] }[] = [];
  const walk = (node: unknown, at: string, depth: number): void => {
    if (depth > 4) return;
    if (typeof node === "string" || typeof node === "boolean" || Array.isArray(node)) {
      given.push({ at, value: node });
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue;
      walk(value, at ? `${at}.${key}` : key, depth + 1);
    }
  };
  walk(incoming, "", 0);
  given.sort((a, b) => settingOrder(a.at) - settingOrder(b.at));
  for (const { at, value } of given) {
    if (run.settableIn(section).has(at)) run.set(at, value);
  }
}

function sectionOf(value: unknown): StepId | null {
  return typeof value === "string" && isStepId(value) && SETTINGS_ORDER.includes(value) ? value : null;
}

/**
 * The answer to a save that was made on answers that changed since its page
 * read them, or null when the version it sent is the one of the answers saved
 * now. A page sends only the answers a person changed, and its version says
 * what it read: a page that is behind would otherwise put its own reading of
 * the section over a save somebody else made meanwhile.
 */
function staleSave(run: SetupRun, section: StepId, version: unknown): SettingsSaved | null {
  return version === sectionVersion(run.present.answers, section) ? null : { saved: false, stale: STALE };
}

async function open(ctx: SettingsRouteContext): Promise<SetupRun> {
  return SetupRun.open({ paths: ctx.paths, env: ctx.env, way: "settings", ...ctx.run });
}

/** The connection address of the control plane this HX Fortress names, or
 *  null when it names none. */
function controlPlaneOf(run: SetupRun): string | null {
  const named = run.present.answers.controlPlane;
  if (named.connect !== "yes") return null;
  const parsed = controlPlaneUrl(named.address);
  return parsed.ok ? parsed.url : null;
}

/** How the connection stands, in the daemon's own words: see
 *  `readConsoleStatus`. Nothing that cannot be read is guessed. */
function connectionOf(run: SetupRun, ctx: SettingsRouteContext): Promise<ConnectionShown> {
  const read = ctx.connection ?? (() => readConsoleStatus(ctx.paths, { controlPlane: controlPlaneOf(run) }));
  return read().catch((): ConnectionShown => ConsoleStatusUnavailable);
}

async function stateOf(run: SetupRun, ctx: SettingsRouteContext): Promise<SettingsState> {
  return {
    frame: await run.frame(),
    answers: run.answers,
    derived: run.derived(),
    sections: SETTINGS_ORDER,
    connection: await connectionOf(run, ctx),
    asksCode: await ctx.code.asks().catch(() => true),
    asksSignIn: await ctx.code.asksSignIn().catch(() => true),
    versions: run.versions(),
  };
}

/**
 * The person's proof before a save: a sign-in through the identity provider
 * that is recent enough, or the code from the authenticator app. Null when the
 * save may go on: this session is not asked, or the code it sent is right.
 * Otherwise what the page is told, which is an answer and not an error: the
 * page shows the sentence where the person acts on it.
 */
async function codeStep(
  ctx: SettingsRouteContext,
  section: StepId,
  code: unknown,
): Promise<SettingsSaved | null> {
  if (await ctx.code.asksSignIn().catch(() => true)) return { saved: false, signInNeeded: SIGN_IN_NEEDED };
  if (!(await ctx.code.asks().catch(() => true))) return null;
  if (typeof code !== "string" || code.trim() === "") return { saved: false, codeNeeded: CODE_NEEDED };
  const verdict = await ctx.code.confirm(code).catch((): CodeVerdict => ({ ok: false, reason: "refused" }));
  if (verdict.ok) return null;
  switch (verdict.reason) {
    case "wrong code":
      // Which section was being saved, and nothing of the code.
      await ctx.audit.raise(AUDIT_ACTIONS.settingsCodeRefused, {
        actor: ctx.actor,
        sessionRef: ctx.sessionId,
        params: { section },
        outcome: "refused",
      });
      return { saved: false, codeNeeded: verdict.closedForMs > 0 ? codeClosed(verdict.closedForMs) : CODE_REFUSED };
    case "too many codes":
      return { saved: false, codeNeeded: codeClosed(verdict.retryAfterMs) };
    case "too many attempts":
      return { saved: false, codeNeeded: tooManyAttempts(verdict.retryAfterMs) };
    case "no app":
      return { saved: false, codeNeeded: NO_APP };
    default:
      return { saved: false, codeNeeded: CODE_REFUSED };
  }
}

/** What a save answers with: whether it wrote, and what it left to do. */
async function saved(result: FinishResult, ctx: SettingsRouteContext): Promise<Response> {
  if (!result.ok) return json({ saved: false, checks: result.checks } satisfies SettingsSaved);
  // The daemon follows a module's switch when told.
  await ctx.signalDaemon().catch(() => {});
  const run = await open(ctx);
  const answer: SettingsSaved = {
    saved: true,
    changed: result.applied.changed,
    restart: result.applied.restart,
    notes: result.applied.notes,
    state: await stateOf(run, ctx),
  };
  return json(answer);
}

/** Null when the path is not one of Settings' routes: the caller falls through. */
export async function handleSettingsRoute(req: Request, ctx: SettingsRouteContext): Promise<Response | null> {
  const path = new URL(req.url).pathname;

  if (path === SETTINGS_PATHS.read && req.method === "GET") {
    return json(await stateOf(await open(ctx), ctx));
  }
  if (req.method !== "POST") return null;

  if (path === SETTINGS_PATHS.check) {
    const body = await readBody(req);
    const section = sectionOf(body.section);
    if (!section) return json({ error: NOT_A_SECTION }, 400);
    const run = await open(ctx);
    takeAnswers(run, section, body.answers);
    // On the host only, whatever the request asks: see the top of this file.
    const check = await run.check(section, { quick: true });
    return json({ derived: run.derived(), check } satisfies SettingsChecked);
  }

  if (path === SETTINGS_PATHS.save) {
    const body = await readBody(req);
    const section = sectionOf(body.section);
    if (!section) return json({ error: NOT_A_SECTION }, 400);
    // Before the person is asked anything: an HX Fortress that is not set up
    // takes no save, and a page that is behind is told so.
    const first = await open(ctx);
    const notSetUp = first.saveRefusal(section);
    if (notSetUp) return json({ saved: false, checks: [notSetUp] } satisfies SettingsSaved);
    const behind = staleSave(first, section, body.version);
    if (behind) return json(behind);
    // The person, once more, before anything is checked or written.
    const refused = await codeStep(ctx, section, body.code);
    if (refused) return json(refused);

    return oneAtATime(async () => {
      try {
        const run = await open(ctx);
        // Once more where saves wait for each other: one that ran meanwhile
        // changed what this page read.
        const overtaken = staleSave(run, section, body.version);
        if (overtaken) return json(overtaken);
        takeAnswers(run, section, body.answers);
        const result = await run.save(section, {
          audit: {
            // Around the checks and the writing: a save its checks refuse
            // writes nothing, and is recorded as refused.
            finish: async (_way, changed, _account, work) =>
              ctx.audit.pair(
                AUDIT_ACTIONS.settingsSaved,
                {
                  actor: ctx.actor,
                  sessionRef: ctx.sessionId,
                  params: {
                    ...recorded(section, changed, await run.restartOf(changed)),
                    ...(section === "signIn" ? signInRecorded(run.answers) : {}),
                  },
                },
                inOwnWords(work, NOT_SAVED),
              ),
          },
        });
        return await saved(result, ctx);
      } catch (error) {
        return failedSave(error, NOT_SAVED);
      }
    });
  }

  if (path === SETTINGS_PATHS.installId) {
    const body = await readBody(req);
    const id = body.id;
    // The value is not repeated: it is, or was meant to be, a credential.
    if (!isInstallId(id)) return json({ error: NOT_AN_INSTALL_ID }, 400);
    // Before the code, since no code changes them: an HX Fortress takes a new
    // id only for the control plane it names, and only once that control
    // plane refused the connection, as the daemon's own status says. A
    // connection that works needs no id, and an id taken then would enroll
    // this HX Fortress again at its next start, for whatever organization
    // issued the id.
    const run = await open(ctx);
    const named = run.saveRefusal("controlPlane") ?? run.installIdRefusal();
    if (named) return json({ saved: false, checks: [named] } satisfies SettingsSaved);
    if (!(await connectionOf(run, ctx)).refused) {
      return json({ saved: false, checks: [refusedAt("controlPlane", ID_ONLY_AFTER_REFUSAL)] } satisfies SettingsSaved);
    }
    const refused = await codeStep(ctx, "controlPlane", body.code);
    if (refused) return json(refused);

    return oneAtATime(async () => {
      const pending = new FilePendingEnrollmentStore(ctx.paths.pendingEnrollment);
      try {
        // Read again: a save that ran meanwhile is part of what is written.
        const now = await open(ctx);
        const result = await now.takeInstallId(id, {
          audit: {
            finish: async (_way, _changed, _account, work) =>
              ctx.audit.pair(
                AUDIT_ACTIONS.settingsInstallId,
                {
                  actor: ctx.actor,
                  sessionRef: ctx.sessionId,
                  params: recorded("controlPlane", ["controlPlane"], await now.restartOf(["controlPlane"])),
                },
                // The id must not be in the record of a failure either, so
                // only a refusal's sentence or this route's own is. The id is
                // the whole of this request, so a save that could not keep it
                // is a failure, not a note.
                inOwnWords(async () => {
                  const result = await work();
                  if (result.ok && (await pending.load().catch(() => null))?.token !== id) {
                    throw new Error(INSTALL_ID_NOT_SAVED);
                  }
                  return result;
                }, INSTALL_ID_NOT_SAVED),
              ),
          },
        });
        return await saved(result, ctx);
      } catch (error) {
        return failedSave(error, INSTALL_ID_NOT_SAVED);
      }
    });
  }

  return null;
}
