// The database URL given as the NAME of a secret (FORTRESS_DATABASE_URL_SECRET).
//
// The value is read from the secret provider when the daemon starts. It must
// reach the Postgres provider and nothing else: not a file, not a log line,
// not the process environment. pg.json carries the secret's name, and the
// console reads the same secret with its own provider.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  embeddedPgJson,
  externalPgJson,
  namesDatabaseSecret,
  readPgJson,
  resolveRoleDsn,
  writePgJson,
} from "../src/host/postgres/pg-json";
import { SecretMissing, SecretUnavailable, type SecretProvider } from "../src/secrets";
import { UI_CONFIG_DEFAULTS } from "../src/ui/config";
import { generateRoleSql } from "../src/host/postgres/print-role-sql";
import { resolveConsoleDb, SecretDatabaseUrl } from "../src/ui/console-db";
import { dataPathRows, type EgressInputs } from "../src/ui/egress";
import { randomLabel } from "./rig/azure-fakes";
import { bootHost, UNREACHABLE_DATABASE_URL, type HostBoot } from "./rig/host-boot";

const SECRET_NAME = "fortress-database-url";

/** A DSN nothing listens on, with a password no other text holds. */
function markedDatabaseUrl(): { url: string; marker: string } {
  const marker = randomLabel("pw");
  return { url: `postgresql://fortress:${marker}@127.0.0.1:1/fortress`, marker };
}

describe("pg.json when the database URL came from a secret", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-pgjson-secret-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("the daemon writes the secret's name and never the URL", async () => {
    const { url, marker } = markedDatabaseUrl();
    const value = externalPgJson({ databaseUrl: url, databaseUrlSecret: SECRET_NAME });
    expect(value).toEqual({ mode: "external", databaseUrlSecret: SECRET_NAME });

    const file = path.join(root, "ui", "pg.json");
    await writePgJson(file, value);
    const text = await readFile(file, "utf8");
    expect(text).not.toContain(marker);
    expect(text).not.toContain("postgresql://");

    const parsed = await readPgJson(file);
    expect(parsed).toEqual({ mode: "external", databaseUrlSecret: SECRET_NAME });
    expect(parsed !== null && namesDatabaseSecret(parsed)).toBe(true);
  });

  test("a URL the operator gave directly is written as before", () => {
    const direct = externalPgJson({ databaseUrl: "postgresql://op:pw@db.example.com:5432/hx" });
    expect(direct).toEqual({ mode: "external", databaseUrl: "postgresql://op:pw@db.example.com:5432/hx" });
    expect(namesDatabaseSecret(direct)).toBe(false);
    expect(namesDatabaseSecret(embeddedPgJson({ host: "127.0.0.1", port: 5432, database: "hx-db", password: "p" }))).toBe(false);
  });

  test("a name that breaks the secret-name rule makes the file unreadable, not a lookup", async () => {
    const file = path.join(root, "ui", "pg.json");
    for (const databaseUrlSecret of ["../../etc/passwd", "DB_URL", "", 7, null]) {
      await writePgJson(file, { mode: "external", databaseUrlSecret } as never);
      expect(await readPgJson(file)).toBeNull();
    }
  });
});

describe("the console's DSN when pg.json names a secret", () => {
  const named = { mode: "external", databaseUrlSecret: SECRET_NAME } as const;

  test("it is the value read from that secret", () => {
    expect(resolveRoleDsn({ pgJson: named, secretDatabaseUrl: "postgresql://op:pw@db.example.com/hx" })).toBe(
      "postgresql://op:pw@db.example.com/hx",
    );
  });

  test("with no value read there is no DSN, and nothing is guessed", () => {
    expect(resolveRoleDsn({ pgJson: named })).toBeNull();
    expect(resolveRoleDsn({ pgJson: named, secretDatabaseUrl: "  " })).toBeNull();
    expect(resolveConsoleDb({ pgJson: named, uiDatabaseUrl: null })).toEqual({ kind: "not-configured" });
  });

  test("an explicit ui.json databaseUrl still wins", () => {
    expect(
      resolveRoleDsn({
        pgJson: named,
        uiDatabaseUrl: "postgresql://hx_ui:pw@db.example.com/hx",
        secretDatabaseUrl: "postgresql://op:pw@db.example.com/hx",
      }),
    ).toBe("postgresql://hx_ui:pw@db.example.com/hx");
  });

  test("the console reports the database as external", () => {
    const state = resolveConsoleDb({
      pgJson: named,
      uiDatabaseUrl: null,
      secretDatabaseUrl: "postgresql://op:pw@db.example.com/hx",
    });
    expect(state.kind).toBe("ready");
    expect(state.kind === "ready" && state.mode).toBe("external");
  });
});

