// What the control plane may ask the Fortress about itself.
//
// Three asks, and every field of every reply is here. Read it as the complete
// list of what `host` can tell a control plane: the Fortress's version, which modules
// are switched on, which releases wait, and lines from the audit trail that
// name who did what — never what a row said.
//
// Pure data, with no imports from the daemon: the terminal and the console read
// this same object to show an operator what may be asked.

import type { ModuleManifest } from "../../host/module-contract";
import { RELEASE_STATES } from "../../host/module-contract";
import { S } from "../../host/shape";

/** What kind of actor an audit line names. */
export const ACTOR_KINDS = ["person", "control_plane", "fortress", "job"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** How an audit line ended. */
export const LINE_OUTCOMES = ["ok", "refused", "failed"] as const;
export type LineOutcome = (typeof LINE_OUTCOMES)[number];

/** The kinds of line `audit.read` can be narrowed to. */
export const LINE_KINDS = ["ask", "release", "module", "sign_in", "command", "other"] as const;
export type LineKind = (typeof LINE_KINDS)[number];

/** Most lines one `audit.read` returns. */
export const AUDIT_READ_MAX_LINES = 100;
/** Most releases one `status` lists, newest first. */
export const STATUS_MAX_RELEASES = 100;
/** Most modules one `status` lists. A build ships a handful. */
export const STATUS_MAX_MODULES = 64;
/** Most frames one `status` lists. The protocol has fewer, in both directions. */
export const STATUS_MAX_FRAMES = 64;
/** Whether session content may travel on the connection, as `status` says it.
 *  `not_set` is a fortress where nobody chose: see src/cloud/kinds.ts. */
export const SESSION_CONTENT_STATES = ["on", "off", "not_set"] as const;

export const HOST_MODULE_ID = "host";

export const HOST_MANIFEST: ModuleManifest = {
  id: HOST_MODULE_ID,
  asks: [
    {
      name: "status",
      args: S.none,
      reply: S.record({
        version: S.name,
        // The kind of key store this Fortress reads its secrets from, as a
        // name: "env", "file" or "azure-key-vault" today. It is a name and not
        // one word from a fixed list, so a key store that a later build adds
        // changes nothing in the shape of this answer, here or on the control
        // plane's side.
        secrets: S.name,
        sessions: S.flag,
        modules: S.list(S.record({ id: S.id, on: S.flag, version: S.name }), STATUS_MAX_MODULES),
        releases: S.list(
          S.record(
            {
              id: S.id,
              module: S.id,
              version: S.name,
              state: S.state(...RELEASE_STATES),
              offeredAt: S.time,
              decidedAt: S.time,
            },
            ["decidedAt"],
          ),
          STATUS_MAX_RELEASES,
        ),
        // What the connection to the control plane may carry, and what it
        // carried since the start of this UTC day: each frame by its name, with
        // its kind and its direction. Counts and names, like every answer.
        connection: S.record({
          sessionContent: S.state(...SESSION_CONTENT_STATES),
          since: S.time,
          messages: S.list(
            S.record({
              kind: S.name,
              frame: S.name,
              direction: S.state("in", "out"),
              count: S.count(),
              refused: S.count(),
            }),
            STATUS_MAX_FRAMES,
          ),
          dropped: S.record({ tooLarge: S.count(), unreadable: S.count(), unknown: S.count() }),
        }),
      }),
    },
    {
      name: "audit.count",
      args: S.record({ from: S.time, to: S.time }),
      reply: S.record({
        asksAllowed: S.count(),
        asksRefused: S.count(),
        releasesInstalled: S.count(),
        releasesWaiting: S.count(),
        signIns: S.count(),
      }),
    },
    {
      name: "audit.read",
      args: S.record(
        {
          from: S.time,
          to: S.time,
          kind: S.state(...LINE_KINDS),
          before: S.id,
          limit: S.count(AUDIT_READ_MAX_LINES),
        },
        ["kind", "before"],
      ),
      reply: S.record(
        {
          lines: S.list(
            S.record({
              id: S.id,
              at: S.time,
              actorKind: S.state(...ACTOR_KINDS),
              actor: S.name,
              action: S.name,
              target: S.name,
              outcome: S.state(...LINE_OUTCOMES),
            }),
            AUDIT_READ_MAX_LINES,
          ),
          next: S.id,
        },
        ["next"],
      ),
    },
  ],
  // The host module calls nothing and reads no secret.
  egress: [],
  secrets: [],
};
