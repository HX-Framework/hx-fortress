// Console sign-in through the organization's own identity provider, against a
// local fake OpenID Connect issuer (test/rig/fake-oidc-issuer.ts) and the real
// console server. The tests play the browser.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cliAuditAct } from "../src/cli-audit";
import { runUiVerb } from "../src/cli-ui-verbs";
import { AuditSpool, readSpool } from "../src/console/audit-spool";
import { fortressPaths } from "../src/host/paths";
import { EnvSecretProvider } from "../src/secrets";
import type { UiAssets } from "../src/ui/assets";
import { ConsoleAudit } from "../src/ui/audit-writer";
import { READONLY_REFUSAL_COPY } from "../src/ui/copy";
import { UI_CONFIG_DEFAULTS } from "../src/ui/config";
import { dataPathRows } from "../src/ui/egress";
import { identityFromClaims, METADATA_FAILURE_TTL_MS, OidcFlows } from "../src/ui/oidc";
import {
  checkOidcIssuer,
  LiveOidcConfig,
  OIDC_CONFIG_DEFAULTS,
  OidcConfigStore,
  oidcMissing,
  parseOidcConfig,
  type UiOidcConfig,
} from "../src/ui/oidc-config";
import {
  handleOidcRoute,
  OIDC_CALLBACK_PATH,
  OIDC_FAILED_COPY,
  OIDC_NOT_ALLOWED_COPY,
  OIDC_PATHS,
  OIDC_UNAVAILABLE_COPY,
} from "../src/ui/oidc-routes";
import { UiRuntime, WARN_LINES_PER_WINDOW } from "../src/ui/runtime";
import { SESSION_HEADER } from "../src/ui/sessions";
import { startUiServer } from "../src/ui/server";
import { startFakeIssuer, type FakeIssuer, type FakeIssuerOptions } from "./rig/fake-oidc-issuer";

const assets: UiAssets = {
  mode: "disk",
  files: { "/index.html": path.join(import.meta.dir, "..", "package.json") },
  inlineScriptHashes: [],
  manifest: { hash: "b".repeat(64), files: 1, bytes: 1 },
};

const OPERATORS = "fortress-operators";
const AUDITORS = "fortress-auditors";

let root: string;
let runtime: UiRuntime;
let audit: ConsoleAudit;
let server: ReturnType<typeof startUiServer>;
let origin: string;
let issuer: FakeIssuer;
let store: OidcConfigStore;
/** What the console told the operator, one line per refusal. */
let warnings: string[];
/** Milliseconds added to the console's clock. */
let clock: { offset: number };
/** The environment the console's secret provider reads. */
let secretEnv: Record<string, string>;

async function useIssuer(options: FakeIssuerOptions = {}): Promise<void> {
  await issuer?.stop();
  issuer = await startFakeIssuer(options);
  issuer.redirectUris.add(`${origin}${OIDC_CALLBACK_PATH}`);
  issuer.people.set("sub-olga", { email: "Olga@Contoso.example", groups: [OPERATORS, "everyone"] });
  issuer.people.set("sub-ravi", { email: "ravi@contoso.example", groups: [AUDITORS] });
  issuer.people.set("sub-both", { email: "both@contoso.example", groups: [AUDITORS, OPERATORS] });
  issuer.people.set("sub-none", { email: "none@contoso.example", groups: ["everyone"] });
  issuer.people.set("sub-nogroups", { email: "nogroups@contoso.example" });
  issuer.people.set("sub-overage", {
    email: "overage@contoso.example",
    _claim_names: { groups: "src1" },
    _claim_sources: { src1: { endpoint: "https://graph.example.com/groups" } },
  });
}

/** Switch sign-in through the provider on, as `ui oidc set` and `ui oidc on` do. */
async function configure(over: Partial<UiOidcConfig> = {}): Promise<UiOidcConfig> {
  return store.update((current) => ({
    ...current,
    enabled: true,
    issuer: issuer.issuer,
    clientId: issuer.clientId,
    operatorGroups: [OPERATORS],
    readonlyGroups: [AUDITORS],
    ...over,
  }));
}

const post = (pathname: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body: JSON.stringify(body),
  });

interface Started {
  authorizationUrl: string;
  verifier: string;
}

async function startFlow(): Promise<Started> {
  const res = await post(OIDC_PATHS.start, {});
  expect(res.status).toBe(200);
  return (await res.json()) as Started;
}

/** A whole sign-in by the person with this subject. */
async function signIn(subject: string): Promise<Response> {
  const started = await startFlow();
  const { code, state } = issuer.authorize(started.authorizationUrl, subject);
  return post(OIDC_PATHS.session, { code, state, verifier: started.verifier });
}

async function sessionOf(subject: string): Promise<{ token: string; login: string; role: string }> {
  const res = await signIn(subject);
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; login: string; role: string };
}

const whoami = (token: string): Promise<Response> =>
  fetch(`${origin}/ui/api/session`, { headers: { [SESSION_HEADER]: token } });

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hx-oidc-"));
  warnings = [];
  clock = { offset: 0 };
  secretEnv = {};
  runtime = new UiRuntime({
    uiRoot: root,
    uiConfigFile: path.join(root, "ui.json"),
    cmdCredsDir: path.join(root, "cmd-creds"),
    env: {},
    now: () => Date.now() + clock.offset,
    onWarn: (message) => warnings.push(message),
    secrets: async () => new EnvSecretProvider(secretEnv),
  });
  runtime.routes.register({ method: "GET", path: "/ui/api/overview", cls: "read" });
  runtime.routes.register({ method: "POST", path: "/ui/api/service/restart", cls: "mutate" });
  audit = new ConsoleAudit(new AuditSpool({ dir: path.join(root, "spool"), writer: "ui" }));
  server = startUiServer({ assets, port: 0, runtime, audit }, "127.0.0.1");
  origin = `http://127.0.0.1:${server.port}`;
  store = new OidcConfigStore(path.join(root, "oidc.json"));
  await useIssuer();
});

