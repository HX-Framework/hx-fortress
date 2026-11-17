// <root>/ui/provider-people.json — the people who signed in through the
// organization's identity provider, as the `access.groups` ask counts them.
//
// With sign-in through the identity provider on, the provider holds the list
// of who has a role, and HX Fortress does not. What HX Fortress learns is who
// signed in, and which groups of its mapping (oidc.json) their token carried.
// This file keeps that, for each person's LAST sign-in through the provider,
// for PEOPLE_DAYS days, and holds only digests:
//
//   - `personKey`: a digest of the provider's address and its id for the
//     person. Never the id itself, the login, an address or a name;
//   - `issuer`: a digest of the provider's address, so a count is of the
//     provider in use now, and the people of an earlier one are not counted;
//   - the time of that sign-in;
//   - `groups`: a digest of each group of the four lists of the mapping that
//     the token carried. Never a group's name: with `groupsClaim` set to
//     `email`, a "group" is a person's address. A group that gives no role
//     here is not kept.
//
// Every sign-in the provider vouched for is noted, whatever came of it. A
// Viewer, whom the console refuses, holds a role. A person whose token carried
// no mapped group, or no groups claim at all, holds none now, and what was
// noted of them is removed. Anyone who can read this file and knows a person's
// id at the provider can tell whether that person signed in, and when: it is
// 0600, beside the console's other files.
//
// The console is the only writer. It reads the file once when it starts, keeps
// the people in memory, notes a sign-in there without the sign-in waiting, and
// writes the whole file at most once every FLUSH_MS, and when it stops. A
// sign-in that changes nothing within a day (the same groups, noted less than
// a day before) is not written again: the window is 90 days, and a day is all
// the precision it needs. A write that fails is tried again. A note still in
// memory when the console is killed is lost; that person's next sign-in notes
// them again. A sign-in older than PEOPLE_DAYS is dropped at a write, when
// the file is read, and by the console's sweep once a day (`prune`), so the
// file keeps 90 days also while nobody signs in. While the console is not
// running, nothing is dropped: it drops what is due when it starts.
//
// A file that is there and cannot be read now (the disk, too many open files)
// is never started again: that sign-in is not noted, the console's log says
// so, and the next sign-in reads the file again. A file that is damaged (it
// does not parse, or it is larger than any file this writer makes) holds
// nothing that can be counted, and the next sign-in starts it again. To the
// daemon's `host` module, either is an error, never "nobody".

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

import { readSmallFile, writePrivateJson } from "../host/private-json";
import { isIsoInstant } from "../host/shape";

/** The file's name, beside users.json and oidc.json. */
export const PROVIDER_PEOPLE_FILE = "provider-people.json";

/** How long a sign-in counts. A person whose last sign-in is older is not
 *  counted, and is dropped from the file at the next write. */
export const PEOPLE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a note waits in memory before it is written, at most. */
export const FLUSH_MS = 30_000;

/** Most people the file keeps. Past it, the oldest sign-ins are dropped first. */
export const PEOPLE_MAX = 100_000;

/**
 * The largest file this writer makes, and the largest that is read. A person
 * in a few groups takes about 250 bytes, so PEOPLE_MAX people fit with room to
 * spare; past this size, the oldest sign-ins are left out of a write, so the
 * file is always one its reader takes.
 */
export const PEOPLE_FILE_MAX_BYTES = 48 * 1024 * 1024;

/** What is kept of one person's last sign-in through the provider. */
export interface PersonSeen {
  /** When it was, as `Date#toISOString()` writes it. */
  at: string;
  /** `issuerKey` of the provider it was through. */
  issuer: string;
  /** `groupKey` of each group of the mapping that it carried. */
  groups: string[];
}

/** What the file holds, as `recent` returns it. */
export interface PeopleRead {
  people: PersonSeen[];
  /** When this file was started: sign-ins before it are not in it. Null when
   *  there is no file yet. */
  since: string | null;
}

/** The file is there and cannot be read, or is damaged. Counting from it
 *  would be a guess. */
