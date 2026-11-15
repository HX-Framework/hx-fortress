// The control plane's address.
//
// A CONTROL PLANE IS OPTIONAL. An HX Fortress with none starts, runs and
// serves its console on its own. One is named with the command that installs
// or sets up HX Fortress (`--connect <address>/i/<id>`), or in a settings
// file. The one-time install id that comes with it is spent the first time
// HX Fortress connects. Nobody signs in anywhere to join, and nobody approves
// anything.
//
// The address a person gives is a host, or an https address with a path. The
// connection itself is a WebSocket at one fixed path under it. An address
// that already starts with `wss://` is taken as it is, path and all: that is
// how an install names a control plane that answers at another path.

import { isLoopbackHost } from "../host/config";

/** Where, under a control plane's address, HX Fortress opens its connection. */
export const CONTROL_PLANE_PATH = "/v1/connection";

/** The path of a control plane that an install made before this one may
 *  still be connected to. It is recognized, so that its address is shown as a
 *  host. It is never built for a new connection. */
export const EARLIER_CONTROL_PLANE_PATH = "/_api/hx-gateway/vault-tunnel";

export type ControlPlaneUrl = { ok: true; url: string } | { ok: false; reason: string };

/**
 * The connection's address for what a person typed, or why it cannot be one.
 *
 * Cleartext is accepted only to this host itself, which is what a test of a
 * control plane on a laptop needs. Everywhere else the connection carries
 * HX Fortress's credential, so it is `wss:`.
 */
export function controlPlaneUrl(address: string): ControlPlaneUrl {
  const typed = address.trim();
  if (!typed) return { ok: false, reason: "Give the control plane's address" };
  if (/\s/.test(typed)) return { ok: false, reason: "An address has no spaces" };

  const socket = /^wss?:\/\//i.test(typed);
  let url: URL;
  try {
    url = new URL(socket || /^https?:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    return { ok: false, reason: "This is not an address. Give a host, such as control.example" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "The address must not hold a user name or a password" };
  }
  if (url.search || url.hash) {
    return { ok: false, reason: "The address must not hold a query or a fragment" };
  }
  if (!url.hostname.includes(".") && !isLoopbackHost(url.hostname)) {
    return { ok: false, reason: "This is not an address. Give a host, such as control.example" };
  }
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  if (!secure && !isLoopbackHost(url.hostname)) {
    return { ok: false, reason: "The control plane's address must be https" };
  }
  if (socket) return { ok: true, url: typed };
  const prefix = url.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${secure ? "wss" : "ws"}://${url.host}${prefix}${CONTROL_PLANE_PATH}` };
}

/**
 * What a person would type for a stored connection address: the host, and the
 * path in front of the protocol's own. A connection address of another shape
 * is shown as it is.
 */
export function controlPlaneAddress(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const path = [CONTROL_PLANE_PATH, EARLIER_CONTROL_PLANE_PATH].find((known) => parsed.pathname.endsWith(known));
  if (!path) return url;
  const prefix = parsed.pathname.slice(0, -path.length);
  if (parsed.protocol === "wss:") return `${parsed.host}${prefix}`;
  if (parsed.protocol === "ws:") return `http://${parsed.host}${prefix}`;
  return url;
}

/**
 * True when two connection addresses are the same control plane: the address
 * a person would give is the same for both. The path under it may be this
 * build's or an earlier one's, so an HX Fortress that enrolled at the earlier
 * path is still enrolled with that control plane, and is not held to be
 * enrolled with another. An address of any other shape is the same only as
 * itself.
 */
export function sameControlPlane(a: string, b: string): boolean {
  return a === b || controlPlaneAddress(a) === controlPlaneAddress(b);
}