/** A provider whose answers a test scripts one call at a time. */
function scripted(answers: Array<string | Error>): () => Promise<SecretProvider> {
  const provider: SecretProvider = {
    kind: "azure-key-vault",
    async get(): Promise<string> {
      const next = answers.shift();
      if (next === undefined) throw new Error("the test scripted no further answer");
      if (next instanceof Error) throw next;
      return next;
    },
    async has(): Promise<boolean> {
      return true;
    },
  };
  return async () => provider;
}

describe("reading the database URL secret from the console", () => {
  const unavailable = (): SecretUnavailable =>
    new SecretUnavailable(SECRET_NAME, "the vault did not answer (timed out)", { transient: true });

  test("the value is read through the provider", async () => {
    const reader = new SecretDatabaseUrl(scripted(["postgresql://op:pw@db.example.com/hx"]));
    expect(await reader.read(SECRET_NAME)).toEqual({
      url: "postgresql://op:pw@db.example.com/hx",
      problem: null,
    });
  });

  test("a store that cannot answer does not take a working connection away", async () => {
    const reader = new SecretDatabaseUrl(scripted(["postgresql://first", unavailable(), "postgresql://second"]));
    expect((await reader.read(SECRET_NAME)).url).toBe("postgresql://first");
    // The store misses one request: the value read last is used again.
    expect(await reader.read(SECRET_NAME)).toEqual({ url: "postgresql://first", problem: null });
    // The store answers again, with a new value: that one is used.
    expect((await reader.read(SECRET_NAME)).url).toBe("postgresql://second");
  });

  test("with nothing read before, a store that cannot answer is a named problem", async () => {
    const reader = new SecretDatabaseUrl(scripted([unavailable()]));
    expect(await reader.read(SECRET_NAME)).toEqual({
      url: null,
      problem: `secret "${SECRET_NAME}" could not be read: the vault did not answer (timed out)`,
    });
  });

  test("a secret that is gone is reported, and the value read earlier is not used again", async () => {
    const reader = new SecretDatabaseUrl(
      scripted(["postgresql://first", new SecretMissing(SECRET_NAME), unavailable()]),
    );
    await reader.read(SECRET_NAME);
    expect(await reader.read(SECRET_NAME)).toEqual({
      url: null,
      problem: `secret "${SECRET_NAME}" is not set`,
    });
    // The earlier value was dropped with it.
    expect((await reader.read(SECRET_NAME)).url).toBeNull();
  });

  test("a store that refuses for good is a named problem, and the value read before is dropped", async () => {
    const refused = new SecretUnavailable(SECRET_NAME, "the vault refused the token (401 Unauthorized)", {
      transient: false,
    });
    const reader = new SecretDatabaseUrl(scripted(["postgresql://first", refused, unavailable()]));
    await reader.read(SECRET_NAME);
    expect(await reader.read(SECRET_NAME)).toEqual({
      url: null,
      problem: `secret "${SECRET_NAME}" could not be read: the vault refused the token (401 Unauthorized)`,
    });
    // Dropped: a store that cannot answer next time has nothing to fall back to.
    expect((await reader.read(SECRET_NAME)).url).toBeNull();
  });

  test("a secret that no longer holds a database URL is reported without its value", async () => {
    const marker = randomLabel("pw");
    const reader = new SecretDatabaseUrl(
      scripted(["postgresql://first", `host=db.internal user=fortress password=${marker}`]),
    );
    await reader.read(SECRET_NAME);
    const read = await reader.read(SECRET_NAME);
    expect(read).toEqual({
      url: null,
      problem: `secret "${SECRET_NAME}" could not be read: its value is not a postgres:// connection URL`,
    });
    expect(JSON.stringify(read)).not.toContain(marker);
  });

  test("the operator is told once that a value read before is still in use", async () => {
    const told: string[] = [];
    const reader = new SecretDatabaseUrl(
      scripted([
        "postgresql://first",
        unavailable(),
        unavailable(),
        "postgresql://second",
        unavailable(),
      ]),
      (reason) => told.push(reason),
    );
    await reader.read(SECRET_NAME);
    await reader.read(SECRET_NAME);
    await reader.read(SECRET_NAME);
    // Two misses in a row are one thing to say.
    expect(told).toEqual([`secret "${SECRET_NAME}" could not be read: the vault did not answer (timed out)`]);
    await reader.read(SECRET_NAME);
    await reader.read(SECRET_NAME);
    // A miss after a good read is a new one.
    expect(told).toHaveLength(2);
  });

  test("a value read under one name is never returned for another", async () => {
    const reader = new SecretDatabaseUrl(scripted(["postgresql://first", unavailable()]));
    await reader.read(SECRET_NAME);
    expect((await reader.read("another-database-url")).url).toBeNull();
  });

  test("a provider that cannot be built is a problem, not a crash", async () => {
    const reader = new SecretDatabaseUrl(async () => {
      throw new Error("Invalid secrets config: config.json is not valid JSON");
    });
    expect(await reader.read(SECRET_NAME)).toEqual({
      url: null,
      problem: "Invalid secrets config: config.json is not valid JSON",
    });
  });

  test("printing the reader shows nothing it holds", async () => {
    const { url, marker } = markedDatabaseUrl();
    const reader = new SecretDatabaseUrl(scripted([url]));
    await reader.read(SECRET_NAME);
    expect(`${JSON.stringify(reader)} ${Bun.inspect(reader)}`).not.toContain(marker);
  });
});

