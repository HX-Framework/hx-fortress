// The three routes of sign-in through the organization's identity provider.
//
//   GET  /ui/api/oidc           is this sign-in offered here? (the page asks
//                               before it draws the button)
//   POST /ui/api/oidc/start     begin a flow: the provider's authorization URL
//                               and a PKCE verifier for this tab
//   POST /ui/api/oidc/session   finish it: code, state and verifier in, a
//                               console session out
//
// All three answer before a session exists, so they are part of the public
// set. They are enumerated here, registered by the runtime, and pinned by a
// test, the same as every other public route.
//
// WHEN THIS SIGN-IN IS OFF, each route answers exactly what an unknown path
// answers a caller with no session: 401, same sentence. A console that has it
// off says nothing about whether this build has it at all.
//
// The provider's callback is not a route here. The provider sends the browser
// to `/oidc/callback`, which the console serves the app shell for like any
// other view path; the page reads the code and posts it to the session route.
// So a code is redeemed by a POST from this console's own page, with an Origin
// the gate has already checked, and never by a GET that a link could cause.

import { AUDIT_ACTIONS } from "../console/audit-actions";
import type { ConsoleAudit } from "./audit-writer";
import { oidcUsable, type UiOidcConfig } from "./oidc-config";
import {
  identityFromClaims,
  usableSubject,
  type OidcClient,
  type OidcFlows,
  type OidcIdentity,
  type OidcRefusal,
} from "./oidc";
import { redactValue } from "./redact";
import type { RouteSpec } from "./routes";
import type { UiRole } from "./users";

// Defined in wire.ts, which the browser bundle can import, and re-exported here.
export { OIDC_CALLBACK_PATH, OIDC_PATHS } from "./wire";
import { OIDC_CALLBACK_PATH, OIDC_PATHS } from "./wire";

/** Public by necessity: each answers a caller who has not signed in yet. Only
 *  the route that can mint a session is audited; the other two carry no
 *  principal, and recording them would let an unauthenticated caller grow the
 *  audit table. */
export const OIDC_PUBLIC_ROUTES: readonly RouteSpec[] = [
  { method: "GET", path: OIDC_PATHS.status, cls: "public", bucket: "oidcSignIn", audited: false },
  { method: "POST", path: OIDC_PATHS.start, cls: "public", bucket: "oidcSignIn", audited: false },
  { method: "POST", path: OIDC_PATHS.session, cls: "public", bucket: "oidcSignIn", audited: true },
] as const;

const OIDC_PATH_SET: ReadonlySet<string> = new Set(Object.values(OIDC_PATHS));

/** True for one of the three routes above. The gate treats them as routes only
 *  while sign-in through the provider is on. While it is off they are unknown
 *  paths in every respect: the same answer, no rate bucket, no Origin check. */
export function isOidcPath(pathname: string): boolean {
  return OIDC_PATH_SET.has(pathname);
}

/** The audit action of a refused sign-in. The reason is the last part of the
 *  action, because a collapsed failure record carries no other place for it. */
export function oidcFailedAction(refusal: OidcRefusal): string {
  return `${AUDIT_ACTIONS.signInFailed}.oidc.${refusal}`;
}

// ── What the page is told ───────────────────────────────────────────────────

/** One sentence for every refusal that says nothing about the person. */
export const OIDC_FAILED_COPY =
  "Sign-in through your identity provider did not complete. Try again, or sign in with a local account.";

/** The provider vouched for the person, and no group of theirs maps to a role
 *  here. Saying so tells them nothing they could not ask their own provider. */
export const OIDC_NOT_ALLOWED_COPY =
  "Your account is not in a group that may open this console. Ask an administrator of this fortress.";

/** The console could not reach the provider or read its own client secret. */
export const OIDC_UNAVAILABLE_COPY =
  "This console could not reach the identity provider. Try again in a moment.";

const NOT_ALLOWED: ReadonlySet<OidcRefusal> = new Set(["groups_missing", "groups_overage", "no_matching_group"]);
const UNAVAILABLE: ReadonlySet<OidcRefusal> = new Set([
  "provider_unreachable",
  "provider_metadata_invalid",
  "client_secret_unavailable",
]);

