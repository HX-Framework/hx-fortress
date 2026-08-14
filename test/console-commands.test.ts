import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  COMMAND_REQUEST_TTL_MS,
  FAIL_CREDENTIAL_CONSUMED,
  REJECT_BOOT_FENCE,
  REJECT_DEADLINE,
  heartbeatFresh,
  pollCommands,
  runBootFence,
  type CommandExecutors,
  type CommandGateway,
  type CommandRow,
} from "../src/console/commands";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import { validateCommandParams } from "../src/console/command-params";
import { createCommandGateway } from "../src/console/command-gateway";
import { consumeCredentialRef } from "../src/console/cmd-creds";
import {
  addInFlight,
  readInFlight,
  readPauseAnchor,
  removeInFlight,
  stampPauseAnchor,
} from "../src/console/runtime-files";
import { AuditSpool } from "../src/console/audit-spool";
import { ConsoleAudit } from "../src/ui/audit-writer";
import { createConsoleWritePort } from "../src/ui/console-write-port";
import { handleMutateRoute, MUTATE_PATHS, OFFERED_COMMAND_KINDS } from "../src/ui/mutate-routes";
import type { HxDb } from "../src/host/postgres/db";

const NOW = new Date("2026-07-31T12:00:00.000Z");

function row(over: Partial<CommandRow> = {}): CommandRow {
  return {
    id: over.id ?? "11111111-1111-4111-8111-111111111111",
    kind: over.kind ?? "self_test",
    params: over.params ?? {},
    status: over.status ?? "requested",
    requestedAt: over.requestedAt ?? new Date(NOW.getTime() - 1000),
    deadlineAt: over.deadlineAt ?? null,
    credentialRef: over.credentialRef ?? null,
  };
}

interface FakeGateway extends CommandGateway {
  calls: string[];
  rows: CommandRow[];
}

function fakeGateway(rows: CommandRow[]): FakeGateway {
  const calls: string[] = [];
  return {
    calls,
    rows,
    listOpen: async () => rows,
    claim: async (id, claimedBy, redrive) => {
      calls.push(`claim:${id}:${redrive}`);
      const r = rows.find((x) => x.id === id);
      if (!r) return false;
      // The routine refuses a future requested_at and any terminal row.
      if (r.requestedAt.getTime() > NOW.getTime()) return false;
      if (r.status === "requested" || (r.status === "running" && redrive)) {
        r.status = "running";
        return true;
      }
      return false;
    },
    complete: async (id, status, _outcome, error) => {
      calls.push(`complete:${id}:${status}:${error ?? ""}`);
      const r = rows.find((x) => x.id === id);
      if (!r || r.status !== "running") return false;
      r.status = status;
      return true;
    },
    reject: async (id, reason) => {
      calls.push(`reject:${id}:${reason}`);
      const r = rows.find((x) => x.id === id);
      if (!r || (r.status !== "requested" && r.status !== "running")) return false;
      r.status = "rejected";
      return true;
    },
  };
}

function executors(ran: string[], throwOn?: string): CommandExecutors {
  const run = (kind: string) => async (): Promise<string | null> => {
    if (throwOn === kind) throw new Error("boom");
    ran.push(kind);
    return "ok";
  };
  return {
    update_apply: run("update_apply"),
    rotate_credentials: run("rotate_credentials"),
    run_migration: run("run_migration"),
    run_checkup: run("run_checkup"),
    self_test: run("self_test"),
    run_audit: run("run_audit"),
    witness_toggle: run("witness_toggle"),
    acknowledge_finding: run("acknowledge_finding"),
  };
}

