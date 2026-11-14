// Stand-ins for what the module host does not hand a module yet.
//
// Each one takes the place of a port in host-ports.ts, and each is written to
// the rule the module host's contract gives for the real thing. They exist so
// the module can be built and tested before the host has them. They are not
// the host's ports:
//
//   • The two lists (hosts this module may reach, names of secrets it may have
//     read) are kept in the module's own state. The real ones are the host's,
//     in the Fortress's one list of hosts, and the host records each change.
//
//   • NO PROGRAM IS STARTED. With no launcher given, `programs.run` answers
//     `program_not_installed` for every run. That is what the daemon is given,
//     so a Fortress of this build dials no database. Starting a program is the
//     host's to do, with its limits and its own audit record, and this module
//     does not do it in the host's place. A test gives a launcher of its own.
//
//   • NO QUERY IS RECORDED. With no recorder given, the record of a query
//     cannot be written, and a query that cannot be recorded does not run.
//
// When the host hands a module the real ports on its context, this file goes.

import { bareHost } from "../../host/address-literal";
import type { ModuleContextV2 } from "../../host/module-contract";
import { isName } from "../../host/shape";
import { isSecretName } from "../../secrets/types";
import {
  ReachRefused,
  SecretNameRefused,
  type ActPorts,
  type ContextPorts,
  type DatabasesHostPorts,
  type Person,
  type ProgramOutcome,
  type ProgramsPort,
  type QueryRecordsPort,
  type ReachEntry,
  type ReachPort,
  type SecretNamesPort,
} from "./host-ports";
import { DATABASES_PROGRAMS } from "./manifest";

/** Most entries one module and organization may have in either list, as the
 *  host's contract says. */
const LIST_MAX = 64;
const REACH_NAME_MAX_CHARS = 64;
const REACH_KEY = "standin-reach";
const SECRET_NAMES_KEY = "standin-secret-names";

// ── Which addresses a reach may not be ───────────────────────────────────────

/** The eight groups of an IPv6 address, or null when the text is not one. */
function ipv6Groups(text: string): number[] | null {
  let rest = text;
  // An IPv4 address may stand in the place of the last two groups. It is read
  // as those two groups.
  const lastColon = rest.lastIndexOf(":");
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

function ipv4Octets(text: string): [number, number, number, number] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^[0-9]{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) return null;
  return octets as [number, number, number, number];
}

function refusedIpv4(octets: readonly number[]): boolean {
  const [a, b] = octets as [number, number];
  // Unspecified, loopback, link-local (a cloud's metadata address is there),
  // multicast and what lies past it.
  return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224;
}

/**
 * Whether a host is one a reach may not name: a loopback, link-local,
 * unspecified or multicast address, or a text that is not a host at all.
 *
 * A private address is taken: a database is usually at one. A NAME is taken
 * whatever it resolves to, except the names that mean this machine.
 */
export function reachHostRefusal(host: string): "reach_host_invalid" | "reach_address_refused" | null {
  const bare = bareHost(host);
  if (bare.length === 0 || bare.length > 253) return "reach_host_invalid";
  if (bare === "localhost" || bare.endsWith(".localhost")) return "reach_address_refused";
  if (bare.includes(":")) {
    const groups = ipv6Groups(bare);
    if (!groups) return "reach_host_invalid";
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
      number, number, number, number, number, number, number, number,
    ];
    const leadingZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
    if (leadingZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return "reach_address_refused";
    if ((g0 & 0xffc0) === 0xfe80 || g0 >> 8 === 0xff) return "reach_address_refused";
    // An IPv4 address written inside an IPv6 one is held to the IPv4 rule.
    if (leadingZero && (g5 === 0xffff || g5 === 0)) {
      return refusedIpv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]) ? "reach_address_refused" : null;
    }
    return null;
  }
  const v4 = ipv4Octets(bare);
  if (v4) return refusedIpv4(v4) ? "reach_address_refused" : null;
  const labels = bare.split(".");
  // A name whose last label is a number is an address to anything that reads
  // it loosely (`2130706433`, `0x7f.1`), so it is not a name.
  const last = labels[labels.length - 1] ?? "";
  if (/^(?:[0-9]+|0x[0-9a-f]*)$/.test(last)) return "reach_host_invalid";
  const wellFormed = labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9_-]+$/.test(label) &&
      !label.startsWith("-") &&
      !label.endsWith("-"),
  );
  return wellFormed ? null : "reach_host_invalid";
}

// ── The two lists, kept in the module's own state ────────────────────────────

