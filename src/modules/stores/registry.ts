// The Stores of one organization on this HX Fortress, as the module keeps them.
//
// The control plane names a Store by an id of its own. That id is never a
// file's name here. The module gives each Store a folder name of its own, a
// letter and a number counted up (`s000001`), and keeps which id has which
// folder in this list.
//
// A FOLDER IS NEVER TAKEN TWICE. The number that comes next is kept in the
// list, and that alone would not hold: a list that was lost, or put back from
// an older copy, counts from a number whose folder is still on the disk, with
// another Store's file in it. So a new Store's folder is MADE, and it has to be
// new (`create` is handed the making). A number whose folder is there already
// is passed over, and what is in that folder is left alone.
//
// A FOLDER WITH NO STORE IS NOT LEFT BEHIND. The folder is made before the
// list is written, so that the list never names a folder that is not there.
// When the list then cannot be written, the folder that was just made is
// removed again: it is new, it holds no row, and nothing names it.
//
// A DELETE IS KEPT BEFORE IT IS DONE. Once a person approved it, the record
// says so, with who approved and when (`deleting`). The Store then takes no
// call. Its folder is removed after that, and its record last. So a delete
// that was cut short (HX Fortress stopped in the middle) is still on the list,
// and is finished when the module next starts.
//
// A RESTORE WAITS ON THE RECORD TOO, ONE FOR A STORE. The record keeps which
// line of the Store's history the control plane asked to go back to, and
// when. A person's decision takes it off the record, either way, before
// anything is done: an approval is used once, and a restore that then fails
// has to be asked for again.
//
// The list is one small record in the module's state for the organization
// (`ctx.state`), so it is kept apart for each organization by the module host.
// A change reads the record, changes it and writes it back. Two changes for
// one organization are done one after the other (`Turns`).

import { AskFailure, type ModuleStatePort } from "../../host/module-contract";
import { ID_MAX_CHARS, ID_PATTERN, isIsoInstant, isName, NAME_MAX_CHARS } from "../../host/shape";
import { STORES_MAX, type StoreState } from "./manifest";

/** The key of the list in the module's state. */
const STATE_KEY = "stores";
/** Longest name of a Store. */
export const STORE_NAME_MAX_CHARS = 64;
/**
 * A Store's id, as the Store's own program takes one: letters, digits, `_`
 * and `-`. The program is told the id with every call and refuses any other
 * form, so a Store with another id could be made and never opened.
 */
export const STORE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** How many numbers are tried for a new Store's folder before giving up. */
const FOLDER_TRIES = 1_000;
/** Who decided a delete, when the login is not a name a record can hold. */
const SOMEBODY = "unknown";

/** A person's login as a record keeps it: the login when it is a name, and
 *  one fixed word when it is not. It is never cut to fit. */
export function recordedLogin(login: string): string {
  return isName(login) && login.length > 0 && login.length <= NAME_MAX_CHARS ? login : SOMEBODY;
}

/** A restore that waits for a person: the line of the Store's history to go
 *  back to the moment before, and when the control plane asked. */
export interface RestoreAsked {
  line: string;
  at: string;
}

export interface StoreRecord {
  /** The control plane's id for the Store. */
  id: string;
  /** The Store's folder under the module's own folder: one path segment. */
  folder: string;
  /** What this organization's people know it by. */
  name?: string;
  createdAt: string;
  /** When the control plane asked to delete it. */
  deleteAskedAt?: string;
  /** Set once a person approved the delete: who, and when. From then on the
   *  Store takes no call, and what is left to do is to remove its folder and
   *  this record. */
  deleting?: { by: string; at: string };
  /** The restore the control plane asked for and no person has decided. */
  restoreAsked?: RestoreAsked;
}

interface Held {
  version: 1;
  /** The number the next Store's folder is tried with first. */
  next: number;
  stores: StoreRecord[];
}

const FOLDER_PATTERN = /^s[0-9]{6,12}$/;

