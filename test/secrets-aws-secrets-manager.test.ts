// The aws-secrets-manager provider against fakes of the three things it talks
// to: the endpoint that gives an Amazon ECS task its credentials, the instance
// metadata service of an Amazon EC2 instance, and AWS Secrets Manager
// (test/rig/aws-fakes.ts). Nothing here reaches AWS.
//
// The fake Secrets Manager works out each request's signature with code of its
// own and refuses one that does not match, as AWS does. So every test that
// reads a value also holds the provider's signing to a second implementation.

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
import {
  awsSecretsManagerOrigin,
  AwsSecretsManagerSecretProvider,
  isAwsRegion,
  resolveAwsCredentialSource,
  type AwsSecretsManagerOptions,
} from "../src/secrets/aws-secrets-manager";
import { AWS_ERROR_MESSAGE, awsErrorBody, startFakeAws, type FakeAws } from "./rig/aws-fakes";
import {
  fakeHttpServer as fakeServer,
  jsonResponse as json,
  randomLabel as random,
  routeHostToFake,
} from "./rig/http-fakes";

interface Rig extends FakeAws {
  /** The waits the provider asked for, in order. None of them is slept. */
  sleeps: number[];
  /** The provider under test, on the fake clock and pointed at the fakes. It
   *  takes its credentials as a task does unless `overrides` says otherwise. */
  provider(overrides?: Partial<AwsSecretsManagerOptions>): AwsSecretsManagerSecretProvider;
  /** The same provider, taking its credentials as an instance does. */
  onInstance(overrides?: Partial<AwsSecretsManagerOptions>): AwsSecretsManagerSecretProvider;
  secretRequests(): number;
  platformRequests(): string[];
}

let rig: Rig;
const errors: unknown[] = [];

/** An id of the shape AWS gives temporary credentials, put together at run time. */
const AN_ID = ["ASIA", "IOSFODNN7", "EXAMPLE"].join("");

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

/** An error answer of Secrets Manager. It says what time it is there, on the
 *  fake's clock, as every answer of the fake does. */
const refusal = (name: string, status = 400, headers: Record<string, string> = {}): Response =>
  json(awsErrorBody(name), status, { date: new Date(rig.clock.now).toUTCString(), ...headers });

/** The real fetch, except that the first `cuts` answers to a request for a
 *  path that ends with `ending` have their headers and a few bytes, and then
 *  the connection is lost. */
function cuttingAt(ending: string, cuts: number): typeof fetch {
  let seen = 0;
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (!url.pathname.endsWith(ending) || (seen += 1) > cuts) return fetch(input, init);
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("hx-fo"));
          },
          pull(controller) {
            controller.error(new Error("the connection was lost"));
          },
        }),
        { status: 200, headers: { "content-type": "text/plain" } },
      ),
    );
  }) as typeof fetch;
}

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
        { status: 200, headers: { "content-type": "application/x-amz-json-1.1" } },
      ),
    );
  }) as typeof fetch;
}

beforeEach(() => {
  errors.length = 0;
  const aws = startFakeAws();
  const sleeps: number[] = [];
  const build = (credentials: AwsSecretsManagerOptions["credentials"], overrides: Partial<AwsSecretsManagerOptions>) =>
    new AwsSecretsManagerSecretProvider({
      region: aws.region,
      credentials,
      secretsManagerOrigin: aws.secretsManager.origin,
      now: () => aws.clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      requestTimeoutMs: 2_000,
      ...overrides,
    });
  rig = Object.assign(aws, {
    sleeps,
    provider: (overrides: Partial<AwsSecretsManagerOptions> = {}) => build({ kind: "container", url: aws.containerUrl }, overrides),
    onInstance: (overrides: Partial<AwsSecretsManagerOptions> = {}) =>
      build({ kind: "instance-metadata", origin: aws.platform.origin }, overrides),
    secretRequests: () => aws.secretsManager.requests.length,
    platformRequests: () => aws.platform.requests.map((request) => request.path),
  });
});

afterEach(async () => {
  await rig.stop();
});

describe("reading a secret from AWS Secrets Manager", () => {
  test("asks the task's endpoint for credentials, then Secrets Manager for the current version, with a signature", async () => {
    const value = random("value");
    rig.secrets.set("db-url", value);
    const provider = rig.provider();

    expect(provider.kind).toBe("aws-secrets-manager");
    // The fake refuses a request whose signature it cannot reproduce.
    expect(await provider.get("db-url")).toBe(value);

    expect(rig.platformRequests()).toEqual([rig.containerPath]);
    expect(rig.platform.requests[0]?.headers.has("authorization")).toBe(false);
    expect(rig.platform.requests[0]?.headers.has("x-forwarded-for")).toBe(false);

    expect(rig.secretsManager.requests).toHaveLength(1);
    const request = rig.secretsManager.requests[0];
    expect(request?.path).toBe("/");
    expect(request?.headers.get("x-amz-target")).toBe("secretsmanager.GetSecretValue");
    expect(request?.headers.get("content-type")).toBe("application/x-amz-json-1.1");
    expect(request?.headers.get("x-amz-date")).toBe("20270115T080000Z");
    const issued = rig.issued[0];
    expect(request?.headers.get("x-amz-security-token")).toBe(issued?.sessionToken ?? "none");
    const authorization = request?.headers.get("authorization") ?? "";
    const upToTheSignature =
      `AWS4-HMAC-SHA256 Credential=${issued?.accessKeyId}/20270115/us-east-1/secretsmanager/aws4_request, ` +
      "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=";
    expect(authorization.startsWith(upToTheSignature)).toBe(true);
    expect(authorization.slice(upToTheSignature.length)).toMatch(/^[0-9a-f]{64}$/);
    // The secret key is never sent.
    const sent = [...(request?.headers.entries() ?? [])].flat().join("\n");
    expect(sent).not.toContain(issued?.secretAccessKey ?? "none");
  });

  test("Secrets Manager's address is the region's own", () => {
    expect(awsSecretsManagerOrigin("us-east-1")).toBe("https://secretsmanager.us-east-1.amazonaws.com");
    expect(awsSecretsManagerOrigin("us-gov-west-1")).toBe("https://secretsmanager.us-gov-west-1.amazonaws.com");
  });

  test("one set of credentials serves many secrets", async () => {
    rig.secrets.set("first", random("value"));
    rig.secrets.set("second", random("value"));
    const provider = rig.provider();
    await provider.get("first");
    await provider.get("second");
    expect(rig.issued).toHaveLength(1);
    expect(rig.secretRequests()).toBe(2);
  });

  test("credentials are fetched again five minutes before they expire", async () => {
    rig.secrets.set("db-url", random("value"));
    const provider = rig.provider({ cacheTtlMs: 0 });
    await provider.get("db-url");
    // They live six hours. They are used for five hours and 55 minutes.
    rig.clock.now += 6 * 3_600_000 - 300_000 - 1;
    await provider.get("db-url");
    expect(rig.issued).toHaveLength(1);
    rig.clock.now += 1;
    await provider.get("db-url");
    expect(rig.issued).toHaveLength(2);
  });

  test("credentials that do not say when they expire are not kept", async () => {
    rig.secrets.set("db-url", random("value"));
    const real = rig.platform.handler;
    for (const expiration of [undefined, "soon", 1_800_000_000, null, ""]) {
      rig.platform.requests.length = 0;
      rig.platform.handler = async (req, url) => {
        const body = (await (await real(req, url)).json()) as Record<string, unknown>;
        if (expiration === undefined) delete body.Expiration;
        else body.Expiration = expiration;
        return json(body);
      };
      const provider = rig.provider({ cacheTtlMs: 0 });
      await provider.get("db-url");
      await provider.get("db-url");
      // Asked for at each read. The platform hands out the same ones.
      expect(rig.platformRequests()).toHaveLength(2);
    }
  });

  test("a value stored as text, and one stored as bytes that are text, are both read", async () => {
    rig.secrets.set("as-text", "pässwörd-口令");
    rig.secrets.set("as-bytes", new TextEncoder().encode("pässwörd-口令"));
    const provider = rig.provider();
    expect(await provider.get("as-text")).toBe("pässwörd-口令");
    expect(await provider.get("as-bytes")).toBe("pässwörd-口令");
    provider.forget();
  });
});

