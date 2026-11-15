// FORTRESS_UI_BOOTSTRAP_USER — the first console account on a container that
// nobody can run a CLI verb inside yet.
//
// The variable is read by the SUPERVISOR and acted on by the CONSOLE, and the
// two are connected by a one-shot request file rather than by the environment
// they both already carry. The environment is present on every respawn; a
// console that acted on it directly would re-run the bootstrap after every crash
// and every `ui disable` flip, printing a fresh setup link into the container
// log each time. The request is written once per container boot, consumed as it
// is read, and gone.
//
// AN EXISTING LOGIN IS NEVER RESET HERE. On the second boot of a persistent
// volume the account already exists, so `ui user create` on it fails — and the
// answer is not to create it harder. Resetting it would mean anyone who can
// restart the container can mint a setup link for a live operator account, which
// is a takeover with a redeploy as its only prerequisite. The bootstrap says
// what the operator would have to run, and does nothing.
//
// FORTRESS_UI_BOOTSTRAP_TOKEN_DIGEST, beside the login, moves the link off this
// host entirely. The install mints the setup token on the computer it runs on,
// keeps the link there, and hands HX Fortress only the token's sha256 and, in
// FORTRESS_UI_BOOTSTRAP_TOKEN_EXPIRES, the time the link stops working. The
// account is made with that digest as its one setup token, and no link file is
// written, because there is no link here to write. It is honoured only on an
// HX Fortress with no account at all: whoever can set a container's environment
// must not be able to give themselves an operator account, by a link only they
// hold, on one that already has administrators. Both ride the same one-shot
// request as the login, for the same reason the login does.

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { checkLogin, checkSetupDigest, checkSetupEnd, setupUrl, type UsersStore } from "./users";

/** Where an install puts the digest of a setup token it minted itself. */
export const BOOTSTRAP_TOKEN_DIGEST_ENV = "FORTRESS_UI_BOOTSTRAP_TOKEN_DIGEST";
/** Where it puts the time that link stops working: an ISO 8601 time, set by
 *  whoever minted the token. Required beside the digest. */
export const BOOTSTRAP_TOKEN_EXPIRES_ENV = "FORTRESS_UI_BOOTSTRAP_TOKEN_EXPIRES";

export interface BootstrapUserRequest {
  login: string;
  /** When the supervisor wrote it — printed, so a link in a log can be aged. */
  requestedAt: string;
  /** The sha256 of a setup token minted elsewhere, as the environment held it.
   *  Absent when the environment held none, or held it empty: the console then
   *  mints the link. */
  tokenDigest?: string;
  /** When that link stops working, as the environment held it. */
  tokenExpires?: string;
}

export function bootstrapRequestPath(uiRoot: string): string {
  return path.join(uiRoot, "bootstrap-user.json");
}

/** Where the first account's setup link is left, 0600, for somebody with access
 *  to the box to read. The name holds no login. */
export function bootstrapLinkPath(uiRoot: string): string {
  return path.join(uiRoot, "bootstrap-setup-link.txt");
}

/** Write the request. 0600 under the console's own directory: it names an
 *  account, and an account name is not something the rest of the box needs. */
export async function writeBootstrapRequest(
  file: string,
  login: string,
  now = new Date(),
  /** As the environment held them. Written as they are, so the console is the
   *  one place that judges them. An empty digest counts as not set. */
  link: { tokenDigest?: string; tokenExpires?: string } = {},
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const request: BootstrapUserRequest = {
    login,
    requestedAt: now.toISOString(),
    ...(link.tokenDigest ? { tokenDigest: link.tokenDigest } : {}),
    ...(link.tokenDigest && link.tokenExpires !== undefined ? { tokenExpires: link.tokenExpires } : {}),
  };
  await writeFile(file, `${JSON.stringify(request)}\n`, { mode: 0o600 });
}

/** Read and UNLINK in one step, so a respawn finds nothing. A malformed or
 *  absent file is simply no request. */
