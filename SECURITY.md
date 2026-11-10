# Security Policy

`hx-fortress` runs on customer infrastructure. It holds enrollment tokens, an
Ed25519 signing key, object-storage credentials, AI session transcripts, and the
administration console for all of it. We take security reports seriously and
appreciate responsible disclosure.

## Supported Versions

Only the latest released version receives security fixes. This project is
pre-1.0.

| Version        | Supported          |
| -------------- | ------------------ |
| latest release | :white_check_mark: |
| older releases | :x:                |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately through either channel:

- **Preferred:** GitHub Private Vulnerability Reporting — the "Report a
  vulnerability" button under this repository's **Security** tab.
- **Email:** [security@<domain>] (PGP key: [link/fingerprint]).

Please include: affected version/commit, a description and impact assessment,
and reproduction steps or a proof-of-concept where possible. Findings against
the enrollment, signing-key, capability-token, console-session, self-update, or
storage-credential paths are prioritized.

## Response Targets

| Stage                              | Target                  |
| ---------------------------------- | ----------------------- |
| Acknowledge receipt                | within 2 business days  |
| Initial assessment / triage        | within 7 days           |
| Fix or coordinated-disclosure plan | within 90 days          |

Timelines may be adjusted for complex issues by mutual agreement.

## Scope

In scope: this repository's source and released binaries. Out of scope:
third-party dependencies (report upstream), social engineering, and physical
attacks. The wire-protocol types live in `hx-protocol`; the client daemon in
`hx`.

---

# Threat model

This section describes what the shipped code does. The properties it names are
ones this repository's tests assert; where a property does not hold, it is
written down under **Known residuals** rather than omitted.

## The two ways in

**The terminal.** Every `hx-fortress` verb runs without a credential. That is
deliberate: anyone who can run them already has the host, its files and its
process table, so a prompt would protect nothing and would put secrets in shell
history and in `/proc/<pid>/cmdline`. The CLI therefore never accepts a password
at all — `ui user create` and `ui user reset` print a one-time setup URL for the
person to open, and `ui config set databaseUrl` reads the DSN from stdin and
refuses a positional argument by name.

**The browser.** Every console session belongs to a named person with one of two
roles, `operator` or `readonly`. By default that person is a local account.
Accounts are created from the terminal and live in a 0600 `users.json` beside
the console, with argon2id password hashes. An organization can also switch on
sign-in through its own identity provider, which is described below. There is no
credential-free browser path and no way to create an account from the browser.

Role decides capability. `readonly` reaches every read; `operator` additionally
reaches the two write routes. The decision is made once, at a single gate every
request passes through, and a path that no route classifies is treated as a
write — so a route added without a decision is locked to operators rather than
quietly open.

## What is served before a session exists

The application shell, its content-hashed assets, `/healthz`, a loopback-only
identity handshake that answers `{"app":"hx-fortress-ui"}`, and four
authentication routes (sign-in, SSO exchange, setup status, setup completion).
Nothing else. No version, no organization, no configuration value, and no path
on the box.

While sign-in through the organization's identity provider is on, three more
routes answer: whether it is offered, the start of a flow, and its finish. While
it is off they answer exactly as a path that does not exist.

An unauthenticated request to a path that does not exist is answered exactly
like one to a path that does — 401, same sentence. The difference between the
two would otherwise be a map of the console's surface, drawn by anyone who can
reach the port.

## The SSO trust boundary

The workbench's "Open fortress console" button carries an Ed25519 grant minted
by let.ai and verified offline against the per-org public key the hub pushed
over the tunnel. Signature first, then purpose, then organization, then origin
and expiry.

A **valid** grant produces four fields: an entry-record id, the workbench
subject, the organization id, and the operator's banner phrase. It produces no
session and no token. The entry id is a server-side annotation — the sign-in
stamps the workbench identity from the record it names, never from anything the
client sends — and presenting it as a session token is refused like any other
unknown token.

So a compromised let.ai can mint a grant, open a tab, and land on a sign-in
form. It cannot read a session, a count, a transcript or a configuration value,
and it cannot change anything: every capability comes from a fortress-local
account whose password the cloud never holds, or from the organization's own
identity provider, which the cloud is not a party to.

