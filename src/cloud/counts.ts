// What crossed the connection, counted.
//
// The connection counts every frame by its name and its direction, and every
// frame it refused or dropped. The counts are this HX Fortress's own record of
// what its connection carried: nobody asks the control plane for them.
//
// They are kept for each UTC day in one file in this HX Fortress's folder, so the
// console (a process of its own) and the terminal can read them. The daemon is
// the only writer. It writes at most once every ten seconds while a count
// changes, and when it stops, so a crash can lose the counts of its last ten
// seconds and nothing older. The frames this HX Fortress sends on a timer do not
// make it write that often by themselves: see TIMER_FRAMES.
//
// A file that is there and cannot be read is never written over. See `load`.
//
// A count is keyed by a frame's name only when the name is on the closed list
// in kinds.ts. A name the control plane invented is never a key here: it is
// counted under `unknown`.
/* eslint-disable security/detect-object-injection -- every key is a day this
   file computed from the clock, or a frame name the caller took from the closed
   list in kinds.ts */

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";
import path from "node:path";

import { writePrivateJson } from "../host/private-json";
import {
  DROP_REASONS,
  MESSAGE_KINDS,
  type Direction,
  type DropReason,
  type SessionContentState,
} from "./kinds";

export const COUNTS_FILE_VERSION = 1;
/** How many UTC days of counts are kept: today and the 399 days before it.
 *  More than a year, so that a period from the first of January to today can
 *  be answered on every day of the year. */
export const COUNT_DAYS_KEPT = 400;
/** How often the file is written while a count changes. */
export const COUNTS_FLUSH_MS = 10_000;
/** How often it is written while the only counts that change are those of
 *  TIMER_FRAMES. */
export const COUNTS_IDLE_FLUSH_MS = 5 * 60_000;
/**
 * The frames this HX Fortress sends on a timer, and the answer to one. They cross
 * a connection that nobody is using, twice a minute and more. Counted like any
 * other frame, but a change in their counts alone is written only every five
 * minutes, so an idle HX Fortress does not rewrite the file twice a minute. A
 * crash can then lose up to five minutes of these counts, and no other.
 */
const TIMER_FRAMES: ReadonlySet<string> = new Set(["heartbeat", "heartbeatAck", "collectionStats"]);
/** A file larger than this is not this file. The days kept, each with every
 *  frame of the closed list carried and refused and every count at its largest,
 *  are under one megabyte. A usual file is a tenth of that. */
export const COUNTS_FILE_MAX_BYTES = 4 * 1024 * 1024;
/** The largest count that is still exact. */
const LARGEST_COUNT = Number.MAX_SAFE_INTEGER;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DayCounts {
  /** Frames taken in, by name. */
  in: Record<string, number>;
  /** Frames sent, by name. */
  out: Record<string, number>;
  /** Frames of a kind that was not carried, by name. */
  refused: Record<string, number>;
  /** Frames dropped without an answer, by reason. */
  dropped: Record<DropReason, number>;
}

export interface CountsFile {
  version: typeof COUNTS_FILE_VERSION;
  /** One entry for each UTC day, keyed `YYYY-MM-DD`. */
  days: Record<string, DayCounts>;
}

export function emptyDay(): DayCounts {
  return { in: {}, out: {}, refused: {}, dropped: { too_large: 0, unreadable: 0, unknown: 0 } };
}

/** The file's name for each reason a frame is dropped, as an answer names it. */
const DROPPED_AS = { too_large: "tooLarge", unreadable: "unreadable", unknown: "unknown" } as const satisfies Record<
  DropReason,
  string
>;

/** The UTC day of a moment, as the file keys it. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FRAME_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readTally(value: unknown): Record<string, number> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const tally: Record<string, number> = {};
  for (const [name, count] of Object.entries(value)) {
    if (!FRAME_NAME_PATTERN.test(name) || !isCount(count)) return null;
    tally[name] = count;
  }
  return tally;
}

function readDay(value: unknown): DayCounts | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const day = value as Record<string, unknown>;
  const [incoming, outgoing, refused] = [readTally(day.in), readTally(day.out), readTally(day.refused)];
  const dropped = day.dropped as Record<string, unknown> | null | undefined;
  if (!incoming || !outgoing || !refused || typeof dropped !== "object" || dropped === null) return null;
  const read = emptyDay().dropped;
  for (const reason of DROP_REASONS) {
    const count = dropped[reason];
    if (!isCount(count)) return null;
    read[reason] = count;
  }
  return { in: incoming, out: outgoing, refused, dropped: read };
}

/**
 * The counts in a file's text, or null when the text is not a counts file.
 *
 * Strict: one entry that is not a day of counts makes the whole text unusable.
 * A reader then says that the counts could not be read. It never shows a part.
 */
