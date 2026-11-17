// The built-in `host` module: HX Fortress answering the control plane about itself.
//
// It ships in every build and, like every module, is OFF until somebody on this
// host switches it on (`hx-fortress modules on host`). Switched on, it answers
// four asks (`status`, `connection.count`, `audit.count`, `audit.read`), and
// what each may say is fixed by the manifest beside this file.
//
// It reads, and only reads: the shelf file, config.json, the daemon's counts of
// what crossed the connection, and the audit trail. It calls nothing on the
// network and holds no secret.
//
// EACH ANSWER IS ABOUT ONE ORGANIZATION: the one the ask was for. An HX Fortress
// that holds one organization is asked about that one, and answers as it always
// did. Where an HX Fortress holds more, an ask for another organization is told
// that organization's records and switches and nothing of anybody else's: not
// HX Fortress's own releases, not its sign-ins, not its commands. What every
// organization is told alike is what is true of the place its data rests in:
// HX Fortress's version, the kind of its key store, and the version of each
// module.

import {
  AskFailure,
  type FortressModule,
  type ModuleContextV2,
  type ReleaseRecord,
} from "../../host/module-contract";
import { utcDay, type ConnectionView, type DayView } from "../../cloud/counts";
import type { Organization } from "../../host/organization-id";
import type { MsgReply } from "../../protocol";
import { TrailUnavailable, type AuditTrail } from "./audit-trail";
import {
  CONNECTION_COUNT_MAX_DAYS,
  HOST_MANIFEST,
  HOST_MODULE_ID,
  STATUS_MAX_FRAMES,
  STATUS_MAX_MODULES,
  STATUS_MAX_RELEASES,
  type LineKind,
} from "./manifest";

