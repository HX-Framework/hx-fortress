// <root>/ui/users.json — every account that can open the console.
//
// The terminal is the administrator: someone with a shell on this host already
// owns the box, so the CLI creates accounts without ever handling a password.
// `ui user create` prints a one-time SETUP URL and the person sets their own
// password in the browser. Nothing here ever reads a password from argv, a
// prompt or a file.
//
// The file is PG-independent by design: sign-in works with the daemon stopped and
// Postgres down, which is exactly when an operator most needs to get in.
//
// Two kinds of state live in two places, deliberately:
//
//   • DURABLE state (accounts, password hashes, setup-token digests, the
//     secrets of the second step at sign-in, the epochs) is here, 0600,
//     written only through the single-writer door.
//   • HOT counters (failed attempts, lockouts) live in ui-server memory. A
//     sign-in flood would otherwise contend on the same file `ui user disable`
//     needs to write, and revocation is the one thing that must not queue behind
//     an attack.
//
// The epochs are the bridge between them. `ui user reset` bumps lockoutEpoch and
// credentialEpoch under the lock; per-request revalidation reads them and drops
// every in-memory counter and lock recorded below the epoch. That is how a CLI
// verb clears a lockout held in another process's memory.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { JsonCasStore, StoreCorruptError, type LockReclaim } from "./store-lock";
import { base32Decode } from "./totp";

/**
 * The kinds of account, by the names in code. People are named Administrators,
 * Operators, Auditors and Viewers. In this build Administrators and Operators
 * are both `operator`, Auditors are `readonly`, and Viewers are `viewer`.
 *
 * A Viewer sees rows in Secure Data Islands, changes nothing, and opens nothing
 * in the console. A Viewer has a password, a one-time link and a second step
 * exactly like the other kinds; only the console session is refused (see
 * `opensConsole`). This build serves no Secure Data Island yet.
 */
export type UiRole = "operator" | "readonly" | "viewer";

export const UI_ROLES: readonly UiRole[] = ["operator", "readonly", "viewer"];

/** The one door from text to a role: users.json, the command line and the
 *  identity provider's mapping all pass it, so a role this build does not know
 *  reaches neither `opensConsole` nor `seesRows`. */
export function isUiRole(value: string): value is UiRole {
  return (UI_ROLES as readonly string[]).includes(value);
}

/** Whether an account of this kind may hold a console session. The one place
 *  that decides it: the runtime makes no session for a role this refuses, and
 *  the gate and the session table refuse one that exists anyway. */
export function opensConsole(role: UiRole): boolean {
  return role === "operator" || role === "readonly";
}

/**
 * Whether this kind of person sees rows in a Secure Data Island ("HX SDI"):
 * Administrators, Operators and Viewers do, Auditors do not. The one place
 * that decides it, for the part that shows rows to ask before it shows any.
 * This build serves no Secure Data Island yet, so nothing calls it.
 */
export function seesRows(role: UiRole): boolean {
  return role === "operator" || role === "viewer";
}

/** argon2id, pinned. p=1 is Bun's parameter and is not settable through its API,
 *  which is why the parallelism figure appears here as a comment and not a knob. */
export const ARGON2ID_MEMORY_COST = 65536; // 64 MiB
export const ARGON2ID_TIME_COST = 3;

export const MIN_PASSWORD_LENGTH = 10;

/** Setup links live a day. Long enough to reach someone in another timezone,
 *  short enough that a link left in a chat log stops working. */