/** What the making of a folder answers: false when a folder of that name is
 *  there already, or the way to remove the folder that was just made. */
export type MadeFolder = false | { remove(): void | Promise<void> };

function folderName(number: number): string {
  return `s${String(number).padStart(6, "0")}`;
}

export function storeState(record: StoreRecord): StoreState {
  if (record.deleting !== undefined) return "deleting";
  return record.deleteAskedAt === undefined ? "ready" : "delete_waiting";
}

function isStoreName(value: unknown): value is string {
  return isName(value) && value.length > 0 && value.length <= STORE_NAME_MAX_CHARS;
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && isIsoInstant(value);
}

function isDeleting(value: unknown): value is { by: string; at: string } {
  if (typeof value !== "object" || value === null) return false;
  const { by, at } = value as { by?: unknown; at?: unknown };
  return isName(by) && by.length > 0 && by.length <= NAME_MAX_CHARS && isInstant(at);
}

function isRestoreAsked(value: unknown): value is RestoreAsked {
  if (typeof value !== "object" || value === null) return false;
  const { line, at } = value as { line?: unknown; at?: unknown };
  return typeof line === "string" && line.length <= ID_MAX_CHARS && ID_PATTERN.test(line) && isInstant(at);
}

/** A record as it must be to be used. One that is not, in a list read from
 *  the disk, makes the whole list unreadable: a Store is never guessed at. */
function isRecord(value: unknown): value is StoreRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<StoreRecord>;
  return (
    typeof record.id === "string" &&
    STORE_ID_PATTERN.test(record.id) &&
    typeof record.folder === "string" &&
    FOLDER_PATTERN.test(record.folder) &&
    (record.name === undefined || isStoreName(record.name)) &&
    isInstant(record.createdAt) &&
    (record.deleteAskedAt === undefined || isInstant(record.deleteAskedAt)) &&
    (record.deleting === undefined || isDeleting(record.deleting)) &&
    (record.restoreAsked === undefined || isRestoreAsked(record.restoreAsked))
  );
}

function isHeld(value: unknown): value is Held {
  if (typeof value !== "object" || value === null) return false;
  const held = value as Partial<Held>;
  if (held.version !== 1 || !Number.isSafeInteger(held.next) || (held.next as number) < 1) return false;
  if (!Array.isArray(held.stores) || !held.stores.every(isRecord)) return false;
  const ids = new Set(held.stores.map((store) => store.id));
  const folders = new Set(held.stores.map((store) => store.folder));
  return ids.size === held.stores.length && folders.size === held.stores.length;
}

/** The list of one organization. Made for one `ctx.state`, and used for one
 *  change or one reading, inside the organization's turn. */
export class StoreRegistry {
  /**
   * `onUnreadable` is told why a list could not be used, for the log: what
   * reading it threw, or nothing when it was read and is not a list of Stores.
   */
  constructor(
    private readonly state: ModuleStatePort,
    private readonly onUnreadable?: (thrown?: unknown) => void,
  ) {}

  /**
   * The list as the disk holds it.
   *
   * THROWS `stores_unreadable` when the record is there and is not a list of
   * Stores, or cannot be read. Nothing is made, changed or removed then, so
   * that a damaged list is never written over by an empty one.
   */
  private async held(): Promise<Held> {
    let value: unknown;
    try {
      value = await this.state.read<unknown>(STATE_KEY);
    } catch (thrown) {
      this.onUnreadable?.(thrown);
      throw new AskFailure("stores_unreadable");
    }
    if (value === null) return { version: 1, next: 1, stores: [] };
    if (!isHeld(value)) {
      this.onUnreadable?.();
      throw new AskFailure("stores_unreadable");
    }
    return value;
  }

  private replace(held: Held, id: string, record: StoreRecord | null): Promise<void> {
    return this.state.write<Held>(STATE_KEY, {
      ...held,
      stores: held.stores.flatMap((store) => (store.id !== id ? [store] : record ? [record] : [])),
    });
  }

