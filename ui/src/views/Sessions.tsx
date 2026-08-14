import React, { useState } from "react";

import { api, type SessionRow } from "../api";
import { Empty, FactRow, Loaded, Panel, SearchBox, Stat, ViewFallback, awaiting } from "../components";
import {
  DISCLOSURE_BOUNDARY,
  DISCLOSURE_SESSIONS_LEDE,
  DISCLOSURE_STAT_LABEL,
  DISCLOSURE_STAT_DETAIL,
} from "../disclosure";
import * as fmt from "../format";
import { useResource } from "../hooks";
import { useApp } from "../state";
import { VerifyResidencyPanel } from "./Verify";

const PAGE = "50";

export function Sessions(): React.ReactElement {
  const app = useApp();
  const active = app.view === "sessions";
  const query = app.route.query;
  const [cursor, setCursor] = useState<string | null>(null);

  const page = useResource(
    () => api.sessions({ limit: PAGE, ...(query ? { search: query } : {}), ...(cursor ? { cursor } : {}) }),
    [query, cursor],
    { pollMs: 20_000, active },
  );

  const setQuery = (value: string): void => {
    setCursor(null);
    app.navigate({ query: value }, { replace: true });
  };

  const totals = page.data?.totals ?? null;

  // Bad numbers are worse than a wait: every headline figure here is one
  // `?? 0` away from claiming this fortress holds nothing, and a first load
  // that FAILED has no data either. Show the shell with a loader — or the
  // reason, when there is one — until the answers have actually arrived.
  const gate = [page];
  if (active && gate.some(awaiting)) {
    return (
      <section className="view active">
        <ViewFallback resources={gate} />
      </section>
    );
  }

  return (
    <section className={active ? "view active" : "view"}>
      <div className="kicker">Operate</div>
      <h1>Sessions</h1>
      <p className="lede">{DISCLOSURE_SESSIONS_LEDE}</p>

      <div className="stats">
        <Stat
          label="Total sessions"
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
        />
        <Stat label="People" value={fmt.int(totals?.people)} sub="with at least one session here" />
        <Stat
          label="Relayed by let.ai"
          value={fmt.int(totals?.tunnel)}
          sub={totals ? `${fmt.int(totals.gateway)} arrived directly at the gateway` : undefined}
        />
        <Stat
          label="Unknown provenance"
          value={fmt.int(totals?.unknownProvenance)}
          sub="recovered by the reconciler, or written before the channel was stamped"
        />
      </div>

      <div className="toolbar">
        <SearchBox
          placeholder="Search titles, working directories, branches, repos, session ids…"
          value={query}
          onInput={setQuery}
        />
      </div>

      {page.data && page.data.foreign.sessions > 0 ? (
        <div className="banner info">
          <span className="badge">i</span>
          <span className="btxt">{page.data.foreign.label}</span>
        </div>
      ) : null}

      <Loaded
        resource={page}
        emptyWhen={(data) => data.rows.length === 0}
        empty={
          <Empty>
            {query
              ? `Nothing on this fortress matches “${query}”.`
              : "No sessions have reached this fortress yet."}
          </Empty>
        }
      >
        {(data) => (
          <>
            <div className="rowlist">
              {data.rows.map((row) => (
                <SessionLine key={row.id} row={row} onOpen={() => openSession(app, row)} />
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 16, justifyContent: "flex-end" }}>
              {cursor ? (
                <button className="btn ghost" onClick={() => setCursor(null)}>
                  Back to the newest
                </button>
              ) : null}
              {data.nextCursor ? (
                <button
                  className="btn ghost"
                  onClick={() => {
                    setCursor(data.nextCursor as string);
                    window.scrollTo(0, 0);
                  }}
                >
                  Older →
                </button>
              ) : null}
            </div>
          </>
        )}
      </Loaded>
    </section>
  );
}

function openSession(app: ReturnType<typeof useApp>, row: SessionRow): void {
  app.navigate({ view: "session-detail", family: row.family, sid: row.sessionId });
  window.scrollTo(0, 0);
}

function TitleSource({ row }: { row: SessionRow }): React.ReactElement | null {
  const chip = fmt.titleSourceChip(row.titleSource, row.title);
  if (!chip) return null;
  return <span className={chip.derived ? "tsrc derived" : "tsrc"}>{chip.label}</span>;
}

function SessionLine({ row, onOpen }: { row: SessionRow; onOpen: () => void }): React.ReactElement {
  return (
    <div className="row linkrow" onClick={onOpen}>
      <span className="dot"></span>
      <div className="who">
        <b>{row.title ?? "untitled"}</b> <TitleSource row={row} />
        <div className="sub">
          {row.userDisplayName ?? row.userExternalId} · {row.family}
          {row.repoSlug ? ` · ${row.repoSlug}` : ""}
          {row.gitBranch ? ` · ${row.gitBranch}` : ""}
        </div>
      </div>
      <div className="m">{fmt.bytes(row.bytesUploaded)}</div>
      <div className="m">{fmt.ago(row.lastActivityAt)}</div>
    </div>
  );
}

export function SessionDetail(): React.ReactElement {
  const app = useApp();
  const active = app.view === "session-detail";
  const family = app.route.family ?? "";
  const sid = app.route.sid ?? "";

  const found = useResource(
    () => api.sessions({ limit: "20", family, search: sid }),
    [family, sid],
    { active: active && sid !== "" },
  );
  const row = found.data?.rows.find((r) => r.sessionId === sid) ?? null;

  return (
    <section className={active ? "view active" : "view"}>
      <div className="kicker">
        <a
          href="/sessions"
          onClick={(e) => {
            e.preventDefault();
            app.goto("sessions");
          }}
        >
          ← Sessions
        </a>
      </div>
      <h1>{row?.title ?? (found.loading ? "Session" : "That session is not on this fortress")}</h1>
      <p className="lede">
        {row
          ? `${row.userDisplayName ?? row.userExternalId} · ${row.family} · last active ${fmt.ago(row.lastActivityAt)}`
          : found.error ?? "It may belong to another organization, or it may have been deleted here."}
      </p>

      {row ? (
        <>
          <div className="grid2">
            <Panel title="Session">
              <div className="facts">
                <FactRow
                  k="Title"
                  v={
                    <>
                      {row.title ?? "untitled"} <TitleSource row={row} />
                    </>
                  }
                  vs={
                    fmt.derivedFromContent(row.titleSource, row.title)
                      ? "derived from the conversation, so it is not plain metadata"
                      : "supplied by the client"
                  }
                />
                <FactRow k="Session id" v={<span className="mono">{row.sessionId}</span>} vs={row.family} />
                <FactRow
                  k="Person"
                  v={row.userDisplayName ?? row.userExternalId}
                  // The id underneath only when the value above is a NAME.
                  // Without a name the fallback is the id itself, and the row
                  // printed the same opaque string twice, which reads as a
                  // rendering fault rather than as "this person has no name here".
                  vs={
                    row.userDisplayName ? <span className="mono">{row.userExternalId}</span> : undefined
                  }
                />
                <FactRow k="Device" v={row.deviceName ?? "—"} />
                <FactRow
                  k="Repository"
                  v={<span className="mono">{row.repoSlug ?? "—"}</span>}
                  vs={row.gitBranch ? `branch ${row.gitBranch}` : undefined}
                />
                <FactRow k="Working directory" v={<span className="mono">{row.cwd ?? "—"}</span>} />
              </div>
            </Panel>

            <Panel title="Activity">
              <div className="facts">
                <FactRow k="First event" v={fmt.when(row.firstEventAt)} vs={fmt.ago(row.firstEventAt)} />
                <FactRow k="Last activity" v={fmt.when(row.lastActivityAt)} vs={fmt.ago(row.lastActivityAt)} />
                <FactRow
                  k="Counts"
                  v={`${fmt.int(row.eventCount)} events`}
                  vs={`${fmt.int(row.userTextCount)} prompts · ${fmt.int(row.assistantCount)} replies · ${fmt.int(row.toolCallCount)} tool calls`}
                />
                <FactRow
                  k="Tokens"
                  v={`${fmt.tokens(row.inputTokens)} in · ${fmt.tokens(row.outputTokens)} out`}
                  vs={row.estCostUsd === null ? "no cost estimate recorded" : `estimated ${fmt.usd(row.estCostUsd)}`}
                />
                <FactRow
                  k="Uploaded"
                  v={fmt.bytes(row.bytesUploaded)}
                  vs={`${fmt.plural(row.chunkCount, "chunk")} appended`}
                />
              </div>
            </Panel>
          </div>

          <Panel title="Where it rests">
            <div className="facts wide">
              <FactRow
                k="Transcript object"
                v={<span className="mono">{row.sourcePath ?? "not recorded"}</span>}
                vs="in the organization's own bucket, under the organization's own keys"
              />
              <FactRow
                k="How it arrived"
                v={row.ingestChannel ?? "unknown"}
                vs={ingestChannelCopy(row.ingestChannel)}
              />
            </div>
          </Panel>

          <VerifyResidencyPanel family={row.family} sessionId={row.sessionId} />

          <Panel title="Content boundary">
            <p className="saidby" style={{ maxWidth: 760 }}>
              {DISCLOSURE_BOUNDARY}
            </p>
          </Panel>
        </>
      ) : null}
    </section>
  );
}

function ingestChannelCopy(channel: string | null): string {
  if (channel === "tunnel") return "relayed by let.ai over the outbound tunnel this fortress dials";
  if (channel === "gateway") return "posted directly to this fortress's gateway, never touching let.ai";
  if (channel === "reconciled") {
    return "recovered by the reconciler, which cannot know how the bytes first arrived";
  }
  return "written before this fortress stamped a channel, so the route it took is not recorded";
}
