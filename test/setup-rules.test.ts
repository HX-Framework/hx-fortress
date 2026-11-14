// The rules the setup holds whatever its questions are: what the host's
// environment decides, which control plane an enrollment belongs to, how the
// sign-in there is asked for, when a Fortress counts as set up, and what a
// check may do in each of its modes.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { FileCredentialStore, FilePendingEnrollmentStore } from "../src/cloud/credentials";
import { mergeConfigPatch, patchConfig } from "../src/host/config";
import { DEFAULT_PG_VERSION } from "../src/host/postgres/resolve";
import type { VaultCredentials } from "../src/modules/session-vault/credentials";
import type { SecretProvider } from "../src/secrets/types";
import { defaultAnswers, type SetupAnswers } from "../src/setup/answers";
import { checkStep, type CheckDeps, type CheckLine } from "../src/setup/checks";
import { checkEnrollment, startEnrollment } from "../src/setup/control-plane";
import { readAnswers } from "../src/setup/read";
import { SetupRun } from "../src/setup/run";
import { isSetUp, needsSetupFirst, readSetupMark } from "../src/setup/state";
import { fixedSecrets, tempRoot, type Paths } from "./host/_module-rig";
import { CONTROL, controlPlane, DB_URL, northstar, providerDocument, rawConfig, runDeps, TOKEN } from "./setup-rig";

// Built at run time so no secret-shaped literal sits in the repository.
const A_KEY = ["a", "key", "for", "a", "test"].join("-");
const SEARCH = { FORTRESS_PGVECTOR_URL: "https://downloads.northstar.example/pgvector" };

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

const read = (paths: Paths, env: Record<string, string | undefined> = {}) =>
  readAnswers(paths, env, { vaultCredentials: async () => null });

const texts = (lines: readonly CheckLine[]): string[] => lines.map((line) => line.text);

// ── What the host's environment decides ──────────────────────────────────────

