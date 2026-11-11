// Shared rig for the module host tests: a temp fortress root, a throwaway
// organization key that mints module grants, a throwaway release signer, and a
// module whose asks are built to probe the gate.
//
// Every key here is generated per test run. Nothing is a real signing key.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { verifyGrant } from "../../src/gateway/capability-token";
import { askScopeHash } from "../../src/host/ask-scope";
import { LogBus } from "../../src/host/logging";
import type { CatalogEntry } from "../../src/host/module-catalog";
import {
  AskFailure,
  type ApprovedRelease,
  type FortressModule,
  type ModuleContextV2,
  type ModuleManifest,
} from "../../src/host/module-contract";
import { ModuleHost, type ModuleHostDeps } from "../../src/host/module-host";
import { ModuleRegistry } from "../../src/host/module-registry";
import { fortressPaths } from "../../src/host/paths";
import { releaseStatement } from "../../src/host/release-shelf";
import { S } from "../../src/host/shape";
import type { TrustedSigningKey } from "../../src/host/trust/signing-keys";
import type { LogRecord, Module } from "../../src/host/types";
import type { AuditRecord } from "../../src/console/audit-spool";
import { SecretMissing, type SecretProvider } from "../../src/secrets/types";

export const ORG = "org_test_1";
export type Paths = ReturnType<typeof fortressPaths>;

// ── A fortress root ──────────────────────────────────────────────────────────

