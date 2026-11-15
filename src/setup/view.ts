// What a screen of the setup is given, as types.
//
// The browser setup's pages and the terminal draw from the same shapes. They
// live here, in a file with no code and no Node in it, so the console's own
// build can import them as they are.

import type { SetupAnswers } from "./answers";
import type { SetupStep, StepId } from "./list";
import type { ReachRow } from "./reach";

export type { ReachRow } from "./reach";

// ── A check's result ─────────────────────────────────────────────────────────

export interface CheckLine {
  ok: boolean;
  /** One plain sentence, with no full stop at its end. */
  text: string;
  /** The answer the line is about. A line with a path shows beside that
   *  field; a line without one shows under the step. */
  path?: string;
  /** True for a line that says something is not right and still lets the
   *  setup go on: an address that did not answer from here, for one. */
  soft?: boolean;
  /** Set on the line that refuses a control plane until a person has signed
   *  in there. A screen offers the sign-in beside it. */
  needs?: "enrollment";
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

/** What a control plane may ask of one module, when that module is on. */
export interface AskRow {
  module: string;
  title: string;
  on: boolean;
  /** The names of the asks, as the module's manifest lists them. */
  asks: string[];
  /** One sentence for a module whose traffic is not a list of asks. */
  note: string;
}

/** An enrollment, as a person sees it. The enrollment token is never part of it. */
export interface EnrollmentShown {
  state: "none" | "waiting" | "ready" | "expired" | "refused";
  /** The short code a person compares on both screens and confirms. */
  code: string;
  /** The control plane's page where the person signs in, and that page's host. */
  signInAt: string;
  signInHost: string;
  reason: string;
  /** How many seconds the control plane wants between two asks whether the
   *  person has signed in. 0 when no code is waiting. */
  interval: number;
  /** The control plane's key, when one can be shown: its id and fingerprint. */
  key: { id: string; fingerprint: string } | null;
}

/** Everything a screen draws that is worked out from the answers. */
export interface SetupDerived {
  reach: ReachRow[];
  asks: AskRow[];
  summary: Record<StepId, string>;
  /** The answers as a settings file. */
  file: string;
  needsFiles: boolean;
  enrollment: EnrollmentShown;
}

/** What does not change while a person answers. */
export interface SetupFrame {
  list: SetupStep[];
  modules: ModuleRow[];
  facts: { host: Fact[]; records: Fact[]; updates: Fact[] };
  /** Answers this host's environment decides: path, and the variable. */
  pinned: Record<string, string>;
  /** False on a Fortress that has never been set up. */
  setUp: boolean;
}

/** What the setup's last screen is given once everything is written. */
export interface SetupDone {
  /** Where the console answers once the Fortress is started. */
  consoleAddress: string;
  /** The first administrator's account, when the setup made it: its one-time
   *  link to set a password, or, for an account made for a link that was
   *  minted where HX Fortress was installed, no link and the sentence that
   *  says where the link is. */
  firstAccount:
    | { login: string; link: string; elsewhere?: undefined }
    | { login: string; link: null; elsewhere: string }
    | null;
  notes: string[];
  summary: Record<StepId, string>;
  /** One sentence: how the Fortress gets started from here. */
  next: string;
}

/** What the setup's server answers a page with. */
export interface SetupState {
  frame: SetupFrame;
  answers: SetupAnswers;
  derived: SetupDerived;
}