export async function consumeBootstrapRequest(file: string): Promise<BootstrapUserRequest | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  await unlink(file).catch(() => {});
  try {
    const parsed: unknown = JSON.parse(raw);
    const login = (parsed as { login?: unknown }).login;
    const requestedAt = (parsed as { requestedAt?: unknown }).requestedAt;
    const tokenDigest = (parsed as { tokenDigest?: unknown }).tokenDigest;
    const tokenExpires = (parsed as { tokenExpires?: unknown }).tokenExpires;
    if (typeof login !== "string" || !login) return null;
    // An empty digest is no digest. One that is present and not text is a
    // digest of the wrong shape, and is refused rather than read as none.
    const digest =
      tokenDigest === undefined || tokenDigest === "" ? undefined : typeof tokenDigest === "string" ? tokenDigest : "-";
    return {
      login,
      requestedAt: typeof requestedAt === "string" ? requestedAt : "",
      ...(digest !== undefined ? { tokenDigest: digest } : {}),
      ...(digest !== undefined && typeof tokenExpires === "string" ? { tokenExpires } : {}),
    };
  } catch {
    return null;
  }
}

/** An ISO 8601 time with its offset, to the minute, the second or a fraction
 *  of one: what an install writes. Anything looser is refused rather than
 *  guessed at, and so is a time of one of these shapes that does not parse. */
const ISO_TIMES = [
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/,
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/,
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}(?:Z|[+-]\d{2}:\d{2})$/,
];

/** The time a minted link stops working, or why it cannot be used. */
export function readSetupEnd(raw: string | undefined, now: Date): { ok: true; at: Date } | { ok: false; reason: string } {
  const text = raw?.trim() ?? "";
  if (!text) return { ok: false, reason: `${BOOTSTRAP_TOKEN_EXPIRES_ENV} is not set` };
  const at = new Date(text);
  if (!ISO_TIMES.some((shape) => shape.test(text)) || !Number.isFinite(at.getTime())) {
    return { ok: false, reason: `${BOOTSTRAP_TOKEN_EXPIRES_ENV} is not an ISO 8601 time with its offset` };
  }
  const problem = checkSetupEnd(at, now);
  return problem ? { ok: false, reason: `${BOOTSTRAP_TOKEN_EXPIRES_ENV}: ${problem}` } : { ok: true, at };
}

/** What a setup link that was minted somewhere else amounts to here. */
export type MintedLink =
  /** The environment holds no digest: the link is minted here, as before. */
  | { use: "none" }
  /** Nothing is made. `said` is whole sentences that name the variable and
   *  never repeat the digest. */
  | { use: "refused"; because: "accounts" | "unusable"; said: string }
  | { use: "digest"; digest: string; end: Date };

/**
 * The one rule for a digest in FORTRESS_UI_BOOTSTRAP_TOKEN_DIGEST, for the
 * console's own first account and for the account the setup makes.
 *
 * Only on an HX Fortress with no account at all, live, disabled or deleted. A
 * link minted elsewhere ends when its minter said, and no more than a day
 * ahead of this clock. Without that, or with a digest of the wrong shape,
 * nothing is made: falling back to minting a link here would leave the person
 * holding the install's link with one that works nowhere. Both problems are
 * named at once, so one restart fixes both.
 */
export function judgeMintedLink(args: {
  tokenDigest: string | undefined;
  tokenExpires: string | undefined;
  /** How many accounts users.json holds: live, disabled and deleted. */
  accounts: number;
  now: Date;
}): MintedLink {
  // An empty digest is no digest, at every step it passes through.
  const tokenDigest = args.tokenDigest?.trim() || undefined;
  if (tokenDigest === undefined) return { use: "none" };
  if (args.accounts > 0) {
    return {
      use: "refused",
      because: "accounts",
      said:
        `${BOOTSTRAP_TOKEN_DIGEST_ENV} is ignored: this HX Fortress already has console accounts, and an ` +
        "account is made from a minted link only on one that has none. No account was made.",
    };
  }
  const end = readSetupEnd(args.tokenExpires, args.now);
  const problems = [checkSetupDigest(tokenDigest), end.ok ? null : end.reason].filter(
    (problem): problem is string => problem !== null,
  );
  if (!end.ok || problems.length > 0) {
    return {
      use: "refused",
      because: "unusable",
      said: `${BOOTSTRAP_TOKEN_DIGEST_ENV} is not usable: ${problems.join("; ")}. No account was made.`,
    };
  }
  return { use: "digest", digest: tokenDigest, end: end.at };
}

