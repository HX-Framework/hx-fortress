// The organizations a Fortress holds data for.
//
// A Fortress is run by one organization, its OWN. Every Fortress has exactly
// one, and almost every Fortress holds no other. A Fortress can also hold more
// organizations, for whoever runs one Fortress for several. Those are listed in
// a file on this host.
//
// ONE RULE FOLLOWS FROM THAT. Every ask is for one organization, and everything
// a module keeps is kept for one organization: its state, its rows and files,
// its audit records, its switch and the names of its secrets. This file is
// where the host knows which organizations there are and what each one's are.
// The module's context (module-context.ts) hands them out, one organization at
// a time, and has no call that takes an organization's id.
//
// A FORTRESS WITH ONE ORGANIZATION LOOKS AS IT DID BEFORE ORGANIZATIONS. Its
// own organization's state rests where a module's state always rested, its
// audit records carry no organization, and its switches are the ones in
// config.json. Nothing on its disk is named after an organization. So "own" is
// written nowhere: it is the absence of a mark. A mark is written only for
// another organization, and then it is that organization's id.
//
// WHO CAN ADD AN ORGANIZATION. Somebody who can write the Fortress's folder on
// this host, and nobody else. Nothing that arrives over the connection adds
// one, switches a module for one, or names a secret for one. A grant that names
// an organization this Fortress does not hold is refused.
//
// FAIL CLOSED. A list that cannot be read, or that holds one entry that breaks
// a rule, counts as no list at all: every ask for an organization in it is
// refused until the file is fixed. So does a list that cannot be checked in
// full, because one of the two ids no entry may carry cannot be read. Asks for
// the own organization do not depend on the list.
//
// ONE ID, ONE ORGANIZATION. An entry may not repeat another entry's id, and it
// may not carry an id of the own organization: neither the id this Fortress
// enrolled as, nor the id it made for itself. An ask that names the id the
// Fortress enrolled as is for the own organization, so such an entry would
// never be asked for, and what it says about modules and secrets would never
// hold.
//
// THE FILE IS READ AT EVERY LOOK, and nothing is trusted about it but its bytes.
// A look is: an ask whose grant names another organization, a secret read for
// one, the list a module is given when it starts, and the module host's own
// look once its modules have started and every few seconds after. Each look reads the whole
// file and compares it, byte for byte, with what was read last. It is parsed
// again only when the bytes changed. So a change is seen at the next look with
// no restart, a file that can no longer be read stops holding anybody at once,
// and nothing here depends on what a file system reports about when a file
// changed.
//
// ONE READ AT A TIME. Looks that arrive while the file is being read share the
// one read that starts after it, so a burst of asks costs one read and one
// copy of the file in memory, however many asks there are. The read is of a
// plain file of a known size: a name that is a pipe, a device or a folder is
// refused without being read.

import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { isSecretName } from "../secrets/types";
import { redactCredentials } from "../ui/redact";
import { isModuleId } from "./module-contract";
import { isOrganizationId, type Organization } from "./organization-id";
import type { ScopedLogger } from "./types";

export {
  isOrganizationId,
  ORGANIZATION_ID_PATTERN,
  ORGANIZATION_PARAM,
  organizationMark,
  type Organization,
} from "./organization-id";

/** The largest list this host reads. A list is a few hundred bytes for each
 *  organization, so this is tens of thousands of them. */
export const ORGANIZATIONS_FILE_MAX_BYTES = 8 * 1024 * 1024;

