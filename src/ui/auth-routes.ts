// The public authentication surface: the only routes that answer before a
// session exists, and the only ones that ever mint one.
//
// Everything here has already passed the gate — rate bucket, loopback rule,
// session, role, Origin — so these handlers decide nothing about authorization.
// They read a body, call the runtime, and shape a response.
//
// Two response rules hold throughout. Failures are UNIFORM: an unknown login, a
// disabled one and a wrong password produce one status and one sentence, because
// any difference between them answers "does this account exist" for whoever asks.
// And a token appears in exactly one place — the JSON body of the response that
// minted it. Never a URL, never a redirect, never a log line.

import { AUDIT_ACTIONS } from "../console/audit-actions";
import type { ConsoleAudit } from "./audit-writer";
import {
  LOCKOUT_COPY,
  SIGN_IN_FAILURE_COPY,
  SIGN_IN_RECOVERY_COPY,
} from "./copy";
import { ArgonBusyError, ARGON_WAIT_MS } from "./argon-gate";
import { UiRuntime } from "./runtime";
import { redactValue } from "./redact";
import { SESSION_HEADER, sessionCopy } from "./sessions";
import { checkLogin, checkPasswordPolicy, liveSetupToken } from "./users";

/** Carried in the setup-status request HEADER, never a path or a query — a
 *  request line reaches access logs, proxy logs and Referer headers. */
export { SETUP_TOKEN_HEADER } from "./wire";
import { SETUP_TOKEN_HEADER } from "./wire";

