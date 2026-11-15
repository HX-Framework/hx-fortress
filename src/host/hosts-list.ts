// The one list of every host HX Fortress may call.
//
// An entry is one of three kinds, and only one kind is stored:
//
//   setting   An answer of the setup that names an outside service: the key
//             store, the sign-in provider, the file store, the AI model, the
//             control plane, the place the database program is downloaded
//             from. Worked out from the present answers each time the list is
//             read, with `reachOf`. Never stored.
//   manifest  A host that a module of the catalog names in its manifest.
//             Worked out from the catalog each time. Never stored.
//   reach     A host and a port that a signed-in person added to one module.
//             Stored in `hosts.json`, beside `config.json`.
//
// So a setting or a manifest entry cannot go stale. Nothing can add one by
// writing to the file.
//
// ONLY THE MODULE HOST CALLS `add` AND `remove`. It calls them while it carries
// out the act of a signed-in person, and it writes the act to the audit trail
// before it calls. This file writes nothing to the audit trail.
//
// THE FILE HOLDS ONLY WHAT `add` ACCEPTS. Every write goes through the
// lock-and-compare store of the console's own settings (`store-lock.ts`), so
// two acts at once cannot lose an entry. A file that is there and cannot be
// read is never written over: `add` refuses with `list_unreadable`, `remove`,
// `list` and `all` throw, and `find` gives nothing, so no program is started
// for a reach.
//
// THIS BUILD SHOWS THE LIST AND DOES NOT HOLD HX FORTRESS TO IT. When
// HX Fortress itself calls a host that is not on the list, the call is not
// refused yet: `REACH_IS_HELD` in `src/setup/reach.ts` says so.

import { ipv4Octets, ipv6Groups, isHostName } from "../modules/databases/host-text";
import type { SetupAnswers } from "../setup/answers";
import { STEP_IDS, type StepId } from "../setup/list";
import { reachOf, type ReachRow } from "../setup/reach";
import { needsFiles, readAnswers } from "../setup/read";
import { JsonCasStore, StoreCorruptError, type LockReclaim } from "../ui/store-lock";
import { MODULE_CATALOG, catalogEntry, type CatalogEntry } from "./module-catalog";
import { isModuleId } from "./module-contract";
import { isOrganizationId } from "./organization-id";
import type { fortressPaths } from "./paths";
import { isIsoInstant, isName } from "./shape";

type FortressPaths = ReturnType<typeof fortressPaths>;

// ── The entries ──────────────────────────────────────────────────────────────

export const HOST_KINDS = ["setting", "manifest", "reach"] as const;
export type HostKind = (typeof HOST_KINDS)[number];

/** The port of an entry when nothing names another. */
export const DEFAULT_PORT = 443;

/** Most reaches one module keeps for one organization. */
export const REACHES_MAX = 64;

/** Longest name of a reach. */
export const REACH_NAME_MAX_CHARS = 64;

/** A host and a port that a signed-in person added to one module. The only
 *  kind of entry that is stored. */
export interface ReachEntry {
  kind: "reach";
  /** The module's id. */
  module: string;
  /** Absent for HX Fortress's own organization, else the organization's id. */
  organization?: string;
  /** A `name` (see `shape.ts`) of 1 to 64 characters. Unique for one module
   *  and organization: two names that differ only by case are the same. */
  name: string;
  /** A DNS name or an address, in lower case. */
  host: string;
  /** 1 to 65535. */
  port: number;
  /** The console login of the person who added it. */
  addedBy: string;
  /** When it was added, as `Date#toISOString()` writes it. */
  addedAt: string;
}

/** An answer of the setup that names an outside service. */
export interface SettingEntry {
  kind: "setting";
  /**
   * Null when the answer names the service and not its host: a database that
   * is reached by an address kept in the key store, for example. `described`
   * then says what the service is, so the list claims no host it does not
   * know.
   */
  host: string | null;
  /** 443 unless the answer gives another. Null when the host is null. */
  port: number | null;
  /** What the service is, in words. Present only when the host is null. */
  described?: string;
  /** What the host is called for: "sign-in", "AI model". */
  why: string;
  /** The id of the setup's question whose answer it is. */
  question: StepId;
}