/** One entry of the list: an organization this Fortress holds besides its own. */
export interface HeldOrganization {
  /** The id a grant names the organization by. */
  id: string;
  /** The modules that are on for this organization. A module that is not here
   *  is off for it, whatever the Fortress's own switch says. */
  modules: ReadonlySet<string>;
  /** For each module: for a secret name the module's manifest declares, the
   *  name this organization's secret is stored under. */
  keys: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** What is wrong with a list, in fixed words. Never a value from the file. */
export type OrganizationsDefect =
  | "unreadable"
  | "too_large"
  | "not_json"
  | "not_a_list"
  | "version"
  | "entry_not_an_object"
  | "entry_unknown_field"
  | "id"
  | "id_listed_twice"
  | "id_is_the_own_organization"
  | "modules"
  | "keys"
  | "own_id_unreadable"
  | "enrolled_id_unreadable";

export type OrganizationsFile =
  | { ok: true; organizations: HeldOrganization[] }
  /** `entry` is the entry's place in the list, counted from 1. */
  | { ok: false; defect: OrganizationsDefect; entry?: number };

const ENTRY_FIELDS = new Set(["id", "modules", "keys"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether an id may be on the list: an organization's id, and one the audit
 * trail writes as it is.
 *
 * An id that looks like a credential would be a credential somebody pasted in
 * the wrong place, about to be written into every record of that organization
 * and into a folder's name. It is refused here, where the list is read.
 */
function isListableId(value: unknown): value is string {
  return isOrganizationId(value) && redactCredentials(value) === value;
}

/**
 * Read a list from its text. Strict: one entry that breaks a rule refuses the
 * whole list, so a list is either all in effect or not at all, and never the
 * part of it that happened to parse.
 *
 * `ownIds` are the ids of this Fortress's own organization: the one it
 * enrolled as once it has enrolled, and the one it made for itself when it has
 * made one. An entry may not carry either. With the first, the entry would
 * never be asked for. With the second, the two organizations would share every
 * row a module keys by it.
 */
export function parseOrganizations(
  text: string,
  ownIds: readonly (string | null)[] = [],
): OrganizationsFile {
  if (Buffer.byteLength(text) > ORGANIZATIONS_FILE_MAX_BYTES) return { ok: false, defect: "too_large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, defect: "not_json" };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.organizations)) {
    return { ok: false, defect: "not_a_list" };
  }
  if (parsed.version !== 1) return { ok: false, defect: "version" };

  const own = new Set(ownIds.filter((id) => id !== null));
  const organizations: HeldOrganization[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of (parsed.organizations as unknown[]).entries()) {
    const refuse = (defect: OrganizationsDefect): OrganizationsFile => ({
      ok: false,
      defect,
      entry: index + 1,
    });
    if (!isRecord(raw)) return refuse("entry_not_an_object");
    if (Object.keys(raw).some((key) => !ENTRY_FIELDS.has(key))) return refuse("entry_unknown_field");
    if (!isListableId(raw.id)) return refuse("id");
    if (seen.has(raw.id)) return refuse("id_listed_twice");
    if (own.has(raw.id)) return refuse("id_is_the_own_organization");
    seen.add(raw.id);

    const listed = raw.modules ?? [];
    if (!Array.isArray(listed) || !listed.every(isModuleId)) return refuse("modules");
    const modules = new Set<string>(listed);
    if (modules.size !== listed.length) return refuse("modules");

    const given = raw.keys ?? {};
    if (!isRecord(given)) return refuse("keys");
    const keys = new Map<string, ReadonlyMap<string, string>>();
    for (const [moduleId, map] of Object.entries(given)) {
      if (!isModuleId(moduleId) || !isRecord(map)) return refuse("keys");
      const names = new Map<string, string>();
      for (const [declared, stored] of Object.entries(map)) {
        if (!isSecretName(declared) || !isSecretName(stored)) return refuse("keys");
        names.set(declared, stored as string);
      }
      keys.set(moduleId, names);
    }
    organizations.push({ id: raw.id, modules, keys });
  }
  return { ok: true, organizations };
}

// ── The own organization's id ────────────────────────────────────────────────

/** True when the name is taken at all: by a file, a folder, or a link that
 *  points nowhere. A name that cannot be looked at counts as taken. */
function nameTaken(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** The id in the file, null when the name is free, and a throw when the name is
 *  taken by anything that does not hold an id. */
function readOwnId(file: string): string | null {
  // A link that points nowhere is not a free name: what it points at may come
  // back, with the id in it.
  if (!nameTaken(file)) return null;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new OwnOrganizationUnreadable();
  }
  try {
    const id = (JSON.parse(text) as { id?: unknown } | null)?.id;
    if (isOrganizationId(id)) return id;
  } catch {
    // Falls through to the refusal below.
  }
  throw new OwnOrganizationUnreadable();
}

/** The file that holds this Fortress's own organization's id is there and
 *  cannot be read. Nothing makes a new id in its place: rows keyed by the id it
 *  held would then belong to nobody. */
export class OwnOrganizationUnreadable extends Error {
  constructor() {
    super(
      "identity/organization.json in the Fortress's folder cannot be read. It holds the id " +
        "this Fortress keys its own organization's data by. Restore the file; do not remove it.",
    );
    this.name = "OwnOrganizationUnreadable";
  }
}

/** What `link` answers on a file system that has no hard links. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EMLINK"]);

/** Give a finished file its name, only if the name is free. */
function publishOnce(tmp: string, file: string, link: (from: string, to: string) => void): void {
  try {
    // A link fails when the name is taken, so of two processes that get here
    // together one wins and the other is told.
    link(tmp, file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (code === "EEXIST") return;
    if (!NO_HARD_LINKS.has(code)) throw error;
    // No hard links here (a network share, some mounted object stores). A
    // rename is the other way to give a whole file its name in one step, but it
    // replaces whatever has the name. So it is done only when the name is free.
    // The check and the rename are two steps. That is safe because one daemon
    // runs for a Fortress's folder, and only the daemon makes this id.
    if (!nameTaken(file)) renameSync(tmp, file);
  }
}

/** Ask the file system to keep a folder's new entry. Best effort: not every
 *  file system lets a folder be opened and synced. */
function syncFolder(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // The file's bytes are on disk either way; only how soon its name is, is
    // left to the file system.
  }
}

/** The own organization's id, and whether this call is the one that made it. */
function readOrMakeOwnId(
  file: string,
  link: (from: string, to: string) => void,
): { id: string; made: boolean } {
  const existing = readOwnId(file);
  if (existing !== null) return { id: existing, made: false };

  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mine = randomUUID();
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      // `writeFileSync` writes all of it or throws. A file with part of an id
      // must never get the name.
      writeFileSync(fd, `${JSON.stringify({ id: mine })}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    publishOnce(tmp, file, link);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // Gone already: a rename took it.
    }
  }
  syncFolder(dir);
  const kept = readOwnId(file);
  if (kept === null) throw new OwnOrganizationUnreadable();
  return { id: kept, made: kept === mine };
}

/**
 * This Fortress's own organization's id, made on first use and kept.
 *
 * Synchronous, so that a module's context can hand it out as a plain value. It
 * is one small file, read once for each process.
 *
 * The file is written whole under another name, synced, and only then given its
 * name. So the name never points at half a file, and a file that has its name
 * is never written again. What is returned is what the file holds once that is
 * done: this call's id, or the id of whoever got there first.
 *
 * An id is made only when the name is free. A name that is taken by something
 * that holds no id (a damaged file, a folder, a link that points nowhere)
 * throws, and nothing is put in its place. A Fortress whose file was removed
 * makes a new id, and what was keyed by the old one is no longer found: the
 * file belongs with the data.
 *
 * `link` is the file system's own, except in a test of a file system that has
 * none.
 */
export function ownOrganizationId(
  file: string,
  link: (from: string, to: string) => void = linkSync,
): string {
  return readOrMakeOwnId(file, link).id;
}

// ── The directory ────────────────────────────────────────────────────────────

export interface OrganizationsDeps {
  /** Where things rest under the Fortress's folder (`fortressPaths`). */
  paths: {
    organizations: string;
    ownOrganization: string;
    moduleState(moduleId: string): string;
    organizationModuleState(organizationId: string, moduleId: string): string;
  };
  /**
   * The id this Fortress enrolled as: the one a grant's `aud` is held to. Null
   * before it has enrolled. An entry of the list may not carry it.
   *
   * REJECTS when the id cannot be read. The list then cannot be checked against
   * it, and counts as no list. It must not answer null for that: null means
   * "not enrolled", and then there is no id to check against.
   */
  enrolledAs: () => string | null | Promise<string | null>;
  logger?: Pick<ScopedLogger, "error"> & Partial<Pick<ScopedLogger, "info">>;
  /** How the list's file is opened: the file system's own, except in a test
   *  that has to hold a read open. */
  open?: (file: string, flags: number) => Promise<FileHandle>;
}

/** What one read of the file found. */
type Reading =
  | { is: "absent" }
  | { is: "bytes"; bytes: Buffer }
  | { is: "refused"; defect: "unreadable" | "too_large" };

type Refusal = Extract<OrganizationsFile, { ok: false }>;

interface Loaded {
  /** The file's bytes, and the two ids its entries were checked against. */
  bytes: Buffer;
  enrolled: string | null;
  made: string | null;
  held: ReadonlyMap<string, HeldOrganization>;
  /** Why these bytes are not a list, when they are not. */
  refusal: Refusal | null;
}

const NONE: ReadonlyMap<string, HeldOrganization> = new Map();

const sameBytes = (a: Buffer | null, b: Buffer | null): boolean =>
  a === b || (a !== null && b !== null && a.equals(b));

/** What the log says for each thing that can be wrong, besides the defect. */
function refusalMessage(defect: OrganizationsDefect): string {
  const consequence =
    "so this Fortress holds no organization but its own. Every ask for another organization " +
    "is refused until the file is fixed.";
  if (defect === "own_id_unreadable") {
    return (
      "identity/organization.json cannot be read, and no entry of organizations.json can be " +
      `checked against the id in it, ${consequence}`
    );
  }
  if (defect === "enrolled_id_unreadable") {
    return (
      "The credentials this Fortress enrolled with cannot be read, and no entry of " +
      `organizations.json can be checked against the id in them, ${consequence}`
    );
  }
  return `organizations.json cannot be used, ${consequence}`;
}

export class Organizations {
  private readonly deps: OrganizationsDeps;
  private loaded: Loaded | null = null;
  /** What the log was last told is wrong. `bytes` is null when what is wrong is
   *  not in the list's own bytes. */
  private said: { bytes: Buffer | null; defect: OrganizationsDefect; entry: number | undefined } | null =
    null;
  private ownId: string | null = null;
  /** The read in progress, and the one that starts after it when a look
   *  arrived meanwhile. Never more than these two. */
  private reading: Promise<Reading> | null = null;
  private queued: Promise<Reading> | null = null;
  /** The entry each organization this directory handed out was found with. An
   *  ask is decided against that one reading of the list. */
  private readonly entries = new WeakMap<Organization, HeldOrganization>();

  /** The organization that runs this Fortress. Reading its `id` makes the id,
   *  the first time; nothing else about it touches the disk. */
  readonly own: Organization;

  constructor(deps: OrganizationsDeps) {
    this.deps = deps;
    const idOf = (): string => {
      if (this.ownId === null) {
        const { id, made } = readOrMakeOwnId(deps.paths.ownOrganization, linkSync);
        this.ownId = id;
        if (made) {
          deps.logger?.info?.(
            "This Fortress made an id for its own organization, in identity/organization.json. " +
              "A module keys what it keeps for that organization by it. Keep the file with the " +
              "data: if it is lost, a new id is made and what was keyed by the old one is not found.",
          );
        }
      }
      return this.ownId;
    };
    this.own = Object.freeze({
      get id(): string {
        return idOf();
      },
      own: true as const,
    });
  }

  /**
   * The file's bytes, as they were at some moment after this call began.
   *
   * One read runs at a time. A call that arrives while one is running does not
   * share it: that read may have opened the file before the call arrived. It
   * shares the next one, with every other call that arrived meanwhile. So a
   * burst of looks costs one more read, and one copy of the file in memory.
   */
  private read(): Promise<Reading> {
    if (!this.reading) {
      const started: Promise<Reading> = this.readOnce().finally(() => {
        if (this.reading === started) this.reading = null;
      });
      this.reading = started;
      return started;
    }
    this.queued ??= this.reading.then(() => {
      this.queued = null;
      return this.read();
    });
    return this.queued;
  }

  /** One read of the file. Never rejects. */
  private async readOnce(): Promise<Reading> {
    let handle: FileHandle;
    try {
      // Not blocked by a name that is not a file: a pipe opens at once, and is
      // refused below for what it is.
      handle = await (this.deps.open ?? open)(
        this.deps.paths.organizations,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
    } catch (error) {
      // No list: this Fortress holds its own organization and no other.
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { is: "absent" }
        : { is: "refused", defect: "unreadable" };
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) return { is: "refused", defect: "unreadable" };
      if (info.size > ORGANIZATIONS_FILE_MAX_BYTES) return { is: "refused", defect: "too_large" };
      // Room for one byte more than the file held when it was opened. A file
      // that grew while it was read is then seen to have grown, and no read
      // goes on for as long as somebody keeps writing.
      const bytes = Buffer.allocUnsafe(info.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > info.size) return { is: "refused", defect: "unreadable" };
      return { is: "bytes", bytes: bytes.subarray(0, length) };
    } catch {
      return { is: "refused", defect: "unreadable" };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * The other organizations this Fortress holds, by id, as the file has them
   * now. Empty when there is no list, and when the list cannot be used.
   *
   * `enrolledAs` is the id a grant was just held to, when the look is for an
   * ask. The list is then checked against that same id, and nothing is read a
   * second time that could answer differently. Any other look reads it.
   */
  private async list(enrolledAs?: string): Promise<ReadonlyMap<string, HeldOrganization>> {
    const reading = await this.read();
    if (reading.is === "absent") {
      this.loaded = null;
      this.said = null;
      return NONE;
    }
    if (reading.is === "refused") return this.refuse(null, { ok: false, defect: reading.defect });

    // The two ids no entry may carry. They are part of what a reading depends
    // on: the same bytes are a different list once this Fortress enrolls as one
    // of its entries. When either cannot be read, no entry can be checked
    // against it, and the list holds nobody.
    let enrolled: string | null;
    if (enrolledAs !== undefined) {
      enrolled = enrolledAs;
    } else {
      try {
        enrolled = (await this.deps.enrolledAs()) ?? null;
      } catch {
        return this.refuse(null, { ok: false, defect: "enrolled_id_unreadable" });
      }
    }
    let made: string | null;
    try {
      made = this.ownId ??= readOwnId(this.deps.paths.ownOrganization);
    } catch {
      return this.refuse(null, { ok: false, defect: "own_id_unreadable" });
    }

    const { bytes } = reading;
    let loaded = this.loaded;
    if (!loaded || loaded.enrolled !== enrolled || loaded.made !== made || !sameBytes(loaded.bytes, bytes)) {
      const parsed = parseOrganizations(bytes.toString("utf8"), [enrolled, made]);
      loaded = parsed.ok
        ? {
            bytes,
            enrolled,
            made,
            held: new Map(parsed.organizations.map((organization) => [organization.id, organization])),
            refusal: null,
          }
        : // Remembered like a good reading, so that a large file that cannot be
          // used is not parsed again at every look.
          { bytes, enrolled, made, held: NONE, refusal: parsed };
      this.loaded = loaded;
    }
    if (loaded.refusal) return this.refuse(loaded.bytes, loaded.refusal);
    this.said = null;
    return loaded.held;
  }

  /** A list that cannot be used. Said once for each thing that is wrong with
   *  it, and not at every look while that lasts. */
  private refuse(bytes: Buffer | null, refusal: Refusal): ReadonlyMap<string, HeldOrganization> {
    const said = this.said;
    if (
      said === null ||
      said.defect !== refusal.defect ||
      said.entry !== refusal.entry ||
      !sameBytes(said.bytes, bytes)
    ) {
      this.said = { bytes, defect: refusal.defect, entry: refusal.entry };
      this.deps.logger?.error(refusalMessage(refusal.defect), {
        defect: refusal.defect,
        ...(refusal.entry === undefined ? {} : { entry: refusal.entry }),
      });
    }
    return NONE;
  }

  /** Look at the list now. The module host does this on each of its passes: once
   *  its modules have started, and every few seconds after. So a list that
   *  cannot be used is in the log soon after it was written, and not only when
   *  an ask for another organization arrives. Never rejects. */
  async look(): Promise<void> {
    try {
      await this.list();
    } catch {
      // Nothing here rejects by design. A look is never a reason to stop.
    }
  }

  private handOut(entry: HeldOrganization): Organization {
    const organization: Organization = Object.freeze({ id: entry.id, own: false });
    this.entries.set(organization, entry);
    return organization;
  }

  /**
   * The organization on the list with this id, as the list has it now. Null
   * when there is none.
   *
   * For an ask. `enrolledAs` is the id the ask's grant was held to (`aud`), so
   * the list is checked against the same id the grant was. The own organization
   * is not on the list and is not found here: an ask is for it when the grant's
   * `org` is that id, which the grant's verifier has checked.
   */
  async held(id: string, enrolledAs: string): Promise<Organization | null> {
    if (!isOrganizationId(id)) return null;
    const entry = (await this.list(enrolledAs)).get(id);
    return entry ? this.handOut(entry) : null;
  }

  /** Every organization of this Fortress: its own first, then the list. */
  async all(): Promise<Organization[]> {
    return [this.own, ...[...(await this.list()).values()].map((entry) => this.handOut(entry))];
  }

  /**
   * Whether a module is on for an organization, besides being on for the
   * Fortress. For the own organization the Fortress's switch is the only one.
   * For another, its entry has to list the module.
   *
   * Answered from the reading of the list the organization was found in, so
   * whether an ask is for an organization this Fortress holds and whether the
   * module is on for it are decided against one reading. An organization this
   * directory did not hand out lists nothing.
   */
  listsModule(organization: Organization, moduleId: string): boolean {
    if (organization.own) return true;
    return this.entries.get(organization)?.modules.has(moduleId) ?? false;
  }

  /**
   * The name an organization's secret is stored under, for a name a module's
   * manifest declares. Null when the organization has none.
   *
   * For the own organization that is the declared name. For another it is what
   * its entry says, and only while its entry lists the module. With no name
   * there is no secret: the own organization's is never the answer for
   * somebody else unless the entry itself gives that name.
   *
   * Read from the list as it is NOW, at each call, and not as it was when the
   * ask was admitted or the context was made: a module may keep a context for
   * longer than one ask, and an organization taken off the list must stop
   * being read for.
   */
  async keyName(organization: Organization, moduleId: string, declared: string): Promise<string | null> {
    if (organization.own) return declared;
    const entry = (await this.list()).get(organization.id);
    if (!entry?.modules.has(moduleId)) return null;
    return entry.keys.get(moduleId)?.get(declared) ?? null;
  }

  /** Where a module's state rests for an organization. */
  stateDir(organization: Organization, moduleId: string): string {
    return organization.own
      ? this.deps.paths.moduleState(moduleId)
      : this.deps.paths.organizationModuleState(organization.id, moduleId);
  }
}
