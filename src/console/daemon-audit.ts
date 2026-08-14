// What the daemon writes to the spool, and the ONE thing it writes even when the
// console is switched off.
//
// The daemon holds no admin_audit INSERT, so everything here reaches Postgres
// through the console's drain. That is why the general writer is GATED on the
// effective enablement predicate (FORTRESS_UI_ENABLE OR ui.json.enabled): on a
// fortress whose console is off, engine records would accumulate on disk with
// nothing to drain them and nobody to read them. Note which side of the OR
// decides — with the env var true and the file false the console IS up, so the
// daemon spools.
//
// COMMAND TRANSITIONS ARE EXEMPT FROM THAT GATE, and the exemption is the whole
// point of the mechanism. A command is minted by the console, so a
// console_commands row existing already implies a console. If the daemon
// executed it after `ui disable`, after a ui-unit crash, or across a window the
// console was down for, a gated writer would produce NO record — and the console
// would render a rotation that genuinely succeeded as "reported (unconfirmed)",
// which is indistinguishable from the adversarial arm this signal exists to
// name. The record is the evidence; it does not get to depend on whether anyone
// was watching.
//
// The daemon writes an outcome record for every transition it ACTUALLY
// PERFORMED — including when its complete/reject call was REFUSED because the
// row was already terminal. That refusal is the tamper evidence: without the
// record, an adversary who drove the row terminal first produces a command with
// no daemon record at all, and DISPUTED could never render.

import { AuditSpool, type AuditRecord, type SpoolWriter } from "./audit-spool";
import type { TransitionRecord } from "./commands";
import {
  COMMAND_OUTCOME_ACTION,
  commandOutcomeParams,
  isTerminalStatus,
} from "../ui/corroboration";

export interface DaemonAuditOptions {
  dir: string;
  /** The EFFECTIVE enablement predicate, read live — the console can be enabled
   *  or disabled under a running daemon. */
  consoleEnabled: () => Promise<boolean>;
  clock?: () => Date;
  /** A spool that cannot be written is a fact worth logging and never a reason
   *  to abandon the work the record describes. */
  onError?: (error: unknown) => void;
  writer?: SpoolWriter;
}

export class DaemonAudit {
  private readonly spool: AuditSpool;
  private readonly options: DaemonAuditOptions;
  /** The claim record for each in-flight command, so its outcome can point back
   *  at the intent — across a rotation, which is why the file id rides along. */
  private readonly claims = new Map<string, AuditRecord>();

  constructor(options: DaemonAuditOptions) {
    this.options = options;
    this.spool = new AuditSpool({
      dir: options.dir,
      writer: options.writer ?? "daemon",
      ...(options.clock ? { clock: options.clock } : {}),
    });
  }

  private fail(error: unknown): null {
    this.options.onError?.(error);
    return null;
  }

  /** A system-origin act. Gated: null means the console is off and nothing was
   *  written, which is a state the caller may report but never an error. */
  async record(
    action: string,
    fields: { sessionRef?: string | null; params?: Record<string, unknown> | null } = {},
  ): Promise<AuditRecord | null> {
    if (!(await this.options.consoleEnabled().catch(() => false))) return null;
    try {
      return await this.spool.event(action, {
        sessionRef: fields.sessionRef ?? null,
        params: fields.params ?? null,
      });
    } catch (error) {
      return this.fail(error);
    }
  }

  /**
   * An engine run, as an append-only pair: the intent is fsynced BEFORE the work
   * starts, the outcome after it ends. A crash between them leaves an intent
   * with nothing answering it, which is exactly the evidence the pair exists to
   * leave behind.
   */
  async run<T>(
    action: string,
    params: Record<string, unknown> | null,
    work: () => Promise<T>,
  ): Promise<T> {
    const gated = await this.options.consoleEnabled().catch(() => false);
    let intent: AuditRecord | null = null;
    if (gated) {
      try {
        intent = await this.spool.intent(action, { params });
      } catch (error) {
        this.fail(error);
      }
    }
    try {
      const result = await work();
      if (intent) await this.spool.outcome(intent, "done").catch((e: unknown) => this.fail(e));
      return result;
    } catch (error) {
      if (intent) {
        const message = error instanceof Error ? error.message : String(error);
        await this.spool.outcome(intent, "failed", message).catch((e: unknown) => this.fail(e));
      }
      throw error;
    }
  }

  /**
   * One record per transition the daemon performed. UNGATED, always.
   *
   * `accepted: false` means the routine refused the transition because the row
   * was already terminal — somebody else moved it. The record is written all the
   * same, and it is the only thing that lets the console tell a fabricated
   * outcome from an honest one.
   */
  async transition(transition: TransitionRecord): Promise<AuditRecord | null> {
    try {
      if (transition.transition === "claimed") {
        const intent = await this.spool.intent(COMMAND_OUTCOME_ACTION, {
          sessionRef: transition.id,
          params: { commandKind: transition.kind, transition: "claimed" },
        });
        this.claims.set(transition.id, intent);
        return intent;
      }
      if (!isTerminalStatus(transition.transition)) return null;
      const status = transition.transition;
      // Exactly the payload the routine wrote (or would have written): reject
      // puts its reason in `error` and leaves `outcome` null, complete carries
      // both. The console digests the ROW's payload and compares, so any other
      // shape here would dispute every honest command.
      const outcome = status === "rejected" ? null : (transition.outcome ?? null);
      const error =
        status === "rejected" ? (transition.reason ?? null) : (transition.error ?? null);
      const claim = this.claims.get(transition.id);
      this.claims.delete(transition.id);
      return await this.spool.append({
        actor: null,
        sessionRef: transition.id,
        tier: null,
        action: COMMAND_OUTCOME_ACTION,
        params: {
          ...commandOutcomeParams({ commandKind: transition.kind, status, outcome, error }),
          accepted: transition.accepted,
        },
        kind: "outcome",
        refFileId: claim?.fileId ?? null,
        refSeq: claim?.seq ?? null,
        outcome,
        error,
      });
    } catch (error) {
      return this.fail(error);
    }
  }

  /** The hook `pollCommands` and the boot fence take. */
  get onTransition(): (record: TransitionRecord) => Promise<void> {
    return async (record: TransitionRecord): Promise<void> => {
      await this.transition(record);
    };
  }
}
