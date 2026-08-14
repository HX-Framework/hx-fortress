// E2E outage drill — the Aug-2026 incident, reproduced live and healed.
// NOT part of the shipped test suite (it drives Docker): run manually with
//   bun drill.ts
// against the pg-ci-fortress container. It composes the REAL production
// modules — buildPostgresProvider (external mode, all 14 real migrations),
// createGuardedDb, handleVaultRpc + ingestCommit, purge — over the real driver
// and a real network fault (docker pause = frozen peer: connects that
// accept-then-hang, established sockets that black-hole — the incident shape).

import { execSync } from "node:child_process";

import { buildPostgresProvider } from "./src/host/postgres";
import { createGuardedDb } from "./src/host/postgres/guarded-db";
import { handleVaultRpc } from "./src/modules/session-vault/store/rpc";
import type { SessionStore } from "./src/modules/session-vault/store/types";
import type { IngestAttribution } from "./src/ingest/ingest";
import type { ScopedLogger } from "./src/host/types";

const CONTAINER = "pg-ci-fortress";
const DSN = "postgresql://postgres:hx@127.0.0.1:5498/postgres";

process.env.FORTRESS_DB_RPC_DEADLINE_MS = "4000"; // drill-speed 25 s analog

const results: { step: string; ok: boolean; detail: string }[] = [];
function record(step: string, ok: boolean, detail = ""): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
}

function docker(cmd: string): void {
  execSync(`docker ${cmd} ${CONTAINER}`, { stdio: "ignore" });
}

const log = (scope: string): ScopedLogger => ({
  debug: () => {},
  info: (m, f) => console.log(`   [${scope}] ${m}`, f ?? ""),
  warn: (m, f) => console.log(`   [${scope}] WARN ${m}`, f ?? ""),
  error: (m, f) => console.log(`   [${scope}] ERROR ${m}`, f ?? ""),
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ATTR: IngestAttribution = {
  orgExternalId: "org-drill",
  projectExternalId: null,
  repoSlug: "let-ai/drill",
  deviceId: null,
};

function chunk(text: string, ts: string): string {
  return [
    JSON.stringify({ type: "user", message: { role: "user", content: text }, timestamp: ts }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: `re: ${text}` }], model: "claude-fable-5" },
      timestamp: ts,
    }),
  ].join("\n");
}

function ingestReq(sessionId: string, chunkId: string) {
  return {
    method: "ingestCommit" as const,
    key: { userId: "drill-user", family: "claude-cli", sessionId },
    chunkId,
    replace: false,
    chunkText: chunk(`hello from ${sessionId}`, "2026-08-04T10:00:00Z"),
    totalBytes: 100,
    componentCount: 1,
    meta: { title: `Drill ${sessionId}` },
    attribution: ATTR,
  };
}

const noopStore = {
  deleteSession: async () => ({ complete: true, deleted: 0 }),
} as unknown as SessionStore;

