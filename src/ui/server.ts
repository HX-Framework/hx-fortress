// The console's HTTP surface: a pure request handler plus a thin Bun.serve
// shell. Everything stateful rides in a context object, so the handler is
// unit-testable with plain Request values.
//
// Everything served here is data-free by construction — the app shell, its
// content-hashed assets, and a bare liveness probe. Nothing is authenticated
// because nothing here is private, and nothing here discloses the fortress
// either: no version, no org, no configuration. A peer that reaches the port
// before signing in learns that a console is listening and nothing else.
//
//   GET  /            → index.html
//   GET  /<view>      → index.html   (the app owns its routes; a cold deep link
//                                     must land where it says)
//   GET  /assets/*    → embedded static files
//   GET  /fonts/*     → embedded static files
//   GET  /healthz     → 200, empty    (platform health checks)
//   GET  /ui/api/instance → the identity handshake, loopback peers only
//   /ui/api/*         → 404 until a route claims it — an API namespace must
//                       never answer a fetch with the HTML shell
//
// The Host allowlist is enforced in the serve shell rather than here, because it
// re-reads ui.json per request and this handler is deliberately synchronous and
// stateless. /healthz and the instance handshake are exempt from THAT check
// alone: both answer before any name for this console exists. The handshake
// still passes the gate, so its meter and its loopback rule are the gate's like
// every other route's; /healthz passes nothing at all, deliberately — a platform
// probe that could be starved, or that could fail because a configuration file
// did not parse, is not a health check.

import type { Server } from "bun";
import { contentTypeFor, type UiAssets } from "./assets";
import { EVENTS_IDLE_TIMEOUT_S } from "./events";
import type { ConsoleAudit } from "./audit-writer";
import { handleAuthRoute } from "./auth-routes";
import { handleMutateRoute, type ConsoleWritePort } from "./mutate-routes";
import { handleReadRoute, type ConsoleExportAudit, type ConsoleReadPort } from "./read-routes";
import { normalizeAddress } from "./remote-key";
import { redactedMessage } from "./redact";
import { INSTANCE_PROBE_IDENTITY } from "./routes";
import type { UiRuntime } from "./runtime";

export interface UiServerCtx {
  assets: UiAssets;
  /** The bound port — echoed nowhere, held for the checks that arrive with auth. */
  port: number;
  /** Sessions, buckets, and the live view of ui.json. Absent in the asset-only
   *  unit tests, which is why every use below is guarded. */
  runtime?: UiRuntime;
  /** The console's read surface. Absent until the daemon plane is wired, in
   *  which case those paths answer 404 to a signed-in caller and 401 to
   *  everyone else - never the app shell. */
  read?: { port: ConsoleReadPort; audit: ConsoleExportAudit };
  /** The console's write surface. Absent in the asset-only unit tests; the gate
   *  has already refused a readonly session before anything here is reached. */
  write?: { write: ConsoleWritePort };
  /** The spool writer. Absent in the asset-only unit tests, where nothing
   *  authenticates and so nothing is recorded. */
  audit?: ConsoleAudit;
}

// script-src carries exact hashes of any inline script in the shell instead of
// 'unsafe-inline'; style-src keeps 'unsafe-inline' for React style attributes —
// standard, and styles cannot exfiltrate. form-action 'none' is safe because the
// app posts with fetch and never navigates a form.
export function cspFor(inlineScriptHashes: string[]): string {
  const scriptSrc = ["'self'", ...inlineScriptHashes].join(" ");
  return (
    `default-src 'self'; script-src ${scriptSrc}; ` +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; font-src 'self'; base-uri 'none'; " +
    "frame-ancestors 'none'; form-action 'none'"
  );
}