`ui.sso` is off by default and is enabled by a local gesture. It requires an
https `publicUrl`: `hx-fortress ui sso on` refuses without one rather than
warning, and the console advertises its URL to let.ai only while all three of
enablement, `sso` and an https public URL hold.

## Sign-in through the organization's identity provider

Off by default. `hx-fortress ui oidc on` switches it on. The `ui oidc` verbs are
the only writers of its settings file, `<root>/ui/oidc.json`: mode 0600, and the
same single-writer protocol as `ui.json`. No browser route writes that file, and
no frame from let.ai reads or writes it.

**The provider is the organization's own, and let.ai is not a party to the
flow.** The issuer, the client and the group mapping are typed on this host. The
console talks to the issuer directly: its discovery document, its signing keys
and its token endpoint. Nothing let.ai sends can start a flow, name an issuer,
map a group or mint a session. So the property stated above holds with this
sign-in on: a compromised let.ai lands on a sign-in form and gets no further.
What is added is a second party, one the organization already trusts for sign-in
elsewhere: its identity provider. A person whom that provider puts in an
operator group is an operator here.

The flow is the authorization code flow with PKCE, and every check fails closed:

- The console signs a `state` value that carries the flow's nonce, its redirect
  URI, its PKCE challenge and the settings epoch. The signing key exists only in
  the serving process. A returning flow is checked in this order: the signature,
  the epoch, its age (ten minutes), single use, and the PKCE verifier, which
  only the browser tab that started the flow holds. All of that happens before
  the provider is asked anything.
- The discovery document must name the configured issuer exactly. Every endpoint
  in it must be https, or http to this host itself. A redirect is not followed
  on any request to the provider.
- The ID token is verified against the provider's published keys: signature,
  issuer, audience, expiry, age, and the nonce of this flow. Only asymmetric
  algorithms are accepted. `none` and the HMAC family are refused, so a token
  signed with the client secret proves nothing. The token never reaches the
  browser.
- A person in no mapped group is refused. So is a token with no groups claim.
- While the sign-in is off, its three routes answer exactly as a path that does
  not exist: the same status and body, no rate bucket and no Origin check.

A session issued this way has no local account behind it. It carries the role
the person's groups gave at sign-in, and the settings epoch it was issued under.
Every write to the settings raises that epoch. So changing a setting, turning
the sign-in off, and `ui oidc revoke` each end every such session on its next
request. `ui disable` ends them with every other session.

A confidential client's secret is read by name, through the secrets boundary
described below. It is sent to the provider's token endpoint and nowhere else.

## Token lifecycle

| Token | Minted by | Carried in | Lifetime | Ends when |
| --- | --- | --- | --- | --- |
| Setup URL | `ui user create` / `ui user reset`, printed to the terminal | the URL **fragment**, so it never reaches a request line, an access log or a `Referer` | 24 hours | the password is set, a newer link is issued, or the account is disabled, deleted or reset |
| Setup URL (container bootstrap) | `FORTRESS_UI_BOOTSTRAP_USER` on a first boot — written to `<root>/ui/bootstrap-setup-link.txt` (0600) and **never printed**, because this console's stdout is pid 1's stdout | the same URL fragment | 24 hours | as above |
| Session token | the sign-in that returns it | the `x-fortress-ui-token` request header, held in `sessionStorage` per tab | an absolute and an idle budget, both from `ui.json` | sign-out, either budget, a console restart, `ui user disable`/`delete`/`reset`, or a role change |
| Console grant | let.ai | the SSO exchange request body | minutes, set by the minter | it is exchanged once — `jti` is single-use |
| Sign-in flow state and PKCE verifier | this console, when a person starts a sign-in through the identity provider | the state rides the provider's redirect; the verifier stays in the tab's `sessionStorage`; both return in the request body that finishes the flow | 10 minutes | the flow is finished once, the settings change, or the console restarts |
| ID token | the organization's identity provider | the token endpoint's response to this console; never the browser | minutes, set by the provider | it is verified once and dropped |
| Capability token | let.ai | `Authorization: Bearer` on the ingest/read gateway | minutes, set by the minter | its own expiry |

