// The azure-key-vault provider against a fake identity endpoint and a fake Key
// Vault (test/rig/azure-fakes.ts). Nothing here reaches Azure.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  AzureKeyVaultSecretProvider,
  DEFAULT_SECRET_CACHE_TTL_MS,
  MAX_SECRET_CACHE_TTL_MS,
  parseKeyVaultUrl,
  resolveManagedIdentity,
  type AzureKeyVaultOptions,
} from "../src/secrets/azure-key-vault";
import {
  MAX_SECRET_BYTES,
  secretErrorForLog,
  SecretMissing,
  SecretNameInvalid,
  SecretUnavailable,
} from "../src/secrets";
import {
  fakeHttpServer as fakeServer,
  jsonResponse as json,
  randomLabel as random,
  startFakeAzure,
  type FakeAzure,
} from "./rig/azure-fakes";

interface Rig extends FakeAzure {
  /** The waits the provider asked for, in order. None of them is slept. */
  sleeps: number[];
  /** The provider under test, on the fake clock and pointed at the fakes. */
  provider(overrides?: Partial<AzureKeyVaultOptions>): AzureKeyVaultSecretProvider;
  vaultSecretRequests(): number;
  identityRequests(): number;
}

let rig: Rig;
const errors: unknown[] = [];

async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    errors.push(error);
    return error;
  }
  throw new Error("expected a rejection");
}

/** Everything an error or a provider can show a reader. */
function everythingPrintable(thing: unknown): string {
  const e = thing as Error;
  return [
    e.message ?? "",
    String(e),
    JSON.stringify(e) ?? "",
    JSON.stringify({ ...e }),
    e.stack ?? "",
    Bun.inspect(thing),
    secretErrorForLog(thing),
  ].join("\n");
}

beforeEach(() => {
  const azure = startFakeAzure();
  const sleeps: number[] = [];
  rig = {
    ...azure,
    sleeps,
    provider: (overrides = {}) =>
      new AzureKeyVaultSecretProvider({
        vault: { origin: azure.vault.origin, resource: "https://vault.azure.net" },
        identity: {
          kind: "identity-endpoint",
          endpoint: `${azure.identity.origin}/msi/token`,
          header: azure.identityHeader,
        },
        now: () => azure.clock.now,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        requestTimeoutMs: 2_000,
        ...overrides,
      }),
    vaultSecretRequests: () => azure.vault.requests.filter((r) => r.path.startsWith("/secrets/")).length,
    identityRequests: () => azure.identity.requests.length,
  };
});

afterEach(async () => {
  await rig.stop();
});