afterEach(async () => {
  await server.stop(true);
  await issuer.stop();
  await rm(root, { recursive: true, force: true });
});

describe("off by default", () => {
  test("with no settings, the three routes answer exactly as a path that does not exist", async () => {
    const unknown = await fetch(`${origin}/ui/api/there-is-no-such-thing`);
    const status = await fetch(`${origin}${OIDC_PATHS.status}`);
    expect(status.status).toBe(401);
    expect(status.status).toBe(unknown.status);
    expect(await status.text()).toBe(await unknown.text());
    for (const header of ["content-type", "cache-control", "content-security-policy", "retry-after"]) {
      expect(status.headers.get(header)).toBe(unknown.headers.get(header));
    }

    // A POST with no Origin header: 401 like any unknown path. A known public
    // POST route would answer 403 here, which would give the route away.
    for (const pathname of [OIDC_PATHS.start, OIDC_PATHS.session, "/ui/api/there-is-no-such-thing"]) {
      const res = await fetch(`${origin}${pathname}`, { method: "POST", body: "{}" });
      expect([pathname, res.status]).toEqual([pathname, 401]);
    }
    expect(existsSync(path.join(root, "oidc.json"))).toBe(false);
  });

  test("they draw from no rate bucket while off, so a flood cannot tell them from an unknown path", async () => {
    // More requests than the route's own bucket allows per minute when it is on.
    for (let i = 0; i < 260; i += 1) {
      const res = await fetch(`${origin}${OIDC_PATHS.status}`);
      if (res.status !== 401) throw new Error(`request ${i} answered ${res.status}`);
    }
  });

  test("settings that are complete and not switched on are still off", async () => {
    await configure({ enabled: false });
    expect((await fetch(`${origin}${OIDC_PATHS.status}`)).status).toBe(401);
    expect((await post(OIDC_PATHS.start, {})).status).toBe(401);
  });

  test("settings that are switched on and incomplete are off", async () => {
    await configure({ operatorGroups: [], readonlyGroups: [] });
    expect((await fetch(`${origin}${OIDC_PATHS.status}`)).status).toBe(401);
  });

  test("a settings file that does not parse turns it off and says so once", async () => {
    await configure();
    expect((await fetch(`${origin}${OIDC_PATHS.status}`)).status).toBe(200);
    await writeFile(path.join(root, "oidc.json"), "{ not json");
    expect((await fetch(`${origin}${OIDC_PATHS.status}`)).status).toBe(401);
    expect((await fetch(`${origin}${OIDC_PATHS.status}`)).status).toBe(401);
    expect(warnings.filter((w) => w.includes("oidc.json does not parse"))).toHaveLength(1);
  });
});

describe("signing in through the identity provider", () => {
  beforeEach(async () => {
    await configure({ label: "Contoso" });
  });

  test("the page is told the sign-in is offered, and nothing else about the provider", async () => {
    const res = await fetch(`${origin}${OIDC_PATHS.status}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ label: "Contoso" });
  });

  test("the authorization request is a code flow with PKCE, a nonce and this console's own redirect URI", async () => {
    const started = await startFlow();
    const url = new URL(started.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${issuer.issuer}/authorize`);
    const q = url.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe(issuer.clientId);
    expect(q.get("redirect_uri")).toBe(`${origin}/oidc/callback`);
    expect(q.get("scope")).toBe("openid profile email");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")?.length).toBe(43);
    expect(q.get("nonce")?.length).toBeGreaterThan(20);
    // The code comes back in the URL fragment, which never reaches a request line.
    expect(q.get("response_mode")).toBe("fragment");
    expect(started.verifier.length).toBe(43);
    // The verifier is not derivable from what the provider is sent.
    expect(started.authorizationUrl).not.toContain(started.verifier);
  });

  test("a person in an operator group gets an operator session", async () => {
    const session = await sessionOf("sub-olga");
    // The login is the email, in lower case.
    expect(session.login).toBe("olga@contoso.example");
    expect(session.role).toBe("operator");
    expect(session.token.length).toBeGreaterThan(40);

    const me = await whoami(session.token);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ login: "olga@contoso.example", role: "operator" });

    // Past the gate on a read route and on a write route. Neither has a
    // handler in this test, so "past the gate" reads as 404 for the read and
    // 405 for the write. Without a session both are 401.
    const headers = { [SESSION_HEADER]: session.token, origin };
    expect((await fetch(`${origin}/ui/api/overview`, { headers })).status).toBe(404);
    expect((await fetch(`${origin}/ui/api/service/restart`, { method: "POST", headers })).status).toBe(405);
    expect((await fetch(`${origin}/ui/api/overview`)).status).toBe(401);
    expect(
      (await fetch(`${origin}/ui/api/service/restart`, { method: "POST", headers: { origin } })).status,
    ).toBe(401);
  });

  test("a person in a read-only group gets every view and no control", async () => {
    const session = await sessionOf("sub-ravi");
    expect(session.role).toBe("readonly");
    const headers = { [SESSION_HEADER]: session.token, origin };
    expect((await fetch(`${origin}/ui/api/overview`, { headers })).status).toBe(404);
    const write = await fetch(`${origin}/ui/api/service/restart`, { method: "POST", headers });
    expect(write.status).toBe(403);
    expect(((await write.json()) as { error: string }).error).toBe(READONLY_REFUSAL_COPY);
  });

  test("a person in both kinds of group is an operator", async () => {
    expect((await sessionOf("sub-both")).role).toBe("operator");
  });

  test("the ID token is checked against the provider's published key", async () => {
    await sessionOf("sub-olga");
    expect(issuer.seen.discovery).toBe(1);
    expect(issuer.seen.keys).toBe(1);
    // The provider received the one-time code and the PKCE verifier, and no secret.
    const sent = issuer.seen.token[0]?.form;
    expect(sent?.get("grant_type")).toBe("authorization_code");
    expect(sent?.get("redirect_uri")).toBe(`${origin}/oidc/callback`);
    expect(sent?.get("code_verifier")?.length).toBe(43);
    expect(sent?.has("client_secret")).toBe(false);
    // A second sign-in reuses the discovery document and the keys.
    await sessionOf("sub-ravi");
    expect(issuer.seen.discovery).toBe(1);
    expect(issuer.seen.keys).toBe(1);
  });

  test("the sign-in is recorded with the way the person came in and the provider's id for them", async () => {
    await sessionOf("sub-olga");
    const records = await readSpool(path.join(root, "spool"));
    const record = records.find((r) => r.action === "console.signin");
    expect(record?.actor).toBe("olga@contoso.example");
    expect(record?.params).toMatchObject({
      login: "olga@contoso.example",
      role: "operator",
      method: "oidc",
      subject: "sub-olga",
    });
  });

  test("a local account still signs in with its password", async () => {
    const created = await runtime.users.create("erik", "operator");
    await runtime.users.completeSetup(created.token, "correct-horse-battery");
    const res = await post("/ui/api/session", { login: "erik", password: "correct-horse-battery" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; role: string };
    expect(body.role).toBe("operator");
    expect((await whoami(body.token)).status).toBe(200);
  });
});

