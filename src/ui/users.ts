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
//   • DURABLE state (accounts, password hashes, setup-token digests, the epochs)
//     is here, 0600, written only through the single-writer door.
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

export type UiRole = "operator" | "readonly";

export const UI_ROLES: readonly UiRole[] = ["operator", "readonly"];

export function isUiRole(value: string): value is UiRole {
  return (UI_ROLES as readonly string[]).includes(value);
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
}

export interface UsersFile {
  version: number;
  /** The GLOBAL session epoch. ONE writer: `ui disable`. Nothing else — not
   *  reset, not delete, and there is no --all-sessions flag anywhere. */
  sessionEpoch: number;
  users: UiUser[];
}

export const EMPTY_USERS_FILE: UsersFile = { version: 0, sessionEpoch: 0, users: [] };

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
  const digest = setupTokenDigest(token);
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
    const users = await this.update((current) => {
      if (liveUser(current, login)) throw new Error(`user '${login}' already exists`);
      const user: UiUser = {
        login,
        role,
        pwdHash: null,
        pwdVersion: 0,
        createdAt: now.toISOString(),
        disabledAt: null,
        deletedAt: null,
        lockoutEpoch: 0,
        credentialEpoch: 0,
        setupTokens: [minted.record],
      };
      return { ...current, users: [...current.users.filter((u) => u.login !== login), user] };
    });
    return { token: minted.token, users };
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
   * The single remedy for both a forgotten password and a lockout.
   *
   * The old password stays valid until the new link is COMPLETED — issuing a link
   * that locks someone out of an account they can still reach would make every
   * mis-sent reset an outage.
   */
  async reset(login: string, now = new Date()): Promise<{ token: string; users: UsersFile }> {
    const minted = mintSetupToken(now);
    const users = await this.update((current) =>
      mapUser(current, login, (user) => ({
        ...user,
        setupTokens: [minted.record],
        lockoutEpoch: user.lockoutEpoch + 1,
        credentialEpoch: user.credentialEpoch + 1,
      })),
    );
    return { token: minted.token, users };
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

const LOGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** Logins are path- and shell-inert by construction. They appear in CLI output
 *  and audit records; nothing here should ever need quoting. */
export function checkLogin(login: string): string | null {
  return LOGIN_PATTERN.test(login)
    ? null
    : `invalid login '${login}' — 2-64 characters, lowercase letters, digits, dot, dash or underscore, starting with a letter or digit`;
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
