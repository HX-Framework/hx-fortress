// What a screen of the setup is given, as types.
//
// The setup's browser page, the terminal and the console's Settings page draw
// from the same shapes. They live here, in a file with no code and no Node in
// it, so the console's own build can import them as they are.

import type { SetupAnswers } from "./answers";
import type { LAST_STEP, PlaceId, StepId, Way } from "./list";
import type { ReachRow } from "./reach";

export type { ReachRow } from "./reach";

// ── A check's result ─────────────────────────────────────────────────────────

export interface CheckLine {
  ok: boolean;
  /** One plain sentence, with no full stop at its end. */
  text: string;
  /** The answer the line is about. A line with a path shows at that field; a
   *  line without one shows under the step. */
  path?: string;
  /** True for a line that says something is not right and still lets the
   *  setup go on: an address that did not answer from here, for one. */
  soft?: boolean;
  /** Set on the line that refuses a place until this computer is signed in to
   *  it. A screen offers Check Again beside it. */
  needs?: "signIn";
}

export interface StepCheck {
  step: StepId;
  /** False while a line refuses the answer. */
  ok: boolean;
  lines: CheckLine[];
}

// ── What the setup found ─────────────────────────────────────────────────────

export interface Fact {
  label: string;
  value: string;
  /** A few words beside the value. */
  note: string;
  /** True: as it should be. False: something to look at. Null: nothing to judge. */
  ok: boolean | null;
  /** The value is a path, a version or an id. */
  mono?: boolean;
}

// ── What a screen draws ──────────────────────────────────────────────────────

export interface ModuleRow {
  id: string;
  title: string;
  summary: string;
}

/** One place of the first page, as this computer sees it. */
export interface PlaceRow {
  id: PlaceId;
  /** False: this build cannot make HX Fortress there. */
  offered: boolean;
  /** Who this computer is signed in as there, in a few words. Empty when it
   *  is not signed in, and for a place that needs no sign-in. */
  signedInAs: string;
  /** True for a place this computer must be signed in to. */
  needsSignIn: boolean;
  /** The command that signs this computer in. */
  signInCommand: string;
}

/** One line of the last step: one thing the answers make. */
export interface PlanRow {
  id: string;
  label: string;
  value: string;
}

/** What the last step shows before a person says yes. */
export interface PlanShown {
  /** Where it is made, in a few words: "In your Azure, East US 2". */
  heading: string;
  rows: PlanRow[];
}

/** How far the last step is. */
export interface Progress {
  stage: "asking" | "making" | "done" | "failed";
  /** The ids of the rows that are made, in order. */
  made: string[];
  /** The row being made now. */
  now: string | null;
  /** While the last step waits for a DNS record: the record a person makes. */
  dns: { name: string; target: string } | null;
  /** Why it stopped, in one sentence, and the row it stopped at. */
  failure: { row: string; text: string } | null;
}

/** Everything a screen draws that is worked out from the answers. */
export interface SetupDerived {
  reach: ReachRow[];
  summary: Record<StepId, string>;
  needsFiles: boolean;
  places: PlaceRow[];
  plan: PlanShown;
  /** The key fields for which a person typed the key itself, by path. The
   *  keys themselves never come back. */
  typed: string[];
  /** The facts that follow the answers. */
  facts: { install: Fact[]; files: Fact[]; controlPlane: Fact[]; thisInstall: Fact[] };
}

/** What does not change while a person answers. */
export interface SetupFrame {
  way: Way;
  modules: ModuleRow[];
  facts: { host: Fact[]; auditTrail: Fact[]; updates: Fact[] };
  /** Answers this host's environment decides: path, and the variable. */
  pinned: Record<string, string>;
  /** False on an HX Fortress that has never been set up. */
  setUp: boolean;
  /** The words of the last step. */
  last: (typeof LAST_STEP)["install"];
}

/** What the setup's last screen is given once everything is made. */
export interface SetupDone {
  /** Where HX Fortress answers. */
  address: string;
  /** The first administrator's one-time link to set a password, when the setup
   *  made that account. */
  firstAccount: { login: string; link: string } | null;
  notes: string[];
  /** One sentence: what a person does next. Empty when Open is all there is. */
  next: string;
}

/** What the setup's server answers a page with. */
export interface SetupState {
  frame: SetupFrame;
  answers: SetupAnswers;
  derived: SetupDerived;
  progress: Progress;
  /** Set once the last step has finished. */
  done: SetupDone | null;
}
