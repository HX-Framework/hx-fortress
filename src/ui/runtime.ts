// The console's authentication runtime: the choke point every request passes
// through, and the state that outlives a single request.
//
// It exists as one object because the pieces are only correct together. A rate
// bucket without a remote key that survives a proxy is decorative; a lockout
// without an epoch cannot be cleared from the CLI; an argon gate without the
// lockout table cannot tell a clean principal from a flood. Handlers registered
// by later tasks get a verdict, never the levers.
//
// Nothing here is cached across requests except by mtime: `ui config set` and
// `ui user disable` run in a different process, and the whole point of the live
// re-read is that they land without a restart.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { sweepCmdCreds } from "../console/cmd-creds";
import { parsePublicUrl } from "./bind";
import { ArgonBusyError, ArgonGate } from "./argon-gate";
import { LiveUiConfig, effectiveUiEnabled, type UiConfig } from "./config";
import { buildHostAllowlist, checkHost, checkOrigin, type HostCheck } from "./origin";
import { RateLimiter, LockoutTable, type LockoutSnapshot } from "./rate-limit";
import { remoteKeyFor, normalizeAddress } from "./remote-key";
import { EventStreamRegistry } from "./events";
import { MUTATE_ROUTES } from "./mutate-routes";
import { READ_ROUTES } from "./read-routes";
import { LiveOidcConfig, oidcUsable, type UiOidcConfig } from "./oidc-config";
import { OidcClient, OidcFlows, type OidcIdentity } from "./oidc";
import { isOidcPath, OIDC_PUBLIC_ROUTES, type OidcRouteDeps } from "./oidc-routes";
import type { SecretProvider } from "../secrets/types";
import { gate, requiresOrigin, RouteRegistry, type RouteSpec } from "./routes";
import {
  ConsumedGrants,
  EntryContexts,
  verifyConsoleGrant,
  type EntryRecord,
  type GrantVerdict,
} from "./sso-grant";
import {
  SESSION_HEADER,
  sessionCopy,
  SessionTable,
  type SessionPolicy,
  type UiSession,
} from "./sessions";
import {
  LiveUsers,
  UsersStore,
  liveUser,
  signInEligible,
  verifyPassword,
  type UiUser,
  type UsersFile,
} from "./users";

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface UiRuntimeOptions {
  uiRoot: string;
  uiConfigFile: string;
  cmdCredsDir: string;
  env?: Record<string, string | undefined>;
  onWarn?: (message: string) => void;
  /** Injected in tests. */
  now?: () => number;
  /** The fortress's secret provider. Sign-in through the identity provider
   *  reads a confidential client's secret from it, by name. */
  secrets?: () => Promise<SecretProvider>;
  /** Injected in tests: how the console reaches the identity provider. */
  fetch?: typeof fetch;
  /** What the SSO door needs to verify a grant. Absent in the asset-only unit
   *  tests and on a fortress with no pinned key, where the door renders the
   *  generic page rather than a reason it cannot substantiate. */
  sso?: {
    pinnedKey: () => Promise<string | null>;
    orgId: () => Promise<string | null>;
    /** Called with the measured offset when the clock is why a grant failed. */
    onClockSkew?: (offsetSeconds: number) => Promise<void>;
    onClockOk?: () => Promise<void>;
  };
}

export type AuthVerdict =
  | { ok: true; route: RouteSpec | null; session: UiSession | null; user: UiUser | null; remoteKey: string }
  | { ok: false; status: 401 | 403 | 404 | 429 | 503; reason: string; retryAfterMs?: number };

export type SignInVerdict =
  | { ok: true; token: string; session: UiSession }
  | { ok: false; status: 401 | 429 | 503; reason: string; retryAfterMs?: number };

/** The origin form, or the input unchanged when it does not parse — the grant
 *  door's own comparison is what reports a mismatch, and swallowing an
 *  unparseable value here would hide it. */
function normalizedPublicUrl(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  const parsed = parsePublicUrl(value);
  return parsed.ok ? parsed.origin : value;
}

/** How many refused sign-ins through the identity provider are logged with
 *  their reason in one minute. */
export const WARN_LINES_PER_WINDOW = 20;
const WARN_WINDOW_MS = 60_000;

