// The daemon's writer for module, ask and release records.
//
// It is built on the console's audit spool — the same 0600 append-only files,
// drained into the same table — so there is one trail on this fortress and not
// two. Three things differ from the daemon's general writer (`DaemonAudit`),
// and all three follow from what these records are for.
//
// NEVER GATED ON THE CONSOLE. `DaemonAudit.record` writes nothing while the
// console is switched off, because an engine record nobody will read is noise.
// An ask is different: "what did the control plane ask of this host, and what
// was it refused" is the question this trail exists to answer, and it has to be
// answerable for a period in which nobody had the console open. So every record
// here is written whether or not anything is draining the spool.
//
// ITS OWN FILES, WITH ITS OWN CAP. Because nothing may be draining them, this
// writer bounds its own files, exactly as the terminal's writer does. They
// carry their own name (`modules`) so the cap can be applied to them alone: the
// daemon's other files hold the command records the console corroborates
// outcomes against, and those are never this writer's to remove.
//
// REFUSALS COLLAPSE, AND HAVE A BUDGET. The control plane chooses how often it
// asks. If every refused ask cost one fsynced record, a control plane that had
// gone wrong — or been taken over — could make this host write to disk as fast
// as it can send frames, into a table with no DELETE. So:
//
//   • A run of identical refusals is two records, not N: the first at once, so
//     the trail shows the refusal when it happens, and one more when the window
//     closes, carrying how many followed and over what span.
//   • Only so many DIFFERENT refusals are written per window. Past that budget
//     a refusal is counted, not written, and each action gets one marker for
//     the window saying how many were counted that way.
//
// Together those make the number of refusal records per minute a constant of
// this file, whatever the control plane sends.
//
// WHOSE A RECORD IS. A record is one organization's. For the Fortress's own
// organization, which is the only one most Fortresses have, a record says
// nothing about organizations. For another organization the record carries its
// id. The mark is set HERE and nowhere else: `for(organization)` gives a writer
// whose every record carries that organization, and no caller adds the mark to
// a record's parameters by hand. This writer itself writes the Fortress's own.
//
// The budget is the whole Fortress's. Past it, refusals for the Fortress's own
// organization are counted in its marker, as before. Refusals for other
// organizations are counted together in one more record for each action, which
// names no organization and is no organization's: a count kept for each of
// them would be a record for each of them, which is what the budget forbids.

import path from "node:path";

import { AUDIT_ACTIONS } from "../console/audit-actions";
import {
  applySpoolReclaim,
  AuditSpool,
  listSpoolFiles,
  planSpoolReclaim,
  readSpoolFile,
  SPOOL_RETENTION_MS,
  type AuditRecord,
  type SpoolCaps,
} from "../console/audit-spool";
import { organizationMark, type Organization } from "./organization-id";
import { RateWindow } from "./rate-window";

/** How long identical refusals accumulate before the count is written. */
export const REFUSAL_WINDOW_MS = 60_000;

/** Different refusals that may be written in any one window, counted exactly
 *  (see rate-window.ts). Each is at most two records, so with the markers (two
 *  for each action at most) this bounds refusal records at about 130 a minute.
 *  Ordinary operation produces a handful a day. */
export const REFUSAL_KINDS_PER_WINDOW = 60;

/** The rule a marker carries: refusals that were counted and not written. */
export const REFUSALS_OVER_BUDGET = "refusals_over_budget";

/**
 * What the action of a marker ends in when the refusals it counts were for
 * organizations other than the Fortress's own. A refused ask is counted under
 * `control_plane.ask.overflow`, and a module's own refusal (a secret or a host
 * its manifest does not list) under `system.module.refused.overflow`.
 *
 * It is an action of its own so that nobody counts it as theirs. It carries no
 * organization, so no other organization's reader is shown it, and it is not
 * the action it stands for, so the own organization's count of refused asks
 * does not include it.
 */
export const REFUSAL_OVERFLOW_SUFFIX = ".overflow";

/**
 * How old one of this writer's files must be before this writer may remove it.
 *
 * A running console drains a file within the minute and removes it once it has
 * gone `SPOOL_RETENTION_MS` without a write. So a file older than that, plus a
 * margin, is one no console removed: no console is running, or the one that is
 * cannot reach its database. Only such a file is this writer's to remove.
 *
 * A younger file is never removed here. With a console running it has been
 * drained and will be removed by the console; removing it here and recording
 * its records as lost would put a loss in the trail that did not happen.
 */