describe("on an Amazon EC2 instance", () => {
  test("it opens a session with the instance metadata service, asks the role's name, then the role's credentials", async () => {
    const value = random("value");
    rig.secrets.set("db-url", value);
    const provider = rig.onInstance();
    expect(await provider.get("db-url")).toBe(value);

    expect(rig.platformRequests()).toEqual([
      "/latest/api/token",
      "/latest/meta-data/iam/security-credentials/",
      "/latest/meta-data/iam/security-credentials/hx-fortress-instance",
    ]);
    const [session, roles, credentials] = rig.platform.requests;
    expect(session?.headers.get("x-aws-ec2-metadata-token-ttl-seconds")).toBe("60");
    const token = [...rig.sessions][0] ?? "none";
    expect(roles?.headers.get("x-aws-ec2-metadata-token")).toBe(token);
    expect(credentials?.headers.get("x-aws-ec2-metadata-token")).toBe(token);
    for (const request of rig.platform.requests) expect(request.headers.has("x-forwarded-for")).toBe(false);
  });

  test("each time credentials are fetched, a new session is opened, and none is kept", async () => {
    rig.secrets.set("db-url", random("value"));
    const provider = rig.onInstance({ cacheTtlMs: 0 });
    await provider.get("db-url");
    rig.clock.now += 6 * 3_600_000;
    await provider.get("db-url");
    expect(rig.sessions.size).toBe(2);
    expect(rig.issued).toHaveLength(2);
  });

  test("an instance with no role is unavailable and says so", async () => {
    rig.role = null;
    const provider = rig.onInstance({ attempts: 3 });
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error).toBeInstanceOf(SecretUnavailable);
    expect(error.reason).toBe(
      "no credentials of this host's role: the instance metadata service answered 404. This instance has no role",
    );
    expect(error.transient).toBe(false);
    expect(rig.secretRequests()).toBe(0);
  });

  test("a metadata service that is switched off is named", async () => {
    rig.platform.handler = () => new Response("Forbidden", { status: 403 });
    const provider = rig.onInstance();
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe(
      "no credentials of this host's role: the instance metadata service answered 403, " +
        "which it answers when it is switched off for this instance",
    );
    expect(error.transient).toBe(false);
  });

  test("no answer at all says what kind of host this must be, and may pass later", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    rig.platform.handler = async () => {
      await held;
      return new Response("too late");
    };
    const provider = rig.onInstance({ attempts: 1, requestTimeoutMs: 80 });
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    release();
    expect(error.reason).toBe(
      "no credentials of this host's role: the instance metadata service did not answer (timed out). " +
        "This host must be an Amazon ECS task or an Amazon EC2 instance with a role. " +
        "In a container on an instance, the instance's metadata hop limit must be 2",
    );
    expect(error.transient).toBe(true);
  });

  test("a session the service does not take, and a busy service, are asked again from the start", async () => {
    rig.secrets.set("db-url", "the-value");
    const real = rig.platform.handler;
    let credentialAsks = 0;
    rig.platform.handler = (req, url) => {
      if (url.pathname.endsWith("/hx-fortress-instance")) {
        credentialAsks += 1;
        if (credentialAsks === 1) return new Response("Unauthorized", { status: 401 });
        if (credentialAsks === 2) return new Response("Service Unavailable", { status: 503 });
      }
      return real(req, url);
    };
    const provider = rig.onInstance({ attempts: 3 });
    expect(await provider.get("db-url")).toBe("the-value");
    // Three whole rounds: a session, the role's name, the credentials.
    expect(rig.platformRequests().filter((path) => path === "/latest/api/token")).toHaveLength(3);
    expect(rig.sleeps).toEqual([200, 400]);
    provider.forget();
  });

  test("an answer with no session, no role or no credentials is unavailable", async () => {
    const real = rig.platform.handler;
    const cases: [string, (path: string) => Response | null][] = [
      ["the instance metadata service's answer did not hold a session token", (path) => (path === "/latest/api/token" ? new Response("") : null)],
      ["the instance metadata service's answer did not hold a session token", (path) => (path === "/latest/api/token" ? new Response("two words") : null)],
      ["the instance metadata service's answer did not name a role", (path) => (path.endsWith("/security-credentials/") ? new Response("") : null)],
      ["the instance metadata service's answer did not name a role", (path) => (path.endsWith("/security-credentials/") ? new Response("../../other\n") : null)],
      ["the instance metadata service's answer did not hold credentials", (path) => (path.endsWith("/hx-fortress-instance") ? new Response("not json") : null)],
      ["the instance metadata service's answer did not hold credentials", (path) => (path.endsWith("/hx-fortress-instance") ? json({ Code: "AssumeRoleUnauthorizedAccess" }) : null)],
      [
        "the instance metadata service's answer did not hold credentials",
        (path) =>
          path.endsWith("/hx-fortress-instance")
            ? json({ Code: "Failed", AccessKeyId: AN_ID, SecretAccessKey: "x", Token: "y", Expiration: "2027-01-15T14:00:00Z" })
            : null,
      ],
    ];
    for (const [reason, answer] of cases) {
      rig.platform.handler = (req, url) => answer(url.pathname) ?? real(req, url);
      const provider = rig.onInstance({ attempts: 3 });
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error.reason).toBe(`no credentials of this host's role: ${reason}`);
      expect(error.transient).toBe(false);
    }
    expect(rig.secretRequests()).toBe(0);
  });

  test("an answer that is cut off after its headers is asked for again, at each of the three steps", async () => {
    rig.secrets.set("db-url", "the-value");
    for (const ending of ["/latest/api/token", "/security-credentials/", "/hx-fortress-instance"]) {
      // Cut once: the whole round is made again, and the value is read.
      rig.platform.requests.length = 0;
      rig.sleeps.length = 0;
      const provider = rig.onInstance({ attempts: 3, fetch: cuttingAt(ending, 1) });
      expect(await provider.get("db-url")).toBe("the-value");
      expect(rig.sleeps).toEqual([200]);
      provider.forget();

      // Cut every time: it is unavailable for now, and a caller may ask again.
      const cut = rig.onInstance({ attempts: 3, fetch: cuttingAt(ending, 99) });
      const error = (await thrownBy(() => cut.get("db-url"))) as SecretUnavailable;
      expect(error.reason).toBe("no credentials of this host's role: the instance metadata service's answer was cut off");
      expect(error.transient).toBe(true);
    }
  });

  test("a session token or a list of roles that is too long is not asked for again", async () => {
    const real = rig.platform.handler;
    for (const [ending, reason] of [
      ["/latest/api/token", "did not hold a session token"],
      ["/security-credentials/", "did not name a role"],
    ] as const) {
      rig.platform.requests.length = 0;
      rig.platform.handler = (req, url) => (url.pathname.endsWith(ending) ? new Response("x".repeat(4097)) : real(req, url));
      const provider = rig.onInstance({ attempts: 3 });
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error.reason).toBe(`no credentials of this host's role: the instance metadata service's answer ${reason}`);
      expect(error.transient).toBe(false);
      expect(rig.platformRequests().filter((path) => path === "/latest/api/token")).toHaveLength(1);
    }
  });
});

