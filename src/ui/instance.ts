// One console per fortress root.
//
// The rule is ROOT-scoped, not port-scoped: two consoles on the same <root> would
// both own users.json, both hold session tables the other cannot revoke, and both
// answer `ui disable` — a second instance on a different port is exactly as wrong
// as one on the same port. A port collision is a SEPARATE, secondary refusal with
// its own diagnosis, because the thing on that port may not be a console at all.
//
// The lockfile records {pid, bootId, startTicks|startTime, port}. Every field
// earns its place:
//
//   • pid alone is not identity — the kernel recycles pids, and a stale lock
//     naming a recycled pid would make a dead console look alive forever;
//   • bootId (the machine's, not this process's) invalidates every lock written
//     before a reboot, when no pid from the old boot can still be running;
//   • startTicks (or a start timestamp off /proc-less platforms) is what
//     distinguishes a recycled pid WITHIN one boot — the exact case bootId
//     cannot see, and the reason the field exists.
//
// The pid is also the signal source for `ui disable`, which is why it is written
// at acquisition rather than derived later from a process listing.
//
// UNLIKE hx's instance.ts there is no reuse handshake and no token reissue. The
// occupant probe returns a bare identity and nothing else; a console that handed
// a token to whoever asked would be a console with no sign-in at all.

import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface InstanceLockRecord {
  pid: number;
  /** The MACHINE boot id. See the header for why this is not per-process. */
  bootId: string;
  /** Linux: process start time in clock ticks since boot. */
  startTicks?: number;
  /** Elsewhere: the platform's own start timestamp, compared as a string. */
  startTime?: string;
  port: number;
  /** True when something is watching this console and will act on the stored
   *  enablement setting — a unit's ExecStart, or the container supervisor.
   *  `ui disable` needs it: a console nobody supervises does not stop because a
   *  file changed, and promising that it will is worse than saying nothing. */
  supervised?: boolean;
}

export const MOVE_REMEDIATION =
  "stop that process, or move the console with `hx-fortress ui config set port <n>`";

let cachedBootId: string | null = null;

/** The machine's boot id where the platform publishes one. Falls back to a value
 *  derived from the boot instant, which changes across a reboot for the same
 *  reason — and to a per-process id only where neither exists, where the
 *  start-time field is doing all the work anyway. */
export function machineBootId(): string {
  if (cachedBootId) return cachedBootId;
  try {
    cachedBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    // Quantized to the minute, and DERIVED is marked as such.
    //
    // `os.uptime()` returns whole seconds while `Date.now()/1000` carries the
    // fraction, so rounding produced two different ids within one run — and
    // `proveIdentity` treats a bootId mismatch as conclusive death BEFORE it
    // consults startTime, so the lock holder was declared dead about half the
    // time on darwin, which ships a launchd manager. Two consoles then owned one
    // root: two writers of users.json, two session tables neither could revoke.
    //
    // A minute is far coarser than the drift and far finer than a reboot. The
    // `~` marks it derived so `proveIdentity` can decline to treat a mismatch as
    // proof of death.
    cachedBootId = `boot~${Math.floor((Date.now() / 1000 - os.uptime()) / 60)}`;
  }
  return cachedBootId;
}

/** Linux: field 22 of /proc/<pid>/stat, read after the last ')' because the comm
 *  field may itself contain spaces and parentheses. */
