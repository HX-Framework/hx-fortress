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

/** The failures that are this HX Fortress's own state, and not about what was
 *  asked: it cannot record the act, the module is not running, or the key
 *  store does not answer. */
const NOT_NOW: ReadonlySet<string> = new Set([
  "failed:audit_unavailable",
  "failed:module_not_running",
  "failed:secret_unavailable",
]);
/** The failures that are a defect on this side. */
const BROKEN: ReadonlySet<string> = new Set(["reply_invalid", "failed:internal", "failed:request_invalid"]);

/**
 * The status a word is answered with. The word itself is in the body, and a
 * page goes by the word.
 *
 * A failure that the module or one of the host's lists named (`failed:` and a
 * word, such as `failed:name_taken` or `failed:reach_address_refused`) is
 * about what was asked: the request was understood and was not carried out.
 * It is a 422, and never a 5xx, which would read as this HX Fortress being
 * broken.
 */
export function actStatus(error: string): number {
  if (error === "args_invalid") return 400;
  if (error === "not_allowed") return 403;
  if (error === "act_unknown") return 404;
  if (error === "module_off") return 409;
  if (error === "busy" || error === DAEMON_UNREACHABLE || NOT_NOW.has(error)) return 503;
  if (error === "failed:timeout") return 504;
  // The daemon took the act and its answer never came whole.
  if (error === ACT_INTERRUPTED) return 502;
  if (BROKEN.has(error)) return 500;
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
  const answer = await ctx.door({
    v: 1,
    person: {
      login: ctx.session.userLogin,
      // A console session holds no email of the person today: an account on
      // this HX Fortress has none, and a sign-in through the identity
      // provider keeps the login and the provider's own id. So a module is
      // told there is none, and never a guess made from a login.
      email: null,
      role: ctx.session.role,
    },
    session: ctx.session.id,
    module: ctx.act.module,
    act: ctx.act.spec.name,
    args,
  });
  if (answer.ok) return json({ reply: answer.reply });
  return json({ error: answer.error }, actStatus(answer.error));
}
