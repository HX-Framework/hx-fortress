// What the CONSOLE writes to the spool: the acts a signed-in session took, the
// copies of fortress data that left, and the one thing in this system that is
// collapsed rather than recorded one-for-one.
//
// PUBLIC AUTH FAILURES COLLAPSE. An unauthenticated flood can produce attempts
// as fast as the network allows, and every record it produced would land in a
// table with no DELETE anywhere in the system - so the trail's size would become
// a function of how hard somebody attacked it, and the honest retention line
// ("the life of the database") would become a liability. One durable record per
// (login, remote-key, 5-minute window) carrying the final attempt count keeps
// growth proportional to ACTIVE PAIRS instead of attempts. Attempts refused by a
// rate bucket, or shed by the argon gate, append NOTHING at all: they cost a
// counter, never an fsync, or a flood would still be able to make this host
// write to disk as fast as it can send packets.
//
// THE RECORD IS APPENDED ONCE, AT WINDOW CLOSE, WITH THE FINAL COUNT. Not
// amended in place - D7's spool is append-only, and an amend would rewrite
// evidence. Not re-appended under the same (fileId, seq) either: the drain is ON
// CONFLICT DO NOTHING on exactly that key, so a "corrected" second copy would be
// discarded in silence and the table would keep the stale count. An open window
// is closed on rotation and on shutdown; a crash loses at most the one open
// window, and the console says so rather than implying the trail is complete.
//
// EXPORTS ARE NEVER COLLAPSED. Each of the five gets its own record with its own
// parameters, because a trail that cannot say WHICH copy left is not a trail.
// They are human-initiated and cannot self-amplify, so the growth argument above
// does not apply; the bound is a per-session/day ceiling plus ONE marker.

import { AUDIT_ACTIONS } from "../console/audit-actions";
import { AuditSpool, type AuditRecord } from "../console/audit-spool";
import type { ConsoleExportAudit } from "./read-routes";

/** How long failures against one (login, remote-key) pair accumulate before the
 *  record is written. Long enough that a flood collapses; short enough that an
 *  operator watching a live attack sees it inside a coffee. */
export const AUTH_FAILURE_WINDOW_MS = 5 * 60 * 1000;

/** Distinct pairs that may hold an open window at once. Past it the attempts are
 *  counted into ONE marker instead of opening more windows - a distributed flood
 *  varies the remote key by design, and per-pair records would be exactly the
 *  unbounded growth the collapse exists to prevent. */
export const AUTH_FAILURE_WINDOW_CEILING = 200;

/** Exports one session may have recorded in one day before the trail says "and
 *  more" instead of naming each. */
export const EXPORT_DAILY_CEILING = 200;

interface FailureWindow {
  action: string;
  login: string | null;
  remoteKey: string;
  attempts: number;
  first: number;
  last: number;
}

interface Overflow {
  attempts: number;
  pairs: number;
  first: number;
  last: number;
}

export interface ConsoleAuditOptions {
  now?: () => Date;
  windowMs?: number;
  ceiling?: number;
  exportCeiling?: number;
  /** A spool that cannot be written is logged, never thrown at a request. */
  onError?: (error: unknown) => void;
}

export class ConsoleAudit implements ConsoleExportAudit {
  private readonly spool: AuditSpool;
  private readonly options: ConsoleAuditOptions;
  private readonly windows = new Map<string, FailureWindow>();
  private overflow: Overflow | null = null;
  private readonly exports = new Map<string, number>();
  private readonly exportMarkers = new Set<string>();

  constructor(spool: AuditSpool, options: ConsoleAuditOptions = {}) {
    this.spool = spool;
    this.options = options;
  }

  private now(): number {
    return (this.options.now ?? ((): Date => new Date()))().getTime();
  }

  private get windowMs(): number {
    return this.options.windowMs ?? AUTH_FAILURE_WINDOW_MS;
  }