describe("who is refused", () => {
  beforeEach(async () => {
    await configure();
  });

  test("a person in no mapped group is refused, and told only that", async () => {
    const res = await signIn("sub-none");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: OIDC_NOT_ALLOWED_COPY });
    expect(warnings.join("\n")).toContain("refused (no_matching_group) for sub:sub-none");
    expect(runtime.sessions.size).toBe(0);
  });

  test("a token with no groups is refused: being known to the provider is not enough", async () => {
    const res = await signIn("sub-nogroups");
    expect(res.status).toBe(403);
    expect(warnings.join("\n")).toContain("refused (groups_missing)");
    expect(runtime.sessions.size).toBe(0);
  });

  test("a token whose groups were left out by the provider is refused, and the operator is told why", async () => {
    const res = await signIn("sub-overage");
    expect(res.status).toBe(403);
    expect(warnings.join("\n")).toContain("refused (groups_overage)");
    expect(warnings.join("\n")).toContain("set groupsClaim to roles");
  });

  test("each refusal is recorded with its reason", async () => {
    await signIn("sub-none");
    await signIn("sub-none");
    await audit.flushFailures(true);
    const failures = (await readSpool(path.join(root, "spool"))).filter((r) =>
      r.action.startsWith("console.signin.failed.oidc."),
    );
    expect(failures.map((r) => r.action)).toEqual(["console.signin.failed.oidc.no_matching_group"]);
    expect(failures[0]?.params).toMatchObject({ login: "sub:sub-none", attempts: 2 });
  });
});

describe("a token that must not be accepted", () => {
  beforeEach(async () => {
    await useIssuer({ clientSecret: "the-client-secret-of-the-test-provider" });
    secretEnv.FORTRESS_SECRET_OIDC_CLIENT_SECRET = "the-client-secret-of-the-test-provider";
    await configure({ clientSecretName: "oidc-client-secret" });
  });

  const now = (): number => Math.floor(Date.now() / 1000);
  const without = (claims: Record<string, unknown>, name: string): Record<string, unknown> =>
    Object.fromEntries(Object.entries(claims).filter(([key]) => key !== name));

  const cases: Array<[string, () => void, string]> = [
    ["for another client", () => (issuer.tweak.claims = (c) => ({ ...c, aud: "another-client" })), "aud"],
    ["from another issuer", () => (issuer.tweak.claims = (c) => ({ ...c, iss: "https://attacker.example.com" })), "iss"],
    ["that has expired", () => (issuer.tweak.claims = (c) => ({ ...c, iat: now() - 900, exp: now() - 600 })), "expired"],
    ["issued long ago", () => (issuer.tweak.claims = (c) => ({ ...c, iat: now() - 3600, exp: now() + 300 })), "expired"],
    ["for another sign-in", () => (issuer.tweak.claims = (c) => ({ ...c, nonce: "the-nonce-of-another-flow" })), "does not belong to this sign-in"],
    ["with no nonce", () => (issuer.tweak.claims = (c) => without(c, "nonce")), "does not belong to this sign-in"],
    ["with no subject", () => (issuer.tweak.claims = (c) => without(c, "sub")), "sub"],
    [
      "issued to another party among several audiences",
      () => (issuer.tweak.claims = (c) => ({ ...c, aud: [issuer.clientId, "another-client"], azp: "another-client" })),
      "issued to another client",
    ],
    ["signed with another key", () => (issuer.tweak.signing = "another-key"), "signature does not verify"],
    ["that is not signed", () => (issuer.tweak.signing = "none"), "algorithm this console does not accept"],
    [
      "signed with the client secret instead of the provider's key",
      () => (issuer.tweak.signing = "hs256-with-client-secret"),
      "algorithm this console does not accept",
    ],
  ];

  for (const [name, breakIt, reason] of cases) {
    test(`a token ${name} is refused`, async () => {
      breakIt();
      const res = await signIn("sub-olga");
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: OIDC_FAILED_COPY });
      expect(warnings.join("\n")).toContain("refused (token_invalid)");
      expect(warnings.join("\n")).toContain(reason);
      expect(runtime.sessions.size).toBe(0);
    });
  }

  test("the same provider, unbroken, is accepted", async () => {
    expect((await sessionOf("sub-olga")).role).toBe("operator");
  });
});

