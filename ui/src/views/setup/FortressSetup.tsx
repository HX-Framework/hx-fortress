import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import "../../setup.css";

import { answerText, cloneAnswers, setAnswer, settleAnswers, wordsOf, type SetupAnswers } from "../../../../src/setup/answers";
import { isPlaceId, keyFields, visibleList, type SetupStep, type StepId } from "../../../../src/setup/list";
import { PICTURE_PART, pictureOf } from "../../../../src/setup/picture";
import type { CheckLine, Progress, SetupDerived, SetupDone, SetupFrame, StepCheck } from "../../../../src/setup/view";
import { takeFragmentToken, useApp } from "../../state";
import { CHECK_ICON, CopyButton, MORPH_EASE, MORPH_MS, Spinner, StepControls, Words, type SetHow } from "./blocks";
import { NO_ANSWER, NO_LINK, readSetupSession, setupApi, SetupClosed, SetupNotNow } from "./client";
import { SetupPicture } from "./Picture";

// `ended` is false when only the host did not answer the first load: the
// session is kept, so a reload tries again.
type Phase = { kind: "opening" } | { kind: "closed"; message: string; ended: boolean } | { kind: "ready" };

/** What a check brought back: the step's result, or why there is none. */
type CheckResult = { ok: true; check: StepCheck | null } | { ok: false; error: unknown };

/** A row as it was last drawn: where it stood inside the body, and the row
 *  that held it. */
interface Row {
  node: HTMLElement;
  top: number;
  left: number;
  width: number;
  parent: string | null;
}

/** A line under the step is replaced by the next line in the same place.
 *  Folding the old one while the new one unfolds would be two things fading
 *  through each other, so a line simply gives way. */
const GIVES_WAY = /^ln-/;

/** How long a check waits before it is asked again when the host asked for
 *  fewer requests and did not say how long. */
const RETRY_SECONDS = 5;

/** How often the last step asks how far it is. */
const PROGRESS_EVERY_MS = 700;

/** How long Open waits for HX Fortress to answer at this page's own address,
 *  and how often it asks. */
const OPEN_WAIT_MS = 45_000;
const OPEN_ASK_EVERY_MS = 600;

/** The digit key of each step, in order. */
const DIGITS = "1234567890";

/** The fields that hold a key, with the name a typed key gets. */
const KEY_FIELDS = keyFields();

function calm(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** The link's token is exchanged once. A second try with the same token would
 *  be refused, so the exchange is remembered for as long as the page lives. One
 *  that failed is not: the same link pasted again tries again. */
let opened: { token: string; done: Promise<void> } | null = null;
function openOnce(token: string): Promise<void> {
  if (opened?.token === token) return opened.done;
  const done = setupApi.open(token);
  opened = { token, done };
  done.catch(() => {
    if (opened?.done === done) opened = null;
  });
  return done;
}

function refusesLine(line: CheckLine): boolean {
  return !line.ok && !line.soft;
}

function refusedOf(check: StepCheck): CheckLine[] {
  return check.lines.filter(refusesLine);
}

function messageOf(error: unknown): string {
  return error instanceof SetupNotNow || error instanceof SetupClosed ? error.message : NO_ANSWER;
}

/**
 * Fold a row away where it stood: the way it unfolded when it came, run
 * backwards. What folds is a copy that takes no room and that nothing can
 * reach, so the rows below glide up beside it in the same time.
 */
function fold(within: HTMLElement, row: Row, ghosts: Set<HTMLElement>): void {
  const ghost = row.node.cloneNode(true) as HTMLElement;
  for (const node of [ghost, ...Array.from(ghost.querySelectorAll<HTMLElement>("[data-k], [data-fid], [id], [role]"))]) {
    node.removeAttribute("data-k");
    node.removeAttribute("data-fid");
    node.removeAttribute("id");
    node.removeAttribute("role");
    node.removeAttribute("tabindex");
  }
  ghost.inert = true;
  ghost.setAttribute("aria-hidden", "true");
  ghost.classList.remove("su-reveal");
  Object.assign(ghost.style, {
    position: "absolute",
    top: `${row.top}px`,
    left: `${row.left}px`,
    width: `${row.width}px`,
    margin: "0",
    pointerEvents: "none",
  });
  within.appendChild(ghost);
  ghosts.add(ghost);
  const gone = ghost.animate(
    [
      { opacity: 1, clipPath: "inset(0 0 0 0)" },
      { opacity: 0, clipPath: "inset(0 0 100% 0)" },
    ],
    { duration: MORPH_MS, easing: MORPH_EASE, fill: "forwards" },
  );
  const remove = (): void => {
    ghost.remove();
    ghosts.delete(ghost);
  };
  gone.finished.then(remove, remove);
}

const MOON = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M16.5 11.6A6.8 6.8 0 0 1 8.4 3.5a6.8 6.8 0 1 0 8.1 8.1z" />
  </svg>
);
const SUN = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
    <circle cx="10" cy="10" r="3.4" />
    <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
  </svg>
);

/**
 * HX Fortress's setup in a browser: one card per step, a picture beside each.
 *
 * Every step, option, field and label is drawn from the setup's one list
 * (`visibleList`), for the way this setup is asked and the place chosen, and
 * worked out again whenever an answer changes. The page holds no question of
 * its own.
 *
 * Each answer is checked on the host as it is given. While a person types, the
 * host checks only what it sees by itself; the full check, which may ask a
 * service outside the host, runs when a field is left, when a choice changes
 * and when Continue is pressed. Continue goes on only when the full check
 * passes, and a refusal shows over its field.
 *
 * The keyboard does everything: Enter is the main button on every page,
 * Shift+Enter goes back, the digits jump to a step, the arrows move a choice,
 * Space flips a switch and opens a menu. When a page appears, its first
 * control already holds the keyboard.
 */
