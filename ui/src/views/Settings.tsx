import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import "../setup.css";
import "../settings.css";

import { cloneAnswers, setAnswer, settleAnswers, wordsOf, type SetupAnswers } from "../../../src/setup/answers";
import { isPlaceId, SETUP_LIST, visibleList, type SetupStep, type StepId } from "../../../src/setup/list";
import type { CheckLine, SetupDerived, StepCheck } from "../../../src/setup/view";
import { READONLY_REFUSAL_COPY } from "../../../src/ui/copy";
import { api, type SettingsSaved, type SettingsState } from "../api";
import { ViewLoading } from "../components";
import { useApp, useOperator } from "../state";
import { CopyButton, Spinner, StepControls, Words, type SetHow } from "./setup/blocks";
import { PanelMotion } from "./settings/motion";
import {
  installIdShown,
  canChange,
  CONNECT_COMMAND,
  CONNECTED_UNTIL_START,
  ID_WAITS,
  NOT_CONNECTED,
  connectionLine,
  controlPlaneNow,
  carried,
  changedOf,
  differs,
  pathsOf,
  SAVED_ELSEWHERE,
  savedAs,
  sentAnswers,
  switchWords,
  unitsOf,
  withEdits,
  type Edits,
} from "./settings/sections";
import { WorldPicture } from "./settings/WorldPicture";

/** A section of the page: a step of the setup's list, or the facts of this
 *  install. */
type Open = StepId | "install";

/** Where a save came from: a section's footer, or the control plane's new
 *  install id. */
type SaveFrom = StepId | "installId";

/** The code a save asks for, while it is asked. `said` is the server's
 *  sentence. */
interface CodeAsk {
  from: SaveFrom;
  said: string;
  /** True once a code was sent and refused. */
  refused: boolean;
}

/** What the last save of a section left to say. */
interface AfterSave {
  restart: boolean;
  notes: string[];
}

/** The line a save of this section leaves when HX Fortress reads the
 *  section only when it starts. */
const TAKES_EFFECT_AT_START = "Takes effect when HX Fortress starts again.";

/** How long a save may take before the page gives it up. A save that checks
 *  the database and the file store in full can take more than 30 s, and it
 *  may wait behind another save. */
const SAVE_WAIT_MS = 90_000;

/** Said where a save was asked, when it did not answer in time. */
const SAVE_NO_ANSWER = "The save did not answer in time. The settings were read again.";

/** Said in a footer before a save, when a save from this session asks the
 *  person to sign in again first (`asksSignIn`). */
const SIGN_IN_FIRST = "A save asks you to sign in again first";

/** The facts of this install, drawn as a step of their own. It is not a step
 *  of the list: nothing in it is asked. */
const THIS_INSTALL: SetupStep = {
  id: "where",
  name: "This install",
  question: "",
  asked: ["settings"],
  blocks: [
    { kind: "facts", source: "thisInstall" },
    // True of an HX Fortress made by `hx-fortress install` and of one set up on
    // its machine alike: in a container, its host is the container.
    { kind: "note", text: "To change one of these, run `hx-fortress setup` on its host." },
  ],
};

const CHEVRON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 3.5L10.5 8 6 12.5" />
  </svg>
);

/** A section's name as the list gives it, for a line about it shown elsewhere. */
function sectionName(id: StepId): string {
  return SETUP_LIST.find((step) => step.id === id)?.name ?? id;
}

function refuses(line: CheckLine): boolean {
  return !line.ok && !line.soft;
}

/** Words that stand alone as a sentence: a capital letter first, and a full
 *  stop at the end. */