/** A host that a module of the catalog names in its manifest. */
export interface ManifestEntry {
  kind: "manifest";
  /** A DNS name in lower case. `*.<name>` stands for every host under that
   *  name. */
  host: string;
  /** 443: a module calls out over https only. */
  port: number;
  why: string;
  /** The module's id. */
  module: string;
}

/** A reach as the whole list gives it: with what it is for. */
export interface ListedReach extends ReachEntry {
  /** The module's title and the reach's name. */
  why: string;
}

export type HostEntry = SettingEntry | ManifestEntry | ListedReach;

/** Why `add` changed nothing. */
export const ADD_REFUSALS = [
  // The module and organization already have a reach with this name.
  "name_taken",
  // The module and organization already have 64 reaches.
  "too_many",
  // The host is not a DNS name or an address, or the port is not 1 to 65535.
  "not_a_host",
  // The host is one that `hostAllowed` refuses.
  "host_not_allowed",
  // `hosts.json` is there and cannot be read.
  "list_unreadable",
] as const;
export type AddRefusal = (typeof ADD_REFUSALS)[number];

export type AddResult = { ok: true } | { ok: false; reason: AddRefusal };

/** What `manifest` entries are called for. A manifest gives no reason of its
 *  own. */
export const MANIFEST_WHY = "named in its manifest";

/** What a setting whose answer cannot be read as an address is called, in
 *  place of that answer. */
export const UNREADABLE_ADDRESS = "an address that cannot be read";

/**
 * A call to the list was given a value that the list does not take: a module
 * id, an organization id, a name, a login or a time of the wrong shape. The
 * module host checks these before it calls, so this is a fault of the caller.
 * Nothing was written.
 */
export class ReachEntryInvalid extends Error {
  readonly field: string;

  constructor(field: string) {
    // The value is not repeated. A value in the wrong place can be anything.
    super(`the list of hosts was given a ${field} that it does not take`);
    this.name = "ReachEntryInvalid";
    this.field = field;
  }
}

/** `hosts.json` is there and cannot be read. Nothing was written to it. */
export class HostsListUnreadable extends Error {
  readonly file: string;

  constructor(file: string) {
    super(
      `The list of hosts at ${file} cannot be read. Nothing was written to it. ` +
        "Restore it from a backup, or move it aside and add each reach again on its module's page.",
    );
    this.name = "HostsListUnreadable";
    this.file = file;
  }
}

// ── Hosts as text ────────────────────────────────────────────────────────────

/** Longest DNS name. */
const NAME_MAX_CHARS = 253;

/** A console login, as the console shows and records one: 1 to 128 printable
 *  characters and no space. A local account's login, an address, and `sub:`
 *  with a provider's id for the person are all of this shape. */
const LOGIN_PATTERN = /^[\x21-\x7e]{1,128}$/;

/**
 * The host as the list keeps it, or null when the text is not a host.
 *
 * A host is a DNS name, an IPv4 address written as four decimal numbers, or an
 * IPv6 address with or without brackets. It is kept in lower case, without
 * brackets, and without the dot a name may end in. A text that holds a user
 * name, a path, a port, a wildcard, a space or a zone is not a host.
 */
