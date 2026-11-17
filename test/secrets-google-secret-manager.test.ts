// The google-secret-manager provider against a fake metadata server and a
// fake Secret Manager (test/rig/google-fakes.ts). Nothing here reaches Google
// Cloud.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createSecretProvider,
  MAX_SECRET_BYTES,
  resolveSecretsConfig,
  secretErrorForLog,
  SecretMissing,
  SecretNameInvalid,
  SecretUnavailable,
} from "../src/secrets";
import { crc32c } from "../src/secrets/crc32c";
import {
  GOOGLE_METADATA_TOKEN_URL,
  GOOGLE_SECRET_MANAGER_ORIGIN,
  GoogleSecretManagerSecretProvider,
  isGoogleProject,
  type GoogleSecretManagerOptions,
} from "../src/secrets/google-secret-manager";
import {
  accessBody,
  crc32cBitwise,
  GOOGLE_TOKEN_PATH,
  googleErrorBody,
  googleErrorInfo,
  startFakeGoogle,
  type FakeGoogle,
} from "./rig/google-fakes";
import {
  fakeHttpServer as fakeServer,
  jsonResponse as json,
  randomLabel as random,
  routeHostToFake,
} from "./rig/http-fakes";

/** The words every fake error body carries as its message. No error of the
 *  provider may repeat them. */
const MESSAGE = "a message that no error may repeat";

interface Rig extends FakeGoogle {
  clock: { now: number };
  /** The waits the provider asked for, in order. None of them is slept. */
  sleeps: number[];
  /** The provider under test, on the fake clock and pointed at the fakes. */
  provider(overrides?: Partial<GoogleSecretManagerOptions>): GoogleSecretManagerSecretProvider;
  secretRequests(): number;
  tokenRequests(): number;
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

const secretPath = (name: string, project = "northstar-fortress"): string =>
  `/v1/projects/${project}/secrets/${name}/versions/latest:access`;

/** The real fetch, except that the first `cuts` answers of `origin` are a 200
 *  whose body starts with `opening` and then ends in the middle. */
function cutting(origin: () => string, cuts: number, opening: string): typeof fetch {
  let seen = 0;
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(origin()) || (seen += 1) > cuts) return fetch(input, init);
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(opening));
          },
          pull(controller) {
            controller.error(new Error("the connection was lost"));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }) as typeof fetch;
}

beforeEach(() => {
  const google = startFakeGoogle();
  const clock = { now: 1_800_000_000_000 };
  const sleeps: number[] = [];
  rig = Object.assign(google, {
    clock,
    sleeps,
    provider: (overrides: Partial<GoogleSecretManagerOptions> = {}) =>
      new GoogleSecretManagerSecretProvider({
        project: google.project,
        tokenUrl: google.tokenUrl,
        secretManagerOrigin: google.secretManager.origin,
        now: () => clock.now,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        requestTimeoutMs: 2_000,
        ...overrides,
      }),
    secretRequests: () => google.secretManager.requests.length,
    tokenRequests: () => google.metadata.requests.length,
  });
});

afterEach(async () => {
  await rig.stop();
});

describe("reading a secret from Google Secret Manager", () => {
  test("asks the metadata server for a token, then Secret Manager for the newest version", async () => {
    const value = random("value");
    rig.secrets.set("db-url", value);
    const provider = rig.provider();

    expect(provider.kind).toBe("google-secret-manager");
    expect(await provider.get("db-url")).toBe(value);

    expect(rig.metadata.requests).toHaveLength(1);
    const tokenRequest = rig.metadata.requests[0];
    expect(tokenRequest?.path).toBe(GOOGLE_TOKEN_PATH);
    // The metadata server answers only with this header, and refuses a
    // request that carries the mark of a forwarding proxy.
    expect(tokenRequest?.headers.get("metadata-flavor")).toBe("Google");
    expect(tokenRequest?.headers.has("x-forwarded-for")).toBe(false);
    expect(tokenRequest?.headers.has("authorization")).toBe(false);

    expect(rig.secretManager.requests).toHaveLength(1);
    const secretRequest = rig.secretManager.requests[0];
    expect(secretRequest?.path).toBe(secretPath("db-url"));
    expect([...(secretRequest?.query.keys() ?? [])]).toEqual([]);
    expect(rig.tokens.has((secretRequest?.headers.get("authorization") ?? "").slice(7))).toBe(true);
    expect(secretRequest?.headers.has("metadata-flavor")).toBe(false);
  });

  test("the two addresses are Google's own unless a test gives others", () => {
    expect(GOOGLE_METADATA_TOKEN_URL).toBe(`http://metadata.google.internal${GOOGLE_TOKEN_PATH}`);
    expect(GOOGLE_SECRET_MANAGER_ORIGIN).toBe("https://secretmanager.googleapis.com");
  });

  test("one token serves many secrets", async () => {
    rig.secrets.set("first", random("value"));
    rig.secrets.set("second", random("value"));
    const provider = rig.provider();
    await provider.get("first");
    await provider.get("second");
    expect(rig.tokenRequests()).toBe(1);
    expect(rig.secretRequests()).toBe(2);
  });

  test("a token is fetched again five minutes before it expires", async () => {
    rig.secrets.set("db-url", random("value"));
    const provider = rig.provider({ cacheTtlMs: 0 });
    await provider.get("db-url");
    // The token lives 3,599 seconds. It is used for 3,299 of them.
    rig.clock.now += 3_298_999;
    await provider.get("db-url");
    expect(rig.tokenRequests()).toBe(1);
    rig.clock.now += 1;
    await provider.get("db-url");
    expect(rig.tokenRequests()).toBe(2);
  });

  test("a token with a few minutes left is used for half of them", async () => {
    // The metadata server hands out a token it holds until five minutes of
    // its life remain.
    rig.tokenLifetimeSeconds = 300;
    rig.secrets.set("db-url", random("value"));
    const provider = rig.provider({ cacheTtlMs: 0 });
    await provider.get("db-url");
    rig.clock.now += 149_999;
    await provider.get("db-url");
    expect(rig.tokenRequests()).toBe(1);
    rig.clock.now += 1;
    await provider.get("db-url");
    expect(rig.tokenRequests()).toBe(2);
  });

  test("a token that does not say how long it lives serves one request", async () => {
    rig.secrets.set("db-url", random("value"));
    for (const expiresIn of [undefined, 0, -5, "soon", null]) {
      rig.metadata.requests.length = 0;
      rig.metadata.handler = () => {
        const token = random("access-token");
        rig.tokens.add(token);
        return json({ access_token: token, token_type: "Bearer", ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}) });
      };
      const provider = rig.provider({ cacheTtlMs: 0 });
      await provider.get("db-url");
      await provider.get("db-url");
      expect(rig.tokenRequests()).toBe(2);
    }
  });

  test("a lifetime too large to be a number is a lifetime nobody stated", async () => {
    rig.secrets.set("db-url", random("value"));
    // In JSON this is a number, and it reads as infinite.
    rig.metadata.handler = () => {
      const token = random("access-token");
      rig.tokens.add(token);
      return new Response(`{"access_token":"${token}","expires_in":1e999,"token_type":"Bearer"}`, {
        headers: { "content-type": "application/json" },
      });
    };
    const provider = rig.provider({ cacheTtlMs: 0 });
    await provider.get("db-url");
    rig.clock.now += 1_000;
    await provider.get("db-url");
    expect(rig.tokenRequests()).toBe(2);
  });

  test("a lifetime written as digits is read, and one of more than a day is trusted for a day", async () => {
    rig.secrets.set("db-url", random("value"));
    const issue = (expiresIn: unknown) => (): Response => {
      const token = random("access-token");
      rig.tokens.add(token);
      return json({ access_token: token, expires_in: expiresIn, token_type: "Bearer" });
    };
    rig.metadata.handler = issue("3599");
    const digits = rig.provider({ cacheTtlMs: 0 });
    await digits.get("db-url");
    rig.clock.now += 3_298_999;
    await digits.get("db-url");
    expect(rig.tokenRequests()).toBe(1);

    rig.metadata.requests.length = 0;
    rig.metadata.handler = issue(30 * 24 * 3600);
    const long = rig.provider({ cacheTtlMs: 0 });
    await long.get("db-url");
    // A day less five minutes.
    rig.clock.now += 24 * 3_600_000 - 300_000 - 1;
    await long.get("db-url");
    expect(rig.tokenRequests()).toBe(1);
    rig.clock.now += 1;
    await long.get("db-url");
    expect(rig.tokenRequests()).toBe(2);
  });

  test("a project is named by its id or by its number", async () => {
    await rig.stop();
    const numbered = startFakeGoogle({ project: "415104041262" });
    try {
      numbered.secrets.set("db-url", "a-value");
      const provider = new GoogleSecretManagerSecretProvider({
        project: "415104041262",
        tokenUrl: numbered.tokenUrl,
        secretManagerOrigin: numbered.secretManager.origin,
      });
      expect(await provider.get("db-url")).toBe("a-value");
      expect(numbered.secretManager.requests[0]?.path).toBe(secretPath("db-url", "415104041262"));
      provider.forget();
    } finally {
      await numbered.stop();
    }
  });
});

