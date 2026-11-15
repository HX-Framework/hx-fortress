import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import "../account.css";

import { ApiError, type SecondStepChallenge } from "../api";
import { qrOf, waitSentence } from "../lib/second-step";
import { copyText } from "../lib/util";
import { qrPath, QUIET_ZONE, type QrMatrix } from "../qr";
import { useApp } from "../state";

const EASE = "cubic-bezier(.2,.8,.2,1)";
/** How long a card takes to change from one thing it holds to the next. */
export const MORPH_MS = 340;

/** The six digits, whatever else was typed or pasted around them. */
const CODE_LENGTH = 6;

interface Snapshot {
  top: number;
  height: number;
  /** Where each sibling of the card stood, so it can glide to its new place. */
  siblings: Map<HTMLElement, number>;
}

/**
 * A card that changes what it holds MORPHS rather than being replaced: one
 * element, whose box glides from its old size to its new one while the new
 * content fades in, and whose siblings glide to their new places with it.
 *
 * Only clip-path, transform and opacity move. The card's box is drawn by a
 * layer of its own (`.ac-morph-bg`), made as tall as the taller of the two
 * sizes for the length of the glide and clipped from the old height to the
 * new one, so nothing is laid out again while it moves.
 *
 * `capture()` is called right before the state change; the glide runs after
 * the render that `key` changes in.
 */
export function useCardMorph(key: string): {
  card: React.RefObject<HTMLDivElement>;
  capture: () => void;
} {
  const card = useRef<HTMLDivElement>(null);
  const before = useRef<Snapshot | null>(null);
  const running = useRef<Animation[]>([]);

  const capture = useCallback(() => {
    const el = card.current;
    if (!el) return;
    // A glide still in flight lands first, so it is measured where it rests.
    for (const animation of running.current) animation.finish();
    running.current = [];
    const box = el.getBoundingClientRect();
    const siblings = new Map<HTMLElement, number>();
    for (const node of Array.from(el.parentElement?.children ?? [])) {
      if (node !== el && node instanceof HTMLElement) siblings.set(node, node.getBoundingClientRect().top);
    }
    before.current = { top: box.top, height: box.height, siblings };
  }, []);

  useLayoutEffect(() => {
    const was = before.current;
    before.current = null;
    const el = card.current;
    if (!was || !el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const options: KeyframeAnimationOptions = { duration: MORPH_MS, easing: EASE };
    const box = el.getBoundingClientRect();
    const animations: Animation[] = [];

    const bg = el.querySelector<HTMLElement>(":scope > .ac-morph-bg");
    if (bg && Math.abs(was.height - box.height) > 0.5) {
      const tall = Math.max(was.height, box.height);
      const radius = getComputedStyle(bg).borderTopLeftRadius || "16px";
      // Bottom of the layer at the taller of the two edges, for the glide only.
      bg.style.bottom = `${box.height - tall - 1}px`;
      const clip = (height: number): string => `inset(0 0 ${tall - height}px 0 round ${radius})`;
      const grow = bg.animate([{ clipPath: clip(was.height) }, { clipPath: clip(box.height) }], options);
      const settle = (): void => {
        bg.style.bottom = "";
      };
      grow.finished.then(settle, settle);
      animations.push(grow);
    }
    const dy = was.top - box.top;
    if (Math.abs(dy) > 0.5) {
      animations.push(el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], options));
    }
    const body = el.querySelector<HTMLElement>(":scope > .ac-morph-body");
    if (body) {
      animations.push(
        body.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], options),
      );
    }
    for (const [node, top] of was.siblings) {
      if (!node.isConnected) continue;
      const shift = top - node.getBoundingClientRect().top;
      if (Math.abs(shift) > 0.5) {
        animations.push(node.animate([{ transform: `translateY(${shift}px)` }, { transform: "none" }], options));
      }
    }
    running.current = animations;
  }, [key]);

  return { card, capture };
}

/** The QR code of an otpauth:// address, drawn in this page. Dark on light in
 *  both themes: that is what a phone's camera reads. */
export function QrCode({ matrix }: { matrix: QrMatrix }): React.ReactElement {
  const span = matrix.size + 2 * QUIET_ZONE;
  return (
    <svg
      className="ac-qr"
      viewBox={`0 0 ${span} ${span}`}
      role="img"
      aria-label="QR code of your setup key, for an authenticator app"
      shapeRendering="crispEdges"
    >
      <rect width={span} height={span} fill="#ffffff" />
      <path d={qrPath(matrix)} fill="#0e0e12" />
    </svg>
  );
}

/** A base32 key in groups of four, the way an app's "enter a key" screen
 *  shows it. Two lines of four groups for a 32-character key. */
function keyLines(secret: string): string[] {
  const groups = secret.match(/.{1,4}/g) ?? [secret];
  const lines: string[] = [];
  for (let i = 0; i < groups.length; i += 4) lines.push(groups.slice(i, i + 4).join(" "));
  return lines;
}

/** What a code that was taken led to: the session is held, or the code was
 *  taken (the finishing call answered 200) and the session could not be read
 *  after it. Either way, what the code finished is done. */
export type SecondStepOutcome = "signed-in" | "taken";

export interface SecondStepProps {
  challenge: SecondStepChallenge;
  /** "auth": inside the sign-in card. "account": the setup page's card. */
  look: "auth" | "account";
  submitLabel: string;
  /** Called once the code was taken. */
  onFinished?: (outcome: SecondStepOutcome) => void;
  /** Leave this sign-in for the password step. Esc does the same. */
  onBack?: () => void;
  /** The ticket is over: only the first factor starts another. `status` tells
   *  a refusal of the account's kind (403, the sign-in itself was proved) from
   *  a ticket that ended (401). */
  onRestart: (message: string, status: number) => void;
}

