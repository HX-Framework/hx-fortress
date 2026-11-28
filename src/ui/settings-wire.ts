// What the console's Settings page and its routes agree on: the four paths,
// and the shapes of what they answer.
//
// The page is built from this file and the server answers with it, so the two
// cannot drift apart. It imports nothing from Node, and only types from the
// setup, which the page reads as it is: the console's build bundles whatever a
// page reaches, and a shape that sat beside a file read would pull the disk in.

import type { StepId } from "../setup/list";
import type { SetupDerived, SetupState, StepCheck } from "../setup/view";

export const SETTINGS_PATHS = {
  read: "/ui/api/settings",
  check: "/ui/api/settings/check",
  save: "/ui/api/settings/save",
  installId: "/ui/api/settings/install-id",
} as const;

export interface ConnectionShown {
  /** `connected`, `connecting`, `offline`, `closing`, or `unknown` when the
   *  daemon's status cannot be read or is too old to trust. */
  state: string;
  /** The daemon's one word for why it is not connected, when it gives one. */
  reason: string | null;
  /** True when the control plane refused the connection: the daemon is
   *  offline, and gives a reason other than having no control plane. That is
   *  when a new one-time install id is asked for. */
  refused: boolean;
  /** True when a new one-time install id was kept and waits for HX Fortress's
   *  next start. */
  idWaiting: boolean;
}

/** What the Settings page is given. */
export interface SettingsState extends Pick<SetupState, "frame" | "answers" | "derived"> {
  sections: readonly StepId[];
  connection: ConnectionShown;
  /** True when a save from this session asks for the current code from the
   *  person's authenticator app. */
  asksCode: boolean;
  /** True when this session came in through the identity provider and its
   *  sign-in is older than the pass: a save asks the person to sign in again. */
  asksSignIn: boolean;
  /** For each section, a digest of its saved answers. A save sends its
   *  section's digest and is refused when the saved answers changed since. */
  versions: Partial<Record<StepId, string>>;
}

/** What a check of one section answers. */
export interface SettingsChecked {
  derived: SetupDerived;
  check: StepCheck;
}

/** What a save, or a new install id, answers. */
export type SettingsSaved =
  | { saved: true; changed: StepId[]; restart: StepId[]; notes: string[]; state: SettingsState }
  | { saved: false; checks: StepCheck[] }
  | { saved: false; codeNeeded: string }
  /** This session came in through the identity provider, and its sign-in is
   *  older than the pass. The sentence says to sign in again. */
  | { saved: false; signInNeeded: string }
  /** The saved answers of this section changed since the page read them.
   *  Nothing was saved. */
  | { saved: false; stale: string };