describe("how long a value is kept", () => {
  test("for the cache time, and then it is read again", async () => {
    rig.secrets.set("db-url", "first");
    const provider = rig.provider({ cacheTtlMs: 30_000 });
    expect(await provider.get("db-url")).toBe("first");
    rig.secrets.set("db-url", "second");
    rig.clock.now += 29_999;
    expect(await provider.get("db-url")).toBe("first");
    expect(rig.secretRequests()).toBe(1);
    rig.clock.now += 1;
    expect(await provider.get("db-url")).toBe("second");
    expect(rig.secretRequests()).toBe(2);
    provider.forget();
  });

  test("forget drops every value and the token", async () => {
    rig.secrets.set("db-url", random("value"));
    const provider = rig.provider();
    await provider.get("db-url");
    expect(provider.heldValues).toBe(1);
    provider.forget();
    expect(provider.heldValues).toBe(0);
    await provider.get("db-url");
    expect(rig.tokenRequests()).toBe(2);
    expect(rig.secretRequests()).toBe(2);
    provider.forget();
  });
});

describe("a secret that is not there", () => {
  test("a name the project does not hold is missing, and is asked for again next time", async () => {
    const provider = rig.provider();
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretMissing;
    expect(error).toBeInstanceOf(SecretMissing);
    expect(error.message).toBe('secret "db-url" is not set');
    expect(secretErrorForLog(error)).toBe(
      'secret "db-url" is not set (Google Secret Manager secret db-url in project northstar-fortress)',
    );
    expect(await provider.has("db-url")).toBe(false);
    rig.secrets.set("db-url", "now-it-is-there");
    expect(await provider.get("db-url")).toBe("now-it-is-there");
    provider.forget();
  });

  test("a version with no bytes, and one that is blank, are missing", async () => {
    rig.secrets.set("empty", "");
    rig.secrets.set("blank", "  \n");
    const provider = rig.provider();
    // An empty value arrives as a payload with no data field.
    expect(accessBody(rig.project, "empty", "")).toEqual({
      name: "projects/northstar-fortress/secrets/empty/versions/3",
      payload: { dataCrc32c: "0" },
    });
    expect(await thrownBy(() => provider.get("empty"))).toBeInstanceOf(SecretMissing);
    expect(await thrownBy(() => provider.get("blank"))).toBeInstanceOf(SecretMissing);
    expect(await provider.has("empty")).toBe(false);
  });

  test("an answer with no bytes and no checksum says nothing, and is not taken for a missing secret", async () => {
    // "Missing" is the reading a caller may act on. An answer that holds
    // neither bytes nor the checksum of no bytes is not one about the secret.
    const provider = rig.provider({ attempts: 3 });
    for (const payload of [{}, { data: "" }, { data: "=" }, { data: "", dataCrc32c: null }]) {
      rig.secretManager.requests.length = 0;
      rig.secretManager.handler = () => json({ name: "projects/x/secrets/db-url/versions/1", payload });
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error).toBeInstanceOf(SecretUnavailable);
      expect(error.reason).toBe("Secret Manager's answer did not hold a secret value");
      expect(await thrownBy(() => provider.has("db-url"))).toBeInstanceOf(SecretUnavailable);
    }
    // No bytes with the wrong checksum is damage, like any other.
    rig.secretManager.handler = () => json({ payload: { dataCrc32c: "7" } });
    expect(((await thrownBy(() => provider.get("db-url"))) as SecretUnavailable).reason).toBe(
      "the value in Secret Manager's answer did not match its checksum",
    );
  });

  test("a 404 that is not Secret Manager's own answer is not a missing secret", async () => {
    const provider = rig.provider();
    for (const answer of [
      () => new Response("<html>Not Found</html>", { status: 404 }),
      () => json({ error: "not found" }, 404),
      () => json(googleErrorBody(404, "SOMETHING_ELSE"), 404),
    ]) {
      rig.secretManager.handler = answer;
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error).toBeInstanceOf(SecretUnavailable);
      expect(error.reason).toBe(
        "Secret Manager answered 404, which is not what Secret Manager answers for a secret that is not there",
      );
      expect(error.transient).toBe(false);
      // has does not turn "could not read" into "not there".
      expect(await thrownBy(() => provider.has("db-url"))).toBeInstanceOf(SecretUnavailable);
    }
  });

  test("a name that breaks the rule is refused before any request", async () => {
    const provider = rig.provider();
    for (const name of ["", "DB-URL", "db_url", "../db-url", "db/url", "db-url/versions/1", "a".repeat(65)]) {
      expect(await thrownBy(() => provider.get(name))).toBeInstanceOf(SecretNameInvalid);
    }
    expect(rig.tokenRequests()).toBe(0);
    expect(rig.secretRequests()).toBe(0);
  });
});

