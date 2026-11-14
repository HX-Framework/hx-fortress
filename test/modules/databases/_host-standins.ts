// Stand-ins, for the tests, for what the module host will hand a module and
// does not yet: the two lists a person adds to, and the look-ups the host does
// before it starts a helper program.
//
// Each is written to the rule the host's contract gives for the real thing.
// They are test code: the product has no way to add to either list, and no
// way to start a program (src/modules/databases/standins.ts).
//
// The lists are kept in the module's own state, which is one organization's.
// The real ones are the host's, in the one list of hosts of an HX Fortress,
// and the host records each change.

import type { ModuleContextV2, ModuleStatePort } from "../../../src/host/module-contract";
import { isName } from "../../../src/host/shape";
import {
  ReachRefused,
  SecretNameRefused,
  type ModuleActContext,
  type Person,
  type ProgramFailure,
  type ProgramRun,
  type ReachEntry,
  type ReachPort,
  type SecretNamesPort,
} from "../../../src/modules/databases/host-ports";
import { ipv4Octets, ipv6Groups, isHost } from "../../../src/modules/databases/host-text";
import { DATABASES_PROGRAMS } from "../../../src/modules/databases/manifest";
import { isSecretName } from "../../../src/secrets/types";

/** Most entries one module and organization may have in either list. */
export const LIST_MAX = 64;
const REACH_NAME_MAX_CHARS = 64;
export const REACH_KEY = "standin-reach";
export const SECRET_NAMES_KEY = "standin-secret-names";

// ── Which addresses a reach may not be ───────────────────────────────────────

/** Names that mean this machine in the hosts file of a common system. */
const THIS_MACHINE = new Set([
  "localhost",
  "localhost.localdomain",
  "localhost4",
  "localhost4.localdomain4",
  "localhost6",
  "localhost6.localdomain6",
  "ip6-localhost",
  "ip6-loopback",
]);

/** The address two clouds answer their instance metadata at, over IPv6. */
const METADATA_V6 = ["fd00:ec2::254", "fd20:ce::254"].map((text) => (ipv6Groups(text) ?? []).join(":"));

function refusedIpv4(octets: readonly number[]): boolean {
  const [a, b] = octets as [number, number];
  // Unspecified, loopback, link-local (a cloud's metadata address is there),
  // multicast and what lies past it.
  return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224;
}

const v4Of = (high: number, low: number): number[] => [high >> 8, high & 0xff, low >> 8, low & 0xff];

/**
 * Whether a host is one a reach may not name: a loopback, link-local,
 * unspecified or multicast address, one of those written inside an IPv6
 * address, or a text that is not a host at all.
 *
 * A private address is taken: a database is usually at one. A NAME is taken
 * whatever it resolves to, except the names that mean this machine.
 */
export function reachHostRefusal(host: string): "reach_host_invalid" | "reach_address_refused" | null {
  // Without brackets, in lower case. A name may end in one dot. An address may not.
  const plain = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!isHost(plain)) return "reach_host_invalid";
  const bare = plain.replace(/\.$/, "");
  if (THIS_MACHINE.has(bare) || bare.endsWith(".localhost")) return "reach_address_refused";
  const v4 = ipv4Octets(bare);
  if (v4) return refusedIpv4(v4) ? "reach_address_refused" : null;
  const groups = bare.includes(":") ? ipv6Groups(bare) : null;
  if (!groups) return null;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number, number, number, number, number, number, number, number,
  ];
  if (METADATA_V6.includes(groups.join(":"))) return "reach_address_refused";
  if ((g0 & 0xffc0) === 0xfe80 || g0 >> 8 === 0xff) return "reach_address_refused";
  const zeros = (...of: number[]): boolean => of.every((group) => group === 0);
  // An IPv4 address written inside an IPv6 one is held to the IPv4 rule:
  // mapped, compatible (which also covers `::` and `::1`), translated, and the
  // two prefixes that carry an IPv4 address to another network.
  let inside: number[] | null = null;
  if (zeros(g0, g1, g2, g3, g4) && (g5 === 0xffff || g5 === 0)) inside = v4Of(g6, g7);
  else if (zeros(g0, g1, g2, g3, g5) && g4 === 0xffff) inside = v4Of(g6, g7);
  else if (g0 === 0x64 && g1 === 0xff9b && zeros(g2, g3, g4, g5)) inside = v4Of(g6, g7);
  else if (g0 === 0x2002) inside = v4Of(g1, g2);
  return inside && refusedIpv4(inside) ? "reach_address_refused" : null;
}