describe("a session token of any length a header can carry", () => {
  test("a long one signs a request that Secrets Manager takes", async () => {
    rig.secrets.set("db-url", "the-value");
    rig.sessionTokenLength = 6_000;
    const provider = rig.provider();
    expect(await provider.get("db-url")).toBe("the-value");
    expect(rig.issued[0]?.sessionToken).toHaveLength(6_000);
    expect(rig.secretsManager.requests[0]?.headers.get("x-amz-security-token")).toBe(rig.issued[0]?.sessionToken ?? "");
    provider.forget();
  });

  test("one longer than this build takes is not used, and nothing is sent to Secrets Manager", async () => {
    rig.sessionTokenLength = 16_385;
    const error = (await thrownBy(() => rig.provider().get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe("no credentials of this host's role: the task's credentials endpoint's answer did not hold credentials");
    expect(rig.secretRequests()).toBe(0);
  });
});

describe("a task's credentials endpoint that cannot answer", () => {
  test("an answer that holds no usable credentials is unavailable", async () => {
    const good = { AccessKeyId: AN_ID, SecretAccessKey: "the-other-half", Token: "a-token", Expiration: "2027-01-15T14:00:00Z" };
    const answers: (() => Response)[] = [
      () => new Response("not json"),
      () => json({}),
      () => json(null),
      () => json([good]),
      () => json({ ...good, AccessKeyId: undefined }),
      () => json({ ...good, AccessKeyId: "lower-case-id-00000000" }),
      () => json({ ...good, SecretAccessKey: 7 }),
      () => json({ ...good, SecretAccessKey: "" }),
      // A session token goes into a header, so it holds no line end.
      () => json({ ...good, Token: "line\nend" }),
      () => json({ ...good, Token: undefined }),
    ];
    for (const answer of answers) {
      rig.platform.requests.length = 0;
      rig.platform.handler = answer;
      const provider = rig.provider({ attempts: 3 });
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error.reason).toBe(
        "no credentials of this host's role: the task's credentials endpoint's answer did not hold credentials",
      );
      expect(error.transient).toBe(false);
      expect(rig.platformRequests()).toHaveLength(1);
    }
    expect(rig.secretRequests()).toBe(0);
  });

  test("a busy endpoint is asked again, and one that refuses is named by its status", async () => {
    rig.secrets.set("db-url", "the-value");
    const real = rig.platform.handler;
    let calls = 0;
    rig.platform.handler = (req, url) => {
      calls += 1;
      if (calls === 1) return new Response("Service Unavailable", { status: 503 });
      if (calls === 2) return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "1" } });
      return real(req, url);
    };
    const provider = rig.provider({ attempts: 3 });
    expect(await provider.get("db-url")).toBe("the-value");
    expect(rig.sleeps).toEqual([200, 1_000]);
    provider.forget();

    rig.platform.handler = () => new Response("Bad Request", { status: 400 });
    const error = (await thrownBy(() => rig.provider({ attempts: 3 }).get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe("no credentials of this host's role: the task's credentials endpoint answered 400");
    expect(error.transient).toBe(false);
  });

  test("one that is not listening is unavailable", async () => {
    const provider = rig.provider({ attempts: 1 });
    await rig.platform.stop();
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe(
      "no credentials of this host's role: the task's credentials endpoint did not answer (network error)",
    );
    expect(error.transient).toBe(true);
  });

  test("a redirect is refused, and nothing is asked elsewhere", async () => {
    const elsewhere = fakeServer(() => json({ AccessKeyId: AN_ID }));
    try {
      rig.platform.handler = () =>
        new Response(null, { status: 302, headers: { location: `${elsewhere.origin}/v2/credentials/x` } });
      const provider = rig.provider({ attempts: 3 });
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error.reason).toBe(
        "no credentials of this host's role: the task's credentials endpoint answered with a redirect, which is not followed",
      );
      expect(rig.platformRequests()).toHaveLength(1);
      expect(elsewhere.requests).toHaveLength(0);
    } finally {
      await elsewhere.stop();
    }
  });

  test("an answer that is cut off is asked for again", async () => {
    rig.secrets.set("db-url", "the-value");
    const provider = rig.provider({ fetch: cutting(() => rig.platform.origin, 1, '{"AccessKeyId":"'), attempts: 3 });
    expect(await provider.get("db-url")).toBe("the-value");
    expect(rig.sleeps).toEqual([200]);
    provider.forget();
  });
});