describe("a newest version that cannot be read", () => {
  test("is unavailable, not missing, and the reason says which version is read", async () => {
    rig.secretManager.handler = () => json(googleErrorBody(400, "FAILED_PRECONDITION"), 400);
    const provider = rig.provider({ attempts: 3 });
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error).toBeInstanceOf(SecretUnavailable);
    expect(error.reason).toBe(
      "Secret Manager answered 400 FAILED_PRECONDITION. The newest version of this secret is disabled or " +
        "destroyed, or its encryption key cannot be used. Only the newest version is read",
    );
    // Nothing on this host changes it, and asking again does not either.
    expect(error.transient).toBe(false);
    expect(rig.secretRequests()).toBe(1);
    expect(rig.sleeps).toEqual([]);
    // A caller that takes "missing" as "not configured" must not go on.
    expect(await thrownBy(() => provider.has("db-url"))).toBeInstanceOf(SecretUnavailable);
  });
});

describe("a Secret Manager that cannot answer", () => {
  test("no access is unavailable, names the status and the reason, and says what to grant", async () => {
    rig.secretManager.handler = () =>
      json(googleErrorBody(403, "PERMISSION_DENIED", [googleErrorInfo("IAM_PERMISSION_DENIED")]), 403);
    const provider = rig.provider({ attempts: 3 });
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error).toBeInstanceOf(SecretUnavailable);
    expect(error.reason).toBe(
      "Secret Manager refused the request (403 PERMISSION_DENIED IAM_PERMISSION_DENIED). The service " +
        "account this host runs as needs the role Secret Manager Secret Accessor " +
        "(roles/secretmanager.secretAccessor) on this secret",
    );
    // A role that was granted a moment ago takes a while to hold.
    expect(error.transient).toBe(true);
    expect(rig.secretRequests()).toBe(1);
    expect(error.message).toBe(`secret "db-url" could not be read: ${error.reason}`);
  });

  test("with the role granted secret by secret, a name that was not granted is refused whether or not it exists", async () => {
    rig.secrets.set("db-url", "the-value");
    rig.secrets.set("not-granted", "another-value");
    rig.granted = new Set(["db-url"]);
    const provider = rig.provider();
    expect(await provider.get("db-url")).toBe("the-value");
    for (const name of ["not-granted", "not-there"]) {
      const error = (await thrownBy(() => provider.get(name))) as SecretUnavailable;
      expect(error).toBeInstanceOf(SecretUnavailable);
      // The store answered, and refused. That says nothing about the name.
      expect(error.refused).toBe(true);
      expect(error.reason).toBe(
        "Secret Manager refused the request (403 PERMISSION_DENIED IAM_PERMISSION_DENIED). The service " +
          "account this host runs as needs the role Secret Manager Secret Accessor " +
          "(roles/secretmanager.secretAccessor) on this secret",
      );
      expect(await thrownBy(() => provider.has(name))).toBeInstanceOf(SecretUnavailable);
    }
    provider.forget();
  });

  test("only Secret Manager's own answer about one secret is marked as a refusal", async () => {
    const provider = rig.provider({ attempts: 1 });
    const refusedBy = async (answer: () => Response): Promise<boolean> => {
      rig.secretManager.handler = answer;
      return ((await thrownBy(() => provider.get("db-url"))) as SecretUnavailable).refused;
    };
    // Its own answer, with the reason and without one.
    expect(await refusedBy(() => json(googleErrorBody(403, "PERMISSION_DENIED"), 403))).toBe(true);
    expect(
      await refusedBy(() => json(googleErrorBody(403, "PERMISSION_DENIED", [googleErrorInfo("IAM_PERMISSION_DENIED")]), 403)),
    ).toBe(true);
    // About the whole project or the whole host: nothing can be read at all.
    for (const reason of ["SERVICE_DISABLED", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "BILLING_DISABLED", "CONSUMER_INVALID"]) {
      expect(
        await refusedBy(() => json(googleErrorBody(403, "PERMISSION_DENIED", [googleErrorInfo(reason)]), 403)),
      ).toBe(false);
    }
    // A 403 from something on the way is not Secret Manager's answer.
    expect(await refusedBy(() => new Response("<html>Forbidden</html>", { status: 403 }))).toBe(false);
    expect(await refusedBy(() => json({ error: "forbidden" }, 403))).toBe(false);
    // And no other failure is one.
    for (const answer of [
      () => json(googleErrorBody(500, "INTERNAL"), 500),
      () => json(googleErrorBody(400, "FAILED_PRECONDITION"), 400),
      () => json(googleErrorBody(401, "UNAUTHENTICATED"), 401),
      () => new Response("not json"),
    ]) {
      expect(await refusedBy(answer)).toBe(false);
    }
  });

  test("an API that is switched off, a missing access scope and billing each say what to fix", async () => {
    const provider = rig.provider();
    for (const [reason, says] of [
      ["SERVICE_DISABLED", "The Secret Manager API is switched off in the project"],
      ["ACCESS_TOKEN_SCOPE_INSUFFICIENT", "The machine this host runs on needs the cloud-platform access scope"],
      ["BILLING_DISABLED", "Billing is switched off for the project"],
    ] as const) {
      rig.secretManager.handler = () =>
        json(googleErrorBody(403, "PERMISSION_DENIED", [{ "@type": "other" }, googleErrorInfo(reason)]), 403);
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error.reason).toBe(`Secret Manager refused the request (403 PERMISSION_DENIED ${reason}). ${says}`);
      // A machine's access scopes change only when it is stopped and started,
      // so waiting for that one gains nothing. The other two end by
      // themselves once somebody switches the thing on.
      expect(error.transient).toBe(reason !== "ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    }
  });

  test("a token that has ended, while this host still held it, is replaced once", async () => {
    rig.secrets.set("db-url", random("value"));
    const provider = rig.provider({ cacheTtlMs: 0 });
    await provider.get("db-url");
    // The token ends, and the metadata server holds a new one.
    rig.endToken();
    expect(await provider.get("db-url")).toBe(rig.secrets.get("db-url") as string);
    expect(rig.tokenRequests()).toBe(2);
    expect(rig.secretRequests()).toBe(3);
  });

  test("a refused token that the metadata server still hands out is not asked for in a loop", async () => {
    rig.secrets.set("db-url", random("value"));
    const provider = rig.provider({ cacheTtlMs: 0, attempts: 3 });
    await provider.get("db-url");
    // Secret Manager stops taking the token. The metadata server hands out
    // the token it holds until that token is nearly at its end, so asking
    // again gets the same one.
    rig.tokens.clear();
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe("Secret Manager refused the token (401 UNAUTHENTICATED)");
    expect(rig.tokenRequests()).toBe(2);
    expect(rig.secretRequests()).toBe(3);
  });

  test("a Secret Manager that refuses every token is unavailable, not a loop", async () => {
    rig.secretManager.handler = () => json(googleErrorBody(401, "UNAUTHENTICATED"), 401);
    const provider = rig.provider({ attempts: 3 });
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe("Secret Manager refused the token (401 UNAUTHENTICATED)");
    expect(error.transient).toBe(false);
    expect(rig.tokenRequests()).toBe(2);
    expect(rig.secretRequests()).toBe(2);
  });

  test("a busy or failing Secret Manager is tried again, waiting as long as it asks", async () => {
    rig.secrets.set("db-url", "the-value");
    const real = rig.secretManager.handler;
    let calls = 0;
    rig.secretManager.handler = (req, url) => {
      calls += 1;
      if (calls === 1) return json(googleErrorBody(429, "RESOURCE_EXHAUSTED"), 429, { "retry-after": "2" });
      if (calls === 2) return json(googleErrorBody(503, "UNAVAILABLE"), 503);
      return real(req, url);
    };
    const provider = rig.provider({ attempts: 3 });
    expect(await provider.get("db-url")).toBe("the-value");
    // The first wait is what the answer asked for. The second is the
    // provider's own, which grows with each attempt.
    expect(rig.sleeps).toEqual([2_000, 400]);
    provider.forget();
  });

  test("one that keeps failing is unavailable after the last attempt, and may answer later", async () => {
    rig.secretManager.handler = () =>
      json(googleErrorBody(429, "RESOURCE_EXHAUSTED", [googleErrorInfo("RATE_LIMIT_EXCEEDED")]), 429);
    const provider = rig.provider({ attempts: 3 });
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe("Secret Manager answered 429 RESOURCE_EXHAUSTED RATE_LIMIT_EXCEEDED");
    expect(error.transient).toBe(true);
    expect(rig.secretRequests()).toBe(3);
    expect(rig.sleeps).toEqual([200, 400]);
  });

  test("a request that timed out on the way, and one that was aborted there, are tried again", async () => {
    for (const [answer, reason] of [
      [() => new Response("Request Timeout", { status: 408 }), "Secret Manager answered 408"],
      [() => json(googleErrorBody(409, "ABORTED"), 409), "Secret Manager answered 409 ABORTED"],
    ] as const) {
      rig.secretManager.requests.length = 0;
      rig.secretManager.handler = answer;
      const error = (await thrownBy(() => rig.provider({ attempts: 3 }).get("db-url"))) as SecretUnavailable;
      expect(error.reason).toBe(reason);
      expect(error.transient).toBe(true);
      expect(rig.secretRequests()).toBe(3);
    }
  });

  test("an error answer that is cut off says nothing about the secret, and is asked for again", async () => {
    rig.secrets.set("db-url", "the-value");
    // A 404 whose body ends in the middle: whether it would have said that
    // the secret is not there is not known.
    const cut404 = (cuts: number): typeof fetch => {
      let seen = 0;
      return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.startsWith(rig.secretManager.origin) || (seen += 1) > cuts) return fetch(input, init);
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"error":{"code":404,"status":"NOT_'));
              },
              pull(controller) {
                controller.error(new Error("the connection was lost"));
              },
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          ),
        );
      }) as typeof fetch;
    };
    const once = rig.provider({ fetch: cut404(1), attempts: 3 });
    expect(await once.get("db-url")).toBe("the-value");
    once.forget();
    const always = rig.provider({ fetch: cut404(99), attempts: 2 });
    const error = (await thrownBy(() => always.get("db-url"))) as SecretUnavailable;
    expect(error).toBeInstanceOf(SecretUnavailable);
    expect(error.reason).toBe("Secret Manager's answer was cut off");
    expect(error.transient).toBe(true);
  });

  test("one that is not listening is unavailable", async () => {
    const provider = rig.provider({ attempts: 1 });
    await rig.secretManager.stop();
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error).toBeInstanceOf(SecretUnavailable);
    expect(error.reason).toBe("Secret Manager did not answer (network error)");
    expect(error.transient).toBe(true);
  });

  test("one that never answers is unavailable when the time limit passes", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The token is fetched first, so the time limit below is spent on the
    // one request this test is about.
    rig.secrets.set("warm", "a-value");
    const provider = rig.provider({ attempts: 1, requestTimeoutMs: 250 });
    await provider.get("warm");
    rig.secretManager.handler = async () => {
      await held;
      return new Response("too late");
    };
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    release();
    expect(error.reason).toBe("Secret Manager did not answer (timed out)");
    expect(error.transient).toBe(true);
    provider.forget();
  });

  test("an answer that is not a secret is unavailable", async () => {
    const provider = rig.provider({ attempts: 3 });
    const answers: (() => Response)[] = [
      () => new Response("not json"),
      () => json({}),
      () => json({ name: "x" }),
      () => json({ payload: null }),
      () => json({ payload: [] }),
      () => json({ payload: "a string" }),
      () => json({ payload: { data: 5 } }),
      () => json({ payload: { data: "not base64!" } }),
      // One character of base64 holds no whole byte.
      () => json({ payload: { data: "A" } }),
      () => json({ payload: { data: "AAAAA" } }),
      () => json(null),
    ];
    for (const answer of answers) {
      rig.secretManager.requests.length = 0;
      rig.secretManager.handler = answer;
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error).toBeInstanceOf(SecretUnavailable);
      expect(error.reason).toBe("Secret Manager's answer did not hold a secret value");
      expect(error.transient).toBe(false);
      expect(rig.secretRequests()).toBe(1);
    }
  });

  test("a redirect is refused, and the token does not follow it", async () => {
    const elsewhere = fakeServer(() => json(accessBody("another", "db-url", "from somewhere else")));
    try {
      rig.secretManager.handler = (_req, url) =>
        new Response(null, { status: 302, headers: { location: `${elsewhere.origin}${url.pathname}` } });
      const provider = rig.provider({ attempts: 3 });
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error.reason).toBe("Secret Manager answered with a redirect, which is not followed");
      expect(error.transient).toBe(false);
      expect(rig.secretRequests()).toBe(1);
      expect(rig.sleeps).toEqual([]);
      expect(elsewhere.requests).toHaveLength(0);
    } finally {
      await elsewhere.stop();
    }
  });

  test("a proxy that asks for credentials is named as a proxy", async () => {
    rig.secretManager.handler = () => new Response("Proxy Authentication Required", { status: 407 });
    const provider = rig.provider();
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe("a proxy between this host and Secret Manager asked for credentials (407)");
    expect(error.transient).toBe(false);
  });

  test("any other answer is named by its status, and is not tried again", async () => {
    rig.secretManager.handler = () => json(googleErrorBody(400, "INVALID_ARGUMENT"), 400);
    const provider = rig.provider({ attempts: 3 });
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe("Secret Manager answered 400 INVALID_ARGUMENT");
    expect(error.transient).toBe(false);
    expect(rig.secretRequests()).toBe(1);
  });
});

