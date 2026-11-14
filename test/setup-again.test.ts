import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";

import { runCheckup, summarizeCheckup, type CheckupDeps } from "../src/console/checkup";
import { NO_CONTROL_PLANE } from "../src/host/runtime";
import type { SessionStore } from "../src/modules/session-vault/store/types";
import type { SecretProvider } from "../src/secrets/types";
import { checkAnswersAgain, refusedSentences } from "../src/setup/again";
import { STEP_IDS } from "../src/setup/list";
import { readAnswers } from "../src/setup/read";
import { SetupRun, type SetupRunDeps } from "../src/setup/run";
import { fixedSecrets, tempRoot, type Paths } from "./host/_module-rig";
import { providerDocument } from "./setup-rig";

// Built at run time so no secret-shaped literal sits in the repository.
const DB_URL = ["postgres://fortress:", "pw-for-a-test", "@db.northstar.example:5432/fortress"].join("");

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function root(): Promise<Paths> {
  const made = await tempRoot();
  cleanup = made.cleanup;
  return made.paths;
}

const KEYS = { "db-url": DB_URL, "oidc-client-secret": "s", "model-key": "k" };

/** Northstar's Fortress, set up while every key it names was in the key store. */
async function setUp(paths: Paths): Promise<void> {
  const deps: SetupRunDeps = {
    paths,
    env: {},
    read: { vaultCredentials: async () => null },
    apply: {
      updateVaultCredentials: async () => {
        throw new Error("no test here keeps files");
      },
    },
    check: {
      keyStore: () => fixedSecrets(KEYS),
      fetch: (async (input: Parameters<typeof fetch>[0]) =>
        String(input).endsWith("/.well-known/openid-configuration")
          ? Response.json(providerDocument("https://login.northstar.example"))
          : Response.json({ data: [{ embedding: [0.1] }] })) as unknown as typeof fetch,
      probeDatabase: async () => "PostgreSQL 17.2",
    },
  };
  const run = await SetupRun.open(deps);
  run.set("organization.name", "Northstar");
  run.set("organization.firstAdministrator", "marta.lindqvist");
  run.set("signIn.provider", "openid-connect");
  run.set("signIn.issuer", "https://login.northstar.example");
  run.set("signIn.clientId", "hx-fortress");
  run.set("signIn.clientSecret", "oidc-client-secret");
  run.set("signIn.operatorGroups", ["fortress-admins"]);
  run.set("data.database.store", "postgres");
  run.set("data.database.address", "db-url");
  run.set("model.provider", "openai-compatible");
  run.set("model.address", "https://models.northstar.example/v1");
  run.set("model.key", "model-key");
  const result = await run.finish("terminal");
  if (!result.ok) throw new Error(`the setup was refused: ${JSON.stringify(result.checks.filter((c) => !c.ok))}`);
}