export interface HostModuleDeps {
  /** The version of HX Fortress. */
  version: string;
  /** The kind of key store this running HX Fortress reads its secrets from, as
   *  the store names itself ("env", "file", "azure-key-vault"). Rejects while
   *  the secrets setting cannot be read. */
  secretsKind: () => Promise<string>;
  /** Every module this build ships, with whether this running HX Fortress has it
   *  on for the organization, and its version. */
  modules: (organization: Organization) => Promise<{ id: string; on: boolean; version: string }[]>;
  /** The release shelf as the organization may see it, newest offer first. A
   *  release for a module is for the whole HX Fortress, so the shelf is the own
   *  organization's and another organization sees none of it. */
  releases: (organization: Organization) => Promise<ReleaseRecord[]>;
  /** What the connection may carry, and what it carried today. */
  connection: () => ConnectionView;
  /**
   * What crossed the connection on each UTC day from `fromDay` to `toDay`
   * (`YYYY-MM-DD`, both included), the oldest day first, without the days on
   * which nothing was counted.
   *
   * Null while the counts of earlier runs are not known: the file that holds
   * them could not be read, or the daemon has not read it yet. What the daemon
   * holds then is only what it counted itself since it started.
   */
  connectionDays: (fromDay: string, toDay: string) => DayView[] | null;
  /**
   * The first UTC day (`YYYY-MM-DD`) that the counts say anything of: from it
   * on, a day that `connectionDays` leaves out is a day on which nothing was
   * counted, and of a day before it nothing is known.
   *
   * Null while the counts of earlier runs are not known, as `connectionDays`.
   */
  connectionKeptFrom: () => string | null;
  trail: AuditTrail;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The id of the Agentic Sessions module. `status` reports as a flag whether this
 *  running HX Fortress stores sessions. */
const SESSIONS_MODULE_ID = "session_vault";

export function createHostModule(deps: HostModuleDeps): FortressModule {
  async function status(organization: Organization): Promise<unknown> {
    const [modules, releases] = await Promise.all([
      deps.modules(organization),
      deps.releases(organization),
    ]);
    // No guess when the setting cannot be read: "env" would be a statement about
    // where this customer's keys are, and it would be wrong.
    const secrets = await deps.secretsKind().catch(() => {
      throw new AskFailure("secrets_setting_invalid");
    });
    // The connection is the whole HX Fortress's, and its counts hold every
    // organization's asks. So only the own organization is told the counts.
    // Another organization is told what the connection may carry, and no count.
    const connection = deps.connection();
    return {
      version: deps.version,
      secrets,
      sessions: modules.some((module) => module.id === SESSIONS_MODULE_ID && module.on),
      connection: organization.own
        ? { ...connection, messages: connection.messages.slice(0, STATUS_MAX_FRAMES) }
        : { ...connection, messages: [], dropped: { tooLarge: 0, unreadable: 0, unknown: 0 } },
      modules: modules.slice(0, STATUS_MAX_MODULES),
      releases: releases.slice(0, STATUS_MAX_RELEASES).map((release) => ({
        id: release.id,
        module: release.moduleId,
        version: release.version,
        state: release.state,
        offeredAt: release.offeredAt,
        ...(release.decidedAt ? { decidedAt: release.decidedAt } : {}),
      })),
    };
  }

  function connectionCount(args: { from: string; to: string }, organization: Organization): unknown {
    const from = Date.parse(args.from);
    const to = Date.parse(args.to);
    if (!(from <= to)) throw new AskFailure("range_invalid");
    // The counts are kept by UTC day, so a period is answered in whole days:
    // from the day of `from` to the day of `to`.
    const fromDay = utcDay(new Date(from));
    const toDay = utcDay(new Date(to));
    const startOf = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);
    const days = Math.round((startOf(toDay) - startOf(fromDay)) / DAY_MS) + 1;
    // Refused whole, and never answered in part: an answer that held only the
    // first days of a period would read as the period.
    if (days > CONNECTION_COUNT_MAX_DAYS) throw new AskFailure("range_too_long");
    // The connection is the whole HX Fortress's, and its counts hold every
    // organization's asks. So only the own organization is told them, as in
    // `status`. That goes for the day the counts begin as well: it says since
    // when this HX Fortress has been connected.
    if (!organization.own) return { days: [] };
    const counted = deps.connectionDays(fromDay, toDay);
    const keptFrom = deps.connectionKeptFrom();
    // The days before this run are in a file that could not be read. What the
    // daemon counted since it started is a part of the period, and a part is
    // not answered.
    if (counted === null || keptFrom === null) throw new AskFailure("counts_unreadable");
    return {
      // Before this day nothing is known, which is not the same as nothing
      // having crossed: a reader must be able to tell the two apart.
      keptFrom: `${keptFrom}T00:00:00.000Z`,
      days: counted
        .slice(0, CONNECTION_COUNT_MAX_DAYS)
        .map((day) => ({ ...day, messages: day.messages.slice(0, STATUS_MAX_FRAMES) })),
    };
  }

  async function auditCount(
    args: { from: string; to: string },
    organization: Organization,
  ): Promise<unknown> {
    const [counts, releases] = await Promise.all([
      deps.trail.count(args, organization),
      deps.releases(organization),
    ]);
    return {
      ...counts,
      // Not a count of the period: how many releases wait for a person NOW.
      releasesWaiting: releases.filter((release) => release.state === "waiting").length,
    };
  }

  return {
    id: HOST_MODULE_ID,
    manifest: HOST_MANIFEST,

    // The control plane reaches a module through `onAsk`, behind the gate, and
    // through nothing else. A plain module message is not something this module
    // takes.
    onMessage(): MsgReply {
      return { ok: false, error: "ask_unknown" };
    },

    async onAsk(ask: string, args: unknown, ctx: ModuleContextV2): Promise<unknown> {
      const { organization } = ctx;
      try {
        switch (ask) {
          case "status":
            return await status(organization);
          case "connection.count":
            return connectionCount(args as { from: string; to: string }, organization);
          case "audit.count":
            return await auditCount(args as { from: string; to: string }, organization);
          case "audit.read":
            return await deps.trail.read(
              args as { from: string; to: string; kind?: LineKind; before?: string; limit: number },
              organization,
            );
          default:
            // The gate refuses an ask the manifest does not list before it gets
            // here; this is the same answer for a manifest and a switch that
            // have drifted apart.
            throw new AskFailure("ask_not_implemented");
        }
      } catch (thrown) {
        if (thrown instanceof TrailUnavailable) throw new AskFailure(thrown.code);
        throw thrown;
      }
    },
  };
}