describe("a flow that must not be finished", () => {
  beforeEach(async () => {
    await configure();
  });

  /** Finish a flow with these three values and return the refusal. */
  async function refused(body: { code: string; state: string; verifier: string }, reason: string): Promise<void> {
    const before = issuer.seen.token.length;
    const res = await post(OIDC_PATHS.session, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: OIDC_FAILED_COPY });
    expect(warnings.join("\n")).toContain(`refused (${reason})`);
    // Refused before the provider was asked anything.
    expect(issuer.seen.token.length).toBe(before);
    expect(runtime.sessions.size).toBe(0);
  }

  test("a state that was changed", async () => {
    const started = await startFlow();
    const { code, state } = issuer.authorize(started.authorizationUrl, "sub-olga");
    const flipped = `${state.slice(0, 10)}${state[10] === "A" ? "B" : "A"}${state.slice(11)}`;
    await refused({ code, state: flipped, verifier: started.verifier }, "state_invalid");
  });

  test("a state this console did not sign", async () => {
    const started = await startFlow();
    const { code } = issuer.authorize(started.authorizationUrl, "sub-olga");
    const foreign = new OidcFlows().start({ redirectUri: `${origin}/oidc/callback`, epoch: 1, now: Date.now() });
    await refused({ code, state: foreign.state, verifier: foreign.verifier }, "state_invalid");
  });

  test("a verifier that is not the one this tab was given", async () => {
    const started = await startFlow();
    const other = await startFlow();
    const { code, state } = issuer.authorize(started.authorizationUrl, "sub-olga");
    await refused({ code, state, verifier: other.verifier }, "verifier_mismatch");
  });

  test("a flow that took longer than ten minutes", async () => {
    const started = await startFlow();
    const { code, state } = issuer.authorize(started.authorizationUrl, "sub-olga");
    clock.offset = 11 * 60_000;
    await refused({ code, state, verifier: started.verifier }, "state_expired");
  });

  test("a flow that was started before the settings changed", async () => {
    const started = await startFlow();
    const { code, state } = issuer.authorize(started.authorizationUrl, "sub-olga");
    await configure({ operatorGroups: ["a-different-group"] });
    await refused({ code, state, verifier: started.verifier }, "state_expired");
  });

  test("a flow that already produced a session", async () => {
    const started = await startFlow();
    const { code, state } = issuer.authorize(started.authorizationUrl, "sub-olga");
    const body = { code, state, verifier: started.verifier };
    expect((await post(OIDC_PATHS.session, body)).status).toBe(200);
    const before = issuer.seen.token.length;
    const again = await post(OIDC_PATHS.session, body);
    expect(again.status).toBe(400);
    expect(warnings.join("\n")).toContain("refused (state_used)");
    expect(issuer.seen.token.length).toBe(before);
    expect(runtime.sessions.size).toBe(1);
  });

  test("a flow whose sign-in failed at the provider is used up too", async () => {
    const started = await startFlow();
    const { code, state } = issuer.authorize(started.authorizationUrl, "sub-olga");
    const body = { code, state, verifier: started.verifier };
    issuer.tweak.tokenError = { status: 503, body: { error: "temporarily_unavailable" } };
    expect((await post(OIDC_PATHS.session, body)).status).toBe(400);
    expect(warnings.join("\n")).toContain("refused (provider_refused)");
    issuer.tweak.tokenError = null;
    const before = issuer.seen.token.length;
    expect((await post(OIDC_PATHS.session, body)).status).toBe(400);
    expect(warnings.join("\n")).toContain("refused (state_used)");
    expect(issuer.seen.token.length).toBe(before);
    expect(runtime.sessions.size).toBe(0);
  });

  test("two requests that carry the same flow at once produce one session", async () => {
    const started = await startFlow();
    const { code, state } = issuer.authorize(started.authorizationUrl, "sub-olga");
    const body = { code, state, verifier: started.verifier };
    const answers = await Promise.all([post(OIDC_PATHS.session, body), post(OIDC_PATHS.session, body)]);
    expect(answers.map((res) => res.status).sort()).toEqual([200, 400]);
    // The provider was asked to redeem the code once.
    expect(issuer.seen.token.length).toBe(1);
    expect(runtime.sessions.size).toBe(1);
  });

  test("a wrong verifier does not use the flow up for the tab that holds the right one", async () => {
    const started = await startFlow();
    const { code, state } = issuer.authorize(started.authorizationUrl, "sub-olga");
    expect((await post(OIDC_PATHS.session, { code, state, verifier: "x".repeat(43) })).status).toBe(400);
    expect((await post(OIDC_PATHS.session, { code, state, verifier: started.verifier })).status).toBe(200);
  });

  test("a flow that was started on another address of this console", async () => {
    const started = await startFlow();
    const { code, state } = issuer.authorize(started.authorizationUrl, "sub-olga");
    const res = await handleOidcRoute(
      new Request(`https://console.example.com${OIDC_PATHS.session}`, {
        method: "POST",
        body: JSON.stringify({ code, state, verifier: started.verifier }),
      }),
      {
        oidc: runtime.oidcRouteDeps(),
        origin: "https://console.example.com",
        remoteKey: "203.0.113.7",
        remoteAddr: "203.0.113.7",
        onWarn: (message) => warnings.push(message),
      },
    );
    expect(res?.status).toBe(400);
    expect(warnings.join("\n")).toContain("started on another address");
  });

  test("a request with a field missing", async () => {
    const started = await startFlow();
    const { code, state } = issuer.authorize(started.authorizationUrl, "sub-olga");
    for (const body of [
      { state, verifier: started.verifier },
      { code, verifier: started.verifier },
      { code, state },
      {},
    ]) {
      expect((await post(OIDC_PATHS.session, body)).status).toBe(400);
    }
    expect(runtime.sessions.size).toBe(0);
  });
});