describe("the setup's checks, made again", () => {
  /** Every address the checks call, in order. The model would answer too, if asked. */
  function watchedNet(): { fetch: typeof fetch; asked: string[] } {
    const asked: string[] = [];
    return {
      asked,
      fetch: (async (input: Parameters<typeof fetch>[0]) => {
        asked.push(String(input));
        return Response.json({ ...providerDocument("https://login.northstar.example"), data: [{ embedding: [0.1] }] });
      }) as unknown as typeof fetch,
    };
  }

  test("at a start they read the answers from where the Fortress reads them, and no request leaves this host", async () => {
    const paths = await root();
    await setUp(paths);
    const net = watchedNet();
    const checks = await checkAnswersAgain({
      paths,
      env: {},
      when: "start",
      read: (at, env) => readAnswers(at, env, { vaultCredentials: async () => null }),
      check: {
        keyStore: () => fixedSecrets(KEYS),
        fetch: net.fetch,
        // The Fortress's own start opens the database and says what it found.
        probeDatabase: async () => {
          throw new Error("the database is not opened a second time");
        },
        // Nothing a caller passes can make this the mode in which a person
        // answers: that mode would ask the model.
        when: "given",
      },
    });
    expect(checks.map((check) => check.step)).toEqual([...STEP_IDS]);
    expect(refusedSentences(checks)).toEqual([]);
    expect(net.asked).toEqual([]);
  });

  test("in the Checkup the sign-in provider is asked whether it is still there, and the model is asked nothing", async () => {
    const paths = await root();
    await setUp(paths);
    const net = watchedNet();
    const checks = await checkAnswersAgain({
      paths,
      env: {},
      when: "checkup",
      read: (at, env) => readAnswers(at, env, { vaultCredentials: async () => null }),
      check: {
        keyStore: () => fixedSecrets(KEYS),
        fetch: net.fetch,
        probeDatabase: async () => {
          throw new Error("the Checkup has a probe of its own for the database");
        },
      },
    });
    expect(refusedSentences(checks)).toEqual([]);
    // A question to the model costs money, so it is asked only while a person answers.
    expect(net.asked).toEqual(["https://login.northstar.example/.well-known/openid-configuration"]);
  });

  test("name each answer that has stopped being true, by its question and in the setup's words", async () => {
    const paths = await root();
    await setUp(paths);
    const checks = await checkAnswersAgain({
      paths,
      env: {},
      when: "checkup",
      read: (at, env) => readAnswers(at, env, { vaultCredentials: async () => null }),
      check: {
        // The model's key was removed, and the sign-in provider is gone.
        keyStore: () => fixedSecrets({ "db-url": DB_URL, "oidc-client-secret": "s" }),
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as unknown as typeof fetch,
      },
    });
    expect(refusedSentences(checks)).toEqual([
      "Sign-in: No sign-in provider answers at this address",
      "AI model: No key with this name",
    ]);
  });
});

/** A key store that writes down every question it is asked. */
function watchedStore(held: Record<string, string>): { store: SecretProvider; asked: string[] } {
  const inner = fixedSecrets(held);
  const asked: string[] = [];
  return {
    asked,
    store: {
      kind: inner.kind,
      has: async (name) => {
        asked.push(`has ${name}`);
        return inner.has(name);
      },
      get: async (name) => {
        asked.push(`get ${name}`);
        return inner.get(name);
      },
    },
  };
}

describe("what the checks ask of the key store, once the Fortress is set up", () => {
  const VAULT = "https://northstar-fortress.vault.azure.net";
  /** The same Fortress, with its keys in a vault that is not on this host. */
  async function inVault(paths: Paths): Promise<void> {
    await setUp(paths);
    const raw = JSON.parse(await readFile(paths.config, "utf8")) as Record<string, unknown>;
    await writeFile(paths.config, JSON.stringify({ ...raw, secrets: { provider: "azure-key-vault", vaultUrl: VAULT } }));
  }
  const again = (paths: Paths, when: "start" | "checkup", store: SecretProvider) =>
    checkAnswersAgain({
      paths,
      env: {},
      when,
      read: (at, env) => readAnswers(at, env, { vaultCredentials: async () => null }),
      check: {
        keyStore: () => store,
        fetch: (async () => Response.json(providerDocument("https://login.northstar.example"))) as unknown as typeof fetch,
      },
    });

  test("at a start, a key store that is not on this host is asked nothing", async () => {
    const paths = await root();
    await inVault(paths);
    // Even a key that is gone is not looked for: the start reads the keys it
    // needs itself, and a lookup of any other is one more request that leaves.
    const watched = watchedStore({ "db-url": DB_URL });
    const checks = await again(paths, "start", watched.store);
    expect(watched.asked).toEqual([]);
    expect(refusedSentences(checks)).toEqual([]);
    expect(checks.find((check) => check.step === "keys")?.lines).toEqual([]);
  });

  test("in the Checkup it is asked for each named key, and for nothing else", async () => {
    const paths = await root();
    await inVault(paths);
    const watched = watchedStore({ "db-url": DB_URL, "oidc-client-secret": "s" });
    const checks = await again(paths, "checkup", watched.store);
    // No made-up name to see whether the store answers. Each named key is
    // asked for once; a real store answers that by reading the key, as it does
    // at every start, and the check keeps only whether it is there.
    expect(watched.asked.sort()).toEqual(["has db-url", "has model-key", "has oidc-client-secret"]);
    expect(refusedSentences(checks)).toEqual(["AI model: No key with this name"]);
  });

  test("a key store on this host is asked at a start too: nothing leaves this host for it", async () => {
    const paths = await root();
    await setUp(paths); // its key store is this host's environment
    const watched = watchedStore(KEYS);
    const checks = await again(paths, "start", watched.store);
    expect(watched.asked.sort()).toEqual(["has db-url", "has model-key", "has oidc-client-secret"]);
    expect(refusedSentences(checks)).toEqual([]);
  });
});