async function main(): Promise<void> {
  docker("unpause 2>/dev/null || true"); // clean slate if a prior run died paused

  // ── Phase 0: provider boots against a PAUSED database — the dsn-null-forever fix.
  console.log("\n━━ Phase 0: boot while the database is DOWN (provider re-probe) ━━");
  docker("pause");
  const provider = buildPostgresProvider({
    env: { FORTRESS_DATABASE_URL: DSN },
    config: {
      schemaVersion: 1,
      cloud: { url: "" },
      gateway: { publicUrl: "http://127.0.0.1:0" },
      modules: { enabled: [] },
    },
    paths: { defaultPgData: "/tmp/unused" } as never,
    logger: log("provider"),
  });
  const bootStart = Date.now();
  await provider.start();
  const bootMs = Date.now() - bootStart;
  record(
    "start() returns promptly while PG is down (tunnel would open)",
    bootMs < 15_000 && provider.status().phase === "retrying",
    `${bootMs}ms, phase=${provider.status().phase}`,
  );
  record("dsn() stays null before ready", provider.dsn() === null);

  docker("unpause");
  const readyDeadline = Date.now() + 90_000;
  while (!provider.isReady() && Date.now() < readyDeadline) await sleep(1000);
  record(
    "background loop reaches ready + runs ALL real migrations (no restart needed)",
    provider.isReady(),
    `phase=${provider.status().phase}`,
  );

  // ── Phase 1: guarded-db + real ingest end-to-end.
  console.log("\n━━ Phase 1: healthy ingest through the real RPC dispatcher ━━");
  let rebuilds = 0;
  let recoveries = 0;
  const guarded = createGuardedDb({
    dsn: (role) => provider.dsn(role),
    logger: log("hx-db"),
    probeIntervalMs: 1_000,
    probeTimeoutMs: 3_000,
    onRebuild: () => {
      rebuilds += 1;
    },
    onRecovered: () => {
      recoveries += 1;
    },
  });
  guarded.start();

  const rpcLogger = { warn: (m: string, f?: Record<string, unknown>) => console.log(`   [rpc] WARN ${m}`, f ?? "") };
  const res1 = await handleVaultRpc(noopStore, ingestReq("drill-s1", "c1"), () => guarded.db(), undefined, () => guarded.dbRead(), rpcLogger);
  record("ingestCommit writes rows via the resolver layer", JSON.stringify(res1).includes('"ok":true'));
  const list1 = await handleVaultRpc(noopStore, { method: "listSessions", userId: "drill-user" }, () => guarded.db(), undefined, () => guarded.dbRead(), rpcLogger);
  const rows1 = list1.method === "listSessions" ? list1.value : [];
  record(
    "listSessions returns the indexed session with its REAL title",
    rows1.some((r) => r.sessionId === "drill-s1" && (r.title ?? "").length > 0),
    rows1.map((r) => `${r.sessionId}:${r.title}`).join(","),
  );

  // ── Phase 2: the incident — PG black-holes mid-flight.
  console.log("\n━━ Phase 2: OUTAGE (docker pause — the wedged-pool incident) ━━");
  docker("pause");
  const t0 = Date.now();
  const failed = await handleVaultRpc(noopStore, ingestReq("drill-s2", "c2"), () => guarded.db(), undefined, null, rpcLogger).then(
    () => null,
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
  const failMs = Date.now() - t0;
  record(
    "a mid-outage ingest fails TYPED under the cloud's abandon window (never a silent hang)",
    failed !== null && failed.includes("db_unavailable:ingest_commit") && failMs < 10_000,
    `${failMs}ms → ${failed}`,
  );

  const probeDeadline = Date.now() + 60_000;
  while (rebuilds === 0 && Date.now() < probeDeadline) await sleep(500);
  record("3 probe breaches rotate the pools (worker resetDb hook fired)", rebuilds >= 1, `rebuilds=${rebuilds}`);

  const del = await handleVaultRpc(noopStore, { method: "deleteSession", key: { userId: "drill-user", family: "claude-cli", sessionId: "drill-s1" } }, () => guarded.db(), undefined, null, rpcLogger, () => provider.dsn("rw")).then(
    () => null,
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
  record(
    "a mid-outage deleteSession maps to a PARK-class error (cloud refunds the attempt)",
    del !== null && /postgres_not_ready/.test(del),
    `→ ${del}`,
  );

  // ── Phase 3: recovery — probe success, urgent signal, ingest resumes.
  console.log("\n━━ Phase 3: RECOVERY (docker unpause) ━━");
  docker("unpause");
  const recoveryDeadline = Date.now() + 60_000;
  while (recoveries === 0 && Date.now() < recoveryDeadline) await sleep(500);
  record("first probe success after the rebuild fires the urgent-guarantor hook", recoveries >= 1, `recoveries=${recoveries}`);

  const res2 = await handleVaultRpc(noopStore, ingestReq("drill-s2", "c2b"), () => guarded.db(), undefined, null, rpcLogger);
  record("ingest works again on the ROTATED pools with no restart", JSON.stringify(res2).includes('"ok":true'));

  const del2 = await handleVaultRpc(noopStore, { method: "deleteSession", key: { userId: "drill-user", family: "claude-cli", sessionId: "drill-s1" } }, () => guarded.db(), undefined, null, rpcLogger, () => provider.dsn("rw"));
  record(
    "deleteSession completes on the dedicated purge client",
    del2.method === "deleteSession" && del2.value.complete === true,
    JSON.stringify(del2.value ?? {}),
  );
  const list2 = await handleVaultRpc(noopStore, { method: "listSessions", userId: "drill-user" }, () => guarded.db(), undefined, null, rpcLogger);
  const rows2 = list2.method === "listSessions" ? list2.value : [];
  record(
    "the purged session is gone; the outage-era session is indexed",
    !rows2.some((r) => r.sessionId === "drill-s1") && rows2.some((r) => r.sessionId === "drill-s2"),
    rows2.map((r) => r.sessionId).join(","),
  );

  await guarded.stop();
  await provider.stop();

  const failures = results.filter((r) => !r.ok);
  console.log(`\n━━ DRILL ${failures.length === 0 ? "PASSED" : "FAILED"}: ${results.length - failures.length}/${results.length} checks ━━`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  try {
    docker("unpause 2>/dev/null || true");
  } catch {
    // container already running
  }
  console.error("drill crashed:", err);
  process.exit(1);
});
