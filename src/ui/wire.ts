// Wire constants the BROWSER also needs.
//
// These live in a module with no imports at all, and that emptiness is the
// point: the SPA bundles whatever it reaches, so a constant it shares with the
// server cannot sit in a module that pulls `node:crypto` or `node:fs` behind it.
// `sessions.ts` and `auth-routes.ts` both do, and importing the header straight
// from either fails the console build with "createHash is not exported by
// __vite-browser-external" — a rollup error rather than a runtime surprise,
// which is the good version of this mistake but still a red build.
//
// So: one definition here, imported by both sides. Server modules re-export
// what they own so their existing callers and tests do not have to move.

/** Header carrying a console session token. */
export const SESSION_HEADER = "x-fortress-ui-token";

/** Header carrying a one-time account-setup token. */
export const SETUP_TOKEN_HEADER = "x-setup-token";

/** Where the code of the second step at sign-in is sent, with the ticket the
 *  password step handed back. */
export const SECOND_STEP_PATH = "/ui/api/session/second-step";

/** Header carrying the session of the one-time Fortress setup. The setup is
 *  served by its own short-lived listener, never by the console. */
export const SETUP_SESSION_HEADER = "x-fortress-setup-session";

/** Where the one-time Fortress setup's own routes live. */
export const FORTRESS_SETUP_API = "/ui/api/fortress-setup";

/** The three routes of sign-in through the organization's identity provider. */
export const OIDC_PATHS = {
  status: "/ui/api/oidc",
  start: "/ui/api/oidc/start",
  session: "/ui/api/oidc/session",
} as const;

/** Where the identity provider sends the browser back. A view path that the
 *  app shell is served for, not an API route. */
export const OIDC_CALLBACK_PATH = "/oidc/callback";
