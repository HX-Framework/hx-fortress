// A local OpenID Connect issuer for tests: discovery, signing keys, an
// authorization step and a token endpoint, on a loopback port. It signs real
// ID tokens with a key pair made when it starts, and it checks what a real
// provider checks: the client, the redirect URI, the one-time code and PKCE.
//
// The tests play the browser. `authorize` is what the provider's sign-in page
// would do after a person signed in: it takes the authorization URL the console
// produced and returns the redirect the provider would send back.

import { createHash, createHmac, randomBytes } from "node:crypto";

import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

/** How the next ID token is signed. Everything but "own" must be refused. */
export type SigningMode = "own" | "another-key" | "hs256-with-client-secret" | "none";

export interface FakeIssuerOptions {
  clientId?: string;
  /** Null for a public client, which is given no secret. */
  clientSecret?: string | null;
  /** How the token endpoint expects a confidential client to authenticate. */
  tokenAuthMethods?: string[];
  /** Whether the code may be returned in the URL fragment. */
  fragment?: boolean;
}

export interface FakeIssuer {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  /** The redirect URIs registered for the client. */
  redirectUris: Set<string>;
  /** People who can sign in, by subject, with the claims their token carries. */
  people: Map<string, Record<string, unknown>>;
  /** Change the next tokens. Each is reset by `reset()`. */
  tweak: {
    signing: SigningMode;
    /** Rewrite the claims just before signing. */
    claims: (claims: Record<string, unknown>) => Record<string, unknown>;
    /** Rewrite the discovery document. */
    discovery: (doc: Record<string, unknown>) => Record<string, unknown>;
    /** Answer the token endpoint with this instead. */
    tokenError: { status: number; body: unknown } | null;
  };
  reset(): void;
  /** What each endpoint received. */
  seen: {
    discovery: number;
    keys: number;
    token: { form: URLSearchParams; authorization: string | null }[];
  };
  /** The provider's side of a sign-in by `subject`: the code and the redirect. */
  authorize(authorizationUrl: string, subject: string): { code: string; state: string; redirect: URL };
  stop(): Promise<void>;
}

const b64url = (bytes: Buffer): string => bytes.toString("base64url");

/** An unsigned token, as a provider that signs nothing would send it. */
function unsignedJwt(claims: Record<string, unknown>): string {
  return `${b64url(Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })))}.${b64url(Buffer.from(JSON.stringify(claims)))}.`;
}

/** A token signed with a shared secret instead of the provider's private key. */
function hmacJwt(claims: Record<string, unknown>, secret: string): string {
  const head = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(Buffer.from(JSON.stringify(claims)));
  return `${head}.${body}.${b64url(createHmac("sha256", secret).update(`${head}.${body}`).digest())}`;
}

