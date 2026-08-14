// The drain: spool files into hx.admin_audit, and the two loud things that fall
// out of doing it.
//
// It runs as hx_ui, the only role that may INSERT here, and it is idempotent on
// (spool_file_id, seq) - so a file is read again at every boot until the
// retention floor lets it go, and a crash halfway through one costs nothing.
//
// PAYLOAD COMPARE. Idempotency alone would hide a rewritten record: ON CONFLICT
// DO NOTHING silently keeps whichever version arrived first. So a record whose
// key is already in the table is COMPARED against it, and a difference is raised
// as an audited integrity error rather than dropped. Two things produce one - a
// tampered spool file, and a writer that re-appended under a key it had already
// used - and both are bugs the operator has to see.
//
// DISPUTED IS RAISED HERE, and only here. The corroboration verdict is computed
// with the SAME exported ANY-MATCH predicate the read API renders from
// (corroborationOf), never a record-at-a-time comparison: a per-record
// evaluation cannot see the other records for a command id, so it would raise
// the loud alarm on exactly the crash-recovery re-drive that must read as
// confirmed - work done, crash before complete, boot re-drive completes with a
// second result. It cannot be raised from a request handler either: the read
// class is defined as having no state-changing effects and its effect test
// asserts it, so a handler that recorded an integrity error would fail its own
// class. The read path RENDERS the state; this path records it, once per
// command id.

import { createHash } from "node:crypto";

import { AUDIT_ACTIONS } from "../console/audit-actions";
import {
  listSpoolFiles,
  readSpoolFile,
  SPOOL_RETENTION_MS,
  type AuditRecord,
} from "../console/audit-spool";
import {
  commandsQuery,
  disputedCommandIdsQuery,
  drainInsertQuery,
  drainedFileQuery,
  drainedOutcomesQuery,
  type CommandRowView,
  type DrainableRecord,
} from "../query/console/audit";
import type { ConsoleAudit } from "./audit-writer";
import {
  corroborationOf,
  isTerminalStatus,
  parseCommandOutcomes,
  type CommandOutcomeRecord,
} from "./corroboration";
import { rm } from "node:fs/promises";

/** Just enough of a database handle to drain. Narrow on purpose: the drain is
 *  the console's only writer, and a wider type here would invite a second. */
export interface DrainDb {
  execute(query: unknown): Promise<unknown>;
}

/** How often the timer fires. Boot and first-recovery drains are separate
 *  triggers; this one is the steady state. */
export const DRAIN_INTERVAL_MS = 30_000;

/** Records per INSERT. Bounded so one enormous spool file cannot build a
 *  statement the server refuses. */
const INSERT_CHUNK = 200;

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const wrapped = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}

/** `params` as a VALUE, whichever side it came from.
 *
 *  The spool holds it parsed; Postgres hands `jsonb` back as raw JSON TEXT under
 *  this driver. Fingerprinting those two directly made every drained record
 *  disagree with its own spooled twin — one `console.audit.integrity_error` per
 *  record per drain, forever, each one accusing the operator's disk of having
 *  been altered. Measured on a fortress holding 35 sessions: 83,397 audit rows
 *  of which 83,388 were that false alarm, 45 MB of the database, still climbing.
 *
 *  Unparseable text is returned AS IS so it still compares by value rather than
 *  throwing inside a comparison. */
function paramsValue(params: unknown): unknown {
  if (typeof params !== "string") return params;
  try {
    return JSON.parse(params);
  } catch {
    return params;
  }
}

/** The comparable form of a record, from either side. Timestamps are normalized
 *  because the driver hands back a Date where the file holds a string, params
 *  are PARSED because it hands jsonb back as text, and then key-sorted because
 *  jsonb does not preserve object order - none of those is a difference in what
 *  was recorded. */
