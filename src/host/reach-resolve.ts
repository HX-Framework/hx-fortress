// Where a reach really leads: the address behind its host, looked at just
// before a program is sent there.
//
// When a person adds a host, the host is checked as text (reach-address.ts).
// A name is taken whatever it resolves to, because nothing is sent to it then.
// A name can lead anywhere, and where it leads can change: to this machine's
// own loopback address, or to a cloud's metadata address. So the name is
// looked up here, at the moment a program is to be sent, and what it leads to
// is held to the same rule as an address a person typed.
//
// THE PROGRAM IS GIVEN THE ADDRESS THAT WAS CHECKED, NOT THE NAME. The program
// connects to that address and looks nothing up itself. So a name that leads
// somewhere else a moment later changes nothing for this run. The program
// still knows the server by its name, which is what the server's certificate
// is checked against.
//
// EVERY ADDRESS THE NAME LEADS TO IS JUDGED, not only the one that is used. A
// name that leads to this machine at one of its addresses is refused whole:
// which of them a later look would pick is not this file's to guess.

import { lookup as systemLookup } from "node:dns/promises";

import { ipv4Octets, ipv6Groups, reachHostRefusal } from "./reach-address";
import { withDeadline } from "./with-deadline";

/** How long the look-up of one name may take. */
export const REACH_RESOLVE_TIMEOUT_MS = 5_000;

/** The most addresses of one name that are looked at. A name with more is
 *  refused: nothing a database's name leads to is that many. */
export const REACH_RESOLVE_MAX_ADDRESSES = 64;

export type ReachResolveFailure =
  /** The name was not found, the look-up failed or took too long, or it
   *  answered what is no address. */
  | "reach_unresolved"
  /** The host, or an address its name leads to, is one a program is not sent
   *  to: this machine, a link-local or multicast address, a cloud's metadata
   *  address. */
  | "reach_address_refused";

export type ReachResolved = { ok: true; address: string } | { ok: false; code: ReachResolveFailure };

/** The addresses of a name, as the machine's own resolver gives them. */
export type ReachLookup = (name: string) => Promise<readonly { address: string; family: number }[]>;

/** The machine's own resolver: its hosts file, its search list and its name
 *  servers, as every program on this machine would be answered. */
const lookupWithSystem: ReachLookup = (name) => systemLookup(name, { all: true, verbatim: true });

const isAddress = (text: string): boolean => ipv4Octets(text) !== null || ipv6Groups(text.toLowerCase()) !== null;

/**
 * The address a program is sent to for this host, or why it is sent nowhere.
 * Never rejects.
 *
 * A host that is an address is that address, judged again by the rule: a list
 * on the disk can be older than the rule. A name is looked up. When it has an
 * IPv4 address, the first of those is the one that is used, because a machine
 * with no IPv6 route would fail on the other kind; else its first address.
 */
export async function resolveReach(
  host: string,
  deps: { lookup?: ReachLookup; timeoutMs?: number } = {},
): Promise<ReachResolved> {
  if (reachHostRefusal(host) !== null) return { ok: false, code: "reach_address_refused" };
  if (isAddress(host)) return { ok: true, address: host };
  let found: readonly { address: string; family: number }[];
  try {
    found = await withDeadline(
      (deps.lookup ?? lookupWithSystem)(host),
      deps.timeoutMs ?? REACH_RESOLVE_TIMEOUT_MS,
      "the look-up took too long",
      { unref: true },
    );
  } catch {
    // What was thrown names the host. Nothing of it is kept.
    return { ok: false, code: "reach_unresolved" };
  }
  if (!Array.isArray(found) || found.length === 0 || found.length > REACH_RESOLVE_MAX_ADDRESSES) {
    return { ok: false, code: "reach_unresolved" };
  }
  const addresses: string[] = [];
  for (const entry of found) {
    const address: unknown = (entry as { address?: unknown } | null)?.address;
    // An answer that is no address is no answer: a name is never handed on in
    // an address's place, because the program would look it up again.
    if (typeof address !== "string" || !isAddress(address)) return { ok: false, code: "reach_unresolved" };
    if (reachHostRefusal(address) !== null) return { ok: false, code: "reach_address_refused" };
    addresses.push(address);
  }
  const chosen = addresses.find((address) => ipv4Octets(address) !== null) ?? addresses[0];
  return chosen === undefined ? { ok: false, code: "reach_unresolved" } : { ok: true, address: chosen };
}