describe("reading a secret from Azure Key Vault", () => {
  test("asks the identity endpoint for a token, then the vault for the secret", async () => {
    const value = random("value");
    rig.secrets.set("db-url", value);
    const provider = rig.provider();

    expect(provider.kind).toBe("azure-key-vault");
    expect(await provider.get("db-url")).toBe(value);

    expect(rig.identity.requests).toHaveLength(1);
    const tokenRequest = rig.identity.requests[0];
    expect(tokenRequest?.path).toBe("/msi/token");
    expect(tokenRequest?.query.get("resource")).toBe("https://vault.azure.net");
    expect(tokenRequest?.query.get("api-version")).toBe("2019-08-01");
    expect(tokenRequest?.query.has("client_id")).toBe(false);
    expect(tokenRequest?.headers.get("x-identity-header")).toBe(rig.identityHeader);

    expect(rig.vault.requests).toHaveLength(1);
    const secretRequest = rig.vault.requests[0];
    expect(secretRequest?.path).toBe("/secrets/db-url");
    expect(secretRequest?.query.get("api-version")).toBe("7.4");
    expect(rig.tokens.has((secretRequest?.headers.get("authorization") ?? "").slice(7))).toBe(true);
  });

  test("one token serves many secrets", async () => {
    rig.secrets.set("first", random("value"));
    rig.secrets.set("second", random("value"));
    const provider = rig.provider();
    await provider.get("first");
    await provider.get("second");
    expect(rig.identityRequests()).toBe(1);
    expect(rig.vaultSecretRequests()).toBe(2);
  });

  test("a token is fetched again before it expires", async () => {
    rig.secrets.set("db-url", random("value"));
    const provider = rig.provider({ cacheTtlMs: 0 });
    await provider.get("db-url");
    // Twenty-three hours on, the 24-hour token is still good.
    rig.clock.now += 23 * 3600_000;
    await provider.get("db-url");
    expect(rig.identityRequests()).toBe(1);
    // Inside the last five minutes it is replaced.
    rig.clock.now += 56 * 60_000;
    await provider.get("db-url");
    expect(rig.identityRequests()).toBe(2);
  });

  test("a user-assigned identity is named by its client id", async () => {
    rig.secrets.set("db-url", random("value"));
    const clientId = "11111111-2222-3333-4444-555555555555";
    const provider = rig.provider({
      identity: {
        kind: "identity-endpoint",
        endpoint: `${rig.identity.origin}/msi/token`,
        header: rig.identityHeader,
        clientId,
      },
    });
    await provider.get("db-url");
    expect(rig.identity.requests[0]?.query.get("client_id")).toBe(clientId);
  });

  test("on a virtual machine it speaks the instance metadata protocol", async () => {
    const value = random("value");
    rig.secrets.set("db-url", value);
    rig.identity.handler = (req, url) => {
      if (url.pathname !== "/metadata/identity/oauth2/token") return json({}, 404);
      if (req.headers.get("metadata") !== "true") return json({ error: "invalid_request" }, 400);
      const token = random("access-token");
      rig.tokens.add(token);
      // The metadata service sends both fields, as strings.
      return json({ access_token: token, expires_in: "86399", expires_on: String(Math.floor(rig.clock.now / 1000) + 86_399) });
    };
    const provider = rig.provider({
      identity: { kind: "imds", endpoint: `${rig.identity.origin}/metadata/identity/oauth2/token` },
    });
    expect(await provider.get("db-url")).toBe(value);
    const tokenRequest = rig.identity.requests[0];
    expect(tokenRequest?.query.get("api-version")).toBe("2018-02-01");
    expect(tokenRequest?.query.get("resource")).toBe("https://vault.azure.net");
    expect(tokenRequest?.headers.get("x-identity-header")).toBeNull();
  });
});

describe("how long a value is kept", () => {
  test("a value is kept for the cache time and then read again", async () => {
    rig.secrets.set("db-url", "first");
    const provider = rig.provider({ cacheTtlMs: 30_000 });
    expect(await provider.get("db-url")).toBe("first");
    rig.secrets.set("db-url", "second");
    rig.clock.now += 29_000;
    expect(await provider.get("db-url")).toBe("first");
    expect(rig.vaultSecretRequests()).toBe(1);
    rig.clock.now += 2_000;
    expect(await provider.get("db-url")).toBe("second");
    expect(rig.vaultSecretRequests()).toBe(2);
    provider.forget();
  });

  test("the default is one minute, and the setting cannot exceed fifteen", async () => {
    expect(DEFAULT_SECRET_CACHE_TTL_MS).toBe(60_000);
    rig.secrets.set("db-url", "first");
    const provider = rig.provider({ cacheTtlMs: 24 * 3600_000 });
    await provider.get("db-url");
    rig.secrets.set("db-url", "second");
    rig.clock.now += MAX_SECRET_CACHE_TTL_MS + 1;
    expect(await provider.get("db-url")).toBe("second");
    provider.forget();
  });

  test("a cache time of zero keeps nothing", async () => {
    rig.secrets.set("db-url", "first");
    const provider = rig.provider({ cacheTtlMs: 0 });
    expect(await provider.get("db-url")).toBe("first");
    rig.secrets.set("db-url", "second");
    expect(await provider.get("db-url")).toBe("second");
    expect(rig.vaultSecretRequests()).toBe(2);
  });

  test("a value is dropped when its time is up, without waiting to be asked for", async () => {
    rig.secrets.set("db-url", random("value"));
    // Real time here: the point is the timer.
    const provider = rig.provider({ cacheTtlMs: 40, now: Date.now });
    await provider.get("db-url");
    expect(provider.heldValues).toBe(1);
    await Bun.sleep(120);
    expect(provider.heldValues).toBe(0);
  });

  test("callers that ask for one name at the same moment share one request", async () => {
    rig.secrets.set("db-url", random("value"));
    const provider = rig.provider();
    const values = await Promise.all([
      provider.get("db-url"),
      provider.get("db-url"),
      provider.get("db-url"),
    ]);
    expect(new Set(values).size).toBe(1);
    expect(rig.vaultSecretRequests()).toBe(1);
    expect(rig.identityRequests()).toBe(1);
    provider.forget();
  });

  test("forget drops every value and the token", async () => {
    rig.secrets.set("db-url", "first");
    const provider = rig.provider();
    await provider.get("db-url");
    provider.forget();
    rig.secrets.set("db-url", "second");
    expect(await provider.get("db-url")).toBe("second");
    expect(rig.identityRequests()).toBe(2);
    provider.forget();
  });
});

