// What the setup writes on the machine that runs HX Fortress, and what its
// record says about it: the account it names, the questions it names as
// changed, and the answers it leaves to the environment and to the file.

import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { SetupAudit } from "../src/setup/audit";
import { readAnswers } from "../src/setup/read";
import { SetupRun } from "../src/setup/run";
import { BOOTSTRAP_TOKEN_DIGEST_ENV, BOOTSTRAP_TOKEN_EXPIRES_ENV } from "../src/ui/bootstrap-user";
import { OidcConfigStore } from "../src/ui/oidc-config";
import { UsersStore } from "../src/ui/users";
import { spoolRecords, tempRoot, type Paths } from "./host/_module-rig";
import { northstar, providerDocument, rawConfig, runDeps } from "./setup-rig";

// Built at run time so no secret-shaped literal sits in the repository.
const ENV_KEY = ["sk", "from", "the", "environment", "Hb2rNotAReal0ne"].join("-");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function root(): Promise<Paths> {
  const made = await tempRoot();
  cleanups.push(made.cleanup);
  return made.paths;
}

const provider = (async (input: Parameters<typeof fetch>[0]) =>
  String(input).endsWith("/.well-known/openid-configuration")
    ? Response.json(providerDocument("https://login.northstar.example"))
    : new Response(null, { status: 200 })) as unknown as typeof fetch;

async function finishedRecord(paths: Paths): Promise<Record<string, unknown> | null> {
  const intent = (await spoolRecords(paths)).find((r) => r.action === "fortress.setup.finished" && r.kind === "intent");
  return (intent?.params ?? null) as Record<string, unknown> | null;
}

const logins = async (paths: Paths): Promise<string[]> =>
  (await new UsersStore(path.join(paths.uiRoot, "users.json")).load()).users.map((user) => user.login);

describe("the account the record names", () => {
  test("an account that is made is named, also when people sign in through a provider", async () => {
    const paths = await root();
    const deps = runDeps(paths);
    const run = await SetupRun.open({ ...deps, check: { ...deps.check, fetch: provider } });
    northstar(run);
    run.set("signIn.provider", "openid-connect");
    run.set("signIn.issuer", "https://login.northstar.example");
    run.set("signIn.clientId", "hx-fortress");
    run.set("signIn.administratorGroups", "hx-fortress-admins");
    const result = await run.finish("terminal", { audit: new SetupAudit(paths.auditSpool) });
    if (!result.ok) throw new Error(JSON.stringify(result.checks.filter((check) => !check.ok)));
    // The account is the way in when the provider cannot be reached, and the record says it was made.
    expect(await logins(paths)).toEqual(["marta.lindqvist"]);
    expect(await finishedRecord(paths)).toMatchObject({ account: "marta.lindqvist" });
  });

  test("a link from the install that this HX Fortress refuses makes no account, and the record names none", async () => {
    const paths = await root();
    const digest = createHash("sha256").update("a token that stays where it was minted").digest("hex");
    const run = await SetupRun.open(
      runDeps(paths, {
        env: {
          FORTRESS_UI_BOOTSTRAP_USER: "marta.lindqvist",
          [BOOTSTRAP_TOKEN_DIGEST_ENV]: digest,
          // The link ended a minute ago.
          [BOOTSTRAP_TOKEN_EXPIRES_ENV]: new Date(Date.now() - 60_000).toISOString(),
        },
      }),
    );
    run.set("organization.name", "Northstar");
    const result = await run.finish("terminal", { audit: new SetupAudit(paths.auditSpool) });
    if (!result.ok) throw new Error(JSON.stringify(result.checks.filter((check) => !check.ok)));
    expect(result.applied.firstAccount).toBeNull();
    expect(await logins(paths)).toEqual([]);
    const record = await finishedRecord(paths);
    expect(record).not.toBeNull();
    expect(record).not.toHaveProperty("account");
    expect(JSON.stringify(await spoolRecords(paths))).not.toContain(digest);
  });

  test("a login that already has an account is not named: the setup leaves that account as it is", async () => {
    const paths = await root();
    await new UsersStore(path.join(paths.uiRoot, "users.json")).create("marta.lindqvist", "readonly");
    const run = await SetupRun.open(runDeps(paths));
    northstar(run);
    const result = await run.finish("terminal", { audit: new SetupAudit(paths.auditSpool) });
    // Nobody could change anything: the only account reads, and no other is made. So it is refused.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.checks.find((check) => check.step === "signIn")?.lines).toEqual([
        {
          ok: false,
          text: "The account marta.lindqvist exists and does not administer this HX Fortress. Name another first administrator under Organization",
        },
      ]);
    }
    expect(await finishedRecord(paths)).not.toHaveProperty("account");

    // With an account that administers, the same login is left as it is, and no account is named.
    await new UsersStore(path.join(paths.uiRoot, "users.json")).create("erik.holm", "operator");
    const again = await SetupRun.open(runDeps(paths));
    northstar(again);
    const ended = await again.finish("terminal", { audit: new SetupAudit(paths.auditSpool) });
    expect(ended.ok).toBe(true);
    expect(await logins(paths)).toEqual(["marta.lindqvist", "erik.holm"]);
    const intents = (await spoolRecords(paths)).filter((r) => r.action === "fortress.setup.finished" && r.kind === "intent");
    expect(intents.at(-1)?.params).not.toHaveProperty("account");
  });
});