describe("a provider that cannot be used", () => {
  test("a refusal from the token endpoint is reported by its code, never by its sentence", async () => {
    await configure();
    const marker = "the-description-the-provider-sent";
    issuer.tweak.tokenError = { status: 400, body: { error: "invalid_grant", error_description: marker } };
    const res = await signIn("sub-olga");
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(marker);
    expect(warnings.join("\n")).toContain("refused (provider_refused)");
    expect(warnings.join("\n")).toContain("400 invalid_grant");
    expect(warnings.join("\n")).not.toContain(marker);
  });

  test("a discovery document that names another issuer", async () => {
    await configure();
    issuer.tweak.discovery = (doc) => ({ ...doc, issuer: "https://another-issuer.example.com" });
    const res = await post(OIDC_PATHS.start, {});
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: OIDC_UNAVAILABLE_COPY });
    expect(warnings.join("\n")).toContain("names a different issuer");
  });

  test("a discovery document that points at a cleartext endpoint on another host", async () => {
    await configure();
    issuer.tweak.discovery = (doc) => ({ ...doc, token_endpoint: "http://collector.example.com/token" });
    expect((await post(OIDC_PATHS.start, {})).status).toBe(503);
    expect(warnings.join("\n")).toContain("lacks an https authorization, token or key endpoint");
  });

  test("a provider that signs with no algorithm this console accepts", async () => {
    await configure();
    issuer.tweak.discovery = (doc) => ({ ...doc, id_token_signing_alg_values_supported: ["HS256", "none"] });
    expect((await post(OIDC_PATHS.start, {})).status).toBe(503);
  });

  test("a provider that is not answering", async () => {
    await configure();
    await issuer.stop();
    const res = await post(OIDC_PATHS.start, {});
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: OIDC_UNAVAILABLE_COPY });
  });

  test("a provider that is failing is asked again only after a few seconds", async () => {
    await configure();
    issuer.tweak.discovery = (doc) => ({ ...doc, issuer: "https://somebody-else.example.com" });
    const answers = await Promise.all(Array.from({ length: 8 }, () => post(OIDC_PATHS.start, {})));
    expect(answers.every((res) => res.status === 503)).toBe(true);
    expect((await post(OIDC_PATHS.start, {})).status).toBe(503);
    // Nine people asked. The provider was asked once.
    expect(issuer.seen.discovery).toBe(1);

    // Once the provider is right again, the console finds out by itself.
    issuer.tweak.discovery = (doc) => doc;
    clock.offset += METADATA_FAILURE_TTL_MS + 1;
    expect((await post(OIDC_PATHS.start, {})).status).toBe(200);
    expect(issuer.seen.discovery).toBe(2);
  });

  test("a flood of refused sign-ins writes a bounded number of log lines", async () => {
    await configure();
    for (let i = 0; i < WARN_LINES_PER_WINDOW + 15; i += 1) {
      await post(OIDC_PATHS.session, { code: "c", state: "not.signed", verifier: "v" });
    }
    // Lines about anything else, such as the console's own settings file, are
    // not what is counted here.
    const aboutSignIn = (): string[] => warnings.filter((line) => line.includes("identity provider"));
    expect(aboutSignIn().length).toBe(WARN_LINES_PER_WINDOW);
    // The next minute says how many were left out, then logs again.
    clock.offset += 60_001;
    await post(OIDC_PATHS.session, { code: "c", state: "not.signed", verifier: "v" });
    expect(aboutSignIn().at(-2)).toBe("15 more refused sign-ins through the identity provider were not logged");
    expect(aboutSignIn().at(-1)).toContain("refused (state_invalid)");
  });
});

