import React, { useEffect, useState } from "react";

import { SIGN_IN_RECOVERY_COPY } from "../../../src/ui/copy";
import { api, ApiError } from "../api";
import { DISCLOSURE_FOOTER } from "../disclosure";
import { takeFragmentToken, useApp } from "../state";

/** The server's own floor. Stated here so the field can refuse before a round
 *  trip, and asserted against the server's refusal so the two cannot drift. */
const MIN_PASSWORD_LENGTH = 10;

type Check =
  | { kind: "checking" }
  | { kind: "live"; login: string }
  | { kind: "dead"; message: string };

/**
 * Setting a password from a one-time link.
 *
 * The token arrives in the fragment and is READ AND CLEARED on the first render:
 * a fragment never reaches the server, so it cannot appear in a request line, an
 * access log or a Referer header — and clearing the address bar means a
 * screenshot or a shared URL does not carry it either. From then on it lives in
 * this component's state, which is why a reload of this page cannot complete the
 * setup a second time.
 *
 * The validity pre-check is a GET, and completion is a POST. That split is the
 * reason a link previewed by a chat client is still usable: an unfurler follows
 * links, and a GET that consumed the token would burn it before the person it
 * was sent to ever opened it.
 */
export default function Setup(): React.ReactElement {
  const app = useApp();
  const [token] = useState<string | null>(() => takeFragmentToken("t"));
  const [check, setCheck] = useState<Check>({ kind: "checking" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

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
        setCheck({ kind: "live", login: status.login });
        app.setMarker(status.marker);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCheck({
          kind: "dead",
          message:
            err instanceof ApiError && err.status === 404
              ? "This setup link is expired, already used, or not one this fortress issued."
              : err instanceof Error
                ? err.message
                : "This setup link could not be checked.",
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready =
    check.kind === "live" && password.length >= MIN_PASSWORD_LENGTH && confirm === password;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!ready || !token || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.completeSetup(token, password);
      setDone(result.login);
    } catch (err) {
      setError(err instanceof Error ? err.message : "this setup link is no longer valid");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="authwrap">
      <div className="authcard">
        <h1>Set your console password</h1>

        {app.marker ? <div className="authmark">{app.marker}</div> : null}

        {done ? (
          <>
            <p className="authsub">
              Done. <b>{done}</b> can sign in now — this link is dead from here on.
            </p>
            <button className="btn" onClick={() => (window.location.href = "/")}>
              Go to sign-in
            </button>
          </>
        ) : check.kind === "checking" ? (
          <p className="authsub">Checking this link…</p>
        ) : check.kind === "dead" ? (
          <>
            <p className="authsub">{check.message}</p>
            <div className="authnote">{SIGN_IN_RECOVERY_COPY}</div>
          </>
        ) : (
          <>
            <p className="authsub">
              For <b>{check.login}</b>. Nobody else has seen this password, and nobody on this host
              can read it afterwards.
            </p>
            <form onSubmit={(e) => void submit(e)}>
              <label htmlFor="pw">New password</label>
              <input
                id="pw"
                type="password"
                autoComplete="new-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <label htmlFor="pw2">Again</label>
              <input
                id="pw2"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              <button className="btn" type="submit" disabled={!ready || busy}>
                {busy ? "Setting…" : "Set password"}
              </button>
            </form>
            <p className="authnote">
              At least {MIN_PASSWORD_LENGTH} characters.
              {tooShort ? " That one is shorter." : ""}
              {mismatch ? " The two entries do not match." : ""}
            </p>
          </>
        )}

        {error ? <div className="autherr">{error}</div> : null}
      </div>

      <div className="authfoot">
        {DISCLOSURE_FOOTER[0]} {DISCLOSURE_FOOTER[1]}
      </div>
    </div>
  );
}
