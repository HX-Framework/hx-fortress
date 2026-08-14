import React from "react";

import { api, type PostureView, type ResidencyFindingRow } from "../api";
import { FactRow, Loaded, MutationControl, Panel, ResultLine, Stat, ViewFallback, awaiting, useConfirm, useResultLine } from "../components";
import { COMMAND_REQUEST_NOTE, NO_POLLER_REFUSAL } from "../../../src/ui/copy";
import * as fmt from "../format";
import { useResource } from "../hooks";
import { useApp } from "../state";
import { VerifyResidencyPanel } from "./Verify";

const POSTURE_COPY: Record<string, string> = {
  fresh: "Answered by let.ai, recently.",
  stale: "The last answer from let.ai is old enough that it may no longer describe today.",
  unavailable: "let.ai could not be asked, so this is what this host knows on its own.",
  "never-fetched": "let.ai has not been asked yet.",
};

/**
 * Where sessions rest, answered from the two things this host can actually see:
 * the channel each session arrived on, and whatever let.ai last said about
 * sessions it believes belong to this organization.
 *
 * There is no "verified" verdict here and no fleet walk. Proving a session's
 * bytes are where the row says they are means heading every object in the
 * bucket, and that engine is not this page's to fake — a green tick with nothing
 * behind it is worse than an honest count.
 */
export default function Residency(): React.ReactElement {
  const app = useApp();
  const active = app.view === "residency";
  const posture = useResource(() => api.posture(), [], { pollMs: 60_000, active });
  const page = useResource(() => api.sessions({ limit: "1" }), [], { pollMs: 30_000, active });
  // The DAEMON's own state. `posture` is read from a published file, so it
  // answers whether or not anything is running — gating the mutation controls on
  // it left Run audit, the witness toggles and Acknowledge enabled against a
  // stopped daemon, each replying "asked the daemon to…" about a request nothing
  // would ever claim.
  const status = useResource(() => api.status(), [], { pollMs: 10_000, active });
  const daemonRunning = status.data?.daemon === "running";

  const totals = page.data?.totals ?? null;

  // Bad numbers are worse than a wait: every headline figure here is one

  // `?? 0` away from claiming this fortress holds nothing. Show the shell and

  // a loader until the answers have actually arrived.

  const gate = [posture, page, status];
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
      <h1>Residency</h1>
      <p className="lede">
        Every session below is on this host: its metadata row is in this fortress's own database and
        its transcript is in the organization's own bucket. What differs between them is how they
        got here, which is the fact that decides what can be proven about them.
      </p>

      <div className="stats">
        <Stat label="Sessions here" value={fmt.int(totals?.sessions)} sub={fmt.bytes(totals?.bytes)} />
        <Stat
          label="Relayed by let.ai"
          value={fmt.int(totals?.tunnel)}
          sub="cloud-relayed, so let.ai can be asked about them"
        />
        <Stat
          label="Direct to the gateway"
          value={fmt.int(totals?.gateway)}
          sub="never passed through let.ai at all"
        />
        <Stat
          label="Unknown provenance"
          value={fmt.int(totals?.unknownProvenance)}
          sub="recovered by the reconciler, or written before the channel was stamped"
        />
      </div>

      {page.data && page.data.foreign.sessions > 0 ? (
        <div className="banner info">
          <span className="badge">i</span>
          <span className="btxt">{page.data.foreign.label}</span>
        </div>
      ) : null}

      <Panel
        title="What let.ai says"
        sub="The routing posture, as this fortress last managed to read it."
      >
        <Loaded resource={posture}>
          {(data) => (
            <>
              <div className="facts wide">
                <FactRow
                  k="Answer"
                  v={data.state.split("-").join(" ")}
                  vs={POSTURE_COPY[data.state] ?? undefined}
                  tone={data.state === "fresh" ? "ok" : "warn"}
                />
                <FactRow k="As of" v={fmt.when(data.asOf)} vs={fmt.ago(data.asOf)} />
                <FactRow
                  k="Held only by let.ai"
                  v={fmt.int(data.cloudOnlySessions)}
                  vs="sessions let.ai believes belong here and this host has never received"
                />
                <FactRow
                  k="Routed here"
                  v={fmt.int(data.routedHere)}
                  vs="sessions let.ai says it delivered to this fortress"
                />
              </div>
              <div className="why-note" style={{ marginTop: 14 }}>
                {data.qualification}
              </div>
              {data.clockSkew ? (
                // Computed by the read port and rendered NOWHERE until now. The
                // failure it describes is invisible from this host: a drifted
                // clock rejects every one-click hand-off with a page only the
                // person in the workbench ever sees.
                <div className="banner warn" style={{ marginTop: 12 }} data-testid="clock-skew">
                  <span className="badge">!</span>
                  <span className="btxt">
                    This host's clock is {fmt.int(Math.abs(data.clockSkew.offsetSeconds))}s from the
                    one that minted the last grant (allowed: {data.clockSkew.allowedSeconds}s).{" "}
                    {data.clockSkew.remediation}
                  </span>
                </div>
              ) : null}
            </>
          )}
        </Loaded>
      </Panel>

      <FindingsPanel
        daemonRunning={daemonRunning}
        resource={posture}
        onChanged={() => void posture.reload()}
      />

      <AuditPanel daemonRunning={daemonRunning} witness={posture.data?.witness ?? null} />

      {page.data?.rows[0] ? (
        <VerifyResidencyPanel
          family={page.data.rows[0].family}
          sessionId={page.data.rows[0].sessionId}
          sub="A spot check against the most recent session here. Every session's own page carries the same control."
        />
      ) : null}

      <Panel
        title="Why provenance decides what can be proven"
        sub="The three channels, and what each one leaves behind."
      >
        <div className="rowlist ops">
          <div className="row">
            <span className="dot"></span>
            <div className="who">
              <b>Relayed by let.ai</b>
              <div className="sub">
                let.ai forwarded the transcript it already held, so its own index names the session
                and can be asked whether a copy remained.
              </div>
            </div>
            <div>
              <span className="pill ok pc">Provable both ways</span>
            </div>
            <div className="m">tunnel</div>
          </div>
          <div className="row">
            <span className="dot"></span>
            <div className="who">
              <b>Direct to the gateway</b>
              <div className="sub">
                The client posted straight to this host. let.ai never saw the session, so it has
                nothing to be asked about — the absence is the property, not a gap.
              </div>
            </div>
            <div>
              <span className="pill fortress pc">Local only</span>
            </div>
            <div className="m">gateway</div>
          </div>
          <div className="row">
            <span className="dot warn"></span>
            <div className="who">
              <b>Unknown provenance</b>
              <div className="sub">
                Recovered by the reconciler after an outage, or written by a build that predates the
                channel column. The route is not recorded, and inventing one would be a claim
                nothing supports.
              </div>
            </div>
            <div>
              <span className="pill warn pc">Not asked</span>
            </div>
            <div className="m">reconciled</div>
          </div>
        </div>
      </Panel>
    </section>
  );
}