describe("a confidential client", () => {
  const SECRET = "the-client-secret-of-the-test-provider";

  test("its secret is read by name and sent to the token endpoint only", async () => {
    await useIssuer({ clientSecret: SECRET });
    secretEnv.FORTRESS_SECRET_OIDC_CLIENT_SECRET = SECRET;
    await configure({ clientSecretName: "oidc-client-secret" });

    const started = await startFlow();
    expect(started.authorizationUrl).not.toContain(SECRET);
    const res = await signIn("sub-olga");
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(SECRET);
    expect(issuer.seen.token.at(-1)?.form.get("client_secret")).toBe(SECRET);
    // The settings file holds the name.
    expect(await readFile(path.join(root, "oidc.json"), "utf8")).not.toContain(SECRET);
  });

  test("a provider that wants HTTP Basic gets it", async () => {
    await useIssuer({ clientSecret: SECRET, tokenAuthMethods: ["client_secret_basic"] });
    secretEnv.FORTRESS_SECRET_OIDC_CLIENT_SECRET = SECRET;
    await configure({ clientSecretName: "oidc-client-secret" });
    expect((await signIn("sub-olga")).status).toBe(200);
    const sent = issuer.seen.token.at(-1);
    expect(sent?.authorization?.startsWith("Basic ")).toBe(true);
    expect(sent?.form.has("client_secret")).toBe(false);
  });

  test("a secret that cannot be read stops the sign-in, and the reason names the secret", async () => {
    await useIssuer({ clientSecret: SECRET });
    await configure({ clientSecretName: "oidc-client-secret" });
    const res = await signIn("sub-olga");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: OIDC_UNAVAILABLE_COPY });
    expect(warnings.join("\n")).toContain("refused (client_secret_unavailable)");
    expect(warnings.join("\n")).toContain("oidc-client-secret");
    expect(issuer.seen.token).toHaveLength(0);
  });

  test("a wrong secret is the provider's refusal, and the secret is in no message", async () => {
    await useIssuer({ clientSecret: SECRET });
    secretEnv.FORTRESS_SECRET_OIDC_CLIENT_SECRET = "a-wrong-secret-value";
    await configure({ clientSecretName: "oidc-client-secret" });
    const res = await signIn("sub-olga");
    expect(res.status).toBe(400);
    expect(warnings.join("\n")).toContain("401 invalid_client");
    expect(`${warnings.join("\n")} ${await res.text()}`).not.toContain("a-wrong-secret-value");
  });
});

describe("how a session issued through the provider ends", () => {
  beforeEach(async () => {
    await configure();
  });

  test("changing any setting ends it, and a local account's session is untouched", async () => {
    const created = await runtime.users.create("erik", "operator");
    await runtime.users.completeSetup(created.token, "correct-horse-battery");
    const local = (await (
      await post("/ui/api/session", { login: "erik", password: "correct-horse-battery" })
    ).json()) as { token: string };
    const olga = await sessionOf("sub-olga");
    expect((await whoami(olga.token)).status).toBe(200);

    // What `hx-fortress ui oidc revoke` does.
    await store.update((current) => current);
    expect((await whoami(olga.token)).status).toBe(401);
    expect((await whoami(local.token)).status).toBe(200);

    // She signs in again, under the settings as they are now.
    expect((await whoami((await sessionOf("sub-olga")).token)).status).toBe(200);
  });

  test("turning the sign-in off ends it", async () => {
    const olga = await sessionOf("sub-olga");
    await store.update((current) => ({ ...current, enabled: false }));
    expect((await whoami(olga.token)).status).toBe(401);
    expect((await fetch(`${origin}${OIDC_PATHS.status}`)).status).toBe(401);
  });

  test("`ui disable` ends it with every other session", async () => {
    const olga = await sessionOf("sub-olga");
    await runtime.users.bumpSessionEpoch();
    expect((await whoami(olga.token)).status).toBe(401);
  });

  test("it has the same lifetime as any session, and signing out ends it", async () => {
    const olga = await sessionOf("sub-olga");
    const out = await fetch(`${origin}/ui/api/session`, {
      method: "DELETE",
      headers: { [SESSION_HEADER]: olga.token, origin },
    });
    expect(out.status).toBe(200);
    expect((await whoami(olga.token)).status).toBe(401);

    const ravi = await sessionOf("sub-ravi");
    clock.offset = (UI_CONFIG_DEFAULTS.sessionTtlHours + 1) * 3_600_000;
    expect((await whoami(ravi.token)).status).toBe(401);
  });

  test("an open live stream is closed by the same rule", async () => {
    const olga = await sessionOf("sub-olga");
    const session = runtime.sessions.list()[0];
    expect(session?.userLogin).toBe(olga.login);
    expect(await runtime.sessionStillValid(session?.id ?? "")).toBe(true);
    await store.update((current) => current);
    expect(await runtime.sessionStillValid(session?.id ?? "")).toBe(false);
  });
});

describe("what cannot change these settings", () => {
  test("no route writes them: a request that carries settings changes nothing", async () => {
    const hostile = {
      enabled: true,
      issuer: "https://attacker.example.com",
      clientId: "attacker",
      operatorGroups: ["everyone"],
    };
    for (const pathname of Object.values(OIDC_PATHS)) {
      await post(pathname, hostile);
      await fetch(`${origin}${pathname}?${new URLSearchParams({ issuer: hostile.issuer, enabled: "true" })}`);
    }
    expect(existsSync(path.join(root, "oidc.json"))).toBe(false);

    await configure();
    const before = await readFile(path.join(root, "oidc.json"), "utf8");
    for (const pathname of Object.values(OIDC_PATHS)) await post(pathname, hostile);
    expect(await readFile(path.join(root, "oidc.json"), "utf8")).toBe(before);
  });

  test("the only routes about this sign-in are the three public ones", () => {
    const routes = runtime.routes.all().filter((r) => r.path.includes("oidc"));
    expect(routes.map((r) => `${r.method} ${r.path} ${r.cls}`).sort()).toEqual([
      "GET /ui/api/oidc public",
      "POST /ui/api/oidc/session public",
      "POST /ui/api/oidc/start public",
    ]);
  });
});