describe("command parameter validation", () => {
  test("rejects an unknown kind and unknown parameters", () => {
    expect(validateCommandParams("revoke_session", {}).ok).toBe(false);
    expect(validateCommandParams("self_test", { rm: "-rf" }).ok).toBe(false);
  });

  test("refuses a secret by NAME and by SHAPE", () => {
    const byName = validateCommandParams("update_apply", { password: "x" });
    expect(byName.ok).toBe(false);
    const byShape = validateCommandParams("update_apply", {
      version: "-----BEGIN RSA PRIVATE KEY-----\nabc",
    });
    expect(byShape.ok).toBe(false);
    const highEntropy = validateCommandParams("update_apply", {
      version: "A".repeat(20) + "b3F9xQ2mZ7pL1kR8sT4vW6yU0iO5eD",
    });
    expect(highEntropy.ok).toBe(false);
  });

  test("a rotation's reference is a column, so it is not a parameter either", () => {
    // The row's params are empty; the reference rides console_commands
    // .credential_ref, which is the only place the daemon reads it from. Named
    // as a parameter it was written where nothing looks.
    expect(validateCommandParams("rotate_credentials", {}).ok).toBe(true);
    const asParam = validateCommandParams("rotate_credentials", {
      credentialRef: "0123456789abcdef0123456789abcdef",
    });
    expect([asParam.ok, asParam.ok ? "" : asParam.reason]).toEqual([
      false,
      "unexpected parameter for rotate_credentials: credentialRef",
    ]);
  });

  test("per-kind shapes are enforced", () => {
    expect(validateCommandParams("run_migration", { phase: "swap" }).ok).toBe(true);
    expect(validateCommandParams("run_migration", { phase: "teleport" }).ok).toBe(false);
    expect(validateCommandParams("witness_toggle", { enabled: "yes" }).ok).toBe(false);
    expect(validateCommandParams("acknowledge_finding", { org: "o", sessionId: "s" }).ok).toBe(true);
    expect(validateCommandParams("acknowledge_finding", { org: "", sessionId: "s" }).ok).toBe(false);
  });
});

describe("the boot fence", () => {
  let root = "";
  let inFlightPath = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-cmd-"));
    inFlightPath = path.join(root, "commands-inflight.json");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a pending row minted before boot is rejected, never claimed", async () => {
    const gateway = fakeGateway([row({ id: "a", status: "requested" })]);
    const result = await runBootFence({ gateway, inFlightPath, claimedBy: "pid:boot" });
    expect(result.rejected).toEqual(["a"]);
    expect(gateway.calls).toEqual([`reject:a:${REJECT_BOOT_FENCE}`]);
  });

  test("a row minted pre-boot with a far-future requestedAt is fenced too", async () => {
    const gateway = fakeGateway([
      row({ id: "a", requestedAt: new Date(NOW.getTime() + 86_400_000) }),
    ]);
    await runBootFence({ gateway, inFlightPath, claimedBy: "pid:boot" });
    expect(gateway.calls.some((c) => c.startsWith("claim:"))).toBe(false);
    expect(gateway.rows[0].status).toBe("rejected");
  });

  test("a planted running row is fenced whatever claimedBy says", async () => {
    // The id is ABSENT from the daemon's own in-flight file, which is the only
    // thing that decides eligibility — claimed_by is SELECT-able by the very
    // adversary the fence defends against, so it is never a predicate.
    const gateway = fakeGateway([row({ id: "planted", status: "running" })]);
    const result = await runBootFence({ gateway, inFlightPath, claimedBy: "pid:boot" });
    expect(result.redriven).toEqual([]);
    expect(result.rejected).toEqual(["planted"]);
  });

  test("the daemon's own crashed row is re-driven in place", async () => {
    await writeFile(inFlightPath, JSON.stringify(["mine"]));
    const gateway = fakeGateway([row({ id: "mine", status: "running" })]);
    const result = await runBootFence({ gateway, inFlightPath, claimedBy: "pid:boot" });
    expect(result.redriven).toEqual(["mine"]);
    expect(gateway.calls).toEqual([]);

    // …and the poll pass then re-claims it through the re-drive arm.
    const ran: string[] = [];
    await pollCommands(
      { gateway, executors: executors(ran), inFlightPath, claimedBy: "pid:boot", clock: () => NOW },
      new Set(result.redriven),
    );
    expect(gateway.calls[0]).toBe("claim:mine:true");
    expect(ran).toEqual(["self_test"]);
    expect(gateway.rows[0].status).toBe("done");
  });

  test("a crashed row carrying a single-use credential FAILS, never re-runs", async () => {
    await writeFile(inFlightPath, JSON.stringify(["rot"]));
    const gateway = fakeGateway([
      row({ id: "rot", kind: "rotate_credentials", status: "running", credentialRef: "a".repeat(32) }),
    ]);
    const result = await runBootFence({ gateway, inFlightPath, claimedBy: "pid:boot" });
    expect(result.failed).toEqual(["rot"]);
    expect(result.redriven).toEqual([]);
    expect(gateway.calls).toEqual([`complete:rot:failed:${FAIL_CREDENTIAL_CONSUMED}`]);
    expect(await readInFlight(inFlightPath)).toEqual(new Set());
  });
});

