// Fetching a release artifact the control plane named.
//
// The URL comes from the control plane. The bytes it leads to are not trusted
// because they were fetched: the signature decides that afterwards. But the
// fetch is itself an act, and the control plane must not be able to point it at
// this host's own network, at a cloud metadata address, at a host this fortress
// has never spoken to, or at a body that never ends.
//
// So the control plane does not choose WHERE. An artifact is fetched from one
// of:
//
//   • the control plane's own origin — the same origin the self-update already
//     downloads from, derived from the enrolled cloud URL. The fortress talks
//     to that host all day; fetching from it reaches nothing new.
//   • a host the operator listed in FORTRESS_RELEASE_HOSTS, over https, on
//     port 443 unless the entry names another port (`files.example:8443`), and
//     never one written as an address in a private, loopback or link-local
//     range.
//
// Everything else is refused before anything is dialed. That includes a name
// nobody listed: a name can be pointed at an inside address, and although the
// service there could not present a certificate for it, the attempt alone
// would tell the control plane what answers on this host's network.
//
// The rest:
//
//   • No credentials in the URL.
//   • Redirects are followed by hand, at most five, and every hop is held to
//     the same rule.
//   • At most 64 MiB, counted as it arrives. `Content-Length` is checked first
//     and never believed.
//   • No content encoding. The runtime inflates a compressed response on its
//     own, whatever the request asked for (measured: 8 KiB on the wire arrive
//     as 8 MiB), so a small body could pass the limit before the count saw it.
//     The request asks for none, the runtime is told not to inflate, and a
//     response that names an encoding is refused before its body is read.
//   • One deadline over the whole fetch.

import { downloadBaseFromCloudUrl } from "../update";
import { FORTRESS_VERSION } from "../version";
import { bareHost, isPrivateAddressLiteral } from "./address-literal";

/** Largest artifact a release may be. */
export const RELEASE_MAX_BYTES = 64 * 1024 * 1024;
/** How long one whole fetch may take, redirects included. */
export const RELEASE_FETCH_TIMEOUT_MS = 120_000;
const RELEASE_MAX_REDIRECTS = 5;
const RELEASE_URL_MAX_CHARS = 2048;

export type ReleaseFetchRule =
  | "url_malformed"
  | "url_not_https"
  | "url_credentials"
  | "url_private_address"
  | "url_host_not_allowed"
  | "fetch_failed"
  | "fetch_status"
  | "fetch_too_large"
  | "fetch_encoded"
  | "fetch_redirect_refused"
  | "fetch_timeout";

export class ReleaseFetchRefused extends Error {
  readonly rule: ReleaseFetchRule;

  constructor(rule: ReleaseFetchRule) {
    super(`release artifact fetch refused: ${rule}`);
    this.name = "ReleaseFetchRefused";
    this.rule = rule;
  }
}

/** Where an artifact may be fetched from. */
export interface ReleaseSources {
  /** The control plane's own origin (`https://control.example`), or null when
   *  this fortress has no readable cloud URL. Matched exactly: scheme, host and
   *  port. */
  controlPlaneOrigin: string | null;
  /** Hosts the operator listed, lower-case: `name` for port 443, or
   *  `name:port`. Reached over https only. */
  hosts: readonly string[];
}

/** The control plane's own origin for a cloud URL: the origin the self-update
 *  downloads from. Null for a URL this build cannot read. */
export function controlPlaneOriginOf(cloudUrl: string): string | null {
  try {
    return new URL(downloadBaseFromCloudUrl(cloudUrl)).origin;
  } catch {
    return null;
  }
}

/** The hosts in FORTRESS_RELEASE_HOSTS: comma-separated, each `name` or
 *  `name:port`. A name alone means port 443 and no other, and `name:443` is
 *  the same entry. An address may be written in brackets, as in a URL. */