export function listedHost(text: unknown): string | null {
  if (typeof text !== "string" || text.length === 0 || text.length > NAME_MAX_CHARS + 2) return null;
  const lower = text.toLowerCase();
  if (lower.startsWith("[") || lower.endsWith("]")) {
    // Brackets hold an IPv6 address, and nothing else.
    const inner = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : "";
    return ipv6Groups(inner) !== null ? inner : null;
  }
  if (lower.includes(":")) return ipv6Groups(lower) !== null ? lower : null;
  if (ipv4Octets(lower) !== null) return lower;
  const name = lower.endsWith(".") ? lower.slice(0, -1) : lower;
  return isHostName(name) ? name : null;
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

/** The names of the cloud metadata services. */
const METADATA_NAMES: ReadonlySet<string> = new Set(["metadata.google.internal", "metadata.azure.internal"]);

/** The IPv6 address of the metadata service of AWS, fd00:ec2::254: its eight
 *  groups, joined the way `ipv6Allowed` compares them. Its IPv4 address,
 *  169.254.169.254, is link-local. */
const METADATA_IPV6 = [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x254].join(":");

/**
 * Whether HX Fortress may call this host or address.
 *
 * False for a loopback, link-local, unspecified or multicast address, IPv4 or
 * IPv6, and for the address or the name of a cloud's metadata service. An IPv4
 * address written inside an IPv6 one is judged as that IPv4 address. A private
 * address is allowed: a database is usually at one.
 *
 * False for every text that is not a host, too. That includes an IPv4 address
 * written another way than four decimal numbers: `2130706433`, `0x7f.1`,
 * `0177.0.0.1`. Programs read such a text in different ways, so nobody can say
 * which address it would call.
 *
 * This is the one copy of the rule. `add` holds a reach's host to it. Whatever
 * connects to a host by its name holds the address the name resolves to, at
 * that moment, to it as well: a name can answer with a loopback address later.
 */
export function hostAllowed(address: string): boolean {
  if (typeof address !== "string" || address.length === 0 || address.length > NAME_MAX_CHARS + 2) {
    return false;
  }
  let text = address.toLowerCase();
  const bracketed = text.startsWith("[") && text.endsWith("]");
  if (bracketed) text = text.slice(1, -1);
  if (text.includes(":")) {
    // A zone names the network interface that a link-local address is reached
    // on. The address is what is judged.
    const zone = text.indexOf("%");
    const groups = ipv6Groups(zone >= 0 ? text.slice(0, zone) : text);
    return groups !== null && ipv6Allowed(groups);
  }
  // Brackets hold an IPv6 address, and nothing else.
  if (bracketed) return false;
  const octets = ipv4Octets(text);
  if (octets !== null) return ipv4Allowed(octets);
  const name = text.endsWith(".") ? text.slice(0, -1) : text;
  if (!isHostName(name) || METADATA_NAMES.has(name)) return false;
  // `localhost`, and every name under it, is loopback by definition.
  return name !== "localhost" && !name.endsWith(".localhost");
}

function ipv4Allowed(octets: readonly number[]): boolean {
  const [a = 0, b = 0] = octets;
  if (a === 0) return false; // 0.0.0.0/8: unspecified
  if (a === 127) return false; // 127.0.0.0/8: loopback
  if (a === 169 && b === 254) return false; // 169.254.0.0/16: link-local, with 169.254.169.254
  if (a >= 224 && a <= 239) return false; // 224.0.0.0/4: multicast
  return true;
}

function ipv6Allowed(groups: readonly number[]): boolean {
  const g0 = groups[0] ?? 0;
  const g1 = groups[1] ?? 0;
  const g5 = groups[5] ?? 0;
  const g6 = groups[6] ?? 0;
  const g7 = groups[7] ?? 0;
  const zeroFrom = (from: number, to: number): boolean => groups.slice(from, to).every((group) => group === 0);
  if (zeroFrom(0, 8)) return false; // ::, unspecified
  if (zeroFrom(0, 7) && g7 === 1) return false; // ::1, loopback
  if ((g0 & 0xffc0) === 0xfe80) return false; // fe80::/10, link-local
  if ((g0 & 0xff00) === 0xff00) return false; // ff00::/8, multicast
  if (groups.join(":") === METADATA_IPV6) return false;
  // An IPv4 address inside an IPv6 one: mapped (::ffff:a.b.c.d), compatible
  // (::a.b.c.d), and behind the NAT64 prefix (64:ff9b::a.b.c.d).
  const mapped = zeroFrom(0, 5) && g5 === 0xffff;
  const compatible = zeroFrom(0, 6);
  const nat64 = g0 === 0x64 && g1 === 0xff9b && zeroFrom(2, 6);
  if (mapped || compatible || nat64) return ipv4Allowed([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  return true;
}

// ── The stored part ──────────────────────────────────────────────────────────

interface HostsFile {
  /** The store's count of writes. */
  version?: number;
  reaches: ReachEntry[];
}

function isReachName(value: unknown): value is string {
  return isName(value) && value.length >= 1 && value.length <= REACH_NAME_MAX_CHARS;
}

function isLogin(value: unknown): value is string {
  return typeof value === "string" && LOGIN_PATTERN.test(value);
}

/** An organization as the calls take it: null or absent for HX Fortress's
 *  own, else an organization's id. */
function isOrganizationArg(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || isOrganizationId(value);
}

/** The module and organization a call names. Throws `ReachEntryInvalid`. */
function owner(module: unknown, organization: unknown): { module: string; organization: string | null } {
  if (!isModuleId(module)) throw new ReachEntryInvalid("module");
  if (!isOrganizationArg(organization)) throw new ReachEntryInvalid("organization");
  return { module, organization: organization ?? null };
}

/** True for a reach exactly as `add` writes one. */
function isStoredReach(value: unknown): value is ReachEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.kind === "reach" &&
    isModuleId(entry.module) &&
    (entry.organization === undefined || isOrganizationId(entry.organization)) &&
    isReachName(entry.name) &&
    typeof entry.host === "string" &&
    listedHost(entry.host) === entry.host &&
    hostAllowed(entry.host) &&
    isPort(entry.port) &&
    isLogin(entry.addedBy) &&
    typeof entry.addedAt === "string" &&
    isIsoInstant(entry.addedAt)
  );
}

/** One reach's place in the file: its module, its organization, and its name
 *  in lower case. */
function placeOf(reach: ReachEntry): string {
  return JSON.stringify([reach.module, reach.organization ?? null, reach.name.toLowerCase()]);
}

/**
 * The file as this module writes it, or null when it is not one.
 *
 * Null is "cannot be read", and nothing is guessed. Every reach must be one
 * that `add` would take, and no two may have one place. A key this build does
 * not know is kept as it is, in the file and in each reach, and is written
 * back with the rest.
 */
function parseHostsFile(raw: unknown): HostsFile | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const reaches = (raw as Record<string, unknown>).reaches;
  if (!Array.isArray(reaches)) return null;
  const places = new Set<string>();
  for (const reach of reaches as unknown[]) {
    if (!isStoredReach(reach)) return null;
    const place = placeOf(reach);
    if (places.has(place)) return null;
    places.add(place);
  }
  return raw as HostsFile;
}

