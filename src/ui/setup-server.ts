// The one-time browser setup: the HTTP surface of `hx-fortress setup --browser`.
//
// THIS IS NOT THE CONSOLE. The console is a long-running service with accounts
// and sessions, and no route of it changes a setting. This is a separate
// listener that exists only while a person on the host runs the setup on a
// Fortress that has never been set up. It serves the same pages (the setup's
// screens are part of the console's own app) and a handful of routes of its
// own, and when the setup ends it stops listening.
//
// THE LINK IS THE CREDENTIAL, and it works once. The link carries a token in
// its fragment, so the token never reaches a request line, a log or a Referer.
// The first browser to present it gets a session secret in return, and the
// token is dead from then on: a second browser that opens the same link is
// refused. Every other route needs that session secret in a header. Nothing
// here sets a cookie, so no other site can ride on a session.
//
// WHAT A HOLDER OF THE LINK CAN DO is exactly what the setup does: answer the
// setup's questions for this Fortress, have each answer checked, and write them
// down. The answers decide who can sign in, where data rests and which control
// plane directs the work, so the link is as strong as a shell on this host. It
// is printed to a terminal on the host, or kept in a file only the Fortress's
// own user can read. It is never printed to a log.
//
// THAT INCLUDES WHERE A KEY IS SENT. An answer names a key and an address, and
// a check uses the key as the Fortress will: the model's key goes to the
// model's address, and a database is opened at the address its key holds. So a
// holder of the link can make this host send a named key to an https address
// of their choosing, by answering so. That is the same power the finished
// answers give the running Fortress, and it is why the link is held as a
// shell is.
//
// WHAT NO REPLY CARRIES: a key's value, anything the Fortress stores, or what
// an outside service answered. A check says "Found", or a status, and no more.
// An address a holder types is called only as that question's check calls it:
// https, or this host itself.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Server } from "bun";

import type { StepCheck } from "../setup/checks";
import { STEP_IDS, type StepId } from "../setup/list";
import type { FinishResult, SetupFrame, SetupRun } from "../setup/run";
import type { SetupDone, SetupState } from "../setup/view";

export type { SetupDone } from "../setup/view";
import type { UiAssets } from "./assets";
import { redactedMessage } from "./redact";
import { buildHostAllowlist, checkHost, checkOrigin, type HostAllowlist } from "./origin";
import { cspFor, handleUiRequest, MAX_REQUEST_BODY_BYTES } from "./server";
import { FORTRESS_SETUP_API, SETUP_SESSION_HEADER } from "./wire";

const SETUP_API = FORTRESS_SETUP_API;

/** How many refused links are written to the audit trail in ten minutes. The
 *  token is 256 random bits, so no count is what makes it unguessable, and no
 *  count ever stands between the right link and its session: a peer that sends
 *  wrong links cannot lock the person with the right one out. The count keeps
 *  a flood from filling the trail. Past it a wrong link is still refused, and
 *  not recorded. */
const REFUSALS_RECORDED = 10;
const REFUSALS_WINDOW_MS = 10 * 60_000;

/** How long the listener stays after the answers are written, for the page to
 *  say that the last screen arrived. That screen holds the first
 *  administrator's one-time link, which cannot be asked for twice. */
const DONE_GRACE_MS = 20_000;

/** A request may run for as long as the checks behind it. Each outside call
 *  has its own deadline, and Finish makes them one after another, so the sum
 *  is far past the server's default of ten seconds. A connection cut in the
 *  middle of Finish would lose the last screen while the host goes on writing. */
const IDLE_TIMEOUT_S = 255;

/** How many checks, enrollments and endings one session may ask for in a minute.
 *  Each can make this host call an address the holder typed. */
const CALLS_PER_MINUTE = 240;

export interface SetupLink {
  /** The token that goes into the link's fragment. Shown once, never stored. */
  token: string;
  digest: Buffer;
}

export function mintSetupLink(): SetupLink {
  const token = randomBytes(32).toString("base64url");
  return { token, digest: createHash("sha256").update(token).digest() };
}

/** The link a person opens. The token rides the fragment. */
export function setupLinkUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/setup#s=${token}`;
}

export interface SetupServerCtx {
  assets: UiAssets;
  port: number;
  run: SetupRun;
  link: SetupLink;
  /** The bind address and the console's public address, for the Host check. */
  bind: string;
  publicUrl: string | null;
  /** Ends the setup: checks everything once more and writes it down. */
  finish: () => Promise<FinishResult>;
  /** Builds what the last screen shows, after a finish that wrote. */
  done: (result: Extract<FinishResult, { ok: true }>) => SetupDone;
  /** Called once the answers are written and the last response is on its way. */
  onDone: () => void;
  onOpened?: (remote: string) => void | Promise<void>;
  onLinkRefused?: (remote: string, attempts: number) => void | Promise<void>;
  now?: () => number;
  /** How long the listener waits for the page's word that the last screen
   *  arrived. Shortened in tests. */
  doneGraceMs?: number;
}

