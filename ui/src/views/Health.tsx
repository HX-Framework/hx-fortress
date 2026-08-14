import React from "react";

import { api, type ConsoleDbState } from "../api";
import { Empty, FactRow, Loaded, Panel, Stat, ViewFallback, awaiting } from "../components";
import * as fmt from "../format";
import { useResource } from "../hooks";
import { useApp } from "../state";

/** What each database state means, and what to do about it. The three degraded
 *  ones are DIFFERENT facts with different remedies, and collapsing them into
 *  "database unavailable" costs an operator an afternoon. */
function databaseCopy(state: ConsoleDbState): { headline: string; detail: string; ok: boolean } {
  switch (state.kind) {
    case "ready":
      return {
        headline: state.mode === "external" ? "External" : "Embedded",
        detail:
          state.mode === "external"
            ? "the operator's own Postgres, reached over the network"
            : "managed by hx-fortress, on this host, bound to loopback",
        ok: true,
      };
    case "not-configured":
      return {
        headline: "No coordinates",
        detail:
          "the daemon writes them on its first boot with a console-capable binary. Start the fortress daemon, then reload.",
        ok: false,
      };
    case "role-not-provisioned":
      return {
        headline: "Console role missing",
        detail:
          "the console's database role is created by the daemon on every boot, so the fix is to restart the daemon — not to create the role by hand.",
        ok: false,
      };
    case "postgres-stopped":
      return {
        headline: "Not accepting connections",
        detail: "the daemon owns Postgres; start the fortress daemon.",
        ok: false,
      };
    default:
      return { headline: "Not answering", detail: state.detail, ok: false };
  }
}

export function Postgres(): React.ReactElement {
  const app = useApp();
  const active = app.view === "postgres";
  const status = useResource(() => api.status(), [], { pollMs: 10_000, active });
  const facts = useResource(() => api.facts(), [], { pollMs: 30_000, active });
  const identity = useResource(() => api.identity(), [], { pollMs: 60_000, active });

  // The DAEMON's verdict wins whenever it reports a failure. `database` is
  // derived from pg.json, which is written only once Postgres is ready, so a
  // boot that died earlier renders as "No coordinates — start the fortress
  // daemon" while the daemon is running and has already recorded exactly what
  // went wrong. Telling an operator to start something that is already started
  // is worse than saying nothing: it sends them away from the evidence.
  const pg = status.data?.daemonPostgres ?? null;
  const database = status.data
    ? pg && (pg.phase === "failed" || pg.phase === "retrying")
      ? {
          headline: pg.phase === "failed" ? "Failed to start" : "Retrying",
          detail:
            pg.reason ??
            "the daemon reported no reason — see `hx-fortress logs` on this host.",
          ok: false,
        }
      : databaseCopy(status.data.database)
    : null;

  // Bad numbers are worse than a wait: every headline figure here is one
  // `?? 0` away from claiming this fortress holds nothing, and a first load
  // that FAILED has no data either. Show the shell with a loader — or the
  // reason, when there is one — until the answers have actually arrived.
  const gate = [status, facts];
  if (active && gate.some(awaiting)) {
    return (
      <section className="view active">
        <ViewFallback resources={gate} />
      </section>
    );
  }

  return (
    <section className={active ? "view active" : "view"}>
      <div className="kicker">Setup &amp; health</div>
      <h1>Postgres</h1>
      <p className="lede">
        The database that holds session metadata, search vectors and this console's audit trail.
        While it is down, the hx clients of this organization have nowhere to record what they
        upload.
      </p>

      <div className="stats">
        <Stat label="State" value={database?.headline ?? "…"} sub={database?.detail} />
        <Stat
          label="Size"
          value={fmt.bytes(facts.data?.postgres?.databaseBytes)}
          sub="as the server reports it"
        />
        <Stat label="Sessions" value={fmt.int(facts.data?.postgres?.sessions)} sub="rows in this fortress's universe" />
        <Stat label="People" value={fmt.int(facts.data?.postgres?.people)} sub="live user rows" />
      </div>

      <Panel title="Connection">
        <Loaded resource={status}>
          {(data) => {
            const copy = databaseCopy(data.database);
            return (
              <div className="facts wide">
                <FactRow k="Mode" v={copy.headline} vs={copy.detail} tone={copy.ok ? "ok" : "warn"} />
                <FactRow
                  k="Daemon"
                  v={data.copy}
                  vs={
                    data.writtenAt
                      ? `status written ${fmt.ago(data.writtenAt)}`
                      : "this daemon publishes no write timestamp, so its age is unknown — not stale"
                  }
                />
                <FactRow
                  k="Coordinates"
                  v={<span className="mono">{identity.data?.paths.databaseCoordinates ?? "—"}</span>}
                  vs="written by the daemon; the console never mints a connection string of its own"
                />
                <FactRow
                  k="Data directory"
                  v={<span className="mono">{identity.data?.paths.postgresData ?? "—"}</span>}
                />
              </div>
            );
          }}
        </Loaded>
      </Panel>

      <Panel
        title="Provisioned roles"
        sub="Least privilege, per install. An external database has none of them: the operator's single connection string is the whole story."
      >
        <Loaded
          resource={identity}
          emptyWhen={(data) => data.roles.length === 0}
          empty={
            <Empty>
              This fortress uses an external Postgres, so there is no role split to show.
            </Empty>
          }
        >
          {(data) => (
            <div className="facts wide">
              {data.roles.map((role) => (
                <FactRow key={role.name} k={<span className="mono">{role.name}</span>} v={role.what} />
              ))}
            </div>
          )}
        </Loaded>
      </Panel>
    </section>
  );
}