describe("the value in an answer", () => {
  test("a value that does not match its checksum is asked for again, and is never returned", async () => {
    const value = random("value");
    rig.secrets.set("db-url", value);
    const real = rig.secretManager.handler;
    const damaged = (): Response => {
      const body = accessBody(rig.project, "db-url", value) as { payload: { dataCrc32c: string } };
      body.payload.dataCrc32c = String((Number(body.payload.dataCrc32c) + 1) % 2 ** 32);
      return json(body);
    };

    // Damaged once: the second answer is whole.
    let calls = 0;
    rig.secretManager.handler = (req, url) => {
      calls += 1;
      return calls === 1 ? damaged() : real(req, url);
    };
    const provider = rig.provider({ attempts: 3, cacheTtlMs: 0 });
    expect(await provider.get("db-url")).toBe(value);
    expect(rig.sleeps).toEqual([200]);

    // Damaged every time.
    rig.secretManager.handler = damaged;
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error).toBeInstanceOf(SecretUnavailable);
    expect(error.reason).toBe("the value in Secret Manager's answer did not match its checksum");
    expect(error.transient).toBe(true);
    expect(everythingPrintable(error)).not.toContain(value);
  });

  test("a checksum written as a number, and a value with no checksum, are read", async () => {
    const provider = rig.provider({ cacheTtlMs: 0 });
    const bytes = new TextEncoder().encode("the-value");
    const data = Buffer.from(bytes).toString("base64");
    rig.secretManager.handler = () => json({ payload: { data, dataCrc32c: crc32cBitwise(bytes) } });
    expect(await provider.get("db-url")).toBe("the-value");
    // Google stores no checksum for some old versions, and then sends none.
    rig.secretManager.handler = () => json({ payload: { data } });
    expect(await provider.get("db-url")).toBe("the-value");
    rig.secretManager.handler = () => json({ payload: { data, dataCrc32c: null } });
    expect(await provider.get("db-url")).toBe("the-value");
  });

  test("a checksum that is not a number, or is another number, is a mismatch", async () => {
    const provider = rig.provider({ attempts: 1 });
    const bytes = new TextEncoder().encode("the-value");
    const data = Buffer.from(bytes).toString("base64");
    const right = crc32cBitwise(bytes);
    for (const sent of ["", "abc", "-1", -1, 1.5, `${right}0`, String(right + 2 ** 32), {}, true]) {
      rig.secretManager.handler = () => json({ payload: { data, dataCrc32c: sent } });
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error.reason).toBe("the value in Secret Manager's answer did not match its checksum");
    }
    // The same number with zeros in front is the same number.
    rig.secretManager.handler = () => json({ payload: { data, dataCrc32c: `000${right}` } });
    expect(await provider.get("db-url")).toBe("the-value");
  });

  test("both base64 alphabets are read, with and without padding", async () => {
    const provider = rig.provider({ cacheTtlMs: 0 });
    // In the standard alphabet this value is `fn5+Pz8/`.
    const value = "~~~???";
    const bytes = new TextEncoder().encode(value);
    const standard = Buffer.from(bytes).toString("base64");
    expect(standard).toBe("fn5+Pz8/");
    const checksum = String(crc32cBitwise(bytes));
    for (const data of [standard, "fn5-Pz8_"]) {
      rig.secretManager.handler = () => json({ payload: { data, dataCrc32c: checksum } });
      expect(await provider.get("db-url")).toBe(value);
    }
    const two = new TextEncoder().encode("ab");
    for (const data of ["YWI=", "YWI"]) {
      rig.secretManager.handler = () => json({ payload: { data, dataCrc32c: String(crc32cBitwise(two)) } });
      expect(await provider.get("db-url")).toBe("ab");
    }
  });

  test("a value that is not UTF-8 text is refused, and no part of it is repeated", async () => {
    rig.secrets.set("binary", new Uint8Array([0x41, 0x42, 0xff, 0xfe, 0x43]));
    const provider = rig.provider({ attempts: 3 });
    const error = (await thrownBy(() => provider.get("binary"))) as SecretUnavailable;
    expect(error).toBeInstanceOf(SecretUnavailable);
    expect(error.reason).toBe("the value is not UTF-8 text");
    expect(error.transient).toBe(false);
    expect(rig.secretRequests()).toBe(1);
    expect(everythingPrintable(error)).not.toContain("AB");
  });

  test("the largest value Secret Manager holds is read whole, and a larger one is refused as too large", async () => {
    // Secret Manager holds 64 KiB at most.
    const largest = "y".repeat(MAX_SECRET_BYTES);
    rig.secrets.set("largest", largest);
    const provider = rig.provider();
    expect(await provider.get("largest")).toBe(largest);

    const marker = random("marker");
    rig.secrets.set("too-large", `${marker}${"x".repeat(MAX_SECRET_BYTES)}`);
    const error = (await thrownBy(() => provider.get("too-large"))) as SecretUnavailable;
    expect(error.reason).toBe(`the value is larger than ${MAX_SECRET_BYTES} bytes`);
    expect(error.transient).toBe(false);
    expect(everythingPrintable(error)).not.toContain(marker);
    provider.forget();
  });

  test("an answer far larger than any secret is not held in memory", async () => {
    rig.secretManager.handler = () =>
      json({ payload: { data: "QUFB".repeat(MAX_SECRET_BYTES) } });
    const provider = rig.provider({ attempts: 3 });
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe("Secret Manager's answer did not hold a secret value");
    expect(rig.secretRequests()).toBe(1);
  });

  test("an answer that is cut off is asked for again", async () => {
    rig.secrets.set("db-url", "the-value");
    const once = rig.provider({ fetch: cutting(() => rig.secretManager.origin, 1, '{"payload":{"data":"'), attempts: 3 });
    expect(await once.get("db-url")).toBe("the-value");
    expect(rig.sleeps).toEqual([200]);
    once.forget();

    rig.sleeps.length = 0;
    const always = rig.provider({ fetch: cutting(() => rig.secretManager.origin, 99, '{"payload":{"data":"'), attempts: 3 });
    const error = (await thrownBy(() => always.get("db-url"))) as SecretUnavailable;
    expect(error).toBeInstanceOf(SecretUnavailable);
    expect(error.reason).toBe("Secret Manager's answer was cut off");
    expect(error.transient).toBe(true);
    expect(rig.sleeps).toEqual([200, 400]);
  });
});

