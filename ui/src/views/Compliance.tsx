import React, { useState } from "react";

import { API, api, downloadFromServer, type DataPathRow } from "../api";
import { AuditTrailPanel } from "./AuditTrail";
import { FactRow, Loaded, Panel, ResultLine, ViewFallback, awaiting, useResultLine } from "../components";
import { RETENTION_LABELS } from "../copy";
import { useResource } from "../hooks";
import { copyText } from "../lib/util";
import { useApp } from "../state";

const DIRECTION: Record<string, string> = {
  in: "inbound",
  out: "outbound",
  both: "both ways",
};

export default function Compliance(): React.ReactElement {
  const app = useApp();
  const active = app.view === "compliance";
  const paths = useResource(() => api.dataPaths(), [], { pollMs: 120_000, active });
  const identity = useResource(() => api.identity(), [], { pollMs: 120_000, active });
  const facts = useResource(() => api.facts(), [], { pollMs: 120_000, active });
  const [report, setReport] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [result, showResult] = useResultLine();

  // Both doors are the SERVER's. Nothing here assembles an artifact out of
  // fortress data: a copy that leaves this box leaves an audit record behind,
  // and a report built in the tab would leave none.
  const fetchReport = async (): Promise<void> => {
    setBusy(true);
    try {
      const payload = await api.report();
      setReport(JSON.stringify(payload, null, 2));
      showResult("The fortress generated the report and recorded that it did.");
    } catch (err) {
      showResult(err instanceof Error ? err.message : "the report could not be generated", true);
    } finally {
      setBusy(false);
    }
  };

  const fetchPdf = async (): Promise<void> => {
    setBusy(true);
    try {
      await downloadFromServer(API.reportPdf, "hx-fortress-report.pdf");
      showResult("The fortress rendered the PDF and recorded that it did.");
    } catch (err) {
      showResult(err instanceof Error ? err.message : "the PDF could not be rendered", true);
    } finally {
      setBusy(false);
    }
  };

  // Bad numbers are worse than a wait: every headline figure here is one

  // `?? 0` away from claiming this fortress holds nothing. Show the shell and

  // a loader until the answers have actually arrived.

  const gate = [paths, identity, facts];
  if (active && gate.some(awaiting)) {
    return (
      <section className="view active">
        <ViewFallback resources={gate} />
      </section>
    );
  }


  return (
    <section className={active ? "view active" : "view"}>
      <div className="kicker">Compliance</div>
      <h1>Posture, data paths &amp; retention</h1>
      <p className="lede">
        Where bytes can travel, how long what is here is kept, and the one-page answer to “where
        does our AI session data live?” — assembled by this fortress, from this fortress.
      </p>

      <Panel
        title={paths.data?.title ?? "Data paths in and out of this host"}
        sub="Computed from this fortress's effective configuration, not from a list somebody remembered. A flow that exists and is missing here fails a test rather than misleading a reader."
        panelKey="paths"
        register={app.registerPanel}
      >
        <Loaded resource={paths}>
          {(data) => (
            <div className="rowlist ops">
              {data.rows.map((row) => (
                <PathRow key={row.id} row={row} />
              ))}
            </div>
          )}
        </Loaded>
      </Panel>

      <Panel
        title="Retention"
        sub="Every figure below is read from what this fortress actually does — the rotation the log writer uses, and the absence of any delete sweep."
        panelKey="retention"
        register={app.registerPanel}
      >
        <Loaded resource={identity}>
          {(data) => (
            <div className="facts wide">
              <FactRow
                k={RETENTION_LABELS.transcripts}
                v={facts.data?.storage.lifecycle ?? "reading the bucket…"}
                vs={
                  facts.data?.storage.bucket
                    ? `in ${facts.data.storage.bucket} — retention is governed by the organization's own bucket policy`
                    : "no bucket is configured on this fortress"
                }
              />
              <FactRow
                k={RETENTION_LABELS.versioning}
                v={facts.data?.storage.versioning ?? "reading the bucket…"}
                vs="read from the provider, and allowed to say it could not be read"
              />
              <FactRow k={RETENTION_LABELS.logs} v={data.retention.logs} vs={<span className="mono">{data.paths.log}</span>} />
              <FactRow k={RETENTION_LABELS.auditTrail} v={data.retention.auditTrail} />
            </div>
          )}
        </Loaded>
      </Panel>

      <Panel
        title="Compliance report"
        sub="Identity, residency counts, storage configuration, retention and the full data-paths inventory — one payload, two renderings, no invented facts."
      >
        <div className="setrow" style={{ borderBottom: "none", paddingBottom: 6 }}>
          <div className="txt">
            <b>Generated by the fortress, and recorded</b>
            <p>
              Both buttons call this fortress, which writes an audit record naming the parameters
              the copy left under. Neither assembles anything in this browser.
            </p>
          </div>
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="btn ghost" disabled={busy} onClick={() => void fetchPdf()}>
              Download PDF
            </button>
            <button className="btn" disabled={busy} onClick={() => void fetchReport()}>
              Generate report
            </button>
          </span>
        </div>
        <ResultLine state={result} />
        {report ? (
          <>
            <div className="proof paper on">{report}</div>
            <div style={{ display: "flex", gap: 10, marginTop: 12, justifyContent: "flex-end" }}>
              <button className="btn ghost sm" onClick={(e) => copyText(report, e.currentTarget)}>
                Copy
              </button>
            </div>
          </>
        ) : null}
      </Panel>

      <AuditTrailPanel active={active} />
    </section>
  );
}

function PathRow({ row }: { row: DataPathRow }): React.ReactElement {
  return (
    <div className="row" style={{ alignItems: "start" }}>
      <span className={row.direction === "out" ? "dot warn" : "dot"}></span>
      <div className="who">
        <b>{row.name}</b>
        <div className="sub">
          <span className="mono">{row.peer}</span>
        </div>
        <div className="sub" style={{ marginTop: 4 }}>
          carries {row.carries}
        </div>
        <div className="sub">authorized by {row.gate}</div>
        {row.notes && row.notes.length > 0 ? (
          <ul className="notes">
            {row.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <div>
        <span className={`pill pc ${row.direction === "out" ? "warn" : row.direction === "in" ? "fortress" : "cloud"}`}>
          {DIRECTION[row.direction]}
        </span>
      </div>
      <div className="m">{row.id}</div>
    </div>
  );
}
