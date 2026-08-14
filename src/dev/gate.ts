// Who may run the `dev` verbs, and the two answers that are always no.
//
// The seed writes a fabricated world: people who do not work here, sessions
// nobody had, tombstones for deletions nobody performed. On a fortress that is
// serving an organization, that world is indistinguishable from the real one
// once it is in the database — it would land in adoption figures, in residency
// verdicts and in a compliance report, and nothing in the corpus is marked as
// synthetic at the row level because rows have no such column.
//
// So the gate refuses twice, on facts rather than on intent: the verbs exist
// only when the build says it is a development build, and they refuse outright
// on a fortress that holds cloud credentials. Both are checked, in that order,
// and the refusals name what to do instead.

import { parseBooleanEnv } from "../env";

/** The opt-in. Absent on every release binary anyone ships. */
export const DEV_ENV_VAR = "FORTRESS_DEV";

export type DevGateVerdict = { ok: true } | { ok: false; reason: string };

export interface DevGateInput {
  env: Record<string, string | undefined>;
  /** True when this host holds cloud credentials — the fortress belongs to an
   *  organization and is (or has been) serving it. */
  enrolled: boolean;
}

export const DEV_DISABLED_REFUSAL =
  `the dev verbs are not part of a release build — set ${DEV_ENV_VAR}=1 to enable them ` +
  `on a development fortress. They write a fabricated corpus, and there is no way to tell ` +
  `seeded rows from real ones once they are in the database.`;

export const DEV_ENROLLED_REFUSAL =
  "this fortress is enrolled to an organization — refusing to seed. Seeded people, sessions " +
  "and tombstones would be counted as real by adoption, residency and every compliance report. " +
  "Run the seed on an unenrolled development fortress (a separate FORTRESS_ROOT is enough).";

export function devGateVerdict(input: DevGateInput): DevGateVerdict {
  if (!parseBooleanEnv(input.env[DEV_ENV_VAR])) return { ok: false, reason: DEV_DISABLED_REFUSAL };
  // Checked SECOND on purpose: a release build must not answer "you are enrolled",
  // which would confirm the fortress's state to whoever ran the verb.
  if (input.enrolled) return { ok: false, reason: DEV_ENROLLED_REFUSAL };
  return { ok: true };
}
