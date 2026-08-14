// The CommandGateway backed by the fortress Postgres.
//
// Reads go straight at the table (the daemon holds SELECT); every WRITE goes
// through a SECURITY DEFINER routine, because the daemon's role holds neither
// INSERT nor UPDATE here. That is not a convention this file could choose to
// break: a direct UPDATE from this connection is refused by the server.

import { sql } from "drizzle-orm";

import type { CommandGateway, CommandRow } from "./commands";
import type { HxDb } from "../host/postgres/db";

interface RawCommand {
  id: string;
  kind: string;
  params: unknown;
  status: string;
  requested_at: string | Date;
  deadline_at: string | Date | null;
  credential_ref: string | null;
}

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const wrapped = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}

function asDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function firstBoolean(result: unknown): boolean {
  const row = rows<Record<string, unknown>>(result)[0];
  if (!row) return false;
  return Object.values(row)[0] === true;
}

/** Refused by name, on a Postgres this fortress does not own.
 *
 *  The five SECURITY DEFINER routines are created by `ensureAppRoles`, which is
 *  wired only into the EMBEDDED path — there is no role split on an operator's
 *  own database, so nothing creates them there. The gateway called them anyway:
 *  every claim raised `42883 function hx.claim_command does not exist`, every
 *  poll pass swallowed it, and commands minted from the console sat at
 *  `requested` until their deadline while the daemon reported healthy. An
 *  operator watching a console that accepts a command and never runs it has no
 *  way to learn why.
 *
 *  So the plane says what is true: it cannot run commands here. Reads are
 *  unaffected — the console's whole read surface works on an external DSN — and
 *  ingest is untouched, which is why this refuses rather than failing boot. */
export function createUnavailableCommandGateway(): CommandGateway {
  return {
    // Nothing to list, nothing claimable. Every arm answers falsely-quiet rather
    // than throwing, because the poll loop swallows throws — which is exactly how
    // this stayed invisible — and a refusal an operator can read belongs on the
    // console's status surface, not in a log line nobody opens.
    listOpen: () => Promise.resolve([]),
    claim: () => Promise.resolve(false),
    complete: () => Promise.resolve(false),
    reject: () => Promise.resolve(false),
  };
}

/** `params` is a jsonb column, and Bun.SQL — the driver under this handle —
 *  hands jsonb back as the raw JSON TEXT rather than a parsed value. The
 *  validator's first test is `typeof params === "object"`, so every command the
 *  console minted was rejected with `rejected_invalid_params: params must be an
 *  object` about a value that WAS an object, and the panel that shows "the
 *  daemon's answer, not this request's success" showed nothing at all. Parse at
 *  this boundary — the one place that knows it is talking to a database — and
 *  leave the validator's contract strict.
 *
 *  A row whose text does not parse is passed through UNCHANGED so the validator
 *  rejects it by its own rules, rather than being turned into a throw that would
 *  take down the whole poll for one bad row. */
function decodeParams(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function createCommandGateway(db: HxDb): CommandGateway {
  return {
    async listOpen(): Promise<CommandRow[]> {
      const result = await db.execute(
        sql`SELECT id, kind, params, status, requested_at, deadline_at, credential_ref
              FROM hx.console_commands
             WHERE status IN ('requested', 'running')
             ORDER BY requested_at ASC`,
      );
      return rows<RawCommand>(result).map((row) => ({
        id: String(row.id),
        kind: row.kind,
        params: decodeParams(row.params),
        status: row.status,
        requestedAt: asDate(row.requested_at),
        deadlineAt: row.deadline_at === null ? null : asDate(row.deadline_at),
        credentialRef: row.credential_ref,
      }));
    },

    async claim(id: string, claimedBy: string, redrive: boolean): Promise<boolean> {
      return firstBoolean(
        await db.execute(
          sql`SELECT hx.claim_command(${id}::uuid, ${claimedBy}, ${redrive}) AS claimed`,
        ),
      );
    },

    async complete(
      id: string,
      status: "done" | "failed",
      outcome: string | null,
      error: string | null,
    ): Promise<boolean> {
      return firstBoolean(
        await db.execute(
          sql`SELECT hx.complete_command(${id}::uuid, ${status}, ${outcome}, ${error}) AS completed`,
        ),
      );
    },

    async reject(id: string, reason: string): Promise<boolean> {
      return firstBoolean(
        await db.execute(sql`SELECT hx.reject_command(${id}::uuid, ${reason}) AS rejected`),
      );
    },
  };
}
