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

Every module is compiled into the binary, and is switched on or off from this
host. What let.ai can ask of a module, and how a release for one is approved, is
described under [Modules, asks and releases](#modules-asks-and-releases).

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
                 modules list|on|off · releases list|approve|refuse
console          ui · ui enable · ui disable · ui config · ui marker
console users    ui user create · list · disable · delete · reset
console sso      ui sso on · ui sso off
console oidc     ui oidc · ui oidc set · ui oidc on · ui oidc off · ui oidc revoke
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

### Sign in with your identity provider

A console can also sign people in through the organization's own OpenID Connect
provider: Microsoft Entra ID, or any provider that publishes a standard
discovery document. It is off by default, and it is switched on from the
terminal of this host. The provider is yours. let.ai takes no part in this
sign-in, cannot switch it on and cannot change its settings.

```sh
hx-fortress ui oidc set issuer https://login.microsoftonline.com/<tenant-id>/v2.0
hx-fortress ui oidc set clientId <application-id>
hx-fortress ui oidc set clientSecretName oidc-client-secret
hx-fortress ui oidc set operatorGroups <group>,<group>
hx-fortress ui oidc set readonlyGroups <group>
hx-fortress ui oidc on
```

`hx-fortress ui oidc` prints the settings and the redirect URI to register at
the provider, which is `<console origin>/oidc/callback`. The console builds
that URI from the address a person opens it at. With a public URL set, that is
the public URL. Without one it is `http://localhost:<port>`, and the provider
must be given exactly the address people use.

| Setting | Meaning |
| --- | --- |
| `issuer` | The provider's issuer, exactly as its discovery document states it. It must be https, or http on this host itself. |
| `clientId` | The application (client) id registered at the provider. |
| `clientSecretName` | The **name** of the secret that holds the client secret, read through [Secrets by name](#secrets-by-name). `none` for a public client. The secret itself is never written to the settings file and never typed at this command. |
| `operatorGroups` | Comma-separated, so a group written here cannot hold a comma: use the group's id. A person in any of them gets what a local `operator` account gets. |
| `readonlyGroups` | Comma-separated. A person in any of them, and in no operator group, gets what a `readonly` account gets. |
| `groupsClaim` | The ID token claim that lists the person's groups. Default `groups`. |
| `loginClaim` | The claim shown as the person's login. Default: `email`, then `preferred_username`. See "How a person is named" below. |
| `scopes` | Default `openid profile email`. |
| `label` | What the sign-in button calls the provider. |

How it behaves:

- A person in no mapped group is refused. Being known to the provider is not a
  reason to see this console.
- A group is matched character for character. Microsoft Entra ID puts object ids
  in the `groups` claim, so the ids are what you write here.
- An address the provider marks as not verified is never matched as a group,
  whichever claim carries it. This matters when `groupsClaim` names a claim
  that holds the person's address.
- The flow is the authorization code flow with PKCE. The ID token's signature,
  issuer, audience, expiry and nonce are checked on this host. The token is
  never sent to the browser.
- Local accounts keep working. They are the way in when the provider cannot be
  reached.
- A session issued this way lasts as long as any console session. Changing a
  setting, `ui oidc off`, `ui oidc revoke` and `ui disable` each end every such
  session at its next request. Removing a person from a group at the provider
  takes effect at their next sign-in. Run `hx-fortress ui oidc revoke` to make
  it take effect now.
- Every sign-in is recorded in the audit trail, with the provider's own id for
  the person. Refused sign-ins are counted there by their reason. A refusal
  that comes after the token was verified, such as "in no mapped group", also
  names the person by that id. A refusal before that point has nobody to name.
  A start that failed because the provider did not answer is written to the
  console's log and not to the audit trail.

How a person is named:

- The login is the address in the ID token: the `email` claim, then
  `preferred_username`. It is shown lower-cased.
- An address the provider marks as not verified (`email_verified` present and
  not true) is not used, whichever claim carries it.
- An address is used only when it is plain printable ASCII and at most 128
  characters long. Anything else is not shown as a login.
- A person with no usable address is named `sub:` followed by the provider's
  own id for them. Set `loginClaim` to `sub` to name everybody that way.
- The provider's id must be printable ASCII of at most 124 characters. A token
  whose id is longer is refused.

The settings live in `$FORTRESS_ROOT/ui/oidc.json`, mode `0600`. The
`hx-fortress ui oidc` verbs are its only writers. If that file is damaged, the
sign-in is off until it is fixed or removed, and the console's log says so.

**Microsoft Entra ID.** Register an application. Add
`<console origin>/oidc/callback` as a **Web** redirect URI. Create a client
secret and store it where the fortress reads secrets. Add the `groups` claim to
the ID token (Token configuration, Add groups claim). Entra leaves the claim out
for a person in more than 200 groups: choose "Groups assigned to the
application", or define application roles and set `groupsClaim` to `roles`.

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
| `also_at_control_plane` | held here, and a historical let.ai copy exists | yes |
| `not_delivered_here` | let.ai recorded this fortress as a destination and the object never arrived | **no** |
| `no_record` | uploaded before let.ai recorded per-destination delivery | — |
| `unknown_provenance` | the row predates channel tracking, or was recovered after an index outage | — |
| `not_applicable` | uploaded straight to this fortress; the id was never sent to let.ai | — |

`not_delivered_here` is the incident: something that should be on this fortress
is not. It is never downgraded by an acknowledgement — an acknowledgement
explains why a copy exists somewhere, and no answer to that makes a missing
object present. `also_at_control_plane` is separate and weaker: the object *is* here, and
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
| `FORTRESS_UI_BOOTSTRAP_USER` | Login for the first console account, created on the first boot of a fresh volume. Its setup link is left in `<root>/ui/bootstrap-setup-link.txt` (0600) and is not printed: the container log names the file. An existing login is left alone — issue a fresh link with `hx-fortress ui user reset <login>`. |
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

## Modules, asks and releases

A module is a part of the Fortress that does one job for the organization. Today
that is keeping AI sessions, and answering let.ai about the Fortress itself.
Every module is compiled into the `hx-fortress` binary. The Fortress never
downloads module code from let.ai and runs it.

This section calls let.ai "the relay", because it reaches the Fortress only over
the connection the Fortress opened. The relay can do two things to a module, and
no more:

- **Send it an ask.** An ask is one question from a short list that the module
  declares. The Fortress checks every ask before the module hears it.
- **Offer it a release.** A release is a signed file for a module to apply. An
  offer changes nothing. A person on this host approves it or refuses it.

Which modules are on, and which releases are approved, is decided on this host.
Nothing the relay sends can switch a module or approve a release.

### The modules in this build

| Module | Name | What it does | On a new install |
| --- | --- | --- | --- |
| `session_vault` | Sessions | keeps AI session transcripts and their search index on this host | on |
| `host` | Host | answers let.ai about this Fortress: its status and its audit trail | off |

```sh
hx-fortress modules list
hx-fortress modules on host
hx-fortress modules off host
```

`modules list` prints each module's switch and whether it is running. For a
module that has a manifest, as `host` has, it also prints every ask let.ai may
send it, what each ask takes, what each answer can hold, the hosts the module
may call, and the names of the secrets it may read. All of that is compiled
into the binary, so the command works with the daemon stopped. Sessions is
older than manifests and has none. The list says so, and it does not say that
Sessions calls no host.

The console shows the same on its Posture & Audit page, in the list of data
paths. Three rows there are about modules: the asks of every module that is
switched on with what each answer can hold, where a release file may be
downloaded from, and the hosts a module may call. The rows are computed from the
switches, so switching a module off takes its asks off the page. The other rows
of that list show what Sessions reaches and what reaches it.

`modules on` and `modules off` write the switch to `config.json` and tell the
running daemon, which starts or stops the module. With no daemon running, the
switch takes effect when the Fortress next starts. Switching a module off
refuses the next ask to it, whether or not the daemon was told.

Sessions differs in one way: the Fortress reads its switch only when it starts.
`hx-fortress modules off session_vault` writes the switch and says that a
restart applies it. The running Fortress keeps storing sessions until then.
Where `FORTRESS_SESSIONS` is set, the Fortress applies that setting at every
start, so it decides. The terminal says so when the setting it sees is the
opposite of the switch just made.
[Sessions on or off](#sessions-on-or-off) says what a Fortress with Sessions off
does.

If `config.json` cannot be read, for example after an edit that left it
malformed, the Fortress refuses every ask until it can be read again. It stops
no module that is running. `modules on` and `modules off` change nothing while
the file cannot be read, and say that nothing was saved.

### An ask

An ask arrives over the tunnel in a `moduleMessage` frame. It holds the module's
id, the ask's name, its arguments and a grant. The Fortress checks the following,
in this order, and stops at the first check that fails:

1. The frame is a request and is well formed.
2. It carries a grant. No setting makes the grant optional.
3. The grant's signature verifies against the organization's key that this
   Fortress pinned.
4. The grant's purpose is `module`. No other part of the Fortress accepts such a
   grant, and an ask accepts no other purpose.
5. The grant is addressed to the organization this Fortress enrolled as,
   and the ask is for that organization. Where this Fortress holds more than
   one organization, the ask may be for any one of them, and for no other. The
   Fortress looks at its list of them only for a grant that has passed checks
   6 to 8. See [More than one organization](#more-than-one-organization).
6. The grant names this module and this ask.
7. The grant commits to these arguments, by a hash of them. The Fortress
   computes the hash only now, after checks 3 to 6 have passed. Arguments too
   large to fit any ask are refused without being hashed.
8. The grant has not expired, and was made to last at most 60 seconds.
9. The grant has not been used before. A grant works once.
10. The module is switched on, and on for the organization the ask is for.
11. The ask is on the module's list.
12. The arguments have the shape the list declares.

The module then answers, and one more check runs before the answer leaves:

13. The answer has the shape the list declares. What is sent is a new value
    built from that shape, never the object the module returned.

The relay is told the answer, or one of eight refusals: `grant_missing`,
`grant_invalid`, `module_off`, `ask_unknown`, `args_invalid`, `reply_invalid`,
`busy` or `failed:<code>`. The rule that refused an ask is written to this
host's audit trail and is not sent to the relay.

**A grant works once.** The Fortress remembers a used grant for five minutes
past its expiry. When an ask runs, the Fortress also writes a digest of the
grant's id beside it in the audit trail, and it reads those digests back when it
starts. A grant that ran an ask before a restart is therefore still used after
it.

**What an ask can take and an answer can hold.** Eight kinds of value, and no
others:

| Kind | What it is |
| --- | --- |
| count | a whole number, zero or more |
| flag | yes or no |
| state | one word from a list the ask declares |
| time | an instant in UTC, written as `2027-03-14T09:12:00.000Z` |
| name | at most 128 characters of letters, digits, space and `_ . : / @ -` |
| id | one token of at most 128 letters, digits and `_ . : -` |
| list | at most 500 values of one kind |
| record | values with names, each of a declared kind |

There is no kind for free text and no kind for bytes. An answer therefore has no
field that a row, a transcript or a file could be put in. One answer holds at
most 20,000 values.

**Limits.** An ask has 25 seconds to answer. At most 16 asks run at once, and at
most 300 start in any minute. Both counts are exact. Asks that arrive together
count each other, and no period of 60 seconds holds more than 300 starts,
wherever the period begins. Past either limit the relay is told `busy`.

### What let.ai may ask the `host` module

| Ask | Takes | The answer holds |
| --- | --- | --- |
| `status` | nothing | the Fortress version; the kind of key store this Fortress reads its secrets from, as a name (`env`, `file` or `azure-key-vault` today); whether this Fortress stores sessions; each module's id, whether it is on, and its version; each release's id, module, version, state and times |
| `audit.count` | a period | for the period: how many asks reached a module, how many were refused, how many releases were installed and how many sign-ins there were. Also how many releases wait now |
| `audit.read` | a period, an optional kind of line, and a page size of at most 100 | lines from the audit trail, newest first |

Each answer is about the organization the ask was for, and about no other. On a
Fortress that holds one organization that is everything the table says.
[More than one organization](#more-than-one-organization) says what changes
where a Fortress holds more.

`status` reports what the running Fortress does. For Sessions that is what it
started with: a switch that waits for a restart is not reported as if it were in
effect. The key store it names is the one this running Fortress reads from. The
answer holds that as a name and not as one word from a fixed list, so a key
store that a later build adds changes nothing in the shape of the answer.

A line from the audit trail is seven values: an id, a time, the kind of actor (a
person, the relay, the Fortress or a job), the actor's name, the action, the
name of what the action was done to, and how it ended (`ok`, `refused` or
`failed`).

The two names in a line come from a fixed list of places in a record, and from
nowhere else: the console login of a person who signed in, the module and the
ask, the module and the version of a release or the release's id, the kind of a
console command, and the `target` that a module named in its own record. The
complete list is at the top of "From a record to a line" in
`src/modules/host/audit-trail.ts`. Three rules hold for every line:

- A value is sent only if it already is a name, as the table above defines one.
  A value that is not a name is replaced by a fixed word such as `unknown`. It
  is never rewritten into a name.
- A sign-in that failed names nobody. The login in its record is whatever was
  typed into the form, and that can be a password typed into the wrong field.
  The line says that a sign-in failed, and when.
- Nothing else of a record is sent: not its other parameters, not its error
  text.

An answer has left this host once it is sent. This section is the complete list
of what the `host` module can disclose, and `hx-fortress modules list` prints
every field of every answer.

### A release

```sh
hx-fortress releases list
hx-fortress releases approve <id>
hx-fortress releases refuse <id>
```

**What is signed.** The signature of a release is made over a statement of four
lines, each ended by a newline:

```text
hx-fortress module release v1
<the module's id>
<the version>
<the sha256 of the file, in lowercase hex>
```

So the signature covers the module and the version that a person sees when
approving, and the file through its sha256. A signature made over anything else
does not count here: not one for another module or another version, and not one
made over a file's own bytes, which is how a Fortress binary is signed. A
version is 1 to 64 letters, digits and `. _ -`, starting with a letter or a
digit.

To sign a release, write those four lines to a file and sign that file with
`scripts/sign-artifact.ts`, the script that signs every other artifact. The
`.sig` file it writes is the signature that the offer carries.

When the relay offers a release, the Fortress does this and nothing else:

1. It refuses the offer if it carries no signature. This holds in every build
   and under every setting.
2. It refuses the offer unless the signature verifies, against a signing key
   compiled into this binary, over the module, the version and the sha256 that
   the offer names. Nothing is downloaded before this check. And until it
   passes, the relay is told nothing about which modules are on, which hosts are
   listed, or what is on the shelf.
3. It refuses the offer unless the file's address is on the relay's own origin,
   which is the origin the self-update downloads from, or on a host listed in
   `FORTRESS_RELEASE_HOSTS`. A redirect is held to the same rule.
4. It refuses the offer unless the module is switched on and takes releases.
5. It downloads the file: at most 64 MiB, within two minutes, and not
   compressed in transit.
6. It refuses the file unless its sha256 is the signed one.
7. It keeps the release as `waiting`.

A waiting release has changed nothing. `hx-fortress releases approve <id>`
verifies the signature again, against the keys that this build and its settings
trust at that moment. It checks the sha256 of the file on disk again. Then it
hands the file to its module, and the module applies it. The release is then
`installed`, or `failed` with a short code.

- A failed release can be approved again after the cause is fixed.
- While a module is still applying a release, nothing can be decided about that
  release. A module that takes more than ten minutes is answered for with
  `failed:timeout`. If it then finishes, the release becomes `installed`.
- If the file of a failed release is no longer on disk, the same offer from the
  relay brings it back, under the same id.
- `hx-fortress releases refuse <id>` removes the file. A refused release stays
  refused when it is offered again.

The relay is told how each release ended.

The Fortress itself never runs a release. To the Fortress a release is a file.
The module that receives the file decides what it means, and that module's code
came with the Fortress.

**Signing keys.** A build that carries a production signing key accepts only
releases signed by a production key. A build that carries only the development
key accepts no release, unless `FORTRESS_ALLOW_DEV_RELEASES=1` is set. Set it on
a development machine only.

At most 16 releases wait at once, one download runs at a time, and at most 6
offers are downloaded in any minute. No module in this build takes a release
yet, so every offer is refused until a module that takes releases ships.

### What is recorded

Every ask, every release event and every module switch is written to the
Fortress's audit trail. It is the same append-only trail the console writes to;
see [Where the audit trail lives](SECURITY.md#where-the-audit-trail-lives).
These records are written whether or not the console is running.

| Action | Written when |
| --- | --- |
| `control_plane.ask` | the relay sends an ask. When the ask ran: one record before the module was called, which holds a digest of the grant's id, and one with how it ended. When the ask was refused: one record with the rule that refused it |
| `control_plane.ask.overflow`, `system.module.refused.overflow` | only on a Fortress that holds more than one organization: asks for other organizations, or a module's own calls for them, were refused after the minute's 60 different refusals were written. One record says how many. It names no organization and is in no organization's count |
| `control_plane.release.offer` | the relay offers a release. It is held as waiting, or refused with the rule |
| `control_plane.module.remove` | the relay asks to remove a module. This is always refused |
| `cli.module.on`, `cli.module.off` | a person switches a module at the terminal |
| `system.module.switch` | the daemon starts or stops the module |
| `cli.release.approve`, `cli.release.refuse` | a person decides a release at the terminal |
| `system.release.approved`, `system.release.refused` | the daemon records that decision, and who made it |
| `system.release.install` | the daemon hands an approved release to its module. One record before the module is called and one with how it ended |
| `module.<id>.<action>` | a module records its own work |

The relay decides how often it asks, so the records of refusals are bounded. A
run of the same refusal within a minute is two records: the first refusal, and
one more with the count of the rest. At most 60 different refusals are written
in any minute. Past that they are counted, and one more record per action (two
where the Fortress holds more than one organization) says
how many.

The console moves these records into the database, and removes each file from
disk an hour after the file's last write. Where no console runs, or the console
cannot reach its database, nothing removes them, and the Fortress bounds them
itself:

- A file that has gone 65 minutes without a write is old. No running console
  leaves a file on disk that long.
- The Fortress keeps at most 16 old files and about 16 MiB of them. Past that it
  removes the oldest file. First it writes a record that says how many records
  the file held and from which period.
- It never removes a younger file. A running console has drained such a file
  and will remove it, and removing it here would record a loss that did not
  happen.

So where nothing drains these records, the disk holds the ones from the last 65
minutes or so, and about 16 MiB of older ones. At the default limits, with the
modules in this build, that comes to about 35 MiB at most. These files do not
count against the ceiling the terminal keeps for its own records, so they push
no terminal record out.

### More than one organization

Almost every Fortress holds one organization: the one that runs it. Every ask is
for that organization. Such a Fortress needs nothing from this part. It has no
file to write and no setting to make, and nothing on its disk, in its records or
on its screens says that a Fortress can hold a second organization.

A Fortress can also hold other organizations beside its own. Whoever runs it for
several organizations lists them in `organizations.json`, in the Fortress's
folder. Nothing that arrives over the connection adds an organization: no ask
does, and no other frame does.

```json
{
  "version": 1,
  "organizations": [
    {
      "id": "alder-dental",
      "modules": ["host"],
      "keys": { "host": { "report-token": "alder-dental-report-token" } }
    }
  ]
}
```

- `id` is the organization's id, as a grant names it. It is 1 to 64 lower-case
  letters, digits and `-`, and starts with a letter or a digit. An id that looks
  like an API key is refused. It is most likely a key pasted into the wrong
  place, and an id is written into every record of its organization and into a
  folder's name.
- `modules` lists the modules that are on for the organization. A module must
  also be switched on for the Fortress.
- `keys` gives, for each module, the name under which each of the module's
  secrets is stored for this organization. A name on the left is one that
  `hx-fortress modules list` prints after `Secrets:`. The example shows the
  form: no module in this build reads a secret, so `keys` can be left out.

What each organization has:

| | The Fortress's own organization | Another organization it holds |
| --- | --- | --- |
| A grant names it | as the organization the Fortress enrolled as | by its `id` |
| A module is on for it | when the module is switched on | when the module is switched on and its entry lists the module |
| What a module keeps | `modules/<module>/state/` | `organizations/<id>/modules/<module>/state/` |
| A module's secret | stored under the name the module declares | stored under the name its entry gives, while its entry lists the module. Without a name the organization has no such secret, and the Fortress's own is not read in its place |
| An audit record | carries no organization | carries `organization`, the organization's `id` |
| The `host` module's answers | this organization's records, every release and every sign-in | this organization's records. The list of releases is empty, and the counts of releases and of sign-ins are 0 |

**A secret is shared only where the file says so.** Two entries may give the
same name, and an entry may give the name the Fortress's own organization uses.
The organizations then read one secret. That is for a secret that is meant to be
one for all of them, and it is the choice of whoever writes the file.

**What a module is handed.** For an ask, a module is handed what belongs to the
organization the ask is for, and nothing that lists or reaches another
organization. When it starts, a module is handed the Fortress's own
organization's, and a way to list the organizations it is on for. That is for
work no ask started, such as finding what was running when the Fortress stopped.

**What the `host` module tells another organization.** `status` reports which
modules are on for that organization. Sessions keeps the sessions of the
Fortress's own organization, so it is reported as off for another organization
unless that organization's entry lists it. The Fortress version, the kind of key
store and each module's version are the same for every organization: they
describe the place where its data rests. `audit.read` also shows every
organization one line that is not its own: the notice that old audit files were
removed from this host's disk, because its own records may have been in them.

**Which records are an organization's.** A record of an ask carries an
organization once a grant that names it has verified in full and the Fortress
has found it on its list. A refusal made before that is the Fortress's own
record. That includes a grant that names another organization and fails any
other check: it did not verify, and the Fortress did not look at its list for
it. A module's own work for an organization, started from the list it is given
when it starts, is recorded for that organization too. A release is for the
whole Fortress, so every release event is the own organization's. So is every
record that the console and the terminal write.

**Limits are the whole Fortress's.** The limits on asks are counted for the
whole Fortress, and so is the limit of 60 different refusals written in a
minute. Past that limit, refusals for the own organization are counted in one
record for each action, as before. Refusals for other organizations are counted
together in one more record for each action, under the action's name with
`.overflow` added: `control_plane.ask.overflow` for refused asks. Such a record
names no organization and is in no organization's count.

**A change needs no restart.** The Fortress reads the file each time an ask
names another organization, and every 15 seconds besides. It compares the file
byte for byte with what it read last, and trusts nothing else about it. Change
the file in one step: write the new list to another name in the same folder and
rename it over `organizations.json`. A file that is read while it is half
written is not a list, and is refused until the next read.

**A list that cannot be used holds nobody.** If the file cannot be read, or any
one entry is not valid, the Fortress holds no other organization until the file
is corrected. It refuses every ask for one, and its log names the rule that was
broken and the entry that broke it, counted from 1. The log says so when the
Fortress starts, and within 15 seconds of a change that breaks the file. Asks
for the Fortress's own organization do not depend on the file.

Three rules are about ids. Two entries may not have the same `id`. No entry may
have the id this Fortress enrolled as: an ask that names that id is for the
Fortress's own organization. And no entry may have the id in
`identity/organization.json`. While that file is there and cannot be read, or
the credentials the Fortress enrolled with cannot be read, no entry can be
checked against it. The list then holds nobody, and the log names the file that
cannot be read.

### Settings and files

| Variable | Default | Purpose |
| --- | --- | --- |
| `FORTRESS_RELEASE_HOSTS` | none | Comma-separated hosts that a release file may also be downloaded from, over https. An entry is a name, which means port 443 and no other, or `name:port`. The relay's own origin is always allowed. The daemon is what reads this, so set it where the daemon runs. |
| `FORTRESS_ALLOW_DEV_RELEASES` | off | Accept a release signed by the development key. Ignored once the build carries a production signing key. |
| `FORTRESS_ASK_MAX_IN_FLIGHT` | `16` | How many asks may run at once. A value above `256` is held to `256`. |
| `FORTRESS_ASK_MAX_PER_MINUTE` | `300` | How many asks may start in any minute. A value above `6000` is held to `6000`. |

| File under `$FORTRESS_ROOT` | Holds |
| --- | --- |
| `config.json`, key `modules.enabled` | the ids of the modules that are switched on |
| `modules/releases.json` | every release that was offered and verified, and what was decided about it |
| `modules/<id>/artifacts/` | the file of each release that waits or failed |
| `modules/<id>/state/` | a module's own small records, one file per key |
| `organizations.json` | the other organizations this Fortress holds. Absent on a Fortress that holds one organization |
| `organizations/<organization>/modules/<id>/state/` | what a module keeps for another organization this Fortress holds |
| `identity/organization.json` | an id this Fortress makes for its own organization, the first time a module reads it. A module keys what it keeps for that organization by it. It is not the id a grant uses, and the Fortress itself puts it in no answer and no audit record. Keep it with the data. A file that is damaged is never replaced. If the file is lost, the Fortress makes a new id, says so in its log, and no longer finds what was keyed by the old one |
| `runtime/release-decisions/` | a decision that the terminal has asked the daemon to carry out |
| `runtime/module-settings.json` | the hosts in `FORTRESS_RELEASE_HOSTS` as the running daemon read them, for the console to show |

Each of these is readable by the Fortress's own user only.

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
| `FORTRESS_SESSIONS` | no | `on` or `off`: whether this fortress stores AI session transcripts. See [Sessions on or off](#sessions-on-or-off). Unset, the choice in `config.json` stands, and a new fortress has Sessions on. |
| `FORTRESS_STORAGE_BUCKET` | with Sessions on | Bucket that holds session transcripts. |
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
| `FORTRESS_DATABASE_URL` | no | Connect to an external Postgres instead of the embedded one. When set, the bundled Postgres is not downloaded or supervised. Write it as a `postgres://` URL. A value that cannot be read as one is reported without being repeated in the log or in the status file. |
| `FORTRESS_DATABASE_URL_SECRET` | no | The name of a secret that holds that connection string, in place of the string itself. See [Secrets by name](#secrets-by-name). Set one of the two, never both. |
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
| `FORTRESS_WATCHDOG_DISABLED` | no | `1`/`true` turns off `container-run`'s liveness watchdog (default on). The watchdog catches a daemon that is still running but has stopped working, which the setting above cannot: its checks run on the daemon's own event loop. See [Containers, Railway and Kubernetes](#containers-railway-and-kubernetes). Only `container-run` has a watchdog; `hx-fortress host` started directly or by systemd/launchd is unchanged. |
| `FORTRESS_WATCHDOG_STALE_MS` | no | How long the daemon's heartbeat may go unchanged before the watchdog stops the daemon and exits the container (default `120000`; `0` or blank ⇒ default; values below `30000` are raised to `30000`). |
| `FORTRESS_WATCHDOG_GRACE_MS` | no | How long after the daemon's **first** heartbeat the watchdog stays disarmed (default `300000`; `0` arms it at the first heartbeat). Time before the first heartbeat never counts, however long boot, Postgres recovery or migrations take. |
| `FORTRESS_DB_CONNECT_TIMEOUT_MS` | no | Pool connect bound (default `10000`; `0` ⇒ default — never disableable). |
| `FORTRESS_DB_STATEMENT_TIMEOUT_MS` | no | Server-side `statement_timeout` startup parameter on every fortress pool (default `120000`). **`0` OMITS the parameter entirely on every consumer — the pooled-DSN escape hatch** (see upgrade note below). |
| `FORTRESS_DB_MAX_LIFETIME_MS` | no | Hard connection rotation (default `3600000` — one hour; `0` ⇒ default — rotation is the last-resort poisoned-pool healer behind the 60 s probe's rebuild path, and a guarantor restore of a very large session must fit one connection lifetime). Kills a still-running statement at rotation (the txn rolls back atomically); purges are exempt (own client). |
| `FORTRESS_DB_ACQUIRE_TIMEOUT_MS` | no | **Ignored since the 2026-10-13 fix** (a warning is logged at boot if it is set). It used to be passed to Bun's `idleTimeout`, believed to bound the pool's checkout queue. Measured, that option is a per-connection inactivity reaper that also closes a connection whose statement is still running, and each such kill under an open transaction corrupts the pool's reservation counter until no transaction can be served (see the upgrade note below). The reaper is now off on every pool; the vault RPC deadline (`FORTRESS_DB_RPC_DEADLINE_MS`, 25 s) bounds a stuck checkout and cancels the statement it leaves behind. |
| `FORTRESS_DB_LOCK_TIMEOUT_MS` | no | `lock_timeout` startup parameter on the LIVE INGEST pool only (default `5000`; `0` omits it, so lock waits fall back to `statement_timeout`). A lock wait counts against `statement_timeout`, so without this a live chunk queued behind a long same-session restore holds a connection for the whole statement budget doing nothing. Rides the `FORTRESS_DB_STATEMENT_TIMEOUT_MS=0` pooler hatch. |
| `FORTRESS_DB_POOL_MAX` | no | Connection ceiling for the live rw/ro pools (default `10`). |
| `FORTRESS_DB_BG_POOL_MAX` | no | Connection ceiling for the background guarantor/reconciler pool (default `2`). Separate from the live pools by design: whole-transcript restores must never be able to spend the write path's budget. |
| `FORTRESS_REINDEX_MAX_CONCURRENCY` | no | How many `reindexCanonical` whole-transcript rebuilds may run at once on the live rw pool (default `FORTRESS_DB_POOL_MAX / 4`, min 1; override with an absolute count ≥ 1). reindexCanonical is the one write RPC that reads a whole canonical and applies one big `replace` txn; for the 30–80 MB tail that txn can overrun the 25 s RPC deadline; it is then cancelled, and the slot is held until the cancelled transaction has rolled back, so the bound is exact. Kept at a QUARTER of the pool so the rest stays free for the millisecond live appends. Interim guard until whole rebuilds move to a bounded-memory streaming path on the background pool; raise it only if you also raise `FORTRESS_DB_POOL_MAX`. |
| `FORTRESS_DB_PROBE_INTERVAL_MS` | no | hx-db probe cadence (default `60000`; `0` disables — mirrors the store probe, **and disables live-pool stall detection with it**). The standalone canary: 3 consecutive breaches rebuild the pools; 2 futile rebuilds escalate per `FORTRESS_STORE_EXIT_ON_WEDGE`. The live-pool detector, on the same tick: a transaction probe on the real write pool plus the outcomes the write paths report; a tick in which no transaction completed while callers hit their deadline or the probe failed is a stall, and 2 consecutive stalls rebuild the pools (`/readyz` reports `"saturated": true` meanwhile). |
| `FORTRESS_DB_MIGRATION_TIMEOUT_MS` | no | Per-statement bound inside every migration batch (default `300000`; validated integer). **Each single migration must fit this budget** — per-migration journaling converges incrementally across attempts, one too-slow migration never does; raise it for backfill-class migrations. |
| `FORTRESS_GUARANTOR_MAX_ORPHANS_PER_PASS` | no | Sessions repaired per sweep (default `100`). **`0` now means the default, not unbounded** — a full rebuild costs 40-115 s of IO against a GIN-indexed turns table, and an unbounded pass after a large backlog unfreezes is a self-inflicted incident. Raise it to drain faster on a quiet database. |
| `FORTRESS_GUARANTOR_REPAIR_STALE` | no | Repair sessions whose index is behind their canonical (default on). `false` leaves detection (`staleIndexes`, `deepMismatched`) and stops stale-index repair **and** count-sweep repair. It does NOT stop orphan restores (a canonical with no indexed row is still restored) or the title corrective pass — it is not a global write brake. |
| `FORTRESS_GUARANTOR_DEEP_VERIFY_PER_PASS` | no | Sessions and lanes the count sweep checks per pass (default 100; `0` disables and logs a warning). The sweep is the only detector for records lost from the MIDDLE of a canonical, where the lane stays seq-dense and byte-covering so the byte gate never selects it. It costs **one canonical read per row**, and it rotates continuously rather than stopping after one pass — budget for that egress on a large corpus, or lower it. |
| `FORTRESS_DB_BG_ACQUIRE_TIMEOUT_MS` | no | **Ignored since the 2026-10-13 fix** (warned at boot if set), like `FORTRESS_DB_ACQUIRE_TIMEOUT_MS` and `FORTRESS_DB_RO_ACQUIRE_TIMEOUT_MS`. As a 300 s `idleTimeout` it killed any background restore statement longer than five minutes, under a statement budget of ten. |
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

**Upgrade note — the write pool stops serving transactions 10–20 minutes after
a restart (2026-10-13, correcting the v0.18.0 reading above):** Bun's
`idleTimeout` is not a checkout-queue bound. Measured against Bun 1.3.14 and
Postgres 18, it is a per-connection inactivity timer: a connection that has
received nothing from the server for that long is closed with
`ERR_POSTGRES_IDLE_TIMEOUT`, whether it sits idle in the pool, idles inside an
open transaction between statements, or is busy running a statement. With the
10 s value the fortress passed, every `hx.turns` insert slower than 10 s (prod
averages 23–34 s) killed its own connection; the orphaned statement kept running
server-side. Each kill under an open transaction also left the pool's
reservation counter off by one, and a connection with a drifted counter is never
handed to `sql.begin()` again. After enough kills every `ingestCommit` and
`reindexCanonical` waited in the pool's reservation queue until the 25 s RPC
deadline, plain queries still answered, `pg_stat_activity` showed one or two
fortress connections, the standalone probe never breached, and memory climbed
with the abandoned transactions until a quiet moment closed the last connection
and failed the whole queue at once.

The fix: the reaper is off on every pool (the three `*_ACQUIRE_TIMEOUT_MS` knobs
no longer reach the driver); a vault RPC that misses its deadline now cancels
the statement it leaves running (`pg_cancel_backend` from a dedicated client,
plus cooperative checks inside the ingest transaction) instead of abandoning it;
the reindex limiter keeps its slot until the cancelled transaction has rolled
back; `ERR_POSTGRES_IDLE_TIMEOUT` is classified as the connection kill it is and
retried once; and guarded-db gained a live-pool detector (a transaction probe
on the real write pool plus the write paths' own outcomes) that rebuilds the
pools when nothing is served while callers wait. A rebuild is also the remedy
for a pool whose counter drifted after a `maxLifetime` rotation landed
mid-transaction. Leave `FORTRESS_DB_INGEST_TRANSACTION_TIMEOUT_MS` off:
`transaction_timeout` terminates the session, which is the same kind of kill.

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

### Sessions on or off

Sessions is the module that stores AI session transcripts in a bucket the
organization owns. It is on by default. A fortress can run with it off. It then
needs no bucket and no embedding key, takes in no transcripts, serves none, and
tells let.ai nothing about storage. It still enrolls, keeps its connection to
let.ai, serves its console and keeps its audit trail.

The choice is made on this host. Nothing let.ai sends can change it. A fortress
reads it once, when it starts, so a change takes effect at the next start.

| Where | How |
| --- | --- |
| A container | `FORTRESS_SESSIONS=off`, or `on`. It is applied at every start. Unset, the choice already in `config.json` stands. Any other value stops the daemon from starting. A start that is refused this way writes no `config.json`, no bucket credentials and no enrollment. |
| `hx-fortress enroll` | A question early in the setup. Answering No skips the bucket and the embedding key. If the fortress is running, the setup says how to restart it. |
| An enrolled host | `hx-fortress modules off session_vault`, or `on`, and then a restart. See [The modules in this build](#the-modules-in-this-build). |

The choice is kept in `config.json`: `modules.enabled` lists `session_vault`
when Sessions is on, and the key `moduleDefaultsApplied` says that the list is
the operator's own. A start adds the default modules to a file that has no
`moduleDefaultsApplied` key, as every earlier version did. So an edit by hand
that only removes `session_vault` from the list is undone at the next start.
The variable, the setup and the command write both.

With Sessions off:

- The `FORTRESS_STORAGE_*`, `FORTRESS_GCS_*` and `FORTRESS_S3_*` variables and
  `FORTRESS_OPENAI_API_KEY` are not needed and not read. No bucket key is
  written to the fortress's disk, and a value among them that Sessions would
  refuse does not stop the start.
- The ingest gateway is not started, even when `FORTRESS_PUBLIC_URL` is set.
  With that variable set, the gateway's port still answers `/healthz` and
  `/readyz`, so a platform health check keeps working. Nothing else is served
  there.
- A request from let.ai that needs sessions is answered with a refusal.
- The console's pages about sessions say that Sessions is off. Its controls
  that act on stored sessions refuse with that reason, and so does a rotation
  of the bucket credentials or the embedding key. The checkup reports the
  object store and the embeddings as not configured.
- The Adoption page stays: the roster still arrives from let.ai and is still
  stored.

A fortress that had Sessions on and is switched off keeps what it had. The
records of earlier sessions stay in its database, and their transcripts stay in
the bucket they were written to. The fortress no longer reads that bucket, and
a credentials file left on its disk is not used.

Turning Sessions on for a fortress that was set up with it off needs a bucket
and an embedding key first. On a host, run `hx-fortress enroll` again and
answer Yes. It asks for both and switches Sessions on once the bucket is
verified. Where it cannot verify the bucket itself, it writes a credentials
file for you to complete, switches Sessions on and says so: the fortress then
does not start until that file is complete. In a container, set the storage
variables and `FORTRESS_SESSIONS=on`. Either way the fortress must be
restarted. `hx-fortress modules on session_vault` writes the switch and nothing
else: with no bucket and no embedding key, the fortress then refuses to start.

### Secrets by name

A setting that holds a credential can be given as the **name** of a secret. The
fortress reads the value from a store you own when it starts, keeps it in
memory, and writes it to no file and no log. let.ai never holds a value: the
most it sees is a name.

A name is 1 to 64 characters of `a-z`, `0-9` and `-`.

| Provider | Where the secret `db-url` is read from | What it needs from the host |
| --- | --- | --- |
| `env` (default) | The variable `FORTRESS_SECRET_DB_URL`. | Nothing. |
| `file` | The file `<dir>/db-url`, the layout of Docker secrets and Kubernetes secret volumes. It is read at every use, so replacing the file replaces the secret. | Nothing. |
| `azure-key-vault` | The secret `db-url` in one Azure Key Vault, read with the managed identity of the machine or container. There is no client secret and no Azure SDK. A value is kept in memory for one minute by default. | A managed identity. The fortress must run on an Azure service that gives it one, such as Azure Container Apps, App Service or a virtual machine. |

| Variable | `secrets` key in `config.json` | Purpose |
| --- | --- | --- |
| `FORTRESS_SECRETS_PROVIDER` | `provider` | `env`, `file` or `azure-key-vault`. Default `env`. |
| `FORTRESS_SECRETS_DIR` | `dir` | `file` only. The directory, as an absolute path. Default `$FORTRESS_ROOT/secrets`. |
| `FORTRESS_SECRETS_AZURE_VAULT_URL` | `vaultUrl` | `azure-key-vault` only. Required. `https://<name>.vault.azure.net`. The host must be a Key Vault host of a known Azure cloud, because the identity's token is sent there. |
| `FORTRESS_SECRETS_AZURE_CLIENT_ID` | `clientId` | `azure-key-vault` only. The client id of a user-assigned managed identity. Leave it out to use the system-assigned one. |
| `FORTRESS_SECRETS_CACHE_SECONDS` | `cacheSeconds` | `azure-key-vault` only. How long a value is kept in memory, from `0` to `900`. Default `60`. |

The environment wins over `config.json`. A host install started by systemd or
launchd carries no environment of its own, so it sets the block in
`config.json`:

```json
"secrets": { "provider": "file", "dir": "/etc/hx-fortress/secrets" }
```

A setting the fortress does not understand stops it from starting, and the
error names the setting: an unknown provider, an unknown key, an unknown
`FORTRESS_SECRETS_*` variable, or a setting given for a provider that is not
the one in use. A variable that starts with `FORTRESS_KEY_VAULT_` is refused
too: the two Azure settings had that prefix before, and those names are not
read. A setting written one letter short is
refused too: `FORTRESS_SECRET_DIR` is the variable of a secret named `dir`, so
a directory path in it is `FORTRESS_SECRETS_DIR`, mistyped. This is checked at
every start, whether or not a secret is read. The fortress never falls back to
another store.

A fortress whose provider needs something from its host says so in one line of
its log when it starts.

One setting can be given by name today: the database connection string, with
`FORTRESS_DATABASE_URL_SECRET`. A secret that cannot be read stops the fortress
from starting. It does not fall back to the embedded Postgres. A store that may
answer later, such as a Key Vault whose role assignment has not taken effect
yet, is asked again for about a minute first.

- The secret's value must be a `postgres://` or `postgresql://` URL. A value in
  another form is refused, and the error does not repeat it.
- `FORTRESS_DATABASE_URL_SECRET` set and empty is refused. It is not read as
  "not set", because the fortress would then start on the embedded Postgres.
- A variable that only looks like it, such as
  `FORTRESS_DATABASE_URL_SECRET_NAME`, is refused by name for the same reason.

With `azure-key-vault`, the managed identity needs the **Key Vault Secrets
User** role on the vault and nothing else.

If the environment names a proxy (`HTTP_PROXY`, `HTTPS_PROXY`), the request to
the vault goes through it as any HTTPS request does, and the proxy sees a
tunnel and no token. The token request never does: it is made in clear text to
an endpoint on the host itself, so the fortress adds that endpoint's host to
`NO_PROXY` when it builds the provider.

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

**A daemon that stops heartbeating is stopped, and the container exits.** A
daemon can stop working without exiting: when its event loop freezes, the
process stays alive, the platform sees a running container, and the daemon's
own stall detection — which runs on that same event loop — never fires. So
`container-run` watches the daemon from outside. The daemon rewrites
`$FORTRESS_ROOT/runtime/metrics.json` every 10 seconds, and `container-run`
reads the file's modification time every 5 seconds. The watchdog arms
`FORTRESS_WATCHDOG_GRACE_MS` (five minutes) after the daemon's first rewrite;
nothing before that first rewrite counts, and the copy of the file left by the
previous container is not a rewrite. Once armed, if the file stays unchanged
for longer than `FORTRESS_WATCHDOG_STALE_MS` (two minutes), `container-run`
logs one line naming the file and when it was last written, sends the daemon
`SIGTERM`, sends `SIGKILL` 10 seconds later if it is still running, stops the
console and exits with code `70`. The orchestrator sees that exit exactly like
a crash, so the restart policy above is what brings the fortress back. Time in
which `container-run` itself did not run — a paused container, a host that
slept — is not counted against the daemon. `FORTRESS_WATCHDOG_DISABLED=1`
turns the watchdog off.

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

### Run on Azure

`deploy/azure/` holds a Bicep template for Azure Container Apps and a README
that walks through it. It deploys one fortress into a resource group you own:

- **One container, one replica**, with a system-assigned managed identity. No
  client secret and no storage key reach the container.
- **A Key Vault** that the identity may read, through the Key Vault Secrets User
  role and no other. The fortress reads its Postgres connection string from
  there by name, with `FORTRESS_SECRETS_PROVIDER=azure-key-vault`,
  `FORTRESS_SECRETS_AZURE_VAULT_URL` and `FORTRESS_DATABASE_URL_SECRET`. See
  [Secrets by name](#secrets-by-name).
- **Postgres is yours.** The template creates no database server. Any Postgres
  the container can reach works, given as a `postgresql://` URL kept in the
  vault.
- **No ingress for the connection to let.ai.** The fortress dials out. The
  console is served only when you give it an HTTPS ingress, and that ingress can
  be limited to your virtual network or to IP ranges.
- **Sessions off** (`FORTRESS_SESSIONS=off`), so no bucket is needed. See
  [Sessions on or off](#sessions-on-or-off). Sessions stores transcripts in
  Amazon S3 or Google Cloud Storage. It has no Azure Blob Storage backend, and
  the template has no settings for it.
- **Sign-in through Microsoft Entra ID** is switched on from inside the
  container with `hx-fortress ui oidc`. See
  [Sign in with your identity provider](#sign-in-with-your-identity-provider).

```sh
az deployment group create --resource-group <group> --parameters deploy/azure/main.bicepparam
```

`deploy/azure/main.bicepparam` reads the image, the control plane's address,
the enrollment token and the connection string from the environment of your
shell. So neither secret is written in a file, and neither is an argument of a
command that other users of the machine can see.
[deploy/azure/README.md](deploy/azure/README.md) has the full commands. It also has what to prepare, every parameter, how to reach the
console, how to keep one copy running during an upgrade and how to operate the
deployment.

The template has not been compiled and has not been deployed from this
repository, because nothing here may create Azure resources. Check it with
`az bicep build` and `az deployment group what-if` first, as that README shows.

### Health checks

- `GET /healthz` — liveness; `200 {"ok":true}` as soon as the gateway listens.
- `GET /readyz` — readiness; `200 {"ok":true,"ready":true}` once the vault store
  is live and Postgres is accepting connections, otherwise `503`. Point the
  platform's traffic gate here.

Both are served on the gateway's port, which listens only when
`FORTRESS_PUBLIC_URL` is set. With [Sessions off](#sessions-on-or-off) there is
no gateway and no vault store. The same port then answers these two paths and
nothing else, and `/readyz` is `200` once Postgres is accepting connections.

## Development

Install Bun, then run:

```sh
bun install
bun test
bun run typecheck
bun run lint
```

Use `bun run check` to run all repository checks in the same order as CI.

### Adding a module

A module lives in `src/modules/<id>/`. It declares a manifest: every ask it
takes, with the shape of the arguments and of the answer; the hosts it may call;
and the names of the secrets it reads. Add an entry for it to
`src/host/module-catalog.ts`, and make the module available in
`src/host/main.ts` with `moduleHost.provide(...)`.

A module gets a context from the host and works through it:

- `ctx.secrets` reads a secret by name. It refuses a name the manifest does not
  list.
- `ctx.fetch` calls out over https. It refuses a host the manifest does not
  list, and it does not follow a redirect. Of the options a call may carry, it
  passes on the method, the headers, the body and the signal, and drops the
  rest. A lint rule over `src/modules/` fails the build when a module uses the
  global `fetch` or a Node network module. A library that makes its own
  requests must be given `ctx.fetch` to use.
- `ctx.audit.record` writes one record to the audit trail. A record holds names,
  counts and flags. If the record names what it worked on in a field called
  `target`, the `host` module reports that name for the line. No other field of
  the record leaves this host.
- `ctx.state` keeps small records for the module on disk.

To fail an ask with a code the relay may see, throw `AskFailure` with one
lower-case word. A failure of `ctx.secrets` or `ctx.fetch` reaches the relay as
a code of its own, such as `failed:secret_missing`. Anything else a module
throws reaches the relay as `failed:internal`. Its message is not sent and not
recorded, and the log holds only the kind of error and where it was thrown.

A new source file that calls `fetch` must also be added to the list in
`test/console-read-api.test.ts` that maps each such file to the row of the
console's data paths that discloses it. The test fails until it is.

Cutting a release — and the order the three repositories have to ship in —
is [RELEASING.md](RELEASING.md).