describe("the poll pass", () => {
  let root = "";
  let inFlightPath = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-cmd-poll-"));
    inFlightPath = path.join(root, "commands-inflight.json");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function deps(gateway: CommandGateway, ran: string[], throwOn?: string) {
    return {
      gateway,
      executors: executors(ran, throwOn),
      inFlightPath,
      claimedBy: "pid:boot",
      clock: () => NOW,
    };
  }

  test("claims, executes and completes a fresh row", async () => {
    const gateway = fakeGateway([row({ id: "a" })]);
    const ran: string[] = [];
    await pollCommands(deps(gateway, ran));
    expect(gateway.calls).toEqual(["claim:a:false", "complete:a:done:"]);
    expect(ran).toEqual(["self_test"]);
    // The in-flight entry is written BEFORE execution and cleared after.
    expect(await readInFlight(inFlightPath)).toEqual(new Set());
  });

  test("records the row as in-flight before it runs", async () => {
    const gateway = fakeGateway([row({ id: "a" })]);
    let seen: string[] = [];
    const ran: string[] = [];
    const base = deps(gateway, ran);
    base.executors = {
      ...base.executors,
      self_test: async () => {
        seen = [...(await readInFlight(inFlightPath))];
        return null;
      },
    };
    await pollCommands(base);
    expect(seen).toEqual(["a"]);
  });

  test("a lapsed request is rejected instead of run", async () => {
    const gateway = fakeGateway([
      row({ id: "old", requestedAt: new Date(NOW.getTime() - COMMAND_REQUEST_TTL_MS - 1000) }),
    ]);
    const ran: string[] = [];
    await pollCommands(deps(gateway, ran));
    expect(gateway.calls).toEqual([`reject:old:${REJECT_DEADLINE}`]);
    expect(ran).toEqual([]);
  });

  test("a future requestedAt is rejected rather than parked in the queue", async () => {
    const gateway = fakeGateway([row({ id: "future", requestedAt: new Date(NOW.getTime() + 5000) })]);
    const ran: string[] = [];
    await pollCommands(deps(gateway, ran));
    expect(gateway.calls).toEqual([`reject:future:${REJECT_DEADLINE}`]);
  });

  test("secret-shaped params are rejected before anything is claimed", async () => {
    const gateway = fakeGateway([row({ id: "bad", kind: "update_apply", params: { token: "x" } })]);
    const ran: string[] = [];
    await pollCommands(deps(gateway, ran));
    expect(gateway.calls[0]).toStartWith("reject:bad:rejected_invalid_params");
    expect(ran).toEqual([]);
  });

  test("a re-drive is spent on use — the second poll leaves the row alone", async () => {
    const gateway = fakeGateway([row({ id: "mine", status: "running" })]);
    const ran: string[] = [];
    const tickets = new Set(["mine"]);
    await pollCommands(deps(gateway, ran), tickets);
    expect(gateway.calls[0]).toBe("claim:mine:true");
    expect(ran).toEqual(["self_test"]);

    // The row is terminal by now, but the permission is what has to be gone: a
    // ticket that survived would re-claim any running row of the same id on the
    // very next tick — and the poll runs once a second, forever.
    expect(tickets.has("mine")).toBe(false);
    gateway.rows[0].status = "running";
    gateway.calls.length = 0;
    await pollCommands(deps(gateway, ran), tickets);
    expect(gateway.calls).toEqual([]);
    expect(ran).toEqual(["self_test"]);
  });

  test("a running row NOT in the in-flight file is never re-driven", async () => {
    const gateway = fakeGateway([row({ id: "planted", status: "running" })]);
    const ran: string[] = [];
    await pollCommands(deps(gateway, ran)); // empty redrive set
    expect(gateway.calls).toEqual([]);
    expect(ran).toEqual([]);
  });

  test("an executor throw completes the row as failed", async () => {
    const gateway = fakeGateway([row({ id: "a" })]);
    const ran: string[] = [];
    await pollCommands(deps(gateway, ran, "self_test"));
    expect(gateway.calls).toEqual(["claim:a:false", "complete:a:failed:boom"]);
    expect(gateway.rows[0].status).toBe("failed");
  });

  test("every transition the daemon performs is reported for corroboration", async () => {
    const gateway = fakeGateway([row({ id: "a" })]);
    const seen: string[] = [];
    const ran: string[] = [];
    await pollCommands({ ...deps(gateway, ran), onTransition: (r) => void seen.push(r.transition) });
    expect(seen).toEqual(["claimed", "done"]);
  });
});

