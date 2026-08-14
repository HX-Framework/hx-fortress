// Console sessions: in the serving process's memory, and nowhere else.
//
// That choice decides several things at once. A restart revokes everything, which
// is the honest behaviour for a process whose whole state is memory. Nothing on
// disk can be stolen and replayed. And revocation from ANOTHER process — the CLI
// disabling a user, deleting one, or resetting their password — cannot be a
// method call, so it rides EPOCHS instead: every session records the epochs it
// was issued under, and per-request revalidation re-reads users.json and drops
// any session whose epochs have moved.
//
// TRANSPORT IS PINNED to the x-fortress-ui-token request header, never a cookie.
// A cookie is attached by the browser to every request the attacker can cause,
// which is what makes CSRF a category; a header the app sets explicitly is not.
//
// The browser medium is PINNED to sessionStorage, per tab. localStorage would
// widen an XSS from "read this tab" to "read every tab, forever". The visible
// consequence is that a second tab signs in again, and the sign-in copy says so.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { UiRole, UiUser, UsersFile } from "./users";

/** The only medium the console accepts a session on. */
export { SESSION_HEADER } from "./wire";

export interface UiSession {
  id: string;
  userLogin: string;
  role: UiRole;
  createdAt: number;
  lastSeenAt: number;
  remoteAddr: string;
  /** The workbench identity that opened the tab, when the arrival carried a
   *  verified SSO entry. Recorded for audit annotation; it conveys no capability. */
  workbenchSub: string | null;
  /** Epochs captured at issue. A later bump invalidates this session. */
  sessionEpoch: number;
  credentialEpoch: number;
  pwdVersion: number;
}

export interface SessionPolicy {
  ttlHours: number;
  idleMinutes: number;
}

export type SessionCheck =
  | { ok: true; session: UiSession; user: UiUser }
  | { ok: false; reason: SessionRefusal };

export type SessionRefusal =
  | "no-token"
  | "unknown-session"
  | "expired"
  | "idle"
  | "user-gone"
  | "user-disabled"
  | "credentials-changed"
  | "revoked";

function digestOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Why a session stopped existing. Handed to every drop listener so a reader
 *  being closed can say which of them happened. */
export type SessionDropReason = SessionRefusal | "revoked" | "logout" | "shutdown";

export type SessionDropListener = (session: UiSession, reason: SessionDropReason) => void;

export class SessionTable {
  /** Keyed by token digest, so a table dump is not a set of live tokens. */
  private readonly byDigest = new Map<string, UiSession>();
  private readonly dropListeners = new Set<SessionDropListener>();

  /**
   * Be told when a session goes away.
   *
   * Sessions are the only revocation channel there is - a disable, a delete, a
   * password change and a logout all land here as a delete from the map - so
   * anything holding an open connection on a session's behalf has to learn about
   * it from this table. Without the seam, a long-lived reader would keep
   * streaming to a principal whose account was disabled minutes ago, and the
   * only bound would be its own idle timeout.
   */
  onDrop(listener: SessionDropListener): () => void {
    this.dropListeners.add(listener);
    return () => this.dropListeners.delete(listener);
  }

  /** The ONE removal path. Every deletion goes through it so no future edit can
   *  drop a session without telling the readers attached to it. */
  private drop(key: string, session: UiSession, reason: SessionDropReason): void {
    this.byDigest.delete(key);
    for (const listener of this.dropListeners) {
      try {
        listener(session, reason);
      } catch {
        // A listener that throws must not keep a revocation from completing.
      }
    }
  }

  issue(args: {
    user: UiUser;
    file: UsersFile;
    remoteAddr: string;
    workbenchSub?: string | null;
    now?: number;
  }): { token: string; session: UiSession } {
    const now = args.now ?? Date.now();
    const token = randomBytes(32).toString("base64url");
    const session: UiSession = {
      id: randomBytes(16).toString("hex"),
      userLogin: args.user.login,
      role: args.user.role,
      createdAt: now,
      lastSeenAt: now,
      remoteAddr: args.remoteAddr,
      workbenchSub: args.workbenchSub ?? null,
      sessionEpoch: args.file.sessionEpoch,
      credentialEpoch: args.user.credentialEpoch,
      pwdVersion: args.user.pwdVersion,
    };
    this.byDigest.set(digestOf(token), session);
    return { token, session };
  }