export class PeopleUnreadable extends Error {
  constructor() {
    super(`${PROVIDER_PEOPLE_FILE} cannot be read`);
    this.name = "PeopleUnreadable";
  }
}

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A person, by a digest of the provider's address and its id for them. The
 *  file holds this and never the id. */
export function personKey(issuer: string, subject: string): string {
  return `sha256:${digest(`${issuer}\n${subject}`)}`;
}

/** The provider, by a digest of its address. */
export function issuerKey(issuer: string): string {
  return `i:${digest(`issuer\n${issuer}`).slice(0, 24)}`;
}

/** A group of the mapping, by a digest of its name. */
export function groupKey(group: string): string {
  return `g:${digest(`group\n${group}`).slice(0, 24)}`;
}

/** Whether a sign-in counts at `now`: it is no more than PEOPLE_DAYS before. */
export function isRecent(seen: Pick<PersonSeen, "at">, now: Date): boolean {
  return Date.parse(seen.at) >= now.getTime() - PEOPLE_DAYS * DAY_MS;
}

const PERSON_KEY = /^sha256:[0-9a-f]{64}$/;
const ISSUER_KEY = /^i:[0-9a-f]{24}$/;
const GROUP_KEY = /^g:[0-9a-f]{24}$/;

function personSeen(value: unknown): PersonSeen | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { at, issuer, groups } = value as Record<string, unknown>;
  if (typeof at !== "string" || !isIsoInstant(at)) return null;
  if (typeof issuer !== "string" || !ISSUER_KEY.test(issuer)) return null;
  if (!Array.isArray(groups) || groups.length === 0) return null;
  if (!groups.every((group) => typeof group === "string" && GROUP_KEY.test(group))) return null;
  return { at, issuer, groups: [...(groups as string[])] };
}

interface PeopleFile {
  startedAt: string;
  people: Map<string, PersonSeen>;
}

/** Null when the text is not this file: the whole file, or one entry. */
function parse(text: string): PeopleFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { version, startedAt, people } = raw as Record<string, unknown>;
  if (version !== 1 || typeof startedAt !== "string" || !isIsoInstant(startedAt)) return null;
  if (typeof people !== "object" || people === null || Array.isArray(people)) return null;
  const out = new Map<string, PersonSeen>();
  for (const [key, value] of Object.entries(people)) {
    const seen = personSeen(value);
    if (!PERSON_KEY.test(key) || !seen) return null;
    out.set(key, seen);
  }
  return { startedAt, people: out };
}

type Loaded = { state: "absent" } | { state: "read"; file: PeopleFile } | { state: "damaged" } | { state: "failed" };

/** Read the file, telling a file that is damaged from a read that failed. */
async function loadFile(file: string): Promise<Loaded> {
  let size: number;
  try {
    // This program's own file under its root, never a path a caller supplies.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const info = await stat(file);
    if (!info.isFile()) return { state: "failed" };
    size = info.size;
  } catch (thrown) {
    return (thrown as NodeJS.ErrnoException | null)?.code === "ENOENT" ? { state: "absent" } : { state: "failed" };
  }
  if (size > PEOPLE_FILE_MAX_BYTES) return { state: "damaged" };
  const read = await readSmallFile(file, PEOPLE_FILE_MAX_BYTES);
  if (read.state === "absent") return { state: "absent" };
  if (read.state === "unreadable") return { state: "failed" };
  const parsed = parse(read.bytes.toString("utf8"));
  return parsed ? { state: "read", file: parsed } : { state: "damaged" };
}

export interface ProviderPeopleOptions {
  /** Injected in tests. */
  now?: () => Date;
  /** Injected in tests: a cap smaller than PEOPLE_MAX. */
  maxPeople?: number;
  /** Injected in tests: a size smaller than PEOPLE_FILE_MAX_BYTES. */
  maxBytes?: number;
  /** Injected in tests: a delay other than FLUSH_MS. */
  flushMs?: number;
  /** Told after each write, and after a read that failed: whether it worked.
   *  The console says a failure once, and nobody's id or login. */
  onWrite?: (ok: boolean) => void;
}