describe("a secret that is not there", () => {
  test("a name the vault does not hold is missing, and is asked for again next time", async () => {
    const provider = rig.provider();
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretMissing;
    expect(error).toBeInstanceOf(SecretMissing);
    expect(error.message).toBe('secret "db-url" is not set');
    expect(error.source).toBe(`Azure Key Vault secret db-url in ${rig.vault.origin}`);
    expect(await provider.has("db-url")).toBe(false);

    // Somebody adds it. Nothing remembered the earlier answer.
    const value = random("value");
    rig.secrets.set("db-url", value);
    expect(await provider.has("db-url")).toBe(true);
    expect(await provider.get("db-url")).toBe(value);
    provider.forget();
  });

  test("a secret switched off in the vault is missing", async () => {
    rig.secrets.set("db-url", random("value"));
    const provider = rig.provider();
    await provider.get("db-url");
    provider.forget();
    const inner = rig.vault.handler;
    rig.vault.handler = (req, url) =>
      url.pathname === "/secrets/db-url"
        ? json(
            {
              error: {
                code: "Forbidden",
                message: "Operation get is not allowed on a disabled secret.",
                innererror: { code: "SecretDisabled" },
              },
            },
            403,
          )
        : inner(req, url);
    expect(await thrownBy(() => provider.get("db-url"))).toBeInstanceOf(SecretMissing);
    expect(await provider.has("db-url")).toBe(false);
  });

  test("an empty or blank value is missing, and one final line ending is removed", async () => {
    const provider = rig.provider({ cacheTtlMs: 0 });
    for (const blank of ["", "\n", "   "]) {
      rig.secrets.set("db-url", blank);
      expect(await thrownBy(() => provider.get("db-url"))).toBeInstanceOf(SecretMissing);
    }
    // What `az keyvault secret set --file` stores for a file that ends in a newline.
    rig.secrets.set("db-url", "the value\n");
    expect(await provider.get("db-url")).toBe("the value");
  });

  test("every name the rule allows is asked for, and the vault decides", async () => {
    const provider = rig.provider();
    rig.secrets.set("2fa-key", "a value under a name that starts with a digit");
    expect(await provider.get("2fa-key")).toBe("a value under a name that starts with a digit");
    expect(await provider.has("-leading-dash")).toBe(false);
    expect(rig.vault.requests.map((r) => r.path)).toEqual(["/secrets/2fa-key", "/secrets/-leading-dash"]);
    provider.forget();
  });

  test("a name that breaks the rule is refused before any request", async () => {
    const provider = rig.provider();
    for (const name of ["DB-URL", "db_url", "../secrets/db-url", "db-url?api-version=1", ""]) {
      expect(await thrownBy(() => provider.get(name))).toBeInstanceOf(SecretNameInvalid);
      expect(await thrownBy(() => provider.has(name))).toBeInstanceOf(SecretNameInvalid);
    }
    expect(rig.identity.requests).toHaveLength(0);
    expect(rig.vault.requests).toHaveLength(0);
  });
});

