// The built-in `host` module: the Fortress answering the control plane about itself.
//
// It ships in every build and, like every module, is OFF until somebody on this
// host switches it on (`hx-fortress modules on host`). Switched on, it answers
// three asks — `status`, `audit.count`, `audit.read` — and what each may say is
// fixed by the manifest beside this file.
//
// It reads, and only reads: the shelf file, config.json, and the audit trail.
// It calls nothing on the network and holds no secret.

import {
  AskFailure,
  type FortressModule,
  type ReleaseRecord,
} from "../../host/module-contract";
import type { MsgReply } from "../../protocol";
import { TrailUnavailable, type AuditTrail } from "./audit-trail";
import {
  HOST_MANIFEST,
  HOST_MODULE_ID,
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
   *  on, and its version. */
  modules: () => Promise<{ id: string; on: boolean; version: string }[]>;
  /** The release shelf, newest offer first. */
  releases: () => Promise<ReleaseRecord[]>;
  trail: AuditTrail;
}

/** The id of the Sessions module. `status` reports as a flag whether this
 *  running Fortress stores sessions. */
const SESSIONS_MODULE_ID = "session_vault";

export function createHostModule(deps: HostModuleDeps): FortressModule {
  async function status(): Promise<unknown> {
    const [modules, releases] = await Promise.all([deps.modules(), deps.releases()]);
    // No guess when the setting cannot be read: "env" would be a statement about
    // where this customer's keys are, and it would be wrong.
    const secrets = await deps.secretsKind().catch(() => {
      throw new AskFailure("secrets_setting_invalid");
    });
    return {
      version: deps.version,
      secrets,
      sessions: modules.some((module) => module.id === SESSIONS_MODULE_ID && module.on),
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

  async function auditCount(args: { from: string; to: string }): Promise<unknown> {
    const [counts, releases] = await Promise.all([deps.trail.count(args), deps.releases()]);
    return {
      ...counts,
      // Not a count of the period: how many releases wait for a person NOW.
      releasesWaiting: releases.filter((release) => release.state === "waiting").length,
    };
  }

  return {
    id: HOST_MODULE_ID,
    manifest: HOST_MANIFEST,

    // The relay reaches a module through `onAsk`, behind the gate, and through
    // nothing else. A plain module message is not something this module takes.
    onMessage(): MsgReply {
      return { ok: false, error: "ask_unknown" };
    },

    async onAsk(ask: string, args: unknown): Promise<unknown> {
      try {
        switch (ask) {
          case "status":
            return await status();
          case "audit.count":
            return await auditCount(args as { from: string; to: string });
          case "audit.read":
            return await deps.trail.read(
              args as { from: string; to: string; kind?: LineKind; before?: string; limit: number },
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
