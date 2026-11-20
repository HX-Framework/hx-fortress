// A Modern App stage's people, kept in the stage's own store so they move with its data: the user
// list (`_users`) and the sessions of the people on it (`_sessions`). The apps edge signs people
// in against it; the deployer's Users page and an app's own admin page edit it. Nothing here
// knows the deployer: whether someone is one of the app's authors is a fact the caller passes in.
//
// Signing in, in one transaction:
//   1. The person's row: by their issuer and subject, or else, for a verified email, the invite
//      waiting under it. An email another sign-in already holds is refused.
//   2. No row: an author gets one, marked `author`, with the app's first role; who counts as an
//      author is the edge's question. Someone else, on a stage its users open: the join rule says
//      whether they may add themselves (people at listed domains, or anyone with the link), with
//      the app's default role. Otherwise they are refused.
//   3. Who opens the stage decides (`opensStage`), and a session starts.
//
// On every request the session is read with its person, and the answer says whether they may open
// the stage as an author and as someone who is not, so the caller asks "is this an author?" only
// when the two differ. A removed person, an ended session or an expired one opens nothing, from the
// next request on.

import type { StoreCore } from "./core.js";
import { StoreError } from "./core.js";
import { heldBy } from "./history.js";
import type {
  AppAccessRefusal,
  AppSessionResult,
  AppSignInBody,
  AppTokenUserResult,
  AppSignInResult,
  AppUser,
  AppUserInviteBody,
  AppUserSignOutResult,
  AppUserUpdateBody,
  AppWhoOpens,
} from "./types.js";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 320;
const ROLE_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u;
const NAME_MAX = 200;
const SESSION_ID_RE = /^[0-9a-f]{64}$/;
const ISSUER_MAX = 400;
const SUB_MAX = 400;
/** A session's last-seen time is written at most this often. */
const SEEN_EVERY_MS = 5 * 60_000;
/** Ended and expired sessions are dropped this long after they stop. */
const SESSION_KEEP_MS = 7 * 24 * 60 * 60_000;
export const SESSION_DAYS_MAX = 90;

const WHO_OPENS: ReadonlySet<string> = new Set<AppWhoOpens>(["authors", "authors-testers", "users"]);

interface UserRow {
  id: string;
  issuer: string | null;
  sub: string | null;
  email: string;
  email_verified: number;
  name: string | null;
  role: string;
  tester: number;
  author: number;
  status: string;
  invited_by: string | null;
  created_at: string;
  last_seen_at: string | null;
  removed_at: string | null;
}

function userOf(row: Record<string, unknown>): AppUser {
  const r = row as unknown as UserRow;
  return {
    id: String(r.id),
    issuer: r.issuer === null ? null : String(r.issuer),
    sub: r.sub === null ? null : String(r.sub),
    email: String(r.email),
    emailVerified: Number(r.email_verified) === 1,
    name: r.name === null ? null : String(r.name),
    role: String(r.role),
    tester: Number(r.tester) === 1,
    author: Number(r.author) === 1,
    status: String(r.status) as AppUser["status"],
    invitedBy: r.invited_by === null ? null : String(r.invited_by),
    createdAt: String(r.created_at),
    lastSeenAt: r.last_seen_at === null ? null : String(r.last_seen_at),
    removedAt: r.removed_at === null ? null : String(r.removed_at),
  };
}

function bad(message: string): StoreError {
  return new StoreError(400, "bad_request", message);
}

/** An email as the list keeps it: trimmed and lower-cased. */
export function cleanEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) throw bad("`email` is an email address.");
  return email;
}

function cleanRole(value: unknown, field = "role"): string {
  const role = typeof value === "string" ? value.trim() : "";
  if (!ROLE_RE.test(role)) throw bad(`\`${field}\` is one of the app's roles: 1 to 60 letters, digits, spaces, dots, dashes or underscores.`);
  return role;
}

/** A name as an issuer sent it: kept, cut to fit. */
function identityName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().slice(0, NAME_MAX) || null;
}

function cleanName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw bad("`name` is text.");
  const name = value.trim();
  if (name.length > NAME_MAX) throw bad(`\`name\` is at most ${NAME_MAX} characters.`);
  return name || null;
}

