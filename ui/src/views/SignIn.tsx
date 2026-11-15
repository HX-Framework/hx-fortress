import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import { SIGN_IN_RECOVERY_COPY } from "../../../src/ui/copy";
import { api, ApiError, type SecondStepChallenge } from "../api";
import { DISCLOSURE_FOOTER } from "../disclosure";
import { saveOidcFlow } from "../lib/oidc-flow";
import { useApp } from "../state";
import { SecondStep, useCardMorph } from "./SecondStep";

/**
 * The only screen an unauthenticated caller ever sees.
 *
 * It discloses nothing about which HX Fortress this is. The org name, the
 * fortress id, the version and the configuration are all behind the session,
 * because a console reachable from a network must not answer "whose is this?"
 * to whoever reaches the port. The two things it DOES show are safe by
 * construction: the origin the browser is already on, and — only when the
 * arrival presented a live setup or entry token — the operator's own banner
 * phrase, which is chosen for exactly this purpose and names no organization.
 *
 * When the console requires a second step, the right password does not sign
 * in: the same card changes to the code, and to the QR code of a new secret
 * for a person who has none yet. Nothing about the second step is shown
 * before the password is right.
 */
export default function SignIn(): React.ReactElement {
  const app = useApp();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; recovery?: string } | null>(null);
  // Null until the console says it offers sign-in through the organization's
  // identity provider. A console that does not offer it answers this question
  // exactly as it answers a path that does not exist.
  const [provider, setProvider] = useState<{ label: string | null } | null>(null);
  /** The second step this sign-in is on, once its password was right. */
  const [challenge, setChallenge] = useState<SecondStepChallenge | null>(null);
  const morph = useCardMorph(challenge ? `second ${challenge.ticket}` : "password");
  const loginField = useRef<HTMLInputElement>(null);
  const passwordField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void api.oidcOffered().then((offered) => {
      if (!cancelled) setProvider(offered);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Back on the password: the keyboard lands where the next keystroke goes.
  useLayoutEffect(() => {
    if (challenge) return;
    (login ? passwordField.current : loginField.current)?.focus({ preventScroll: true });
    // Only when the step changes, never while a person types.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge]);

  const providerName = provider?.label ?? "your identity provider";

  const signInWithProvider = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const started = await api.oidcStart();
      // The state this tab sends to the provider. The answer must carry it
      // back, so a start that has none cannot be finished: say so now, not
      // after the person has been to the provider and back.
      const state = new URL(started.authorizationUrl).searchParams.get("state");
      if (!state) throw new Error("sign-in could not be started");
      // Kept by this tab until the provider sends the browser back.
      saveOidcFlow({ verifier: started.verifier, state });
      window.location.assign(started.authorizationUrl);
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : "sign-in could not be started" });
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || !login || !password) return;
    setBusy(true);
    setError(null);
    try {
      // A login is lower case, and an email address is typed in every case:
      // what is sent is trimmed and lowercased, so both shapes match.
      const next = await app.signIn(login.trim().toLowerCase(), password);
      if (next) {
        morph.capture();
        setChallenge(next);
      }
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : "sign-in failed",
        ...(err instanceof ApiError && err.recovery ? { recovery: err.recovery } : {}),
      });
    } finally {
      // The password is not kept once it has been sent, whatever the answer.
      setPassword("");
      setBusy(false);
    }
  };

  const backToPassword = (message: string | null): void => {
    morph.capture();
    setChallenge(null);
    setError(message ? { message } : null);
  };

  return (
    <div className="authwrap">
      <div className="authcard ac-morph" ref={morph.card}>
        <div className="ac-morph-bg" aria-hidden="true" />
        <h1>HX Fortress console</h1>

        {challenge ? (
          <div className="ac-morph-body" key="second">
            <p className="authsub">
              {challenge.secondStep === "enroll"
                ? "This console asks for a second step after the password. Scan the QR code with an authenticator app, or type the key into it, then enter the 6-digit code the app shows."
                : "Enter the 6-digit code from your authenticator app."}
            </p>
            <SecondStep
              challenge={challenge}
              look="auth"
              submitLabel="Sign in"
              onBack={() => backToPassword(null)}
              onRestart={(message) => backToPassword(message)}
              // A held session changes the whole screen. A code that was taken
              // when the session could not be read after it is a sign-in to
              // start again, with the next code.
              onFinished={(outcome) => {
                if (outcome === "taken") backToPassword("HX Fortress did not answer after your code. Sign in again.");
              }}
            />
            <p className="authnote">{SIGN_IN_RECOVERY_COPY}</p>
          </div>
        ) : (
          <div className="ac-morph-body" key="password">
            <p className="authsub">
              Sign in with the account an administrator created for you on this host.
            </p>

            {app.marker ? <div className="authmark">{app.marker}</div> : null}

            {app.ssoIdentity ? (
              <div className="authwho">
                You arrived from the control plane
                {app.ssoIdentity.controlPlaneUser ? ` as ${app.ssoIdentity.controlPlaneUser}` : ""}
                {app.ssoIdentity.organization ? `, for ${app.ssoIdentity.organization}` : ""}. That
                identity is recorded alongside whatever you do here; it does not sign you in.
              </div>
            ) : null}

            <form onSubmit={(e) => void submit(e)}>
              <label htmlFor="login">Login</label>
              <input
                ref={loginField}
                id="login"
                autoComplete="username"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
              />
              <label htmlFor="password">Password</label>
              <input
                ref={passwordField}
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button className="btn" type="submit" disabled={busy || !login || !password}>
                Sign in
              </button>
            </form>

            {provider ? (
              <div className="authalt">
                <button className="btn ghost" type="button" disabled={busy} onClick={() => void signInWithProvider()}>
                  Sign in with {providerName}
                </button>
                <p className="authnote">
                  This sends you to {providerName} and back. Your groups there decide what you may do
                  here. No control plane takes part in it.
                </p>
              </div>
            ) : null}

            {error ? (
              <div className="autherr" role="alert">
                <div>{error.message}</div>
                {error.recovery ? <div style={{ marginTop: 6 }}>{error.recovery}</div> : null}
              </div>
            ) : null}

            <p className="authnote">{SIGN_IN_RECOVERY_COPY}</p>
            <p className="authnote">
              No account? Console logins are created on this host with{" "}
              <code className="hx">hx-fortress ui user create</code>. There is no self-registration and
              no way to request one from this page.
            </p>
            <p className="authnote">
              A sign-in is held per browser tab, so a second tab signs in again.
            </p>
          </div>
        )}
      </div>

      <div className="authfoot">
        <div className="mono" style={{ fontSize: 13 }}>
          {window.location.origin}
        </div>
        <div style={{ marginTop: 8 }}>
          {DISCLOSURE_FOOTER[0]} {DISCLOSURE_FOOTER[1]}
        </div>
      </div>
    </div>
  );
}