function asSentence(text: string): string {
  const trimmed = text.trim();
  const first = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

/** The lines a refused save shows under its section about another section,
 *  led by that section's name. */
const ABOUT_ANOTHER = new WeakSet<CheckLine>();

/**
 * The save lines once a save of `id` has answered. The section's own lines
 * are replaced by what its answer says (by the caller). Another section keeps
 * its own lines, its field refusals among them, until it is saved or
 * discarded. A line it shows about a third section, from an earlier save of
 * its own, goes: what it was about may be what this save changed.
 */
function answeredFor(id: StepId): (was: Partial<Record<StepId, CheckLine[]>>) => Partial<Record<StepId, CheckLine[]>> {
  return (was) => {
    const out: Partial<Record<StepId, CheckLine[]>> = {};
    for (const section of Object.keys(was) as StepId[]) {
      if (section === id) continue;
      const kept = (was[section] ?? []).filter((line) => !ABOUT_ANOTHER.has(line));
      if (kept.length > 0) out[section] = kept;
    }
    return out;
  };
}

/** A record without one section's entry. */
function withoutKey<T>(was: Partial<Record<StepId, T>>, id: StepId): Partial<Record<StepId, T>> {
  if (!(id in was)) return was;
  const out = { ...was };
  delete out[id];
  return out;
}

/** Every path each section asks, for one state: what a save of it may write. */
function sectionPaths(state: SettingsState): Partial<Record<StepId, string[]>> {
  const place = isPlaceId(state.answers.where.place) ? state.answers.where.place : "here";
  const modules = state.frame.modules.map((module) => module.id);
  const out: Partial<Record<StepId, string[]>> = {};
  for (const step of visibleList({ way: "settings", place, words: wordsOf(state.answers) })) {
    out[step.id] = pathsOf(step, modules);
  }
  return out;
}

/** The answers of each section that mean something only together, for one
 *  state (`unitsOf`). */
function sectionUnits(state: SettingsState): Partial<Record<StepId, string[][]>> {
  const place = isPlaceId(state.answers.where.place) ? state.answers.where.place : "here";
  const out: Partial<Record<StepId, string[][]>> = {};
  for (const step of visibleList({ way: "settings", place, words: wordsOf(state.answers) })) {
    out[step.id] = unitsOf(step);
  }
  return out;
}

/** A control by its `data-fid`, as a selector. */
function byFid(fid: string): string {
  return `[data-fid="${CSS.escape(fid)}"]`;
}

/** The controls that can hold the keyboard for one answer of a section, in
 *  the order they are looked for: its field, its menu, its switch, its
 *  module, or the chosen option or tile of its choice. */
function controlsOf(id: StepId, path: string): string[] {
  const panel = `[data-k="sec-${id}"]`;
  const module = path.startsWith("modules.") ? [byFid(`mod:${path.slice("modules.".length)}`)] : [];
  return [
    byFid(`in:${path}`),
    byFid(`menu:${path}`),
    byFid(`cbx:${path}`),
    ...module,
    `[data-fid^="${CSS.escape(`${path}:`)}"][tabindex="0"]`,
  ].map((selector) => `${panel} ${selector}`);
}

/** Six digits, or what a person has typed of them. A code field has no
 *  length of its own: a code pasted as "123 456" is seven characters, and a
 *  field cut at six would lose its last digit before this saw it. */
function digits(text: string): string {
  return text.replace(/\D/g, "").slice(0, 6);
}

/**
 * The console's Settings page: what an administrator can change from a
 * browser, one section at a time.
 *
 * Every section is a step of the setup's own list, asked the `settings` way,
 * and its controls are the setup's (`StepControls`): the page holds no
 * question, option or label of its own. A section keeps the answers a person
 * changed in it apart from every other section, checks them as they are typed
 * and when a field is left, and grows a footer while they differ from what
 * HX Fortress holds: Save sends that section alone, Discard forgets it. A
 * check asks nothing outside HX Fortress; the check that does is a save's own,
 * after the code. A read-only session sees everything and changes nothing.
 */
export default function Settings(): React.ReactElement {
  const app = useApp();
  const active = app.view === "settings";
  const operator = useOperator();
  // The server's words, as a sentence: they also stand alone under a section.
  const readOnly = operator ? undefined : asSentence(READONLY_REFUSAL_COPY);

  const [state, setState] = useState<SettingsState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const [edits, setEdits] = useState<Partial<Record<StepId, Edits>>>({});
  const [derivedOf, setDerivedOf] = useState<Partial<Record<StepId, SetupDerived>>>({});
  const [checks, setChecks] = useState<Partial<Record<StepId, StepCheck>>>({});
  // The refusals a person was shown when a save was refused. A line goes when
  // the answer it is about changes.
  const [alerts, setAlerts] = useState<Partial<Record<StepId, CheckLine[]>>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [after, setAfter] = useState<Partial<Record<StepId, AfterSave>>>({});
  const [code, setCode] = useState<CodeAsk | null>(null);
  // What is typed in each code field: a section's footer has one, and so
  // does the new install id. Each keeps its own.
  const [codes, setCodes] = useState<Partial<Record<SaveFrom, string>>>({});
  const [saving, setSaving] = useState<SaveFrom | null>(null);
  const [failed, setFailed] = useState<{ from: SaveFrom; text: string } | null>(null);
  // While a new install id waits for the next start, the person asked to
  // give another one.
  const [anotherId, setAnotherId] = useState(false);
  // A save that came too late: the section's saved answers had changed since
  // the page read them. Its sentence stays under the section until the
  // section changes again, or another save answers.
  const [stale, setStale] = useState<Partial<Record<StepId, string>>>({});
  // A change that was dropped because someone else saved its answer
  // meanwhile: a line under its field, until the field changes again or the
  // section is saved or discarded.
  const [elsewhere, setElsewhere] = useState<Partial<Record<StepId, CheckLine[]>>>({});
  // A save was answered that this session must sign in again first. The
  // footer says so until a read says it is not asked any more.
  const [signInWanted, setSignInWanted] = useState(false);

  const stateRef = useRef(state);
  stateRef.current = state;
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const codeRef = useRef(code);
  codeRef.current = code;
  const codesRef = useRef(codes);
  codesRef.current = codes;
  const setCodeOf = useCallback((from: SaveFrom, text: string): void => {
    setCodes((was) => ((was[from] ?? "") === text ? was : { ...was, [from]: text }));
  }, []);
  const savingRef = useRef(saving);
  savingRef.current = saving;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  // While a dialog is open over the page (the keyboard shortcuts), the
  // page's keys do nothing: Escape is the dialog's.
  const keysOff = useRef(app.shortcutsOpen);
  keysOff.current = app.shortcutsOpen;

  // Every check takes the next number, and a section shows the reply to its
  // latest one. `checked` is the change count each section's last check was
  // asked for.
  const asked = useRef(0);
  const latestFor = useRef<Partial<Record<StepId, number>>>({});
  const changes = useRef<Partial<Record<StepId, number>>>({});
  const checked = useRef<Partial<Record<StepId, number>>>({});
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Reads and saves in the order they happen: a read that was asked before a
  // save answered is older than that save's answers.
  const clock = useRef(0);
  const savedAt = useRef(0);
  // The changes a save sent that did not answer in time, or failed, by
  // section: an answer of them found saved is the person's own. Kept until a
  // read shows them saved, or the person changes or discards the section, or
  // saves it.
  const unanswered = useRef<Partial<Record<StepId, Edits>>>({});
  // The save on its way, by the section it writes, and what it sends there:
  // the section's changes, or for a new install id the connection switched
  // on.
  const inFlight = useRef<{ section: StepId; sent: Edits } | null>(null);
  // What a section's changes were made against, while a read that came during
  // its save left it as it was.
  const heldBase = useRef<Partial<Record<StepId, SetupAnswers>>>({});
  // Where the keyboard goes once the next change is drawn: selectors, tried
  // in order.
  const focusWant = useRef<string[] | null>(null);
  // A newer state came while the install id's block held the keyboard.
  const installIdHeld = useRef(false);
  const view = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const installIdInput = useRef<HTMLInputElement | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  // The control of this page that last held the keyboard, by its `data-fid`.
  const lastFocus = useRef<string | null>(null);
  // A newer state from HX Fortress, worked into the page: see `adopt`, below.
  const adoptRef = useRef<(next: SettingsState) => void>(() => {});
  // Try Again takes the keyboard once, when it appears: a stable callback,
  // so a later draw of the page does not take it back.
  const retryShown = useCallback((button: HTMLButtonElement | null): void => {
    button?.focus();
  }, []);

  // ── Reading ────────────────────────────────────────────────────────────────
  // On every arrival, what HX Fortress holds now. The first time, the page
  // opens its first section and that section's header holds the keyboard.
  // On a return, the page stands as it was left: the same section open, the
  // keyboard on the control that held it, and changes not saved kept. The
  // read that answers then changes neither.
  const load = useCallback(async (first: boolean): Promise<void> => {
    const readAt = (clock.current += 1);
    try {
      const next = await api.settings();
      // A save that answered after this read was asked holds newer answers.
      if (savedAt.current > readAt) return;
      setLoadError(null);
      adoptRef.current(next);
      if (first && activeRef.current) {
        const head: Open = next.sections[0] ?? "install";
        setOpen((was) => was ?? head);
        focusWant.current = [byFid(`acc:${head}`)];
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useLayoutEffect(() => {
    if (!active) return;
    const back = stateRef.current !== null;
    if (back) {
      // A return: the keyboard goes back where it was, at once.
      const within = view.current;
      const head = openRef.current;
      for (const selector of [
        ...(lastFocus.current ? [byFid(lastFocus.current)] : []),
        ...(head ? [byFid(`acc:${head}`)] : []),
        '[data-fid^="acc:"]',
      ]) {
        const control = within?.querySelector<HTMLElement>(selector);
        if (control) {
          control.focus();
          break;
        }
      }
    }
    void load(!back);
  }, [active, load]);

  useEffect(
    () => () => {
      if (typingTimer.current) clearTimeout(typingTimer.current);
    },
    [],
  );

  // The keyboard's place, once the change it follows is drawn: the first of
  // the controls asked for that is on the page.
  useLayoutEffect(() => {
    const want = focusWant.current;
    const watched = installIdHeld.current;
    installIdHeld.current = false;
    if (!active) return;
    const within = view.current ?? document;
    const first = (selectors: readonly string[]): boolean => {
      for (const selector of selectors) {
        const control = within.querySelector<HTMLElement>(selector);
        if (control) {
          control.focus();
          return true;
        }
      }
      return false;
    };
    if (want) {
      focusWant.current = null;
      if (first(want)) return;
    }
    // A newer state took away the install id's field or its button while it
    // held the keyboard: the keyboard goes to the connection's switch.
    if (watched && (document.activeElement === null || document.activeElement === document.body)) {
      first([byFid("cbx:controlPlane.connected"), byFid("acc:controlPlane")]);
    }
  });

  const place = state && isPlaceId(state.answers.where.place) ? state.answers.where.place : "here";

  /** One section as the list shows it, for the answers it would save. */
  const stepOf = useCallback(
    (id: StepId, answers: SetupAnswers): SetupStep | null =>
      visibleList({ way: "settings", place, words: wordsOf(answers) }).find((step) => step.id === id) ?? null,
    [place],
  );

  /** Every path a section asks: what a save of it may write. */
  const pathsFor = useMemo(() => (state ? sectionPaths(state) : {}), [state]);
  const pathsRef = useRef(pathsFor);
  pathsRef.current = pathsFor;

  // ── Checks ─────────────────────────────────────────────────────────────────
  const runCheck = useCallback(async (id: StepId): Promise<void> => {
    const now = stateRef.current;
    const own = editsRef.current[id];
    if (!now || !own || readOnlyRef.current) return;
    const mine = (asked.current += 1);
    latestFor.current[id] = mine;
    checked.current[id] = changes.current[id] ?? 0;
    // This check covers the answers as they are now: one that waits for a
    // pause in the typing would only repeat it.
    if (typingTimer.current) {
      clearTimeout(typingTimer.current);
      typingTimer.current = null;
    }
    try {
      const answer = await api.settingsCheck(id, withEdits(now.answers, own));
      // A reply to an ask that a later one overtook, or for changes that were
      // saved or forgotten meanwhile, says nothing about what is shown now.
      if (latestFor.current[id] !== mine || !editsRef.current[id]) return;
      setDerivedOf((was) => ({ ...was, [id]: answer.derived }));
      setChecks((was) => {
        const next = { ...was };
        if (answer.check) next[id] = answer.check;
        else delete next[id];
        return next;
      });
      setPending(new Set());
    } catch {
      if (checked.current[id] === (changes.current[id] ?? 0)) delete checked.current[id];
    }
  }, []);

  /** A field was left: its last change is checked now rather than after the
   *  pause in the typing. */
  const checkIfChanged = useCallback(
    (id: StepId): void => {
      if (editsRef.current[id] && checked.current[id] !== (changes.current[id] ?? 0)) void runCheck(id);
    },
    [runCheck],
  );

  /** Forget what a section was told: its checks, its refusals, its code. */
  const forgetSaid = useCallback((id: StepId): void => {
    const without = <T,>(was: Partial<Record<StepId, T>>): Partial<Record<StepId, T>> => {
      if (!(id in was)) return was;
      const next = { ...was };
      delete next[id];
      return next;
    };
    setDerivedOf(without);
    setChecks(without);
    setAlerts(without);
    setPending(new Set());
    if (codeRef.current?.from === id) setCode(null);
    setCodeOf(id, "");
    setFailed((was) => (was?.from === id ? null : was));
  }, [setCodeOf]);

  /**
   * Sections' changes, carried onto a newer state from the answers they were
   * made against. A change stays only where that saved answer did not move:
   * where someone else saved it meanwhile, the change goes, its field shows
   * what is saved now, and a line under the field says why (`carried`). An
   * answer that moved to exactly what this page itself sent, in a save on its
   * way or one that did not answer, is the person's own: the change it covers
   * goes with no line. A section whose changes are all gone, or all match
   * what is saved, loses its footer. Every section that keeps changes is
   * checked again, against the new state.
   */
  const carry = useCallback(
    (next: SettingsState, ids: readonly StepId[], before: SetupAnswers | null): void => {
      const paths = sectionPaths(next);
      const units = sectionUnits(next);
      const nextEdits = { ...editsRef.current };
      const gone: StepId[] = [];
      const moved: Partial<Record<StepId, string[]>> = {};
      for (const id of ids) {
        const base = heldBase.current[id] ?? before;
        delete heldBase.current[id];
        const own = editsRef.current[id];
        if (!own) continue;
        const late = unanswered.current[id];
        const flying = inFlight.current?.section === id ? inFlight.current.sent : undefined;
        const sent = late || flying ? { ...late, ...flying } : undefined;
        const result = base
          ? carried(base, next.answers, own, paths[id] ?? [], units[id] ?? [], sent)
          : { kept: changedOf(next.answers, withEdits(next.answers, own), paths[id] ?? []), moved: [], quiet: [] };
        // What a save that did not answer sent is kept until a read shows it
        // saved.
        if (late && savedAs(next.answers, late)) delete unanswered.current[id];
        if (result.moved.length > 0) moved[id] = result.moved;
        if (Object.keys(result.kept).length > 0) nextEdits[id] = result.kept;
        else {
          delete nextEdits[id];
          gone.push(id);
        }
      }
      if (Object.keys(moved).length > 0) {
        setElsewhere((was) => {
          const out = { ...was };
          for (const id of Object.keys(moved) as StepId[]) {
            const paths = moved[id] ?? [];
            out[id] = [
              ...(was[id] ?? []).filter((line) => !paths.includes(line.path ?? "")),
              ...paths.map((path): CheckLine => ({ ok: false, soft: true, path, text: SAVED_ELSEWHERE })),
            ];
          }
          return out;
        });
      }
      editsRef.current = nextEdits;
      setEdits(nextEdits);
      for (const id of gone) {
        // Its footer goes: a keyboard that was in it goes to its header.
        const held = document.activeElement;
        if (held instanceof HTMLElement && held.closest(`[data-gone-with="${id}"]`)) focusWant.current = [byFid(`acc:${id}`)];
        forgetSaid(id);
      }
      for (const id of ids) if (nextEdits[id]) void runCheck(id);
    },
    [forgetSaid, runCheck],
  );

  /**
   * A newer state from HX Fortress: after a save, or a read. Each section's
   * changes are carried onto it (`carry`), and each section takes its digest.
   * A section whose save is on its way is left as it is, and keeps what its
   * changes were made against: that save's own answer (`answered`) works the
   * newer state into it, or, when the save saves nothing, the page does once
   * it ends (`afterFlight`). So a read never takes the person's own save for
   * someone else's.
   */
  const adopt = useCallback(
    (next: SettingsState, answered?: StepId): void => {
      const before = stateRef.current;
      // The install id's block may go with this state; if it holds the
      // keyboard, the next draw finds it a home (see the keyboard's place).
      const held = document.activeElement;
      if (held instanceof HTMLElement && held.closest(".st-install-id")) installIdHeld.current = true;
      setState(next);
      stateRef.current = next;
      // Whether a save asks this session to sign in again is the newest
      // read's to say. A state that leaves it out says no.
      setSignInWanted(next.asksSignIn === true);
      pathsRef.current = sectionPaths(next);
      const flying = inFlight.current?.section;
      const ids = (Object.keys(editsRef.current) as StepId[]).filter((id) => {
        if (id !== flying || id === answered) return true;
        if (before && heldBase.current[id] === undefined) heldBase.current[id] = before.answers;
        return false;
      });
      carry(next, ids, before?.answers ?? null);
    },
    [carry],
  );

  /** A save ended with nothing saved, or no answer: a section that a read
   *  left as it was meanwhile is carried now onto what the page holds. */
  const afterFlight = useCallback(
    (section: StepId): void => {
      const now = stateRef.current;
      if (now && heldBase.current[section] !== undefined) carry(now, [section], null);
    },
    [carry],
  );
  adoptRef.current = adopt;

  const change = useCallback(
    (id: StepId, path: string, value: string | boolean, how: SetHow): void => {
      const now = stateRef.current;
      if (!now || readOnlyRef.current) return;
      // While a section saves, its controls take no change: the reply is
      // about the answers that were sent, and nothing else.
      if (savingRef.current === id) return;
      const paths = pathsRef.current[id] ?? [];
      const was = withEdits(now.answers, editsRef.current[id]);
      const next = cloneAnswers(was);
      if (!setAnswer(next, path, value)) return;
      if (path === "model.provider") settleAnswers(next, path);
      // A save given up sent the section as it was: from here on, the
      // section's changes are no longer what it sent.
      if (differs(was, next, paths)) delete unanswered.current[id];
      const changed = differs(now.answers, next, paths);
      const first = editsRef.current[id] === undefined;
      const nextEdits = { ...editsRef.current };
      if (changed) nextEdits[id] = changedOf(now.answers, next, paths);
      else delete nextEdits[id];
      editsRef.current = nextEdits;
      setEdits(nextEdits);
      changes.current[id] = (changes.current[id] ?? 0) + 1;
      const without = <T,>(was: Partial<Record<StepId, T>>): Partial<Record<StepId, T>> => {
        if (!was[id]) return was;
        const kept = { ...was };
        delete kept[id];
        return kept;
      };
      setAfter(without);
      setStale(without);
      setFailed((was) => (was?.from === id ? null : was));
      // The field is changed again: what was said of it goes.
      setElsewhere((was) => {
        const lines = was[id];
        if (!lines?.some((line) => line.path === path)) return was;
        return { ...was, [id]: lines.filter((line) => line.path !== path) };
      });
      if (!changed) {
        // Back to what is saved: nothing to check, nothing to say.
        forgetSaid(id);
        return;
      }
      // The section's first change: read the settings again in the
      // background, so what a save will ask (a new sign-in, for one, once its
      // five minutes ran out while the page was open) is said before Save.
      if (first) void load(false);
      setPending((was) => new Set(was).add(path));
      setAlerts((was) => {
        const lines = was[id];
        if (!lines || lines.length === 0) return was;
        return { ...was, [id]: how === "pick" ? [] : lines.filter((line) => line.path !== undefined && line.path !== path) };
      });
      if (typingTimer.current) clearTimeout(typingTimer.current);
      if (how === "type") {
        typingTimer.current = setTimeout(() => {
          typingTimer.current = null;
          void runCheck(id);
        }, 300);
      } else {
        typingTimer.current = null;
        void runCheck(id);
      }
    },
    [runCheck, forgetSaid, load],
  );

  // ── Saving ─────────────────────────────────────────────────────────────────
  /** The keyboard goes back to the section's header when the control that
   *  held it is about to go. */
  const homeWhenGone = (id: StepId): void => {
    const held = document.activeElement;
    if (held instanceof HTMLElement && held.closest(`[data-gone-with="${id}"]`)) focusWant.current = [byFid(`acc:${id}`)];
  };

  const take = useCallback(
    (from: SaveFrom, answer: SettingsSaved, codeSent: boolean): void => {
      const id: StepId = from === "installId" ? "controlPlane" : from;
      // A section's save answers in its footer. Once the footer is gone, the
      // changes it was about are gone too, and a refusal of them says nothing.
      if (from !== "installId" && !answer.saved && !editsRef.current[from]) return;
      if ("codeNeeded" in answer) {
        setCode({ from, said: answer.codeNeeded, refused: codeSent });
        setCodeOf(from, "");
        // An install id is not kept once sent, so it is pasted again first.
        focusWant.current = [byFid(from === "installId" ? "in:install-id" : `code:${from}`)];
        return;
      }
      if ("signInNeeded" in answer) {
        // Nothing was saved: the person signs in again first. The sentence
        // shows where the save was asked, with no code field.
        if (codeRef.current?.from === from) setCode(null);
        setCodeOf(from, "");
        setFailed({ from, text: answer.signInNeeded });
        // The footer keeps saying so after the next change, until a read
        // says the sign-in is no longer asked; the read starts now.
        setSignInWanted(true);
        void load(false);
        focusWant.current = [byFid(from === "installId" ? "save:installId" : `save:${from}`), byFid(`acc:${id}`)];
        return;
      }
      if ("stale" in answer) {
        // Nothing was saved: the section's saved answers changed since the
        // page read them. The sentence shows under the section, the page
        // reads the settings again, and the person's changes stay where they
        // still differ from what is saved now.
        if (codeRef.current?.from === from) setCode(null);
        setCodeOf(from, "");
        setAlerts(answeredFor(id));
        setStale((was) => ({ ...was, [id]: answer.stale }));
        void load(false);
        return;
      }
      if (answer.saved) {
        homeWhenGone(id);
        if (from === "installId") {
          // The id is kept for the next start: the field gives way to the
          // line that says so, and to the way to give another id.
          setAnotherId(false);
          focusWant.current = [byFid("another:install-id"), byFid("in:install-id"), byFid(`acc:${id}`)];
        }
        savedAt.current = clock.current += 1;
        if (from !== "installId") {
          const nextEdits = { ...editsRef.current };
          delete nextEdits[id];
          editsRef.current = nextEdits;
          delete unanswered.current[id];
          delete heldBase.current[id];
        }
        forgetSaid(id);
        setElsewhere((was) => {
          if (!was[id]) return was;
          const kept = { ...was };
          delete kept[id];
          return kept;
        });
        // Every other section's changes, worked out again from what was saved;
        // for a new install id, this section's too.
        adopt(answer.state, id);
        setAlerts(answeredFor(id));
        setStale((was) => withoutKey(was, id));
        setCode(null);
        setCodeOf(from, "");
        setAfter((was) => ({ ...was, [id]: { restart: answer.restart.includes(id), notes: answer.notes } }));
        return;
      }
      // Refused. A line about this section shows at its field; a line about
      // another one shows under this section, where the save was asked, led
      // by the name of the section it is about.
      const own = answer.checks.find((check) => check.step === id);
      const lines = answer.checks.flatMap((check) =>
        check.lines.filter(refuses).map((line): CheckLine => {
          if (check.step === id) return line;
          const about: CheckLine = { ok: line.ok, text: `${sectionName(check.step)}: ${line.text}` };
          ABOUT_ANOTHER.add(about);
          return about;
        }),
      );
      setChecks((was) => {
        const next = { ...was };
        if (own) next[id] = own;
        return next;
      });
      // This save's lines, in place of its section's earlier ones.
      setAlerts((was) => ({ ...answeredFor(id)(was), [id]: lines }));
      setStale((was) => withoutKey(was, id));
      setCode(null);
      setCodeOf(from, "");
      // The refusal is shown where the save was asked: the section opens, so
      // its lines can be read even when the save came from a closed one's
      // footer. The keyboard goes to the first control a line refuses, or to
      // the Save that was pressed.
      setOpen(id);
      const path = lines.find((line) => line.path)?.path;
      focusWant.current = [
        ...(path ? controlsOf(id, path) : []),
        byFid(from === "installId" ? "in:install-id" : `save:${id}`),
        byFid(`acc:${id}`),
      ];
    },
    [forgetSaid, adopt, setCodeOf, load],
  );

  /** A save that failed: the code it carried is spent, so the code step ends
   *  and its field is emptied, and the failure's sentence shows where the
   *  code was. The keyboard goes to the Save that was pressed, or for a new
   *  install id to its field, which takes the id again: but only from inside
   *  that section, or from nowhere. A save can take long, and the person may
   *  be at work in another section meanwhile. */
  const failedSave = useCallback(
    (from: SaveFrom, err: unknown): void => {
      if (from !== "installId" && !editsRef.current[from]) return;
      if (codeRef.current?.from === from) setCode(null);
      setCodeOf(from, "");
      setFailed({ from, text: err instanceof Error ? err.message : String(err) });
      const section: StepId = from === "installId" ? "controlPlane" : from;
      const held = document.activeElement;
      const nowhere = held === null || held === document.body;
      const inside = held instanceof HTMLElement && held.closest(`[data-k="sec-${section}"]`) !== null;
      if (nowhere || inside) focusWant.current = [byFid(from === "installId" ? "in:install-id" : `save:${from}`)];
    },
    [setCodeOf],
  );

  const save = useCallback(
    async (id: StepId): Promise<void> => {
      const now = stateRef.current;
      const own = editsRef.current[id];
      if (!now || !own || savingRef.current || readOnlyRef.current) return;
      const asking = codeRef.current?.from === id;
      const given = asking ? (codesRef.current[id] ?? "") : "";
      if (asking && given.length !== 6) {
        document.querySelector<HTMLElement>(`[data-fid="code:${id}"]`)?.focus();
        return;
      }
      if (typingTimer.current) clearTimeout(typingTimer.current);
      savingRef.current = id;
      setSaving(id);
      setFailed(null);
      // Only what the person changed, against the state the page read, and
      // the digest of that state's answers for the section. A server that
      // gives no digests is sent none.
      const sent = sentAnswers(now.answers, withEdits(now.answers, own), pathsRef.current[id] ?? []);
      const version = now.versions?.[id];
      // A save that does not answer in time is given up: the section takes
      // changes again, and the settings are read again, to show whether it
      // was saved after all.
      const giveUp = new AbortController();
      const timer = setTimeout(() => giveUp.abort(), SAVE_WAIT_MS);
      inFlight.current = { section: id, sent: own };
      try {
        take(id, await api.settingsSave(id, sent, given || undefined, version, giveUp.signal), asking);
      } catch (err) {
        // It may be saved all the same: a read that finds it saved finds the
        // person's own change.
        unanswered.current[id] = { ...unanswered.current[id], ...own };
        if (giveUp.signal.aborted) {
          failedSave(id, new Error(SAVE_NO_ANSWER));
          void load(false);
        } else failedSave(id, err);
      } finally {
        clearTimeout(timer);
        inFlight.current = null;
        savingRef.current = null;
        setSaving(null);
        afterFlight(id);
      }
    },
    [take, failedSave, load, afterFlight],
  );

  const saveInstallId = useCallback(async (): Promise<void> => {
    const input = installIdInput.current;
    const now = stateRef.current;
    if (!input || !now || savingRef.current || readOnlyRef.current) return;
    const id = input.value.trim();
    if (!id) {
      input.focus();
      return;
    }
    const asking = now.asksCode || codeRef.current?.from === "installId";
    const given = asking ? (codesRef.current.installId ?? "") : "";
    if (asking && given.length !== 6) {
      document.querySelector<HTMLElement>('[data-fid="code:installId"]')?.focus();
      return;
    }
    // The id is a credential: once it is sent, the page does not keep it.
    input.value = "";
    savingRef.current = "installId";
    setSaving("installId");
    setFailed(null);
    const giveUp = new AbortController();
    const timer = setTimeout(() => giveUp.abort(), SAVE_WAIT_MS);
    // HX Fortress switches the connection on with a new install id.
    const switchedOn: Edits = { "controlPlane.connected": "on" };
    inFlight.current = { section: "controlPlane", sent: switchedOn };
    try {
      take("installId", await api.settingsInstallId(id, given || undefined, giveUp.signal), asking);
    } catch (err) {
      unanswered.current.controlPlane = { ...unanswered.current.controlPlane, ...switchedOn };
      if (giveUp.signal.aborted) {
        failedSave("installId", new Error(SAVE_NO_ANSWER));
        void load(false);
      } else failedSave("installId", err);
    } finally {
      clearTimeout(timer);
      inFlight.current = null;
      savingRef.current = null;
      setSaving(null);
      afterFlight("controlPlane");
    }
  }, [take, failedSave, load, afterFlight]);

  const discard = useCallback(
    (id: StepId): void => {
      // Discard waits for a save of the same section to answer.
      if (savingRef.current === id) return;
      homeWhenGone(id);
      const nextEdits = { ...editsRef.current };
      delete nextEdits[id];
      editsRef.current = nextEdits;
      setEdits(nextEdits);
      delete unanswered.current[id];
      delete heldBase.current[id];
      changes.current[id] = (changes.current[id] ?? 0) + 1;
      forgetSaid(id);
      const without = <T,>(was: Partial<Record<StepId, T>>): Partial<Record<StepId, T>> => {
        if (!was[id]) return was;
        const kept = { ...was };
        delete kept[id];
        return kept;
      };
      setStale(without);
      setElsewhere(without);
    },
    [forgetSaid],
  );

  const toggle = (id: Open): void => setOpen((was) => (was === id ? null : id));

  // ── Drawing ────────────────────────────────────────────────────────────────
  const header = (
    <>
      <div className="kicker">System</div>
      <h1>Settings</h1>
    </>
  );

  if (!state) {
    // Before the first read answers: the page's own words while it waits,
    // and, when the read failed, why, with the way to read again holding the
    // keyboard.
    return (
      <section className={active ? "view active st-view" : "view st-view"} ref={view}>
        {header}
        {!active ? null : loadError !== null ? (
          <div className="banner warn">
            <span className="badge">!</span>
            <span className="btxt">{loadError}</span>
            <button className="btn" data-fid="retry:settings" ref={retryShown} onClick={() => void load(true)}>
              Try again
            </button>
          </div>
        ) : (
          <ViewLoading what="Reading the settings" />
        )}
      </section>
    );
  }

  const ids: Open[] = [...state.sections, "install"];

  /** Up and down walk the headers; Home and End go to the first and last. */
  const headerKeys = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (keysOff.current) return;
    const heads = Array.from(root.current?.querySelectorAll<HTMLElement>(".st-acch") ?? []);
    const at = heads.indexOf(e.currentTarget);
    const to =
      e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? heads.length - 1 : -2;
    if (to === -2) return;
    e.preventDefault();
    heads[Math.max(0, Math.min(heads.length - 1, to))]?.focus();
  };

  const panels = ids.map((id) => {
    const isOpen = open === id;
    if (id === "install") {
      return (
        <section className={isOpen ? "st-acc open" : "st-acc"} key={id} data-k="sec-install" data-panel="">
          <div className="st-acc-bg" data-panel-bg="" />
          <div className="st-acc-bg st-acc-edge" data-panel-edge="" aria-hidden="true" />
          <div className="st-acc-in">
            <button
              type="button"
              className="st-acch"
              data-fid="acc:install"
              aria-expanded={isOpen}
              aria-controls="st-body-install"
              onClick={() => toggle(id)}
              onKeyDown={headerKeys}
            >
              {CHEVRON}
              <span className="t">{THIS_INSTALL.name}</span>
              <span className="s">{state.derived.summary.where}</span>
            </button>
            {isOpen ? (
              <div className="st-accb" id="st-body-install" data-k="body-install">
                <StepControls
                  step={THIS_INSTALL}
                  frame={state.frame}
                  answers={state.answers}
                  derived={state.derived}
                  check={null}
                  onSet={() => {}}
                  onTyped={() => {}}
                />
              </div>
            ) : null}
          </div>
        </section>
      );
    }

    const own = edits[id];
    const dirty = own !== undefined;
    const answers = dirty ? withEdits(state.answers, own) : state.answers;
    const derived = (dirty ? derivedOf[id] : undefined) ?? state.derived;
    const listed = stepOf(id, answers);
    if (!listed) return null;
    // The control plane's section says one thing in its header, its picture,
    // its switch and its line: see `controlPlaneNow`.
    const isControlPlane = id === "controlPlane";
    const cp = controlPlaneNow(state.answers, answers, state.connection);
    const step: SetupStep = !isControlPlane
      ? listed
      : {
          ...listed,
          blocks: listed.blocks.map((block) =>
            block.kind === "switch" && block.path === "controlPlane.connected"
              ? switchWords(block, listed.name, {
                  on: answers.controlPlane.connected === block.on,
                  connected: cp.connected,
                  changed: cp.changed,
                })
              : block,
          ),
        };
    // The read-only sentence is said under a section that has something to
    // change: not under one of facts, or of choices with one option each.
    const settable = canChange(step, state.frame.pinned, state.frame.modules.map((module) => module.id));
    const latest = checks[id];
    const notes = dirty ? (latest?.lines ?? []).filter((line) => !refuses(line) && !(line.path && pending.has(line.path))) : [];
    const armed = alerts[id] ?? [];
    const savedElsewhere = elsewhere[id] ?? [];
    const shownCheck: StepCheck | null =
      notes.length > 0 || armed.length > 0 || savedElsewhere.length > 0
        ? { step: id, ok: armed.length === 0, lines: [...armed, ...savedElsewhere, ...notes] }
        : null;
    const said = after[id];
    const staleSaid = stale[id];
    // A session that came in through the identity provider, with a sign-in
    // older than a save allows. Read defensively: a server that does not say
    // leaves it out, which reads as not asked.
    const signInAsked = state.asksSignIn === true || signInWanted;
    const asking = code?.from === id ? code : null;
    const busy = saving === id;
    const summary = isControlPlane && cp.endsAtStart ? CONNECTED_UNTIL_START : (derived.summary[id] ?? "");

    // The control plane: its state in plain words, and the one-time id a
    // control plane that refused the connection asks for.
    const named = answers.controlPlane.connect === "yes";
    // The saved answer, not this section's edits: the line says how things
    // stand now.
    const line = connectionLine(state.connection, state.answers.controlPlane.connected === "off");
    const idShown = installIdShown(state.connection, { another: anotherId, lineSaysWaiting: line.text === ID_WAITS });
    const connectBlock =
      isControlPlane && idShown ? (
        <InstallId
          inputRef={installIdInput}
          readOnly={readOnly}
          shown={idShown}
          // The line says the id waits, unless it says something that comes
          // first (switched off here): then this block says it.
          sayWaiting={line.text !== ID_WAITS}
          onAnother={() => {
            setAnotherId(true);
            focusWant.current = [byFid("in:install-id")];
          }}
          asksCode={state.asksCode || code?.from === "installId"}
          code={code?.from === "installId" ? code : null}
          codeValue={codes.installId ?? ""}
          onCode={(text) => setCodeOf("installId", digits(text))}
          busy={saving === "installId"}
          failed={failed?.from === "installId" ? failed.text : null}
          signInFirst={signInAsked}
          onSave={() => void saveInstallId()}
          keysOff={keysOff}
          onEscape={(field) => {
            if (savingRef.current === "installId") return;
            if (field === "code") {
              // Escape in the code takes back the code step, and the code.
              setCodeOf("installId", "");
              if (codeRef.current?.from === "installId") {
                setCode(null);
                // Where the code's field goes with the step, the keyboard
                // goes back to the id's.
                if (!stateRef.current?.asksCode) focusWant.current = [byFid("in:install-id")];
              }
              return;
            }
            // Escape in the id empties it. An empty one, given while another
            // id waits, gives way to that id again.
            const input = installIdInput.current;
            if (input && input.value !== "") {
              input.value = "";
              return;
            }
            if (stateRef.current?.connection.idWaiting === true) {
              setAnotherId(false);
              focusWant.current = [byFid("another:install-id")];
            }
          }}
        />
      ) : undefined;

    const controls = (
      <StepControls
        step={step}
        frame={state.frame}
        answers={answers}
        derived={derived}
        check={shownCheck}
        onSet={(path, value, how) => change(id, path, value, how)}
        onTyped={() => {}}
        onLeave={() => checkIfChanged(id)}
        // While its save is on its way, the section's controls are held:
        // nothing typed or picked meanwhile is shown and then dropped.
        saving={busy}
        {...(readOnly ? { disabled: readOnly } : {})}
        {...(connectBlock ? { connect: connectBlock } : {})}
      />
    );

    const picture = (
      <div className="st-pic">
        <WorldPicture answers={answers} on={cp.pictureOn} off={cp.onButDown ? NOT_CONNECTED : summary} />
      </div>
    );
    const body = !isControlPlane ? null : named ? (
      <div className="st-split">
        <div className="st-col">
          {controls}
          <div className={`st-conn ${line.tone}`} data-k="conn">
            <i />
            <span>
              {line.text}
              {line.word ? (
                <>
                  {" "}
                  <code className="su-code">{line.word}</code>
                </>
              ) : null}
              {/* Two sentences: the state, then what the next start changes. */}
              {line.then ? (
                <>
                  .<span className="then"> {line.then}</span>
                </>
              ) : null}
            </span>
          </div>
          {readOnly && settable ? <div className="st-readonly">{readOnly}</div> : null}
        </div>
        {picture}
      </div>
    ) : (
      // No control plane is named: the command that names one, above the picture.
      <div className="st-none">
        {controls}
        <div className="st-cmd" data-k="connect-command">
          <code className="mono">{CONNECT_COMMAND}</code>
          <CopyButton text={CONNECT_COMMAND} fid="copy:connect-command" />
        </div>
        {picture}
      </div>
    );
    const sectionBody = body ?? (
      <>
        {controls}
        {readOnly && settable ? <div className="st-readonly">{readOnly}</div> : null}
      </>
    );

    return (
      <section
        className={["st-acc", isOpen ? "open" : "", dirty ? "dirty" : "", said || staleSaid ? "said" : ""].filter(Boolean).join(" ")}
        key={id}
        data-k={`sec-${id}`}
        data-panel=""
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          if (keysOff.current) return;
          const target = e.target as HTMLElement;
          if (e.key === "Enter" && !e.shiftKey) {
            // A button answers Enter itself; so does the install id's own Save.
            if (target.tagName === "BUTTON" && !target.hasAttribute("data-menu")) return;
            if (target.closest("[data-own-enter]")) return;
            if (!dirty) return;
            e.preventDefault();
            if (e.repeat) return;
            void save(id);
            return;
          }
          if (e.key === "Escape") {
            if (savingRef.current === id) {
              // Escape waits for the save, like Discard.
              e.preventDefault();
              return;
            }
            if (asking && target.dataset.fid === `code:${id}`) {
              // Escape in the code field takes back the code step, not the changes.
              e.preventDefault();
              setCode(null);
              setCodeOf(id, "");
              focusWant.current = [byFid(`save:${id}`)];
              return;
            }
            if (!dirty) return;
            e.preventDefault();
            discard(id);
          }
        }}
      >
        <div className="st-acc-bg" data-panel-bg="" />
        <div className="st-acc-bg st-acc-edge" data-panel-edge="" aria-hidden="true" />
        <div className="st-acc-in">
          <button
            type="button"
            className="st-acch"
            data-fid={`acc:${id}`}
            aria-expanded={isOpen}
            aria-controls={`st-body-${id}`}
            onClick={() => toggle(id)}
            onKeyDown={headerKeys}
          >
            {CHEVRON}
            <span className="t">{step.name}</span>
            <span className="s">{summary}</span>
          </button>
          {isOpen ? (
            <div className="st-accb" id={`st-body-${id}`} data-k={`body-${id}`}>
              {sectionBody}
            </div>
          ) : null}
          {said && (said.restart || said.notes.length > 0) ? (
            <div className="st-after" data-k={`after-${id}`}>
              {said.restart ? <div className="st-after-line">{TAKES_EFFECT_AT_START}</div> : null}
              {said.notes.map((note) => (
                <div className="st-after-line" key={note}>
                  <Words text={note} />
                </div>
              ))}
            </div>
          ) : null}
          {staleSaid ? (
            // Under the section, open or closed: the save came too late.
            <div className="st-after" data-k={`stale-${id}`} role="alert">
              <div className="st-after-line bad">
                <Words text={staleSaid} />
              </div>
            </div>
          ) : null}
          {dirty && !readOnly ? (
            <div className="st-foot" data-k={`foot-${id}`} data-gone-with={id}>
              {asking ? (
                <div className="st-code" data-k={`code-${id}`}>
                  <label htmlFor={`st-code-${id}`} className={asking.refused ? "bad" : undefined}>
                    <Words text={asking.said} />
                  </label>
                  <input
                    id={`st-code-${id}`}
                    className="su-inp mono st-code-in"
                    data-fid={`code:${id}`}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
                    spellCheck={false}
                    value={codes[id] ?? ""}
                    readOnly={busy}
                    aria-invalid={asking.refused ? true : undefined}
                    onChange={(e) => setCodeOf(id, digits(e.target.value))}
                  />
                </div>
              ) : failed?.from === id ? (
                <div className="st-foot-err" role="alert" data-k={`foot-err-${id}`}>
                  <Words text={failed.text} />
                </div>
              ) : signInAsked ? (
                // Said before the save, so Save is not a surprise.
                <div className="st-foot-note" data-k={`foot-note-${id}`}>
                  {SIGN_IN_FIRST}
                </div>
              ) : null}
              <button
                type="button"
                className="su-btn ghost"
                data-fid={`discard:${id}`}
                aria-disabled={busy ? true : undefined}
                onClick={() => discard(id)}
              >
                <span className="key">Esc</span>
                Discard
              </button>
              <button
                type="button"
                className="su-btn"
                data-fid={`save:${id}`}
                aria-busy={busy ? true : undefined}
                aria-disabled={busy ? true : undefined}
                onClick={() => void save(id)}
              >
                Save
                <BusyKey busy={busy} />
              </button>
            </div>
          ) : null}
        </div>
      </section>
    );
  });

  return (
    <section
      className={active ? "view active st-view" : "view st-view"}
      ref={view}
      onFocus={(e) => {
        // Where the keyboard is, for a return to the page.
        const fid = (e.target as HTMLElement).getAttribute("data-fid");
        if (fid) lastFocus.current = fid;
      }}
    >
      {header}
      <PanelMotion
        active={active}
        className="su st-su"
        rootRef={root}
        onKeyDownCapture={(e) => {
          // A dialog is open over the page: no control of the page acts on a
          // key that would change or save something. Escape and `?` go on to
          // the dialog, and the page's own handlers let them pass.
          if (!keysOff.current || !PAGE_KEYS.has(e.key)) return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {panels}
      </PanelMotion>
    </section>
  );
}

/** A Save's key, ↵, and the spinner that takes its place while the save is
 *  on its way. The spinner is drawn over the key, so the button keeps its
 *  width. */
function BusyKey({ busy }: { busy: boolean }): React.ReactElement {
  return (
    <span className="st-busykey">
      <span className="key">↵</span>
      {busy ? <Spinner /> : null}
    </span>
  );
}

/** The keys a control of the page acts on, other than Escape. */
const PAGE_KEYS: ReadonlySet<string> = new Set(["Enter", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

/**
 * A new one-time install id, for a control plane that refused the connection.
 * It is a credential: it lives in its field until it is sent, and the page
 * keeps no copy of it. Where a save asks this account for a code, the code is
 * asked beside it, so the id is sent once.
 */
function InstallId(props: {
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
  readOnly: string | undefined;
  /** What is shown (`installIdShown`): the field; while an id already waits,
   *  the button that brings the field back for another id; or, while an id
   *  waits and the connection is not refused, only that it waits. */
  shown: "field" | "another" | "said";
  /** While an id waits, this block also says so: the line under the section
   *  says something that comes first (the connection is switched off). */
  sayWaiting: boolean;
  onAnother: () => void;
  asksCode: boolean;
  code: CodeAsk | null;
  codeValue: string;
  onCode: (text: string) => void;
  busy: boolean;
  failed: string | null;
  /** A save from this session asks the person to sign in again first: the
   *  line under the fields says so before the id is sent. */
  signInFirst: boolean;
  onSave: () => void;
  /** True while a dialog is open over the page: Escape is the dialog's. */
  keysOff: React.MutableRefObject<boolean>;
  /** Escape in one of the two fields. It is the fields' own: it never
   *  reaches the section, whose Escape discards its changes. */
  onEscape: (field: "id" | "code") => void;
}): React.ReactElement {
  if (props.shown === "said") {
    // An id waits, and the server takes no other while the connection is not
    // refused: the block only says that it waits.
    return (
      <div className="su-flds st-install-id" data-gone-with="controlPlane">
        <div className="st-another" data-k="waits-install-id">
          <span className="st-another-said">{ID_WAITS}</span>
        </div>
      </div>
    );
  }
  if (props.shown === "another") {
    // The line under the section says the id waits, or else this does. The
    // button is the way to give another one.
    return (
      <div className="su-flds st-install-id" data-gone-with="controlPlane">
        <div className="st-another" data-k="another-install-id">
          {props.sayWaiting ? <span className="st-another-said">{ID_WAITS}</span> : null}
          <button
            type="button"
            className="su-btn ghost sm"
            data-fid="another:install-id"
            disabled={props.readOnly !== undefined}
            title={props.readOnly}
            onClick={props.onAnother}
          >
            Give another install id
          </button>
        </div>
      </div>
    );
  }
  const keys =
    (field: "id" | "code") =>
    (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        if (props.keysOff.current) return;
        e.preventDefault();
        e.stopPropagation();
        props.onEscape(field);
        return;
      }
      if (e.key !== "Enter") return;
      e.preventDefault();
      props.onSave();
    };
  const withCode = props.asksCode && props.readOnly === undefined;
  // Save comes after the last field, so Tab goes id, code, Save. When the
  // code's row comes, the Save of the id's row folds away and the code's row
  // unfolds with its own: each is a row of its own (`data-k`).
  const save = (
    <button
      type="button"
      className="su-btn sm"
      data-fid="save:installId"
      data-k={withCode ? "save-install-code" : "save-install-id"}
      disabled={props.readOnly !== undefined}
      title={props.readOnly}
      aria-busy={props.busy ? true : undefined}
      onClick={props.onSave}
    >
      Save
      <BusyKey busy={props.busy} />
    </button>
  );
  return (
    <div className="su-flds st-install-id" data-own-enter="" data-gone-with="controlPlane">
      <div className={withCode ? "su-fld" : "su-fld tagged"} data-k="fld-install-id">
        <label htmlFor="st-install-id">New install id</label>
        <input
          id="st-install-id"
          ref={props.inputRef}
          type="password"
          className="su-inp mono"
          data-fid="in:install-id"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          readOnly={props.readOnly !== undefined}
          title={props.readOnly}
          onKeyDown={keys("id")}
        />
        {withCode ? null : save}
      </div>
      {withCode ? (
        <div className={props.code?.refused ? "su-fld tagged err" : "su-fld tagged"} data-k="fld-install-code">
          <label htmlFor="st-install-code">{props.code ? <Words text={props.code.said} /> : "Code"}</label>
          <input
            id="st-install-code"
            className="su-inp mono st-code-in"
            data-fid="code:installId"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            spellCheck={false}
            value={props.codeValue}
            onChange={(e) => props.onCode(e.target.value)}
            onKeyDown={keys("code")}
          />
          {save}
        </div>
      ) : null}
      {props.failed ? (
        <div className="su-line bad" role="alert" data-k="ln-install-id">
          <i />
          <span>
            <Words text={props.failed} />
          </span>
        </div>
      ) : props.signInFirst && props.readOnly === undefined ? (
        <div className="su-line soft" data-k="ln-install-id">
          <i />
          <span>{SIGN_IN_FIRST}</span>
        </div>
      ) : null}
    </div>
  );
}
