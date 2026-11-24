// A control plane's address, and the addresses worked out from it.
//
// An HX Fortress connects to a control plane at one address: a `wss://` address,
// such as `wss://control.example/v1/connection`. A few other things live
// beside it on the same control plane, over https: the requests of an
// enrollment from a terminal, the key the control plane publishes, and the
// files of a release it offers a module. This file is the one place that works
// out where "beside it" is.
//
// "Beside" is the connection's address without its last path segment. This
// file assumes no path of any control plane: whichever path the connection's
// address has decides. (The setup is what builds a connection's address from
// the address a person gives: src/setup/control-plane.ts.)
//
//   wss://control.example/v1/connection        ->  https://control.example/v1
//   wss://control.example/connect              ->  https://control.example
//   wss://control.example                      ->  https://control.example
//
// It works out nothing about where HX Fortress itself is downloaded from.
// That is src/update-source.ts, and it never reads a control plane's address.

import { readFile } from "node:fs/promises";

import { isLoopbackHost } from "../host/config";

/**
 * The https address that the control plane's other requests hang off: its
 * address with `https` for `wss` and without its last path segment.
 *
 * `ws` becomes `http` for this host itself and `https` for any other host, so
 * nothing is asked in clear text across a network. A user name, a password, a
 * query and a fragment are dropped: none of them belongs to another request.
 * Throws on a value that is not a control plane's address.
 */
export function controlPlaneHttpBase(address: string): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error("the control plane's address is not an address");
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error("the control plane's address must start with wss://");
  }
  url.protocol = url.protocol === "ws:" && isLoopbackHost(url.hostname) ? "http:" : "https:";
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  // The last segment is the connection itself. A slash after it changes nothing.
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  segments.pop();
  url.pathname = `/${segments.join("/")}`;
  return url.toString().replace(/\/+$/, "");
}

/**
 * The control plane's address this HX Fortress has in config.json, or null when
 * it has none: an HX Fortress with no control plane, or one that was never set
 * up. A config.json that cannot be read also yields null here;
 * whoever needs the file for more reports that it cannot be read.
 */
export async function readControlPlaneAddress(paths: { config: string }): Promise<string | null> {
  try {
    // HX Fortress's own config.json.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const parsed: unknown = JSON.parse(await readFile(paths.config, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const cloud = (parsed as { cloud?: unknown }).cloud;
    if (typeof cloud !== "object" || cloud === null) return null;
    const url = (cloud as { url?: unknown }).url;
    if (typeof url !== "string") return null;
    // Throws on a value that is not a control plane's address.
    controlPlaneHttpBase(url);
    return url;
  } catch {
    return null;
  }
}
