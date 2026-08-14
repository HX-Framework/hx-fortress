import React from "react";

import { MIGRATION_PHASES } from "../../../src/console/command-params";
import { helpEntries } from "../../../src/ui/help";
import {
  COMMAND_REQUEST_NOTE,
  CONTAINER_SERVICE_REFUSAL,
  NO_POLLER_REFUSAL,
} from "../../../src/ui/copy";
import {
  api,
  ApiError,
  NO_ANSWER,
  type CommandView,
  type MigrationRunView,
  type StatusView,
} from "../api";
import { Empty, FactRow, Loaded, MutationControl, Panel, ResultLine, ViewFallback, awaiting, useConfirm, useResultLine } from "../components";
import { COMMAND_SURFACE_NOTE, OPS_SESSION_LINE, opsLede } from "../copy";
import * as fmt from "../format";
import { useResource, type Resource } from "../hooks";
import { useApp } from "../state";

const CORROBORATION_PILL: Record<string, { label: string; tone: string }> = {
  confirmed: { label: "Confirmed", tone: "ok" },
  awaiting: { label: "Awaiting corroboration", tone: "fortress" },
  "reported-unconfirmed": { label: "Reported (unconfirmed)", tone: "warn" },
  disputed: { label: "Disputed", tone: "danger" },
};

