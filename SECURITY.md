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
the enrollment, signing-key, capability-token, console-session, self-update,
storage-credential, module-ask or module-release paths are prioritized.

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
The one account not made from the terminal is the first administrator's: the
one-time setup makes it (see *What a browser can change*).

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
- One flow yields one session at most. While a request is finishing a flow, a
  second request that carries the same flow is refused. A flow that produced a
  session is refused from then on. A flow whose sign-in failed may be tried
  again, and the provider decides whether its code is still worth anything. A
  failed attempt leaves nothing in this console's memory.
- The discovery document must name the configured issuer exactly. Every endpoint
  in it must be https, or http to this host itself. A redirect is not followed
  on any request to the provider.
- The ID token is verified against the provider's published keys: signature,
  issuer, audience, expiry, age, and the nonce of this flow. Only asymmetric
  algorithms are accepted. `none` and the HMAC family are refused, so a token
  signed with the client secret proves nothing. The token never reaches the
  browser.
- A person in no mapped group is refused. So is a token with no groups claim.
- While the sign-in is on, its two POST routes need this console's own Origin,
  as every write here does, and all three routes share one rate budget.
- While the sign-in is off, its three routes answer exactly as a path that does
  not exist: the same status and body, no rate bucket and no Origin check. They
  also do the same work as an unknown path, so the time an answer takes does
  not tell them apart.
- The two answers of a flow carry only what the browser tab needs: the address
  to go to and the verifier, then the session token. They are sent exactly as
  they were made.

A session issued this way has no local account behind it. It carries the role
the person's groups gave at sign-in, and the settings epoch it was issued under.
Every write to the settings raises that epoch. So changing a setting, turning
the sign-in off, and `ui oidc revoke` each end every such session on its next
request. `ui disable` ends them with every other session. The epoch is never
lower than the time of the write, so a settings file that was deleted and
written again cannot reach a value an earlier session still holds.

The login shown for such a person, and recorded as the actor of what they do,
is the address in their ID token: the `email` claim, then `preferred_username`.
An address the provider marks as not verified is not used, whichever claim
carries it. An address is used only when it is plain printable ASCII of at most
128 characters, well inside the 256 the audit trail keeps of an actor, so a
login holds no control character and is never cut short. A person with no
usable address is named `sub:` followed by the provider's own id for them. That
id must be printable ASCII of at most 124 characters, and a token with a longer
one is refused.

A console account's login can be an email address too, so the same text can
name a console account and a person who comes in through the provider. They
are two principals, and nothing confuses them. A session knows which it is: one
made through the provider is marked so, never reads `users.json`, and is not
ended by `ui user disable` or `ui user delete`, which end the console account's
own sessions; `ui oidc revoke` ends it. In the audit trail a record's
`sessionRef` leads to that session's `console.signin` record, whose `method`
says which way the person came in.

A setting typed at `ui oidc set` is recorded in the audit trail with its value,
except the name of the client secret. A key that is not a known setting, spelt
exactly, is recorded as unknown, with neither the key nor the value: the record
is written before the verb refuses the key, and a mistyped key is where a
pasted secret would otherwise end up.

A confidential client's secret is read by name, through the secrets boundary
described below. It is sent to the provider's token endpoint and nowhere else.

## Token lifecycle

| Token | Minted by | Carried in | Lifetime | Ends when |
| --- | --- | --- | --- | --- |
| Setup URL | `ui user create` / `ui user reset`, printed to the terminal | the URL **fragment**, so it never reaches a request line, an access log or a `Referer` | 24 hours | the password is set, a newer link is issued, or the account is disabled, deleted or reset |
| Setup URL (container bootstrap) | `FORTRESS_UI_BOOTSTRAP_USER` on a first boot — written to `<root>/ui/bootstrap-setup-link.txt` (0600) and **never printed**, because this console's stdout is pid 1's stdout. With `FORTRESS_UI_BOOTSTRAP_TOKEN_DIGEST` and `FORTRESS_UI_BOOTSTRAP_TOKEN_EXPIRES` beside it, the link was minted where HX Fortress was installed and only its digest is here, so **no file is written**: the link exists only where it was minted | the same URL fragment | 24 hours, or the end time the install gave, at most 24 hours ahead | as above |
| Session token | the sign-in that returns it | the `x-fortress-ui-token` request header, held in `sessionStorage` per tab | an absolute and an idle budget, both from `ui.json` | sign-out, either budget, a console restart, `ui user disable`/`delete`/`reset`, or a role change |
| Console grant | let.ai | the SSO exchange request body | minutes, set by the minter | it is exchanged once — `jti` is single-use |
| Sign-in flow state and PKCE verifier | this console, when a person starts a sign-in through the identity provider | the state rides the provider's redirect; the verifier stays in the tab's `sessionStorage`; both return in the request body that finishes the flow | 10 minutes | the flow has produced a session, the settings change, or the console restarts |
| ID token | the organization's identity provider | the token endpoint's response to this console; never the browser | minutes, set by the provider | it is verified once and dropped |
| Capability token | let.ai | `Authorization: Bearer` on the ingest/read gateway | minutes, set by the minter | its own expiry |
| Module grant | let.ai | the `grant` field of one ask, in a `moduleMessage` frame on the tunnel | at most 60 seconds from when it was issued | it is used once, or it expires |

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

A module grant is a third kind, with its own purpose. The gateway, the vault RPC
and the MCP tools refuse it by its purpose, the console door refuses it, and the
ask gate refuses a grant of any other purpose.

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

## The second step at sign-in

For the console's own accounts, when `secondStep` is `required`. Sign-in
through the organization's identity provider is not part of it.

- **What it is.** A time-based code (RFC 6238: HMAC-SHA1, 6 digits, 30-second
  steps). The step of the host's clock and one step either side are accepted,
  so the host's clock must be right to within about half a minute.
- **A code works once.** The last step an account used is written to
  `users.json`, under that file's lock, before a session exists. That step and
  every earlier one are refused from then on, also after a restart, and also
  for a second request that arrives at the same moment.
- **Between the password and the code there is a ticket, and nothing else.**
  A right password answers with a ticket and no session. The ticket is 32
  random bytes kept in the console's memory. It is good for five minutes, for
  the login it was made for and the network address it was made from, for
  five wrong codes, and for one session. It opens no route but the one that
  takes the code. A console restart ends every ticket.