interface SessionState {
  /** sha256 of the session secret. The secret itself is held by the tab. */
  digest: Buffer | null;
  refusals: number[];
  calls: number[];
  frame: SetupFrame | null;
  done: SetupDone | null;
  /** The end of the setup, while it runs. There is one at a time. */
  finishing: Promise<FinishResult> | null;
}

function digestOf(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function sameDigest(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isStepId(value: unknown): value is StepId {
  return typeof value === "string" && (STEP_IDS as readonly string[]).includes(value);
}

/**
 * Take the answers a page sends. Every value goes through the run's own `set`,
 * one path at a time: a path that names no answer is dropped, a value of the
 * wrong kind is dropped, and an answer the host's environment decides is left
 * as it is. So a page cannot add a key to the answers or change a field's type,
 * whatever it sends.
 */
export function takeAnswers(run: SetupRun, incoming: unknown): void {
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > 4) return;
    if (typeof node === "string" || typeof node === "boolean" || Array.isArray(node)) {
      run.set(path, node);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue;
      walk(value, path ? `${path}.${key}` : key, depth + 1);
    }
  };
  walk(incoming, "", 0);
}

export interface SetupRequestHandler {
  /** Answers one request, or null when the path is not one of the setup's. */
  handle(req: Request, peer: string | undefined): Promise<Response | null>;
  /** True once the answers are written. */
  finished(): boolean;
}

export function createSetupHandler(ctx: SetupServerCtx): SetupRequestHandler {
  const now = ctx.now ?? Date.now;
  const state: SessionState = { digest: null, refusals: [], calls: [], frame: null, done: null, finishing: null };
  let closed = false;
  let wait: ReturnType<typeof setTimeout> | null = null;
  /** Tell the caller that the setup is over. Once. The wait for the page's
   *  word ends with it: a timer left behind would keep the process alive after
   *  the setup has ended. */
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (wait) clearTimeout(wait);
    wait = null;
    ctx.onDone();
  };
  const allow: HostAllowlist = buildHostAllowlist({ bind: ctx.bind, port: ctx.port, publicUrl: ctx.publicUrl });

  /** Drop what is older than the window, and say whether one more fits. */
  const within = (stamps: number[], limit: number, windowMs: number): boolean => {
    const cutoff = now() - windowMs;
    while (stamps.length > 0 && (stamps[0] as number) <= cutoff) stamps.shift();
    if (stamps.length >= limit) return false;
    stamps.push(now());
    return true;
  };

  const signedIn = (req: Request): boolean => {
    const presented = req.headers.get(SETUP_SESSION_HEADER) ?? "";
    return state.digest !== null && presented.length > 0 && sameDigest(digestOf(presented), state.digest);
  };

  /** Everything a page needs to draw itself. Sent once, when it loads. */
  const view = async (): Promise<SetupState> => {
    state.frame ??= await ctx.run.frame();
    return { frame: state.frame, answers: ctx.run.answers, derived: ctx.run.derived() };
  };
  /** What changes with the answers. Sent with every other reply. */
  const derived = (): Pick<SetupState, "derived"> => ({ derived: ctx.run.derived() });

  return {
    finished: () => state.done !== null,
    async handle(req, peer) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (!path.startsWith(`${SETUP_API}/`)) return null;
      const route = path.slice(SETUP_API.length + 1);
      const remote = peer ?? "unknown";

      // Every route here is a write, or reads what only the holder may read.
      // So every one is held to the Host the request arrived on and, for a
      // write, to the page's own origin.
      const host = checkHost(req.headers.get("host"), allow);
      if (!host.ok) return json({ error: "This address is not one this setup answers on" }, 400);
      if (req.method !== "GET") {
        const origin = checkOrigin(req.headers.get("origin"), host);
        if (!origin.ok) return json({ error: "This request did not come from the setup's own page" }, 403);
      }

      // ── Opening the link ────────────────────────────────────────────────────
      if (route === "open" && req.method === "POST") {
        // The token is looked at first, whatever else was tried before: nothing
        // another peer does stands between the right link and its session.
        const token = (await readBody(req)).token;
        const right = typeof token === "string" && token.length <= 128 && sameDigest(digestOf(token), ctx.link.digest);
        if (right && state.digest === null) {
          const session = randomBytes(32).toString("base64url");
          state.digest = digestOf(session);
          await ctx.onOpened?.(remote);
          return json({ session });
        }
        if (within(state.refusals, REFUSALS_RECORDED, REFUSALS_WINDOW_MS)) {
          await ctx.onLinkRefused?.(remote, state.refusals.length);
        }
        if (!right) return json({ error: "This is not this Fortress's setup link" }, 401);
        return json(
          {
            error:
              "This setup link was already opened, and a link works once. " +
              "If that was not you, stop the setup on the host and start it again: nothing has been saved",
          },
          410,
        );
      }

      if (!signedIn(req)) return json({ error: "Open the setup link that the host printed" }, 401);

      // After the end two things are left: what the last screen shows, and the
      // page's word that the screen arrived, on which the listener stops.
      if (state.done) {
        if (route === "state" && req.method === "GET") return json({ done: state.done });
        if (route === "seen" && req.method === "POST") {
          queueMicrotask(close);
          return json({ ok: true });
        }
        return json({ error: "Setup is closed. To change an answer, run `hx-fortress setup` on the host" }, 410);
      }

      if (route === "state" && req.method === "GET") return json(await view());

      if (req.method !== "POST") return json({ error: "Not found" }, 404);
      if (!within(state.calls, CALLS_PER_MINUTE, 60_000)) {
        return json({ error: "Too many requests. Wait a moment" }, 429, { "retry-after": "5" });
      }

      if (route === "finish") {
        // One end at a time. The answers are taken when it begins; a second
        // request while it runs gets the same result and changes nothing.
        if (!state.finishing) {
          const body = await readBody(req);
          if (body.answers !== undefined) takeAnswers(ctx.run, body.answers);
          state.finishing ??= ctx.finish().finally(() => {
            state.finishing = null;
          });
        }
        const result = await state.finishing;
        if (!result.ok) return json({ ...derived(), checks: result.checks });
        state.done ??= ctx.done(result);
        // The session ends with the setup. The listener stops when the page
        // says that the last screen arrived, or after a short wait.
        if (!closed) wait ??= setTimeout(close, ctx.doneGraceMs ?? DONE_GRACE_MS);
        return json({ done: state.done });
      }

      // While the answers are being written, no other request may change them
      // or start a check that reads them half-written.
      if (state.finishing) return json({ error: "The setup is being saved" }, 409);
      const body = await readBody(req);
      if (body.answers !== undefined) takeAnswers(ctx.run, body.answers);

      if (route === "check") {
        const step = body.step;
        // `all` is what the review asks: every question's check, in order.
        if (step === "all") return json({ ...derived(), checks: await ctx.run.checkAll() });
        // `quick` is the check made while a person still types: no request
        // leaves this host for it.
        const check: StepCheck | null = isStepId(step)
          ? await ctx.run.check(step, { quick: body.quick === true })
          : null;
        return json({ ...derived(), check });
      }

      if (route === "enroll") {
        try {
          await ctx.run.enroll();
        } catch (error) {
          return json({ ...derived(), error: redactedMessage(error) });
        }
        return json({ ...derived(), check: await ctx.run.check("controlPlane") });
      }

      if (route === "enroll/check") {
        await ctx.run.enrollCheck();
        return json({ ...derived(), check: await ctx.run.check("controlPlane") });
      }

      return json({ error: "Not found" }, 404);
    },
  };
}

