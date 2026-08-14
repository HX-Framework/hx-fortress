// Rotations, and the one mechanism that lets a rotated credential reach a
// RUNNING daemon.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import createSessionVaultModule from "../src/modules/session-vault/module";
import {
  credentialsPath,
  writeVaultCredentials,
  type VaultCredentials,
} from "../src/modules/session-vault/credentials";
import { buildStore } from "../src/modules/session-vault/store";
import { isPauseGated, IngestQuiesce } from "../src/console/pause-gate";
import { PauseState } from "../src/console/ingest-control";
import { runCheckup, summarizeCheckup } from "../src/console/checkup";
import { createCommandExecutors } from "../src/console/executors";
import { writeCredentialRef, mintCredentialRef } from "../src/console/cmd-creds";
import { applyRotation, envManagedRefusal, isRotationPayload } from "../src/console/rotation";
import { reattachUnmanaged } from "../src/host/headless-bootstrap";
import { AuditSpool } from "../src/console/audit-spool";
import { ConsoleAudit } from "../src/ui/audit-writer";
import { handleMutateRoute, MUTATE_PATHS, OFFERED_COMMAND_KINDS } from "../src/ui/mutate-routes";
import type { ConsoleWritePort } from "../src/ui/mutate-routes";
import type { ModuleContext, ScopedLogger } from "../src/host/types";
import type { SessionStore } from "../src/modules/session-vault/store/types";
import type { ServiceManager } from "../src/service";

// ── an in-process S3 the self-test can actually write to ─────────────────────

interface StubBucket {
  url: string;
  objects: Map<string, string>;
  failWrites: boolean;
  stop: () => void;
}

function startBucket(): StubBucket {
  const objects = new Map<string, string>();
  const state = { failWrites: false };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const key = new URL(req.url).pathname.replace(/^\/[^/]+\//, "");
      if (req.method === "PUT") {
        if (state.failWrites) return new Response("nope", { status: 500 });
        objects.set(key, await req.text());
        return new Response(null, { status: 200, headers: { etag: '"stub"' } });
      }
      if (req.method === "GET") {
        const body = objects.get(key);
        return body === undefined
          ? new Response("missing", { status: 404 })
          : new Response(body, { status: 200 });
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    objects,
    get failWrites() {
      return state.failWrites;
    },
    set failWrites(value: boolean) {
      state.failWrites = value;
    },
    stop: () => void server.stop(true),
  };
}

function credsFor(bucket: StubBucket, name = "vault-one"): VaultCredentials {
  return {
    store: "s3",
    bucket: name,
    region: "us-east-1",
    endpoint: bucket.url,
    forcePathStyle: true,
    s3: { accessKeyId: "stub", secretAccessKey: "stub" },
  };
}

const LOGGER: ScopedLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function moduleContext(): ModuleContext {
  return { logger: LOGGER, fortressIdentity: null } as unknown as ModuleContext;
}

let home: string;
let previousHome: string | undefined;
let previousAllow: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "hx-rotate-"));
  previousHome = process.env.HOME;
  previousAllow = process.env.FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT;
  process.env.HOME = home;
  process.env.FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT = "1";
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAllow === undefined) delete process.env.FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT;
  else process.env.FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT = previousAllow;
  await rm(home, { recursive: true, force: true });
});

describe("the gate-installing factory", () => {
  test("buildStore is what puts the pause gate on — and it is the only way to get one", () => {
    const bucket = startBucket();
    try {
      const hooks = { state: new PauseState(), quiesce: new IngestQuiesce() };
      expect(isPauseGated(buildStore(credsFor(bucket), LOGGER, { pause: hooks }))).toBe(true);
      // A rebind that skipped it would return exactly this: a store with no
      // gate, no per-call deadline policy of its own to re-apply, and every
      // ingest route bypassing ingest_control from then on.
      expect(isPauseGated(buildStore(credsFor(bucket), LOGGER))).toBe(false);
    } finally {
      bucket.stop();
    }
  });
});