Session tokens are 256 bits from the system CSPRNG. They appear in exactly one
place — the JSON body of the response that minted them — and never in a URL, a
redirect or a log line. The server stores only a SHA-256 digest, in the serving
process's memory: a restart revokes every session, and nothing on disk can be
stolen and replayed. Cookies are not used, which is what keeps cross-site
request forgery from being a category here; writes additionally carry an Origin
check that fails closed on an absent or `null` header.

Revocation performed by another process — the CLI writing `users.json` — rides
epochs that are re-read on every single request, so a disabled account stops
working on its next call rather than when its session happens to expire.

## The two realms do not cross

The console and the ingest/read gateway are separate authentication realms with
separate verifiers. A capability token reaches no `/ui/api/*` route on either
header, a console session reaches no gateway route, and a console grant is
refused by both — the gateway rejects its purpose outright, and the console door
mints nothing but an annotation. This is asserted in both directions.

## The metadata-only boundary

With the bundled Postgres, the console's database role holds:

- column-level `SELECT` on `hx.sessions` that **excludes** `last_user_text` and
  `last_assistant_text`;
- column-level `SELECT` on `hx.embeddings` that **excludes** the vector and
  `content_hash` — an embedding is a lossy encoding of the text it was computed
  from, and a hash of that text is a membership oracle over it;
- **no** privilege on `hx.turns`, `hx.tool_calls`, `hx.session_agents`, or on
  any view (views are owner-rights and read straight past a column grant, so
  every one of them is denied);
- `SELECT` and `INSERT` on the command queue and the audit table, and `SELECT`
  and nothing else on every table the daemon's engines own.

