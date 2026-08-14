// The daemon side of hx.console_commands: poll, fence, claim, execute, report.
//
// The daemon's write role holds NO INSERT and NO UPDATE on the table — every
// transition goes through the SECURITY DEFINER routines, which enforce
// requested → running → terminal and refuse any exit from a terminal state.
// That is what stops a Postgres-level adversary MINTING a self-update or a
// credential rotation; what it cannot stop (the daemon's own authority IS that
// role) is a fabricated OUTCOME, which is why every transition the daemon
// actually performs is also written to the 0600 audit spool and drained as the
// console role — a record a Postgres-only adversary cannot produce.

import { validateCommandParams, type CommandParams } from "./command-params";
import { addInFlight, readInFlight, removeInFlight } from "./runtime-files";
import { STATUS_STALE_MS } from "../daemon-state";
import type { ConsoleCommandKind } from "../host/postgres/console-plane";
import type { ScopedLogger } from "../host/types";

/** How long a requested row may sit before the daemon rejects it instead of
 *  running it. An update or rotation that has been queued for hours is no
 *  longer the operator's current intent. */
export const COMMAND_REQUEST_TTL_MS = 30 * 60 * 1000;

/** Named rejection reasons. The console renders each one as its own copy, so
 *  they are a contract, not log text. */
export const REJECT_BOOT_FENCE = "rejected_boot_fence";
export const REJECT_DEADLINE = "rejected_deadline";
export const REJECT_INVALID_PARAMS = "rejected_invalid_params";
/** A single-use credential was already consumed when the daemon died, so the
 *  command can never be completed and must not be re-driven into a half-applied
 *  rotation. */
export const FAIL_CREDENTIAL_CONSUMED = "credential consumed — re-issue";

export interface CommandRow {
  id: string;
  kind: string;
  params: unknown;
  status: string;
  requestedAt: Date;
  deadlineAt: Date | null;
  credentialRef: string | null;
}

/** The three transition routines plus the queue read, as the daemon sees them.
 *  Every mutating member maps 1:1 onto a SECURITY DEFINER routine. */
export interface CommandGateway {
  /** Non-terminal rows, oldest first. */
  listOpen(): Promise<CommandRow[]>;
  /** hx.claim_command — requested → running, or a re-drive of a running row. */
  claim(id: string, claimedBy: string, redrive: boolean): Promise<boolean>;
  /** hx.complete_command — running → done | failed. */
  complete(id: string, status: "done" | "failed", outcome: string | null, error: string | null): Promise<boolean>;
  /** hx.reject_command — non-terminal → rejected. */
  reject(id: string, reason: string): Promise<boolean>;
}

export interface CommandExecutionContext {
  id: string;
  params: CommandParams;
  credentialRef: string | null;
}

export type CommandExecutor = (ctx: CommandExecutionContext) => Promise<string | null>;

/** One executor per kind. The Record is exhaustive over the allowlist, so a new
 *  kind cannot be added without an executor to run it. */
export type CommandExecutors = Record<ConsoleCommandKind, CommandExecutor>;

export interface BootFenceDeps {
  gateway: CommandGateway;
  /** Path of the 0600 in-flight file. */
  inFlightPath: string;
  /** pid + a boot-unique id. OBSERVABILITY ONLY: it is recorded on the row and
   *  never read back as a security predicate — the row is SELECT-able by the
   *  adversary this fence defends against, who could simply copy it. */
  claimedBy: string;
  logger?: ScopedLogger;
  clock?: () => Date;
  /** Called for every transition the daemon actually performs, so the console
   *  can render an outcome as CORROBORATED rather than merely reported. AWAITED:
   *  the claim record has to reach disk before the work it authorizes starts,
   *  and the outcome record before the poll moves on. */
  onTransition?: (record: TransitionRecord) => void | Promise<void>;
}

/** The fence needs no executors — it only closes rows out. Keeping the two
 *  shapes apart means boot can run the fence before anything is wired to
 *  execute, which is the order the machine requires. */
export interface CommandDriverDeps extends BootFenceDeps {
  executors: CommandExecutors;
}