describe("rebindStore", () => {
  test("swaps the live binding onto rotated credentials, gate and all", async () => {
    const bucket = startBucket();
    try {
      await writeVaultCredentials(credsFor(bucket, "vault-one"));
      const module = createSessionVaultModule({
        pause: { state: new PauseState(), quiesce: new IngestQuiesce() },
      });
      await module.init!(moduleContext());
      const before = module.getStore();
      expect(isPauseGated(before)).toBe(true);

      await writeVaultCredentials(credsFor(bucket, "vault-two"));
      await module.rebindStore();

      const after = module.getStore();
      expect(after).not.toBe(before);
      // The gate is a per-INSTANCE wrapper: a rebind that returned a bare store
      // would leave every later write ungated.
      expect(isPauseGated(after)).toBe(true);
      // And it is proven against the real bucket before it is adopted.
      expect([...bucket.objects.keys()]).toEqual([]);
    } finally {
      bucket.stop();
    }
  });

  test("an ARMED pause does not refuse it — the swap that armed the pause is the caller", async () => {
    const bucket = startBucket();
    try {
      await writeVaultCredentials(credsFor(bucket, "vault-one"));
      const state = new PauseState();
      const module = createSessionVaultModule({
        pause: { state, quiesce: new IngestQuiesce() },
      });
      await module.init!(moduleContext());

      // Exactly the state a storage-migration swap is in when it calls this: it
      // armed the pause itself, the serving store refuses every write, and a
      // probe taken through that store is a probe of the thing being held still
      // rather than of the credentials that are about to replace it.
      state.observe({ pausedUntil: new Date(Date.now() + 60_000), capped: false });
      await writeVaultCredentials(credsFor(bucket, "vault-two"));
      await module.rebindStore();

      // Bound, gated, and proven — credentials.json and the running daemon now
      // name the same bucket, which is the whole point of the cut.
      expect(isPauseGated(module.getStore())).toBe(true);
      expect(state.isPaused()).toBe(true);
    } finally {
      bucket.stop();
    }
  });

  test("a candidate that cannot write keeps the OLD store and stays running", async () => {
    const bucket = startBucket();
    try {
      await writeVaultCredentials(credsFor(bucket));
      const module = createSessionVaultModule({
        pause: { state: new PauseState(), quiesce: new IngestQuiesce() },
      });
      await module.init!(moduleContext());
      const before = module.getStore();

      bucket.failWrites = true;
      await expect(module.rebindStore()).rejects.toThrow();
      // Still serving, still the old binding: the alternative is a module the
      // registry answers "not running" for while the gateway keeps ingesting.
      expect(module.getStore()).toBe(before);
    } finally {
      bucket.stop();
    }
  });
});

describe("what a rotation writes", () => {
  test("a storage rotation keeps the embedding key, and an embedding rotation keeps the bucket", () => {
    const current: VaultCredentials = {
      store: "s3",
      bucket: "old",
      region: "us-east-1",
      openaiApiKey: "sk-existing",
    };
    const rotated = applyRotation(current, {
      target: "storage",
      credentials: { store: "s3", bucket: "new", region: "eu-west-1" },
    });
    expect(rotated).toMatchObject({ bucket: "new", openaiApiKey: "sk-existing" });

    const embedded = applyRotation(current, { target: "openai", apiKey: "sk-fresh" });
    expect(embedded).toMatchObject({ bucket: "old", openaiApiKey: "sk-fresh" });
  });

  test("the headless rebuild preserves the embedding key and drops what the environment stopped setting", () => {
    const merged = reattachUnmanaged(
      { store: "s3", bucket: "from-env" },
      { store: "s3", bucket: "old", region: "eu-west-1", openaiApiKey: "sk-existing", version: 4 },
    );
    expect(merged).toEqual({
      store: "s3",
      bucket: "from-env",
      openaiApiKey: "sk-existing",
      version: 4,
    });
    // region came from an env var that is no longer set — it must not survive.
    expect(merged.region).toBeUndefined();
  });

  test("only the three known shapes are accepted", () => {
    expect(isRotationPayload({ target: "openai", apiKey: "sk-x" })).toBe(true);
    expect(isRotationPayload({ target: "cloud", credential: "vlc_abc" })).toBe(true);
    expect(isRotationPayload({ target: "cloud", credential: "not-a-vlc" })).toBe(false);
    expect(isRotationPayload({ target: "storage", credentials: { store: "s3", bucket: "b" } })).toBe(true);
    expect(isRotationPayload({ target: "whatever" })).toBe(false);
  });
});