function json(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(redactValue(body))}\n`, {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Exactly the gate's answer to an unknown path with no session. */
function off(): Response {
  return json({ error: "sign in to continue" }, 401);
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── The handler ─────────────────────────────────────────────────────────────

export interface OidcRouteDeps {
  /** The settings as they are now. */
  config: () => Promise<UiOidcConfig>;
  client: OidcClient;
  flows: OidcFlows;
  /** Issue a console session for a person the provider vouched for. */
  issueSession(args: {
    identity: OidcIdentity;
    epoch: number;
    remoteAddr: string;
  }): Promise<{ token: string; login: string; role: UiRole; sessions: string }>;
  now: () => number;
}

export interface OidcRouteContext {
  oidc: OidcRouteDeps;
  /** The origin this request arrived on, as the Host allowlist resolved it.
   *  The redirect URI is built from it and from nothing the caller sends. */
  origin: string | null;
  remoteKey: string;
  remoteAddr: string;
  audit?: ConsoleAudit;
  /** Where the reason for a refusal is logged for the operator. */
  onWarn?: (message: string) => void;
}

/** Null when the path is not one of the three routes. */
export async function handleOidcRoute(req: Request, ctx: OidcRouteContext): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  const { oidc } = ctx;

  if (path === OIDC_PATHS.status && req.method === "GET") {
    const config = await oidc.config();
    if (!oidcUsable(config) || !ctx.origin) return off();
    // The label is the operator's own word for the provider. Nothing else
    // about the provider is said before a person asks to be sent there.
    return json({ label: config.label });
  }

  if (path === OIDC_PATHS.start && req.method === "POST") {
    const config = await oidc.config();
    if (!oidcUsable(config) || !ctx.origin) return off();
    const metadata = await oidc.client.metadata(config.issuer);
    if (!metadata.ok) {
      ctx.onWarn?.(`sign-in through the identity provider could not start: ${metadata.detail ?? metadata.refusal}`);
      return json({ error: OIDC_UNAVAILABLE_COPY }, 503);
    }
    const flow = oidc.flows.start({
      redirectUri: `${ctx.origin}${OIDC_CALLBACK_PATH}`,
      epoch: config.epoch,
      now: oidc.now(),
    });
    return json({
      authorizationUrl: oidc.client.authorizationUrl(config, metadata.value, {
        redirectUri: `${ctx.origin}${OIDC_CALLBACK_PATH}`,
        state: flow.state,
        nonce: flow.nonce,
        challenge: flow.challenge,
      }),
      // Held by this tab and sent back with the code. The console keeps no copy.
      verifier: flow.verifier,
    });
  }

  if (path === OIDC_PATHS.session && req.method === "POST") {
    const config = await oidc.config();
    if (!oidcUsable(config) || !ctx.origin) return off();
    const body = await readJson(req);
    const code = typeof body.code === "string" ? body.code : "";
    const state = typeof body.state === "string" ? body.state : "";
    const verifier = typeof body.verifier === "string" ? body.verifier : "";

    /** Record the refusal, tell the operator why, and tell the page as little
     *  as it needs. `login` is known only once a token has verified. */
    const refused = (refusal: OidcRefusal, detail: string | undefined, login: string | null): Response => {
      ctx.audit?.noteFailure(oidcFailedAction(refusal), { login, remoteKey: ctx.remoteKey });
      ctx.onWarn?.(
        `sign-in through the identity provider was refused (${refusal})` +
          (login ? ` for ${login}` : "") +
          (detail ? `: ${detail}` : ""),
      );
      if (UNAVAILABLE.has(refusal)) return json({ error: OIDC_UNAVAILABLE_COPY }, 503);
      if (NOT_ALLOWED.has(refusal)) return json({ error: OIDC_NOT_ALLOWED_COPY }, 403);
      return json({ error: OIDC_FAILED_COPY }, 400);
    };

    if (!code || code.length > 4096 || !state || !verifier || verifier.length > 256) {
      return refused("state_invalid", undefined, null);
    }
    const flow = oidc.flows.finish({ state, verifier, epoch: config.epoch, now: oidc.now() });
    if (!flow.ok) return refused(flow.refusal, flow.detail, null);
    // The flow was started for this origin. A code obtained for one address of
    // this console is not redeemed on another.
    if (flow.value.redirectUri !== `${ctx.origin}${OIDC_CALLBACK_PATH}`) {
      return refused("state_invalid", "the flow was started on another address of this console", null);
    }

    const metadata = await oidc.client.metadata(config.issuer);
    if (!metadata.ok) return refused(metadata.refusal, metadata.detail, null);
    const idToken = await oidc.client.redeem(config, metadata.value, {
      code,
      redirectUri: flow.value.redirectUri,
      verifier,
    });
    if (!idToken.ok) return refused(idToken.refusal, idToken.detail, null);
    const claims = await oidc.client.verify(config, metadata.value, idToken.value, flow.value.nonce);
    if (!claims.ok) return refused(claims.refusal, claims.detail, null);
    const identity = identityFromClaims(config, claims.value);
    if (!identity.ok) {
      // The person is known now, even though they are refused: name them, so
      // an operator fixing a group mapping can find the attempt. An id that is
      // not safe to print is not written.
      const subject = usableSubject(claims.value);
      return refused(identity.refusal, identity.detail, subject ? `sub:${subject}` : null);
    }

    const session = await oidc.issueSession({
      identity: identity.value,
      epoch: config.epoch,
      remoteAddr: ctx.remoteAddr,
    });
    await ctx.audit?.raise(AUDIT_ACTIONS.signIn, {
      actor: session.login,
      params: {
        login: session.login,
        role: session.role,
        remote: ctx.remoteKey,
        method: "oidc",
        subject: identity.value.subject,
      },
      outcome: "signed in",
    });
    return json(session);
  }

  return null;
}