- **How many codes can be tried.** A wrong code counts where a wrong password
  counts, by login and network address, with the same growing delay. That
  count alone would let a person who has the password try from many
  addresses, so there is a second one for the account as a whole: ten wrong
  codes in fifteen minutes refuse the second step of that account for fifteen
  minutes, from every address. No more than ten codes are judged in that
  window however many arrive at once: the count is read and kept in the same
  step that judges a code. It is saved with the lockout table, so a restart
  does not reopen it. `ui user reset` reopens it at once, for the new link's
  first code, and nothing a caller can do without a shell on the host does. A
  stranger cannot aim this at somebody: a code can be typed only after the
  right password.
- **An app is set up only from a one-time link.** The page that sets a
  password from a link also sets up the app, and the first right code writes
  the password, the app and the spent link in one write. A closed tab or a
  wrong code leaves the account as it was and the link alive. A right
  password for an account with no app is refused with one sentence, whether
  or not a link is waiting: the password alone never enrolls.
- **What a reply tells.** Nothing differs before the password is proved. A
  wrong code, an old one and one that was used already get the same sentence.
- **Where the key of an app rests.** In `users.json`, beside the password's
  argon2id hash, readable by HX Fortress's own user only. It has to be the
  key itself, because the console computes the same codes. Whoever can read
  that file can make codes for every account in it; they could already
  replace every password hash in it.
- **What is recorded.** A sign-in says that a second step was passed. Wrong
  codes are recorded as wrong passwords are: one record for a login, a source
  and a window, never one per attempt. Setting an app up and removing one are
  recorded. No record, log line or reply holds a key or a code, except the
  reply that shows a new key to the person who is setting it up.

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

The console has no configuration-write endpoint under any spelling, no account
management, and no way to change what the console itself is configured with.
Configuration, account lifecycle and SSO advertisement are terminal verbs, and
the command plane refuses a configuration key as a parameter.

One thing outside the console writes settings from a browser: the setup,
once. It is not a console route. It is a listener of its own, and the same
code serves it in two places:

- `hx-fortress setup --browser`, typed on the machine that runs HX Fortress.
  It refuses to run on an HX Fortress that is set up: one whose `config.json`
  holds its own settings. A container's entry point runs it when its volume
  holds no settings and its environment hands none over.
- `hx-fortress install`, typed on an engineer's own computer, before anything
  exists. It listens on that computer's own address only (`127.0.0.1`), and
  has no option that widens that. Its link names that address and never
  `localhost`: a name may be answered at `::1`, where the setup does not
  listen and another program on the computer could.

What the one-time setup can do is exactly this:

- **Be opened once.** Its link carries a 256-bit token in the fragment. On a
  host the link is printed to the terminal that started the setup, and
  `hx-fortress install` opens it in the engineer's own browser. In a
  container, and wherever the output is not a terminal, the setup on the
  machine itself writes it to a `0600` file, which `hx-fortress setup link`
  prints, and never to a log. The first browser to present the token gets a
  session secret, which lives in that tab and travels in a header, never in a
  cookie. The token is dead from then on, and a second browser is refused.
  The token is looked at before anything else, so no number of wrong links
  stands between the right link and its session. On an engineer's computer
  this is what stops another page in the same browser: a page of another site
  can send a request to the computer's own address, and without the session
  secret it is refused.
- **Give the answers, and have each one checked.** A check says what it
  found in a sentence this program wrote: a key is `Found` or not, a database
  is reached or refused. No reply carries a key's value, anything HX Fortress
  stores, or text an outside service sent. An address typed into it is called
  only as that question's check calls it, over https or on the machine itself.
- **Decide where a key is used.** A check uses a key as HX Fortress will: a
  database is opened at the address its key holds, and the AI model's key is
  sent to the model's address. So whoever holds the link can make the machine
  send any key it can read to an https address of their choosing, by answering
  so. The finished answers give the running HX Fortress the same instruction.
  This is why the link is held as a shell is.
- **Take a key that a person types, in the install only.** On the machine
  itself the setup has no field that takes a key's value: a key is given by
  its name. In `hx-fortress install` a person may type a key, because nothing
  holds it yet. It arrives in one request, is kept in the memory of that
  command under the path of its field, and is never part of the answers, of a
  settings file, of a reply or of a record. A reply says which fields hold a
  typed key, and no more. The page keeps the key in its field alone until it
  is sent: it is not in the page's state and not in an attribute of the field.
  The key is sent once to the provider it belongs to, at that provider's own
  address, in a header. The install's checks read no variable of the
  engineer's own shell that is addressed to HX Fortress, so a key or an
  address that the shell holds is never what is checked or where a key goes.
  A typed key has the name its field gives it: an answer that names another
  key drops the typed one, and so does a change of provider, so that no key is
  offered to a provider it was not typed for. On the last step it is handed
  once to the place that makes HX Fortress, which writes it to the key store
  the answers chose with the engineer's own access. Only a key whose field the
  final answers use is handed over: one typed for an option that was given up
  afterwards is forgotten with the rest. No file on the engineer's
  computer ever holds a key or an answer. One file exists there for a moment:
  the page that hands the link to the browser, in a folder only that user can
  read. The system's opener is given that file and never the link, because an
  argument of a command can be read by every process on the computer. The
  file is removed when the link is opened, and when the command ends.
- **Say yes to the last step, once.** The answers, and the typed keys, are
  copied when the last step begins, and the last checks and the making both
  work on that copy, so what is made is what was checked; a request that
  arrives meanwhile changes nothing. On the machine itself that writes
  `config.json` and the console's own settings. In the install it hands the
  place everything in one piece: the container's settings, the typed keys,
  and the plan a person saw. A control plane is connected only when the
  command named one with a one-time install id. On the machine itself the
  answers may name such an id in the key store instead; an install takes it
  from its command and from nowhere else. An HX Fortress that holds an enrollment with one
  control plane is not connected to another by an answer: that takes removing
  the enrollment by hand. The first administrator's account is made, and its
  one-time password link is shown on the last screen. In the install that
  link's token is made on the engineer's computer and stays there:
  HX Fortress is given only its sha256, and the time the link ends. The token
  is made once for an install: a second attempt after a failure hands over the
  same sha256, so the link on the last screen is the one HX Fortress answers
  to. Then the listener stops for good.