describe("a vault that cannot answer", () => {
  test("no access is unavailable, names the status and the code, and says what to grant", async () => {
    rig.vault.handler = () =>
      json(
        {
          error: {
            code: "Forbidden",
            message: "Caller is not authorized to perform action on resource.",
            innererror: { code: "ForbiddenByRbac" },
          },
        },
        403,
      );
    const provider = rig.provider();
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error).toBeInstanceOf(SecretUnavailable);
    expect(error.reason).toContain("403 ForbiddenByRbac");
    expect(error.reason).toContain("Key Vault Secrets User");
    // A role granted a moment ago is refused for a few minutes, so asking later may work.
    expect(error.transient).toBe(true);
    expect(error.source).toBe(`Azure Key Vault secret db-url in ${rig.vault.origin}`);
    // The service's own sentence is never repeated.
    expect(error.message).not.toContain("Caller is not authorized");
    // Not being allowed to look is not the same as the secret being absent.
    expect(await thrownBy(() => provider.has("db-url"))).toBeInstanceOf(SecretUnavailable);
    // A refusal is not tried again.
    expect(rig.vaultSecretRequests()).toBe(2);
  });

  test("a token the vault refuses is replaced once", async () => {
    const value = random("value");
    rig.secrets.set("db-url", value);
    const provider = rig.provider();
    await provider.get("db-url");
    provider.forget();
    // Re-issue: the provider still believes its token is good, and the vault
    // no longer does.
    rig.secrets.set("other", random("value"));
    await provider.get("other");
    rig.tokens.clear();
    expect(await provider.get("db-url")).toBe(value);
    expect(rig.identityRequests()).toBe(3);
    provider.forget();
  });

  test("a vault that refuses every token is unavailable, not a loop", async () => {
    rig.vault.handler = () => json({ error: { code: "Unauthorized", message: "no" } }, 401);
    const provider = rig.provider();
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error).toBeInstanceOf(SecretUnavailable);
    expect(error.reason).toBe("the vault refused the token (401 Unauthorized)");
    expect(error.transient).toBe(false);
    expect(rig.identityRequests()).toBe(2);
    expect(rig.vaultSecretRequests()).toBe(2);
  });

  test("a busy or failing vault is tried again, waiting as long as it asks", async () => {
    const value = random("value");
    rig.secrets.set("db-url", value);
    const inner = rig.vault.handler;
    let failures = 0;
    rig.vault.handler = (req, url) => {
      failures += 1;
      if (failures === 1) {
        return json({ error: { code: "Throttled", message: "slow down" } }, 429, { "retry-after": "2" });
      }
      if (failures === 2) return json({ error: { code: "InternalServerError", message: "oops" } }, 500);
      return inner(req, url);
    };
    const provider = rig.provider();
    expect(await provider.get("db-url")).toBe(value);
    expect(rig.sleeps).toEqual([2_000, 400]);
    provider.forget();
  });

  test("a vault that keeps failing is unavailable after the last attempt", async () => {
    rig.vault.handler = () => json({ error: { code: "ServiceUnavailable", message: "down" } }, 503);
    const provider = rig.provider({ attempts: 3 });
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error).toBeInstanceOf(SecretUnavailable);
    expect(error.reason).toBe("the vault answered 503 ServiceUnavailable");
    expect(error.transient).toBe(true);
    expect(rig.vaultSecretRequests()).toBe(3);
    expect(rig.sleeps).toEqual([200, 400]);
  });

  test("a vault that is not listening is unavailable", async () => {
    await rig.vault.stop();
    const provider = rig.provider({ attempts: 2 });
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error).toBeInstanceOf(SecretUnavailable);
    expect(error.reason).toBe("the vault did not answer (network error)");
    expect(error.message).not.toContain("127.0.0.1");
  });

  test("a vault that never answers is unavailable when the time limit passes", async () => {
    rig.vault.handler = async () => {
      await Bun.sleep(400);
      return json({ value: "late" });
    };
    const provider = rig.provider({ attempts: 1, requestTimeoutMs: 50 });
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error).toBeInstanceOf(SecretUnavailable);
    expect(error.reason).toBe("the vault did not answer (timed out)");
  });

  test("an answer that is not a secret is unavailable", async () => {
    const provider = rig.provider();
    for (const body of ["not json", JSON.stringify({ id: "x" }), JSON.stringify({ value: 7 }), JSON.stringify([])]) {
      rig.vault.handler = () => new Response(body, { status: 200 });
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error).toBeInstanceOf(SecretUnavailable);
      expect(error.reason).toBe("the vault's answer did not hold a secret value");
      expect(error.transient).toBe(false);
    }
  });

  test("a value past the size limit is unavailable and is not repeated", async () => {
    const marker = random("oversized-marker");
    rig.secrets.set("db-url", marker + "x".repeat(MAX_SECRET_BYTES));
    const provider = rig.provider();
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error).toBeInstanceOf(SecretUnavailable);
    expect(error.reason).toBe(`the value is larger than ${MAX_SECRET_BYTES} bytes`);
    expect(everythingPrintable(error)).not.toContain(marker);
  });

  test("a redirect is refused, and the token does not follow it", async () => {
    const elsewhere = fakeServer(() => json({ value: "from somewhere else" }));
    try {
      rig.vault.handler = (_req, url) =>
        new Response(null, {
          status: 302,
          headers: { location: `${elsewhere.origin}${url.pathname}${url.search}` },
        });
      const provider = rig.provider({ attempts: 1 });
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error).toBeInstanceOf(SecretUnavailable);
      expect(elsewhere.requests).toHaveLength(0);
    } finally {
      await elsewhere.stop();
    }
  });
});