describe("a secret that is not there", () => {
  test("a name Secrets Manager does not hold is missing, and is asked for again next time", async () => {
    const provider = rig.provider();
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretMissing;
    expect(error).toBeInstanceOf(SecretMissing);
    expect(error.message).toBe('secret "db-url" is not set');
    expect(secretErrorForLog(error)).toBe('secret "db-url" is not set (AWS Secrets Manager secret db-url in us-east-1)');
    expect(await provider.has("db-url")).toBe(false);
    rig.secrets.set("db-url", "now-it-is-there");
    expect(await provider.get("db-url")).toBe("now-it-is-there");
    provider.forget();
  });

  test("the error's name is read with a prefix, with a suffix, and from the header beside the body", async () => {
    const provider = rig.provider();
    for (const answer of [
      () => json({ __type: "com.amazonaws.secretsmanager#ResourceNotFoundException", message: AWS_ERROR_MESSAGE }, 400),
      () => json({ __type: "ResourceNotFoundException:http://internal.amazon.com/coral/", Message: AWS_ERROR_MESSAGE }, 400),
      () => new Response("<html>not json</html>", { status: 400, headers: { "x-amzn-errortype": "ResourceNotFoundException" } }),
      () => json({}, 400, { "x-amzn-errortype": "com.amazonaws.secretsmanager#ResourceNotFoundException:http://x/" }),
    ]) {
      rig.secretsManager.handler = answer;
      expect(await thrownBy(() => provider.get("db-url"))).toBeInstanceOf(SecretMissing);
    }
  });

  test("that name with another status is not a missing secret", async () => {
    const html = (status: number): Response =>
      new Response("<html>an error page</html>", { status, headers: { "x-amzn-errortype": "ResourceNotFoundException" } });
    for (const [answer, reason, transient, asked] of [
      // A status that this name does not come with: it is read by the status alone.
      [() => refusal("ResourceNotFoundException", 500), "Secrets Manager answered 500", true, 3],
      [() => html(503), "Secrets Manager answered 503", true, 3],
      // Another status of the same kind: named, and still not "missing".
      [() => refusal("ResourceNotFoundException", 404), "Secrets Manager answered 404 ResourceNotFoundException", false, 1],
      [() => refusal("ResourceNotFoundException", 403), "Secrets Manager answered 403 ResourceNotFoundException", false, 1],
    ] as const) {
      rig.secretsManager.requests.length = 0;
      rig.secretsManager.handler = answer;
      const provider = rig.provider({ attempts: 3 });
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error).toBeInstanceOf(SecretUnavailable);
      expect(error.reason).toBe(reason);
      expect(error.transient).toBe(transient);
      expect(rig.secretRequests()).toBe(asked);
      // `has` does not answer "no" for it: it fails as the read does.
      expect(await thrownBy(() => provider.has("db-url"))).toBeInstanceOf(SecretUnavailable);
    }
  });

  test("an answer whose body and header name different errors is read by its status alone", async () => {
    const provider = rig.provider({ attempts: 1 });
    for (const [body, header] of [
      ["AccessDeniedException", "ResourceNotFoundException"],
      ["ResourceNotFoundException", "AccessDeniedException"],
      // A name that is not AWS's, beside one that is.
      ["TextFromAResponseException", "ResourceNotFoundException"],
      ["ResourceNotFoundException", "x".repeat(300)],
    ] as const) {
      rig.secretsManager.handler = () => json({ __type: body, Message: AWS_ERROR_MESSAGE }, 400, { "x-amzn-errortype": header });
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error).toBeInstanceOf(SecretUnavailable);
      expect(error.reason).toBe("Secrets Manager answered 400");
      expect(error.refused).toBe(false);
    }
    // The same name in both is one name.
    rig.secretsManager.handler = () => refusal("ResourceNotFoundException", 400, { "x-amzn-errortype": "ResourceNotFoundException" });
    expect(await thrownBy(() => provider.get("db-url"))).toBeInstanceOf(SecretMissing);
  });

  test("a name of a failure inside AWS counts only with a status of 500 or more", async () => {
    const provider = rig.provider({ attempts: 1 });
    rig.secretsManager.handler = () => refusal("InternalServiceError", 500);
    expect(((await thrownBy(() => provider.get("db-url"))) as SecretUnavailable).reason).toBe(
      "Secrets Manager answered 500 InternalServiceError",
    );
    rig.secretsManager.handler = () => refusal("InternalServiceError", 400);
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe("Secrets Manager answered 400");
    expect(error.transient).toBe(false);
  });

  test("a blank value is missing, and one final line end is removed", async () => {
    rig.secrets.set("blank", "  \n");
    rig.secrets.set("with-line-end", "the-value\n");
    const provider = rig.provider();
    expect(await thrownBy(() => provider.get("blank"))).toBeInstanceOf(SecretMissing);
    expect(await provider.get("with-line-end")).toBe("the-value");
    provider.forget();
  });

  test("a 400 or a 404 that does not carry that name is not a missing secret", async () => {
    const provider = rig.provider();
    for (const [answer, reason] of [
      [() => new Response("<html>Not Found</html>", { status: 404 }), "Secrets Manager answered 404"],
      [() => json({ __type: "SomethingElseException" }, 400), "Secrets Manager answered 400"],
      [() => json({ message: "ResourceNotFoundException" }, 400), "Secrets Manager answered 400"],
      [() => refusal("ValidationException"), "Secrets Manager answered 400 ValidationException"],
    ] as const) {
      rig.secretsManager.handler = answer;
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error).toBeInstanceOf(SecretUnavailable);
      expect(error.reason).toBe(reason);
      expect(error.transient).toBe(false);
      // has does not turn "could not read" into "not there".
      expect(await thrownBy(() => provider.has("db-url"))).toBeInstanceOf(SecretUnavailable);
    }
  });

  test("a name that breaks the rule is refused before any request", async () => {
    const provider = rig.provider();
    for (const name of ["", "DB-URL", "db_url", "arn:aws:secretsmanager:us-east-1:1:secret:x", "db/url", "a".repeat(65)]) {
      expect(await thrownBy(() => provider.get(name))).toBeInstanceOf(SecretNameInvalid);
    }
    expect(rig.platformRequests()).toEqual([]);
    expect(rig.secretRequests()).toBe(0);
  });
});