describe("the terminal verbs", () => {
  const run = async (args: string[], env: Record<string, string> = {}): Promise<{ code: number; lines: string[] }> => {
    const lines: string[] = [];
    const code = await runUiVerb(["oidc", ...args], { writeLine: (l) => lines.push(l), fortressRoot: root, env });
    return { code, lines };
  };
  const stored = (): Promise<UiOidcConfig> =>
    new OidcConfigStore(path.join(fortressPaths(root).uiRoot, "oidc.json")).load();

  test("set, on, revoke and off are the whole way in", async () => {
    await expect(run(["on"])).rejects.toThrow("issuer is not set");
    await run(["set", "issuer", "https://login.example.com/tenant-id/v2.0"]);
    await expect(run(["on"])).rejects.toThrow("clientId is not set");
    await run(["set", "clientId", "11111111-2222-3333-4444-555555555555"]);
    await expect(run(["on"])).rejects.toThrow("no group is mapped to a role");
    await run(["set", "operatorGroups", "Fortress Operators, 22222222-3333-4444-5555-666666666666"]);
    expect((await stored()).enabled).toBe(false);

    const on = await run(["on"], { FORTRESS_UI_PUBLIC_URL: "https://console.example.com" });
    expect(on.lines.join("\n")).toContain("let.ai takes no part in this sign-in");
    expect(on.lines.join("\n")).toContain(
      "Redirect URI to register at the provider: https://console.example.com/oidc/callback",
    );
    const after = await stored();
    expect(after).toMatchObject({
      enabled: true,
      issuer: "https://login.example.com/tenant-id/v2.0",
      operatorGroups: ["Fortress Operators", "22222222-3333-4444-5555-666666666666"],
    });

    await run(["revoke"]);
    expect((await stored()).epoch).toBe(after.epoch + 1);
    expect((await stored()).enabled).toBe(true);

    // A setting it needs cannot be cleared while it is on.
    await expect(run(["set", "operatorGroups", ""])).rejects.toThrow("no group is mapped to a role");

    await run(["off"]);
    expect((await stored()).enabled).toBe(false);
  });

  test("printing shows every setting and the redirect URI, and writes nothing", async () => {
    const printed = (await run([])).lines.join("\n");
    expect(printed).toContain("enabled: false");
    // With no public URL the console is on this host, and `localhost` is the
    // name a provider accepts over http.
    expect(printed).toContain("Redirect URI to register at the provider: http://localhost:8788/oidc/callback");
    expect(printed).toContain("the redirect URI is the address it is opened at");
    expect(printed).toContain("not ready to turn on: issuer is not set");
    expect(existsSync(path.join(fortressPaths(root).uiRoot, "oidc.json"))).toBe(false);
  });

  test("a value that breaks its rule is refused", async () => {
    await expect(run(["set", "issuer", "http://login.example.com"])).rejects.toThrow("issuer must use https:");
    await expect(run(["set", "nothing", "x"])).rejects.toThrow("unknown setting 'nothing'");
    await expect(run(["set", "scopes"])).rejects.toThrow("usage: hx-fortress ui oidc set scopes <value>");
    await expect(run(["sideways"])).rejects.toThrow("usage: hx-fortress ui oidc");
  });

  test("the client secret is given by name, and a secret pasted there is refused and not repeated", async () => {
    const pasted = "Zx8~Q.the-secret-itself-pasted-by-mistake";
    let message = "";
    try {
      await run(["set", "clientSecretName", pasted]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("must be the NAME of a secret");
    expect(message).not.toContain(pasted);
    await run(["set", "clientSecretName", "oidc-client-secret"]);
    expect((await stored()).clientSecretName).toBe("oidc-client-secret");
    await run(["set", "clientSecretName", "none"]);
    expect((await stored()).clientSecretName).toBeNull();
  });

  test("every change is recorded, and a value that could be a pasted secret is not", () => {
    expect(cliAuditAct(["oidc"])).toBeNull();
    expect(cliAuditAct(["oidc", "on"])).toEqual({ action: "cli.ui.oidc_on", params: null });
    expect(cliAuditAct(["oidc", "revoke"])).toEqual({ action: "cli.ui.oidc_revoke", params: null });
    expect(cliAuditAct(["oidc", "set", "issuer", "https://login.example.com"])).toEqual({
      action: "cli.ui.oidc_set_issuer",
      params: { value: "https://login.example.com" },
    });
    expect(cliAuditAct(["oidc", "set", "clientSecretName", "pasted-by-mistake"])).toEqual({
      action: "cli.ui.oidc_set_clientsecretname",
      params: null,
    });
  });
});

describe("from a token's claims to a console identity", () => {
  const config: UiOidcConfig = {
    ...OIDC_CONFIG_DEFAULTS,
    enabled: true,
    issuer: "https://login.example.com",
    clientId: "client",
    operatorGroups: [OPERATORS],
    readonlyGroups: [AUDITORS],
  };

  test("the login is the email, then the preferred username, then the provider's id", () => {
    const login = (claims: Record<string, unknown>): unknown => {
      const result = identityFromClaims(config, { sub: "abc-123", groups: [OPERATORS], ...claims });
      return result.ok ? result.value.login : result.refusal;
    };
    expect(login({ email: "Olga@Contoso.example", preferred_username: "olga" })).toBe("olga@contoso.example");
    expect(login({ preferred_username: "olga@contoso.example" })).toBe("olga@contoso.example");
    expect(login({})).toBe("sub:abc-123");
    // A value that is not shaped like an address is not used as a login.
    expect(login({ email: "olga smith <script>" })).toBe("sub:abc-123");
    // A local login can hold neither "@" nor ":", so the two kinds never collide.
    expect(login({ email: "erik" })).toBe("sub:abc-123");
  });

  test("a person cannot be shown under another person's login", () => {
    const login = (claims: Record<string, unknown>): unknown => {
      const result = identityFromClaims(config, { sub: "abc-123", groups: [OPERATORS], ...claims });
      return result.ok ? result.value.login : result.refusal;
    };
    // A claim that only looks like the login of a person with no address.
    expect(login({ email: "sub:somebody-else" })).toBe("sub:abc-123");
    expect(login({ preferred_username: "sub:somebody-else" })).toBe("sub:abc-123");
    // An address never holds ":", so it cannot read as a `sub:` login either.
    expect(login({ email: "sub:x@contoso.example" })).toBe("sub:abc-123");
    // The provider's id is kept exactly: two ids that differ only in case are
    // two people.
    expect(login({ sub: "AbC-123" })).toBe("sub:AbC-123");
    expect(login({ sub: "abc-123" })).toBe("sub:abc-123");
  });

  test("a configured login claim is required once it is configured", () => {
    const custom = { ...config, loginClaim: "upn" };
    const ok = identityFromClaims(custom, { sub: "abc", upn: "olga@contoso.example", groups: [OPERATORS] });
    expect(ok.ok && ok.value.login).toBe("olga@contoso.example");
    const missing = identityFromClaims(custom, { sub: "abc", email: "olga@contoso.example", groups: [OPERATORS] });
    expect(missing.ok).toBe(false);
  });

  test("groups are matched character for character, as a list or as one name", () => {
    const role = (groups: unknown): unknown => {
      const result = identityFromClaims(config, { sub: "abc", groups } as never);
      return result.ok ? result.value.role : result.refusal;
    };
    expect(role([OPERATORS])).toBe("operator");
    expect(role(OPERATORS)).toBe("operator");
    expect(role([AUDITORS])).toBe("readonly");
    expect(role([OPERATORS.toUpperCase()])).toBe("no_matching_group");
    expect(role([` ${OPERATORS}`])).toBe("no_matching_group");
    expect(role([])).toBe("no_matching_group");
    expect(role([7, null, { name: OPERATORS }])).toBe("no_matching_group");
    expect(role(undefined)).toBe("groups_missing");
    expect(role({ [OPERATORS]: true })).toBe("groups_missing");
  });

  test("another claim can carry the groups, such as Entra application roles", () => {
    const roles = { ...config, groupsClaim: "roles" };
    const result = identityFromClaims(roles, { sub: "abc", roles: [OPERATORS], groups: ["ignored"] });
    expect(result.ok && result.value.role).toBe("operator");
  });

  test("a subject that is missing or not printable is refused", () => {
    expect(identityFromClaims(config, { groups: [OPERATORS] }).ok).toBe(false);
    expect(identityFromClaims(config, { sub: "has a space", groups: [OPERATORS] }).ok).toBe(false);
    expect(identityFromClaims(config, { sub: "line\nbreak", groups: [OPERATORS] }).ok).toBe(false);
    expect(identityFromClaims(config, { sub: "x".repeat(255), groups: [OPERATORS] }).ok).toBe(true);
    expect(identityFromClaims(config, { sub: "x".repeat(256), groups: [OPERATORS] }).ok).toBe(false);
  });
});

describe("the settings file", () => {
  test("the issuer must be https, or http on this host itself", () => {
    expect(checkOidcIssuer("https://login.microsoftonline.com/tenant-id/v2.0").ok).toBe(true);
    expect(checkOidcIssuer("http://127.0.0.1:9000").ok).toBe(true);
    for (const issuer of [
      "http://login.example.com",
      "https://user:pw@login.example.com",
      "https://login.example.com/?tenant=x",
      "login.example.com",
      "",
    ]) {
      expect(checkOidcIssuer(issuer).ok).toBe(false);
    }
  });

  test("it is switched on only when nothing it needs is missing", () => {
    expect(oidcMissing(OIDC_CONFIG_DEFAULTS)).toBe("issuer is not set");
    expect(
      oidcMissing({ ...OIDC_CONFIG_DEFAULTS, issuer: "https://login.example.com", clientId: "c", readonlyGroups: ["g"] }),
    ).toBeNull();
  });

  test("a file with a value that breaks its rule is corrupt as a whole, never half used", () => {
    const good = { enabled: true, issuer: "https://login.example.com", clientId: "c", operatorGroups: ["g"] };
    expect(parseOidcConfig(good)?.enabled).toBe(true);
    expect(parseOidcConfig({ ...good, issuer: "http://login.example.com" })).toBeNull();
    expect(parseOidcConfig({ ...good, clientSecretName: "Not A Name" })).toBeNull();
    expect(parseOidcConfig([])).toBeNull();
    // `enabled` must be exactly true.
    expect(parseOidcConfig({ ...good, enabled: "true" })?.enabled).toBe(false);
  });

  test("every write raises the epoch, and the reader follows the file", async () => {
    const file = path.join(root, "another-oidc.json");
    const writer = new OidcConfigStore(file);
    const reader = new LiveOidcConfig(file);
    expect((await reader.read()).enabled).toBe(false);
    const first = await writer.update((c) => ({ ...c, label: "one" }));
    const second = await writer.update((c) => ({ ...c, label: "two" }));
    expect(second.epoch).toBe(first.epoch + 1);
    expect((await reader.read()).label).toBe("two");
  });

  test("the data paths page lists the provider", async () => {
    const rows = dataPathRows({
      ui: { ...UI_CONFIG_DEFAULTS },
      boundPort: 8788,
      postgres: { mode: "unknown" },
      cloudUrl: null,
      downloadBase: null,
      postgresBinariesUrl: null,
      bucket: null,
      embeddingEndpoint: null,
      ssoAdvertised: false,
      rosterRetentionDays: 90,
      oidc: { enabled: true, issuer: "https://login.example.com" },
    });
    const row = rows.find((r) => r.id === "identity-provider");
    expect(row?.peer).toBe("https://login.example.com");
    expect(row?.notes?.join(" ")).toContain("let.ai is not on this path");
  });
});
