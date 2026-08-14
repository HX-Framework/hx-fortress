// The adversarial pass: one suite that attacks the ASSEMBLED surface rather than
// any component of it.
//
// Nothing here restates a unit test. The component arms are proven where they
// live — the Host and Origin predicates and the rightmost XFF walk in
// ui-allowlist, the traversal shapes in ui-serving, the buckets, the argon gate
// and the lockout table in ui-users-auth, the grant-rejection taxonomy in
// sso-entry, the stream caps in console-events, the corroboration state machine
// in console-corroboration and console-audit-trail, the privilege matrix and the
// one-way machine in the console-plane e2e. What is proven HERE is what only the
// assembled surface can answer:
//
//   • the security headers on EVERY class of response this console emits, not
//     just on the shell and its assets — an unauthenticated 401, a role refusal,
//     a rate refusal, a JSON read, a download, a live event stream;
//   • that the two authentication realms do not cross IN EITHER DIRECTION: a
//     cloud-signed gateway bearer reaches no console route, and a console
//     session reaches no gateway route;
//   • that a cloud-minted grant produces a sign-in form and NOTHING else (D9),
//     over the wire, for the acceptance as well as for every refusal;
//   • that nothing a caller types reaches a response header, tears an audit
//     record in two, or forges an event frame;
//   • that the browser surface is strictly narrower than the terminal's — a
//     closed set of enumerated mutations, and no way to write configuration.
//
// Every request runs against a real listening server with the real runtime, the
// real gate, the real asset map and a real 0600 spool.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { exportJWK, importPKCS8, SignJWT } from "jose";

import { MAX_ACTOR_CHARS } from "../src/console/audit-actions";
import { AuditSpool, readSpool } from "../src/console/audit-spool";
import { replaceRoster } from "../src/console/roster";
import { startGatewayServer, type GatewayHandle } from "../src/gateway/server";
import { CONSOLE_COMMAND_KINDS } from "../src/host/postgres/console-plane";
import { inlineScriptHashesOf, manifestOf, mapDistDir, type UiAssets } from "../src/ui/assets";
import { ConsoleAudit } from "../src/ui/audit-writer";
import { UI_CONFIG_SET_KEYS, UiConfigStore } from "../src/ui/config";
import { EventStreamRegistry } from "../src/ui/events";
import { CLI_HELP } from "../src/ui/help";
import {
  MUTATE_PATHS,
  MUTATE_ROUTES,
  OFFERED_COMMAND_KINDS,
  type ConsoleWritePort,
  type ServiceAction,
} from "../src/ui/mutate-routes";
import { BUCKETS } from "../src/ui/rate-limit";
import {
  READ_AUDITED_PATHS,
  READ_PATHS,
  READ_ROUTES,
  type ConsoleReadPort,
} from "../src/ui/read-routes";
import { INSTANCE_PROBE_PATH, cspFor, startUiServer } from "../src/ui/server";
import { SESSION_HEADER } from "../src/ui/sessions";
import { CONSOLE_GRANT_PURPOSE } from "../src/ui/sso-grant";
import { UiRuntime } from "../src/ui/runtime";
import type { SQL } from "drizzle-orm";
import type { CommandParams } from "../src/console/command-params";
import type { ConsoleCommandKind } from "../src/host/postgres/console-plane";
import type { HxDb } from "../src/host/postgres/db";
import type { RosterSyncPayload } from "../src/protocol";
import type { ReportPayload } from "../src/ui/report";
import type { SessionStore } from "../src/modules/session-vault/store/types";

const ORG = "org-adversarial";
const PUBLIC_HOST = "console.example";
const PUBLIC_URL = `https://${PUBLIC_HOST}`;
const PASSPHRASE = "seventeen-quiet-copper-lanterns";

/** An inline script in the shell, so the CSP under test carries a real hash
 *  rather than the degenerate empty one. */
