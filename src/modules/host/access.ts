// What the `access.groups` ask answers: for each role on this HX Fortress, how
// many people hold it. Enterprise Compliance, a page on the control plane's
// side, asks it of each HX Fortress.
//
// TWO WAYS TO COUNT, decided by whether sign-in through the identity provider
// is in use (`oidcUsable`, on the settings oidc.json holds):
//
//   - "accounts": no identity provider in use. One row for each kind of
//     account (`operator`, `readonly`, `viewer`), with no group, counting the
//     accounts of that kind in users.json that are neither disabled nor
//     deleted.
//   - "sign-ins": the identity provider is in use, and it is the provider that
//     holds the list of who has a role. HX Fortress knows only the people who
//     signed in through it (provider-people.json). `since` is when the counts
//     became complete: the later of when that file was started and the last
//     change to the provider's settings, because a sign-in noted under another
//     provider or other groups may be missing from a row. A person counts
//     under the role their last sign-in, within the last 90 days and through
//     the provider in use now, gave them: the first of the four lists
//     (administrators, operators, auditors, viewers) that holds a group it
//     carried. So `seesRows` is true of everyone a row counts. `accounts`
//     says how many accounts on this HX Fortress can still sign in with a
//     password beside the provider; they are not in the rows.
//
//     With a groups claim that is a group claim (`groupClaim`), there is one
//     row for each group of the role's list, counting the people of that role
//     whose last sign-in carried it, and one row with no group and no people
//     for a list that is empty. With any other claim (`email`, a user name),
//     each "group" of the mapping is a person, so each role has one row, with
//     its group hidden, counting the people of that role.
//
// `holders` has each role once, counting each person once. A person in two
// groups of one role counts in both of its rows, so adding up rows can count
// a person twice; adding up `holders` never does.
//
// WHAT CROSSES. Roles, flags, counts, a time, and the names of groups: a
// group's name only when it may cross (`groupMayCross`). A row whose group may
// not cross says `groupHidden` instead. users.json is only counted, and
// provider-people.json holds only digests, so no row can hold a login, an
// address or a person's id.
//
// A file that cannot be read fails the ask with `access_unreadable`. The
// answer is never shorter than what the files hold, and never an error's own
// words.
//
// Pure, apart from the readers it is handed (`fileSources` for the daemon's).

import path from "node:path";

import type { fortressPaths } from "../../host/paths";
import { AskFailure } from "../../host/module-contract";
import { isName } from "../../host/shape";
import { OidcConfigStore, oidcUsable, type UiOidcConfig } from "../../ui/oidc-config";
import { groupKey, issuerKey, isRecent, ProviderPeopleStore, type PeopleRead } from "../../ui/provider-people";
import { seesRows, UI_ROLES, UsersStore, type UsersFile } from "../../ui/users";
import type { AccessRole, CountedFrom } from "./manifest";

/** One row of the answer. */
export interface AccessRow {
  role: AccessRole;
  /** The group's name at the identity provider, when it may cross. */
  group?: string;
  /** The row is for a group, or a role's people, whose name may not cross. */
  groupHidden?: true;
  seesRows: boolean;
  people: number;
}

/** How many people hold one role, each person counted once. */
export interface AccessHolders {
  role: AccessRole;
  seesRows: boolean;
  people: number;
}

export interface AccessView {
  roles: AccessRow[];
  /** Each role of `roles` once, each person counted once. */
  holders: AccessHolders[];
  countedFrom: CountedFrom;
  /** With "sign-ins": since when sign-ins are counted, when they are. */
  since?: string;
  /** With "sign-ins": accounts on this HX Fortress that can sign in with a
   *  password beside the provider. */
  accounts?: number;
}

export interface AccessSources {
  /** The settings oidc.json holds. Rejects when the file cannot be read. */
  oidc: () => Promise<UiOidcConfig>;
  /** users.json. Rejects when the file cannot be read. */
  accounts: () => Promise<UsersFile>;
  /** The people who signed in through the identity provider, as the file
   *  holds them. Rejects when provider-people.json cannot be read. */
  people: () => Promise<PeopleRead>;
  /** Injected in tests. */
  now?: () => Date;
}

type FortressPaths = ReturnType<typeof fortressPaths>;

/** The daemon's readers: the console's own files, read when the ask comes. */
export function fileSources(paths: FortressPaths): AccessSources {
  return {
    oidc: () => new OidcConfigStore(path.join(paths.uiRoot, "oidc.json")).load(),
    accounts: () => new UsersStore(path.join(paths.uiRoot, "users.json")).load(),
    people: () => new ProviderPeopleStore(paths.providerPeople).recent(),
  };
}

/**
 * Whether a groups claim is a claim of groups or roles, so the values it
 * carries are names of groups. Anything else (an address, a user name, an id)
 * makes each "group" of the mapping a person. Compared without regard to
 * letter case; a namespaced claim counts by its last part.
 */
export function groupClaim(claim: string): boolean {
  const lower = claim.toLowerCase();
  const last = lower.split(/[/:]/).pop() ?? lower;
  return ["groups", "group", "roles", "role", "memberof", "wids"].includes(last);
}