export default function Ops(): React.ReactElement {
  const app = useApp();
  const active = app.view === "ops";
  const status = useResource(() => api.status(), [], { pollMs: 10_000, active });
  const identity = useResource(() => api.identity(), [], { pollMs: 60_000, active });
  const version = useResource(() => api.version(), [], { pollMs: 300_000, active });
  const commands = useResource(() => api.commands(), [], { pollMs: 10_000, active });
  const migrations = useResource(() => api.migrations(), [], { pollMs: 10_000, active });

  const principal = app.auth.kind === "signed-in" ? app.auth.principal : null;
  const container = status.data?.serviceManager === "container";

  // Bad numbers are worse than a wait: every headline figure here is one

  // `?? 0` away from claiming this fortress holds nothing. Show the shell and

  // a loader until the answers have actually arrived.

  const gate = [status, identity, commands];
  if (active && gate.some(awaiting)) {
    return (
      <section className="view active">
        <ViewFallback resources={gate} />
      </section>
    );
  }


  return (
    <section className={active ? "view active" : "view"}>
      <div className="kicker">System</div>
      <h1>Operate the fortress</h1>
      <p className="lede">{opsLede(container)}</p>

      <Panel title="This install">
        <Loaded resource={identity}>
          {(data) => (
            <div className="facts wide">
              <FactRow
                k="Enrollment"
                v={data.boundOrgId ? "Enrolled" : "Not enrolled"}
                vs={
                  data.boundOrgId
                    ? `bound to ${data.boundOrgId} — one fortress, one organization`
                    : "run `hx-fortress enroll` with a token from your organization"
                }
                tone={data.boundOrgId ? "ok" : "warn"}
              />
              <FactRow
                k="Fortress id"
                v={<span className="mono">{data.fortressId ?? "—"}</span>}
                vs={
                  data.credentialWrittenAt
                    ? `credential written ${fmt.when(data.credentialWrittenAt)}`
                    : "no credential on this host"
                }
              />
              <FactRow
                k="Fortress root"
                v={<span className="mono">{data.root}</span>}
                vs={
                  data.rootMatch === "same"
                    ? "the daemon reads the same directory"
                    : data.rootMatch === "different"
                      ? `the daemon published ${data.daemonRoot ?? "another root"}`
                      : "the daemon has not published a root, so this cannot be compared"
                }
                tone={data.rootMatch === "different" ? "warn" : undefined}
              />
              <FactRow
                k="Service"
                v={status.data?.serviceManager ?? "—"}
                vs={
                  container
                    ? "your orchestrator starts, stops and updates this fortress"
                    : "the daemon runs under this host's service manager"
                }
              />
            </div>
          )}
        </Loaded>
      </Panel>

      <ServicePanel
        status={status.data}
        container={container}
        onChanged={() => {
          status.reload();
          commands.reload();
        }}
      />

      <CheckupPanel daemon={status.data?.daemon ?? null} onSubmitted={() => commands.reload()} />

      <RotationPanel daemon={status.data?.daemon ?? null} onSubmitted={() => commands.reload()} />

      <MigrationPanel
        daemon={status.data?.daemon ?? null}
        onSubmitted={() => {
          commands.reload();
          migrations.reload();
        }}
        runs={migrations}
      />

      <Panel title="Version">
        <Loaded resource={version}>
          {(remote) => (
            <div className="facts wide">
              <FactRow
                k="Running"
                v={<span className="mono">{status.data?.version ?? "—"}</span>}
                vs={
                  remote.kind === "available"
                    ? remote.version === status.data?.version
                      ? "which is the latest release"
                      : `latest release: ${remote.version}`
                    : `latest release: not checked — ${remote.reason}`
                }
                tone={
                  remote.kind === "available" && remote.version !== status.data?.version
                    ? "warn"
                    : undefined
                }
              />
              <FactRow
                k="Checked"
                v={fmt.ago(remote.checkedAt)}
                vs={remote.cached ? "from this console's cache" : "asked just now"}
              />
              <UpdateRow
                container={container}
                daemon={status.data?.daemon ?? null}
                available={
                  remote.kind === "available" && remote.version !== status.data?.version
                    ? remote.version
                    : null
                }
                onSubmitted={() => commands.reload()}
              />
            </div>
          )}
        </Loaded>
      </Panel>

      <Panel
        title="Commands"
        sub="Work the console asked the daemon to do, and whether the daemon's own record agrees that it did it."
        panelKey="commands"
        register={app.registerPanel}
      >
        <Loaded
          resource={commands}
          emptyWhen={(data) => data.commands.length === 0}
          empty={<Empty>Nothing has been asked of the daemon from this console.</Empty>}
        >
          {(data) => (
            <div className="rowlist ops">
              {data.commands.map((command) => (
                <CommandLine key={command.id} command={command} />
              ))}
            </div>
          )}
        </Loaded>
      </Panel>

      <Panel title="This sign-in" sub={OPS_SESSION_LINE}>
        <div className="facts wide">
          <FactRow
            k="Signed in as"
            v={principal?.login ?? "—"}
            vs={
              principal?.role === "operator"
                ? "operator — full read, and every control this console has"
                : "read-only — every view, no controls"
            }
          />
          <FactRow
            k="Since"
            v={fmt.when(principal?.createdAt ?? null)}
            vs={app.sessionBudgets ?? "held per browser tab — a second tab signs in again"}
          />
          {principal?.workbenchSub ? (
            <FactRow
              k="Arrived as"
              v={<span className="mono">{principal.workbenchSub}</span>}
              vs="the workbench identity recorded alongside what this session does"
            />
          ) : null}
          <FactRow
            k="End it"
            v="Sign out"
            vs="ends this tab's session on the fortress; other tabs and other people are untouched"
            action={
              <button className="btn ghost sm" onClick={() => void app.signOut()}>
                Sign out
              </button>
            }
          />
        </div>
      </Panel>

      <Panel title="Command line" sub={COMMAND_SURFACE_NOTE} panelKey="cli" register={app.registerPanel}>
        {helpEntries().map((entry) => (
          <div className="clirow" key={entry.usage}>
            <span className="c">{entry.usage}</span>
            <span className="d">{entry.summary}</span>
          </div>
        ))}
      </Panel>
    </section>
  );
}

