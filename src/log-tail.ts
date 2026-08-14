// Log reading primitives: a bounded reverse-seek tail that walks back into
// rotated segments, and a follow watcher with tail -F semantics.
//
// Both exist because the obvious implementations break on the files this
// actually runs against. `readFile` + `split("\n")` materializes a multi-GB log
// to show 50 lines. A watcher that holds one file descriptor goes permanently
// silent the moment the log rotates — the writer is appending to a new inode
// while the reader waits on the old one, with no error anywhere to say so.

import { open, stat, type FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

/** Rotate once the live file passes this. */
export const ROTATE_BYTES = 16 * 1024 * 1024;
/** How many rotated segments to keep. */
export const ROTATE_KEEP = 5;
/** Read granularity for the backwards walk. */
const CHUNK_BYTES = 64 * 1024;

export function rotateSizeFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.FORTRESS_LOG_ROTATE_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : ROTATE_BYTES;
}

export function rotateKeepFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.FORTRESS_LOG_ROTATE_KEEP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : ROTATE_KEEP;
}

/** `<log>.1` is the most recently rotated segment. */
export function segmentPath(logPath: string, index: number): string {
  return `${logPath}.${index}`;
}

/** Rotated segments, newest first. */
export function rotatedSegments(logPath: string, keep: number = ROTATE_KEEP): string[] {
  return Array.from({ length: keep }, (_, i) => segmentPath(logPath, i + 1));
}

/** The last `n` lines of ONE file, read by seeking backwards from the end.
 *  Never reads more than it needs: a multi-GB log costs a few chunk reads. */
export async function readLastLinesOfFile(filePath: string, n: number): Promise<string[]> {
  if (n <= 0) return [];
  let handle: FileHandle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return [];
  }
  try {
    const { size } = await handle.stat();
    let position = size;
    let carry = "";
    // BYTES, not text. Each chunk was decoded on its own, so a multi-byte
    // character straddling a 64 KiB boundary was split across two `toString`
    // calls and both halves decoded to replacement characters — mojibake in
    // `hx-fortress logs` and in the console's backfill. Carrying the undecoded
    // head bytes and prepending them to the next chunk decodes the character
    // once, whole.
    let carryBytes = Buffer.alloc(0);
    const lines: string[] = [];
    while (position > 0 && lines.length <= n) {
      const length = Math.min(CHUNK_BYTES, position);
      position -= length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      const raw = Buffer.concat([buffer, carryBytes]);
      // Reading BACKWARDS, so a character split by this boundary has its
      // continuation bytes at the START of this chunk and its lead byte at the
      // END of the next one we read. Strip them and carry them forward.
      let lead = 0;
      if (position > 0) {
        while (lead < raw.length && (raw[lead]! & 0xc0) === 0x80) lead += 1;
      }
      carryBytes = position > 0 ? raw.subarray(0, lead) : Buffer.alloc(0);
      const text = raw.subarray(lead).toString("utf8") + carry;
      const parts = text.split("\n");
      // The first part may be the tail of a line whose head is in the next
      // chunk back; carry it rather than emitting a truncated record.
      carry = position > 0 ? (parts.shift() ?? "") : "";
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        if (parts[i].length > 0) lines.push(parts[i]);
        if (lines.length > n) break;
      }
    }
    if (position === 0 && carry.length > 0 && lines.length <= n) lines.push(carry);
    return lines.reverse().slice(-n);
  } finally {
    await handle.close();
  }
}

/**
 * The last `n` lines across the current file AND its rotated segments.
 *
 * `--lines 500` on a log that rotated 200 lines ago has to reach into
 * `<log>.1`, or the answer is silently short — which reads as "nothing happened
 * before this" rather than "the file rotated".
 */
export async function readLastLines(
  logPath: string,
  n: number,
  keep: number = ROTATE_KEEP,
): Promise<string[]> {
  const collected = await readLastLinesOfFile(logPath, n);
  for (const file of rotatedSegments(logPath, keep)) {
    if (collected.length >= n) break;
    const older = await readLastLinesOfFile(file, n - collected.length);
    // A gap in the numbering means there is nothing older to find.
    if (older.length === 0) break;
    collected.unshift(...older);
  }
  return collected.slice(-n);
}