function finish(res: Response, cache: string, csp: string, hsts = false): Response {
  res.headers.set("content-security-policy", csp);
  res.headers.set("x-content-type-options", "nosniff");
  res.headers.set("referrer-policy", "no-referrer");
  res.headers.set("cache-control", cache);
  // Sent only where the request actually arrived over https. Asserting it on a
  // plain-http console would pin a browser to a scheme that console cannot serve.
  if (hsts) res.headers.set("strict-transport-security", "max-age=31536000");
  return res;
}

/** Content-hashed names may be cached forever; the shell that names them may not. */
export function cacheControlFor(assetPath: string): string {
  if (assetPath === "/index.html") return "no-cache";
  if (assetPath.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}

/** The request target as it arrived, before URL parsing normalizes `..` away.
 *  Bun resolves dot segments itself, so this is a belt for anything that hands
 *  the handler a target it did not resolve. */
export function rawRequestPath(requestUrl: string): string {
  const afterScheme = requestUrl.indexOf("://");
  const authorityStart = afterScheme < 0 ? 0 : afterScheme + 3;
  const pathStart = requestUrl.indexOf("/", authorityStart);
  if (pathStart < 0) return "/";
  const end = requestUrl.slice(pathStart).search(/[?#]/);
  return end < 0 ? requestUrl.slice(pathStart) : requestUrl.slice(pathStart, pathStart + end);
}

/**
 * True for a path that must 404 rather than fall through to the shell.
 *
 * Traversal cannot READ anything — the lookup is a map, never a path join — but
 * answering `/../../etc/passwd` with a 200 shell would still tell a scanner the
 * traversal was accepted, and would hide a genuinely missing asset behind an
 * HTML page the browser then fails to parse as JS. Checked against the raw
 * target as well as the parsed pathname: dot segments are resolved before the
 * handler runs, so what still arrives are the ENCODED shapes that survive
 * normalization (%2f, %5c, malformed escapes) — those must not be decoded into
 * a lookup key. Nothing here is what makes traversal impossible; the map is.
 */
export function isTraversal(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true; // malformed escapes are never a route
  }
  if (!decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0")) return true;
  return decoded.split("/").some((seg) => seg === "." || seg === "..");
}

/** A request for a file, not for a view: it must 404 when the file is missing. */
export function looksLikeAsset(pathname: string): boolean {
  if (pathname.startsWith("/assets/") || pathname.startsWith("/fonts/")) return true;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return last.includes(".");
}

/** Reserved for the console's own API; never served from the asset map. */
const API_PREFIX = "/ui/api/";

/**
 * The ceiling on a request body, enforced by the server before a handler runs.
 *
 * Every body the console reads is small control-plane JSON — a login, a password,
 * a grant, a command's parameters — and the largest of them is a JWT. Without a
 * stated ceiling the runtime default applies, which lets an unauthenticated
 * caller make this process buffer megabytes per request on the one route that
 * answers before a session exists.
 */
export const MAX_REQUEST_BODY_BYTES = 256 * 1024;

/** The identity handshake. Enumerated in the public route set, never audited. */
export const INSTANCE_PROBE_PATH = "/ui/api/instance";

/** The handshake and the health probe answer before this console has a name, so
 *  neither can be gated on the Host allowlist. Exemption from the ALLOWLIST
 *  only — see UNGATED_PATH for the one route that skips the gate as well. */
export const HOST_EXEMPT_PATHS: ReadonlySet<string> = new Set(["/healthz", INSTANCE_PROBE_PATH]);

/** The single route that reaches the handler without a verdict. It is
 *  deliberately unmetered (BUCKETS names no bucket for it) and deliberately
 *  independent of ui.json, because a platform health check runs on its own
 *  schedule and must answer while the console is refusing everything else. */
export const UNGATED_PATH = "/healthz";

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Fail CLOSED on an unknown peer: without an address there is no proof the
 *  caller is local, and the handshake exists only for a local caller. */
export function isLoopbackPeer(peer: string | undefined): boolean {
  return peer !== undefined && LOOPBACK_PEERS.has(normalizeAddress(peer));
}

export function handleUiRequest(req: Request, ctx: UiServerCtx, peer?: string): Response {
  const url = new URL(req.url);
  const path = url.pathname;
  const csp = cspFor(ctx.assets.inlineScriptHashes);

  if (isTraversal(rawRequestPath(req.url)) || isTraversal(path)) {
    return finish(new Response("Not found", { status: 404 }), "no-store", csp);
  }

  if (path === "/healthz") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return finish(new Response(null, { status: 405 }), "no-store", csp);
    }
    // Read by the workbench interstitial before it navigates the owner here, so
    // the status must be readable cross-origin. The body is empty and the route
    // is already public, so a readable 200 discloses nothing an opaque timing
    // probe would not.
    const res = finish(new Response(null, { status: 200 }), "no-store", csp);
    res.headers.set("access-control-allow-origin", "*");
    return res;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return finish(new Response("Method not allowed", { status: 405 }), "no-store", csp);
  }

  // An identity handshake and nothing else: no version, no org, no token, and no
  // reissue of anything. It exists so a console refusing a busy port can say
  // whether the occupant is another console or a stranger.
  if (path === INSTANCE_PROBE_PATH) {
    if (!isLoopbackPeer(peer)) {
      return finish(new Response("Not found", { status: 404 }), "no-store", csp);
    }
    return finish(
      new Response(`${JSON.stringify(INSTANCE_PROBE_IDENTITY)}\n`, {
        headers: { "content-type": "application/json" },
      }),
      "no-store",
      csp,
    );
  }

  // Map lookup only — a request path is never joined onto the filesystem, and
  // every key starts with "/" so it cannot reach Object.prototype either.
  const assetPath = path === "/" ? "/index.html" : path;
  const filePath = Object.hasOwn(ctx.assets.files, assetPath)
    ? ctx.assets.files[assetPath]
    : undefined;
  if (filePath) {
    return finish(
      new Response(Bun.file(filePath), {
        headers: { "content-type": contentTypeFor(assetPath) },
      }),
      cacheControlFor(assetPath),
      csp,
    );
  }

  if (looksLikeAsset(path) || path.startsWith(API_PREFIX)) {
    return finish(new Response("Not found", { status: 404 }), "no-store", csp);
  }

  // Every other path is a view. The app parses it and renders from there, so a
  // cold load of any deep link lands exactly where the link says.
  const index = ctx.assets.files["/index.html"];
  if (!index) return finish(new Response("Not found", { status: 404 }), "no-store", csp);
  return finish(
    new Response(Bun.file(index), { headers: { "content-type": contentTypeFor("/index.html") } }),
    cacheControlFor("/index.html"),
    csp,
  );
}

/**
 * Bind and serve. `hostname` is 127.0.0.1 unless the bind rule widened it; a
 * container without IPv6 cannot bind "::", so that retries as IPv4-only rather
 * than leaving the console down.
 *
 * The Host allowlist is checked HERE, per request, against a live re-read of
 * ui.json — so `ui config set publicUrl` lands on a running unit with no restart,
 * and so a name nobody configured never reaches a handler. Without it, an
 * attacker who points a hostname of their own at this address gets a same-origin
 * page in a victim's browser, and same-origin policy is on their side.
 */
export function startUiServer(
  ctx: UiServerCtx,
  hostname: string,
  fallbackHostname?: string,
): Server<undefined> {
  const csp = cspFor(ctx.assets.inlineScriptHashes);
  const answer = async (req: Request, peer: string | undefined): Promise<Response> => {
    const runtime = ctx.runtime;
    const path = new URL(req.url).pathname;
    if (!runtime || path === UNGATED_PATH) return handleUiRequest(req, ctx, peer);
    const config = await runtime.readConfig();
    let hsts = false;
    if (!HOST_EXEMPT_PATHS.has(path)) {
      const host = runtime.hostCheck(req, config, ctx.port);
      if (!host.ok) {
        return finish(new Response(host.reason, { status: 400 }), "no-store", csp);
      }
      hsts = host.scheme === "https";
    }

    // The gate decides everything — bucket, loopback rule, session, role, Origin.
    // No handler below it re-decides any of that, and nothing reaches a handler
    // without a verdict.
    const verdict = await runtime.authorize(req, peer ?? "", ctx.port);
    if (!verdict.ok) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (verdict.retryAfterMs !== undefined) {
        headers["retry-after"] = String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000)));
      }
      return finish(
        new Response(`${JSON.stringify({ error: verdict.reason })}\n`, {
          status: verdict.status,
          headers,
        }),
        "no-store",
        csp,
        hsts,
      );
    }

    const authenticated = await handleAuthRoute(req, {
      runtime,
      remoteKey: verdict.remoteKey,
      remoteAddr: peer ?? "",
      ...(ctx.audit ? { audit: ctx.audit } : {}),
    });
    if (authenticated) return finish(authenticated, "no-store", csp, hsts);

    if (ctx.write && ctx.audit && verdict.session) {
      const mutated = await handleMutateRoute(req, {
        port: ctx.write.write,
        audit: ctx.audit,
        actor: verdict.session.userLogin,
        sessionId: verdict.session.id,
      });
      if (mutated) return finish(mutated, "no-store", csp, hsts);
    }

    if (ctx.read && verdict.session) {
      const read = await handleReadRoute(req, {
        port: ctx.read.port,
        audit: ctx.read.audit,
        actor: verdict.session.userLogin,
        sessionId: verdict.session.id,
        streams: runtime.streams,
      });
      // An event stream is a live body: finish() would set cache headers on a
      // response that is already flowing, and the CSP belongs to documents.
      if (read) {
        if (read.headers.get("content-type") === "text/event-stream") return read;
        return finish(read, "no-store", csp, hsts);
      }
    }

    const response = handleUiRequest(req, ctx, peer);
    if (hsts) response.headers.set("strict-transport-security", "max-age=31536000");
    return response;
  };
  /**
   * Nothing thrown out of a handler reaches the runtime's own error page. Bun's
   * default one is 67 KB of HTML carrying the exception message, the throwing
   * source lines and absolute filesystem paths — served to whoever made the
   * request, and reachable post-auth from the READONLY class. It also bypassed
   * `redact.ts` entirely, falsifying its "every value that leaves the console
   * goes through here". Both belts are worn: this catch, and `development:
   * false` so an escape at any other layer is still a bare 500.
   */
  const answerSafely = async (req: Request, peer: string | undefined): Promise<Response> => {
    try {
      return await answer(req, peer);
    } catch (err) {
      return finish(
        new Response(`${JSON.stringify({ error: redactedMessage(err) })}\n`, {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
        "no-store",
        csp,
      );
    }
  };

  const serveOn = (host: string): Server<undefined> => {
    try {
      return Bun.serve({
        hostname: host,
        port: ctx.port,
        maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
        // The live feed is a long-lived SSE stream that is idle between
        // heartbeats; Bun's default idleTimeout (10s) is shorter than the
        // heartbeat and closed every one of them mid-stream. See
        // EVENTS_IDLE_TIMEOUT_S — it is derived from the heartbeat on purpose.
        idleTimeout: EVENTS_IDLE_TIMEOUT_S,
        // NODE_ENV is set nowhere on the container path, and Bun's default is a
        // development error page. Stated here rather than inherited.
        development: false,
        fetch: (req, server) => answerSafely(req, server.requestIP(req)?.address),
        error: (err: Error): Response =>
          new Response(`${JSON.stringify({ error: redactedMessage(err) })}\n`, {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      });
    } catch (err) {
      if (fallbackHostname && host !== fallbackHostname) return serveOn(fallbackHostname);
      throw err;
    }
  };
  return serveOn(hostname);
}