const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>HX Fortress</title></head>
<body><div id="root"></div>
<script>window.__boot = 1;</script>
<script type="module" src="/assets/app-abc123.js"></script></body></html>`;

// ── the wire ────────────────────────────────────────────────────────────────

interface RawResponse {
  status: number;
  headers: Headers;
  body: string;
}

function parseResponse(bytes: Buffer, separator: number): RawResponse {
  const lines = bytes.subarray(0, separator).toString().split("\r\n");
  const headers = new Headers();
  for (const line of lines.slice(1)) {
    const at = line.indexOf(":");
    if (at > 0) headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return {
    status: Number((lines[0] ?? "").split(" ")[1]),
    headers,
    body: bytes.subarray(separator + 4).toString(),
  };
}

/**
 * A request written verbatim onto the socket. `fetch` refuses to forge a Host
 * header and normalizes a request target, and both are the subject here.
 *
 * The message is complete when Content-Length BYTES have arrived, not when the
 * peer hangs up: the console keeps a connection alive after some refusals, and a
 * reader that waited for the close would wait for the test timeout. Byte
 * lengths, not string lengths — a refusal quotes the Host in a sentence with an
 * em dash in it.
 */
function raw(port: number, request: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    const chunks: Buffer[] = [];
    const settle = (bytes: Buffer, separator: number): void => {
      socket.destroy();
      resolve(parseResponse(bytes, separator));
    };
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const separator = bytes.indexOf("\r\n\r\n");
      if (separator < 0) return;
      const declared = /content-length:\s*(\d+)/i.exec(bytes.subarray(0, separator).toString());
      if (declared && bytes.length - (separator + 4) < Number(declared[1])) return;
      settle(bytes, separator);
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const bytes = Buffer.concat(chunks);
      const separator = bytes.indexOf("\r\n\r\n");
      if (separator >= 0) resolve(parseResponse(bytes, separator));
    });
  });
}

function request(target: string, host: string, extra: readonly string[] = []): string {
  return [`GET ${target} HTTP/1.1`, `Host: ${host}`, ...extra, "Connection: close", "", ""].join("\r\n");
}

// ── the harness ─────────────────────────────────────────────────────────────

interface Submitted {
  kind: ConsoleCommandKind;
  params: CommandParams;
  requestedBy: string;
}

interface Harness {
  root: string;
  runtime: UiRuntime;
  config: UiConfigStore;
  spoolDir: string;
  audit: ConsoleAudit;
  origin: string;
  port: number;
  csp: string;
  streams: EventStreamRegistry;
  submitted: Submitted[];
  services: ServiceAction[];
  stop(): Promise<void>;
}

interface HarnessOptions {
  /** The pinned org key the SSO door verifies against. Absent ⇒ no key, which
   *  is a pre-verification state rather than a rejection of its own. */
  ssoKey?: string;
  sso?: boolean;
  trustedProxies?: string[];
  /** The line the log producer emits on every open — the event-frame injection
   *  probe writes its payload here. */
  logLine?: string;
}

/** Everything reportLines() reads, and nothing else: the PDF is a RESPONSE CLASS
 *  here, not a rendering under test. */
const REPORT = {
  generatedAt: "2026-07-31T00:00:00.000Z",
  version: "adversarial",
  identity: {
    fortressId: null,
    boundOrgId: null,
    credentialWrittenAt: "never",
    root: "/nonexistent",
    postgresMode: "embedded",
    retention: { logs: "14 days", auditTrail: "the life of the database" },
    paths: { root: "/nonexistent" },
    roles: [],
  },
  totals: { sessions: 0, people: 0, bytes: 0, tunnel: 0, gateway: 0, unknownProvenance: 0 },
  foreign: { label: "no other organization has sent sessions here" },
  storage: { provider: null, bucket: null, region: null, versioning: "unavailable", lifecycle: "unavailable" },
  posture: {
    state: "never-fetched",
    asOf: null,
    cloudOnlySessions: null,
    routedHere: null,
    qualification: "no posture has been fetched",
  },
  dataPaths: [],
} as unknown as ReportPayload;

function readPortFor(streams: EventStreamRegistry, logLine: string): ConsoleReadPort {
  return {
    status: async () => ({
      daemon: "stopped",
      copy: "the fortress daemon is not running",
      version: "adversarial",
      serviceManager: "systemd",
      pid: null,
      writtenAt: null,
      rootMatch: "unknown",
      database: { kind: "not-configured" },
    }),
    commands: async () => ({ rows: [], records: [], externalPostgres: false }),
    audit: async () => ({ rows: [] }),
    auditExport: async () => ({ rows: [{ action: "console.sign-in" }], truncated: false }),
    spoolTail: async () => [],
    logsExport: async () => `{"ts":"2026-07-31T00:00:00.000Z","msg":"line"}\n`,
    report: async () => REPORT,
    openEvents: (args: { sessionId: string; userLogin: string; lastEventId: string | null }) =>
      streams.open({
        sessionId: args.sessionId,
        userLogin: args.userLogin,
        lastEventId: args.lastEventId,
        producer: {
          start(sink) {
            sink({ event: "log", data: { line: logLine } });
          },
        },
      }),
  } as unknown as ConsoleReadPort;
}

function writePortFor(submitted: Submitted[], services: ServiceAction[]): ConsoleWritePort {
  return {
    serviceRefusal: () => null,
    service: async (action: ServiceAction) => {
      services.push(action);
      return { action, manager: "systemd", pid: 4242, copy: `Fortress ${action}ed.` };
    },
    heartbeatAt: async () => new Date().toISOString(),
    submit: async (kind: ConsoleCommandKind, params: CommandParams, requestedBy: string) => {
      submitted.push({ kind, params, requestedBy });
      return { id: `cmd-${submitted.length}` };
    },
    mintCredential: async () => "0".repeat(32),
    offered: () => OFFERED_COMMAND_KINDS,
  };
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hx-adversarial-"));
  const dist = path.join(root, "dist");
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await writeFile(path.join(dist, "index.html"), INDEX_HTML);
  await writeFile(path.join(dist, "assets", "app-abc123.js"), "export const a = 1;\n");
  const files = mapDistDir(dist);
  const assets: UiAssets = {
    mode: "disk",
    files,
    inlineScriptHashes: inlineScriptHashesOf(INDEX_HTML),
    manifest: await manifestOf(files),
  };

  const uiConfigFile = path.join(root, "ui.json");
  const config = new UiConfigStore(uiConfigFile);
  await config.update((current) => ({
    ...current,
    enabled: true,
    publicUrl: PUBLIC_URL,
    sso: options.sso ?? true,
    trustedProxies: options.trustedProxies ?? [],
  }));

  const runtime = new UiRuntime({
    uiRoot: root,
    uiConfigFile,
    cmdCredsDir: path.join(root, "cmd-creds"),
    env: {},
    sso: {
      pinnedKey: async () => options.ssoKey ?? null,
      orgId: async () => ORG,
    },
  });

  const spoolDir = path.join(root, "spool");
  const audit = new ConsoleAudit(new AuditSpool({ dir: spoolDir, writer: "ui" }));
  const submitted: Submitted[] = [];
  const services: ServiceAction[] = [];
  const read = readPortFor(runtime.streams, options.logLine ?? "an ordinary line");
  const server = startUiServer(
    {
      assets,
      port: 0,
      runtime,
      read: { port: read, audit },
      write: { write: writePortFor(submitted, services) },
      audit,
    },
    "127.0.0.1",
  );

  return {
    root,
    runtime,
    config,
    spoolDir,
    audit,
    streams: runtime.streams,
    submitted,
    services,
    origin: `http://127.0.0.1:${server.port}`,
    port: server.port as number,
    csp: cspFor(assets.inlineScriptHashes),
    stop: async () => {
      runtime.streams.closeAll("shutdown");
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A session token, minted directly. The sign-in path, its buckets, its lockout
 *  and its uniform failures are proven in ui-users-auth and ui-auth-http; here a
 *  token is the means, never the subject. */
async function tokenFor(h: Harness, login: string, role: "operator" | "readonly"): Promise<string> {
  const created = await h.runtime.users.create(login, role);
  await h.runtime.users.completeSetup(created.token, PASSPHRASE);
  const file = await h.runtime.readUsers();
  const user = file.users.find((u) => u.login === login);
  if (!user) throw new Error(`no such user: ${login}`);
  return h.runtime.sessions.issue({ user, file, remoteAddr: "127.0.0.1" }).token;
}

// ── the ed25519 signers ─────────────────────────────────────────────────────

interface Signer {
  publicKey: string;
  /** `window` places the token in time: absent is "issued now, live for two
   *  minutes", which is what every claims-shape case wants. */
  mint(claims: Record<string, unknown>, window?: { iat?: number; exp?: number | string }): Promise<string>;
}

let mintCounter = 0;

async function signer(): Promise<Signer> {
  const pair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const key = await importPKCS8(pair.privateKey, "EdDSA");
  const jwk = await exportJWK(createPublicKey(pair.publicKey));
  return {
    publicKey: jwk.x as string,
    mint: (claims, window = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "EdDSA" })
        // Counted, not random: a replay arm is about which jti was already
        // spent, and a suite that cannot say which token it minted cannot fail
        // the same way twice.
        .setJti(typeof claims.jti === "string" ? claims.jti : `jti-${(mintCounter += 1).toString(36)}`)
        .setIssuedAt(window.iat)
        .setExpirationTime(window.exp ?? "2m")
        .sign(key),
  };
}