describe("the rotation executor", () => {
  test("refuses an env-managed fortress by naming the variable — the embedding key included", async () => {
    const bucket = startBucket();
    try {
      await writeVaultCredentials(credsFor(bucket));
      const cmdCredsDir = path.join(home, "cmd-creds");
      for (const payload of [
        { target: "storage", credentials: credsFor(bucket, "new") },
        { target: "openai", apiKey: "sk-fresh" },
      ]) {
        const ref = mintCredentialRef();
        await writeCredentialRef(cmdCredsDir, ref, payload);
        const executors = createCommandExecutors(
          executorDeps({ cmdCredsDir, env: { FORTRESS_STORAGE_BUCKET: "env-bucket" } }),
        );
        await expect(
          executors.rotate_credentials({ id: "c1", params: { credentialRef: ref }, credentialRef: ref }),
        ).rejects.toThrow(envManagedRefusal(payload.target as "storage"));
      }
    } finally {
      bucket.stop();
    }
  });

  test("reports an armed migration as a migration, never as broken credentials", async () => {
    const cmdCredsDir = path.join(home, "cmd-creds");
    const ref = mintCredentialRef();
    await writeCredentialRef(cmdCredsDir, ref, { target: "openai", apiKey: "sk-fresh" });
    const executors = createCommandExecutors(
      executorDeps({
        cmdCredsDir,
        episode: {
          id: "3f1d",
          pausedUntil: new Date(Date.now() + 60_000),
          resumedAt: null,
          rowWrittenAt: new Date(),
          reason: "storage migration",
        },
      }),
    );
    await expect(
      executors.rotate_credentials({ id: "c1", params: { credentialRef: ref }, credentialRef: ref }),
    ).rejects.toThrow("a storage migration is in progress (run 3f1d)");
  });

  test("so is the self-test — its probe is a bucket WRITE the gate refuses", async () => {
    const cmdCredsDir = path.join(await mkdtemp(path.join(os.tmpdir(), "hx-creds-")), "cmd");
    const executors = createCommandExecutors(
      executorDeps({
        cmdCredsDir,
        episode: {
          id: "3f1d",
          pausedUntil: new Date(Date.now() + 60_000),
          resumedAt: null,
          rowWrittenAt: new Date(),
          reason: "storage migration",
        },
      }),
    );
    // Unrefused, the gate answers with the literal it sends a retrying client —
    // `vault_offline:ingest_paused:<deadline>` — and an operator reads a paused
    // fortress as a broken bucket and goes off to re-issue keys mid-migration.
    await expect(executors.self_test({ id: "c1", params: {}, credentialRef: null })).rejects.toThrow(
      "a storage migration is in progress (run 3f1d)",
    );
  });

  test("a consumed reference is terminal — the same rotation cannot run twice", async () => {
    const cmdCredsDir = path.join(home, "cmd-creds");
    const ref = mintCredentialRef();
    await writeCredentialRef(cmdCredsDir, ref, { target: "cloud", credential: "vlc_new" });
    const saved: string[] = [];
    const executors = createCommandExecutors(
      executorDeps({
        cmdCredsDir,
        setCloudCredential: async (credential) => {
          saved.push(credential);
          return { orgId: "o", fortressId: "f", credential } as never;
        },
      }),
    );
    const ctx = { id: "c1", params: { credentialRef: ref }, credentialRef: ref };
    await expect(executors.rotate_credentials(ctx)).resolves.toContain("cloud credential rotated");
    expect(saved).toEqual(["vlc_new"]);
    await expect(executors.rotate_credentials(ctx)).rejects.toThrow(/already consumed/);
  });
});

