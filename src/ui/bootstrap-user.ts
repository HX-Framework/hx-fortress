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

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { checkLogin, setupUrl, type UsersStore } from "./users";

export interface BootstrapUserRequest {
  login: string;
  /** When the supervisor wrote it — printed, so a link in a log can be aged. */
  requestedAt: string;
}

export function bootstrapRequestPath(uiRoot: string): string {
  return path.join(uiRoot, "bootstrap-user.json");
}

/** Where the first account's setup link is left, 0600, for somebody with access
 *  to the box to read. */
export function bootstrapLinkPath(uiRoot: string): string {
  return path.join(uiRoot, "bootstrap-setup-link.txt");
}

/** Write the request. 0600 under the console's own directory: it names an
 *  account, and an account name is not something the rest of the box needs. */
export async function writeBootstrapRequest(
  file: string,
  login: string,
  now = new Date(),
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const request: BootstrapUserRequest = { login, requestedAt: now.toISOString() };
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
    if (typeof login !== "string" || !login) return null;
    return { login, requestedAt: typeof requestedAt === "string" ? requestedAt : "" };
  } catch {
    return null;
  }
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
}): Promise<BootstrapUserResult> {
  const { login } = args.request;
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