export async function startFakeIssuer(options: FakeIssuerOptions = {}): Promise<FakeIssuer> {
  const own: KeyPair = await generateKeyPair("ES256", { extractable: true });
  const other: KeyPair = await generateKeyPair("ES256", { extractable: true });
  const kid = `key-${randomBytes(4).toString("hex")}`;
  const publicJwk: JWK = { ...(await exportJWK(own.publicKey)), kid, alg: "ES256", use: "sig" };

  const codes = new Map<
    string,
    { subject: string; nonce: string | null; challenge: string | null; redirectUri: string; clientId: string }
  >();

  const fake: FakeIssuer = {
    issuer: "",
    clientId: options.clientId ?? "fortress-console",
    clientSecret: options.clientSecret === undefined ? null : options.clientSecret,
    redirectUris: new Set(),
    people: new Map(),
    tweak: { signing: "own", claims: (c) => c, discovery: (d) => d, tokenError: null },
    reset: () => {
      fake.tweak = { signing: "own", claims: (c) => c, discovery: (d) => d, tokenError: null };
    },
    seen: { discovery: 0, keys: 0, token: [] },
    authorize: (authorizationUrl, subject) => {
      const url = new URL(authorizationUrl);
      if (`${url.origin}${url.pathname}` !== `${fake.issuer}/authorize`) {
        throw new Error("the console sent the browser somewhere other than this provider");
      }
      const q = url.searchParams;
      const redirectUri = q.get("redirect_uri") ?? "";
      if (q.get("client_id") !== fake.clientId) throw new Error("unknown client");
      if (!fake.redirectUris.has(redirectUri)) throw new Error(`redirect URI not registered: ${redirectUri}`);
      if (q.get("response_type") !== "code") throw new Error("response_type must be code");
      if (!(q.get("scope") ?? "").split(" ").includes("openid")) throw new Error("scope must include openid");
      if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
        throw new Error("PKCE with S256 is required");
      }
      if (!fake.people.has(subject)) throw new Error(`nobody with subject ${subject}`);
      const code = `code-${randomBytes(12).toString("hex")}`;
      codes.set(code, {
        subject,
        nonce: q.get("nonce"),
        challenge: q.get("code_challenge"),
        redirectUri,
        clientId: fake.clientId,
      });
      const state = q.get("state") ?? "";
      const redirect = new URL(redirectUri);
      const answer = new URLSearchParams({ code, state }).toString();
      if (q.get("response_mode") === "fragment") redirect.hash = answer;
      else redirect.search = answer;
      return { code, state, redirect };
    },
    stop: async () => {
      await server.stop(true);
    },
  };

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/openid-configuration") {
        fake.seen.discovery += 1;
        return json(
          fake.tweak.discovery({
            issuer: fake.issuer,
            authorization_endpoint: `${fake.issuer}/authorize`,
            token_endpoint: `${fake.issuer}/token`,
            jwks_uri: `${fake.issuer}/keys`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["ES256"],
            token_endpoint_auth_methods_supported: options.tokenAuthMethods ?? [
              "client_secret_post",
              "client_secret_basic",
            ],
            response_modes_supported: options.fragment === false ? ["query"] : ["query", "fragment"],
          }),
        );
      }
      if (url.pathname === "/keys") {
        fake.seen.keys += 1;
        return json({ keys: [publicJwk] });
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        const authorization = req.headers.get("authorization");
        fake.seen.token.push({ form, authorization });
        if (fake.tweak.tokenError) return json(fake.tweak.tokenError.body, fake.tweak.tokenError.status);

        if (fake.clientSecret !== null) {
          let presented = form.get("client_secret");
          if (authorization?.startsWith("Basic ")) {
            const [, secret] = Buffer.from(authorization.slice(6), "base64").toString("utf8").split(":");
            presented = decodeURIComponent((secret ?? "").replace(/\+/g, " "));
          }
          if (presented !== fake.clientSecret) return json({ error: "invalid_client" }, 401);
        }
        const grant = codes.get(form.get("code") ?? "");
        // One use: a code is gone once it was presented, whatever comes next.
        codes.delete(form.get("code") ?? "");
        if (!grant || form.get("grant_type") !== "authorization_code") return json({ error: "invalid_grant" }, 400);
        if (form.get("client_id") !== grant.clientId || form.get("redirect_uri") !== grant.redirectUri) {
          return json({ error: "invalid_grant" }, 400);
        }
        const verifier = form.get("code_verifier") ?? "";
        if (b64url(createHash("sha256").update(verifier).digest()) !== grant.challenge) {
          return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
        }

        const now = Math.floor(Date.now() / 1000);
        const claims = fake.tweak.claims({
          iss: fake.issuer,
          aud: fake.clientId,
          sub: grant.subject,
          iat: now,
          exp: now + 300,
          ...(grant.nonce ? { nonce: grant.nonce } : {}),
          ...(fake.people.get(grant.subject) ?? {}),
        });
        let idToken: string;
        if (fake.tweak.signing === "none") idToken = unsignedJwt(claims);
        else if (fake.tweak.signing === "hs256-with-client-secret") {
          idToken = hmacJwt(claims, fake.clientSecret ?? fake.clientId);
        } else {
          idToken = await new SignJWT(claims)
            .setProtectedHeader({ alg: "ES256", kid })
            .sign(fake.tweak.signing === "another-key" ? other.privateKey : own.privateKey);
        }
        return json({ access_token: `at-${randomBytes(8).toString("hex")}`, token_type: "Bearer", expires_in: 300, id_token: idToken });
      }
      return json({ error: "not_found" }, 404);
    },
  });
  fake.issuer = `http://127.0.0.1:${server.port}`;
  return fake;
}