function CommandLine({ command }: { command: CommandView }): React.ReactElement {
  const pill = CORROBORATION_PILL[command.corroboration.state] ?? {
    label: command.corroboration.state,
    tone: "warn",
  };
  const disputed = command.corroboration.state === "disputed";
  return (
    <div className="row" style={{ alignItems: "start" }}>
      <span className={disputed ? "dot bad" : command.status === "done" ? "dot" : "dot warn"}></span>
      <div className="who">
        <b>{command.kind}</b>
        <div className="sub">
          {command.status}
          {command.requestedBy ? ` · asked by ${command.requestedBy}` : ""}
          {command.outcome ? ` · ${command.outcome}` : ""}
          {command.error ? ` · ${command.error}` : ""}
        </div>
        {command.copy.length > 0 ? (
          <div className={disputed ? "why-note" : "sub"} style={{ marginTop: 8 }}>
            {command.copy.map((line, i) => (
              <p className="saidby" key={i}>
                {line}
              </p>
            ))}
          </div>
        ) : null}
      </div>
      <div>
        <span className={`pill pc ${pill.tone}`}>{pill.label}</span>
      </div>
      <div className="m">{fmt.ago(command.completedAt ?? command.requestedAt)}</div>
    </div>
  );
}

/**
 * The daemon's lifecycle, driven from the browser.
 *
 * Every action confirms, states what it does to THIS page as well as to the
 * fortress, and answers in place with the server's own sentence. A console that
 * stops the daemon keeps serving — that is the point of a separate process — and
 * the copy says so, because a page that went blank after Stop would read as a
 * crash.
 */