export const SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface SetupTokenRecord {
  /** sha256 of the token. The token itself is printed once and never stored. */
  digest: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * The second step at sign-in for one account: the secret an authenticator app
 * holds, written beside the password hash.
 *
 * Only a secret the person proved with one code is ever written here, so a
 * stored record is in force from the moment it exists. `confirmedAt: null`
 * reads as "never proved" and is not in force: the account sets up a new one.
 */
export interface SecondStepRecord {
  /** base32, 20 random bytes. */
  secret: string;
  /** When the person proved the secret with a right code. */
  confirmedAt: string | null;
  /** The last 30-second step a code was accepted for. That step and every
   *  earlier one is refused from then on, so a code works once. */
  lastStep: number;
}

export interface UiUser {
  login: string;
  role: UiRole;
  /** Null until a setup link is completed. A null hash can never verify. */
  pwdHash: string | null;
  /** Bumped when the password changes; invalidates that user's live sessions. */
  pwdVersion: number;
  createdAt: string;
  disabledAt: string | null;
  deletedAt: string | null;
  /** Cross-process clear channel for in-memory failure counters and lockouts. */
  lockoutEpoch: number;
  /** Cross-process invalidation for this user's sessions and setup tokens. */
  credentialEpoch: number;
  setupTokens: SetupTokenRecord[];
  /** Null for an account with no second step, and for every account in a
   *  users.json written before the field existed. */
  secondStep: SecondStepRecord | null;
}

export interface UsersFile {
  version: number;
  /** The GLOBAL session epoch. ONE writer: `ui disable`. Nothing else — not
   *  reset, not delete, and there is no --all-sessions flag anywhere. */
  sessionEpoch: number;
  users: UiUser[];
}

export const EMPTY_USERS_FILE: UsersFile = { version: 0, sessionEpoch: 0, users: [] };

/** The `lastStep` a damaged record is read with: no step is ever later, so
 *  every code is refused. */
const UNREADABLE_STEP = Number.MAX_SAFE_INTEGER;

/**
 * The second step as stored. Absent and null are "none", which is how a file
 * from before the field existed loads unchanged.
 *
 * Anything else that is not a whole record is DAMAGED, and a damaged record is
 * kept in force with a secret that cannot verify, or a last step no code can
 * pass: every code is refused until `ui user reset` removes it. A file that
 * lost its shape must never lower the bar for the account it describes.
 */
function parseSecondStep(raw: unknown): SecondStepRecord | null {
  if (raw === undefined || raw === null) return null;
  const value =
    typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : ({} as Record<string, unknown>);
  const confirmedAt =
    typeof value.confirmedAt === "string" ? value.confirmedAt : value.confirmedAt === null ? null : "";
  const lastStep = value.lastStep;
  return {
    secret: typeof value.secret === "string" ? value.secret : "",
    confirmedAt: typeof value.secret === "string" ? confirmedAt : "",
    // A safe whole number from 0. Anything else, a negative one included,
    // could only lower the bar, so it reads as a step no code can pass.
    lastStep:
      typeof lastStep === "number" && Number.isSafeInteger(lastStep) && lastStep >= 0 && lastStep < UNREADABLE_STEP
        ? lastStep
        : UNREADABLE_STEP,
  };
}

/** Whether this account's sign-in asks for a code: it has a second step, and
 *  the person proved it. */
export function hasSecondStep(user: Pick<UiUser, "secondStep">): boolean {
  return user.secondStep !== null && user.secondStep.confirmedAt !== null;
}

/** Whether a second step in force can ever accept a code: its secret is a key,
 *  it says when it was proved, and its last step is one a code can pass. A
 *  record that cannot refuses every code, and only a reset clears it. */
export function secondStepReadable(record: SecondStepRecord): boolean {
  const key = base32Decode(record.secret);
  return (
    key !== null &&
    key.length >= 16 &&
    typeof record.confirmedAt === "string" &&
    record.confirmedAt !== "" &&
    Number.isSafeInteger(record.lastStep) &&
    record.lastStep >= 0 &&
    record.lastStep < UNREADABLE_STEP
  );
}

function parseUser(raw: unknown): UiUser | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.login !== "string" || !value.login) return null;
  if (typeof value.role !== "string" || !isUiRole(value.role)) return null;
  const tokens = Array.isArray(value.setupTokens) ? value.setupTokens : [];
  return {
    login: value.login,
    role: value.role,
    pwdHash: typeof value.pwdHash === "string" && value.pwdHash ? value.pwdHash : null,
    pwdVersion: typeof value.pwdVersion === "number" ? value.pwdVersion : 0,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
    disabledAt: typeof value.disabledAt === "string" ? value.disabledAt : null,
    deletedAt: typeof value.deletedAt === "string" ? value.deletedAt : null,
    lockoutEpoch: typeof value.lockoutEpoch === "number" ? value.lockoutEpoch : 0,
    credentialEpoch: typeof value.credentialEpoch === "number" ? value.credentialEpoch : 0,
    setupTokens: tokens.flatMap((t): SetupTokenRecord[] => {
      if (!t || typeof t !== "object") return [];
      const token = t as Record<string, unknown>;
      return typeof token.digest === "string" && typeof token.expiresAt === "string"
        ? [
            {
              digest: token.digest,
              createdAt: typeof token.createdAt === "string" ? token.createdAt : token.expiresAt,
              expiresAt: token.expiresAt,
            },
          ]
        : [];
    }),
    secondStep: parseSecondStep(value.secondStep),
  };
}

