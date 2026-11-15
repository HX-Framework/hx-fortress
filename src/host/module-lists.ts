// The two lists a person adds to, for one module and one organization: the
// hosts a helper program of the module may be sent to (its reaches), and the
// names of secrets the module may have read.
//
// WHERE THEY ARE KEPT. Each list is one 0600 file beside the module's `state`
// folder and never inside it: `reach.json` and `secret-names.json`. A module's
// state port cannot name either file, so a module cannot write its own lists.
// Only this file writes them, and only the context of an operator's act calls
// the two writers here (module-context.ts).
//
// The reaches are to move into this HX Fortress's one list of hosts when that
// list exists. The four calls of a reach list below are the four calls that
// list will have, with its words for a refusal, so the move changes where an
// entry is kept and nothing else.
//
// A FILE THAT CANNOT BE READ IS NOT AN EMPTY LIST. A file that is there and
// does not pass the checks below is read as "cannot be read": nothing is added
// to it and nothing is written over it, and a look-up in it finds nothing. A
// file that somebody edited by hand to hold a host this HX Fortress refuses
// is such a file, and so not one of its entries is used.
//
// One process writes these files: the daemon. Two acts at once take turns
// here, so neither loses the other's entry.

// Every path this file reads or writes is built by the module host from a
// module's id and an organization's id, both checked before, and one of two
// fixed names.

import path from "node:path";

import { MAX_ACTOR_CHARS } from "../console/audit-actions";
import { isSecretName } from "../secrets/types";
import { redactCredentials } from "../ui/redact";
import type { ReachEntry } from "./module-contract";
import { readSmallFile, writePrivateJson } from "./private-json";
import { isReachPort, reachHostRefusal } from "./reach-address";
import { isIsoInstant, isName } from "./shape";

/** Most entries one module and organization may have in either list. */
export const LIST_MAX_ENTRIES = 64;
export const REACH_NAME_MAX_CHARS = 64;

const REACH_FILE = "reach.json";
const SECRET_NAMES_FILE = "secret-names.json";
/** Far past what 64 entries can take. A larger file is not one of these. */
const LIST_FILE_MAX_BYTES = 256 * 1024;

/**
 * Whether a text can be written into an audit record as it is.
 *
 * The audit trail replaces what looks like a credential, also inside a name.
 * A name it would replace could not be read back in its own record, so no
 * list takes one.
 */
export function recordable(text: string): boolean {
  return redactCredentials(text) === text;
}

/** A reach's name: a `name` of 1 to 64 characters that a record can hold. */
export function isReachName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= REACH_NAME_MAX_CHARS &&
    isName(name) &&
    name.trim() === name &&
    recordable(name)
  );
}

/** A secret's name a person may add: the rule every key store has, and a name
 *  a record can hold. */
export function isAddableSecretName(name: unknown): name is string {
  return typeof name === "string" && isSecretName(name) && recordable(name);
}

function isWho(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_ACTOR_CHARS;
}

function isWhen(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && isIsoInstant(value);
}

/** The list is on the disk and cannot be read. */
export class ListUnreadable extends Error {
  constructor(readonly file: string) {
    super(`${path.basename(file)} cannot be read as a list`);
    this.name = "ListUnreadable";
  }
}

/** Why an entry was not added, in the words this HX Fortress's one list of
 *  hosts will use. */
export type ReachAddRefusal = "name_taken" | "too_many" | "not_a_host" | "host_not_allowed" | "list_unreadable";
export type SecretNameAddRefusal = "too_many" | "list_unreadable";

export interface AddedSecretName {
  name: string;
  addedBy: string;
  addedAt: string;
}

type Read<T> = { ok: true; entries: T[] } | { ok: false };

function reachOf(value: unknown): ReachEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (!isReachName(entry.name)) return null;
  if (typeof entry.host !== "string" || reachHostRefusal(entry.host) !== null || !recordable(entry.host)) {
    return null;
  }
  if (!isReachPort(entry.port) || !isWho(entry.addedBy) || !isWhen(entry.addedAt)) return null;
  return {
    name: entry.name,
    host: entry.host,
    port: entry.port,
    addedBy: entry.addedBy,
    addedAt: entry.addedAt,
  };
}

function secretNameOf(value: unknown): AddedSecretName | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (!isAddableSecretName(entry.name) || !isWho(entry.addedBy) || !isWhen(entry.addedAt)) return null;
  return { name: entry.name, addedBy: entry.addedBy, addedAt: entry.addedAt };
}

/** Read one list's file. A file that is not there is an empty list. A file
 *  that is there and fails any check is not a list. */
async function readList<T extends { name: string }>(
  file: string,
  entryOf: (value: unknown) => T | null,
): Promise<Read<T>> {
  // Never waits on what is at the path, and never reads more than a list can
  // hold: a named pipe or a huge file there is "unreadable" at once.
  const read = await readSmallFile(file, LIST_FILE_MAX_BYTES);
  if (read.state === "absent") return { ok: true, entries: [] };
  if (read.state === "unreadable") return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.bytes.toString("utf8"));
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
  const { version, entries } = parsed as { version?: unknown; entries?: unknown };
  if (version !== 1 || !Array.isArray(entries) || entries.length > LIST_MAX_ENTRIES) return { ok: false };
  const out: T[] = [];
  const names = new Set<string>();
  for (const raw of entries as unknown[]) {
    const entry = entryOf(raw);
    if (!entry || names.has(entry.name)) return { ok: false };
    names.add(entry.name);
    out.push(entry);
  }
  return { ok: true, entries: out };
}

