// hx.ingest_control — the store-write pause, and the clamp that bounds it.
//
// The pause exists so a storage migration can quiesce writes before a swap. It
// also closes the gate for artifact writes, deletes and the self-test probe,
// which means an unbounded pause would park GDPR-class purges indefinitely. The
// role that arms a pause is the cloud-reachable write role, so the bound cannot
// be a value that role can write.
//
// The gate therefore takes the MINIMUM of three terms:
//
//   min(paused_until, row_written_at + CAP, daemon_first_observed + CAP)
//
//   • `paused_until` is what the operator asked for;
//   • `row_written_at` is stamped by a column DEFAULT and EXCLUDED from the
//     write role's column grants, so it is a sound DB-side anchor — but only
//     because each pause episode INSERTs its OWN row: a singleton updated in
//     place would carry an anchor older than the cap, and min() would resolve
//     to "already expired" on every fortress, silently no-opping the barrier a
//     migration swap depends on;
//   • the daemon's first-observed file is defence in depth here and the SOLE
//     anchor on an external Postgres, where no role split exists to grant
//     against.
//
// Extending a drain re-arms a NEW episode row rather than moving a clamped
// deadline, so a long legitimate drain stays reachable; the abuse bound is that
// each extension needs a live daemon, which a Postgres-only adversary has no
// way to produce.

/** How far past its episode anchor a pause may hold the gate closed. */
export const PAUSE_CAP_MS = 15 * 60 * 1000;

export interface IngestControlRow {
  id: string;
  pausedUntil: Date;
  resumedAt: Date | null;
  rowWrittenAt: Date;
  reason: string | null;
}

export interface EffectivePause {
  /** When the gate reopens, or null when it is open now. */
  pausedUntil: Date | null;
  /** The row asked for longer than the cap allows — audited, not silently cut. */
  capped: boolean;
}

const OPEN: EffectivePause = { pausedUntil: null, capped: false };

export function effectivePause(args: {
  row: IngestControlRow | null;
  firstObservedAt: Date | null;
  now: Date;
}): EffectivePause {
  const { row, now } = args;
  if (!row || row.resumedAt !== null) return OPEN;
  const anchor = args.firstObservedAt ?? now;
  const terms = [
    row.pausedUntil.getTime(),
    row.rowWrittenAt.getTime() + PAUSE_CAP_MS,
    anchor.getTime() + PAUSE_CAP_MS,
  ];
  const effective = Math.min(...terms);
  const capped = effective < row.pausedUntil.getTime();
  if (effective <= now.getTime()) return { pausedUntil: null, capped };
  return { pausedUntil: new Date(effective), capped };
}

/**
 * The daemon's cached view of the pause, refreshed on every status heartbeat.
 *
 * Postgres going away must never REOPEN the gate: a failed refresh keeps the
 * last known deadline, so a migration that armed a pause and then lost its
 * database still has writes held off until that deadline actually passes.
 */
export class PauseState {
  private effective: EffectivePause = OPEN;
  private lastRefreshFailed = false;

  /** Apply a successful read of the current episode row. */
  observe(pause: EffectivePause): void {
    this.effective = pause;
    this.lastRefreshFailed = false;
  }

  /** Apply a FAILED read — the previous deadline stands, unchanged. */
  observeUnavailable(): void {
    this.lastRefreshFailed = true;
  }

  get stale(): boolean {
    return this.lastRefreshFailed;
  }

  get capped(): boolean {
    return this.effective.capped;
  }

  /** The deadline in force, or null when writes are open. */
  pausedUntil(now: Date = new Date()): Date | null {
    const until = this.effective.pausedUntil;
    if (!until) return null;
    if (until.getTime() <= now.getTime()) return null;
    return until;
  }

  isPaused(now: Date = new Date()): boolean {
    return this.pausedUntil(now) !== null;
  }
}
