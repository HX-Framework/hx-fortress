// A fake of what the aws-secrets-manager provider talks to: the endpoint that
// gives an Amazon ECS task its credentials, the instance metadata service of
// an Amazon EC2 instance, and AWS Secrets Manager. Local HTTP servers.
// Nothing here reaches AWS.
//
// The fake Secrets Manager checks each request's signature with code of its
// own (the Web Crypto functions, and the headers as they really arrived), so a
// mistake in the provider's signing, or in what it sends, is refused here as
// AWS would refuse it.

import { fakeHttpServer, jsonResponse, randomLabel, type FakeHttpServer } from "./http-fakes";

/** The words every fake error body carries as its message. No error of the
 *  provider may repeat them. */
export const AWS_ERROR_MESSAGE = "a message that no error may repeat";

/** An error body of an AWS JSON service. */
export const awsErrorBody = (name: string, message = AWS_ERROR_MESSAGE): unknown => ({ __type: name, Message: message });

export interface IssuedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** Milliseconds since 1970, on the fake's clock. */
  expiresAt: number;
}

export interface FakeAws {
  /** Both ways a host gets credentials: `GET /v2/credentials/<id>` of a task,
   *  and the instance metadata service under `/latest/`. */
  platform: FakeHttpServer;
  /** `POST /` with `X-Amz-Target: secretsmanager.GetSecretValue`. */
  secretsManager: FakeHttpServer;
  /** The address a task's credentials are at: what the fixed origin and
   *  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI make together. */
  containerUrl: string;
  /** The path alone: what AWS_CONTAINER_CREDENTIALS_RELATIVE_URI holds. */
  containerPath: string;
  region: string;
  /** The role an instance has. Null: it has none. */
  role: string | null;
  /** Every set of credentials the platform has made, in order. */
  issued: IssuedCredentials[];
  /**
   * The real endpoints hand out the credentials they hold, and make new ones
   * shortly before those expire. So does this one: every request gets the same
   * credentials until five minutes of their life remain, or until a test says
   * otherwise with one of the two calls below.
   */
  /** The platform now holds new credentials, and Secrets Manager no longer
   *  takes the earlier ones. */
  rotate(): void;
  /** Secrets Manager no longer takes the credentials the platform holds, and
   *  the platform goes on handing them out. */
  revokeCurrent(): void;
  /** Sessions the instance metadata service has opened. */
  sessions: Set<string>;
  /** What Secrets Manager holds: text, or bytes that were stored as bytes. */
  secrets: Map<string, string | Uint8Array>;
  /** Milliseconds. Credentials are dated from this, and a request's time is held to it. */
  clock: { now: number };
  /** How long new credentials live. */
  lifetimeMs: number;
  /** How many characters a new session token has. Null: a short one. */
  sessionTokenLength: number | null;
  /** The host a request must be signed for. Null: the host it arrived at. A
   *  test that sends AWS's own host name to this fake names it here. */
  signedHost: string | null;
  stop(): Promise<void>;
}

const hex = (bytes: ArrayBuffer): string => Buffer.from(bytes).toString("hex");

async function hmac(key: ArrayBuffer, text: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(text));
}

