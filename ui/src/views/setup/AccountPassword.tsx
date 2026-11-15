import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import "../../account.css";

import { SIGN_IN_RECOVERY_COPY } from "../../../../src/ui/copy";
import { api, ApiError, challengeOf, type SecondStepChallenge } from "../../api";
import { DISCLOSURE_FOOTER } from "../../disclosure";
import { forgetSetupLink, keepSetupLink, keptSetupLink } from "../../lib/setup-link";
import { takeFragmentToken, useApp } from "../../state";
import { SecondStep, useCardMorph, type SecondStepOutcome } from "../SecondStep";

/** The server's own floor. Stated here so the field can refuse before a round
 *  trip, and asserted against the server's refusal so the two cannot drift. */
const MIN_PASSWORD_LENGTH = 10;

/** The server's one sentence for a link that does not work. */
const DEAD_LINK = "this setup link is no longer valid";

const LINK_IS_DEAD = "This setup link is expired, already used, or not one this HX Fortress issued.";

/** The token this page works with: a new link in the address bar, else the
 *  one this tab kept. The address bar is cleared on this first render, and the
 *  token kept for this page only (see lib/setup-link.ts). */
function linkToken(): string | null {
  const arrived = takeFragmentToken("t");
  if (arrived) {
    keepSetupLink(arrived);
    return arrived;
  }
  return keptSetupLink();
}

type Role = "operator" | "readonly" | "viewer";

type Check =
  | { kind: "checking" }
  | { kind: "live"; login: string; role: Role | null; first: boolean }
  /** The server said the link does not work. */
  | { kind: "dead"; message: string }
  /** No answer that says anything about the link: the console restarting, a
   *  refusal for load, an error. The link is kept, and Try Again asks again. */
  | { kind: "unanswered" };

/** What the card holds after the link was found live. */
type Stage =
  | { kind: "password" }
  | { kind: "second"; challenge: SecondStepChallenge }
  /** The link is used. `signIn` when the page offers Sign In from here: never
   *  for a Viewer, whose account opens nothing in the console. */
  | { kind: "done"; title: string; message: string; signIn: boolean };

/** The line above the title: who this account is, by the names people use. */
function kickerOf(check: Extract<Check, { kind: "live" }>): string {
  if (check.first) return "First administrator";
  // Auditors are `readonly` in code.
  if (check.role === "readonly") return "Auditor";
  if (check.role === "operator") return "Operator";
  if (check.role === "viewer") return "Viewer";
  return "Your account";
}

function titleOf(check: Check, stage: Stage): string {
  if (check.kind === "dead") return "This link does not work";
  if (check.kind === "unanswered") return "HX Fortress did not answer";
  if (stage.kind === "second") {
    return stage.challenge.secondStep === "enroll" ? "Set up your second step" : "Enter your code";
  }
  if (stage.kind === "done") return stage.title;
  return "Choose your password";
}

function ThemeIcon({ dark }: { dark: boolean }): React.ReactElement {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {dark ? (
        <>
          <circle cx="10" cy="10" r="3.4" />
          <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
        </>
      ) : (
        <path d="M16.5 11.6A6.8 6.8 0 0 1 8.4 3.5a6.8 6.8 0 1 0 8.1 8.1z" />
      )}
    </svg>
  );
}

const SHIELD = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 2.6 4 4.8v4.6c0 3.9 2.6 6.6 6 8 3.4-1.4 6-4.1 6-8V4.8z" />
  </svg>
);

/**
 * Setting a password from a one-time link.
 *
 * The token arrives in the fragment and is READ AND CLEARED on the first render:
 * a fragment never reaches the server, so it cannot appear in a request line, an
 * access log or a Referer header — and clearing the address bar means a
 * screenshot or a shared URL does not carry it either. From then on it lives in
 * this component's state and in this tab's sessionStorage, for this page only:
 * until the setup is finished or the link is refused as dead, and never past a
 * sign-in, a sign-out or another page (lib/setup-link.ts).
 *
 * The validity pre-check is a GET, and completion is a POST. That split is the
 * reason a link previewed by a chat client is still usable: an unfurler follows
 * links, and a GET that consumed the token would burn it before the person it
 * was sent to ever opened it. Only the server's answer that the link is dead
 * says so. No answer, or an answer about something else, keeps the link and
 * asks again.
 *
 * "Save and Sign In" does both. Where the console requires a second step, the
 * answer starts it and the same card changes to the QR code: the first right
 * code saves the password, sets up the second step and spends the link in one
 * write, and signs the person in. Until then nothing is saved. Otherwise the
 * password is saved at once, and the page signs in with it, exactly as the
 * sign-in page would. A Viewer's account opens nothing in the console, so for
 * a Viewer the button saves, and the page ends on the password being set.
 */