describe("a metadata server that cannot answer", () => {
  test("a host with no service account is unavailable and says so", async () => {
    rig.metadata.handler = () => new Response("Not Found", { status: 404 });
    const provider = rig.provider({ attempts: 3 });
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error).toBeInstanceOf(SecretUnavailable);
    expect(error.reason).toBe(
      "no service account token: the metadata server answered 404. Check that this host runs with a service account",
    );
    expect(error.transient).toBe(false);
    expect(rig.tokenRequests()).toBe(1);
    expect(rig.secretRequests()).toBe(0);
  });

  test("a disabled service account and an endpoint that is switched off are named", async () => {
    const provider = rig.provider();
    rig.metadata.handler = () => new Response("Unauthorized", { status: 401 });
    expect(((await thrownBy(() => provider.get("db-url"))) as SecretUnavailable).reason).toBe(
      "no service account token: the metadata server answered 401, which it answers when this host's " +
        "service account is disabled",
    );
    rig.metadata.handler = () => new Response("Forbidden", { status: 403 });
    expect(((await thrownBy(() => provider.get("db-url"))) as SecretUnavailable).reason).toBe(
      "no service account token: the metadata server answered 403, which it answers when the project or " +
        "the machine has this endpoint switched off",
    );
    rig.metadata.handler = () => new Response("Bad Request", { status: 400 });
    expect(((await thrownBy(() => provider.get("db-url"))) as SecretUnavailable).reason).toBe(
      "no service account token: the metadata server answered 400",
    );
  });

  test("a metadata server that is starting or busy is tried again", async () => {
    rig.secrets.set("db-url", "the-value");
    const real = rig.metadata.handler;
    let calls = 0;
    rig.metadata.handler = (req, url) => {
      calls += 1;
      if (calls === 1) return new Response("Service Unavailable", { status: 503 });
      if (calls === 2) return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "1" } });
      return real(req, url);
    };
    const provider = rig.provider({ attempts: 3 });
    expect(await provider.get("db-url")).toBe("the-value");
    expect(rig.sleeps).toEqual([200, 1_000]);
    provider.forget();
  });

  test("one that stays busy is unavailable, and may answer later", async () => {
    rig.metadata.handler = () => new Response("Service Unavailable", { status: 503 });
    const provider = rig.provider({ attempts: 3 });
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe("no service account token: the metadata server answered 503");
    expect(error.transient).toBe(true);
    expect(rig.tokenRequests()).toBe(3);
  });

  test("an answer with no token is unavailable", async () => {
    const provider = rig.provider({ attempts: 3 });
    const answers: (() => Response)[] = [
      () => new Response("not json"),
      () => json({}),
      () => json(null),
      () => json([]),
      () => json({ access_token: "" }),
      () => json({ access_token: 7, expires_in: 3599 }),
      // A token goes into a header, so it holds no space and no line end.
      () => json({ access_token: "two words", expires_in: 3599, token_type: "Bearer" }),
      () => json({ access_token: "line\nend", expires_in: 3599, token_type: "Bearer" }),
      () => json({ access_token: "a-token", expires_in: 3599, token_type: "MAC" }),
    ];
    for (const answer of answers) {
      rig.metadata.requests.length = 0;
      rig.metadata.handler = answer;
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error.reason).toBe("no service account token: the metadata server's answer did not hold a token");
      expect(error.transient).toBe(false);
      expect(rig.tokenRequests()).toBe(1);
    }
    expect(rig.secretRequests()).toBe(0);
  });

  test("one that is not listening is unavailable", async () => {
    const provider = rig.provider({ attempts: 1 });
    await rig.metadata.stop();
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe("no service account token: the metadata server did not answer (network error)");
    expect(error.transient).toBe(true);
  });

  test("a redirect from the metadata server is refused", async () => {
    const elsewhere = fakeServer(() => json({ access_token: "from-somewhere-else", expires_in: 3599 }));
    try {
      rig.metadata.handler = () =>
        new Response(null, { status: 301, headers: { location: `${elsewhere.origin}${GOOGLE_TOKEN_PATH}` } });
      const provider = rig.provider({ attempts: 3 });
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error.reason).toBe(
        "no service account token: the metadata server answered with a redirect, which is not followed",
      );
      expect(rig.tokenRequests()).toBe(1);
      expect(elsewhere.requests).toHaveLength(0);
      expect(rig.secretRequests()).toBe(0);
    } finally {
      await elsewhere.stop();
    }
  });

  test("a token request whose answer is cut off is made again", async () => {
    rig.secrets.set("db-url", "the-value");
    const once = rig.provider({ fetch: cutting(() => rig.metadata.origin, 1, '{"access_token":"'), attempts: 3 });
    expect(await once.get("db-url")).toBe("the-value");
    expect(rig.sleeps).toEqual([200]);
    once.forget();

    const always = rig.provider({ fetch: cutting(() => rig.metadata.origin, 99, '{"access_token":"'), attempts: 2 });
    const error = (await thrownBy(() => always.get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe("no service account token: the metadata server's answer was cut off");
    expect(error.transient).toBe(true);
  });
});

