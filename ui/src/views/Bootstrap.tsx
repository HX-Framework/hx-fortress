import React, { useEffect, useState } from "react";

import { api, ApiError } from "../api";
import { DISCLOSURE_FOOTER } from "../disclosure";
import { takeFragmentToken, useApp } from "../state";

/**
 * The workbench hand-off, client half.
 *
 * The workbench sends a browser here with a one-time grant in the fragment. This
 * page reads it, CLEARS the address bar, exchanges it for an entry token, and
 * moves to the sign-in screen carrying that token in the fragment and the
 * workbench's display fields in memory.
 *
 * It is a normal SPA path — the index handler serves it like every other view —
 * so the hand-off costs no server route, and the public route enumeration the
 * route-walk test compares against is unchanged. There is no inline script: the
 * page the server sends is byte-identical to every other page it sends, which is
 * what lets a single content-security-policy cover all of them.
 */
export default function Bootstrap(): React.ReactElement {
  const app = useApp();
  const [grant] = useState<string | null>(() => takeFragmentToken("g"));
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!grant) {
      setFailed("This link carried no hand-off, so there is nothing to exchange.");
      return;
    }
    let cancelled = false;
    void api
      .ssoExchange(grant)
      .then((result) => {
        if (cancelled) return;
        // Kept in memory and handed to the sign-in screen by NAVIGATING, not by
        // reloading: a document load would throw away the display fields this
        // exchange just returned, and the annotation would be gone by the time
        // anyone could read it. They are DISPLAY ONLY — the entry id is what the
        // sign-in carries, and the server stamps the identity from its own
        // record of it.
        app.setSsoIdentity({
          workbenchUser: result.workbenchSub,
          organization: result.org,
        });
        // The banner phrase comes from THIS response. It renders to an arrival
        // that presented a live grant and to nobody else, so a plain sign-in
        // still says nothing about which fortress this is.
        app.setMarker(result.marker);
        app.setEntryId(result.entryId);
        app.navigate({ view: "overview" }, { replace: true });
        window.history.replaceState(
          window.history.state,
          "",
          `/#e=${encodeURIComponent(result.entryId)}`,
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // The fortress's own sentence when it wrote one; otherwise something a
        // person can act on, rather than a status code they cannot.
        setFailed(
          err instanceof ApiError && err.fromBody
            ? err.message
            : "This hand-off could not be completed. Open the console URL directly and sign in.",
        );
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grant]);

  return (
    <div className="authwrap">
      <div className="authcard">
        <h1>HX Fortress console</h1>
        {failed ? (
          <>
            <p className="authsub">{failed}</p>
            <button className="btn" onClick={() => (window.location.href = "/")}>
              Go to sign-in
            </button>
          </>
        ) : (
          <p className="authsub">Handing this browser over to the fortress…</p>
        )}
      </div>
      <div className="authfoot">
        {DISCLOSURE_FOOTER[0]} {DISCLOSURE_FOOTER[1]}
      </div>
    </div>
  );
}