// ── header assertions ───────────────────────────────────────────────────────

/** The four every DOCUMENT-class response carries. The label rides into the
 *  assertion so a failure names the class rather than the header. */
function expectDocumentHeaders(label: string, headers: Headers, csp: string): void {
  expect([label, headers.get("content-security-policy")]).toEqual([label, csp]);
  expect([label, headers.get("x-content-type-options")]).toEqual([label, "nosniff"]);
  expect([label, headers.get("referrer-policy")]).toEqual([label, "no-referrer"]);
  expect([label, headers.get("cache-control") !== null]).toEqual([label, true]);
}

// ── 1 · the security headers, on every class ────────────────────────────────

describe("the security headers, on every class of response", () => {
  let h: Harness;
  let operator: string;
  let readonly: string;

  beforeAll(async () => {
    h = await harness();
    operator = await tokenFor(h, "ada", "operator");
    readonly = await tokenFor(h, "grace", "readonly");
  });

  afterAll(() => h.stop());

  test("the CSP carries a real hash and grants no inline script and no third party", () => {
    const scriptSrc = h.csp.split("script-src ")[1]?.split(";")[0] ?? "";
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toMatch(/'sha256-[A-Za-z0-9+/=]+'/);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(h.csp).toContain("frame-ancestors 'none'");
    expect(h.csp).toContain("base-uri 'none'");
    expect(h.csp).toContain("form-action 'none'");
    expect(h.csp).not.toMatch(/https?:\/\//);
  });

  test("every class a browser can reach carries all four", async () => {
    const json = { "content-type": "application/json", origin: h.origin };
    const auth = { [SESSION_HEADER]: operator };
    const classes: Array<[string, number, Response]> = [
      ["the app shell", 200, await fetch(`${h.origin}/`)],
      ["a hashed asset", 200, await fetch(`${h.origin}/assets/app-abc123.js`)],
      ["a missing asset", 404, await fetch(`${h.origin}/assets/gone.js`)],
      ["a cold deep link", 200, await fetch(`${h.origin}/sessions/by/team`)],
      ["an unauthenticated method", 401, await fetch(`${h.origin}/`, { method: "PUT" })],
      [
        "a method refusal",
        405,
        await fetch(`${h.origin}/`, {
          method: "PUT",
          headers: { [SESSION_HEADER]: operator, origin: h.origin },
        }),
      ],
      ["the health probe", 200, await fetch(`${h.origin}/healthz`)],
      ["the identity handshake", 200, await fetch(`${h.origin}${INSTANCE_PROBE_PATH}`)],
      ["an unauthenticated read", 401, await fetch(`${h.origin}${READ_PATHS.status}`)],
      ["an unauthenticated unknown path", 401, await fetch(`${h.origin}/ui/api/nothing-here`)],
      [
        "a readonly session on a mutate route",
        403,
        await fetch(`${h.origin}${MUTATE_PATHS.service}`, {
          method: "POST",
          headers: { ...json, [SESSION_HEADER]: readonly },
          body: JSON.stringify({ action: "restart" }),
        }),
      ],
      [
        "a cross-site write",
        403,
        await fetch(`${h.origin}${MUTATE_PATHS.commands}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://evil.example", ...auth },
          body: JSON.stringify({ kind: "self_test", params: {} }),
        }),
      ],
      ["a signed-in read", 200, await fetch(`${h.origin}${READ_PATHS.status}`, { headers: auth })],
      [
        "a refused read parameter",
        400,
        await fetch(`${h.origin}${READ_PATHS.audit}?from=yesterday`, { headers: auth }),
      ],
      [
        "an audited export",
        200,
        await fetch(`${h.origin}${READ_AUDITED_PATHS.auditExport}`, { headers: auth }),
      ],
      [
        "an audited log export",
        200,
        await fetch(`${h.origin}${READ_AUDITED_PATHS.logsExport}`, { headers: auth }),
      ],
      ["a report PDF", 200, await fetch(`${h.origin}${READ_AUDITED_PATHS.reportPdf}`, { headers: auth })],
      [
        "a submitted command",
        202,
        await fetch(`${h.origin}${MUTATE_PATHS.commands}`, {
          method: "POST",
          headers: { ...json, ...auth },
          body: JSON.stringify({ kind: "self_test", params: {} }),
        }),
      ],
      [
        "a refused grant",
        400,
        await fetch(`${h.origin}/ui/api/sso/exchange`, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ grant: "not-a-token" }),
        }),
      ],
    ];
    for (const [label, status, res] of classes) {
      expect([label, res.status]).toEqual([label, status]);
      expectDocumentHeaders(label, res.headers, h.csp);
      // Plain http, so a browser must never be pinned to a scheme this console
      // cannot serve.
      expect([label, res.headers.get("strict-transport-security")]).toEqual([label, null]);
      await res.arrayBuffer();
    }
  });

  test("a rate refusal carries them too, and states its own budget", async () => {
    let refused: Response | null = null;
    for (let i = 0; i <= BUCKETS.instanceProbe.limit; i += 1) {
      const res = await fetch(`${h.origin}${INSTANCE_PROBE_PATH}`);
      if (res.status === 429) {
        refused = res;
        break;
      }
      await res.arrayBuffer();
    }
    expect(refused).not.toBeNull();
    const res = refused as Response;
    expectDocumentHeaders("a rate refusal", res.headers, h.csp);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: "too many requests" });
  });

  test("the event stream is the ONE exception, and it is a bounded one", async () => {
    const res = await fetch(`${h.origin}${READ_PATHS.events}`, {
      headers: { [SESSION_HEADER]: operator },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    // A stream is already flowing when the finisher would run, and a CSP is a
    // directive for a DOCUMENT. Both of those are carried by the shell that
    // opened this connection; what belongs on a live body is carried here.
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    await res.text();
  });
});

// ── 2 · the Host a browser sends ────────────────────────────────────────────

describe("the Host a browser sends decides what this console admits", () => {
  let h: Harness;
  let operator: string;

  beforeAll(async () => {
    h = await harness();
    operator = await tokenFor(h, "ada", "operator");
  });

  afterAll(() => h.stop());

  test("a Host nobody configured is refused, and the refusal is never a document", async () => {
    const res = await raw(h.port, request("/", "evil.example"));
    expect(res.status).toBe(400);
    expectDocumentHeaders("a refused Host", res.headers, h.csp);
    // The reason echoes the Host so an operator can fix it; nosniff plus a
    // non-HTML type is what keeps that echo from being a document.
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
    expect(res.body).toContain("evil.example");
  });

  test("HSTS is asserted on the configured https host, and only there", async () => {
    const secure = await raw(h.port, request("/", PUBLIC_HOST));
    expect(secure.status).toBe(200);
    expect(secure.headers.get("strict-transport-security")).toBe("max-age=31536000");

    const loopback = await raw(h.port, request("/", `127.0.0.1:${h.port}`));
    expect(loopback.status).toBe(200);
    expect(loopback.headers.get("strict-transport-security")).toBeNull();

    // The same asymmetry on a gated JSON response, not only on the shell.
    const gated = await raw(
      h.port,
      request(READ_PATHS.status, PUBLIC_HOST, [`${SESSION_HEADER}: ${operator}`]),
    );
    expect(gated.status).toBe(200);
    expect(gated.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });
});

// ── 3 · the two realms ──────────────────────────────────────────────────────

describe("the two realms do not cross", () => {
  let h: Harness;
  let gateway: GatewayHandle;
  let cloud: Signer;
  let session: string;
  let capability: string;
  let consoleGrant: string;

  beforeAll(async () => {
    cloud = await signer();
    h = await harness({ ssoKey: cloud.publicKey });
    session = await tokenFor(h, "ada", "operator");
    capability = await cloud.mint({
      v: 2,
      purpose: "read",
      org: ORG,
      aud: ORG,
      sub: "user-1",
      repo: "acme/app",
      scopeHash: "HASH",
    });
    consoleGrant = await cloud.mint({
      purpose: CONSOLE_GRANT_PURPOSE,
      org: ORG,
      aud: ORG,
      sub: "workbench-user",
      origin: PUBLIC_URL,
    });
    gateway = startGatewayServer({
      port: 0,
      logger: { info() {}, error() {} },
      signingKey: async () => cloud.publicKey,
      ownOrgId: async () => ORG,
      store: () => ({}) as SessionStore,
      postgresReady: () => true,
      db: () => null,
      dbRead: () => null,
    });
  });

  afterAll(async () => {
    gateway.stop();
    await h.stop();
  });

  test("a cloud-signed gateway bearer reaches no console route, on either header", async () => {
    const carriers: Array<[string, Record<string, string>]> = [
      ["as a bearer", { authorization: `Bearer ${capability}` }],
      ["as a session token", { [SESSION_HEADER]: capability }],
      ["as both", { authorization: `Bearer ${capability}`, [SESSION_HEADER]: capability }],
    ];
    for (const [label, headers] of carriers) {
      for (const target of [READ_PATHS.status, READ_PATHS.sessions, READ_AUDITED_PATHS.report]) {
        const res = await fetch(`${h.origin}${target}`, { headers });
        expect([label, target, res.status]).toEqual([label, target, 401]);
        // The SAME sentence an unknown path gets: a valid token from the other
        // realm must not be able to map this one.
        expect(await res.json()).toEqual({ error: "sign in to continue" });
      }
      const write = await fetch(`${h.origin}${MUTATE_PATHS.commands}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", origin: h.origin },
        body: JSON.stringify({ kind: "self_test", params: {} }),
      });
      expect([label, write.status]).toEqual([label, 401]);
    }
    expect(h.submitted).toEqual([]);
  });

  test("a console session reaches no gateway route, on either header", async () => {
    const base = `http://127.0.0.1:${gateway.port}`;
    const carriers: Array<[string, Record<string, string>]> = [
      ["as a bearer", { authorization: `Bearer ${session}` }],
      ["as a session token", { [SESSION_HEADER]: session }],
    ];
    for (const [label, headers] of carriers) {
      const read = await fetch(`${base}/sessions`, { headers });
      expect([label, read.status]).toEqual([label, 401]);
      expect(await read.json()).toEqual({ error: "unauthorized" });

      const mcp = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect([label, mcp.status]).toEqual([label, 401]);

      const ingest = await fetch(`${base}/sessions/commit`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ family: "claude-cli", sessionId: "s", chunkId: "c" }),
      });
      expect([label, ingest.status]).toEqual([label, 401]);
    }
  });

  test("the console grant opens neither door — it is not a capability token", async () => {
    const base = `http://127.0.0.1:${gateway.port}`;
    // Signed by the very key this gateway verifies against, and still refused:
    // the purpose is a realm, not a label.
    const read = await fetch(`${base}/sessions`, {
      headers: { authorization: `Bearer ${consoleGrant}` },
    });
    expect(read.status).toBe(401);
    // And it authenticates nothing on the console either: the exchange is the
    // only door it fits, and that door mints no session.
    const console = await fetch(`${h.origin}${READ_PATHS.status}`, {
      headers: { [SESSION_HEADER]: consoleGrant },
    });
    expect(console.status).toBe(401);
  });

  test("the roster has no HTTP door at all, on either surface", async () => {
    // rosterSync arrives on the daemon's own authenticated tunnel and nowhere
    // else. Neither realm exposes a path to it — with a valid token or without.
    expect(h.runtime.routes.all().some((r) => r.path.includes("roster"))).toBe(false);

    const base = `http://127.0.0.1:${gateway.port}`;
    const payload = JSON.stringify({ asOf: new Date().toISOString(), members: [] });
    for (const target of ["/roster", "/rosterSync", "/sessions/roster"]) {
      const res = await fetch(`${base}${target}`, {
        method: "POST",
        headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
        body: payload,
      });
      expect([target, res.status]).toEqual([target, 404]);
    }
    // From the most privileged session this console can hold: no handler claims
    // the path, so the shell refuses the method and nothing is written.
    const onConsole = await fetch(`${h.origin}/ui/api/roster`, {
      method: "POST",
      headers: { [SESSION_HEADER]: session, "content-type": "application/json", origin: h.origin },
      body: payload,
    });
    expect(onConsole.status).toBe(405);
  });
});