/** Null ⇒ CORRUPT. A users.json that lost its shape is never rebuilt from what
 *  this build happens to understand: the missing keys are accounts. */
export function parseUsersFile(raw: unknown): UsersFile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.users)) return null;
  const users: UiUser[] = [];
  for (const entry of value.users) {
    const user = parseUser(entry);
    if (!user) return null;
    users.push(user);
  }
  return {
    version: typeof value.version === "number" ? value.version : 0,
    sessionEpoch: typeof value.sessionEpoch === "number" ? value.sessionEpoch : 0,
    users,
  };
}

// ── Passwords ───────────────────────────────────────────────────────────────

export function checkPasswordPolicy(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: ARGON2ID_MEMORY_COST,
    timeCost: ARGON2ID_TIME_COST,
  });
}

/** A hash of a value nobody knows, verified against for logins that do not exist
 *  or cannot sign in. Computed once per process, lazily — a sign-in flood against
 *  unknown logins must cost the same as one against a real account, or the
 *  difference is an enumeration oracle. */
let dummyHash: Promise<string> | null = null;

export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString("base64"));
  return dummyHash;
}

export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  const target = hash ?? (await dummyPasswordHash());
  const matched = await Bun.password.verify(password, target).catch(() => false);
  // A null hash means "no password set". The verify above still ran, so the cost
  // is identical; the answer is fixed here rather than skipped above.
  return hash === null ? false : matched;
}

// ── Setup tokens ────────────────────────────────────────────────────────────

export function setupTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Null when a link minted elsewhere ends at a time this console accepts:
 *  later than now, and no more than the life of a link minted here ahead of
 *  this console's clock. */
export function checkSetupEnd(expiresAt: Date, now: Date): string | null {
  const end = expiresAt.getTime();
  if (!Number.isFinite(end)) return "the link's end time is not a time";
  if (end <= now.getTime()) return "the link's end time has passed";
  if (end > now.getTime() + SETUP_TOKEN_TTL_MS) {
    return "the link's end time is more than 24 hours ahead of this console's clock";
  }
  return null;
}

/** A setup-token digest as `setupTokenDigest` writes it: sha256, 64 hex
 *  characters. Either case is read; the store keeps lower case. */
const SETUP_DIGEST_SHAPE = /^[0-9a-f]{64}$/i;

/** Null when `digest` is shaped like a setup-token digest, else why not. The
 *  value itself is not repeated: it may be a token pasted where its digest
 *  belongs. */
export function checkSetupDigest(digest: string): string | null {
  return SETUP_DIGEST_SHAPE.test(digest)
    ? null
    : "a setup-token digest is the sha256 of the token: 64 hexadecimal characters";
}

export function mintSetupToken(now: Date, ttlMs = SETUP_TOKEN_TTL_MS): {
  token: string;
  record: SetupTokenRecord;
} {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    record: {
      digest: setupTokenDigest(token),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    },
  };
}

function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function liveSetupToken(
  user: UiUser,
  token: string,
  now: Date,
): SetupTokenRecord | null {
  return liveSetupDigest(user, setupTokenDigest(token), now);
}

/** The same check by the token's digest, for a caller that keeps the digest
 *  rather than the token. */
export function liveSetupDigest(user: UiUser, digest: string, now: Date): SetupTokenRecord | null {
  for (const record of user.setupTokens) {
    if (!digestsEqual(record.digest, digest)) continue;
    return Date.parse(record.expiresAt) > now.getTime() ? record : null;
  }
  return null;
}

export function findUserBySetupToken(file: UsersFile, token: string, now: Date): UiUser | null {
  for (const user of file.users) {
    if (user.deletedAt || user.disabledAt) continue;
    if (liveSetupToken(user, token, now)) return user;
  }
  return null;
}

/** The token rides the URL FRAGMENT — never the path, never the query. A fragment
 *  is not sent to the server, so it cannot appear in a request line, an access
 *  log, a proxy log or a Referer header. The status probe carries it in the
 *  X-Setup-Token header for the same reason. */
export function setupUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/setup#t=${token}`;
}

// ── The store ───────────────────────────────────────────────────────────────

/** Thrown inside a second-step write to leave the file untouched: the account
 *  is no longer the one whose code was checked. */
class StaleSecondStep extends Error {}

export class UsersStore {
  private readonly store: JsonCasStore<UsersFile>;

