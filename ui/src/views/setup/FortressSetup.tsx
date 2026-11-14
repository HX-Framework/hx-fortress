import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import "../../setup.css";

import { cloneAnswers, setAnswer, splitList, type SetupAnswers } from "../../../../src/setup/answers";
import { STEP_IDS, type StepId } from "../../../../src/setup/list";
import type { SetupDerived, SetupDone, SetupFrame, SetupState, StepCheck } from "../../../../src/setup/view";
import { takeFragmentToken, useApp } from "../../state";
import { CHECK_ICON, FileText, SetupViewProvider, StepBody, Words, type SetupView } from "./blocks";
import { readSetupSession, setupApi, SetupClosed, SetupNotNow, NO_ANSWER, type EnrollAnswer } from "./client";

// `ended` is false when only the host did not answer the first load: the
// session is kept, so a reload tries again.
type Phase =
  | { kind: "opening" }
  | { kind: "closed"; message: string; ended: boolean }
  | { kind: "ready" }
  | { kind: "done"; done: SetupDone };

/** The review is the screen after the last question. */
const REVIEW = STEP_IDS.length;
const EASE = "cubic-bezier(.2,.8,.2,1)";
/** How long a row takes to open, to close, and to glide to its new place. One
 *  time for all three, so the edge of a row that opens or closes stays against
 *  the rows that move beside it. `.su-reveal` in setup.css holds the same time. */
const MORPH_MS = 320;

/** A row as it was last drawn: where it stood inside the screen, and the row
 *  that held it. */
interface Row {
  node: HTMLElement;
  top: number;
  left: number;
  width: number;
  parent: string | null;
}

/** A line that a check wrote is replaced by the next line, in the same place.
 *  Folding the old one while the new one unfolds would be two things fading
 *  through each other, so a line simply gives way. */
const GIVES_WAY = /^(ln|nt)-/;

/**
 * Fold a row away where it stood: the way it unfolded when it came, run
 * backwards. What folds is a copy that takes no room and that nothing can
 * reach, so the rows below glide up beside it in the same time.
 */
function fold(within: HTMLElement, row: Row, ghosts: Set<HTMLElement>): void {
  const ghost = row.node.cloneNode(true) as HTMLElement;
  for (const node of [ghost, ...Array.from(ghost.querySelectorAll<HTMLElement>("[data-k], [data-fid], [id]"))]) {
    node.removeAttribute("data-k");
    node.removeAttribute("data-fid");
    node.removeAttribute("id");
  }
  ghost.inert = true;
  ghost.setAttribute("aria-hidden", "true");
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
    { duration: MORPH_MS, easing: EASE, fill: "forwards" },
  );
  const remove = (): void => {
    ghost.remove();
    ghosts.delete(ghost);
  };
  gone.finished.then(remove, remove);
}

/** The least number of seconds between two asks whether a person has signed in. */
const SIGN_IN_EVERY = 3;

/** How long a check waits before it is asked again when the host asked for
 *  fewer requests and did not say how long. */
const RETRY_SECONDS = 5;

/** What the review says when a finish got no answer. */
const FINISH_LOST = "The setup on the host did not answer. Press Finish again";

/** The digit key of each question, in order. A question after the last has none. */
const DIGITS = "1234567890";

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

function byStep(checks: readonly StepCheck[]): Partial<Record<StepId, StepCheck>> {
  return Object.fromEntries(checks.map((check) => [check.step, check]));
}

/**
 * The one-time browser setup of a new Fortress: its questions, on one card.
 *
 * Every screen is drawn from the list the host sends, so a question, an option
 * or a word changes in one place for the browser, the terminal and the
 * settings file. Each answer is checked on the host as it is given, and what
 * the check found is one line. While a person types, the host checks only what
 * it sees by itself. The full check, which can ask a service outside the host,
 * runs when the person is done with a field or a question.
 *
 * The keyboard does everything: Enter continues, Shift+Enter goes back, the
 * digits jump to a question, the arrows move a choice, Space flips a switch
 * and opens a menu. On every screen the first control already holds the
 * keyboard.
 */