export interface TransitionRecord {
  id: string;
  kind: string;
  transition: "claimed" | "done" | "failed" | "rejected";
  /** Exactly what the daemon reported to the routine — the payload the console
   *  digests off the row and compares against. */
  outcome?: string | null;
  error?: string | null;
  /** The reason a rejection carried, which the routine writes into `error`. */
  reason?: string;
  /** FALSE when the routine refused the transition because the row was already
   *  terminal. The record is written anyway: somebody else having driven the row
   *  terminal is the tamper evidence, and a daemon that stayed silent about it
   *  would leave the console nothing to dispute with. */
  accepted: boolean;
  at: string;
}

function isTerminal(status: string): boolean {
  return status === "done" || status === "failed" || status === "rejected";
}

/**
 * Boot fence. Runs BEFORE the first poll, and after ensureAppRoles: under the
 * embedded apparatus it is ensureAppRoles that CREATES the very routines the
 * fence calls, and Postgres resolves `hx.reject_command` at parse time, so a
 * fence-first ordering would error even against zero rows.
 *
 * Exactly two outcomes for a non-terminal row:
 *
 *   • running AND present in the daemon's own in-flight file ⇒ re-driven IN
 *     PLACE through claim's re-drive arm (or FAILED, if it carried a single-use
 *     credential that is already gone);
 *   • everything else ⇒ rejected with `rejected_boot_fence`.
 *
 * This closes the downgrade window: an older binary re-grants the write role
 * INSERT on its first boot, so a row planted then must never be executed by the
 * binary that comes back. `claimed_by` is not consulted — any value at all on a
 * planted row still fails the file test.
 */
export async function runBootFence(deps: BootFenceDeps): Promise<{
  redriven: string[];
  rejected: string[];
  failed: string[];
}> {
  const inFlight = await readInFlight(deps.inFlightPath);
  const rows = await deps.gateway.listOpen();
  const redriven: string[] = [];
  const rejected: string[] = [];
  const failed: string[] = [];
  for (const row of rows) {
    if (isTerminal(row.status)) continue;
    if (row.status === "running" && inFlight.has(row.id)) {
      if (row.credentialRef) {
        // The credential file is unlinked as it is read, so a crash after that
        // read leaves nothing to run with. Terminal, audited, never re-driven.
        const accepted = await deps.gateway.complete(row.id, "failed", null, FAIL_CREDENTIAL_CONSUMED);
        if (accepted) failed.push(row.id);
        await record(deps, row, "failed", { accepted, error: FAIL_CREDENTIAL_CONSUMED });
        await removeInFlight(deps.inFlightPath, row.id);
        continue;
      }
      redriven.push(row.id);
      continue;
    }
    const accepted = await deps.gateway.reject(row.id, REJECT_BOOT_FENCE);
    if (accepted) rejected.push(row.id);
    // Written whether or not the routine accepted it. A refusal means the row
    // was already terminal when this daemon reached it, and the console can only
    // tell that from a fabrication if the daemon says what it tried to do.
    await record(deps, row, "rejected", { accepted, reason: REJECT_BOOT_FENCE });
    await removeInFlight(deps.inFlightPath, row.id);
  }
  if (rejected.length > 0 || failed.length > 0 || redriven.length > 0) {
    deps.logger?.info("console command boot fence applied", {
      redriven: redriven.length,
      rejected: rejected.length,
      failed: failed.length,
    });
  }
  return { redriven, rejected, failed };
}

interface TransitionFields {
  accepted: boolean;
  reason?: string;
  outcome?: string | null;
  error?: string | null;
}

async function record(
  deps: BootFenceDeps,
  row: CommandRow,
  transition: TransitionRecord["transition"],
  fields: TransitionFields,
): Promise<void> {
  await deps.onTransition?.({
    id: row.id,
    kind: row.kind,
    transition,
    ...fields,
    at: (deps.clock ?? ((): Date => new Date()))().toISOString(),
  });
}

/**
 * Permission to re-claim a RUNNING row, spent on use.
 *
 * A plain `Set<string>` is one. Modelled as a consumable rather than as a
 * membership test because a re-drive is one-shot: the boot fence says "this row
 * was mine when I died, drive it once", and the claim routine permits
 * running→running only for a named id. Left standing, the same id is re-claimed
 * and re-executed on EVERY poll — a re-driven audit starts a fresh full run once
 * a second, and a re-driven update downloads N binaries concurrently onto one
 * path.
 */
export interface RedriveTickets {
  has(id: string): boolean;
  delete(id: string): unknown;
}