describe("a setting in the host's environment pins exactly the answers it decides", () => {
  test("the model's key in the environment pins the key, and the address and the name stay a person's to give", async () => {
    const paths = await root();
    const env = { FORTRESS_OPENAI_API_KEY: A_KEY };
    const run = await SetupRun.open(runDeps(paths, { env }));
    expect(run.present.pinned).toEqual({
      "model.provider": "FORTRESS_OPENAI_API_KEY",
      "model.key": "FORTRESS_OPENAI_API_KEY",
    });
    northstar(run);
    expect(run.set("model.key", "another-key")).toBe(false);
    expect(run.set("model.address", "https://models.northstar.example/v1")).toBe(true);
    expect(run.set("model.name", "northstar-embed")).toBe(true);
    expect((await run.finish("terminal")).ok).toBe(true);

    // What a person gave is written. No key's name is: the key stays where it is.
    expect((await rawConfig(paths)).model).toEqual({
      provider: "openai-compatible",
      address: "https://models.northstar.example/v1",
      name: "northstar-embed",
    });
    expect(JSON.stringify(await rawConfig(paths))).not.toContain(A_KEY);
    const again = await read(paths, env);
    expect(again.answers.model).toMatchObject({ address: "https://models.northstar.example/v1", name: "northstar-embed" });
    expect(again.kept.modelKey).toBe(true);
  });

  test("the model's address and its name each have a variable of their own", async () => {
    const paths = await root();
    const present = await read(paths, {
      FORTRESS_OPENAI_API_KEY: A_KEY,
      FORTRESS_OPENAI_BASE_URL: "https://gateway.northstar.example/v1",
      FORTRESS_EMBED_MODEL: "northstar-embed",
    });
    expect(present.answers.model).toMatchObject({
      provider: "openai-compatible",
      address: "https://gateway.northstar.example/v1",
      name: "northstar-embed",
      key: "",
    });
    expect(present.pinned).toMatchObject({
      "model.address": "FORTRESS_OPENAI_BASE_URL",
      "model.name": "FORTRESS_EMBED_MODEL",
    });
  });

  test("the storage variables are the file store's answer on a folder that holds no credentials file yet", async () => {
    const paths = await root();
    const present = await read(paths, {
      FORTRESS_SESSIONS: "on",
      FORTRESS_STORAGE_KIND: "s3",
      FORTRESS_STORAGE_BUCKET: "northstar-fortress",
      FORTRESS_STORAGE_REGION: "eu-central-1",
    });
    expect(present.answers.modules.session_vault).toBe(true);
    expect(present.answers.data.files).toMatchObject({
      store: "amazon-s3",
      bucket: "northstar-fortress",
      region: "eu-central-1",
    });
    // Every part of the answer is the environment's, each by its own variable.
    expect(Object.fromEntries(Object.entries(present.pinned).filter(([at]) => at.startsWith("data.files.")))).toEqual({
      "data.files.store": "FORTRESS_STORAGE_BUCKET",
      "data.files.bucket": "FORTRESS_STORAGE_BUCKET",
      "data.files.region": "FORTRESS_STORAGE_REGION",
      "data.files.address": "FORTRESS_S3_ENDPOINT",
      "data.files.project": "FORTRESS_GCS_PROJECT_ID",
    });
  });

  test("a refused answer that the environment decides says where it is put right", async () => {
    const paths = await root();
    const env = { FORTRESS_SESSIONS: "on", FORTRESS_STORAGE_KIND: "s3", FORTRESS_STORAGE_BUCKET: "northstar-fortress", ...SEARCH };
    const present = await read(paths, env);
    const check = await checkStep("data", present.answers, await checkDeps(paths, { env, present }));
    expect(texts(check.lines)).toContain(
      "Give the bucket's region. This host's environment decides this answer: set FORTRESS_STORAGE_REGION there",
    );
  });

  test("the database's key in the environment pins both parts of that answer", async () => {
    const paths = await root();
    const present = await read(paths, { FORTRESS_DATABASE_URL_SECRET: "db-url" });
    expect(present.answers.data.database).toEqual({ store: "postgres", address: "db-url" });
    expect(present.pinned).toEqual({
      "data.database.store": "FORTRESS_DATABASE_URL_SECRET",
      "data.database.address": "FORTRESS_DATABASE_URL_SECRET",
    });
  });

  test("a container's first account is the first administrator, and the setup makes it", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths, { env: { FORTRESS_UI_BOOTSTRAP_USER: "ops" } }));
    expect(run.answers.organization.firstAdministrator).toBe("ops");
    expect(run.present.pinned).toEqual({ "organization.firstAdministrator": "FORTRESS_UI_BOOTSTRAP_USER" });
    // A settings file or a page cannot name another: the console would then make two.
    expect(run.set("organization.firstAdministrator", "marta.lindqvist")).toBe(false);
    run.set("organization.name", "Northstar");
    const result = await run.finish("file");
    expect(result.ok && result.applied.firstAccount?.login).toBe("ops");
  });

  test("a variable that nothing in this build reads pins nothing", async () => {
    const paths = await root();
    const present = await read(paths, { FORTRESS_UPDATE_URL: "https://releases.northstar.example" });
    expect(present.pinned).toEqual({});
    expect(present.answers.updates.from).toBe("project-releases");
  });
});

// ── Which control plane an enrollment belongs to ─────────────────────────────