export class UiRuntime {
  readonly sessions = new SessionTable();
  readonly limiter = new RateLimiter();
  readonly lockouts = new LockoutTable();
  readonly argon = new ArgonGate();
  readonly routes = new RouteRegistry();
  readonly streams = new EventStreamRegistry();
  readonly config: LiveUiConfig;
  readonly users: UsersStore;
  /** Grants already exchanged, and the workbench identities their exchanges
   *  produced. Both in memory: they only have to outlive the grant. */
  readonly consumedGrants = new ConsumedGrants();
  readonly entries = new EntryContexts();
  /** Sign-in through the organization's identity provider: its settings, read
   *  live from oidc.json, the flows in progress, and the provider client. */
  readonly oidcConfig: LiveOidcConfig;
  readonly oidcFlows = new OidcFlows();
  readonly oidcClient: OidcClient;
  private readonly live: LiveUsers;
  private readonly options: UiRuntimeOptions;
  private warnWindow = { startedAt: 0, written: 0, dropped: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: UiRuntimeOptions) {
    this.options = options;
    this.config = new LiveUiConfig(options.uiConfigFile, options.onWarn);
    this.users = new UsersStore(path.join(options.uiRoot, "users.json"));
    this.live = new LiveUsers(this.users);
    this.oidcConfig = new LiveOidcConfig(path.join(options.uiRoot, "oidc.json"), options.onWarn);
    this.oidcClient = new OidcClient({
      secrets:
        options.secrets ??
        ((): Promise<SecretProvider> => Promise.reject(new Error("this console has no secret provider"))),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      now: () => this.now(),
    });
    // Classified whether or not anything is wired to serve them. An
    // unclassified path falls to `mutate`, which answers an unauthenticated
    // caller with 401 - but it would answer a READONLY signed-in one with 403,
    // and a read surface that refuses its own auditors is a bug nobody would
    // find until a compliance review.
    for (const route of READ_ROUTES) this.routes.register(route);
    for (const route of MUTATE_ROUTES) this.routes.register(route);
    // Registered always, and treated as routes only while that sign-in is on:
    // see `authorize`.
    for (const route of OIDC_PUBLIC_ROUTES) this.routes.register(route);
    // A session that stops existing takes its open streams with it. Registered
    // here rather than at each open, so no future caller can forget it.
    this.streams.attachRevocation((listener) => this.sessions.onDrop((session) => listener(session)));
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  readConfig(): Promise<UiConfig> {
    return this.config.read();
  }

  readUsers(): Promise<UsersFile> {
    return this.live.read();
  }

  readOidc(): Promise<UiOidcConfig> {
    return this.oidcConfig.read();
  }

  /** The provider settings epoch in force, or null while sign-in through the
   *  provider is off or incomplete. A session issued through the provider is
   *  valid only under the epoch it was issued with. */
  async oidcEpoch(): Promise<number | null> {
    const config = await this.readOidc();
    return oidcUsable(config) ? config.epoch : null;
  }

  /** Whether an open stream's session is still good, by the same rules a
   *  request is held to. */
  async sessionStillValid(sessionId: string): Promise<boolean> {
    return this.sessions.revocationCheck(sessionId, await this.users.load(), await this.oidcEpoch());
  }

  /** Issue a console session for a person the identity provider vouched for. */
  async issueOidcSession(args: {
    identity: OidcIdentity;
    epoch: number;
    remoteAddr: string;
  }): Promise<{ token: string; login: string; role: UiSession["role"]; sessions: string }> {
    const [file, config] = await Promise.all([this.readUsers(), this.readConfig()]);
    const issued = this.sessions.issueOidc({
      login: args.identity.login,
      role: args.identity.role,
      subject: args.identity.subject,
      epoch: args.epoch,
      sessionEpoch: file.sessionEpoch,
      remoteAddr: args.remoteAddr,
      now: this.now(),
    });
    return {
      token: issued.token,
      login: issued.session.userLogin,
      role: issued.session.role,
      sessions: sessionCopy(UiRuntime.policyOf(config)),
    };
  }

  /** What the three sign-in routes work with. */
  oidcRouteDeps(): OidcRouteDeps {
    return {
      config: () => this.readOidc(),
      client: this.oidcClient,
      flows: this.oidcFlows,
      issueSession: (args) => this.issueOidcSession(args),
      now: () => this.now(),
    };
  }

  /**
   * Where a refused sign-in's reason goes for the operator to read.
   *
   * Starting or finishing a sign-in needs no session, so the lines are capped:
   * a flood of refused sign-ins must not become a flood of log lines. Every
   * refusal is still counted in the audit trail.
   */
  warn(message: string): void {
    const now = this.now();
    if (now - this.warnWindow.startedAt >= WARN_WINDOW_MS) {
      if (this.warnWindow.dropped > 0) {
        this.options.onWarn?.(
          `${this.warnWindow.dropped} more refused sign-ins through the identity provider were not logged`,
        );
      }
      this.warnWindow = { startedAt: now, written: 0, dropped: 0 };
    }
    if (this.warnWindow.written < WARN_LINES_PER_WINDOW) {
      this.warnWindow.written += 1;
      this.options.onWarn?.(message);
    } else {
      this.warnWindow.dropped += 1;
    }
  }

  /**
   * Verify a one-click grant and produce the entry record the sign-in stamps
   * from.
   *
   * A valid grant mints NO session and reveals no data. It produces an
   * annotation and nothing else — every capability the eventual session has
   * comes from the local account whose password is typed on the form this lands
   * on.
   */
  async exchangeGrant(grant: string): Promise<GrantVerdict & { entry?: EntryRecord }> {
    const config = await this.readConfig();
    const sso = this.options.sso;
    const verdict = await verifyConsoleGrant({
      grant,
      publicKey: (await sso?.pinnedKey()) ?? null,
      orgId: (await sso?.orgId()) ?? null,
      // NORMALIZED, like every other consumer of this value. The advertisement
      // sends `parsePublicUrl(...).origin` and the hub re-normalizes on arrival,
      // so comparing the raw env var here made a single trailing slash a
      // permanent origin_mismatch — with the operator looking at two settings
      // that read identically.
      publicUrlOrigin: normalizedPublicUrl(
        this.options.env?.FORTRESS_UI_PUBLIC_URL?.trim() || config.publicUrl,
      ),
      ssoEnabled: config.sso,
      now: () => new Date(this.now()),
      ...(sso?.onClockSkew ? { onClockSkew: sso.onClockSkew } : {}),
      ...(sso?.onClockOk ? { onClockOk: sso.onClockOk } : {}),
      consume: (jti, expiresAt) =>
        this.consumedGrants.consume(jti, expiresAt, new Date(this.now())),
    });
    if (!verdict.ok) return verdict;
    const entry = this.entries.create(
      { workbenchSub: verdict.claims.sub, org: verdict.claims.org },
      new Date(this.now()),
    );
    return { ...verdict, entry };
  }

  static policyOf(config: UiConfig): SessionPolicy {
    return { ttlHours: config.sessionTtlHours, idleMinutes: config.sessionIdleMinutes };
  }

  /** The key every bucket and lockout counter is stored under. */
  remoteKey(req: Request, peer: string, config: UiConfig): string {
    return remoteKeyFor({
      peer,
      forwardedFor: req.headers.get("x-forwarded-for"),
      trustedProxies: config.trustedProxies,
    });
  }

  hostCheck(req: Request, config: UiConfig, boundPort: number): HostCheck {
    return checkHost(
      req.headers.get("host"),
      // Same precedence the SSO door uses thirty lines up, and the same one
      // `advertise.ts` publishes. The documented container recipe sets
      // FORTRESS_UI_PUBLIC_URL rather than writing ui.json, so ignoring it here
      // meant the hub was handed an origin, armed the launch button, and every
      // request carrying that Host was refused — while the grant itself would
      // have been accepted.
      buildHostAllowlist({
        bind: config.bind,
        port: boundPort,
        publicUrl:
          normalizedPublicUrl(this.options.env?.FORTRESS_UI_PUBLIC_URL?.trim() || config.publicUrl) ??
          config.publicUrl,
      }),
    );
  }

  /**
   * The gate. Order matters and is the security argument:
   *
   *   the rate bucket first (so a flood is cheap), the loopback rule next (the
   *   probe answers nobody else), then the session, then the role, then Origin.
   *
   * A 401 is returned for an unknown path as readily as for a known one, so the
   * response never confirms what the console has.
   */
  async authorize(req: Request, peer: string, boundPort: number): Promise<AuthVerdict> {
    const config = await this.readConfig();
    const url = new URL(req.url);
    let route = this.routes.lookup(req.method, url.pathname);
    // While sign-in through the identity provider is off, its three routes do
    // not exist: the request is judged as one to an unknown path, with the same
    // answer, no rate bucket and no Origin check. A console that has it off
    // gives away nothing about it.
    if (route && isOidcPath(route.path) && (await this.oidcEpoch()) === null) route = null;
    const remoteKey = this.remoteKey(req, peer, config);

    if (route?.bucket) {
      const verdict = this.limiter.take(route.bucket, remoteKey, this.now());
      if (!verdict.ok) {
        return { ok: false, status: 429, reason: "too many requests", retryAfterMs: verdict.retryAfterMs };
      }
    }
    if (route?.loopbackOnly && !LOOPBACK_PEERS.has(normalizeAddress(peer))) {
      return { ok: false, status: 404, reason: "not found" };
    }

    let session: UiSession | null = null;
    let user: UiUser | null = null;
    if (route?.cls !== "public") {
      const check = this.sessions.validate(
        req.headers.get(SESSION_HEADER),
        await this.readUsers(),
        UiRuntime.policyOf(config),
        this.now(),
        await this.oidcEpoch(),
      );
      if (!check.ok) return { ok: false, status: 401, reason: "sign in to continue" };
      session = check.session;
      user = check.user;
    }

    const decision = gate({ method: req.method, path: url.pathname, route, role: session?.role ?? null });
    if (!decision.allow) return { ok: false, status: decision.status, reason: decision.reason };

    if (requiresOrigin(route, req.method)) {
      const host = this.hostCheck(req, config, boundPort);
      const origin = checkOrigin(req.headers.get("origin"), host);
      if (!origin.ok) return { ok: false, status: 403, reason: origin.reason };
    }

    return { ok: true, route, session, user, remoteKey };
  }

  /**
   * Sign in, uniformly.
   *
   * Every failure looks the same and costs the same: an unknown login, a disabled
   * one and a wrong password all run a real argon2id verify (against a dummy hash
   * where there is no real one) and return the same message. Anything else is an
   * account-enumeration oracle, in the response body or in the clock.
   */
  async signIn(args: {
    login: string;
    password: string;
    remoteKey: string;
    remoteAddr: string;
    workbenchSub?: string | null;
  }): Promise<SignInVerdict> {
    const now = this.now();
    // The argon gate advertises that "during a flood from unknown logins, the
    // operator who knows their password still gets in", and the process-wide
    // ceiling used to run ahead of it — so a couple of dozen source addresses
    // saturated the ceiling and every subsequent sign-in got 429, the real
    // operator included.
    //
    // THE PROCESS-WIDE CEILING IS GONE, not merely un-refused. A counter that
    // cannot tell one principal from another can only refuse them all, which is
    // an org-wide lockout by construction — the thing RULE ONE in rate-limit.ts
    // forbids — and behind a proxy (this console's shipped shape: `publicUrl`
    // set, `trustedProxies: []`) every exemption we could key it on was either
    // false for everybody (the shared address) or removable by one failure (the
    // login). Measured: fail against a named operator every thirty minutes,
    // hold the counter down at two requests a second, and they cannot get in
    // WITH THE CORRECT PASSWORD. Spending a token nothing reads would have been
    // the same claim with the evidence removed.
    //
    // What bounds the work is layered and per-principal: the (login, remote)
    // bucket below at five a minute, the exponential account lockout after it,
    // and the argon gate — which bounds concurrency (and therefore RSS), caps a
    // remote key at ONE in-flight hash, reserves a slot for a clean principal,
    // and sheds a full queue as a fast 503 rather than a lockout. Measured under
    // 3,000 rotating-login sign-ins from rotating addresses: 2,399 shed, 601
    // hashed, resident memory held at maxConcurrent × 64 MiB.
    const file = await this.readUsers();
    const known = liveUser(file, args.login) !== null;
    const bucket = this.limiter.take("signIn", `${args.login} ${args.remoteKey}`, now);
    if (!bucket.ok) {
      return { ok: false, status: 429, reason: "too many attempts", retryAfterMs: bucket.retryAfterMs };
    }

    const user = signInEligible(file, args.login);
    const lockoutEpoch = user?.lockoutEpoch ?? 0;
    const locked = this.lockouts.state(args.login, args.remoteKey, lockoutEpoch, now);
    if (locked.locked) {
      return { ok: false, status: 429, reason: "too many attempts", retryAfterMs: locked.retryAfterMs };
    }

    // The argon gate's RESERVED slot does ask, and this is the one place the
    // existence question is safe to put: it decides scheduling inside an already
    // saturated gate, never a status code, and the alternative is handing the
    // last slot to a flood of first attempts at names that do not exist — which
    // is exactly what the gate's own header says it must not do. The residual is
    // a timing difference under saturation, which is weaker than the status-code
    // oracle it replaces.
    const clean = known && this.lockouts.isCleanPrincipal(args.login, args.remoteKey, now, lockoutEpoch);
    let matched: boolean;
    try {
      matched = await this.argon.run(args.remoteKey, clean, () =>
        // A null hash verifies against the dummy one and answers false, so an
        // unknown login costs exactly what a real one does — and it pays for a
        // gate slot, or it would be the one path a flood could take for free.
        verifyPassword(user?.pwdHash ?? null, args.password),
      );
    } catch (err) {
      if (err instanceof ArgonBusyError) {
        return { ok: false, status: 503, reason: err.message, retryAfterMs: 1_000 };
      }
      throw err;
    }

    if (!user || !matched) {
      this.lockouts.recordFailure(args.login, args.remoteKey, lockoutEpoch, now);
      return { ok: false, status: 401, reason: "sign-in failed" };
    }
    this.lockouts.recordSuccess(args.login, args.remoteKey);
    const issued = this.sessions.issue({
      user,
      file,
      remoteAddr: args.remoteAddr,
      workbenchSub: args.workbenchSub ?? null,
      now,
    });
    return { ok: true, token: issued.token, session: issued.session };
  }

  /** Setup completion also passes the argon gate: it hashes, and a hash is the
   *  expensive operation the gate exists to bound. */
  async completeSetup(token: string, password: string, remoteKey: string): Promise<UiUser> {
    return this.argon.run(remoteKey, this.lockouts.isClean(remoteKey, this.now()), () =>
      this.users.completeSetup(token, password, new Date(this.now())),
    );
  }

  /** True when the console may serve at all: the env var OR ui.json. */
  async enabled(): Promise<boolean> {
    return effectiveUiEnabled(await this.readConfig(), this.options.env ?? process.env);
  }

  // -- housekeeping ----------------------------------------------------------

  private get lockoutSnapshotFile(): string {
    return path.join(this.options.uiRoot, "lockouts.json");
  }

  async restoreLockouts(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.lockoutSnapshotFile, "utf8"));
      const snapshot = raw as LockoutSnapshot;
      if (Array.isArray(snapshot.entries)) this.lockouts.hydrate(snapshot, this.now());
    } catch {
      // No snapshot, or an unreadable one. Starting with empty counters is the
      // pre-existing behaviour, never a refusal to serve.
    }
  }

  /** Counters live in memory; this is the periodic copy so a restart does not
   *  hand an attacker a clean slate. Holds no secret. */
  async persistLockouts(): Promise<void> {
    await writeFile(this.lockoutSnapshotFile, `${JSON.stringify(this.lockouts.snapshot())}\n`, {
      mode: 0o600,
    }).catch(() => {});
  }

  /** Drops expired sessions and rate windows, and removes single-use command
   *  credentials whose command will never run — the console mints those, so the
   *  orphans are its own. */
  async sweep(): Promise<{ sessions: number; windows: number; lockouts: number; creds: number }> {
    const now = this.now();
    const config = await this.readConfig().catch(() => null);
    const sessions = config ? this.sessions.sweep(UiRuntime.policyOf(config), now) : 0;
    const swept = await sweepCmdCreds(this.options.cmdCredsDir, new Date(now)).catch(() => ({ deleted: [] }));
    const result = {
      sessions,
      windows: this.limiter.sweep(now),
      lockouts: this.lockouts.sweep(now),
      creds: swept.deleted.length,
    };
    await this.persistLockouts();
    return result;
  }

  startSweepTimer(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), intervalMs);
    // Housekeeping must never be the reason a foreground console refuses to exit.
    this.timer.unref?.();
  }

  stopSweepTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
