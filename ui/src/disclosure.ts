// What this console shows, and what it does not — stated in one place.
//
// It is a MODULE rather than a constant because the same claim has to appear as
// a two-word inline label under a number, as one line inside an identity
// popover, and as two sentences in a footer read before anyone has signed in.
// One string cannot be all three, and three hand-written strings drift: the
// footer was corrected once and the popover was not, so the console said two
// different things about the same boundary on the same screen.
//
// So there is ONE canonical sentence, and every short form below is DERIVED from
// its parts. Changing what the console shows means changing SUBJECT or EXCLUSION
// here, and every site changes with it.
//
// A grep gate asserts that no claim of this shape exists anywhere else in
// ui/src, and a self-test asserts the gate matches every literal this module
// publishes — a gate that cannot match its own subject matter would pass while
// protecting nothing.

/** What the console holds. Titles are content-DERIVED and are named as such:
 *  a title may quote a first message or summarize the conversation, and calling
 *  it plain metadata would be the comfortable lie. */
const SUBJECT = "session metadata and derived titles";

/** What it never holds. The claim the whole boundary rests on. */
const EXCLUSION = "never transcript bodies";

/** The long form. Everything below is this sentence, said shorter. */
export const DISCLOSURE_CANONICAL = `This console shows ${SUBJECT} — ${EXCLUSION}.`;

/** One line, inside the identity popover. */
export const DISCLOSURE_INLINE = `${SUBJECT} — ${EXCLUSION}`;

/** Two sentences, in the footer that renders before sign-in. */
export const DISCLOSURE_FOOTER: readonly [string, string] = [
  `This console is served from the fortress itself and shows ${SUBJECT}.`,
  "Transcript bodies rest in the organization's bucket and never appear here.",
];

/** The tail of a page lede, lower-cased to continue a sentence. */
export const DISCLOSURE_LEDE_TAIL = `this console shows ${SUBJECT} — ${EXCLUSION}`;

/** The two-word label under a count. Short enough to sit inline, which is why it
 *  cannot be the canonical sentence and why the detail below travels with it. */
export const DISCLOSURE_STAT_LABEL = "metadata only";

/** What the label expands to when someone asks. */
export const DISCLOSURE_STAT_DETAIL =
  "Titles, counts, sizes, timestamps and storage locations, mirrored into this fortress's own " +
  "database. Transcript bodies rest in the bucket and never appear here.";

/** What a title IS, on the one view that renders titles. Stated wherever a title
 *  is shown, because a reader who assumes a title is machine-generated metadata
 *  will draw the wrong conclusion about what left the transcript. */
export const DISCLOSURE_TITLE_TRUTH =
  "Titles — which may quote the first message or be a model-written summary of the conversation — " +
  `counts and locations; ${EXCLUSION}.`;

/** The lede of the session list. */
export const DISCLOSURE_SESSIONS_LEDE =
  `Every session this fortress holds. ${DISCLOSURE_TITLE_TRUTH}`;

/** Under a person's recent sessions. */
export const DISCLOSURE_PEOPLE_NOTE =
  `Newest sessions attributed to this person — titles and counts, ${EXCLUSION}.`;

/** The session-detail boundary panel. Ends on the canonical sentence so the
 *  strongest statement is the last thing read. */
export const DISCLOSURE_BOUNDARY =
  "No text, no excerpts, no previews: the transcript rests in the organization's bucket, readable " +
  `only through the tools the organization authorizes. ${DISCLOSURE_CANONICAL}`;

/** On the adoption surface, which renders a directory of people this fortress
 *  did not compile. Naming its origin is the point: an operator reading names,
 *  addresses and teams should know they came from let.ai and are replaced whole
 *  on every sync, not accumulated here. */
export const DISCLOSURE_ROSTER_NOTE =
  "The roster is people-data let.ai reports for this organization — names, addresses and team " +
  "membership. It is stored here so this page can be answered without asking the cloud, it is " +
  "replaced whole on every sync, and members who leave are removed on the retention the Data paths " +
  "panel states.";

/**
 * Every literal this module publishes.
 *
 * The self-test walks this list and asserts the grep gate matches each one. It
 * is the reason the gate can be trusted as a gate: a pattern that misses its own
 * canonical language would pass over a page that dropped the claim entirely.
 */
export const DISCLOSURE_LITERALS: readonly string[] = [
  DISCLOSURE_CANONICAL,
  DISCLOSURE_INLINE,
  // The footer is two sentences at one site, so it is one literal: the claim
  // lives in the second, and enumerating the halves separately would ask the
  // gate to match a sentence that never appears alone.
  DISCLOSURE_FOOTER.join(" "),
  DISCLOSURE_LEDE_TAIL,
  DISCLOSURE_STAT_LABEL,
  DISCLOSURE_STAT_DETAIL,
  DISCLOSURE_TITLE_TRUTH,
  DISCLOSURE_SESSIONS_LEDE,
  DISCLOSURE_PEOPLE_NOTE,
  DISCLOSURE_BOUNDARY,
];