function sameOwner(reach: ReachEntry, module: string, organization: string | null): boolean {
  return reach.module === module && (reach.organization ?? null) === organization;
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Ordered by UTF-16 code units, the same on every machine. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** By module, then organization (HX Fortress's own first), then name. */
function compareReaches(a: ReachEntry, b: ReachEntry): number {
  const organization =
    a.organization === b.organization
      ? 0
      : a.organization === undefined
        ? -1
        : b.organization === undefined
          ? 1
          : compareText(a.organization, b.organization);
  return (
    compareText(a.module, b.module) ||
    organization ||
    compareText(a.name.toLowerCase(), b.name.toLowerCase()) ||
    compareText(a.name, b.name)
  );
}

/** A reach with the fields of its kind and no other. */
function plainReach(reach: ReachEntry): ReachEntry {
  return {
    kind: "reach",
    module: reach.module,
    ...(reach.organization === undefined ? {} : { organization: reach.organization }),
    name: reach.name,
    host: reach.host,
    port: reach.port,
    addedBy: reach.addedBy,
    addedAt: reach.addedAt,
  };
}

/** Thrown inside a write to end it with nothing written. */
class Refused extends Error {
  readonly reason: AddRefusal;

  constructor(reason: AddRefusal) {
    super(reason);
    this.name = "Refused";
    this.reason = reason;
  }
}

/** Thrown inside a write that finds nothing to remove. */
class NothingToRemove extends Error {
  constructor() {
    super("nothing to remove");
    this.name = "NothingToRemove";
  }
}

// ── The entries that are worked out ──────────────────────────────────────────

/** The question of the setup that each reason of `reachOf` comes from. A test
 *  holds this table to `reachOf`. */
const QUESTION_OF: ReadonlyMap<string, StepId> = new Map<string, StepId>([
  ["keys", "keys"],
  ["database", "data"],
  ["database program, once", "data"],
  ["files", "data"],
  ["sign-in", "signIn"],
  ["AI model", "model"],
  ["audit trail copy", "auditTrail"],
  ["new versions", "updates"],
  ["control plane", "controlPlane"],
  ["control plane, new versions", "controlPlane"],
]);

/** The question a row is under when its reason is not in the table above: the
 *  question that shows the whole list. */
const LIST_QUESTION: StepId = "network";

/**
 * A host, and the port after it when one is written, as `URL#host` writes the
 * two: `db.example`, `db.example:5432`, `[2001:db8::1]:8443`. Null when the
 * text is not that.
 */
function hostAndPort(text: string): { host: string; port: number } | null {
  let hostText = text;
  let portText: string | null = null;
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 0) return null;
    hostText = text.slice(0, end + 1);
    const rest = text.slice(end + 1);
    if (rest !== "") {
      if (!rest.startsWith(":")) return null;
      portText = rest.slice(1);
    }
  } else {
    // One colon parts a host from its port. More than one is an IPv6 address
    // written without brackets, and without a port.
    const colon = text.indexOf(":");
    if (colon >= 0 && colon === text.lastIndexOf(":")) {
      hostText = text.slice(0, colon);
      portText = text.slice(colon + 1);
    }
  }
  const host = listedHost(hostText);
  if (host === null) return null;
  if (portText === null) return { host, port: DEFAULT_PORT };
  const port = /^[0-9]{1,5}$/.test(portText) ? Number(portText) : Number.NaN;
  return isPort(port) ? { host, port } : null;
}

