import React from "react";

import { api, type GrowthRow } from "../api";
import { Empty, FactRow, Loaded, Panel, Stat, ViewFallback, awaiting } from "../components";
import { DISCLOSURE_LEDE_TAIL, DISCLOSURE_STAT_DETAIL, DISCLOSURE_STAT_LABEL } from "../disclosure";
import * as fmt from "../format";
import { useResource } from "../hooks";
import { useApp } from "../state";

export default function Overview(): React.ReactElement {
  const app = useApp();
  const active = app.view === "overview";

  const status = useResource(() => api.status(), [], { pollMs: 10_000, active });
  const page = useResource(() => api.sessions({ limit: "1" }), [], { pollMs: 15_000, active });
  const facts = useResource(() => api.facts(), [], { pollMs: 30_000, active });
  // The daemon says whether Postgres came up; the console can only see whether
  // coordinates were written, which is a strictly later event.
  const pgFailed =
    status.data?.daemonPostgres?.phase === "failed" ||
    status.data?.daemonPostgres?.phase === "retrying";
  const growth = useResource(() => api.growth(30), [], { pollMs: 60_000, active });
  const metrics = useResource(() => api.metrics(), [], { pollMs: 15_000, active });

  const totals = page.data?.totals ?? null;

  // Bad numbers are worse than a wait: every headline figure here is one

  // `?? 0` away from claiming this fortress holds nothing. Show the shell and

  // a loader until the answers have actually arrived.

  const gate = [status, page, facts];
  if (active && gate.some(awaiting)) {
    return (
      <section className="view active">
        <ViewFallback resources={gate} />
      </section>
    );
  }


  return (
    <section className={active ? "view active" : "view"}>
      <div className="kicker">This fortress</div>
      <h1>Operational truth, at a glance</h1>
      <p className="lede">
        What this host actually holds, read from its own database and its own runtime files —{" "}
        {DISCLOSURE_LEDE_TAIL}.
      </p>

      <div className="tiles">
        <Tile
          head="Fortress daemon"
          state={status.data?.copy ?? null}
          sub={
            status.data?.writtenAt
              ? `status written ${fmt.ago(status.data.writtenAt)}`
              : status.data
                ? "no heartbeat in its status file"
                : null
          }
          tone={
            status.data?.daemon === "running"
              ? "ok"
              : status.data?.daemon === "stale" || status.data?.daemon === "failed"
                ? "bad"
                : "off"
          }
          onClick={() => app.goto("ops")}
        />
        <Tile
          head="Metadata database"
          // The DAEMON's verdict first. `database` is derived from pg.json,
          // which exists only once Postgres is ready, so a boot that died
          // earlier rendered as "not configured" — which reads like nobody set
          // it up, on the one tile that should say the database CRASHED.
          state={
            status.data
              ? pgFailed
                ? "Failed to start"
                : status.data.database.kind === "ready"
                  ? status.data.database.mode === "external"
                    ? "External"
                    : "Embedded"
                  : status.data.database.kind.split("-").join(" ")
              : null
          }
          sub={
            pgFailed
              ? (status.data?.daemonPostgres?.reason ?? "the daemon reported no reason")
              : facts.data?.postgres
                ? `${fmt.bytes(facts.data.postgres.databaseBytes)} on disk`
                : null
          }
          tone={!pgFailed && status.data?.database.kind === "ready" ? "ok" : "bad"}
          onClick={() => app.goto("postgres")}
        />
        <Tile
          head="Object storage"
          state={facts.data?.storage.bucket ? facts.data.storage.provider ?? "Configured" : null}
          sub={facts.data?.storage.bucket ?? null}
          tone={facts.data?.storage.bucket ? "ok" : "off"}
          onClick={() => app.goto("storage")}
        />
        <Tile
          head="Embeddings"
          state={facts.data?.embeddings ? `${fmt.int(facts.data.embeddings.embedded)} vectors` : null}
          sub={
            facts.data?.embeddings
              ? facts.data.embeddings.newestAt
                ? `newest ${fmt.ago(facts.data.embeddings.newestAt)}`
                : "nothing has been embedded on this host yet"
              : null
          }
          tone={facts.data?.embeddings?.embedded ? "ok" : "off"}
          onClick={() => app.goto("embeddings")}
        />
      </div>

      <div className="stats">
        <Stat
          label="Sessions on this fortress"
          value={fmt.int(totals?.sessions)}
          sub={
            <>
              {fmt.bytes(totals?.bytes)} ·{" "}
              <span className="dashy">
                {DISCLOSURE_STAT_LABEL}
                <div className="pop">
                  <b>What this console holds</b>
                  <div style={{ marginTop: 6 }}>{DISCLOSURE_STAT_DETAIL}</div>
                </div>
              </span>
            </>
          }
          onClick={() => app.goto("sessions")}
        />
        <Stat
          label="People sending here"
          value={fmt.int(totals?.people)}
          sub="with at least one session on this host"
          onClick={() => app.goto("people")}
        />
        <Stat
          label="Relayed by let.ai"
          value={fmt.int(totals?.tunnel)}
          sub={
            totals
              ? `${fmt.int(totals.gateway)} direct to the gateway · ${fmt.int(totals.unknownProvenance)} unknown`
              : undefined
          }
          onClick={() => app.goto("residency")}
        />
        <Stat
          label="Tombstoned"
          value={fmt.int(facts.data?.postgres?.tombstones)}
          sub="sessions deleted here, remembered so they cannot come back"
        />
      </div>

      {page.data && page.data.foreign.sessions > 0 ? (
        <div className="banner info">
          <span className="badge">i</span>
          <span className="btxt">{page.data.foreign.label}</span>
        </div>
      ) : null}

      <div className="grid2">
        <Panel title="Newest session">
          <Loaded
            resource={page}
            emptyWhen={(data) => data.rows.length === 0}
            empty={<Empty>No sessions have reached this fortress yet.</Empty>}
          >
            {(data) => {
              const row = data.rows[0];
              if (!row) return null;
              return (
                <div className="facts">
                  <FactRow
                    k="Title"
                    v={row.title ?? "untitled"}
                    vs={`${row.userDisplayName ?? row.userExternalId} · ${row.family}`}
                  />
                  <FactRow
                    k="Last activity"
                    v={fmt.ago(row.lastActivityAt)}
                    vs={fmt.when(row.lastActivityAt)}
                  />
                  <FactRow
                    k="Size"
                    v={fmt.bytes(row.bytesUploaded)}
                    vs={`${fmt.plural(row.eventCount, "event")} · ${fmt.plural(row.chunkCount, "chunk")}`}
                  />
                  <FactRow
                    k="Where"
                    v={<span className="mono">{row.repoSlug ?? row.cwd ?? "—"}</span>}
                    vs={row.gitBranch ? `branch ${row.gitBranch}` : undefined}
                  />
                </div>
              );
            }}
          </Loaded>
        </Panel>

        <Panel title="Right now" sub="Counters the daemon publishes on its own clock.">
          <Loaded resource={metrics}>
            {(data) =>
              data.metrics === null ? (
                <Empty>{data.reason ?? "the daemon has published no metrics"}</Empty>
              ) : (
                <div className="facts metrics">
                  <FactRow
                    k="Published"
                    v={fmt.ago(data.metrics.writtenAt)}
                    vs={fmt.when(data.metrics.writtenAt)}
                  />
                  {Object.entries({ ...data.metrics.gauges, ...data.metrics.counters })
                    .sort(([a], [b]) => a.localeCompare(b))
                    .slice(0, 8)
                    .map(([name, value]) => (
                      <FactRow key={name} k={<span className="mono">{name}</span>} v={fmt.int(value)} />
                    ))}
                </div>
              )
            }
          </Loaded>
        </Panel>
      </div>

      <Panel
        title="Sessions landing here"
        sub="Sessions and bytes per day, bucketed on last activity in UTC — the last 30 days."
      >
        <Loaded
          resource={growth}
          emptyWhen={(data) => data.days.length === 0}
          empty={<Empty>No session has been active in the last 30 days.</Empty>}
        >
          {(data) => <GrowthChart rows={data.days} />}
        </Loaded>
      </Panel>
    </section>
  );
}