export default function AccountPassword(): React.ReactElement {
  const app = useApp();
  const [token] = useState<string | null>(linkToken);
  const [check, setCheck] = useState<Check>({ kind: "checking" });
  const [stage, setStage] = useState<Stage>({ kind: "password" });
  const [password, setPassword] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const morph = useCardMorph(`${check.kind} ${stage.kind}`);
  const field = useRef<HTMLInputElement>(null);
  const doneButton = useRef<HTMLButtonElement>(null);
  const againButton = useRef<HTMLButtonElement>(null);
  const viewer = check.kind === "live" && check.role === "viewer";

  const linkIsDead = useCallback(
    (message: string): void => {
      forgetSetupLink();
      morph.capture();
      setCheck({ kind: "dead", message });
    },
    [morph],
  );

  useEffect(() => {
    if (!token) {
      setCheck({ kind: "dead", message: "This page needs a setup link to do anything." });
      return;
    }
    let cancelled = false;
    void api
      .setupStatus(token)
      .then((status) => {
        if (cancelled) return;
        if (status.status === "dead") {
          linkIsDead(LINK_IS_DEAD);
          return;
        }
        morph.capture();
        setCheck({ kind: "live", login: status.login, role: status.role ?? null, first: status.first === true });
        app.setMarker(status.marker);
      })
      .catch(() => {
        if (cancelled) return;
        // Not the server's word that the link is dead: the link is kept.
        morph.capture();
        setCheck({ kind: "unanswered" });
      });
    return () => {
      cancelled = true;
    };
    // `asked` asks again for Try Again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, asked]);

  // The first control of each screen holds the keyboard when it appears.
  useLayoutEffect(() => {
    if (check.kind === "live" && stage.kind === "password") field.current?.focus({ preventScroll: true });
    if (check.kind === "unanswered") againButton.current?.focus({ preventScroll: true });
    if (stage.kind === "done") doneButton.current?.focus({ preventScroll: true });
  }, [check.kind, stage.kind]);

  const toStage = (next: Stage): void => {
    morph.capture();
    setStage(next);
  };

  /** The link is used: the password is set, with the app where the console
   *  asked for one. A Viewer is told the account opens nothing, and offered
   *  nothing that would only be refused. */
  const finished = (what: "password" | "password and app"): void => {
    forgetSetupLink();
    const withApp = what === "password and app" ? "Your authenticator app is set up too. " : "";
    toStage(
      viewer
        ? {
            kind: "done",
            title: "Your password is set",
            message: `${withApp}This account opens nothing in this console.`,
            signIn: false,
          }
        : {
            kind: "done",
            title: "Your password is set",
            message:
              what === "password and app"
                ? `${withApp}Sign in with your password and a code from the app.`
                : "Sign in with your password.",
            signIn: true,
          },
    );
  };

  const tryAgain = (): void => {
    morph.capture();
    setCheck({ kind: "checking" });
    setAsked((n) => n + 1);
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (check.kind !== "live" || !token || busy) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setRefusal(`At least ${MIN_PASSWORD_LENGTH} characters.`);
      field.current?.focus();
      return;
    }
    setBusy(true);
    setRefusal(null);
    let saved: Awaited<ReturnType<typeof api.completeSetup>>;
    try {
      saved = await api.completeSetup(token, password);
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.message === DEAD_LINK) {
        linkIsDead(LINK_IS_DEAD);
        return;
      }
      setRefusal(err instanceof Error ? err.message : DEAD_LINK);
      field.current?.focus();
      return;
    }
    const challenge = challengeOf(saved);
    if (challenge) {
      // Nothing is saved yet, and the link is still live: it stays kept.
      setPassword("");
      setShown(false);
      setBusy(false);
      toStage({ kind: "second", challenge });
      return;
    }
    // Saved, and the link is used.
    forgetSetupLink();
    if (viewer) {
      // The console opens nothing for a Viewer: there is no sign-in to try.
      setPassword("");
      setBusy(false);
      finished("password");
      return;
    }
    // Sign in with the password just set.
    try {
      const next = await app.signIn(saved.login, password);
      setPassword("");
      setBusy(false);
      if (next) {
        toStage({ kind: "second", challenge: next });
        return;
      }
      app.navigate({ view: "overview" }, { replace: true });
    } catch {
      setPassword("");
      setBusy(false);
      finished("password");
    }
  };

  const secondStepFinished = (outcome: SecondStepOutcome): void => {
    // The code was taken: the password and the app are saved, and the link is
    // used, whatever happens next.
    forgetSetupLink();
    if (outcome === "signed-in") {
      app.navigate({ view: "overview" }, { replace: true });
      return;
    }
    finished("password and app");
  };

  const secondStepEnded = (_said: string, status: number): void => {
    if (status === 403) {
      // The code was right, the setup is finished, and this kind of account
      // does not open the console. The link is used.
      finished("password and app");
      return;
    }
    // The code was not accepted in time, or too many were wrong. Nothing was
    // saved and the link still works: back to the password, for a new code.
    setRefusal("Nothing was saved. Choose your password again for a new QR code.");
    toStage({ kind: "password" });
  };

  return (
    <div className="ac">
      <div className="topbar">
        <div className="mark">
          <i></i>
          <i></i>
          <i></i>
          <i></i>
        </div>
        <div className="wordmark">HX Fortress</div>
        <div className="spacer"></div>
        {app.marker ? (
          <div className="chip">
            {SHIELD}
            <b>{app.marker}</b>
          </div>
        ) : null}
        <button
          className="iconbtn"
          type="button"
          aria-label="Switch theme"
          // A click here leaves the keyboard where it was, in the field.
          onMouseDown={(e) => e.preventDefault()}
          onClick={app.toggleTheme}
        >
          <ThemeIcon dark={app.theme === "dark"} />
          <span className="ac-hint">Switch theme</span>
        </button>
      </div>

      <div className="ac-wrap">
        <div className="ac-card ac-morph" ref={morph.card}>
          <div className="ac-morph-bg" aria-hidden="true" />
          {check.kind === "live" ? <div className="kicker">{kickerOf(check)}</div> : null}
          <h1>{titleOf(check, stage)}</h1>

          <div className="ac-morph-body" key={`${check.kind} ${stage.kind}`}>
            {check.kind === "checking" ? (
              <p className="ac-note">Checking this link.</p>
            ) : check.kind === "unanswered" ? (
              <>
                <p className="ac-lede">
                  The link was not checked: HX Fortress may be starting again. The link is kept in this tab.
                </p>
                <div className="ac-row">
                  <span className="ac-note"></span>
                  <button ref={againButton} className="btn" type="button" onClick={tryAgain}>
                    Try Again
                    <span className="key">↵</span>
                  </button>
                </div>
              </>
            ) : check.kind === "dead" ? (
              <>
                <p className="ac-lede">{check.message}</p>
                <p className="ac-note">{SIGN_IN_RECOVERY_COPY}</p>
              </>
            ) : stage.kind === "second" ? (
              <>
                {stage.challenge.secondStep === "enroll" ? (
                  <p className="ac-lede">
                    This console also asks for a code from an authenticator app. Scan the QR code with
                    the app, or type the key into it, then enter the 6 digits it shows. Your password is
                    saved with the first right code. An entry for this account that you scanned before
                    no longer works, and can be removed from the app.
                  </p>
                ) : (
                  <p className="ac-lede">Your password is saved. Enter the 6-digit code from your authenticator app.</p>
                )}
                <SecondStep
                  challenge={stage.challenge}
                  look="account"
                  submitLabel={viewer ? "Save" : "Sign In"}
                  onFinished={secondStepFinished}
                  onRestart={secondStepEnded}
                />
              </>
            ) : stage.kind === "done" ? (
              <>
                <p className="ac-lede">{stage.message}</p>
                <div className="ac-row">
                  <span className="ac-note">This link is used up.</span>
                  {stage.signIn ? (
                    <button ref={doneButton} className="btn" type="button" onClick={() => (window.location.href = "/")}>
                      Go to Sign In
                      <span className="key">↵</span>
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <form onSubmit={(e) => void submit(e)} noValidate>
                {/* For a password manager: the login this password belongs to. */}
                <input className="ac-hidden" type="text" autoComplete="username" value={check.login} readOnly hidden />
                <div className="ac-flds">
                  <div className="ac-fld">
                    <span className="k">Account</span>
                    <span className="sv mono">{check.login}</span>
                  </div>
                  <div className={refusal ? "ac-fld pw err" : "ac-fld pw"}>
                    <label htmlFor="ac-pw">Password</label>
                    <input
                      ref={field}
                      id="ac-pw"
                      className="ac-inp"
                      type={shown ? "text" : "password"}
                      autoComplete="new-password"
                      spellCheck={false}
                      value={password}
                      aria-invalid={refusal ? true : undefined}
                      aria-describedby={refusal ? "ac-pw-tip" : undefined}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setRefusal(null);
                      }}
                    />
                    <button
                      className="btn ghost sm ac-show"
                      type="button"
                      aria-pressed={shown}
                      aria-controls="ac-pw"
                      // A click keeps the keyboard in the field; Tab reaches the
                      // button for a person who works without a pointer.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setShown((was) => !was)}
                    >
                      {shown ? "Hide" : "Show"}
                    </button>
                    {refusal ? (
                      <div className="ac-tip" id="ac-pw-tip" role="alert">
                        {refusal}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="ac-row">
                  <span className="ac-note">This link works once.</span>
                  <button className="btn" type="submit" aria-disabled={busy ? true : undefined}>
                    {viewer ? "Save" : "Save and Sign In"}
                    <span className="key">↵</span>
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
        <p className="ac-foot">
          {DISCLOSURE_FOOTER[0]} {DISCLOSURE_FOOTER[1]}
        </p>
      </div>
    </div>
  );
}
