// Who a request is FROM, for the purposes of rate limiting and lockout.
//
// X-Forwarded-For is a header any client can send. Honoring it unconditionally
// hands every attacker a fresh identity per request — rate limits and lockouts
// stop existing. Ignoring it unconditionally is just as bad behind a platform
// proxy: every request then arrives from one peer address and all the keys
// collapse onto it, so one attacker locks out the whole organization.
//
// So XFF is honored ONLY when the immediate peer is in the configured
// trustedProxies allowlist (empty by default), and the walk goes RIGHTMOST to
// left. Honest proxies APPEND, so the rightmost entries are the ones added by
// infrastructure we trust and the leftmost are whatever the client typed. The
// first entry from the right that is not itself a trusted proxy is the real
// remote; all-trusted, absent or malformed falls back to the peer address.

const HOP_CAP = 16;

/** Strip brackets, an interface zone, and the IPv4-mapped IPv6 prefix, so
 *  ::ffff:203.0.113.5 and 203.0.113.5 are one key rather than two. */
export function normalizeAddress(raw: string): string {
  let value = raw.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end > 0) value = value.slice(1, end);
  }
  const zone = value.indexOf("%");
  if (zone > 0) value = value.slice(0, zone);
  if (value.startsWith("::ffff:") && value.includes(".")) value = value.slice("::ffff:".length);
  return value;
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    bytes.push(byte);
  }
  return bytes;
}

function parseIpv6(value: string): number[] | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const expand = (part: string): number[] | null => {
    if (!part) return [];
    const groups: number[] = [];
    for (const group of part.split(":")) {
      const v4 = parseIpv4(group);
      if (v4) {
        groups.push(v4[0] as number, v4[1] as number, v4[2] as number, v4[3] as number);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      const word = Number.parseInt(group, 16);
      groups.push(word >> 8, word & 0xff);
    }
    return groups;
  };
  const head = expand(halves[0] ?? "");
  const tail = halves.length === 2 ? expand(halves[1] ?? "") : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 16 ? head : null;
  const fill = 16 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

/** 4 bytes for IPv4, 16 for IPv6. Null for anything else — a value we cannot
 *  compare is a value we never match, which is the safe direction. */
export function parseAddress(value: string): number[] | null {
  const normalized = normalizeAddress(value);
  return normalized.includes(":") ? parseIpv6(normalized) : parseIpv4(normalized);
}

/** True when `address` falls inside `entry` (an IP or a CIDR). Families never
 *  cross: an IPv4 address is not inside an IPv6 prefix. */
export function addressMatches(address: string, entry: string): boolean {
  const [network, prefix] = entry.split("/");
  const left = parseAddress(address);
  const right = parseAddress(network ?? "");
  if (!left || !right || left.length !== right.length) return false;
  const bits = prefix === undefined ? left.length * 8 : Number(prefix);
  if (!Number.isInteger(bits) || bits < 0 || bits > left.length * 8) return false;
  const whole = bits >> 3;
  for (let i = 0; i < whole; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  const rest = bits & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((left[whole] as number) & mask) === ((right[whole] as number) & mask);
}

export function isTrustedProxy(address: string, trusted: readonly string[]): boolean {
  return trusted.some((entry) => addressMatches(address, entry));
}

export interface RemoteKeyInputs {
  /** The socket peer — the only address the console observes directly. */
  peer: string;
  forwardedFor: string | null;
  trustedProxies: readonly string[];
}

/**
 * The key every rate bucket and lockout counter is stored under.
 *
 * ADVERSARIAL PROPERTY, tested: a trusted peer that prepends attacker-controlled
 * entries changes nothing, because the walk never reaches them — it stops at the
 * first non-trusted entry FROM THE RIGHT, which is the address the trusted proxy
 * itself observed.
 */
export function remoteKeyFor(inputs: RemoteKeyInputs): string {
  const peer = normalizeAddress(inputs.peer);
  if (inputs.trustedProxies.length === 0) return peer;
  if (!isTrustedProxy(peer, inputs.trustedProxies)) return peer;
  const header = inputs.forwardedFor?.trim();
  if (!header) return peer;
  const hops = header
    .split(",")
    .map((h) => normalizeAddress(h))
    .filter((h) => h !== "")
    .slice(-HOP_CAP);
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = hops[i] as string;
    if (!parseAddress(hop)) return peer; // malformed anywhere in the walk ⇒ the peer
    if (!isTrustedProxy(hop, inputs.trustedProxies)) return hop;
  }
  return peer;
}


/**
 * Which address the sign-in limits are actually keyed on.
 *
 * Printed by `hx-fortress ui config` and rendered in the Console-listener row of
 * the data-paths inventory, from ONE function, because the default is a silent
 * failure otherwise: behind a platform proxy with no trustedProxies configured,
 * every request arrives from the same peer, every rate and lockout key collapses
 * onto it, and one attacker locks out the organization. Nothing fails, nothing
 * logs, and the value that fixes it is one the corpus never said how to obtain.
 */
export function remoteKeySourceLine(
  trustedProxies: readonly string[],
  observedPeer?: string,
): string {
  if (trustedProxies.length === 0) {
    const keyedOn = observedPeer ? observedPeer : "the socket peer address";
    return (
      `X-Forwarded-For ignored - all sign-in limits keyed on ${keyedOn}. ` +
      "Behind a proxy or a platform edge, set `hx-fortress ui config set trustedProxies <csv>` or every " +
      "key collapses onto that one address."
    );
  }
  return (
    `X-Forwarded-For honored via trustedProxies (${trustedProxies.join(", ")}) - the walk is rightmost ` +
    "to left, skipping trusted entries, so a client-supplied prefix cannot change the key."
  );
}