export const MODULE_SPOOL_STALE_MS = SPOOL_RETENTION_MS + 5 * 60_000;

/**
 * How many of this writer's OLD files are kept (see `MODULE_SPOOL_STALE_MS`).
 * Past it the oldest are removed, after a record that says so.
 *
 * So what this writer leaves on disk where nothing drains it is bounded by two
 * things: these caps for the old files, and the limits on how fast records can
 * be written for the young ones (asks a minute, different refusals a minute,
 * release offers a minute).
 */
export const MODULE_SPOOL_CAPS: SpoolCaps = { maxFiles: 16, maxBytes: 16 * 1024 * 1024 };

/** How often the old files are checked against the caps, besides each time a
 *  file is retired. */
const CAP_CHECK_MS = 10 * 60_000;

/** The actor recorded for something the control plane did. */
export const CONTROL_PLANE_ACTOR = "control plane";

export interface ModuleAuditOptions {
  dir: string;
  clock?: () => Date;
  /** A record that could not be written. Reported, never thrown at the
   *  connection: the act it describes is refused by the caller where that is
   *  the rule. */
  onError?: (error: unknown) => void;
  windowMs?: number;
  kindsPerWindow?: number;
  caps?: SpoolCaps;
  /** How old a file must be before the cap may remove it. */
  staleMs?: number;
  /** Size at which the spool retires a file. Defaults to the spool's own. */
  rotateBytes?: number;
}

export type AuditParams = Record<string, string | number | boolean | null>;

/** What a pair's intent, or a single record, may be given. */
export interface AuditFields {
  actor?: string | null;
  sessionRef?: string | null;
  params?: AuditParams | null;
}

/**
 * The writer of ONE organization's records.
 *
 * `ModuleAudit` is this for the Fortress's own organization, and
 * `ModuleAudit.for` gives one for any other. Code that acts for an organization
 * takes its writer once and uses nothing else, so a record it writes cannot be
 * left without its mark.
 */
export interface AuditWriter {
  /** The intent half of a pair, on disk before the act it names. Throws when
   *  it cannot be written. */
  intent(action: string, fields?: AuditFields): Promise<AuditRecord>;
  /** The outcome half. It is the organization's that its intent is. */
  outcome(intent: AuditRecord, outcome: string, error?: string | null): Promise<void>;
  /** A single record. Null when it could not be written. */
  event(
    action: string,
    fields?: AuditFields & { outcome?: string | null; error?: string | null },
  ): Promise<AuditRecord | null>;
  /** A refusal that the other side can repeat at will. */
  refused(action: string, params: AuditParams, actor?: string | null): Promise<void>;
}

interface RefusalWindow {
  action: string;
  actor: string | null;
  /** Whose refusals these are: null for the Fortress's own organization. */
  mark: string | null;
  params: AuditParams;
  /** Refusals after the first, which was written when the window opened. */
  attempts: number;
  /** When the first COLLAPSED refusal arrived, and the last. */
  from: number;
  to: number;
  closesAt: number;
}

interface OverBudget {
  action: string;
  actor: string | null;
  /** True when these were refusals for organizations other than the Fortress's
   *  own. They are counted together and written as nobody's. */
  others: boolean;
  attempts: number;
  from: number;
  to: number;
}

export class ModuleAudit implements AuditWriter {
  private readonly spool: AuditSpool;
  private readonly options: ModuleAuditOptions;
  private readonly windows = new Map<string, RefusalWindow>();
  /** Refusals counted past the budget: by action, the own organization's and
   *  everybody else's apart. */
  private readonly overBudget = new Map<string, OverBudget>();
  /** When each refusal window of the last `windowMs` was opened. */
  private readonly opened: RateWindow;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private capTimer: ReturnType<typeof setInterval> | null = null;
  /** The cap check in progress. A second caller waits for it and starts none
   *  beside it. */
  private capping: Promise<void> | null = null;
  /** True when a check was asked for while one was running: one more runs after it. */
  private capAgain = false;