/** Whether two notes carried the same groups, in any order. */
function sameGroups(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((group) => b.includes(group));
}

export class ProviderPeopleStore {
  /** The people as noted, once the file was read; null until then. */
  private people: Map<string, PersonSeen> | null = null;
  /** When the file was started; set with `people`. */
  private startedAt: string | null = null;
  /** True while a note in memory is not written yet. */
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When `prune` looks again, in milliseconds. */
  private nextPruneAt = 0;
  /** The notes, one after another, so they land in the order they came. */
  private notes: Promise<unknown> = Promise.resolve();
  /** The writes, one after another. */
  private writes: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private readonly maxPeople: number;
  private readonly maxBytes: number;
  private readonly flushMs: number;
  private readonly onWrite: (ok: boolean) => void;

  constructor(
    readonly file: string,
    options: ProviderPeopleOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxPeople = options.maxPeople ?? PEOPLE_MAX;
    this.maxBytes = options.maxBytes ?? PEOPLE_FILE_MAX_BYTES;
    this.flushMs = options.flushMs ?? FLUSH_MS;
    this.onWrite = options.onWrite ?? (() => {});
  }

  /** Read the file now, so the first sign-in after a start does not wait for
   *  it. Never rejects. */
  warm(): Promise<void> {
    const mine = this.notes.then(() => this.memory(false)).then(() => {});
    this.notes = mine.catch(() => {});
    return mine.catch(() => {});
  }

  /**
   * Note one sign-in through the provider: the mapped groups its token
   * carried. It replaces what the person's sign-in before it noted. Notes land
   * in the order they came; the file is written within FLUSH_MS (see `flush`).
   *
   * With no group, the person holds no role here now: what was noted of them
   * is removed, and a person who was never noted changes nothing.
   */
  note(args: { issuer: string; subject: string; groups: readonly string[] }): Promise<void> {
    // The time of the sign-in, not of the write.
    const at = this.now();
    const mine = this.notes.then(() => this.noteNow(args, at));
    this.notes = mine.catch(() => {});
    return mine;
  }

  /** Write what is noted and not written yet, now, after the notes that came
   *  before. Rejects when the file cannot be written; the notes stay, and a
   *  write is tried again. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.notes;
    const mine = this.writes.then(() => this.writeNow());
    this.writes = mine.catch(() => {});
    return mine;
  }

  /** Each person's last sign-in in the FILE, when it counts at `now`, and when
   *  the file was started. Rejects with `PeopleUnreadable` when the file is
   *  there and cannot be read, or is damaged. This is the daemon's read: notes
   *  still in the console's memory are not in it. */
  async recent(now: Date = this.now()): Promise<PeopleRead> {
    const loaded = await loadFile(this.file);
    if (loaded.state === "absent") return { people: [], since: null };
    if (loaded.state !== "read") throw new PeopleUnreadable();
    return {
      people: [...loaded.file.people.values()].filter((seen) => isRecent(seen, now)),
      since: loaded.file.startedAt,
    };
  }

  /**
   * Drop the sign-ins that left the window, and write the file within
   * FLUSH_MS when one was dropped. The console's sweep calls it every minute,
   * and it looks at most once a day: a day is all the precision a window of
   * PEOPLE_DAYS needs, and a large file is not written again every minute.
   * When nothing is in memory (the read at start failed, or the file is
   * damaged), it reads the file again, which drops what left the window.
   */
  prune(): void {
    const now = this.now().getTime();
    // A next look more than a day away was set by a clock that ran ahead:
    // waiting for it would stop the drop until real time catches up.
    if (now < this.nextPruneAt && this.nextPruneAt - now <= DAY_MS) return;
    this.nextPruneAt = now + DAY_MS;
    if (!this.people) {
      void this.warm();
      return;
    }
    if (this.pruneOld()) this.schedule();
  }