/**
 * The audit itself, asked for from here.
 *
 * Two controls, and the second one is an EGRESS switch: with the witness on,
 * the session ids of cloud-relayed sessions are sent to let.ai so it can say
 * whether it still holds a copy. With it off nothing leaves the box and every
 * eligible session reports the witness as unavailable — which is a different
 * answer from "let.ai holds no copy", and the run says so.
 */
function AuditPanel(props: {
  daemonRunning: boolean;
  witness: { enabled: boolean; changedAt: string | null; changedBy: string | null } | null;
}): React.ReactElement {
  const [dialog, ask] = useConfirm();
  const [result, showResult] = useResultLine();
  const [busy, setBusy] = React.useState(false);
  const reason = props.daemonRunning ? undefined : NO_POLLER_REFUSAL;

  const submit = async (
    kind: string,
    params: Record<string, unknown>,
    confirm: { title: string; body: string; confirmLabel: string; danger?: boolean },
    done: string,
  ): Promise<void> => {
    if (!(await ask(confirm))) return;
    setBusy(true);
    try {
      await api.submitCommand(kind, params);
      showResult(done);
    } catch (error) {
      showResult(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Run the audit"
      sub="The daemon lists the bucket, checks every session this fortress claims against what is actually there, and records a run you can come back to."
    >
      {dialog}
      <div className="facts wide">
        <FactRow
          k="Residency audit"
          v="On demand"
          vs={COMMAND_REQUEST_NOTE}
          action={
            <MutationControl
              label="Run audit"
              small
              disabled={busy || reason !== undefined}
              {...(reason ? { reason } : {})}
              onClick={() =>
                void submit(
                  "run_audit",
                  { scope: "console" },
                  {
                    title: "Run the residency audit?",
                    body: "The daemon lists this organization's bucket and checks every session against it. Large fortresses take a while; the run is paced so it cannot become an outage.",
                    confirmLabel: "Run it",
                  },
                  "Asked the daemon to run it. Its verdict appears under Commands.",
                )
              }
            />
          }
        />
        <FactRow
          k="Ask let.ai"
          v={props.witness ? (props.witness.enabled ? "On" : "Off") : "Cloud witness"}
          vs={
            // The STAMP, rendered. `hx.set_cloud_witness` cannot be fenced — the
            // daemon and a leaked roles.json are the same Postgres role — so who
            // last changed it is the whole compensating control, and it was
            // recorded and read by nothing.
            props.witness?.changedAt
              ? `Last changed ${fmt.when(props.witness.changedAt)} by ${props.witness.changedBy ?? "an unrecorded role"}. With it on, the ids of cloud-relayed sessions are sent to let.ai during a run; with it off nothing leaves this host.`
              : "With it on, the ids of cloud-relayed sessions are sent to let.ai during a run. With it off nothing leaves this host, and every eligible session reports the witness as unavailable."
          }
          action={
            <span style={{ display: "inline-flex", gap: 8 }}>
              <MutationControl
                label="Turn on"
                small
                disabled={busy || reason !== undefined}
                {...(reason ? { reason } : {})}
                onClick={() =>
                  void submit(
                    "witness_toggle",
                    { enabled: true },
                    {
                      title: "Send session ids to let.ai during an audit?",
                      body: "Only for sessions that reached this fortress THROUGH let.ai — it has already seen those ids. Nothing else is sent, and no transcript ever is.",
                      confirmLabel: "Turn it on",
                    },
                    "Asked the daemon to turn the cloud witness on.",
                  )
                }
              />
              <MutationControl
                label="Turn off"
                small
                danger
                disabled={busy || reason !== undefined}
                {...(reason ? { reason } : {})}
                onClick={() =>
                  void submit(
                    "witness_toggle",
                    { enabled: false },
                    {
                      title: "Stop asking let.ai?",
                      body: "No session id leaves this host from then on. Every eligible session will report the witness as unavailable, which is not the same as let.ai reporting no copy — and the run will say so.",
                      confirmLabel: "Turn it off",
                      danger: true,
                    },
                    "Asked the daemon to turn the cloud witness off.",
                  )
                }
              />
            </span>
          }
        />
      </div>
      <ResultLine state={result} />
    </Panel>
  );
}

/**
 * What the last run actually found, named — and the one control that can clear
 * it.
 *
 * The audit's roll-up fails on any unacknowledged `also_at_letai`, and until
 * this panel existed it failed while naming no session: the findings were
 * written to a table nothing read, and `acknowledge_finding` was an accepted
 * command with no surface that submitted it. A compliance page stuck at failed
 * with nothing an operator can do is worse than one that never ran.
 *
 * Only `also_at_letai` is acknowledgeable, and the control says so rather than
 * offering a button that would be refused: every other failing verdict is a
 * statement about bytes that are not in this bucket, which no sign-off changes.
 */
function FindingsPanel(props: {
  daemonRunning: boolean;
  resource: { data: PostureView | null; stale?: boolean };
  onChanged: () => void;
}): React.ReactElement | null {
  const [dialog, ask] = useConfirm();
  const [result, showResult] = useResultLine();
  const [busy, setBusy] = React.useState<string | null>(null);
  // Sessions the operator has asked for, awaiting the daemon's own record of
  // the acknowledgement. The command is a REQUEST — the row cannot clear until
  // the daemon claims and completes it — so the page says "asked" on the row
  // itself rather than leaving a live button that mints a second command on
  // every further click.
  const [asked, setAsked] = React.useState<ReadonlySet<string>>(new Set());
  const reason = props.daemonRunning ? undefined : NO_POLLER_REFUSAL;
  const posture = props.resource.data;
  const data = posture?.findings ?? null;

  // UNKNOWN is not CLEAN. A stopped Postgres degrades `findings` to null, and
  // rendering nothing there says "no findings" on the one surface where the
  // difference is the whole point.
  if (posture && data === null) {
    return (
      <Panel
        title="What the last run found"
        sub="This console could not read the audit's own tables, so it cannot say what the last run found."
      >
        <div className="banner warn">
          <span className="badge">!</span>
          <span className="btxt">
            Not answered — the fortress database could not be reached. This is not the same as a
            run with nothing to report.
          </span>
        </div>
      </Panel>
    );
  }
  // A run that found nothing is a RESULT, and it was the one result this panel
  // could not state: it returned null, so the page after a clean audit was
  // byte-identical to the page before it. On a compliance surface "checked, and
  // clean, at 10:10" is the answer the reader came for — and rendering nothing
  // also made a command plane that rejected every request indistinguishable from
  // one that worked perfectly.
  if (!data || data.rows.length === 0) {
    const run = posture?.lastRun ?? null;
    if (!run) {
      return (
        <Panel
          title="What the last run found"
          sub="No audit has completed on this host yet. That is not the same as a run with nothing to report."
        >
          <div className="banner">
            <span className="badge">–</span>
            <span className="btxt">Run the audit above to record one.</span>
          </div>
        </Panel>
      );
    }
    return (
      <Panel
        title="What the last run found"
        sub={`From the run of ${fmt.when(run.startedAt)}${run.trigger ? ` (${run.trigger})` : ""}.`}
      >
        <div className="banner ok">
          <span className="badge">✓</span>
          <span className="btxt">
            Nothing to report — {run.qualification ?? "every checked session is held here"}.{" "}
            {run.sessionsChecked} session(s) checked, {run.confirmed} confirmed.
          </span>
        </div>
      </Panel>
    );
  }

  const acknowledge = async (row: ResidencyFindingRow): Promise<void> => {
    const ok = await ask({
      title: "Acknowledge this copy?",
      body:
        "This records that somebody responsible has seen that let.ai also holds a copy of this " +
        "session, and stops it failing the residency check. It does not delete anything, here or " +
        "there. The acknowledgement is signed into this host's audit trail with your login.",
      confirmLabel: "Acknowledge",
    });
    if (!ok) return;
    setBusy(row.sessionId);
    try {
      await api.submitCommand("acknowledge_finding", {
        org: row.org,
        sessionId: row.sessionId,
        reason: "acknowledged from the console",
      });
      setAsked((prev) => new Set([...prev, row.sessionId]));
      showResult("Asked the daemon to record it. The finding clears once it has.");
      props.onChanged();
    } catch (error) {
      showResult(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title="What the last run found"
      sub={
        data.runStartedAt
          ? `From the run of ${fmt.when(data.runStartedAt)}. ${data.total} finding(s)${
              data.shown < data.total ? `, showing the first ${data.shown}` : ""
            }.`
          : `${data.total} finding(s) from the most recent completed run.`
      }
    >
      {dialog}
      <div className="rowlist ops">
        {data.rows.map((row) => (
          <div className="row" key={`${row.org}/${row.family}/${row.sessionId}`}>
            <span className={row.acknowledged ? "dot" : "dot warn"}></span>
            <div className="who">
              <b>{row.sessionId}</b>
              <div className="sub">
                {row.detail ?? row.verdict.split("_").join(" ")}
                {row.ingestChannel ? ` · arrived over ${row.ingestChannel}` : ""}
              </div>
            </div>
            <div>
              {/* The VERDICT always, even once acknowledged: what was found is
                  the fact, and an acknowledgement is an annotation on it. */}
              <span className={row.acknowledged ? "pill ok pc" : "pill warn pc"}>
                {row.verdict.split("_").join(" ")}
              </span>
            </div>
            <div className="m">
              {row.acknowledged ? (
                <span className="sub">acknowledged</span>
              ) : asked.has(row.sessionId) ? (
                <span className="sub" data-testid="ack-asked">
                  asked — awaiting the daemon
                </span>
              ) : row.acknowledgeable ? (
                <MutationControl
                  label="Acknowledge"
                  small
                  disabled={busy !== null || reason !== undefined}
                  {...(reason ? { reason } : {})}
                  onClick={() => void acknowledge(row)}
                />
              ) : (
                <span className="sub">not acknowledgeable</span>
              )}
            </div>
          </div>
        ))}
      </div>
      <ResultLine state={result} />
    </Panel>
  );
}
