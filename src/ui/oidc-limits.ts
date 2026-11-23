// How long a role's list of the identity provider's groups can be.
//
// A module of its own, with no imports, so that the audit trail's rules can
// name the longest list a record must hold without loading the provider's
// settings and what they read.

/** The most groups one role's list holds. The `host` module's
 *  `access.groups` answer has a row for each, and its manifest's cap on rows
 *  is four times this: a test ties the two. */
export const MAX_GROUPS = 50;

/** The longest name of one group. */
export const MAX_GROUP_CHARS = 256;

/** The longest one list can be as text: its names, with a comma between two.
 *  A record of a change to a list holds this much of it, so that no cut can
 *  hide a group. */
export const MAX_GROUP_LIST_CHARS = MAX_GROUPS * (MAX_GROUP_CHARS + 1);
