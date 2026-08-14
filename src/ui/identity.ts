// The identity and path facts every Ops, Logs and Health panel renders from.
//
// It exists because those panels used to hardcode their answers. A path printed
// as `~/.let/hx-fortress/logs/fortress.jsonl` is wrong on every container and on
// every host that sets FORTRESS_ROOT, and a hardcoded path is wrong SILENTLY -
// the operator opens a file that does not exist and concludes the fortress is
// not logging.
//
// The retention lines are DERIVED for the same reason, and they are the two
// facts most often invented. Log retention is whatever the size rotation
// actually does - N megabytes across M segments - read from the same functions
// the writer reads. Audit retention is "the life of the database", because no
// delete sweep exists anywhere in the system and no role holds DELETE on the
// table: that absence is what makes a drained record evidence, so a retention
// figure here would be describing a mechanism whose absence is the guarantee.

import { stat } from "node:fs/promises";

import { PG_APP_RO_ROLE, PG_APP_RW_ROLE, PG_READONLY_ROLE, PG_ROLE } from "../host/postgres/cluster-roles";
import { PG_CMD_OWNER_ROLE, PG_UI_ROLE } from "../host/postgres/console-plane";
import type { fortressPaths } from "../host/paths";
import { rotateKeepFromEnv, rotateSizeFromEnv } from "../log-tail";
import type { CloudCredential } from "../cloud/credentials";
import { compareRoots, type RootMatch } from "../daemon-state";

type FortressPaths = ReturnType<typeof fortressPaths>;

export interface ProvisionedRole {
  name: string;
  what: string;
}

/** The roles an embedded cluster carries. An external database has none of them
 *  - the operator's single DSN is the whole story, which the banner states. */
export const EMBEDDED_ROLES: readonly ProvisionedRole[] = [
  { name: PG_ROLE, what: "bootstrap superuser - DDL, migrations, extensions, role management" },
  { name: PG_APP_RW_ROLE, what: "the daemon's write role, and the one reachable from the cloud" },
  { name: PG_APP_RO_ROLE, what: "the MCP read-tool role" },
  { name: PG_READONLY_ROLE, what: "schema-wide SELECT, held by the read role" },
  { name: PG_UI_ROLE, what: "the console login role - the only minter of commands" },
  { name: PG_CMD_OWNER_ROLE, what: "NOLOGIN owner of the command transition routines" },
];

export interface RetentionLines {
  logs: string;
  auditTrail: string;
}

/** What the size rotation actually keeps. Read from the same env-backed helpers
 *  the log writer uses, so the sentence cannot drift from the behaviour. */
export function logRetentionLine(env: Record<string, string | undefined> = process.env): string {
  const bytes = rotateSizeFromEnv(env);
  const keep = rotateKeepFromEnv(env);
  const mb = Math.round((bytes / (1024 * 1024)) * 10) / 10;
  return `the last ${mb} MB across ${keep} rotated segments (${keep + 1} files, oldest discarded)`;
}

/** No sweep exists, and no role holds DELETE. Stating a number here would be
 *  describing a mechanism whose ABSENCE is the tamper fence. */
export const AUDIT_RETENTION_LINE =
  "retained for the life of the database - there is no delete sweep, and no role holds DELETE on the " +
  "audit table. That absence is what makes a drained record evidence.";

export function retentionLines(env: Record<string, string | undefined> = process.env): RetentionLines {
  return { logs: logRetentionLine(env), auditTrail: AUDIT_RETENTION_LINE };
}

export interface IdentityFacts {
  /** Null before enrollment. Never the credential itself. */
  fortressId: string | null;
  boundOrgId: string | null;
  /** When the credential file was last written. The nearest honest answer to
   *  "enrolled at": no column records the enrollment instant, and inventing one
   *  from a first-seen timestamp would be a different fact wearing its name. */
  credentialWrittenAt: string | null;
  /** The resolved root - what this process actually reads and writes. */
  root: string;
  /** The root the daemon published, and whether it is the same DIRECTORY. */
  daemonRoot: string | null;
  rootMatch: RootMatch;
  paths: Record<string, string>;
  roles: readonly ProvisionedRole[];
  postgresMode: "embedded" | "external" | "unknown";
  retention: RetentionLines;
}

export interface IdentityFactsDeps {
  paths: FortressPaths;
  credentials: CloudCredential | null;
  /** host.root from status.json, when the daemon published one. */
  daemonRoot?: string | null;
  postgresMode?: "embedded" | "external" | "unknown";
  env?: Record<string, string | undefined>;
  /** Injected in tests. */
  mtimeOf?: (file: string) => Promise<string | null>;
}

async function fileMtime(file: string): Promise<string | null> {
  try {
    return (await stat(file)).mtime.toISOString();
  } catch {
    return null;
  }
}

export async function readIdentityFacts(deps: IdentityFactsDeps): Promise<IdentityFacts> {
  const { paths } = deps;
  const mode = deps.postgresMode ?? "unknown";
  const mtime = deps.mtimeOf ?? fileMtime;
  return {
    fortressId: deps.credentials?.fortressId ?? null,
    boundOrgId: deps.credentials?.orgId ?? null,
    credentialWrittenAt: deps.credentials ? await mtime(paths.credentials) : null,
    root: paths.root,
    daemonRoot: deps.daemonRoot ?? null,
    rootMatch: await compareRoots(paths.root, deps.daemonRoot ?? undefined),
    // Every path a panel used to hardcode, resolved from the same function the
    // daemon and the CLI resolve theirs from.
    paths: {
      root: paths.root,
      log: paths.log,
      serviceLog: paths.serviceLog,
      status: paths.status,
      credentials: paths.credentials,
      consoleConfig: paths.uiConfig,
      databaseCoordinates: paths.pgJson,
      runtime: paths.runtimeRoot,
      auditSpool: paths.auditSpool,
      postgresData: paths.defaultPgData,
    },
    roles: mode === "external" ? [] : EMBEDDED_ROLES,
    postgresMode: mode,
    retention: retentionLines(deps.env ?? process.env),
  };
}