  /**
   * Per-REQUEST revalidation. `file` is the CURRENT users.json (the caller's
   * mtime-gated read) — caching the user record at sign-in would mean a disabled
   * account keeps working until its session happens to expire.
   */
  validate(
    token: string | null,
    file: UsersFile,
    policy: SessionPolicy,
    now = Date.now(),
  ): SessionCheck {
    if (!token) return { ok: false, reason: "no-token" };
    const digest = digestOf(token);
    let session: UiSession | undefined;
    let key: string | undefined;
    for (const [candidate, value] of this.byDigest) {
      if (digestsEqual(candidate, digest)) {
        session = value;
        key = candidate;
        break;
      }
    }
    if (!session || !key) return { ok: false, reason: "unknown-session" };

    if (now - session.createdAt >= policy.ttlHours * 3_600_000) {
      this.drop(key, session, "expired");
      return { ok: false, reason: "expired" };
    }
    if (now - session.lastSeenAt >= policy.idleMinutes * 60_000) {
      this.drop(key, session, "idle");
      return { ok: false, reason: "idle" };
    }
    if (session.sessionEpoch < file.sessionEpoch) {
      this.drop(key, session, "revoked");
      return { ok: false, reason: "revoked" };
    }

    const user = file.users.find((u) => u.login === session.userLogin);
    if (!user || user.deletedAt) {
      this.drop(key, session, "user-gone");
      return { ok: false, reason: "user-gone" };
    }
    if (user.disabledAt) {
      this.drop(key, session, "user-disabled");
      return { ok: false, reason: "user-disabled" };
    }
    if (user.credentialEpoch > session.credentialEpoch || user.pwdVersion > session.pwdVersion) {
      this.drop(key, session, "credentials-changed");
      return { ok: false, reason: "credentials-changed" };
    }

    // The role is re-read too: an account whose role changed must not keep the
    // capability its session was issued with.
    session.role = user.role;
    session.lastSeenAt = now;
    return { ok: true, session, user };
  }

  /**
   * Re-affirm an OPEN stream's session against the CURRENT users.json, by id.
   *
   * The same revocation predicates `validate` applies — the session epoch, the
   * account, and the credential epoch / password version — because a belt that
   * asked a weaker question than the door would keep a stream alive for a
   * principal every ordinary request already refuses. `reset`, the console's own
   * standing remedy for a locked-out operator, bumps exactly the epochs and
   * touches none of the account flags, so an eligibility-only check missed it
   * entirely.
   *
   * NOT the clock predicates: TTL and idle belong to the request path, and a
   * heartbeat is not a user action, so re-running them here would either extend
   * an idle session or kill a stream the operator is actively watching.
   * Revocation drops the session, so the next request sees it gone too.
   */
  revocationCheck(id: string, file: UsersFile): boolean {
    for (const [digest, session] of this.byDigest) {
      if (session.id !== id) continue;
      if (session.sessionEpoch < file.sessionEpoch) {
        this.drop(digest, session, "revoked");
        return false;
      }
      const user = file.users.find((u) => u.login === session.userLogin);
      if (!user || user.deletedAt) {
        this.drop(digest, session, "user-gone");
        return false;
      }
      if (user.disabledAt) {
        this.drop(digest, session, "user-disabled");
        return false;
      }
      if (user.credentialEpoch > session.credentialEpoch || user.pwdVersion > session.pwdVersion) {
        this.drop(digest, session, "credentials-changed");
        return false;
      }
      return true;
    }
    // A session id the table does not hold is one this process already dropped
    // (or never issued): not valid.
    return false;
  }

  list(): UiSession[] {
    return [...this.byDigest.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  revoke(id: string, reason: SessionDropReason = "revoked"): boolean {
    for (const [digest, session] of this.byDigest) {
      if (session.id === id) {
        this.drop(digest, session, reason);
        return true;
      }
    }
    return false;
  }

  revokeUser(login: string): number {
    let revoked = 0;
    for (const [digest, session] of this.byDigest) {
      if (session.userLogin === login) {
        this.drop(digest, session, "revoked");
        revoked += 1;
      }
    }
    return revoked;
  }

  revokeAll(reason: SessionDropReason = "revoked"): number {
    let count = 0;
    for (const [digest, session] of this.byDigest) {
      this.drop(digest, session, reason);
      count += 1;
    }
    return count;
  }

  /** Drop sessions past either budget. The server runs this on its sweep timer so
   *  an abandoned tab does not hold a row until the process exits. */
  sweep(policy: SessionPolicy, now = Date.now()): number {
    let dropped = 0;
    for (const [digest, session] of this.byDigest) {
      const expired = now - session.createdAt >= policy.ttlHours * 3_600_000;
      const idle = now - session.lastSeenAt >= policy.idleMinutes * 60_000;
      if (expired || idle) {
        this.drop(digest, session, expired ? "expired" : "idle");
        dropped += 1;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.byDigest.size;
  }
}

/** What the sign-in page says about both budgets and about the per-tab medium.
 *  Single-sourced so the copy and the enforcement cannot drift. */
export function sessionCopy(policy: SessionPolicy): string {
  return (
    `Signed-in sessions last ${policy.ttlHours} hours, or ${policy.idleMinutes} minutes idle, ` +
    `and are held per browser tab — a second tab signs in again.`
  );
}
