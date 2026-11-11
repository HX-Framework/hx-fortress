// Whether a host in a URL is WRITTEN as an address this fortress must not dial
// on somebody else's word: loopback, link-local (cloud metadata lives there),
// a private range, or a numeric form that is not a plain address.
//
// A NAME IS NEVER ONE. `fcm.example.com` starts with "fc" and is not an address
// in fc00::/7; a name is checked against a list (a manifest's hosts, or the
// hosts an operator listed), and that list is the control for names. What a
// name RESOLVES to is not looked at here: a listed name that resolves to an
// inside address is dialed. That is stated in SECURITY.md.

import { isIP } from "node:net";

import { isPrivateOrLoopbackIp } from "../modules/session-vault/store/endpoint-safety";

/** A host as it is compared everywhere: no brackets, lower case, no final dot. */
export function bareHost(host: string): string {
  return host
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
}

export function isPrivateAddressLiteral(host: string): boolean {
  const bare = bareHost(host);
  if (isIP(bare) !== 0) return isPrivateOrLoopbackIp(bare);
  // Not a plain address. A host whose last label is a number is still an
  // address to anything that parses it loosely (`2130706433`, `0x7f.1`,
  // `0177.0.0.1`). The URL parser has already turned the valid ones into plain
  // addresses, which the line above saw; what is left in this form is refused.
  const last = bare.slice(bare.lastIndexOf(".") + 1);
  return /^(?:\d+|0x[0-9a-f]*)$/.test(last);
}
