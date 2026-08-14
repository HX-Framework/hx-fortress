// Where the console listens, and what it prints about it.
//
// The rule, normative:
//
//   Loopback is the default. A wildcard bind is reached three ways —
//
//   (1) a DOCKER-CLASS container (/.dockerenv, /run/.containerenv, Kubernetes,
//       Railway) with FORTRESS_UI_ENABLE set binds dual-stack with no further
//       gesture. Those runtimes publish through host indirection, so the
//       documented `-p 127.0.0.1:8788:8788` reaches a console that listens on a
//       wildcard and exposes nothing that the publish did not. The residual and
//       the publish guidance are printed anyway, because host networking
//       (`--network host`, `hostNetwork: true`) is undetectable from inside and
//       turns the same bind into a real LAN bind.
//   (2) FORTRESS_UI_CONTAINER_BIND=1 binds dual-stack ANYWHERE, with the
//       residual printed — the override for a detector miss, and explicitly
//       equivalent to --allow-insecure-bind. LXC and systemd-nspawn guests route
//       through here: they are LAN-routable with no publish indirection, so
//       widening them is an operator decision, never an inference.
//   (3) otherwise a non-loopback bind is REFUSED unless an https
//       FORTRESS_UI_PUBLIC_URL is set or --allow-insecure-bind is passed, and
//       the residual is printed either way.
//
// The bind address is not the access boundary — the operator's password over
// the ingress the operator chose is. Publish to loopback, or terminate TLS in
// front of the console.

import type { ContainerVerdict } from "./container";

export const DEFAULT_UI_PORT = 8788;
export const LOOPBACK_BIND = "127.0.0.1";
/** IPv4+IPv6 wildcard; a container without IPv6 falls back to 0.0.0.0. */
export const DUAL_STACK_BIND = "::";
export const DUAL_STACK_FALLBACK_BIND = "0.0.0.0";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

export function isLoopbackBind(bind: string): boolean {
  return LOOPBACK_ADDRESSES.has(bind.trim().toLowerCase());
}

export interface BindInputs {
  /** The configured bind address; loopback unless the operator changed it. */
  bind: string;
  port: number;
  /** The effective external URL, or null. Validated before it is used. */
  publicUrl: string | null;
  /** FORTRESS_UI_ENABLE — the operator asked for a reachable console. */
  uiEnable: boolean;
  /** FORTRESS_UI_CONTAINER_BIND=1. */
  containerBind: boolean;
  /** --allow-insecure-bind. */
  allowInsecureBind: boolean;
  container: ContainerVerdict;
}

export type BindClause =
  | "loopback"
  | "container-publish"
  | "container-gesture"
  | "public-url"
  | "insecure-flag";

export interface BindAccepted {
  ok: true;
  clause: BindClause;
  /** What to hand Bun.serve. */
  hostname: string;
  /** True when hostname is a wildcard and 0.0.0.0 is the retry. */
  dualStack: boolean;
  /** Lines to print under the URL — residual first, then guidance. */
  notes: string[];
}

export interface BindRefused {
  ok: false;
  /** One line naming what was refused. */
  reason: string;
  /** The gestures that would authorize it, then the residual each accepts. */
  notes: string[];
}

export type BindResolution = BindAccepted | BindRefused;

const RESIDUAL =
  "residual: a non-loopback listener is reachable by anything that can route to this host. " +
  "The only barrier is the console password over the ingress you chose — publish to loopback, " +
  "or terminate TLS in front of it.";

const HOST_NETWORK_RESIDUAL =
  "residual: with host networking (--network host, hostNetwork: true) this is a real LAN bind, " +
  "not a published port. That is undetectable from inside the container.";

function publishGuidance(port: number): string[] {
  return [
    `publish it to the host's loopback: docker run -p 127.0.0.1:${port}:${port} …`,
    HOST_NETWORK_RESIDUAL,
  ];
}

const GESTURES =
  "set FORTRESS_UI_CONTAINER_BIND=1, or pass --allow-insecure-bind";

export interface PublicUrlError {
  ok: false;
  /** `not-https` is a posture the operator may knowingly accept; the others are
   *  malformed configuration, which no flag makes correct. */
  kind: "not-https" | "not-a-url" | "not-an-origin";
  reason: string;
}

export interface PublicUrlOk {
  ok: true;
  /** Scheme + host + port, no trailing slash. */
  origin: string;
  url: URL;
}

/**
 * Validate an operator-supplied public URL. https because the console carries a
 * password; empty pathname because the app is root-absolute by construction, so
 * a URL with a path advertises a console that answers on no route it names.
 */
export function parsePublicUrl(raw: string): PublicUrlOk | PublicUrlError {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, kind: "not-a-url", reason: `public URL is not a URL: ${raw}` };
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    return {
      ok: false,
      kind: "not-an-origin",
      reason: `public URL must be a bare origin — no path, query, fragment or userinfo: ${raw}`,
    };
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      kind: "not-https",
      reason: `public URL must be https (got ${url.protocol.replace(":", "")}): ${raw}`,
    };
  }
  return { ok: true, origin: url.origin, url };
}