  async list(): Promise<StoreRecord[]> {
    return (await this.held()).stores;
  }

  /** The Store with this id that takes calls, or the ask fails with
   *  `store_unknown`. A Store that is being deleted takes none. */
  async need(id: string): Promise<StoreRecord> {
    const record = (await this.held()).stores.find((store) => store.id === id);
    if (!record || record.deleting !== undefined) throw new AskFailure("store_unknown");
    return record;
  }

  /**
   * Make a Store, or answer the one that is there. An id that is there keeps
   * its folder and its name, and nothing of it is touched.
   *
   * `makeFolder` is handed a folder name and makes that folder, new. It
   * answers false when a folder of that name is there already: the next
   * number is tried then. For a folder it made, it answers the way to remove
   * it again, which is used only when the list cannot be written.
   */
  async create(
    id: string,
    name: string | undefined,
    now: Date,
    makeFolder: (folder: string) => MadeFolder | Promise<MadeFolder>,
  ): Promise<{ record: StoreRecord; created: boolean }> {
    const held = await this.held();
    const existing = held.stores.find((store) => store.id === id);
    // Its folder is still being removed. The id is free again when it is gone.
    if (existing?.deleting !== undefined) throw new AskFailure("store_deleting");
    if (existing) return { record: existing, created: false };
    if (!STORE_ID_PATTERN.test(id)) throw new AskFailure("store_id_invalid");
    if (name !== undefined && !isStoreName(name)) throw new AskFailure("store_name_invalid");
    if (held.stores.length >= STORES_MAX) throw new AskFailure("stores_full");
    let next = held.next;
    let made: { folder: string; remove(): void | Promise<void> } | null = null;
    for (let tries = 0; made === null; tries += 1) {
      if (tries >= FOLDER_TRIES) throw new AskFailure("store_folders_taken");
      const tried = folderName(next);
      next += 1;
      const answered = await makeFolder(tried);
      if (answered) made = { folder: tried, remove: () => answered.remove() };
    }
    const record: StoreRecord = {
      id,
      folder: made.folder,
      ...(name === undefined ? {} : { name }),
      createdAt: now.toISOString(),
    };
    try {
      await this.state.write<Held>(STATE_KEY, { version: 1, next, stores: [...held.stores, record] });
    } catch (thrown) {
      // No list names the folder, so no Store will ever use it. Left there,
      // each try that fails this way would take one more number.
      try {
        await made.remove();
      } catch {
        // It stays. A later Store passes over its number.
      }
      throw thrown;
    }
    return { record, created: true };
  }

  /** Note that the control plane asked to delete a Store. Asking again keeps
   *  the first time. `first` says whether this was the first. */
  async askDelete(id: string, now: Date): Promise<{ record: StoreRecord; first: boolean }> {
    const held = await this.held();
    const record = held.stores.find((store) => store.id === id);
    if (!record) throw new AskFailure("store_unknown");
    if (record.deleteAskedAt !== undefined || record.deleting !== undefined) {
      return { record, first: false };
    }
    const asked: StoreRecord = { ...record, deleteAskedAt: now.toISOString() };
    await this.replace(held, id, asked);
    return { record: asked, first: true };
  }