describe("an enrollment belongs to one control plane", () => {
  const pending = (paths: Paths) => new FilePendingEnrollmentStore(paths.pendingEnrollment);

  /** A Fortress that signed in at control.example and has connected once: the
   *  token is spent, and a credential is held. */
  async function enrolled(paths: Paths): Promise<void> {
    const plane = controlPlane();
    const run = await SetupRun.open(runDeps(paths, { enrollment: plane.deps }));
    northstar(run);
    run.set("controlPlane.connect", "yes");
    run.set("controlPlane.address", "control.example");
    await run.enroll();
    plane.signIn();
    await run.enrollCheck();
    const result = await run.finish("terminal");
    if (!result.ok) throw new Error(`the setup was refused: ${JSON.stringify(result.checks.filter((c) => !c.ok))}`);
    await pending(paths).clear();
    await new FileCredentialStore(paths.credentials).save({
      orgId: "org-northstar",
      fortressId: "fortress-1",
      credential: A_KEY,
    });
  }

  async function disconnect(paths: Paths): Promise<void> {
    const run = await SetupRun.open(runDeps(paths));
    run.set("controlPlane.connect", "no");
    expect((await run.finish("terminal")).ok).toBe(true);
  }

  test("disconnecting keeps the enrollment, and writes down which control plane it belongs to", async () => {
    const paths = await root();
    await enrolled(paths);
    await disconnect(paths);
    expect((await rawConfig(paths)).cloud).toBeUndefined();
    expect((await readSetupMark(paths))?.disconnectedFrom).toBe(CONTROL);
    expect(await new FileCredentialStore(paths.credentials).load()).not.toBeNull();
    // And every later end of the setup carries it forward.
    const later = await SetupRun.open(runDeps(paths));
    later.set("organization.name", "Northstar Ltd");
    expect((await later.finish("terminal")).ok).toBe(true);
    expect((await readSetupMark(paths))?.disconnectedFrom).toBe(CONTROL);
  });

  test("another control plane is refused until a person removes the enrollment by hand", async () => {
    const paths = await root();
    await enrolled(paths);
    await disconnect(paths);
    const plane = controlPlane();
    const run = await SetupRun.open(runDeps(paths, { enrollment: plane.deps }));
    run.set("controlPlane.connect", "yes");
    run.set("controlPlane.address", "other.example");
    const check = await run.check("controlPlane");
    expect(check.ok).toBe(false);
    expect(check.lines[0]?.text).toBe(
      "This Fortress is enrolled with another control plane. To connect it here, stop it, remove the folder " +
        `${path.dirname(paths.credentials)}, and answer this question again. It then enrolls as a new Fortress`,
    );
    // No code is asked for, nothing is written, and the Fortress stays with nobody.
    expect((await run.finish("terminal")).ok).toBe(false);
    expect((await rawConfig(paths)).cloud).toBeUndefined();
    expect(await pending(paths).load()).toBeNull();
  });

  test("the same control plane connects again with no new sign-in", async () => {
    const paths = await root();
    await enrolled(paths);
    await disconnect(paths);
    const run = await SetupRun.open(runDeps(paths));
    run.set("controlPlane.connect", "yes");
    run.set("controlPlane.address", "control.example");
    expect((await run.check("controlPlane")).lines).toEqual([{ ok: true, text: "This Fortress is enrolled there" }]);
    expect((await run.finish("terminal")).ok).toBe(true);
    expect((await rawConfig(paths)).cloud).toEqual({ url: CONTROL });
    expect((await readSetupMark(paths))?.disconnectedFrom).toBeUndefined();
    expect(await pending(paths).load()).toBeNull();
  });

  test("an enrollment that nothing on the host explains is refused, whatever the address", async () => {
    const paths = await root();
    const first = await SetupRun.open(runDeps(paths));
    northstar(first);
    expect((await first.finish("terminal")).ok).toBe(true);
    await new FileCredentialStore(paths.credentials).save({ orgId: "org", fortressId: "f", credential: A_KEY });
    const run = await SetupRun.open(runDeps(paths, { enrollment: controlPlane().deps }));
    run.set("controlPlane.connect", "yes");
    run.set("controlPlane.address", "control.example");
    const check = await run.check("controlPlane");
    expect(check.ok).toBe(false);
    expect(check.lines[0]?.text).toStartWith(
      "This Fortress holds an enrollment, and its settings do not say with which control plane.",
    );
  });

  test("a sign-in is used even when the answer did not change: the settings named a control plane the Fortress held no enrollment for", async () => {
    const paths = await root();
    await enrolled(paths);
    // The enrollment is gone, and config.json still names the control plane.
    await unlink(paths.credentials);
    const plane = controlPlane();
    const run = await SetupRun.open(runDeps(paths, { enrollment: plane.deps }));
    expect(run.changedSteps()).toEqual([]);
    expect((await run.check("controlPlane")).ok).toBe(false);
    await run.enroll();
    plane.signIn();
    await run.enrollCheck();
    expect((await run.check("controlPlane")).lines).toEqual([
      { ok: true, text: "Signed in. This Fortress connects when it starts" },
    ]);
    expect((await run.finish("terminal")).ok).toBe(true);
    expect((await pending(paths).load())?.token).toBe(TOKEN);
  });

  test("a token that cannot be kept leaves the settings saved, and a line says what to do", async () => {
    const paths = await root();
    // Something is in the way of the file the token is kept in.
    await mkdir(paths.pendingEnrollment, { recursive: true });
    const plane = controlPlane();
    const run = await SetupRun.open(runDeps(paths, { enrollment: plane.deps }));
    northstar(run);
    run.set("controlPlane.connect", "yes");
    run.set("controlPlane.address", "control.example");
    await run.enroll();
    plane.signIn();
    await run.enrollCheck();
    const result = await run.finish("terminal");
    expect(result.ok).toBe(true);
    // config.json is whole: the Fortress is set up, and simply not enrolled yet.
    expect((await rawConfig(paths)).cloud).toEqual({ url: CONTROL });
    expect(await isSetUp(paths)).toBe(true);
    expect(result.ok && result.applied.notes.join(" ")).toContain("Sign in again: hx-fortress setup control-plane");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

// ── The sign-in at the control plane ─────────────────────────────────────────

describe("the sign-in at the control plane", () => {
  const code = (expiresAt: string) => ({
    userCode: "K7Q-42M",
    deviceCode: "device-code-for-a-test",
    verificationUriComplete: "https://control.example/install?code=K7Q-42M",
    interval: 5,
    expiresAt,
  });

  test("a control plane that takes the connection and never answers does not hold the setup", async () => {
    const hung = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const began = Date.now();
    await expect(startEnrollment(CONTROL, { fetch: hung, timeoutMs: 40 })).rejects.toThrow(
      "No control plane answers at this address",
    );
    expect(Date.now() - began).toBeLessThan(2_000);
  });

  test("neither request follows a redirect, and each has a deadline", async () => {
    const seen: RequestInit[] = [];
    const plane = (async (input: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return String(input).endsWith("/vault/install/code")
        ? Response.json(code(new Date(Date.now() + 600_000).toISOString()))
        : Response.json({ status: "pending" });
    }) as typeof fetch;
    const enrollment = await startEnrollment(CONTROL, { fetch: plane });
    expect(await checkEnrollment(enrollment, { fetch: plane })).toEqual({ state: "waiting" });
    expect(seen.map((init) => [init.redirect, init.signal instanceof AbortSignal])).toEqual([
      ["error", true],
      ["error", true],
    ]);
  });

  test("how long a code lives is counted on this host's clock, so a clock that is wrong does not end it", async () => {
    // This host's clock is two hours ahead of the control plane's.
    let now = Date.parse("2026-11-14T12:00:00Z");
    const deps = { requestCode: async () => code("2026-11-14T10:10:00Z"), now: () => now };
    const enrollment = await startEnrollment(CONTROL, deps);
    const nobodyYet = { poll: async () => ({ kind: "expired" as const }), now: () => now };
    expect(await checkEnrollment(enrollment, nobodyYet)).toEqual({ state: "waiting" });
    now += 10 * 60_000 + 1;
    expect(await checkEnrollment(enrollment, nobodyYet)).toEqual({ state: "expired" });
  });

  test("an answer that is not what a control plane sends changes nothing", async () => {
    const enrollment = await startEnrollment(CONTROL, {
      requestCode: async () => code(new Date(Date.now() + 600_000).toISOString()),
    });
    const broken = {
      poll: async () => {
        throw new TypeError("null is not an object");
      },
    };
    expect(await checkEnrollment(enrollment, broken)).toEqual({ state: "waiting" });
  });

  test("a request for a new code that fails leaves an earlier sign-in as it was", async () => {
    const paths = await root();
    const plane = controlPlane();
    let down = false;
    const run = await SetupRun.open(
      runDeps(paths, {
        enrollment: {
          ...plane.deps,
          requestCode: async (base, calls) => {
            if (down) throw new Error("nothing answers");
            return (plane.deps.requestCode as NonNullable<typeof plane.deps.requestCode>)(base, calls);
          },
        },
      }),
    );
    northstar(run);
    run.set("controlPlane.connect", "yes");
    run.set("controlPlane.address", "control.example");
    await run.enroll();
    plane.signIn();
    await run.enrollCheck();
    expect(run.derived().enrollment.state).toBe("ready");

    down = true;
    await expect(run.enroll()).rejects.toThrow("No control plane answers at this address");
    // The sign-in that did happen still stands, and its token is still held.
    expect(run.derived().enrollment.state).toBe("ready");
    expect((await run.finish("terminal")).ok).toBe(true);
    expect((await new FilePendingEnrollmentStore(paths.pendingEnrollment).load())?.token).toBe(TOKEN);
  });
});

// ── When a Fortress counts as set up ─────────────────────────────────────────

describe("a Fortress is set up when its config.json is its own", () => {
  test("a file that holds only the key store's block is not one, and the setup keeps the block", async () => {
    const paths = await root();
    const folder = path.join(paths.root, "keys");
    await mkdir(folder, { recursive: true });
    await mkdir(path.dirname(paths.config), { recursive: true });
    await writeFile(paths.config, JSON.stringify({ secrets: { provider: "file", dir: folder } }));
    expect(await isSetUp(paths)).toBe(false);
    expect(await needsSetupFirst(paths, {})).toBe(true);

    const run = await SetupRun.open(runDeps(paths));
    expect(run.present.setUp).toBe(false);
    expect(run.answers.keys).toMatchObject({ store: "file", folder });
    // A new install's modules, not the list an older config.json would get.
    expect(run.answers.modules.session_vault).toBe(false);
    northstar(run);
    expect((await run.finish("terminal")).ok).toBe(true);

    const raw = await rawConfig(paths);
    expect(raw.schemaVersion).toBe(1);
    expect(raw.secrets).toEqual({ provider: "file", dir: folder });
    expect(raw.organization).toEqual({ name: "Northstar" });
    expect(await isSetUp(paths)).toBe(true);
    expect(await needsSetupFirst(paths, {})).toBe(false);
  });

  test("a file that cannot be read counts as set up, so nothing writes over it", async () => {
    const paths = await root();
    await mkdir(path.dirname(paths.config), { recursive: true });
    await writeFile(paths.config, "{not json");
    expect(await isSetUp(paths)).toBe(true);
    expect(await needsSetupFirst(paths, {})).toBe(false);
  });

  test("the check of a change and the write of it are one function, and fill in what every config.json has", async () => {
    const paths = await root();
    const ahead = { secrets: { provider: "env" } };
    const merged = mergeConfigPatch(ahead, { organization: { name: "Northstar" } });
    expect(merged.next).toMatchObject({ schemaVersion: 1, modules: { enabled: [] }, secrets: { provider: "env" } });
    expect(merged.checked.organization).toEqual({ name: "Northstar" });

    await mkdir(path.dirname(paths.config), { recursive: true });
    await writeFile(paths.config, JSON.stringify(ahead));
    await patchConfig(paths, { organization: { name: "Northstar" } });
    expect(await rawConfig(paths)).toEqual(merged.next);
  });
});

// ── What a check may do ──────────────────────────────────────────────────────

async function checkDeps(paths: Paths, over: Partial<CheckDeps> = {}): Promise<CheckDeps> {
  const env = over.env ?? {};
  return {
    paths,
    env,
    present: await read(paths, env),
    keyStore: () => fixedSecrets({ "db-url": DB_URL, "model-key": A_KEY, "oidc-client-secret": A_KEY }),
    fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    probeDatabase: async () => "PostgreSQL 17.2",
    probeFiles: async () => {},
    timeoutMs: 2_000,
    ...over,
  };
}

function answers(change: (a: SetupAnswers) => void = () => {}): SetupAnswers {
  const a = defaultAnswers(["session_vault", "host"]);
  a.organization = { name: "Northstar", firstAdministrator: "marta.lindqvist" };
  change(a);
  return a;
}

const sessions = (a: SetupAnswers): void => {
  a.modules.session_vault = true;
  a.model = { ...a.model, provider: "openai-compatible", address: "https://models.northstar.example/v1", key: "model-key" };
  a.data.files = { ...a.data.files, store: "s3-compatible", address: "https://minio.northstar.example", bucket: "fortress" };
};

describe("what a check may do", () => {
  test("while a person is still typing, no request leaves this host and nothing is opened", async () => {
    const paths = await root();
    const outside: string[] = [];
    const asked: string[] = [];
    const watched: SecretProvider = {
      kind: "azure-key-vault",
      get: async (name) => {
        asked.push(`get ${name}`);
        return A_KEY;
      },
      has: async (name) => {
        asked.push(`has ${name}`);
        return true;
      },
    };
    const typed = answers((a) => {
      sessions(a);
      a.keys = { ...a.keys, store: "azure-key-vault", address: "https://northstar-fortress.vault.azure.net" };
      a.signIn = {
        ...a.signIn,
        provider: "openid-connect",
        issuer: "https://login.northstar.example",
        clientId: "hx-fortress",
        clientSecret: "oidc-client-secret",
        operatorGroups: ["fortress-admins"],
      };
      a.data.database = { store: "postgres", address: "db-url" };
    });
    const deps = await checkDeps(paths, {
      when: "typing",
      env: SEARCH,
      keyStore: () => watched,
      fetch: (async (input: unknown) => {
        outside.push(String(input));
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
      probeDatabase: async () => {
        outside.push("the database");
        return "PostgreSQL 17.2";
      },
      probeFiles: async () => {
        outside.push("the file store");
      },
    });
    for (const step of ["keys", "signIn", "data", "model", "network"] as const) {
      const check = await checkStep(step, typed, deps);
      expect([step, check.ok]).toEqual([step, true]);
    }
    expect(outside).toEqual([]);
    expect(asked).toEqual([]);
    // What the host can see by itself is still said: the shape of an answer.
    const wrong = await checkStep("data", answers((a) => {
      a.data.database = { store: "postgres", address: "Not A Name" };
    }), deps);
    expect(texts(wrong.lines)).toEqual(["Not a key's name"]);
  });

  test("an address that holds a user name or a password is refused, so no credential is written down with it", async () => {
    const paths = await root();
    const model = await checkStep(
      "model",
      answers((a) => {
        sessions(a);
        a.model.address = "https://user:token@models.northstar.example/v1";
      }),
      await checkDeps(paths),
    );
    expect(texts(model.lines)).toEqual(["The model's address must be https, with no user name or password in it"]);
    const files = await checkStep(
      "data",
      answers((a) => {
        sessions(a);
        a.data.files.address = "https://access:secret@minio.northstar.example";
      }),
      await checkDeps(paths, { env: SEARCH }),
    );
    expect(texts(files.lines)).toContain("The storage's address must be https, with no user name or password in it");
  });

  test("a sign-in provider the console would refuse is refused here, by the console's own rules", async () => {
    const paths = await root();
    const issuer = "https://login.northstar.example";
    const check = await checkStep(
      "signIn",
      answers((a) => {
        a.signIn = { ...a.signIn, provider: "openid-connect", issuer, clientId: "hx-fortress", operatorGroups: ["fortress-admins"] };
      }),
      await checkDeps(paths, {
        // It names the right issuer, and gives a token address that is not https.
        fetch: (async () =>
          Response.json({ ...providerDocument(issuer), token_endpoint: "http://login.northstar.example/token" })) as unknown as typeof fetch,
      }),
    );
    expect(check.ok).toBe(false);
    expect(texts(check.lines)).toEqual([
      "The provider at this address cannot sign people in to this console: the discovery document lacks an https authorization, token or key endpoint",
    ]);
  });

  test("Sessions with Postgres on this disk and no control plane is refused in words, and taken where the extension can be had", async () => {
    const paths = await root();
    const refusal =
      "Sessions searches with a database extension, and this build downloads it through a control plane. " +
      "Connect one, use your own Postgres, or switch Sessions off under Modules";
    const on = answers(sessions);
    expect(texts((await checkStep("data", on, await checkDeps(paths))).lines)).toContain(refusal);
    // A download address in the environment.
    expect(texts((await checkStep("data", on, await checkDeps(paths, { env: SEARCH }))).lines)).not.toContain(refusal);
    // A control plane.
    const connected = answers((a) => {
      sessions(a);
      a.controlPlane = { ...a.controlPlane, connect: "yes", address: "control.example" };
    });
    expect(texts((await checkStep("data", connected, await checkDeps(paths))).lines)).not.toContain(refusal);
    // The extension already on this disk, from an earlier start.
    const extensions = path.join(paths.postgresVersionDir(DEFAULT_PG_VERSION), "share", "extension");
    await mkdir(extensions, { recursive: true });
    await writeFile(path.join(extensions, "vector.control"), "comment = 'vector'\n");
    expect(texts((await checkStep("data", on, await checkDeps(paths))).lines)).not.toContain(refusal);
  });

  test("keys an earlier setup kept for the same bucket are the ones the test write uses", async () => {
    const paths = await root();
    const kept: VaultCredentials = {
      store: "s3",
      bucket: "fortress",
      region: "eu-central-1",
      s3: { accessKeyId: ["AKID", "FOR", "A", "TEST"].join(""), secretAccessKey: A_KEY },
    };
    const present = await readAnswers(paths, {}, { vaultCredentials: async () => kept });
    expect(present.kept.filesKeys).toBe(true);
    const on = structuredClone(present.answers);
    on.organization = { name: "Northstar", firstAdministrator: "marta.lindqvist" };
    on.modules.session_vault = true;
    const tried: VaultCredentials[] = [];
    const deps = await checkDeps(paths, {
      env: SEARCH,
      present,
      vaultCredentials: async () => kept,
      probeFiles: async (credentials) => {
        tried.push(credentials);
      },
    });
    const same = await checkStep("data", on, deps);
    expect(texts(same.lines)).toContain("A test file was written, read and removed");
    expect(tried).toEqual([kept]);
    // Another bucket is tested with this host's own access, and no key.
    const moved = structuredClone(on);
    moved.data.files.bucket = "another-bucket";
    await checkStep("data", moved, deps);
    expect(tried[1]).toEqual({ store: "s3", bucket: "another-bucket", region: "eu-central-1" });
    // No reply holds a key.
    expect(JSON.stringify(same)).not.toContain(A_KEY);
  });

  test("the model is asked what the Fortress will ask: one function gives the address, the name and the size", async () => {
    const paths = await root();
    const sent: { url: string; body: unknown; key: string | null }[] = [];
    const check = await checkStep(
      "model",
      answers(sessions),
      await checkDeps(paths, {
        env: { FORTRESS_EMBED_DIMENSIONS: "512" },
        fetch: (async (input: unknown, init?: RequestInit) => {
          sent.push({
            url: String(input),
            body: JSON.parse(String(init?.body)),
            key: new Headers(init?.headers).get("authorization"),
          });
          return Response.json({ data: [{ embedding: [0.1] }] });
        }) as unknown as typeof fetch,
      }),
    );
    expect(check.ok).toBe(true);
    expect(sent).toEqual([
      {
        url: "https://models.northstar.example/v1/embeddings",
        body: { model: "text-embedding-3-large", input: ["ready"], dimensions: 512 },
        key: `Bearer ${A_KEY}`,
      },
    ]);
    expect(JSON.stringify(check)).not.toContain(A_KEY);
  });

  test("a question that passed a moment ago is not asked of the outside again, and a refused one is", async () => {
    const paths = await root();
    let probes = 0;
    let reachable = true;
    const deps = runDeps(paths);
    const run = await SetupRun.open({
      ...deps,
      check: {
        ...deps.check,
        probeDatabase: async () => {
          probes += 1;
          if (!reachable) throw new Error("ECONNREFUSED");
          return "PostgreSQL 17.2";
        },
      },
    });
    northstar(run);
    run.set("data.database.store", "postgres");
    run.set("data.database.address", "db-url");
    // The question, the review and the end, one after another.
    expect((await run.check("data")).ok).toBe(true);
    expect((await run.checkAll()).find((check) => check.step === "data")?.ok).toBe(true);
    expect((await run.check("data")).ok).toBe(true);
    expect(probes).toBe(1);
    // Another answer is another question.
    run.set("organization.name", "Northstar Ltd");
    await run.check("data");
    expect(probes).toBe(2);
    // A refused answer is asked about every time: the person is putting it right.
    reachable = false;
    run.set("organization.name", "Northstar");
    expect((await run.check("data")).ok).toBe(false);
    expect((await run.check("data")).ok).toBe(false);
    expect(probes).toBe(4);
  });
});