/** The bytes of a text, as a buffer of their own. */
function bytesOf(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** The signature a request should carry, worked out from what arrived. */
async function expectedSignature(parts: {
  method: string;
  path: string;
  headers: (name: string) => string;
  signed: string[];
  body: string;
  secretAccessKey: string;
  timestamp: string;
  region: string;
  service: string;
}): Promise<string> {
  const date = parts.timestamp.slice(0, 8);
  const canonical = [
    parts.method,
    parts.path,
    "",
    ...parts.signed.map((name) => `${name}:${parts.headers(name).trim().replace(/ +/g, " ")}`),
    "",
    parts.signed.join(";"),
    await sha256(parts.body),
  ].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", parts.timestamp, `${date}/${parts.region}/${parts.service}/aws4_request`, await sha256(canonical)].join("\n");
  let key = await hmac(bytesOf(`AWS4${parts.secretAccessKey}`), date);
  for (const step of [parts.region, parts.service, "aws4_request"]) key = await hmac(key, step);
  return hex(await hmac(key, toSign));
}

export function startFakeAws(options: { region?: string } = {}): FakeAws {
  const region = options.region ?? "us-east-1";
  const clock = { now: 1_800_000_000_000 };
  const issued: IssuedCredentials[] = [];
  const sessions = new Set<string>();
  const secrets = new Map<string, string | Uint8Array>();
  const containerPath = `/v2/credentials/${randomLabel("task")}`;
  /** The credentials the platform holds now. */
  let held: IssuedCredentials | null = null;
  /** Credentials Secrets Manager no longer takes. */
  const revoked = new Set<IssuedCredentials>();

  /** What a request for credentials gets. New credentials are there at least
   *  five minutes before the held ones expire. */
  const current = (): IssuedCredentials => {
    if (held === null || held.expiresAt - clock.now <= 5 * 60_000) held = issue();
    return held;
  };

  const issue = (): IssuedCredentials => {
    const made: IssuedCredentials = {
      // An id of capitals and digits, made at run time.
      accessKeyId: `ASIA${randomLabel("").replace(/[^a-z0-9]/g, "").toUpperCase().slice(0, 16)}`,
      secretAccessKey: randomLabel("secret-access-key"),
      sessionToken:
        fake.sessionTokenLength === null
          ? randomLabel("session-token")
          : Buffer.from(crypto.getRandomValues(new Uint8Array(fake.sessionTokenLength))).toString("base64").slice(0, fake.sessionTokenLength),
      expiresAt: clock.now + fake.lifetimeMs,
    };
    issued.push(made);
    return made;
  };
  const credentialsBody = (made: IssuedCredentials, extra: Record<string, unknown> = {}): unknown => ({
    ...extra,
    AccessKeyId: made.accessKeyId,
    SecretAccessKey: made.secretAccessKey,
    Token: made.sessionToken,
    Expiration: new Date(made.expiresAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
  });

  const platform = fakeHttpServer((req, url) => {
    // The real endpoints refuse a request that came through something that
    // forwards requests.
    if (req.headers.has("x-forwarded-for")) return new Response("Forbidden", { status: 403 });
    if (url.pathname === containerPath) {
      if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      return jsonResponse(credentialsBody(current(), { RoleArn: "arn:aws:iam::123456789012:role/hx-fortress-task" }));
    }
    if (url.pathname === "/latest/api/token") {
      if (req.method !== "PUT") return new Response("Method Not Allowed", { status: 405 });
      const seconds = Number(req.headers.get("x-aws-ec2-metadata-token-ttl-seconds"));
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 21_600) return new Response("Bad Request", { status: 400 });
      const session = randomLabel("metadata-session");
      sessions.add(session);
      return new Response(session, { headers: { "content-type": "text/plain" } });
    }
    const roles = "/latest/meta-data/iam/security-credentials/";
    if (url.pathname.startsWith(roles)) {
      if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      if (!sessions.has(req.headers.get("x-aws-ec2-metadata-token") ?? "")) return new Response("Unauthorized", { status: 401 });
      if (fake.role === null) return new Response("Not Found", { status: 404 });
      const asked = url.pathname.slice(roles.length);
      if (asked === "") return new Response(`${fake.role}\n`, { headers: { "content-type": "text/plain" } });
      if (asked !== fake.role) return new Response("Not Found", { status: 404 });
      // All metadata is sent as plain text, this JSON included.
      return new Response(
        JSON.stringify(credentialsBody(current(), { Code: "Success", LastUpdated: "2026-11-16T12:00:00Z", Type: "AWS-HMAC" })),
        { headers: { "content-type": "text/plain" } },
      );
    }
    return new Response("Not Found", { status: 404 });
  });

  /** Every answer of Secrets Manager says what time it is there. */
  const dated = (): Record<string, string> => ({ date: new Date(clock.now).toUTCString() });
  const refuse = (name: string, status = 400): Response =>
    jsonResponse(awsErrorBody(name), status, { "x-amzn-errortype": name, ...dated() });

  const secretsManager = fakeHttpServer(async (req, url) => {
    const body = await req.text();
    if (req.method !== "POST" || url.pathname !== "/" || url.search !== "") return refuse("UnknownOperationException", 404);
    if (req.headers.get("x-amz-target") !== "secretsmanager.GetSecretValue") return refuse("UnknownOperationException", 404);
    if (req.headers.get("content-type") !== "application/x-amz-json-1.1") return refuse("UnknownOperationException", 404);

    const authorization = req.headers.get("authorization") ?? "";
    const match =
      /^AWS4-HMAC-SHA256 Credential=([A-Z0-9]+)\/(\d{8})\/([a-z0-9-]+)\/([a-z]+)\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(
        authorization,
      );
    if (!match) return refuse(authorization ? "IncompleteSignature" : "MissingAuthenticationToken");
    const [, keyId, date, scopeRegion, service, signedList, signature] = match as unknown as string[];
    const made = issued.find((one) => one.accessKeyId === keyId);
    if (!made || req.headers.get("x-amz-security-token") !== made.sessionToken) return refuse("UnrecognizedClientException");
    if (revoked.has(made) || made.expiresAt <= clock.now) return refuse("ExpiredTokenException");

    const signed = (signedList ?? "").split(";");
    // What AWS wants signed: the host, the time, and every x-amz header sent.
    const required = ["content-type", "host", "x-amz-date", "x-amz-security-token", "x-amz-target"];
    if (required.some((name) => !signed.includes(name))) return refuse("InvalidSignatureException");
    const timestamp = req.headers.get("x-amz-date") ?? "";
    const at = Date.parse(timestamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));
    if (!Number.isFinite(at) || timestamp.slice(0, 8) !== date) return refuse("IncompleteSignature");
    // What a service of this kind answers for a time that is too far from
    // its own: "Signature expired", or "Signature not yet current".
    if (Math.abs(at - clock.now) > 5 * 60_000) return refuse("InvalidSignatureException");
    if (scopeRegion !== region || service !== "secretsmanager") return refuse("InvalidSignatureException");

    const expected = await expectedSignature({
      method: req.method,
      path: url.pathname,
      headers: (name) => (name === "host" && fake.signedHost ? fake.signedHost : (req.headers.get(name) ?? "")),
      signed,
      body,
      secretAccessKey: made.secretAccessKey,
      timestamp,
      region,
      service: "secretsmanager",
    });
    if (expected !== signature) return refuse("InvalidSignatureException");

    let asked: unknown;
    try {
      asked = JSON.parse(body);
    } catch {
      return refuse("SerializationException");
    }
    const id = (asked as { SecretId?: unknown } | null)?.SecretId;
    if (typeof id !== "string" || id === "") return refuse("ValidationException");
    const stored = secrets.get(id);
    if (stored === undefined) return refuse("ResourceNotFoundException");
    return jsonResponse(
      {
        ARN: `arn:aws:secretsmanager:${region}:123456789012:secret:${id}-AbCdEf`,
        CreatedDate: 1.523477145713e9,
        Name: id,
        VersionId: "EXAMPLE1-90ab-cdef-fedc-ba987SECRET1",
        VersionStages: ["AWSCURRENT"],
        ...(typeof stored === "string" ? { SecretString: stored } : { SecretBinary: Buffer.from(stored).toString("base64") }),
      },
      200,
      { "content-type": "application/x-amz-json-1.1", ...dated() },
    );
  });

  const fake: FakeAws = {
    platform,
    secretsManager,
    containerUrl: `${platform.origin}${containerPath}`,
    containerPath,
    region,
    role: "hx-fortress-instance",
    issued,
    rotate: () => {
      if (held) revoked.add(held);
      held = null;
    },
    revokeCurrent: () => {
      if (held) revoked.add(held);
    },
    sessions,
    secrets,
    clock,
    lifetimeMs: 6 * 3_600_000,
    sessionTokenLength: null,
    signedHost: null,
    stop: async () => {
      await platform.stop();
      await secretsManager.stop();
    },
  };
  return fake;
}