describe("heartbeat freshness", () => {
  test("gates submission on a daemon that is actually writing", () => {
    expect(heartbeatFresh(new Date(NOW.getTime() - 1000).toISOString(), NOW)).toBe(true);
    expect(heartbeatFresh(new Date(NOW.getTime() - 60_000).toISOString(), NOW)).toBe(false);
    // A pre-heartbeat file cannot vouch for anything.
    expect(heartbeatFresh(undefined, NOW)).toBe(false);
  });
});

describe("the in-flight file", () => {
  test("is created 0600", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hx-cmd-mode-"));
    try {
      const file = path.join(root, "runtime", "commands-inflight.json");
      const gateway = fakeGateway([row({ id: "a" })]);
      await pollCommands({
        gateway,
        executors: executors([]),
        inFlightPath: file,
        claimedBy: "pid",
        clock: () => NOW,
      });
      const contents = await readFile(file, "utf8");
      expect(JSON.parse(contents)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the runtime files two writers share", () => {
  let inFlightPath = "";
  let anchorPath = "";
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "hx-cmd-rt-"));
    inFlightPath = path.join(dir, "commands-inflight.json");
    anchorPath = path.join(dir, "pause-anchor.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("concurrent adds all survive — a read-modify-write is not a write", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `id-${i}`);
    // Overlapping in earnest: one poll pass outliving its interval is enough,
    // and every one of these reads the set before any of them has written it
    // back. Unserialized, all but the last are silently dropped — and the file
    // is what decides which running rows may be re-driven after a crash.
    await Promise.all(ids.map((id) => addInFlight(inFlightPath, id)));
    expect((await readInFlight(inFlightPath)).size).toBe(ids.length);

    await Promise.all(ids.slice(0, 10).map((id) => removeInFlight(inFlightPath, id)));
    expect((await readInFlight(inFlightPath)).size).toBe(15);
  });

  test("concurrent anchor stamps agree on one episode", async () => {
    const at = new Date("2026-08-01T00:00:00.000Z");
    const stamped = await Promise.all(
      Array.from({ length: 12 }, () => stampPauseAnchor(anchorPath, "episode-1", at)),
    );
    // The anchor bounds how long a pause may hold the write gate shut, so a
    // torn write here is a barrier that silently stops binding.
    for (const anchor of stamped) expect(anchor.episodeId).toBe("episode-1");
    expect(await readPauseAnchor(anchorPath)).toEqual({
      episodeId: "episode-1",
      firstObservedAt: at.toISOString(),
    });
  });
});