  private report(error: unknown): null {
    this.options.onError?.(error);
    return null;
  }

  /** The raw door, for the records the console raises about itself. */
  async raise(
    action: string,
    fields: {
      actor?: string | null;
      sessionRef?: string | null;
      params?: Record<string, unknown> | null;
      outcome?: string | null;
      error?: string | null;
    } = {},
  ): Promise<AuditRecord | null> {
    try {
      return await this.spool.event(action, {
        actor: fields.actor ?? null,
        sessionRef: fields.sessionRef ?? null,
        params: fields.params ?? null,
        outcome: fields.outcome ?? null,
        error: fields.error ?? null,
      });
    } catch (error) {
      return this.report(error);
    }
  }

  /**
   * A console act, recorded as an append-only pair around the work.
   *
   * The intent is fsynced BEFORE the mutation runs and the outcome after it
   * returns, so a crash between them leaves an intent nothing answers — the
   * honest state, and the one an auditor can act on. Never amended in place.
   */
  async run<T>(
    action: string,
    fields: {
      actor?: string | null;
      sessionRef?: string | null;
      params?: Record<string, unknown> | null;
    },
    work: () => Promise<T>,
  ): Promise<T> {
    // The intent is a PRECONDITION, not a best-effort log line. This used to
    // catch the failure to null and run `work()` anyway, which contradicted the
    // contract three lines above and meant the whole admin surface — stop the
    // daemon, rotate credentials, export the trail — kept working with nothing
    // recorded. And because the spool caches its readiness PROMISE, one failure
    // is permanent for the process, so it is not a blip: it is every action from
    // then on. An operator who cannot be recorded is refused instead.
    const intent = await this.spool.intent(action, {
      actor: fields.actor ?? null,
      sessionRef: fields.sessionRef ?? null,
      params: fields.params ?? null,
    });
    try {
      const result = await work();
      if (intent) await this.spool.outcome(intent, "done").catch((e: unknown) => this.report(e));
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (intent) await this.spool.outcome(intent, "failed", message).catch(() => null);
      throw error;
    }
  }

  /**
   * Note one failed public-auth attempt. Nothing is written here, which is the
   * point. The caller must NOT call this for an attempt a rate bucket refused or
   * the argon gate shed: those are counted by the limiter and write no record,
   * so a flood cannot convert a refusal into disk traffic.
   */
  noteFailure(action: string, args: { login?: string | null; remoteKey: string }): void {
    const at = this.now();
    const login = args.login ?? null;
    const key = [action, login ?? "", args.remoteKey].join(" ");
    const open = this.windows.get(key);
    if (open) {
      open.attempts += 1;
      open.last = at;
      return;
    }
    if (this.windows.size >= (this.options.ceiling ?? AUTH_FAILURE_WINDOW_CEILING)) {
      this.overflow = {
        attempts: (this.overflow?.attempts ?? 0) + 1,
        pairs: (this.overflow?.pairs ?? 0) + 1,
        first: this.overflow?.first ?? at,
        last: at,
      };
      return;
    }
    this.windows.set(key, {
      action,
      login,
      remoteKey: args.remoteKey,
      attempts: 1,
      first: at,
      last: at,
    });
  }