// ── The Checkup ──────────────────────────────────────────────────────────────

function checkupDeps(over: Partial<CheckupDeps> = {}): CheckupDeps {
  return {
    service: {
      name: "launchd",
      state: async () => ({ loaded: true, pid: 4242 }),
      unit: async () => ({ path: "/unit", present: true, executablePath: "/bin/hx-fortress" }),
    } as never,
    status: async () =>
      ({
        host: { writtenAt: new Date().toISOString() },
        connection: { state: "connected", reason: null },
      }) as never,
    db: () => ({ execute: async () => [] }) as never,
    store: () => ({ selfTest: async () => {} }) as unknown as SessionStore,
    embeddingEndpoint: () => "https://models.northstar.example/v1",
    ...over,
  };
}

describe("the Checkup", () => {
  test("has a probe for the setup's answers when the Fortress gives it one, and says that all pass", async () => {
    const results = await runCheckup(checkupDeps({ setupAnswers: async () => [] }));
    expect(results.map((r) => r.name)).toEqual([
      "service",
      "status snapshot",
      "postgres",
      "object store",
      "embeddings",
      "control plane",
      "setup",
    ]);
    expect(results.at(-1)).toEqual({
      name: "setup",
      verdict: "ok",
      detail: "every answer of the setup passes its check",
    });
  });

  test("a Fortress that was set up before the setup's questions existed is not judged by them", async () => {
    // Null: nobody answered the questions here. That is not a failed probe.
    const results = await runCheckup(checkupDeps({ setupAnswers: async () => null }));
    expect(results.at(-1)).toEqual({
      name: "setup",
      verdict: "not-configured",
      detail: "this Fortress was set up before the setup's questions existed; `hx-fortress setup` asks them",
    });
  });

  test("names the refused answers, and counts the ones past the third", async () => {
    const one = await runCheckup(checkupDeps({ setupAnswers: async () => ["AI model: No key with this name"] }));
    expect(one.at(-1)).toEqual({ name: "setup", verdict: "failed", detail: "AI model: No key with this name" });
    expect(summarizeCheckup(one)).toContain("setup: failed (AI model: No key with this name)");

    const five = await runCheckup(
      checkupDeps({ setupAnswers: async () => ["Keys: a", "Sign-in: b", "Data: c", "AI model: d", "Updates: e"] }),
    );
    expect(five.at(-1)?.detail).toBe("Keys: a; Sign-in: b; Data: c; and 2 more");
  });

  test("a check that cannot be made is a probe that failed, not one that passed", async () => {
    const results = await runCheckup(
      checkupDeps({
        setupAnswers: async () => {
          throw new Error("config.json could not be read");
        },
      }),
    );
    expect(results.at(-1)).toEqual({ name: "setup", verdict: "failed", detail: "config.json could not be read" });
  });

  test("a Fortress with no control plane is not told that its connection is down", async () => {
    const results = await runCheckup(
      checkupDeps({
        status: async () =>
          ({
            host: { writtenAt: new Date().toISOString() },
            connection: { state: "offline", reason: NO_CONTROL_PLANE },
          }) as never,
      }),
    );
    const last = results.at(-1);
    expect(last?.verdict).toBe("not-configured");
    expect(last?.detail).toBe("this Fortress has no control plane, by its setup");
    // A connection that is really down still reads as down.
    const down = await runCheckup(
      checkupDeps({
        status: async () =>
          ({
            host: { writtenAt: new Date().toISOString() },
            connection: { state: "offline", reason: "socket closed" },
          }) as never,
      }),
    );
    expect(down.at(-1)).toMatchObject({ verdict: "degraded", detail: "offline — socket closed" });
  });
});