export function parseCounts(text: string): CountsFile | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const file = value as Record<string, unknown>;
  if (file.version !== COUNTS_FILE_VERSION) return null;
  if (typeof file.days !== "object" || file.days === null || Array.isArray(file.days)) return null;
  const days: Record<string, DayCounts> = {};
  for (const [day, counts] of Object.entries(file.days)) {
    if (!DAY_PATTERN.test(day)) return null;
    const read = readDay(counts);
    if (!read) return null;
    days[day] = read;
  }
  return { version: COUNTS_FILE_VERSION, days };
}

/** What reading the counts file gave. */
export type CountsRead =
  | { state: "ok"; counts: CountsFile }
  /** An HX Fortress whose connection has counted nothing yet. */
  | { state: "absent" }
  /**
   * A file that is there and cannot be used. `content`: it was read, and it is
   * not a counts file of this build. `io`: it could not be read at all, so
   * nothing is known about what it holds.
   */
  | { state: "unreadable"; cause: "content" | "io" };

/**
 * Read the counts file: for the daemon at its start, and for the console.
 *
 * It never reads more than the size a counts file can have, whatever is at
 * the path.
 */
export async function readConnectionCounts(file: string): Promise<CountsRead> {
  let text: string;
  try {
    // Opened so that the open itself never waits. Opening something that is
    // not a file can otherwise wait for ever: a named pipe waits for a writer.
    // What was opened is looked at through its own handle, and only a file is
    // read: nothing is asked about the path a second time.
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile()) return { state: "unreadable", cause: "io" };
      if (info.size > COUNTS_FILE_MAX_BYTES) return { state: "unreadable", cause: "content" };
      text = await handle.readFile("utf8");
    } finally {
      await handle.close().catch(() => {});
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "absent" }
      : { state: "unreadable", cause: "io" };
  }
  // The file can have grown between the two calls above.
  if (Buffer.byteLength(text) > COUNTS_FILE_MAX_BYTES) return { state: "unreadable", cause: "content" };
  const counts = parseCounts(text);
  return counts ? { state: "ok", counts } : { state: "unreadable", cause: "content" };
}

/** What one frame did on one day. */
export interface FrameCount {
  /** The kind's id, from kinds.ts. */
  kind: string;
  /** The frame's name. */
  frame: string;
  direction: Direction;
  /** How many were carried. */
  count: number;
  /** How many were not, because their kind was not carried. */
  refused: number;
}

/** The connection as a reader is shown it: what it may carry, and what one UTC
 *  day's counts were. */
export interface ConnectionView {
  sessionContent: SessionContentState;
  /** The start of the UTC day the counts are for. */
  since: string;
  /** Every frame that was carried or refused that day, in the order of the
   *  kinds. A frame that was never seen is left out. */
  messages: FrameCount[];
  dropped: { tooLarge: number; unreadable: number; unknown: number };
}

/** What one UTC day's counts were, as a reader is shown them. */
export interface DayView {
  /** The start of the UTC day. */
  day: string;
  /** Every frame that was carried or refused that day, in the order of the
   *  kinds. A frame that was never seen is left out. */
  messages: FrameCount[];
  dropped: { tooLarge: number; unreadable: number; unknown: number };
}

/** The start of a UTC day, as a time. */
function startOfDay(day: string): string {
  return `${day}T00:00:00.000Z`;
}

/**
 * One UTC day's counts as a reader is shown them: each frame of the closed list
 * in kinds.ts with its kind and its direction. A name in the counts that is not
 * on that list is not shown: the list is what a reader may be told.
 */
export function dayView(day: string, counts: DayCounts | null): DayView {
  const messages: FrameCount[] = [];
  for (const kind of MESSAGE_KINDS) {
    for (const direction of ["in", "out"] as const) {
      for (const frame of kind[direction]) {
        const count = counts?.[direction][frame] ?? 0;
        const refused = counts?.refused[frame] ?? 0;
        if (count > 0 || refused > 0) messages.push({ kind: kind.id, frame, direction, count, refused });
      }
    }
  }
  const dropped = { tooLarge: 0, unreadable: 0, unknown: 0 };
  for (const reason of DROP_REASONS) dropped[DROPPED_AS[reason]] = counts?.dropped[reason] ?? 0;
  return { day: startOfDay(day), messages, dropped };
}

export function connectionView(
  sessionContent: SessionContentState,
  day: string,
  counts: DayCounts | null,
): ConnectionView {
  const { messages, dropped } = dayView(day, counts);
  return { sessionContent, since: startOfDay(day), messages, dropped };
}

/** The oldest UTC day that is still kept, at a moment. */
export function oldestDayKept(now: Date): string {
  return utcDay(new Date(now.getTime() - (COUNT_DAYS_KEPT - 1) * DAY_MS));
}

