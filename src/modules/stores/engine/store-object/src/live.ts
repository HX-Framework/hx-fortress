// Live rows (Stores, Part A, slice C; design section 8): a run's page watches the table the run is
// writing, its newest rows coming over a WebSocket from this object. They are never copied into
// another database.
//
// A socket is one run's. The caller in front (the deployer's gateway) checked a token that may read
// this store, and forwards the upgrade with the caller, the run and when the token ends
// (LIVE_HEADER). The object takes the socket with the hibernation API (`acceptWebSocket`, tagged
// `run:<runId>`), so an idle socket costs nothing, and sends the run's frame at once: the run's
// jobs (a job names its run in `params.madeBy.runId`), their progress, and the newest rows of the
// table the job the store is on is writing (`<name>__new`), else of the newest table the run made.
// A job's submit and each commit of its chunks send the frame again, at most every LIVE_EVERY_MS
// per run, and what that holds back goes at the end of the wait; a chunk's end sends it at once, so
// a job's last state never waits. A socket whose token has ended is closed with LIVE_TOKEN_ENDED
// when it would be sent to, and the page asks for a new token. A frame is a courtesy to a watcher:
// nothing that goes wrong building or sending one reaches the job it reports on.

import { EXTRA_COLUMN, FILE_COLUMN, HASH_COLUMN } from "../../store-readers/src/index.js";
import type { StoreCore } from "./core.js";
import { begun, quote } from "./program-tables.js";
import type { Job, JobProgress, StoreCaller } from "./types.js";
import type { StoreSqlValue } from "./sql.js";

/** The header the caller in front forwards a socket's request with: `LiveCaller` as JSON. */
export const LIVE_HEADER = "x-store-live";
/** The close code of a socket whose token ended: the page asks for a new token and opens again. */
export const LIVE_TOKEN_ENDED = 4401;
/** The close code of a socket whose store was deleted. */
const LIVE_STORE_GONE = 1001;
/** The least time between two frames of one run. */
export const LIVE_EVERY_MS = 500;
/** The rows a frame carries: the newest. The section shows about eleven and scrolls the rest. */
export const LIVE_ROWS = 20;
/** A cell's text is cut to this many characters in a frame: more than the section's cell can show. */
const CELL_MAX = 120;
/** LOAD's columns a glance cannot read, left out of a frame: the file's id, a row's hash, and its extra values as JSON. `_row` stays. */
const UNREAD_COLUMNS = new Set([FILE_COLUMN, HASH_COLUMN, EXTRA_COLUMN]);
/** The names SQLite answers with a table's rowid, unless a column of the table has taken that name. */
const ROWID_NAMES = ["rowid", "_rowid_", "oid"];
/** A run's id as a live socket names it. */
export const LIVE_RUN_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** Who opens a socket, on which run, until when (epoch ms). */
export interface LiveCaller extends StoreCaller {
  runId: string;
  until: number;
}

export interface LiveJob {
  id: string;
  kind: string;
  state: Job["state"];
  progress: JobProgress | null;
  error: string | null;
  updatedAt: string;
}

export interface LiveTable {
  name: string;
  /** A job of the run is writing it now; else it is the newest table the run made. */
  writing: boolean;
  columns: string[];
  /** The newest rows, newest first, each cell cut to a readable length. */
  rows: (string | number | null)[][];
  /** Its rows so far. */
  count: number;
}

/** What a run's socket is sent: the whole picture each time, so a frame missed costs nothing. */
export interface LiveFrame {
  runId: string;
  at: string;
  /** Oldest first. */
  jobs: LiveJob[];
  /** The job of `jobs` the store is on for this run (the one running, else the oldest waiting), if any is open. */
  current: string | null;
  table: LiveTable | null;
}