function linuxStartTicks(pid: number): number | null {
  try {
    const stats = readFileSync(`/proc/${pid}/stat`, "utf8");
    const tail = stats.slice(stats.lastIndexOf(")") + 2).split(" ");
    // stat fields are 1-based and the slice drops the first two, so field 22 is
    // index 19 here.
    const ticks = Number(tail[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

function psStartTime(pid: number): string | null {
  try {
    const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
    const line = result.stdout.toString().trim();
    return line || null;
  } catch {
    return null;
  }
}

export function processStartToken(pid: number): Pick<InstanceLockRecord, "startTicks" | "startTime"> {
  const ticks = linuxStartTicks(pid);
  if (ticks !== null) return { startTicks: ticks };
  const started = psStartTime(pid);
  return started ? { startTime: started } : {};
}

/** Three answers, because two collapse the case that matters. */
export type IdentityVerdict = "same" | "gone" | "unproven";

/**
 * Is the process named by this record still the one that wrote it?
 *
 * A record from a previous boot is dead by definition. Within one boot, a pid
 * that exists but started at a different time is a DIFFERENT process wearing a
 * recycled number.
 *
 * UNPROVEN is the third answer, and it is not a synonym for either. It means the
 * pid exists and nothing available on this platform — no /proc, no `ps` — can
 * say whose it is. Collapsing it into "same" is a claim the machine did not
 * make, and every caller weighs it differently: refusing to start a console is
 * recoverable where two consoles are not, while signalling the wrong pid in a
 * container is how a console shutdown kills the daemon.
 */
export function proveIdentity(record: InstanceLockRecord): IdentityVerdict {
  if (record.bootId !== machineBootId()) {
    // A DERIVED boot id is not proof of a reboot. Where the kernel publishes one
    // a mismatch really does mean the machine restarted and every pid is stale.
    // Where we computed it from uptime it can differ between two live processes,
    // and treating that as conclusive death is what let a second console unlink
    // a live holder's lock. Fall through to the pid and start-time checks, which
    // is what the comment above already claims this does.
    if (!record.bootId.startsWith("boot~") && !machineBootId().startsWith("boot~")) return "gone";
  }
  try {
    process.kill(record.pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return "gone";
  }
  const current = processStartToken(record.pid);
  if (record.startTicks !== undefined && current.startTicks !== undefined) {
    return record.startTicks === current.startTicks ? "same" : "gone";
  }
  if (record.startTime !== undefined && current.startTime !== undefined) {
    return record.startTime === current.startTime ? "same" : "gone";
  }
  return "unproven";
}

/** True when the record's process may still be holding this lock. UNPROVEN reads
 *  as alive here on purpose: a console that refuses to start says so and is
 *  fixed in a second, and two consoles on one root cannot be. */
export function holderAlive(record: InstanceLockRecord): boolean {
  return proveIdentity(record) !== "gone";
}

export function parseInstanceLock(raw: unknown): InstanceLockRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.pid !== "number" || typeof value.bootId !== "string") return null;
  if (typeof value.port !== "number") return null;
  return {
    pid: value.pid,
    bootId: value.bootId,
    port: value.port,
    ...(typeof value.startTicks === "number" ? { startTicks: value.startTicks } : {}),
    ...(typeof value.startTime === "string" ? { startTime: value.startTime } : {}),
    ...(value.supervised === true ? { supervised: true } : {}),
  };
}

export async function readInstanceLock(file: string): Promise<InstanceLockRecord | null> {
  try {
    return parseInstanceLock(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return null;
  }
}

export type InstanceAcquire =
  | { ok: true; record: InstanceLockRecord; release: () => Promise<void> }
  | { ok: false; holder: InstanceLockRecord | null; message: string };

/** O_EXCL, then a liveness check on what is already there. A lock left by a
 *  killed console is reclaimed; one held by a live console is refused. */
export async function acquireInstanceLock(
  file: string,
  port: number,
  options: { supervised?: boolean } = {},
): Promise<InstanceAcquire> {
  const record: InstanceLockRecord = {
    pid: process.pid,
    bootId: machineBootId(),
    ...processStartToken(process.pid),
    port,
    ...(options.supervised ? { supervised: true } : {}),
  };
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`);
      } finally {
        await handle.close();
      }
      return { ok: true, record, release: async () => void (await unlink(file).catch(() => {})) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = await readInstanceLock(file);
      if (holder && holderAlive(holder)) {
        return {
          ok: false,
          holder,
          message:
            `another hx-fortress console is already running on this fortress root ` +
            `(pid ${holder.pid}, port ${holder.port}). One root, one console: a second would own the same ` +
            `user store and hold sessions the first cannot revoke. Stop it with \`kill ${holder.pid}\`, ` +
            `or \`hx-fortress ui disable\`.`,
        };
      }
      await unlink(file).catch(() => {});
    }
  }
  return {
    ok: false,
    holder: null,
    message: `could not take the console instance lock at ${file}`,
  };
}

export type Occupant = "console" | "unknown" | "none";

/** Just enough of fetch to ask one question — the full signature drags in
 *  runtime-only members no caller here uses. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Ask whatever holds the port to identify itself. Loopback only, no session, no
 *  token — the answer is the literal identity object and nothing more. */
export async function probeOccupant(
  origin: string,
  fetchImpl: FetchLike = fetch,
): Promise<Occupant> {
  try {
    const response = await fetchImpl(`${origin}/ui/api/instance`, {
      method: "GET",
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return "unknown";
    const body = (await response.json()) as { app?: unknown };
    return body.app === "hx-fortress-ui" ? "console" : "unknown";
  } catch {
    return "none";
  }
}

/** The secondary refusal. Distinct from the same-root one, and distinct again by
 *  who answered: an unknown responder means the printed URL is somebody else's. */
export function portCollisionMessage(port: number, occupant: Occupant): string {
  if (occupant === "console") {
    return (
      `port ${port} is already serving an hx-fortress console for a different fortress root. ` +
      `${MOVE_REMEDIATION}.`
    );
  }
  return (
    `another process is listening on ${port} — do not use the printed URL. ${MOVE_REMEDIATION}.`
  );
}

/**
 * Same root by FILE IDENTITY, not by string. Symlinks, bind mounts and a trailing
 * slash all make two spellings of one directory, and a string comparison would
 * report a divergence the operator cannot see or fix.
 */
export async function sameRoot(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    stat(a).catch(() => null),
    stat(b).catch(() => null),
  ]);
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
}