  constructor(options: ModuleAuditOptions) {
    this.options = options;
    this.opened = new RateWindow(
      options.kindsPerWindow ?? REFUSAL_KINDS_PER_WINDOW,
      options.windowMs ?? REFUSAL_WINDOW_MS,
    );
    this.spool = new AuditSpool({
      dir: options.dir,
      writer: "modules",
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.rotateBytes === undefined ? {} : { rotateBytes: options.rotateBytes }),
      beforeRotate: async () => {
        // A window still open when a file is retired is closed into that file,
        // so its count lands beside the refusal it continues.
        await this.flush();
        // Under load this is the moment that comes often, so the old files are
        // checked against the cap here as well as on the timer. On a timeout,
        // because the spool names its next file only after this hook returns,
        // and the check must see that name as the current one.
        const timer = setTimeout(() => void this.enforceCap(), 0);
        (timer as { unref?: () => void }).unref?.();
      },
    });
  }

  private now(): number {
    return (this.options.clock ?? ((): Date => new Date()))().getTime();
  }

  /** The name of the file this writer is on now. Every other file of this
   *  writer is finished. Two files that were started in the same second sort
   *  by their random ids, so the newest name in the folder is not always this
   *  one. */
  get currentFile(): string {
    return path.basename(this.spool.filePath);
  }

  private get windowMs(): number {
    return this.options.windowMs ?? REFUSAL_WINDOW_MS;
  }

  private report(error: unknown): null {
    try {
      this.options.onError?.(error);
    } catch {
      // The log could not take it either (a full disk fails both). There is
      // nowhere left to say so, and a method documented as never throwing must
      // not start throwing because the place it reports to did.
    }
    return null;
  }

  /**
   * The intent records of one action that this writer left on disk in the last
   * `sinceMs`, this run's and earlier runs'.
   *
   * Read newest file first, and stopped at the first file that holds nothing
   * that recent, so a start reads a file or two and not the whole directory.
   */
  async recentIntents(action: string, sinceMs: number): Promise<AuditRecord[]> {
    const since = this.now() - sinceMs;
    const mine = (await listSpoolFiles(this.options.dir))
      .filter((file) => file.writer === "modules")
      .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    const found: AuditRecord[] = [];
    for (const file of mine) {
      const records = await readSpoolFile(file.path);
      const recent = records.filter((record) => Date.parse(record.ts) >= since);
      for (const record of recent) {
        if (record.action === action && record.kind === "intent") found.push(record);
      }
      // A file is named for when it was opened, and files are read newest
      // first: once one holds a record older than the window, every older file
      // is older still.
      if (recent.length < records.length) break;
    }
    return found;
  }

  /** Start the two timers: closing refusal windows, and the cap check every ten
   *  minutes. Both are unref'd; neither keeps the daemon alive. The cap is also
   *  checked each time a file is retired (see the constructor). */
  start(): void {
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => void this.flushExpired(), Math.max(250, this.windowMs / 2));
      (this.flushTimer as { unref?: () => void }).unref?.();
    }
    if (!this.capTimer) {
      this.capTimer = setInterval(() => void this.enforceCap(), CAP_CHECK_MS);
      (this.capTimer as { unref?: () => void }).unref?.();
    }
    void this.enforceCap();
  }

  /** Stop the timers and write every open window. */
  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.capTimer) clearInterval(this.capTimer);
    this.flushTimer = null;
    this.capTimer = null;
    await this.flush();
  }

  /**
   * The writer of one organization's records.
   *
   * For the Fortress's own organization that is this object. For another, it is
   * a writer whose every record carries that organization's id: an intent, its
   * outcome, a single record and a refusal alike.
   */
  for(organization: Organization): AuditWriter {
    const mark = organizationMark(organization);
    if (mark === null) return this;
    return {
      intent: (action, fields) => this.intentFor(mark, action, fields),
      // An outcome is whose its intent is: the spool copies the mark across.
      outcome: (intent, outcome, error) => this.outcome(intent, outcome, error),
      event: (action, fields) => this.eventFor(mark, action, fields),
      refused: (action, params, actor) => this.refusedFor(mark, action, params, actor),
    };
  }

  /**
   * The intent half of a pair, fsynced before the act it names.
   *
   * THROWS when it cannot be written. The caller is about to run something on
   * the control plane's word, and an act with no record of having been asked
   * for is the one state this trail must not contain — so the act does not run.
   */
  intent(action: string, fields: AuditFields = {}): Promise<AuditRecord> {
    return this.intentFor(null, action, fields);
  }

  private intentFor(mark: string | null, action: string, fields: AuditFields = {}): Promise<AuditRecord> {
    return this.spool.intent(action, {
      actor: fields.actor ?? null,
      sessionRef: fields.sessionRef ?? null,
      params: fields.params ?? null,
      organization: mark,
    });
  }

  /** The outcome half. A failure to write it is reported and swallowed: the act
   *  already happened, and its intent is on disk with nothing answering it,
   *  which is the honest record of exactly that.
   *
   *  It is the organization's that its intent is. The spool copies that across,
   *  so no caller says it twice and the two halves cannot disagree. */
  async outcome(intent: AuditRecord, outcome: string, error: string | null = null): Promise<void> {
    try {
      await this.spool.outcome(intent, outcome, error);
    } catch (thrown) {
      this.report(thrown);
    }
  }

  /** A single record. Null when it could not be written. */
  event(
    action: string,
    fields: AuditFields & { outcome?: string | null; error?: string | null } = {},
  ): Promise<AuditRecord | null> {
    return this.eventFor(null, action, fields);
  }

  private async eventFor(
    mark: string | null,
    action: string,
    fields: AuditFields & { outcome?: string | null; error?: string | null } = {},
  ): Promise<AuditRecord | null> {
    try {
      return await this.spool.event(action, {
        actor: fields.actor ?? null,
        sessionRef: fields.sessionRef ?? null,
        params: fields.params ?? null,
        outcome: fields.outcome ?? null,
        error: fields.error ?? null,
        organization: mark,
      });
    } catch (thrown) {
      return this.report(thrown);
    }
  }

  /**
   * A refusal that the other side can repeat at will.
   *
   * `params` says what was refused and by which rule, and is what identical
   * refusals are collapsed on. Build it from values this build knows — a module
   * id from the catalog, an ask name from a manifest, a rule from the caller's
   * own list — and a placeholder otherwise, so the trail reads cleanly. The
   * budget below is what holds if a caller ever gets that wrong.
   */
  refused(action: string, params: AuditParams, actor: string | null = CONTROL_PLANE_ACTOR): Promise<void> {
    return this.refusedFor(null, action, params, actor);
  }

  private async refusedFor(
    mark: string | null,
    action: string,
    params: AuditParams,
    actor: string | null = CONTROL_PLANE_ACTOR,
  ): Promise<void> {
    // Whose refusal it is, is part of what makes two refusals the same one: a
    // run for one organization never swallows another's.
    const key = `${action}\u0000${actor ?? ""}\u0000${mark ?? ""}\u0000${Object.keys(params)
      .sort()
      // The object's own keys, read back from the same object.
      // eslint-disable-next-line security/detect-object-injection
      .map((name) => `${name}=${String(params[name])}`)
      .join("\u0000")}`;
    const now = this.now();
    const open = this.windows.get(key);
    if (open && now < open.closesAt) {
      if (open.attempts === 0) open.from = now;
      open.attempts += 1;
      open.to = now;
      return;
    }

    // A new window is a new record, and those are budgeted. Everything that
    // changes the maps happens before the first await, so two refusals arriving
    // together cannot both find the key free and both write a "first" record.
    if (!this.opened.take(now)) {
      // Counted, not written. The own organization's are counted for it. Every
      // other organization's are counted together: one count for each of them
      // would be one record for each of them.
      const others = mark !== null;
      const slot = `${action}\u0000${others ? "others" : "own"}`;
      const counted = this.overBudget.get(slot);
      if (counted) {
        counted.attempts += 1;
        counted.to = now;
      } else {
        this.overBudget.set(slot, { action, actor, others, attempts: 1, from: now, to: now });
      }
      return;
    }
    this.windows.set(key, {
      action,
      actor,
      mark,
      params,
      attempts: 0,
      from: now,
      to: now,
      closesAt: now + this.windowMs,
    });
    if (open) await this.writeWindow(open);
    await this.eventFor(mark, action, { actor, params, outcome: "refused" });
  }

  private async writeWindow(window: RefusalWindow): Promise<void> {
    if (window.attempts === 0) return;
    await this.eventFor(window.mark, window.action, {
      actor: window.actor,
      params: {
        ...window.params,
        attempts: window.attempts,
        from: new Date(window.from).toISOString(),
        to: new Date(window.to).toISOString(),
      },
      outcome: "refused",
    });
  }

  private async writeOverBudget(counted: OverBudget): Promise<void> {
    // Refusals for other organizations go under an action of their own, with no
    // organization: see `REFUSAL_OVERFLOW_SUFFIX`.
    const action = counted.others ? `${counted.action}${REFUSAL_OVERFLOW_SUFFIX}` : counted.action;
    await this.event(action, {
      actor: counted.actor,
      params: {
        rule: REFUSALS_OVER_BUDGET,
        attempts: counted.attempts,
        from: new Date(counted.from).toISOString(),
        to: new Date(counted.to).toISOString(),
      },
      outcome: "refused",
    });
  }

  private async flushExpired(): Promise<void> {
    const now = this.now();
    // Each write below is awaited, and during it a refusal may arrive or the
    // spool may retire its file and flush every window. So each entry is looked
    // up again when its turn comes: one that was written or replaced meanwhile
    // is not this loop's any more. Without the second look, the old count was
    // written twice and the window that had replaced it was deleted unwritten.
    for (const [key, window] of [...this.windows]) {
      if (now < window.closesAt) continue;
      if (this.windows.get(key) !== window) continue;
      this.windows.delete(key);
      await this.writeWindow(window);
    }
    for (const [slot, counted] of [...this.overBudget]) {
      if (now - counted.from < this.windowMs) continue;
      if (this.overBudget.get(slot) !== counted) continue;
      this.overBudget.delete(slot);
      await this.writeOverBudget(counted);
    }
  }

  /** Close every open window now. */
  async flush(): Promise<void> {
    const open = [...this.windows.values()];
    const counted = [...this.overBudget.values()];
    this.windows.clear();
    this.overBudget.clear();
    for (const window of open) await this.writeWindow(window);
    for (const marker of counted) await this.writeOverBudget(marker);
  }

  /**
   * Bring this writer's old files back inside the cap, announcing the loss first.
   *
   * Only a file that is OLD is counted, and only such a file is removed: one of
   * this writer's, not the one it is appending to, and untouched for longer
   * than a running console would have left it on disk (`MODULE_SPOOL_STALE_MS`).
   * So this acts only where nothing drains the spool. Oldest first.
   *
   * The record naming the span is written before anything is removed, into the
   * file this writer is on now: a bounded trail with a hole somebody can see,
   * rather than an unbounded directory or a trail that silently stops.
   *
   * One check runs at a time, so no file is announced twice. A caller that
   * arrives during a check starts no second one beside it. It asks for one more
   * to run after it, and waits for both.
   *
   * The second run is the point. The caller is here because something changed:
   * a file was retired a moment ago. The check that is running may have read
   * the directory before that. If the request were dropped, a burst of writes
   * that ends while a check is under way would leave the spool over its cap,
   * with nothing left to notice until the next file is retired or the timer
   * fires.
   */
  enforceCap(): Promise<void> {
    if (this.capping) {
      this.capAgain = true;
      return this.capping;
    }
    this.capping = (async (): Promise<void> => {
      do {
        this.capAgain = false;
        await this.checkCap();
      } while (this.capAgain);
    })().finally(() => {
      this.capping = null;
    });
    return this.capping;
  }

  private async checkCap(): Promise<void> {
    try {
      const staleMs = this.options.staleMs ?? MODULE_SPOOL_STALE_MS;
      const current = this.currentFile;
      const oldBefore = this.now() - staleMs;
      const plan = await planSpoolReclaim(this.options.dir, {
        writer: "modules",
        keep: new Set([current]),
        caps: this.options.caps ?? MODULE_SPOOL_CAPS,
        counts: (file) =>
          file.writer === "modules" &&
          file.name !== current &&
          file.modifiedAt.getTime() <= oldBefore,
      });
      if (plan.files.length === 0) return;
      await this.spool.event(AUDIT_ACTIONS.spoolReclaimed, {
        params: {
          files: plan.files.length,
          records: plan.records,
          bytes: plan.bytes,
          from: plan.from,
          to: plan.to,
        },
        error:
          `${plan.records} module records in ${plan.files.length} spool files were removed from ` +
          `this host's disk. The files had gone more than ${Math.round(staleMs / 60_000)} minutes ` +
          "without a write and no console had removed them, which a running console does within " +
          "the hour, and together they had passed this writer's cap. Any of these records that a " +
          "console did drain are in the audit table. The others are lost.",
      });
      await applySpoolReclaim(plan);
    } catch (thrown) {
      this.report(thrown);
    }
  }
}