describe("the questions the setup names as changed", () => {
  test("an answer under an option nobody chose changes nothing", async () => {
    const paths = await root();
    const first = await SetupRun.open(runDeps(paths));
    northstar(first);
    expect((await first.finish("terminal")).ok).toBe(true);
    // A provider that was set up once and is switched off still holds its settings.
    await new OidcConfigStore(path.join(paths.uiRoot, "oidc.json")).update((config) => ({
      ...config,
      enabled: false,
      issuer: "https://login.northstar.example",
      clientId: "hx-fortress",
      administratorGroups: ["hx-fortress-admins"],
    }));

    const again = await SetupRun.open(runDeps(paths));
    expect(again.answers.signIn).toMatchObject({ provider: "local", issuer: "https://login.northstar.example" });
    const taken = again.takeFile(JSON.stringify({ signIn: { provider: "local" } }));
    expect(taken.ok).toBe(true);
    // The file empties the provider's fields, and they were in effect for nothing.
    expect(again.answers.signIn.issuer).toBe("");
    expect(again.changedSteps()).toEqual([]);
    const result = await again.finish("file");
    expect(result.ok && result.applied.changed).toEqual([]);
    // What the provider holds is still there for the day it is switched on.
    expect((await new OidcConfigStore(path.join(paths.uiRoot, "oidc.json")).load()).issuer).toBe("https://login.northstar.example");
  });
});

describe("what is left to the environment and to the file", () => {
  test("a provider the environment decides is not written as if a person chose it", async () => {
    const paths = await root();
    const first = await SetupRun.open(runDeps(paths));
    northstar(first);
    expect((await first.finish("terminal")).ok).toBe(true);
    // The file names a provider and a key by its name, from an earlier answer.
    const config = JSON.parse(await readFile(paths.config, "utf8")) as Record<string, unknown>;
    config.model = { provider: "anthropic", key: "model-key" };
    await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

    // Now the host's environment holds a key, which decides the provider.
    const run = await SetupRun.open(runDeps(paths, { env: { FORTRESS_OPENAI_API_KEY: ENV_KEY } }));
    expect(run.present.pinned["model.provider"]).toBe("FORTRESS_OPENAI_API_KEY");
    expect(run.set("model.name", "text-embedding-3-large")).toBe(true);
    const result = await run.finish("terminal");
    if (!result.ok) throw new Error(JSON.stringify(result.checks.filter((check) => !check.ok)));
    const raw = await rawConfig(paths);
    expect(raw.model).toEqual({ provider: "anthropic", key: "model-key", name: "text-embedding-3-large" });
    expect(JSON.stringify(raw)).not.toContain(ENV_KEY);
  });

  test("the audit trail's answer of the earlier list is read, and moves to its new place when it is written", async () => {
    const paths = await root();
    const first = await SetupRun.open(runDeps(paths));
    northstar(first);
    expect((await first.finish("terminal")).ok).toBe(true);
    const config = JSON.parse(await readFile(paths.config, "utf8")) as Record<string, unknown>;
    delete config.auditTrail;
    config.records = { keepFor: "until-removed", copyTo: { to: "syslog", address: "logs.northstar.example:6514" } };
    await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

    const present = await readAnswers(paths, {}, { vaultCredentials: async () => null });
    expect(present.answers.auditTrail).toEqual({
      keepFor: "until-removed",
      copyTo: "syslog",
      copyAddress: "logs.northstar.example:6514",
    });
  });
});
