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

import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { sweepCmdCreds } from "../console/cmd-creds";
import { parsePublicUrl } from "./bind";
import { ArgonBusyError, ArgonGate } from "./argon-gate";
import { LiveUiConfig, effectiveUiEnabled, type UiConfig } from "./config";
import { buildHostAllowlist, checkHost, checkOrigin, type HostCheck } from "./origin";
import {
  RateLimiter,
  LockoutTable,
  type BucketName,
  type BucketVerdict,
  type LockoutSnapshot,
} from "./rate-limit";
import { remoteKeyFor, normalizeAddress } from "./remote-key";
import { EventStreamRegistry } from "./events";
import { MUTATE_ROUTES } from "./mutate-routes";
import { READ_ROUTES } from "./read-routes";
import { SETTINGS_ROUTES } from "./settings-routes";
import { LiveOidcConfig, oidcUsable, type UiOidcConfig } from "./oidc-config";
import { OidcClient, OidcFlows, type OidcIdentity } from "./oidc";
import { isOidcPath, OIDC_PUBLIC_ROUTES, type OidcRouteDeps } from "./oidc-routes";
import { PROVIDER_PEOPLE_FILE, ProviderPeopleStore } from "./provider-people";
import type { SecretProvider } from "../secrets/types";
import { gate, requiresOrigin, RouteRegistry, type RouteSpec } from "./routes";
import type { ActRoutes, ResolvedAct } from "./act-routes";
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
import { CodeCeiling, SecondStepTickets, type HeldTicket } from "./second-step";
import { checkCode, newSecret, otpauthUri } from "./totp";
import {
  LiveUsers,
  UsersStore,
  checkPasswordPolicy,
  findUserBySetupToken,
  hasSecondStep,
  hashPassword,
  liveUser,
  opensConsole,
  setupTokenDigest,
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
  /** The acts of the modules that are switched on: the routes that are not in
   *  this console's own table. Absent, the console has none. */
  acts?: ActRoutes;
  env?: Record<string, string | undefined>;
  onWarn?: (message: string) => void;
  /** Injected in tests. */
  now?: () => number;
  /** This HX Fortress's secret provider. Sign-in through the identity provider
   *  reads a confidential client's secret from it, by name. */
  secrets?: () => Promise<SecretProvider>;
  /** Injected in tests: how the console reaches the identity provider. */
  fetch?: typeof fetch;
  /** What the SSO door needs to verify a grant. Absent in the asset-only unit
   *  tests and on an HX Fortress with no pinned key, where the door renders the
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
  | {
      ok: true;
      route: RouteSpec | null;
      session: UiSession | null;
      user: UiUser | null;
      remoteKey: string;
      /** The act of a module this request is for, when it is for one. */
      act?: ResolvedAct;
    }
  | {
      ok: false;
      status: 401 | 403 | 404 | 429 | 503;
      reason: string;
      retryAfterMs?: number;
      /** A signed-in person was refused an act of a module because of their
       *  role. The server tells the daemon, which records the try under the
       *  person's login (act-routes.ts). Left out for every other refusal. */
      refusedAct?: { act: ResolvedAct; session: UiSession };
    };

/** What a proved first factor leads to when the second step is required: a
 *  ticket for the code of an app already set up, or, from a setup link, a
 *  ticket and the new secret to set one up with. */
export type SecondStepChallenge =
  | { kind: "code"; ticket: string }
  | { kind: "setup"; ticket: string; secret: string; uri: string };

export type SignInVerdict =
  | { ok: true; token: string; session: UiSession }
  /** The password was right and the second step is still to come. No session
   *  exists yet, which is why this is not `ok`. */
  | { ok: false; status: 200; reason: "second step"; challenge: SecondStepChallenge; retryAfterMs?: undefined }
  /** The password was right, and the account has no second step: it is set up
   *  only from a one-time link. See SECOND_STEP_LINK_NEEDED_COPY. */
  | { ok: false; status: 403; reason: "setup link needed"; retryAfterMs?: undefined }
  /** The password was right, and this kind of account does not open the
   *  console. See NO_CONSOLE_COPY. */
  | { ok: false; status: 403; reason: "no console"; retryAfterMs?: undefined }
  | { ok: false; status: 401 | 429 | 503; reason: string; retryAfterMs?: number };