A console compromise is therefore not a transcript disclosure **through the
database**: there is no grant it could use to read one. That is the whole claim
the matrix supports, and the residual is stated rather than implied — the
console process holds the storage credential and builds a direct store from it
(it needs one to sign the HEAD that proves a session's object exists), and it
runs as the same uid as the daemon, so anything that uid can read it can read.
Code execution in the console process is therefore a bucket-credential
compromise; it is simply not a *privilege* the database grants. The whole matrix
is asserted against a live catalog on every pull request, on the second boot —
the blanket grant that every boot re-issues must not undo a revoke.

The console does render the organization's roster and per-person session counts
to any signed-in account, including `readonly`. That is a deliberate product
decision, not an oversight: the people, adoption and device views exist to
answer who in the organization is covered, and suppressing them would be
theatre against an operator who has root on the box. The boundary is who gets
an account.

## The daemon runtime plane

Everything the console asks the daemon to do is a row in `hx.console_commands`,
and the two processes reach that table with different authority.

The console's role, `hx_ui`, is the only one that may `INSERT` there. The
daemon's role, `hx_app_rw`, is the one every cloud-reachable path runs as — the
tunnel, the gateway, each ingest entry point — and it holds no `INSERT`, no
`UPDATE` and no `DELETE` on that table at all. The same revoke covers
`hx.admin_audit`, `hx.audit_acks` and `hx.audit_settings`. An adversary who
reaches that role over the network therefore cannot ask this host to update
itself, rotate a credential, move its storage or acknowledge a residency
finding: the row that would carry the request is one it cannot write.

`hx.ingest_control` is revoked with them and then handed back exactly what
pausing ingest needs, at column level: `paused_until`, `reason` and `armed_by` on
insert, `paused_until`, `reason` and `resumed_at` on update. `row_written_at` is
not among them — it anchors how long a pause may hold the write gate closed, so
the role that arms a pause must not be able to set it. `DELETE` stays revoked
permanently, because delete-then-reinsert would mint a fresh anchor and restore
the unbounded pause the clamp exists to bound.

The daemon still has to move rows it did not mint — claim one, finish it, reject
it — and it does that through five `SECURITY DEFINER` routines:

| Routine | What it may do |
| --- | --- |
| `hx.claim_command` | `requested` → `running`, or re-drive a row this daemon already had in flight |
| `hx.complete_command` | `running` → `done` or `failed`, and nothing else |
| `hx.reject_command` | non-terminal → `rejected` |
| `hx.acknowledge_finding` | write one residency acknowledgement |
| `hx.set_cloud_witness` | flip the cloud-witness setting |

Each enforces a one-way state machine — a terminal row is final, and no argument
shape moves it back — and none can change a row's `kind`, its parameters or its
requested time. `EXECUTE` is revoked from `PUBLIC` in the same transaction that
creates each routine, and granted to `hx_app_rw` alone.

They are owned by `hx_cmd_owner`, a `NOLOGIN` role created for this and nothing
else, and deliberately not the cluster superuser: a `SECURITY DEFINER` body runs
with its owner's rights, so a superuser-owned routine would turn a defect in a
body into control of the cluster, and the caller here is the one principal this
fence exists to constrain. Each routine pins
`search_path = pg_catalog, pg_temp` and schema-qualifies every reference,
because an unqualified name in such a body otherwise resolves through the
*caller's* search path. `hx_cmd_owner` holds `SELECT, UPDATE` on the command
queue and `SELECT, INSERT, UPDATE` on the two audit tables — no `INSERT` on the
queue, so minting stays with the console — and it is a member of nothing and has
no members.

The role, the routines, the ownership, the `PUBLIC` revoke and the grants are
re-applied on every boot rather than written once by a migration. A migration
runs before the role it would grant to exists, aborts an upgrade on an external
Postgres whose operator role cannot take ownership, and — the journal being
keyed by name — could never correct a routine it had already recorded. The same
boot drops stale overloads: `CREATE OR REPLACE` is keyed on the argument types,
so a changed signature would leave the previous routine alive, still owned and
still granted, still enforcing the previous state machine. Every property in
this section is asserted against the live catalog on the second boot.

All of it is embedded-Postgres only; see **Console containment is
EMBEDDED-Postgres only** below.

## The secrets boundary

A setting that holds a credential can be given as the name of a secret
(`FORTRESS_DATABASE_URL_SECRET`). The fortress reads the value from a store the
organization owns: its environment, a directory of files, or Azure Key Vault.
For every provider:

- **let.ai holds names, never values.** No frame carries a secret's value in
  either direction, and nothing let.ai sends can choose which store is read.
  The provider and its settings come from this host's environment and
  `config.json` alone.
- **A value is returned to the code that asked for it and goes nowhere else.**
  It is in no error message, log line, audit record or status file. An error
  names the secret. Where the provider looked is kept in a field that is not
  part of the message and is not serialized. A provider object holds what it
  was given in private fields, so logging one prints only its kind.
- **Nothing is written to disk.** A database URL read from a secret reaches the
  Postgres client in memory. It is not copied into the process environment, so
  no child process inherits it. `pg.json`, the file that tells the console how
  to reach the database, carries the secret's *name*, and the console reads the
  same secret with its own provider.
- **It fails closed.** A name is checked (1 to 64 characters of `a-z`, `0-9`
  and `-`) before it reaches a path, a URL or an environment lookup. A setting
  the fortress does not understand, or a secret it cannot read, stops it from
  starting. The settings are checked at every start, whether or not a secret is
  read. It never substitutes another store, and it never falls back to the
  embedded Postgres when the database secret cannot be read: a variable that
  names the secret and is empty, or that only looks like the setting, is
  refused, never read as "not set".
- **A database secret is checked before any driver sees it.** Its value must be
  a `postgres://` URL. A driver quotes a string it cannot parse in its own
  error, and that error is logged, so a value in another form is refused first
  and is not repeated.
- **Azure Key Vault is reached with the host's managed identity and two
  requests**: a token from the platform's identity endpoint, which is on the
  host itself or on its link-local network, then `GET {vault}/secrets/{name}`
  over HTTPS. The vault's host must be a Key Vault host of a known Azure cloud,
  and a redirect is refused on both requests, so the token cannot be sent
  anywhere else. The token request is made in clear text, so it is kept away
  from any proxy the environment names: the endpoint's host is added to
  `NO_PROXY`. A value is kept in memory for one minute by default, fifteen at
  most, and then dropped. A token is trusted for a day at most, whatever the
  endpoint says.
- **An error repeats a status, and an error code only from a fixed list of
  Azure's own.** No other text from a response reaches an error, a log line or
  the console.

## Rate limiting, lockout, and the load ceilings

- Sign-in counters are keyed on `(login, remote-key)`. A lockout is never
  organization-wide and never permanent: repeated failures buy an exponentially
  growing delay with a 15-minute ceiling, because a permanent lock is a
  denial-of-service an attacker can aim at the operator.
- A process-wide sign-in ceiling sheds load above every per-principal budget.
- Password verification runs through a bounded argon2id gate that keeps a slot
  reserved for a remote with no recent failures, so a genuine sign-in gets
  through a flood.
- `X-Forwarded-For` is honoured **only** when the immediate peer is a configured
  trusted proxy, and the walk goes rightmost-to-left, so entries an attacker
  prepends are never reached. With no trusted proxy configured the header is
  ignored entirely; `hx-fortress ui config` prints which address the limits are
  actually keyed on, because the default is otherwise a silent failure behind
  any platform edge.
- Request bodies are capped at 256 KiB by the listener, before any handler runs.
- Live event streams are capped per session, per account, and process-wide, and
  every stream a session holds is closed the moment that session is dropped.

## Browser-facing responses

Every response class carries `Content-Security-Policy` (with SHA-256 hashes for
the shell's inline scripts, so `script-src` needs no `'unsafe-inline'`, and with
`frame-ancestors 'none'`, `base-uri 'none'` and `form-action 'none'`),
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and a
`Cache-Control` directive. `Strict-Transport-Security` is sent only where the
request actually arrived on a configured https host — asserting it on a
plain-http console would pin a browser to a scheme that console cannot serve.

The single exception is the event stream, which is a body already flowing when
those headers would be set: it carries `nosniff`, the referrer policy and
`no-store`, and not the CSP, which is a directive for documents.

The `Host` header is checked per request against an allowlist rebuilt from a
live read of `ui.json`. Literal loopback is accepted on any port — a published
container maps 8788 onto some other host port — and a configured public host is
accepted on its own port alone. A name nobody configured is refused, which is
what closes DNS rebinding.

## What a browser can change

Exactly two routes, and one acknowledgement:

- `POST /ui/api/service` — start, stop or restart the daemon's unit.
- `POST /ui/api/commands` — mint one row in the command queue, whose `kind` must
  be one of the eight the console offers a control for.
- `POST /ui/api/report/proof-copy` — record that a residency proof was copied.

There is no configuration-write endpoint under any spelling, no account
management, and no way to change what this console itself is configured with.
Configuration, account lifecycle and SSO advertisement are terminal verbs, and
the command plane refuses a configuration key as a parameter.

A credential a command needs — the storage migration's target keys, a rotation's
replacement — never travels in the row. The request body carries it once, the
console writes it to a single-use `0600` file, and the row carries a 32-hex
reference in a column of its own — `console_commands.credential_ref`, never a
parameter — which the daemon reads and unlinks in one step. The file is written
only after every refusal the submission can meet, so a kind this console does
not offer leaves no key material on disk. The row is durable and readable by
everything holding `SELECT`; the secret it points at is neither.

## Where the audit trail lives

Every console act is written to a 0600 append-only JSONL spool owned by the
serving process before it is mirrored into Postgres. The intent record is
fsynced **before** the mutation runs and the outcome is appended after — an
append-only pair, never an in-place amend, so a crash between them leaves an
intent nothing answers, which is the honest state.

Failed public authentication attempts are collapsed: one record per
`(login, source, 5-minute window)` carrying the final count, and attempts a rate
bucket refused append nothing at all. Otherwise a flood could make this host
write to disk as fast as it can send packets, into a table with no `DELETE`
anywhere in the system.

---

# Known residuals

These are properties of the design, not open bugs. They are stated here so an
operator can decide about them rather than discover them.

## Command outcomes are corroborated, not trusted

The daemon's Postgres authority IS the cloud-reachable write role. The role
cannot mint a command and cannot alter one — every transition runs through a
`SECURITY DEFINER` routine owned by a NOLOGIN role that holds nothing else — but
the routines are `EXECUTE`-granted to it by necessity, so an adversary holding
that role can call them directly: report a rotation that never ran, or deny one
that did.

There is no SQL-layer fix. Any nonce the routine could check is one the same
role could rotate.

So the row is not the evidence. The daemon writes every transition it actually
performs to the 0600 spool — a file that role cannot reach — and the console
compares the two. A terminal outcome with no matching record renders as
**REPORTED (unconfirmed)**, never as success; one contradicted by a record
renders as **DISPUTED**, names which way the disagreement runs, links the trail
entry, and gives the remediation. The residual is that forgery is made *visible*
rather than *impossible*.

## Console containment is EMBEDDED-Postgres only

Against an **external Postgres** (`FORTRESS_DATABASE_URL`) both fences above are
**void**. There is no role split to enforce, the operator's role OWNS the tables
— an owner cannot be constrained by `REVOKE` and bypasses any routine with plain
DML — and the apparatus is never created there at all. Console mutations still
work; they are simply not contained, and the console says so on the pages that
depend on them.

The metadata-only column boundary is not applied there either: the grants that
create it are issued by the embedded provider's boot, which never runs against
an external DSN. Unless the operator provisioned a restricted console role
themselves, the console connects with whatever privilege the DSN carries.

Remediation for all three: run the daemon under a NON-OWNING role.
`hx-fortress ui config --print-role-sql` emits that script — table DML only,
`SELECT, UPDATE` on the command queue and never `INSERT`, so minting stays with
the console role the same script creates, and the same column-scoped `SELECT`
on `hx.sessions` that the embedded boot issues.

## The console process holds a bucket-write-capable key

The fortress has ONE storage credential for both reads and writes, and signing
the console's `HEAD`/`LIST`/`GetBucketVersioning` calls requires exactly the
secret half of it. The console is given the storage block minus the OpenAI key;
the storage credential it does hold can also write.

## A downgrade window is not audit-trustworthy

The console-table `REVOKE`s are carried both by the migration and by every boot.
An OLDER binary re-grants the write role full DML on its first boot through its
blanket schema grant, so audit rows written while a downgraded binary was
running are untrusted. A command row planted during such a window is rejected by
the boot fence of the binary that comes back — it is never executed — but the
rows the downgraded binary wrote are still there.

## A console restart re-opens replay for an unexchanged grant

Exchanged grants are remembered by `jti` in the serving process's memory, which
is all the set has to outlive. A restart inside a grant's own TTL therefore
forgets it, and a grant that was captured but never exchanged could be exchanged
afterwards. What that buys is one more sign-in form.

## The console binds dual-stack inside a container

Outside a container, a non-loopback bind is refused unless an https
`FORTRESS_UI_PUBLIC_URL` is set or `--allow-insecure-bind` is passed, and the
residual is printed. Inside a detected docker-class container with
`FORTRESS_UI_ENABLE`, the console binds dual-stack so the documented
`-p 127.0.0.1:8788:8788` publish works with no extra gesture. The Host allowlist
and the local account credentials are the boundary there. System containers
(lxc, nspawn) are LAN-routable and have no publish indirection, so they require
the explicit gesture like any host.

## A person removed from a group keeps their session until it ends

With sign-in through the identity provider, the role is decided from the groups
in the ID token at sign-in. The console does not ask the provider again while
the session lives. A person removed from a group therefore keeps the session
for up to its lifetime: 12 hours, or 60 minutes idle, by default.
`hx-fortress ui oidc revoke` ends every such session at once.

## The identity provider decides who is an operator

With that sign-in on, whoever controls group membership at the provider controls
who is an operator of this console. That is its purpose, and the provider is the
organization's own. It is still a second root of trust beside the shell on this
host. Leave the sign-in off to keep the shell the only one.

## The `env` secret provider is readable by every child process

With the `env` provider a secret is an environment variable of the daemon. The
processes the daemon starts inherit that environment: the embedded Postgres, and
the console under `container-run`. Use the `file` or `azure-key-vault` provider
to keep a secret out of it. A value read from either is never placed in the
environment.

## The console reads the database secret too

When the database URL is named by `FORTRESS_DATABASE_URL_SECRET`, the console
process reads the same secret. On an external Postgres the console connects
with the operator's connection string unless it is given its own
(`hx-fortress ui config set databaseUrl --stdin`). This is the residual stated
under *Console containment is EMBEDDED-Postgres only*, reached through a name
instead of a file.

---

# Safe Harbor

We will not pursue legal action against researchers who act in good faith,
avoid privacy violations and service disruption, and give us a reasonable
opportunity to remediate before public disclosure.