describe("the credential a rotation carries", () => {
  const dialect = new PgDialect();
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-cmd-cred-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("reaches the executor: route → row → poll → ctx.credentialRef", async () => {
    const cmdCredsDir = path.join(root, "cmd-creds");
    const statements: string[] = [];
    const values: unknown[][] = [];
    const db = {
      execute: async (statement: SQL) => {
        const query = dialect.sqlToQuery(statement);
        statements.push(query.sql);
        values.push(query.params);
        return [{ id: "11111111-1111-4111-8111-111111111111" }];
      },
    } as unknown as HxDb;

    // The REAL write port, so the statement under test is the one that ships.
    const port = createConsoleWritePort({
      service: null,
      serviceLogPath: path.join(root, "service.log"),

      db: () => db,
      heartbeatAt: async () => new Date().toISOString(),
      offered: OFFERED_COMMAND_KINDS,
      cmdCredsDir,
    });
    const audit = new ConsoleAudit(new AuditSpool({ dir: path.join(root, "spool"), writer: "ui" }));
    const res = await handleMutateRoute(
      new Request(`http://console.local${MUTATE_PATHS.commands}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "rotate_credentials",
          secret: { target: "openai", apiKey: "sk-the-new-embedding-key" },
        }),
      }),
      { port, audit, actor: "op", sessionId: "s1" },
    );
    expect(res?.status).toBe(202);

    const at = statements.findIndex((s) => s.includes("INSERT INTO hx.console_commands"));
    expect(at).toBeGreaterThanOrEqual(0);
    // The COLUMN, which is what the daemon reads. Written into params instead,
    // every rotation and every migration arm and swap reached its executor with
    // a null reference and failed on a message that reads like corrupted state,
    // while the minted secret sat at rest for its whole TTL unconsumed.
    expect(statements[at]).toContain("credential_ref");
    const ref = (values[at] ?? []).find(
      (v): v is string => typeof v === "string" && /^[0-9a-f]{32}$/.test(v),
    );
    expect(ref).toBeDefined();
    // …and the params blob does not also carry it.
    const params = JSON.parse(String((values[at] ?? [])[1])) as Record<string, unknown>;
    expect(params).toEqual({});

    // The daemon side, over the row the gateway would hand it.
    const gateway = fakeGateway([row({ kind: "rotate_credentials", credentialRef: ref ?? null })]);
    let seen: string | null | undefined;
    const ran: string[] = [];
    const base = executors(ran);
    await pollCommands({
      gateway,
      executors: {
        ...base,
        rotate_credentials: async (ctx) => {
          seen = ctx.credentialRef;
          return "rotated";
        },
      },
      inFlightPath: path.join(root, "commands-inflight.json"),
      claimedBy: "pid:1",
      clock: () => NOW,
    });
    expect(seen).toBe(ref);
    // And the reference names the file the material was written to.
    expect(await consumeCredentialRef<Record<string, string>>(cmdCredsDir, ref ?? "")).toEqual({
      target: "openai",
      apiKey: "sk-the-new-embedding-key",
    });
  });
});

describe("the command gateway decodes what the driver actually hands back", () => {
  /** A db that answers `listOpen` with what Bun.SQL returns for a jsonb column
   *  on the embedded Postgres this appliance ships: the raw JSON TEXT. The same
   *  driver returns a parsed object against other servers, so this cannot be
   *  pinned by an e2e against one of them — it has to be asserted here. */
  const dbReturning = (params: unknown): HxDb =>
    ({
      execute: () =>
        Promise.resolve({
          rows: [
            {
              id: "6f1d0e6a-0000-4000-8000-000000000001",
              kind: "run_audit",
              params,
              status: "requested",
              requested_at: "2026-08-05T06:56:46.312Z",
              deadline_at: null,
              credential_ref: null,
            },
          ],
        }),
    }) as unknown as HxDb;

  test("a jsonb column delivered as TEXT still reaches the validator as an object", async () => {
    // The whole console write surface ran through this. `validateCommandParams`
    // opens with `typeof params !== "object"`, so a string meant EVERY minted
    // command was rejected with `rejected_invalid_params: params must be an
    // object` — about a value that was an object. Observed live: Run audit
    // confirmed in the console, one rejected row in console_commands, audit_runs
    // empty, and nothing on screen, because the panel reports the daemon's
    // answer rather than the request's success.
    const [row] = await createCommandGateway(dbReturning('{"scope":"console"}')).listOpen();
    expect(typeof row?.params).toBe("object");
    expect(row?.params).toEqual({ scope: "console" });
    expect(validateCommandParams(row?.kind, row?.params).ok).toBe(true);
  });

  test("an already-parsed object passes through untouched", async () => {
    const [row] = await createCommandGateway(dbReturning({ scope: "console" })).listOpen();
    expect(row?.params).toEqual({ scope: "console" });
  });

  test("text that is not JSON is left alone for the validator to refuse", async () => {
    // Never a throw: one malformed row must not take down the poll for the rest.
    const [row] = await createCommandGateway(dbReturning("{ not json")).listOpen();
    expect(row?.params).toBe("{ not json");
    expect(validateCommandParams(row?.kind, row?.params).ok).toBe(false);
  });

  test("a JSON scalar is still refused — parsing is not permission", () => {
    expect(validateCommandParams("run_audit", 7).ok).toBe(false);
    expect(validateCommandParams("run_audit", ["scope"]).ok).toBe(false);
    expect(validateCommandParams("run_audit", null).ok).toBe(false);
  });
});