describe("a secret that is there and cannot be read", () => {
  test("one scheduled for deletion is unavailable, not missing", async () => {
    rig.secretsManager.handler = () => refusal("InvalidRequestException");
    const provider = rig.provider({ attempts: 3 });
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error).toBeInstanceOf(SecretUnavailable);
    expect(error.reason).toBe(
      "Secrets Manager answered 400 InvalidRequestException, which it answers for a secret that is scheduled for deletion",
    );
    expect(error.transient).toBe(false);
    expect(rig.secretRequests()).toBe(1);
    // A caller that takes "missing" as "not configured" must not go on.
    expect(await thrownBy(() => provider.has("db-url"))).toBeInstanceOf(SecretUnavailable);
  });

  test("one that cannot be decrypted says so", async () => {
    rig.secretsManager.handler = () => refusal("DecryptionFailure");
    const error = (await thrownBy(() => rig.provider().get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe(
      "Secrets Manager answered 400 DecryptionFailure. Secrets Manager could not decrypt this secret with its key",
    );
    expect(error.transient).toBe(false);
  });

  test("bytes that are not text are refused, and no part of them is repeated", async () => {
    rig.secrets.set("binary", new Uint8Array([0x41, 0x42, 0xff, 0xfe, 0x43]));
    const provider = rig.provider({ attempts: 3 });
    const error = (await thrownBy(() => provider.get("binary"))) as SecretUnavailable;
    expect(error.reason).toBe("the value is not UTF-8 text");
    expect(error.transient).toBe(false);
    expect(rig.secretRequests()).toBe(1);
  });

  test("a value past the size limit is refused as too large, and the largest that fits is read whole", async () => {
    const largest = "y".repeat(MAX_SECRET_BYTES);
    rig.secrets.set("largest", largest);
    const provider = rig.provider();
    expect(await provider.get("largest")).toBe(largest);
    const marker = random("marker");
    rig.secrets.set("too-large", `${marker}${"x".repeat(MAX_SECRET_BYTES)}`);
    const error = (await thrownBy(() => provider.get("too-large"))) as SecretUnavailable;
    expect(error.reason).toBe(`the value is larger than ${MAX_SECRET_BYTES} bytes`);
    expect(everythingPrintable(error)).not.toContain(marker);
    provider.forget();
  });
});

describe("a Secrets Manager that cannot answer", () => {
  test("no access is unavailable, names the error, and says what the role needs", async () => {
    const provider = rig.provider({ attempts: 3 });
    for (const [answer, label] of [
      [() => refusal("AccessDeniedException"), "400 AccessDeniedException"],
      [() => refusal("NotAuthorized"), "400 NotAuthorized"],
      [() => new Response("Forbidden", { status: 403 }), "403"],
      [() => new Response("Unauthorized", { status: 401 }), "401"],
    ] as const) {
      rig.secretsManager.requests.length = 0;
      rig.secretsManager.handler = answer;
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error.reason).toBe(
        `Secrets Manager refused the request (${label}). The role this host runs as needs ` +
          "secretsmanager:GetSecretValue on this secret, and kms:Decrypt on its key when the key is the organization's own",
      );
      // A permission that was granted a moment ago takes a while to hold.
      expect(error.transient).toBe(true);
      // Only AWS's own answer says that this role may not read this secret.
      // A 401 or a 403 with no name of AWS's came from something on the way.
      expect(error.refused).toBe(label.includes(" "));
      expect(rig.secretRequests()).toBe(1);
    }
  });

  test("no other failure is marked as a refusal", async () => {
    const provider = rig.provider({ attempts: 1 });
    for (const answer of [
      () => refusal("InternalServiceError", 500),
      () => refusal("InvalidRequestException"),
      () => refusal("ExpiredTokenException"),
      () => refusal("InvalidSignatureException", 403),
      () => refusal("OptInRequired", 403),
      () => new Response("not json"),
    ]) {
      rig.secretsManager.handler = answer;
      expect(((await thrownBy(() => provider.get("db-url"))) as SecretUnavailable).refused).toBe(false);
    }
  });

  test("an error answer that is cut off says nothing about the secret, and is asked for again", async () => {
    rig.secrets.set("db-url", "the-value");
    // A 400 whose body ends before its name: whether it would have said that
    // the secret is not there is not known.
    const cut400 = (cuts: number): typeof fetch => {
      let seen = 0;
      return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.startsWith(rig.secretsManager.origin) || (seen += 1) > cuts) return fetch(input, init);
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"__type":"ResourceNot'));
              },
              pull(controller) {
                controller.error(new Error("the connection was lost"));
              },
            }),
            { status: 400, headers: { "content-type": "application/x-amz-json-1.1" } },
          ),
        );
      }) as typeof fetch;
    };
    const once = rig.provider({ fetch: cut400(1), attempts: 3 });
    expect(await once.get("db-url")).toBe("the-value");
    once.forget();
    const always = rig.provider({ fetch: cut400(99), attempts: 2 });
    const error = (await thrownBy(() => always.get("db-url"))) as SecretUnavailable;
    expect(error).toBeInstanceOf(SecretUnavailable);
    expect(error.reason).toBe("Secrets Manager's answer was cut off");
    expect(error.transient).toBe(true);
  });

  test("credentials that were replaced on the platform, while this host still held the old ones, are fetched again once", async () => {
    rig.secrets.set("db-url", random("value"));
    const provider = rig.provider({ cacheTtlMs: 0 });
    await provider.get("db-url");
    // The role's credentials are replaced before the provider would ask again.
    rig.rotate();
    expect(await provider.get("db-url")).toBe(rig.secrets.get("db-url") as string);
    expect(rig.issued).toHaveLength(2);
    expect(rig.platformRequests()).toHaveLength(2);
    expect(rig.secretRequests()).toBe(3);
  });

  test("refused credentials that the platform still hands out are not asked for in a loop", async () => {
    rig.secrets.set("db-url", random("value"));
    const provider = rig.provider({ cacheTtlMs: 0, attempts: 3 });
    await provider.get("db-url");
    rig.revokeCurrent();
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe("Secrets Manager refused the credentials (400 ExpiredTokenException)");
    expect(error.transient).toBe(false);
    expect(rig.platformRequests()).toHaveLength(2);
    expect(rig.secretRequests()).toBe(3);
  });

  test("a Secrets Manager that refuses every set of credentials is unavailable, not a loop", async () => {
    for (const name of ["ExpiredTokenException", "UnrecognizedClientException", "InvalidClientTokenId"]) {
      rig.platform.requests.length = 0;
      rig.secretsManager.requests.length = 0;
      rig.secretsManager.handler = () => refusal(name, name === "InvalidClientTokenId" ? 403 : 400);
      const provider = rig.provider({ attempts: 3 });
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error.reason).toBe(
        `Secrets Manager refused the credentials (${name === "InvalidClientTokenId" ? 403 : 400} ${name})`,
      );
      expect(error.transient).toBe(false);
      expect(rig.platformRequests()).toHaveLength(2);
      expect(rig.secretRequests()).toBe(2);
    }
  });

  test("a busy or failing Secrets Manager is tried again, waiting as long as it asks", async () => {
    rig.secrets.set("db-url", "the-value");
    const real = rig.secretsManager.handler;
    let calls = 0;
    rig.secretsManager.handler = (req, url) => {
      calls += 1;
      // AWS answers "too many requests" with status 400 and this name.
      if (calls === 1) return refusal("ThrottlingException", 400, { "retry-after": "2" });
      if (calls === 2) return refusal("InternalServiceError", 500);
      return real(req, url);
    };
    const provider = rig.provider({ attempts: 3 });
    expect(await provider.get("db-url")).toBe("the-value");
    expect(rig.sleeps).toEqual([2_000, 400]);
    provider.forget();
  });

  test("one that keeps failing is unavailable after the last attempt, and may answer later", async () => {
    for (const [answer, reason] of [
      [() => refusal("ServiceUnavailable", 503), "Secrets Manager answered 503 ServiceUnavailable"],
      [() => refusal("Throttling"), "Secrets Manager answered 400 Throttling"],
      [() => refusal("TooManyRequestsException", 429), "Secrets Manager answered 429 TooManyRequestsException"],
      [() => new Response("Bad Gateway", { status: 502 }), "Secrets Manager answered 502"],
    ] as const) {
      rig.secretsManager.requests.length = 0;
      rig.secretsManager.handler = answer;
      const error = (await thrownBy(() => rig.provider({ attempts: 3 }).get("db-url"))) as SecretUnavailable;
      expect(error.reason).toBe(reason);
      expect(error.transient).toBe(true);
      expect(rig.secretRequests()).toBe(3);
    }
  });

  test("a host whose clock is far from AWS's is told so, from the time AWS's answer carries", async () => {
    rig.secrets.set("db-url", "the-value");
    for (const [off, words] of [
      [20 * 60_000, "20 minutes"],
      [-7 * 60_000, "7 minutes"],
      [26 * 3_600_000, "more than two hours"],
    ] as const) {
      rig.secretsManager.requests.length = 0;
      const provider = rig.provider({ now: () => rig.clock.now + off, attempts: 3 });
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      // The fake refuses the request's time as AWS does: its signature is
      // "expired", or "not yet current".
      expect(error.reason).toBe(
        `Secrets Manager answered 400 InvalidSignatureException. Check the clock of this host: it is ${words} from AWS's own`,
      );
      expect(error.transient).toBe(false);
      expect(rig.secretRequests()).toBe(1);
    }
  });

  test("credentials that AWS calls expired, on a host whose clock is behind, are told the same", async () => {
    rig.secrets.set("db-url", "the-value");
    // The host believes its credentials are good, and AWS's clock is past their end.
    rig.secretsManager.handler = () =>
      json(awsErrorBody("ExpiredTokenException"), 400, { date: new Date(rig.clock.now + 9 * 3_600_000).toUTCString() });
    const error = (await thrownBy(() => rig.provider({ attempts: 3 }).get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe(
      "Secrets Manager refused the credentials (400 ExpiredTokenException). " +
        "Check the clock of this host: it is more than two hours from AWS's own",
    );
  });

  test("a clock within what AWS allows is not blamed, and neither is an answer that judged no time", async () => {
    const dated = (name: string, offMs: number): Response =>
      json(awsErrorBody(name), 400, { date: new Date(rig.clock.now + offMs).toUTCString() });
    const reasonOf = async (answer: () => Response): Promise<string> => {
      rig.secretsManager.handler = answer;
      return ((await thrownBy(() => rig.provider({ attempts: 1 }).get("db-url"))) as SecretUnavailable).reason;
    };
    // Five minutes is still allowed.
    expect(await reasonOf(() => dated("InvalidSignatureException", 5 * 60_000))).toBe(
      "Secrets Manager answered 400 InvalidSignatureException",
    );
    expect(await reasonOf(() => dated("InvalidSignatureException", -5 * 60_000))).toBe(
      "Secrets Manager answered 400 InvalidSignatureException",
    );
    // An answer about something else says nothing of the clock, however far it is.
    expect(await reasonOf(() => dated("ValidationException", 90 * 60_000))).toBe("Secrets Manager answered 400 ValidationException");
    expect(await reasonOf(() => dated("AccessDeniedException", 90 * 60_000))).toStartWith(
      "Secrets Manager refused the request (400 AccessDeniedException). The role",
    );
  });

  test("an answer that says the request's time is too far, and carries no time of its own, is told to check the clock", async () => {
    // A response built here has no Date header, which a server always adds.
    const undated = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(rig.secretsManager.origin)) return fetch(input, init);
      return Promise.resolve(new Response(JSON.stringify(awsErrorBody("RequestExpired")), { status: 400 }));
    }) as typeof fetch;
    const error = (await thrownBy(() => rig.provider({ attempts: 3, fetch: undated }).get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe("Secrets Manager answered 400 RequestExpired. Check the clock of this host: it is too far from AWS's own");
    expect(error.transient).toBe(false);
    // With a time in the answer, the same error says how far.
    rig.secretsManager.handler = () =>
      json(awsErrorBody("RequestExpired"), 400, { date: new Date(rig.clock.now - 16 * 60_000).toUTCString() });
    const dated = (await thrownBy(() => rig.provider({ attempts: 1 }).get("db-url"))) as SecretUnavailable;
    expect(dated.reason).toBe("Secrets Manager answered 400 RequestExpired. Check the clock of this host: it is 16 minutes from AWS's own");
  });

  test("a request signed for another region is refused by Secrets Manager, and named", async () => {
    rig.secrets.set("db-url", "the-value");
    const provider = rig.provider({ region: "eu-west-1" });
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe("Secrets Manager answered 400 InvalidSignatureException");
    expect(error.transient).toBe(false);
  });

  test("one that is not listening is unavailable", async () => {
    const provider = rig.provider({ attempts: 1 });
    await rig.secretsManager.stop();
    const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe("Secrets Manager did not answer (network error)");
    expect(error.transient).toBe(true);
  });

  test("an answer that is not a secret is unavailable", async () => {
    const provider = rig.provider({ attempts: 3 });
    const answers: (() => Response)[] = [
      () => new Response("not json"),
      () => json({}),
      () => json(null),
      () => json([{ SecretString: "x" }]),
      () => json({ Name: "db-url", VersionStages: ["AWSCURRENT"] }),
      () => json({ SecretString: 5 }),
      () => json({ SecretBinary: 5 }),
      () => json({ SecretBinary: "not base64!" }),
      () => json({ SecretBinary: "A" }),
    ];
    for (const answer of answers) {
      rig.secretsManager.requests.length = 0;
      rig.secretsManager.handler = answer;
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error.reason).toBe("Secrets Manager's answer did not hold a secret value");
      expect(error.transient).toBe(false);
      expect(rig.secretRequests()).toBe(1);
    }
  });

  test("an answer that is cut off is asked for again", async () => {
    rig.secrets.set("db-url", "the-value");
    const once = rig.provider({ fetch: cutting(() => rig.secretsManager.origin, 1, '{"SecretString":"'), attempts: 3 });
    expect(await once.get("db-url")).toBe("the-value");
    expect(rig.sleeps).toEqual([200]);
    once.forget();

    const always = rig.provider({ fetch: cutting(() => rig.secretsManager.origin, 99, '{"SecretString":"'), attempts: 2 });
    const error = (await thrownBy(() => always.get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe("Secrets Manager's answer was cut off");
    expect(error.transient).toBe(true);
  });

  test("a redirect is refused, and the signed request does not follow it", async () => {
    const elsewhere = fakeServer(() => json({ SecretString: "from somewhere else" }));
    try {
      rig.secretsManager.handler = () => new Response(null, { status: 307, headers: { location: `${elsewhere.origin}/` } });
      const provider = rig.provider({ attempts: 3 });
      const error = (await thrownBy(() => provider.get("db-url"))) as SecretUnavailable;
      expect(error.reason).toBe("Secrets Manager answered with a redirect, which is not followed");
      expect(error.transient).toBe(false);
      expect(rig.secretRequests()).toBe(1);
      expect(elsewhere.requests).toHaveLength(0);
    } finally {
      await elsewhere.stop();
    }
  });

  test("a proxy that asks for credentials is named as a proxy", async () => {
    rig.secretsManager.handler = () => new Response("Proxy Authentication Required", { status: 407 });
    const error = (await thrownBy(() => rig.provider().get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe("a proxy between this host and Secrets Manager asked for credentials (407)");
  });
});

describe("what an error may say", () => {
  test("no error from any of the paths above holds a value, a credential or text of a response", async () => {
    const value = random("value");
    rig.secrets.set("db-url", value);
    const provider = rig.provider({ attempts: 1 });
    await provider.get("db-url");
    provider.forget();

    // Each way a read can fail after credentials and a value existed.
    rig.secretsManager.handler = () => json(awsErrorBody("AccessDeniedException", value), 400);
    await thrownBy(() => provider.get("db-url"));
    rig.secretsManager.handler = () => new Response(`<html>${value}</html>`, { status: 500 });
    await thrownBy(() => provider.get("db-url"));
    rig.secretsManager.handler = () => json({ __type: value, Message: value }, 400, { "x-amzn-errortype": value });
    await thrownBy(() => provider.get("db-url"));
    rig.secretsManager.handler = () => json({ SecretString: 12, echo: value });
    await thrownBy(() => provider.get("db-url"));
    rig.platform.handler = () => new Response(`denied: ${value}`, { status: 500 });
    provider.forget();
    await thrownBy(() => provider.get("db-url"));

    expect(errors.length).toBeGreaterThan(4);
    const printed = errors.map(everythingPrintable).join("\n");
    expect(printed).not.toContain(value);
    expect(printed).not.toContain(AWS_ERROR_MESSAGE);
    expect(rig.issued.length).toBeGreaterThan(0);
    for (const made of rig.issued) {
      expect(printed).not.toContain(made.secretAccessKey);
      expect(printed).not.toContain(made.sessionToken);
      expect(printed).not.toContain(made.accessKeyId);
    }
  });

  test("a name from a response is repeated only when it is one of AWS's own", async () => {
    const provider = rig.provider();
    const reasonOf = async (answer: () => Response): Promise<string> => {
      rig.secretsManager.handler = answer;
      return ((await thrownBy(() => provider.get("db-url"))) as SecretUnavailable).reason;
    };
    expect(await reasonOf(() => json({ __type: "TextFromAResponseException" }, 400))).toBe("Secrets Manager answered 400");
    expect(await reasonOf(() => json({ __type: "x".repeat(300) }, 400))).toBe("Secrets Manager answered 400");
    expect(await reasonOf(() => json({ __type: ["ValidationException"] }, 400))).toBe("Secrets Manager answered 400");
    expect(await reasonOf(() => json(["ValidationException"], 400))).toBe("Secrets Manager answered 400");
    expect(await reasonOf(() => json({ __type: "IncompleteSignature" }, 400))).toBe(
      "Secrets Manager answered 400 IncompleteSignature",
    );
  });

  test("printing or serializing the provider shows only its kind", async () => {
    const value = random("value");
    rig.secrets.set("db-url", value);
    const provider = rig.provider();
    await provider.get("db-url");
    // It now holds a value and a set of credentials.
    const printed = everythingPrintable(provider);
    expect(printed).not.toContain(value);
    for (const made of rig.issued) {
      expect(printed).not.toContain(made.secretAccessKey);
      expect(printed).not.toContain(made.sessionToken);
    }
    expect(JSON.stringify({ provider })).toBe('{"provider":{"kind":"aws-secrets-manager"}}');
    provider.forget();
  });
});

describe("the region", () => {
  test("a region's name is accepted, and anything that could change the host is not", () => {
    for (const region of ["us-east-1", "eu-west-1", "ap-southeast-2", "us-gov-west-1", "me-central-1", "il-central-1"]) {
      expect(isAwsRegion(region)).toBe(true);
    }
    for (const region of [
      "",
      "us-east",
      "US-EAST-1",
      "us_east_1",
      "us-east-1.evil.example",
      "us-east-1/",
      "us-east-1@evil.example",
      "useast1",
      "1-east-1",
      "us-east-1a",
      "us-east-123",
      " us-east-1",
      // Too few words, and too many.
      "us-1",
      "us-a-b-c-d-1",
      // A word that is not lowercase letters.
      "us-EAST-1",
      "us-e4st-1",
      "us-ea.st-1",
      "us--1",
      // Their hosts end differently, and this build does not ask them.
      "cn-north-1",
      "cn-northwest-1",
      "us-iso-east-1",
      "us-isob-east-1",
    ]) {
      expect(isAwsRegion(region)).toBe(false);
    }
  });

  test("a provider built by hand with something else is refused, and does not repeat it", () => {
    const pasted = `${random("pasted")}.example`;
    let thrown: unknown = null;
    try {
      new AwsSecretsManagerSecretProvider({ region: pasted, credentials: { kind: "container", url: rig.containerUrl } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(everythingPrintable(thrown)).not.toContain(pasted);
  });
});

describe("where the credentials come from", () => {
  test("an Amazon ECS task publishes a path, which is asked at one fixed address", () => {
    expect(resolveAwsCredentialSource({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/4f1c-task" })).toEqual({
      kind: "container",
      url: "http://169.254.170.2/v2/credentials/4f1c-task",
    });
    // Whatever the path holds, the address it is asked at does not change.
    for (const path of ["//elsewhere.example/x", "/@elsewhere.example/x", "/x?y=http://elsewhere.example", "/\\elsewhere.example"]) {
      const source = resolveAwsCredentialSource({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: path });
      expect(source.kind).toBe("container");
      expect(new URL((source as { url: string }).url).origin).toBe("http://169.254.170.2");
    }
  });

  test("with nothing published, the instance metadata service is asked", () => {
    expect(resolveAwsCredentialSource({})).toEqual({ kind: "instance-metadata", origin: "http://169.254.169.254" });
    expect(resolveAwsCredentialSource({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "  " })).toEqual({
      kind: "instance-metadata",
      origin: "http://169.254.169.254",
    });
  });

  test("a path that is not one, and a whole address of the host's own, are refused by name", () => {
    for (const path of ["v2/credentials/x", "http://elsewhere.example/x", "/with space", `/${"x".repeat(2048)}`]) {
      expect(() => resolveAwsCredentialSource({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: path })).toThrow(
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI is not a path",
      );
    }
    // Falling back to the instance metadata service here would use the
    // machine's role in place of the one this host was given.
    expect(() => resolveAwsCredentialSource({ AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials" })).toThrow(
      "this host publishes its credentials at an address of its own (AWS_CONTAINER_CREDENTIALS_FULL_URI), which this build cannot use",
    );
    // The task's path wins when both are there, as AWS's own tools read them.
    expect(
      resolveAwsCredentialSource({
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/x",
        AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials",
      }).kind,
    ).toBe("container");
  });

  test("a host that was given its role through a web identity token is refused by name", () => {
    const refusedAs =
      "this host was given its role through a web identity token (AWS_WEB_IDENTITY_TOKEN_FILE), which this build cannot use";
    // What Amazon EKS sets in a pod. The instance metadata service would
    // answer there with the node's role.
    const pod = {
      AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/hx-fortress-pod",
      AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/secrets/eks.amazonaws.com/serviceaccount/token",
    };
    expect(() => resolveAwsCredentialSource(pod)).toThrow(refusedAs);
    // AWS's own tools take that role before a task's, so it is refused there too.
    expect(() => resolveAwsCredentialSource({ ...pod, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/x" })).toThrow(refusedAs);
    // The role's name alone gives no role, and blank is not set.
    expect(resolveAwsCredentialSource({ AWS_ROLE_ARN: pod.AWS_ROLE_ARN }).kind).toBe("instance-metadata");
    expect(resolveAwsCredentialSource({ AWS_WEB_IDENTITY_TOKEN_FILE: "  " }).kind).toBe("instance-metadata");
  });
});

describe("the settings", () => {
  const root = "/var/lib/hx-fortress";
  const resolve = (env: Record<string, string>, config: unknown = null): unknown =>
    resolveSecretsConfig({ env, config, root });
  const refused = (env: Record<string, string>, config: unknown = null): string => {
    try {
      resolve(env, config);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("expected a refusal");
  };

  test("the provider and its region, from the environment or from config.json", () => {
    expect(resolve({ FORTRESS_SECRETS_PROVIDER: "aws-secrets-manager", FORTRESS_SECRETS_AWS_REGION: "us-east-1" })).toEqual({
      provider: "aws-secrets-manager",
      region: "us-east-1",
    });
    expect(resolve({}, { secrets: { provider: "aws-secrets-manager", region: "eu-west-1", cacheSeconds: 30 } })).toEqual({
      provider: "aws-secrets-manager",
      region: "eu-west-1",
      cacheTtlMs: 30_000,
    });
    // The environment wins, setting by setting.
    expect(
      resolve({ FORTRESS_SECRETS_AWS_REGION: "us-west-2" }, { secrets: { provider: "aws-secrets-manager", region: "eu-west-1" } }),
    ).toEqual({ provider: "aws-secrets-manager", region: "us-west-2" });
  });

  test("a missing region is refused, and the refusal names the setting", () => {
    expect(refused({ FORTRESS_SECRETS_PROVIDER: "aws-secrets-manager" })).toBe(
      "Invalid secrets config: the aws-secrets-manager provider needs the region: set " +
        "FORTRESS_SECRETS_AWS_REGION, or secrets.region in config.json",
    );
    // The region is not taken from the variables AWS's own tools read: the
    // setting says which Secrets Manager holds this HX Fortress's keys.
    expect(refused({ FORTRESS_SECRETS_PROVIDER: "aws-secrets-manager", AWS_REGION: "us-east-1" })).toContain(
      "needs the region",
    );
  });

  test("a region that is not one is refused, and what was written is not repeated", () => {
    const pasted = `Pasted-${random("line")}`;
    const fromEnv = refused({ FORTRESS_SECRETS_PROVIDER: "aws-secrets-manager", FORTRESS_SECRETS_AWS_REGION: pasted });
    expect(fromEnv).toBe(
      "Invalid secrets config: FORTRESS_SECRETS_AWS_REGION must be a region's name, such as us-east-1. " +
        "The regions of China and of the isolated partitions are not read by this build",
    );
    const fromFile = refused({}, { secrets: { provider: "aws-secrets-manager", region: "cn-north-1" } });
    expect(fromFile).toContain("secrets.region in config.json must be a region's name");
  });

  test("the region is a setting of this provider alone", () => {
    expect(refused({ FORTRESS_SECRETS_PROVIDER: "file", FORTRESS_SECRETS_AWS_REGION: "us-east-1" })).toContain(
      "FORTRESS_SECRETS_AWS_REGION is set, but the provider is file",
    );
    expect(
      refused({ FORTRESS_SECRETS_PROVIDER: "aws-secrets-manager", FORTRESS_SECRETS_AWS_REGION: "us-east-1", FORTRESS_SECRETS_AWS_REGIONS: "us-east-1" }),
    ).toContain("FORTRESS_SECRETS_AWS_REGIONS is not a setting this build knows");
  });

  test("a host that publishes credentials this build cannot use stops the provider from being built", () => {
    const env = {
      FORTRESS_SECRETS_PROVIDER: "aws-secrets-manager",
      FORTRESS_SECRETS_AWS_REGION: "us-east-1",
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials",
    };
    expect(() => createSecretProvider(resolveSecretsConfig({ env, config: null, root }), { env })).toThrow(
      "Invalid secrets config: this host publishes its credentials at an address of its own",
    );
  });
});

describe("from the settings to a value", () => {
  test("the provider that the settings build asks AWS's own addresses, as a task", async () => {
    const value = random("value");
    rig.secrets.set("db-url", value);
    // AWS's two addresses are sent to the fakes where requests leave this
    // process, so the provider itself is built exactly as HX Fortress builds
    // it. The request is signed for Secrets Manager's own host.
    rig.signedHost = "secretsmanager.us-east-1.amazonaws.com";
    const undoPlatform = routeHostToFake("169.254.170.2", rig.platform);
    const undoSecrets = routeHostToFake("secretsmanager.us-east-1.amazonaws.com", rig.secretsManager);
    try {
      const env: Record<string, string | undefined> = {
        FORTRESS_SECRETS_PROVIDER: "aws-secrets-manager",
        FORTRESS_SECRETS_AWS_REGION: "us-east-1",
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: rig.containerPath,
      };
      // The fake's clock is not the wall clock, and this provider runs on the
      // wall clock: the fake follows it for this one test.
      rig.clock.now = Date.now();
      const provider = createSecretProvider(resolveSecretsConfig({ env, config: null, root: "/var/lib/hx-fortress" }), { env });
      expect(provider.kind).toBe("aws-secrets-manager");
      expect(await provider.get("db-url")).toBe(value);
      expect(rig.platformRequests()).toEqual([rig.containerPath]);
      (provider as AwsSecretsManagerSecretProvider).forget();
    } finally {
      undoSecrets();
      undoPlatform();
    }
  });
});

describe("a proxy named in the environment", () => {
  const build = (env: Record<string, string | undefined>): void => {
    const withSettings = Object.assign(env, {
      FORTRESS_SECRETS_PROVIDER: "aws-secrets-manager",
      FORTRESS_SECRETS_AWS_REGION: "us-east-1",
    });
    createSecretProvider(resolveSecretsConfig({ env: withSettings, config: null, root: "/var/lib/hx-fortress" }), {
      env: withSettings,
    });
  };

  test("building the provider keeps the endpoint that gives the credentials off it", () => {
    // The request is made in clear text. A proxy that carried it would see
    // the credentials that come back.
    const task: Record<string, string | undefined> = {
      HTTPS_PROXY: "http://proxy.internal.example:3128",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/x",
    };
    build(task);
    expect(task.NO_PROXY).toBe("169.254.170.2");
    expect(task.no_proxy).toBe("169.254.170.2");

    const instance: Record<string, string | undefined> = { HTTP_PROXY: "http://proxy.internal.example:3128", NO_PROXY: "localhost" };
    build(instance);
    expect(instance.NO_PROXY).toBe("localhost,169.254.169.254");
  });

  test("with no proxy named, the environment is left as it is", () => {
    const env: Record<string, string | undefined> = {};
    build(env);
    expect(env.NO_PROXY).toBeUndefined();
  });
});