export default function FortressSetup(): React.ReactElement {
  const app = useApp();
  const [token] = useState<string | null>(() => takeFragmentToken("s"));
  const [phase, setPhase] = useState<Phase>({ kind: "opening" });
  const [frame, setFrame] = useState<SetupFrame | null>(null);
  const [answers, setAnswers] = useState<SetupAnswers | null>(null);
  const [derived, setDerived] = useState<SetupDerived | null>(null);
  const [checks, setChecks] = useState<Partial<Record<StepId, StepCheck>>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [checking, setChecking] = useState<StepId | "all" | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [step, setStep] = useState(0);
  const [view, setView] = useState<"summary" | "file">("summary");
  // Finish waits while a finish, or the review's check of every question, is
  // in flight. The refs below decide; these two draw it.
  const [finishing, setFinishing] = useState(false);
  const [checkingAll, setCheckingAll] = useState(false);
  const [finishLost, setFinishLost] = useState(false);
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // The questions the person has left at least once. Until then an empty
  // field is not called wrong.
  const [left, setLeft] = useState<ReadonlySet<StepId>>(() => new Set());

  const answersRef = useRef<SetupAnswers | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const checksRef = useRef(checks);
  checksRef.current = checks;
  const stepRef = useRef(0);
  stepRef.current = step;
  const signInEvery = useRef(SIGN_IN_EVERY);
  signInEvery.current = Math.max(SIGN_IN_EVERY, derived?.enrollment.interval || 0);
  const quickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retries = useRef(new Set<ReturnType<typeof setTimeout>>());
  // Every ask that can bring a question's result takes the next number.
  // `latest` is the number of the latest check or finish, `latestFor` the
  // latest check of each question, and `resultFrom` the ask whose result each
  // question shows.
  const asked = useRef(0);
  const latest = useRef(0);
  const latestFor = useRef<Partial<Record<StepId | "all", number>>>({});
  const resultFrom = useRef<Partial<Record<StepId, number>>>({});
  // How many times each question's answers changed, and which change and ask
  // its last full check was for.
  const edits = useRef<Partial<Record<StepId, number>>>({});
  const fullAsked = useRef<Partial<Record<StepId, { edit: number; ask: number }>>>({});
  const finishingRef = useRef(false);
  /** The review's check of every question while it is in flight, or 0. */
  const allAsk = useRef(0);
  const signInAsk = useRef<Promise<EnrollAnswer> | null>(null);
  const seenSent = useRef(false);
  const body = useRef<HTMLDivElement | null>(null);
  const foot = useRef<HTMLDivElement | null>(null);
  const lastScreen = useRef<HTMLDivElement | null>(null);
  const focusWant = useRef<string | null>("first");
  const drawn = useRef<{ step: number; view: string; tops: Map<string, number>; rows: Map<string, Row> } | null>(null);
  const moving = useRef<{ direction: number; out: Animation | null } | null>(null);
  const glides = useRef(new Map<HTMLElement, Animation>());
  /** Copies of rows that are folding away. */
  const ghosts = useRef(new Set<HTMLElement>());

  // A setup that has ended closes the screen. Anything else that goes wrong
  // there is a host that did not answer. The last screen stays: a request that
  // was still out when the setup ended is refused, and says nothing new.
  const close = useCallback((error: unknown): void => {
    setPhase((was) =>
      was.kind === "done"
        ? was
        : error instanceof SetupClosed
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
        else if (!readSetupSession()) {
          throw new SetupClosed("This page opens from the setup link that the host printed");
        }
        const state = await setupApi.state();
        if (cancelled) return;
        if ("done" in state) {
          setPhase({ kind: "done", done: state.done });
          return;
        }
        answersRef.current = state.answers;
        setFrame(state.frame);
        setAnswers(state.answers);
        setDerived(state.derived);
        setPhase({ kind: "ready" });
      } catch (error) {
        // Nothing is drawn yet, so even a host that only did not answer leaves
        // the closed screen.
        if (!cancelled) close(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, close]);

  // The session ends with the setup, so a link opened in this tab later is not
  // taken for it. The last screen first tells the host that it arrived: that
  // request already holds the session when the session is forgotten.
  useEffect(() => {
    if (phase.kind === "done" && !seenSent.current) {
      seenSent.current = true;
      void setupApi.seen().catch(() => {});
      setupApi.forget();
    } else if (phase.kind === "closed" && phase.ended) {
      setupApi.forget();
    }
  }, [phase]);

  // A check that waits is dropped once the questions are gone from the screen.
  useEffect(() => {
    if (phase.kind !== "ready") return;
    const timers = retries.current;
    return () => {
      for (const timer of [quickTimer, nowTimer]) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
      }
      for (const retry of timers) clearTimeout(retry);
      timers.clear();
    };
  }, [phase.kind]);

  // ── Checks ─────────────────────────────────────────────────────────────────
  /** Take the results that ask number `mine` brought. A question shows the
   *  result of the latest ask that answered for it, in whatever order the
   *  replies arrive and whether they answered for one question or for all. */
  const take = useCallback((mine: number, results: readonly StepCheck[]): void => {
    const fresh = results.filter((one) => mine > (resultFrom.current[one.step] ?? 0));
    if (fresh.length === 0) return;
    for (const one of fresh) resultFrom.current[one.step] = mine;
    setChecks((was) => ({ ...was, ...byStep(fresh) }));
  }, []);

  /** True when an answer of the question changed since its last full check
   *  was asked for, or that check brought nothing back. */
  const changedSinceFull = useCallback(
    (id: StepId): boolean => fullAsked.current[id]?.edit !== (edits.current[id] ?? 0),
    [],
  );

  const runCheck = useCallback(
    async (which: StepId | "all", quick = false, again = false): Promise<void> => {
      const current = answersRef.current;
      if (!current || phaseRef.current.kind !== "ready") return;
      const mine = (asked.current += 1);
      latest.current = mine;
      latestFor.current[which] = mine;
      // A full check covers the answers as they are now, and makes a quick
      // check that waits for a pause in the typing needless.
      const covers: readonly StepId[] = quick ? [] : which === "all" ? STEP_IDS : [which];
      for (const id of covers) fullAsked.current[id] = { edit: edits.current[id] ?? 0, ask: mine };
      if (!quick && quickTimer.current) {
        clearTimeout(quickTimer.current);
        quickTimer.current = null;
      }
      if (which === "all") {
        allAsk.current = mine;
        setCheckingAll(true);
      }
      setChecking(which);
      try {
        const answer = await setupApi.check(current, which, quick);
        take(mine, "checks" in answer ? answer.checks : answer.check ? [answer.check] : []);
        // What is worked out from the answers comes from the latest ask.
        if (latest.current === mine) {
          setDerived(answer.derived);
          setPending(new Set());
        }
      } catch (error) {
        for (const id of covers) if (fullAsked.current[id]?.ask === mine) delete fullAsked.current[id];
        if (error instanceof SetupClosed) {
          close(error);
          return;
        }
        // Anything else leaves the screen as it is. A host that asked for
        // fewer requests is asked once more, after the wait it named, unless
        // a later check of the same thing went out meanwhile.
        if (!again && error instanceof SetupNotNow && error.status === 429) {
          const retry = setTimeout(
            () => {
              retries.current.delete(retry);
              if (latestFor.current[which] !== mine) return;
              if (which === "all" && (stepRef.current !== REVIEW || finishingRef.current)) return;
              void runCheck(which, quick, true);
            },
            (error.retryAfter ?? RETRY_SECONDS) * 1000,
          );
          retries.current.add(retry);
        }
      } finally {
        if (latest.current === mine) setChecking(null);
        if (allAsk.current === mine) {
          allAsk.current = 0;
          setCheckingAll(false);
        }
      }
    },
    [take, close],
  );

  /** Check a question in full when an answer in it changed since its last full check. */
  const checkIfChanged = useCallback(
    (id: StepId): void => {
      if (changedSinceFull(id)) void runCheck(id);
    },
    [changedSinceFull, runCheck],
  );

  const currentStepId = (index: number): StepId | null => STEP_IDS[index] ?? null;

  // Typing is checked once it pauses, and only for what the host sees by
  // itself. A choice, a switch or a menu is checked in full at once.
  const schedule = useCallback(
    (how: "now" | "typing"): void => {
      const id = currentStepId(stepRef.current);
      if (!id) return;
      if (how === "now") {
        if (nowTimer.current) clearTimeout(nowTimer.current);
        nowTimer.current = setTimeout(() => {
          nowTimer.current = null;
          void runCheck(id);
        }, 0);
        return;
      }
      if (quickTimer.current) clearTimeout(quickTimer.current);
      quickTimer.current = setTimeout(() => {
        quickTimer.current = null;
        void runCheck(id, true);
      }, 300);
    },
    [runCheck],
  );

  const change = useCallback(
    (path: string, value: string | boolean | string[], how: "now" | "typing", focus?: string): void => {
      const current = answersRef.current;
      if (!current) return;
      const next = cloneAnswers(current);
      if (!setAnswer(next, path, value)) return;
      answersRef.current = next;
      setAnswers(next);
      setPending((was) => new Set(was).add(path));
      const id = currentStepId(stepRef.current);
      if (id) edits.current[id] = (edits.current[id] ?? 0) + 1;
      if (path.startsWith("controlPlane.")) setEnrollError(null);
      // A choice that changes what is on the screen keeps the keyboard where it
      // was: on the option, the switch or the menu that was just used. An arrow
      // key names the option it moved to.
      if (how === "now") focusWant.current = focus ?? "keep";
      schedule(how);
    },
    [schedule],
  );

  const typeList = useCallback(
    (path: string, text: string): void => {
      setTexts((was) => ({ ...was, [path]: text }));
      change(path, splitList(text), "typing");
    },
    [change],
  );

  // A question is checked in full when it is shown with no result yet, and
  // every question is checked when the review is shown.
  useEffect(() => {
    if (phase.kind !== "ready") return;
    if (step === REVIEW) {
      void runCheck("all");
      return;
    }
    const id = currentStepId(step);
    if (id && !checksRef.current[id]) checkIfChanged(id);
  }, [step, phase.kind, runCheck, checkIfChanged]);

  // ── Moving between the steps ───────────────────────────────────────────────
  const go = useCallback(
    (to: number): void => {
      const from = stepRef.current;
      if (to === from || to < 0 || to > REVIEW || moving.current) return;
      // A check that waits is overtaken by the full check of the question left.
      for (const timer of [quickTimer, nowTimer]) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
      }
      const leaving = currentStepId(from);
      if (leaving) {
        checkIfChanged(leaving);
        setLeft((was) => (was.has(leaving) ? was : new Set(was).add(leaving)));
      } else {
        setFinishLost(false);
      }
      const direction = to > from ? 1 : -1;
      const el = body.current;
      const out =
        el?.animate(
          [
            { opacity: 1, transform: "none" },
            { opacity: 0, transform: `translateX(${-14 * direction}px)` },
          ],
          { duration: 110, easing: "ease-in", fill: "forwards" },
        ) ?? null;
      moving.current = { direction, out };
      const arrive = (): void => {
        focusWant.current = "first";
        setStep(to);
      };
      if (out) out.finished.then(arrive, arrive);
      else arrive();
    },
    [checkIfChanged],
  );

  // ── Enrolling with a control plane ─────────────────────────────────────────
  const takeEnrollment = useCallback(
    (mine: number, answer: EnrollAnswer): void => {
      setDerived(answer.derived);
      take(mine, "check" in answer && answer.check ? [answer.check] : []);
      setEnrollError("error" in answer ? answer.error : null);
    },
    [take],
  );

  // A button whose ask got no answer says so in a sentence, where the sign-in's
  // own errors show.
  const enrollFailed = useCallback(
    (error: unknown): void => {
      if (error instanceof SetupClosed) close(error);
      else setEnrollError(error instanceof SetupNotNow ? error.message : NO_ANSWER);
    },
    [close],
  );

  const getCode = useCallback((): void => {
    const current = answersRef.current;
    if (!current || enrollBusy) return;
    const mine = (asked.current += 1);
    setEnrollBusy(true);
    void setupApi
      .enroll(current)
      .then((answer) => takeEnrollment(mine, answer), enrollFailed)
      .finally(() => setEnrollBusy(false));
  }, [enrollBusy, takeEnrollment, enrollFailed]);

  /** Ask the host whether a person has signed in. The button and the repeated
   *  ask share the ask in flight, so there are never two. */
  const askSignIn = useCallback((): Promise<EnrollAnswer> => {
    if (signInAsk.current) return signInAsk.current;
    const mine = (asked.current += 1);
    const ask = setupApi.enrollCheck();
    signInAsk.current = ask;
    const ended = (): void => {
      if (signInAsk.current === ask) signInAsk.current = null;
    };
    void ask.then((answer) => {
      ended();
      takeEnrollment(mine, answer);
    }, ended);
    return ask;
  }, [takeEnrollment]);

  const checkCode = useCallback((): void => {
    setEnrollBusy(true);
    void askSignIn()
      .catch(enrollFailed)
      .finally(() => setEnrollBusy(false));
  }, [askSignIn, enrollFailed]);

  // While a code waits, the host is asked whether a person has signed in, so
  // the screen turns by itself. The next wait starts only when the last ask
  // has ended, and a hidden tab skips its asks until it is shown again.
  const waiting = phase.kind === "ready" && derived?.enrollment.state === "waiting";
  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const wait = (seconds: number): void => {
      timer = setTimeout(ask, Math.max(signInEvery.current, seconds) * 1000);
    };
    const ask = (): void => {
      if (stopped) return;
      if (document.hidden) {
        wait(0);
        return;
      }
      void askSignIn().then(
        () => {
          if (!stopped) wait(0);
        },
        (error: unknown) => {
          if (stopped) return;
          if (error instanceof SetupClosed) close(error);
          else wait(error instanceof SetupNotNow ? (error.retryAfter ?? 0) : 0);
        },
      );
    };
    wait(0);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [waiting, askSignIn, close]);

  // ── The end ────────────────────────────────────────────────────────────────
  const finish = useCallback((): void => {
    const current = answersRef.current;
    if (!current || finishingRef.current || allAsk.current !== 0) return;
    finishingRef.current = true;
    setFinishing(true);
    setFinishLost(false);
    const mine = (asked.current += 1);
    latest.current = mine;
    void (async (): Promise<void> => {
      try {
        const answer = await setupApi.finish(current);
        if ("done" in answer) {
          setPhase({ kind: "done", done: answer.done });
          return;
        }
        take(mine, answer.checks);
        if (latest.current === mine) setDerived(answer.derived);
        setLeft(new Set(STEP_IDS));
        const first = answer.checks.find((check) => !check.ok);
        if (first) go(STEP_IDS.indexOf(first.step));
      } catch (error) {
        // The answers may be written although the reply never arrived. The
        // host still says what the last screen shows.
        let after: SetupState | { done: SetupDone } | null = null;
        let again: unknown = null;
        try {
          after = await setupApi.state();
        } catch (failed) {
          again = failed;
        }
        if (after && "done" in after) setPhase({ kind: "done", done: after.done });
        else if (again instanceof SetupClosed) close(again);
        else if (error instanceof SetupClosed) close(error);
        else setFinishLost(true);
      } finally {
        finishingRef.current = false;
        setFinishing(false);
      }
    })();
  }, [take, go, close]);

  // ── The keyboard ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase.kind !== "ready") return;
    const onKey = (e: KeyboardEvent): void => {
      // A key that composes a word in an input method (Japanese, Chinese,
      // Korean) belongs to that input method.
      if (e.isComposing || e.keyCode === 229) return;
      const target = e.target as HTMLElement | null;
      if (document.querySelector("[data-menu-open]")) return; // a menu has the keyboard
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const typing = target?.tagName === "INPUT";
      if (e.key === "Enter") {
        // A key that is held down answers once. Otherwise one long press would
        // walk through every question and finish the setup.
        if (e.repeat) {
          e.preventDefault();
          return;
        }
        if (e.shiftKey) {
          e.preventDefault();
          go(stepRef.current - 1);
          return;
        }
        // A focused button answers Enter itself. A value with a menu does not
        // open on Enter, so that a walk through the setup is Enter on every question.
        if (target?.tagName === "BUTTON" && !target.hasAttribute("data-menu")) return;
        if (target?.tagName === "A") return;
        e.preventDefault();
        if (typing) target?.blur();
        if (stepRef.current < REVIEW) go(stepRef.current + 1);
        else finish();
        return;
      }
      if (!typing && /^[0-9]$/.test(e.key)) {
        const to = DIGITS.indexOf(e.key);
        if (to >= 0 && to < STEP_IDS.length) {
          e.preventDefault();
          go(to);
        }
        return;
      }
      // The review, top to bottom: the two views, a row for each question, then
      // Finish. Down from Finish goes round to the first row.
      const focus = (selector: string): void => {
        document.querySelector<HTMLElement>(selector)?.focus();
      };
      const up = e.key === "ArrowUp";
      if (target?.classList.contains("su-rvr") && (e.key === "ArrowDown" || up)) {
        e.preventDefault();
        const next = (up ? target.previousElementSibling : target.nextElementSibling) as HTMLElement | null;
        if (next) next.focus();
        else focus(up ? ".su-fpill.sel" : "[data-fid='act:finish']");
        return;
      }
      if (target?.dataset.fid === "act:finish" && (e.key === "ArrowDown" || up)) {
        e.preventDefault();
        const rows = document.querySelector(".su-rvr") !== null;
        focus(rows ? (up ? ".su-rvr:last-child" : ".su-rvr") : ".su-fpill.sel");
        return;
      }
      if (target?.classList.contains("su-fpill") && e.key === "ArrowDown") {
        e.preventDefault();
        focus(document.querySelector(".su-rvr") ? ".su-rvr" : "[data-fid='act:finish']");
        return;
      }
      if (target?.classList.contains("su-fpill") && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.preventDefault();
        focusWant.current = e.key === "ArrowRight" ? "view:file" : "view:summary";
        setView(e.key === "ArrowRight" ? "file" : "summary");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [phase.kind, go, finish]);

  // ── After each draw: motion, then the keyboard's place ─────────────────────
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || phase.kind !== "ready") return;
    const keyed = Array.from(el.querySelectorAll<HTMLElement>("[data-k]"));
    // Where each row is drawn at this moment, a glide in flight included. Then
    // every glide is ended, and each row is measured again where it rests. A
    // row measured while it moves would start its next glide from a place it
    // was only passing through, and a row typed into would drift off the card.
    const origin = (): number => el.getBoundingClientRect().top;
    const shownFrom = origin();
    const shown = new Map<HTMLElement, number>();
    for (const node of keyed) shown.set(node, node.getBoundingClientRect().top - shownFrom);
    for (const glide of glides.current.values()) glide.cancel();
    glides.current.clear();
    const restBox = el.getBoundingClientRect();
    const rest = new Map<HTMLElement, number>();
    const tops = new Map<string, number>();
    const rows = new Map<string, Row>();
    for (const node of keyed) {
      const box = node.getBoundingClientRect();
      const top = box.top - restBox.top;
      rest.set(node, top);
      tops.set(node.dataset.k as string, top);
      rows.set(node.dataset.k as string, {
        node,
        top,
        left: box.left - restBox.left,
        width: box.width,
        parent: node.parentElement?.closest<HTMLElement>("[data-k]")?.dataset.k ?? null,
      });
    }

    const before = drawn.current;
    if (before && before.step === step && before.view === view) {
      // The same screen after an answer changed. A row that is new unfolds. A
      // row that stays glides to its new place, and a row inside a row that
      // already moves is carried by it.
      const moved = new Map<HTMLElement, number>();
      for (const node of keyed) {
        const key = node.dataset.k as string;
        const was = before.tops.get(key);
        if (was === undefined) {
          if (!node.parentElement?.closest(".su-reveal")) {
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
        if (Math.abs(own) < 1 || node.closest(".su-reveal")) continue;
        const glide = node.animate([{ transform: `translateY(${own}px)` }, { transform: "none" }], {
          duration: MORPH_MS,
          easing: EASE,
        });
        glides.current.set(node, glide);
        const ended = (): void => {
          if (glides.current.get(node) === glide) glides.current.delete(node);
        };
        glide.finished.then(ended, ended);
      }
      // A row that is gone folds away. One that sat inside a row that is gone
      // too is carried by that row's copy.
      for (const [key, row] of before.rows) {
        if (tops.has(key) || GIVES_WAY.test(key)) continue;
        if (row.parent !== null && !tops.has(row.parent)) continue;
        fold(el, row, ghosts.current);
      }
    } else if (moving.current) {
      // Nothing of the last screen folds over the new one.
      for (const ghost of ghosts.current) ghost.remove();
      ghosts.current.clear();
      // Another step: the old one left to one side, and this one arrives from
      // the other.
      const { direction, out } = moving.current;
      out?.cancel();
      el.animate(
        [
          { opacity: 0, transform: `translateX(${14 * direction}px)` },
          { opacity: 1, transform: "none" },
        ],
        { duration: 220, easing: EASE },
      );
      moving.current = null;
    }
    drawn.current = { step, view, tops, rows };

    const want = focusWant.current;
    focusWant.current = null;
    if (!want || want === "keep") return;
    if (want !== "first") {
      document.querySelector<HTMLElement>(`[data-fid="${want}"]`)?.focus({ preventScroll: true });
      return;
    }
    // The first control of the screen holds the keyboard, so the first arrow
    // key moves a choice that is already there. On the review that is Finish:
    // Enter ends the setup, and the arrows go up through the rows.
    const first =
      el.querySelector<HTMLElement>('.su-opt[tabindex="0"]') ??
      el.querySelector<HTMLElement>(".su-mod") ??
      el.querySelector<HTMLElement>(".su-inp:not([readonly])") ??
      el.querySelector<HTMLElement>(".gpill") ??
      foot.current?.querySelector<HTMLElement>("[data-fid='act:next'], [data-fid='act:finish']");
    first?.focus({ preventScroll: true });
  });

  // The last screen's first control holds the keyboard.
  useLayoutEffect(() => {
    if (phase.kind !== "done") return;
    lastScreen.current?.querySelector<HTMLElement>("a[href], button")?.focus({ preventScroll: true });
  }, [phase.kind]);

  const copy = useCallback((what: string, text: string): void => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(what);
        setTimeout(() => setCopied((was) => (was === what ? null : was)), 1_600);
      },
      () => {},
    );
  }, []);

  const orgName = answers?.organization.name.trim() || "";
  const stepId = currentStepId(step);
  const stepDef = useMemo(() => frame?.list.find((s) => s.id === stepId) ?? null, [frame, stepId]);

  const setupView: SetupView | null =
    frame && answers && derived
      ? {
          frame,
          answers,
          derived,
          check: stepId ? (checks[stepId] ?? null) : null,
          pending,
          quiet: stepId !== null && !left.has(stepId),
          texts,
          change,
          typeList,
          blurred: () => {
            if (stepId) checkIfChanged(stepId);
          },
          getCode,
          checkCode,
          enrollBusy,
          enrollError,
        }
      : null;

  // ── Drawing ────────────────────────────────────────────────────────────────
  const themeButton = (
    <button
      className="iconbtn"
      aria-label="Switch theme"
      // A click here leaves the keyboard where it was, in the question.
      onMouseDown={(e) => e.preventDefault()}
      onClick={app.toggleTheme}
    >
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {app.theme === "dark" ? (
          <>
            <circle cx="10" cy="10" r="3.4" />
            <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
          </>
        ) : (
          <path d="M16.5 11.6A6.8 6.8 0 0 1 8.4 3.5a6.8 6.8 0 1 0 8.1 8.1z" />
        )}
      </svg>
      <span className="su-tip">Switch theme</span>
    </button>
  );

  const bar = (state: "setup" | "set up" | "closed"): React.ReactElement => (
    <div className="su-bar">
      <div className="mark">
        <i></i>
        <i></i>
        <i></i>
        <i></i>
      </div>
      <div className="wordmark">HX Fortress</div>
      <div className="spacer"></div>
      <div className="chip">
        <span className={state === "set up" ? "dot ok" : "dot"}></span>
        <b>{orgName || (phase.kind === "done" ? "This Fortress" : "New Fortress")}</b>
        <span>{state}</span>
      </div>
      {themeButton}
    </div>
  );

  if (phase.kind === "opening" || phase.kind === "closed") {
    return (
      <div className="su">
        <div className="su-wrap">
          {bar("closed")}
          <div className="su-card" style={{ minHeight: 0, marginTop: 12 }}>
            <div className="su-head">
              <div className="kicker">Setup</div>
              <h1>{phase.kind === "opening" ? "Opening the setup" : "Setup is closed"}</h1>
            </div>
            <div className="su-body">
              {phase.kind === "closed" ? (
                <div className="su-note">
                  <Words text={phase.message} />.
                </div>
              ) : (
                <div className="su-line wait">
                  <span className="su-spin" />
                  <span>Checking the link</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (phase.kind === "done") {
    const done = phase.done;
    const owner = done.summary.organization.split(" · ")[0] || "This";
    return (
      <div className="su">
        <div className="su-wrap">
          {bar("set up")}
          <div className="su-card" style={{ marginTop: 12 }}>
            <div className="su-head">
              <div className="kicker">Setup finished</div>
              <h1>{owner}'s Fortress is set up</h1>
            </div>
            <div className="su-body">
              <div
                className="su-done"
                ref={lastScreen}
                onKeyDown={(e) => {
                  // The arrows move between the screen's controls, top to bottom.
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("a[href], button"));
                  const here = controls.indexOf(e.target as HTMLElement);
                  const next = here < 0 ? undefined : controls[here + (e.key === "ArrowDown" ? 1 : -1)];
                  if (!next) return;
                  e.preventDefault();
                  next.focus();
                }}
              >
                <div className="facts">
                  <div className="frw">
                    <div className="k">Console</div>
                    <div className="v">
                      <a className="mono" href={done.consoleAddress}>
                        {done.consoleAddress}
                      </a>
                    </div>
                    <div className="vs"></div>
                  </div>
                  <div className="frw">
                    <div className="k">Sign-in</div>
                    <div className="v">{done.summary.signIn}</div>
                    <div className="vs"></div>
                  </div>
                  <div className="frw">
                    <div className="k">Modules</div>
                    <div className="v">{done.summary.modules}</div>
                    <div className="vs"></div>
                  </div>
                  <div className="frw">
                    <div className="k">Control plane</div>
                    <div className="v">{done.summary.controlPlane}</div>
                    <div className="vs"></div>
                  </div>
                </div>
                {done.firstAccount ? (
                  <div className="su-grp">
                    <div className="lbl">
                      {done.firstAccount.login} sets a password here, once, within 24 hours
                    </div>
                    <span className="su-link">{done.firstAccount.link}</span>
                    {typeof navigator.clipboard?.writeText === "function" ? (
                      <button
                        className="btn ghost sm"
                        style={{ marginTop: 8 }}
                        onClick={() => copy("account", done.firstAccount?.link ?? "")}
                      >
                        {copied === "account" ? "Copied" : "Copy the link"}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {done.notes.map((note) => (
                  <div className="su-line bad" key={note}>
                    <i />
                    <span>
                      <Words text={note} />
                    </span>
                  </div>
                ))}
                <div className="su-note">
                  <Words text={done.next} />.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!frame || !answers || !derived || !setupView) return <div className="su" />;

  const onReview = step === REVIEW;
  const stripState = (index: number): string => {
    if (index === step) return "su-st cur";
    const id = currentStepId(index);
    const check = id ? checks[id] : undefined;
    if (check && !check.ok) return "su-st bad";
    return index < step ? "su-st done" : "su-st";
  };

  return (
    <div className="su">
      <div className="su-wrap">
        {bar("setup")}
        <div className="su-steps">
          {frame.list.map((s, index) => (
            <button key={s.id} className={stripState(index)} aria-label={s.name} onClick={() => go(index)}>
              {String(index + 1).padStart(2, "0")}
              <span className="su-tip">
                {s.name}
                {index < DIGITS.length ? <span className="k">{DIGITS[index]}</span> : null}
              </span>
            </button>
          ))}
          <button className={stripState(REVIEW)} aria-label="Review" onClick={() => go(REVIEW)}>
            {CHECK_ICON}
            <span className="su-tip">Review</span>
          </button>
        </div>

        <div className="su-card">
          <div className="su-head">
            <div className="kicker">
              {onReview ? (
                "Review"
              ) : (
                <>
                  Step <span className="mono">{step + 1}</span> of <span className="mono">{STEP_IDS.length}</span> ·{" "}
                  {stepDef?.name}
                </>
              )}
            </div>
            <h1>{onReview ? `${orgName || "This"}'s Fortress` : stepDef?.question}</h1>
          </div>

          <div className="su-body" ref={body}>
            <SetupViewProvider value={setupView}>
              {onReview ? (
                <>
                  <div className="su-seg" data-k="seg">
                    <button
                      className={view === "summary" ? "su-fpill sel" : "su-fpill"}
                      data-fid="view:summary"
                      onClick={() => setView("summary")}
                    >
                      Summary
                    </button>
                    <button
                      className={view === "file" ? "su-fpill sel" : "su-fpill"}
                      data-fid="view:file"
                      onClick={() => setView("file")}
                    >
                      As a file
                    </button>
                    {view === "file" && typeof navigator.clipboard?.writeText === "function" ? (
                      <button className="su-fpill" style={{ marginLeft: "auto" }} onClick={() => copy("file", derived.file)}>
                        {copied === "file" ? "Copied" : "Copy"}
                      </button>
                    ) : null}
                  </div>
                  {view === "file" ? (
                    <div className="su-file" tabIndex={0} data-k="filev">
                      <FileText text={derived.file} />
                    </div>
                  ) : (
                    <div className="su-rv" data-k="rv">
                      {frame.list.map((s, index) => {
                        const check = checks[s.id];
                        const refused = check ? check.lines.filter((line) => !line.ok && !line.soft) : [];
                        return (
                          <button className="su-rvr" key={s.id} data-fid={`rv:${index}`} onClick={() => go(index)}>
                            <span className="k">{s.name}</span>
                            <span className="v">{derived.summary[s.id]}</span>
                            {refused.length > 0 ? <span className="wdot"></span> : check ? CHECK_ICON : <span />}
                            {refused.length > 0 ? (
                              <span className="why">
                                <Words text={refused[0]?.text ?? ""} />
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {finishLost ? (
                    <div className="su-rvx" data-k="finish-lost">
                      {FINISH_LOST}
                    </div>
                  ) : null}
                </>
              ) : stepDef ? (
                <StepBody step={stepDef} checking={checking === stepDef.id} />
              ) : null}
            </SetupViewProvider>
          </div>

          <div className="su-foot" ref={foot}>
            {step > 0 ? (
              <button className="btn ghost" data-fid="act:back" onClick={() => go(step - 1)}>
                <span className="key">⇧↵</span>
                Back
              </button>
            ) : null}
            <div className="grow"></div>
            {onReview ? (
              <button
                className="btn"
                data-fid="act:finish"
                // Waiting is said with aria-disabled, not disabled: a disabled
                // button would drop the keyboard that Finish holds on arrival.
                aria-disabled={finishing || checkingAll}
                onClick={finish}
              >
                Finish setup
                <span className="key">↵</span>
              </button>
            ) : (
              <button className="btn" data-fid="act:next" onClick={() => go(step + 1)}>
                Continue
                <span className="key">↵</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