/**
 * The words for a setting whose host is not known.
 *
 * `reachOf` writes such a row as a phrase: "the address in db-url", "an
 * existing Postgres". A phrase is letters, digits, spaces and dashes. Any
 * other text is an answer that cannot be read as an address. It may hold a
 * user name or a query string, so it is not repeated.
 */
function describedAs(text: string): string {
  return /^[A-Za-z0-9 -]{1,200}$/.test(text) ? text : UNREADABLE_ADDRESS;
}

function settingEntry(row: ReachRow): SettingEntry {
  const question = QUESTION_OF.get(row.why) ?? LIST_QUESTION;
  const at = hostAndPort(row.address);
  if (at) return { kind: "setting", host: at.host, port: at.port, why: row.why, question };
  return { kind: "setting", host: null, port: null, described: describedAs(row.address), why: row.why, question };
}

/** The `setting` entries for these answers, in the order of the questions. */
function settingEntries(answers: SetupAnswers): SettingEntry[] {
  const rank = (entry: SettingEntry): number => STEP_IDS.indexOf(entry.question);
  // The sort is stable, so the rows of one question keep the order `reachOf`
  // gives them.
  return reachOf(answers, { needsFiles: needsFiles(answers) })
    .map(settingEntry)
    .sort((a, b) => rank(a) - rank(b));
}

/** The `manifest` entries of a catalog: by module, and in the manifest's own
 *  order within one module. */