  private async noteNow(
    args: { issuer: string; subject: string; groups: readonly string[] },
    at: Date,
  ): Promise<void> {
    const groups = [...new Set(args.groups.map(groupKey))];
    const people = await this.memory(true);
    if (!people) return;
    const key = personKey(args.issuer, args.subject);
    const issuer = issuerKey(args.issuer);
    if (groups.length > 0) {
      const was = people.get(key);
      const unchanged =
        was !== undefined &&
        was.issuer === issuer &&
        sameGroups(was.groups, groups) &&
        at.getTime() - Date.parse(was.at) < DAY_MS;
      if (!unchanged) {
        people.set(key, { at: at.toISOString(), issuer, groups });
        this.dirty = true;
      }
    } else if (people.delete(key)) {
      this.dirty = true;
    }
    if (this.dirty) this.schedule();
  }

  private async writeNow(): Promise<void> {
    const people = this.people;
    if (!this.dirty || !people || !this.startedAt) return;
    const at = this.now();
    // Newest first, within the window, within the cap on people and on bytes.
    const kept: [string, PersonSeen][] = [];
    let bytes = 64;
    // Each time read once: a sort that parses in every comparison holds the
    // console for most of a second at PEOPLE_MAX.
    const from = at.getTime() - PEOPLE_DAYS * DAY_MS;
    const newestFirst = [...people.entries()]
      .map(([key, seen]) => ({ key, seen, time: Date.parse(seen.at) }))
      .filter((entry) => entry.time >= from)
      .sort((a, b) => b.time - a.time);
    for (const { key, seen } of newestFirst) {
      if (kept.length >= this.maxPeople) break;
      const size = JSON.stringify(key).length + JSON.stringify(seen).length + 2;
      if (bytes + size > this.maxBytes) break;
      bytes += size;
      kept.push([key, seen]);
    }
    // Pruned in place: a note that holds this map keeps holding the live one.
    const keep = new Set(kept.map(([key]) => key));
    for (const key of [...people.keys()]) if (!keep.has(key)) people.delete(key);
    // Taken now: a note that lands while this write runs makes it dirty again.
    this.dirty = false;
    try {
      await writePrivateJson(this.file, { version: 1, startedAt: this.startedAt, people: Object.fromEntries(kept) });
    } catch (thrown) {
      this.dirty = true;
      this.onWrite(false);
      this.schedule();
      throw thrown;
    }
    this.onWrite(true);
  }

  /** A write within FLUSH_MS, unless one is already due. */
  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // A failure is told through `onWrite`, and schedules the next try.
      this.flush().catch(() => {});
    }, this.flushMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** The people in memory, read from the file the first time. Null when the
   *  file cannot be read now, or when it is damaged and this is no note: the
   *  next sign-in starts a damaged file again, and reading it again at each
   *  one would cost every sign-in a parse of up to PEOPLE_FILE_MAX_BYTES. */
  private async memory(fromNote: boolean): Promise<Map<string, PersonSeen> | null> {
    if (this.people) return this.people;
    const loaded = await loadFile(this.file);
    if (loaded.state === "read") {
      this.people = loaded.file.people;
      this.startedAt = loaded.file.startedAt;
      // What left the window while the console was away goes at the next write.
      this.nextPruneAt = 0;
      this.prune();
      return this.people;
    }
    if (loaded.state === "failed") {
      // Never started again on a read that failed: the file may be whole.
      this.onWrite(false);
      return null;
    }
    // Absent, or damaged: nothing in it can be counted.
    if (loaded.state === "damaged" && !fromNote) return null;
    this.people = new Map();
    this.startedAt = this.now().toISOString();
    this.nextPruneAt = this.now().getTime() + DAY_MS;
    if (loaded.state === "damaged") this.dirty = true;
    return this.people;
  }

  /** Drop the sign-ins that left the window. True when one was dropped: the
   *  file then needs a write. */
  private pruneOld(): boolean {
    const people = this.people;
    if (!people) return false;
    const from = this.now().getTime() - PEOPLE_DAYS * DAY_MS;
    let dropped = false;
    for (const [key, seen] of people) {
      if (Date.parse(seen.at) < from) {
        people.delete(key);
        dropped = true;
      }
    }
    if (dropped) this.dirty = true;
    return dropped;
  }
}