function ServicePanel(props: {
  status: StatusView | null;
  container: boolean;
  onChanged: () => void;
}): React.ReactElement {
  const [dialog, ask] = useConfirm();
  const [result, showResult] = useResultLine();
  const [busy, setBusy] = React.useState(false);
  const running = props.status?.pid !== null && props.status?.pid !== undefined;

  const drive = async (
    action: "start" | "stop" | "restart",
    confirm: { title: string; body: string; confirmLabel: string; danger?: boolean },
  ): Promise<void> => {
    if (!(await ask(confirm))) return;
    setBusy(true);
    try {
      const answer = await api.serviceAction(action);
      showResult(answer.copy);
    } catch (error) {
      showResult(
        error instanceof ApiError && error.status === NO_ANSWER
          ? "This console stopped answering. It is restarting; this page follows it."
          : error instanceof Error
            ? error.message
            : String(error),
        true,
      );
    } finally {
      setBusy(false);
      props.onChanged();
    }
  };

  return (
    <Panel
      title="Service"
      sub={
        props.container
          ? CONTAINER_SERVICE_REFUSAL
          : "Start, restart and stop the daemon. This console runs in its own process and keeps answering either way."
      }
    >
      {dialog}
      <div className="facts wide">
        <FactRow
          k="Daemon"
          v={props.status?.copy ?? "—"}
          vs={
            running
              ? `pid ${props.status?.pid}, under ${props.status?.serviceManager ?? "this host"}`
              : "nothing is running to answer for this fortress"
          }
          tone={running ? "ok" : "warn"}
          action={
            <span style={{ display: "inline-flex", gap: 8 }}>
              <MutationControl
                label="Start"
                small
                disabled={props.container || busy || running}
                {...(props.container ? { reason: CONTAINER_SERVICE_REFUSAL } : {})}
                onClick={() =>
                  void drive("start", {
                    title: "Start the fortress?",
                    body: "The daemon comes up under this host's service manager and begins accepting uploads again.",
                    confirmLabel: "Start",
                  })
                }
              />
              <MutationControl
                label="Restart"
                small
                disabled={props.container || busy || !running}
                {...(props.container ? { reason: CONTAINER_SERVICE_REFUSAL } : {})}
                onClick={() =>
                  void drive("restart", {
                    title: "Restart the fortress?",
                    body: "Uploads in flight fail and their senders retry. The unit is restarted exactly as installed — nothing about it is rewritten.",
                    confirmLabel: "Restart",
                  })
                }
              />
              <MutationControl
                label="Stop"
                small
                danger
                disabled={props.container || busy || !running}
                {...(props.container ? { reason: CONTAINER_SERVICE_REFUSAL } : {})}
                onClick={() =>
                  void drive("stop", {
                    title: "Stop the fortress?",
                    body: "Uploads stop being accepted and the tunnel closes until it is started again. This console keeps answering, and every panel that needs the daemon will say it is stopped.",
                    confirmLabel: "Stop the fortress",
                    danger: true,
                  })
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

/** Applying an update is host code execution, asked for from a browser. It is
 *  confirmed, it is recorded, and the daemon — not this page — reports what
 *  happened. */
function UpdateRow(props: {
  container: boolean;
  daemon: string | null;
  available: string | null;
  onSubmitted: () => void;
}): React.ReactElement {
  const [dialog, ask] = useConfirm();
  const [result, showResult] = useResultLine();
  const [busy, setBusy] = React.useState(false);
  const noPoller = props.daemon !== "running";
  const reason = props.container
    ? CONTAINER_SERVICE_REFUSAL
    : noPoller
      ? NO_POLLER_REFUSAL
      : props.available === null
        ? "there is no newer release to install"
        : undefined;

  return (
    <>
      {dialog}
      <FactRow
        k="Update"
        v={props.available ? `${props.available} available` : "up to date"}
        vs={COMMAND_REQUEST_NOTE}
        action={
          <MutationControl
            label="Install update"
            small
            disabled={busy || reason !== undefined}
            {...(reason ? { reason } : {})}
            onClick={() => {
              void (async () => {
                const ok = await ask({
                  title: `Install ${props.available ?? "the latest release"}?`,
                  body: "The daemon downloads the release, verifies it, replaces its own binary and restarts. Uploads in flight fail and their senders retry.",
                  confirmLabel: "Install and restart",
                  danger: true,
                });
                if (!ok) return;
                setBusy(true);
                try {
                  await api.submitCommand("update_apply");
                  showResult("Asked the daemon to install it. Its answer appears under Commands.");
                } catch (error) {
                  showResult(error instanceof Error ? error.message : String(error), true);
                } finally {
                  setBusy(false);
                  props.onSubmitted();
                }
              })();
            }}
          />
        }
      />
      <ResultLine state={result} />
    </>
  );
}

/** The composite health probe. Six checks, run where the handles are, reported
 *  with the evidence each one saw. */
function CheckupPanel(props: {
  daemon: string | null;
  onSubmitted: () => void;
}): React.ReactElement {
  const [dialog, ask] = useConfirm();
  const [result, showResult] = useResultLine();
  const [busy, setBusy] = React.useState(false);
  const reason = props.daemon !== "running" ? NO_POLLER_REFUSAL : undefined;

  return (
    <Panel
      title="Checkup"
      sub="Six probes, run by the daemon: its service, its own status file, Postgres, a real write to the bucket, the embedding endpoint, and the tunnel."
    >
      {dialog}
      <div className="facts wide">
        <FactRow
          k="Run it"
          v="Six probes"
          vs={`One of them WRITES a probe object to the bucket and deletes it. ${COMMAND_REQUEST_NOTE}`}
          action={
            <MutationControl
              label="Run checkup"
              small
              disabled={busy || reason !== undefined}
              {...(reason ? { reason } : {})}
              onClick={() => {
                void (async () => {
                  const ok = await ask({
                    title: "Run the checkup?",
                    body: "The daemon probes its own service, Postgres, the object store (a real write and delete), the embedding endpoint and the tunnel.",
                    confirmLabel: "Run it",
                  });
                  if (!ok) return;
                  setBusy(true);
                  try {
                    await api.submitCommand("run_checkup");
                    showResult("Asked the daemon to run it. Each probe's verdict appears under Commands.");
                  } catch (error) {
                    showResult(error instanceof Error ? error.message : String(error), true);
                  } finally {
                    setBusy(false);
                    props.onSubmitted();
                  }
                })();
              }}
            />
          }
        />
      </div>
      <ResultLine state={result} />
    </Panel>
  );
}

/** The three steps an operator drives a bucket move in, and what each one costs
 *  the people uploading to this fortress.
 *
 *  The keys are the DAEMON's phase names, checked against them rather than
 *  re-typed: a control whose key drifts mints a row the validator refuses, and
 *  the operator reads that as a broken fortress. */
const MIGRATION_STEPS = [
  {
    key: "arm",
    label: "Copy into the target",
    hint: "Copies every object and its sidecars, then narrows the difference. Nothing is paused and nothing is switched — uploads run at full speed throughout.",
    confirm: {
      title: "Copy this fortress into the target bucket?",
      body: "The daemon proves the target accepts a write, copies every session and reads each one back to check it. Ingest is untouched. At the end new staging signatures are cut short, so the swap afterwards is seconds rather than the whole signature lifetime.",
      confirmLabel: "Start copying",
    },
    needsTarget: true,
  },
  {
    key: "swap",
    label: "Cut over",
    hint: "Holds uploads, copies the last difference, points credentials.json at the target and rebinds the running store. Refused unless the write gate proves the pause is in force.",
    confirm: {
      title: "Point this fortress at the target bucket?",
      body: "Uploads are held for the length of the cut and their senders retry. The daemon waits for its own write gate to confirm the pause, replays deletes onto the target, then swaps credentials.json and rebinds. The source bucket is never deleted from — it is the way back.",
      confirmLabel: "Cut over",
      danger: true,
    },
    needsTarget: true,
  },
  {
    key: "resume",
    label: "Resume ingest",
    hint: "Releases the pause and returns staging signatures to their normal lifetime. The way out of a run that stopped halfway.",
    confirm: {
      title: "Resume ingest?",
      body: "Uploads are accepted again and staging signatures go back to their normal lifetime. Nothing about the buckets changes.",
      confirmLabel: "Resume",
    },
    needsTarget: false,
  },
] as const;

/** The controls and the daemon's phases are the same set, in both directions: a
 *  phase with no control is an engine nobody can reach, and a control with no
 *  phase mints a row the validator refuses and an operator reads as a broken
 *  fortress. Both sides are checked at BUILD time — neither is reachable from a
 *  test that does not open a browser. */
function assertNoDrift<T extends never>(): void {
  void 0 as T | undefined;
}
assertNoDrift<
  Exclude<(typeof MIGRATION_PHASES)[number], (typeof MIGRATION_STEPS)[number]["key"]>
>();
assertNoDrift<
  Exclude<(typeof MIGRATION_STEPS)[number]["key"], (typeof MIGRATION_PHASES)[number]>
>();

const MIGRATION_STATUS_TONE: Record<string, string> = {
  done: "ok",
  running: "fortress",
  aborted: "warn",
  switched_unverified: "danger",
  failed: "danger",
};

/** What a status means, where the word alone would not say it. */
const MIGRATION_STATUS_COPY: Record<string, string> = {
  switched_unverified:
    "this fortress is serving from the target, and objects the source holds were not readable there",
  aborted: "nothing was switched; the fortress still serves from the source bucket",
};

/**
 * Moving this fortress's objects to another bucket, from the browser.
 *
 * The target's credentials are typed here and never reach the command row: they
 * go to a 0600 single-use file the daemon unlinks as it reads, exactly like a
 * rotation. The row carries the bucket NAME so the run record can be audited,
 * and the daemon refuses when the name and the credential disagree.
 *
 * The cut is the daemon's to make. It holds the credentials file's lock and the
 * store handle; this page asks, and reports what it answered.
 */
function MigrationPanel(props: {
  daemon: string | null;
  runs: Resource<{ migrations: MigrationRunView[] }>;
  onSubmitted: () => void;
}): React.ReactElement {
  const [dialog, ask] = useConfirm();
  const [result, showResult] = useResultLine();
  const [step, setStep] = React.useState<(typeof MIGRATION_STEPS)[number]["key"]>("arm");
  const [material, setMaterial] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const chosen = MIGRATION_STEPS.find((s) => s.key === step) ?? MIGRATION_STEPS[0];
  const reason = props.daemon !== "running" ? NO_POLLER_REFUSAL : undefined;
  const missingTarget = chosen.needsTarget && material.trim().length === 0;

  const submit = async (): Promise<void> => {
    let credentials: { bucket?: unknown } = {};
    if (chosen.needsTarget) {
      try {
        credentials = JSON.parse(material) as { bucket?: unknown };
      } catch {
        showResult("that is not valid JSON — paste the target's storage block exactly as the wizard wrote it", true);
        return;
      }
      if (typeof credentials.bucket !== "string" || credentials.bucket.length === 0) {
        showResult("that storage block names no bucket, so the run record could not say where it went", true);
        return;
      }
    }
    if (!(await ask(chosen.confirm))) return;
    setBusy(true);
    try {
      if (chosen.needsTarget) {
        await api.submitCommandWithSecret("run_migration", credentials as Record<string, unknown>, {
          phase: chosen.key,
          target: credentials.bucket as string,
        });
        // Cleared immediately: this console keeps no credential, before or after.
        setMaterial("");
      } else {
        await api.submitCommand("run_migration", { phase: chosen.key });
      }
      showResult("Handed it to the daemon. Its answer appears under Commands, and the run below.");
    } catch (error) {
      showResult(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
      props.onSubmitted();
    }
  };

  return (
    <Panel
      title="Storage migration"
      sub="Move this fortress to another bucket. The copy runs while ingest does; only the cut holds uploads, and the source bucket is never deleted from."
    >
      {dialog}
      <div className="facts wide">
        <FactRow
          k="Step"
          v={
            <select
              className="rotatein"
              value={step}
              onChange={(e) => setStep(e.target.value as typeof step)}
            >
              {MIGRATION_STEPS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          }
          vs={chosen.hint}
        />
        {chosen.needsTarget ? (
          <FactRow
            k="Target bucket"
            v={
              <input
                className="rotatein"
                type="password"
                autoComplete="off"
                placeholder='{"store":"s3","bucket":"…","region":"…","s3":{"accessKeyId":"…","secretAccessKey":"…"}}'
                value={material}
                onChange={(e) => setMaterial(e.target.value)}
              />
            }
            vs={`The whole storage block for the NEW bucket, as JSON. It goes to a single-use file the daemon deletes as it reads. ${COMMAND_REQUEST_NOTE}`}
          />
        ) : null}
        <FactRow
          k="Run it"
          v={chosen.label}
          vs={COMMAND_REQUEST_NOTE}
          action={
            <MutationControl
              label={chosen.label}
              small
              danger={step === "swap"}
              disabled={busy || missingTarget || reason !== undefined}
              {...(reason ? { reason } : {})}
              onClick={() => void submit()}
            />
          }
        />
      </div>
      <ResultLine state={result} />
      {/* Through <Loaded>, like every other panel on this page. Read as
          `data?.migrations ?? []`, a failed fetch and a fortress that has never
          moved are the same empty array — so a stopped Postgres or a 500 made a
          COMPLIANCE surface assert that this fortress has never been moved
          between buckets, which is the exact claim an auditor came here to
          check. An unanswered question renders as the failure and a retry. */}
      <Loaded
        resource={props.runs}
        emptyWhen={(data) => data.migrations.length === 0}
        empty={<Empty>This fortress has not been moved between buckets.</Empty>}
      >
        {(data) => (
          <div className="rowlist ops">
            {data.migrations.map((run) => (
              <MigrationLine key={run.id} run={run} />
            ))}
          </div>
        )}
      </Loaded>
    </Panel>
  );
}

function MigrationLine({ run }: { run: MigrationRunView }): React.ReactElement {
  const tone = MIGRATION_STATUS_TONE[run.status] ?? "warn";
  return (
    <div className="row" style={{ alignItems: "start" }}>
      <span className={tone === "ok" ? "dot" : tone === "fortress" ? "dot warn" : "dot bad"}></span>
      <div className="who">
        <b>
          {run.sourceBucket} → {run.targetBucket}
        </b>
        <div className="sub">
          {run.phase} · {fmt.int(run.sessionsCopied)} of {fmt.int(run.sessionsTotal)}{" "}
          {fmt.plural(run.sessionsTotal, "session")} copied · {fmt.bytes(run.bytesCopied)} ·{" "}
          {fmt.int(run.deltaPasses)} {fmt.plural(run.deltaPasses, "delta pass", "delta passes")}
          {run.switchedAt ? ` · cut over ${fmt.when(run.switchedAt)}` : ""}
        </div>
        {MIGRATION_STATUS_COPY[run.status] ? (
          <div className="sub">{MIGRATION_STATUS_COPY[run.status]}</div>
        ) : null}
        {run.error ? <p className="saidby">{run.error}</p> : null}
      </div>
      <div>
        <span className={`pill pc ${tone}`}>{run.status.replace(/_/g, " ")}</span>
      </div>
      <div className="m">{fmt.ago(run.finishedAt ?? run.startedAt)}</div>
    </div>
  );
}

const ROTATION_TARGETS = [
  {
    key: "storage",
    label: "Storage credentials",
    hint: "The whole storage block, as JSON: store, bucket, region, and the inline key.",
    placeholder: '{"store":"s3","bucket":"…","region":"…","s3":{"accessKeyId":"…","secretAccessKey":"…"}}',
  },
  { key: "openai", label: "Embedding key", hint: "The API key the embed worker signs with.", placeholder: "" },
  {
    key: "cloud",
    label: "Cloud credential",
    hint: "The vlc_ value from the workbench. The tunnel reconnects with it.",
    placeholder: "vlc_…",
  },
] as const;

/**
 * Rotating a credential from the browser.
 *
 * What is typed here never reaches the command row: it is written to a 0600
 * single-use file the daemon unlinks as it reads. Nothing is echoed back, and
 * the field is cleared the moment it is handed over — the console holds no
 * credential, before or after.
 */
function RotationPanel(props: { daemon: string | null; onSubmitted: () => void }): React.ReactElement {
  const [dialog, ask] = useConfirm();
  const [result, showResult] = useResultLine();
  const [target, setTarget] = React.useState<(typeof ROTATION_TARGETS)[number]["key"]>("storage");
  const [material, setMaterial] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const chosen = ROTATION_TARGETS.find((t) => t.key === target) ?? ROTATION_TARGETS[0];
  const reason = props.daemon !== "running" ? NO_POLLER_REFUSAL : undefined;

  const rotate = async (): Promise<void> => {
    let secret: Record<string, unknown>;
    if (target === "storage") {
      try {
        secret = { target, credentials: JSON.parse(material) as unknown };
      } catch {
        showResult("that is not valid JSON — paste the storage block exactly as the wizard wrote it", true);
        return;
      }
    } else if (target === "openai") {
      secret = { target, apiKey: material.trim() };
    } else {
      secret = { target, credential: material.trim() };
    }
    const ok = await ask({
      title: `Rotate the ${chosen.label.toLowerCase()}?`,
      body: "The daemon proves the new credential works before it writes it, and rebinds the running store onto it. A credential that does not work is refused and nothing changes.",
      confirmLabel: "Rotate",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.submitCommandWithSecret("rotate_credentials", secret);
      // Cleared immediately: this console keeps nothing.
      setMaterial("");
      showResult("Handed it to the daemon. Its answer appears under Commands.");
    } catch (error) {
      showResult(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
      props.onSubmitted();
    }
  };

  return (
    <Panel
      title="Credentials"
      sub="The daemon owns these files and is the only writer. What you paste here goes to a single-use file it deletes as it reads; it never reaches the command row or the audit trail."
    >
      {dialog}
      <div className="facts wide">
        <FactRow
          k="What to rotate"
          v={
            <select
              className="rotatein"
              value={target}
              onChange={(e) => setTarget(e.target.value as typeof target)}
            >
              {ROTATION_TARGETS.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          }
          vs={chosen.hint}
        />
        <FactRow
          k="New value"
          v={
            <input
              className="rotatein"
              type="password"
              autoComplete="off"
              placeholder={chosen.placeholder}
              value={material}
              onChange={(e) => setMaterial(e.target.value)}
            />
          }
          vs={COMMAND_REQUEST_NOTE}
          action={
            <MutationControl
              label="Rotate"
              small
              danger
              disabled={busy || material.trim().length === 0 || reason !== undefined}
              {...(reason ? { reason } : {})}
              onClick={() => void rotate()}
            />
          }
        />
      </div>
      <ResultLine state={result} />
    </Panel>
  );
}
