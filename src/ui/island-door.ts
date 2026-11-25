// The door of a Secure Data Island: everything this HX Fortress answers under
// `/island/`.
//
// A Secure Data Island is a small page that HX Fortress serves at its own
// address. A control plane's page shows it in a frame, and the person in front
// of it signs in here, at HX Fortress. What the control plane's page learns of
// it is a state, a count and a height.
//
//   GET  /island/v1/<file>     a page file, exactly as it is in the repository
//   GET  /island/v1/<page>     a page, also without `.html`
//   GET  /island/v1/config     what a page file reads of this HX Fortress
//
// `ISLAND_ROUTES` below is the whole list of what answers beside the files,
// and a test walks it.
//
// APART FROM THE CONSOLE. A request under `/island/` never reaches the
// console's gate, its routes or its sessions, and the console's own pages are
// never served here. Whatever this door does not have is a 404. The app shell
// that the console serves for any path it does not know is not served under
// `/island/`: a page that may be framed by nothing must not answer where a
// framed page is expected.
//
// ONE BUDGET, SPENT FIRST. Every request under `/island/` spends the same
// budget before anything is looked up, whether it then finds a file or not.
// It is not the console's: frames on another site's page and the console's
// own shell cannot use each other's up.
//
// THE PAGE FILES NEED NO SIGN-IN. They hold no data, and anyone may download
// one and compare it with the repository. `config` holds none either.
//
// WHO MAY FRAME A PAGE. Only a kind's own page may be shown in a frame, and
// only by the one origin that this HX Fortress's settings name. Every other
// page of the folder opens as a window of its own, and says so in its headers.
// While this HX Fortress shows no Secure Data Island (`islandsOpen`), no page
// may be framed at all.

import { ISLAND_FILES_PREFIX, type IslandFiles } from "./island-files";
import { islandsOpen, type IslandSettings } from "./island-settings";
import { oidcUsable } from "./oidc-config";
import { redactValue } from "./redact";
import { retryAfterHeader, withResponseHeaders } from "./response-headers";
import type { UiRuntime } from "./runtime";

/** True for a path that is this door's to answer, and never the console's. */
export function isIslandPath(pathname: string): boolean {
  return pathname === "/island" || pathname.startsWith("/island/");
}

// ── What answers ─────────────────────────────────────────────────────────────

export interface IslandRoute {
  method: "GET" | "POST";
  path: string;
  /** What the caller must hold: nothing, or the session of a Secure Data
   *  Island. */
  needs: "nothing" | "session";
}

const CONFIG_PATH = `${ISLAND_FILES_PREFIX}config`;

/**
 * Every route of the door beside the page files. THE WHOLE LIST: a path under
 * `/island/` that is neither a page file nor here is a 404. A test walks it
 * and asks for each route what it needs, as the console's own test does for
 * `PUBLIC_ROUTES`.
 */
export const ISLAND_ROUTES: readonly IslandRoute[] = [{ method: "GET", path: CONFIG_PATH, needs: "nothing" }];

// ── Headers ──────────────────────────────────────────────────────────────────

/** What a framed page asks of the frame it is shown in, and gives itself. The
 *  same words stand in contract.json, for the page around the frame. */
export const ISLAND_FRAME_SANDBOX = "allow-scripts allow-same-origin";

/** Everything a page of this folder may load, and where it may send: its own
 *  origin, and nothing else. There is no inline script and no inline style in
 *  any file, so the policy needs no hash. */
const ISLAND_CSP_BASE =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'";

/**
 * The policy of a page that a control plane's page may show in a frame.
 *
 * The page sandboxes itself, whatever the site around it does: it may run its
 * script and keep its own origin. It may not open a window, send a form, start
 * a download, show a dialog or move the tab it is shown in.
 */
export function framedPageCsp(pages: string | null): string {
  return `${ISLAND_CSP_BASE}; frame-ancestors ${pages ?? "'none'"}; sandbox ${ISLAND_FRAME_SANDBOX}`;
}

/** The policy of a page that opens as a window of its own, and of every other
 *  file and answer of this door. */
export const OWN_PAGE_CSP = `${ISLAND_CSP_BASE}; frame-ancestors 'none'`;

function finish(res: Response, csp: string, cache: "no-cache" | "no-store", hsts: boolean): Response {
  return withResponseHeaders(res, { csp, cache, hsts });
}

/**
 * An answer in JSON. Redacted on the way out like every answer the console
 * builds: nothing this door says before a sign-in is a credential, and a value
 * that looks like one is not said.
 */
function json(body: unknown, status: number, hsts: boolean, redact = true): Response {
  return finish(
    new Response(`${JSON.stringify(redact ? redactValue(body) : body)}\n`, { status, headers: { "content-type": "application/json" } }),
    OWN_PAGE_CSP,
    "no-store",
    hsts,
  );
}