/** Resolve the listen address, or refuse with the gesture that would allow it. */
export function resolveUiBind(inputs: BindInputs): BindResolution {
  const { container, port } = inputs;

  // A public URL that is not a bare origin is malformed configuration: it names
  // a console that answers on no route it advertises, and no flag makes that
  // correct. Only the https rule is a posture the operator may knowingly accept.
  const parsedPublicUrl = inputs.publicUrl === null ? null : parsePublicUrl(inputs.publicUrl);
  const warnings: string[] = [];
  if (parsedPublicUrl && !parsedPublicUrl.ok) {
    if (parsedPublicUrl.kind !== "not-https") {
      return { ok: false, reason: parsedPublicUrl.reason, notes: [] };
    }
    if (!inputs.allowInsecureBind) {
      return {
        ok: false,
        reason: parsedPublicUrl.reason,
        notes: ["override with --allow-insecure-bind", RESIDUAL],
      };
    }
    warnings.push(
      `warning: ${parsedPublicUrl.reason} — every console password will cross the network in clear text`,
    );
  }
  const publicUrlOk = parsedPublicUrl?.ok === true;

  const accept = (
    clause: BindClause,
    hostname: string,
    dualStack: boolean,
    notes: string[] = [],
  ): BindAccepted => ({ ok: true, clause, hostname, dualStack, notes: [...warnings, ...notes] });

  // An explicitly configured non-loopback bind is clause (3) — the operator
  // named the address, so the container clauses do not apply to it.
  if (!isLoopbackBind(inputs.bind)) {
    if (publicUrlOk) return accept("public-url", inputs.bind, false);
    if (inputs.allowInsecureBind) return accept("insecure-flag", inputs.bind, false, [RESIDUAL]);
    return {
      ok: false,
      reason: `refusing to bind ${inputs.bind}:${port} — a non-loopback bind needs an https FORTRESS_UI_PUBLIC_URL or --allow-insecure-bind`,
      notes: [RESIDUAL],
    };
  }

  // Clause (2) — the gesture, honored anywhere, detector or no detector.
  if (inputs.containerBind) {
    return accept("container-gesture", DUAL_STACK_BIND, true, [RESIDUAL]);
  }

  // Clause (1) — publish indirection makes the widen free of a new gesture.
  if (container.dockerClass && inputs.uiEnable) {
    return accept("container-publish", DUAL_STACK_BIND, true, [RESIDUAL, ...publishGuidance(port)]);
  }

  if (container.container) {
    // A system container reached by the other gesture — same widen, same residual.
    if (inputs.allowInsecureBind) {
      return accept("container-gesture", DUAL_STACK_BIND, true, [RESIDUAL]);
    }
    // Asked for a reachable console on a box whose address is a LAN address:
    // refuse and name the gesture rather than bind loopback and leave the
    // operator with a console nothing can reach and no diagnostic.
    if (inputs.uiEnable) {
      return {
        ok: false,
        reason:
          `refusing to widen the bind — this looks like a container (${container.signals.join(", ")}) ` +
          `with no published-port indirection, so a wildcard bind here is a LAN bind`,
        notes: [`to accept that: ${GESTURES}`, RESIDUAL],
      };
    }
  }

  return accept("loopback", LOOPBACK_BIND, false);
}

export interface PrintedUrlInputs {
  /** --url <base>, the operator's override. Wins over everything. */
  urlOverride: string | null;
  publicUrl: string | null;
  /** The resolved listen address. */
  hostname: string;
  dualStack: boolean;
  port: number;
  /** os.hostname(), for the SSH one-liner. */
  hostName: string;
}

export interface PrintedUrl {
  base: string;
  /** The off-box access line, when the base is only reachable on this host. */
  notes: string[];
}

/**
 * The URL to print. The effective public URL when there is one, else the bind
 * address plus the SSH forward that makes it reachable — an SSH-tunnel-only
 * console is the most private posture there is, not a degraded one.
 *
 * A dual-stack bind prints 127.0.0.1, never "localhost": Docker Desktop also
 * publishes on the host's IPv6, "localhost" resolves to ::1 first there, and its
 * IPv6 forwarding drops the connection. The literal forces the path that works.
 */
export function printedUrl(inputs: PrintedUrlInputs): PrintedUrl {
  if (inputs.urlOverride) {
    return { base: inputs.urlOverride.replace(/\/+$/, ""), notes: [] };
  }
  if (inputs.publicUrl) {
    const parsed = parsePublicUrl(inputs.publicUrl);
    if (parsed.ok) return { base: parsed.origin, notes: [] };
  }
  const loopbackOnly = !inputs.dualStack && isLoopbackBind(inputs.hostname);
  const host = inputs.dualStack || loopbackOnly ? LOOPBACK_BIND : bracketed(inputs.hostname);
  return {
    base: `http://${host}:${inputs.port}`,
    // The SSH forward is the answer only where the console is reachable on this
    // host alone. A widened bind is reached by the ingress that widened it, and
    // its own guidance is printed with the residual.
    notes: loopbackOnly
      ? [`reach it from your machine: ssh -L ${inputs.port}:127.0.0.1:${inputs.port} ${inputs.hostName}`]
      : [],
  };
}

/** IPv6 literals need brackets before a port. */
export function bracketed(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