describe("the data paths page lists where secrets are read from", () => {
  const inputs = (over: Partial<EgressInputs>): EgressInputs => ({
    ui: { ...UI_CONFIG_DEFAULTS },
    boundPort: 8788,
    postgres: { mode: "external", host: "db.example.com", database: "hx", tls: true },
    cloudUrl: "wss://hub.example.com/vault-tunnel",
    downloadBase: null,
    postgresBinariesUrl: null,
    bucket: null,
    embeddingEndpoint: null,
    ssoAdvertised: false,
    rosterRetentionDays: 90,
    ...over,
  });
  const row = (over: Partial<EgressInputs>) => dataPathRows(inputs(over)).find((r) => r.id === "secret-store");

  test("Azure Key Vault is a network path, with the vault and the identity named", () => {
    const vault = row({
      secrets: {
        provider: "azure-key-vault",
        vault: { origin: "https://contoso-kv.vault.azure.net", resource: "https://vault.azure.net" },
      },
      secretNames: [SECRET_NAME],
    });
    expect(vault?.direction).toBe("both");
    expect(vault?.peer).toBe(
      "https://contoso-kv.vault.azure.net, with a token from the platform's managed identity endpoint",
    );
    expect(vault?.gate).toContain("Key Vault Secrets User");
    expect(vault?.notes?.[0]).toBe(`Read by name on this host: ${SECRET_NAME}.`);
    expect(vault?.notes?.join(" ")).toContain("The control plane is not on this path");
  });

  test("the environment and a directory are on this host, and the row says so", () => {
    const env = row({ secrets: { provider: "env" } });
    expect(env?.direction).toBe("in");
    expect(env?.peer).toContain("FORTRESS_SECRET_* variables");
    expect(env?.peer).toContain("nothing leaves this host");
    expect(env?.notes).toContain("This console sees no setting that is given by secret name.");

    const file = row({ secrets: { provider: "file", dir: "/run/secrets" } });
    expect(file?.peer).toBe("/run/secrets - a directory on this host, nothing leaves it");
  });

  test("settings that could not be read are reported as not resolved, never guessed", () => {
    expect(row({ secrets: null })?.peer).toBe("not resolved");
    // A caller that does not pass the field at all still gets the row.
    expect(row({})?.peer).toBe("not resolved");
  });
});