export function Storage(): React.ReactElement {
  const app = useApp();
  const active = app.view === "storage";
  const facts = useResource(() => api.facts(), [], { pollMs: 30_000, active });
  const page = useResource(() => api.sessions({ limit: "1" }), [], { pollMs: 60_000, active });

  // Bad numbers are worse than a wait: every headline figure here is one
  // `?? 0` away from claiming this fortress holds nothing, and a first load
  // that FAILED has no data either. Show the shell with a loader — or the
  // reason, when there is one — until the answers have actually arrived.
  const gate = [facts, page];
  if (active && gate.some(awaiting)) {
    return (
      <section className="view active">
        <ViewFallback resources={gate} />
      </section>
    );
  }

  return (
    <section className={active ? "view active" : "view"}>
      <div className="kicker">Setup &amp; health</div>
      <h1>Object storage</h1>
      <p className="lede">
        Transcripts rest in the organization's own bucket, under the organization's own keys.
        Neither the bucket nor the keys reach let.ai.
      </p>

      <Loaded resource={facts}>
        {(data) => (
          <>
            <div className="stats">
              <Stat label="Provider" value={data.storage.provider ?? "none"} sub={data.storage.region ?? undefined} />
              <Stat
                label="Bucket"
                value={<span className="mono" style={{ fontSize: 20 }}>{data.storage.bucket ?? "—"}</span>}
                sub={data.storage.bucket ? "resolved from the fortress credential" : "no bucket is configured"}
              />
              <Stat label="Uploaded" value={fmt.bytes(page.data?.totals.bytes)} sub="summed over the sessions here" />
              <Stat label="Sessions" value={fmt.int(page.data?.totals.sessions)} sub="one transcript object each" />
            </div>

            <Panel
              title="Bucket configuration"
              sub="Read from the provider. The fortress key is provisioned for object access, so a configuration it cannot read says so rather than being guessed at."
            >
              <div className="facts wide">
                <FactRow k="Versioning" v={data.storage.versioning} />
                <FactRow k="Lifecycle" v={data.storage.lifecycle} />
              </div>
            </Panel>
          </>
        )}
      </Loaded>

      <Panel
        title="Object layout"
        sub="Every object a session owns lives under one prefix — short, predictable, auditable from the bucket alone."
      >
        <div className="facts wide">
          <FactRow
            k="Session prefix"
            v={<span className="mono">{"{userId}/{family}/{sessionId}/"}</span>}
            vs="staging and canonical share the bucket, under the same prefix"
          />
          <FactRow
            k="Canonical"
            v={<span className="mono">log.jsonl</span>}
            vs="one object per session, chunks appended in order"
          />
          <FactRow
            k="Staging"
            v={<span className="mono">{".staging/{chunkId}.jsonl"}</span>}
            vs="transient upload chunks, composed into the canonical and then removed"
          />
          <FactRow
            k="Artifacts"
            v={<span className="mono">session.json · tasks.json · plan.json</span>}
            vs="allow-listed sidecars; nothing else can be written by name"
          />
        </div>
      </Panel>
    </section>
  );
}

export function Embeddings(): React.ReactElement {
  const app = useApp();
  const active = app.view === "embeddings";
  const facts = useResource(() => api.facts(), [], { pollMs: 30_000, active });

  // Bad numbers are worse than a wait: every headline figure here is one
  // `?? 0` away from claiming this fortress holds nothing, and a first load
  // that FAILED has no data either. Show the shell with a loader — or the
  // reason, when there is one — until the answers have actually arrived.
  const gate = [facts];
  if (active && gate.some(awaiting)) {
    return (
      <section className="view active">
        <ViewFallback resources={gate} />
      </section>
    );
  }

  return (
    <section className={active ? "view active" : "view"}>
      <div className="kicker">Setup &amp; health</div>
      <h1>Embeddings</h1>
      <p className="lede">
        Vectors make sessions searchable by meaning. They are computed through the configured
        embedding endpoint and stored in this fortress's own Postgres.
      </p>

      <Loaded resource={facts}>
        {(data) =>
          data.embeddings === null ? (
            <Empty>This fortress has no embedding index to report on.</Empty>
          ) : (
            <>
              <div className="stats">
                <Stat label="Vectors" value={fmt.int(data.embeddings.embedded)} sub="one per embeddable turn" />
                <Stat
                  label="Models"
                  value={fmt.int(data.embeddings.models)}
                  sub="distinct models represented in the index"
                />
                <Stat
                  label="Newest"
                  value={fmt.ago(data.embeddings.newestAt)}
                  sub={fmt.when(data.embeddings.newestAt)}
                />
                <Stat
                  label="Where"
                  value="Postgres"
                  sub="pgvector, on this host — the vectors never leave it"
                />
              </div>

              <Panel title="What the console can see here">
                <div className="facts wide">
                  <FactRow
                    k="Coverage"
                    v={`${fmt.int(data.embeddings.embedded)} embedded`}
                    vs="counts and models only — the vector column is withheld from this console at the privilege layer, and no query here asks for it"
                  />
                  <FactRow
                    k="Embedding key"
                    v="held by the daemon"
                    vs="the console process is never given it, which is the one real narrowing between the two"
                  />
                </div>
              </Panel>
            </>
          )
        }
      </Loaded>
    </section>
  );
}
