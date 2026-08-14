import React, { useState } from "react";

import { SIGN_IN_RECOVERY_COPY } from "../../../src/ui/copy";
import { ApiError } from "../api";
import { DISCLOSURE_FOOTER } from "../disclosure";
import { useApp } from "../state";

/**
 * The only screen an unauthenticated caller ever sees.
 *
 * It discloses nothing about which fortress this is. The org name, the fortress
 * id, the version and the configuration are all behind the session, because a
 * console reachable from a network must not answer "whose is this?" to whoever
 * reaches the port. The two things it DOES show are safe by construction: the
 * origin the browser is already on, and — only when the arrival presented a live
 * setup or entry token — the operator's own banner phrase, which is chosen for
 * exactly this purpose and names no organization.
 */
export default function SignIn(): React.ReactElement {
  const app = useApp();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; recovery?: string } | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || !login || !password) return;
    setBusy(true);
    setError(null);
    try {
      await app.signIn(login, password);
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : "sign-in failed",
        ...(err instanceof ApiError && err.recovery ? { recovery: err.recovery } : {}),
      });
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="authwrap">
      <div className="authcard">
        <h1>HX Fortress console</h1>
        <p className="authsub">
          Sign in with the account an administrator created for you on this host.
        </p>

        {app.marker ? <div className="authmark">{app.marker}</div> : null}

        {app.ssoIdentity ? (
          <div className="authwho">
            You arrived from the workbench
            {app.ssoIdentity.workbenchUser ? ` as ${app.ssoIdentity.workbenchUser}` : ""}
            {app.ssoIdentity.organization ? `, for ${app.ssoIdentity.organization}` : ""}. That
            identity is recorded alongside whatever you do here; it does not sign you in.
          </div>
        ) : null}

        <form onSubmit={(e) => void submit(e)}>
          <label htmlFor="login">Login</label>
          <input
            id="login"
            autoComplete="username"
            autoFocus
            value={login}
            onChange={(e) => setLogin(e.target.value)}
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className="btn" type="submit" disabled={busy || !login || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        {error ? (
          <div className="autherr">
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
