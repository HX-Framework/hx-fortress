import React, { useState } from "react";

import { api, type VerifyResult } from "../api";
import { Panel, ResultLine, useResultLine } from "../components";
import { copyText } from "../lib/util";

// The per-session residency proof, and the copy of it that leaves the box.
//
// Nothing is asserted here that was not checked. The server returns the checks
// it actually performed, each with its own state, and this panel renders those
// states rather than a verdict badge with reassuring text under it. The one
// check this console never performs - asking let.ai whether it still holds a
// copy - says so in every verdict.
//
// COPYING THE PROOF IS AN AUDITED ACT. The text is a claim about where an
// organization's data lives, made by this fortress; once it is on a clipboard it
// can end up in a compliance file, so the trail records that a copy was taken,
// of which session, and under which verdict.

const TONE: Record<VerifyResult["verdict"], string> = {
  healthy: "ok",
  missing: "bad",
  mismatch: "bad",
  orphan: "warn",
  "witness-unavailable": "warn",
};

const MARK: Record<VerifyResult["checks"][number]["state"], string> = {
  passed: "ok",
  failed: "bad",
  "not-checked": "warn",
};

export function VerifyResidencyPanel(props: {
  family: string;
  sessionId: string;
  sub?: string;
}): React.ReactElement {
  const [proof, setProof] = useState<VerifyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, showResult] = useResultLine();

  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      const verdict = await api.verify(props.family, props.sessionId);
      setProof(verdict);
      showResult(verdict.headline, verdict.verdict !== "healthy");
    } catch (err) {
      showResult(err instanceof Error ? err.message : "this session could not be verified", true);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (target: HTMLElement, verdict: VerifyResult): Promise<void> => {
    copyText(verdict.proof.join("\n"), target);
    try {
      await api.proofCopyAck({
        family: verdict.family,
        session: verdict.sessionId,
        verdict: verdict.verdict,
      });
    } catch (err) {
      showResult(err instanceof Error ? err.message : "the copy was not recorded", true);
    }
  };

  return (
    <Panel
      title="Verify where this session rests"
      sub={
        props.sub ??
        "Runs the checks this fortress can actually perform: its own metadata row, and the transcript object in the organization's bucket."
      }
    >
      <div className="setrow" style={{ borderBottom: "none", paddingBottom: 6 }}>
        <div className="txt">
          <b>Checked by the fortress, and reported as checked</b>
          <p>
            Every line below says whether it was checked. A verdict that could not run a check says
            so rather than passing it.
          </p>
        </div>
        <button className="btn" disabled={busy} onClick={() => void run()}>
          Verify this session
        </button>
      </div>
      <ResultLine state={result} />

      {proof ? (
        <>
          <div className="chain">
            {proof.checks.map((check) => (
              <span key={check.name} className={check.state === "not-checked" ? "step dashed" : "step"}>
                <span className={`dot ${MARK[check.state]}`}></span>
                {check.name}
              </span>
            ))}
          </div>
          <div className="facts wide">
            {proof.checks.map((check) => (
              <div className="row" key={check.name}>
                <span className={`dot ${MARK[check.state]}`}></span>
                <div className="who">
                  <b>{check.name}</b>
                  <div className="sub">{check.detail}</div>
                </div>
                <div>
                  <span className={`pill pc ${MARK[check.state]}`}>{check.state}</span>
                </div>
              </div>
            ))}
          </div>
          <div className={`proof paper on ${TONE[proof.verdict]}`}>{proof.proof.join("\n")}</div>
          <div style={{ display: "flex", gap: 10, marginTop: 12, justifyContent: "flex-end" }}>
            <button className="btn ghost sm" onClick={(e) => void copy(e.currentTarget, proof)}>
              Copy the proof
            </button>
          </div>
        </>
      ) : null}
    </Panel>
  );
}
