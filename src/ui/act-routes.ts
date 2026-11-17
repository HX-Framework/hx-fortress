// A person's act: the one way from the console to a module.
//
//   POST /ui/api/modules/<module>/acts/<act>     body: { "args": { … } }
//
// An act is something a module's manifest says a signed-in person may have it
// do. The module lives in the daemon, so the console carries the act out
// nowhere: it hands the act to the daemon's door on this machine and shows the
// daemon's own answer (src/host/local-door.ts).
//
// WHICH ROUTES THERE ARE is not in the console's own route table. The catalog
// of this build says which acts exist, and the switch in config.json says
// which modules are on. An act is a route only while its module is switched
// on. For a module that is off, the path is judged like any path the console
// does not know, with the same answer. So an HX Fortress that has switched no
// such module on has not one route more than before.
//
// WHO MAY. The act's role decides its class, and the console's one gate
// enforces it like every other route's: an act that only operators may do is
// `mutate`, and a read-only person is answered with the server's own refusal.
// An act any signed-in person may do is `read`. The daemon checks the role
// again, and everything else about the act.
//
// WHAT IS RECORDED, AND BY WHOM. The daemon records every act it carries out
// for an operator and every act it turns away. The console records nothing
// of an act by itself. Of the console's own refusals one reaches the trail: a
// signed-in person who tried an act that their role may not do. The console
// answers that person as before and tells the daemon, which records the try
// under the person's login. The console's other refusals are not recorded,
// as they are not for any of its own routes: no sign-in, another site's
// page, too many requests, a body that is not JSON, a path that is no route.
//
// ONLY FOR A CALLER WHO IS SIGNED IN. The console's gate looks for an act only
// once the sign-in is checked (runtime.ts). A caller with no sign-in is
// answered as for any path the console does not know, before the switch is
// read. So such a caller cannot learn which acts exist, by an answer or by how
// long it takes, and cannot spend the budget of the operators' acts.
//
// For a signed-in caller, the path is read for its shape before anything is
// looked up, and the switch is read for every path that has the shape. So an
// act that exists and one that does not take the same work.

import { MODULE_CATALOG, type CatalogEntry } from "../host/module-catalog";
import { ACT_INTERRUPTED, DAEMON_UNREACHABLE, type ActRequest, type DoorAnswer } from "../host/local-door-client";
import { isAskName, isModuleId, type ActSpec } from "../host/module-contract";
import { redactValue } from "./redact";
import type { RouteSpec } from "./routes";
import type { UiSession } from "./sessions";
import { emailOf, opensConsole, type UiRole } from "./users";

const ACT_PATH = /^\/ui\/api\/modules\/([^/]+)\/acts\/([^/]+)$/;

/** The module and the act a path names, or null when it is not an act's path. */
export function parseActPath(pathname: string): { module: string; act: string } | null {
  const found = ACT_PATH.exec(pathname);
  if (!found) return null;
  const [, module, act] = found;
  if (!isModuleId(module) || !isAskName(act)) return null;
  return { module, act };
}

export function actPath(module: string, act: string): string {
  return `/ui/api/modules/${module}/acts/${act}`;
}

/** An act that is a route now. */
export interface ResolvedAct {
  module: string;
  spec: ActSpec;
  route: RouteSpec;
}

export interface ActRoutes {
  /** The act a request is for, when its module is switched on now. */
  resolve(method: string, pathname: string): Promise<ResolvedAct | null>;
  /** Every act that is a route now. */
  listed(): Promise<ResolvedAct[]>;
}

export interface ActRoutesOptions {
  /** The ids switched on in config.json, read now. Null when it cannot be read. */
  enabled: () => Promise<readonly string[] | null>;
  catalog?: readonly CatalogEntry[];
}

function routeOf(module: string, spec: ActSpec): RouteSpec {
  return spec.role === "operator"
    ? { method: "POST", path: actPath(module, spec.name), cls: "mutate", bucket: "moduleAct" }
    : // A read. Sent as a POST all the same, so it carries the Origin check
      // every write carries, and its arguments are never in an address.
      { method: "POST", path: actPath(module, spec.name), cls: "read" };
}