// ── 4 · the grant yields a form ─────────────────────────────────────────────

describe("a cloud-minted grant lands on a sign-in form and nothing else", () => {
  let h: Harness;
  let cloud: Signer;

  const grantFor = (claims: Record<string, unknown> = {}, window?: { iat?: number; exp?: number }) =>
    cloud.mint(
      {
        purpose: CONSOLE_GRANT_PURPOSE,
        org: ORG,
        aud: ORG,
        sub: "workbench-user",
        origin: PUBLIC_URL,
        ...claims,
      },
      window,
    );

  async function exchange(grant: string, at: Harness = h): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${at.origin}/ui/api/sso/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: at.origin },
      body: JSON.stringify({ grant }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    cloud = await signer();
    h = await harness({ ssoKey: cloud.publicKey });
  });

  afterAll(() => h.stop());

  test("an ACCEPTED grant produces an annotation, and no session exists afterwards", async () => {
    const accepted = await exchange(await grantFor({ jti: "accepted-once" }));
    expect(accepted.status).toBe(200);
    expect(Object.keys(accepted.body).sort()).toEqual(["entryId", "marker", "org", "workbenchSub"]);
    expect(accepted.body.org).toBe(ORG);
    expect(accepted.body.workbenchSub).toBe("workbench-user");
    // The four fields carry no capability, and the table that holds capability
    // is untouched.
    expect(accepted.body).not.toHaveProperty("token");
    expect(h.runtime.sessions.size).toBe(0);

    // The entry id is a server-side annotation. It is not a session token, and
    // presenting it as one is the same 401 an unknown path gets.
    const asToken = await fetch(`${h.origin}${READ_PATHS.status}`, {
      headers: { [SESSION_HEADER]: String(accepted.body.entryId) },
    });
    expect(asToken.status).toBe(401);
    expect(await asToken.json()).toEqual({ error: "sign in to continue" });
  });

  test("the entry annotates a sign-in; it never substitutes for one", async () => {
    const accepted = await exchange(await grantFor({ jti: "annotates" }));
    const res = await fetch(`${h.origin}/ui/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: h.origin },
      body: JSON.stringify({
        login: "nobody",
        password: "not-the-password",
        entryId: accepted.body.entryId,
      }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).not.toHaveProperty("token");
    expect(h.runtime.sessions.size).toBe(0);
  });

  test("no refusal in the taxonomy ever mints one either", async () => {
    const other = await signer();
    const past = Math.floor(Date.now() / 1000);
    const cases: Array<[string, string]> = [
      ["a token this fortress cannot verify", await other.mint({ purpose: CONSOLE_GRANT_PURPOSE, org: ORG, aud: ORG, origin: PUBLIC_URL })],
      ["a read grant at the console door", await grantFor({ purpose: "read" })],
      ["another organization", await grantFor({ org: "org-someone-else", aud: "org-someone-else" })],
      ["another origin", await grantFor({ origin: "https://not-this-console.example" })],
      ["a window that has closed", await grantFor({ jti: "stale" }, { iat: past - 300, exp: past - 120 })],
      ["a replay of one already exchanged", await grantFor({ jti: "accepted-once" })],
      ["nothing that parses at all", "not-a-token"],
    ];
    const reasons = new Map<string, unknown>();
    for (const [label, grant] of cases) {
      const res = await exchange(grant);
      expect([label, res.status]).toEqual([label, 400]);
      expect([label, typeof res.body.error]).toEqual([label, "string"]);
      expect([label, "token" in res.body]).toEqual([label, false]);
      expect([label, "entryId" in res.body]).toEqual([label, false]);
      expect([label, h.runtime.sessions.size]).toEqual([label, 0]);
      reasons.set(label, res.body.error);
    }
    // The reasons ARE distinguishable where the fortress can substantiate them,
    // and generic where it cannot. The taxonomy is proven at the verifier; what
    // is proven here is that not one of these outcomes is a session.
    expect(reasons.get("a replay of one already exchanged")).toBe("grant_used");
    expect(reasons.get("a token this fortress cannot verify")).toBe("generic");
  });

  test("with SSO off the door refuses, and still no session exists", async () => {
    const off = await harness({ ssoKey: cloud.publicKey, sso: false });
    try {
      const res = await exchange(await grantFor({ jti: "sso-off" }), off);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("sso_disabled");
      expect(off.runtime.sessions.size).toBe(0);
    } finally {
      await off.stop();
    }
  });
});

// ── 5 · what the console refuses to buffer, parse or echo ───────────────────

const CRLF_PROBE = "ada\r\nx-injected: yes\r\n\r\n<script>alert(1)</script>";
const FRAME_PROBE = 'a line\n\nevent: closed\ndata: {"reason":"forged"}\n\n';

describe("what the console refuses to buffer, parse or echo", () => {
  let h: Harness;
  let operator: string;

  beforeAll(async () => {
    h = await harness({ logLine: FRAME_PROBE });
    operator = await tokenFor(h, "ada", "operator");
  });

  afterAll(() => h.stop());

  test("a body past the ceiling is refused by the server, not by a handler", async () => {
    const sessions = h.runtime.sessions.size;
    const oversized = "x".repeat(512 * 1024);
    const res = await fetch(`${h.origin}/ui/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: h.origin },
      body: oversized,
    }).catch(() => null);
    // The one public route that answers before a session exists must not be a
    // way to make this process buffer megabytes.
    expect(res?.status).toBe(413);
    expect(h.runtime.sessions.size).toBe(sessions);
  });

  test("a body of the wrong shape is a refusal, never a fault", async () => {
    // Three, not five: the sign-in meter is keyed on the peer, and every test in
    // this file arrives from the same one.
    const shapes = ["[]", "null", "{"];
    for (const body of shapes) {
      const res = await fetch(`${h.origin}/ui/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: h.origin },
        body,
      });
      expect([body, res.status]).toEqual([body, 401]);
      await res.arrayBuffer();
    }
    for (const body of ["[]", '"a string"', "{"]) {
      const res = await fetch(`${h.origin}${MUTATE_PATHS.commands}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: h.origin, [SESSION_HEADER]: operator },
        body,
      });
      expect([body, res.status]).toEqual([body, 400]);
      await res.arrayBuffer();
    }
    expect(h.submitted).toEqual([]);
  });

  test("a login no account could have is refused at the door, and writes nothing", async () => {
    // The failed sign-in is the ONE place an unauthenticated caller chooses what
    // is written down: the login becomes the record's actor and a lockout key.
    // The window collapse bounds how MANY such records there are, never how big
    // — and hx.admin_audit has no DELETE anywhere — so 200 windows of a 256 KiB
    // login per five minutes is tens of gigabytes a day of append-only table.
    for (const probe of [CRLF_PROBE, "A".repeat(200_000)]) {
      const res = await fetch(`${h.origin}/ui/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: h.origin },
        body: JSON.stringify({ login: probe, password: "wrong" }),
      });
      // The SAME uniform 401 a wrong password gets: the refusal must not tell a
      // caller which of the two they got wrong.
      expect(res.status).toBe(401);
      expect(res.headers.get("x-injected")).toBeNull();
      await res.arrayBuffer();
    }

    await h.audit.flushFailures(true);
    const records = await readSpool(h.spoolDir);
    expect(records.find((r) => r.params?.login === CRLF_PROBE)).toBeUndefined();
    expect(records.some((r) => (r.actor?.length ?? 0) > MAX_ACTOR_CHARS + 1)).toBe(false);

    // …and whatever does reach the spool is still one JSON line per record: a
    // spool the caller can split is a spool the caller can forge a record into.
    // (Here that is nothing at all — a refusal at the door does not even open
    // the file, which is the point.)
    const files = await readdir(h.spoolDir).catch(() => [] as string[]);
    const text = (
      await Promise.all(files.map((f) => readFile(path.join(h.spoolDir, f), "utf8")))
    ).join("");
    const lines = text.split("\n").filter((line) => line !== "");
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
    expect(lines.length).toBe(records.length);
  });

  test("an export records what the caller asked, and names the file itself", async () => {
    const hostile = encodeURIComponent("console.sign-in\r\nInjected: 1");
    const res = await fetch(`${h.origin}${READ_AUDITED_PATHS.auditExport}?action=${hostile}`, {
      headers: { [SESSION_HEADER]: operator },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("injected")).toBeNull();
    // Server-built, always: a caller-supplied filename is a header-injection
    // seam and a browser-side save-path decision at once.
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="hx-fortress-audit.jsonl"');
    await res.arrayBuffer();

    const records = await readSpool(h.spoolDir);
    const exported = records.find((r) => typeof r.params?.action === "string" && r.params.action.includes("Injected"));
    expect(exported).toBeDefined();
  });

  test("a log line cannot forge an event frame", async () => {
    const res = await fetch(`${h.origin}${READ_PATHS.events}`, {
      headers: { [SESSION_HEADER]: operator },
    });
    const body = await res.text();
    const events = body.split("\n").filter((line) => line.startsWith("event: "));
    // open, the log line, and the goodbye this stream's own producer earned.
    // The `closed` the LINE tried to announce is not among them.
    expect(events).toEqual(["event: open", "event: log", "event: closed"]);
    expect(body).toContain('{"reason":"producer-ended"}');
    expect(body).not.toContain('{"reason":"forged"}');
    // It is present, escaped, inside the one data field that carries it.
    expect(body).toContain("\\n\\nevent: closed");
  });
});

// ── 6 · tokens this console did not mint ────────────────────────────────────

describe("session tokens this console did not mint, and ones it no longer honours", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness();
  });

  afterAll(() => h.stop());

  test("every malformed shape is the same refusal, in the same words", async () => {
    const shapes: Array<[string, string]> = [
      ["empty", ""],
      ["whitespace", "   "],
      ["a word", "not-a-token"],
      ["a very long one", "a".repeat(8192)],
      ["an unsigned JWT", "eyJhbGciOiJub25lIn0.e30."],
      ["one carrying a space", "abc def"],
    ];
    for (const [label, token] of shapes) {
      const res = await fetch(`${h.origin}${READ_PATHS.status}`, {
        headers: { [SESSION_HEADER]: token },
      });
      expect([label, res.status]).toEqual([label, 401]);
      expect([label, await res.json()]).toEqual([label, { error: "sign in to continue" }]);
    }
  });

  test("a token minted by ANOTHER console is a stranger here", async () => {
    const other = await harness();
    try {
      const foreign = await tokenFor(other, "ada", "operator");
      // It is a live, valid session - on the console that issued it.
      const athome = await fetch(`${other.origin}${READ_PATHS.status}`, {
        headers: { [SESSION_HEADER]: foreign },
      });
      expect(athome.status).toBe(200);
      await athome.arrayBuffer();

      const abroad = await fetch(`${h.origin}${READ_PATHS.status}`, {
        headers: { [SESSION_HEADER]: foreign },
      });
      expect(abroad.status).toBe(401);
    } finally {
      await other.stop();
    }
  });

  test("a budget that moves under a live session ends it on the next request", async () => {
    const token = await tokenFor(h, "grace", "operator");
    const before = await fetch(`${h.origin}${READ_PATHS.status}`, { headers: { [SESSION_HEADER]: token } });
    expect(before.status).toBe(200);
    await before.arrayBuffer();

    // ui.json is re-read per request, so a narrowed budget lands with no restart.
    await h.config.update((current) => ({ ...current, sessionTtlHours: 0 }));
    const after = await fetch(`${h.origin}${READ_PATHS.status}`, { headers: { [SESSION_HEADER]: token } });
    expect(after.status).toBe(401);
    await h.config.update((current) => ({ ...current, sessionTtlHours: 12 }));
  });
});

// ── 7 · the forged X-Forwarded-For, at the wire ─────────────────────────────

describe("a forged X-Forwarded-For buys no fresh identity", () => {
  let h: Harness;

  beforeAll(async () => {
    // The loopback peer IS the trusted proxy here, which is the only arrangement
    // in which the header is honoured at all.
    h = await harness({ trustedProxies: ["127.0.0.1"] });
    const created = await h.runtime.users.create("ada", "operator");
    await h.runtime.users.completeSetup(created.token, PASSPHRASE);
  });

  afterAll(() => h.stop());

  async function attempt(forwardedFor: string): Promise<number> {
    const res = await fetch(`${h.origin}/ui/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: h.origin, "x-forwarded-for": forwardedFor },
      body: JSON.stringify({ login: "ada", password: "wrong-on-purpose" }),
    });
    await res.arrayBuffer();
    return res.status;
  }

  test("prepended entries change nothing; the rightmost non-trusted hop is the key", async () => {
    const real = "203.0.113.9";
    // Every attempt claims a different leftmost source. The walk never reaches
    // them, so all of them spend ONE budget.
    for (let i = 0; i < BUCKETS.signIn.limit; i += 1) {
      expect(await attempt(`10.0.0.${i}, 198.51.100.${i}, ${real}`)).toBe(401);
    }
    expect(await attempt(`192.0.2.77, ${real}`)).toBe(429);

    // A genuinely different rightmost hop is a genuinely different principal,
    // and it still has its own budget - otherwise one attacker would take the
    // whole organization down.
    expect(await attempt("203.0.113.10")).toBe(401);
  });
});