describe("the checkup", () => {
  test("runs six probes and reports what each one saw", async () => {
    const results = await runCheckup({
      service: {
        name: "systemd (user)",
        state: async () => ({ loaded: true, pid: 99 }),
        unit: async () => ({ path: "/unit", present: true, executablePath: "/bin/hx" }),
      } as unknown as ServiceManager,
      status: async () => ({
        host: { writtenAt: new Date().toISOString() },
        connection: { state: "connected", reason: null },
      }) as never,
      db: () => ({ execute: async () => [] }) as never,
      store: () => ({ selfTest: async () => {} }) as unknown as SessionStore,
      embeddingEndpoint: () => "https://api.openai.com/v1",
    });
    expect(results.map((r) => r.name)).toEqual([
      "service",
      "status snapshot",
      "postgres",
      "object store",
      "embeddings",
      "relay tunnel",
    ]);
    expect(results.every((r) => r.verdict === "ok")).toBe(true);
    expect(summarizeCheckup(results)).toContain("object store: ok");
  });

  test("a probe that cannot run says so instead of passing", async () => {
    const results = await runCheckup({
      service: {
        name: "systemd (user)",
        state: async () => ({ loaded: false, pid: null }),
        unit: async () => ({ path: "/unit", present: false, executablePath: null }),
      } as unknown as ServiceManager,
      status: async () => null,
      db: () => null,
      store: () => null,
      embeddingEndpoint: () => null,
    });
    expect(results.map((r) => r.verdict)).toEqual([
      "degraded",
      "failed",
      "failed",
      "failed",
      "not-configured",
      "failed",
    ]);
  });
});

describe("the console's rotation request", () => {
  test("sends the material to a single-use file and the row gets only its reference", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hx-audit-"));
    try {
      const audit = new ConsoleAudit(new AuditSpool({ dir, writer: "ui" }));
      const minted: unknown[] = [];
      const submitted: Array<Record<string, unknown>> = [];
      const port: ConsoleWritePort = {
        serviceRefusal: () => null,
        service: async () => ({ action: "start", manager: "m", pid: 1, copy: "" }),
        heartbeatAt: async () => new Date().toISOString(),
        offered: () => OFFERED_COMMAND_KINDS,
        async mintCredential(payload) {
          minted.push(payload);
          return "a".repeat(32);
        },
        async submit(_kind, params, _requestedBy, credentialRef) {
          submitted.push({ params, credentialRef });
          return { id: "id-1" };
        },
      };
      const res = await handleMutateRoute(
        new Request(`http://console.local${MUTATE_PATHS.commands}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "rotate_credentials",
            secret: { target: "openai", apiKey: "sk-super-secret-value" },
          }),
        }),
        { port, audit, actor: "op", sessionId: "s1" },
      );
      expect(res?.status).toBe(202);
      expect(minted).toEqual([{ target: "openai", apiKey: "sk-super-secret-value" }]);
      // The row's params carry nothing at all; the reference is a column, which
      // is where the daemon reads it from.
      expect(submitted).toEqual([{ params: {}, credentialRef: "a".repeat(32) }]);

      // And nothing that was typed reaches the trail.
      const spool = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
      const text = (
        await Promise.all(spool.map((f) => readFile(path.join(dir, f), "utf8")))
      ).join("");
      expect(text).not.toContain("sk-super-secret-value");
      expect(text).toContain("rotate_credentials");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function executorDeps(overrides: {
  cmdCredsDir: string;
  env?: Record<string, string | undefined>;
  episode?: unknown;
  setCloudCredential?: (credential: string) => Promise<never>;
}): Parameters<typeof createCommandExecutors>[0] {
  return {
    logger: LOGGER,
    store: () => null,
    downloadBaseUrl: async () => null,
    service: {
      name: "systemd (user)",
      state: async () => ({ loaded: true, pid: 1 }),
      unit: async () => ({ path: "/unit", present: true, executablePath: "/bin/hx" }),
    } as unknown as ServiceManager,
    cmdCredsDir: overrides.cmdCredsDir,
    env: overrides.env ?? {},
    db: () =>
      overrides.episode === undefined
        ? null
        : ({
            execute: async () => [
              {
                id: (overrides.episode as { id: string }).id,
                paused_until: (overrides.episode as { pausedUntil: Date }).pausedUntil,
                resumed_at: null,
                row_written_at: (overrides.episode as { rowWrittenAt: Date }).rowWrittenAt,
                reason: null,
              },
            ],
          } as never),
    rebindStore: async () => {},
    setCloudCredential:
      overrides.setCloudCredential ??
      (async () => {
        throw new Error("not wired");
      }),
    status: async () => null,
    embeddingEndpoint: () => null,
    runAudit: async () => {
      throw new Error("not wired");
    },
    runMigration: async () => {
      throw new Error("not wired");
    },
    setCloudWitness: async () => {},
    acknowledgeFinding: async () => {},
    onBinarySwapped: () => {},
  };
}

void credentialsPath;
