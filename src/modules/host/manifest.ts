// What the control plane may ask HX Fortress about itself.
//
// Four asks, and every field of every reply is here. Read it as the complete
// list of what `host` can tell a control plane: the HX Fortress version, which
// modules are switched on, which releases wait, lines from the audit trail that
// name who did what — never what a row said — and, for each role, how many
// people hold it and through which group of the identity provider — never who
// they are.
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
/** Most releases one `status` lists, newest first. */
export const STATUS_MAX_RELEASES = 100;
/** Most modules one `status` lists. A build ships a handful. */
export const STATUS_MAX_MODULES = 64;
/** Most frames one `status` lists. The protocol has fewer, in both directions. */
export const STATUS_MAX_FRAMES = 64;

/**
 * What a person may be, as the rows of `access.groups` name it. People are
 * named Administrators, Operators, Auditors and Viewers. An account is
 * `operator`, `readonly` or `viewer`. `administrator` is only ever the role of
 * a row for a group of the identity provider's administrators' list, whose
 * members are `operator` in this build.
 */
export const ACCESS_ROLES = ["administrator", "operator", "readonly", "viewer"] as const;
export type AccessRole = (typeof ACCESS_ROLES)[number];

/** How `access.groups` counted: the accounts on this HX Fortress, or, with
 *  sign-in through the identity provider on, the people who signed in. */
export const COUNTED_FROM = ["accounts", "sign-ins"] as const;
export type CountedFrom = (typeof COUNTED_FROM)[number];

/**
 * Most rows one `access.groups` lists: one for each group of each of the four
 * lists of the identity provider's mapping, and a list holds at most 50 groups
 * (`MAX_GROUPS` in src/ui/oidc-config.ts). This file imports nothing from the
 * daemon, so the number is written here, and a test ties it to that one.
 */
export const ACCESS_MAX_ROWS = 4 * 50;
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
    {
      // Who holds each role, as counts. A row names a group of the identity
      // provider only when the name may cross: the groups claim is a claim of
      // groups or roles, the name is a name, and it holds no "@". Otherwise the
      // row says the group is hidden. No field holds a login, an address or a
      // subject. See access.ts.
      name: "access.groups",
      args: S.none,
      reply: S.record({
        roles: S.list(
          S.record(
            {
              role: S.state(...ACCESS_ROLES),
              group: S.name,
              groupHidden: S.flag,
              seesRows: S.flag,
              people: S.count(),
            },
            ["group", "groupHidden"],
          ),
          ACCESS_MAX_ROWS,
        ),
        // Each role once, each person counted once: a person in two groups of
        // one role counts in both of its rows, and once here.
        holders: S.list(
          S.record({ role: S.state(...ACCESS_ROLES), seesRows: S.flag, people: S.count() }),
          ACCESS_ROLES.length,
        ),
        countedFrom: S.state(...COUNTED_FROM),
        // With "sign-ins": since when sign-ins are counted, and how many
        // accounts on HX Fortress can sign in with a password beside the
        // provider. Neither is a person.
        since: S.time,
        accounts: S.count(),
      }, ["since", "accounts"]),
    },
  ],
  // The host module calls nothing and reads no secret.
  egress: [],
  secrets: [],
};