/**
 * Whether someone may open a stage: the rule for each "who opens it". A row the edge made for an
 * author (`author`) opens a stage only while the person is one. Authors open every stage, whoever
 * else it opens for; a stage of its users also opens for the people someone put on the list.
 */
export function opensStage(whoOpens: AppWhoOpens, user: Pick<AppUser, "status" | "tester" | "author">, author: boolean): boolean {
  if (user.status !== "active") return false;
  switch (whoOpens) {
    case "authors":
      return author;
    case "authors-testers":
      return author || (user.tester && !user.author);
    case "users":
      return author || !user.author;
  }
}

/** Why `opensStage` said no, in the words a refusal page uses. */
function refusalOf(whoOpens: AppWhoOpens): AppAccessRefusal {
  return whoOpens === "authors" ? "authors_only" : whoOpens === "authors-testers" ? "testers_only" : "not_invited";
}

/** Whether the join rule lets someone with this verified email add themselves. */
function mayJoin(join: AppSignInBody["join"], email: string): AppAccessRefusal | null {
  if (join.mode === "link") return null;
  if (join.mode === "domains") {
    const domain = email.slice(email.lastIndexOf("@") + 1);
    return join.domains.some((d) => typeof d === "string" && d.trim().toLowerCase() === domain) ? null : "domain_not_listed";
  }
  return "not_invited";
}

function userById(core: StoreCore, id: string): AppUser | null {
  const row = core.sql.exec("SELECT * FROM _users WHERE id = ?", id).toArray()[0];
  return row ? userOf(row) : null;
}

function mustUser(core: StoreCore, id: unknown): AppUser {
  if (typeof id !== "string" || !/^usr_[0-9a-f]{24}$/.test(id)) throw bad("A person's id is usr_ and 24 hex digits.");
  const user = userById(core, id);
  if (!user) throw new StoreError(404, "app_user_not_found", "No one with this id is on the list.");
  return user;
}

/** The rows the last statement changed (a cursor's `rowsWritten` also counts index entries). */
function changed(core: StoreCore): number {
  return Number(core.sql.exec<{ n: number }>("SELECT changes() AS n").one().n);
}

/** Ends sessions: each one's end is now, so the cleanup that drops old ones finds it by its end. */
const END_SESSIONS = "UPDATE _sessions SET revoked_at = ?, expires_at = min(expires_at, ?) WHERE revoked_at IS NULL";

function endSessions(core: StoreCore, userId: string, now: string): number {
  core.sql.exec(`${END_SESSIONS} AND user_id = ?`, now, now, userId).toArray();
  return changed(core);
}

// ── The list, for the deployer's Users page and an app's own admin page ──────

export function listAppUsers(core: StoreCore): AppUser[] {
  return core.sql.exec("SELECT * FROM _users ORDER BY created_at, id").toArray().map((row) => userOf(row));
}

/** Invites one person. Someone removed is invited again; an author's own row becomes an invite's. */
export function inviteAppUser(core: StoreCore, by: string, body: AppUserInviteBody): AppUser {
  const email = cleanEmail(body?.email);
  const role = cleanRole(body?.role);
  const tester = body?.tester === true;
  const name = cleanName(body?.name);
  return core.transaction(() => {
    const existing = core.sql.exec("SELECT * FROM _users WHERE email = ?", email).toArray()[0];
    if (existing) {
      const user = userOf(existing);
      if (user.status !== "removed" && !user.author) throw new StoreError(409, "app_user_exists", `${email} is already on the list.`);
      // Someone removed comes back active if they ever signed in, invited if they never did.
      const status = user.status === "removed" ? (user.issuer ? "active" : "invited") : user.status;
      core.sql.exec(
        "UPDATE _users SET status = ?, role = ?, tester = ?, author = 0, name = coalesce(?, name), invited_by = ?, removed_at = NULL WHERE id = ?",
        status,
        role,
        tester ? 1 : 0,
        name,
        by,
        user.id,
      );
      return userById(core, user.id)!;
    }
    const id = core.newId("usr");
    core.sql.exec(
      "INSERT INTO _users (id, email, email_verified, name, role, tester, author, status, invited_by, created_at) VALUES (?, ?, 0, ?, ?, ?, 0, 'invited', ?, ?)",
      id,
      email,
      name,
      role,
      tester ? 1 : 0,
      by,
      core.nowIso(),
    );
    return userById(core, id)!;
  });
}

