// What a host looks like, as text: a DNS name, an IPv4 address or an IPv6
// address.
//
// This is about the text only. Whether this HX Fortress may dial a host is the
// list of hosts' to say, and that list is the module host's. What is here is
// what a connection's own fields are held to, and what anything that sorts
// addresses into kinds reads them with. The last function is about one more
// text: the address of a Store's gateway on this machine.

/** Longest host a connection keeps: the longest name an act's argument takes. */
export const HOST_MAX_CHARS = 128;

/**
 * The four numbers of an IPv4 address written as four decimal numbers, or null
 * when the text is not one.
 *
 * Other spellings that some resolvers take are not an address here: `127.1`,
 * `0x7f.0.0.1`, one large number, and a number with a zero in front, which a C
 * library reads as octal.
 */
export function ipv4Octets(text: string): [number, number, number, number] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^(?:0|[1-9][0-9]{0,2})$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) return null;
  return octets as [number, number, number, number];
}

/** The eight groups of an IPv6 address, or null when the text is not one. The
 *  text is taken in lower case, without brackets and without a zone. */
export function ipv6Groups(text: string): number[] | null {
  let rest = text;
  // An IPv4 address may stand in the place of the last two groups. It is read
  // as those two groups.
  const lastColon = rest.lastIndexOf(":");
  if (lastColon < 0) return null;
  const dotted = rest.slice(lastColon + 1);
  if (dotted.includes(".")) {
    const v4 = ipv4Octets(dotted);
    if (!v4) return null;
    const high = ((v4[0] << 8) | v4[1]).toString(16);
    const low = ((v4[2] << 8) | v4[3]).toString(16);
    rest = `${rest.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
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
 * `0x7f.1`), so nobody could say what it would dial.
 */
export function isHostName(text: string): boolean {
  if (text.length === 0 || text.length > 253) return false;
  const labels = text.split(".");
  const last = labels[labels.length - 1] ?? "";
  if (/^(?:[0-9]+|0x[0-9a-f]*)$/i.test(last)) return false;
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[A-Za-z0-9_-]+$/.test(label) &&
      !label.startsWith("-") &&
      !label.endsWith("-"),
  );
}

/**
 * Whether a text is a host: a DNS name, an IPv4 address, or an IPv6 address
 * written without brackets. A name may end in one dot. An address may not.
 */
export function isHost(text: string): boolean {
  if (text.length === 0 || text.length > HOST_MAX_CHARS) return false;
  const lower = text.toLowerCase();
  if (lower.includes(":")) return ipv6Groups(lower) !== null;
  if (ipv4Octets(lower) !== null) return true;
  return isHostName(lower.replace(/\.$/, ""));
}

/**
 * The one form of an address that names a Store's gateway on this machine:
 * `http://127.0.0.1:<port>` or `http://[::1]:<port>`, with the port written
 * out and an optional path of letters, digits and `. _ ~ / -`.
 *
 * It is matched on the text itself, so the text that was checked is the text
 * the program is handed: no reading of an address by one parser is trusted to
 * be the reading of another.
 */
export function isLocalGateway(address: string): boolean {
  // Each part has a fixed place, and the path's parts begin with a slash.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})((?:\/[A-Za-z0-9._~-]+)*)\/?$/.exec(address);
  if (!match || address.length > 512) return false;
  if (Number(match[1]) > 65_535) return false;
  return !(match[2] ?? "").split("/").some((part) => part === "." || part === "..");
}