function plain(text: string, status: number, hsts: boolean, extra: Record<string, string> = {}): Response {
  return finish(new Response(text, { status, headers: extra }), OWN_PAGE_CSP, "no-store", hsts);
}

/** The answer for everything under `/island/` that this door does not have. */
export function islandNotFound(hsts: boolean): Response {
  return plain("Not found", 404, hsts);
}

/** Whether a request's `If-None-Match` names this entity tag. */
function sameEntity(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header.split(",").some((part) => {
    const tag = part.trim();
    return tag === "*" || tag === etag || tag === `W/${etag}`;
  });
}

// ── The door ─────────────────────────────────────────────────────────────────

/** What the door serves from. One is built when the console starts. */
export interface IslandDoor {
  files: IslandFiles;
  /** This HX Fortress's settings for a Secure Data Island, as they are now. */
  settings: () => Promise<IslandSettings>;
}

export interface IslandRequestContext {
  /** Null on a console that serves no Secure Data Island, and for a path the
   *  caller refused: everything is then "not found", out of the same budget. */
  door: IslandDoor | null;
  runtime: UiRuntime;
  /** The key this caller's budgets are counted under: the runtime's one
   *  function made it, never the socket's address by itself. */
  remoteKey: string;
  /** True when the request arrived on an https host of this HX Fortress. */
  hsts: boolean;
}

/** What a page file reads from HX Fortress at run time (contract.json, "config"). */
export interface IslandConfigAnswer {
  v: 1;
  pages: string | null;
  organization: string | null;
  signIn: "account" | "provider";
}

/**
 * Answer one request under `/island/`. Always an answer: what this door does
 * not have is a 404.
 *
 * The caller has checked the request's `Host` against this HX Fortress's own
 * names.
 */
export async function handleIslandRequest(req: Request, ctx: IslandRequestContext): Promise<Response> {
  const { door, runtime, hsts } = ctx;

  const budget = runtime.take("islandFile", ctx.remoteKey);
  if (!budget.ok) return plain("Too many requests", 429, hsts, retryAfterHeader(budget.retryAfterMs));

  const path = new URL(req.url).pathname;
  if (door === null || !path.startsWith(ISLAND_FILES_PREFIX)) return islandNotFound(hsts);
  const reading = req.method === "GET" || req.method === "HEAD";

  if (path === CONFIG_PATH) {
    if (!reading) return plain("Method not allowed", 405, hsts, { allow: "GET, HEAD" });
    const [settings, oidc] = await Promise.all([door.settings(), runtime.readOidc().catch(() => null)]);
    // An HX Fortress that shows no Secure Data Island says nothing of itself
    // here: not its organization, and not how its people sign in.
    const open = islandsOpen(settings);
    const answer: IslandConfigAnswer = {
      v: 1,
      pages: settings.pages,
      organization: open ? settings.organization : null,
      signIn: open && oidc !== null && oidcUsable(oidc) ? "provider" : "account",
    };
    // Said as it is, and not redacted like the door's other answers. Each value is a constant,
    // an origin that `pagesOrigin` made, a name that `isOrganizationName` took, or one of two
    // words. The redaction would read a name such as "Token Security" as a credential.
    return json(answer, 200, hsts, false);
  }

  // A page file, by its name or, for a page, without `.html`. A lookup in a
  // map: the name is never joined onto a path.
  const file = door.files.byAddress.get(path.slice(ISLAND_FILES_PREFIX.length));
  if (!file) return islandNotFound(hsts);
  if (!reading) return plain("Method not allowed", 405, hsts, { allow: "GET, HEAD" });

  if (file.name.endsWith(".html")) {
    // A page is always sent whole, with the headers of this moment: who may
    // frame it can change while a browser still holds an earlier answer.
    const csp = door.files.framed.has(file.name) ? framedPageCsp((await door.settings()).pages) : OWN_PAGE_CSP;
    return finish(new Response(file.bytes, { headers: { "content-type": file.contentType } }), csp, "no-cache", hsts);
  }

  // Every other file is the bytes its checksum names, so a browser that holds
  // them is told so and is sent nothing again.
  const headers = { "content-type": file.contentType, etag: file.etag };
  if (sameEntity(req.headers.get("if-none-match"), file.etag)) {
    return finish(new Response(null, { status: 304, headers }), OWN_PAGE_CSP, "no-cache", hsts);
  }
  // The file as it is: nothing changes it or wraps it on the way.
  return finish(new Response(file.bytes, { headers }), OWN_PAGE_CSP, "no-cache", hsts);
}