/**
 * One poll pass: drive every eligible row to a terminal state.
 *
 * `redrive` names the rows the boot fence already decided may be re-claimed —
 * the daemon's in-flight file is the only thing that decides that, and the
 * routine merely PERMITS the transition it asserts, once.
 */
export async function pollCommands(
  deps: CommandDriverDeps,
  redrive: RedriveTickets = new Set<string>(),
): Promise<number> {
  const clock = deps.clock ?? ((): Date => new Date());
  const rows = await deps.gateway.listOpen();
  let handled = 0;
  for (const row of rows) {
    if (isTerminal(row.status)) continue;
    const isRedrive = row.status === "running" && redrive.has(row.id);
    if (row.status === "running" && !isRedrive) continue;
    const now = clock();
    // A future requested_at is also refused by claim itself; rejecting here as
    // well means the row does not sit in the queue until that time arrives.
    if (row.requestedAt.getTime() > now.getTime()) {
      const accepted = await deps.gateway.reject(row.id, REJECT_DEADLINE);
      await record(deps, row, "rejected", { accepted, reason: REJECT_DEADLINE });
      if (accepted) handled += 1;
      continue;
    }
    const deadline = row.deadlineAt ?? new Date(row.requestedAt.getTime() + COMMAND_REQUEST_TTL_MS);
    if (deadline.getTime() <= now.getTime()) {
      const accepted = await deps.gateway.reject(row.id, REJECT_DEADLINE);
      await record(deps, row, "rejected", { accepted, reason: REJECT_DEADLINE });
      if (accepted) handled += 1;
      continue;
    }
    const checked = validateCommandParams(row.kind, row.params);
    if (!checked.ok) {
      // The recorded reason is the WHOLE string the routine wrote into the row.
      // A record carrying only the tail would digest differently from the row it
      // describes, and every invalid-params rejection would read as disputed.
      const why = `${REJECT_INVALID_PARAMS}: ${checked.reason}`;
      const accepted = await deps.gateway.reject(row.id, why);
      await record(deps, row, "rejected", { accepted, reason: why });
      if (accepted) handled += 1;
      continue;
    }
    // The file entry is written BEFORE execution: a crash one instruction later
    // must still leave this row recognizable as ours.
    await addInFlight(deps.inFlightPath, row.id);
    if (!(await deps.gateway.claim(row.id, deps.claimedBy, isRedrive))) {
      // Someone else moved it, or its requested_at is still in the future.
      await removeInFlight(deps.inFlightPath, row.id);
      continue;
    }
    // The ticket is spent the instant the claim lands, before the executor is
    // entered: what follows can take minutes, and the permission must not still
    // be sitting there when it returns.
    if (isRedrive) redrive.delete(row.id);
    // The claim record is fsynced BEFORE the executor runs: an intent that never
    // reached disk describes work the console can never corroborate.
    await record(deps, row, "claimed", { accepted: true });
    try {
      const outcome = await deps.executors[checked.kind]({
        id: row.id,
        params: checked.params,
        credentialRef: row.credentialRef,
      });
      const accepted = await deps.gateway.complete(row.id, "done", outcome, null);
      await record(deps, row, "done", { accepted, outcome });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger?.error("console command failed", { id: row.id, kind: row.kind, error: message });
      const accepted = await deps.gateway.complete(row.id, "failed", null, message);
      await record(deps, row, "failed", { accepted, error: message });
    } finally {
      await removeInFlight(deps.inFlightPath, row.id);
    }
    handled += 1;
  }
  return handled;
}

/** How stale a status heartbeat may be before the console refuses to submit a
 *  command. A command nobody is polling for would sit until its deadline and
 *  then be rejected — telling the operator up front is the honest answer.
 *
 *  The SAME fact daemonState() calls stale, aliased rather than restated: these
 *  two decide "is the daemon still there" for coupled surfaces — one refuses the
 *  submission, the other renders the state that explains the refusal — and two
 *  copies of the number is how a console comes to refuse a command while showing
 *  a daemon it calls running. */
export const HEARTBEAT_FRESH_MS = STATUS_STALE_MS;

export function heartbeatFresh(writtenAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!writtenAt) return false;
  const ms = Date.parse(writtenAt);
  return Number.isFinite(ms) && now.getTime() - ms <= HEARTBEAT_FRESH_MS;
}