function manifestEntries(catalog: readonly CatalogEntry[]): ManifestEntry[] {
  return [...catalog]
    .sort((a, b) => compareText(a.id, b.id))
    .flatMap((entry) =>
      (entry.manifest?.egress ?? []).map(
        (host): ManifestEntry => ({
          kind: "manifest",
          host: host.toLowerCase(),
          port: DEFAULT_PORT,
          why: MANIFEST_WHY,
          module: entry.id,
        }),
      ),
    );
}

function listedReach(reach: ReachEntry, catalog: readonly CatalogEntry[]): ListedReach {
  const title = catalogEntry(reach.module, catalog)?.title ?? reach.module;
  return {
    kind: "reach",
    host: reach.host,
    port: reach.port,
    why: `${title}: ${reach.name}`,
    module: reach.module,
    ...(reach.organization === undefined ? {} : { organization: reach.organization }),
    name: reach.name,
    addedBy: reach.addedBy,
    addedAt: reach.addedAt,
  };
}

// ── The list ─────────────────────────────────────────────────────────────────

export interface HostsListOptions {
  /** The modules of the build: their manifests, and their titles. Default: the
   *  catalog compiled into this binary. */
  catalog?: readonly CatalogEntry[];
  /** The present answers of the setup. Default: read from the folder and this
   *  process's environment, as `hx-fortress setup` reads them. */
  answers?: () => Promise<SetupAnswers>;
  /** Told when a lock that a writer left behind is taken over, so the caller
   *  can record it. */
  onReclaim?: (reclaim: LockReclaim) => void;
}

/**
 * The list of hosts of one HX Fortress.
 *
 * Every call reads the file as it is now. Nothing is kept from one call to the
 * next, so a reach that was added or removed by another process counts at
 * once.
 */
export class HostsList {
  private readonly store: JsonCasStore<HostsFile>;
  private readonly catalog: readonly CatalogEntry[];
  private readonly answers: () => Promise<SetupAnswers>;

  constructor(paths: FortressPaths, options: HostsListOptions = {}) {
    const catalog = options.catalog ?? MODULE_CATALOG;
    this.catalog = catalog;
    this.answers = options.answers ?? (async () => (await readAnswers(paths, process.env, { catalog })).answers);
    this.store = new JsonCasStore<HostsFile>({
      file: paths.hostsList,
      label: "hosts.json",
      parse: parseHostsFile,
      onReclaim: options.onReclaim,
    });
  }

  get file(): string {
    return this.store.file;
  }

  /**
   * Add a reach. Called by the module host only, inside a person's act, with
   * that person's login as `addedBy`.
   *
   * Refuses, and changes nothing, with one of `ADD_REFUSALS`. Throws
   * `ReachEntryInvalid` for a module, an organization, a name, a login or a
   * time of the wrong shape, and changes nothing then either.
   */
  async add(entry: ReachEntry): Promise<AddResult> {
    if (typeof entry !== "object" || entry === null) throw new ReachEntryInvalid("entry");
    if (entry.kind !== "reach") throw new ReachEntryInvalid("kind");
    const { module, organization } = owner(entry.module, entry.organization);
    if (!isReachName(entry.name)) throw new ReachEntryInvalid("name");
    if (!isLogin(entry.addedBy)) throw new ReachEntryInvalid("addedBy");
    if (typeof entry.addedAt !== "string" || !isIsoInstant(entry.addedAt)) throw new ReachEntryInvalid("addedAt");

    const host = listedHost(entry.host);
    if (host === null || !isPort(entry.port)) return { ok: false, reason: "not_a_host" };
    if (!hostAllowed(host)) return { ok: false, reason: "host_not_allowed" };
    const reach: ReachEntry = {
      kind: "reach",
      module,
      ...(organization === null ? {} : { organization }),
      name: entry.name,
      host,
      port: entry.port,
      addedBy: entry.addedBy,
      addedAt: entry.addedAt,
    };

    try {
      await this.store.update((current) => {
        const reaches = current?.reaches ?? [];
        const theirs = reaches.filter((other) => sameOwner(other, module, organization));
        if (theirs.some((other) => sameName(other.name, reach.name))) throw new Refused("name_taken");
        if (theirs.length >= REACHES_MAX) throw new Refused("too_many");
        return { ...current, reaches: [...reaches, reach] };
      });
    } catch (thrown) {
      if (thrown instanceof Refused) return { ok: false, reason: thrown.reason };
      if (thrown instanceof StoreCorruptError) return { ok: false, reason: "list_unreadable" };
      throw thrown;
    }
    return { ok: true };
  }