/** The reaches of one module and one organization. */
export interface ReachList {
  /** Every entry. Rejects with `ListUnreadable`. */
  list(): Promise<ReachEntry[]>;
  /** The host and the port under a name, as the list is now. Null when the
   *  name is not on it, and when the list cannot be read. */
  find(name: string): Promise<{ host: string; port: number } | null>;
  /** Changes nothing when it refuses. */
  add(entry: ReachEntry): Promise<{ ok: true } | { ok: false; reason: ReachAddRefusal }>;
  /** True when an entry was removed. Rejects with `ListUnreadable`. */
  remove(name: string): Promise<boolean>;
}

/** The names of secrets added to one module and one organization. */
export interface SecretNameList {
  /** Rejects with `ListUnreadable`. */
  list(): Promise<AddedSecretName[]>;
  /** Whether the name is on the list now. False when the list cannot be read. */
  has(name: string): Promise<boolean>;
  /** A name that is already on the list is `{ ok: true, added: false }`. */
  add(entry: AddedSecretName): Promise<{ ok: true; added: boolean } | { ok: false; reason: SecretNameAddRefusal }>;
  remove(name: string): Promise<boolean>;
}

export class ModuleLists {
  /** The last write to each file. A write waits for the one before it. */
  private readonly turns = new Map<string, Promise<unknown>>();

  private turn<T>(file: string, work: () => Promise<T>): Promise<T> {
    const before = this.turns.get(file) ?? Promise.resolve();
    const mine = before.then(work, work);
    const settled = mine.catch(() => {});
    this.turns.set(file, settled);
    void settled.then(() => {
      if (this.turns.get(file) === settled) this.turns.delete(file);
    });
    return mine;
  }

  /** The reaches kept in `dir`: the folder that holds the module's `state`
   *  folder for one organization. */
  reaches(dir: string): ReachList {
    const file = path.join(dir, REACH_FILE);
    const read = (): Promise<Read<ReachEntry>> => readList(file, reachOf);
    const write = (entries: ReachEntry[]): Promise<void> =>
      writePrivateJson(file, { version: 1, entries }, { pretty: true });
    return {
      list: async () => {
        const held = await read();
        if (!held.ok) throw new ListUnreadable(file);
        return held.entries;
      },
      find: async (name) => {
        const held = await read();
        if (!held.ok) return null;
        const entry = held.entries.find((candidate) => candidate.name === name);
        return entry ? { host: entry.host, port: entry.port } : null;
      },
      add: (entry) =>
        this.turn(file, async () => {
          // Checked again here, whatever the caller checked: this is the last
          // step before an address is on the list.
          const refusal = reachHostRefusal(entry.host);
          if (refusal === "reach_address_refused") return { ok: false as const, reason: "host_not_allowed" as const };
          if (refusal !== null || !isReachPort(entry.port)) return { ok: false as const, reason: "not_a_host" as const };
          // What is left to be wrong is the caller's own doing: a name, a
          // login or a time that is not one. It is not written.
          if (reachOf(entry) === null) throw new TypeError("not an entry of the list of hosts");
          const held = await read();
          if (!held.ok) return { ok: false as const, reason: "list_unreadable" as const };
          if (held.entries.some((candidate) => candidate.name === entry.name)) {
            return { ok: false as const, reason: "name_taken" as const };
          }
          if (held.entries.length >= LIST_MAX_ENTRIES) return { ok: false as const, reason: "too_many" as const };
          await write([...held.entries, entry]);
          return { ok: true as const };
        }),
      remove: (name) =>
        this.turn(file, async () => {
          const held = await read();
          if (!held.ok) throw new ListUnreadable(file);
          const kept = held.entries.filter((candidate) => candidate.name !== name);
          if (kept.length === held.entries.length) return false;
          await write(kept);
          return true;
        }),
    };
  }

  /** The names of secrets kept in `dir`. */
  secretNames(dir: string): SecretNameList {
    const file = path.join(dir, SECRET_NAMES_FILE);
    const read = (): Promise<Read<AddedSecretName>> => readList(file, secretNameOf);
    const write = (entries: AddedSecretName[]): Promise<void> =>
      writePrivateJson(file, { version: 1, entries }, { pretty: true });
    return {
      list: async () => {
        const held = await read();
        if (!held.ok) throw new ListUnreadable(file);
        return held.entries;
      },
      has: async (name) => {
        const held = await read();
        return held.ok && held.entries.some((candidate) => candidate.name === name);
      },
      add: (entry) =>
        this.turn(file, async () => {
          if (secretNameOf(entry) === null) throw new TypeError("not an entry of the list of secret names");
          const held = await read();
          if (!held.ok) return { ok: false as const, reason: "list_unreadable" as const };
          if (held.entries.some((candidate) => candidate.name === entry.name)) {
            return { ok: true as const, added: false };
          }
          if (held.entries.length >= LIST_MAX_ENTRIES) return { ok: false as const, reason: "too_many" as const };
          await write([...held.entries, entry]);
          return { ok: true as const, added: true };
        }),
      remove: (name) =>
        this.turn(file, async () => {
          const held = await read();
          if (!held.ok) throw new ListUnreadable(file);
          const kept = held.entries.filter((candidate) => candidate.name !== name);
          if (kept.length === held.entries.length) return false;
          await write(kept);
          return true;
        }),
    };
  }
}