  /** Close every window whose time is up. `force` closes the open ones too - the
   *  rotation and shutdown paths, where a window that survived into the next
   *  file would be recorded under a file id that no longer says when it
   *  happened. */
  async flushFailures(force = false): Promise<AuditRecord[]> {
    const at = this.now();
    const written: AuditRecord[] = [];
    for (const [key, window] of [...this.windows]) {
      if (!force && at - window.first < this.windowMs) continue;
      this.windows.delete(key);
      const record = await this.raise(window.action, {
        actor: window.login,
        params: {
          ...(window.login ? { login: window.login } : {}),
          remote: window.remoteKey,
          attempts: window.attempts,
          from: new Date(window.first).toISOString(),
          to: new Date(window.last).toISOString(),
        },
        error: `${window.attempts} failed ${window.attempts === 1 ? "attempt" : "attempts"}`,
      });
      if (record) written.push(record);
    }
    const overflow = this.overflow;
    if (overflow && (force || at - overflow.first >= this.windowMs)) {
      this.overflow = null;
      const record = await this.raise(AUDIT_ACTIONS.authOverflow, {
        params: {
          ceiling: this.options.ceiling ?? AUTH_FAILURE_WINDOW_CEILING,
          windows: overflow.pairs,
          from: new Date(overflow.first).toISOString(),
          to: new Date(overflow.last).toISOString(),
        },
        error:
          `${overflow.attempts} further failed attempts from sources beyond the per-window ` +
          "record ceiling; counted here rather than recorded one by one",
      });
      if (record) written.push(record);
    }
    return written;
  }

  /** Open windows right now - what the panel's crash-loses-the-window line is
   *  about, and what a shutdown flush has to close. */
  get openWindows(): number {
    return this.windows.size + (this.overflow ? 1 : 0);
  }

  async signIn(args: {
    login: string;
    role: string;
    remoteKey: string;
    workbenchSub?: string | null;
  }): Promise<void> {
    await this.raise(AUDIT_ACTIONS.signIn, {
      actor: args.login,
      params: {
        login: args.login,
        role: args.role,
        remote: args.remoteKey,
        ...(args.workbenchSub ? { workbenchSub: args.workbenchSub } : {}),
      },
      outcome: "signed in",
    });
  }

  async signOut(args: { login: string; role: string; sessionRef: string }): Promise<void> {
    await this.raise(AUDIT_ACTIONS.signOut, {
      actor: args.login,
      sessionRef: args.sessionRef,
      params: { login: args.login, role: args.role },
      outcome: "signed out",
    });
  }

  async setupOpened(args: { login: string; remoteKey: string }): Promise<void> {
    await this.raise(AUDIT_ACTIONS.setupOpened, {
      actor: args.login,
      params: { login: args.login, remote: args.remoteKey },
      outcome: "setup link opened",
    });
  }

  async setupCompleted(args: { login: string; role: string; remoteKey: string }): Promise<void> {
    await this.raise(AUDIT_ACTIONS.setupCompleted, {
      actor: args.login,
      params: { login: args.login, role: args.role, remote: args.remoteKey },
      outcome: "password set",
    });
  }

  /**
   * The export record.
   *
   * Written BEFORE the copy is produced, so an export that fails halfway - after
   * bytes were already read - is still recorded. There is no outcome half: this
   * record answers "which copy was authorized to leave, under which parameters",
   * and that answer is complete the moment it is written.
   */
  async recordExport(entry: {
    what: string;
    actor: string;
    sessionRef: string;
    params: Record<string, unknown>;
  }): Promise<void> {
    const ceiling = this.options.exportCeiling ?? EXPORT_DAILY_CEILING;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const key = [entry.sessionRef, day].join(" ");
    const used = (this.exports.get(key) ?? 0) + 1;
    this.exports.set(key, used);
    if (used > ceiling) {
      // ONE marker, then silence for the rest of the day: a marker per export
      // past the ceiling would be the same unbounded growth wearing a different
      // action name.
      if (this.exportMarkers.has(key)) return;
      this.exportMarkers.add(key);
      await this.raise(AUDIT_ACTIONS.exportOverflow, {
        actor: entry.actor,
        sessionRef: entry.sessionRef,
        params: { ceiling, day, session: entry.sessionRef },
        error:
          `this session passed ${ceiling} recorded exports today; further exports from it ` +
          "are not recorded one by one",
      });
      return;
    }
    await this.raise(`${AUDIT_ACTIONS.exportPrefix}${entry.what.split(" ").join("_")}`, {
      actor: entry.actor,
      sessionRef: entry.sessionRef,
      params: entry.params,
      outcome: entry.what,
    });
  }
}
