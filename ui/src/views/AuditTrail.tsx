import React from "react";

import { API, api, downloadFromServer, type AuditRow, type SpoolRecord } from "../api";
import { Empty, FactRow, Loaded, Panel, ResultLine, useResultLine } from "../components";
import * as fmt from "../format";
import { useResource } from "../hooks";
import { disabledWindowMarkers } from "../../../src/ui/audit-markers";
import { OPEN_WINDOW_COPY } from "../../../src/ui/copy";

// The admin audit trail.
//
// Two sources, one panel. Normally these rows are read from hx.admin_audit,
// where the drain puts them. When Postgres is down the panel falls back to the
// ON-DISK SPOOL, because that is where the console is still writing: an audit
// surface that rendered "nothing recorded" during an outage would be saying the
// opposite of what is true, at the moment somebody is most likely to be reading
// it. The header says which source is answering.
//
// The retention line is the server's derived truth and is never typed here.
// Nothing deletes a drained record and no role holds DELETE on the table, so the
// honest answer is the life of the database - and a number in this file would be
// describing a sweep that does not exist.

export function AuditTrailPanel({ active }: { active: boolean }): React.ReactElement {
  const rows = useResource(() => api.audit({ limit: "100" }), [], { pollMs: 30_000, active });
  const degraded = rows.error !== null;
  // Fetched only when the table could not answer: the spool tail is a fallback,
  // not a second opinion.
  const tail = useResource(() => api.spool(100), [degraded], { active: active && degraded });
  const identity = useResource(() => api.identity(), [], { pollMs: 120_000, active });
  const markers = disabledWindowMarkers(rows.data?.rows ?? []);
  const [result, showResult] = useResultLine();

  // The export route is metered (60/min) and `downloadFromServer` throws on any
  // non-2xx, so `void`-ing it turned a refusal into an unhandled rejection and
  // nothing at all on screen — the reader clicks again and again. Its sibling in
  // Logs.tsx has always answered in place; this now does the same.
  const exportTrail = async (): Promise<void> => {
    try {
      await downloadFromServer(API.auditExport, "hx-fortress-audit.jsonl");
      showResult("The fortress read the trail and recorded that a copy left.");
    } catch (err) {
      showResult(err instanceof Error ? err.message : "the export was refused", true);
    }
  };

  return (
    <Panel
      title="Admin audit trail"
      sub="Every state-changing action taken in this console, every terminal act against its user store or its configuration, and every copy of fortress data that left. Bounded reads of this panel are not themselves recorded; the full-range export is."
      panelKey="trail"
    >
      {degraded ? (
        <div className="banner warn">
          <span className="badge">!</span>
          <span className="btxt">
            The database is not answering, so this is the console's own write-ahead spool: the
            records on disk that have not been drained yet. Nothing is lost while it is down.
          </span>
        </div>
      ) : null}

      <div className="facts wide" style={{ marginBottom: 14 }}>
        <FactRow
          k="Retention"
          v={degraded ? <span className="m">{identity.data?.retention.auditTrail ?? "—"}</span> : (identity.data?.retention.auditTrail ?? "—")}
          vs={
            degraded
              ? "greyed because it describes the drained trail, which cannot be read right now"
              : "read from what this fortress does, not from a policy somebody wrote down"
          }
        />
        <FactRow k="Collapsed records" v={OPEN_WINDOW_COPY} />
      </div>

      {markers.map((marker) => (
        <div className="why-note" key={marker.from} style={{ marginBottom: 10 }}>
          {marker.text}
        </div>
      ))}

      {degraded ? (
        <Loaded
          resource={tail}
          emptyWhen={(data) => data.records.length === 0}
          empty={<Empty>Nothing is waiting in the spool.</Empty>}
        >
          {(data) => (
            <div className="rowlist ops">
              {data.records
                .slice()
                .reverse()
                .map((record) => (
                  <SpoolLine key={`${record.fileId}:${record.seq}`} record={record} />
                ))}
            </div>
          )}
        </Loaded>
      ) : (
        <Loaded
          resource={rows}
          emptyWhen={(data) => data.rows.length === 0}
          empty={<Empty>Nothing has been recorded on this fortress yet.</Empty>}
        >
          {(data) => (
            <>
              <div className="rowlist ops">
                {data.rows.map((row) => (
                  <AuditLine key={row.id} row={row} />
                ))}
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 16, justifyContent: "flex-end" }}>
                <button className="btn ghost" onClick={() => void exportTrail()}>
                  Export the trail
                </button>
              </div>
              <ResultLine state={result} />
            </>
          )}
        </Loaded>
      )}
    </Panel>
  );
}

function AuditLine({ row }: { row: AuditRow }): React.ReactElement {
  return (
    <div className="row">
      <span className={row.error ? "dot bad" : row.kind === "intent" ? "dot warn" : "dot"}></span>
      <div className="who">
        <b>{row.action}</b>
        <div className="sub">
          {row.actor ?? row.origin}
          {row.outcome ? ` · ${row.outcome}` : ""}
          {row.error ? ` · ${row.error}` : ""}
        </div>
      </div>
      <div>
        <span className={`pill pc ${row.kind === "intent" ? "warn" : "ok"}`}>{row.origin}</span>
      </div>
      <div className="m">{fmt.when(row.ts)}</div>
    </div>
  );
}

function SpoolLine({ record }: { record: SpoolRecord }): React.ReactElement {
  return (
    <div className="row">
      <span className={record.error ? "dot bad" : "dot warn"}></span>
      <div className="who">
        <b>{record.action}</b>
        <div className="sub">
          {record.actor ?? record.origin}
          {record.outcome ? ` · ${record.outcome}` : ""}
          {record.error ? ` · ${record.error}` : ""}
        </div>
      </div>
      <div>
        <span className="pill pc warn">on disk</span>
      </div>
      <div className="m">{fmt.when(record.ts)}</div>
    </div>
  );
}