export function listedReleaseHosts(env: Record<string, string | undefined>): string[] {
  return (env.FORTRESS_RELEASE_HOSTS ?? "")
    .split(",")
    .map((entry) => {
      const text = entry.trim().toLowerCase();
      let host = text;
      let port = "";
      const close = text.startsWith("[") ? text.indexOf("]") : -1;
      if (close > 0) {
        // `[addr]` or `[addr]:port`, as a URL writes an IPv6 address.
        host = text.slice(1, close);
        const rest = text.slice(close + 1);
        port = rest.startsWith(":") ? rest.slice(1) : "";
      } else if (text.indexOf(":") === text.lastIndexOf(":") && text.includes(":")) {
        // One colon: `name:port`. More than one is a bare IPv6 address, which
        // is left whole.
        host = text.slice(0, text.indexOf(":"));
        port = text.slice(text.indexOf(":") + 1);
      }
      // A port that is not a number is not a port: such an entry matches nothing.
      if (port !== "" && !/^\d{1,5}$/.test(port)) return "";
      const name = host.replace(/\.$/, "");
      return port !== "" && port !== "443" ? `${name}:${port}` : name;
    })
    .filter(Boolean);
}

/** The rule a URL breaks, or null. No network: this is what lets an offer be
 *  refused before anything is dialed. */
export function artifactUrlDefect(raw: unknown, sources: ReleaseSources): ReleaseFetchRule | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > RELEASE_URL_MAX_CHARS) {
    return "url_malformed";
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "url_malformed";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "url_not_https";
  if (url.username || url.password) return "url_credentials";
  const host = bareHost(url.hostname);
  if (!host) return "url_malformed";

  // The control plane's own origin, exactly. Cleartext only where the control
  // plane itself is cleartext, which the rule for its address (`cloud.url`)
  // allows for a loopback address alone.
  if (sources.controlPlaneOrigin !== null && url.origin === sources.controlPlaneOrigin) return null;

  if (url.protocol !== "https:") return "url_not_https";
  if (isPrivateAddressLiteral(host)) return "url_private_address";
  // The port is part of what the operator listed. A name alone is port 443: a
  // listed file server is not thereby reachable on every port it has open.
  const listed = url.port === "" ? host : `${host}:${url.port}`;
  if (!sources.hosts.includes(listed)) return "url_host_not_allowed";
  return null;
}

export interface ReleaseFetchOptions {
  sources: ReleaseSources;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

/** The artifact's bytes, or a `ReleaseFetchRefused` naming the rule. */
export async function fetchReleaseArtifact(
  artifactUrl: string,
  options: ReleaseFetchOptions,
): Promise<Uint8Array> {
  const doFetch = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? RELEASE_MAX_BYTES;
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, options.timeoutMs ?? RELEASE_FETCH_TIMEOUT_MS);

  try {
    let current = artifactUrl;
    for (let hop = 0; ; hop += 1) {
      const defect = artifactUrlDefect(current, options.sources);
      if (defect) {
        // A defect on a later hop is a redirect this host will not follow.
        throw new ReleaseFetchRefused(hop === 0 ? defect : "fetch_redirect_refused");
      }
      let response: Response;
      try {
        response = await doFetch(current, {
          redirect: "manual",
          signal: abort.signal,
          // The bytes as they are on the wire, never inflated by the runtime.
          decompress: false,
          headers: {
            "User-Agent": `hx-fortress/${FORTRESS_VERSION}`,
            "Accept-Encoding": "identity",
          },
        });
      } catch {
        throw new ReleaseFetchRefused(timedOut ? "fetch_timeout" : "fetch_failed");
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => {});
        if (!location || hop >= RELEASE_MAX_REDIRECTS) {
          throw new ReleaseFetchRefused("fetch_redirect_refused");
        }
        try {
          current = new URL(location, current).toString();
        } catch {
          throw new ReleaseFetchRefused("fetch_redirect_refused");
        }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new ReleaseFetchRefused("fetch_status");
      }
      const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
      if (encoding && encoding !== "identity") {
        await response.body?.cancel().catch(() => {});
        throw new ReleaseFetchRefused("fetch_encoded");
      }
      return await readBounded(response, maxBytes, () => timedOut);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(
  response: Response,
  maxBytes: number,
  timedOut: () => boolean,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ReleaseFetchRefused("fetch_too_large");
  }
  const body = response.body;
  if (!body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    if (whole.byteLength > maxBytes) throw new ReleaseFetchRefused("fetch_too_large");
    return whole;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ReleaseFetchRefused("fetch_too_large");
      }
      chunks.push(value);
    }
  } catch (thrown) {
    if (thrown instanceof ReleaseFetchRefused) throw thrown;
    throw new ReleaseFetchRefused(timedOut() ? "fetch_timeout" : "fetch_failed");
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