function standInReach(ctx: ModuleContextV2, person: Person | null, clock: () => Date): ReachPort {
  const read = async (): Promise<ReachEntry[]> =>
    (await ctx.state.read<ReachEntry[] | null>(REACH_KEY)) ?? [];
  const actor = (): string => {
    // Only an act's context has the adders, and an act has a person.
    if (!person) throw new ReachRefused("reach_not_listed");
    return person.login;
  };
  return {
    list: read,
    async add(name, to) {
      const addedBy = actor();
      if (!isName(name) || name.length === 0 || name.length > REACH_NAME_MAX_CHARS) {
        throw new ReachRefused("reach_name_invalid");
      }
      const refusal = reachHostRefusal(to.host);
      if (refusal) throw new ReachRefused(refusal);
      if (!Number.isInteger(to.port) || to.port < 1 || to.port > 65_535) {
        throw new ReachRefused("reach_port_invalid");
      }
      const entries = await read();
      if (entries.some((entry) => entry.name === name)) throw new ReachRefused("reach_name_taken");
      if (entries.length >= LIST_MAX) throw new ReachRefused("reach_list_full");
      entries.push({ name, host: to.host, port: to.port, addedBy, addedAt: clock().toISOString() });
      await ctx.state.write(REACH_KEY, entries);
    },
    async remove(name) {
      actor();
      const entries = await read();
      const kept = entries.filter((entry) => entry.name !== name);
      if (kept.length !== entries.length) await ctx.state.write(REACH_KEY, kept);
    },
  };
}

function standInSecretNames(ctx: ModuleContextV2, person: Person | null): SecretNamesPort {
  const read = async (): Promise<string[]> =>
    (await ctx.state.read<string[] | null>(SECRET_NAMES_KEY)) ?? [];
  const guard = (): void => {
    if (!person) throw new SecretNameRefused("secret_name_invalid");
  };
  return {
    list: read,
    async add(name) {
      guard();
      if (!isSecretName(name)) throw new SecretNameRefused("secret_name_invalid");
      const names = await read();
      if (names.includes(name)) return;
      if (names.length >= LIST_MAX) throw new SecretNameRefused("secret_names_full");
      await ctx.state.write(SECRET_NAMES_KEY, [...names, name]);
    },
    async remove(name) {
      guard();
      const names = await read();
      const kept = names.filter((entry) => entry !== name);
      if (kept.length !== names.length) await ctx.state.write(SECRET_NAMES_KEY, kept);
    },
  };
}

// ── The program, and the record of a query ───────────────────────────────────

/** What a launcher is handed: everything the host has looked up for one run. */
export interface ProgramLaunch {
  program: string;
  /** The fixed arguments the manifest lists for the program. */
  args: readonly string[];
  /** The reach's host and port, from the list. */
  reach: { host: string; port: number };
  /** A field's name to the NAME of its secret. The launcher reads the values. */
  secrets: Readonly<Record<string, string>>;
  input: unknown;
  onOutput: (value: unknown) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ProgramLauncher = (launch: ProgramLaunch) => Promise<ProgramOutcome>;

function standInPrograms(ctx: ModuleContextV2, launcher: ProgramLauncher | undefined): ProgramsPort {
  return {
    async run(program, run) {
      const declared = DATABASES_PROGRAMS.find((entry) => entry.id === program);
      if (!declared) return { ok: false, code: "program_not_declared" };
      const entry = ((await ctx.state.read<ReachEntry[] | null>(REACH_KEY)) ?? []).find(
        (reach) => reach.name === run.reach,
      );
      if (!entry) return { ok: false, code: "reach_not_listed" };
      const added = (await ctx.state.read<string[] | null>(SECRET_NAMES_KEY)) ?? [];
      for (const name of Object.values(run.secrets)) {
        if (!added.includes(name)) return { ok: false, code: "secret_not_added" };
      }
      if (!launcher) return { ok: false, code: "program_not_installed" };
      return launcher({
        program,
        args: declared.args,
        reach: { host: entry.host, port: entry.port },
        secrets: run.secrets,
        input: run.input,
        onOutput: run.onOutput,
        ...(run.timeoutMs === undefined ? {} : { timeoutMs: run.timeoutMs }),
        ...(run.signal === undefined ? {} : { signal: run.signal }),
      });
    },
  };
}

/** The record of a query cannot be written on this host. */
export class QueryRecordUnavailable extends Error {
  constructor() {
    super("this Fortress cannot record a query's text yet, so it runs none");
    this.name = "QueryRecordUnavailable";
  }
}

const NO_QUERY_RECORDS: QueryRecordsPort = {
  open: () => Promise.reject(new QueryRecordUnavailable()),
  refused: () => Promise.reject(new QueryRecordUnavailable()),
};

export interface StandInOptions {
  /** How a program is started. Left out, none is: every run answers
   *  `program_not_installed`. */
  launcher?: ProgramLauncher;
  /** Where the record of a query goes. Left out, no query can be recorded, so
   *  none runs. */
  queryRecords?: (ctx: ModuleContextV2) => QueryRecordsPort;
  clock?: () => Date;
}

export function createStandInPorts(options: StandInOptions = {}): DatabasesHostPorts {
  const clock = options.clock ?? ((): Date => new Date());
  const shared = (ctx: ModuleContextV2): Pick<ContextPorts, "programs" | "queryRecords"> => ({
    programs: standInPrograms(ctx, options.launcher),
    queryRecords: options.queryRecords?.(ctx) ?? NO_QUERY_RECORDS,
  });
  return {
    forContext(ctx: ModuleContextV2): ContextPorts {
      return {
        reach: { list: standInReach(ctx, null, clock).list },
        secretNames: { list: standInSecretNames(ctx, null).list },
        ...shared(ctx),
      };
    },
    forAct(ctx: ModuleContextV2, person: Person): ActPorts {
      return {
        reach: standInReach(ctx, person, clock),
        secretNames: standInSecretNames(ctx, person),
        ...shared(ctx),
      };
    },
  };
}
