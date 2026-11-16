// What the control plane may ask HX Fortress about itself.
//
// Four asks, and every field of every reply is here. Read it as the complete
// list of what `host` can tell a control plane: the version of HX Fortress,
// which modules are switched on, which releases wait, how many frames of each
// name crossed the connection on a day, how often each ask was allowed and
// refused, and lines from the audit trail that name who did what. Never what a
// row said.
//
// Pure data, with no imports from the daemon: the terminal and the console read
// this same object to show an operator what may be asked.

import { SESSION_CONTENT_STATES } from "../../cloud/kinds";
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
/**
 * Most entries of `asks` in one `audit.count`: one for each ask that was
 * allowed or refused in the period. A build ships a few dozen asks. Should a
 * period ever hold more different ones than this, the reader counts the rest
 * together under `UNKNOWN_ASK`, so the sums stay right.
 */
export const AUDIT_COUNT_MAX_ASKS = 256;
/** The word for a module or an ask that a record does not name: a refusal made
 *  before this build knew which one was meant. */
export const UNKNOWN_ASK = "unknown";
/**
 * Most UTC days one `connection.count` answers.
 *
 * An answer holds at most 20,000 values (`VALUE_MAX_NODES` in shape.ts). A day
 * on which every frame of the closed list was carried or refused is about 160
 * of them, so 100 days fit and 400 do not. A longer period is refused, never
 * answered in part: the reader asks again for each part.
 */
export const CONNECTION_COUNT_MAX_DAYS = 100;
/** Most releases one `status` lists, newest first. */
export const STATUS_MAX_RELEASES = 100;
/** Most modules one `status` lists. A build ships a handful. */
export const STATUS_MAX_MODULES = 64;
/** Most frames one `status` lists. The protocol has fewer, in both directions. */
export const STATUS_MAX_FRAMES = 64;
export const HOST_MODULE_ID = "host";

/** One frame's counts on one UTC day: its name, its kind and its direction, how
 *  many were carried and how many were not. Counts and names, like every
 *  answer. */
const FRAME_COUNT = S.record({
  kind: S.name,
  frame: S.name,
  direction: S.state("in", "out"),
  count: S.count(),
  refused: S.count(),
});
/** How many frames were dropped without an answer on one UTC day, by reason. */
const DROPPED = S.record({ tooLarge: S.count(), unreadable: S.count(), unknown: S.count() });

export const HOST_MANIFEST: ModuleManifest = {
  id: HOST_MODULE_ID,
  asks: [
    {
      name: "status",
      args: S.none,
      reply: S.record({
        version: S.name,
        // The kind of key store this HX Fortress reads its secrets from, as a
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
        // its kind and its direction.
        connection: S.record({
          sessionContent: S.state(...SESSION_CONTENT_STATES),
          since: S.time,
          messages: S.list(FRAME_COUNT, STATUS_MAX_FRAMES),
          dropped: DROPPED,
        }),
      }),
    },
    {
      // What the connection carried on each UTC day of a period, the oldest
      // day first: for each day what `status` gives for today. `day` is the
      // start of the UTC day. A day on which nothing was counted is left out.
      name: "connection.count",
      args: S.record({ from: S.time, to: S.time }),
      reply: S.record({
        days: S.list(
          S.record({ day: S.time, messages: S.list(FRAME_COUNT, STATUS_MAX_FRAMES), dropped: DROPPED }),
          CONNECTION_COUNT_MAX_DAYS,
        ),
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
        // The two counts of asks again, for each ask by its module and its
        // name. The names are this build's own, or the word `unknown`.
        asks: S.list(
          S.record({ module: S.id, ask: S.name, allowed: S.count(), refused: S.count() }),
          AUDIT_COUNT_MAX_ASKS,
        ),
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
