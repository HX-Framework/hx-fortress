// The Fortress Checkup: six probes, each reporting what it actually observed.
//
// The rule that shapes every probe below is that a verdict names its evidence.
// "Healthy" with nothing behind it is what a status page says; this says which
// thing answered, and a probe that could not run says so rather than passing.
//
// It runs on the DAEMON, because that is where the handles are: the store, the
// database, the tunnel. The console asks for it and renders the answer.

import { heartbeatFresh } from "./commands";
import type { HostStatusSnapshot } from "../host/types";
import type { SessionStore } from "../modules/session-vault/store/types";
import type { HxDb } from "../host/postgres/db";
import type { ServiceManager } from "../service";

export type ProbeVerdict = "ok" | "degraded" | "failed" | "not-configured";

export interface ProbeResult {
  name: string;
  verdict: ProbeVerdict;
  detail: string;
}

export interface CheckupDeps {
  service: ServiceManager;
  status: () => Promise<HostStatusSnapshot | null>;
  db: () => HxDb | null;
  store: () => SessionStore | null;
  /** The embedding endpoint this fortress is configured with, or null. */
  embeddingEndpoint: () => string | null;
  now?: () => Date;
}

/** One line per probe, in the order an operator reads them: what runs it, what
 *  it says about itself, what it stores into, what it writes to, what it
 *  embeds with, and who it talks to. */
export async function runCheckup(deps: CheckupDeps): Promise<ProbeResult[]> {
  const now = (deps.now ?? ((): Date => new Date()))();
  const results: ProbeResult[] = [];

  results.push(await probe("service", async () => {
    const state = await deps.service.state();
    const unit = await deps.service.unit();
    if (!unit.present) {
      return {
        verdict: "degraded" as const,
        detail: "running without a service unit — nothing restarts this fortress if it exits",
      };
    }
    return state.pid !== null
      ? { verdict: "ok" as const, detail: `${deps.service.name}, pid ${state.pid}` }
      : { verdict: "degraded" as const, detail: `${deps.service.name} reports no running process` };
  }));

  const snapshot = await deps.status().catch(() => null);
  results.push({
    name: "status snapshot",
    ...(snapshot === null
      ? { verdict: "failed" as const, detail: "no status file — this daemon has published nothing" }
      : heartbeatFresh(snapshot.host.writtenAt, now)
        ? { verdict: "ok" as const, detail: `heartbeat written ${snapshot.host.writtenAt ?? "just now"}` }
        : {
            verdict: "degraded" as const,
            detail: `heartbeat is stale (last written ${snapshot.host.writtenAt ?? "before this build"})`,
          }),
  });

  results.push(await probe("postgres", async () => {
    const db = deps.db();
    if (!db) return { verdict: "failed" as const, detail: "no database handle — Postgres is not ready" };
    await db.execute("SELECT 1" as never);
    return { verdict: "ok" as const, detail: "answered a query" };
  }));

  results.push(await probe("object store", async () => {
    const store = deps.store();
    if (!store) return { verdict: "failed" as const, detail: "the vault store is not initialized" };
    // A real write and delete against the real bucket — the only probe that
    // proves the write path, which is what stayed silently wedged for three
    // hours while every read-backed panel showed green.
    await store.selfTest();
    return { verdict: "ok" as const, detail: "wrote and removed a probe object" };
  }));

  const endpoint = deps.embeddingEndpoint();
  results.push({
    name: "embeddings",
    ...(endpoint
      ? {
          verdict: "ok" as const,
          detail: `configured against ${endpoint} — reachability is proven by the embed worker's own runs, not by this probe`,
        }
      : {
          verdict: "not-configured" as const,
          detail: "no embedding endpoint — semantic search falls back to keyword",
        }),
  });

  results.push({
    name: "relay tunnel",
    ...(snapshot === null
      ? { verdict: "failed" as const, detail: "no status file to read the connection from" }
      : snapshot.connection.state === "connected"
        ? { verdict: "ok" as const, detail: "connected to let.ai" }
        : {
            verdict: "degraded" as const,
            detail: `${snapshot.connection.state}${snapshot.connection.reason ? ` — ${snapshot.connection.reason}` : ""}`,
          }),
  });

  return results;
}

async function probe(
  name: string,
  work: () => Promise<{ verdict: ProbeVerdict; detail: string }>,
): Promise<ProbeResult> {
  try {
    return { name, ...(await work()) };
  } catch (error) {
    return {
      name,
      verdict: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The one-line summary a command outcome carries. Every probe appears, with
 *  its own verdict — a summary that dropped the failures would be a claim the
 *  checkup did not make. */
export function summarizeCheckup(results: readonly ProbeResult[]): string {
  return results.map((r) => `${r.name}: ${r.verdict} (${r.detail})`).join(" · ");
}