export function createActRoutes(options: ActRoutesOptions): ActRoutes {
  const catalog = options.catalog ?? MODULE_CATALOG;
  const on = async (): Promise<ReadonlySet<string>> => {
    // A switch that cannot be read switches nothing on.
    const enabled = await options.enabled().catch(() => null);
    return new Set(enabled ?? []);
  };
  return {
    async resolve(method, pathname) {
      const named = parseActPath(pathname);
      if (!named) return null;
      const enabled = await on();
      if (method !== "POST" || !enabled.has(named.module)) return null;
      const entry = catalog.find((candidate) => candidate.id === named.module);
      const spec = entry?.manifest?.acts?.find((candidate) => candidate.name === named.act);
      return spec ? { module: named.module, spec, route: routeOf(named.module, spec) } : null;
    },
    async listed() {
      const enabled = await on();
      return catalog.flatMap((entry) =>
        enabled.has(entry.id)
          ? (entry.manifest?.acts ?? []).map((spec) => ({ module: entry.id, spec, route: routeOf(entry.id, spec) }))
          : [],
      );
    },
  };
}

/** How the console hands an act to the daemon. */
export type ActDoor = (request: ActRequest) => Promise<DoorAnswer>;

export interface ActRouteContext {
  door: ActDoor;
  act: ResolvedAct;
  session: UiSession;
}