/** Changes a role, the tester mark, the name or the status. Removing someone ends their sessions at once. */
export function updateAppUser(core: StoreCore, userId: unknown, body: AppUserUpdateBody): AppUser {
  const patch = body ?? {};
  const role = patch.role === undefined ? undefined : cleanRole(patch.role);
  if (patch.tester !== undefined && typeof patch.tester !== "boolean") throw bad("`tester` is true or false.");
  const name = patch.name === undefined ? undefined : cleanName(patch.name);
  if (patch.status !== undefined && patch.status !== "active" && patch.status !== "removed") throw bad("`status` is active or removed.");
  return core.transaction(() => {
    const user = mustUser(core, userId);
    const now = core.nowIso();
    // A role or a tester mark someone sets makes an author's own row a listed person's.
    if (role !== undefined) core.sql.exec("UPDATE _users SET role = ?, author = 0 WHERE id = ?", role, user.id);
    if (patch.tester !== undefined) core.sql.exec("UPDATE _users SET tester = ?, author = 0 WHERE id = ?", patch.tester ? 1 : 0, user.id);
    if (name !== undefined) core.sql.exec("UPDATE _users SET name = ? WHERE id = ?", name, user.id);
    if (patch.status === "removed" && user.status !== "removed") {
      core.sql.exec("UPDATE _users SET status = 'removed', removed_at = ? WHERE id = ?", now, user.id);
      endSessions(core, user.id, now);
    } else if (patch.status === "active" && user.status === "removed") {
      // Back on the list: active again if they ever signed in, invited if they never did.
      core.sql.exec("UPDATE _users SET status = ?, removed_at = NULL WHERE id = ?", user.issuer ? "active" : "invited", user.id);
    }
    return userById(core, user.id)!;
  });
}

/** Signs someone out everywhere. */
export function signOutAppUser(core: StoreCore, userId: unknown): AppUserSignOutResult {
  return core.transaction(() => {
    const user = mustUser(core, userId);
    return { ended: endSessions(core, user.id, core.nowIso()) };
  });
}

// ── Signing in, and each request's session ─────────────────────────────────

function checkSignIn(body: AppSignInBody): void {
  const i = body?.identity;
  if (!i || typeof i.issuer !== "string" || !i.issuer || i.issuer.length > ISSUER_MAX) throw bad("A sign-in names its issuer.");
  if (typeof i.sub !== "string" || !i.sub || i.sub.length > SUB_MAX) throw bad("A sign-in names the person's subject at the issuer.");
  if (typeof i.emailVerified !== "boolean") throw bad("A sign-in says whether the issuer verified the email.");
  if (!WHO_OPENS.has(body.whoOpens)) throw bad("`whoOpens` is authors, authors-testers or users.");
  const join = body.join;
  if (!join || !["invited", "domains", "link"].includes(join.mode) || !Array.isArray(join.domains)) throw bad("`join` is { mode: invited | domains | link, domains }.");
  if (typeof body.author !== "boolean") throw bad("`author` is true or false.");
  const session = body.session;
  if (!session || typeof session.id !== "string" || !SESSION_ID_RE.test(session.id)) throw bad("A session's id is the 64 hex digits of its token's hash.");
  if (!Number.isFinite(session.days) || session.days <= 0 || session.days > SESSION_DAYS_MAX) throw bad(`A session lasts more than 0 and at most ${SESSION_DAYS_MAX} days.`);
}

/**
 * Signs a person in to the stage, or says why not, in one transaction. The rule decides before
 * anything is written: a refused sign-in changes nothing on the list.
 */