export const SIGN_IN_PATH = "/ui/api/session";
export const SSO_EXCHANGE_PATH = "/ui/api/sso/exchange";
export const SETUP_STATUS_PATH = "/ui/api/setup/status";
export const SETUP_COMPLETE_PATH = "/ui/api/setup/complete";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  // Redacted on the way out, unconditionally — the same belt the read and mutate
  // builders wear. It matters MORE here: every route in this file answers a
  // caller who has not signed in yet.
  return new Response(`${JSON.stringify(redactValue(body))}\n`, {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function retryAfter(ms: number | undefined): Record<string, string> {
  return ms === undefined ? {} : { "retry-after": String(Math.max(1, Math.ceil(ms / 1000))) };
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface AuthRouteContext {
  runtime: UiRuntime;
  /** The socket peer, already resolved to a rate-limit key by the gate. */
  remoteKey: string;
  remoteAddr: string;
  /** The spool. These four are the only routes that answer before a session
   *  exists, and they are the only public ones that reach it - the shell, the
   *  hashed assets, /healthz and the instance probe carry no principal and no
   *  intent, and recording them would let an unauthenticated flood grow a table
   *  nothing deletes. */
  audit?: ConsoleAudit;
}

/** Null when the path is not an authentication route — the caller falls through
 *  to the asset map and the app shell. */
export async function handleAuthRoute(
  req: Request,
  ctx: AuthRouteContext,
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  const { runtime } = ctx;

  if (path === SSO_EXCHANGE_PATH && req.method === "POST") {
    const body = await readJson(req);
    const grant = typeof body.grant === "string" ? body.grant : "";
    const config = await runtime.readConfig();
    const verdict = await runtime.exchangeGrant(grant);
    if (!verdict.ok || !verdict.entry) {
      ctx.audit?.noteFailure(AUDIT_ACTIONS.ssoExchangeFailed, { remoteKey: ctx.remoteKey });
      // The REASON is the page; the offset is the remediation. Neither says
      // anything a caller could not already have learned from the grant it
      // presented — and `generic` says nothing at all.
      return json(
        {
          error: verdict.ok ? "generic" : verdict.reason,
          ...(!verdict.ok && verdict.offsetSeconds !== undefined
            ? { offsetSeconds: verdict.offsetSeconds }
            : {}),
        },
        400,
      );
    }
    await ctx.audit?.raise(AUDIT_ACTIONS.ssoExchange, {
      params: { org: verdict.claims.org, workbenchSub: verdict.claims.sub, remote: ctx.remoteKey },
    });
    // FOUR fields, and three of them are for the page to render. The entry id is
    // the only one that carries authority, and all it carries is an annotation:
    // the sign-in stamps the workbench identity from the record this id names,
    // never from anything the client sends back.
    return json({
      entryId: verdict.entry.id,
      workbenchSub: verdict.claims.sub,
      org: verdict.claims.org,
      marker: config.marker,
    });
  }

  if (path === SIGN_IN_PATH && req.method === "POST") {
    const body = await readJson(req);
    const login = typeof body.login === "string" ? body.login : "";
    const password = typeof body.password === "string" ? body.password : "";
    // A login that cannot name an account is refused HERE, in the same uniform
    // 401 a wrong password gets — so it stays non-enumerating — and without
    // reaching the failure window, the lockout table or the hasher. Every real
    // login satisfies this rule by construction (the CLI applies it at
    // creation), so nothing that could succeed is turned away.
    //
    // Unrefused, the body's `login` is a string an UNAUTHENTICATED caller
    // chooses, up to the whole 256 KiB request ceiling, and it is written
    // verbatim as the audit record's actor and used as a lockout key: the
    // collapse that bounds those records bounds how MANY there are, never how
    // big, and hx.admin_audit has no DELETE anywhere.
    if (checkLogin(login) !== null) {
      return json(
        { error: SIGN_IN_FAILURE_COPY, recovery: SIGN_IN_RECOVERY_COPY },
        401,
      );
    }
    const config = await runtime.readConfig();
    // The entry id is a server-side record; anything the client claims about the
    // workbench identity is ignored, and the stamp comes from the record alone.
    const entry = runtime.entries.read(
      typeof body.entryId === "string" ? body.entryId : null,
    );
    const result = await runtime.signIn({
      login,
      password,
      remoteKey: ctx.remoteKey,
      remoteAddr: ctx.remoteAddr,
      workbenchSub: entry?.workbenchSub ?? null,
    });
    if (!result.ok) {
      // A refusal by a rate bucket appends NOTHING: it
      // is a counter, and an attempt the box refused must not be able to make it
      // write to disk. A genuine failure joins its (login, source, window) and
      // becomes one record when that window closes.
      if (result.status === 401) {
        ctx.audit?.noteFailure(AUDIT_ACTIONS.signInFailed, { login, remoteKey: ctx.remoteKey });
      }
      // 503 is LOAD SHEDDING, not a verdict about the credential. Folding it
      // into "that login and password did not match" told an operator their
      // password was wrong during a two-second spike and pointed them at the
      // reset in the recovery line — an admin round-trip and a credential
      // rotation caused by queue depth. The gate's own sentence says nothing
      // about the account, so it enumerates nothing.
      const shed = result.status === 503;
      return json(
        {
          error: shed
            ? result.reason
            : result.status === 429
              ? LOCKOUT_COPY
              : SIGN_IN_FAILURE_COPY,
          ...(shed ? {} : { recovery: SIGN_IN_RECOVERY_COPY }),
        },
        result.status,
        retryAfter(result.retryAfterMs),
      );
    }
    await ctx.audit?.signIn({
      login: result.session.userLogin,
      role: result.session.role,
      remoteKey: ctx.remoteKey,
      workbenchSub: result.session.workbenchSub,
    });
    return json({
      token: result.token,
      login: result.session.userLogin,
      role: result.session.role,
      sessions: sessionCopy(UiRuntime.policyOf(config)),
    });
  }

  if (path === SIGN_IN_PATH && (req.method === "DELETE" || req.method === "GET")) {
    const users = await runtime.readUsers();
    const config = await runtime.readConfig();
    const check = runtime.sessions.validate(
      req.headers.get(SESSION_HEADER),
      users,
      UiRuntime.policyOf(config),
    );
    if (!check.ok) return json({ error: "sign in to continue" }, 401);
    if (req.method === "DELETE") {
      runtime.sessions.revoke(check.session.id);
      await ctx.audit?.signOut({
        login: check.session.userLogin,
        role: check.session.role,
        sessionRef: check.session.id,
      });
      return json({ signedOut: true });
    }
    return json({
      login: check.session.userLogin,
      role: check.session.role,
      workbenchSub: check.session.workbenchSub,
      createdAt: new Date(check.session.createdAt).toISOString(),
    });
  }

  if (path === SETUP_STATUS_PATH && req.method === "GET") {
    const token = req.headers.get(SETUP_TOKEN_HEADER) ?? "";
    const users = await runtime.readUsers();
    const config = await runtime.readConfig();
    const now = new Date();
    const user = token
      ? users.users.find((u) => !u.deletedAt && !u.disabledAt && liveSetupToken(u, token, now))
      : undefined;
    if (user) {
      await ctx.audit?.setupOpened({ login: user.login, remoteKey: ctx.remoteKey });
    } else {
      ctx.audit?.noteFailure(AUDIT_ACTIONS.setupFailed, { remoteKey: ctx.remoteKey });
    }
    // The marker renders to a token-bearing arrival only. On a plain sign-in the
    // console still says nothing about which fortress this is.
    return json(
      user
        ? { status: "live", login: user.login, marker: config.marker }
        : { status: "dead", recovery: SIGN_IN_RECOVERY_COPY },
      user ? 200 : 404,
    );
  }

  if (path === SETUP_COMPLETE_PATH && req.method === "POST") {
    const token = req.headers.get(SETUP_TOKEN_HEADER) ?? "";
    const body = await readJson(req);
    const password = typeof body.password === "string" ? body.password : "";
    const policy = checkPasswordPolicy(password);
    if (policy) return json({ error: policy }, 400);

    try {
      // A GET must never reach here: a link-unfurling chat client would burn
      // every setup URL it previews, and the person it was sent to would find a
      // dead link and no way to tell why.
      const user = await runtime.completeSetup(token, password, ctx.remoteKey);
      await ctx.audit?.setupCompleted({
        login: user.login,
        role: user.role,
        remoteKey: ctx.remoteKey,
      });
      return json({ completed: true, login: user.login, role: user.role });
    } catch (error) {
      // The SHED is not a dead link. A setup token that arrived while the argon
      // gate was full is still valid — nothing consumed it — and telling the
      // operator it is "no longer valid" sends them to the recovery line on that
      // page, which asks an admin to run `ui user reset`: a new link and a
      // credential-epoch bump, for a queue that was busy for two seconds. Named
      // before the uniform answer below, and only this one is named.
      if (error instanceof ArgonBusyError) {
        return json({ error: error.message }, error.status, retryAfter(ARGON_WAIT_MS));
      }
      ctx.audit?.noteFailure(AUDIT_ACTIONS.setupFailed, { remoteKey: ctx.remoteKey });
      // ONE sentence, never the exception's. The caller holds a setup token that
      // did not work and nothing else, and every reason this throws — unknown,
      // expired, already used, account disabled — is the same answer to them;
      // saying which would enumerate. The thrown message is worse than useless
      // here: a corrupt store names its own path on disk.
      return json({ error: "this setup link is no longer valid" }, 400);
    }
  }

  return null;
}