/** Whether a group's name may be sent: the groups claim is a group claim, the
 *  name is a `name` as an answer holds one, and it holds no "@", because an
 *  address can name a person. */
export function groupMayCross(config: UiOidcConfig, group: string): boolean {
  return groupClaim(config.groupsClaim) && isName(group) && !group.includes("@");
}

/** What a reader gave, or the ask's failure. Its error is not looked at: its
 *  words can hold a path, or a piece of the file. */
async function read<T>(reader: () => Promise<T>): Promise<T> {
  try {
    return await reader();
  } catch {
    throw new AskFailure("access_unreadable");
  }
}

/** Administrators are Operators in this build, and see what Operators see. */
function seesRowsOf(role: AccessRole): boolean {
  return seesRows(role === "administrator" ? "operator" : role);
}

/**
 * From when every row is complete: the later of when the file was started and
 * the last write of oidc.json (`epoch` is never lower than the time of that
 * write, in milliseconds). A change of provider leaves earlier sign-ins out,
 * and a group added to a list was not noted for people who signed in before it.
 * Any write counts, `ui oidc revoke` too: that can say fewer days than were
 * counted, never more. Never later than now: an epoch from a clock that ran
 * ahead says nothing more. A clock set back before a write can leave `since`
 * earlier than that write.
 */
function sinceOf(started: string | null, epoch: number, now: Date): string | undefined {
  if (started === null) return undefined;
  return new Date(Math.min(Math.max(Date.parse(started), epoch), now.getTime())).toISOString();
}

/** Accounts that can sign in: neither disabled nor deleted. */
function liveAccounts(file: UsersFile): UsersFile["users"] {
  return file.users.filter((user) => !user.disabledAt && !user.deletedAt);
}

/**
 * The answer. With `rows` false (an ask from another organization), only how
 * this HX Fortress counts: oidc.json is the one file read.
 */
export async function accessView(sources: AccessSources, options: { rows?: boolean } = {}): Promise<AccessView> {
  const config = await read(sources.oidc);
  const countedFrom: CountedFrom = oidcUsable(config) ? "sign-ins" : "accounts";
  if (options.rows === false) return { roles: [], holders: [], countedFrom };

  if (countedFrom === "accounts") {
    const accounts = liveAccounts(await read(sources.accounts));
    const rows = UI_ROLES.map((role) => ({
      role,
      seesRows: seesRows(role),
      people: accounts.filter((user) => user.role === role).length,
    }));
    // An account has one kind, so each row is a role, counted once.
    return { roles: rows, holders: rows.map((row) => ({ ...row })), countedFrom };
  }

  const now = sources.now?.() ?? new Date();
  const [held, accounts] = await Promise.all([read(sources.people), read(sources.accounts)]);
  const lists: ReadonlyArray<readonly [AccessRole, readonly string[]]> = [
    ["administrator", config.administratorGroups],
    ["operator", config.operatorGroups],
    ["readonly", config.readonlyGroups],
    ["viewer", config.viewerGroups],
  ];
  const keysOf = lists.map(([, groups]) => new Set(groups.map(groupKey)));
  // Set whenever the provider is in use (`oidcUsable`).
  const issuer = issuerKey(config.issuer ?? "");

  // Each person under the role their last sign-in gave them: the first list
  // that holds one of its groups. Counted per role, and per group of it.
  const perRole = lists.map(() => 0);
  const perGroup = new Map<string, number>();
  for (const seen of held.people) {
    if (seen.issuer !== issuer || !isRecent(seen, now)) continue;
    const at = keysOf.findIndex((keys) => seen.groups.some((group) => keys.has(group)));
    if (at < 0) continue;
    perRole[at] = (perRole[at] ?? 0) + 1;
    for (const group of new Set(seen.groups)) {
      // eslint-disable-next-line security/detect-object-injection
      if (keysOf[at]?.has(group)) perGroup.set(`${at} ${group}`, (perGroup.get(`${at} ${group}`) ?? 0) + 1);
    }
  }

  const roles: AccessRow[] = [];
  const byGroup = groupClaim(config.groupsClaim);
  lists.forEach(([role, groups], at) => {
    if (groups.length === 0) {
      roles.push({ role, seesRows: seesRowsOf(role), people: 0 });
      return;
    }
    if (!byGroup) {
      // Each "group" is a person: one row for the role, and no name.
      // eslint-disable-next-line security/detect-object-injection
      roles.push({ role, groupHidden: true, seesRows: seesRowsOf(role), people: perRole[at] ?? 0 });
      return;
    }
    for (const group of groups) {
      roles.push({
        role,
        ...(groupMayCross(config, group) ? { group } : { groupHidden: true as const }),
        seesRows: seesRowsOf(role),
        people: perGroup.get(`${at} ${groupKey(group)}`) ?? 0,
      });
    }
  });
  const holders = lists.map(([role], at) => ({
    role,
    seesRows: seesRowsOf(role),
    // eslint-disable-next-line security/detect-object-injection
    people: perRole[at] ?? 0,
  }));
  const since = sinceOf(held.since, config.epoch, now);
  return {
    roles,
    holders,
    countedFrom,
    ...(since ? { since } : {}),
    accounts: liveAccounts(accounts).length,
  };
}