/**
 * Bind and serve the setup. The pages and their assets come from the console's
 * own handler, so the two can never serve different bytes for the same path.
 */
export function startSetupServer(
  ctx: SetupServerCtx,
  hostname: string,
  fallbackHostname?: string,
): { server: Server<undefined>; handler: SetupRequestHandler } {
  const handler = createSetupHandler(ctx);
  const csp = cspFor(ctx.assets.inlineScriptHashes);
  const harden = (res: Response): Response => {
    res.headers.set("content-security-policy", csp);
    res.headers.set("x-content-type-options", "nosniff");
    res.headers.set("referrer-policy", "no-referrer");
    return res;
  };
  const answer = async (req: Request, peer: string | undefined): Promise<Response> => {
    try {
      const own = await handler.handle(req, peer);
      if (own) return harden(own);
      // The console's API is not served here: a path under it that the setup
      // does not own does not exist.
      if (new URL(req.url).pathname.startsWith("/ui/api/")) {
        return harden(json({ error: "Not found" }, 404));
      }
      return handleUiRequest(req, { assets: ctx.assets, port: ctx.port }, peer);
    } catch (error) {
      return harden(json({ error: redactedMessage(error) }, 500));
    }
  };
  const serveOn = (host: string): Server<undefined> => {
    try {
      return Bun.serve({
        hostname: host,
        port: ctx.port,
        maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
        idleTimeout: IDLE_TIMEOUT_S,
        development: false,
        fetch: (req, server) => answer(req, server.requestIP(req)?.address),
        error: (error: Error): Response => harden(json({ error: redactedMessage(error) }, 500)),
      });
    } catch (error) {
      if (fallbackHostname && host !== fallbackHostname) return serveOn(fallbackHostname);
      throw error;
    }
  };
  return { server: serveOn(hostname), handler };
}