The setup on the machine itself listens where the console would, by the
console's own rule and inputs, and has no flag of its own that widens that.
Each route is held to the Host the request arrived on, and each write to the
page's own Origin. Because the answers decide who can sign in, where data
rests, where a key is sent and which control plane directs the work, the link
is as strong as a shell on the machine for as long as the setup is open. The
audit trail of the machine records that the link was opened, refused links,
which questions were written, and the login of the first administrator's
account when the setup made it. It records no other answer. Refused links are
recorded up to ten in ten minutes; past that a wrong link is still refused,
and not recorded, so a flood cannot fill the trail. An install on an
engineer's computer has no audit trail to write to: HX Fortress records its
own first start, with the questions that were written and the way they came.

**What an install hands over, and how.** The settings of the container are
plain: where it runs, its key store, its address, the name of the key that
holds its database's address, and one settings file with the answers an
administrator may change later. None of them is a secret, and that settings
file holds no key. Two things are secret and travel as the platform's own
secrets, never as plain settings: the one-time install id, and a typed key
when the key store is the container's own settings. HX Fortress reads the
settings file once, at its first start, checks every answer with the real key
store, database and network, and refuses to start on an answer that fails.

**Which pages may show a page of this HX Fortress.** One setting names the
origin of the control plane's pages (`controlPlane.pages` in `config.json`, or
`FORTRESS_CONTROL_PLANE_PAGES`). One function reads it, and it answers "none"
when the setting is absent, when it is not exactly one origin (a wildcard, a
path or a user name is refused), and whenever `config.json` names no control
plane, which is also the state of an HX Fortress whose connection is switched
off. A value in the environment that is not an origin decides "none": it does
not fall back to the file.

**A connection that is switched off stays off when HX Fortress starts.** An
install id that waits for its first connection, in its file or in the
variables of a container, is not used by a start while the setup's mark says
that an administrator switched the connection off and no credential is held.
Switching the connection on is what spends the id.

**The install id is on a command line.** The command a control plane shows
carries the one-time install id as an argument, so another user of the
engineer's computer can read it in the list of processes while the command
runs. It works once. Whoever read it would have to present it before the new
HX Fortress does at its first start, and the new HX Fortress would then not
be connected.

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

## What the connection carries