describe("what an error may say", () => {
  test("no error from any of the paths above holds a value, a token or text of a response", async () => {
    const value = random("value");
    rig.secrets.set("db-url", value);
    const provider = rig.provider({ attempts: 1 });
    await provider.get("db-url");
    provider.forget();
    const issued = [...rig.tokens];

    // Each way a read can fail after a token and a value existed.
    rig.secretManager.handler = () => json(googleErrorBody(403, "PERMISSION_DENIED", [], value), 403);
    await thrownBy(() => provider.get("db-url"));
    rig.secretManager.handler = () => new Response(`<html>${value}</html>`, { status: 500 });
    await thrownBy(() => provider.get("db-url"));
    rig.secretManager.handler = () => json(googleErrorBody(400, value, [googleErrorInfo(value)], value), 400);
    await thrownBy(() => provider.get("db-url"));
    rig.secretManager.handler = () => json({ payload: { data: 12, echo: value } });
    await thrownBy(() => provider.get("db-url"));
    rig.secretManager.handler = () =>
      json({ payload: { data: Buffer.from(value).toString("base64"), dataCrc32c: "1" } });
    await thrownBy(() => provider.get("db-url"));
    rig.metadata.handler = () => new Response(`denied: ${value}`, { status: 500 });
    provider.forget();
    await thrownBy(() => provider.get("db-url"));

    expect(errors.length).toBeGreaterThan(5);
    const printed = errors.map(everythingPrintable).join("\n");
    expect(printed).not.toContain(value);
    expect(printed).not.toContain(MESSAGE);
    for (const token of [...issued, ...rig.tokens]) expect(printed).not.toContain(token);
  });

  test("a status or a reason from a response is repeated only when it is one of Google's own", async () => {
    const provider = rig.provider();
    const label = async (body: unknown, status = 400): Promise<string> => {
      rig.secretManager.handler = () => json(body, status);
      return ((await thrownBy(() => provider.get("db-url"))) as SecretUnavailable).reason;
    };
    // Shaped like a status and like a reason, and on neither list.
    expect(await label(googleErrorBody(400, "TEXT_FROM_A_RESPONSE", [googleErrorInfo("ALSO_FROM_A_RESPONSE")]))).toBe(
      "Secret Manager answered 400",
    );
    // A listed reason under a domain that is not Google's is somebody else's word.
    for (const domain of ["example.com", "googleapis.com.example.com", "evilgoogleapis.com", "a.b.googleapis.com", "", "GOOGLEAPIS.COM"]) {
      expect(
        await label(googleErrorBody(400, "INVALID_ARGUMENT", [googleErrorInfo("SERVICE_DISABLED", domain)])),
      ).toBe("Secret Manager answered 400 INVALID_ARGUMENT");
    }
    // Under Google's own, or under one of its services', it is repeated.
    for (const domain of ["googleapis.com", "iam.googleapis.com", "secretmanager.googleapis.com"]) {
      expect(
        await label(googleErrorBody(400, "INVALID_ARGUMENT", [googleErrorInfo("CONSUMER_INVALID", domain)])),
      ).toBe("Secret Manager answered 400 INVALID_ARGUMENT CONSUMER_INVALID");
    }
    // A reason in an entry of another type is not an error reason.
    expect(
      await label(
        googleErrorBody(400, "INVALID_ARGUMENT", [
          { "@type": "type.googleapis.com/google.rpc.Help", reason: "SERVICE_DISABLED", domain: "googleapis.com" },
        ]),
      ),
    ).toBe("Secret Manager answered 400 INVALID_ARGUMENT");
    // Values of the wrong type are skipped.
    expect(await label({ error: { code: 400, status: 400, details: "none" } })).toBe("Secret Manager answered 400");
    expect(await label({ error: "INVALID_ARGUMENT" })).toBe("Secret Manager answered 400");
    expect(await label(googleErrorBody(400, "INVALID_ARGUMENT", [null, 5, "x", googleErrorInfo("CONSUMER_INVALID")]))).toBe(
      "Secret Manager answered 400 INVALID_ARGUMENT CONSUMER_INVALID",
    );
  });

  test("printing or serializing the provider shows only its kind", async () => {
    const value = random("value");
    rig.secrets.set("db-url", value);
    const provider = rig.provider();
    await provider.get("db-url");
    // It now holds a value and a token.
    const printed = everythingPrintable(provider);
    expect(printed).not.toContain(value);
    expect(printed).not.toContain(rig.project);
    for (const token of rig.tokens) expect(printed).not.toContain(token);
    expect(JSON.stringify({ provider })).toBe('{"provider":{"kind":"google-secret-manager"}}');
    provider.forget();
  });
});