describe("a daemon whose database URL is given by secret name", () => {
  let boot: HostBoot | null = null;
  afterEach(async () => {
    await boot?.cleanup();
    boot = null;
  });

  /** Sessions is on by default, and it needs an embedding key to start. */
  const SESSIONS_ON = { FORTRESS_OPENAI_API_KEY: "sk-test-fortress-openai-key" };

  test("starts on the database the secret names, and writes the value nowhere", async () => {
    const { url, marker } = markedDatabaseUrl();
    boot = await bootHost({
      env: {
        ...SESSIONS_ON,
        FORTRESS_DATABASE_URL_SECRET: SECRET_NAME,
        FORTRESS_SECRET_FORTRESS_DATABASE_URL: url,
      },
      scenario: { waitForFrames: ["enroll"] },
    });
    expect(boot.report.error).toBeNull();
    expect(boot.report.started).toBe(true);
    expect(boot.report.frames.map((frame) => frame.t)).toContain("enroll");
    // The default provider needs nothing from the host, and says nothing.
    expect(boot.stdout).not.toContain("It needs:");

    // "retrying" is what an external database that does not answer looks like.
    // The embedded Postgres would say "acquiring" or "failed" instead.
    const status = await boot.status();
    expect((status?.postgres as { phase?: string } | undefined)?.phase).toBe("retrying");
    expect(existsSync(boot.paths.postgresRoot)).toBe(false);

    // Not in a file, not in a log line, not in status.json.
    expect(await boot.whereWritten(marker)).toEqual([]);
    // The same search does find a value the daemon wrote down: the hub's address.
    expect(await boot.whereWritten("ws://127.0.0.1")).toContain("config.json");
  }, 30_000);

  test("reads the value from Azure Key Vault with the managed identity", async () => {
    const { url, marker } = markedDatabaseUrl();
    boot = await bootHost({
      env: { ...SESSIONS_ON, FORTRESS_DATABASE_URL_SECRET: SECRET_NAME },
      scenario: { waitForFrames: ["enroll"], keyVault: { secrets: { [SECRET_NAME]: url } } },
    });
    expect(boot.report.error).toBeNull();
    expect(boot.report.started).toBe(true);
    expect(boot.report.keyVault?.tokenRequests).toBe(1);
    expect(boot.report.keyVault?.secretPaths).toEqual([`/secrets/${SECRET_NAME}`]);
    // A provider that needs something from the host says so when the fortress
    // starts: this one cannot work on a host that gives it no identity.
    expect(boot.stdout).toContain("secrets are read by the azure-key-vault (https://");
    expect(boot.stdout).toContain("provider. It needs: A managed identity.");

    const status = await boot.status();
    expect((status?.postgres as { phase?: string } | undefined)?.phase).toBe("retrying");
    expect(await boot.whereWritten(marker)).toEqual([]);
  }, 30_000);

  test("does not start when the secret is missing, and does not fall back to the embedded Postgres", async () => {
    boot = await bootHost({
      env: { ...SESSIONS_ON, FORTRESS_DATABASE_URL_SECRET: SECRET_NAME },
      scenario: {},
    });
    expect(boot.report.started).toBe(false);
    expect(boot.report.error).toBe(`secret "${SECRET_NAME}" is not set`);
    // It stopped before it connected to anything.
    expect(boot.report.frames).toEqual([]);
    expect(existsSync(boot.paths.postgresRoot)).toBe(false);
    // The operator's log says which secret, and where it was looked for.
    expect(boot.stdout).toContain("the database URL secret could not be read, so this fortress will not start");
    expect(boot.stdout).toContain("environment variable FORTRESS_SECRET_FORTRESS_DATABASE_URL");
  }, 30_000);

  test("does not start on a secret that is not a database URL, and writes its value nowhere", async () => {
    const marker = randomLabel("pw");
    boot = await bootHost({
      env: {
        ...SESSIONS_ON,
        FORTRESS_DATABASE_URL_SECRET: SECRET_NAME,
        // Connection settings in the keyword form. The driver's own error for
        // a string like this quotes it whole.
        FORTRESS_SECRET_FORTRESS_DATABASE_URL: `host=db.internal port=5432 dbname=hx user=fortress password=${marker} sslmode=require`,
      },
      scenario: {},
    });
    expect(boot.report.started).toBe(false);
    expect(boot.report.error).toBe(
      `secret "${SECRET_NAME}" could not be read: its value is not a postgres:// connection URL`,
    );
    expect(boot.report.frames).toEqual([]);
    expect(existsSync(boot.paths.postgresRoot)).toBe(false);
    // Not in a file, not in a log line, not in status.json.
    expect(await boot.whereWritten(marker)).toEqual([]);
  }, 30_000);

  test("does not start on secret settings it does not understand, even when no secret is read", async () => {
    boot = await bootHost({
      env: {
        ...SESSIONS_ON,
        FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL,
        FORTRESS_SECRETS_PROVIDER: "key-vault",
      },
      scenario: {},
    });
    expect(boot.report.started).toBe(false);
    expect(boot.report.error).toBe(
      "Invalid secrets config: FORTRESS_SECRETS_PROVIDER must be one of env, file, azure-key-vault",
    );
    expect(boot.stdout).toContain("the secret settings are not valid, so this fortress will not start");
    expect(boot.report.frames).toEqual([]);
  }, 30_000);

  test("refuses the value and the name given together", async () => {
    boot = await bootHost({
      env: {
        ...SESSIONS_ON,
        FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL,
        FORTRESS_DATABASE_URL_SECRET: SECRET_NAME,
      },
      scenario: {},
    });
    expect(boot.report.started).toBe(false);
    expect(boot.report.error).toBe(
      "FORTRESS_DATABASE_URL and FORTRESS_DATABASE_URL_SECRET are both set. Set one of them",
    );
  }, 30_000);

  test("a URL given directly still works as before", async () => {
    boot = await bootHost({
      env: { ...SESSIONS_ON, FORTRESS_DATABASE_URL: UNREACHABLE_DATABASE_URL },
      scenario: { waitForFrames: ["enroll"] },
    });
    expect(boot.report.error).toBeNull();
    expect(boot.report.started).toBe(true);
    const status = await boot.status();
    expect((status?.postgres as { phase?: string } | undefined)?.phase).toBe("retrying");
  }, 30_000);
});

describe("the console role's DSN, made from the daemon's database URL", () => {
  test("it carries no credential of the daemon's role, in the URL or in its query", () => {
    const marker = randomLabel("pw");
    const generated = generateRoleSql({
      password: "the-console-role-password-of-this-test",
      databaseUrl:
        `postgresql://fortress:${marker}@db.example.com:5432/hx` +
        `?sslmode=require&password=${marker}&sslpassword=${marker}&user=fortress&application_name=a%20b`,
    });
    for (const text of [generated.consoleDatabaseUrl, generated.maskedDatabaseUrl, generated.sql]) {
      expect(text).not.toContain(marker);
    }
    // Every other parameter is kept as it was written.
    expect(new URL(generated.consoleDatabaseUrl).search).toBe("?sslmode=require&application_name=a%20b");
  });

  test("a URL with no query is left with none", () => {
    const generated = generateRoleSql({
      password: "the-console-role-password-of-this-test",
      databaseUrl: "postgresql://fortress:daemon-password@db.example.com:5432/hx",
    });
    expect(new URL(generated.consoleDatabaseUrl).search).toBe("");
    expect(generated.consoleDatabaseUrl).not.toContain("daemon-password");
  });
});