The connection to the control plane carries frames from one closed list, and
HX Fortress sorts each into a kind before anything else looks at it.
[README.md](README.md#the-connection-to-the-control-plane) has the list. This
section says what holds, and what does not.

- **With session content off, the connection refuses a session's text itself.**
  `FORTRESS_CONNECTION_SESSION_CONTENT=off`, or the same in `config.json`, makes
  the connection refuse every call that reads or writes a session and every call
  of a tool, before a module or a tool hears it. The refusal does not depend on
  what the control plane sends or on which modules are on. It is written to the
  audit trail, and it is counted.
- **The same switch closes the kinds that go with Agentic Sessions.** With it
  `off` or `on`, the member list is dropped and HX Fortress sends no count of
  sessions and no question of its own unless the Agentic Sessions module is on.
- **A choice that cannot be read stops the start.** Each of these stops the
  daemon, so a mistyped "off" is not read as no choice: a value that is neither
  word; a variable that is set and empty; a variable that is meant for HX
  Fortress and only looks like the setting; another key in the `connection`
  block; a block named `Connection` or `connections`; and the setting's name
  anywhere else in `config.json`, at any depth and in any spelling that keeps
  its letters. An enrollment refuses to write a new `config.json` over one whose
  choice it cannot read, and over one that is not valid JSON and mentions the
  setting. The runtime connects only with a config that says what the start
  decided.
- **One function sends.** Every frame leaves through one function with two
  callers. The first looks the frame's kind up and does not send a kind that is
  not carried: every frame from a module, a handler or the daemon goes through
  it. The second sends the answer to a refused call, and it builds that frame
  itself from the call's id: one fixed word.
- **A frame the list does not have is dropped.** A name that this build does not
  know reaches no handler. The table of kinds has one key for each frame of the
  protocol's own types, so a frame that is added to the protocol and not sorted
  into a kind fails the typecheck, which the repository's checks run.
- **The connection writes no text the control plane chose in full.** A count is
  keyed by a frame's name from the list. A refused session call is recorded
  under a method this build knows, or as `unknown`. An unknown frame's name is
  logged once, cut to 64 characters, for at most 32 names. A frame that is
  dropped for its size is logged by its name and its method only when this build
  knows them. A session call that fails is logged by a method this build knows
  and the first word of its error. The reason the control plane gives for
  refusing the connection is kept when it is one word of at most 128 characters,
  and replaced with `reason_withheld` otherwise. A protocol version that is not
  a whole number is said as "not a version number", and an organization's id
  that is not an id is logged as `not_an_id`.
- **No frame ends the daemon.** A session call with no request to read is
  answered `invalid_request`. A handler that throws on a frame is caught, and
  the log names the frame and the kind of error, never the error's text.

What it does not do:

- **The setting does not close the ingest gateway.** It is about the connection.
  With Agentic Sessions on and `FORTRESS_PUBLIC_URL` set, the gateway takes
  session uploads and serves session reads to a caller with a token the control
  plane signed, whatever the setting says. The daemon logs a warning at start
  when the setting is `off` and the gateway is on. An HX Fortress from which no
  session text may leave has Agentic Sessions off.
- **An HX Fortress where nobody chose serves session calls as before.** The
  setting has a third state, not set, for an HX Fortress that is older than the
  setting. A new one that `hx-fortress setup` sets up has it `off`. In the
  third state a call that reads or writes a session is served while
  the Agentic Sessions module is on. A grant on it is checked when the control
  plane sends one, and a call without one is served unless
  `FORTRESS_TUNNEL_GRANT_ENFORCE` is on. Such a call leaves no audit record. Set
  the setting to `off`, or to `on` where the control plane sends a grant with
  every call.
- **A call that is served under `on` is not written to the audit trail.** It
  must carry a grant that verifies. Two calls need none and read no session:
  `selfTest`, and the list of HX Fortress's tools. The Agentic Sessions module
  serves the call.
- **Not every slip of the hand is seen.** A name that is misspelled in its
  letters and is also in the wrong place, such as `sesionContent` at the top of
  `config.json`, reads as a key this build does not know, and such keys are
  kept as they are. `hx-fortress status` prints what the running daemon goes
  by, and the console's page of data paths shows it: check after a change.
- **The log of a tool call that fails is not covered.** It holds the tool's
  error, and a database's error can repeat part of what the call asked for.
  This is so with session content `on` or not set, and never with `off`, where
  no tool runs.
- **The Agentic Sessions module's own log is not covered.** It logs a call that
  fails with the method as the control plane sent it and with the error, and for
  a method it does not know that error holds the request. This is so with
  session content `on` or not set, and never with `off`, where no call reaches
  the module.
- **The setting is on HX Fortress's own host.** Whoever can write `config.json`
  or the daemon's environment can change it, from the next start.
  `hx-fortress status` and the console show what the running daemon goes by.
- **The counts are a file, not evidence.** They are written by the daemon, at
  most every 10 seconds, to a file its own user can change. Nothing signs them.
  A daemon that is killed loses up to 10 seconds of them, and up to 5 minutes of
  the counts of the frames it sends on a timer. A daemon that cannot read its
  counts file writes nothing over it and counts in memory, so those counts are
  lost if it stops before the file can be read.
- **The size limit is on what is parsed, not on memory.** With session content
  off and Agentic Sessions off, no frame over 256 KiB is parsed. Everywhere else
  the size is 32 MiB, or `FORTRESS_MAX_FRAME_BYTES`. A frame has arrived in full
  by the time HX Fortress learns its size. What goes out is bounded by the
  shapes of answers, not by a size limit on the frame.

## Modules, asks and releases

let.ai reaches a Fortress only over the connection the Fortress opened, and this
section calls it the relay. Beyond what the sections above describe, the relay
can do two things: send a module an ask, and offer a module a release. This
section says what stands between each of them and the organization's data.
[README.md](README.md#modules-asks-and-releases) gives the checks in order, the
kinds of value, the limits and the records.

**The Fortress never loads code from the relay.** Every module is compiled into
the `hx-fortress` binary. The connection to the relay has no way to load code:
it takes no loader, and no frame on it leads to an import. The source still
holds a class that can fetch a module's code and import it (`ModuleLoader`, with
its `importModule` hook). Nothing constructs it. Outside its own file it is
named once, on the line that exports it, and a test fails if that changes. A
release that the relay offers is a file. The
Fortress fetches it, checks it, stores it, and hands it to a module that was
already part of the binary. Nothing on that path imports, evaluates or runs the
file.

### The ask gate

In the daemon, every `moduleMessage` frame goes to one gate, and a module is
reached no other way. The daemon builds its connection to the relay in one
place and gives it the gate there, and a test builds the daemon the same way and
checks that it did. Before this gate existed, such a frame was handed straight
to the module it named, with no grant check at all. That path is closed: a plain
module message now reaches no module, `session_vault` included. Vault calls
arrive as `rpc` frames, as they did before.

- **The grant is required.** An ask with no grant is refused. No setting and no
  environment variable turns that into a warning.
- **The grant is bound to one ask.** It names the module and the ask, it commits
  to the arguments by a hash of them, and it was made to last at most 60
  seconds. The Fortress recomputes the hash from the frame that arrived.
- **An ask is for one organization, and the grant says which.** The grant is
  addressed to the organization this Fortress enrolled as, and it names the
  organization the ask is for. On a Fortress that holds one organization the two
  are the same, and a grant that names any other is refused. Where a Fortress
  holds more, the ask may be for an organization on the list in
  `organizations.json`, and for no other. For the ask, the module is handed
  that organization's state, secrets and records. Nothing it is handed for an
  ask lists or reaches another organization, and no call takes an
  organization's id. Whether the ask is for an organization this Fortress
  holds, and whether the module is on for it, are decided against one reading
  of the list. A secret's name is looked up later, when the module reads the
  secret, in the list as it is then. See
  [More than one organization](README.md#more-than-one-organization).
- **The list costs a grant that does not verify nothing.** The Fortress looks
  at the list as the last check of a grant, after its signature, purpose,
  module, ask, arguments and expiry. A grant that fails any of those is refused
  by that check, whatever organization it names, so how it is refused says
  nothing about which organizations the Fortress holds. One read of the file
  runs at a time, and asks that arrive meanwhile share the next one. The file
  must be a plain file of at most 8 MiB: a pipe, a device or a folder under its
  name is refused without being read.
- **Every record of an ask says whose it is.** From the moment the organization
  is known, the gate writes through that organization's writer and through
  nothing else. The mark is set in one place, after a record's parameters were
  held to their list, so no caller and no module can set, change or remove it.
  A refusal made before a grant verified names no organization: it is the
  Fortress's own record.
- **Only this host adds an organization.** The list is a file in the Fortress's
  folder. Nothing that arrives over the connection adds an organization,
  switches a module for one, or names a secret for one. A list that cannot be
  read, or that has one entry that is not valid, counts as no list: every ask
  for another organization is refused until the file is corrected.
- **A grant works once.** The Fortress remembers a used grant for five minutes
  past its expiry, so a grant cannot be used again at the moment it expires, or
  after the clock was set back by up to five minutes. When an ask runs, a digest
  of its grant's id is written to the audit trail, and the Fortress reads those
  digests back when it starts. A grant that ran an ask before a restart is still
  used after it.
- **Without a valid grant the relay cannot make this host work.** The arguments
  are hashed only after the grant's signature, purpose, module and ask have
  been checked, and after the check that it is addressed to this Fortress. Arguments too large to fit any ask are refused without
  being hashed.
- **A Fortress that cannot verify refuses.** With no pinned organization key, or
  before enrollment, every ask is refused.
- **The list is closed.** An ask is served only if the module's manifest lists
  it. The manifest is data in the binary, and `hx-fortress modules list` prints
  it.
- **An answer cannot hold a row, by construction.** An answer is made of eight
  kinds of value, and none of them is free text or bytes. The gate does not
  inspect the object a module returned. It builds a new value from the declared
  shape, out of values it has checked, and sends that. An extra key, a getter, a
  `toJSON` or a prototype on the module's object is therefore not sent. An
  object that throws while it is read is refused, and what it threw is dropped.
- **A switch is local.** An ask to a module that is switched off is refused, and
  nothing the relay sends can switch a module. An ask tells the relay whether a
  module is on only after the relay has shown a grant that is valid for that
  module and ask. A `config.json` that cannot be read refuses every ask and
  stops nothing.
- **The limits are exact.** At most 16 asks run at once, counted so that asks
  arriving together count each other. At most 300 start in any 60 seconds,
  wherever the 60 seconds begin.
- **A failure says one word.** A refused ask, a failed module and a refused
  answer each reach the relay as a short code. A message that a module threw is
  not sent and not written to the audit trail. The gate writes how an ask ended
  on every way out of it, the ones nobody foresaw included.

### The release shelf

- **An unsigned release is refused**, in every build and under every setting.
- **The signature covers what a person approves.** It is made over a statement
  of the module's id, the version, and the sha256 of the file, under a first
  line that marks it as a module's release. So the name and the version shown at
  approval are the signer's, not the relay's. A signature made for another
  module, another version or another file does not verify, and neither does one
  made over a file's own bytes, which is how a Fortress binary is signed.
- **The signature is made by a key the relay does not hold.** It is verified
  against the signing keys compiled into the binary.
- **The signature is checked first.** Nothing is downloaded before it verifies.
  Until it verifies, the relay is told nothing about which modules are on, which
  hosts the operator listed, or what is on the shelf.
- **A development key counts only when asked for.** While the build carries no
  production key, a release signed by the development key is accepted only with
  `FORTRESS_ALLOW_DEV_RELEASES=1`. Once the build carries a production key, the
  development key never counts.
- **The relay does not choose where the Fortress fetches from.** The file must be
  on the relay's own origin, or on a host and port the operator listed in
  `FORTRESS_RELEASE_HOSTS`. A listed host that is written as an address in a
  private, loopback or link-local range is refused all the same. A redirect is
  held to the same rule. The file is at most 64 MiB, counted as it arrives, and
  a compressed response is refused, because a small one could expand past that
  limit.
- **The file is held to the signed sha256.** A file with another sha256 is not
  the file that was signed, and is refused.
- **An offer installs nothing.** A verified release waits until a person on this
  host approves it. At approval the signature is verified again, against the
  keys this build and its settings trust at that moment, and the sha256 of the
  file on disk is checked again. Only then is the file handed to its module.
- **An approval is carried out once.** The request a terminal writes is removed
  before the Fortress acts on it, so a Fortress that stops while a module
  applies a release does not apply it again when it starts. While a module is
  still applying a release, nothing can be decided about that release.
- **What a refusal tells the relay.** The relay gets the rule that refused its
  offer. Before the signature verifies, a rule is about the signing keys in the
  binary. On a build with no production key it also shows whether development
  releases are allowed. After the signature verifies, the offer is a genuine
  release, and the rule can show whether its module is switched on, whether the
  host in its address is listed, and whether its version is already on the
  shelf. A relay that holds a genuine release can therefore learn those three
  things. Hiding the rule would not hide the first, because an offer that passes
  is followed by a download the relay can see.

### What a relay that has been taken over can and cannot do

The grant is signed with the organization's key, and let.ai holds that key. A
relay that has been taken over together with that key can therefore mint a valid
grant. The grant still stops everything short of that: a tunnel or proxy tier
that does not hold the key, a grant replayed from another organization, another
ask or other arguments, and a fault in let.ai's own code that sends an ask it
did not authorize. The table assumes the worse case, a relay that holds the key.

The key that signs releases is a different key. The relay does not hold it, and
the table assumes it still does not.

| It can | It cannot |
| --- | --- |
| send any ask that is on the list of a module that is switched on, up to 300 in any minute unless the operator raised that limit | reach a module that is switched off, or switch any module |
| learn everything those answers can hold. With `host` on, that is the Fortress version, the kind of key store it reads its secrets from, the logins of people who signed in to the console, the names of modules and releases, the kinds of console commands, and the time of each recorded act. With `databases` on, that is also the names of the organization's connections, their engines and states, whether each login may change anything, whether each link was encrypted and its certificate checked, and the names of their tables and columns, with each column's type as one word and each table's estimated number of rows | send an ask that is not on a list |
| offer a genuine release again, an old one included, to a module that is switched on and takes releases. The shelf shows its true module and version | get a row, a transcript, a file or free text in an answer |
| with a genuine release in hand, make the Fortress download up to 64 MiB from the relay's own origin, up to 6 times in any minute. A file that is not the signed one is discarded | approve a release, install one, or make the Fortress run anything |
| make the Fortress write audit records, at the bounded rate the README gives. On a host where nothing drains those records, enough of them push the oldest records of asks and releases off the disk (see the residual below) | put a release on the shelf that is unsigned, that is signed by a key the binary does not carry, or whose module or version is not the one that was signed |
| learn what the refusal of an offer shows (see "What a refusal tells the relay") | make the Fortress fetch from a host other than its own origin or one the operator listed |
| stop answering, and so stop asks and offers | write text of its choosing into the audit trail, or change a record |
| on a Fortress that holds more than one organization, send an ask for any of them. One key signs the grants for all of them (see the residual below) | add an organization, or send an ask for one that is not on this host's list |
|  | get the state, secrets or records of one organization handed to a module for an ask whose grant names another |
|  | remove a record on a host whose console drains the trail, or a record of any other kind on any host |

The line about text holds because of how records are written. A refusal records
a rule from a fixed list. A module's id or an ask's name is written only when
this build knows it; a name the relay invented is recorded as `unknown`, and the
name of an argument the relay invented is not recorded at all. A release's
version is written only after its signature verified, so it is the signer's
text.

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

## When a module grant can be shown a second time

The Fortress remembers which grants were used in the daemon's memory, and
restores from the audit trail the ones that ran an ask. Two cases are left.

A grant that verified and was then refused left no record to restore: the module
was off, the host was busy, or the arguments did not fit. If the daemon
restarts, the same frame can be sent again within what is left of the grant's 60
seconds, and it is examined again. It runs only if the reason it was refused is
gone. What that buys is one ask that let.ai authorized and that had not run.

A used grant is forgotten five minutes after it expires. If this host's clock is
then set back by more than that, a grant from before reads as not yet expired,
and it is no longer remembered as used. The relay cannot set this host's clock.

## A module grant names the organization, not one Fortress

A grant commits to an organization, a module, an ask and its arguments. It does
not name a Fortress. Each Fortress keeps its own record of used grants. So where
one organization runs two Fortresses, a grant minted for an ask to one is
accepted once by the other, within its 60 seconds, if the frame is delivered
there. Delivering it takes let.ai or a tier in front of it. The answer goes back
to the relay, about a Fortress of the same organization. Closing this takes a
claim in the grant that names the Fortress, which let.ai would have to mint.

## Organizations on one Fortress are kept apart by the Fortress's own code

This residual is about a Fortress that holds more than one organization. A
Fortress that holds one, as almost every Fortress does, has nothing to keep
apart.

- **One process, one user.** Every module runs in the Fortress's process, and
  every organization's files belong to the Fortress's user. The module host
  decides which state folder, which secret names and which audit records a
  module is handed for an ask. The operating system does not enforce that
  choice.
- **A module can list the organizations when it starts.** The context a module
  is started with can list the context of every organization the module is on
  for, for work that no ask started. A module that kept that list and used the
  wrong entry while answering an ask would mix organizations. A module's code
  ships in the binary, and nothing in the host stops it.
- **A module keys its own rows.** What a module writes outside its state folder,
  such as rows in a database, is kept apart by the module's own code, which
  writes the organization's id on every row. The module host cannot check that.
- **One key signs for all of them.** The grant for every organization on the
  list is signed with the key of the organization the Fortress enrolled as.
  Whoever holds that key can ask for any organization the Fortress holds.
- **The limits are shared.** The 16 asks at once, the 300 in a minute and the 60
  different refusals written in a minute are counted for the whole Fortress.
  Asks for one organization can use them up for the others. Past the 60,
  refusals for other organizations are counted together and attributed to none
  of them.
- **A line's id shows its place in the trail.** The id of a line from
  `audit.read` holds the position of its record in the Fortress's audit files,
  which all organizations share. The gaps between one organization's ids show
  how many records the others wrote.
- **The list is a file.** Whoever can write the Fortress's folder can add an
  organization, or give two organizations one secret name. That is the same
  person who can read every organization's state.

An organization that needs more than this runs its own Fortress.

## An answer is bounded in form, not in meaning

A `name` is up to 128 characters from a fixed alphabet. A module that put a
secret or a value from a row into a `name` field would pass the check on its
answer. The closed kinds bound how much can leave in one answer and in what
form. What each field means is decided by the module's manifest and its code.
Both are compiled into the binary, and both can be read in this repository.

## A module is not confined inside the process

A module is code in the daemon's own process. The context it is given refuses a
secret or a host that its manifest does not list, and a lint rule fails the
build when a module reaches the network another way. Neither stops code that was
written to get around them. The boundary against such code is that module code
arrives only inside the Fortress binary.

## Module code is as trustworthy as the binary it came in

Every module is compiled into the binary, so the question of who wrote a
module's code is the question of who made the binary. Today a release of the
binary is published without a signature. `hx-fortress update` checks the
download against a checksum published beside it, and verifies a signature only
when one is published. A checksum from the same place shows that the bytes
arrived whole. It does not show who made them. [RELEASING.md](RELEASING.md)
lists the steps that end with signed releases and a build that requires the
signature.

This is about the binary. A release for a module is a different thing and is
never accepted unsigned: a build with no production signing key accepts no
module release at all, unless development releases were switched on by hand.

## A signed release for a module does not expire

The signature on a module's release covers its module, its version and its
file. It carries no date. The relay can offer an old genuine release again. The
shelf shows its true version, and the person who approves decides. A module that
must never go back to an older release has to refuse one in its own
`applyRelease`.

## A listed host name is not checked for where it resolves

A module's manifest and `FORTRESS_RELEASE_HOSTS` list host names. A host that is
written as an address in a private, loopback or link-local range is refused. A
name is not resolved and checked. A listed name that resolves to an inside
address is dialed, over https, so the server there would need a certificate for
that name.

## With the `host` module on, audit lines and counts reach the control plane

The `audit.read` ask returns lines from this host's audit trail to the control
plane: who acted, on what, and when. That includes the login of each person who
signed in to the console. It also includes a line for each act that a person
had a module do: the person's login, the module and the act, and how it ended.
The hosts and the names of secrets that a person added are in the records on
this host, and not in a line. A sign-in that failed names nobody, because the
login in its record is whatever was typed into the form.

Two more asks return counts, and no line. `audit.count` says how often each ask
was allowed and refused in a period, by the module's id and the ask's name from
this build's own lists. `connection.count` says how many frames of each name
crossed the connection on each UTC day, for up to 400 days back. Together they
show the control plane how much an organization uses each module, day by day.
They hold no login, no row and no text that a person typed.

The module is off until an operator switches it on, and switching it off stops
the asks. It does not take back what was already sent.

## With the `databases` module on, names of tables and columns reach the control plane

The `catalog.read` ask returns the names of a connection's tables and columns,
each column's type as one word, and the engine's own estimate of each table's
rows. A name can say something about what an organization keeps. The other asks
return each connection's name and engine, whether its login may change anything,
and whether its link was encrypted and its certificate checked. No ask returns a
row, and no ask takes a statement: `hx-fortress modules list` prints every field
of every answer.

A table's or a column's name is sent only when it is a name as an answer can
hold one, at most 128 characters of letters, digits, space and `_ . : / @ -`.
Any other name is left out and counted, never rewritten. A name of that form can
still be chosen to carry a value: the check bounds what a name is made of, not
what it means.

With the `host` module on as well, a line of the audit trail about a connection
carries the connection's name. Such a line stays readable through `audit.read`
after `databases` is switched off.

The module is off until an operator switches it on, and switching it off stops
the asks. It does not take back what was already sent.

## A person's act crosses to the daemon on this machine

While a module that takes acts is switched on, the daemon listens on
`127.0.0.1`, on a port the system picks, for the console to hand it a person's
act. This listener is the door.
[README.md](README.md#an-act-what-a-signed-in-person-may-have-a-module-do)
says what the door checks. With no such module on, there is no door and no
file.

**Who can call it.** Any program on this machine can connect to the port. A
call is handed on only when it proves that it holds the door's secret, which is
in `runtime/local-door.json` and readable by the user HX Fortress runs as only.
So a program that runs as that user can call it, as it can read every other
file of this HX Fortress. A program that runs as another user cannot.

**The secret is not sent.** The console sends a number that it makes up for the
call, the time, the SHA-256 of the request's body, and an HMAC-SHA-256 of those
three with the request's method and path, keyed with the secret. The door
answers with an HMAC of the same number and the answer's body. The console
shows an answer only when that code is right. So what listens on the door's
port in the door's place learns no secret from the console, and cannot make an
answer that the console shows.

**A call is taken once.** The door takes a call only within 30 seconds of the
time the call carries, and it remembers the number of every call it took for
that long. So a request that somebody saw on its way to the door cannot be
sent to it a second time. The console and the daemon are on one machine and
read one clock. When the door remembers 65,536 calls, it takes no new one
until one of them is 30 seconds old: it never forgets a call early.

**A caller without the secret is answered from its headers.** The door checks
the code before it reads the request's body. So a program on this machine that
does not hold the secret cannot make the daemon hold bodies in memory.

**What a program in the door's place can do.** The console sends its request
when it has found the door's file and the daemon's process. In the moment a
door closes, a program that takes the door's port can be sent one request. It
is the person's request: who the person is, the act and its arguments. It holds
no secret and no secret's value. The same can happen while a door's file could
not be removed, which the daemon's log says, and which the daemon tries again
every 15 seconds. Such a program cannot make the console show a reply. By
answering with an error, by not answering, or by closing the connection, it
can make the console say `failed:internal`, `failed:timeout` or
`failed:interrupted` for that one request.

**A browser on this machine cannot.** A page cannot read the file. And a call
that carries a header a browser adds (`Origin`, `Sec-Fetch-Site`,
`Sec-Fetch-Mode`), or that names another host than the door's own address, is
turned away before the code is looked at. The second rule is for a page that
makes a browser resolve the page's own name to this machine.

**The console sends an act only to the daemon that is running now.** The file
can outlive a daemon that was killed, and the daemon's old port is then free
for any program on this machine to take. So before the console sends, it checks
two things: a process with the id in the file is running, and it is the process
that the daemon's own status file names with a heartbeat of the last 15
seconds. A process id alone would not do, because an id is given out again in
time. When the daemon stops in order, it removes the file before it stops
listening.

**A proxy does not see it.** Under Bun, `fetch` and `node:http` send a request
for `127.0.0.1` through the proxy that `HTTP_PROXY` names, with every header.
The console therefore opens the socket to this machine's own address itself. A
test sets the proxy variables and checks that nothing reaches the proxy.

**What is trusted.** The console signs a person in, and tells the daemon the
person's login and role, and an email when the login is an email address. The
daemon takes those on the word of whoever holds the secret, and it checks
everything else itself. The console holds the secret. So does every other
program that runs as the user HX Fortress runs as, because it can read the
file. Whoever holds it can act as any person, an operator included, and the
audit trail then names that person.

**What is recorded, and what is not.** The daemon records every act of an
operator before it runs, and the acts and the calls at the door that it turns
away. The README names two kinds of call at the door that are answered and not
counted. The console tells the daemon when a read-only person tries an act
of operators, and the daemon records that try. It tells it at most 30 times a
minute from one address, and not while the daemon is stopped: past that, a try
is refused and not recorded. A module's own try at a change that is not its
to make is recorded as the module's, with no person. The console's other
refusals
are not recorded, as they are not for any of its own routes: a caller with no
sign-in, a request from another site's page, a request past the rate, a body
that is not JSON, and a path that is no route. An act that every signed-in
person may do is not recorded one by one.

## An act that runs past its deadline is not stopped

An act has 25 seconds. After that the person is answered `failed:timeout`, and
for an act of operators the audit trail records the act as failed. An act that
every signed-in person may do has no record. The module's work is not stopped: it
goes on, and it may still do what was asked. For an act of operators, the
daemon writes one more record when that work ends, with how it ended
(`console.module.act.ended_late`). So a person who is told `failed:timeout`
has to look at what the act was to change, or at the audit trail, before they
do it again.

A reply that the daemon refuses is a like case. The word `reply_invalid` means
that the module's reply did not have its declared shape or was too large. The
act was carried out, and its reply is not shown.

## A person who adds a connection names a host and a secret

An operator at the console adds, for the `databases` module, a host with a port
and the name of a secret. A helper program is later sent to that host with that
secret's value as the login. Two rules bound what this can reach, and two
things they do not bound are stated here.

- **The host.** A loopback, link-local, unspecified or multicast address is
  refused, and so are `localhost` and the addresses and names of a cloud's
  metadata service that this build knows. That is a list, in
  `src/host/reach-address.ts`, and a list can miss one. A
  private address is taken, because a database is usually at one. The next
  section says what this check cannot see.
- **The secret.** A name that one of this HX Fortress's own settings names is
  refused: the name of its database's address, of its model's key, of its
  sign-in's client secret and of its own certificate. So is a name that
  `organizations.json` keeps another organization's secret under, and every
  name a manifest lists. Without this rule, an operator could name the secret
  that holds this HX Fortress's own database password, or another
  organization's login, and have it presented to a server of their choosing.
  The rule is applied when a name is added and again each time an added name
  is read. So an operator who adds, ahead of time, the name that the sign-in's
  secret is later kept under gains nothing by it. While a setting or
  `organizations.json` cannot be read, no added name is read.
- **What the rules do not bound: every other secret.** Every other secret in
  the key store that this HX Fortress may read can be named by an operator,
  and would be presented as a login to the host the same operator named. Keep
  in that key store, or give this HX Fortress's identity the right to read,
  only the secrets this HX Fortress is to use.
- **What the rules do not bound: who has a program sent there.** A person adds
  the host. After that, a job on that connection can be started by others than
  that person: by the control plane with the ask `test.start` and a grant, and
  by another module of this build that has a pull or a compare run on the
  connection. Adding a host allows all of these.

This build starts no helper program, so nothing is sent to an added host and no
added secret is read by one. The two lists are kept and shown.

## A host a person added is checked as text

The check of an added host looks at what was typed, and at nothing else.

- A DNS name is taken whatever it resolves to, except `localhost`, the other
  names that mean this machine in a common hosts file, and the names of a
  cloud's metadata service. A name can later resolve to an address the check
  refuses.
- The check does not know which machine it runs on. This machine's own address
  on its network, and its own host name, are taken like any other. So an
  operator can add this machine itself by that address.
- An IPv6 address that carries an IPv4 address inside it is judged by that
  IPv4 address where the address's form fixes its place. Two ranges do not fix
  it, and every address in them is refused: the local-use NAT64 prefix
  (`64:ff9b:1::/48`) and Teredo (`2001::/32`). An organization that reaches its
  databases through that NAT64 prefix cannot add them by such an address in
  this build.
- A network can also set a prefix of its own for reaching IPv4 addresses
  (RFC 6052). The check cannot know such a prefix. It takes an address under
  it, whatever IPv4 address that leads to in that network.
- The addresses of a cloud's metadata service are a list. An address that the
  list does not hold is taken.

The address a name resolves to has to be checked again when a helper program is
about to be sent there. That check comes with the change that starts helper
programs, and this build starts none.

## A query's text is scanned, and a scan cannot see everything

A query runs for a signed-in person, with a login that a test found can change
nothing, in a transaction the data runner rolls back. In front of both,
HX Fortress scans the statement's text. It refuses a text that is not one
statement starting with SELECT or WITH, or that holds a word that writes. The
scan reads the text only, so there are things it cannot see. The data runner
checks the statement again with the same rule before it runs it, and that check
reads the text only too:

- A function that does more than read: one that takes the next number of a
  sequence, waits, or calls out of the database. What such a function may do is
  bounded by the rights of the connection's login.
- On SQL Server, where two statements need no semicolon between them: a second
  SELECT after the first, and a second statement that starts with a word
  the scan does not refuse, such as SEND, RECEIVE or END.
- A statement that holds a lock, or waits, for as long as it runs. A job ends
  after two minutes.

So the login is the control. Give a connection a login that can read the tables
people may query and can do nothing else. A test asks the database what the
login may change, and HX Fortress runs no query on a connection whose login can
change something. The test does not look for a right to run a procedure or to
call out of the database.

On this build no query runs at all: the README says why.

## The audit trail of asks is bounded where nothing drains it

Records of asks and releases are written whether or not the console runs. The
console is what moves them into the database, and it removes each file an hour
after the file's last write. Where no console runs, or the console cannot reach
its database, the Fortress keeps the files of the last 65 minutes and about
16 MiB of older ones, and then removes the oldest file. It first writes a record
that names how many records the file held and from which period.

A relay that keeps sending asks can therefore push older records of asks and
releases off such a host. At the default limits that takes about two and a half
hours of asks with valid grants, or about eight hours of refused ones. It cannot
do that on a host whose console drains the trail: the Fortress removes no file
that such a console would still remove itself. And it cannot remove a record of
any other kind. The files of the terminal, the console and the daemon's commands
are not counted against this bound and are not touched by it.

## A person removed from a group keeps their session until it ends

With sign-in through the identity provider, the role is decided from the groups
in the ID token at sign-in. The console does not ask the provider again while
the session lives. A person removed from a group therefore keeps the session
for up to its lifetime: 12 hours, or 60 minutes idle, by default.
`hx-fortress ui oidc revoke` ends every such session at once.

## The login of a provider sign-in is what the provider says it is

The console cannot check the address in an ID token. At a provider where a
person can change their own address, one person can sign in and appear in the
audit trail under another person's address. Their role is not affected: it
comes from their groups. The record of each sign-in also carries the
provider's own id for the person (`subject`), which the person cannot change,
so the trail still says which account signed in. To name everybody by that id
and never by an address, set `loginClaim` to `sub`.

What the console does on its own: it does not use an address the provider
marks as not verified, as a login or as a group, and it does not use one that
holds anything but plain printable ASCII, so an address cannot be made to look
like another one with letters from another alphabet. The ASCII rule is applied
to the claim exactly as the provider sent it.

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

## The second step has no recovery codes

A person who loses the phone that holds the app cannot sign in until somebody
with a shell on the host runs `hx-fortress ui user reset <login>`. That is on
purpose: a recovery code is a second password that is written down somewhere.

## A person who has the password can hold up the second step

Ten wrong codes refuse an account's second step for fifteen minutes, from
every address. Somebody who knows the password, and nothing else, can keep
doing that. They get no session, the audit trail shows the wrong codes, and
the remedy is a reset: it reopens the second step at once and gives the
account a new password and a new app, so the password that was known no
longer works.

## An older build that rewrites `users.json` drops every second step

A build from before the second step rebuilds each account from the fields it
knows when it writes that file. After a roll back to such a build, its first
write removes every app, and the setting with it. Rolling forward again and
requiring the second step then asks every account for a new link.

With a `viewer` account in `users.json`, an older build does not get that far.
It does not know the role, so it refuses the file whole: no console account
signs in, and every `ui user` command fails, until the viewer accounts are
removed with this build (`hx-fortress ui user delete <login>`).

## The variables of a minted first link stay in the container's settings

`FORTRESS_UI_BOOTSTRAP_TOKEN_DIGEST` and `FORTRESS_UI_BOOTSTRAP_TOKEN_EXPIRES`
stay in the container's settings after the first account is made. If
`users.json` is lost before the link's end time, the next start finds no
account and makes it again from the same digest, and a link that was already
used works again until that time. Remove the two variables once the first
account has set its password.

## The identity provider's sign-in is not asked for a code here

Requiring the second step covers the accounts on this HX Fortress. A person
who signs in through the organization's identity provider is held to that
provider's own rules for a second step.

# Safe Harbor

We will not pursue legal action against researchers who act in good faith,
avoid privacy violations and service disruption, and give us a reasonable
opportunity to remediate before public disclosure.
