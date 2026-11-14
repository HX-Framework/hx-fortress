// The built-in `host` module: the Fortress answering the control plane about itself.
//
// It ships in every build and, like every module, is OFF until somebody on this
// host switches it on (`hx-fortress modules on host`). Switched on, it answers
// three asks — `status`, `audit.count`, `audit.read` — and what each may say is
// fixed by the manifest beside this file.
//
// It reads, and only reads: the shelf file, config.json, and the audit trail.
// It calls nothing on the network and holds no secret.
//
// EACH ANSWER IS ABOUT ONE ORGANIZATION: the one the ask was for. A fortress
// that holds one organization is asked about that one, and answers as it always
// did. Where a fortress holds more, an ask for another organization is told
// that organization's records and switches and nothing of anybody else's: not
// the fortress's own releases, not its sign-ins, not its commands. What every
// organization is told alike is what is true of the place its data rests in:
// the fortress's version, the kind of its key store, and the version of each
// module.

import {
  AskFailure,
  type FortressModule,
  type ModuleContextV2,
  type ReleaseRecord,
} from "../../host/module-contract";
import type { ConnectionView } from "../../cloud/counts";
import type { Organization } from "../../host/organization-id";
import type { MsgReply } from "../../protocol";
import { TrailUnavailable, type AuditTrail } from "./audit-trail";
import {
  HOST_MANIFEST,
  HOST_MODULE_ID,
  STATUS_MAX_FRAMES,
  STATUS_MAX_MODULES,
  STATUS_MAX_RELEASES,
  type LineKind,
} from "./manifest";

export interface HostModuleDeps {
  /** The Fortress version. */
  version: string;
  /** The kind of key store this running Fortress reads its secrets from, as
   *  the store names itself ("env", "file", "azure-key-vault"). Rejects while
   *  the secrets setting cannot be read. */
  secretsKind: () => Promise<string>;
  /** Every module this build ships, with whether this running Fortress has it
   *  on for the organization, and its version. */
  modules: (organization: Organization) => Promise<{ id: string; on: boolean; version: string }[]>;
  /** The release shelf as the organization may see it, newest offer first. A
   *  release for a module is for the whole Fortress, so the shelf is the own
   *  organization's and another organization sees none of it. */
  releases: (organization: Organization) => Promise<ReleaseRecord[]>;
  /** What the connection may carry, and what it carried today. */
  connection: () => ConnectionView;
  trail: AuditTrail;
}

/** The id of the Sessions module. `status` reports as a flag whether this
 *  running Fortress stores sessions. */
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
    // The connection is the whole Fortress's, and its counts hold every
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