export function signInAppUser(core: StoreCore, body: AppSignInBody): AppSignInResult {
  checkSignIn(body);
  const identity = body.identity;
  const email = cleanEmail(identity.email);
  const name = identityName(identity.name);
  const defaultRole = cleanRole(body.defaultRole, "defaultRole");
  const authorRole = cleanRole(body.authorRole, "authorRole");
  return core.transaction((): AppSignInResult => {
    const sql = core.sql;
    const nowMs = core.deps.now();
    const now = new Date(nowMs).toISOString();
    const refuse = (reason: AppAccessRefusal, user: AppUser | null): AppSignInResult => ({ ok: false, reason, user });
    const byIdentity = sql.exec("SELECT * FROM _users WHERE issuer = ? AND sub = ?", identity.issuer, identity.sub).toArray()[0];
    let user = byIdentity ? userOf(byIdentity) : null;
    if (!user) {
      const byEmail = sql.exec("SELECT * FROM _users WHERE email = ?", email).toArray()[0];
      if (byEmail) {
        const held = userOf(byEmail);
        // The email is another sign-in's, or the issuer does not vouch for it: no link by email.
        if (held.issuer !== null) return refuse("email_in_use", null);
        if (!identity.emailVerified) return refuse("email_unverified", null);
        user = held;
      }
    }
    let joins: { role: string; author: boolean } | null = null;
    if (user) {
      if (user.status === "removed") return refuse("removed", user);
    } else if (body.author) {
      joins = { role: authorRole, author: true };
    } else if (body.whoOpens === "users") {
      if (!identity.emailVerified) return refuse("email_unverified", null);
      const notAllowed = mayJoin(body.join, email);
      if (notAllowed) return refuse(notAllowed, null);
      joins = { role: defaultRole, author: false };
    } else {
      return refuse(refusalOf(body.whoOpens), null);
    }
    // An invite becomes active as it signs in: the rule is asked about it as it would be then.
    if (!opensStage(body.whoOpens, user ? { ...user, status: "active" } : { status: "active", tester: false, author: joins!.author }, body.author)) {
      return refuse(refusalOf(body.whoOpens), user);
    }
    // An export reads `_users` and its indexes at different times, so while it holds the store a
    // sign-in may not change who a row is: someone new, or a person whose issuer or email moves,
    // tries again in a moment. Anyone else signs in as ever: only their session and last visit change.
    const exporting = heldBy(sql) === "export";
    const busy = () => new StoreError(409, "store_busy", "This store is writing its export. Try again in a moment.");
    let id: string;
    if (user) {
      id = user.id;
      // The email follows the issuer only where the issuer vouches for it and no one else on the
      // list holds it; otherwise the row keeps the one it had.
      let nextEmail = user.email;
      let verified = user.emailVerified;
      if (identity.emailVerified && email !== user.email.toLowerCase()) {
        const taken = sql.exec("SELECT 1 FROM _users WHERE email = ? AND id != ?", email, id).toArray().length > 0;
        if (!taken) nextEmail = email;
      }
      if (identity.emailVerified && nextEmail.toLowerCase() === email) verified = true;
      if (exporting && (identity.issuer !== user.issuer || identity.sub !== user.sub || nextEmail !== user.email)) throw busy();
      sql.exec(
        "UPDATE _users SET issuer = ?, sub = ?, email = ?, email_verified = ?, name = coalesce(?, name), status = 'active', last_seen_at = ? WHERE id = ?",
        identity.issuer,
        identity.sub,
        nextEmail,
        verified ? 1 : 0,
        name,
        now,
        id,
      );
    } else {
      if (exporting) throw busy();
      id = core.newId("usr");
      sql.exec(
        "INSERT INTO _users (id, issuer, sub, email, email_verified, name, role, tester, author, status, invited_by, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', NULL, ?, ?)",
        id,
        identity.issuer,
        identity.sub,
        email,
        identity.emailVerified ? 1 : 0,
        name,
        joins!.role,
        joins!.author ? 1 : 0,
        now,
        now,
      );
    }
    const expiresAt = new Date(nowMs + body.session.days * 24 * 60 * 60_000).toISOString();
    sql.exec("INSERT INTO _sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", body.session.id, id, now, expiresAt);
    // Sessions that stopped a while ago go, a few at a time, as new ones start. An ended session's
    // end is the moment it ended (END_SESSIONS), so the index on the end finds both kinds.
    sql.exec("DELETE FROM _sessions WHERE id IN (SELECT id FROM _sessions WHERE expires_at < ? LIMIT 50)", new Date(nowMs - SESSION_KEEP_MS).toISOString());
    return { ok: true, user: userById(core, id)!, session: { id: body.session.id, expiresAt } };
  });
}