// ── The two lists ────────────────────────────────────────────────────────────

const readReach = async (state: ModuleStatePort): Promise<ReachEntry[]> =>
  (await state.read<ReachEntry[] | null>(REACH_KEY)) ?? [];
const readNames = async (state: ModuleStatePort): Promise<string[]> =>
  (await state.read<string[] | null>(SECRET_NAMES_KEY)) ?? [];

function reachList(state: ModuleStatePort, person: Person, clock: () => Date): ReachPort {
  return {
    list: () => readReach(state),
    async add(name, to) {
      if (!isName(name) || name.length === 0 || name.length > REACH_NAME_MAX_CHARS) {
        throw new ReachRefused("reach_name_invalid");
      }
      const refusal = reachHostRefusal(to.host);
      if (refusal) throw new ReachRefused(refusal);
      if (!Number.isInteger(to.port) || to.port < 1 || to.port > 65_535) {
        throw new ReachRefused("reach_port_invalid");
      }
      const entries = await readReach(state);
      if (entries.some((entry) => entry.name === name)) throw new ReachRefused("reach_name_taken");
      if (entries.length >= LIST_MAX) throw new ReachRefused("reach_list_full");
      entries.push({ name, host: to.host, port: to.port, addedBy: person.login, addedAt: clock().toISOString() });
      await state.write(REACH_KEY, entries);
    },
    async remove(name) {
      const entries = await readReach(state);
      const kept = entries.filter((entry) => entry.name !== name);
      if (kept.length !== entries.length) await state.write(REACH_KEY, kept);
    },
  };
}

function secretNamesList(state: ModuleStatePort): SecretNamesPort {
  return {
    list: () => readNames(state),
    async add(name) {
      if (!isSecretName(name)) throw new SecretNameRefused("secret_name_invalid");
      const names = await readNames(state);
      if (names.includes(name)) return;
      if (names.length >= LIST_MAX) throw new SecretNameRefused("secret_names_full");
      await state.write(SECRET_NAMES_KEY, [...names, name]);
    },
    async remove(name) {
      const names = await readNames(state);
      const kept = names.filter((entry) => entry !== name);
      if (kept.length !== names.length) await state.write(SECRET_NAMES_KEY, kept);
    },
  };
}

/** The context of a person's act: the organization's context, and the two
 *  lists only a person may change. */
export function actContext(ctx: ModuleContextV2, person: Person, clock: () => Date): ModuleActContext {
  const state = ctx.state;
  return {
    moduleId: ctx.moduleId,
    logger: ctx.logger,
    get fortressIdentity() {
      return ctx.fortressIdentity;
    },
    organization: ctx.organization,
    secrets: ctx.secrets,
    audit: ctx.audit,
    state,
    fetch: (url, init) => ctx.fetch(url, init),
    reach: reachList(state, person, clock),
    secretNames: secretNamesList(state),
  };
}

/** What the host has looked up for one run of a program, or why it starts none. */
export type LookedUp =
  | { ok: true; args: readonly string[]; reach: { host: string; port: number } }
  | { ok: false; code: ProgramFailure };

/** The look-ups the host does before it starts a program: the program is one
 *  the module declares, the reach is on the list, and so is each secret's name. */
export async function lookUp(state: ModuleStatePort, program: string, run: ProgramRun): Promise<LookedUp> {
  const declared = DATABASES_PROGRAMS.find((entry) => entry.id === program);
  if (!declared) return { ok: false, code: "program_not_declared" };
  const entry = (await readReach(state)).find((reach) => reach.name === run.reach);
  if (!entry) return { ok: false, code: "reach_not_listed" };
  const added = await readNames(state);
  for (const name of Object.values(run.secrets)) {
    if (!added.includes(name)) return { ok: false, code: "secret_not_added" };
  }
  return { ok: true, args: declared.args, reach: { host: entry.host, port: entry.port } };
}