export type SecondStepVerdict =
  /** `setUp` when the code finished a setup link: the password and the second
   *  step were written, and the link spent, with this code. */
  | { ok: true; token: string; session: UiSession; setUp: boolean }
  /** A wrong code against a live ticket. `ended` when that was the ticket's
   *  last allowed one. */
  | { ok: false; status: 401; reason: "wrong code"; login: string; ended: boolean }
  /** No live ticket for this caller: never issued, expired, void, used, being
   *  finished by another request, from another network, or the account changed
   *  since its first factor was proved. */
  | { ok: false; status: 401; reason: "no ticket" }
  /** This account took too many wrong codes, from wherever they came. No code
   *  was looked at. */
  | { ok: false; status: 429; reason: "too many codes"; login: string; retryAfterMs: number }
  | { ok: false; status: 429; reason: "too many attempts"; retryAfterMs: number }
  /** The code was right, and this kind of account does not open the console.
   *  `setUp` as above: a setup link was finished all the same. */
  | { ok: false; status: 403; reason: "no console"; login: string; role: UiUser["role"]; setUp: boolean };

/** How long a code from a person's authenticator app counts for a save in
 *  Settings, from when it was given: at sign-in, or before an earlier save. */
export const CODE_PASS_MS = 5 * 60_000;

