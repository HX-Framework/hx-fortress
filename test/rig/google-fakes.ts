// A fake metadata server and a fake Google Secret Manager: two local HTTP
// servers that speak the two protocols the google-secret-manager provider
// uses. Nothing here reaches Google Cloud.

import { fakeHttpServer, jsonResponse, randomLabel, type FakeHttpServer } from "./http-fakes";

export const GOOGLE_TOKEN_PATH = "/computeMetadata/v1/instance/service-accounts/default/token";

export interface FakeGoogle {
  /** Answers `GET /computeMetadata/v1/instance/service-accounts/default/token`
   *  to a request with the header `Metadata-Flavor: Google`. */
  metadata: FakeHttpServer;
  /** Answers `GET /v1/projects/<project>/secrets/<name>/versions/latest:access`. */
  secretManager: FakeHttpServer;
  /** The address of the token, at the fake metadata server. */
  tokenUrl: string;
  /** The one project this Secret Manager holds secrets for. */
  project: string;
  /** Tokens the metadata server has issued. Secret Manager accepts these only. */
  tokens: Set<string>;
  /**
   * The real metadata server hands out the token it holds until five minutes
   * of that token's life remain, and so does this one: every request gets the
   * same token until a test says that it has ended.
   */
  endToken(): void;
  /**
   * The secrets this host's service account was granted, one by one. Null:
   * the role is granted on the whole project. With a list, Secret Manager
   * refuses every other name, whether or not a secret has it.
   */
  granted: Set<string> | null;
  /** What the project holds: text, or bytes that need not be text. */
  secrets: Map<string, string | Uint8Array>;
  /** How long a token says it lives, in seconds. */
  tokenLifetimeSeconds: number;
  stop(): Promise<void>;
}

/** An error body of a Google API. */
export function googleErrorBody(
  code: number,
  status: string,
  details: unknown[] = [],
  message = "a message that no error may repeat",
): unknown {
  return { error: { code, message, status, ...(details.length > 0 ? { details } : {}) } };
}

/** The ErrorInfo entry of an error body's details. */
export const googleErrorInfo = (reason: string, domain = "googleapis.com"): unknown => ({
  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
  reason,
  domain,
  metadata: { service: "secretmanager.googleapis.com" },
});

/**
 * CRC32C, bit by bit. Written apart from the one the provider uses
 * (src/secrets/crc32c.ts works from a table), so that a mistake in either one
 * shows as a checksum that does not match.
 */
export function crc32cBitwise(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The body Secret Manager answers an access with. An empty value has no
 *  `data` field: a JSON answer of a Google API leaves an empty field out. */
export function accessBody(project: string, name: string, stored: string | Uint8Array): unknown {
  const bytes = typeof stored === "string" ? new TextEncoder().encode(stored) : stored;
  return {
    name: `projects/${project}/secrets/${name}/versions/3`,
    payload: {
      ...(bytes.byteLength > 0 ? { data: Buffer.from(bytes).toString("base64") } : {}),
      dataCrc32c: String(crc32cBitwise(bytes)),
    },
  };
}

export function startFakeGoogle(options: { project?: string } = {}): FakeGoogle {
  const tokens = new Set<string>();
  const secrets = new Map<string, string | Uint8Array>();
  const project = options.project ?? "northstar-fortress";
  /** The token the metadata server holds now. */
  let held: string | null = null;

  const metadata = fakeHttpServer((req, url) => {
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
    // The real server refuses a request without this header, and one that
    // came through something that forwards requests.
    if (req.headers.get("metadata-flavor") !== "Google" || req.headers.has("x-forwarded-for")) {
      return new Response("Missing Metadata-Flavor:Google header.", { status: 403 });
    }
    if (url.pathname !== GOOGLE_TOKEN_PATH) return new Response("Not Found", { status: 404 });
    if (held === null) {
      held = randomLabel("access-token");
      tokens.add(held);
    }
    return jsonResponse({ access_token: held, expires_in: fake.tokenLifetimeSeconds, token_type: "Bearer" });
  });

  const secretManager = fakeHttpServer((req, url) => {
    const authorization = req.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!tokens.has(token)) return jsonResponse(googleErrorBody(401, "UNAUTHENTICATED"), 401);
    const match = /^\/v1\/projects\/([^/]+)\/secrets\/([^/]+)\/versions\/latest:access$/.exec(url.pathname);
    if (!match || req.method !== "GET") return jsonResponse(googleErrorBody(400, "INVALID_ARGUMENT"), 400);
    const [, askedProject, name] = match as unknown as [string, string, string];
    // Permission is checked before a thing is looked for: a caller with no
    // access to a project learns nothing about what it holds.
    if (askedProject !== project) {
      return jsonResponse(googleErrorBody(403, "PERMISSION_DENIED", [googleErrorInfo("IAM_PERMISSION_DENIED")]), 403);
    }
    if (fake.granted !== null && !fake.granted.has(name)) {
      return jsonResponse(
        googleErrorBody(403, "PERMISSION_DENIED", [googleErrorInfo("IAM_PERMISSION_DENIED", "iam.googleapis.com")]),
        403,
      );
    }
    const stored = secrets.get(name);
    if (stored === undefined) return jsonResponse(googleErrorBody(404, "NOT_FOUND"), 404);
    return jsonResponse(accessBody(project, name, stored));
  });

  const fake: FakeGoogle = {
    metadata,
    secretManager,
    tokenUrl: `${metadata.origin}${GOOGLE_TOKEN_PATH}`,
    project,
    tokens,
    endToken: () => {
      if (held !== null) tokens.delete(held);
      held = null;
    },
    granted: null,
    secrets,
    tokenLifetimeSeconds: 3599,
    stop: async () => {
      await metadata.stop();
      await secretManager.stop();
    },
  };
  return fake;
}
