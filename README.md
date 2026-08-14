# hx-fortress

HX Fortress is the on-customer-infrastructure host for let.ai components. It
runs as a long-lived Bun process, owns the connection to let.ai cloud, and
loads component modules such as `session_vault`.

This repository currently contains the vendored Fortress/cloud protocol
boundary, the host runtime with its stable on-disk configuration and status
contracts, and the lifecycle CLI for running Fortress as a persistent per-user
launchd or systemd service. Structured logs, module loading, and cloud
transport are implemented. Release artifacts bundle the core `session_vault`
module, and both the self-update command and the install-from-source and
prebuilt installers are shipped. The same binary serves the administration
console described under
[The administration console](#the-administration-console).

## Install

The distribution installer is served from the customer's let.ai
Workbench origin:

```sh
curl -fsSL https://<workbench-origin>/install/hx-fortress.sh | sh
```

## Install from sources

If you'd rather build the binary yourself instead of downloading a prebuilt
one, clone this repo and run the from-source installer. It reaches the same
running, enrolled Fortress as the `curl … | sh` path above — it just compiles
the binary locally with [Bun](https://bun.sh) first (installed automatically
if missing).

Both parameters are optional: the `--cloud` URL defaults to production
(`wss://let.ai/_api/hx-gateway/vault-tunnel`), and if you omit the enrollment
token the wizard walks you through acquiring one (via browser or paste) once
the build finishes.

```sh
git clone https://github.com/hx-framework/hx-fortress && cd hx-fortress
./install-from-source.sh
```

The script installs dependencies, builds `hx-fortress`, installs it to
`~/.let/bin/hx-fortress` (ad-hoc code-signed on macOS), and hands off to the
interactive enroll wizard. Once credentials are verified, the wizard asks
"Start hx-fortress now?" — accept to have it register as a service and start
immediately, or decline and run `hx-fortress start` yourself later. Bun users
can equivalently run `bun run install:enroll`. Pass a token and/or `--cloud
<url>` explicitly if you already have them: `./install-from-source.sh <token>
--cloud <cloud-url>`.

## Commands

`hx-fortress` with no arguments opens the terminal dashboard, and
`hx-fortress help` prints the whole surface. The groups are:

```text
fortress         enroll · start · stop · status · logs · update · credentials set
console          ui · ui enable · ui disable · ui config · ui marker
console users    ui user create · list · disable · delete · reset
console sso      ui sso on · ui sso off
residency audit  audit witness show|on|off · audit acks reconcile
roster           roster purge-inactive
```

`hx-fortress host` runs the daemon in the foreground and is what the OS service
manager invokes. `hx-fortress container-run` is the container entrypoint that
supervises the daemon and the console together. Neither is meant to be typed by
hand.

## The administration console

A fortress is an appliance for one organization: one host, one bucket, one
database, one roster of people. The console is the window onto that appliance —
a browser surface for whoever runs it, so that "is ingest healthy", "who in the
organization is actually covered" and "does this host hold what it is supposed
to hold" are questions with answers rather than questions that need a shell.
Administrators reach it from their own machines; the fortress stays where the
organization put it.

The console is a **separate process from the daemon**. The daemon owns the cloud
tunnel, the ingest gateway, Postgres and the object store; the console owns a
listener, a set of local accounts and its own audit spool. That separation is
what lets the console render a stopped daemon and offer to start it, and it is
why the two are enabled, configured and supervised independently.

### Reaching it

**One click from the workbench.** In let.ai, an organization owner opens
Clarity → Settings → Storage and uses *Open fortress console*. The button
appears once this fortress has advertised a console URL, which needs all three
of `hx-fortress ui sso on`, an https public URL, and the console enabled. The
advertisement is recomputed on every reconnect, so `ui sso off` clears it on the
next one — and does not unsend what has already been sent. The button is
owner-only; operators and auditors who are not owners receive the console URL
from the administrator who created their account, alongside their setup link.
The URL is organization infrastructure rather than a secret, and on its own it
conveys nothing.

**SSH and `hx-fortress ui`.** The cloud-independent path, and the one to use
when let.ai is unreachable. Forward the port and run the console in the
foreground:

```sh
ssh -L 8788:127.0.0.1:8788 <fortress-host>
hx-fortress ui
```

Then open `http://127.0.0.1:8788`. The console prints the URL to reach it on,
along with the disclosure of what a console login grants.

Neither path is an entry in itself. A workbench arrival lands on the console's
sign-in form: the grant it carries names the workbench identity for the audit
trail and mints no session, no token and no read. Every session belongs to a
fortress-local account.

### Accounts

Accounts are created from the terminal, and only from the terminal:

```sh
hx-fortress ui user create alice --role operator
hx-fortress ui user create audit-bot --role readonly
hx-fortress ui user list
hx-fortress ui user disable alice
hx-fortress ui user reset alice
hx-fortress ui user delete alice
```

There are two roles and the difference between them is exactly one thing:
`readonly` reaches every read surface, `operator` additionally reaches the two
write routes. `readonly` is the auditor and monitoring persona — it sees the
same numbers, and a control it may not use is disabled carrying the server's own
refusal.

**No password is ever typed at a terminal.** `user create` and `user reset`
print a one-time setup link instead, and the person opens it and sets their own
password in the browser. The token rides the URL *fragment*, so it never reaches
a request line, an access log or a `Referer`; it lasts 24 hours, dies once the
password is set, and completion requires a POST so a link preview cannot consume
it. `user reset` leaves the current password working until the new link is
completed — a reset that locked someone out the moment it was issued would
strand them if the link never arrived.

Sessions live in the serving process's memory: 12 hours absolute and 60 minutes
idle by default, both configurable, and a console restart ends every one of
them. `user disable` and `user delete` end that account's live sessions on their
next request.

### The surfaces, and where their numbers come from

| Surface | Path | What it answers | Where the figures come from |
| --- | --- | --- | --- |
| Overview | `/` | is this fortress healthy right now | the daemon's `status.json` and `metrics.json` heartbeat files; session and byte totals from Postgres; the bucket the storage credential names |
| Sessions | `/sessions` | what has arrived, from whom, and when | Postgres metadata only, never transcript text; *Verify* additionally stats the object in the bucket |
| Adoption | `/people` | who in the organization is covered | the roster let.ai sent, and this host's own session rows — kept apart, never blended |
| Residency | `/residency` | does this host hold what it is supposed to | an audit the daemon runs; routing posture from the cached answer to let.ai |
| Posture & Audit | `/compliance` | where data enters and leaves, and who did what | data paths computed from the effective configuration; the admin trail from Postgres, falling back to the on-disk spool |
| Postgres | `/postgres` | is the database up, and how large | the daemon's status file, and Postgres itself |
| Object storage | `/storage` | which bucket this fortress writes to, and every storage migration it has run | the bucket the storage credential names, and migration runs from Postgres. The console builds no store handle of its own, so versioning and lifecycle report as unreadable rather than guessed |
| Embeddings | `/embeddings` | how much is embedded, under which model | Postgres row counts; the vector column is never selected |
| Ops Tools | `/ops` | do something, and see what came of it | the command queue in Postgres, corroborated against the audit spool; the release origin for the version check |
| Logs | `/logs` | what the daemon is saying | a live tail of the daemon's structured log file |

**An absent number is never rendered as a zero.** A figure the console could not
obtain renders as an em dash with the reason beside it — "the daemon has
published no metrics", "Postgres is not accepting connections", "unavailable —
the fortress key cannot read bucket configuration". A panel whose refresh failed
keeps the last figures it had and says they are no longer current, rather than
replacing them with nothing.

**Staleness has thresholds, and the console states them.** The daemon writes a
heartbeat every 5 seconds; a status file older than 15 seconds reads as *not
responding*. A control that needs a live daemon refuses **before** it queues
anything — a row nobody polls for would sit until its deadline and then be
rejected, which reads as the work failing rather than the ask. A cached answer
from let.ai older than 15 minutes is labelled stale rather than presented as
current, and a residency roll-up that could not reach let.ai is never called
clean.

Sessions belonging to another organization are counted so the totals reconcile
against the bucket, and their metadata is not shown.

### Adoption, and what a coverage figure means

Adoption is a funnel of five stages, and every stage carries the source it was
computed from — because the hub knows who the organization employs and what they
have installed, and only this host knows what actually arrived here. A stage
with two sources would be a figure nobody could reconcile against either.

| Stage | Counts | Attested by |
| --- | --- | --- |
| On the roster | active members let.ai reports for this organization | let.ai |
| Client installed | members with at least one active install, counted by machine | let.ai |
| Backfill reported complete | members whose most recent backfill report has nothing outstanding | let.ai |
| Sending to this fortress | members with at least one session on this host | this fortress |
| Active in the last 30 days | members with session activity here inside the window | this fortress |

The denominator is **active members only**. People who have left are counted
separately and never divided into: a coverage figure that keeps counting
departed employees falls forever, and one that deletes them loses the fact that
their sessions are still here. People sending to this fortress whom the roster
does not know at all are their own labelled bucket, never folded into the
percentage.

"Quiet" is derived from the last **upload**, never the last heartbeat. A client
heartbeats whether or not it is sending anything, so last-seen stays fresh on an
install that has silently stopped — which is exactly the install worth finding.
An install that has not uploaded for 14 days is listed for attention, as are
members with no install reported, installs that have never uploaded, and
backfills still outstanding.

`hx-fortress roster purge-inactive [--days <n>]` removes directory rows for
members who left more than the retention ago. It removes directory rows only;
their sessions on this fortress are untouched.

### The residency audit

The audit answers one question per session: is the transcript where this
organization decided it should be? It reads every session row, stats the object
in this fortress's bucket, and — for sessions that reached this host *through*
let.ai — asks let.ai whether it still holds a copy.

It runs when an operator asks for one, from Residency or the command plane.
There is no timer: a run walks every session and stats objects in the bucket,
and doing that on a schedule nobody was reading would spend the storage budget
on an answer no one asked for.

| Verdict | What it means | Acknowledgeable |
| --- | --- | --- |
| `confirmed` | held here, and let.ai reports no copy | — |
| `also_at_letai` | held here, and a historical let.ai copy exists | yes |
| `not_delivered_here` | let.ai recorded this fortress as a destination and the object never arrived | **no** |
| `no_record` | uploaded before let.ai recorded per-destination delivery | — |
| `unknown_provenance` | the row predates channel tracking, or was recovered after an index outage | — |
| `not_applicable` | uploaded straight to this fortress; the id was never sent to let.ai | — |

`not_delivered_here` is the incident: something that should be on this fortress
is not. It is never downgraded by an acknowledgement — an acknowledgement
explains why a copy exists somewhere, and no answer to that makes a missing
object present. `also_at_letai` is separate and weaker: the object *is* here, and
bytes at let.ai either predate this fortress or belong to a session also
attributed to a let.ai-hosted organization. Per session it fails the check until
acknowledged; in the fleet roll-up an acknowledged one qualifies the verdict
rather than failing it.

**Only a cloud-relayed session is ever named to let.ai.** A session uploaded
straight to this fortress was never known to let.ai by id, so there is nothing to
ask about, and one whose channel is unrecorded is not assumed to be either. The
witness is controlled locally:

```sh
hx-fortress audit witness show
hx-fortress audit witness off
```

With it off, no session id leaves this host and every eligible session says so by
name — never "no copy was found", because nothing was asked. A run that could not
reach let.ai says that instead, as a different fact.

`hx-fortress audit acks reconcile` lists acknowledgements that have no matching
record in this host's own audit trail; `--re-confirm` writes them again through
the fenced routine so they land in it.

### Asking the daemon to do something

The console does not perform privileged work itself. Anything that needs the
daemon's credentials, its engines or its database authority is a **request**: a
row in the command queue that the daemon claims, performs and records. Eight
kinds exist — apply an update, rotate a credential, run a storage migration, run
a checkup, run a self-test, run the residency audit, toggle the cloud witness,
acknowledge a finding.

Service control is the exception. Start, stop and restart run in the console
process, because the thing being controlled is the daemon and a stopped daemon
polls for nothing.

The console renders **the daemon's own record**, not the fact that a request was
accepted. A terminal outcome that no daemon-written record corroborates renders
as *Reported (unconfirmed)*; one a record contradicts renders as *Disputed*,
names which way the disagreement runs, links the trail entry and gives the
remediation. Neither is ever rendered as success.

### Moving the fortress to another bucket

A storage migration is driven from Object storage, in three gestures:

| Gesture | What it does |
| --- | --- |
| `arm` | copy everything, then keep copying the delta; shorten the lifetime of new upload signatures |
| `swap` | prove the fortress is quiet, cut onto the new bucket, verify |
| `resume` | clear the pause left by a swap that was abandoned |

Arm first, and leave it armed as long as you like — ingest keeps running
throughout and nothing is held. Repeated delta passes narrow what has changed
since the bulk copy, so the work remaining when you cut approaches zero.

The target bucket's credentials accompany **each** gesture that touches it — arm
and swap alike. They travel to a single-use `0600` file and never into the
command row, and the daemon reads and unlinks them in one step, so a reference is
spent once and the next gesture mints its own. Credentials naming a different
bucket than the request asked for are refused: a run whose record disagrees with
what it actually wrote is a record nobody can audit.

Swap when ready. It first drains outstanding presigned uploads — a presigned PUT
lands in the bucket directly, invisible to this process, so a pause cannot stop
one and a counter cannot see it — then waits for quiet, re-checks the pause
deadline immediately before the cut, swaps, and verifies. The pause is armed for
at most 5 minutes and the barrier waits at most 2. A swap that cannot prove quiet
resumes without cutting rather than cutting anyway.

**The source bucket is never deleted.** Not at the end, not on success, not as
cleanup. The old bucket *is* the rollback: if the new one turns out wrong, point
the fortress back at it. Emptying it is a separate, deliberate act you take by
hand once you are satisfied — and the run record names every object that was
copied, with a checksum computed from what was read back out of the *target*
rather than from what was sent.

Object storage renders each run: the bucket pair, sessions and bytes copied,
delta passes, when the cut happened, and how it ended. A run that stopped short
is continued rather than restarted, so what an arm already proved is what a swap
gets to skip.

Storage configured by environment (`FORTRESS_STORAGE_BUCKET`) is refused before
any copy begins. On a container the bucket belongs to the deployment, and a
migration that moved it would be undone by the next redeploy.

### Configuring the console

Settings live in `$FORTRESS_ROOT/ui/ui.json` — mode `0600`, in a `0700`
directory, beside the account store and the audit spool. The `hx-fortress ui`
verbs are its only writers — no browser path writes it, under any spelling.
`hx-fortress ui config` prints the stored settings, the fortress root they belong
to, which address the sign-in limits are actually keyed on, and, where the
environment is what turned the console on, says so.

| Variable | Purpose |
| --- | --- |
| `FORTRESS_UI_ENABLE` | `1` or `true` turns the console on. It can only turn it **on**: it is OR-ed with the stored setting, and `hx-fortress ui disable` refuses while it is set rather than writing a `false` the environment would override. |
| `FORTRESS_UI_PORT` | Console port. Default `8788`. |
| `FORTRESS_UI_BIND` | Listen address. Default `127.0.0.1`. |
| `FORTRESS_UI_PUBLIC_URL` | The https origin the console is reached on when something terminates TLS in front of it. A bare origin — no path, query, fragment or userinfo. |
| `FORTRESS_UI_CONTAINER_BIND` | `1` permits the dual-stack bind anywhere, with the residual printed. The override for a container the detector did not recognize; equivalent to `--allow-insecure-bind`. |
| `FORTRESS_UI_BOOTSTRAP_USER` | Login for the first console account, created on the first boot of a fresh volume with its setup link printed to the container log. An existing login is left alone — issue a fresh link with `hx-fortress ui user reset <login>`. |
| `FORTRESS_CONTAINER` | `0` disables container detection entirely, as `--no-container` does on the command line. |

For `port`, `bind` and `publicUrl` the environment wins over `ui.json`, and
`--port` and `--bind` win over the environment in turn. `--url` changes only the
URL the console prints — not where it binds, not the `Host` allowlist and not
what is advertised to let.ai. `FORTRESS_UI_ENABLE` is the exception to all of
it: it is OR-ed, never authoritative in both directions.

| `ui.json` key | Default | Written by |
| --- | --- | --- |
| `enabled` | `false` | `ui enable` / `ui disable`, and `ui --install-service` |
| `port` | `8788` | `ui config set port` |
| `bind` | `127.0.0.1` | `ui config set bind` |
| `publicUrl` | unset | `ui config set publicUrl` |
| `trustedProxies` | none | `ui config set trustedProxies <csv>` |
| `sso` | `false` | `ui sso on` / `ui sso off` |
| `sessionTtlHours` | `12` | `ui config set sessionTtlHours` |
| `sessionIdleMinutes` | `60` | `ui config set sessionIdleMinutes` |
| `databaseUrl` | unset | `ui config set databaseUrl --stdin` |
| `allowInsecureBind` | `false` | `ui --install-service --allow-insecure-bind` |
| `marker` | unset | `ui marker "<phrase>"` / `ui marker --clear` |

`databaseUrl` is read from stdin and refuses a positional argument by name: a
DSN carries a password, and argv is visible in `/proc/<pid>/cmdline`, in `ps`
and in shell history.

```sh
printf %s "$DSN" | hx-fortress ui config set databaseUrl --stdin
```

`trustedProxies` decides whether `X-Forwarded-For` is honoured at all. With none
configured the header is ignored and every sign-in limit is keyed on the socket
peer — which, behind any platform edge, is one address for everybody.

### Where the console runs

**Host installs** get a user service:

```sh
hx-fortress ui --install-service      # systemd --user, or launchd on macOS
hx-fortress ui --uninstall-service    # removes the unit, keeps the settings
```

The installer refuses when this shell's fortress root differs from the daemon's:
a console on a different root reads a different database, a different audit spool
and a different set of accounts.

On Linux a `systemd --user` unit stops when your last login session ends. The
installer detects that and says so; it does not fix it for you:

```sh
sudo loginctl enable-linger <user>
```

**lxc and nspawn containers are host installs.** They run `systemd --user`, keep
the terminal dashboard and keep full service control, so they take the rungs
above. What they do not have is Docker's published-port indirection — a wildcard
bind inside one is a real LAN bind — so widening the bind there takes the
explicit gesture.

**Docker-class containers** — Docker, Podman, Kubernetes, Railway — have no unit
to install and nothing for `systemctl` to mean. Set `FORTRESS_UI_ENABLE=1` and
redeploy; that is the entire gesture, and a redeploy without it is how you turn
the console off again. Service control is hidden there, with its reason: the
orchestrator owns starting, stopping and updating this fortress.

**The bind rule.** Outside a container a non-loopback bind is refused unless an
https `FORTRESS_UI_PUBLIC_URL` is set or `--allow-insecure-bind` is passed, and
the residual is printed either way. Inside a detected docker-class container with
`FORTRESS_UI_ENABLE` the console binds dual-stack, so the documented
`-p 127.0.0.1:8788:8788` publish works with no extra gesture. Everywhere else —
lxc, nspawn, or a runtime the detector did not recognize — widening takes
`FORTRESS_UI_CONTAINER_BIND=1` or `--allow-insecure-bind`.

**Behind a reverse proxy**, terminate TLS in front of the console and tell it
the origin it is reached on:

```nginx
server {
  listen 443 ssl;
  server_name fortress.example.com;

  location / {
    proxy_pass http://127.0.0.1:8788;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

```sh
hx-fortress ui config set publicUrl https://fortress.example.com
hx-fortress ui config set trustedProxies 127.0.0.1
hx-fortress ui sso on
```

`publicUrl` must be https and a bare origin; `hx-fortress ui sso on` refuses
without one rather than warning. The console sends
`Strict-Transport-Security` on responses that actually arrived over that
configured https host — asserting it on a plain-http console would pin a browser
to a scheme that console cannot serve.

Keep the proxy's `Host` header intact. Every request is checked against an
allowlist rebuilt from a live read of `ui.json` — literal loopback on any port,
and the configured public host on its own port — and a name nobody configured is
refused, which is what closes DNS rebinding.

## Cloud-service run mode

`hx-fortress host` also runs headless as a let.ai cloud service — no TUI, no
interactive enroll wizard. A container started with only environment variables
and an empty mounted volume enrolls into the hub on first boot and serves the
gateway. The Dockerfile sets `FORTRESS_ROOT=/data`, `HOME=/data` and `ENTRYPOINT
["hx-fortress", "container-run"]`; mount a volume at `/data` so `config.json`,
`credentials.json`, and the signing key persist across restarts (restarts
re-`hello` with the saved credential instead of re-enrolling). See
[Containers, Railway and Kubernetes](#containers-railway-and-kubernetes) for the
console's own variables and for what host networking changes.

### Environment contract

| Variable | Required | Purpose |
| --- | --- | --- |
| `FORTRESS_ROOT` | yes (Docker) | Directory for persisted state. The image sets `/data`. |
| `FORTRESS_PUBLIC_URL` | yes | Public URL of the ingest gateway; also enables the gateway. |
| `FORTRESS_GATEWAY_PORT` | no | Gateway listen port (default `8787`). |
| `FORTRESS_ENROLL_TOKEN` | first boot | One-time enrollment token from the let.ai hub. |
| `FORTRESS_CLOUD_URL` | first boot | WebSocket URL of the hub. Production is `wss://let.ai/_api/hx-gateway/vault-tunnel`; the self-update origin is derived from it by replacing the trailing `/vault-tunnel`. |
| `FORTRESS_STORAGE_BUCKET` | yes | Bucket that holds session transcripts. |
| `FORTRESS_STORAGE_KIND` | no | `gcs` (default) or `s3`. |
| `FORTRESS_STORAGE_REGION` | no | Bucket location / region. |
| `FORTRESS_GCS_PROJECT_ID` | gcs | GCP project id. |
| `FORTRESS_GCS_SA_KEY` | no (gcs) | Service-account key JSON, raw or base64-encoded. Omit to use application default credentials. |
| `FORTRESS_S3_ACCESS_KEY_ID` | no (s3) | S3 access key id. Omit to use the AWS default credential chain. |
| `FORTRESS_S3_SECRET_ACCESS_KEY` | no (s3) | S3 secret access key. |
| `FORTRESS_S3_SESSION_TOKEN` | no (s3) | S3 session token. |
| `FORTRESS_S3_ENDPOINT` | no (s3) | S3-compatible endpoint (MinIO, R2, …). |
| `FORTRESS_S3_FORCE_PATH_STYLE` | no (s3) | `true` for path-style addressing. |
| `FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT` | no (s3) | Allow a plaintext / private-range `FORTRESS_S3_ENDPOINT` (e.g. MinIO on an internal network); off ⇒ https + public-range required (SSRF guard). |
| `FORTRESS_S3_ENDPOINT_ALLOWLIST` | no (s3) | Comma-separated host allowlist for `FORTRESS_S3_ENDPOINT`; when set, only these hosts are permitted. |
| `FORTRESS_DATABASE_URL` | no | Connect to an external Postgres instead of the embedded one. When set, the bundled Postgres is not downloaded or supervised. |
| `FORTRESS_PG_VERSION` | no | Embedded Postgres version to acquire (default pinned in code). |
| `FORTRESS_PG_BINARIES_URL` | no | Base URL for Postgres binary archives (default Maven Central); point at a mirror for air-gapped installs. |
| `FORTRESS_PG_DATA` | no | Data directory for the embedded cluster (default `$FORTRESS_ROOT/pgdata`). |
| `FORTRESS_PG_PORT` | no | Loopback port for the embedded server (default `54329`). Bound to `127.0.0.1` only. |
| `FORTRESS_PG_REQUIRE_PINNED` | no | Refuse a Postgres binary with no baked-in pinned SHA-256 (strict supply-chain mode). |
| `FORTRESS_PG_ALLOW_UNPINNED` | no | Escape hatch that re-permits the network `.sha256` fallback even under require-pinned. |
| `FORTRESS_STORE_OP_TIMEOUT_MS` | no | Per-call deadline for ordinary storage calls (default `20000`). Values above the cloud tunnel's 30s only help direct-gateway callers. |
| `FORTRESS_STORE_HEAVY_TIMEOUT_MS` | no | Deadline for heavy storage calls — whole-canonical read/write, chunk compose (default `120000`). |
| `FORTRESS_STORE_SCAN_TIMEOUT_MS` | no | Deadline for whole-bucket scans — reconciler discovery, large session lists (default `600000`). |
| `FORTRESS_STORE_PROBE_INTERVAL_MS` | no | Write-path self-test cadence (default `60000`; `0` disables). A hung probe counts toward the storage-client rebuild. |
| `FORTRESS_STORE_EXIT_ON_WEDGE` | no | `on`/`off`: force or forbid exiting for a supervisor restart when rebuilds prove futile. **Spans BOTH self-heal layers** — the storage client and the hx-db pools. Default: auto-detect systemd/launchd/Railway; never exits from a terminal, never exits if the layer has not succeeded since boot. |
| `FORTRESS_DB_CONNECT_TIMEOUT_MS` | no | Pool connect bound (default `10000`; `0` ⇒ default — never disableable). |
| `FORTRESS_DB_STATEMENT_TIMEOUT_MS` | no | Server-side `statement_timeout` startup parameter on every fortress pool (default `120000`). **`0` OMITS the parameter entirely on every consumer — the pooled-DSN escape hatch** (see upgrade note below). |
| `FORTRESS_DB_MAX_LIFETIME_MS` | no | Hard connection rotation (default `3600000` — one hour; `0` ⇒ default — rotation is the last-resort poisoned-pool healer behind the 60 s probe's rebuild path, and a guarantor restore of a very large session must fit one connection lifetime). Kills a still-running statement at rotation (the txn rolls back atomically); purges are exempt (own client). |
| `FORTRESS_DB_ACQUIRE_TIMEOUT_MS` | no | How long a query may wait in the pool's CHECKOUT QUEUE before it is rejected (default `10000`; `0` ⇒ default — an unbounded queue is never correct). This is Bun's `idleTimeout`, which is **not** an idle-connection reaper: it bounds waiting *for* a connection. Keep it below `FORTRESS_DB_RPC_DEADLINE_MS` (25 s) so a starved pool sheds load while the caller is still listening. |
| `FORTRESS_DB_LOCK_TIMEOUT_MS` | no | `lock_timeout` startup parameter on the LIVE INGEST pool only (default `5000`; `0` omits it, so lock waits fall back to `statement_timeout`). A lock wait counts against `statement_timeout`, so without this a live chunk queued behind a long same-session restore holds a connection for the whole statement budget doing nothing. Rides the `FORTRESS_DB_STATEMENT_TIMEOUT_MS=0` pooler hatch. |
| `FORTRESS_DB_POOL_MAX` | no | Connection ceiling for the live rw/ro pools (default `10`). |
| `FORTRESS_DB_BG_POOL_MAX` | no | Connection ceiling for the background guarantor/reconciler pool (default `2`). Separate from the live pools by design: whole-transcript restores must never be able to spend the write path's budget. |
| `FORTRESS_DB_PROBE_INTERVAL_MS` | no | hx-db liveness probe cadence (default `60000`; `0` disables — mirrors the store probe, **and disables pool-saturation detection with it**). 3 consecutive breaches rebuild the pools; 2 futile rebuilds escalate per `FORTRESS_STORE_EXIT_ON_WEDGE`. Sustained pool saturation also rebuilds, independently of the probe verdict. |
| `FORTRESS_DB_MIGRATION_TIMEOUT_MS` | no | Per-statement bound inside every migration batch (default `300000`; validated integer). **Each single migration must fit this budget** — per-migration journaling converges incrementally across attempts, one too-slow migration never does; raise it for backfill-class migrations. |
| `FORTRESS_GUARANTOR_MAX_ORPHANS_PER_PASS` | no | Sessions repaired per sweep (default `100`). **`0` now means the default, not unbounded** — a full rebuild costs 40-115 s of IO against a GIN-indexed turns table, and an unbounded pass after a large backlog unfreezes is a self-inflicted incident. Raise it to drain faster on a quiet database. |
| `FORTRESS_GUARANTOR_REPAIR_STALE` | no | Repair sessions whose index is behind their canonical (default on). `false` leaves detection (`staleIndexes`, `deepMismatched`) and stops stale-index repair **and** count-sweep repair. It does NOT stop orphan restores (a canonical with no indexed row is still restored) or the title corrective pass — it is not a global write brake. |
| `FORTRESS_GUARANTOR_DEEP_VERIFY_PER_PASS` | no | Sessions and lanes the count sweep checks per pass (default 100; `0` disables and logs a warning). The sweep is the only detector for records lost from the MIDDLE of a canonical, where the lane stays seq-dense and byte-covering so the byte gate never selects it. It costs **one canonical read per row**, and it rotates continuously rather than stopping after one pass — budget for that egress on a large corpus, or lower it. |
| `FORTRESS_DB_BG_ACQUIRE_TIMEOUT_MS` | no | Checkout bound for the background repair pool (default 300 000). Far longer than the live bound on purpose: a repair has no caller waiting, so failing its checkout does not shed load, it discards work that then repeats every pass. |
| `FORTRESS_DB_BG_STATEMENT_TIMEOUT_MS` | no | Statement bound for background repair (default 600 000). Sized to let a large single-transaction rebuild finish. Clamped under `FORTRESS_DB_MAX_LIFETIME_MS`, and a **lowered** `FORTRESS_DB_STATEMENT_TIMEOUT_MS` still wins — an operator bounding a shared Postgres must not find background repair exempt. |
| `FORTRESS_GUARANTOR_INTERVAL_MS` | no | Reconcile sweep interval (default `3600000`; `0` ⇒ default — use `FORTRESS_GUARANTOR_DISABLED` to turn the guarantor off). |

**Upgrade note — pooler-fronted `FORTRESS_DATABASE_URL` (PgBouncer-class):**
v0.17.0 sends a `statement_timeout` startup parameter on its pools. Poolers
that reject unknown startup parameters (`unsupported startup parameter`) will
refuse those connections — the fortress still boots and migrates (its
provider/migration clients are parameter-free), then logs a one-shot ERROR
naming the remedy: set `FORTRESS_DB_STATEMENT_TIMEOUT_MS=0` to omit the
parameter everywhere. Note the `=0` semantics deliberately differ per knob
(statement-timeout `0` = omit; max-lifetime/guarantor `0` = default;
probe-interval `0` = disable) — each row above states its own.

**Upgrade note — pool saturation (v0.18.0, fixing a v0.17.0 regression):**
v0.17.0 set Bun's `idleTimeout` to 60 s believing it reaped idle connections.
It does not: Bun documents it as *"maximum time in seconds to wait for
connection to become available"* — the pool CHECKOUT-QUEUE bound, defaulting to
0 (wait forever). The practical effect was that a busy pool queued every query
for a full minute and then failed it with
`ERR_POSTGRES_IDLE_TIMEOUT: Idle timeout reached after 1m`, which the classifier
in turn treated as a connection kill and retried immediately — adding load to a
pool already proven to have none to spare.

Three things kept that self-sustaining once it started. A lock wait counts
against `statement_timeout`, so a live chunk queued behind a long same-session
guarantor restore held one of ten connections for the full 120 s doing nothing.
The vault RPC abandons at 25 s but never cancels, so the abandoned transaction
kept its connection for the remaining ~95 s while the cloud enqueued a durable
replay that queued behind it. And the healer could not see any of it: its probe
is a standalone one-connection canary, so it answered instantly throughout and
`/healthz` and `/readyz` stayed green for ~13 hours.

v0.18.0 addresses each: the acquire bound is 10 s (under the 25 s RPC deadline,
so a starved pool sheds while the caller is still listening);
`ERR_POSTGRES_IDLE_TIMEOUT` is classified as capacity, never retried in-process;
the live ingest pool sets `lock_timeout` (default 5 s) so a blocked chunk is
cheap to retry instead of hoarding a connection; the guarantor runs on its own
2-connection pool and can no longer spend the write path's budget; and sustained
saturation now feeds the same breach accounting the probe uses, so the pools are
rebuilt — which force-closes the retired pool and releases exactly those held
connections — and `/readyz` reports `"saturated": true` while it lasts.

Restarting does NOT fix a pool in this state: the backlog survives the restart
and the ratchet re-engages within about two minutes. Upgrade instead.

Buckets enrolled before v0.16.0 predate the probe-prefix lifecycle rules new
enrolls provision automatically; add them once so the minutely write-probe's
noncurrent versions expire (scoped to `.session-vault/` — customer data is
untouched). **Both commands REPLACE the bucket's entire lifecycle
configuration** — if your bucket already carries lifecycle rules (transitions,
expiries), merge these into your existing set instead of pasting verbatim.
GCS — `gcloud storage buckets update gs://<bucket> --lifecycle-file=<json with
the .session-vault/ noncurrent-delete + age-7 rules>`; S3 — `aws s3api
put-bucket-lifecycle-configuration --bucket <bucket> --lifecycle-configuration
'{"Rules":[{"ID":"hx-session-vault-probe","Status":"Enabled","Filter":{"Prefix":".session-vault/"},"NoncurrentVersionExpiration":{"NoncurrentDays":1},"Expiration":{"ExpiredObjectDeleteMarker":true}},{"ID":"hx-session-vault-probe-strays","Status":"Enabled","Filter":{"Prefix":".session-vault/"},"Expiration":{"Days":7}}]}'`.

`FORTRESS_ENROLL_TOKEN` + `FORTRESS_CLOUD_URL` are consumed only on the first
boot of a fresh volume; once a credential is saved they are ignored. Storage
credentials are re-applied from the environment on every boot, so rotating a key
is a redeploy.

### Configuration (embed / semantic)

The semantic layer — the `hx_semantic_search` tool and its `pgvector` index — is
driven by an in-fortress embed worker. It is **off until
`FORTRESS_OPENAI_API_KEY` is set**; with no key the worker never runs and
`hx_semantic_search` degrades to keyword search. The OpenAI account **must have
billing/credits** — otherwise embedding fails with `insufficient_quota` and the
tool likewise degrades to keyword. Resolved in `resolveEmbedConfig`
(`src/host/config.ts`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `FORTRESS_OPENAI_API_KEY` | — (gates the feature) | OpenAI key for the embed worker. Absent ⇒ worker off, semantic degrades to keyword. |
| `FORTRESS_OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI endpoint base; override for a zero-retention / DPA endpoint. |
| `FORTRESS_EMBED_MODEL` | `text-embedding-3-large` | Embedding model. |
| `FORTRESS_EMBED_DIMENSIONS` | `1024` | Output dimensions (Matryoshka); must match the `vector`/`halfvec` column width. |
| `FORTRESS_EMBED_DB_MAX` | `4` | The worker's own `Bun.SQL` pool cap (the shared `createHxDb` handle is uncapped). |
| `FORTRESS_EMBED_CONCURRENCY` | `2` | In-process embed concurrency limit. |
| `FORTRESS_EMBED_BATCH` | `96` | Turns per OpenAI embed request. |
| `FORTRESS_EMBED_MAX_PER_PASS` | `500` | Maximum turns embedded per worker pass. |
| `FORTRESS_EMBED_DEBOUNCE_MS` | `5000` | Debounce (ms) after a commit before an embed pass fires. |
| `FORTRESS_EMBED_MAX_WAIT_MS` | `1800000` | Max-wait cap (ms; 30 min) — embed any turn that has waited at least this long regardless of later chunks. |
| `FORTRESS_EMBED_DAILY_TOKEN_BUDGET` | `5000000` | Daily OpenAI embed-token ceiling, keyed on the UTC day; `0` ⇒ unlimited. New embeds pause for the day once crossed. |
| `FORTRESS_MAX_QUERY_TEXT_CHARS` | `8000` | Max `hx_semantic_search` query length before it is trimmed (scrub + egress DoS guard). |

The vector column and its index require a pgvector-enabled Postgres; point the
fortress at one via `FORTRESS_DATABASE_URL` (the bundled embedded Postgres is
vanilla and ships no `vector` extension). When the extension is absent the embed
indexes are skipped and `hx_semantic_search` degrades to keyword.

**MCP data plane.** The `hx_*` tools are served over MCP on the gateway's `/mcp`
route, which is **off by default**. Set `FORTRESS_PUBLIC_URL` to enable the
gateway and advertise the public address an MCP client connects to; without it
the fortress advertises no public URL and the MCP data plane is unavailable.

### Security & hardening

Boolean knobs read the truthy spellings `1` / `true` / `yes` / `on`
(case-insensitive); everything else is off. These default to the conservative
setting — flip them deliberately.

| Variable | Default | Purpose |
| --- | --- | --- |
| `FORTRESS_GRANT_ENFORCE` | off | REQUIRE a capability grant on the HTTP gateway + `/mcp` (verify-if-present when off). Coordinated-rollout lever — flip together with the workbench's `HX_FORTRESS_SEND_GRANTS`. |
| `FORTRESS_TUNNEL_GRANT_ENFORCE` | off | The reverse-tunnel equivalent (vault RPC + tunnel MCP). Same coordinated-rollout lever as `HX_FORTRESS_SEND_GRANTS`. |
| `FORTRESS_ALLOW_REENROLL` | off | Permit a pending enrollment whose cloud origin differs from the enrolled one (otherwise a hijack-drop re-enroll is ignored). |
| `FORTRESS_MAX_FRAME_BYTES` | `33554432` | Drop a cloud tunnel frame larger than this (bytes) before parsing — pre-auth DoS guard (32 MiB). |
| `FORTRESS_MAX_CANONICAL_BYTES` | `67108864` | Reject a whole-object session read above this size (bytes) — OOM guard (64 MiB). |
| `FORTRESS_SIGNING_KEY` / `FORTRESS_SIGNING_KEYID` | — (CI only) | base64url private Ed25519 JWK + its keyid used by `scripts/sign-artifact.ts` to sign release artifacts; the keyid must match a baked trust anchor. |

### Embedded Postgres

Fortress runs a local Postgres (database `hx-db`, schema `hx`) with no Docker, no
root, and no prompts. On first boot it downloads a pinned Postgres build, runs
`initdb` into `$FORTRESS_ROOT/pgdata`, and starts the server bound to `127.0.0.1`
(loopback only) on `FORTRESS_PG_PORT`. Set `FORTRESS_DATABASE_URL` to use an
external Postgres instead. Readiness (`/readyz` and `hx-fortress status`) reflects
Postgres availability; a failed or unreachable database holds readiness down with
a specific reason.

### Containers, Railway and Kubernetes

The image's entrypoint is `hx-fortress container-run`, not `hx-fortress host`.
The console is a separate process from the daemon — a stopped daemon cannot
serve its own Start button — and an image has one entrypoint, so `container-run`
starts both. It **refuses to run anywhere it is not pid 1**: pid 1 is what
receives the runtime's `SIGTERM`, and a daemon killed by the grace timeout never
writes its last status, never drains its audit spool and never stops its
Postgres cleanly. `hx-fortress host` remains the way to run only the daemon.
The two processes are supervised differently, and the difference is deliberate.
**If the daemon exits, the supervisor stops the console and exits with the
daemon's own exit code.** A container whose daemon has died is not doing its job,
and an orchestrator told so can restart it, back it off, or roll the deployment
back; one that sees the container still running learns nothing, and a crash loop
hidden inside a healthy-looking container is the failure nobody is paged for.
There is a second reason it cannot simply respawn: the daemon daemonizes its own
postmaster, which is re-parented to pid 1 when the daemon dies, so a replacement
daemon in the same container would find a cluster already running and be unable
to start one. Set a restart policy on the container instead — compose
`restart:`, a Kubernetes `restartPolicy` — the same one
`FORTRESS_STORE_EXIT_ON_WEDGE` already assumes.

**Only the console is respawned**, on a doubling backoff from one second to
thirty (reset once it has stayed up), and only while it is still enabled. The supervisor re-reads that setting as it runs, so
`hx-fortress ui disable` stops the console within seconds and leaves it stopped
— without touching the daemon or the ingest it is serving.

`SIGTERM` and `SIGINT` are forwarded to both, console first and daemon last,
because the console reads the daemon's status and its database.

Set `FORTRESS_UI_ENABLE=1` to turn the console on here, and redeploy to turn it
off again — `hx-fortress ui disable` refuses while the variable is set, because
writing `enabled: false` would change nothing. That variable and the rest of the
console's environment are documented in full under
[Configuring the console](#configuring-the-console).

`HOME=/data` in the image, beside `FORTRESS_ROOT=/data`, because
`credentials.json` lives under `$HOME/.let/session-vault/`. An image whose HOME
was elsewhere kept the organization's bucket keys in the container's writable
layer, and `VOLUME ["/data"]` does not cover that layer, so a plain image
upgrade discards them. Both processes check the older locations once at boot and
adopt what they find, so upgrading does not lose an enrollment — but only where
a volume actually covers the old path.

**Publish the console to the host's loopback**, and reach it over an SSH
forward or put an ingress in front of it:

```sh
docker run -p 127.0.0.1:8787:8787 -p 127.0.0.1:8788:8788 -v hx-data:/data …
```

Inside a Docker-class container (Docker, Podman, Kubernetes, Railway) the
console binds the dual-stack wildcard once `FORTRESS_UI_ENABLE` is set. That is
safe **because the publish is the boundary**: the container's network namespace
is reached only through the port you published, the Service you declared or the
domain Railway attached.

**`--network host` (Docker) and `hostNetwork: true` (Kubernetes) remove that
boundary.** There is no namespace and no publish indirection, so the same
wildcard bind is a real LAN bind — the console is reachable from anything that
can route to the node, with the operator's password as the only barrier. Nothing
inside the container can detect either setting, so the console cannot warn you
specifically: if you use them, set `FORTRESS_UI_BIND=127.0.0.1` and reach the
console over an SSH forward, or put a TLS-terminating ingress in front and set
`FORTRESS_UI_PUBLIC_URL`.

### Health checks

- `GET /healthz` — liveness; `200 {"ok":true}` as soon as the gateway listens.
- `GET /readyz` — readiness; `200 {"ok":true,"ready":true}` once the vault store
  is live and Postgres is accepting connections, otherwise `503`. Point the
  platform's traffic gate here.

## Development

Install Bun, then run:

```sh
bun install
bun test
bun run typecheck
bun run lint
```

Use `bun run check` to run all repository checks in the same order as CI.

Cutting a release — and the order the three repositories have to ship in —
is [RELEASING.md](RELEASING.md).