/** What a code typed in a signed-in session comes to. */
export type CodeVerdict =
  /** The code is right, and that step of the app is spent. The session passes
   *  for CODE_PASS_MS from now. */
  | { ok: true }
  /** The code was judged and is wrong, from a step too far away, or used
   *  already. Counted as a wrong code at sign-in is. `closedForMs` is above
   *  zero when this was the wrong code that closed the account's second step. */
  | { ok: false; reason: "wrong code"; closedForMs: number }
  /** This account took too many wrong codes, from wherever they came. No code
   *  was looked at. */
  | { ok: false; reason: "too many codes"; retryAfterMs: number }
  /** Too many attempts for this login from this network. No code was looked at. */
  | { ok: false; reason: "too many attempts"; retryAfterMs: number }
  /** The account has no app to take a code from: its second step was never set
   *  up, or was taken out. Only a new setup link gives it one. */
  | { ok: false; reason: "no app" }
  /** Nothing to judge the code against: a session through the identity
   *  provider, an account that changed since the session began, or anything
   *  unexpected while checking. */
  | { ok: false; reason: "refused" };

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
  /** Grants already exchanged, and the identities from the control plane that their exchanges
   *  produced. Both in memory: they only have to outlive the grant. */
  readonly consumedGrants = new ConsumedGrants();
  readonly entries = new EntryContexts();
  /** Sign-ins between a right password and the code of the second step. In
   *  memory: a restart ends every one of them. */
  readonly secondSteps = new SecondStepTickets();
  /** Wrong codes counted for each account, from every address, and saved with
   *  the lockout table so a restart does not reopen it. See CodeCeiling. */
  readonly codeCeiling = new CodeCeiling();
  /** Sign-in through the organization's identity provider: its settings, read
   *  live from oidc.json, the flows in progress, and the provider client. */
  readonly oidcConfig: LiveOidcConfig;
  readonly oidcFlows = new OidcFlows();
  readonly oidcClient: OidcClient;
  /** The people who signed in through the identity provider, as the `host`
   *  module's `access.groups` ask counts them. This console is its only writer. */
  readonly providerPeople: ProviderPeopleStore;
  /** True from a write of provider-people.json that failed until one succeeds: it is said once. */
  private noteFailing = false;
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
    this.providerPeople = new ProviderPeopleStore(path.join(options.uiRoot, PROVIDER_PEOPLE_FILE), {
      now: () => new Date(this.now()),
      onWrite: (ok) => this.peopleWritten(ok),
    });
    // Read once now, so the first sign-in after a start finds it in memory.
    void this.providerPeople.warm();
    // Classified whether or not anything is wired to serve them. An
    // unclassified path falls to `mutate`, which answers an unauthenticated
    // caller with 401 - but it would answer a READONLY signed-in one with 403,
    // and a read surface that refuses its own auditors is a bug nobody would
    // find until a compliance review.
    for (const route of READ_ROUTES) this.routes.register(route);
    for (const route of MUTATE_ROUTES) this.routes.register(route);
    for (const route of SETTINGS_ROUTES) this.routes.register(route);
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

  /**
   * Make a console session: the ONE place one is made, for an account of this
   * console and for a person the identity provider vouched for alike. Every
   * sign-in ends here, after its credential is fully proved: the password, the
   * code where one is required, or the provider's signed answer.
   *
   * A kind of account that does not open the console is refused here and gets
   * no session. Refusing only now tells a stranger nothing: by this point the
   * caller has proved everything a sign-in asks for.
   */
  private openConsoleSession(
    who:
      | { kind: "local"; user: UiUser; file: UsersFile; remoteAddr: string; controlPlaneSub: string | null }
      | { kind: "oidc"; identity: OidcIdentity; epoch: number; sessionEpoch: number; remoteAddr: string },
  ): { ok: true; token: string; session: UiSession } | { ok: false; reason: "no console" } {
    const role = who.kind === "local" ? who.user.role : who.identity.role;
    if (!opensConsole(role)) return { ok: false, reason: "no console" };
    const now = this.now();
    const issued =
      who.kind === "local"
        ? this.sessions.issue({
            user: who.user,
            file: who.file,
            remoteAddr: who.remoteAddr,
            controlPlaneSub: who.controlPlaneSub,
            now,
          })
        : this.sessions.issueOidc({
            login: who.identity.login,
            role: who.identity.role,
            subject: who.identity.subject,
            epoch: who.epoch,
            sessionEpoch: who.sessionEpoch,
            remoteAddr: who.remoteAddr,
            now,
          });
    // The provider's sign-in is this session's proof, as a code is at the
    // sign-in of an account of this console: see `asksSignIn`.
    if (who.kind === "oidc") issued.session.codePassedAt = now;
    return { ok: true, token: issued.token, session: issued.session };
  }

  /** Issue a console session for a person the identity provider vouched for,
   *  or refuse one their role does not open the console for. */
  async issueOidcSession(args: {
    identity: OidcIdentity;
    epoch: number;
    remoteAddr: string;
  }): Promise<
    | { ok: true; token: string; login: string; role: UiSession["role"]; sessions: string }
    | { ok: false; reason: "no console" }
  > {
    const [file, config] = await Promise.all([this.readUsers(), this.readConfig()]);
    const opened = this.openConsoleSession({
      kind: "oidc",
      identity: args.identity,
      epoch: args.epoch,
      sessionEpoch: file.sessionEpoch,
      remoteAddr: args.remoteAddr,
    });
    if (!opened.ok) return opened;
    return {
      ok: true,
      token: opened.token,
      login: opened.session.userLogin,
      role: opened.session.role,
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
      notePerson: (args) => this.notePerson(args),
      now: () => this.now(),
    };
  }

  /**
   * Note what a sign-in through the identity provider carried, in
   * provider-people.json. Never rejects: a note that fails does not fail the
   * sign-in. The note lands in memory at once and is written within a little
   * while (`ProviderPeopleStore`); a write that fails is said through
   * `peopleWritten`.
   */
  private async notePerson(args: { issuer: string; subject: string; groups: readonly string[] }): Promise<void> {
    try {
      await this.providerPeople.note(args);
    } catch {
      this.peopleWritten(false);
    }
  }

  /** A write of provider-people.json that failed is said once, and said again
   *  only after a write succeeded in between. The line names the file, and
   *  nobody. */
  private peopleWritten(ok: boolean): void {
    if (ok) {
      this.noteFailing = false;
      return;
    }
    if (this.noteFailing) return;
    this.noteFailing = true;
    this.options.onWarn?.(
      `${this.providerPeople.file} could not be read or written, so sign-ins through the identity provider are not ` +
        "noted, and the counts of who holds each role leave them out. Signing in is not affected. This line " +
        "is not repeated until a sign-in has been noted",
    );
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
      // Said once, at the moment the lines stop, so a burst that is followed
      // by silence still leaves a line that says lines were left out.
      if (this.warnWindow.dropped === 0) {
        this.options.onWarn?.(
          "further refused sign-ins through the identity provider are not logged one by one for the " +
            "rest of this minute. The audit trail counts every one of them",
        );
      }
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
      { controlPlaneSub: verdict.claims.sub, org: verdict.claims.org },
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

  /**
   * Spend one request of a budget, on this runtime's clock.
   *
   * For a surface that is metered outside `authorize`: the door of a Secure
   * Data Island. One limiter and one clock, so that a budget counts the same
   * wherever it is spent.
   */
  take(bucket: BucketName, key: string): BucketVerdict {
    return this.limiter.take(bucket, key, this.now());
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
    const found = this.routes.lookup(req.method, url.pathname);
    const token = req.headers.get(SESSION_HEADER);
    // The sign-in settings are read at most once for a request, and only when
    // the request needs them:
    //   - on a path of the sign-in routes, to learn whether they exist now;
    //   - on a path this console does not know. The answer does not need that
    //     read. It is made so that an unknown path, and a sign-in path of a
    //     console that has the sign-in off, do the same work and cannot be told
    //     apart by how long the answer takes;
    //   - for a session that was issued through the provider.
    // Every other request reads nothing, so an HX Fortress that never used this
    // sign-in pays nothing for it.
    const needsOidc =
      found === null || isOidcPath(found.path) || this.sessions.issuedThroughProvider(token);
    const oidcEpoch = needsOidc ? await this.oidcEpoch() : undefined;
    // While sign-in through the identity provider is off, its three routes do
    // not exist: the request is judged as one to an unknown path, with the same
    // answer, no rate bucket and no Origin check. A console that has it off
    // gives away nothing about it.
    let route = found && isOidcPath(found.path) && oidcEpoch === null ? null : found;
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
        token,
        await this.readUsers(),
        UiRuntime.policyOf(config),
        this.now(),
        oidcEpoch,
      );
      if (!check.ok) return { ok: false, status: 401, reason: "sign in to continue" };
      session = check.session;
      user = check.user;
    }

    // A module's act is a route only while its module is switched on, so it is
    // not in the table above: see act-routes.ts.
    //
    // It is looked for only where the table has nothing, so no act can take
    // the place of a route of the console's own. And only for a caller who is
    // signed in: a caller who is not has been answered above, as for any path
    // this console does not know. So a caller with no sign-in cannot make the
    // console read the switch and cannot learn which acts exist.
    let act: ResolvedAct | null = null;
    if (found === null && session && this.options.acts) {
      act = await this.options.acts.resolve(req.method, url.pathname);
      if (act) route = act.route;
    }

    const decision = gate({ method: req.method, path: url.pathname, route, role: session?.role ?? null });
    if (!decision.allow) {
      // A person who is signed in tried an act of a module that their role
      // may not do. The answer is the gate's, as for every other route. The
      // try is also told to the daemon, which records it, a few times a
      // minute at most.
      const told =
        act !== null &&
        session !== null &&
        decision.status === 403 &&
        // A person the console opens for, refused by their role. A session of
        // a role it opens nothing for does not exist, and is not spoken for.
        opensConsole(session.role) &&
        this.limiter.take("moduleActRefused", remoteKey, this.now()).ok;
      return {
        ok: false,
        status: decision.status,
        reason: decision.reason,
        ...(told && act && session ? { refusedAct: { act, session } } : {}),
      };
    }

    if (requiresOrigin(route, req.method)) {
      const host = this.hostCheck(req, config, boundPort);
      const origin = checkOrigin(req.headers.get("origin"), host);
      if (!origin.ok) return { ok: false, status: 403, reason: origin.reason };
    }

    // The budget of an act is taken last: after the sign-in, the role and the
    // Origin. So only a request that is about to be handed to the daemon uses
    // it. A caller with no sign-in, and a read-only person who tries an act of
    // operators, cannot use up the operators' budget.
    if (act?.route.bucket) {
      const verdict = this.limiter.take(act.route.bucket, remoteKey, this.now());
      if (!verdict.ok) {
        return { ok: false, status: 429, reason: "too many requests", retryAfterMs: verdict.retryAfterMs };
      }
    }

    return { ok: true, route, session, user, remoteKey, ...(act ? { act } : {}) };
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
    controlPlaneSub?: string | null;
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

    // The second step, when the console requires it. The failure memory of
    // this (login, network) is deliberately NOT cleared by the right password:
    // a wrong code counts in the same table, and a password known to an
    // attacker must not buy a fresh run of free code guesses each time it is
    // typed. Only a right code clears it.
    if ((await this.readConfig()).secondStep === "required") {
      // A second step is set up from a one-time link and never with the
      // password alone: otherwise whoever learned a leaked password first would
      // set up an app of their own. The answer is the same whether a link is
      // waiting, expired or was never made.
      if (!hasSecondStep(user)) return { ok: false, status: 403, reason: "setup link needed" };
      return {
        ok: false,
        status: 200,
        reason: "second step",
        challenge: this.issueCodeTicket(user, {
          remoteKey: args.remoteKey,
          controlPlaneSub: args.controlPlaneSub ?? null,
        }),
      };
    }

    this.lockouts.recordSuccess(args.login, args.remoteKey);
    const opened = this.openConsoleSession({
      kind: "local",
      user,
      file,
      remoteAddr: args.remoteAddr,
      controlPlaneSub: args.controlPlaneSub ?? null,
    });
    if (!opened.ok) return { ok: false, status: 403, reason: "no console" };
    return { ok: true, token: opened.token, session: opened.session };
  }

  /** The ticket for the code of an account whose second step is in force, after
   *  its password was proved. */
  private issueCodeTicket(
    user: UiUser,
    args: { remoteKey: string; controlPlaneSub: string | null },
  ): SecondStepChallenge {
    const ticket = this.secondSteps.issue({
      kind: "code",
      login: user.login,
      remoteKey: args.remoteKey,
      controlPlaneSub: args.controlPlaneSub,
      credentialEpoch: user.credentialEpoch,
      pwdVersion: user.pwdVersion,
      lockoutEpoch: user.lockoutEpoch,
      secret: null,
      setupDigest: null,
      pwdHash: null,
      createdAt: this.now(),
    });
    return { kind: "code", ticket };
  }

  /**
   * The first half of a setup link where the console requires a second step.
   *
   * Checks the link and the password's rules, hashes the password under the
   * argon gate, and hands out a setup ticket that holds the hash and a new
   * secret, in memory. It writes NOTHING and does not spend the link: a reload,
   * a closed tab or a wrong code leaves the account exactly as it was, and the
   * link works until it expires. The first right code writes it all at once.
   */
  async prepareSetup(
    token: string,
    password: string,
    remoteKey: string,
  ): Promise<{ user: UiUser; challenge: SecondStepChallenge }> {
    const policy = checkPasswordPolicy(password);
    if (policy) throw new Error(policy);
    const found = findUserBySetupToken(await this.users.load(), token, new Date(this.now()));
    if (!found) throw new Error("this setup link is no longer valid");
    const pwdHash = await this.argon.run(remoteKey, this.lockouts.isClean(remoteKey, this.now()), () =>
      hashPassword(password),
    );
    const secret = newSecret();
    const ticket = this.secondSteps.issue({
      kind: "setup",
      login: found.login,
      remoteKey,
      controlPlaneSub: null,
      credentialEpoch: found.credentialEpoch,
      pwdVersion: found.pwdVersion,
      lockoutEpoch: found.lockoutEpoch,
      secret,
      setupDigest: setupTokenDigest(token),
      pwdHash,
      createdAt: this.now(),
    });
    return { user: found, challenge: { kind: "setup", ticket, secret, uri: otpauthUri(found.login, secret) } };
  }

  /**
   * Finish a sign-in, or a setup link, with the code of its second step.
   *
   * A right code makes the session exactly as a sign-in without the step
   * does. A wrong one is counted four ways: against the ticket (five and it
   * is void), in the lockout table under the same (login, network) a wrong
   * password is, in the same per-principal bucket, and by the login alone (see
   * CodeCeiling). Every refusal is uniform, and anything unexpected while
   * checking is a refusal.
   */
  async completeSecondStep(args: {
    ticket: unknown;
    code: unknown;
    remoteKey: string;
    remoteAddr: string;
  }): Promise<SecondStepVerdict> {
    const now = this.now();
    const held = this.secondSteps.find(args.ticket, args.remoteKey, now);
    if (!held) return { ok: false, status: 401, reason: "no ticket" };
    const { login, kind } = held.record;

    const bucket = this.limiter.take("signIn", `${login} ${args.remoteKey}`, now);
    if (!bucket.ok) return { ok: false, status: 429, reason: "too many attempts", retryAfterMs: bucket.retryAfterMs };

    // Too many wrong codes for this account, from wherever they came: no code
    // is looked at, a right one included, until the time is up. Asked here to
    // spare the read below, and asked again after it.
    const closedEarly = this.codeCeiling.closedFor(login, held.record.lockoutEpoch, now);
    if (closedEarly > 0) return { ok: false, status: 429, reason: "too many codes", login, retryAfterMs: closedEarly };

    // The account as it is now, held to the account as it was when the first
    // factor was proved. A reset, a new password, a disable or a delete in
    // between ends the sign-in; so does a link that is no longer live.
    const file = await this.readUsers();
    const user =
      kind === "code" ? signInEligible(file, login) : (liveUser(file, login) ?? null);
    if (
      !user ||
      user.disabledAt ||
      user.credentialEpoch !== held.record.credentialEpoch ||
      user.pwdVersion !== held.record.pwdVersion ||
      (kind === "code" && !hasSecondStep(user)) ||
      (kind === "setup" && !user.setupTokens.length)
    ) {
      this.secondSteps.drop(held);
      return { ok: false, status: 401, reason: "no ticket" };
    }

    // THE LAST AWAIT BEFORE THE CODE IS JUDGED IS ABOVE. From here to the claim
    // of the ticket nothing is awaited, so reading the ceiling, judging the
    // code, counting a wrong one and claiming the ticket happen in one
    // synchronous run. Requests in flight for this account take their turns
    // here one at a time: once the count closes the second step, every later
    // one is refused here, and no more than CEILING_WRONG_CODES codes are
    // judged in the window however many arrive at once. The first ask, before
    // the read, cannot promise that: a burst passes it together.
    const closedFor = this.codeCeiling.closedFor(login, user.lockoutEpoch, now);
    if (closedFor > 0) return { ok: false, status: 429, reason: "too many codes", login, retryAfterMs: closedFor };

    const locked = this.lockouts.state(login, args.remoteKey, user.lockoutEpoch, now);
    if (locked.locked) return { ok: false, status: 429, reason: "too many attempts", retryAfterMs: locked.retryAfterMs };

    // Spaces a person typed between the groups are dropped. Anything longer
    // than a code with generous spacing is not looked at at all.
    const code = typeof args.code === "string" && args.code.length <= 32 ? args.code.replace(/\s+/g, "") : "";
    const secret = kind === "setup" ? (held.record.secret ?? "") : (user.secondStep?.secret ?? "");
    const checked = checkCode({
      secret,
      code,
      nowMs: now,
      lastStep: kind === "setup" ? null : (user.secondStep?.lastStep ?? null),
    });
    if (!checked.ok) return this.wrongCode(held, user, args.remoteKey, now);

    // The code is right. The ticket is taken HERE, before anything is awaited,
    // so a second request on it (one that carries the code of the next step,
    // say) finds it gone: one ticket makes one session.
    if (!this.secondSteps.claim(held)) return { ok: false, status: 401, reason: "no ticket" };

    // Written BEFORE the session exists: a step that cannot be recorded as
    // spent is not accepted, so a code can never be used twice.
    const written =
      kind === "setup"
        ? await this.users.completeSetupWithSecondStep(login, {
            setupDigest: held.record.setupDigest ?? "",
            credentialEpoch: user.credentialEpoch,
            pwdVersion: user.pwdVersion,
            pwdHash: held.record.pwdHash ?? "",
            secret,
            step: checked.step,
            now: new Date(now),
          })
        : await this.users.spendSecondStep(login, {
            credentialEpoch: user.credentialEpoch,
            pwdVersion: user.pwdVersion,
            secret,
            step: checked.step,
          });
    if (written === "stale") {
      // The link is no longer live, or another ticket spent this step first:
      // that reads as a wrong code, and this ticket is gone.
      if (kind === "setup") return { ok: false, status: 401, reason: "no ticket" };
      this.lockouts.recordFailure(login, args.remoteKey, user.lockoutEpoch, now);
      this.countWrongCode(login, user.lockoutEpoch, now);
      return { ok: false, status: 401, reason: "wrong code", login, ended: true };
    }
    const fresh = signInEligible(written, login);
    if (!fresh) return { ok: false, status: 401, reason: "no ticket" };

    this.lockouts.recordSuccess(login, args.remoteKey);
    const setUp = kind === "setup";
    const opened = this.openConsoleSession({
      kind: "local",
      user: fresh,
      file: written,
      remoteAddr: args.remoteAddr,
      controlPlaneSub: held.record.controlPlaneSub,
    });
    if (!opened.ok) return { ok: false, status: 403, reason: "no console", login, role: fresh.role, setUp };
    // The code that opened the session counts for a save in Settings, as one
    // typed there would.
    opened.session.codePassedAt = now;
    return { ok: true, token: opened.token, session: opened.session, setUp };
  }

  /** True while the session's last proof is less than CODE_PASS_MS old: a code
   *  from the authenticator app, or a sign-in through the identity provider. */
  private passHolds(session: UiSession): boolean {
    const passed = session.codePassedAt;
    if (passed === undefined) return false;
    // A clock that was set back does not lengthen the pass.
    const age = this.now() - passed;
    return age >= 0 && age < CODE_PASS_MS;
  }

  /**
   * Whether a save from this session needs the current code from the
   * person's authenticator app, now.
   *
   * Only while the console requires the second step, and only for an account
   * of this console: a person who came in through the identity provider proved
   * themselves there, and has no app here (see `asksSignIn`). A code given in
   * the last CODE_PASS_MS counts, at sign-in included.
   */
  async asksCode(session: UiSession): Promise<boolean> {
    if (session.oidc) return false;
    if ((await this.readConfig()).secondStep !== "required") return false;
    return !this.passHolds(session);
  }

  /**
   * Whether a save from this session asks the person to sign in again first.
   *
   * Only for a session through the identity provider. Its sign-in is its
   * proof, as a code is for an account of this console, and it counts for
   * CODE_PASS_MS from when the session was issued. After that, a session that
   * somebody else got hold of saves nothing until the person signs in again,
   * and a role the provider changed since the sign-in is the one a save goes
   * by. This holds whatever the console's `secondStep` says: that setting is
   * about the accounts of this console.
   */
  asksSignIn(session: UiSession): boolean {
    return session.oidc !== undefined && !this.passHolds(session);
  }

  /**
   * Judge a code typed in a signed-in session, before a save in Settings.
   *
   * It goes through what a code at sign-in goes through, in the same order:
   * the per-principal bucket, the count of wrong codes for the account
   * (CodeCeiling), the lockout table by login and network, the code against
   * the app's secret and the last step it spent, and the step written as spent
   * before the code is taken, so a code is used once. A wrong code is counted
   * in the same two places a wrong code at sign-in is: the lockout table and
   * the account's count. Anything unexpected while checking is a refusal.
   */
  async confirmWithCode(args: { session: UiSession; code: unknown; remoteKey: string }): Promise<CodeVerdict> {
    try {
      return await this.judgeSessionCode(args);
    } catch {
      return { ok: false, reason: "refused" };
    }
  }

  private async judgeSessionCode(args: { session: UiSession; code: unknown; remoteKey: string }): Promise<CodeVerdict> {
    const { session } = args;
    if (session.oidc) return { ok: false, reason: "refused" };
    const now = this.now();
    const login = session.userLogin;

    const bucket = this.limiter.take("signIn", `${login} ${args.remoteKey}`, now);
    if (!bucket.ok) return { ok: false, reason: "too many attempts", retryAfterMs: bucket.retryAfterMs };

    // The account as it is now, held to the account the session was issued
    // for. A reset or a new password in between ends the session anyway; this
    // is the same rule, asked where the code is judged.
    const file = await this.readUsers();
    const user = signInEligible(file, login);
    if (!user || user.disabledAt || user.credentialEpoch !== session.credentialEpoch || user.pwdVersion !== session.pwdVersion) {
      return { ok: false, reason: "refused" };
    }
    if (!hasSecondStep(user)) return { ok: false, reason: "no app" };

    // THE LAST AWAIT BEFORE THE CODE IS JUDGED IS ABOVE, as in
    // completeSecondStep: reading the ceiling, judging the code and counting a
    // wrong one happen in one synchronous run, so no more than
    // CEILING_WRONG_CODES codes are judged in the window, from this page and
    // the sign-in page together, however many arrive at once.
    const closedFor = this.codeCeiling.closedFor(login, user.lockoutEpoch, now);
    if (closedFor > 0) return { ok: false, reason: "too many codes", retryAfterMs: closedFor };

    const locked = this.lockouts.state(login, args.remoteKey, user.lockoutEpoch, now);
    if (locked.locked) return { ok: false, reason: "too many attempts", retryAfterMs: locked.retryAfterMs };

    const code = typeof args.code === "string" && args.code.length <= 32 ? args.code.replace(/\s+/g, "") : "";
    const secret = user.secondStep?.secret ?? "";
    const checked = checkCode({ secret, code, nowMs: now, lastStep: user.secondStep?.lastStep ?? null });
    if (!checked.ok) return this.wrongSessionCode(login, args.remoteKey, user.lockoutEpoch, now);

    // Written before the code is taken: a step that cannot be recorded as
    // spent is not accepted, so a code can never be used twice, here or at
    // sign-in.
    const written = await this.users.spendSecondStep(login, {
      credentialEpoch: user.credentialEpoch,
      pwdVersion: user.pwdVersion,
      secret,
      step: checked.step,
    });
    // Another request spent this step first: that reads as a wrong code, as
    // at sign-in.
    if (written === "stale") return this.wrongSessionCode(login, args.remoteKey, user.lockoutEpoch, now);
    this.lockouts.recordSuccess(login, args.remoteKey);
    session.codePassedAt = now;
    return { ok: true };
  }

  /** A wrong code in a signed-in session, counted where a wrong code at
   *  sign-in is: the lockout table and the account's count. */
  private wrongSessionCode(login: string, remoteKey: string, lockoutEpoch: number, now: number): CodeVerdict {
    this.lockouts.recordFailure(login, remoteKey, lockoutEpoch, now);
    this.countWrongCode(login, lockoutEpoch, now);
    return { ok: false, reason: "wrong code", closedForMs: this.codeCeiling.closedFor(login, lockoutEpoch, now) };
  }

  private wrongCode(held: HeldTicket, user: UiUser, remoteKey: string, now: number): SecondStepVerdict {
    const ended = this.secondSteps.wrong(held);
    this.lockouts.recordFailure(user.login, remoteKey, user.lockoutEpoch, now);
    this.countWrongCode(user.login, user.lockoutEpoch, now);
    return { ok: false, status: 401, reason: "wrong code", login: user.login, ended };
  }

  /** One wrong code for the account. A count that closes its second step is
   *  saved at once, not at the next sweep: a restart in between must not
   *  reopen it. */
  private countWrongCode(login: string, lockoutEpoch: number, now: number): void {
    if (this.codeCeiling.wrong(login, lockoutEpoch, now)) void this.persistLockouts();
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
      const snapshot = raw as LockoutSnapshot & { ceiling?: unknown };
      if (Array.isArray(snapshot.entries)) this.lockouts.hydrate(snapshot, this.now());
      // Absent from a file an earlier build wrote, which then reads as no
      // account having had a wrong code.
      this.codeCeiling.hydrate(snapshot.ceiling, this.now());
    } catch {
      // No snapshot, or an unreadable one. Starting with empty counters is the
      // pre-existing behaviour, never a refusal to serve.
    }
  }

  /**
   * Counters live in memory; this is the copy so a restart does not hand an
   * attacker a clean slate: the lockout table, and the count of wrong codes
   * for each account (CodeCeiling), in one file. Written at every sweep, and at
   * once when an account's second step closes. Holds no secret: logins,
   * addresses, counts and times.
   *
   * Written to a file beside it and moved into place, so a restart never
   * reads half a file. A write that fails leaves the previous copy.
   */
  async persistLockouts(): Promise<void> {
    const now = this.now();
    const text = `${JSON.stringify({ ...this.lockouts.snapshot(), ceiling: this.codeCeiling.snapshot(now) })}\n`;
    // The console's own files under its own folder, never a path a caller
    // supplies.
    const next = `${this.lockoutSnapshotFile}.${process.pid}.${(this.persistCount += 1)}`;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await writeFile(next, text, { mode: 0o600 });
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await rename(next, this.lockoutSnapshotFile);
    } catch {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await unlink(next).catch(() => {});
    }
  }
  private persistCount = 0;

  /** Drops expired sessions and rate windows, and removes single-use command
   *  credentials whose command will never run — the console mints those, so the
   *  orphans are its own. */
  async sweep(): Promise<{ sessions: number; windows: number; lockouts: number; creds: number }> {
    const now = this.now();
    const config = await this.readConfig().catch(() => null);
    const sessions = config ? this.sessions.sweep(UiRuntime.policyOf(config), now) : 0;
    const swept = await sweepCmdCreds(this.options.cmdCredsDir, new Date(now)).catch(() => ({ deleted: [] }));
    // Tickets of second steps nobody finished. Each holds at most a secret and
    // a password hash that were never written; dropping them is the whole of
    // their cleanup. The per-login count of wrong codes ages out the same way.
    this.secondSteps.sweep(now);
    this.codeCeiling.sweep(now);
    // Sign-ins through the provider older than 90 days, once a day.
    this.providerPeople.prune();
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