/** Whether a day's view holds nothing: no frame of the closed list was carried
 *  or refused, and nothing was dropped. */
function nothingToShow(view: DayView): boolean {
  const { tooLarge, unreadable, unknown } = view.dropped;
  return view.messages.length === 0 && tooLarge === 0 && unreadable === 0 && unknown === 0;
}

export interface ConnectionCountsDeps {
  /** Where the counts are kept: `connection/counts.json` in this HX Fortress's folder. */
  file: string;
  now?: () => Date;
  logger?: { error(message: string, fields?: Record<string, unknown>): void };
  /** How often to write while a count changes. 0 writes only on `flush`. */
  flushMs?: number;
  /** How often to write while only the counts of timer frames change. */
  idleFlushMs?: number;
}

/** What the connection needs of the counts. */
export interface FrameCounter {
  received(frame: string): void;
  sent(frame: string): void;
  refused(frame: string): void;
  dropped(reason: DropReason): void;
}

export class ConnectionCounts implements FrameCounter {
  private days: Record<string, DayCounts> = {};
  /** A count changed that is written at the next flush. */
  private dirty = false;
  /** Only counts of timer frames changed. Written every `idleFlushMs`. */
  private idleDirty = false;
  private lastWriteAt = 0;
  /**
   * Whether the file's own counts were taken up, so the file may be written.
   * False until the file was read, or found absent, or moved aside. While it
   * is false nothing is written: a write would replace every day of counts
   * that this run never saw.
   */
  private loaded = false;
  /** Loads and writes, one at a time, in the order they were asked for. */
  private queue: Promise<void> = Promise.resolve();
  /** A write that was asked for and has not begun. A second ask joins it, so
   *  however long one turn takes, at most one write waits behind it. */
  private waiting: { everything: boolean; done: Promise<void> } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Said once, so a folder that cannot be used does not become the log. */
  private saidUnwritable = false;
  private saidUnreadable = false;
  private readonly now: () => Date;