export interface WatchOptions {
  /** Poll cadence. Polling rather than fs.watch: watch semantics differ per
   *  platform and are unreliable across a rename, which is exactly the event
   *  that matters here. */
  pollMs?: number;
  /** Replay the file from the beginning instead of following from the end. */
  fromStart?: boolean;
}

/**
 * Follow a log across rotations — `tail -F`, not `tail -f`.
 *
 * Identity is (dev, ino) on an OPEN handle. When the writer rotates, the path
 * points at a new inode while the handle still refers to the old one: the
 * watcher drains whatever the old inode gained after our last offset, THEN
 * reopens at the new file from zero. That ordering is the whole point — the
 * lines written between the last poll and the rename live only in the old
 * inode, which no path can reach once the rename has happened.
 */
export async function watchLines(
  logPath: string,
  onLine: (line: string) => void,
  signal: AbortSignal,
  options: WatchOptions = {},
): Promise<void> {
  const pollMs = options.pollMs ?? 100;
  let handle: FileHandle | null = null;
  let identity: string | null = null;
  let offset = 0;
  let carry = "";
  // Each poll reads its own byte range, and a multi-byte character straddling
  // two ranges is not a whole character in either. Decoding each range on its
  // own turned it into replacement characters — the live Logs tab is what reads
  // these lines, so the operator saw the corruption. StringDecoder holds the
  // incomplete tail bytes UNDECODED until the rest arrives; it is per
  // attachment, because a rotation or a truncation means the held bytes belong
  // to a file nobody will read again.
  let decoder = new StringDecoder("utf8");
  // Once attached, EVERY later attach starts at byte 0. Seeking to the end
  // again would silently skip whatever the new segment already holds — the
  // exact hole a rotation opens when the reopen lands a poll late.
  let attached = false;

  const drain = async (): Promise<void> => {
    if (!handle) return;
    const info = await handle.stat();
    if (info.size < offset) {
      // Truncated in place by a writer that reused the inode.
      offset = 0;
      carry = "";
      decoder = new StringDecoder("utf8");
    }
    if (info.size <= offset) return;
    const buffer = Buffer.alloc(info.size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    offset = info.size;
    const parts = (carry + decoder.write(buffer)).split("\n");
    carry = parts.pop() ?? "";
    for (const part of parts) if (part.length > 0) onLine(part);
  };

  try {
    while (!signal.aborted) {
      const onDisk = await stat(logPath).catch(() => null);
      if (onDisk) {
        if (handle && `${onDisk.dev}:${onDisk.ino}` !== identity) {
          // Rotated. Drain what the previous inode gained after our last
          // offset BEFORE letting go of it — those bytes live only there once
          // the rename has happened, and no path reaches them again.
          await drain();
          await handle.close();
          handle = null;
        }
        if (!handle) {
          const opened = await open(logPath, "r").catch(() => null);
          if (opened) {
            // Identity comes from the OPEN handle, never from the earlier stat:
            // another rotation between the two would pin the wrong inode and
            // the watcher would never notice the next one.
            const info = await opened.stat();
            handle = opened;
            identity = `${info.dev}:${info.ino}`;
            offset = attached || options.fromStart ? 0 : info.size;
            carry = "";
            decoder = new StringDecoder("utf8");
            attached = true;
          }
        }
        await drain();
      }
      if (signal.aborted) break;
      await new Promise<void>((resolve) => {
        // Removed on the TIMER path too. `{ once: true }` only unregisters when
        // the event fires, so every ordinary poll left a listener behind — ten a
        // second at the default interval, for the life of a follower. Both real
        // followers are long-lived: `hx-fortress logs` follows unconditionally,
        // and the console's Logs tab holds an SSE stream open.
        const done = (): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = (): void => done();
        const timer = setTimeout(done, pollMs);
        signal.addEventListener("abort", abort);
      });
    }
    // One last pass so a line written just before the abort is not lost.
    await drain().catch(() => {});
  } finally {
    await handle?.close().catch(() => {});
  }
}