describe("an identity endpoint that cannot answer", () => {
  test("a host with no managed identity is unavailable and says so", async () => {
    rig.identity.handler = () =>
      json({ error: "invalid_request", error_description: "Identity not found" }, 400);
    const provider = rig.provider();
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error).toBeInstanceOf(SecretUnavailable);
    expect(error.reason).toBe(
      "no managed identity token: the identity endpoint answered 400 invalid_request. " +
        "Check that this host has a managed identity",
    );
    expect(error.transient).toBe(false);
    expect(rig.vault.requests).toHaveLength(0);
    expect(rig.identityRequests()).toBe(1);
  });

  test("a metadata service that is still starting is tried again", async () => {
    const value = random("value");
    rig.secrets.set("db-url", value);
    const inner = rig.identity.handler;
    let calls = 0;
    rig.identity.handler = (req, url) => {
      calls += 1;
      return calls < 3 ? json({ error: "not ready" }, calls === 1 ? 410 : 503) : inner(req, url);
    };
    const provider = rig.provider();
    expect(await provider.get("db-url")).toBe(value);
    expect(calls).toBe(3);
    provider.forget();
  });

  test("an answer with no token is unavailable", async () => {
    rig.identity.handler = () => json({ token_type: "Bearer" });
    const provider = rig.provider();
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe(
      "no managed identity token: the identity endpoint's answer did not hold a token",
    );
  });

  test("an endpoint that is not listening is unavailable", async () => {
    await rig.identity.stop();
    const provider = rig.provider({ attempts: 2 });
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe(
      "no managed identity token: the identity endpoint did not answer (network error)",
    );
    expect(error.transient).toBe(true);
  });
});

describe("what an error may say", () => {
  test("no error from any of the paths above holds a value, a token or the identity header", async () => {
    const value = random("value");
    rig.secrets.set("db-url", value);
    const provider = rig.provider({ attempts: 1 });
    await provider.get("db-url");
    provider.forget();
    const issued = [...rig.tokens];

    // Each way a read can fail after a token and a value existed.
    rig.vault.handler = () => json({ error: { code: "Forbidden", message: value } }, 403);
    await thrownBy(() => provider.get("db-url"));
    rig.vault.handler = () => new Response(`<html>${value}</html>`, { status: 500 });
    await thrownBy(() => provider.get("db-url"));
    rig.vault.handler = () => json({ error: { code: value, message: value } }, 400);
    await thrownBy(() => provider.get("db-url"));
    rig.vault.handler = () => json({ value: 12, echo: value });
    await thrownBy(() => provider.get("db-url"));
    rig.identity.handler = () => json({ error: value, access_token: 7 }, 500);
    provider.forget();
    await thrownBy(() => provider.get("db-url"));

    expect(errors.length).toBeGreaterThan(4);
    const printed = errors.map(everythingPrintable).join("\n");
    expect(printed).not.toContain(value);
    expect(printed).not.toContain(rig.identityHeader);
    for (const token of [...issued, ...rig.tokens]) expect(printed).not.toContain(token);
  });

  test("printing or serializing the provider shows only its kind", async () => {
    const value = random("value");
    rig.secrets.set("db-url", value);
    const provider = rig.provider();
    await provider.get("db-url");
    // It now holds a value, a token and the identity header.
    const printed = everythingPrintable(provider);
    expect(printed).not.toContain(value);
    expect(printed).not.toContain(rig.identityHeader);
    for (const token of rig.tokens) expect(printed).not.toContain(token);
    expect(JSON.stringify({ provider })).toBe('{"provider":{"kind":"azure-key-vault"}}');
    provider.forget();
  });
});

