// Route classes, and the single gate every request passes through.
//
// Routes are classified BY EFFECT, not by URL shape or by who happens to call
// them today: `read` means no state changes anywhere — no store write, no
// filesystem write, no Postgres write, no ServiceManager call, no
// credential-bearing outbound request. Anything unclassified is `mutate`, so a
// route added without a decision is locked to operators rather than quietly open.
//
// The PUBLIC set is enumerated here and nowhere else, and the route-walk test
// compares the live registry against it member for member. A route that reaches
// the network before a session exists is a decision, never an accident.
//
// Only the public AUTH routes are spool-audited. The shell, the hashed assets,
// /healthz and the instance probe are not: they carry no principal and no
// intent, and logging them would let an unauthenticated flood grow a table that
// has no DELETE anywhere in the system.
//
// 401 BEFORE 404: an unauthenticated request to a path that does not exist is
// answered exactly like one to a path that does. Otherwise the difference between
// the two is a map of the console's surface, drawn by anyone who can reach it.

import { READONLY_REFUSAL_COPY } from "./copy";
import type { BucketName } from "./rate-limit";
import type { UiRole } from "./users";

export type RouteClass = "public" | "self" | "read" | "read-audited" | "mutate";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteSpec {
  method: HttpMethod;
  /** Exact path, or a prefix when `prefix` is set. */
  path: string;
  prefix?: boolean;
  cls: RouteClass;
  /** Which meter this route draws from, when it draws from one.
   *
   *  Absent on MOST routes, not on /healthz alone: the meters exist for the
   *  expensive and the guessable — sign-in, the SSO exchange, the store probe,
   *  the exports — and a plain read answered from this host's own Postgres is
   *  bounded by the session it needs rather than by a bucket. */
  bucket?: BucketName;
  /** Public routes only: does an attempt reach the audit spool? */
  audited?: boolean;
  /** The instance probe answers before any origin exists to compare against. */
  originExempt?: boolean;
  /** The instance probe refuses a non-loopback peer outright. */
  loopbackOnly?: boolean;
}

/**
 * THE public set. Every entry is reachable with no session; nothing else is.
 *
 * The SPA's own view paths are not listed individually — the index entry is a
 * prefix match on "/" and the server hands any non-asset path the shell, which is
 * what makes a cold deep link land where it says.
 */
export const PUBLIC_ROUTES: readonly RouteSpec[] = [
  { method: "GET", path: "/", prefix: true, cls: "public", bucket: "asset", audited: false },
  { method: "GET", path: "/assets/", prefix: true, cls: "public", bucket: "asset", audited: false },
  { method: "GET", path: "/fonts/", prefix: true, cls: "public", bucket: "asset", audited: false },
  { method: "GET", path: "/healthz", cls: "public", audited: false, originExempt: true },
  { method: "POST", path: "/ui/api/session", cls: "public", bucket: "publicSignIn", audited: true },
  { method: "POST", path: "/ui/api/sso/exchange", cls: "public", bucket: "ssoEntry", audited: true },
  { method: "GET", path: "/ui/api/setup/status", cls: "public", bucket: "setup", audited: true },
  { method: "POST", path: "/ui/api/setup/complete", cls: "public", bucket: "setup", audited: true },
  {
    method: "GET",
    path: "/ui/api/instance",
    cls: "public",
    bucket: "instanceProbe",
    audited: false,
    originExempt: true,
    loopbackOnly: true,
  },
] as const;

/** Routes any signed-in role may reach about ITSELF. */
export const SELF_ROUTES: readonly RouteSpec[] = [
  { method: "GET", path: "/ui/api/session", cls: "self" },
  { method: "DELETE", path: "/ui/api/session", cls: "self" },
] as const;

/** The non-secret identity the probe returns. It is a handshake, never a
 *  capability: it reissues nothing, names no org, and states no version. */
export const INSTANCE_PROBE_IDENTITY = { app: "hx-fortress-ui" } as const;

/** Reserved for the console's own API; never claimed by the shell prefix. */
const API_NAMESPACE = "/ui/api/";

export class RouteRegistry {
  private readonly routes: RouteSpec[] = [];

  constructor(seed: readonly RouteSpec[] = [...PUBLIC_ROUTES, ...SELF_ROUTES]) {
    this.routes.push(...seed);
  }

  register(spec: RouteSpec): void {
    this.routes.push(spec);
  }

  all(): readonly RouteSpec[] {
    return this.routes;
  }

  /** Longest match wins, so a specific route always beats the shell prefix. */
  lookup(method: string, path: string): RouteSpec | null {
    const wanted = method === "HEAD" ? "GET" : method;
    let best: RouteSpec | null = null;
    for (const route of this.routes) {
      if (route.method !== wanted) continue;
      const hit = route.prefix ? path.startsWith(route.path) : path === route.path;
      if (!hit) continue;
      // The API namespace is RESERVED from every prefix route outside it. The
      // shell matches "/" as a prefix so a cold deep link renders, and without
      // this an unclassified /ui/api path would inherit the shell's public class
      // and answer 404 — telling an unauthenticated caller which endpoints exist,
      // which is exactly what 401-before-404 is for.
      if (path.startsWith(API_NAMESPACE) && !route.path.startsWith(API_NAMESPACE)) continue;
      if (!best || route.path.length > best.path.length) best = route;
    }
    return best;
  }

  /** The public enumeration as the route-walk test reads it. */
  publicPaths(): string[] {
    return this.routes
      .filter((r) => r.cls === "public")
      .map((r) => `${r.method} ${r.path}${r.prefix ? "*" : ""}`)
      .sort();
  }
}

export interface GateInput {
  method: string;
  path: string;
  route: RouteSpec | null;
  /** Null when the request carried no valid session. */
  role: UiRole | null;
}

export type GateDecision =
  | { allow: true; cls: RouteClass }
  | { allow: false; status: 401 | 403; reason: string };

/**
 * The choke point. Nothing reaches a handler without a verdict from here.
 *
 * An unclassified path is treated as `mutate`, which for an unauthenticated
 * caller means 401 — identical to a real route it may not have. That is the
 * 401-before-404 rule: the console never confirms what exists.
 */
export function gate(input: GateInput): GateDecision {
  const cls: RouteClass = input.route?.cls ?? "mutate";
  if (cls === "public") return { allow: true, cls };
  if (!input.role) {
    return { allow: false, status: 401, reason: "sign in to continue" };
  }
  if (cls === "mutate" && input.role !== "operator") {
    return {
      allow: false,
      status: 403,
      reason: READONLY_REFUSAL_COPY,
    };
  }
  return { allow: true, cls };
}

/** Writes carry an Origin check; reads do not. The probe and /healthz are exempt
 *  because they answer before an origin is established at all. */
export function requiresOrigin(route: RouteSpec | null, method: string): boolean {
  if (route?.originExempt) return false;
  if (method === "GET" || method === "HEAD") return false;
  return true;
}
