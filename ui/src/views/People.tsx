import React from "react";

import { api, type AdoptionView, type DeviceRow, type RosterPersonRow } from "../api";
import { Empty, FactRow, Loaded, Panel, SearchBox, Stat, ViewFallback, awaiting } from "../components";
import { ROSTER_ABSENT_COPY, ROSTER_EMPTY_COPY } from "../copy";
import { DISCLOSURE_PEOPLE_NOTE, DISCLOSURE_ROSTER_NOTE } from "../disclosure";
import * as fmt from "../format";
import { useResource } from "../hooks";
import { useApp } from "../state";

// Adoption: who this organization employs, what the hub says they have, and what
// actually reached this host.
//
// The two halves are never blended. Every funnel stage carries the ONE source it
// was computed from and whether that source is cloud-attested or
// fortress-observed, because a number an operator cannot trace to one of the two
// is a number they cannot check against either.
//
// The page also refuses two comfortable readings. A fortress that has never
// received a roster does not render an empty company — it says the roster never
// arrived and declines to compute coverage at all, because a denominator taken
// from the people who already appear here would always read 100%. And somebody
// sending to this fortress whom the roster does not name is a separate bucket,
// never an adoption gap: they may be a service account, a member added since the
// last sync, or somebody whose membership ended while their sessions stayed.

const ALL_TEAMS = "";