/** The parts of a socket the object uses: workerd's WebSocket, or a test's stand-in. */
export interface LiveSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** The caller a forwarded socket request names, or null when it names none this object takes. */
export function liveCallerOf(header: string | null): LiveCaller | null {
  if (!header) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(header);
  } catch {
    return null;
  }
  const c = raw as Partial<LiveCaller> | null;
  if (!c || typeof c.storeId !== "string" || typeof c.actor !== "string" || !c.actor) return null;
  if (typeof c.runId !== "string" || !LIVE_RUN_ID_RE.test(c.runId) || typeof c.until !== "number" || !Number.isFinite(c.until)) return null;
  return { storeId: c.storeId, actor: c.actor, runId: c.runId, until: c.until };
}

const tagOf = (runId: string) => `run:${runId}`;

function cell(value: unknown): string | number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return value.length > CELL_MAX ? `${value.slice(0, CELL_MAX - 1)}…` : value;
  return null;
}

/**
 * A table's newest rows and how many it holds. Its rowid only grows as a job appends, so the top
 * rowid is its count while it is written (a table changed in place has gaps: `known` is its count
 * then, from the catalog). Long text is cut in SQL, so a frame never carries a whole memo field into the
 * object's memory, and a file's own `ROWID` column is left alone: the rowid is read under a name no
 * column of the table has taken.
 */
function readTable(core: StoreCore, name: string, stored: string, writing: boolean, known: number | null = null): LiveTable | null {
  const names = core.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?)", stored).toArray().map((c) => String(c.name));
  if (names.length === 0) return null;
  const taken = new Set(names.map((n) => n.toLowerCase()));
  const rowid = ROWID_NAMES.find((n) => !taken.has(n));
  if (!rowid) return null;
  const columns = names.filter((n) => !UNREAD_COLUMNS.has(n));
  const shown = columns.map((c) => `CASE typeof(${quote(c)}) WHEN 'text' THEN substr(${quote(c)}, 1, ${CELL_MAX + 1}) WHEN 'blob' THEN NULL ELSE ${quote(c)} END`);
  const raw = [...core.sql.exec(`SELECT ${[rowid, ...shown].join(", ")} FROM ${quote(stored)} ORDER BY ${rowid} DESC LIMIT ${LIVE_ROWS}`).raw()];
  return { name, writing, columns, rows: raw.map((row) => row.slice(1).map(cell)), count: known ?? Number(raw[0]?.[0] ?? 0) };
}

/** The run's frame as the store holds it now. */
export function runFrame(core: StoreCore, runId: string): LiveFrame {
  const rows = core.sql
    .exec<Record<string, StoreSqlValue>>(
      "SELECT id, kind, state, progress, error, updated_at FROM _jobs WHERE json_extract(params, '$.madeBy.runId') = ? ORDER BY created_at, id",
      runId,
    )
    .toArray();
  const jobs: LiveJob[] = rows.map((r) => ({
    id: String(r.id),
    kind: String(r.kind),
    state: String(r.state) as Job["state"],
    progress: r.progress === null ? null : (JSON.parse(String(r.progress)) as JobProgress | null),
    error: r.error === null ? null : String(r.error),
    updatedAt: String(r.updated_at),
  }));
  // The runner's own order: the job running, else the oldest waiting.
  const current = jobs.find((j) => j.state === "running") ?? jobs.find((j) => j.state === "queued") ?? null;
  const writing = current ? begun(core, current.id).at(-1) : undefined;
  let table = writing ? readTable(core, writing, `${writing}__new`, true) : null;
  if (!table) {
    // Only what the database holds as a table: a view has no rowid to read it by, and keeps no rows
    // of its own, and a parked table's rows are in the store's files.
    const made = core.sql
      .exec<{ name: string; rows: number | null }>(
        "SELECT t.name AS name, t.rows AS rows FROM _tables AS t JOIN sqlite_master AS m ON m.name = t.name AND m.type = 'table' WHERE t.made_run = ? ORDER BY t.made_at DESC, t.name LIMIT 1",
        runId,
      )
      .toArray()[0];
    if (made) table = readTable(core, String(made.name), String(made.name), false, made.rows === null ? null : Number(made.rows));
  }
  return { runId, at: core.nowIso(), jobs, current: current?.id ?? null, table };
}