  constructor(file: string, onReclaim?: (reclaim: LockReclaim) => void) {
    this.store = new JsonCasStore<UsersFile>({
      file,
      label: "users.json",
      parse: parseUsersFile,
      onReclaim,
    });
  }

  get file(): string {
    return this.store.file;
  }

  async load(): Promise<UsersFile> {
    const read = await this.store.read();
    if (read.state === "corrupt") throw new StoreCorruptError("users.json", this.store.file);
    return read.doc ?? { ...EMPTY_USERS_FILE, users: [] };
  }

  private update(mutate: (current: UsersFile) => UsersFile): Promise<UsersFile> {
    return this.store.update((current) => mutate(current ?? { ...EMPTY_USERS_FILE, users: [] }));
  }

  /** Creates the account and mints its first setup token. No password is involved
   *  on this path at all. */
  async create(
    login: string,
    role: UiRole,
    now = new Date(),
  ): Promise<{ token: string; users: UsersFile }> {
    const minted = mintSetupToken(now);
    const users = await this.addAccount(login, role, minted.record, now);
    return { token: minted.token, users };
  }

  /**
   * Creates the account exactly as `create` does, except that its one setup
   * token was minted somewhere else and only its digest arrives here: the
   * install mints the link on the computer it runs on and hands HX Fortress
   * the sha256 of the token, and the time the link stops working. The link
   * then exists on that computer alone.
   *
   * Refuses a digest that is not 64 hex characters, an end time that has
   * passed or is more than a day ahead (a link minted elsewhere lives no longer
   * than one minted here), and an account that already exists. Returns
   * nothing: there is no secret on this side to give.
   */
  async createWithSetupDigest(
    login: string,
    role: UiRole,
    digest: string,
    expiresAt: Date,
    now = new Date(),
  ): Promise<void> {
    const problem = checkSetupDigest(digest) ?? checkSetupEnd(expiresAt, now);
    if (problem) throw new Error(problem);
    await this.addAccount(
      login,
      role,
      { digest: digest.toLowerCase(), createdAt: now.toISOString(), expiresAt: expiresAt.toISOString() },
      now,
    );
  }

  private addAccount(login: string, role: UiRole, token: SetupTokenRecord, now: Date): Promise<UsersFile> {
    return this.update((current) => {
      if (liveUser(current, login)) throw new Error(`user '${login}' already exists`);
      // A login made again after it was deleted starts every counter past the
      // deleted account's. Starting at zero let a session or a sign-in ticket
      // of the deleted account, still held in a console's memory, pass as the
      // new account's: same login, counters no higher than its own.
      const before = current.users.find((u) => u.login === login);
      const user: UiUser = {
        login,
        role,
        pwdHash: null,
        pwdVersion: before ? before.pwdVersion + 1 : 0,
        createdAt: now.toISOString(),
        disabledAt: null,
        deletedAt: null,
        lockoutEpoch: before ? before.lockoutEpoch + 1 : 0,
        credentialEpoch: before ? before.credentialEpoch + 1 : 0,
        setupTokens: [token],
        secondStep: null,
      };
      return { ...current, users: [...current.users.filter((u) => u.login !== login), user] };
    });
  }

  async disable(login: string, now = new Date()): Promise<UsersFile> {
    return this.update((current) =>
      mapUser(current, login, (user) => ({
        ...user,
        disabledAt: user.disabledAt ?? now.toISOString(),
        // Every outstanding link dies with the account, so a setup URL sent
        // yesterday cannot resurrect access to it today.
        setupTokens: [],
        credentialEpoch: user.credentialEpoch + 1,
      })),
    );
  }

  /** Soft delete: the row stays so per-request revalidation keeps refusing the
   *  login, and so an audit trail still resolves the actor. */
  async remove(login: string, now = new Date()): Promise<UsersFile> {
    return this.update((current) =>
      mapUser(current, login, (user) => ({
        ...user,
        deletedAt: user.deletedAt ?? now.toISOString(),
        setupTokens: [],
        credentialEpoch: user.credentialEpoch + 1,
      })),
    );
  }