  /**
   * A person decides a delete that was asked for.
   *
   * Refused, the Store is as it was before the ask (`kept`). Approved, the
   * record says so from here on (`deleting`): the Store takes no call, and the
   * caller removes its folder and then this record. `first` says whether this
   * call made the decision: a delete that is already under way answers
   * `deleting` again, whatever is decided now.
   *
   * THROWS `store_unknown`, and `delete_not_asked` for a Store nobody asked to
   * delete.
   */
  async decide(
    id: string,
    approve: boolean,
    by: string,
    now: Date,
  ): Promise<{ record: StoreRecord; outcome: "kept" | "deleting"; first: boolean }> {
    const held = await this.held();
    const record = held.stores.find((store) => store.id === id);
    if (!record) throw new AskFailure("store_unknown");
    if (record.deleting !== undefined) return { record, outcome: "deleting", first: false };
    if (record.deleteAskedAt === undefined) throw new AskFailure("delete_not_asked");
    if (!approve) {
      const kept: StoreRecord = { ...record };
      delete kept.deleteAskedAt;
      await this.replace(held, id, kept);
      return { record: kept, outcome: "kept", first: true };
    }
    const marked: StoreRecord = {
      ...record,
      deleting: { by: recordedLogin(by), at: now.toISOString() },
    };
    // A restore that waited goes with the Store.
    delete marked.restoreAsked;
    await this.replace(held, id, marked);
    return { record: marked, outcome: "deleting", first: true };
  }

  /**
   * Note that the control plane asked to take a Store back to the moment
   * before a line of its history. One restore waits for a Store: asking again
   * for the same line keeps the first time, and asking for another line takes
   * the place of the one that waited. `first` says whether this ask changed
   * what waits.
   *
   * THROWS `store_unknown`, also for a Store that is being deleted.
   */
  async askRestore(
    id: string,
    line: string,
    now: Date,
  ): Promise<{ record: StoreRecord; asked: RestoreAsked; first: boolean }> {
    const held = await this.held();
    const record = held.stores.find((store) => store.id === id);
    if (!record || record.deleting !== undefined) throw new AskFailure("store_unknown");
    if (record.restoreAsked?.line === line) return { record, asked: record.restoreAsked, first: false };
    const asked: RestoreAsked = { line, at: now.toISOString() };
    const noted: StoreRecord = { ...record, restoreAsked: asked };
    await this.replace(held, id, noted);
    return { record: noted, asked, first: true };
  }

  /**
   * Take the restore that waits for a Store off its record, for a person's
   * decision: refused, the Store is as it was, and approved, the caller
   * carries it out. The decision names the line it is for, so nobody decides
   * a line other than the one they read.
   *
   * THROWS `store_unknown`, also for a Store that is being deleted,
   * `restore_not_asked` for a Store no restore waits for, and
   * `restore_changed` when the line that waits is another one.
   */
  async takeRestore(id: string, line: string): Promise<{ record: StoreRecord; asked: RestoreAsked }> {
    const held = await this.held();
    const record = held.stores.find((store) => store.id === id);
    if (!record || record.deleting !== undefined) throw new AskFailure("store_unknown");
    const asked = record.restoreAsked;
    if (asked === undefined) throw new AskFailure("restore_not_asked");
    if (asked.line !== line) throw new AskFailure("restore_changed");
    const decided: StoreRecord = { ...record };
    delete decided.restoreAsked;
    await this.replace(held, id, decided);
    return { record: decided, asked };
  }

  /** The Stores whose delete was approved and is not finished. */
  async deleting(): Promise<StoreRecord[]> {
    return (await this.held()).stores.filter((store) => store.deleting !== undefined);
  }

  /** Take a Store whose folder is gone off the list. Only a Store that is
   *  being deleted, in this folder, is taken off. */
  async forget(id: string, folder: string): Promise<boolean> {
    const held = await this.held();
    const record = held.stores.find((store) => store.id === id);
    if (!record || record.deleting === undefined || record.folder !== folder) return false;
    await this.replace(held, id, null);
    return true;
  }
}

/**
 * One thing at a time for each key.
 *
 * A change to an organization's list reads it and writes it back. Two asks
 * for one organization can run at once, so each change waits for the one
 * before it. A change that fails does not stop the next.
 */
export class Turns {
  private readonly last = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = this.last.get(key) ?? Promise.resolve();
    const mine = before.then(work, work);
    const settled = mine.then(
      () => undefined,
      () => undefined,
    );
    this.last.set(key, settled);
    void settled.then(() => {
      if (this.last.get(key) === settled) this.last.delete(key);
    });
    return mine;
  }
}