/** When a run was last sent a frame, and the send waiting for the end of its LIVE_EVERY_MS. */
interface LiveSend {
  at: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * A store's live sockets: takes them, and sends each run's frame to its own. One per object; a
 * platform with no hibernation API (a test's stand-in) takes no socket and sends nothing.
 */
export class LiveRuns {
  private readonly core: StoreCore;
  private readonly sends = new Map<string, LiveSend>();

  constructor(core: StoreCore) {
    this.core = core;
  }

  /** Takes a run's socket and sends it the run's frame, built first: a frame that cannot be built leaves no socket behind. */
  accept(caller: LiveCaller, socket: LiveSocket): void {
    const accept = this.core.state.acceptWebSocket?.bind(this.core.state);
    if (!accept || !this.core.state.getWebSockets) throw new Error("This store takes no live sockets here.");
    const frame = JSON.stringify(runFrame(this.core, caller.runId));
    accept(socket, [tagOf(caller.runId)]);
    socket.serializeAttachment({ until: caller.until });
    socket.send(frame);
  }

  /**
   * A job of the run moved (submitted, or a commit): its sockets get the frame now, or at the end
   * of the LIVE_EVERY_MS since the last one, when one frame carries whatever came between. Never
   * throws: this runs inside the job's own work.
   */
  changed(runId: string): void {
    this.guarded(runId, () => {
      const now = this.core.deps.now();
      // A run past its wait throttles nothing, so only those within one stay here.
      for (const [id, entry] of this.sends) if (!entry.timer && now - entry.at >= LIVE_EVERY_MS) this.sends.delete(id);
      if (this.socketsOf(runId).length === 0) return;
      const entry = this.sends.get(runId);
      if (!entry || now - entry.at >= LIVE_EVERY_MS) {
        this.send(runId);
        return;
      }
      entry.timer ??= setTimeout(() => this.guarded(runId, () => this.send(runId)), entry.at + LIVE_EVERY_MS - now);
    });
  }

  /** A chunk of the run's job ended: its sockets get the frame at once. Never throws. */
  chunkEnded(runId: string): void {
    this.guarded(runId, () => this.send(runId));
  }

  /** The store is being deleted: every socket closes, and the page finds out why when it asks for a token. */
  closeAll(): void {
    for (const entry of this.sends.values()) if (entry.timer) clearTimeout(entry.timer);
    this.sends.clear();
    for (const socket of (this.core.state.getWebSockets?.() ?? []) as LiveSocket[]) {
      try {
        socket.close(LIVE_STORE_GONE, "The store was deleted.");
      } catch {
        // Already closing.
      }
    }
  }

  private socketsOf(runId: string): LiveSocket[] {
    return (this.core.state.getWebSockets?.(tagOf(runId)) ?? []) as LiveSocket[];
  }

  private send(runId: string): void {
    const now = this.core.deps.now();
    const waiting = this.sends.get(runId)?.timer;
    if (waiting) clearTimeout(waiting);
    this.sends.set(runId, { at: now, timer: null });
    const sockets = this.socketsOf(runId);
    if (sockets.length === 0) return;
    const message = JSON.stringify(runFrame(this.core, runId));
    for (const socket of sockets) {
      const until = (socket.deserializeAttachment() as { until?: number } | null)?.until ?? 0;
      try {
        if (until <= now) socket.close(LIVE_TOKEN_ENDED, "The store token ended.");
        else socket.send(message);
      } catch {
        // A socket closing as it is sent to: the platform drops it.
      }
    }
  }

  private guarded(runId: string, work: () => void): void {
    try {
      work();
    } catch (error) {
      this.core.deps.log?.({ level: "warn", event: "store_live_frame_failed", runId, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
