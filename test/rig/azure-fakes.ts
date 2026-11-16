// A fake managed identity endpoint and a fake Azure Key Vault: two local HTTP
// servers that speak the two protocols the azure-key-vault provider uses.
// Nothing here reaches Azure.

import { fakeHttpServer, jsonResponse, randomLabel, type FakeHttpServer } from "./http-fakes";

export {
  fakeHttpServer,
  jsonResponse,
  randomLabel,
  routeHostToFake,
  type FakeHandler,
  type FakeHttpServer,
} from "./http-fakes";

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