describe("the project", () => {
  test("an id and a number are accepted, and anything that could change a path is not", () => {
    for (const project of ["northstar-fortress", "a12345", "p-1-2-3", `a${"b".repeat(29)}`, "415104041262", "123456"]) {
      expect(isGoogleProject(project)).toBe(true);
    }
    for (const project of [
      "",
      "short",
      `a${"b".repeat(30)}`,
      "Northstar-Fortress",
      "1starts-with-a-digit",
      "ends-with-a-hyphen-",
      "-starts-with-a-hyphen",
      "has_underscore",
      "has.dot.in-it",
      "example.com:northstar",
      "northstar/secrets/x",
      "northstar%2fother",
      "northstar fortress",
      "12345",
      "../northstar",
    ]) {
      expect(isGoogleProject(project)).toBe(false);
    }
  });

  test("a provider built by hand with something else is refused, and does not repeat it", () => {
    const pasted = `${random("pasted")}/secrets/other`;
    let thrown: unknown = null;
    try {
      new GoogleSecretManagerSecretProvider({ project: pasted });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(everythingPrintable(thrown)).not.toContain(pasted);
  });
});

describe("the settings", () => {
  const root = "/var/lib/hx-fortress";
  const resolve = (env: Record<string, string>, config: unknown = null): unknown =>
    resolveSecretsConfig({ env, config, root });
  const refusal = (env: Record<string, string>, config: unknown = null): string => {
    try {
      resolve(env, config);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("expected a refusal");
  };

  test("the provider and its project, from the environment or from config.json", () => {
    expect(
      resolve({ FORTRESS_SECRETS_PROVIDER: "google-secret-manager", FORTRESS_SECRETS_GOOGLE_PROJECT: "northstar-fortress" }),
    ).toEqual({ provider: "google-secret-manager", project: "northstar-fortress" });
    expect(resolve({}, { secrets: { provider: "google-secret-manager", project: "415104041262", cacheSeconds: 30 } })).toEqual({
      provider: "google-secret-manager",
      project: "415104041262",
      cacheTtlMs: 30_000,
    });
    // The environment wins, setting by setting.
    expect(
      resolve(
        { FORTRESS_SECRETS_GOOGLE_PROJECT: "northstar-live", FORTRESS_SECRETS_CACHE_SECONDS: "0" },
        { secrets: { provider: "google-secret-manager", project: "northstar-test" } },
      ),
    ).toEqual({ provider: "google-secret-manager", project: "northstar-live", cacheTtlMs: 0 });
  });

  test("a missing project is refused, and the refusal names the setting", () => {
    expect(refusal({ FORTRESS_SECRETS_PROVIDER: "google-secret-manager" })).toBe(
      "Invalid secrets config: the google-secret-manager provider needs the project: set " +
        "FORTRESS_SECRETS_GOOGLE_PROJECT, or secrets.project in config.json",
    );
  });

  test("a project that is not one is refused, and what was written is not repeated", () => {
    const pasted = `Pasted-${random("line")}`;
    const fromEnv = refusal({
      FORTRESS_SECRETS_PROVIDER: "google-secret-manager",
      FORTRESS_SECRETS_GOOGLE_PROJECT: pasted,
    });
    expect(fromEnv).toBe(
      "Invalid secrets config: FORTRESS_SECRETS_GOOGLE_PROJECT must be a project id (6 to 30 lowercase " +
        "letters, digits and hyphens, starting with a letter) or a project number",
    );
    const fromFile = refusal({}, { secrets: { provider: "google-secret-manager", project: pasted } });
    expect(fromFile).toContain("secrets.project in config.json must be a project id");
    expect(fromFile).not.toContain(pasted);
  });

  test("the project is a setting of this provider alone", () => {
    expect(
      refusal({ FORTRESS_SECRETS_PROVIDER: "file", FORTRESS_SECRETS_GOOGLE_PROJECT: "northstar-fortress" }),
    ).toContain("FORTRESS_SECRETS_GOOGLE_PROJECT is set, but the provider is file");
    expect(
      refusal({
        FORTRESS_SECRETS_PROVIDER: "google-secret-manager",
        FORTRESS_SECRETS_GOOGLE_PROJECT: "northstar-fortress",
        FORTRESS_SECRETS_AZURE_VAULT_URL: "https://northstar.vault.azure.net",
      }),
    ).toContain("FORTRESS_SECRETS_AZURE_VAULT_URL is set, but the provider is google-secret-manager");
    // A variable that only looks like the setting is refused by name.
    expect(
      refusal({ FORTRESS_SECRETS_PROVIDER: "google-secret-manager", FORTRESS_SECRETS_GOOGLE_PROJECT_ID: "northstar-fortress" }),
    ).toContain("FORTRESS_SECRETS_GOOGLE_PROJECT_ID is not a setting this build knows");
  });
});

describe("from the settings to a value", () => {
  test("the provider that the settings build asks Google's own two addresses", async () => {
    const value = random("value");
    rig.secrets.set("db-url", value);
    // Google's two hosts are sent to the fakes where requests leave this
    // process, so the provider itself is built exactly as HX Fortress builds it.
    const undoMetadata = routeHostToFake("metadata.google.internal", rig.metadata);
    const undoSecrets = routeHostToFake("secretmanager.googleapis.com", rig.secretManager);
    try {
      const env: Record<string, string | undefined> = {
        FORTRESS_SECRETS_PROVIDER: "google-secret-manager",
        FORTRESS_SECRETS_GOOGLE_PROJECT: rig.project,
      };
      const provider = createSecretProvider(resolveSecretsConfig({ env, config: null, root: "/var/lib/hx-fortress" }), {
        env,
      });
      expect(provider.kind).toBe("google-secret-manager");
      expect(await provider.get("db-url")).toBe(value);
      expect(rig.metadata.requests[0]?.path).toBe(GOOGLE_TOKEN_PATH);
      expect(rig.secretManager.requests[0]?.path).toBe(secretPath("db-url"));
      (provider as GoogleSecretManagerSecretProvider).forget();
    } finally {
      undoSecrets();
      undoMetadata();
    }
  });
});

describe("a proxy named in the environment", () => {
  const build = (env: Record<string, string | undefined>): void => {
    const withSettings = Object.assign(env, {
      FORTRESS_SECRETS_PROVIDER: "google-secret-manager",
      FORTRESS_SECRETS_GOOGLE_PROJECT: "northstar-fortress",
    });
    createSecretProvider(resolveSecretsConfig({ env: withSettings, config: null, root: "/var/lib/hx-fortress" }), {
      env: withSettings,
    });
  };

  test("building the provider keeps the metadata server off it, under both spellings", () => {
    // The token request is made in clear text. A proxy that carried it would
    // see the token that comes back.
    const env: Record<string, string | undefined> = {
      HTTPS_PROXY: "http://proxy.internal.example:3128",
      NO_PROXY: "localhost",
    };
    build(env);
    expect(env.NO_PROXY).toBe("localhost,metadata.google.internal");
    expect(env.no_proxy).toBe("localhost,metadata.google.internal");
  });

  test("with no proxy named, the environment is left as it is", () => {
    const env: Record<string, string | undefined> = {};
    build(env);
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.no_proxy).toBeUndefined();
  });
});

describe("the checksum itself", () => {
  const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

  test("gives the published check values of CRC32C", () => {
    // The check value of the algorithm, and the test patterns of RFC 3720,
    // section B.4.
    expect(crc32c(ascii("123456789"))).toBe(0xe3069283);
    expect(crc32c(new Uint8Array(32))).toBe(0x8a9136aa);
    expect(crc32c(new Uint8Array(32).fill(0xff))).toBe(0x62a8ab43);
    expect(crc32c(Uint8Array.from({ length: 32 }, (_, i) => i))).toBe(0x46dd794e);
    expect(crc32c(Uint8Array.from({ length: 32 }, (_, i) => 31 - i))).toBe(0x113fdb5c);
    expect(crc32c(new Uint8Array(0))).toBe(0);
  });

  test("agrees with a second way of working it out, on bytes of every value", () => {
    for (const length of [1, 2, 3, 7, 64, 255, 256, 257, 1_000, 65_536]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 131 + length) & 0xff);
      expect(crc32c(bytes)).toBe(crc32cBitwise(bytes));
    }
  });

  test("it is not the CRC-32 the runtime has built in", () => {
    expect(crc32c(ascii("123456789"))).not.toBe(Bun.hash.crc32(ascii("123456789")));
  });
});
