// What an organization's id looks like, and how an audit record says whose it
// is. Its own file, with no imports, so the audit spool and the pure parts of
// the module host can use it without pulling the filesystem in.

/** An organization's id: 1 to 64 characters of a to z, 0 to 9 and "-", starting
 *  with a letter or a digit. Lower case only, so that two ids can never differ
 *  by case alone: on a file system that ignores case they would share a folder. */
export const ORGANIZATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isOrganizationId(value: unknown): value is string {
  return typeof value === "string" && ORGANIZATION_ID_PATTERN.test(value);
}

/** One organization, as the host and a module's context know it. */
export interface Organization {
  /**
   * What this Fortress keys the organization's data by.
   *
   * For another organization it is the id a grant names it by. For the
   * Fortress's own it is an id this Fortress made itself, the first time
   * something read it, and keeps in a file from then on. It is not the id a
   * grant uses for this organization, and the host puts it in no answer and no
   * record.
   */
  readonly id: string;
  /** True for the organization that runs this Fortress. */
  readonly own: boolean;
}

/**
 * The mark an organization's audit records carry: its id, or null for the
 * Fortress's own, whose records carry none.
 *
 * `own` is read first, so asking this about the own organization never makes
 * it an id.
 */
export function organizationMark(organization: Organization): string | null {
  return organization.own ? null : organization.id;
}

/**
 * The parameter an audit record names another organization by. A record of the
 * Fortress's own organization has no such parameter.
 *
 * NO CALLER SETS IT. The spool writes it from the `organization` a record is
 * appended with, after it has dropped whatever the record's own parameters
 * held under this name. So it is never a string a module or the other side
 * chose, and it does not depend on any action's list of parameters.
 *
 * Its own word, and not `org`: the console's sign-in and command records carry
 * an `org` that means something else, and those records are the own
 * organization's.
 */
export const ORGANIZATION_PARAM = "organization";

/**
 * Whose a record is, read from its parameters: another organization's id, or
 * null for the Fortress's own.
 *
 * Only a valid id counts. Anything else under the name (a number, an empty
 * string, text that is not an id) is no organization's mark, and the record is
 * the own organization's. The reader in SQL applies the same rule.
 */
export function organizationOfParams(params: unknown): string | null {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  if (!Object.hasOwn(params, ORGANIZATION_PARAM)) return null;
  const mark = (params as Record<string, unknown>)[ORGANIZATION_PARAM];
  return isOrganizationId(mark) ? mark : null;
}

/** The record cannot be written: it was given a mark that is not an id. */
export class OrganizationMarkInvalid extends Error {
  constructor() {
    super("an audit record was given an organization that is not an organization's id");
    this.name = "OrganizationMarkInvalid";
  }
}

/**
 * A record's parameters as they are written: without anything the caller put
 * under the reserved name, and with the mark when the record is another
 * organization's.
 *
 * THROWS for a mark that is not an id. A record with its mark left out would be
 * read as the own organization's, so the record is not written at all.
 */
export function withOrganization(
  params: Record<string, unknown> | null,
  organization: string | null | undefined,
): Record<string, unknown> | null {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    // A caller's own key, copied to an object this function made.
    // eslint-disable-next-line security/detect-object-injection
    if (key !== ORGANIZATION_PARAM) rest[key] = value;
  }
  if (organization === null || organization === undefined) {
    return Object.keys(rest).length === 0 ? null : rest;
  }
  if (!isOrganizationId(organization)) throw new OrganizationMarkInvalid();
  return { ...rest, [ORGANIZATION_PARAM]: organization };
}
