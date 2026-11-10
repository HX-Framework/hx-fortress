import React, { useEffect, useState } from "react";

import { ApiError } from "../api";
import { DISCLOSURE_FOOTER } from "../disclosure";
import { takeOidcFlow } from "../lib/oidc-flow";
import { takeOidcAnswer, type OidcAnswer } from "../router";
import { useApp } from "../state";

/**
 * Where the organization's identity provider sends the browser back.
 *
 * The page reads the one-time code, clears it from the address bar, and posts
 * it to the console with the verifier this tab kept. The console redeems the
 * code, checks the provider's signed answer and the person's groups, and
 * returns a console session exactly as a password sign-in does.
 *
 * It is an ordinary view path, served like every other one, so the code is
 * redeemed by a POST from this page and never by loading a link.
 */

/** One exchange per page load. React may run an effect twice while developing,
 *  and a code can be redeemed once. */
let exchange: Promise<void> | null = null;

export default function OidcCallback(): React.ReactElement {
  const app = useApp();
  const [answer] = useState<OidcAnswer>(() => takeOidcAnswer());
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!exchange) {
      const flow = takeOidcFlow();
      if (!answer.code || !answer.state) {
        setFailed(
          answer.error
            ? "Your identity provider did not sign you in."
            : "This page was opened with no sign-in in progress.",
        );
        return;
      }
      if (!flow || flow.state !== answer.state) {
        setFailed("This sign-in was started in another tab, or it was already used. Start it again.");
        return;
      }
      exchange = app.signInWithProvider({
        code: answer.code,
        state: answer.state,
        verifier: flow.verifier,
      });
    }
    void exchange
      .then(() => {
        if (!cancelled) app.navigate({ view: "overview" }, { replace: true });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // The console's own sentence when it wrote one.
        setFailed(
          err instanceof ApiError && err.fromBody
            ? err.message
            : "This sign-in could not be completed. Start it again from the sign-in page.",
        );
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="authwrap">
      <div className="authcard">
        <h1>HX Fortress console</h1>
        {failed ? (
          <>
            <p className="authsub">{failed}</p>
            <button className="btn" autoFocus onClick={() => (window.location.href = "/")}>
              Go to sign-in
            </button>
          </>
        ) : (
          <p className="authsub">Finishing your sign-in…</p>
        )}
      </div>
      <div className="authfoot">
        {DISCLOSURE_FOOTER[0]} {DISCLOSURE_FOOTER[1]}
      </div>
    </div>
  );
}