function json(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(redactValue(body))}\n`, {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Whether a failure is this HX Fortress's own state, and not about what was
 * asked: it cannot record the act, the module is not running, the key store
 * does not answer, or one of its own files cannot be read. The same request
 * may work later, and nothing about it needs to change.
 *
 * THE RULE IS IN THE WORD. `failed:module_not_running`, and every failure
 * whose word ends in `_unavailable` or `_unreadable`: the host's own
 * (`audit_unavailable`, `secret_unavailable`, `reach_list_unreadable`,
 * `secret_names_unreadable`) and any that a module names that way
 * (`state_unreadable`).
 */
function notNow(error: string): boolean {
  return error === "failed:module_not_running" || /^failed:[a-z0-9_]*_(?:unavailable|unreadable)$/.test(error);
}

/** The failures that are a defect on this side: of the console, of the
 *  daemon, or of a module that did what its own manifest does not allow. */
const BROKEN: ReadonlySet<string> = new Set([
  "reply_invalid",
  "failed:internal",
  "failed:request_invalid",
  // The module asked for a secret that neither its manifest nor a person named.
  "failed:secret_not_declared",
  // An act for every signed-in person tried to change one of the two lists.
  "failed:not_allowed",
  // The module asked for a folder of an organization this HX Fortress does not hold.
  "failed:organization_not_held",
]);
/** And every refusal of a call or of a folder that the module's manifest does
 *  not allow, and of a process the host did not start: `egress_*`, `folder_*`
 *  and `process_*`. A process in a folder that the module did not make is
 *  `folder_missing`, and is one of them. A module that runs as many processes
 *  as it may is `processes_unavailable`, which is no defect: it ends in
 *  `_unavailable`, and `notNow` answers it first. */
const BROKEN_PREFIXES = ["failed:egress_", "failed:folder_", "failed:process_"] as const;

/**
 * The status a word is answered with. The word itself is in the body, and a
 * page goes by the word.
 *
 * A failure that the module or one of the host's lists named (`failed:` and a
 * word, such as `failed:name_taken` or `failed:reach_address_refused`) is
 * about what was asked: the request was understood and was not carried out.
 * It is a 422, and never a 5xx, which would read as this HX Fortress being
 * broken. The failures that ARE this HX Fortress's own are a 503 when the same
 * request may work later, and a 500 when something on this side is wrong.
 */
export function actStatus(error: string): number {
  if (error === "args_invalid") return 400;
  if (error === "not_allowed") return 403;
  if (error === "act_unknown") return 404;
  if (error === "module_off") return 409;
  if (error === "busy" || error === DAEMON_UNREACHABLE || notNow(error)) return 503;
  if (error === "failed:timeout") return 504;
  // The daemon took the act and its answer never came whole.
  if (error === ACT_INTERRUPTED) return 502;
  if (BROKEN.has(error) || BROKEN_PREFIXES.some((prefix) => error.startsWith(prefix))) return 500;
  if (error.startsWith("failed:")) return 422;
  return 500;
}

/**
 * Hand one act to the daemon and show its answer: `{ reply }`, or `{ error }`
 * with one word.
 *
 * The gate has checked the person's sign-in, the act's class against the
 * person's role, the rate and the Origin before this is called.
 */
export async function handleActRoute(req: Request, ctx: ActRouteContext): Promise<Response> {
  // The console's gate has refused such a person before this is called. This
  // is the same rule, held here as well: nothing is read, and the daemon is
  // not called.
  if (actRoleOf(ctx.session.role) === null) return json({ error: "not_allowed" }, 403);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "args_invalid" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: "args_invalid" }, 400);
  }
  const args: unknown = (body as { args?: unknown }).args ?? {};
  const request = requestOf(ctx, args);
  if (request === null) return json({ error: "not_allowed" }, 403);
  let answer: DoorAnswer;
  try {
    answer = await ctx.door(request);
  } catch {
    // The way to the daemon answers for every failure by itself. This is for
    // what was not foreseen: what was thrown is not shown, and whether the
    // act was carried out is not known.
    answer = { ok: false, error: "failed:internal" };
  }
  if (answer.ok) return json({ reply: answer.reply });
  return json({ error: answer.error }, actStatus(answer.error));
}

/**
 * The role a person does acts with, or null for a person the console opens
 * nothing for.
 *
 * An act knows two roles. A Viewer is neither: a Viewer sees rows in a Secure
 * Data Island and does nothing in the console, and the console makes no
 * session for one. A role that a later build adds and opens the console for
 * does what every signed-in person may do, and no more, until it is named
 * here.
 */
function actRoleOf(role: UiRole): ActRequest["person"]["role"] | null {
  if (!opensConsole(role)) return null;
  return role === "operator" ? "operator" : "readonly";
}

/** What the console hands the daemon for one act of one person. Null for a
 *  person who does no acts. */
function requestOf(ctx: ActRouteContext, args: unknown): ActRequest | null {
  const role = actRoleOf(ctx.session.role);
  if (role === null) return null;
  return {
    v: 1,
    person: {
      login: ctx.session.userLogin,
      // The person's email is their login, when that login is an email
      // address: the address of an account on this HX Fortress, or the one an
      // identity provider vouches for. A login of any other kind gives none,
      // and never a guess made from it.
      email: emailOf(ctx.session.userLogin),
      role,
    },
    session: ctx.session.id,
    module: ctx.act.module,
    act: ctx.act.spec.name,
    args,
  };
}

/** How long the console waits for the daemon to take the word of a refused
 *  try. The person is answered after it either way. */
export const REFUSED_ACT_REPORT_MS = 2_000;

/**
 * Tell the daemon that a signed-in person tried an act that their role may
 * not do, so that the try is in the audit trail under the person's login.
 *
 * The console has refused the person already, and what the daemon answers is
 * not used. The act is handed over with who the person is and WITHOUT the
 * person's arguments: the daemon turns it away by the role, before it looks
 * at any argument, and nothing of what was asked for needs to cross.
 *
 * Never rejects, and never waits long: a daemon that is stopped or slow does
 * not hold up the refusal.
 */
export async function reportRefusedAct(ctx: ActRouteContext, waitMs: number = REFUSED_ACT_REPORT_MS): Promise<void> {
  const request = requestOf(ctx, {});
  if (request === null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Inside a promise from its first step, so that a way to the daemon that
  // throws is a rejection like any other.
  const told = Promise.resolve()
    .then(() => ctx.door(request))
    .then(
      () => undefined,
      () => undefined,
    );
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
  });
  try {
    await Promise.race([told, waited]);
  } finally {
    clearTimeout(timer);
  }
}
