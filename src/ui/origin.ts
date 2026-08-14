// The Host and Origin allowlist — the console's defence against DNS rebinding
// and against cross-site writes.
//
// HOST: a browser sends whatever name the URL carried. An attacker who points
// evil.example.com at 127.0.0.1 can make a victim's browser talk to a console
// listening there, and same-origin policy will not stop it because the origin is
// genuinely the attacker's. Refusing every Host the operator did not configure
// closes that: the attacker's name is never on the list.
//
// LITERAL LOOPBACK IS PORT-AGNOSTIC, deliberately. A published container maps
// 8788 onto some other host port, so the Host the browser sends bears no relation
// to the port the console bound. The name is what carries the rebinding risk, not
// the number, so 127.0.0.1 / [::1] / localhost are accepted on any port while a
// configured public host is accepted on ITS port alone.
//
// ORIGIN: derived FROM THE MATCHED HOST rather than from a single configured
// value, so a console reachable both over the tunnel and on loopback validates
// each request against the origin that request actually arrived on. Absent or
// `null` Origin FAILS CLOSED on every write — the header is omitted by exactly
// the clients that are not a browser doing a same-origin fetch.

import { parsePublicUrl } from "./bind";
import { normalizeAddress } from "./remote-key";

export type ExternalScheme = "http" | "https";

export interface HostAllowlist {
  /** Hosts accepted on any port — literal loopback only. */
  loopbackNames: ReadonlySet<string>;
  /** host:port → the effective external scheme for that host. */
  pinned: ReadonlyMap<string, ExternalScheme>;
  /** True when a matched host is https, i.e. when HSTS is honest to send. */
  hsts: boolean;
}

const LOOPBACK_NAMES = new Set(["127.0.0.1", "::1", "localhost"]);

/** Never a valid Host: they name "every interface", not a destination, and a
 *  browser that sends one is not talking to a console anybody configured. */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

/** Lowercase, strip the trailing dot (`example.com.` is the same name to DNS and
 *  a different string to a naive comparison), and split off the port. */
export function splitHost(raw: string): { host: string; port: string | null } | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return null;
    const host = value.slice(1, end);
    const rest = value.slice(end + 1);
    if (rest && !/^:\d+$/.test(rest)) return null;
    return { host: normalizeAddress(host), port: rest ? rest.slice(1) : null };
  }
  const colons = value.split(":").length - 1;
  if (colons > 1) return { host: normalizeAddress(value), port: null }; // bare IPv6
  const [host, port] = value.split(":");
  if (!host) return null;
  if (port !== undefined && !/^\d+$/.test(port)) return null;
  return { host: host.replace(/\.$/, ""), port: port ?? null };
}

export interface AllowlistInputs {
  /** The address the console bound, or the configured one. */
  bind: string;
  /** The port it bound. */
  port: number;
  publicUrl: string | null;
}

export function buildHostAllowlist(inputs: AllowlistInputs): HostAllowlist {
  const pinned = new Map<string, ExternalScheme>();
  let hsts = false;

  const bind = normalizeAddress(inputs.bind);
  // A wildcard bind names no host; the loopback set and the public URL are what
  // make it reachable by a name anybody can type.
  if (!WILDCARD_HOSTS.has(bind) && !LOOPBACK_NAMES.has(bind)) {
    pinned.set(`${bind}:${inputs.port}`, "http");
  }

  if (inputs.publicUrl) {
    const parsed = parsePublicUrl(inputs.publicUrl);
    if (parsed.ok) {
      const host = parsed.url.hostname.replace(/^\[|\]$/g, "");
      const port = parsed.url.port || "443";
      pinned.set(`${normalizeAddress(host)}:${port}`, "https");
      hsts = true;
    }
  }

  return { loopbackNames: LOOPBACK_NAMES, pinned, hsts };
}

export type HostCheck =
  | { ok: true; host: string; scheme: ExternalScheme; origin: string }
  | { ok: false; reason: string };

function bracket(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function originOf(host: string, port: string | null, scheme: ExternalScheme): string {
  const defaultPort = scheme === "https" ? "443" : "80";
  return port && port !== defaultPort
    ? `${scheme}://${bracket(host)}:${port}`
    : `${scheme}://${bracket(host)}`;
}

export function checkHost(hostHeader: string | null, allow: HostAllowlist): HostCheck {
  if (!hostHeader) return { ok: false, reason: "no Host header" };
  const split = splitHost(hostHeader);
  if (!split) return { ok: false, reason: `unparseable Host: ${hostHeader}` };
  if (WILDCARD_HOSTS.has(split.host)) {
    return { ok: false, reason: `Host ${split.host} names every interface, not a destination` };
  }
  if (allow.loopbackNames.has(split.host)) {
    return {
      ok: true,
      host: split.host,
      scheme: "http",
      origin: originOf(split.host, split.port, "http"),
    };
  }
  const port = split.port ?? "443";
  const scheme = allow.pinned.get(`${split.host}:${port}`);
  if (!scheme) {
    return {
      ok: false,
      reason: `Host ${hostHeader} is not configured for this console — set it with \`hx-fortress ui config set publicUrl\``,
    };
  }
  return { ok: true, host: split.host, scheme, origin: originOf(split.host, split.port, scheme) };
}

export type OriginCheck = { ok: true } | { ok: false; reason: string };

/**
 * Every write compares Origin against the origin derived from THIS request's
 * allowlisted Host.
 *
 * Fail-closed on absence is the whole point: browsers attach Origin to every
 * cross-site write, and `null` is what they send from a sandboxed or
 * redirect-laundered context — treating either as "probably fine" would make the
 * check decorative.
 */
export function checkOrigin(originHeader: string | null, host: HostCheck): OriginCheck {
  if (!host.ok) return { ok: false, reason: host.reason };
  if (!originHeader) {
    return { ok: false, reason: "this request carries no Origin header, so it is refused" };
  }
  if (originHeader === "null") {
    return { ok: false, reason: "this request carries a null Origin, so it is refused" };
  }
  let candidate: string;
  try {
    const url = new URL(originHeader);
    candidate = originOf(
      normalizeAddress(url.hostname.replace(/^\[|\]$/g, "")),
      url.port || (url.protocol === "https:" ? "443" : "80"),
      url.protocol === "https:" ? "https" : "http",
    );
  } catch {
    return { ok: false, reason: `unparseable Origin: ${originHeader}` };
  }
  return candidate === host.origin
    ? { ok: true }
    : { ok: false, reason: `Origin ${originHeader} does not match ${host.origin}` };
}