export default function FortressSetup(): React.ReactElement {
  const app = useApp();
  const [token] = useState<string | null>(() => takeFragmentToken("s"));
  const [phase, setPhase] = useState<Phase>({ kind: "opening" });
  const [frame, setFrame] = useState<SetupFrame | null>(null);
  const [answers, setAnswers] = useState<SetupAnswers | null>(null);
  const [derived, setDerived] = useState<SetupDerived | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [done, setDone] = useState<SetupDone | null>(null);
  const [checks, setChecks] = useState<Partial<Record<StepId, StepCheck>>>({});
  // The refusals a person was shown when Continue or the last step's yes was
  // refused. A line goes when the answer it is about changes.
  const [alerts, setAlerts] = useState<Partial<Record<StepId, CheckLine[]>>>({});
  // Paths whose answer changed since the last check came back: what the last
  // check said of them is old.
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  // The fields whose typed key the host said it holds.
  const [typedHere, setTypedHere] = useState<ReadonlySet<string>>(() => new Set());
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState<"continue" | "again" | "create" | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  // The row of the last step that waited for a DNS record.
  const [dnsRow, setDnsRow] = useState<string | null>(null);

  const answersRef = useRef<SetupAnswers | null>(null);
  /** How the list is asked here. Read inside handlers that outlive a render. */
  const wayRef = useRef<SetupFrame["way"] | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const stepRef = useRef(0);
  stepRef.current = step;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const stepsRef = useRef<SetupStep[]>([]);
  const lockedRef = useRef(false);
  const primaryRef = useRef<() => void>(() => {});
  const backRef = useRef<() => void>(() => {});

  // Every ask that can bring a step's result takes the next number. A step
  // shows the result of the latest ask that answered for it, in whatever
  // order the replies arrive, and what is worked out from the answers comes
  // from the latest reply.
  const asked = useRef(0);
  const derivedFrom = useRef(0);
  const resultFrom = useRef<Partial<Record<StepId, number>>>({});
  // The first ask whose result a step may take: a reply to an ask made before
  // the place changed speaks of answers that are gone.
  const floor = useRef<Partial<Record<StepId, number>>>({});
  const checksRef = useRef<Partial<Record<StepId, StepCheck>>>({});
  checksRef.current = checks;
  // How many times each step's answers changed, and the full check that was
  // last asked for each.
  const edits = useRef<Partial<Record<StepId, number>>>({});
  const fullFor = useRef<Partial<Record<StepId, { edit: number; ask: number; result: Promise<CheckResult> }>>>({});
  const quickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retries = useRef(new Set<ReturnType<typeof setTimeout>>());
  const typedInFlight = useRef(new Set<Promise<void>>());
  const seenSent = useRef(false);

  const body = useRef<HTMLDivElement | null>(null);
  const mainButton = useRef<HTMLButtonElement | null>(null);
  const focusWant = useRef<string | null>("first");
  const drawn = useRef<{ screen: number; tops: Map<string, number>; rows: Map<string, Row>; parts: Set<string> } | null>(null);
  const moving = useRef<{ direction: number; out: Animation | null } | null>(null);
  const glides = useRef(new Map<HTMLElement, Animation>());
  /** Copies of rows that are folding away. */
  const ghosts = useRef(new Set<HTMLElement>());

  // ── The theme ──────────────────────────────────────────────────────────────
  // The console's own switch. Nothing of it is kept in this browser: the
  // console keeps nothing there but a session, and neither does the setup.
  const switchTheme = app.toggleTheme;

  // A setup that has ended closes the screen. Anything else that goes wrong
  // there is a host that did not answer. A finished setup stays: a request
  // that was still out when it ended is refused, and says nothing new.
  const close = useCallback((error: unknown): void => {
    if (lockedRef.current && error instanceof SetupClosed) return;
    setPhase(
      error instanceof SetupClosed
        ? { kind: "closed", message: error.message, ended: true }
        : { kind: "closed", message: NO_ANSWER, ended: false },
    );
  }, []);

  // ── Opening the link ───────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        if (token) await openOnce(token);
        else if (!readSetupSession()) throw new SetupClosed(NO_LINK);
        const state = await setupApi.state();
        if (cancelled) return;
        answersRef.current = state.answers;
        wayRef.current = state.frame.way;
        setFrame(state.frame);
        setAnswers(state.answers);
        setDerived(state.derived);
        setProgress(state.progress);
        setDone(state.done);
        // A page opened while the last step runs, or after it, lands there.
        if (state.done || state.progress.stage === "making" || state.progress.stage === "done") {
          const steps = visibleList({
            way: state.frame.way,
            place: isPlaceId(state.answers.where.place) ? state.answers.where.place : "here",
            words: wordsOf(state.answers),
          });
          setStep(steps.length);
        }
        setPhase({ kind: "ready" });
      } catch (error) {
        if (!cancelled) close(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, close]);

  const finished = progress?.stage === "done" || done !== null;
  const making = !finished && (busy === "create" || progress?.stage === "making");
  lockedRef.current = finished;

  // The session ends with the setup, so a link opened in this tab later is not
  // taken for it. The last screen first tells the host that it arrived: that
  // request already holds the session when the session is forgotten.
  useEffect(() => {
    if (phase.kind === "ready" && finished && !seenSent.current) {
      seenSent.current = true;
      void setupApi.seen().catch(() => {});
      setupApi.forget();
    } else if (phase.kind === "closed" && phase.ended) {
      setupApi.forget();
    }
  }, [phase, finished]);

  // Nothing waits once the page is gone.
  useEffect(() => {
    const timers = retries.current;
    return () => {
      for (const timer of [quickTimer, pickTimer]) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
      }
      for (const retry of timers) clearTimeout(retry);
      timers.clear();
    };
  }, []);

  // ── The list, as this setup asks it ────────────────────────────────────────
  const steps = useMemo(
    () =>
      frame && answers
        ? visibleList({
            way: frame.way,
            place: isPlaceId(answers.where.place) ? answers.where.place : "here",
            words: wordsOf(answers),
          })
        : [],
    [frame, answers],
  );
  stepsRef.current = steps;
  const lastIndex = steps.length;
  const stepDef = step < lastIndex ? (steps[step] ?? null) : null;
  const currentId = useCallback((): StepId | null => stepsRef.current[stepRef.current]?.id ?? null, []);

  // ── Checks ─────────────────────────────────────────────────────────────────
  const take = useCallback((mine: number, results: readonly StepCheck[]): void => {
    const fresh = results.filter(
      (one) => mine > Math.max(resultFrom.current[one.step] ?? 0, floor.current[one.step] ?? 0),
    );
    if (fresh.length === 0) return;
    for (const one of fresh) resultFrom.current[one.step] = mine;
    setChecks((was) => {
      const next = { ...was };
      for (const one of fresh) next[one.step] = one;
      return next;
    });
  }, []);

  const takeDerived = useCallback((mine: number, next: SetupDerived): void => {
    if (mine < derivedFrom.current) return;
    derivedFrom.current = mine;
    setDerived(next);
    if (mine === asked.current) setPending(new Set());
  }, []);

  const runCheck = useCallback(
    (id: StepId, quick: boolean, again = false): Promise<CheckResult> => {
      const current = answersRef.current;
      if (!current || phaseRef.current.kind !== "ready") return Promise.resolve({ ok: false, error: null });
      const mine = (asked.current += 1);
      // A full check covers the answers as they are now, and makes a quick
      // check that waits for a pause in the typing needless.
      if (!quick && quickTimer.current) {
        clearTimeout(quickTimer.current);
        quickTimer.current = null;
      }
      const result = (async (): Promise<CheckResult> => {
        try {
          const answer = await setupApi.check(current, id, quick);
          take(mine, answer.check ? [answer.check] : []);
          takeDerived(mine, answer.derived);
          return { ok: true, check: answer.check };
        } catch (error) {
          if (!quick && fullFor.current[id]?.ask === mine) delete fullFor.current[id];
          if (error instanceof SetupClosed) close(error);
          else if (!again && error instanceof SetupNotNow && error.status === 429) {
            // The host asked for fewer requests: once more, after the wait it
            // named, unless the answers changed meanwhile.
            const edit = edits.current[id] ?? 0;
            const retry = setTimeout(
              () => {
                retries.current.delete(retry);
                if ((edits.current[id] ?? 0) === edit) void runCheck(id, quick, true);
              },
              (error.retryAfter ?? RETRY_SECONDS) * 1000,
            );
            retries.current.add(retry);
          }
          return { ok: false, error };
        }
      })();
      if (!quick) fullFor.current[id] = { edit: edits.current[id] ?? 0, ask: mine, result };
      return result;
    },
    [take, takeDerived, close],
  );

  /** The full check of the answers as they are now: one already asked for
   *  them, or a new one. */
  const fullCheck = useCallback(
    (id: StepId): Promise<CheckResult> => {
      const asked_ = fullFor.current[id];
      if (asked_ && asked_.edit === (edits.current[id] ?? 0)) return asked_.result;
      return runCheck(id, false);
    },
    [runCheck],
  );

  const checkIfChanged = useCallback(
    (id: StepId): void => {
      const asked_ = fullFor.current[id];
      if (!asked_ || asked_.edit !== (edits.current[id] ?? 0)) void runCheck(id, false);
    },
    [runCheck],
  );

  /** One answer of the step changed: what was said of it is old, and it is
   *  checked again (when the typing pauses, or at once). */
  const touched = useCallback(
    (id: StepId | null, path: string, how: SetHow): void => {
      setPending((was) => new Set(was).add(path));
      if (!id) return;
      edits.current[id] = (edits.current[id] ?? 0) + 1;
      setAlerts((was) => {
        const lines = was[id];
        if (!lines || lines.length === 0) return was;
        return { ...was, [id]: how === "pick" ? [] : lines.filter((line) => line.path !== undefined && line.path !== path) };
      });
      if (how === "type") {
        if (quickTimer.current) clearTimeout(quickTimer.current);
        quickTimer.current = setTimeout(() => {
          quickTimer.current = null;
          void runCheck(id, true);
        }, 300);
        return;
      }
      if (pickTimer.current) clearTimeout(pickTimer.current);
      pickTimer.current = setTimeout(() => {
        pickTimer.current = null;
        checkIfChanged(id);
      }, 0);
    },
    [runCheck, checkIfChanged],
  );

  const change = useCallback(
    (path: string, value: string | boolean, how: SetHow, onStep?: StepId): void => {
      const current = answersRef.current;
      if (!current) return;
      const next = cloneAnswers(current);
      if (!setAnswer(next, path, value)) return;
      // The answers that follow this one move with it, by the same rule the
      // host applies.
      settleAnswers(next, path, undefined, { before: current, install: wayRef.current === "install" });
      answersRef.current = next;
      setAnswers(next);
      // The step the answer was given on. A key's reply may arrive after the
      // person has moved on, and it still counts for the step it was typed on.
      const id = onStep ?? currentId();
      if (path === "where.place") {
        // Answers on other pages followed the place. What was found of them,
        // and what was refused, is old.
        for (const other of stepsRef.current) {
          if (other.id === id) continue;
          edits.current[other.id] = (edits.current[other.id] ?? 0) + 1;
          floor.current[other.id] = asked.current;
        }
        setChecks((was) => (id && was[id] ? { [id]: was[id] } : {}));
        setAlerts((was) => (id && was[id] ? { [id]: was[id] } : {}));
      }
      touched(id, path, how);
    },
    [currentId, touched],
  );

  /** A key the person typed. It goes to the host in one request of its own
   *  and is held nowhere here. The answer becomes the name the key gets. */
  const typed = useCallback(
    (path: string, value: string): void => {
      const id = currentId();
      const sent = setupApi.typed(path, value).then(
        (answer) => {
          setTypedHere(new Set(answer.typed));
          // A value the host did not keep: its sentence, at the field.
          if (answer.refused) {
            const said = answer.refused;
            if (id) setAlerts((was) => ({ ...was, [id]: [...(was[id] ?? []), { ok: false, text: said, path }] }));
            return;
          }
          const name = KEY_FIELDS.get(path)?.typedAs;
          const current = answersRef.current;
          if (name && current && answerText(current, path) !== name) change(path, name, "pick", id ?? undefined);
          else touched(id, path, "pick");
        },
        (error: unknown) => {
          if (error instanceof SetupClosed) {
            close(error);
            return;
          }
          if (!id) return;
          setAlerts((was) => ({ ...was, [id]: [...(was[id] ?? []), { ok: false, text: messageOf(error), path }] }));
        },
      );
      typedInFlight.current.add(sent);
      const settled = (): void => {
        typedInFlight.current.delete(sent);
      };
      sent.then(settled, settled);
    },
    [currentId, change, touched, close],
  );

  /** Wait for every typed key that is on its way. */
  const keysSent = useCallback(async (): Promise<void> => {
    while (typedInFlight.current.size > 0) await Promise.allSettled(Array.from(typedInFlight.current));
  }, []);

  // A step is checked in full when it is shown with no result yet. The last
  // step asks for every step's check, so what it shows is worked out from the
  // answers as they are.
  useEffect(() => {
    if (phase.kind !== "ready" || finished || making) return;
    if (step >= stepsRef.current.length) {
      const current = answersRef.current;
      if (!current) return;
      const mine = (asked.current += 1);
      setupApi.checkAll(current).then(
        (answer) => {
          take(mine, answer.checks);
          takeDerived(mine, answer.derived);
        },
        (error: unknown) => {
          if (error instanceof SetupClosed) close(error);
        },
      );
      return;
    }
    const id = stepsRef.current[step]?.id;
    if (id && !checksRef.current[id]) checkIfChanged(id);
    // Only on arrival at a step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, phase.kind]);

  // ── Moving between the steps ───────────────────────────────────────────────
  const go = useCallback(
    (to: number, focus?: string): void => {
      const from = stepRef.current;
      if (to === from || to < 0 || to > stepsRef.current.length || moving.current) return;
      if (lockedRef.current || progress?.stage === "making") return;
      // A check that waits is overtaken by the full check of the step left.
      for (const timer of [quickTimer, pickTimer]) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
      }
      const leaving = stepsRef.current[from]?.id;
      if (leaving) checkIfChanged(leaving);
      setCreateError(null);
      const direction = to > from ? 1 : -1;
      const el = body.current;
      const out =
        el && !calm()
          ? el.animate(
              [
                { opacity: 1, transform: "none" },
                { opacity: 0, transform: `translateX(${-14 * direction}px)` },
              ],
              { duration: 110, easing: "ease-in", fill: "forwards" },
            )
          : null;
      moving.current = { direction, out };
      const arrive = (): void => {
        focusWant.current = focus ?? "first";
        setStep(to);
      };
      if (out) out.finished.then(arrive, arrive);
      else arrive();
    },
    [checkIfChanged, progress?.stage],
  );

  /** The field a refused line is about, as the page can focus it. */
  const refusalFocus = (lines: readonly CheckLine[]): string | undefined => {
    for (const line of lines) {
      if (!line.path) continue;
      for (const fid of [`in:${line.path}`, `menu:${line.path}`]) {
        if (document.querySelector(`[data-fid="${fid}"]`)) return fid;
      }
    }
    return undefined;
  };

  // Continue: the full check of the step, and on only when it passes.
  const goOn = useCallback(async (): Promise<void> => {
    const id = currentId();
    if (!id || busyRef.current || moving.current) return;
    setBusy("continue");
    busyRef.current = "continue";
    try {
      await keysSent();
      let result = await fullCheck(id);
      // An answer that changed while the check ran is checked too.
      if (result.ok && fullFor.current[id]?.edit !== (edits.current[id] ?? 0)) result = await fullCheck(id);
      if (stepRef.current !== stepsRef.current.findIndex((s) => s.id === id)) return;
      if (!result.ok) {
        if (result.error instanceof SetupClosed) return;
        setAlerts((was) => ({ ...was, [id]: [{ ok: false, text: messageOf(result.error) }] }));
        return;
      }
      const lines = result.check ? refusedOf(result.check) : [];
      if (lines.length === 0) {
        setAlerts((was) => ({ ...was, [id]: [] }));
        go(stepRef.current + 1);
        return;
      }
      focusWant.current = refusalFocus(lines) ?? null;
      setAlerts((was) => ({ ...was, [id]: lines }));
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }, [currentId, keysSent, fullCheck, go]);

  // Check Again: the first page's full check once more, for a place this
  // computer was not signed in to.
  const checkAgain = useCallback(async (): Promise<void> => {
    const id = currentId();
    if (!id || busyRef.current) return;
    setBusy("again");
    busyRef.current = "again";
    try {
      const result = await runCheck(id, false);
      if (result.ok && result.check) {
        const check = result.check;
        setAlerts((was) => ({ ...was, [id]: refusedOf(check) }));
      }
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }, [currentId, runCheck]);

  // The last step's yes.
  const create = useCallback(async (): Promise<void> => {
    if (busyRef.current || lockedRef.current) return;
    setBusy("create");
    busyRef.current = "create";
    setCreateError(null);
    try {
      await keysSent();
      const current = answersRef.current;
      if (!current) return;
      const mine = (asked.current += 1);
      const answer = await setupApi.create(current);
      if ("progress" in answer) {
        setProgress(answer.progress);
        // A setup on the machine itself is done when it answers.
        if (answer.done) setDone(answer.done);
        return;
      }
      take(mine, answer.checks);
      takeDerived(mine, answer.derived);
      const refused = answer.checks.filter((check) => !check.ok);
      setAlerts((was) => {
        const next = { ...was };
        for (const check of refused) next[check.step] = refusedOf(check);
        return next;
      });
      const first = stepsRef.current.findIndex((s) => refused.some((check) => check.step === s.id));
      if (first < 0) {
        // What was refused is on no page here: the control plane is named by
        // the command. Its words are shown on this step.
        const said = refused.flatMap((check) => refusedOf(check).map((line) => line.text));
        setCreateError(said.join(" ") || "An answer was refused");
        return;
      }
      const lines = refusedOf(refused.find((check) => check.step === stepsRef.current[first]?.id) as StepCheck);
      busyRef.current = null;
      // The field, or the menu, of the refused answer is focused once the step is drawn.
      const path = lines.find((line) => line.path)?.path;
      go(first, path ? `path:${path}` : undefined);
    } catch (error) {
      if (error instanceof SetupClosed) close(error);
      else setCreateError(messageOf(error));
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }, [keysSent, take, takeDerived, go, close]);

  // How far the last step is: asked about once a while, one ask at a time.
  const stage = progress?.stage;
  useEffect(() => {
    if (phase.kind !== "ready" || stage !== "making") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ask = async (): Promise<void> => {
      let wait = PROGRESS_EVERY_MS;
      try {
        const answer = await setupApi.progress();
        if (stopped) return;
        if (answer.done) setDone(answer.done);
        setProgress(answer.progress);
        if (answer.progress.stage !== "making") return;
      } catch (error) {
        if (stopped) return;
        if (error instanceof SetupClosed) {
          close(error);
          return;
        }
        if (error instanceof SetupNotNow && error.retryAfter !== null) wait = Math.max(wait, error.retryAfter * 1000);
      }
      if (!stopped) timer = setTimeout(() => void ask(), wait);
    };
    timer = setTimeout(() => void ask(), PROGRESS_EVERY_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase.kind, stage, close]);

  // The row that waits for a DNS record is remembered, so it can say the
  // record was found once it is made.
  const dnsNow = progress?.dns ? progress.now : null;
  const dnsHeldKeyboard = useRef(false);
  useEffect(() => {
    if (!dnsNow) {
      // The record was found, and its Copy went with the wait. The keyboard is
      // never left on nothing: it goes to the main button.
      if (dnsHeldKeyboard.current && (document.activeElement === document.body || document.activeElement === null)) {
        mainButton.current?.focus();
      }
      dnsHeldKeyboard.current = false;
      return;
    }
    setDnsRow(dnsNow);
    // The record is what a person does next: its Copy holds the keyboard.
    document.querySelector<HTMLElement>('[data-fid="copy:dns"]')?.focus();
    dnsHeldKeyboard.current = true;
  }, [dnsNow]);

  // The main button holds the keyboard once HX Fortress is made: Enter opens it.
  useEffect(() => {
    if (finished) mainButton.current?.focus();
  }, [finished]);

  // Opening what was made. On the machine itself the console answers at this
  // page's own address, a moment after the setup stops listening there, or
  // once a person has started HX Fortress. So the page asks that address until
  // the console answers, and only then goes: a browser that is sent to an
  // address nothing listens on shows its own error page, and the one-time link
  // would be lost with it. Somewhere else, the place said it answers.
  const [opening, setOpening] = useState(false);
  const [notYet, setNotYet] = useState(false);
  const open = useCallback((): void => {
    const where = done?.firstAccount?.link || done?.address;
    if (!where || opening) return;
    let target: URL;
    try {
      target = new URL(where, window.location.href);
    } catch {
      return;
    }
    if (target.origin !== window.location.origin) {
      window.location.assign(where);
      return;
    }
    setOpening(true);
    setNotYet(false);
    const until = Date.now() + OPEN_WAIT_MS;
    const ask = (): void => {
      // The console answers this path with "sign in". The setup's own
      // listener, while it is still there, does not know it.
      fetch("/ui/api/session", { cache: "no-store" })
        .then((res) => res.status === 401 || res.ok)
        .catch(() => false)
        .then((up) => {
          if (up) window.location.assign(where);
          else if (Date.now() < until) window.setTimeout(ask, OPEN_ASK_EVERY_MS);
          else {
            setOpening(false);
            setNotYet(true);
          }
        });
    };
    ask();
  }, [done, opening]);

  // ── The main button ────────────────────────────────────────────────────────
  const place = derived && answers ? derived.places.find((p) => p.id === answers.where.place) : undefined;
  const needsSignIn = stepDef?.id === "where" && place !== undefined && place.needsSignIn && !place.signedInAs;
  const onLast = step === lastIndex;

  const primary = useCallback((): void => {
    if (finished) open();
    else if (onLast) {
      if (!making) void create();
    } else if (needsSignIn) void checkAgain();
    else void goOn();
  }, [finished, onLast, making, needsSignIn, open, create, checkAgain, goOn]);

  const back = useCallback((): void => {
    if (making || finished) return;
    go(stepRef.current - 1);
  }, [making, finished, go]);
  primaryRef.current = primary;
  backRef.current = back;

  // ── The keyboard ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase.kind !== "ready") return;
    const onKey = (e: KeyboardEvent): void => {
      // A key that composes a word in an input method (Japanese, Chinese,
      // Korean) belongs to that input method.
      if (e.isComposing || e.keyCode === 229) return;
      if (document.querySelector("[data-menu-open]")) return; // a menu has the keyboard
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (e.key === "Enter") {
        // A key that is held down answers once. Otherwise one long press would
        // walk through every step and make HX Fortress.
        if (e.repeat) {
          e.preventDefault();
          return;
        }
        if (e.shiftKey) {
          e.preventDefault();
          backRef.current();
          return;
        }
        // A focused button answers Enter itself. A value with a menu does not
        // open on Enter, so that a walk through the setup is Enter on every page.
        if (target?.tagName === "BUTTON" && !target.hasAttribute("data-menu")) return;
        if (target?.tagName === "A") return;
        e.preventDefault();
        primaryRef.current();
        return;
      }
      if (!typing && /^[0-9]$/.test(e.key)) {
        const to = DIGITS.indexOf(e.key);
        if (to >= 0 && to <= stepsRef.current.length) {
          e.preventDefault();
          go(to);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [phase.kind, go]);

  // ── After each draw: motion, then the keyboard's place ─────────────────────
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || phase.kind !== "ready") return;
    const still = calm();
    const keyed = Array.from(el.querySelectorAll<Element>("[data-k]"));
    const rowsNow = keyed.filter((node): node is HTMLElement => node instanceof HTMLElement && !ghosts.current.has(node));
    const partsNow = keyed.filter((node) => !(node instanceof HTMLElement));
    // Where each row is drawn at this moment, a glide in flight included. Then
    // every glide is ended, and each row is measured again where it rests. A
    // row measured while it moves would start its next glide from a place it
    // was only passing through.
    const shownFrom = el.getBoundingClientRect().top;
    const shown = new Map<HTMLElement, number>();
    for (const node of rowsNow) shown.set(node, node.getBoundingClientRect().top - shownFrom);
    for (const glide of glides.current.values()) glide.cancel();
    glides.current.clear();
    const restBox = el.getBoundingClientRect();
    const rest = new Map<HTMLElement, number>();
    const tops = new Map<string, number>();
    const rows = new Map<string, Row>();
    for (const node of rowsNow) {
      const box = node.getBoundingClientRect();
      const top = box.top - restBox.top;
      const key = node.dataset.k as string;
      rest.set(node, top);
      tops.set(key, top);
      rows.set(key, {
        node,
        top,
        left: box.left - restBox.left,
        width: box.width,
        parent: node.parentElement?.closest<HTMLElement>("[data-k]")?.dataset.k ?? null,
      });
    }
    const parts = new Set(partsNow.map((node) => node.getAttribute("data-k") as string));

    const before = drawn.current;
    if (before && before.screen === step) {
      // The same page after an answer changed. A row that is new unfolds; a
      // row that stays glides to its new place, and a row inside a row that
      // already moves is carried by it; a part of the picture that is new
      // fades in.
      const moved = new Map<HTMLElement, number>();
      for (const node of rowsNow) {
        const key = node.dataset.k as string;
        const was = before.tops.get(key);
        if (was === undefined) {
          if (!still && !node.parentElement?.closest(".su-reveal")) {
            node.classList.add("su-reveal");
            node.addEventListener("animationend", () => node.classList.remove("su-reveal"), { once: true });
          }
          continue;
        }
        const now = rest.get(node) as number;
        // From where the row was drawn: its old place, plus what was left of a
        // glide that was still in flight.
        const dy = was + ((shown.get(node) as number) - now) - now;
        moved.set(node, dy);
        const parent = node.parentElement?.closest<HTMLElement>("[data-k]");
        const carried = parent ? (moved.get(parent) ?? 0) : 0;
        const own = dy - carried;
        if (still || Math.abs(own) < 1 || node.closest(".su-reveal")) continue;
        const glide = node.animate([{ transform: `translateY(${own}px)` }, { transform: "none" }], {
          duration: MORPH_MS,
          easing: MORPH_EASE,
        });
        glides.current.set(node, glide);
        const ended = (): void => {
          if (glides.current.get(node) === glide) glides.current.delete(node);
        };
        glide.finished.then(ended, ended);
      }
      if (!still) {
        for (const node of partsNow) {
          const key = node.getAttribute("data-k") as string;
          if (before.parts.has(key) || node.parentElement?.closest(".sp-fade")) continue;
          node.classList.add("sp-fade");
          node.addEventListener("animationend", () => node.classList.remove("sp-fade"), { once: true });
        }
        // A row that is gone folds away. One that sat inside a row that is
        // gone too is carried by that row's copy.
        for (const [key, row] of before.rows) {
          if (tops.has(key) || GIVES_WAY.test(key)) continue;
          if (row.parent !== null && !tops.has(row.parent)) continue;
          fold(el, row, ghosts.current);
        }
      }
    } else if (moving.current) {
      // Nothing of the last page folds over the new one.
      for (const ghost of ghosts.current) ghost.remove();
      ghosts.current.clear();
      // Another step: the old one left to one side, and this one arrives from
      // the other.
      const { direction, out } = moving.current;
      out?.cancel();
      if (!still) {
        el.animate(
          [
            { opacity: 0, transform: `translateX(${14 * direction}px)` },
            { opacity: 1, transform: "none" },
          ],
          { duration: 220, easing: MORPH_EASE },
        );
      }
      moving.current = null;
    }
    drawn.current = { screen: step, tops, rows, parts };

    const want = focusWant.current;
    focusWant.current = null;
    if (!want) return;
    if (want !== "first") {
      // An answer is named by its path: its field, or its menu.
      const ids = want.startsWith("path:") ? [`in:${want.slice(5)}`, `menu:${want.slice(5)}`] : [want];
      for (const fid of ids) {
        const target = document.querySelector<HTMLElement>(`[data-fid="${fid}"]`);
        if (target) {
          target.focus();
          return;
        }
      }
    }
    // The first control of the page holds the keyboard, so the first arrow
    // key moves a choice that is already there. On the AI model page that is
    // the key, while it is empty. On the last step it is the main button.
    const ctl = el.querySelector<HTMLElement>(".su-ctl");
    let first: HTMLElement | null = null;
    if (ctl && step < stepsRef.current.length) {
      const key = ctl.querySelector<HTMLInputElement>('[data-fid="in:model.key"]');
      if (stepsRef.current[step]?.id === "model" && key && !key.readOnly && key.value === "" && !key.placeholder.startsWith("•")) {
        first = key;
      } else {
        first = ctl.querySelector<HTMLElement>(
          '.su-opt[tabindex="0"], .su-tile[tabindex="0"], .su-mod, .su-cbx, .su-inp:not([readonly]), .su-pill:not([disabled])',
        );
      }
    }
    const target = first ?? mainButton.current;
    target?.focus();
    if (target instanceof HTMLInputElement && target.type !== "password") target.select();
  });

  // ── Drawing ────────────────────────────────────────────────────────────────
  const orgName = answers?.organization.name.trim() ?? "";
  const bar = (
    <div className="su-bar">
      <div className="su-mark" aria-hidden="true">
        <i></i>
        <i></i>
        <i></i>
        <i></i>
      </div>
      <div className="su-wordmark">HX Fortress</div>
      <div className="su-spacer"></div>
      <div className="su-chip">
        <span className={finished ? "dot ok" : "dot"}></span>
        <b>{orgName || "New HX Fortress"}</b>
        <span>{finished ? "live" : "setup"}</span>
      </div>
      <button
        type="button"
        className="su-iconbtn"
        aria-label="Theme"
        // A click here leaves the keyboard where it was.
        onMouseDown={(e) => e.preventDefault()}
        onClick={switchTheme}
      >
        {app.theme === "dark" ? SUN : MOON}
      </button>
    </div>
  );

  if (phase.kind !== "ready" || !frame || !answers || !derived) {
    return (
      <div className="su">
        <div className="su-wrap">
          {bar}
          <div className="su-card su-card-alone">
            <div className="su-body su-body-alone">
              {phase.kind === "closed" ? (
                <p className="su-closed">
                  <Words text={phase.message} />.
                </p>
              ) : (
                <Spinner />
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const last = frame.last;
  const id = stepDef?.id ?? null;
  const pictureWords = {
    keys: steps.find((s) => s.id === "keys")?.name ?? "",
    database: steps.find((s) => s.id === "data")?.name ?? "",
    signIn: steps.find((s) => s.id === "signIn")?.name ?? "",
  };
  const picture = pictureOf(answers, {
    moduleTitles: Object.fromEntries(frame.modules.map((module) => [module.id, module.title])),
  });
  const part = id ? (PICTURE_PART[id] ?? null) : null;
  const typedPaths = Array.from(new Set([...derived.typed, ...Array.from(typedHere)]));
  const derivedShown: SetupDerived = typedPaths.length === derived.typed.length ? derived : { ...derived, typed: typedPaths };

  // What the step's check says: what it found, and the refusals the person
  // was shown. A line about an answer that changed since waits for the next.
  const shownCheck = ((): StepCheck | null => {
    if (!id) return null;
    const latest = checks[id];
    const notes = (latest?.lines ?? []).filter((line) => !refusesLine(line) && !(line.path && pending.has(line.path)));
    const armed = alerts[id] ?? [];
    if (!latest && armed.length === 0) return null;
    return { step: id, ok: armed.length === 0, lines: [...armed, ...notes] };
  })();

  const title = finished ? last.done : onLast ? (making ? last.busy : last.ask) : (stepDef?.question ?? "");
  const mainLabel = finished
    ? last.open
    : onLast
      ? making
        ? last.busyButton
        : last.yes
      : needsSignIn
        ? "Check Again"
        : "Continue";
  const mainBusy = making || opening || busy === "continue" || busy === "again";
  const pillsLocked = making || finished;

  const planRows = derived.plan.rows.map((row) => {
    const made = finished || progress?.made.includes(row.id) === true;
    const now = making && progress?.now === row.id;
    const waiting = now && progress?.dns ? progress.dns : null;
    const failed = progress?.failure?.row === row.id ? progress.failure : null;
    const value = waiting ? "Waiting for this record at your DNS provider" : made && row.id === dnsRow ? `${row.value}, found` : row.value;
    return (
      <div className={made ? "su-prow made" : "su-prow"} key={row.id} data-k={`pr-${row.id}`}>
        <span className="ic">{made ? CHECK_ICON : now ? <Spinner /> : <i className={failed ? "bad" : undefined} />}</span>
        <span className="k">{row.label}</span>
        <span className="v">{value}</span>
        {waiting ? (
          <div className="su-dnsr" data-k={`dns-${row.id}`}>
            <div className="v">
              CNAME {waiting.name} → {waiting.target}
            </div>
            <CopyButton text={waiting.target} fid="copy:dns" />
          </div>
        ) : null}
        {failed ? (
          <div className="su-fail" role="alert" data-k={`fail-${row.id}`}>
            <Words text={failed.text} />
          </div>
        ) : null}
      </div>
    );
  });

  return (
    <div className="su">
      <div className="su-wrap">
        {bar}
        <div className="su-steps">
          {steps.map((s, index) => (
            <button
              type="button"
              key={s.id}
              className={index === step ? "su-st cur" : index < step || finished ? "su-st done" : "su-st"}
              aria-label={s.name}
              aria-current={index === step ? "step" : undefined}
              disabled={pillsLocked}
              onClick={() => go(index)}
            >
              {String(index + 1).padStart(2, "0")}
              <span className="su-tip">
                {s.name}
                {index < DIGITS.length ? <span className="k">{DIGITS[index]}</span> : null}
              </span>
            </button>
          ))}
          <button
            type="button"
            className={onLast ? "su-st cur" : finished ? "su-st done" : "su-st"}
            aria-label={last.kicker}
            aria-current={onLast ? "step" : undefined}
            disabled={pillsLocked}
            onClick={() => go(lastIndex)}
          >
            {CHECK_ICON}
            <span className="su-tip">
              {last.kicker}
              {lastIndex < DIGITS.length ? <span className="k">{DIGITS[lastIndex]}</span> : null}
            </span>
          </button>
        </div>

        <div className="su-card">
          <div className="su-head">
            <div className="su-kicker">
              {finished ? (
                last.doneKicker
              ) : onLast ? (
                last.kicker
              ) : (
                <>
                  Step <span className="mono">{step + 1}</span> of <span className="mono">{steps.length}</span> · {stepDef?.name}
                </>
              )}
            </div>
            <h1>{title}</h1>
          </div>

          <div className="su-body" ref={body}>
            <div className="su-split">
              <div className="su-ctl">
                {stepDef ? (
                  <StepControls
                    step={stepDef}
                    frame={frame}
                    answers={answers}
                    derived={derivedShown}
                    check={shownCheck}
                    onSet={change}
                    onTyped={typed}
                    onLeave={() => {
                      if (id) checkIfChanged(id);
                    }}
                  />
                ) : (
                  <>
                    <div className="su-grp" data-k="plan">
                      <div className="su-lbl">{derived.plan.heading}</div>
                      <div className="su-plan">{planRows}</div>
                    </div>
                    {createError ? (
                      <div className="su-line bad" role="alert" data-k={`ln-${createError}`}>
                        <i />
                        <span>
                          <Words text={createError} />
                        </span>
                      </div>
                    ) : null}
                    {finished && done
                      ? [...done.notes, done.next].filter(Boolean).map((line) => (
                          <div className="su-note" key={line} data-k={`done-${line}`}>
                            <Words text={line} />
                          </div>
                        ))
                      : null}
                    {finished && notYet ? (
                      <div className="su-line bad" role="alert" data-k="ln-not-yet">
                        <i />
                        <span>HX Fortress does not answer at this address yet.</span>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
              <div className="su-pic">
                <SetupPicture picture={picture} part={part} words={pictureWords} />
              </div>
            </div>
          </div>

          <div className="su-foot">
            {step > 0 && !making && !finished ? (
              <button type="button" className="su-btn ghost" data-fid="act:back" onClick={back}>
                <span className="key">⇧↵</span>
                Back
              </button>
            ) : null}
            <div className="su-grow"></div>
            <button
              type="button"
              ref={mainButton}
              className="su-btn"
              data-fid="act:primary"
              // Waiting is said with aria-disabled, not disabled: a disabled
              // button would drop the keyboard that it holds.
              aria-disabled={making ? true : undefined}
              aria-busy={mainBusy ? true : undefined}
              onClick={primary}
            >
              {mainBusy ? <Spinner /> : null}
              {mainLabel}
              <span className="key">↵</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