function Tile(props: {
  head: string;
  state: string | null;
  sub: string | null;
  tone: "ok" | "bad" | "off";
  onClick: () => void;
}): React.ReactElement {
  return (
    <div
      className={`tile${props.tone === "bad" ? " bad" : props.tone === "off" ? " off" : ""}`}
      onClick={props.onClick}
    >
      <div className="thead">
        <span className="tdot"></span> {props.head}
      </div>
      <div className="tstate">{props.state ?? "unknown"}</div>
      <div className="tsub">{props.sub ?? "no answer from this fortress yet"}</div>
    </div>
  );
}

/** Bars scaled to the tallest day in the window. There is no fixed axis maximum:
 *  a hard-coded ceiling either flattens a busy fortress or exaggerates a quiet
 *  one, and both misread as a trend. */
function GrowthChart({ rows }: { rows: GrowthRow[] }): React.ReactElement {
  const peak = Math.max(...rows.map((r) => Number(r.bytes)), 1);
  return (
    <div className="chart">
      <div className="yaxis">
        <span>{fmt.bytes(peak)}</span>
        <span>{fmt.bytes(peak / 2)}</span>
        <span>0</span>
      </div>
      <div className="plot">
        <div className="gridl" style={{ top: 0 }}></div>
        <div className="gridl" style={{ top: "50%" }}></div>
        <div className="bars">
          {rows.map((row) => (
            <i
              key={row.day}
              style={{ height: `${Math.max(3, (Number(row.bytes) / peak) * 100)}%` }}
              title={`${row.day} · ${fmt.plural(row.sessions, "session")} · ${fmt.bytes(row.bytes)}`}
            />
          ))}
        </div>
        <div className="axis">
          <span>{rows[0]?.day ?? ""}</span>
          <span>{rows[rows.length - 1]?.day ?? ""}</span>
        </div>
      </div>
    </div>
  );
}