export interface BootstrapUserResult {
  /** Lines for the boot log, in order. Never empty when a request was found. */
  lines: string[];
  created: boolean;
}

/**
 * Apply one request against the user store.
 *
 * THE LINK IS NOT PRINTED. It is a live 24-hour credential for an operator
 * account, and this console's stdout is pid 1's stdout in a container — which is
 * the log aggregator, where a secret is retained, indexed and searchable by
 * everyone who can read logs. It goes to a 0600 file under the console's own
 * directory instead, and what is printed is the path: reading it needs access to
 * the box, which is the same bar the terminal path already sets.
 */
export async function applyBootstrapUser(args: {
  request: BootstrapUserRequest;
  users: UsersStore;
  /** The base the setup link is built on — the console's own printed URL. */
  base: string;
  /** Where to leave the link, 0600. */
  linkFile: string;
  now?: () => Date;
  /** Records an account made from a minted link's digest. Never handed the
   *  digest. */
  record?: (account: { login: string; role: string }) => Promise<void>;
}): Promise<BootstrapUserResult> {
  const { login, tokenExpires } = args.request;
  // An empty digest is no digest, at every step it passes through.
  const tokenDigest = args.request.tokenDigest?.trim() || undefined;
  const invalid = checkLogin(login);
  if (invalid) {
    return { created: false, lines: [`FORTRESS_UI_BOOTSTRAP_USER is not a usable login: ${invalid}`] };
  }
  const now = args.now?.() ?? new Date();
  const file = await args.users.load();
  // A TOMBSTONE COUNTS. Matching only live users let a soft-deleted login fall
  // through to `create`, which rebuilds the list with `.filter(u => u.login !==
  // login)` and drops the tombstone the users file documents as load-bearing —
  // so an operator removed for cause was restored with a fresh 24-hour setup
  // link on the next container redeploy, and the trail could no longer resolve
  // the removal.
  const existing = file.users.find((user) => user.login === login);
  if (existing) {
    // `ui user create` would fail here, and resetting on a redeploy is a
    // takeover, so the command is printed rather than run.
    return {
      created: false,
      lines: existing.deletedAt
        ? [
            `console account ${login} was removed on ${existing.deletedAt} — not re-creating it`,
            `if that removal is to be undone, do it deliberately: hx-fortress ui user create ${login} --role operator`,
          ]
        : [
            `console account ${login} already exists — leaving it alone`,
            `to issue a fresh setup link: hx-fortress ui user reset ${login}`,
          ],
    };
  }
  const minted = judgeMintedLink({ tokenDigest, tokenExpires, accounts: file.users.length, now });
  if (minted.use === "refused") {
    return {
      created: false,
      lines:
        minted.because === "accounts"
          ? [minted.said]
          : [
              minted.said,
              `fix the variables and restart, or make the account here: hx-fortress ui user create ${login} --role operator`,
            ],
    };
  }
  if (minted.use === "digest") {
    await args.users.createWithSetupDigest(login, "operator", minted.digest, minted.end, now);
    await args.record?.({ login, role: "operator" });
    return {
      created: true,
      lines: [
        `created console account ${login} (operator)`,
        "its setup link was made where HX Fortress was installed, and only the link's digest is here: " +
          "open that link to set the password",
        `the link works until ${minted.end.toISOString()}; after that, hx-fortress ui user reset ${login}`,
      ],
    };
  }
  const created = await args.users.create(login, "operator", now);
  await mkdir(path.dirname(args.linkFile), { recursive: true, mode: 0o700 });
  await writeFile(args.linkFile, `${setupUrl(args.base, created.token)}\n`, { mode: 0o600 });
  return {
    created: true,
    lines: [
      `created console account ${login} (operator)`,
      `finish setup: the link is in ${args.linkFile} (0600) — it is a live credential and is deliberately not printed here`,
      "the link expires in 24 hours; after that, hx-fortress ui user reset " + login,
    ],
  };
}
