// A fake managed identity endpoint and a fake Azure Key Vault: two local HTTP
// servers that speak the two protocols the azure-key-vault provider uses.
// Nothing here reaches Azure.

import { randomBytes } from "node:crypto";

/** A label plus random hex. Made at run time, so the repository holds no
 *  token-shaped or secret-shaped literal and every run uses different ones. */
export const randomLabel = (label: string): string => `${label}-${randomBytes(12).toString("hex")}`;

export type FakeHandler = (req: Request, url: URL) => Response | Promise<Response>;

export interface FakeHttpServer {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  /** Every request received, in order. */
  requests: { path: string; query: URLSearchParams; headers: Headers }[];
  /** Replaceable, so a test can make the server fail in a chosen way. */
  handler: FakeHandler;
  stop(): Promise<void>;
}

export function fakeHttpServer(handler: FakeHandler): FakeHttpServer {
  const fake: FakeHttpServer = {
    origin: "",
    requests: [],
    handler,
    stop: async () => {
      await server.stop(true);
    },
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const url = new URL(req.url);
      fake.requests.push({ path: url.pathname, query: url.searchParams, headers: req.headers });
      return fake.handler(req, url);
    },
  });
  fake.origin = `http://127.0.0.1:${server.port}`;
  return fake;
}

export const jsonResponse = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export interface FakeAzure {
  /** Speaks the Container Apps and App Service protocol at `/msi/token`. */
  identity: FakeHttpServer;
  /** Speaks `GET /secrets/<name>?api-version=7.4`. */
  vault: FakeHttpServer;
  /** What the identity endpoint requires in X-IDENTITY-HEADER. */
  identityHeader: string;
  /** Tokens the identity endpoint has issued. The vault accepts these only. */
  tokens: Set<string>;
  /** What the vault holds. */
  secrets: Map<string, string>;
  /** Milliseconds. The identity endpoint dates its tokens from this. */
  clock: { now: number };
  stop(): Promise<void>;
}

export function startFakeAzure(options: { now?: number } = {}): FakeAzure {
  const tokens = new Set<string>();
  const identityHeader = randomLabel("identity-header");
  const secrets = new Map<string, string>();
  const clock = { now: options.now ?? 1_800_000_000_000 };

  const identity = fakeHttpServer((req, url) => {
    if (url.pathname !== "/msi/token") return jsonResponse({ error: "not found" }, 404);
    if (req.headers.get("x-identity-header") !== identityHeader) {
      return jsonResponse({ statusCode: 401, message: "the identity header is wrong" }, 401);
    }
    const token = randomLabel("access-token");
    tokens.add(token);
    return jsonResponse({
      access_token: token,
      expires_on: String(Math.floor(clock.now / 1000) + 24 * 3600),
      resource: url.searchParams.get("resource"),
      token_type: "Bearer",
    });
  });

  const vault = fakeHttpServer((req, url) => {
    const authorization = req.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!tokens.has(token)) {
      return jsonResponse({ error: { code: "Unauthorized", message: "the token is not valid" } }, 401);
    }
    const match = /^\/secrets\/([^/]+)$/.exec(url.pathname);
    if (!match || url.searchParams.get("api-version") !== "7.4") {
      return jsonResponse({ error: { code: "BadParameter", message: "bad request" } }, 400);
    }
    const name = match[1] as string;
    const value = secrets.get(name);
    if (value === undefined) {
      return jsonResponse(
        { error: { code: "SecretNotFound", message: `A secret with (name/id) ${name} was not found` } },
        404,
      );
    }
    return jsonResponse({
      value,
      id: `${vault.origin}/secrets/${name}/00000000000000000000000000000000`,
      attributes: { enabled: true, created: 1_700_000_000, updated: 1_700_000_000 },
    });
  });

  return {
    identity,
    vault,
    identityHeader,
    tokens,
    secrets,
    clock,
    stop: async () => {
      await identity.stop();
      await vault.stop();
    },
  };
}

/**
 * Send this process's requests for `https://<host>` to a fake server.
 *
 * The real provider accepts only a Key Vault address of a known Azure cloud,
 * and a local server cannot have one. A test that runs the real provider from
 * its settings therefore names a real-looking address and redirects it here,
 * where requests leave the process. Install it before the provider is built.
 * Returns a function that undoes it.
 */
export function routeHostToFake(host: string, fake: FakeHttpServer): () => void {
  const real = globalThis.fetch;
  const routed = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== host) return real(input, init);
    return real(`${fake.origin}${url.pathname}${url.search}`, init);
  };
  globalThis.fetch = routed as unknown as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}