export function People(): React.ReactElement {
  const app = useApp();
  const active = app.view === "people";
  const adoption = useResource(() => api.adoption(), [], { pollMs: 60_000, active });
  const devices = useResource(() => api.devices(), [], { pollMs: 60_000, active });

  const [team, setTeam] = React.useState<string>(ALL_TEAMS);
  const [search, setSearch] = React.useState("");

  const data = adoption.data;
  const deviceRows = devices.data?.devices ?? [];
  const neverSeen = deviceRows.filter((d) => d.lastSeenAt === null).length;
  const roster = data?.roster ?? [];
  const shown = filterRoster(roster, team, search);

  // Bad numbers are worse than a wait: every headline figure here is one

  // `?? 0` away from claiming this fortress holds nothing. Show the shell and

  // a loader until the answers have actually arrived.

  const gate = [adoption, devices];
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
      <h1>Adoption</h1>
      <p className="lede">
        Who this organization employs, which of their machines have worked here, and what has
        actually reached this fortress.
      </p>

      <div className="stats">
        <Stat
          label="On the roster"
          value={fmt.int(data ? data.counts.rostered : null)}
          sub={data?.sync ? `as of ${fmt.ago(data.sync.asOf)}` : "no roster received"}
        />
        <Stat
          label="Sending here"
          value={fmt.int(data ? data.counts.sending : null)}
          sub="members with at least one session on this host"
        />
        <Stat
          label="Unclaimed"
          value={fmt.int(data ? data.counts.unrostered : null)}
          sub="sending here, not named by the roster"
        />
        <Stat
          label="Former members"
          value={fmt.int(data ? data.counts.formerMembers : null)}
          sub="retained, and outside every figure above"
        />
      </div>

      <Panel
        title="From the roster to this fortress"
        sub={
          data?.sync
            ? `let.ai computed this roster ${fmt.ago(data.sync.asOf)}; it reached this host ${fmt.ago(
                data.sync.receivedAt,
              )}.`
            : undefined
        }
      >
        <Loaded resource={adoption}>
          {(view) =>
            view.sync === null ? (
              <Empty>{ROSTER_ABSENT_COPY}</Empty>
            ) : view.counts.rostered === 0 ? (
              <Empty>{ROSTER_EMPTY_COPY}</Empty>
            ) : (
              <>
                <div className="funnel">
                  {view.stages.map((stage) => (
                    <div className="fstage" key={stage.id} title={stage.detail}>
                      <div className="fnum">{fmt.int(stage.count)}</div>
                      <div className="fk">{stage.label}</div>
                      <div className="fdrop">
                        {stage.share === null ? "" : `${Math.round(stage.share * 100)}%`}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="facts" style={{ marginTop: 18 }}>
                  {view.stages.map((stage) => (
                    <FactRow
                      key={stage.id}
                      k={stage.label}
                      v={
                        <span
                          className={
                            stage.attestation === "fortress-observed" ? "pill fortress" : "pill cloud"
                          }
                        >
                          {stage.attestation}
                        </span>
                      }
                      vs={`${stage.detail} · from ${stage.source}`}
                    />
                  ))}
                </div>
              </>
            )
          }
        </Loaded>
      </Panel>

      {data && data.attention.length > 0 ? (
        <Panel
          title="Worth a look"
          sub="Active members only — somebody who has left the organization is not an adoption problem."
        >
          <div className="rowlist ops">
            {data.attention.map((row) => (
              <div
                className="row linkrow"
                key={`${row.kind}/${row.externalId}`}
                onClick={() => open(app, row.externalId)}
              >
                <span className="dot warn"></span>
                <div className="who">
                  <b>{row.displayName}</b>
                  <div className="sub">{row.detail}</div>
                </div>
                <div className="m"></div>
                <div className="m"></div>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      <Panel title="People" sub={DISCLOSURE_ROSTER_NOTE}>
        {data && data.teams.length > 0 ? (
          <div className="toolbar">
            <span
              className={team === ALL_TEAMS ? "pill fortress" : "pill off"}
              style={{ cursor: "pointer" }}
              onClick={() => setTeam(ALL_TEAMS)}
            >
              Everyone
            </span>
            {data.teams.map((t) => (
              <span
                key={t.name}
                className={team === t.name ? "pill fortress" : "pill off"}
                style={{ cursor: "pointer" }}
                onClick={() => setTeam(t.name)}
                title={`${fmt.plural(t.members, "member")}, ${t.sending} sending here`}
              >
                {t.name}
              </span>
            ))}
          </div>
        ) : null}
        <SearchBox
          placeholder="Search people and teams"
          value={search}
          onInput={setSearch}
          compact
          style={{ marginBottom: 16 }}
        />
        <Loaded
          resource={adoption}
          emptyWhen={(view) => view.roster.length === 0}
          empty={<Empty>No roster has landed on this fortress yet.</Empty>}
        >
          {() =>
            shown.length === 0 ? (
              <Empty>Nobody on the roster matches that.</Empty>
            ) : (
              <div className="rowlist ops">
                {shown.map((person) => (
                  <RosterLine key={person.externalId} person={person} onOpen={() => open(app, person.externalId)} />
                ))}
              </div>
            )
          }
        </Loaded>
      </Panel>

      <Panel
        title="Unclaimed senders"
        sub="Sending to this fortress, and not on the roster. Counted apart rather than as a gap: the reason varies, and this host cannot tell which applies."
      >
        <Loaded
          resource={adoption}
          emptyWhen={(view) => view.unrostered.length === 0}
          empty={<Empty>Everyone sending to this fortress is on the roster.</Empty>}
        >
          {(view) => (
            <div className="rowlist ops">
              {view.unrostered.map((row) => (
                <div
                  className="row linkrow"
                  key={row.userExternalId}
                  onClick={() => open(app, row.userExternalId)}
                >
                  <span className="dot warn"></span>
                  <div className="who">
                    <b>{row.displayName ?? row.userExternalId}</b>
                    <div className="sub mono">{row.userExternalId}</div>
                  </div>
                  <div className="m">{fmt.plural(row.sessions, "session")}</div>
                  <div className="m">{fmt.ago(row.lastActivityAt)}</div>
                </div>
              ))}
            </div>
          )}
        </Loaded>
      </Panel>

      <Panel
        title="Devices"
        sub="Device metadata reported by the hx client — names, platforms and liveness. Nothing on the device itself is readable from here."
      >
        <div className="stats" style={{ marginBottom: 18 }}>
          <Stat label="Devices" value={fmt.int(devices.data ? deviceRows.length : null)} sub="registered against these people" />
          <Stat
            label="Never seen"
            value={fmt.int(devices.data ? neverSeen : null)}
            sub="registered but never observed since"
          />
        </div>
        <Loaded
          resource={devices}
          emptyWhen={(d) => d.devices.length === 0}
          empty={<Empty>No device has registered with this fortress.</Empty>}
        >
          {(d) => (
            <div className="rowlist ops">
              {d.devices.map((device) => (
                <DeviceLine key={`${device.userExternalId}/${device.deviceId}`} device={device} />
              ))}
            </div>
          )}
        </Loaded>
      </Panel>
    </section>
  );
}

function open(app: ReturnType<typeof useApp>, personId: string): void {
  app.navigate({ view: "person-detail", personId });
  window.scrollTo(0, 0);
}

/** Name, id and team all match, so one box answers "who is Raj" and "who is on
 *  Payments" — the roster is the only thing that knows the second. */
function filterRoster(rows: readonly RosterPersonRow[], team: string, search: string): RosterPersonRow[] {
  const needle = search.trim().toLowerCase();
  return rows.filter((row) => {
    if (team !== ALL_TEAMS && !row.teams.includes(team)) return false;
    if (needle === "") return true;
    return (
      row.displayName.toLowerCase().includes(needle) ||
      row.externalId.toLowerCase().includes(needle) ||
      row.teams.some((t) => t.toLowerCase().includes(needle))
    );
  });
}

function RosterLine({
  person,
  onOpen,
}: {
  person: RosterPersonRow;
  onOpen: () => void;
}): React.ReactElement {
  return (
    <div className={person.active ? "row linkrow" : "row linkrow dimf"} onClick={onOpen}>
      {/* No "installed but silent" state: `installed` counts machines that have
          produced a session attributed to THIS organization, so it cannot be
          above zero while `sessions` is zero. The middle dot this used to render
          was unreachable the moment the roster was scoped to one tenant. */}
      <span className={person.sessions > 0 ? "dot" : "dot offd"}></span>
      <div className="who">
        <b>{person.displayName}</b>
        <div className="sub">
          {person.active ? null : <span className="pill off">departed</span>}
          {person.teams.length > 0 ? ` ${person.teams.join(" · ")}` : " no team"}
        </div>
      </div>
      <div className="m">{fmt.plural(person.sessions, "session")}</div>
      {/* Last UPLOAD, never last seen: a client heartbeats whether or not it is
          sending anything, so last-seen stays fresh on an install that stopped. */}
      <div className="m">{fmt.ago(person.lastUploadAt)}</div>
    </div>
  );
}

function DeviceLine({ device }: { device: DeviceRow }): React.ReactElement {
  // A device that has never reported is a different fact from one reporting
  // zero, so the two are never collapsed: nulls stay dashes.
  const backlog =
    device.syncTotal === null || device.syncDone === null
      ? null
      : Math.max(0, device.syncTotal - device.syncDone);
  return (
    <div className="row">
      <span className={device.lastSeenAt ? "dot" : "dot offd"}></span>
      <div className="who">
        <b>{device.name ?? device.deviceId}</b>
        <div className="sub">
          {device.userExternalId}
          {device.os ? ` · ${device.os}` : ""}
          {device.arch ? ` ${device.arch}` : ""}
        </div>
      </div>
      <div className="m">
        {backlog === null ? "—" : backlog === 0 ? "in sync" : `${fmt.int(backlog)} queued`}
      </div>
      <div className="m">{fmt.ago(device.lastSeenAt)}</div>
    </div>
  );
}

export function PersonDetail(): React.ReactElement {
  const app = useApp();
  const active = app.view === "person-detail";
  const personId = app.route.personId ?? "";
  const on = active && personId !== "";

  const adoption = useResource(() => api.adoption(), [], { active: on });
  const people = useResource(() => api.people(), [], { active: on });
  const devices = useResource(() => api.devices(), [], { active: on });
  const sessions = useResource(
    () => api.sessions({ limit: "10", userExternalId: personId }),
    [personId],
    { active: on },
  );

  const member = adoption.data?.roster.find((r) => r.externalId === personId) ?? null;
  const person = people.data?.people.find((p) => p.userExternalId === personId) ?? null;
  const mine = devices.data?.devices.filter((d) => d.userExternalId === personId) ?? [];
  const known = member !== null || person !== null;

  return (
    <section className={active ? "view active" : "view"}>
      <div className="kicker">
        <a
          href="/people"
          onClick={(e) => {
            e.preventDefault();
            app.goto("people");
          }}
        >
          ← Adoption
        </a>
      </div>
      <h1>{member?.displayName ?? person?.displayName ?? personId}</h1>
      <p className="lede">{lede(member, person, adoption.loading || people.loading)}</p>

      {known ? (
        <>
          <div className="grid2">
            <Panel title="On the roster">
              {member === null ? (
                <Empty>
                  The roster let.ai sent does not name this person. Everything below is what this
                  fortress observed for itself.
                </Empty>
              ) : (
                <div className="facts">
                  <FactRow k="External id" v={<span className="mono">{member.externalId}</span>} />
                  <FactRow k="Email" v={member.email ?? "not reported"} />
                  <FactRow k="Teams" v={member.teams.length > 0 ? member.teams.join(", ") : "no team"} />
                  <FactRow
                    k="Membership"
                    v={member.active ? "active" : "departed"}
                    vs={
                      member.active
                        ? "present in the most recent roster let.ai sent"
                        : `absent since this fortress noticed on ${fmt.when(member.inactiveSince)}`
                    }
                    tone={member.active ? "ok" : "warn"}
                  />
                  <FactRow
                    k="Machines here"
                    v={fmt.int(member.installed)}
                    vs="machines of theirs that have produced a session for this organization"
                  />
                  <FactRow
                    k="Last upload"
                    v={fmt.when(member.lastUploadAt)}
                    vs={
                      member.lastUploadAt === null
                        ? "no machine of theirs has uploaded anything"
                        : fmt.ago(member.lastUploadAt)
                    }
                  />
                  <FactRow
                    k="Backfill"
                    v={backfill(member)}
                    vs={
                      member.syncReportedAt === null
                        ? "no machine of theirs has reported progress"
                        : `reported ${fmt.ago(member.syncReportedAt)}`
                    }
                  />
                </div>
              )}
            </Panel>

            <Panel title="Footprint on this fortress">
              <div className="facts">
                <FactRow k="Sessions" v={fmt.int(member?.sessions ?? person?.sessions ?? 0)} />
                <FactRow k="Uploaded" v={fmt.bytes(member?.bytes ?? person?.bytes ?? 0)} />
                <FactRow
                  k="Last activity"
                  v={fmt.when(member?.lastActivityAt ?? person?.lastActivityAt ?? null)}
                  vs={fmt.ago(member?.lastActivityAt ?? person?.lastActivityAt ?? null)}
                />
                {mine.length === 0 ? (
                  <FactRow k="Devices" v="none registered here" />
                ) : (
                  mine.map((device) => (
                    <FactRow
                      key={device.deviceId}
                      k={device.name ?? device.deviceId}
                      v={device.os ? `${device.os} ${device.arch ?? ""}`.trim() : "platform not reported"}
                      vs={`last seen ${fmt.ago(device.lastSeenAt)}`}
                    />
                  ))
                )}
              </div>
            </Panel>
          </div>

          <Panel title="Recent sessions here" sub={DISCLOSURE_PEOPLE_NOTE}>
            <Loaded
              resource={sessions}
              emptyWhen={(data) => data.rows.length === 0}
              empty={<Empty>Nothing of theirs is on this fortress.</Empty>}
            >
              {(data) => (
                <div className="rowlist ops">
                  {data.rows.map((row) => (
                    <div
                      className="row linkrow"
                      key={row.id}
                      onClick={() => {
                        app.navigate({ view: "session-detail", family: row.family, sid: row.sessionId });
                        window.scrollTo(0, 0);
                      }}
                    >
                      <span className="dot"></span>
                      <div className="who">
                        <b>{row.title ?? "untitled"}</b>
                        <div className="sub">
                          {row.family}
                          {row.repoSlug ? ` · ${row.repoSlug}` : ""}
                        </div>
                      </div>
                      <div className="m">{fmt.bytes(row.bytesUploaded)}</div>
                      <div className="m">{fmt.ago(row.lastActivityAt)}</div>
                    </div>
                  ))}
                </div>
              )}
            </Loaded>
          </Panel>
        </>
      ) : null}
    </section>
  );
}

function backfill(member: RosterPersonRow): string {
  if (member.syncTotal === null || member.syncDone === null) return "not reported";
  const outstanding = Math.max(0, member.syncTotal - member.syncDone);
  return outstanding === 0 ? "complete" : `${fmt.int(outstanding)} still to upload`;
}

/** The three states a person page can be in, said apart: on the roster and
 *  sending, on the roster and silent, and sending while unknown to the roster. */
function lede(
  member: RosterPersonRow | null,
  person: { sessions: number; bytes: number | string } | null,
  loading: boolean,
): string {
  if (member === null && person === null) {
    return loading ? "Reading the fortress…" : "Nobody with that id is on the roster or has sent a session here.";
  }
  const sessions = member?.sessions ?? person?.sessions ?? 0;
  const bytes = member?.bytes ?? person?.bytes ?? 0;
  if (sessions === 0) {
    return member === null
      ? "Nothing of theirs is on this fortress."
      : "On the roster, with nothing on this fortress yet.";
  }
  return `${fmt.plural(sessions, "session")} on this fortress · ${fmt.bytes(bytes)}`;
}