  constructor(private readonly deps: ConnectionCountsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Take up the counts of earlier runs, and start writing.
   *
   * A file that cannot be used does not make this reject: see `load`. Asked
   * for twice, it takes the file's counts up once.
   */
  async start(): Promise<void> {
    await this.inTurn(() => this.load());
    const flushMs = this.deps.flushMs ?? COUNTS_FLUSH_MS;
    if (flushMs > 0 && !this.timer) {
      this.timer = setInterval(() => void this.flush(), flushMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  received(frame: string): void {
    this.add("in", frame);
  }

  sent(frame: string): void {
    this.add("out", frame);
  }

  refused(frame: string): void {
    this.add("refused", frame);
  }

  dropped(reason: DropReason): void {
    const day = this.day();
    day.dropped[reason] = Math.min(day.dropped[reason] + 1, LARGEST_COUNT);
    this.dirty = true;
  }

  /** The counts of one UTC day, as a copy. Today when no day is given. */
  of(day: string = utcDay(this.now())): DayCounts {
    const counts = this.days[day] ?? emptyDay();
    return {
      in: { ...counts.in },
      out: { ...counts.out },
      refused: { ...counts.refused },
      dropped: { ...counts.dropped },
    };
  }

  /**
   * Whether the counts of earlier runs are known: the file was read, or there
   * was none. While this is false, the days before this run are in a file that
   * could not be read, and what is held here is only what this run counted.
   */
  get takenUp(): boolean {
    return this.loaded;
  }

  /**
   * What crossed on each UTC day from `fromDay` to `toDay`, both included, the
   * oldest day first. Days are `YYYY-MM-DD`.
   *
   * Null while the counts of earlier runs are not known (`takenUp`). What is
   * held then is a part of the days, and a reader is not handed a part.
   *
   * A day with nothing to show is left out. So is a day older than the days
   * kept, also when the file has not been written since it grew that old.
   */
  daysBetween(fromDay: string, toDay: string): DayView[] | null {
    if (!this.loaded) return null;
    const oldest = oldestDayKept(this.now());
    // `YYYY-MM-DD` sorts as text in the order of the days.
    return Object.keys(this.days)
      .filter((day) => day >= fromDay && day <= toDay && day >= oldest)
      .sort()
      .map((day) => dayView(day, this.days[day] ?? null))
      .filter((view) => !nothingToShow(view));
  }

  /**
   * Write the file now if a count changed since the last write.
   *
   * Counts of timer frames alone are written only when the last write is
   * `idleFlushMs` old. `everything` writes them too: a stop does that.
   */
  flush(everything = false): Promise<void> {
    const waiting = this.waiting;
    if (waiting) {
      waiting.everything ||= everything;
      return waiting.done;
    }
    const mine = { everything, done: Promise.resolve() };
    mine.done = this.inTurn(() => {
      // From here on, an ask gets a write of its own: a count that is made
      // after this point may be too late for this one.
      if (this.waiting === mine) this.waiting = null;
      return this.flushNow(mine.everything);
    });
    this.waiting = mine;
    return mine.done;
  }

  /** Stop the timer and write what is left. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush(true);
  }

  /** Run one load or one write after those asked for before it. */
  private inTurn(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work);
    // The queue goes on whatever one turn did.
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * Take up the file's counts, so the file may be written.
   *
   * A file that was read and is not a counts file of this build is moved
   * aside, under a name of its own that no earlier copy has, and this run
   * counts from zero. The log says so, because the days of counts it held are
   * no longer shown.
   *
   * A file that could not be read at all is left where it is, and so is a
   * file that could not be moved aside. Nothing is written while it stays
   * that way, and the read is tried again at every write. This run's counts
   * are then in memory only, and the log says so once.
   */
  private async load(): Promise<void> {
    if (this.loaded) return;
    const read = await readConnectionCounts(this.deps.file);
    if (read.state === "ok") {
      // Counts made before the file was read stay: add, never replace.
      const counted = this.days;
      this.days = read.counts.days;
      for (const [day, counts] of Object.entries(counted)) this.merge(day, counts);
      this.loaded = true;
      return;
    }
    if (read.state === "absent") {
      this.loaded = true;
      return;
    }
    if (read.cause === "content") {
      const stamp = this.now().toISOString().replace(/[-:.]/g, "");
      const aside = `${this.deps.file}.unreadable-${stamp}-${randomBytes(4).toString("hex")}`;
      const moved = await rename(this.deps.file, aside).then(
        () => true,
        () => false,
      );
      if (moved) {
        this.deps.logger?.error(
          "the counts of the connection's messages are not a counts file of this build, so this run starts them again from zero",
          { keptAs: path.basename(aside) },
        );
        this.loaded = true;
        this.dirty = true;
        return;
      }
    }
    if (!this.saidUnreadable) {
      this.saidUnreadable = true;
      this.deps.logger?.error(
        "the counts of the connection's messages could not be read, so they are not written either: this run's counts are kept in memory until the file can be read",
        { cause: read.cause },
      );
    }
  }

  private async flushNow(everything: boolean): Promise<void> {
    if (!this.loaded) await this.load();
    if (!this.loaded) return;
    const idleMs = this.deps.idleFlushMs ?? COUNTS_IDLE_FLUSH_MS;
    const idleDue = this.idleDirty && (everything || this.now().getTime() - this.lastWriteAt >= idleMs);
    if (!this.dirty && !idleDue) return;
    const [wasDirty, wasIdleDirty] = [this.dirty, this.idleDirty];
    this.dirty = false;
    this.idleDirty = false;
    this.prune();
    try {
      await writePrivateJson(this.deps.file, { version: COUNTS_FILE_VERSION, days: this.days } satisfies CountsFile);
      this.lastWriteAt = this.now().getTime();
      this.saidUnwritable = false;
    } catch (error) {
      // Still counted in memory, and written at the next flush.
      this.dirty ||= wasDirty;
      this.idleDirty ||= wasIdleDirty;
      if (!this.saidUnwritable) {
        this.saidUnwritable = true;
        this.deps.logger?.error("the counts of the connection's messages could not be written", {
          code: (error as NodeJS.ErrnoException).code ?? "unknown",
        });
      }
    }
  }

  private day(): DayCounts {
    const key = utcDay(this.now());
    return (this.days[key] ??= emptyDay());
  }

  private add(tally: "in" | "out" | "refused", frame: string): void {
    const counts = this.day()[tally];
    counts[frame] = Math.min((counts[frame] ?? 0) + 1, LARGEST_COUNT);
    if (tally !== "refused" && TIMER_FRAMES.has(frame)) this.idleDirty = true;
    else this.dirty = true;
  }

  private merge(day: string, counts: DayCounts): void {
    const into = (this.days[day] ??= emptyDay());
    for (const tally of ["in", "out", "refused"] as const) {
      for (const [frame, count] of Object.entries(counts[tally])) {
        into[tally][frame] = Math.min((into[tally][frame] ?? 0) + count, LARGEST_COUNT);
      }
    }
    for (const reason of DROP_REASONS) {
      into.dropped[reason] = Math.min(into.dropped[reason] + counts.dropped[reason], LARGEST_COUNT);
    }
    this.dirty = true;
  }

  /** Drop the days that are older than the days kept. */
  private prune(): void {
    const oldest = oldestDayKept(this.now());
    // `YYYY-MM-DD` sorts as text in the order of the days.
    for (const day of Object.keys(this.days)) if (day < oldest) delete this.days[day];
  }
}
