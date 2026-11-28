# HX Fortress

HX Fortress is an open-source program that an organization runs on its own
computers or in its own cloud. It keeps the organization's data, its keys and
its audit trail there, and it does the work on that data there.

- **It comes from this project and from nowhere else.** HX Fortress is
  installed from this project's releases and updated from them, or from an
  address the organization names. No other service takes part in either.
- **A control plane is optional.** A control plane is a service outside the
  organization that people use to direct the work of an HX Fortress. With no
  control plane, HX Fortress starts and runs on its own. With one, HX Fortress
  opens one connection to it, outbound. No control plane's address or key is
  written in this program: the address is the one in the command a person
  runs. [The control plane's keys](#the-control-planes-keys) says what
  HX Fortress keeps when it connects.
- **Its parts are modules.** Every module is compiled into the program and is
  switched on or off on the host. What a control plane can ask of a module, and
  how a release for one is approved, is described under
  [Modules, asks and releases](#modules-asks-and-releases).

This repository holds the whole program: the daemon, the command line that runs
it as a per-user service under launchd or systemd, and the administration
console that the same program serves, described under
[The administration console](#the-administration-console).
[SECURITY.md](SECURITY.md) states the threat model, and
[RELEASING.md](RELEASING.md) says how a release is cut.

## Get the program

There are three ways to get the program. All three come from this project: its
releases, its container image, or its source.

### From the project's releases

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/HX-Framework/hx-fortress/releases/latest/download/hx-fortress-install.sh | sh
```

The install script downloads the program for this computer, checks the
download against the checksum published beside it, and puts the program in
`~/.let/bin/hx-fortress`. On macOS it signs that copy for this Mac, with a
signature that names nobody. It asks for nothing, and it takes its files from
one place: the project's releases, or the address `--from` names. It asks that
place over https only, and follows a redirect only to https. Then it runs
`hx-fortress install`, which
[Install and set up HX Fortress](#install-and-set-up-hx-fortress) describes.

| Option | Variable | Meaning |
| --- | --- | --- |
| `--from <address>` | `HX_FORTRESS_FROM` | A base address that holds one release's files, in place of the project's releases. It must be https. |
| `--dir <folder>` | `HX_FORTRESS_BIN_DIR` | Where the program goes. |
| `--on-this-machine` | | Run `hx-fortress setup` in place of `hx-fortress install`: HX Fortress then runs on this machine. |
| `--program-only` | | Put the program in place, and start nothing. |

Options follow `sh -s --`. Every other option goes to the command the script
runs, as it is written. That is how the command a control plane shows names
that control plane:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/HX-Framework/hx-fortress/releases/latest/download/hx-fortress-install.sh | sh -s -- --connect control.example/i/<id> --pages https://app.control.example
```

**What the script leaves as it was.** Three checks come before the program on
this computer is replaced:

- An option the script passes on is checked against the options that command
  takes, before anything is downloaded. A mistyped option ends the script
  there.
- The program that was downloaded is asked for its commands. One that does not
  run on this computer, or a release from before the command existed, is not
  put in place.
- A program that is already here, and can say its version, is not replaced by
  an older one: HX Fortress may be running from it, on a database a newer
  version has already changed. The script asks it `hx-fortress version`, and
  the address then has to state which version it holds, as it has to for
  `hx-fortress update`. A program from before that command says nothing, so
  nothing can be compared, and the script replaces it. `hx-fortress update` is
  what keeps an installed program current.

**What the check proves.** The checksum shows that the bytes arrived whole. It
does not show who made them, because it comes from the same place as the
program. Two things show who made them:

- **The build record.** Each release's programs and its install script have a
  build provenance record: a signed statement of this repository, the workflow
  and the commit they were built from, made by the build and kept by GitHub.
  Check a file with
  `gh attestation verify <file> --repo HX-Framework/hx-fortress`. The record
  names each program twice: as the `.gz` file of a release, and as the program
  unpacked from it. So on Linux, and after `hx-fortress update` on any system,
  the program in place can be checked as it is:
  `gh attestation verify ~/.let/bin/hx-fortress --repo HX-Framework/hx-fortress`.
  On macOS the install script signs its copy for that Mac, which changes the
  file. There, download the `.gz` and check that.
- **The release signature.** `hx-fortress update` verifies a release's
  signature when the release has one. [Update](#update) says what is signed
  today.

A control plane may show an install command of its own, which takes the
program from an address that control plane names. The build record is how you
tell whether such a program is one this project built, checked as above.

### As a container

The image is `ghcr.io/hx-framework/hx-fortress:<version>`. Pin a version.
[Running as a container](#running-as-a-container) has the environment it reads
and the volume it needs, and `deploy/azure/` holds a template for Azure
Container Apps.

### From the source

```sh
git clone https://github.com/hx-framework/hx-fortress && cd hx-fortress
./install-from-source.sh
```

The script builds `hx-fortress` with [Bun](https://bun.sh), which it offers to
install when it is missing, and puts the result in `~/.let/bin/hx-fortress`,
signed for this Mac on macOS. It downloads nothing but the build's own
dependencies. Then it does what the install script of a release does: it runs
`hx-fortress install`, and it takes `--dir`, `--on-this-machine`,
`--program-only` and the options of that command in the same way, checked
before anything is built. One more option enrolls with a control plane the way
an earlier version did:

```sh
./install-from-source.sh --cloud <the control plane's address> [token]
```

## Install and set up HX Fortress

HX Fortress asks one short list of questions before it runs. There are two
places to answer it, and both ask the same list.

**From your own computer, for a cloud account or a machine with Docker.**
`hx-fortress install` serves the setup in your browser, on your computer only.
Nothing exists when it starts. Each page comes with an answer already chosen,
so most pages need only Continue. The last step shows everything the answers
add up to and asks once. On your yes it makes HX Fortress in the place you
picked, with the sign-in your computer already holds there. Until you say yes,
nothing is made, and nothing is on the internet.

```sh
hx-fortress install                 # in a browser, on this computer only
hx-fortress install --terminal      # in this terminal
hx-fortress install --file <path>   # from a settings file
```

Which places an install can make HX Fortress in depends on the build:
`hx-fortress install --list` prints the questions and options for each place,
and the first page offers only the places this build has. A build that has
none says so and ends.

**On the machine that runs HX Fortress.** `hx-fortress setup` asks the same
list there, without the question of where it runs, and writes the settings on
that machine.

```sh
hx-fortress setup                  # in this terminal
hx-fortress setup --browser        # in a browser, once, from a link printed here
hx-fortress setup --file <path>    # from a settings file
```

Every answer has a plain option that needs no cloud account, and that option
is the one a setup on the machine itself starts on.

**A control plane is optional, and nobody is asked about one.** HX Fortress
with no control plane starts and runs on its own. A control plane writes its
address and a one-time install id into the command it shows you:

```sh
hx-fortress install --connect control.example/i/<id> --pages https://app.control.example
```

The id works once. HX Fortress presents it the first time it connects, and
from then on it holds a credential of its own. Nobody signs in anywhere to
join it, and nobody has to confirm anything. `--pages` names the one origin of
the control plane's own pages, and HX Fortress keeps it as a setting. A page
of HX Fortress that is shown inside another page goes by that setting: only
that origin may show it, and without the setting none may.

**Keys.** Each answer is checked when it is given, and a wrong one is refused
in a sentence that says why. On the machine itself a key is always given by
its name in the key store: the setup never asks for a key's value there, and
never shows or stores one. A check uses a key as HX Fortress will: it opens
the database at the address the key holds, and sends the model's key to the
model's address.

In `hx-fortress install` you may type a key itself, such as the key of your
AI provider. It is kept in the memory of the command, sent once to that
provider's own address to see whether the provider takes it, and written once
to the key store you chose, with your own access. It is in no file on your
computer, in no settings file and in no log. HX Fortress then reads it by
name, like every other key.

**What the environment decides.** A setting in the host's environment decides
its answer, as it does for HX Fortress itself. The setup shows that answer as
set by the host and does not change it. This is also how an install tells
HX Fortress the facts of the place it made: where it runs, its key store, its
address and its database are in the container's own settings, and the install
command is what changes them.

| Command | What it does |
| --- | --- |
| `hx-fortress setup --list` | prints the questions and the options this build has for each |
| `hx-fortress setup --print` | writes the present answers as a settings file |
| `hx-fortress setup check` | checks every answer again |
| `hx-fortress setup <question>` | asks one question again, by the name `--list` gives it |

When HX Fortress starts, it checks again what the host can see by itself, and
names an answer that no longer holds in its log. A start sends nothing for
this. The Checkup makes the checks too, and also asks the sign-in provider and
the key store whether what the answers name is still there.

The browser setup on the machine itself runs once, on an HX Fortress that has
never been set up, and stops when it ends. It listens where the console would.
In a container the entry point runs the setup when the volume holds no
settings: from the settings an install handed over in `FORTRESS_SETUP_SETTINGS`,
or from the file that `FORTRESS_SETUP_FILE` names, or else in a browser. The
link is never printed in a container: print it with `hx-fortress setup link`
inside the container. What the link can and cannot do is in
[SECURITY.md](SECURITY.md#what-a-browser-can-change).

An install made before the setup existed needs nothing: its `config.json` is
read as the answers, and it is not held to questions nobody asked it. Running
`hx-fortress setup` on it asks them.

## Update

```sh
hx-fortress update
```

`update` downloads the newest version, checks it, and swaps it in for the
program that is running. If HX Fortress runs as a service, the service is then
restarted onto the new program. The console's Ops Tools page offers the same
step.

**Where a new version comes from.** From this project's releases, or from an
address the organization names. Never from a control plane: an HX Fortress
that is connected to one updates exactly as an HX Fortress with none.

| Setting | Meaning |
| --- | --- |
| none | The project's releases: `https://github.com/HX-Framework/hx-fortress/releases/latest/download`. |
| `"updates": { "from": "own-address", "address": "https://…" }` in `config.json` | A base address of the organization's own. |
| The same `updates` block in a settings file | The same, given to `hx-fortress setup --file <path>`, which writes it to `config.json`. A file that names no source leaves the present one as it is, and `"from": "project-releases"` goes back to the project's releases. |
| `FORTRESS_UPDATE_URL` | The same, set in the environment the daemon runs with: its service, or its container. It wins over `config.json`. |

- The address is named on the host. No page of the setup and no page of the
  console asks for it or changes it, because it decides where the program
  itself comes from. The setup's Updates page shows it, and its Network page
  lists its host.
- An address must be https, with no user name, password, `?` or `#` in it.
- A setting HX Fortress does not understand stops the update and names the
  setting. It is never read as "the default". An `updates` block in
  `config.json` that cannot be understood also stops the daemon at its start,
  as every block of that file does, and stops an enrollment that would write
  the file anew. A `FORTRESS_UPDATE_URL` that cannot be understood does not
  stop the daemon: it says so in its log, and an update is refused until the
  variable is put right. One start is the exception: a start that has to
  download the pgvector files stops, because that address is where they come
  from. The setup shows such a setting as not known. A variable that is wrong
  does not stop a save there, because nothing the setup writes changes a
  variable. A block of `config.json` that cannot be read does: the setup says
  so, and a settings file that names the source
  (`"updates": { "from": "project-releases" }`, or `own-address` with an
  address) replaces the block.
- The daemon, a terminal and the console may each run with another
  environment, and the service that `hx-fortress start` installs carries none
  of the terminal's variables. So the daemon writes down what its own
  environment names (`runtime/daemon-environment.json`), and while that daemon
  runs, the setup, the console and `hx-fortress hosts` show what it goes by.
  `hx-fortress update` in a terminal uses the terminal's own
  `FORTRESS_UPDATE_URL` when it has one, and otherwise follows the running
  daemon. If the daemon is stopped and its environment last named another
  address than the one the terminal works out, the update is refused: nothing
  can tell whether the variable is still set. Give the address to the command,
  or start HX Fortress first. No setting is wrong in that case, and nothing
  says so: the setup shows what `config.json` holds with a line about what is
  not known, and the console asks no address for a version until HX Fortress
  runs again.
- `hx-fortress update` prints the address it uses as its first line. It reads
  its settings from the folder the service runs with, and refuses when the
  terminal's folder (`FORTRESS_ROOT`) is another one.

**What a base address holds.** One release's files, found by name:

| File | What it is |
| --- | --- |
| `hx-fortress-version` | The version, as text. |
| `hx-fortress-<os>-<arch>.gz` | The program, gzipped. `<os>` is `linux` or `darwin`, `<arch>` is `x64` or `arm64`. |
| `hx-fortress-<os>-<arch>.sha256` | Its checksum. |
| `hx-fortress-<os>-<arch>.sig` | Its signature, when the release is signed. |
| `pgvector-pg<major>-<platform>.tar.gz`, with `.sha256` and `.sig` | The pgvector files for the Postgres that runs on HX Fortress's own disk. |
| `hx-fortress-install.sh`, with `.sha256` | The install script. |

So an organization that keeps its own copy puts one release's files in one
folder, serves the folder over https, and names its address.

**What is checked.** The update source must say which version it holds, in
`hx-fortress-version`, and that version must be newer than the one that runs:
an update never goes back, and a source that does not answer with a version is
not asked for a program. That statement is the source's own, in a file that
carries no signature. The download must match its checksum. If the release has
a signature, it must verify against a release key compiled into the program
that runs, or nothing is installed. A release with no signature is installed with a
warning, until this project publishes signed releases and the program requires
them. [RELEASING.md](RELEASING.md) lists those steps, and
[SECURITY.md](SECURITY.md#module-code-is-as-trustworthy-as-the-binary-it-came-in)
states the gap.

**What it reaches.** With the project's releases: `github.com`, and the hosts
GitHub serves a release's files from. With an address of your own: that
address, and any https address it answers a file's request with. The Postgres
that runs on HX Fortress's own disk is downloaded once, from `repo1.maven.org`
or from `FORTRESS_PG_BINARIES_URL`. Every one of these downloads follows a
redirect only to https, and never to an address in clear text. The pgvector
files of that Postgres are files of a release too. They come from the release of the version that runs, because they are
built for its Postgres and signed with its keys: from the project's releases,
from the address of your own, or from `FORTRESS_PGVECTOR_URL` when the host
names an address for them alone. They are downloaded once, and only when a
module that is switched on searches. The console's Posture & Audit page lists
these addresses under Downloads. `hx-fortress hosts` prints the host of the
update source and the host of the Postgres download. An address named for the
pgvector files alone is in the Downloads row only.

A container is updated by deploying a newer image. `hx-fortress update` is for
an install on a host.

### Updating from a version that downloaded through a control plane

Earlier versions took a new version through their control plane. An
HX Fortress that updates from one of them changes in four ways:

- **It downloads from the project's releases.** The host has to reach
  `github.com` and the hosts GitHub serves a release's files from, or name an
  address of its own with `FORTRESS_UPDATE_URL`. The pgvector files come from
  the same place.
- **It holds no key of its control plane.** Earlier versions carried one in the
  program. An HX Fortress that is connected keeps working after the update:
  the organization's key it pinned stays pinned. It refuses a change of that
  key until the control plane's key is named on the host or pinned with
  `hx-fortress control-plane pin`.
- **One residency verdict has a new name.** A session that is held here and also
  at the control plane is stored as `also_at_control_plane`. The findings that
  were already stored are renamed by the update. The sentence stored with each
  of them changes at the next audit run.
- **New audit records name the person at the control plane as
  `controlPlaneSub`.** Records written earlier keep their earlier key.

## The control plane's keys

HX Fortress connects to a control plane when the command that installs it or
sets it up names one, with `--connect <address>/i/<id>`:
[Install and set up HX Fortress](#install-and-set-up-hx-fortress) says how.
The way of an earlier version still works:

```sh
hx-fortress enroll --cloud <the control plane's address>
```

The terminal prints a link and a short code. The same person opens the link,
signs in at the control plane and confirms the code. A control plane can also
hand out a one-time enrollment token:
`hx-fortress enroll <token> --cloud <address>`. Here the address is the whole
connection address the control plane gives, such as
`wss://control.example/v1/connection`.

Either way it is done once. After it, HX Fortress keeps one connection to that
address open, and opens it again when it drops. What HX Fortress keeps, all
under its own folder and readable by its own user only:

| It keeps | In | What it is for |
| --- | --- | --- |
| The address | `config.json`, `cloud.url` | Where to connect. |
| Its credential | `identity/credentials.json` | It shows this when it connects again. |
| The organization's key | `identity/signing-key` | The control plane signs every grant with it. HX Fortress pins it the first time it sees it, and checks every grant against it, offline. |
| The control plane's key | `identity/control-plane-keys.json`, or a setting | A later change of the organization's key is taken only with a proof made with this key. |

**The control plane's key.** No key of any control plane is compiled into this
program. HX Fortress learns the key of its control plane in one of three ways,
in this order:

1. **The organization names it where the daemon runs**, in
   `FORTRESS_CONTROL_PLANE_KEY` as `<id>:<public key>`. Then that is the key,
   and nothing a control plane publishes changes it. The variable has to be in
   the daemon's own environment: a container's, or the service's. The service
   that `hx-fortress start` installs carries none of the terminal's variables,
   so on such a host the next way is the one to use.
2. **A person pins it on this host**, after comparing its fingerprint with what
   the control plane states about itself: `hx-fortress control-plane pin`. It
   needs no variable, and it can be done before the first start: with the
   control plane's address in place and nothing enrolled yet, the pin is there
   when HX Fortress enrolls.
3. **HX Fortress pins the key the control plane publishes at its first
   enrollment**: when it presents a one-time token and holds no key of the
   organization yet. Nobody compares a fingerprint then, so HX Fortress writes
   the fingerprint to its log and to its audit trail. This happens once, or
   never. After the first enrollment nothing a control plane sends or publishes
   pins a key, because a key fetched then would be chosen by whoever asks for
   the change it is meant to check.

```sh
hx-fortress control-plane                                  # the address, the organization, the pinned keys
hx-fortress control-plane pin                              # show what the control plane publishes now, ask, pin
hx-fortress control-plane pin --fingerprint "<fingerprint>"   # pin exactly this key, with nobody at the terminal
hx-fortress control-plane unpin                            # stop trusting the pinned key
```

A fingerprint is the first 128 bits of the SHA-256 of the key, written as eight
groups of four hex digits.

`hx-fortress control-plane` shows what the daemon that runs goes by: the key
its environment names when it names one, and the pin otherwise.

Each pin is written to the audit trail, with the control plane's address, the
key's id and its fingerprint: `cli.control_plane.pin` and
`cli.control_plane.unpin` for a person at the terminal, and
`system.control_plane.key` for the pin HX Fortress makes at its first
enrollment, or for the reason it could make none.

**An HX Fortress that pinned no key keeps working.** The organization's key it
already pinned stays pinned, and grants are checked against it as before. What
it refuses, with no key to check a proof against, is a change of the
organization's key. That is the state of an HX Fortress that connected before
this program stopped carrying a control plane's key, of one whose control
plane published no key when it first enrolled, and of one whose control plane
could not be asked at that moment. After `hx-fortress control-plane pin`, the
change is taken at the next connection.

**What a control plane publishes.** `GET <base>/control-plane-keys`, where
`<base>` is its address with `https` for `wss` and without its last path
segment. For `wss://control.example/v1/connection` that is
`https://control.example/v1/control-plane-keys`. The answer is JSON:

```json
{ "v": 1, "keys": [{ "id": "cp-2026-11", "publicKey": "<base64url, 43 characters>" }] }
```

`publicKey` is the raw 32-byte Ed25519 public key. A control plane lists the
key it signs with now, and may list the one it moves to next, four at most.
`404` means it publishes none. A redirect is refused: the key has to come from
the address HX Fortress connects to.

## Commands

`hx-fortress` with no arguments opens the terminal dashboard, and
`hx-fortress help` prints the whole surface. The groups are:

```text
hx-fortress      install · setup · enroll · start · stop · status · logs · update · version · credentials set
                 modules list|on|off · releases list|approve|refuse · hosts
                 control-plane · control-plane pin · control-plane unpin
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

The console is a **separate process from the daemon**. The daemon owns the
connection to the control plane, the ingest gateway, Postgres and the object
store; the console owns a
listener, a set of local accounts and its own audit spool. That separation is
what lets the console render a stopped daemon and offer to start it, and it is
why the two are enabled, configured and supervised independently.

### Reaching it

**One click from the control plane.** A control plane can show its people a
button that opens this console. It can do so once this HX Fortress has
advertised a console URL, which needs all three of `hx-fortress ui sso on`, an
https public URL, and the console enabled. The advertisement is recomputed on
every reconnect, so `ui sso off` clears it on the next one — and does not unsend
what has already been sent. Who sees the button is the control plane's to
decide; operators and auditors who do not see it receive the console URL from
the administrator who created their account, alongside their setup link. The URL
is organization infrastructure rather than a secret, and on its own it conveys
nothing.

**SSH and `hx-fortress ui`.** The path that needs no control plane, and the one
to use when the control plane is unreachable. Forward the port and run the
console in the
foreground:

```sh
ssh -L 8788:127.0.0.1:8788 <fortress-host>
hx-fortress ui
```

Then open `http://127.0.0.1:8788`. The console prints the URL to reach it on,
along with the disclosure of what a console login grants.

Neither path is an entry in itself. An arrival from the control plane lands on
the console's sign-in form: the grant it carries names the person's identity at
the control plane for the audit trail and mints no session, no token and no
read. Every session belongs to a fortress-local account.

### Accounts

Accounts are created from the terminal, and only from the terminal:

```sh
hx-fortress ui user create marta.lindqvist@northstar.example --role operator
hx-fortress ui user create audit-bot --role readonly
hx-fortress ui user create lena.hart@northstar.example --role viewer
hx-fortress ui user list
hx-fortress ui user disable audit-bot
hx-fortress ui user reset marta.lindqvist@northstar.example
hx-fortress ui user delete audit-bot
```

A login is a short name (2 to 64 lowercase letters, digits, dots, dashes or
underscores) or an email address in lowercase.

There are four kinds of people, and three kinds of account. The commands use
the account's name in code:

- Administrators and Operators: `operator`. They reach every surface of the
  console and its write routes.
- Auditors: `readonly`. They reach every read surface of the console and see
  the same numbers; a control they may not use is disabled, carrying the
  server's own refusal.
- Viewers: `viewer`. A Viewer sees rows in Secure Data Islands, changes
  nothing, and opens nothing in the console. This build serves no Secure Data
  Island yet, so today a Viewer can prove who they are, exactly as the others
  do, and open nothing.

Administrators, Operators and Viewers see rows in a Secure Data Island;
Auditors do not.

**No password is ever typed at a terminal.** `user create` and `user reset`
print a one-time setup link instead, and the person opens it and sets their own
password in the browser. The token rides the URL *fragment*, so it never reaches
a request line, an access log or a `Referer`; it lasts 24 hours, dies once the
password is set, and completion requires a POST so a link preview cannot consume
it. What the old password does after `user reset` depends on the second step
(below). With it off, the old password keeps working until the new link is
used, because a reset that locked someone out the moment it was issued would
strand them if the link never arrived. With it required, a reset removes the
account's app, and the old password then signs in nowhere until the new link
is used: the link sets a new password and a new app.

**A code after the password.** With the second step required, signing in to
an account on this HX Fortress takes two things: the password, and a 6-digit
code from an authenticator app.

```sh
hx-fortress ui config set secondStep required
hx-fortress ui config set secondStep off
```

- An HX Fortress set up by `hx-fortress setup` while it has no console account
  starts with it required. One that already has accounts keeps its setting,
  and running the setup again never changes it. An install from before the
  setup keeps it off until somebody sets it.
- The app is set up on the page that sets the password, from the one-time
  link. The page shows a QR code, and the same key as text. The first right
  code saves the password and the app together. Until that code nothing is
  saved, and the link still works.
- The password alone never sets up an app. An account that has a password and
  no app, which is every account on an install that switches the setting on
  later, signs in again after a new link: `hx-fortress ui user reset <login>`.
  So a password that leaked cannot be turned into a second step by whoever
  holds it.
- `user reset` removes the app. The old password then signs in nowhere until
  the new link is used, which sets a new password and a new app. A reset also
  reopens an account's second step that too many wrong codes closed. `user
  list` says for each account whether it has an app. There are no recovery
  codes: a person with a shell on the host resets the account.
- Sign-in through the identity provider is not asked for this code. The
  provider's own second step applies there.

Sessions live in the serving process's memory: 12 hours absolute and 60 minutes
idle by default, both configurable, and a console restart ends every one of
them. `user disable` and `user delete` end that account's live sessions on their
next request. An account that is deleted and made again under the same login
starts with none of the earlier account's sessions. A login that is an email
address can be the same text as the login of a person who signs in through the
identity provider. They are two principals: `user disable` and `user delete`
end the console account's sessions and not that person's, which
`hx-fortress ui oidc revoke` ends.

### Sign in with your identity provider

A console can also sign people in through the organization's own OpenID Connect
provider: Microsoft Entra ID, or any provider that publishes a standard
discovery document. It is off by default, and it is switched on from the
terminal of this host. The provider is yours. A control plane takes no part in
this sign-in, cannot switch it on and cannot change its settings.

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
| `administratorGroups` | The Administrators' groups. Comma-separated, so a group written here cannot hold a comma: use the group's id. A person in any of them gets what a local `operator` account gets. This build has no kind above `operator`; the list is kept apart from `operatorGroups` so the two can be told apart once it has. |
| `operatorGroups` | The Operators' groups. Comma-separated. A person in any of them gets what a local `operator` account gets. |
| `readonlyGroups` | The Auditors' groups. Comma-separated. A person in any of them, and in no administrator or operator group, gets what a `readonly` account gets. |
| `viewerGroups` | The Viewers' groups. Comma-separated. A person in any of them, and in none of the groups above, is a Viewer (`viewer`): the console opens nothing for them. |
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

Each sign-in the provider vouched for is noted in
`$FORTRESS_ROOT/ui/provider-people.json`, mode `0600`, for the `access.groups`
ask of the `host` module (see
[What the control plane may ask](#what-the-control-plane-may-ask-the-host-module)). The
console is its only writer.

- For each person it keeps their last sign-in only, for 90 days, and only as
  digests: of the provider's address and its id for the person, of the
  provider's address alone, and of each group of the four lists that the token
  carried, with the time. It holds no login, no address, no id of a person and
  no group's name, also when `groupsClaim` is `email`.
- Every sign-in the provider vouched for is noted, whatever came of it: a
  Viewer, whom the console refuses, holds a role. A person whose token carried
  no mapped group, or no groups claim at all, holds none now, and is removed.
- It keeps at most 100,000 people, and never grows past 48 MB. Past either, the
  oldest sign-ins are left out first. A sign-in older than 90 days is dropped
  at the console's next write, when the console reads the file, and by its
  sweep once a day while it runs, also while nobody signs in. While the console
  is not running, nothing is dropped until it starts.
- The console reads the file when it starts, keeps the people in memory, and
  notes a sign-in there without the sign-in waiting. It writes the file within
  30 seconds, and when it stops. A sign-in that changes nothing within a day
  (the same groups, noted less than a day before) is not written again. A note
  still in memory when the console is killed is lost, until that person signs
  in again.
- A write that fails is tried again, and does not stop any sign-in. The
  console's log says so once, and again only after a write succeeded in
  between.
- When the file is there and cannot be read, the console does not start it
  again: that sign-in is not noted, the log says so, and the next sign-in reads
  the file again. A damaged file makes `access.groups` fail until the next
  sign-in through the provider starts it again, at the console's next write.

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
| Adoption | `/people` | who in the organization is covered | the roster the control plane sent, and this host's own session rows — kept apart, never blended |
| Residency | `/residency` | does this host hold what it is supposed to | an audit the daemon runs; routing posture from the cached answer of the control plane |
| Posture & Audit | `/compliance` | where data enters and leaves, and who did what | data paths computed from the effective configuration; the admin trail from Postgres, falling back to the on-disk spool |
| Postgres | `/postgres` | is the database up, and how large | the daemon's status file, and Postgres itself |
| Object storage | `/storage` | which bucket this fortress writes to, and every storage migration it has run | the bucket the storage credential names, and migration runs from Postgres. The console builds no store handle of its own, so versioning and lifecycle report as unreadable rather than guessed |
| Embeddings | `/embeddings` | how much is embedded, under which model | Postgres row counts; the vector column is never selected |
| Ops Tools | `/ops` | do something, and see what came of it | the command queue in Postgres, corroborated against the audit spool; the update source for the version check |
| Logs | `/logs` | what the daemon is saying | a live tail of the daemon's structured log file |
| Databases | `/databases` | which databases this HX Fortress connects to, and where each one stands | the `databases` module in the daemon, through its acts. See [The Databases page](#the-databases-page) |

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
from the control plane older than 15 minutes is labelled stale rather than
presented as current, and a residency roll-up that could not reach the control
plane is never called clean.

Sessions belonging to another organization are counted so the totals reconcile
against the bucket, and their metadata is not shown.

### Adoption, and what a coverage figure means

Adoption is a funnel of five stages, and every stage carries the source it was
computed from — because the control plane knows who the organization employs
and what they have installed, and only this host knows what actually arrived
here. A stage
with two sources would be a figure nobody could reconcile against either.

| Stage | Counts | Attested by |
| --- | --- | --- |
| On the roster | active members the control plane reports for this organization | the control plane |
| Client installed | members with at least one active install, counted by machine | the control plane |
| Backfill reported complete | members whose most recent backfill report has nothing outstanding | the control plane |
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
the control plane — asks the control plane whether it still holds a copy.

It runs when an operator asks for one, from Residency or the command plane.
There is no timer: a run walks every session and stats objects in the bucket,
and doing that on a schedule nobody was reading would spend the storage budget
on an answer no one asked for.

| Verdict | What it means | Acknowledgeable |
| --- | --- | --- |
| `confirmed` | held here, and the control plane reports no copy | — |
| `also_at_control_plane` | held here, and the control plane holds a historical copy | yes |
| `not_delivered_here` | the control plane recorded this HX Fortress as a destination and the object never arrived | **no** |
| `no_record` | uploaded before the control plane recorded per-destination delivery | — |
| `unknown_provenance` | the row predates channel tracking, or was recovered after an index outage | — |
| `not_applicable` | uploaded straight to this HX Fortress; the id was never sent to the control plane | — |

`not_delivered_here` is the incident: something that should be on this fortress
is not. It is never downgraded by an acknowledgement — an acknowledgement
explains why a copy exists somewhere, and no answer to that makes a missing
object present. `also_at_control_plane` is separate and weaker: the object *is*
here, and bytes at the control plane either predate this HX Fortress or belong
to a session also attributed to an organization the control plane hosts. Per
session it fails the check until acknowledged; in the fleet roll-up an
acknowledged one qualifies the verdict rather than failing it.

**Only a session that came through the control plane is ever named to it.** A
session uploaded straight to this HX Fortress was never known to the control
plane by id, so there is nothing to ask about, and one whose channel is
unrecorded is not assumed to be either. The witness is controlled locally:

```sh
hx-fortress audit witness show
hx-fortress audit witness off
```

With it off, no session id leaves this host and every eligible session says so
by name — never "no copy was found", because nothing was asked. A run that could
not reach the control plane says that instead, as a different fact.

`hx-fortress audit acks reconcile` lists acknowledgements that have no matching
record in this host's own audit trail; `--re-confirm` writes them again through
the fenced routine so they land in it.

### Asking the daemon to do something

The console does not perform privileged work itself. Anything that needs the
daemon's credentials, its engines or its database authority is a **request**: a
row in the command queue that the daemon claims, performs and records. Eight
kinds exist — apply an update, rotate a credential, run a storage migration, run
a checkup, run a self-test, run the residency audit, toggle the witness,
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
| `FORTRESS_UI_BOOTSTRAP_USER` | Login for the first console account, created on the first boot of a fresh volume. Its setup link is left in `<root>/ui/bootstrap-setup-link.txt` (0600) and is not printed: the container log names the file. An existing login is left alone — issue a fresh link with `hx-fortress ui user reset <login>`. With `FORTRESS_UI_BOOTSTRAP_TOKEN_DIGEST` and `FORTRESS_UI_BOOTSTRAP_TOKEN_EXPIRES` beside it, no file is written: the link exists only where it was minted. |
| `FORTRESS_UI_BOOTSTRAP_TOKEN_DIGEST` | The sha256, in hex, of a setup token minted where HX Fortress was installed. The first account is made with it as its one setup token, so the install's link is the one that sets the password. Used only while `users.json` holds no account at all, and only with the next variable. |
| `FORTRESS_UI_BOOTSTRAP_TOKEN_EXPIRES` | The time that link stops working: an ISO 8601 time with its offset, not passed, and at most 24 hours ahead of this host's clock. Without a usable one no account is made, and the log says why. |
| `FORTRESS_CONTAINER` | `0` disables container detection entirely, as `--no-container` does on the command line. |

For `port`, `bind` and `publicUrl` the environment wins over `ui.json`, and
`--port` and `--bind` win over the environment in turn. `--url` changes only the
URL the console prints — not where it binds, not the `Host` allowlist and not
what is advertised to the control plane. `FORTRESS_UI_ENABLE` is the exception
to all of
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

## The addresses HX Fortress calls

HX Fortress keeps one list of every host it may call. `hx-fortress hosts`
prints it on the host. Each entry is one of three kinds, and only one kind is
stored:

| Kind | Where it comes from | Stored |
| --- | --- | --- |
| `setting` | An answer of the setup that names an outside service: the key store, the sign-in provider, the file store, the AI model, the control plane, or the place the database program is downloaded from. It is worked out from `config.json` and the files beside it each time the list is read. | No |
| `manifest` | A host that a module of this build names in its manifest. | No |
| `reach` | A host and a port that a signed-in person added to one module. | Yes, in `hosts.json` |

So a `setting` or a `manifest` entry cannot go stale: it is the setting, or the
manifest. Nothing can add one by writing to a file.

### Reaches

A reach is added and removed on its module's own page in the console, by a
signed-in person. The module host makes the change while it carries out that
person's act, and it writes the act to the audit trail first. No ask of the
control plane, no release and no module on its own can add, change or remove a
reach. In this build a host that a person adds is not yet an entry of this
list: see the end of this section.

- A reach may be at a private address, because a database usually is.
- A reach to a loopback, link-local, unspecified or multicast address is
  refused, in IPv4 and in IPv6, and so is an IPv4 address of those kinds
  written inside an IPv6 one. So is a reach to `localhost`, or to a cloud's
  metadata service: `169.254.169.254`, `fd00:ec2::254`,
  `metadata.google.internal` and `metadata.azure.internal`.
- A host must be a DNS name or an address. A user name, a path, a port, a
  wildcard or a space in it is refused. An IPv4 address must be written as four
  decimal numbers: `2130706433`, `0x7f.1` and `0177.0.0.1` are refused,
  because programs read such text in different ways.
- One module keeps at most 64 reaches for one organization. A reach's name is
  unique among them, whatever the case of its letters. The same host and port
  under two names is allowed.

`hosts.json` is in this HX Fortress's folder, beside `config.json`. Only its
own user can read or write it (mode `0600`). It is written under a lock, so two
changes at once cannot lose one. A `hosts.json` that cannot be read is never
written over. While it cannot be read, no reach can be added or removed, no
program is started for a reach, and `hx-fortress hosts` stops with an error
that names the file.

### Printing the list

`hx-fortress hosts` prints one row for each entry: the address (the host, and
the port when it is not 443), what HX Fortress calls it for, the module, and
for a reach who added it and when. The settings come first, in the order of
the setup's questions, then the manifests by module, then the reaches by
module, organization and name. A setting that names a service whose host
HX Fortress does not know, such as a database that is reached by an address
kept in the key store, shows a phrase in place of the address. With an
identity provider for sign-in, a second sign-in row reads "the addresses this
provider names for its keys and tokens": a provider can keep its keys and
tokens at other hosts than its own, and HX Fortress learns those hosts only
when it asks the provider.

`hx-fortress hosts --json` prints the same entries with every field, for a
firewall rule or a template to read:

```json
{
  "hosts": [
    { "kind": "setting", "host": "idp.northstar.example", "port": 443, "why": "sign-in", "question": "signIn" },
    { "kind": "setting", "host": null, "port": null, "described": "the address in db-url", "why": "database", "question": "data" },
    { "kind": "reach", "host": "db.northstar.example", "port": 5432, "why": "Databases: sales-1", "module": "databases",
      "name": "sales-1", "addedBy": "marta.lindqvist@northstar.example", "addedAt": "2027-03-14T09:30:00.000Z" }
  ]
}
```

A reach of another organization than this HX Fortress's own has an
`organization` field with that organization's id. A setting's `question` is the
id of the setup's question whose answer it is. The command reads files only. It
needs no daemon, and it changes nothing. It prints no key, no user name of an
address and no query string.

### What this build does not do yet

This build shows the list and prints it. It does not yet refuse a call to an
address that is not on the list: HX Fortress's own calls go where its settings
say, whether that address is listed or not. Set your firewall from the printed
rows. These parts are not in this build:

- HX Fortress refusing its own calls to a host that is not a `setting` entry;
- reach entries. The module host carries out a person's act now, and it keeps
  the hosts a person adds in a file of its own beside the module's state: see
  [An act](#an-act-what-a-signed-in-person-may-have-a-module-do). They are not
  in `hosts.json` yet, so this list has no reach entries and `hx-fortress
  hosts` prints none. They move here in the change that follows. The module
  host holds a host to a stricter rule than the one on this page: the section
  on an act names what else it refuses;
- a module's page that adds or removes a reach. The act's route is there, and
  the page is not;
- the Databases module's connections in this list: until they move, that
  module keeps its own record of the servers it reaches;
- anything for a client's network, such as a second door or a runner;
- a page of the console that shows the whole list. The setup's Network
  question shows the `setting` entries.

## The connection to the control plane

An HX Fortress that is enrolled keeps one connection to its control plane. HX
Fortress opens it, outbound, to the address in `cloud.url`: port 443, unless
that address names another. The control plane never opens a connection to an
HX Fortress.

The connection carries messages from one closed list. Each message is one frame
of the protocol package, named by its `t`. HX Fortress sorts every frame into
one kind, by its name and its direction, with one table in the code
(`src/cloud/kinds.ts`). "In" is from the control plane to HX Fortress.

| Kind | Frames in | Frames out | Carried |
| --- | --- | --- | --- |
| The greeting | `enrolled`, `welcome`, `fatal` | `enroll`, `hello` | always |
| Heartbeats | `heartbeatAck` | `heartbeat` | always |
| Asks and their answers | `moduleMessage` | `moduleReply` | always |
| Release offers and their results | `moduleAdvertise`, `moduleRemove` | `moduleInstallResult`, `moduleRemoveResult` | always. A request to remove a module is always refused |
| The member list | `rosterSync` | none | with Agentic Sessions |
| Counts of sessions, and that a session changed | none | `collectionStats`, `hxInvalidate` | with Agentic Sessions |
| Questions HX Fortress asks | `fortressQueryResult`, `fortressQueryError` | `fortressQuery` | with Agentic Sessions |
| Calls that read or write a session | `rpc` | `rpcResult`, `rpcError` | with session content |
| Calls of HX Fortress's tools | `mcpRpc` | `mcpRpcResult`, `mcpRpcError` | with session content |

A frame with any other name belongs to no kind. It is dropped and counted.

"With Agentic Sessions" and "with session content" go by the setting of the
next section. Where it is `on` or `off`, a kind that goes with Agentic Sessions
is carried only while that module is on, and a kind that goes with session
content only while the setting is `on`. Where it is not set, every kind is
carried, as before the setting existed.

So an HX Fortress with Agentic Sessions off and session content off carries four
kinds: the greeting, heartbeats, asks with their answers, and release offers
with their results.

### Session content on the connection

Session content is the text of a session and every call that reads or writes
one: the calls that read or write a session, and the calls of HX Fortress's
tools. One setting says whether it may travel on the connection.

| Where | How |
| --- | --- |
| The daemon's environment | `FORTRESS_CONNECTION_SESSION_CONTENT=off`, or `on`. It wins over `config.json`. Any other value stops the daemon from starting, and so does a variable that is set and empty |
| `config.json` | `"connection": { "sessionContent": "off" }`, or `"on"`. Any other value stops the daemon from starting. So does any other key in `connection`. `hx-fortress enroll` refuses to rewrite the file until it is fixed, and it refuses a file that is not valid JSON when the file mentions the setting |

The variable is read from the daemon's own environment. A container gets it from
its settings. A daemon that `hx-fortress start` installed as a service does not
get the variables of the shell that ran the command, so on such an HX Fortress
put the setting in `config.json`.

A choice that is written wrongly must not be read as no choice, because an HX
Fortress where nobody chose serves session calls. So the daemon also refuses to
start on these:

- the setting's name anywhere else in `config.json`, at any depth and in any
  spelling that keeps its letters: `session_content` at the top of the file,
  `sessionContent` under `cloud`;
- a block named `Connection` or `connections`;
- a variable that is meant for HX Fortress and only looks like the setting:
  `FORTRESS_SESSION_CONTENT`, `FORTRESS_CONNECTION_SESSION_CONTENTS`, the right
  name in lower case.

It cannot see every slip. A name that is misspelled in its letters and is also
in the wrong place, such as `sesionContent` at the top of the file, reads as a
key this build does not know, and such keys are kept as they are. So check
what the running daemon goes by after a change:

`hx-fortress status` prints `Carries:    no session content`, or
`Carries:    session content`. It prints neither line where nobody chose. The
status file, `runtime/status.json`, holds the same as
`connection.sessionContent`: `on`, `off` or `not_set`.

The setting is read once, at start. It has three states:

| State | Calls that read or write a session, and tool calls | The member list, the counts and HX Fortress's questions |
| --- | --- | --- |
| `off` | refused by the connection itself | carried only while Agentic Sessions is on |
| `on` | served only with a grant signed by the control plane. Two calls need no grant and read no session: `selfTest`, and the list of HX Fortress's tools | carried only while Agentic Sessions is on |
| not set | served as before the setting existed: by the Agentic Sessions module while it is on. A grant is checked when one is sent, and a call without one is served unless `FORTRESS_TUNNEL_GRANT_ENFORCE` is on | carried whether Agentic Sessions is on or off |

An HX Fortress that is older than the setting has it not set, and does not
change. One that `hx-fortress setup` sets up has it `off`: the setup writes
`"connection": { "sessionContent": "off" }` once, when an HX Fortress is first
set up. It asks no question for it, it leaves a choice that is already in the
file, and a later run does not put it back. An HX Fortress that is made
another way has it not set until somebody sets it: one that `hx-fortress
enroll` made, and a container that enrolls from `FORTRESS_ENROLL_TOKEN`. A
template for such a container sets the variable.

With Agentic Sessions on and the setting `off`, no session reaches an HX
Fortress through the connection. Sessions then come in through its ingest
gateway only, which needs `FORTRESS_PUBLIC_URL`.

The setting is about the connection and about nothing else. The ingest gateway
is another way in and out. With Agentic Sessions on and `FORTRESS_PUBLIC_URL`
set, an HX Fortress takes session uploads and serves session reads at its
gateway, to a caller with a token the control plane signed. `off` does not
change that, and the daemon says so in its log at start. An HX Fortress from
which no session text may leave has Agentic Sessions off.

With the setting `off`:

- A call that reads or writes a session is answered
  `{ "t": "rpcError", "id": ..., "error": "session_content_off" }`. A tool call
  is answered with `mcpRpcError` and the same word. Nothing is dispatched, so
  no module and no tool hears the call. A call whose id is not a string of 1 to
  128 characters is refused and recorded like any other, and gets no answer:
  there is nothing to send it under.
- Each refusal is written to the audit trail, as `control_plane.session_call`
  or `control_plane.tool_call`. A session call's record names its method when
  the method is one this build knows, and `unknown` otherwise. A run of the
  same refusal within a minute is two records: the first, and one more with the
  count of the rest.

The connection parses no frame over 32 MiB. `FORTRESS_MAX_FRAME_BYTES` changes
that size. With session content `off` and Agentic Sessions off, only the four
kinds above can arrive, and none of them is large, so the size is 256 KiB there:
the variable can lower it and cannot raise it. A larger frame is dropped before
it is parsed, and counted. The size limits what HX Fortress goes on to parse and
hand on. It does not limit memory, because a frame has arrived in full by the
time its size is known.

### What crossed, counted

HX Fortress counts every frame by its name and its direction. It also counts
every frame it refused because its kind was not carried, and every frame it
dropped: over the cap, not readable as a frame, or with a name this build does
not know.

The counts are in `connection/counts.json` in this HX Fortress's folder,
readable only by its own user. The file has one entry for each UTC day and
keeps 400 days, so that a whole year can be shown:

```json
{
  "version": 1,
  "days": {
    "2027-03-14": {
      "in": { "enrolled": 1, "moduleMessage": 12, "heartbeatAck": 2880 },
      "out": { "enroll": 1, "moduleReply": 12, "heartbeat": 2880, "rpcError": 3 },
      "refused": { "rpc": 3 },
      "dropped": { "too_large": 1, "unreadable": 0, "unknown": 2 }
    }
  }
}
```

The daemon writes the file at most once every 10 seconds while a count changes,
and when it stops. Three frames cross a connection that nobody is using,
because HX Fortress sends them on a timer: `heartbeat`, its answer
`heartbeatAck`, and `collectionStats`. They are counted like any other frame,
and a change in their counts alone is written every 5 minutes. A daemon that is
killed can lose the counts of its last 10 seconds, and up to 5 minutes of those
three. A key of `in`, `out` and `refused` is always a frame's name from the
table above, never text the control plane chose.

The daemon never writes over a file it could not read. A file that is there and
cannot be read stays where it is: the daemon counts in memory, says so once in
its log, and tries the read again at every write. A file that was read and is
not a counts file of this build is moved aside, as
`counts.json.unreadable-<time>-<8 hex digits>`, and the counts start from zero.

The console's page of data paths shows the day's counts in its row for the
connection, with the state of the setting. Two asks of the `host` module give
the counts to the control plane: `status` for today, and `connection.count` for
each day of a period. See the table of that module's asks, further down. Both
answer from the daemon's own memory, which holds the file's days and what was
counted since the last write. While the file cannot be read, the memory holds
only what this run counted: `status` gives those counts for today all the
same, and `connection.count` answers no period. Nobody asks the control plane
for a count.

## Secure Data Islands

A Secure Data Island is a small page that HX Fortress serves at its own
address, for a control plane's page to show in a frame. The person in front of
it signs in at HX Fortress, and what the page shows comes from HX Fortress and
goes to that person's browser. The control plane's page learns a state, a count
and a height, and never a value.

### The page files

The files are the folder [`islands/v1/`](islands/README.md) of this repository:
plain HTML, CSS, JavaScript and JSON. No build step touches them. The console
serves each one at `/island/v1/<its name>` exactly as it is in the repository,
to anyone, with no sign-in, because a page file holds no data. A page also
answers without `.html`.

`islands/v1/contract.json` is the closed list of what may cross a frame's edge:
the kinds, every message with its fields, the style tokens, the key chords, the
refusal codes, the grant's claims, and the one spelling of the settings that a
grant commits to. Both sides drop a message that is not on it. A control plane
keeps a copy of that file.

`islands/v1/SHA256SUMS` lists each file's checksum, in the form `shasum -c`
reads. So anyone can compare a file that an HX Fortress serves with the
repository at the tag of the release it runs:

```bash
curl -s https://hx.northstar.example/island/v1/island.js | shasum -a 256
```

The console reads the files once, when it starts, compares them with that list,
and says the result in its first lines. A console whose files do not match the
list serves none of them. Every build checks the list against the folder before
it compiles (`bun run check:islands`).

Everything under `/island/` has a request budget of its own. Frames on a control
plane's page and the console's own pages cannot use each other's up. The font
files, which both load, have a third budget.

### Who may frame a page

One setting names the one origin whose pages may show a Secure Data Island in a
frame: `controlPlane.pages` in `config.json`, or the variable
`FORTRESS_CONTROL_PLANE_PAGES`, which wins. It is one origin, such as
`https://app.control.example`: no wildcard, no path and no list.

| Page | Its `frame-ancestors` |
| --- | --- |
| A kind's own page, such as `/island/v1/rows` | that one origin |
| The same page while no origin is set, or while this HX Fortress has no connection to a control plane | `'none'` |
| Every other page of the folder: the sign-in window's two pages, and the page of a result | `'none'` |
| The console's own pages | `'none'`, always |

A kind's page also sandboxes itself (`sandbox allow-scripts allow-same-origin`):
it may run its script and keep its own origin, and it may not open a window,
send a form, start a download or move the tab it is shown in. Every page of the
folder may load and call its own origin and nothing else, and holds no inline
script and no inline style.

A change of the setting lands on a running console with no restart. A
`config.json` that cannot be read, or whose `cloud` or `controlPlane` key is
not valid, frames nothing, and the console says so once in its log.

`GET /island/v1/config` is what a page file reads at run time: the origin that
may frame it, the organization's name, and whether the organization's people
sign in with an account on this HX Fortress or through its identity provider.
It needs no sign-in. While no page may be framed it says none of the three.

## Modules, asks and releases

A module is a part of the Fortress that does one job for the organization. Today
that is keeping AI sessions, and answering the control plane about HX Fortress
itself. Every module is compiled into the `hx-fortress` binary. HX Fortress
never downloads module code from a control plane and runs it.

A control plane reaches HX Fortress only over the connection HX Fortress
opened. It can do two things to a module, and no more:

- **Send it an ask.** An ask is one question from a short list that the module
  declares. The Fortress checks every ask before the module hears it.
- **Offer it a release.** A release is a signed file for a module to apply. An
  offer changes nothing. A person on this host approves it or refuses it.

Which modules are on, and which releases are approved, is decided on this host.
Nothing the control plane sends can switch a module or approve a release.

### The modules in this build

| Module | Name | What it does | On after `hx-fortress setup` or `install` | On after `hx-fortress enroll` |
| --- | --- | --- | --- | --- |
| `session_vault` | Agentic Sessions | keeps AI session transcripts and their search index | off | on |
| `host` | Host | answers the control plane about this HX Fortress: its status and its audit trail | on | off |
| `databases` | Databases | reads and writes local databases | on | off |
| `stores` | Stores | keeps working copies of tables on this machine, each in a file of its own | off | off |

The setup and the install show one switch for each module, already set as the
fourth column says, and a person changes any of them before anything is
written. `hx-fortress enroll` is the older way to connect a host, and it keeps
the list it always made.

```sh
hx-fortress modules list
hx-fortress modules on host
hx-fortress modules off host
```

`modules list` prints each module's switch and whether it is running. For a
module that has a manifest, as `host` has, it also prints every ask the control
plane may send it, what each ask takes, what each answer can hold, every act a
signed-in person may have it do, the hosts the module may call, and the names of
the secrets it may read. All of that is compiled into the binary, so the command
works with the daemon stopped. Agentic Sessions is older than manifests and has
none. The list says so, and it does not say that Agentic Sessions calls no host.

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

An ask arrives over the connection in a `moduleMessage` frame. It holds the
module's id, the ask's name, its arguments and a grant. HX Fortress checks the
following, in this order, and stops at the first check that fails:

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

The control plane is told the answer, or one of eight refusals: `grant_missing`,
`grant_invalid`, `module_off`, `ask_unknown`, `args_invalid`, `reply_invalid`,
`busy` or `failed:<code>`. The rule that refused an ask is written to this
host's audit trail and is not sent to the control plane.

**A grant works once.** The Fortress remembers a used grant for five minutes
past its expiry. When an ask runs, the Fortress also writes a digest of the
grant's id beside it in the audit trail, and it reads those digests back when it
starts. A grant that ran an ask before a restart is therefore still used after
it.

**What an ask can take and an answer can hold.** Nine kinds of value, and no
others:

| Kind | What it is |
| --- | --- |
| count | a whole number, zero or more |
| flag | yes or no |
| state | one word from a list the ask declares |
| time | an instant in UTC, written as `2027-03-14T09:12:00.000Z` |
| name | at most 128 characters of letters, digits, space and `_ . : / @ -` |
| id | one token of at most 128 letters, digits and `_ . : -` |
| email | a person's address in lower case, at most 254 characters: the letters a to z, digits and `. _ + ' -` before the `@`, and a domain name after it |
| list | at most 500 values of one kind |
| record | values with names, each of a declared kind |

There is no kind for free text and no kind for bytes. An answer therefore has no
field that a row, a transcript or a file could be put in. One answer holds at
most 20,000 values.

**Limits.** An ask has 25 seconds to answer. At most 16 asks run at once, and at
most 300 start in any minute. Both counts are exact. Asks that arrive together
count each other, and no period of 60 seconds holds more than 300 starts,
wherever the period begins. Past either limit the control plane is told `busy`.

### What the control plane may ask the `host` module

| Ask | Takes | The answer holds |
| --- | --- | --- |
| `status` | nothing | this HX Fortress's version; the kind of key store this HX Fortress reads its secrets from, as a name (one of the providers under [Secrets by name](#secrets-by-name)); whether this HX Fortress stores sessions; each module's id, whether it is on, and its version; each release's id, module, version, state and times; whether session content may travel on the connection, and for each frame that crossed or was refused since the start of the UTC day: its kind, its name, its direction and two counts |
| `connection.count` | a period | the first day that the counts say anything of; and for each UTC day of the period on which something was counted, the oldest day first: the start of the day, and for each frame that crossed or was refused on it what `status` gives for today. At most 100 days |
| `audit.count` | a period | for the period: how many asks reached a module, how many were refused, how many releases were installed and how many sign-ins there were. The two counts of asks again for each ask, under its module and its name. Also how many releases wait now |
| `audit.read` | a period, an optional kind of line, and a page size of at most 100 | lines from the audit trail, newest first |
| `access.groups` | nothing | for each role, whether it sees rows in a Secure Data Island and how many people hold it; with sign-in through the identity provider on, a row for each group of the mapping, with the group's name when the name may cross; how many people hold each role, each person counted once; and whether the people were counted from the accounts or from the sign-ins; counted from the sign-ins, since when, and how many accounts can still sign in with a password. Never a login, an address or the provider's id for a person |

Each answer is about the organization the ask was for, and about no other. On
an HX Fortress that holds one organization that is everything the table says.
[More than one organization](#more-than-one-organization) says what changes
where an HX Fortress holds more.

`status` reports what the running HX Fortress does. For Agentic Sessions that
is what it started with: a switch that waits for a restart is not reported as
if it were in effect. The key store it names is the one this running
HX Fortress reads from. The answer holds that as a name and not as one word
from a fixed list, so a key store that a later build adds changes nothing in
the shape of the answer.

`connection.count` answers from the counts of
[What crossed, counted](#what-crossed-counted).

- The counts are kept by UTC day. So the answer holds every whole day from the
  day the period starts on to the day it ends on, also when the period starts
  at noon.
- A day on which nothing was counted is left out. So is a day older than the
  400 days that the counts are kept.
- `keptFrom` is the start of the first UTC day that the counts say anything
  of. From that day on, a day that is left out is a day on which nothing was
  counted. Of a day before it nothing is known: this HX Fortress was not
  connected yet, or a build that kept 90 days has dropped the day, or the file
  of the counts was started again. So a reader shows the days before it as not
  counted, and never as days on which nothing crossed. It is never older than
  the 400 days kept and never later than today, and it can be later than the
  whole period.
- One ask answers at most 100 days. A longer period is refused with
  `failed:range_too_long`, and nothing of it is answered. A year is four asks.
  An answer holds at most 20,000 values, and 100 days of every frame are about
  15,700.
- A period that ends before it starts is refused with `failed:range_invalid`.
- While the file of the counts could not be read, the daemon knows only what it
  counted itself since it started. The ask then answers
  `failed:counts_unreadable`, and never a part of the days. Where a file that
  was not a counts file was moved aside, the days it held are in no answer.
  The daemon's log says so, and `keptFrom` is the day the counts started
  again.
- The connection is the whole HX Fortress's, and its counts hold every
  organization's asks. So only this HX Fortress's own organization is told a
  day, and the day the counts begin. Another organization is answered an empty
  list and no `keptFrom`.

`audit.count` counts the asks of a period twice: as two numbers, and for each
ask. An ask is allowed when it passed the gate and reached its module, however
the module then answered. It is refused when the gate turned it away, or
refused to send what the module answered. The two numbers are the sums over
every ask.

- An ask is named by its module's id and its own name, as the gate wrote them
  into the ask's record. The gate writes a name only once it has found it in
  this build's own lists, so a name that the control plane sent and this build
  does not know is never in the answer. The count holds each of the two to the
  form of an id and of an ask's name, and counts any other value under the
  word `unknown`.
- A refusal that was made before HX Fortress knew which module or which ask was
  meant is counted under `unknown`. So are the refusals of this HX Fortress's
  own organization that were counted and not written, past the 60 different
  refusals of a minute. Those of another organization are in no count: they
  are one record that names no organization, under an action of its own.
- An ask that ran is counted under `unknown` when its first record, the one
  that names it, is no longer on the disk and was never moved into the table.
  An ask is two records, and they can be in two places: on the disk, in the
  table, or one in each. The count finds the first record wherever it is. One
  limit: where the first record is only on the disk and the second only in the
  table, the count looks at the oldest 1,000 asks that the disk holds no
  second record of. That many are open only after the daemon was stopped hard
  many times.
- An ask that nobody sent in the period is left out. An answer lists at most
  256 asks. A build ships a few dozen.
- The count reads every record of an ask in the period. On a busy HX Fortress
  a year is many records, and the answer has 25 seconds. No sum is kept by day.

A line from the audit trail is seven values: an id, a time, the kind of actor (a
person, the control plane, HX Fortress or a job), the actor's name, the action,
the name of what the action was done to, and how it ended (`ok`, `refused` or
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

`access.groups` says who holds each role, as counts. How it counts depends on
whether sign-in through the identity provider is on (it is on when `ui oidc on`
was run and nothing it needs is missing):

- Off: `countedFrom` is `accounts`. There is one row for each kind of account,
  `operator`, `readonly` and `viewer`, with no group. A row counts the accounts
  of its kind in `users.json` that are neither disabled nor deleted.
- On: `countedFrom` is `sign-ins`. The provider holds the list of who has a
  role, and HX Fortress knows only who signed in through it. `since` says from
  when the counts are complete: the later of when `provider-people.json` was
  started and the last write of the provider's settings in `oidc.json`,
  `ui oidc revoke` too. A sign-in noted before such a change, through another
  provider or before a group was added to a list, may be missing from a row,
  so `since` can show fewer days than were counted, never more. A person
  counts under the role their last sign-in through the provider in use now, in
  the last 90 days, gave them: the first of `administratorGroups`,
  `operatorGroups`, `readonlyGroups` and `viewerGroups` that holds one of its
  groups. So a row's `seesRows` is true of everyone it counts. There is one
  row for each group of each list, in that order, counting the people of that
  role whose last sign-in carried it, and one row with no group and no people
  for each list that is empty. `accounts` says how many accounts on this HX
  Fortress can still sign in with a password beside the provider; they are not
  in the rows.

`holders` has each role of the rows once, counting each person once. A person in
two groups of one role counts in both of its rows, so adding up the rows can
count a person twice; adding up `holders` never does. With the accounts, the
rows and `holders` are the same.

Each row has a role, `administrator`, `operator`, `readonly` or `viewer`, and
whether that role sees rows in a Secure Data Island. `administrator` is the role
of a row for a group of `administratorGroups`; in this build such a person is an
operator. A row names its group only when the name may cross:

- `groupsClaim` is a claim of groups or roles, such as `groups`, `roles` or a
  namespaced claim ending in `/groups`. With any other claim, such as `email`
  or a user name, each "group" of the mapping is a person: each role then has
  one row, with its group hidden and its people counted together;
- it is a name, as the table of kinds above defines one;
- it holds no `@`, because an address can name a person.

Otherwise the row says `groupHidden`, and still has its count. A file the ask
reads that cannot be read (`users.json`, `oidc.json` or `provider-people.json`)
fails the ask with `access_unreadable`. It never sends a shorter answer.

An answer has left this host once it is sent. This section is the complete list
of what the `host` module can disclose, and `hx-fortress modules list` prints
every field of every answer.

### What the control plane may ask the `databases` module

A connection is a local database this HX Fortress may reach, kept under a name:
its engine, its server and port, the database, how the link is encrypted, and a
login. The login is a user name and the name of a secret in the organization's
own key store. The password is never typed into HX Fortress and never kept by
it.

| Ask | Takes | The answer holds |
| --- | --- | --- |
| `connections.list` | nothing | each connection's name, its engine, how it is reached (`direct`), where it stands (`not_tested`, `testing`, `ready` or `failed`), when its last test ended, the one word its last test failed with, and whether its login may change anything |
| `catalog.read` | a connection's name and a page number | the names of the connection's tables and columns as its last test that passed read them, a page at a time. For the reading: when it was read, how many pages, tables and columns it has, how many names were left out, and whether the database has more tables than one reading takes. For each table: its schema, name and kind, the engine's own estimate of its rows, and how many columns it has. For each column: its name, its type as one word, whether it may be empty, its length and scale as counts, and its place in the primary key |
| `test.start` | a connection's name | a job's id |
| `job.read` | a job's id | the job's connection, its state, its times and the one word it failed with. For a test: the step it is on or stopped at, and what a test that passed found: how many tables and columns, whether the link was encrypted and its certificate checked, and whether the login may change anything. For a job that writes: its kind (`write`, `rehearsal` or `undo`), the Store and the Store's own job, how that job stood when this one ended and the Store's one word for it when it failed, what the program counted (batches, and rows inserted, updated, deleted and held), which build of the program ran and which version of HX Fortress started it |
| `write.start` | the control plane's id of one approval, a connection's name, a Store's id, one to eight previews (each the Store's table, its version and the Store's checksum of it), whether it is a rehearsal, who writes, and who approved: the control plane's id of that person and their email | this module's job, and the Store's own job for the write |
| `write.undo` | the control plane's id of one approval, a connection's name, a Store's id, the Store's job of the write to take back, who writes, and who approved | this module's job, and the Store's own job for the undo |

`hx-fortress modules list` prints every field of every answer.

What these six asks cannot do:

- **No ask adds, changes or removes a connection.** Adding one adds a host this
  HX Fortress may reach and the name of a secret it may have read. Only a person
  signed in to this HX Fortress does that.
- **No ask takes a statement, and no answer holds a row.** A column's type is
  one word from a list of nine (`characters`, `whole_number`, `decimal`, `date`,
  `time`, `date_time`, `flag`, `binary`, `other`). The engine's own type name
  does not cross. A table's or a column's name that an answer cannot hold is
  left out and counted. It is never rewritten. A write's rows are in no ask
  either: `write.start` names previews that a Store on this machine holds.
- **No ask starts a write without the control plane's grant for exactly that
  write**, which names the person who approved it. What this HX Fortress can
  and cannot check of that is in "A write into a database", below.
- **A failure is one word.** The database's own sentence about a failure can
  quote a value, so it stays in this HX Fortress.
- **The control plane cannot have a database signed in to as often as it
  likes.** Every test signs in. For one connection the control plane can start
  a test at most once a minute: a second ask inside that minute is answered
  with the id of the test that already ran. And once a database has refused a
  login, the control plane can start no test that signs in with that user at
  that server, until a person's test with it passes, or the connection gets
  another server or another user. A wrong password tried again and again locks
  a login.

A query does not travel on the connection to the control plane at all. It runs
for a person who is signed in to this HX Fortress, and its rows go to that
person's browser. It runs only on a connection whose last test that passed
found that its login can change nothing, and whose login no database has
refused since. Before anything is started, the statement's text is
scanned: it must be one statement, start with SELECT or WITH, and hold no word
that writes. SECURITY.md says what a scan of a text cannot see.

Another module of HX Fortress reaches a database through this one. It names a
connection and hands over one job for a store, a pull or a compare, and gets
counts back, with the names of the tables they are for. It is given no server's
address, no user's name and no secret's name. It is given an id for the
connection, which is another id once the connection's engine, server, port or
database has changed, and for a connection that was removed and added again
under the same name. A server's name in another case is the same server, and
keeps the id. So the other module can tell what it read from one database from
what belongs to another under the same name. HX Fortress does not see a server
that is given another database under the same name, and the id does not change
then. Such a job runs only on a
connection whose last test that passed found that its login can change nothing,
and whose login no database has refused since. At most two such jobs run at
once, for the whole HX Fortress. Such a job can run for half an hour, and so
can a job that writes. Together they take all of the module's four places but
one, so that a test or a query, which take two minutes at the most, always
find a place. When an operator changes or removes a
connection, what runs on it is stopped once the change is saved. A job that
read the connection just before such a change was saved, and starts just after
it, can still run on the connection as it was. Its answer
names the id of the database it ran on. A job that writes makes its last check
under the lock that such a change holds: it sees the change and does not
start, or it has started and the change stops it.

The module's one line in `hx-fortress modules list` says what it is for. A
daemon of this build writes to no database: the Stores module of this build
does not answer this module yet what a write holds. So `write.start` and
`write.undo` answer `stores_off`, also for a connection that passed a test and
has write settings.

**A write into a database.** A write is started by the control plane, with the
ask `write.start`, and by nothing else: no person at this HX Fortress's console
starts one, and no other module can. What is written is one to eight previews
that a Store of this HX Fortress holds. A write of one preview is written a
batch at a time, and each batch is committed by itself. A write of several
previews is one transaction. A rehearsal writes the previews in one
transaction and rolls it back. An undo, `write.undo`, takes one earlier write
back, in one transaction.

What this HX Fortress checks before it starts the program, in this order:

1. **The grant.** The ask gate lets the ask through only with the control
   plane's grant for exactly these arguments, and takes a grant once. The
   arguments name the person who approved, and each preview by the Store's
   checksum of it. So the grant is the approval.
2. **The request was not taken before.** The same request with the same
   arguments answers the job it started, and starts nothing. With other
   arguments it is refused (`request_reused`).
3. **The connection** is there, has passed a test since it was added or
   changed (`not_tested`), names a write login (`write_login_missing`), and no
   database has refused that login since an operator last set it
   (`write_login_refused`).
4. **What the Store holds.** The Stores module says what the write holds. Each
   preview has the checksum the ask names (`preview_changed`), and each part's
   table is one the connection may write (`table_not_listed`). Nothing is
   opened for a write that is refused here.
5. **A place.** One write runs on a connection at a time, and one of the
   module's places always stays free of jobs that can run for half an hour
   (`busy`).
6. **The same again for the store job that the Stores module then opens**, and
   that the connection is still as it was checked (`connection_changed`). A
   write that is refused here has its store job failed again at once.

The Stores module has 20 seconds for its two answers together. Past that the
ask fails with `timeout` and nothing is started. A store job that it opens
after that is failed again as soon as it is there. An ask has 25 seconds in
all, so a slow Stores module alone does not use them up. An ask that still
runs past them is answered `timeout` by the ask gate while the module works
on, and its write may start after that answer. So after `timeout` the control
plane asks again with the same request: the answer is the job that was
started, or a start now, and not a second write.

Then the program runs with the connection's write login. The module names that
login's secret to the module host, which reads the password and hands it to the
program. The module holds no value of it. `write.start` answers at once with
two ids, and `job.read` says how the job went.

An operator stops a write that runs by changing or removing its connection, or
by changing the connection's write settings or taking them away. The program
is then ended as a crash would end it, and the database rolls back what was
not committed. The same write settings set again stop nothing. A change that
is refused, or that cannot be saved, leaves the connection as it was and
stops nothing. So does a removal that could not begin. A removal that failed part of the way has taken the connection's host
off the list by then, so what ran on the connection is stopped. Of a write of
one preview, the batches that were committed before the stop stay written. The
Store keeps their record: `write.undo` takes them back, and a new preview shows
what is left to write. A write of several previews, a rehearsal and an undo
leave nothing behind when they are stopped before their commit. A write that
the program had finished in that moment is a
write that happened, and the job says so. A test that finds that the read login
can change the database stops the jobs that read, and no write.

When a job is over and its program is gone, this module tells the Stores
module to end the Store's own job. A job whose end the Store heard from the
program stays as it is. Any other is failed, so that the Store takes its next
job at once and does not wait for a program that will not come. The module
does not do this while a program may still run, which is when the module host
gave no answer for the run. The Store then ends that job by itself, when the
time of the job's key is up.

`job.read` says how the program's run ended. What was written is the Store's
to say. The two can differ: a program that was stopped, or that ended with no
answer, may have told the Store of its write before that. So `job.read` also
answers how the Store's own job stood when this job ended, and the Stores
module's own asks answer what was written.

After a database refused a connection's write login, no write signs in with it
again until an operator sets the connection's write settings again, also with
the same values. So a wrong password is tried once, and not once for each
approval.

What the module keeps of a write: one record for each job, with its ids, its
kind, how it ended, what the program counted, and a hash of what was asked. No
person and no table is in it. It keeps every job that runs and the newest 100
that ended. A job that was running when HX Fortress stopped is answered as
failed with `interrupted` after the next start, and is then the newest of
those that ended. What it wrote before that is the Store's to say. The audit
trail has two lines for each job, and one for each table it writes. The first line holds the connection, the kind, the Store and its
job, the request, who writes, and the approver's id and email. A table's line
holds the table of the database by its schema and name, and the Store's table
that holds what is written there, with its version and checksum. The last line
says how the job ended, how the Store's own job stood then, which build of the
program ran and which version of HX Fortress started it. No row and no value
is in a line.

**What the approval does not prove.** The control plane signs the grant. So
this HX Fortress knows that the control plane says a person approved, and whom
it names. It cannot ask that person. A control plane that is taken over can
approve its own writes. What bounds such a write is on the organization's own
side: only a connection that an operator gave a write login, only the tables
that operator listed, only what that login may do in the database, and every
write on this HX Fortress's audit trail with the approver it named.

**This build can keep a connection and test it. It runs no query yet.** An
operator who is signed in to the console adds a connection on its page,
[Data › Databases](#the-databases-page). The page has the module do an act, see
[An act](#an-act-what-a-signed-in-person-may-have-a-module-do). To reach a
database, the module hands HX Fortress one job for a helper program, the data
runner, and names a host and a secret that the person added. The daemon runs
the program for the module: see
[A helper program](#a-helper-program-what-the-daemon-runs-for-a-module). On a
host with no data runner installed, a test of a connection ends as failed with
`program_not_installed`, and no database is dialed and no secret of a
connection is read. No query runs on any host, because this build cannot yet
record a query's text. With `databases` switched on and no connection added,
`connections.list` answers an empty list, and the other five asks answer
`failed:connection_unknown` or `failed:job_unknown`.

### The Databases page

**Data › Databases** in the console (`/databases`) lists the databases this HX
Fortress connects to and where each one stands, and has Add Database, Edit, Test
and Remove. Everything on it is an act of the `databases` module. So it shows
databases only while that module is switched on and the daemon runs. With the
module off, the page says that Databases is off. With the daemon stopped, it
says so. A list that was already showing stays, marked as one that may be out
of date.

| Who | May |
| --- | --- |
| every person who is signed in | see the list, each database's settings and what its last test found |
| operators | add, change, test and remove a database |

A person who may only read sees the four controls, switched off, with the
reason beside them.

**Add Database** asks for the engine (SQL Server, Oracle, MySQL or PostgreSQL),
a name, the server and its port, the database (for Oracle: the service name), a
user name, and the secret that holds the password. More Settings is folded and
says what holds now, such as "TLS 1.2 or newer, certificate checked". Open, it
has the encryption, the oldest TLS version, and the name the server's
certificate must carry when that is not the server's own. A name left empty is
the database's. Edit changes everything but the name and the engine.

**The Password field takes the name of a secret, never a password.** An act
carries no secret's value, and HX Fortress writes to no key store. So the field
holds the name under which the password is kept in the key store this HX
Fortress reads (see [Secrets by name](#secrets-by-name)). While it is typed, the
field refuses anything that cannot be such a name. It cannot tell a password
made only of lower-case letters, digits and hyphens from a name, and takes one
as a name: the field says "Secret name" in front of what is typed for that
reason. A secret's name is shown to every person who is signed in.

**A pasted connection string fills the form.** Pasted into Server, a
`postgres://`, `mysql://` or `sqlserver://` address, a `jdbc:` one, Oracle's
`oracle:thin:` form or SQL Server's `Server=…;Database=…` fills the engine, the
server, the port, the database, the user name and the encryption it names. A
password in the text is dropped where the text is read: it reaches no field and
is never sent. The text is read right or not used at all. Every field takes by
paste only what can be its value, so a connection string the form does not
read, or a line of a settings file, stays out of every field. A field's text
that cannot be its value is not sent either. In Edit, a connection string for
another engine is not taken.

A name that holds an address with a login in it, such as a connection string,
is refused as a name by the form and by the module: a name is shown to every
person who is signed in.

**No field takes a text that reads as a password, a key or a token.** The
daemon refuses such a text as an argument of any act, because the audit trail
would replace a part of it (see
[An act](#an-act-what-a-signed-in-person-may-have-a-module-do)). Its answer
names no field. So the form applies the same rule to each field before it
sends, and says which field it is about. The rule goes by the form of the text,
and not by what a person meant. `Token Northstar2027` is refused as a name: the
word `token` stands right in front of a word of eight or more characters.
`Token Exchange` is refused for the same reason. `Tokens of Northstar` and
`Token of the Northstar permits` are taken. So a server, a database or a user
whose real name has such a form cannot be added.

The daemon refuses a text of more than 128 characters the same way, with no
field named, and the form says that at the field too. When a pasted connection
string names a value the form keeps out for one of these two reasons, the
other fields are filled, that value goes into no field, and its field says why.

**The keys.** The first database is selected when the page opens. ↑ and ↓ move
the selection, and Home and End go to its ends. `A` adds a database, `T` tests
the selected one, `E` edits it and Delete removes it, after a confirmation. In
Add Database, ← and → choose the engine, ↵ adds, and Esc closes.

**Test** reaches the server, signs in and reads the names of the tables. While
it runs, the page says which step it is on. Then it says what the test found:
whether the link was encrypted and the certificate checked, how many tables and
columns were read, and whether the login can change data. A database whose
login can change data reads "Login can write", because a query runs only with a
login that can only read. A login that may write a file on the database's own
machine counts as one that can change data, though it may write no table. A test that failed says why in one sentence. The
database's own words about a failure are not shown: they can quote a value, and
they stay in the daemon.

On a host with no data runner installed, every test ends with "This HX
Fortress has no data runner it can start.": the variable `FORTRESS_DATA_RUNNER`
names no file that can be run.

### An act: what a signed-in person may have a module do

An ask comes from the control plane. An act comes from a person who is signed
in to this HX Fortress's console. A module's manifest lists its acts as it
lists its asks: each with a name, who may do it, the shape of what the person
sends and the shape of what comes back. No act takes free text or bytes, and no
reply can hold either. The control plane cannot send an act: no message on the
connection leads to one.

```text
POST /ui/api/modules/<module>/acts/<act>      body: { "args": { … } }
```

The answer is `{ "reply": … }`, or `{ "error": "<one word>" }`.

**Who may.** An act is for operators only, or for every signed-in person. An
act for every signed-in person is one that its module wrote to read.
HX Fortress holds it to that in two ways: its context cannot change either of
the two lists below, and the audit trail does not record it one by one. Nothing
else is kept from it. Such an act can still write the module's own state and
the module's folder. A Viewer does no act: the console opens nothing for a
Viewer. The console's own gate checks the sign-in and the role, as it does for
every other route, and it checks the request's origin for a read as for a
change. The daemon checks the role again.

**A route only while its module is on.** The path of an act is a route of the
console only while the act's module is switched on. For a module that is off,
the path is answered like any path the console does not serve. So an
HX Fortress that has switched no such module on has not one route more than
before. A caller who is not signed in is answered "sign in to continue" for
every such path, before the console looks whether the act exists.

**The acts of the `databases` module.**

| Act | Who | Takes | Does |
| --- | --- | --- | --- |
| `connections.read` | every signed-in person | nothing | answers every connection in full: its engine, server, port, database, encryption, user name, the name of its secret, who added it and its newest test. Of its write settings it answers the write login and how many tables a write may reach |
| `connection.add` | operators | a connection's fields | adds a connection, its host and the name of its secret |
| `connection.change` | operators | a connection's fields | changes one, under the same name. Its write settings stay, unless the change names another database |
| `connection.remove` | operators | a connection's name | removes one, with its host, what its tests read of the database's tables and, when no other connection uses it, the name of each of its secrets |
| `connection.writes.read` | every signed-in person | a connection's name | answers one connection's write settings: its write login and each table a write may reach |
| `connection.writes.set` | operators | a connection's name, a user name, the name of a secret, and a list of tables | sets the connection's write settings: its write login and the tables a write may reach. What stood before is replaced whole |
| `connection.writes.remove` | operators | a connection's name | takes the connection's write settings away |
| `connection.test` | operators | a connection's name | makes a job for a test and answers the job's id. The daemon runs the data runner for the job. On a host with none installed, the job ends as failed with `program_not_installed` |
| `job.read` | every signed-in person | a job's id | answers how a test went, or how a job that writes went |

**A connection's write settings.** A connection is added with one login, and
that login only reads. Its tests sign in with it, and a query or any other job
runs with it only after a test found that it can change nothing. Before
anything can write through a connection, an operator gives it write settings
with an act of their own:

- **A write login.** A second user of the same database, and the name of the
  secret that holds its password in the organization's key store. As with the
  read login, HX Fortress keeps the name and never the password. The write
  login's user name is never the read login's. Setting it so is refused, and
  so is a change of the connection that would give the read login that name.
  Two user names that differ only by case count as one.
- **The tables a write may reach.** Each is a schema and a name, as the
  database spells them. A connection names at most 200, and all connections of
  an organization together name at most 1,000. A write login with no table
  takes no write.

One act sets both, and setting them again replaces them whole. They are apart
from the connection's own fields, so setting them keeps the connection's last
test, and a change of the connection's fields keeps them. One kind of change
does not. When a connection's engine, server, port or database changes, it
names another database, and the change takes its write settings away: the
tables an operator opened to writes were tables of the database it named
before. A server's name in another case is the same server.

The audit trail gets one line when write settings are set or taken away, and
one line for each table that was opened to writes or closed. Each line is under
the operator's console login, as the console's own record of the act is: the
module host writes the login on it, whatever characters it has. So a line says
who opened which table of which connection to writes, also for a person whose
login is an address with a plus sign.

The `databases` module's own asks answer nothing of a connection's write
settings. With the `host` module on as well, the control plane reads the lines
above from the audit trail, each with the connection's name and no table's
name, and with the operator's login where that login is a name (SECURITY.md).

The module host keeps the names of at most 192 secrets for this module and one
organization. A write login's secret is one of them, unless another login is
kept under the same name: the connection's own read login, or a login of
another connection. The 64 connections that an organization can have name at
most 128 secrets, a read secret and a write secret each, so they do not fill
the list.

**What signs in with the write login.** Only a job that the control plane's
ask `write.start` or `write.undo` started: see "A write into a database",
above. A test and a query sign in with the read login. The console's Databases
page has no form for these three acts yet.

`hx-fortress modules list` prints every act with who may do it, what it takes
and every field of its reply. It prints the acts of a module that is switched
off too: the listing shows what this build can do. For a module that takes
acts it also prints what a person added to it: the hosts, and the names of
secrets.

**How an act reaches the module.** The console and the daemon are two
processes, and a module is in the daemon. The daemon listens on `127.0.0.1`, on
a port the system picks, and on no other address. This listener is the door.
The console hands the act over at the door, and the reply comes back the same
way. HX Fortress writes neither the request nor the reply to a table or a
file. What an act changes is written, and so is the audit record of the act.

- The door is open only while a module that is switched on lists acts. An
  HX Fortress with no such module listens nowhere new and has no such file.
- While the door is open, `runtime/local-door.json` in HX Fortress's folder
  holds the port and a secret of 32 random bytes. Only the user HX Fortress
  runs as can read the file. The secret is new each time the file is written,
  and it is never logged. The file is removed before the door closes. A file
  that something else removed is written again, with a new secret, the next
  time the daemon looks at the module switch: within 15 seconds. A file that
  could not be removed when the door closed is removed at one of those looks.
- The secret never crosses the socket. The console sends, in headers, a number
  that it makes up for the call, the time, the SHA-256 of the request's body,
  and a code made from the secret and those three with the path
  (HMAC-SHA-256). The door answers with a code made from the secret, the same
  number and the answer's body. The console shows an answer only when that
  code is right. So a program that takes the door's port after a daemon was
  killed is told no secret, and what it answers is not shown.
- The door takes a call once. It takes one only within 30 seconds of the time
  the call carries, and it remembers the number of every call it took for
  that long. So a request that somebody saw on its way cannot be sent again.
- The door checks the code before it reads the body. So a program that does
  not hold the secret cannot make the daemon hold a body in memory.
- The console sends an act only when the door's file names the process that
  the daemon's own status file says is the daemon now.
- A call is handed on only when it comes from this machine, names the door's
  own address as its host, carries no header that a browser adds (`Origin`,
  `Sec-Fetch-Site`, `Sec-Fetch-Mode`), carries the right code, and is new. A
  call that fails one of the first three is answered 404. One without the
  right code, one that is not new, and one whose body is not the body its code
  was made for are answered 401. A call with the right code for another path
  is answered 404, and one whose body is not JSON 400. None of these answers
  has a body, and each is counted in the audit trail. Two kinds of call are
  answered and not counted: a request that is not well-formed HTTP, which the
  runtime answers before the door sees it, and a call that arrives in the
  moment the door closes.
- The door closes when the last module that takes acts is switched off, and as
  the first step when the daemon stops. A switch-off lets an act that is
  running get its answer. The daemon's stop cuts the call, and the person is
  told `failed:interrupted`.
- The console does not use the runtime's `fetch` for this call. Under Bun,
  `fetch` sends a request for `127.0.0.1` through the proxy that `HTTP_PROXY`
  names, with all its headers. The console opens the socket to this machine's
  own address itself.

**What the daemon checks.** The console says who the person is: the login, the
role, and an email when the login is an email address. The daemon takes that
on the console's word and checks everything else itself, in this order: the
request is well formed; the module is one this build ships; it is switched on
and running; the act is in its manifest; the person's role may do it; the
arguments have the declared shape, and none of them looks like a credential;
and there is room. Then the module runs. Its reply is rebuilt from the declared
shape before it is shown, as an ask's answer is, and it is at most 256 KiB. The
console replaces a text in a reply that looks like a credential, as it does in
everything it shows.

**What the console answers by itself.** The console answers some requests
before the daemon hears of them. These answers are a sentence, and not one of
the words in the table below.

| Status | When |
| --- | --- |
| 401, `sign in to continue` | the caller is not signed in |
| 403, with the sentence a read-only person gets for every write | a read-only person tries an act of operators. The console also tells the daemon, which records the try. It tells it at most 30 times a minute from one address, and not while the daemon is stopped |
| 403 | the request comes from another site's page |
| 429, `too many requests` | more than 120 acts of operators in a minute |
| 405 for an operator, and the 403 above for a read-only person | the path is not an act of a module that is switched on |
| 404 | the request is a GET. An act is always a POST, so its arguments are never in an address |
| 400, `args_invalid` | the body is not a JSON object |

**What a person is told when there is no reply.** One word, and a status that
says what kind of word it is. A page goes by the word.

| Word | Status | Means |
| --- | --- | --- |
| `args_invalid` | 400 | the arguments do not have the act's shape, or one of them looks like a credential |
| `not_allowed` | 403 | the person's role may not do the act. This is the daemon's word. The console refuses such a person first, with its own sentence |
| `act_unknown` | 404 | the module has no such act |
| `module_off` | 409 | the module was switched off |
| `failed:<code>` | 422 | the act was understood and was not carried out. The module or one of the two lists says why in one word, such as `failed:name_taken` or `failed:reach_address_refused` |
| `busy` | 503 | 16 acts are running, or 120 acts of operators have started in the last minute |
| `daemon_unreachable` | 503 | the act did not reach the daemon, and nothing of it was carried out. The daemon is not running, it is starting or stopping, it has not yet opened the door for a module that was just switched on, or what answers at the door's port is not the door |
| `failed:module_not_running`, and each `failed:` word that ends in `_unavailable` or `_unreadable` | 503 | HX Fortress cannot do it now, and the same request may work later. The module is not running, the act cannot be recorded (`audit_unavailable`), the key store does not answer (`secret_unavailable`), or one of HX Fortress's own files cannot be read (`reach_list_unreadable`, `secret_names_unreadable`, a module's `state_unreadable`) |
| `failed:timeout` | 504 | the act did not end within 25 seconds. It is not stopped. For an act of operators, the audit trail says how it ended |
| `failed:interrupted` | 502 | the daemon took the act and stopped before the answer came whole. The act may have been carried out. The console does not send it a second time |
| `reply_invalid` | 500 | the module's reply did not have its shape, or was too large. The act was carried out |
| `failed:internal`, `failed:request_invalid`, `failed:secret_not_declared`, `failed:not_allowed`, `failed:organization_not_held`, and each word that starts with `failed:egress_` or `failed:folder_` | 500 | a defect on this side. The module failed in a way it did not name, the console's hand-over was not well formed, or the module did what its own manifest does not allow |

**The two lists a person adds to.** A module calls no host that its manifest
does not list and reads no secret that its manifest does not list. A database's
address and the name of its login's secret are not known when the binary is
built, so a person adds them. Of the calls a module is given, only those of an
operator's act can change either list, and only while that act runs. An ask, a
release, an act for every signed-in person and a context that a module kept
after its act cannot. A module that tries is refused, and the try is recorded
as the module's own refused call, which names no person. This is a rule for
those calls. A module is code of this
build and runs as the user HX Fortress runs as, so nothing keeps it from the
two files themselves: see
[A module is not confined inside the process](SECURITY.md#a-module-is-not-confined-inside-the-process).

- **A host and a port, under a name** (a "reach"). It is where a helper program
  of the module may be sent. A private address is taken, because a database is
  usually at one. Refused:
  - a loopback, link-local, unspecified or multicast address, also when it is
    written inside an IPv6 address: mapped, compatible, translated, behind the
    well-known NAT64 prefix, 6to4 or ISATAP;
  - every address in the local-use NAT64 prefix (`64:ff9b:1::/48`) and in
    Teredo (`2001::/32`), because the text does not say which IPv4 address one
    of them leads to;
  - the addresses and the names of a cloud's metadata service that this build
    knows (the list is in `src/host/reach-address.ts`, and a list can miss
    one), and the two addresses outside the
    link-local range at which a cloud answers an instance from the inside
    (`168.63.129.16` at Azure, `100.100.100.200` at Alibaba Cloud);
  - `localhost` and the other names that mean this machine in a common hosts
    file;
  - a text that is not a host, a port outside 1 to 65535, a name that is
    already on the list, and a 65th entry.

  The check reads the text and nothing else. It does not look up what a name
  resolves to. It does not know this machine's own address on its network or
  its own host name, so it takes both. The address under a name never changes:
  a change is a remove and an add.
- **The name of a secret.** `ctx.secrets` then reads that name for the module,
  besides the names in its manifest, for this HX Fortress's own organization.
  Refused:
  - a name that breaks the rule of a key store;
  - a name that one of this HX Fortress's own settings names: its database's
    address, its model's key, its sign-in's client secret and its own
    certificate;
  - a name that `organizations.json` keeps another organization's secret under;
  - a name that a manifest lists, and a 193rd name. The list takes 192: three
    for each of the 64 connections the Databases module takes. A connection
    names a secret for its read login, and can name a second for a write
    login. The third is for a certificate authority of the connection's own,
    which a connection cannot name yet.

  Adding a name reads no secret. The same checks are made again each time the
  module has an added name read. So a name that a person added first, and that
  a setting came to name later, is not read for the module. While a setting or
  `organizations.json` cannot be read, no added name is read and none is
  added.
- A name or a host that the audit trail would write as `[redacted]`, because it
  looks like a credential, is refused where it is added. The daemon refuses an
  act whose argument looks like one, before the module hears of the act.
- Each list is one file beside the module's state, readable only by the user
  HX Fortress runs as: `modules/<module>/reach.json` and
  `modules/<module>/secret-names.json`. A file that is there and fails a check
  is not read as an empty list: nothing in it is used, nothing is added to it
  and nothing is written over it. A file that somebody edited to hold an
  address this HX Fortress refuses is such a file. So is a named pipe or a
  very large file at that path: it is not waited on and not read.
- These hosts are not yet entries of the one list of hosts, and `hx-fortress
  hosts` does not print them yet: see
  [The addresses HX Fortress calls](#the-addresses-hx-fortress-calls). They
  move into `hosts.json` in a change that follows this one. Until then the
  two places that show them are the console's list of data paths and
  `hx-fortress modules list`. A helper program is sent to these hosts and to
  no other: see the next section.

The console's list of data paths gains two rows while a module that takes acts
is on: the acts, and the hosts a person added with who added each one.

### A helper program: what the daemon runs for a module

A module opens no socket and starts no process. Where a module needs a database
reached, the daemon runs a helper program for it: another binary on this
machine, given one job. The one program of this build is DB IO, which the rest
of this README still calls the data runner.

**The daemon's list of programs is closed** (`src/host/program-list.ts`). For
each program it fixes which one module the program is for, which variable of
the daemon's environment holds its path, which arguments it is started with and
which variables it is given. No manifest, ask, release or act can change one of
those. A module's manifest names the programs it may have run by their id, and
nothing else: `programs: [{ id: "data-runner" }]`.

| Program | For the module | Its path | Started as |
| --- | --- | --- | --- |
| `data-runner` (DB IO) | `databases` | the value of `FORTRESS_DATA_RUNNER` | `<path> run --job-stdin` |

A module has a program run with `ctx.programs.run(id, run)`, on every context.
It hands over four things:

- **`reach`**: the name of a host that a person added for this module. The
  daemon looks the name up in its list. A module cannot pass an address.
- **`secrets`**: for the field `password`, and for `caCertificate` when the
  connection has a certificate authority of its own, the name of a secret that
  a person added for this module. The daemon reads each value. The module never
  holds one. A name from the module's own manifest is handed to no program.
- **`input`**: the job, as a JSON object, without an address and without a
  secret.
- **`onOutput`**: a listener for what the program prints.

**The daemon writes the job itself.** It takes the module's `input` and puts
four things into it:

| The daemon puts in | From |
| --- | --- |
| `server: { host, port }` | the host as the person added it. This is the name that the server's certificate is checked against, unless the job's own `tls.serverName` names another |
| `reach: { kind: "direct", host, port }` | the address that the daemon looked up for that host just before the run, and checked. The program connects to this address and looks nothing up itself |
| `login.password` | the value of the secret that `secrets.password` names |
| `tls.caCertificate` | the value of the secret that `secrets.caCertificate` names, when the run names one |

**The order of the checks.** Every check that reads no secret and looks up no
name comes first, then the record, then the secrets and the look-up, then the
start.

1. The program is one that the module's manifest lists and that the daemon's
   list gives to this module. The module is running, and runs fewer than four
   programs.
2. The run has a listener, and its `signal`, when it has one, is a signal. A
   signal that is aborted already ends the run here as `program_failed`:
   nothing is read for it and nothing is recorded. The job is a JSON object
   with a `login` object. It holds no `server`, no `reach`, no `login.password`
   and no `tls.caCertificate`. `secrets` names `password`, and no field besides
   the two. In this build a job holds no `store.gatewayUrl` either. That is the
   address to which the program sends the rows it reads. A later change brings
   a door on this machine for those calls, and until then no pull and no
   compare runs.

   **A field's name is judged as DB IO reads it.** DB IO takes a name without
   regard to the case of its letters, so `Tls` is its `tls`. Where the daemon
   looks (the job itself, and its `login`, `tls` and `store`), a name is plain
   letters, digits and `_`. A name that differs from one of the daemon's own
   only in the case of its letters makes the job `job_invalid`.
3. The host's name is on the module's list of hosts, and each secret's name is
   on its list of secret names.
4. The variable names a file that somebody may run. The daemon looks at the
   file and does not start it. So a host with no such file reads no secret for
   it. A file that is there and cannot be started after all, such as a program
   built for another machine, fails at step 7, after the secret was read.
5. The first half of the record is written to the audit trail. A run that
   cannot be recorded is not made.
6. The two lists are looked at again: a host or a secret's name that an
   operator took off since step 3 ends the run. Each secret is read. The
   host's name is looked up, and every address it leads to is held to the rule
   for a host that a person adds: a name that leads to this machine, to a
   link-local or multicast address or to a cloud's metadata address is refused
   whole. A caller's signal that is aborted by now ends the run before the next
   thing is read.
7. The program is started, with no shell. The module's count is looked at
   again here. Calls that come at the same moment can all pass step 1, and the
   one that is too many is refused here as `busy`, after its secret was read.
8. The second half of the record is written. A module's switch-off and the
   daemon's stop wait for it.

**What the program is given.** Its command line is its path and the list's
arguments. The job goes to its standard input, which is then closed, so a login
is in no command line and in no variable. Its environment holds `PATH`, and
`SSL_CERT_FILE` and `SSL_CERT_DIR` when the daemon has them, which is where a
program finds a company's certificate authorities on Linux. It holds the list's
own variable, `DB_IO_NAMES_ITSELF=1`, which asks DB IO to add its version and
commit to what it prints. The program in this repository's folder
`data-runner/` does not read the variable yet: the version that does comes in
a change of the Databases module. It holds nothing else of the daemon's: no
proxy, no secret, no address of a database. It runs in the machine's root
folder.

**What comes back.** The program prints JSON on its standard output, one value
to a line, at most 16 MiB in a run. The daemon hands each value to the module's
listener and does not look into it, log it or record it: it can hold rows. What
the program prints on its error output goes to the daemon's log, at most 64 KiB
and 1,000 lines for a run, with anything that looks like a credential replaced.

**What ends a run.** Its time: five minutes when the module names none, and
never more than thirty. The module's own signal. The module being switched off.
The daemon's stop. The program is asked to stop first, and killed five seconds
later if it is still there. A run that the daemon ended is never answered
`ok`, whatever the program printed when it was asked to stop: DB IO answers a
stop by printing its failure and leaving with 0. The daemon cannot end a
program when the daemon itself is killed: DB IO stops at its job's own
deadline.

**The answer is one word.** `ctx.programs.run` never rejects. It answers
`{ ok: true }`, or `{ ok: false, code }`:

| Word | Meaning |
| --- | --- |
| `program_not_declared` | the manifest does not list the program, or the daemon's list does not give it to this module |
| `module_not_running`, `busy` | the module is not running; or it runs four programs already, or the daemon is stopping |
| `job_invalid` | the job is not one a module may hand over (step 2), or the finished job is larger than 1 MiB |
| `reach_not_listed` | no person added a host under this name, or the list cannot be read, or the host was taken off the list while the run was prepared |
| `secret_not_added` | no person added this secret's name for the module, or a setting of this HX Fortress reads that name too, or the list cannot be read, or the name was taken off the list while the run was prepared |
| `program_not_installed` | the variable is not set, or names no file that somebody may run, or the file could not be started |
| `audit_unavailable` | the record could not be written, so the run was not made. The daemon's log says so |
| `secret_missing`, `secret_unavailable` | the key store holds no such secret; or it did not answer |
| `reach_unresolved` | the host's name was not found, or its look-up failed or took more than five seconds, or it answered more than 64 addresses or what is no address |
| `reach_address_refused` | the host's name leads to an address that no program is sent to |
| `timeout` | the run's time was up, and the program was ended |
| `program_failed` | the program could not be started, ended badly, was ended by the daemon before it was done, or printed what is not JSON or more than it may. Also a run that its caller had given up before anything was started |

**Recorded.** A run that passes steps 1 to 4 is a pair `system.module.program`
in the audit trail, with the module, the program's id and the name of the host.
Its second half says how the run ended, with the word. The pair holds no field
of the job and nothing the program printed. A run that fails one of steps 1 to
4 leaves a record `system.module.refused` with the word, and nothing of what
was asked for. As for every refusal of a module's own call, the same refusal
within a minute is counted and not written again: one more record with the
count follows when the minute ends. Two runs leave no record: one whose record
could not be written (`audit_unavailable`), which the daemon's log says, and
one that its caller had given up before the call. In an answer to the control
plane's `audit.read`, a line of a run or of a refusal
has the module's id as its target: the name of the host stays on this
HX Fortress.

**Shown.** `hx-fortress modules list` prints the program and the variable under
`Runs:`. The console's list of data paths says for the row of added hosts what
a program sends there and how it is started.

**The Databases module says five of these words as its own.** Its answers to
the control plane and its page keep the words they had: `reach_unresolved` and
`reach_address_refused` read `unreachable`, `job_invalid` and
`audit_unavailable` read `not_ready`, and `module_not_running` reads
`interrupted`. The daemon's own word is in the record of the run, or, for
`audit_unavailable`, in the daemon's log.

### The data runner

The data runner is the program HX Fortress starts beside itself to do one job on
a database. It dials one server, does one thing, prints one line and exits. Its
source is the folder `data-runner/` of this repository, a Go module of its own.
`data-runner/README.md` is everything its caller relies on: the command, the
job, the output, and what it opens on the network.

One kind of job opens more than one session. A `query` whose `params` hold
`onlyOpenable` also opens each database its rows name, on the same server and
with the same login, and answers only the databases that login may open. The
program's home uses it. HX Fortress builds every job itself and never sets
that key, so a job that HX Fortress starts opens one session at a time, on the
connection's own database.

A script writes that folder from the program's home repository, and nothing in
this repository edits it. `data-runner/FILES.sha256` lists every file with its
checksum, and a test fails when a file differs or one is added.
`data-runner/VENDORED.md` says what was left out. A change to the program is
made at its home, and the folder is written again.

A query's statement is checked twice before it runs: by the `databases` module's
scan, and then by the program's own rule, which reads each of the four engines
its own way. The program reads the statement before it opens anything, so a
statement it refuses reaches no server and signs in nowhere. The program
publishes that rule as examples, in
`data-runner/contract/vectors/query-refusal.json`. A test holds the module's
scan to every one of them, on each engine an example names: the same answer,
and for a refusal the same reason. It holds the two lists of words that write
to each other too. A change to either check that alters its answer for one of
these examples fails that test. The examples do not cover every statement, so
the test shows a difference only where an example stands.

One more check is the program's alone, because it needs the database. Both
checks take a character outside ASCII inside quoted text and comments, as it is
written. On two engines the database can read such a text differently when its
character set is not Unicode:

- **Oracle.** The program's driver writes a statement in the database's own
  character set, and writes some characters outside ASCII as an ASCII character
  that looks alike, a quote among them. Quoted text then ends earlier for
  Oracle than for the check.
- **MySQL.** A server can be set to read statements in another character set
  than the one the program asks for. It can then read the last byte of such a
  character together with the backtick after it as one character, and a quoted
  name ends later for MySQL than for the check.

SQL Server takes a statement as Unicode. PostgreSQL refuses a character its
encoding does not hold, and reads no byte of such a character as an ASCII
character. So for a statement that holds a character outside ASCII, the program
first asks an Oracle or MySQL database which character set it reads a statement
in, and runs the statement only when the answer is Unicode. A statement of
ASCII characters alone asks nothing.

On every pull request CI checks the folder against its list, runs the program's
own tests, and builds it for the four platforms HX Fortress is released for. The
dependency audit covers its Go module, and the static analysis reads its code.

One script builds the program everywhere: `scripts/build-data-runner.sh`. It
copies the files the folder's list names into an empty folder, checks each copy
against its checksum, and builds there with the version of Go that
`data-runner/go.mod` names. So a file that was added to the folder is never
compiled, and a listed file that differs stops the build. The result is one
file for each platform, with no C code in it. The two linux files are static.
CI builds the four files twice and fails when the two builds differ.

```sh
scripts/build-data-runner.sh dist            # the four platforms, needs Go
scripts/build-data-runner.sh dist dev linux/amd64
```

A release holds the program beside HX Fortress's own binaries, built from the
folder at the release's commit:

| File of a release | What it is |
| --- | --- |
| `hx-fortress-data-runner-<os>-<arch>.gz` | the program, for `darwin-arm64`, `darwin-x64`, `linux-arm64` and `linux-x64` |
| `hx-fortress-data-runner-<os>-<arch>.sha256` | the SHA-256 of the program before it was compressed |
| `hx-fortress-data-runner-<os>-<arch>.sig` | its signature, when the release is signed |

`data-runner version` prints the release's version and commit, as
`<version>+<commit>`. The files are in the release's build-provenance
attestation with the others.

The image holds the program at `/usr/local/bin/data-runner`, owned by root, and
sets `FORTRESS_DATA_RUNNER` to that path. It is the same file as the release's
`hx-fortress-data-runner-linux-x64`: CI builds both and compares them. The image
also holds the system's certificate authorities, which the program reads when a
connection checks a server's certificate and names no authority of its own.

Every pull request builds the image and runs the two scans of a release on it.
The image scan reads the version of Go and the modules the program was built
with, so an advisory against one of them is usually seen on a pull request
first. `RELEASING.md` says what happens when a release sees it first.

The daemon reads `FORTRESS_DATA_RUNNER` each time a module has the program
run: see
[A helper program](#a-helper-program-what-the-daemon-runs-for-a-module). An
install on a host does not fetch the program. Where the variable names no file
that can be run, a test of a connection ends as `program_not_installed`.

### What the control plane may ask the `stores` module

A Store is a working copy of tables, kept in one SQLite file on this
HX Fortress's disk. Each Store has a folder of its own inside the module's
folder for its organization, readable by the user HX Fortress runs as and by
nobody else. The control plane names a Store by an id. The id is never part of
a path: the module gives each Store a folder name of its own (`s000001`).

| Ask | Takes | The answer holds |
| --- | --- | --- |
| `create` | a Store's id, and a name for people to know it by | the id, the Store's state, and whether this ask made it. Asked again for an id that is there, it changes nothing |
| `list` | nothing | each Store's id, name and state, the bytes its folder takes on the disk, and when it was made. For a Store that a restore waits for: the line of its history that was asked for, and when |
| `catalog.read` | a Store's id and a page number | the names of the Store's tables and columns, a page of 40 tables at a time. For each table: its name, its kind (`program`, `managed` or `system`), whether it is a view, how many rows it has and whether that is an estimate, its version, and how many columns it has. For each column: its name, its type as one word, and its place in the table's key |
| `stats.read` | a Store's id | counts: bytes, tables, rows, files and their bytes. Whether a job is running, until when a job waits, the day's written rows and limit, and whether that limit is the Store's own |
| `history.read` | a Store's id | the lines of the Store's history, newest first: each line's id, time and kind, who it is by, and whether the Store can be taken back to the moment before it. And how far back the Store can be taken |
| `review.read` | a Store's id | the tables in which rows wait for a person's review, each with how many |
| `job.read` | a Store's id and a job's id | the job's kind and state, its times, the step it is on, counts of rows and tables, the one word it waits or failed with, and for a pull the name of each table it read with that table's own counts |
| `write_limit.set` | a Store's id and a number of rows | the Store's new daily write limit |
| `delete` | a Store's id | the Store's state. The ask only notes that a delete was asked for |
| `restore` | a Store's id, and the id of a line of its history | the Store's id, the line, and when the restore was asked for. The ask only notes that a restore was asked for |

`hx-fortress modules list` prints every field of every answer.

What these ten asks cannot do:

- **No ask takes a statement, and no answer holds a row.** A column's type is
  one word from the same list of nine that the `databases` module uses. A
  table's or a column's name that an answer cannot hold is left out and
  counted. It is never rewritten.
- **No ask removes a Store.** `delete` leaves the Store as it is and marks it
  `delete_waiting`. A person of this HX Fortress decides it. This build has no
  page for that decision yet, so a Store that was asked to be deleted waits.
- **No ask takes a Store back.** `restore` leaves the Store as it is and notes
  which line of its history the control plane asked to go back to. The line
  has to be one that `history.read` answers as a way back, or the ask fails
  with `line_not_restorable`. It names a line, never a time. A person of this
  HX Fortress decides it, and this build has no page for that decision yet
  either. One restore waits for a Store: asking for another line takes the
  place of the one that waited.
- **A failure is one word.** Where the Store's own program refuses a call, its
  word crosses as `engine_<word>`, from a closed list. Its sentence about the
  refusal can quote a value, so it stays in this HX Fortress.
- **A Store's daily write limit has a ceiling the control plane cannot raise.**
  The limit is set to between 1,000 and 100,000,000 rows, and never above the
  organization's ceiling, which is 2,000,000 rows in this build. A Store that
  was given no limit is held to 2,000,000 rows a day.
- **One organization keeps at most 200 Stores here.**

**Each open Store runs in a process of its own.** HX Fortress starts it: this
same binary again, with the word `store-engine`, as
[SECURITY.md](SECURITY.md#a-modules-own-process-runs-as-the-same-user)
describes for every module's process. The process holds the Store's file and
answers the module one call at a time. A call that takes longer than 20
seconds ends the process, and the next ask starts a new one: SQLite cannot be
told to stop a statement from the thread that runs it. At most 8 Stores stay
open: a Store that no call came for is closed after a minute, and the one used
longest ago is closed for a ninth. A Store whose call is running is not closed
to make room, so up to 16 of these processes can run while calls run, and an
ask past that answers `failed:busy`. `hx-fortress store-engine` typed by hand
does nothing and ends: it has no HX Fortress to talk to.

**A Store's files are kept in the Store's own folder.** A file a person
uploads, a table that was put away, and an export are kept in a `files` folder
beside the Store's database, for the user HX Fortress runs as and nobody else.
A file's name is never part of a path on this disk: its bytes and its record
are kept under names HX Fortress makes. Removing a Store removes its files.
One Store cannot read another's files.

**A Store keeps snapshots of itself, and can be taken back to one.** Before
each change that it can undo (a migration, a table's new version, the start
of a pull), the Store's program marks the moment, and HX Fortress keeps a
snapshot: a whole copy of the Store's file, in a `snapshots` folder beside it.
A line of the Store's history is a way back while the Store holds that line's
snapshot and the line is no older than thirty days. A Store keeps its ten
newest snapshots. While a restore waits it keeps two files more: the snapshot
the restore names, whatever its age, and the copy that takes the Store's
place. Each is as large as the Store's file was at its moment. So a Store's
folder can take many times the size its file has now: eleven times and more,
and far more for a Store that was taken back to a moment at which it was
small. `list` answers what the folder takes. A Store whose file is larger than
256 MiB keeps no snapshot and cannot be taken back: the snapshots it took
while it was smaller are no way back from then on, and are removed when its
program next marks a moment. A restore that a person approved is carried out
when the Store's file is next opened. The copy that takes the Store's place
is made when the restore is readied, the process that readied it is closed,
and the copy gets the file's name before the next call runs. The Store's
history keeps its lines since that moment and gets a line for the restore, by
`console`. That line is a way back too: going back to it undoes the restore.

**This build can make a Store and cannot fill one yet.** The calls that hold
rows are a person's, made from that person's browser, and this build has no
door for them yet. For the same reason no file reaches a Store yet, and it
has no pull from a database. So a Store's history has no line yet, and there
is nothing to take a Store back to. With `stores` switched
on and no Store made, `list` answers an empty list, and every ask that names a
Store answers `failed:store_unknown`.

The module is off after `hx-fortress setup`, `install` and `enroll`. A person
of this HX Fortress switches it on:

```sh
hx-fortress modules on stores
```

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

When the control plane offers a release, HX Fortress does this and nothing else:

1. It refuses the offer if it carries no signature. This holds in every build
   and under every setting.
2. It refuses the offer unless the signature verifies, against a signing key
   compiled into this binary, over the module, the version and the sha256 that
   the offer names. Nothing is downloaded before this check. And until it
   passes, the control plane is told nothing about which modules are on, which
   hosts are listed, or what is on the shelf.
3. It refuses the offer unless the file's address is on the control plane's own
   origin, which is the host and port HX Fortress connects to, or on a host
   listed in `FORTRESS_RELEASE_HOSTS`. A redirect is held to the same rule.
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
  control plane brings it back, under the same id.
- `hx-fortress releases refuse <id>` removes the file. A refused release stays
  refused when it is offered again.

The control plane is told how each release ended.

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
| `control_plane.ask` | the control plane sends an ask. When the ask ran: one record before the module was called, which holds a digest of the grant's id, and one with how it ended. When the ask was refused: one record with the rule that refused it |
| `control_plane.ask.overflow`, `system.module.refused.overflow` | only on a Fortress that holds more than one organization: asks for other organizations, or a module's own calls for them, were refused after the minute's 60 different refusals were written. One record says how many. It names no organization and is in no organization's count |
| `control_plane.release.offer` | the control plane offers a release. It is held as waiting, or refused with the rule |
| `control_plane.module.remove` | the control plane asks to remove a module. This is always refused |
| `control_plane.session_call`, `control_plane.tool_call` | the control plane sends a call that reads or writes a session, or a call of one of HX Fortress's tools, while session content is off on the connection. Always refused, with the rule `session_content_off`. See [Session content on the connection](#session-content-on-the-connection) |
| `cli.module.on`, `cli.module.off` | a person switches a module at the terminal |
| `system.module.switch` | the daemon starts or stops the module |
| `cli.release.approve`, `cli.release.refuse` | a person decides a release at the terminal |
| `system.release.approved`, `system.release.refused` | the daemon records that decision, and who made it |
| `system.release.install` | the daemon hands an approved release to its module. One record before the module is called and one with how it ended |
| `module.<id>.<action>` | a module records its own work. A record that it writes of a person's act, while that act runs, is under the person's login: the module says which record that is, and the daemon says who. Every other one names no person |
| `console.module.act` | a person at the console has a module do something. For an act of operators: one record before the module is called and one with how it ended, under the person's login. For an act that the daemon turned away: one record with the rule. That includes a read-only person's try at an act of operators, which the console refuses and tells the daemon about: at most 30 times a minute from one address, and not while the daemon is stopped. An act that every signed-in person may do is not recorded one by one |
| `console.module.act.ended_late` | an act of operators that was answered `failed:timeout` went on, and has ended. One record with how it ended: `ok`, or `failed` with the module's word |
| `console.module.reach.add`, `console.module.reach.remove` | a person adds or removes a host a module's helper program may be sent to. One record before the list is changed, with the name, the host and the port, and one with how it ended. When two acts remove the same host at the same moment, the one that found it gone ends `unchanged`. An add under a name that is taken is refused, also when another act added the same host a moment before |
| `console.module.secret.add`, `console.module.secret.remove` | a person adds or removes the name of a secret a module may have read. The name is recorded. A value never is. When two acts add or remove the same name at the same moment, the second ends `unchanged`. In the lines that the `host` module gives the control plane, `unchanged` reads as `ok`: a line has three words for how a thing ended |
| `system.module.refused` | a module made a call that it may not make: a secret or a host that is not its own to use, or a change to one of the two lists outside an act of operators (`list_change_not_allowed`). The record names the module and the rule, and no person |
| `system.local_door.refused` | a call to the daemon's door on this machine was turned away. The record holds the rule: the call did not come from this machine (`door_peer`), it named another host (`door_host`), it carried a browser's header (`door_browser`), it did not prove that it holds the secret (`door_secret`), it was not new (`door_replay`: the door took it before, or its time is not now), it was for a path the door does not have (`door_route`), or its body was not JSON (`door_body`) |

The control plane decides how often it asks, so the records of refusals are
bounded. A run of the same refusal within a minute is two records: the first
refusal, and one more with the count of the rest. At most 60 different refusals
are written in any minute. Past that they are counted, and one more record per
action (two where HX Fortress holds more than one organization) says how many.

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
| A module's folder for files | `modules/<module>/data/` | `organizations/<id>/modules/<module>/data/` |
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
Who holds each role is a fact about the whole HX Fortress, so `access.groups`
tells another organization how HX Fortress counts, and no row and no holder, and
reads nothing but `oidc.json` for it.

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
| `FORTRESS_RELEASE_HOSTS` | none | Comma-separated hosts that a release file may also be downloaded from, over https. An entry is a name, which means port 443 and no other, or `name:port`. The control plane's own origin is always allowed. The daemon is what reads this, so set it where the daemon runs. |
| `FORTRESS_ALLOW_DEV_RELEASES` | off | Accept a release signed by the development key. Ignored once the build carries a production signing key. |
| `FORTRESS_ASK_MAX_IN_FLIGHT` | `16` | How many asks may run at once. A value above `256` is held to `256`. |
| `FORTRESS_ASK_MAX_PER_MINUTE` | `300` | How many asks may start in any minute. A value above `6000` is held to `6000`. |

| File under `$FORTRESS_ROOT` | Holds |
| --- | --- |
| `config.json`, key `modules.enabled` | the ids of the modules that are switched on |
| `modules/releases.json` | every release that was offered and verified, and what was decided about it |
| `modules/<id>/artifacts/` | the file of each release that waits or failed |
| `modules/<id>/state/` | a module's own small records, one file per key |
| `modules/<id>/data/` | a module's own folder for files: a database file and the files beside it. Made the first time the module asks for it |
| `modules/<id>/reach.json`, `modules/<id>/secret-names.json` | the hosts and the names of secrets that a person added to a module at the console. Absent until a person adds one |
| `organizations.json` | the other organizations this Fortress holds. Absent on a Fortress that holds one organization |
| `organizations/<organization>/modules/<id>/state/` | what a module keeps for another organization this Fortress holds |
| `organizations/<organization>/modules/<id>/data/` | a module's folder for files, for another organization this HX Fortress holds |
| `identity/organization.json` | an id this Fortress makes for its own organization, the first time a module reads it. A module keys what it keeps for that organization by it. It is not the id a grant uses, and the Fortress itself puts it in no answer and no audit record. Keep it with the data. A file that is damaged is never replaced. If the file is lost, the Fortress makes a new id, says so in its log, and no longer finds what was keyed by the old one |
| `runtime/release-decisions/` | a decision that the terminal has asked the daemon to carry out |
| `runtime/module-settings.json` | the hosts in `FORTRESS_RELEASE_HOSTS` as the running daemon read them, for the console to show |
| `runtime/local-door.json` | the port and the secret of the daemon's door on this machine. There only while a module that takes acts is switched on and the daemon runs |
| `runtime/daemon-environment.json` | what the running daemon's environment names for `FORTRESS_UPDATE_URL`, `FORTRESS_CONTROL_PLANE_KEY`, `FORTRESS_PGVECTOR_URL` and `FORTRESS_PG_BINARIES_URL`, for a terminal and the console to go by. It counts only while the daemon that wrote it runs, and that daemon writes it again with its status file when something replaced it. It holds addresses and public keys, and no secret |
| `identity/control-plane-keys.json` | the key of the control plane as it was pinned on this host: public keys only |

Each of these is readable by the Fortress's own user only.

## Running as a container

`hx-fortress host` also runs headless in a container — no TUI, no interactive
enroll wizard. A container started with only environment variables and an empty
mounted volume enrolls with its control plane on first boot and serves the
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
| `FORTRESS_ENROLL_TOKEN` | first boot | One-time enrollment token from the control plane. |
| `FORTRESS_CLOUD_URL` | first boot | The control plane's address, as the control plane gives it: a `wss://` address such as `wss://control.example/v1/connection`. There is no default. Nothing about updates is worked out from it. |
| `FORTRESS_CONTROL_PLANE_KEY` | no | The control plane's key, named in the daemon's environment: `<id>:<public key>`, or several separated by commas. With it set, nothing the control plane publishes is pinned. See [The control plane's keys](#the-control-planes-keys). |
| `FORTRESS_UPDATE_URL` | no | A base address that `hx-fortress update` and the pgvector download take their files from, in place of the project's releases, named in the daemon's environment. See [Update](#update). |
| `FORTRESS_SESSIONS` | no | `on` or `off`: whether this fortress stores AI session transcripts. See [Sessions on or off](#sessions-on-or-off). Unset, the choice in `config.json` stands, and a new fortress has Sessions on. |
| `FORTRESS_CONNECTION_SESSION_CONTENT` | no | `on` or `off`: whether session content may travel on the connection to the control plane. See [Session content on the connection](#session-content-on-the-connection). Unset, the choice in `config.json` stands, and with none HX Fortress serves session calls as before the setting existed. Set and empty, it stops the start. |
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
| `FORTRESS_STORE_OP_TIMEOUT_MS` | no | Per-call deadline for ordinary storage calls (default `20000`). Values above the 30s that a call over the connection is given only help direct-gateway callers. |
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
kept its connection for the remaining ~95 s while the control plane enqueued a
durable replay that queued behind it. And the healer could not see any of it:
its probe is a standalone one-connection canary, so it answered instantly
throughout and `/healthz` and `/readyz` stayed green for ~13 hours.

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
noncurrent versions expire (scoped to `.session-vault/` — the organization's
data is untouched). **Both commands REPLACE the bucket's entire lifecycle
configuration** — if your bucket already carries lifecycle rules (transitions,
expiries), merge these into your existing set instead of pasting verbatim. GCS —
`gcloud storage buckets update gs://<bucket> --lifecycle-file=<json with the
.session-vault/ noncurrent-delete + age-7 rules>`; S3 — `aws s3api
put-bucket-lifecycle-configuration --bucket <bucket> --lifecycle-configuration
'{"Rules":[{"ID":"hx-session-vault-probe","Status":"Enabled","Filter":{"Prefix":".session-vault/"},"NoncurrentVersionExpiration":{"NoncurrentDays":1},"Expiration":{"ExpiredObjectDeleteMarker":true}},{"ID":"hx-session-vault-probe-strays","Status":"Enabled","Filter":{"Prefix":".session-vault/"},"Expiration":{"Days":7}}]}'`.

`FORTRESS_ENROLL_TOKEN` + `FORTRESS_CLOUD_URL` are consumed only on the first
boot of a fresh volume; once a credential is saved they are ignored. Storage
credentials are re-applied from the environment on every boot, so rotating a key
is a redeploy.

### What an install hands over

`hx-fortress install` gives the container it makes these settings, and
HX Fortress reads them at its first start. A template that makes the container
another way can set the same ones.

| Variable | Purpose |
| --- | --- |
| `FORTRESS_SETUP_SETTINGS` | One settings file, as text: the organization's name, sign-in, modules, the AI model, the network, updates and the audit trail. It holds no key. It is read once, when the volume holds no settings; afterwards these answers are HX Fortress's own. The entry point runs `hx-fortress setup --from-environment` for it, and the container exits when an answer fails its check. |
| `FORTRESS_INSTALL` | The facts of the place, as JSON: `place`, `region`, `certificate`, `database`. HX Fortress shows them and decides nothing from them. |
| `FORTRESS_CONTROL_PLANE_PAGES` | The one origin whose pages may show a page of this HX Fortress, such as `https://app.control.example`. Not set, or not exactly one origin: none may. |
| `FORTRESS_UI_BOOTSTRAP_TOKEN_DIGEST`, `FORTRESS_UI_BOOTSTRAP_TOKEN_EXPIRES` | Beside `FORTRESS_UI_BOOTSTRAP_USER`: the sha256 of a one-time token that the install made and kept, and the time its link ends. The first account is made for that token, so the install can show the link and HX Fortress never holds it. Honoured only while HX Fortress holds no account at all. |

The key store, the address, the database and the control plane arrive in the
variables this section already lists. Two values are secret and belong in the
platform's own secrets: `FORTRESS_ENROLL_TOKEN`, and each `FORTRESS_SECRET_*`
when the key store is the container's own settings.

### Sessions on or off

Sessions is the module that stores AI session transcripts in a bucket the
organization owns. It is on by default. A fortress can run with it off. It then
needs no bucket and no embedding key, takes in no transcripts, serves none, and
tells the control plane nothing about storage. It still enrolls, keeps its
connection to the control plane, serves its console and keeps its audit trail.

The choice is made on this host. Nothing the control plane sends can change it.
An HX Fortress reads it once, when it starts, so a change takes effect at the
next start.

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
- A request from the control plane that needs sessions is answered with a
  refusal.
- The console's pages about sessions say that Sessions is off. Its controls
  that act on stored sessions refuse with that reason, and so does a rotation
  of the bucket credentials or the embedding key. The checkup reports the
  object store and the embeddings as not configured.
- The Adoption page stays: the roster still arrives from the control plane and
  is still stored.

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
memory, and writes it to no file and no log. A control plane never holds a
value: the most it sees is a name.

A name is 1 to 64 characters of `a-z`, `0-9` and `-`.

| Provider | Where the secret `db-url` is read from | What it needs from the host |
| --- | --- | --- |
| `env` (default) | The variable `FORTRESS_SECRET_DB_URL`. | Nothing. |
| `file` | The file `<dir>/db-url`, the layout of Docker secrets and Kubernetes secret volumes. It is read at every use, so replacing the file replaces the secret. | Nothing. |
| `aws-secrets-manager` | The current version of the secret `db-url` in AWS Secrets Manager, in one region, read with the role of the task or machine. There is no access key in the settings and no AWS SDK. A value is kept in memory for one minute by default. | A role. HX Fortress must run where AWS gives it one: an Amazon ECS task with a task role, AWS Fargate included, or an Amazon EC2 instance with an instance profile. |
| `azure-key-vault` | The secret `db-url` in one Azure Key Vault, read with the managed identity of the machine or container. There is no client secret and no Azure SDK. A value is kept in memory for one minute by default. | A managed identity. HX Fortress must run on an Azure service that gives it one, such as Azure Container Apps, App Service or a virtual machine. |
| `google-secret-manager` | The newest version of the secret `db-url` in one Google Cloud project, read from Secret Manager with the service account of the machine or container. There is no key file and no Google SDK. A value is kept in memory for one minute by default. A regional secret is not read. | A service account. HX Fortress must run on a Google Cloud service that gives it one through the metadata server, such as Cloud Run or Compute Engine. On Compute Engine the machine also needs the `cloud-platform` access scope. |

| Variable | `secrets` key in `config.json` | Purpose |
| --- | --- | --- |
| `FORTRESS_SECRETS_PROVIDER` | `provider` | `env`, `file`, `aws-secrets-manager`, `azure-key-vault` or `google-secret-manager`. Default `env`. |
| `FORTRESS_SECRETS_DIR` | `dir` | `file` only. The directory, as an absolute path. Default `$FORTRESS_ROOT/secrets`. |
| `FORTRESS_SECRETS_AWS_REGION` | `region` | `aws-secrets-manager` only. Required. The region whose Secrets Manager holds the secrets, such as `us-east-1`. |
| `FORTRESS_SECRETS_CACHE_SECONDS` | `cacheSeconds` | `aws-secrets-manager`, `azure-key-vault` or `google-secret-manager` only. How long a value is kept in memory, from `0` to `900`. Default `60`. |
| `FORTRESS_SECRETS_AZURE_VAULT_URL` | `vaultUrl` | `azure-key-vault` only. Required. `https://<name>.vault.azure.net`. The host must be a Key Vault host of a known Azure cloud, because the identity's token is sent there. |
| `FORTRESS_SECRETS_AZURE_CLIENT_ID` | `clientId` | `azure-key-vault` only. The client id of a user-assigned managed identity. Leave it out to use the system-assigned one. |
| `FORTRESS_SECRETS_GOOGLE_PROJECT` | `project` | `google-secret-manager` only. Required. The id of the Google Cloud project that holds the secrets, or its number. |

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

With `aws-secrets-manager`, the role needs `secretsmanager:GetSecretValue` on
each secret that HX Fortress reads, and nothing else. Where a secret is
encrypted with a key of the organization's own, the role also needs
`kms:Decrypt` on that key.

- The credentials come from the platform: an Amazon ECS task with a task role,
  AWS Fargate included, or an Amazon EC2 instance with an instance profile.
  HX Fortress reads no access key from its environment or from a file. In a
  container on an instance that is not an ECS task, the instance's metadata
  hop limit must be 2.
- A pod on Amazon EKS gets its role through a web identity token
  (`AWS_WEB_IDENTITY_TOKEN_FILE`), which this build does not read. Such a host
  is refused at start, by name: reading with the node's role in its place
  would be the wrong identity. An ECS task on an instance that has no task
  role does read with the instance's role, as AWS's own tools do. Give the
  task a role.
- AWS takes a request only when its time is within five minutes of AWS's own.
  An error says so when this host's clock is further off than that.
- HX Fortress reads the current version of a secret, the one with the stage
  `AWSCURRENT`.
- A secret that is scheduled for deletion cannot be read. It is reported as a
  secret that could not be read, not as a missing one.
- A value that was stored as bytes is read when the bytes are text.
- A secret in another account is not read, and neither are the regions of
  China and of the isolated partitions.

With `azure-key-vault`, the managed identity needs the **Key Vault Secrets
User** role on the vault and nothing else.

With `google-secret-manager`, the service account needs the role **Secret
Manager Secret Accessor** (`roles/secretmanager.secretAccessor`) and nothing
else. Grant it on each secret that HX Fortress reads, or on the project.

- HX Fortress reads the newest version of a secret. That is the version that
  was created last, also when that version is disabled or destroyed, and such
  a version cannot be read. To go back to an earlier value, add that value as
  a new version.
- The bytes of a value are checked against the checksum that Secret Manager
  sends with them. A value that does not match is not used.
- A regional secret is not read.

If the environment names a proxy (`HTTP_PROXY`, `HTTPS_PROXY`), the request to
the key store goes through it as any HTTPS request does. A proxy that only
passes the encrypted connection on sees no token and no value. A proxy that
opens the encryption, with a certificate authority that this host trusts, sees
both. The request for the token, or for the role's credentials, never goes
through a proxy: it is made in clear text to an endpoint on the host itself
or on its link-local network, so HX Fortress adds that endpoint's host to
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
| `FORTRESS_GRANT_ENFORCE` | off | REQUIRE a capability grant on the HTTP gateway + `/mcp` (verify-if-present when off). Switch it on once the control plane sends a grant with every request: a control plane that sends none is then refused. |
| `FORTRESS_TUNNEL_GRANT_ENFORCE` | off | The same requirement for the vault calls and the tool calls that arrive over the connection. Switch it on under the same condition. |
| `FORTRESS_ALLOW_REENROLL` | off | Permit a pending enrollment whose control plane differs from the enrolled one (otherwise a hijack-drop re-enroll is ignored). |
| `FORTRESS_MAX_FRAME_BYTES` | `33554432` | Drop a frame from the control plane that is larger than this (bytes) before parsing it (32 MiB). With session content off and Agentic Sessions off the size is 262144 (256 KiB), and this variable can lower it and cannot raise it: see [Session content on the connection](#session-content-on-the-connection). A value under 1 is ignored. |
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
- **No ingress for the connection to the control plane.** HX Fortress dials out.
  The console is served only when you give it an HTTPS ingress, and that ingress
  can be limited to your virtual network or to IP ranges.
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
takes, with the shape of the arguments and of the answer; every act a signed-in
person may have it do, with who may do it and the same two shapes; the hosts it
may call; and the names of the secrets it reads. Add an entry for it to
`src/host/module-catalog.ts`, and make the module available in
`src/host/main.ts` with `moduleHost.provide(...)`.

A module answers an ask in `onAsk(ask, args, ctx)` and carries out an act in
`onAct(act, args, ctx, person)`. `person` is who the console's sign-in says the
person is: the login, the role, and an email when the login is an email
address. Before `onAsk` is called, the host has checked the grant and the
arguments. Before `onAct` is called, it has checked the person's role and the
arguments.

A module gets a context from the host and works through it:

- `ctx.secrets` reads a secret by name. It refuses a name that is neither in
  the manifest nor on the list of names a person added for this module
  (`ctx.secretNames`).
- `ctx.fetch` calls out over https. It refuses a host the manifest does not
  list, and it does not follow a redirect. Of the options a call may carry, it
  passes on the method, the headers, the body and the signal, and drops the
  rest. A lint rule over `src/modules/` fails the build when a module uses the
  global `fetch` or a Node network module. A library that makes its own
  requests must be given `ctx.fetch` to use.
- `ctx.audit.record` writes one record to the audit trail. A record holds names,
  counts and flags, and it can hold a person's address: a text is kept when it
  is a name or an email as an ask can take one, and any other text is left out.
  If the record names what it worked on in a field called `target`, the `host`
  module reports that name for the line. Of a record `module.<id>.job.<…>` it
  also reports the field `job`, as who the line is by. No other field of the
  record leaves this host.
  - **Such a record names no person,** on every context.
  - **The context of an act has `ctx.audit.recordAct` beside it,** for a record
    of what the person is having the module do: "a connection was added". The
    host writes that record under the person's login, with the console's own
    id for the sign-in, as it writes the act's own two records. That holds for
    an act of operators and for an act that every signed-in person may do. The
    login is kept whole, whatever characters it has.
  - **The host says who, and the module says which record.** A module passes
    no login, and no field of a record can take a person's place. And only a
    record written with `recordAct` names the person: a module does other work
    during an act, such as closing a job that another caller started and that
    was lost, and a line of that work is not the person's.
  - **Only while the act's work has not ended.** Through a context that a
    module kept, after that, `recordAct` writes its record under nobody's
    login. A job that an act started and that ends later is such a case: the
    line of its start names who started it, and the line of its end names
    nobody.
- `ctx.state` keeps small records for the module on disk, one file for each
  key. `ctx.state.remove` removes one, with its file.
  - A value is written under a temporary name and renamed. A daemon that stops
    between the two leaves the temporary file, with the value in it. Those
    files are made in a folder of their own inside the state folder,
    `.writing`.
  - `remove` also removes every temporary file of its key that no write of
    this daemon is using, whichever run left it. Where it could not make sure,
    because the folder could not be listed or a file could not be removed, it
    fails, and the module removes again.
  - The first use of a module's state by a daemon removes what earlier runs
    left there for any key.
  - One daemon writes a state folder. Where two do, as for a moment while a
    new one takes over from an old one, a write of one can be taken for a left
    one by the other, and that write then fails.
- `ctx.reach.list()` and `ctx.secretNames.list()` give the hosts and the names
  of secrets that a person added for this module, for the context's
  organization. Every context can read them. The context of an act has `add`
  and `remove` as well. They work only in an act that the manifest gives to
  operators, and the host records each change under the person's login before
  it makes it. In an act that every signed-in person may do, `add` and
  `remove` reject with `not_allowed`. They also reject on a context that a
  module kept after its act had ended: a change belongs to the act of the
  person who is recorded for it. The host records such a try as the module's
  own refused call, with no person. An act that runs past its 25 seconds has
  not ended, and its context still works.
- `ctx.folder(...names)` gives the module a folder of its own on this host's
  disk, as an absolute path: for a database file and the files beside it. The
  folder is made the first time it is asked for. At every call the host sets
  the folder and every level under it so that only the user HX Fortress runs as
  can read them, and takes the write bit for everybody else off the levels
  above it. Each name is one more level, at most 4. A name is 1 to 64
  characters of `a-z`, `0-9`, `_` and `-`, and starts with a letter or a digit.
  So a dot, a slash, an upper-case letter and `..` are refused, with
  `folder_name_invalid`. An id from an ask is not a name: it can hold dots,
  colons and upper-case letters. Give what the id names a name of the module's
  own first, such as a number the module counts and keeps in its state, and
  never put an id into a path by hand. A module has one folder for each
  organization, and never names the organization: the host builds the path. An
  organization that HX Fortress no longer holds gets no folder
  (`organization_not_held`). The host does not watch or limit what a module
  keeps there, and it removes nothing: a person removes a folder.
- `ctx.processes.start(verb, { folder, onMessage })` has the host start a
  process of the module's own: this same program, started again with one word.
  A module starts no process itself, and a lint rule over `src/modules/` fails
  the build on one that tries. It is for work that has to be ended from
  outside, such as a statement that may run for ever.
  - The word is from a closed list in `src/host/process-words.ts`, where each
    word is for one module. Today the list holds one word, `store-engine`, for
    the module `stores`, which adds the word's command to the command line
    itself. The module's manifest names the words it has started
    (`processes: [{ verb: "store-engine" }]`), and names nothing else: no
    argument, no path and no environment.
  - `folder` is the folder the process is given, level by level, as for
    `ctx.folder`. The host builds the path from the names as they are when
    `start` is called, and hands it to the process as the value of its one
    variable, `SQLITE_TMPDIR`. It makes nothing on the disk and changes no
    mode: the module made the folder before. A start is refused with
    `folder_missing` where a level of the path, from the module's own folder
    down, is not there, or is a file or a link.
  - The process does not run in that folder. It runs in the machine's root
    folder. The runtime reads variables and code from the folder a program
    starts in (a `.env`, a `bunfig.toml`), and a module's folder holds what
    was written for a client. So the word's own code names every file by its
    full path.
  - The process is started with no shell, and with nothing but the word on its
    command line. Nothing of the daemon's own environment is passed on. It has
    no input, and what it prints is read by nobody.
  - The two talk over the runtime's own channel between a parent and its
    child. The answer of `start` has `send(message)`, `kill()` and `exited`.
    The host passes each value through as it is, and does not look at it, log
    it, count it or record it: a value can hold rows.
    - `send` drops a value for a process that is gone. For a process that is
      still there, it throws `ProcessSendFailed` when the value could not be
      handed over: `value_unsendable` for a value the channel cannot carry,
      and `channel_closed` when the process has closed its side. What is
      thrown holds nothing of the value.
    - A listener that fails, at once or through a promise it answers, fails
      for itself. The daemon's log says that it did, and nothing of why.
    - `kill()` ends the process at once. `exited` settles with the exit code,
      or with the signal that ended it.
  - A process is started only for a module that is running. Once the module's
    stop has begun, a start is refused with `module_not_running`, also through
    a context the module kept. A module runs at most 32 at once, and the next
    start is refused with `processes_unavailable`. A program that could not be
    started is refused with `process_start_failed`.
  - When the module is switched off, and when the daemon stops, the host ends
    every process of the module and waits at most 5 seconds for them to be
    gone. It cannot end a process when the daemon itself is killed. The
    process's channel closes then, and the word's own code must end when it
    does. That code must also listen before its first `await`: a value that
    arrives before it listens is lost.
  - A refusal is recorded as `system.module.refused`, with the module and the
    rule. A start and an end are in the daemon's log, with the module, the
    word and how the process ended.
- `ctx.programs.run(id, { reach, secrets, input, onOutput, timeoutMs, signal })`
  has the host run a helper program for the module: another binary on this
  machine, given one job. The module names a host and secrets that a person
  added, and the host writes the address and the secrets into the job. It
  never rejects: the answer is `{ ok: true }`, or `{ ok: false, code }` with
  one word. [A helper program](#a-helper-program-what-the-daemon-runs-for-a-module)
  has the checks, the words and the record.

To fail an ask with a code the control plane may see, throw `AskFailure` with
one lower-case word. An act fails the same way, and the person sees the code.
A refusal by `ctx.secrets`, `ctx.fetch`, `ctx.folder`, `ctx.processes`, `ctx.reach`
or `ctx.secretNames`, and a secret that is missing or cannot be read, reaches the
control plane or the person as a code of its own, such as
`failed:secret_missing`. Anything else a module
throws reaches the control plane as `failed:internal`: an error of the disk in
`ctx.folder` is one. Its message is not sent and not recorded, and the log
holds only the kind of error and where it was thrown.

A new source file that calls `fetch` must also be added to the list in
`test/console-read-api.test.ts` that maps each such file to the row of the
console's data paths that discloses it. The test fails until it is.

Cutting a release — and the order the three repositories have to ship in —
is [RELEASING.md](RELEASING.md).
