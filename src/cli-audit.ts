// The terminal's own audit writer - and the one writer in this system that is
// NEVER gated on whether the console is enabled.
//
// The blind window it closes is the one that matters most: the first operator
// account is created from a shell before any console exists, `ui sso on` is run
// before the unit is up, and `ui disable` is by definition an act performed
// while the console is off. A writer that only recorded when somebody was
// watching would miss precisely the acts an auditor asks about first.
//
// Which means nothing drains these until a console runs, so THE CLI ENFORCES ITS
// OWN CAP. Past a file count or a byte total it reclaims its own oldest files -
// after writing one record naming the span it is about to drop, into its own
// fresh file. A fortress whose console never starts therefore keeps a bounded
// spool with an explicit, audited hole in it, rather than an unbounded directory
// or a trail that silently stops.
//
// A record that cannot be written REFUSES THE ACT. That is the whole ordering
// rule of the spool applied to the terminal: the intent is on disk before the
// mutation runs, so a spool the caller cannot write - because they are root and
// the fortress belongs to somebody else - is a reason not to act at all.

import path from "node:path";

import { AUDIT_ACTIONS } from "./console/audit-actions";
import {
  applySpoolReclaim,
  AuditSpool,
  DEFAULT_SPOOL_CAPS,
  overSpoolCap,
  planSpoolReclaim,
  spoolUsage,
  type SpoolCaps,
} from "./console/audit-spool";

/** Who a terminal act is attributed to. There are no accounts on this side of
 *  the door: whoever has a shell on the host has all of it. */
export const CLI_ACTOR = "root operator (terminal)";

export interface CliAuditOptions {
  dir: string;
  now?: () => Date;
  caps?: SpoolCaps;
  /** An outcome that could not be written is reported here. The act already
   *  happened by then, and hiding the write failure would be worse than the
   *  incomplete pair it leaves. */
  onWarn?: (message: string) => void;
}

export class CliAudit {
  private readonly spool: AuditSpool;
  private readonly options: CliAuditOptions;
  private capChecked = false;

  constructor(options: CliAuditOptions) {
    this.options = options;
    this.spool = new AuditSpool({
      dir: options.dir,
      writer: "cli",
      ...(options.now ? { clock: options.now } : {}),
    });
  }

  /** Bring the spool back inside the cap, announcing the loss first. Runs once
   *  per invocation, before the first record this process writes. */
  private async enforceCap(): Promise<void> {
    if (this.capChecked) return;
    this.capChecked = true;
    const caps = this.options.caps ?? DEFAULT_SPOOL_CAPS;
    const usage = await spoolUsage(this.options.dir);
    // Counted WITH the file this invocation is about to open, or every run would
    // leave the spool one file over the cap and the next would reclaim one more.
    const reserve = { files: 1, bytes: 0 };
    if (!overSpoolCap({ files: usage.files + reserve.files, bytes: usage.bytes }, caps)) return;
    const plan = await planSpoolReclaim(this.options.dir, {
      writer: "cli",
      keep: new Set([path.basename(this.spool.filePath)]),
      caps,
      reserve,
    });
    if (plan.files.length === 0) return;
    // Named span, into THIS invocation's own fresh file, before anything is
    // deleted: a reclaim nobody can see is indistinguishable from a trail that
    // was never written.
    await this.spool.event(AUDIT_ACTIONS.spoolReclaimed, {
      actor: CLI_ACTOR,
      params: {
        files: plan.files.length,
        records: plan.records,
        bytes: plan.bytes,
        from: plan.from,
        to: plan.to,
      },
      error:
        `${plan.records} terminal records from ${plan.files.length} spool files were dropped ` +
        "before any console drained them: the spool had grown past its cap with no console to " +
        "empty it.",
    });
    await applySpoolReclaim(plan);
  }

  /**
   * Record a terminal act as an append-only pair around the work.
   *
   * The intent is fsynced BEFORE the verb runs and the outcome after it returns,
   * so a crash in between leaves an intent with nothing answering it - which is
   * the honest state, and the one a reader can act on.
   */
  async run<T>(
    action: string,
    params: Record<string, unknown> | null,
    work: () => Promise<T>,
  ): Promise<T> {
    await this.enforceCap();
    const intent = await this.spool.intent(action, { actor: CLI_ACTOR, params });
    try {
      const result = await work();
      await this.spool.outcome(intent, "done").catch((error: unknown) => {
        this.options.onWarn?.(error instanceof Error ? error.message : String(error));
        return null;
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.spool.outcome(intent, "failed", message).catch(() => null);
      throw error;
    }
  }
}

/** An action name safe to store: a subcommand nobody enumerated must not be able
 *  to write an arbitrary string into the trail's action column. */
function safeVerb(parts: readonly string[]): string {
  const joined = parts.filter(Boolean).join("_").toLowerCase();
  return /^[a-z][a-z0-9_-]{0,40}$/.test(joined) ? joined : "unknown";
}

export interface CliAuditAct {
  action: string;
  params: Record<string, unknown> | null;
}

/**
 * What a `ui` subcommand records, decided in ONE place.
 *
 * The default is AUDITED, exactly as an unclassified route is `mutate`: a verb
 * added later without a decision lands in the trail rather than quietly outside
 * it. Only the two verbs that read - `ui config` with no arguments and
 * `ui user list` - return null.
 */
export function cliAuditAct(args: readonly string[]): CliAuditAct | null {
  const [verb, sub, third, ...rest] = args;
  const prefix = AUDIT_ACTIONS.cliPrefix;
  if (verb === "config") {
    if (sub === undefined) return null;
    if (sub === "set") {
      // The value is recorded EXCEPT for the stdin-only keys, whose value is a
      // connection string with a password in it. Those arrive on stdin
      // precisely so they never reach argv, and the trail is not the place to
      // undo that.
      const key = third ?? "";
      const value = rest[0];
      return {
        action: `${prefix}config_set`,
        params: { key, ...(value && value !== "--stdin" ? { value } : {}) },
      };
    }
    return { action: `${prefix}config_${safeVerb([sub.replace(/^--/, "")])}`, params: null };
  }
  if (verb === "user") {
    if (sub === "list" || sub === undefined) return null;
    const roleFlag = args.indexOf("--role");
    const role = roleFlag >= 0 ? args[roleFlag + 1] : undefined;
    return {
      action: `${prefix}user_${safeVerb([sub])}`,
      params: { ...(third ? { login: third } : {}), ...(role ? { role } : {}) },
    };
  }
  if (verb === "sso") return { action: `${prefix}sso_${safeVerb([sub ?? ""])}`, params: null };
  if (verb === "enable") return { action: AUDIT_ACTIONS.cliEnable, params: null };
  if (verb === "disable") return { action: AUDIT_ACTIONS.cliDisable, params: null };
  if (verb === "marker") {
    return { action: `${prefix}marker`, params: sub && sub !== "--clear" ? { phrase: sub } : null };
  }
  return { action: `${prefix}${safeVerb([verb ?? ""])}`, params: null };
}