describe("the vault URL", () => {
  test("a Key Vault address of a known Azure cloud is accepted", () => {
    expect(parseKeyVaultUrl("https://contoso-kv.vault.azure.net")).toEqual({
      origin: "https://contoso-kv.vault.azure.net",
      resource: "https://vault.azure.net",
    });
    expect(parseKeyVaultUrl(" https://Contoso-KV.vault.azure.net/ ")).toEqual({
      origin: "https://contoso-kv.vault.azure.net",
      resource: "https://vault.azure.net",
    });
    expect(parseKeyVaultUrl("https://contoso-kv.vault.usgovcloudapi.net").resource).toBe(
      "https://vault.usgovcloudapi.net",
    );
    expect(parseKeyVaultUrl("https://contoso-kv.vault.azure.cn").resource).toBe("https://vault.azure.cn");
  });

  test("anything the token should not be sent to is refused", () => {
    for (const url of [
      "http://contoso-kv.vault.azure.net",
      "https://contoso-kv.vault.azure.net:8443",
      "https://contoso-kv.vault.azure.net/secrets/db-url",
      "https://contoso-kv.vault.azure.net?x=1",
      "https://someone:pw@contoso-kv.vault.azure.net",
      "https://contoso-kv.vault.azure.net.example.com",
      "https://example.com/contoso-kv.vault.azure.net",
      "https://vault.azure.net",
      "https://a.b.vault.azure.net",
      "https://kv.vault.azure.net",
      "https://contoso-kv.managedhsm.azure.net",
      "https://127.0.0.1",
      "contoso-kv",
      "",
    ]) {
      expect(() => parseKeyVaultUrl(url)).toThrow("the Key Vault URL");
    }
  });
});

describe("where a token comes from", () => {
  test("Container Apps and App Service publish an endpoint and a header", () => {
    expect(
      resolveManagedIdentity({
        IDENTITY_ENDPOINT: "http://localhost:42356/msi/token",
        IDENTITY_HEADER: "a-header",
      }),
    ).toEqual({
      kind: "identity-endpoint",
      endpoint: "http://localhost:42356/msi/token",
      header: "a-header",
    });
  });

  test("with neither, the instance metadata service is used", () => {
    expect(resolveManagedIdentity({})).toEqual({
      kind: "imds",
      endpoint: "http://169.254.169.254/metadata/identity/oauth2/token",
    });
    expect(resolveManagedIdentity({}, "11111111-2222-3333-4444-555555555555")).toEqual({
      kind: "imds",
      endpoint: "http://169.254.169.254/metadata/identity/oauth2/token",
      clientId: "11111111-2222-3333-4444-555555555555",
    });
  });

  test("half a configuration, a wrong client id and Service Fabric are refused by name", () => {
    expect(() => resolveManagedIdentity({ IDENTITY_ENDPOINT: "http://localhost:42356/msi/token" })).toThrow(
      "must both be set",
    );
    expect(() => resolveManagedIdentity({ IDENTITY_HEADER: "a-header" })).toThrow("must both be set");
    expect(() =>
      resolveManagedIdentity({ IDENTITY_ENDPOINT: "not a url", IDENTITY_HEADER: "a-header" }),
    ).toThrow("IDENTITY_ENDPOINT is not a URL");
    expect(() =>
      resolveManagedIdentity({ IDENTITY_ENDPOINT: "file:///etc/passwd", IDENTITY_HEADER: "a-header" }),
    ).toThrow("must use http: or https:");
    expect(() => resolveManagedIdentity({}, "not-a-guid")).toThrow("must be a GUID");
    expect(() =>
      resolveManagedIdentity({
        IDENTITY_ENDPOINT: "https://localhost:2377/metadata/identity/oauth2/token",
        IDENTITY_HEADER: "a-header",
        IDENTITY_SERVER_THUMBPRINT: "0123456789abcdef",
      }),
    ).toThrow("Service Fabric");
  });
});