  /**
   * The single remedy for a forgotten password, a lockout and a lost
   * authenticator app.
   *
   * The old password stays valid until the new link is COMPLETED — issuing a link
   * that locks someone out of an account they can still reach would make every
   * mis-sent reset an outage. The second step is removed at once: there are no
   * recovery codes, and a person with a shell on this host is the recovery.
   * Where the console requires a second step, the link sets up the new one.
   */
  async reset(
    login: string,
    now = new Date(),
  ): Promise<{ token: string; users: UsersFile; secondStepRemoved: boolean }> {
    const minted = mintSetupToken(now);
    let secondStepRemoved = false;
    const users = await this.update((current) =>
      mapUser(current, login, (user) => {
        secondStepRemoved = user.secondStep !== null;
        return {
          ...user,
          setupTokens: [minted.record],
          lockoutEpoch: user.lockoutEpoch + 1,
          credentialEpoch: user.credentialEpoch + 1,
          secondStep: null,
        };
      }),
    );
    return { token: minted.token, users, secondStepRemoved };
  }

  /**
   * Finish a setup link where the console requires a second step, in ONE
   * write: the password hash, the second step proved by its first right code
   * at `step`, and the link spent. Nothing before this wrote anything, so a
   * wrong code, an expired ticket or a closed tab leave the account exactly as
   * it was, and the link works until it expires.
   *
   * Refused ("stale") when the link is no longer live for this account (used,
   * reissued, expired, or the account disabled or deleted), or the account
   * changed since the link was checked.
   */
  async completeSetupWithSecondStep(
    login: string,
    args: {
      setupDigest: string;
      credentialEpoch: number;
      pwdVersion: number;
      pwdHash: string;
      secret: string;
      step: number;
      now: Date;
    },
  ): Promise<UsersFile | "stale"> {
    try {
      return await this.update((current) => {
        const user = liveUser(current, login);
        if (
          !user ||
          user.disabledAt ||
          !liveSetupDigest(user, args.setupDigest, args.now) ||
          user.credentialEpoch !== args.credentialEpoch ||
          user.pwdVersion !== args.pwdVersion
        ) {
          throw new StaleSecondStep();
        }
        const next: UiUser = {
          ...user,
          pwdHash: args.pwdHash,
          pwdVersion: user.pwdVersion + 1,
          setupTokens: [],
          secondStep: { secret: args.secret, confirmedAt: args.now.toISOString(), lastStep: args.step },
        };
        return { ...current, users: current.users.map((u) => (u.login === login ? next : u)) };
      });
    } catch (error) {
      if (error instanceof StaleSecondStep) return "stale";
      throw error;
    }
  }

  /**
   * Spend one step of an account's second step: a code for `step` was right.
   *
   * Refused ("stale") when the step is not later than the last one spent, so
   * two requests carrying the same code cannot both pass, and when the account
   * or its secret changed since the code was checked.
   */
  async spendSecondStep(
    login: string,
    args: { secret: string; step: number; credentialEpoch: number; pwdVersion: number },
  ): Promise<UsersFile | "stale"> {
    return this.writeSecondStep(login, args, (user) => {
      const held = user.secondStep;
      if (!held || !hasSecondStep(user) || held.secret !== args.secret || args.step <= held.lastStep) return null;
      return { ...held, lastStep: args.step };
    });
  }

  private async writeSecondStep(
    login: string,
    args: { credentialEpoch: number; pwdVersion: number },
    next: (user: UiUser) => SecondStepRecord | null,
  ): Promise<UsersFile | "stale"> {
    try {
      return await this.update((current) => {
        const user = signInEligible(current, login);
        if (!user || user.credentialEpoch !== args.credentialEpoch || user.pwdVersion !== args.pwdVersion) {
          throw new StaleSecondStep();
        }
        const record = next(user);
        if (!record) throw new StaleSecondStep();
        return {
          ...current,
          users: current.users.map((u) => (u.login === login ? { ...u, secondStep: record } : u)),
        };
      });
    } catch (error) {
      if (error instanceof StaleSecondStep) return "stale";
      throw error;
    }
  }

  /** Completion is a POST and consumes the token; a GET must never reach here, or
   *  a link-unfurling chat client would burn every setup URL it previews. */
  async completeSetup(token: string, password: string, now = new Date()): Promise<UiUser> {
    const policy = checkPasswordPolicy(password);
    if (policy) throw new Error(policy);
    const hash = await hashPassword(password);
    let completed: UiUser | undefined;
    await this.update((current) => {
      const user = findUserBySetupToken(current, token, now);
      if (!user) throw new Error("this setup link is no longer valid");
      const next: UiUser = { ...user, pwdHash: hash, pwdVersion: user.pwdVersion + 1, setupTokens: [] };
      completed = next;
      return { ...current, users: current.users.map((u) => (u.login === next.login ? next : u)) };
    });
    if (!completed) throw new Error("this setup link is no longer valid");
    return completed;
  }

