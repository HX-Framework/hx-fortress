// M-4 · SSRF / exfiltration guard for a self-hosted vault's custom S3 endpoint.
//
// A self-hosted vault may point at an S3-compatible endpoint (MinIO, R2, …) via
// FORTRESS_S3_ENDPOINT. Left unvalidated, a hostile or mistaken endpoint could
// send the org's session bytes in cleartext, or aim the store's requests at a
// loopback / link-local / private-range address — including cloud metadata
// (169.254.169.254). So we require https and reject private/loopback IP literals
// unless the operator explicitly opts in (a legitimately-private MinIO on an
// internal network), and support an optional host allowlist. Throws on violation
// (fail-closed — the store is not built).

import { parseBooleanEnv } from "../../../env";

/** Reject a host whose SHAPE is an OBFUSCATED IP literal — an integer, hex, or
 *  octal encoding a browser/agent/S3 SDK would still dial (e.g. `2852039166`,
 *  `0x7f000001`, `0177.0.0.1`, `010.0.0.1`). We accept ONLY a canonical
 *  dotted-decimal quad or a real DNS hostname; everything else fails closed. This
 *  is belt-and-suspenders atop the WHATWG URL parser's own normalization, so the
 *  SSRF guard holds regardless of the runtime's host parser (a parser that does
 *  NOT canonicalize would otherwise let `2852039166` (=169.254.169.254) through). */
function isObfuscatedIpLiteral(host: string): boolean {
  // All-digits with no dots = a 32-bit integer IPv4 (e.g. 2852039166).
  if (/^\d+$/.test(host)) return true;
  // A `0x…` hex octet/whole-host (0x7f000001, 0x7f.0.0.1) — never a real hostname.
  if (/(^|\.)0[xX][0-9a-fA-F]+/.test(host)) return true;
  // A dotted octet with a LEADING ZERO = octal reinterpretation (0177.0.0.1). A
  // bare "0" octet (as in 0.0.0.0) is fine — only a leading zero + more digits.
  if (host.includes(".") && host.split(".").some((o) => /^0\d/.test(o))) return true;
  return false;
}

/** True for an IPv4/IPv6 LITERAL in a loopback / link-local / private / reserved
 *  range. A DNS name (e.g. "minio.internal") is not an IP literal and is not
 *  matched here — the allowlist is the control for names. Fail-closed: any address
 *  that resolves into a non-routable range is rejected (unless the operator opts
 *  in), including the unspecified `0.0.0.0/8`, carrier-grade NAT `100.64.0.0/10`,
 *  and IPv4-mapped-IPv6 in BOTH dotted and hex forms. */
function isPrivateOrLoopbackIp(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a > 255 || b > 255) return false;
    if (a === 0) return true; // 0.0.0.0/8 "this host" / unspecified
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. metadata)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
    return false;
  }
  const h = host.toLowerCase();
  if (h === "::1") return true; // IPv6 loopback
  if (h === "::" || h === "::0" || h === "0:0:0:0:0:0:0:0") return true; // unspecified
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7 unique-local (incl. fd00::/8)
  // fe80::/10 link-local: the first 10 bits are 1111111010, so the second hextet
  // spans 0x80–0xbf → fe80..febf. `startsWith("fe80")` missed fe8x/fe9x/feax/febx.
  if (/^fe[89ab]/.test(h)) return true;
  // IPv4-mapped IPv6, in dotted (::ffff:169.254.169.254) OR hex (::ffff:a9fe:a9fe)
  // form — a WHATWG parser normalizes the mapped v4 to hex, which the dotted-only
  // check missed. Re-classify the embedded v4 either way.
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (mappedDotted) return isPrivateOrLoopbackIp(mappedDotted[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const v4Dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateOrLoopbackIp(v4Dotted);
  }
  return false;
}

/** Validate a custom S3 endpoint before the store is constructed. No-op when no
 *  custom endpoint is configured (the AWS default chain resolves the real S3). */
export function assertS3EndpointSafe(
  endpoint: string | undefined,
  env: Record<string, string | undefined> = process.env,
): void {
  const raw = endpoint?.trim();
  if (!raw) return;

  const allowPrivate = parseBooleanEnv(env.FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("FORTRESS_S3_ENDPOINT must be a valid URL");
  }

  if (url.protocol !== "https:" && !allowPrivate) {
    throw new Error(
      "FORTRESS_S3_ENDPOINT must use https (set FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT for a private/plaintext endpoint)",
    );
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");

  const allowlist = (env.FORTRESS_S3_ENDPOINT_ALLOWLIST ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length > 0 && !allowlist.includes(host.toLowerCase())) {
    throw new Error(`FORTRESS_S3_ENDPOINT host is not in FORTRESS_S3_ENDPOINT_ALLOWLIST: ${host}`);
  }

  // Reject an obfuscated IP literal (integer / hex / octal) BEFORE the range
  // classifier — a host that isn't a canonical dotted quad or a real hostname is
  // never a legitimate endpoint and could smuggle a private/metadata address past
  // a parser that doesn't canonicalize. Fail-closed (operator opt-in still wins).
  if (!allowPrivate && isObfuscatedIpLiteral(host)) {
    throw new Error(
      `FORTRESS_S3_ENDPOINT host is an obfuscated IP literal — use a canonical hostname or dotted-decimal IPv4: ${host}`,
    );
  }

  if (!allowPrivate && isPrivateOrLoopbackIp(host)) {
    throw new Error(
      `FORTRESS_S3_ENDPOINT points at a private/loopback address: ${host} (set FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT to allow)`,
    );
  }
}