export function payloadFingerprint(record: {
  ts: string | Date;
  origin: string;
  actor: string | null;
  sessionRef: string | null;
  tier: string | null;
  action: string;
  params: unknown;
  kind: string;
  refFileId: string | null;
  refSeq: number | string | null;
  outcome: string | null;
  error: string | null;
}): string {
  const canonical = JSON.stringify([
    new Date(record.ts).toISOString(),
    record.origin,
    record.actor,
    record.sessionRef,
    record.tier,
    record.action,
    sortedJson(paramsValue(record.params)),
    record.kind,
    record.refFileId,
    record.refSeq === null ? null : Number(record.refSeq),
    record.outcome,
    record.error,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortedJson((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function drainable(record: AuditRecord): DrainableRecord {
  return {
    fileId: record.fileId,
    seq: record.seq,
    ts: record.ts,
    origin: record.origin,
    actor: record.actor,
    sessionRef: record.sessionRef,
    tier: record.tier,
    action: record.action,
    params: record.params,
    kind: record.kind,
    refFileId: record.refFileId ?? null,
    refSeq: record.refSeq,
    outcome: record.outcome,
    error: record.error,
  };
}

export interface DrainResult {
  /** False when there was no database to drain into. Not a failure: the spool
   *  exists precisely so a console without Postgres keeps recording. */
  drained: boolean;
  files: number;
  inserted: number;
  mismatches: number;
  disputed: number;
  reclaimed: number;
}

const EMPTY: DrainResult = {
  drained: false,
  files: 0,
  inserted: 0,
  mismatches: 0,
  disputed: 0,
  reclaimed: 0,
};

export interface AuditDrainOptions {
  dir: string;
  db: () => DrainDb | null;
  /** The console's own writer - the integrity error and the disputed record are
   *  themselves audited acts, and they ride the same spool as everything else. */
  audit: ConsoleAudit;
  /** The file this console is appending to right now, which is never reclaimed
   *  however old it looks. */
  currentFileId?: () => string;
  now?: () => Date;
  retentionMs?: number;
  onWarn?: (message: string, fields: Record<string, unknown>) => void;
}

export class AuditDrain {
  private readonly options: AuditDrainOptions;
  /** Mismatches already raised, so a file that stays on disk until the retention
   *  floor does not raise its integrity error at every 30-second tick. */
  private readonly raised = new Set<string>();
  /** Command ids already disputed in THIS process; the table is consulted too,
   *  so a restart does not re-raise. */
  private readonly disputed = new Set<string>();
  private running: Promise<DrainResult> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;


  constructor(options: AuditDrainOptions) {
    this.options = options;
  }

  private now(): Date {
    return (this.options.now ?? ((): Date => new Date()))();
  }

  /** One pass, single-flight. A boot drain and the first timer tick overlapping
   *  would each read the same files and race on the same conflict. */
  run(): Promise<DrainResult> {
    this.running ??= this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(): Promise<DrainResult> {
    // Windows close on the same tick that drains them, so a window's record is
    // in the table one drain after it closed rather than two.
    await this.options.audit.flushFailures().catch(() => []);
    const db = this.options.db();
    if (!db) return { ...EMPTY };
    const result: DrainResult = { ...EMPTY, drained: true };
    const files = await listSpoolFiles(this.options.dir);
    const seen: AuditRecord[] = [];
    const retention = this.options.retentionMs ?? SPOOL_RETENTION_MS;
    const current = this.options.currentFileId?.();
    for (const file of files) {
      const records = await readSpoolFile(file.path);
      seen.push(...records);
      if (records.length === 0) continue;
      result.files += 1;
      const byFile = new Map<string, AuditRecord[]>();
      for (const record of records) {
        const bucket = byFile.get(record.fileId) ?? [];
        bucket.push(record);
        byFile.set(record.fileId, bucket);
      }
      let complete = true;
      for (const [fileId, group] of byFile) {
        try {
          const already = new Map<number, string>();
          for (const row of rows<Record<string, unknown>>(await db.execute(drainedFileQuery(fileId)))) {
            already.set(Number(row.seq), payloadFingerprint(row as never));
          }
          const missing: DrainableRecord[] = [];
          for (const record of group) {
            const drainedDigest = already.get(record.seq);
            if (drainedDigest === undefined) {
              missing.push(drainable(record));
              continue;
            }
            if (drainedDigest === payloadFingerprint(record)) continue;
            result.mismatches += 1;
            await this.raiseMismatch(fileId, record.seq);
          }
          for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
            await db.execute(drainInsertQuery(missing.slice(i, i + INSERT_CHUNK)));
          }
          result.inserted += missing.length;
        } catch (error) {
          complete = false;
          this.options.onWarn?.("the audit spool could not be drained", {
            file: file.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // Deleted only once every record is in the table, only past the retention
      // floor, and never the file this console is appending to. The floor is
      // also what keeps the console from removing a file another process (a CLI
      // invocation that started a second ago) is still writing.
      const age = this.now().getTime() - file.modifiedAt.getTime();
      if (complete && age >= retention && file.fileId !== current) {
        await rm(file.path, { force: true }).catch(() => {});
        result.reclaimed += 1;
      }
    }
    result.disputed = await this.corroborate(db, seen);
    return result;
  }

  private async raiseMismatch(fileId: string, seq: number): Promise<void> {
    const key = [fileId, seq].join(":");
    if (this.raised.has(key)) return;
    this.raised.add(key);
    await this.options.audit.raise(AUDIT_ACTIONS.integrityError, {
      params: { spoolFileId: fileId, seq },
      error:
        "a spooled record disagrees with the one already drained under its key. The trail keeps " +
        "the drained version; the file on disk has been altered, or a writer re-used a key it had " +
        "already written.",
    });
  }

  /**
   * Raise DISPUTED for every terminal command no daemon record agrees with.
   *
   * The predicate is t06's exported one, unchanged and unrepeated. Its ANY-MATCH
   * rule is what keeps an ordinary crash-recovery re-drive - two records for one
   * command, one of them stale - out of this branch.
   */
  private async corroborate(db: DrainDb, spooled: readonly AuditRecord[]): Promise<number> {
    let raised = 0;
    try {
      const commands = rows<CommandRowView>(await db.execute(commandsQuery()));
      const terminal = commands.filter((row) => isTerminalStatus(row.status));
      if (terminal.length === 0) return 0;
      const ids = terminal.map((row) => row.id);
      const tail = parseCommandOutcomes(
        spooled.map((r) => ({ action: r.action, kind: r.kind, sessionRef: r.sessionRef, params: r.params })),
      );
      const drained = parseCommandOutcomes(
        rows<{ sessionRef: string | null; action: string; kind: string; params: unknown }>(
          await db.execute(drainedOutcomesQuery(ids)),
        ),
      );
      const records: CommandOutcomeRecord[] = [...tail, ...drained];
      const alreadyRaised = new Set(
        rows<{ sessionRef: string | null }>(await db.execute(disputedCommandIdsQuery(ids)))
          .map((row) => row.sessionRef)
          .filter((id): id is string => typeof id === "string"),
      );
      for (const row of terminal) {
        if (!isTerminalStatus(row.status)) continue;
        if (this.disputed.has(row.id) || alreadyRaised.has(row.id)) continue;
        const verdict = corroborationOf({
          commandId: row.id,
          status: row.status,
          outcome: row.outcome,
          error: row.error,
          completedAt: row.completedAt,
          records,
          now: this.now(),
        });
        if (verdict.state !== "disputed") continue;
        this.disputed.add(row.id);
        await this.options.audit.raise(AUDIT_ACTIONS.commandDisputed, {
          sessionRef: row.id,
          params: {
            commandKind: row.kind,
            arm: verdict.arm ?? "fabricated",
            expectedDigest: verdict.expectedDigest,
            records: verdict.records,
          },
          error:
            "the recorded outcome of this command was not produced by this fortress daemon. " +
            "The database role that reports outcomes can report one it did not produce; this row " +
            "and the daemon's own record disagree.",
        });
        raised += 1;
      }
    } catch (error) {
      this.options.onWarn?.("command corroboration could not be evaluated", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return raised;
  }

  /**
   * Boot, first recovery and every 30 seconds after.
   *
   * NO SIGNAL HANDLER. This component has no authority to end the process and
   * nothing else in the console verb would: a listener registered here
   * SUPPRESSES the default termination under Bun, so the console flushed its
   * spool on SIGTERM and then went on serving the whole admin surface — through
   * the runtime's entire grace period and out the other side into SIGKILL, with
   * the operator already told it had stopped. The verb that owns the server, the
   * lock and this timer owns the signal, and calls stop() as part of the exit it
   * performs.
   */
  start(intervalMs = DRAIN_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.run(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