/** A person's last-seen time, written at most every few minutes (each write is a row the store pays for). */
function noteSeen(core: StoreCore, user: AppUser): string | null {
  const nowMs = core.deps.now();
  const seen = user.lastSeenAt ? Date.parse(user.lastSeenAt) : 0;
  if (nowMs - seen < SEEN_EVERY_MS || heldBy(core.sql) !== null) return user.lastSeenAt;
  const lastSeenAt = new Date(nowMs).toISOString();
  core.sql.exec("UPDATE _users SET last_seen_at = ? WHERE id = ?", lastSeenAt, user.id);
  return lastSeenAt;
}

/** A request's session, with its person, and whether they may open the stage as an author and as anyone else. */
export function readAppSession(core: StoreCore, body: { id?: unknown; whoOpens?: unknown }): AppSessionResult {
  if (typeof body?.id !== "string" || !SESSION_ID_RE.test(body.id)) return { ok: false, reason: "no_session" };
  if (typeof body.whoOpens !== "string" || !WHO_OPENS.has(body.whoOpens)) throw bad("`whoOpens` is authors, authors-testers or users.");
  const whoOpens = body.whoOpens as AppWhoOpens;
  const sql = core.sql;
  const session = sql.exec<{ user_id: string; expires_at: string; revoked_at: string | null }>("SELECT user_id, expires_at, revoked_at FROM _sessions WHERE id = ?", body.id).toArray()[0];
  if (!session) return { ok: false, reason: "no_session" };
  if (session.revoked_at !== null) return { ok: false, reason: "ended" };
  const nowMs = core.deps.now();
  if (Date.parse(String(session.expires_at)) <= nowMs) return { ok: false, reason: "expired" };
  const user = userById(core, String(session.user_id));
  if (!user || user.status === "removed") return { ok: false, reason: "removed" };
  return {
    ok: true,
    user: { ...user, lastSeenAt: noteSeen(core, user) },
    expiresAt: String(session.expires_at),
    opens: { asAuthor: opensStage(whoOpens, user, true), asOther: opensStage(whoOpens, user, false) },
  };
}

/** The person a native client's token names (its issuer and `sub`), with no session: see `AppTokenUserResult`. */
export function readAppTokenUser(core: StoreCore, body: { issuer?: unknown; sub?: unknown; whoOpens?: unknown }): AppTokenUserResult {
  if (typeof body?.whoOpens !== "string" || !WHO_OPENS.has(body.whoOpens)) throw bad("`whoOpens` is authors, authors-testers or users.");
  const whoOpens = body.whoOpens as AppWhoOpens;
  if (typeof body.issuer !== "string" || !body.issuer || body.issuer.length > ISSUER_MAX) throw bad("`issuer` is the token's issuer.");
  if (typeof body.sub !== "string" || !body.sub || body.sub.length > SUB_MAX) throw bad("`sub` is the token's subject.");
  const user = findAppUser(core, { issuer: body.issuer, sub: body.sub });
  if (!user) return { ok: false, reason: "not_listed" };
  if (user.status === "removed") return { ok: false, reason: "removed" };
  return { ok: true, user: { ...user, lastSeenAt: noteSeen(core, user) }, opens: { asAuthor: opensStage(whoOpens, user, true), asOther: opensStage(whoOpens, user, false) } };
}

/** Ends one session: the person signed out on this browser. */
export function endAppSession(core: StoreCore, body: { id?: unknown }): { ended: boolean } {
  if (typeof body?.id !== "string" || !SESSION_ID_RE.test(body.id)) return { ended: false };
  return core.transaction(() => {
    const now = core.nowIso();
    core.sql.exec(`${END_SESSIONS} AND id = ?`, now, now, body.id).toArray();
    return { ended: changed(core) > 0 };
  });
}

/** One person, found by their sign-in or by their email. */
export function findAppUser(core: StoreCore, by: { issuer?: unknown; sub?: unknown; email?: unknown }): AppUser | null {
  if (typeof by?.issuer === "string" && typeof by.sub === "string") {
    const row = core.sql.exec("SELECT * FROM _users WHERE issuer = ? AND sub = ?", by.issuer, by.sub).toArray()[0];
    return row ? userOf(row) : null;
  }
  if (by?.email !== undefined) {
    const row = core.sql.exec("SELECT * FROM _users WHERE email = ?", cleanEmail(by.email)).toArray()[0];
    return row ? userOf(row) : null;
  }
  throw bad("Find a person by { issuer, sub } or by { email }.");
}
