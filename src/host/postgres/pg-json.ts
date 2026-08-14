// <root>/ui/pg.json — the ONLY place the console learns how to reach Postgres.
//
// The daemon rewrites it every boot from its own resolved configuration, so an
// env-sourced port (FORTRESS_PG_PORT) reaches the console without the console
// carrying any environment of its own. It holds hx_ui credentials only: the
// console never sees the superuser or the daemon's write role, which is what
// keeps a console compromise inside the console's own privilege matrix.

import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { PG_UI_ROLE } from "./console-plane";

export interface EmbeddedPgJson {
  mode: "embedded";
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface ExternalPgJson {
  mode: "external";
  /** The operator's effective DSN. External Postgres has no role split, so the
   *  console connects exactly as the daemon does — the banner says so. */
  databaseUrl: string;
}

export type PgJson = EmbeddedPgJson | ExternalPgJson;

/** Atomic 0600 write into an owner-only directory. */
async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, filePath);
}

export async function writePgJson(filePath: string, value: PgJson): Promise<void> {
  await writeJsonFile(filePath, value);
}

export function embeddedPgJson(args: {
  host: string;
  port: number;
  database: string;
  password: string;
}): EmbeddedPgJson {
  return {
    mode: "embedded",
    host: args.host,
    port: args.port,
    database: args.database,
    user: PG_UI_ROLE,
    password: args.password,
  };
}

export async function readPgJson(filePath: string): Promise<PgJson | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Record<string, unknown>;
    if (value.mode === "external") {
      return typeof value.databaseUrl === "string" && value.databaseUrl
        ? { mode: "external", databaseUrl: value.databaseUrl }
        : null;
    }
    if (value.mode !== "embedded") return null;
    if (
      typeof value.host !== "string" ||
      typeof value.port !== "number" ||
      typeof value.database !== "string" ||
      typeof value.user !== "string" ||
      typeof value.password !== "string"
    ) {
      return null;
    }
    return {
      mode: "embedded",
      host: value.host,
      port: value.port,
      database: value.database,
      user: value.user,
      password: value.password,
    };
  } catch {
    return null;
  }
}

/**
 * The console's DSN, from pg.json and ui.json ONLY.
 *
 * PURE and total: it never reads roles.json (those are the daemon's secrets,
 * including the superuser's), never mints a credential, and returns null rather
 * than inventing a connection when neither file says anything.
 *
 * Precedence is pinned: an explicit `ui.json.databaseUrl` wins over pg.json in
 * BOTH modes. An operator who set one has said which database the console is to
 * use, and silently preferring the embedded coordinates would send the console
 * at a different database than the one they configured.
 */
export function resolveRoleDsn(args: {
  pgJson: PgJson | null;
  uiDatabaseUrl?: string | null;
}): string | null {
  const configured = args.uiDatabaseUrl?.trim();
  if (configured) return configured;
  const pg = args.pgJson;
  if (!pg) return null;
  if (pg.mode === "external") return pg.databaseUrl || null;
  return `postgresql://${encodeURIComponent(pg.user)}:${encodeURIComponent(pg.password)}@${pg.host}:${pg.port}/${encodeURIComponent(pg.database)}`;
}

/** A DSN with its password replaced by `***`, for printing. The only form of a
 *  DSN that may reach stdout, a log or a rendered page. */
export function maskDsn(dsn: string): string {
  try {
    const url = new URL(dsn);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    // Fail CLOSED. This is the only printable form of a DSN, so a value that
    // cannot be parsed cannot be partially redacted either — echoing it on the
    // chance that it holds no password is the wrong side to err on.
    return "(unparseable connection string — redacted)";
  }
}
