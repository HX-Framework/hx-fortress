// The real ConsoleWritePort: the console's two ways of changing something.
//
// The command INSERT lives here and nowhere else. It runs as the console role,
// which is the only principal in the system holding INSERT on the table — the
// daemon's own write role does not, so a Postgres-level adversary with the
// daemon's authority cannot ask the daemon for a self-update, a rotation or a
// migration. Keeping the statement in one file is what makes that claim
// checkable.

import { sql } from "drizzle-orm";

import { mintCredentialRef, writeCredentialRef } from "../console/cmd-creds";
import { COMMAND_REQUEST_TTL_MS } from "../console/commands";
import { CONTAINER_SERVICE_REFUSAL, type ConsoleWritePort, type ServiceAction, type ServiceResult } from "./mutate-routes";
import type { CommandParams } from "../console/command-params";
import type { ConsoleCommandKind } from "../host/postgres/console-plane";
import type { HxDb } from "../host/postgres/db";
import type { ServiceManager } from "../service";

export interface ConsoleWritePortOptions {
  /** The daemon's own unit. Null under an orchestrator, which owns the
   *  lifecycle instead. */
  service: ServiceManager | null;
  serviceLogPath: string;
  db: () => HxDb | null;
  /** The heartbeat the poller check reads. */
  heartbeatAt: () => Promise<string | null>;
  offered: readonly ConsoleCommandKind[];
  /** Where the 0600 single-use credential files live. */
  cmdCredsDir: string;
}

export function createConsoleWritePort(options: ConsoleWritePortOptions): ConsoleWritePort {
  const service = options.service;
  return {
    serviceRefusal(): string | null {
      return service ? null : CONTAINER_SERVICE_REFUSAL;
    },

    async service(action: ServiceAction): Promise<ServiceResult> {
      if (!service) throw new Error(CONTAINER_SERVICE_REFUSAL);
      switch (action) {
        case "stop": {
          const before = await service.stop();
          return {
            action,
            manager: service.name,
            pid: null,
            copy: before.wasRunning
              ? "Fortress stopped. This console keeps answering; every panel that needs the daemon now says so."
              : "Fortress was not running. Nothing changed.",
          };
        }
        case "start":
        case "restart": {
          const unit = await service.unit();
          if (!unit.present) {
            throw new Error(
              "this fortress has no service unit, so there is nothing to start from here. " +
                "Run `hx-fortress start` on the host.",
            );
          }
          // Never re-rendered from the console: the unit names a binary and an
          // environment this process did not choose, and rewriting it would
          // retarget the service at whatever is serving the console.
          await service.ensureLogDir(options.serviceLogPath);
          if (action === "restart") await service.restart();
          else await service.start();
          const state = await service.state();
          return {
            action,
            manager: service.name,
            pid: state.pid,
            copy:
              state.pid !== null
                ? `Fortress ${action === "restart" ? "restarted" : "started"} (pid ${state.pid}).`
                : "Fortress loaded. It will come up on its own; this page follows it.",
          };
        }
      }
    },

    heartbeatAt: options.heartbeatAt,

    offered(): readonly ConsoleCommandKind[] {
      return options.offered;
    },

    async mintCredential(payload: unknown): Promise<string> {
      const ref = mintCredentialRef();
      await writeCredentialRef(options.cmdCredsDir, ref, payload);
      return ref;
    },

    async submit(
      kind: ConsoleCommandKind,
      params: CommandParams,
      requestedBy: string,
      credentialRef: string | null = null,
    ): Promise<{ id: string }> {
      const db = options.db();
      if (!db) throw new Error("this console cannot reach the fortress database, so it cannot ask the daemon for anything");
      const deadline = new Date(Date.now() + COMMAND_REQUEST_TTL_MS).toISOString();
      // credential_ref is NAMED here because it is the column the daemon reads.
      // Omitted, every rotation and every migration arm and swap reached its
      // executor with a null reference and failed on it.
      const result = await db.execute(
        sql`INSERT INTO hx.console_commands (kind, params, requested_by, deadline_at, credential_ref)
            VALUES (${kind}, ${JSON.stringify(params)}::jsonb, ${requestedBy}, ${deadline}::timestamptz, ${credentialRef})
            RETURNING id`,
      );
      const rows = Array.isArray(result)
        ? (result as Array<{ id: unknown }>)
        : (((result as { rows?: unknown[] } | null)?.rows ?? []) as Array<{ id: unknown }>);
      const id = rows[0]?.id;
      if (typeof id !== "string") throw new Error("the fortress database accepted no request row");
      return { id };
    },
  };
}