/**
 * The second step of a sign-in: the code from an authenticator app, and for a
 * person with none set up yet, the QR code and the key to set one up with.
 *
 * The code field holds the keyboard as soon as it shows. Enter sends it, Esc
 * goes back, and a refusal floats over the field so nothing moves.
 */
export function SecondStep(props: SecondStepProps): React.ReactElement {
  const app = useApp();
  const { challenge, look } = props;
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const field = useRef<HTMLInputElement>(null);
  const enrolling = challenge.secondStep === "enroll";
  // Drawn once per key. Never throws into the render: without a code the key
  // is still shown, as text.
  const qr = useMemo(
    () => (challenge.secondStep === "enroll" ? qrOf(challenge.uri) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [challenge.ticket],
  );

  useLayoutEffect(() => {
    field.current?.focus({ preventScroll: true });
  }, [challenge.ticket]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    if (code.length !== CODE_LENGTH) {
      setRefusal("Type the 6 digits your app shows.");
      field.current?.focus();
      return;
    }
    setBusy(true);
    setRefusal(null);
    let outcome: SecondStepOutcome;
    try {
      outcome = await app.finishSecondStep(challenge.ticket, code);
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.restart) {
        props.onRestart(err.message, err.status);
        return;
      }
      // The server's sentence, and the wait it named when there is one: the
      // account's second step is closed for a while after too many wrong codes.
      setRefusal(
        err instanceof ApiError && err.fromBody
          ? err.more.waitMs !== undefined
            ? `${err.message} ${waitSentence(err.more.waitMs)}`
            : err.message
          : "That code could not be checked. Try again.",
      );
      setCode("");
      field.current?.focus();
      return;
    }
    setBusy(false);
    // The code was taken. What happens next is the caller's, and nothing here
    // reads it as a refusal.
    props.onFinished?.(outcome);
  };

  const copyKey = (): void => {
    if (challenge.secondStep !== "enroll") return;
    // Says what happened: a browser that would not copy is told apart from one
    // that did, so nobody pastes a key that never left the page.
    setCopy(copyText(challenge.secret) ? "copied" : "failed");
    setTimeout(() => setCopy("idle"), 1_600);
    // The copy borrows the keyboard for a moment; the code field takes it back.
    field.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape" && props.onBack) {
      e.preventDefault();
      props.onBack();
    }
  };

  // Where a refusal shows. On the code screen it floats over the form above
  // the field, so nothing moves. On the enrollment screen the QR code and the
  // Copy key button sit above the field, and a refusal must never cover them,
  // so it is part of the flow below the field and moves the buttons down.
  const tip =
    refusal && !enrolling ? (
      <div className="ac-tip" id="ac-code-tip" role="alert">
        {refusal}
      </div>
    ) : null;
  const inFlow =
    refusal && enrolling ? (
      <div className="ac-refusal" id="ac-code-tip" role="alert">
        {refusal}
      </div>
    ) : null;

  const input = (
    <input
      ref={field}
      id="ac-code"
      className="ac-inp ac-code"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      spellCheck={false}
      value={code}
      aria-invalid={refusal ? true : undefined}
      aria-describedby={refusal ? "ac-code-tip" : undefined}
      onChange={(e) => {
        setCode(e.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH));
        setRefusal(null);
      }}
    />
  );

  const submitButton = (
    <button className="btn" type="submit" aria-disabled={busy ? true : undefined}>
      {props.submitLabel}
      <span className="key">↵</span>
    </button>
  );
  const backButton = props.onBack ? (
    <button className="btn ghost" type="button" onClick={props.onBack}>
      Back
      <span className="key">esc</span>
    </button>
  ) : null;

  return (
    <form className={`ac-step ${look}`} onSubmit={(e) => void submit(e)} onKeyDown={onKeyDown} noValidate>
      {challenge.secondStep === "enroll" ? (
        <div className={qr ? "ac-enroll" : "ac-enroll no-qr"}>
          {qr ? <QrCode matrix={qr} /> : null}
          <div className="ac-key">
            <div className="ac-keylabel">
              {qr ? "Or type this key into the app" : "Type this key into an authenticator app"}
            </div>
            <code className="ac-secret">
              {keyLines(challenge.secret).map((line) => (
                <span key={line}>{line}</span>
              ))}
            </code>
            <button className="btn ghost sm ac-copy" type="button" onClick={copyKey}>
              {copy === "copied" ? "Copied" : copy === "failed" ? "Copy failed" : "Copy key"}
            </button>
          </div>
        </div>
      ) : null}
      {look === "account" ? (
        <>
          <div className="ac-flds">
            <div className={refusal ? "ac-fld err" : "ac-fld"}>
              <label htmlFor="ac-code">Code</label>
              {input}
              {tip}
            </div>
            {inFlow}
          </div>
          <div className="ac-row">
            <span className="ac-note">{challenge.secondStep === "enroll" ? "This key is shown once." : ""}</span>
            <span className="ac-btns">
              {backButton}
              {submitButton}
            </span>
          </div>
        </>
      ) : (
        <>
          <label htmlFor="ac-code">Code</label>
          <div className={refusal ? "ac-codewrap err" : "ac-codewrap"}>
            {input}
            {tip}
          </div>
          {inFlow}
          <div className="ac-actions">
            {backButton}
            {submitButton}
          </div>
        </>
      )}
    </form>
  );
}