export async function tempRoot(): Promise<{ paths: Paths; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-modules-"));
  return { paths: fortressPaths(root), cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** A minimal valid config.json with exactly these modules switched on. */
export async function writeConfig(paths: Paths, enabled: readonly string[]): Promise<void> {
  await mkdir(path.dirname(paths.config), { recursive: true });
  await writeFile(
    paths.config,
    JSON.stringify({
      schemaVersion: 1,
      cloud: { url: "wss://relay.example/_api/hx-gateway/vault-tunnel" },
      gateway: { publicUrl: "http://localhost:8787" },
      modules: { enabled: [...enabled] },
    }),
  );
}

/**
 * Write the status file a daemon publishes every five seconds: a whole one, as
 * the shared reader requires. `host` overrides any field of its `host` part.
 */
export async function publishStatus(
  paths: Paths,
  modules: readonly { id: string; state: string }[],
  host: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(path.dirname(paths.status), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(
    paths.status,
    JSON.stringify({
      schemaVersion: 1,
      host: {
        state: "running",
        pid: 4242,
        startedAt: now,
        updatedAt: now,
        error: null,
        writtenAt: now,
        ...host,
      },
      connection: { state: "connected", reason: null, message: null },
      postgres: { phase: "ready", reason: null },
      modules: modules.map((module) => ({ ...module, error: null })),
    }),
  );
}

/** Every record in the spool, oldest file first. */
export async function spoolRecords(paths: Paths): Promise<AuditRecord[]> {
  let names: string[];
  try {
    names = (await readdir(paths.auditSpool)).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const records: AuditRecord[] = [];
  for (const name of names) {
    // A file can be removed between the listing and the read: the console
    // deletes a drained one, and a writer's cap deletes its own oldest.
    const text = await readFile(path.join(paths.auditSpool, name), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (line.trim()) records.push(JSON.parse(line) as AuditRecord);
    }
  }
  return records;
}

/** The whole spool as one string: for asserting that something is NOT in it. */
export async function spoolText(paths: Paths): Promise<string> {
  return JSON.stringify(await spoolRecords(paths));
}

export function captureBus(): { bus: LogBus; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { bus: new LogBus({ write: (record) => void records.push(record) }), records };
}

// ── The organization's key, and grants ───────────────────────────────────────

export interface OrgKey {
  publicKey: string;
  /** Mint a token with exactly these claims. `ttl` and `iat` are in seconds. */
  mint(
    claims: Record<string, unknown>,
    options?: { ttl?: number; iat?: number; jti?: string | null; noExp?: boolean },
  ): Promise<string>;
  /** A well-formed module grant for one ask. `overrides` replaces claims. */
  grant(
    module: string,
    ask: string,
    args: Record<string, unknown>,
    overrides?: Record<string, unknown>,
    options?: { ttl?: number; iat?: number; jti?: string | null },
  ): Promise<string>;
}

export async function makeOrgKey(clock: () => Date = () => new Date()): Promise<OrgKey> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const raw = (await exportJWK(publicKey)).x as string;
  const mint: OrgKey["mint"] = async (claims, options = {}) => {
    const iat = options.iat ?? Math.floor(clock().getTime() / 1000);
    let jwt = new SignJWT(claims).setProtectedHeader({ alg: "EdDSA" }).setIssuedAt(iat);
    if (!options.noExp) jwt = jwt.setExpirationTime(iat + (options.ttl ?? 60));
    if (options.jti !== null) jwt = jwt.setJti(options.jti ?? randomUUID());
    return jwt.sign(privateKey);
  };
  return {
    publicKey: raw,
    mint,
    grant: (module, ask, args, overrides = {}, options = {}) =>
      mint(
        {
          v: 2,
          purpose: "module",
          org: ORG,
          aud: ORG,
          sub: `${module}:${ask}`,
          scopeHash: askScopeHash({ module, ask, args }),
          ...overrides,
        },
        options,
      ),
  };
}

// ── A release signer ─────────────────────────────────────────────────────────

export interface ReleaseSigner {
  keyid: string;
  trusted: TrustedSigningKey[];
  /** A sidecar over these bytes themselves: how a Fortress binary is signed,
   *  and NOT how a module release is. */
  sign(bytes: Uint8Array): Promise<string>;
  /** A sidecar over the release statement: the module, the version and the
   *  file's sha256. This is what an offer carries. */
  release(moduleId: string, version: string, checksum: string): Promise<string>;
}

export async function makeReleaseSigner(keyid: string, production = false): Promise<ReleaseSigner> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const sign = async (bytes: Uint8Array): Promise<string> => {
    const data = new Uint8Array(bytes.byteLength);
    data.set(bytes);
    const sig = await crypto.subtle.sign("Ed25519", pair.privateKey, data);
    return JSON.stringify({
      v: 1,
      alg: "Ed25519",
      keyid,
      sig: Buffer.from(new Uint8Array(sig)).toString("base64url"),
    });
  };
  return {
    keyid,
    trusted: [{ keyid, publicKey: jwk.x ?? "", production }],
    sign,
    release: (moduleId, version, checksum) => sign(releaseStatement(moduleId, version, checksum)),
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

// ── A module built to probe the gate ─────────────────────────────────────────

/** A value no test output may ever contain: it stands for a row. */
export const ROW_VALUE = "invoice #4471 | Maria Okafor <maria@example.com>";
/** A value no test output may ever contain: it stands for a secret. */
export const SECRET_VALUE = "sk-live-do-not-leak-0f3a9b";

export const PROBE_MANIFEST: ModuleManifest = {
  id: "probe",
  asks: [
    { name: "count.double", args: S.record({ n: S.count(1000) }), reply: S.record({ n: S.count() }) },
    {
      name: "tables.list",
      args: S.record({ prefix: S.name }, ["prefix"]),
      reply: S.record({ tables: S.list(S.record({ name: S.name, rows: S.count() }), 3) }),
    },
    { name: "leak.row", args: S.none, reply: S.record({ name: S.name }) },
    { name: "leak.extra", args: S.none, reply: S.record({ ok: S.flag }) },
    { name: "leak.getter", args: S.none, reply: S.record({ ok: S.flag }) },
    { name: "leak.throws", args: S.none, reply: S.record({ ok: S.flag }) },
    { name: "throw.secret", args: S.none, reply: S.none },
    { name: "throw.code", args: S.none, reply: S.none },
    { name: "throw.hostile", args: S.none, reply: S.none },
    { name: "never", args: S.none, reply: S.none },
    { name: "context.probe", args: S.none, reply: S.record({ identity: S.flag }) },
  ],
  egress: ["api.example.com", "*.stores.example.net"],
  secrets: ["probe-token"],
};

export interface ProbeModule extends FortressModule {
  calls: { ask: string; args: unknown }[];
  applied: ApprovedRelease[];
  context: ModuleContextV2 | null;
  /** Set to make `applyRelease` fail. */
  applyFailure: Error | null;
}

export function createProbeModule(
  manifest: ModuleManifest = PROBE_MANIFEST,
  options: { takesReleases?: boolean } = {},
): ProbeModule {
  const module: ProbeModule = {
    id: manifest.id,
    manifest,
    calls: [],
    applied: [],
    context: null,
    applyFailure: null,
    init(context) {
      module.context = context as ModuleContextV2;
    },
    onMessage() {
      return { ok: false, error: "ask_unknown" };
    },
    async onAsk(ask, args, ctx) {
      module.calls.push({ ask, args });
      module.context = ctx;
      switch (ask) {
        case "count.double":
          return { n: (args as { n: number }).n * 2 };
        case "tables.list":
          return { tables: [{ name: "orders", rows: 1204 }] };
        case "leak.row":
          return { name: ROW_VALUE };
        case "leak.extra":
          return { ok: true, row: ROW_VALUE };
        case "leak.getter":
          return {
            ok: true,
            toJSON() {
              return { ok: true, row: ROW_VALUE };
            },
          };
        case "leak.throws":
          // A lazy field, as a row object from a database driver can have.
          return {
            get ok(): boolean {
              throw new Error(`could not load ${ROW_VALUE}`);
            },
          };
        case "throw.secret":
          throw new Error(`could not connect with ${SECRET_VALUE} for ${ROW_VALUE}`);
        case "throw.code":
          throw new AskFailure("store_unreachable");
        case "throw.hostile":
          // A thrown value that fails when anything looks at it.
          throw new Proxy(
            {},
            {
              getPrototypeOf() {
                throw new Error(`looked at ${ROW_VALUE}`);
              },
              get() {
                throw new Error(`looked at ${ROW_VALUE}`);
              },
            },
          );
        case "never":
          return new Promise(() => {});
        case "context.probe":
          return { identity: ctx.fortressIdentity !== null };
        default:
          throw new AskFailure("ask_not_implemented");
      }
    },
  };
  if (options.takesReleases !== false) {
    module.applyRelease = async (release: ApprovedRelease) => {
      if (module.applyFailure) throw module.applyFailure;
      module.applied.push(release);
    };
  }
  return module;
}

export const PROBE_CATALOG: readonly CatalogEntry[] = [
  { id: "session_vault", title: "Sessions", summary: "transcripts", manifest: null, startOnly: true },
  {
    id: "probe",
    title: "Probe",
    summary: "a module for tests",
    manifest: PROBE_MANIFEST,
    startOnly: false,
  },
];

/** A plain module with no manifest, standing in for `session_vault`. */
export function legacyModule(id = "session_vault"): Module & { messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    id,
    messages,
    onMessage(data) {
      messages.push(data.payload);
      return { ok: true, payload: { legacy: true } };
    },
  };
}

export interface FixedSecrets extends SecretProvider {
  /** The names that were asked for, in order. */
  reads: string[];
  /** What the store holds. Replace it to change what the next read finds. */
  values: Record<string, string>;
}

/** A customer's secret store with exactly these values in it. */
export function fixedSecrets(values: Record<string, string>): FixedSecrets {
  const store: FixedSecrets = {
    kind: "file",
    reads: [],
    values,
    async get(name) {
      store.reads.push(name);
      // The lookup is by a name the test itself wrote.
      // eslint-disable-next-line security/detect-object-injection
      const value = store.values[name];
      if (value === undefined) throw new SecretMissing(name);
      return value;
    },
    async has(name) {
      return Object.hasOwn(store.values, name);
    },
  };
  return store;
}

// ── A whole module host ──────────────────────────────────────────────────────

export interface Rig {
  paths: Paths;
  host: ModuleHost;
  registry: ModuleRegistry;
  probe: ProbeModule;
  key: OrgKey;
  /** The customer's secret store the host was given. */
  secrets: FixedSecrets;
  logs: LogRecord[];
  now: { value: Date };
  cleanup: () => Promise<void>;
}

/**
 * A module host over a temp root, with the probe module provided and the given
 * modules switched on and started — what the daemon has after boot.
 */
export async function makeRig(
  options: {
    enabled?: readonly string[];
    deps?: Partial<ModuleHostDeps>;
    probe?: ProbeModule;
    start?: boolean;
    /** Another daemon over the same root, key and clock: what a restart is. */
    restartOf?: Rig;
  } = {},
): Promise<Rig> {
  const { paths, cleanup } = options.restartOf
    ? { paths: options.restartOf.paths, cleanup: async (): Promise<void> => {} }
    : await tempRoot();
  const enabled = options.enabled ?? ["session_vault", "probe"];
  if (!options.restartOf) await writeConfig(paths, enabled);
  const now = options.restartOf?.now ?? { value: new Date("2027-03-14T09:00:00.000Z") };
  const clock = (): Date => new Date(now.value.getTime());
  const key = options.restartOf?.key ?? (await makeOrgKey(clock));
  const { bus, records } = captureBus();
  const registry = new ModuleRegistry(bus);
  registry.register(legacyModule());
  const probe = options.probe ?? createProbeModule();
  const secrets = fixedSecrets({ "probe-token": SECRET_VALUE });
  const host = new ModuleHost({
    paths,
    registry,
    bus,
    version: "9.9.9",
    secrets: async () => secrets,
    verifyGrant: (token, bind) =>
      verifyGrant(token, key.publicKey, ORG, { purpose: "module", ...bind, now: clock }),
    catalog: PROBE_CATALOG,
    clock,
    env: {},
    ...options.deps,
  });
  host.provide(probe);
  if (options.start !== false) {
    // The order the daemon boots in: the host looks at the switch, the runtime
    // starts the modules, and the host is told they have started.
    await host.start();
    await registry.startAll(enabled);
    await host.started();
  }
  return {
    paths,
    host,
    registry,
    probe,
    key,
    secrets,
    logs: records,
    now,
    cleanup: async () => {
      await host.stop();
      await cleanup();
    },
  };
}

/** Send one ask through the gate, exactly as a `moduleMessage` frame carries it. */
export async function ask(
  rig: Rig,
  module: string,
  name: string,
  args: Record<string, unknown> = {},
  grant?: string | null,
  id = `msg-${randomUUID()}`,
) {
  const token = grant === undefined ? await rig.key.grant(module, name, args) : grant;
  return rig.host.asks.handle({
    module,
    id,
    kind: "request",
    payload: { v: 1, ask: name, args, ...(token === null ? {} : { grant: token }) },
  });
}