  /**
   * Remove a reach. Called by the module host only, inside a person's act, and
   * for each reach of a module that is uninstalled.
   *
   * True when the reach was there and is removed. False when there was none,
   * and then nothing is written. Throws `HostsListUnreadable` when the file is
   * there and cannot be read.
   */
  async remove(module: string, organization: string | null, name: string): Promise<boolean> {
    const at = owner(module, organization);
    if (!isReachName(name)) throw new ReachEntryInvalid("name");
    const matches = (reach: ReachEntry): boolean =>
      sameOwner(reach, at.module, at.organization) && sameName(reach.name, name);
    // Read once without the lock: when there is nothing to remove, nothing is
    // locked and nothing is written.
    if (!(await this.reaches()).some(matches)) return false;
    try {
      await this.store.update((current) => {
        const reaches = current?.reaches ?? [];
        const kept = reaches.filter((reach) => !matches(reach));
        if (kept.length === reaches.length) throw new NothingToRemove();
        return { ...current, reaches: kept };
      });
    } catch (thrown) {
      if (thrown instanceof NothingToRemove) return false;
      if (thrown instanceof StoreCorruptError) throw new HostsListUnreadable(this.file);
      throw thrown;
    }
    return true;
  }

  /**
   * The host and the port of one reach, or null. The module host calls this
   * each time it starts a program for a module, and starts none on null.
   *
   * Null also when the file cannot be read, and for a module, an organization
   * or a name of the wrong shape: none of those can name a reach.
   */
  async find(module: string, organization: string | null, name: string): Promise<{ host: string; port: number } | null> {
    if (!isModuleId(module) || !isOrganizationArg(organization) || !isReachName(name)) return null;
    const read = await this.store.read();
    if (read.state !== "ok" || read.doc === null) return null;
    const reach = read.doc.reaches.find(
      (other) => sameOwner(other, module, organization ?? null) && sameName(other.name, name),
    );
    return reach ? { host: reach.host, port: reach.port } : null;
  }

  /** Every reach of one module and organization, by name. For the module's
   *  page. Throws `HostsListUnreadable` when the file cannot be read. */
  async list(module: string, organization: string | null): Promise<ReachEntry[]> {
    const at = owner(module, organization);
    return (await this.reaches())
      .filter((reach) => sameOwner(reach, at.module, at.organization))
      .sort(compareReaches)
      .map(plainReach);
  }

  /**
   * The whole list, for the pages and the printed rules: the settings in the
   * order of the questions, then the manifests by module, then the reaches by
   * module, organization and name. Throws `HostsListUnreadable` when the file
   * cannot be read: a list without its reaches would read as complete.
   */
  async all(): Promise<HostEntry[]> {
    const reaches = await this.reaches();
    const answers = await this.answers();
    return [
      ...settingEntries(answers),
      ...manifestEntries(this.catalog),
      ...[...reaches].sort(compareReaches).map((reach) => listedReach(reach, this.catalog)),
    ];
  }

  /** The stored reaches, or none when there is no file. */
  private async reaches(): Promise<ReachEntry[]> {
    const read = await this.store.read();
    if (read.state === "corrupt") throw new HostsListUnreadable(this.file);
    return read.doc?.reaches ?? [];
  }
}