// ── 8 · the browser surface ─────────────────────────────────────────────────

describe("the browser surface is strictly narrower than the terminal's", () => {
  let h: Harness;
  let operator: string;

  beforeAll(async () => {
    h = await harness();
    operator = await tokenFor(h, "ada", "operator");
  });

  afterAll(() => h.stop());

  test("the whole write surface is two routes and one acknowledgement", () => {
    expect(MUTATE_ROUTES.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [`POST ${MUTATE_PATHS.commands}`, `POST ${MUTATE_PATHS.service}`].sort(),
    );
    // The only other non-GET a session can reach is the record that a residency
    // proof was copied, which appends to the trail and changes nothing else.
    const posts = READ_ROUTES.filter((r) => r.method !== "GET");
    expect(posts.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST ${READ_AUDITED_PATHS.proofCopyAck}`,
    ]);
    // Every registered route is one of the classified kinds. An unclassified one
    // falls to `mutate`, which is operator-only rather than open - but it is
    // also a route nobody decided about.
    for (const route of h.runtime.routes.all()) {
      const classified = ["public", "self", "read", "read-audited", "mutate"].includes(route.cls);
      expect([route.path, classified]).toEqual([route.path, true]);
    }
  });

  test("the browser mints no kind the plane does not know, and none without a control", () => {
    for (const kind of OFFERED_COMMAND_KINDS) {
      expect([kind, (CONSOLE_COMMAND_KINDS as readonly string[]).includes(kind)]).toEqual([kind, true]);
    }
    // Every kind the plane defines now has a control that submits it, so the two
    // sets coincide. That is the converged state, not a widening: the narrowing
    // that matters is the write surface itself - two routes and one
    // acknowledgement - and the verbs the terminal keeps for itself, both pinned
    // by their own tests here. This assertion is what guards the next kind: one
    // added to the plane WITHOUT a control makes it red at the definition,
    // before any route is reached.
    const withheld = CONSOLE_COMMAND_KINDS.filter(
      (kind) => !(OFFERED_COMMAND_KINDS as readonly string[]).includes(kind),
    );
    expect(withheld).toEqual([]);
  });

  test("a kind the plane never defined is refused by name, and never becomes a row", async () => {
    // The known-but-unoffered case would answer 404 here; no kind is in that
    // state any more, and the assertion above is what keeps it that way. What
    // remains reachable is a name the plane never defined at all.
    const cases: Array<[string, number]> = [
      ["revoke_session", 400],
      ["run_migration_", 400],
      ["", 400],
    ];
    for (const [kind, status] of cases) {
      const res = await fetch(`${h.origin}${MUTATE_PATHS.commands}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: h.origin, [SESSION_HEADER]: operator },
        body: JSON.stringify({ kind, params: { phase: "arm" } }),
      });
      expect([kind, res.status]).toEqual([kind, status]);
      await res.arrayBuffer();
    }
    expect(h.submitted).toEqual([]);
  });

  test("there is no configuration-write endpoint, under any spelling", async () => {
    const uiJson = path.join(h.root, "ui.json");
    const usersJson = path.join(h.root, "users.json");
    const before = [await readFile(uiJson, "utf8"), await readFile(usersJson, "utf8")];

    const attempts: Array<[string, string]> = [
      ["POST", "/ui/api/config"],
      ["PUT", "/ui/api/config"],
      ["PATCH", "/ui/api/config"],
      ["POST", "/ui/api/config/set"],
      ["POST", "/ui/api/ui/config"],
      ["POST", "/ui/api/settings"],
      ["POST", "/ui/api/users"],
      ["POST", "/ui/api/user/create"],
      ["DELETE", "/ui/api/users/ada"],
      ["POST", "/ui/api/sso/on"],
      ["POST", "/ui/api/marker"],
      ["POST", "/ui/api/enable"],
      ["POST", "/ui/api/disable"],
      ["POST", "/ui/api/credentials"],
    ];
    for (const [method, target] of attempts) {
      const res = await fetch(`${h.origin}${target}`, {
        method,
        headers: { "content-type": "application/json", origin: h.origin, [SESSION_HEADER]: operator },
        body: JSON.stringify({ publicUrl: "https://attacker.example", enabled: true, sso: true }),
      });
      // Never a 2xx, from the most privileged session this console can hold.
      const label = `${method} ${target}`;
      expect([label, res.status < 300]).toEqual([label, false]);
      await res.arrayBuffer();
    }
    expect([await readFile(uiJson, "utf8"), await readFile(usersJson, "utf8")]).toEqual(before);
  });

  test("the command plane is not a configuration-write channel either", async () => {
    for (const key of UI_CONFIG_SET_KEYS) {
      const res = await fetch(`${h.origin}${MUTATE_PATHS.commands}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: h.origin, [SESSION_HEADER]: operator },
        body: JSON.stringify({ kind: "update_apply", params: { [key]: "https://attacker.example" } }),
      });
      expect([key, res.status]).toEqual([key, 400]);
      const body = (await res.json()) as { error: string };
      expect([key, body.error]).toEqual([key, `unexpected parameter for update_apply: ${key}`]);
    }
    expect(h.submitted).toEqual([]);
  });

  test("the terminal keeps verbs the browser has no route for", () => {
    const usages = CLI_HELP.flatMap((section) => section.entries.map((entry) => entry.usage));
    const terminalOnly = [
      "hx-fortress ui config set <key> <value>",
      "hx-fortress ui user create <login> --role operator|readonly",
      "hx-fortress ui user disable <login>",
      "hx-fortress ui user delete <login>",
      "hx-fortress ui user reset <login>",
      "hx-fortress ui sso on",
      "hx-fortress ui sso off",
      "hx-fortress ui enable",
      "hx-fortress ui disable",
      "hx-fortress credentials set <key>",
      "hx-fortress enroll [token] --cloud <url>",
    ];
    for (const usage of terminalOnly) {
      expect([usage, usages.includes(usage)]).toEqual([usage, true]);
    }
    // Nothing on the console answers for any of them: the mutating surface is
    // the enumerated two, and neither takes a configuration key or a login.
    const mutating = h.runtime.routes
      .all()
      .filter((r) => r.cls === "mutate")
      .map((r) => r.path)
      .sort();
    expect(mutating).toEqual([MUTATE_PATHS.commands, MUTATE_PATHS.service].sort());
  });
});

// ── 9 · a hostile roster payload ────────────────────────────────────────────

interface Recorded {
  statements: Array<{ sql: string; params: unknown[] }>;
}

function recordingDb(recorded: Recorded): HxDb {
  const dialect = new PgDialect();
  const push = (statement: SQL): { count: number } => {
    const query = dialect.sqlToQuery(statement);
    recorded.statements.push({ sql: query.sql, params: query.params });
    return { count: 0 };
  };
  const tx = { execute: async (statement: SQL) => push(statement) };
  return {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => await fn(tx),
    execute: async (statement: SQL) => push(statement),
  } as unknown as HxDb;
}

function upserts(recorded: Recorded): Array<{ sql: string; params: unknown[] }> {
  return recorded.statements.filter((s) => s.sql.includes("INSERT INTO hx.roster ("));
}

describe("a hostile roster payload", () => {
  test("a member the wire cannot name is dropped, and the sync still lands", async () => {
    const recorded: Recorded = { statements: [] };
    const result = await replaceRoster(recordingDb(recorded), {
      asOf: "2026-07-30T00:00:00.000Z",
      members: [
        { externalId: "ada", displayName: "Ada", teams: [], devices: { installed: 1, lastSeenAt: null, lastUploadAt: null, syncTotal: null, syncDone: null, syncReportedAt: null } },
        { externalId: "", displayName: "empty", teams: [], devices: { installed: 0, lastSeenAt: null, lastUploadAt: null, syncTotal: null, syncDone: null, syncReportedAt: null } },
        { externalId: 42, displayName: "a number", teams: [], devices: { installed: 0, lastSeenAt: null, lastUploadAt: null, syncTotal: null, syncDone: null, syncReportedAt: null } },
        { displayName: "nameless", teams: [], devices: { installed: 0, lastSeenAt: null, lastUploadAt: null, syncTotal: null, syncDone: null, syncReportedAt: null } },
      ],
    } as unknown as RosterSyncPayload);

    expect(result.received).toBe(1);
    expect(upserts(recorded).length).toBe(1);
    // The marker records what was APPLIED, so the coverage denominator the
    // adoption funnel divides by can never count a member that was dropped.
    const marker = recorded.statements.find((s) => s.sql.includes("INSERT INTO hx.roster_sync"));
    expect(marker?.params).toContain(1);
    expect(recorded.statements.some((s) => /DELETE\s+FROM\s+hx\.roster/i.test(s.sql))).toBe(false);
  });

  test("hostile field values normalize rather than becoming facts", async () => {
    const recorded: Recorded = { statements: [] };
    await replaceRoster(recordingDb(recorded), {
      asOf: "not a date at all",
      members: [
        {
          externalId: "ada",
          displayName: "Ada",
          teams: ["Payments"],
          devices: {
            installed: Number.NaN,
            lastSeenAt: "yesterday",
            lastUploadAt: "2026-07-29T00:00:00.000Z",
            syncTotal: null,
            syncDone: null,
            syncReportedAt: "the day before",
          },
        },
      ],
    } as unknown as RosterSyncPayload);

    const [insert] = upserts(recorded);
    // installed, lastSeenAt, lastUploadAt, syncTotal, syncDone, syncReportedAt
    // in the order the statement binds them.
    expect(insert?.params[4]).toBe(0);
    expect(insert?.params[5]).toBeNull();
    expect(insert?.params[6]).toBe("2026-07-29T00:00:00.000Z");
    expect(insert?.params[9]).toBeNull();
    // An unparseable asOf becomes this host's own clock rather than a NULL that
    // would read as "no sync has ever landed".
    const marker = recorded.statements.find((s) => s.sql.includes("INSERT INTO hx.roster_sync"));
    expect(typeof marker?.params[0]).toBe("string");
    expect(Number.isNaN(Date.parse(String(marker?.params[0])))).toBe(false);
  });

  test("a payload the shape cannot carry aborts the replace rather than half-writing it", async () => {
    for (const members of [[{ externalId: "ada", displayName: "Ada", teams: [] }], "not an array", 7]) {
      const recorded: Recorded = { statements: [] };
      await expect(
        replaceRoster(recordingDb(recorded), { asOf: "2026-07-30T00:00:00.000Z", members } as unknown as RosterSyncPayload),
      ).rejects.toThrow();
      // The marker is the LAST statement of the replace, so its absence is what
      // says the roster this host renders is still the one it had.
      expect(recorded.statements.some((s) => s.sql.includes("INSERT INTO hx.roster_sync"))).toBe(false);
    }
  });

  test("a payload cannot reach Object.prototype", async () => {
    const recorded: Recorded = { statements: [] };
    const hostile: unknown = JSON.parse(
      '{"asOf":"2026-07-30T00:00:00.000Z","members":[{"externalId":"ada","displayName":"Ada","teams":[],' +
        '"__proto__":{"polluted":true},' +
        '"devices":{"installed":1,"lastSeenAt":null,"lastUploadAt":null,"syncTotal":null,"syncDone":null,' +
        '"syncReportedAt":null,"__proto__":{"pollutedToo":true}}}]}',
    );
    await replaceRoster(recordingDb(recorded), hostile as RosterSyncPayload);
    const probe = {} as Record<string, unknown>;
    expect(probe.polluted).toBeUndefined();
    expect(probe.pollutedToo).toBeUndefined();
    expect(upserts(recorded).length).toBe(1);
  });
});
