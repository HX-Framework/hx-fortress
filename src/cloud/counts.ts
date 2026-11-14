// What crossed the connection, counted.
//
// The connection counts every frame by its name and its direction, and every
// frame it refused or dropped. The counts are this fortress's own record of
// what its connection carried: nobody asks the control plane for them.
//
// They are kept for each UTC day in one file in the fortress's folder, so the
// console (a process of its own) and the terminal can read them. The daemon is
// the only writer. It writes at most once every ten seconds while a count
// changes, and when it stops, so a crash can lose the counts of its last ten
// seconds and nothing older.
//
// A count is keyed by a frame's name only when the name is on the closed list
// in kinds.ts. A name the control plane invented is never a key here: it is
// counted under `unknown`.
/* eslint-disable security/detect-object-injection -- every key is a day this
   file computed from the clock, or a frame name the caller took from the closed
   list in kinds.ts */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { MESSAGE_KINDS, type Direction, type DropReason, type SessionContentSetting } from "./kinds";

export const COUNTS_FILE_VERSION = 1;
/** How many UTC days of counts are kept. */
export const COUNT_DAYS_KEPT = 90;
/** How often the file is written while a count changes. */
export const COUNTS_FLUSH_MS = 10_000;
/** A file larger than this is not this file. Ninety days of at most a few
 *  dozen names each is a few tens of kilobytes. */
const COUNTS_FILE_MAX_BYTES = 1024 * 1024;
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
  const { too_large: tooLarge, unreadable, unknown } = dropped;
  if (!isCount(tooLarge) || !isCount(unreadable) || !isCount(unknown)) return null;
  return { in: incoming, out: outgoing, refused, dropped: { too_large: tooLarge, unreadable, unknown } };
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

/**
 * Read the counts file, for the console and the terminal.
 *
 * `absent` is a fortress whose connection has counted nothing yet.
 * `unreadable` is a file that is there and cannot be used.
 */
export async function readConnectionCounts(
  file: string,
): Promise<{ state: "ok"; counts: CountsFile } | { state: "absent" } | { state: "unreadable" }> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "unreadable" };
  }
  if (Buffer.byteLength(text) > COUNTS_FILE_MAX_BYTES) return { state: "unreadable" };
  const counts = parseCounts(text);
  return counts ? { state: "ok", counts } : { state: "unreadable" };
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
  sessionContent: "on" | "off" | "not_set";
  /** The start of the UTC day the counts are for. */
  since: string;
  /** Every frame that was carried or refused that day, in the order of the
   *  kinds. A frame that was never seen is left out. */
  messages: FrameCount[];
  dropped: { tooLarge: number; unreadable: number; unknown: number };
}

/** The state of session content as a page and an answer name it. */
export function sessionContentState(setting: SessionContentSetting): ConnectionView["sessionContent"] {
  return setting ?? "not_set";
}

export function connectionView(
  sessionContent: ConnectionView["sessionContent"],
  day: string,
  counts: DayCounts | null,
): ConnectionView {
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
  return {
    sessionContent,
    since: `${day}T00:00:00.000Z`,
    messages,
    dropped: {
      tooLarge: counts?.dropped.too_large ?? 0,
      unreadable: counts?.dropped.unreadable ?? 0,
      unknown: counts?.dropped.unknown ?? 0,
    },
  };
}

export interface ConnectionCountsDeps {
  /** Where the counts are kept: `connection/counts.json` in the fortress's folder. */
  file: string;
  now?: () => Date;
  logger?: { error(message: string, fields?: Record<string, unknown>): void };
  /** How often to write while a count changes. 0 writes only on `flush`. */
  flushMs?: number;
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
  private dirty = false;
  private writing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Said once, so a folder that cannot be written does not become the log. */
  private saidUnwritable = false;
  private readonly now: () => Date;

  constructor(private readonly deps: ConnectionCountsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Take up the counts of earlier runs, and start writing.
   *
   * A file that cannot be used is moved aside under the same name with
   * `.unreadable` added, and this run counts from zero. The log says so,
   * because up to ninety days of counts are no longer shown.
   */
  async start(): Promise<void> {
    const read = await readConnectionCounts(this.deps.file);
    if (read.state === "ok") {
      // Counts made before the file was read stay: add, never replace.
      const counted = this.days;
      this.days = read.counts.days;
      for (const [day, counts] of Object.entries(counted)) this.merge(day, counts);
    } else if (read.state === "unreadable") {
      const aside = `${this.deps.file}.unreadable`;
      const moved = await rename(this.deps.file, aside).then(
        () => true,
        () => false,
      );
      this.deps.logger?.error(
        "the counts of the connection's messages could not be read, so this run starts them again from zero",
        { keptAs: moved ? path.basename(aside) : "not kept" },
      );
      this.dirty = true;
    }
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

  /** Write the file now if a count changed since the last write. */
  async flush(): Promise<void> {
    // One write at a time. A caller that arrives during a write waits for it
    // and then writes what changed meanwhile.
    while (this.writing) await this.writing;
    if (!this.dirty) return;
    this.dirty = false;
    this.prune();
    const body = `${JSON.stringify({ version: COUNTS_FILE_VERSION, days: this.days } satisfies CountsFile)}\n`;
    this.writing = this.write(body).finally(() => {
      this.writing = null;
    });
    await this.writing;
  }

  /** Stop the timer and write what is left. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  private async write(body: string): Promise<void> {
    const folder = path.dirname(this.deps.file);
    const temporary = `${this.deps.file}.${process.pid}.tmp`;
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(temporary, body, { mode: 0o600 });
      // The mode given to writeFile is masked by the process's umask.
      await chmod(temporary, 0o600).catch(() => {});
      await rename(temporary, this.deps.file);
      this.saidUnwritable = false;
    } catch (error) {
      // Still counted in memory, and written at the next change.
      this.dirty = true;
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
    this.dirty = true;
  }

  private merge(day: string, counts: DayCounts): void {
    const into = (this.days[day] ??= emptyDay());
    for (const tally of ["in", "out", "refused"] as const) {
      for (const [frame, count] of Object.entries(counts[tally])) {
        into[tally][frame] = Math.min((into[tally][frame] ?? 0) + count, LARGEST_COUNT);
      }
    }
    for (const reason of ["too_large", "unreadable", "unknown"] as const) {
      into.dropped[reason] = Math.min(into.dropped[reason] + counts.dropped[reason], LARGEST_COUNT);
    }
    this.dirty = true;
  }

  /** Drop the days that are older than the days kept. */
  private prune(): void {
    const oldest = utcDay(new Date(this.now().getTime() - (COUNT_DAYS_KEPT - 1) * DAY_MS));
    // `YYYY-MM-DD` sorts as text in the order of the days.
    for (const day of Object.keys(this.days)) if (day < oldest) delete this.days[day];
  }
}
