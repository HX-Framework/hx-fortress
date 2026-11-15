// Which hosts a reach may name.
//
// A reach is a host and a port that a person added to a module, so that a
// helper program of the module can be sent there. A database is usually at a
// private address, so a private address is taken here. What is refused is an
// address that can only mean this machine or the machinery around it: a
// loopback, link-local, unspecified or multicast address, such an address
// written inside an IPv6 one, a cloud's metadata address, and a name that
// means this machine.
//
// THIS LOOKS AT THE TEXT ONLY. A name is taken whatever it resolves to, except
// the names below. What a name resolves to is looked at when a program is
// about to be sent there, which is not in this file.
//
// The rule is written here from the text up, and reads no other module's code:
// a rule that decides what this HX Fortress may be sent to has one owner.

/** The longest host a reach may name. An audit record holds a value of at most
 *  200 characters, and a host that did not fit would be written cut short. */
export const REACH_HOST_MAX_CHARS = 128;

export type ReachHostRefusal = "reach_host_invalid" | "reach_address_refused";

/** Names that mean this machine in the hosts file of a common system. */
const THIS_MACHINE: ReadonlySet<string> = new Set([
  "localhost",
  "localhost.localdomain",
  "localhost4",
  "localhost4.localdomain4",
  "localhost6",
  "localhost6.localdomain6",
  "ip6-localhost",
  "ip6-loopback",
]);

/** Names at which a cloud answers an instance's metadata. */
const METADATA_NAMES: ReadonlySet<string> = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.azure.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

/** The addresses two clouds answer an instance's metadata at, over IPv6. They
 *  are in a private range, which is taken otherwise. */
const METADATA_V6: readonly string[] = ["fd00:ec2:0:0:0:0:0:254", "fd20:ce:0:0:0:0:0:254"];

/**
 * The four numbers of an IPv4 address written as four decimal numbers, or null
 * when the text is not one.
 *
 * No other spelling is an address here: `127.1`, `0x7f.0.0.1`, one large
 * number, or a number with a zero in front, which a C library reads as octal.
 */
export function ipv4Octets(text: string): [number, number, number, number] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets as [number, number, number, number];
}

/** One run of groups between colons, as numbers. Null when a group is not one
 *  to four hex digits. */
function groupsOf(part: string): number[] | null {
  if (part === "") return [];
  const groups: number[] = [];
  for (const group of part.split(":")) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    groups.push(Number.parseInt(group, 16));
  }
  return groups;
}

/**
 * The eight groups of an IPv6 address, or null when the text is not one. The
 * text is in lower case, without brackets and without a zone.
 */
export function ipv6Groups(text: string): number[] | null {
  let rest = text;
  const lastColon = rest.lastIndexOf(":");
  if (lastColon < 0) return null;
  // An IPv4 address may stand in the place of the last two groups.
  const tailText = rest.slice(lastColon + 1);
  if (tailText.includes(".")) {
    const v4 = ipv4Octets(tailText);
    if (!v4) return null;
    const high = ((v4[0] << 8) | v4[1]).toString(16);
    const low = ((v4[2] << 8) | v4[3]).toString(16);
    rest = `${rest.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const head = groupsOf(halves[0] ?? "");
  const tail = halves.length === 2 ? groupsOf(halves[1] ?? "") : [];
  if (!head || !tail) return null;
  const known = head.length + tail.length;
  // "::" stands for one group of zeros or more.
  if (halves.length === 2 ? known > 7 : known !== 8) return null;
  return [...head, ...new Array<number>(8 - known).fill(0), ...tail];
}

/**
 * A DNS name: labels of letters, digits, `_` and `-`, joined by dots, none
 * starting or ending with `-`.
 *
 * A name whose last label is a number is not a name. Anything that reads a
 * host loosely takes such a text for an address (`127.1`, `2130706433`,
 * `0x7f.1`), so nobody could say where it leads.
 */
function isHostName(text: string): boolean {
  if (text.length === 0 || text.length > 253) return false;
  const labels = text.split(".");
  const last = labels[labels.length - 1] ?? "";
  if (/^(?:[0-9]+|0x[0-9a-f]*)$/.test(last)) return false;
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9_-]+$/.test(label) &&
      !label.startsWith("-") &&
      !label.endsWith("-"),
  );
}

/** Unspecified, loopback, link-local (a cloud's metadata address is there),
 *  multicast, and what lies past it up to the broadcast address. */
function refusedIpv4(octets: readonly number[]): boolean {
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224;
}

const v4Of = (high: number, low: number): number[] => [high >> 8, high & 0xff, low >> 8, low & 0xff];

/** An IPv4 address that an IPv6 address carries inside it, or null. Mapped,
 *  compatible (which also covers `::` and `::1`), translated, and the two
 *  prefixes that carry an IPv4 address to another network. */
function ipv4Inside(groups: readonly number[]): number[] | null {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number, number, number, number, number, number, number, number,
  ];
  const zeros = (...of: number[]): boolean => of.every((group) => group === 0);
  if (zeros(g0, g1, g2, g3, g4) && (g5 === 0xffff || g5 === 0)) return v4Of(g6, g7);
  if (zeros(g0, g1, g2, g3, g5) && g4 === 0xffff) return v4Of(g6, g7);
  if (g0 === 0x64 && g1 === 0xff9b && zeros(g2, g3, g4, g5)) return v4Of(g6, g7);
  if (g0 === 0x2002) return v4Of(g1, g2);
  return null;
}

/**
 * Why a host may not be a reach, or null when it may.
 *
 * `reach_host_invalid`: the text is not a DNS name, an IPv4 address or an IPv6
 * address written without brackets, or it is longer than a record can hold.
 * `reach_address_refused`: it is one of the addresses or names this file
 * refuses.
 *
 * Upper and lower case read the same. A name may end in one dot. An address
 * may not.
 */
export function reachHostRefusal(host: unknown): ReachHostRefusal | null {
  if (typeof host !== "string" || host.length === 0 || host.length > REACH_HOST_MAX_CHARS) {
    return "reach_host_invalid";
  }
  const lower = host.toLowerCase();
  if (lower.includes(":")) {
    const groups = ipv6Groups(lower);
    if (!groups) return "reach_host_invalid";
    if (METADATA_V6.includes(groups.map((group) => group.toString(16)).join(":"))) {
      return "reach_address_refused";
    }
    const g0 = groups[0] ?? 0;
    // Link-local (fe80::/10) and multicast (ff00::/8).
    if ((g0 & 0xffc0) === 0xfe80 || g0 >> 8 === 0xff) return "reach_address_refused";
    const inside = ipv4Inside(groups);
    return inside && refusedIpv4(inside) ? "reach_address_refused" : null;
  }
  const v4 = ipv4Octets(lower);
  if (v4) return refusedIpv4(v4) ? "reach_address_refused" : null;
  const name = lower.replace(/\.$/, "");
  if (!isHostName(name)) return "reach_host_invalid";
  if (THIS_MACHINE.has(name) || name.endsWith(".localhost") || METADATA_NAMES.has(name)) {
    return "reach_address_refused";
  }
  return null;
}

/** Whether a port is one a reach may name. */
export function isReachPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65_535;
}