  /** The ONLY writer of the global session epoch. */
  async bumpSessionEpoch(): Promise<UsersFile> {
    return this.update((current) => ({ ...current, sessionEpoch: current.sessionEpoch + 1 }));
  }
}

export function liveUser(file: UsersFile, login: string): UiUser | null {
  const user = file.users.find((u) => u.login === login);
  return user && !user.deletedAt ? user : null;
}

/** A user who may sign in right now — present, not deleted, not disabled, and
 *  past setup. Everything else fails uniformly at the sign-in route. */
export function signInEligible(file: UsersFile, login: string): UiUser | null {
  const user = liveUser(file, login);
  return user && !user.disabledAt && user.pwdHash ? user : null;
}

function mapUser(file: UsersFile, login: string, fn: (user: UiUser) => UiUser): UsersFile {
  const user = liveUser(file, login);
  if (!user) throw new Error(`no such user '${login}'`);
  return { ...file, users: file.users.map((u) => (u.login === login ? fn(u) : u)) };
}

/** A login as it has always been: 2 to 64 of lowercase letters, digits, `.`,
 *  `_` and `-`, starting with a letter or a digit. */
const NAME_LOGIN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** The part of an email login before the `@`: 1 to 64 of `a-z 0-9 . _ + -`,
 *  starting with a letter or a digit. */
const EMAIL_LOCAL = /^[a-z0-9][a-z0-9._+-]{0,63}$/;

/** One label of the host after the `@`: 1 to 63 of `a-z 0-9 -`. That it does
 *  not start or end with `-` is checked beside it. */
const EMAIL_LABEL = /^[a-z0-9-]{1,63}$/;

/** The longest login an email address may make. */
export const MAX_EMAIL_LOGIN_LENGTH = 254;

/** A lowercase email address: one `@`, the part before it, and a host of two
 *  or more labels with a dot between. The length is checked first, and each
 *  pattern runs on one bounded part. */
function isEmailLogin(login: string): boolean {
  if (login.length > MAX_EMAIL_LOGIN_LENGTH || login.includes("..")) return false;
  const at = login.indexOf("@");
  if (at < 0 || at !== login.lastIndexOf("@")) return false;
  const labels = login.slice(at + 1).split(".");
  return (
    EMAIL_LOCAL.test(login.slice(0, at)) &&
    labels.length >= 2 &&
    labels.every((label) => EMAIL_LABEL.test(label) && !label.startsWith("-") && !label.endsWith("-"))
  );
}

/**
 * Logins are path- and shell-inert by construction. They appear in CLI output,
 * in audit records, in the keys of the rate and lockout tables, and as the
 * account name an authenticator app shows; nothing here should ever need
 * quoting.
 *
 * A login is either the name it has always been, or a lowercase email address.
 * An address keeps the property: `@` and `+` mean nothing to a POSIX shell (no
 * expansion, no quoting, no splitting into words), neither separates a path or
 * matches like a glob character, neither needs escaping in JSON, and neither is
 * the space the lockout and rate tables put between a login and an address in
 * their keys. Where a login goes into a URL (the otpauth:// label of a QR code)
 * it is percent-encoded. The longest address, 254 characters, fits the audit
 * trail's actor and parameter limits whole.
 */
export function checkLogin(login: string): string | null {
  return NAME_LOGIN.test(login) || isEmailLogin(login)
    ? null
    : `invalid login '${login}' — either 2-64 characters of lowercase letters, digits, dot, dash or underscore, ` +
        "starting with a letter or digit, or a lowercase email address";
}

/** The login when it is an email address, else null. */
export function emailOf(login: string): string | null {
  return isEmailLogin(login) ? login : null;
}

/**
 * The per-request view of the store.
 *
 * Re-reads only when the file's identity or mtime moved, so revalidating on every
 * authenticated request costs a stat. Caching the parse at boot is FORBIDDEN:
 * `ui user disable` runs in a different process, and a console that read the
 * store once would keep serving the account it just revoked.
 */
export class LiveUsers {
  private cached: UsersFile | null = null;
  private signature: string | null = null;

  constructor(private readonly store: UsersStore) {}

  async read(): Promise<UsersFile> {
    const info = await Bun.file(this.store.file)
      .stat()
      .catch(() => null);
    const signature = info ? `${info.mtimeMs}:${info.size}` : null;
    if (this.cached && signature !== null && signature === this.signature) return this.cached;
    const fresh = await this.store.load();
    this.cached = fresh;
    this.signature = signature;
    return fresh;
  }
}
