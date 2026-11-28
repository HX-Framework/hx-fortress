# Releasing HX Fortress

A release is cut from two repositories of this project, in one order:

1. **`hx-protocol`** — the wire types.
2. **`hx-fortress`** — this repository.

A control plane that an HX Fortress is connected to is a party to every release
that changes the protocol. It uses the same wire types, and it has to answer
what the new version of HX Fortress asks before that version is published.

The order is not a convention. Each step is a precondition of the one after it,
and the last of them publishes a binary that fortresses in the field can install
themselves.

## Why the order is forced

**The protocol merges first, because everything that uses it pins it by
commit.** `hx-fortress` depends on the protocol package at a git SHA, and so
does a control plane. A squash merge produces a **new** commit, so the SHA that
exists afterwards is not the branch tip anything is pinned to now. Until the
protocol PR is merged there is no SHA to pin to.

**Everything that uses the protocol re-pins together, and each re-pin carries
its own lockfile.** Two sides on different protocol commits are compiling
different wire types against each other. The lockfile has to move in the same
commit as `package.json`: a lockfile still resolving the old SHA is what
actually gets installed, so CI would go green against types nobody is shipping.

**A control plane answers before HX Fortress asks.** A new HX Fortress asks its
control plane questions the new protocol defines. Deploy the side that answers
before the side that asks: a control plane that has not deployed yet cannot
answer, and HX Fortress cannot tell that apart from one that will not.

**The fortress push is last, and it *is* the release.** `package.json` and
`bun.lock` are both in `release.yml`'s `on.push.paths`, so the version bump and
the protocol re-pin are pushes that build, publish and move the build tag. There
is no way to land them quietly first: pushing them **is** the release.

## What breaks if the order is violated

| Violation | What happens |
| --- | --- |
| The fortress re-pin is pushed before the protocol PR merges | The pin names a commit on a branch that is about to be squashed away. It resolves today and stops resolving the moment the branch is deleted, so the build is not reproducible and a later `bun install --frozen-lockfile` fails. |
| HX Fortress and a control plane are re-pinned in separate rounds | The two sides serialize different shapes for the same message. The failure surfaces as a field that silently reads `undefined`, not as a build error. |
| HX Fortress is published before a control plane deploys | Every HX Fortress that updates itself starts asking a control plane that does not understand the question. An unanswered question is reported as unavailable, never as a clean answer. What the control plane does with a message it does not know is its own: it can be lost work, not only a qualified verdict. |
| The immutable release is dispatched on a **branch** instead of the tag | `workflow_dispatch` runs the workflow file *at the dispatched ref*, and builds it there. The release is cut from whatever the branch points at now, which is not the commit the build tag records. |
| The version bump is pushed twice for one version | The rolling step force-moves `builds/hx-fortress-<version>` on every push. A build tag verified before a second push no longer names the commit that was verified. |

## What a release holds

A release is a set of files under one tag. `hx-fortress update` and the
install script find them by name, at
`https://github.com/HX-Framework/hx-fortress/releases/latest/download/`, or at
the address an organization names.

| File | What it is |
| --- | --- |
| `hx-fortress-version` | The version, as text. |
| `hx-fortress-<os>-<arch>.gz`, `.sha256`, and `.sig` when the release is signed | The program for one platform. The checksum and the signature are over the program before it is gzipped. |
| `hx-fortress-install.sh`, `.sha256` | The install script, as it stands at the release's commit. |
| `hx-fortress-data-runner-<os>-<arch>.gz`, `.sha256`, and `.sig` when signed | The data runner for one platform: the program HX Fortress starts beside itself to do one job on a database. The image holds it. An install on a host does not fetch it yet. |
| `pgvector-pg<major>-<platform>.tar.gz`, `.sha256`, and `.sig` when signed | The pgvector files for the Postgres on HX Fortress's own disk. The `pgvector` job attaches them. |
| `hx-fortress-parts.cdx.json` | The open-source parts of the release, as a CycloneDX list: each package of the program, of the console's pages and of the data runner, with its version and its license; the runtime inside the program; the console's fonts; and what a database on HX Fortress's own disk fetches. `scripts/list-parts.ts` says which file each is read from. |
| `hx-fortress-image-parts.cdx.json` | The open-source parts of the container image, as a CycloneDX list that a scanner makes from the image a build pushes. |
| `hx-fortress-release.json`, and `.sig` when the release is signed | The release file: what this release is, in one JSON file. [The release file](#the-release-file) says what it holds. |

Two kinds of release carry them:

- **A rolling build**, `builds/hx-fortress-<version>`, is recreated by every
  push to `main` that touches the build's inputs. The workflow never marks it
  as latest.
- **An immutable release**, `releases/hx-fortress-<version>`, is cut once, by
  hand, from a build tag. The workflow's last job, `mark-latest`, marks it as
  **latest** once every pgvector job has attached its files, and never over a
  newer release. So it is the one that installs and updates follow, and it is
  whole when they start to.

**While no release is marked, GitHub answers "latest" with a rolling build.**
GitHub picks the newest release that is not a prerelease when none is marked,
and a rolling build is not a prerelease. That is the state before the first
immutable release, and again after the marked release is deleted. Installs and
updates then follow the newest build of `main`. Cut the first immutable release
as soon as `main` holds this workflow, and after deleting a marked release,
mark the one before it: `gh release edit releases/hx-fortress-<version> --latest`.

The programs, the data runner, the install script, the two lists of open-source
parts and the release file also have a build provenance record, made by the
build and kept by GitHub. `gh attestation verify <file> --repo
HX-Framework/hx-fortress` checks a file against it. The record names each
program as the `.gz` file and as the program unpacked from it, so a program
that is in place on a host can be checked as it is. The container image has a
record too, for its digest.

The pgvector files belong to one version: they are built for the Postgres that
version runs and signed with the keys it carries. An HX Fortress asks the
release of its own version for them, then the build of its own version, and the
latest release last. So a release that moves to another Postgres or to another
signing key does not strand the versions before it.

### The release file

`hx-fortress-release.json` says what a release is, for a person who reviews it
and for a program that does. `scripts/release-file.ts` writes it last, from
what the run can see, and it never claims what it cannot see.

| Field | What it holds |
| --- | --- |
| `version`, `commit`, `repository` | The release's version, and the commit of this repository that was built. |
| `builtBy` | The workflow, the address of the run, the ref the run started on, and the time. |
| `signature` | `signed` is true only when every program has a signature beside it, and `keyId` is the key those signatures name. An unsigned release says `"signed": false`. |
| `buildRecord` | How to check a file against its build provenance record. |
| `files` | Every file the release job built, with its sha256. A gzipped program also has `holds`: the name and the sha256 of the program inside. The script unpacks each program, and writes no file when a program is not the one its `.sha256` names. |
| `image` | The container image by its name and its digest, its tags, and `bases`: the images the Dockerfile builds on, each with its digest. |
| `parts` | The names of the two lists of open-source parts. |
| `changes` | `since` is the tag of the immutable release before this one. `commits` are the changes since then, the newest first, at most 500 of them. `more` counts the older ones that are not listed. |
| `pages` | The page files of a Secure Data Island, each with its path in the repository and its sha256. A page is served as it is written, so a served file is one of these. The files are the ones that each `islands/<version>/SHA256SUMS` names, and a file that is not what its list says stops the release file. |
| `whatCrosses` | The name of the file that lists everything the connection may carry, once a release holds one. `null` until then. |

Three things to know when reading one:

- **The pgvector files are not in `files`.** A later job attaches them, after
  the release file is written. Each has its own `.sha256`, and a `.sig` when
  the release is signed.
- **The image is the one a push built.** A rolling build names the image that
  its own run pushed. An immutable release is cut from a build and pushes no
  image, so it names the image that the build of the same commit pushed. It
  reads that from the build's release file, after checking that file against
  its build record. When it cannot, `image` is `null`, and the run says so in
  a warning.
- **The file's own signature** is `hx-fortress-release.json.sig`, made when the
  release is signed: one signature over every checksum the file holds.

Check the file, and the image it names:

```sh
gh attestation verify hx-fortress-release.json --repo HX-Framework/hx-fortress
gh attestation verify oci://ghcr.io/hx-framework/hx-fortress@<digest> --repo HX-Framework/hx-fortress
```

**The base images are pinned.** The Dockerfile names each image it builds on
by its tag and by the digest of its image index, so a tag that is moved later
cannot change what a rebuild starts from. A test fails when one loses its
digest. To move to a newer image, change the tag and the digest together.

## The rungs

`<version>` below is the version in `package.json` for this release.

| # | Rung | How it is verified |
| --- | --- | --- |
| 0 | Precheck the signing posture: the release signing secret is unset, and the latest release carries no `.sig` sidecar. | `gh release view` the latest build tag and list its assets — no `*.sig` present. |
| 1 | Merge the `hx-protocol` PR. **Squash.** | `git rev-parse origin/main` in `hx-protocol` — the SHA is new, and is not the branch tip anything is pinned to. |
| 2 | In `hx-fortress`, re-pin the protocol package to that SHA and regenerate the lockfile **in the same commit**. Tell each control plane to do the same in its own repository. | The SHA appears in `package.json` *and* in the lockfile's dependency line *and* in its resolved entry. `bun install --frozen-lockfile` succeeds unchanged. |
| 3 | Each control plane that an HX Fortress is connected to deploys a build that speaks the new protocol. | That control plane's own report of the version it runs. Never the exit code of a deploy job — see the standing rules. |
| 4 | Push `hx-fortress` `main`: the version bump and the protocol re-pin. **This is the release build.** | The release workflow ran for that SHA, and `git rev-parse builds/hx-fortress-<version>` equals it. Record that commit — later rungs compare against it. |
| 5 | Publish the immutable release: `workflow_dispatch` on the **tag** `builds/hx-fortress-<version>`, never a branch. | **Pre-dispatch:** `git rev-parse builds/hx-fortress-<version>` still equals the commit recorded at rung 4. **Post:** `releases/hx-fortress-<version>` exists, its `target_commitish` is that same commit, it holds the pgvector files for all four platforms, its `hx-fortress-release.json` names that commit and an image, the job `mark-latest` passed, and `gh api repos/HX-Framework/hx-fortress/releases/latest --jq .tag_name` prints it. If a pgvector job failed, the release is there and is not latest: run the failed job again, and `mark-latest` after it. |
| 6 | Freeze: no further push to `main` touching `src/`, `ui/`, `data-runner/`, `islands/`, `scripts/`, `Dockerfile`, `package.json`, `bun.lock` **or `.github/workflows/release.yml`** until rung 5 has been verified. | Those are `release.yml`'s own `on.push.paths`. Any push touching one re-runs the rolling step and force-moves the build tag — including rung 8's edit to the workflow file itself, which is why that is a release of its own. |
| 7 | Bake the production release keys into `src/host/trust/signing-keys.ts`, keeping the current and next public halves. This release still publishes **unsigned**. | `hasProductionAnchor()` is true for the shipped build; the release assets still carry no `.sig`. |
| 8 | The next release signs: publish with the signing secret set, delete every `\|\| 'hxf-dev-2026-07'` keyid fallback in `release.yml` (there are four), and drop the development key. | Assets carry `.sig` sidecars; `grep -c "hxf-dev-2026-07" .github/workflows/release.yml` is `0`; the shipped key set holds production keys only. |
| 9 | A later release requires the signature: `SIGNATURE_ENFORCE` and `CONSOLE_SIGNATURE_ENFORCE` in `src/host/trust/verify.ts` become `true`. Only once every release an update can reach is signed. | An HX Fortress on that build refuses a release with no `.sig`, and says so by name. |

Rungs 8 and 9 are each a **release of its own** — its own version bump, its own
push, its own immutable dispatch. Neither is an amendment to the one before it.

## Keys, and whose they are

**The release keys are this project's.** They sign the files of a release, and
their public halves are compiled into the program
(`src/host/trust/signing-keys.ts`). The private halves live in the release
workflow's secrets and nowhere in this repository. Until rung 7 the program
carries a development key only, and every path that needs a production key
refuses by name.

**No key of a control plane is part of a release.** None is compiled into the
program. An HX Fortress learns the key of its control plane on its own host: the
organization names it, a person pins it, or HX Fortress pins what the control
plane publishes when it first connects. So a control plane changes its key with
no release of this project.
[SECURITY.md](SECURITY.md#the-keys-of-a-control-plane) says what an HX Fortress
does with that key.

## Remediation

**The immutable release was cut from the wrong commit.** Delete the release
**and** the tag, then dispatch again on the correct build tag. Deleting the
release alone leaves the tag pointing where it was, and the next dispatch
recreates the same wrong artifact. Deleting the release that was marked as
latest leaves GitHub to pick another one by date, which can be a rolling build.
Until the new dispatch has passed, mark the release before it
(`gh release edit releases/hx-fortress-<earlier version> --latest`), and check
`releases/latest` again after the new dispatch.

**Rollback has two arms, and they are not interchangeable.**

*Host installs:*

```sh
hx-fortress ui sso off          # stop advertising the console URL
                                # wait for the next reconnect
                                # VERIFY that the control plane's button is gone
hx-fortress ui --uninstall-service
                                # then downgrade the binary
```

*Containers:*

```sh
# in a shell inside the container
hx-fortress ui sso off
# REDEPLOY — that is the reconnect gesture here
#   verify that the control plane's button is gone
#   then revert the image tag
```

On a container `hx-fortress ui disable` refuses while `FORTRESS_UI_ENABLE` is
set, and `systemctl` / `launchctl` mean nothing there. Unsetting the variable and
redeploying is the equivalent act.

**After going back to an older binary, run one residency audit.** The database
keeps the migrations the newer binary applied, and a migration may have renamed
a verdict in the findings that are already stored. The older binary does not
know the new name: its Residency page leaves those findings out, and it refuses
to acknowledge them, until a run of its own has recorded them again. A
migration says so under "GOING BACK TO AN OLDER BINARY" in its header when it
has this effect. No migration removes a column or a table that the binary one
release older still writes.

**Going back to a binary that carried a control plane's key.** Such a binary
checks a change of the organization's key against the key compiled into it, and
ignores what this host pinned or named. Nothing has to be undone: the pin file
and the setting are left as they are, and the newer binary reads them again
when it returns.

**Before upgrading a container, check where its enrollment lives.** `credentials.json`
sits under `$HOME/.let/session-vault/`, and `VOLUME` is `["/data"]`. An image built
before `ENV HOME=/data` therefore wrote it to `/root/.let` (or `/.let`) — in the
container's writable layer, which is discarded when the image is replaced. The daemon
does look in those older homes at boot, but by then they are gone. So on any container
that was enrolled interactively (`docker exec … hx-fortress enroll`, i.e. without
`FORTRESS_STORAGE_BUCKET` in the environment), copy the state onto the volume FIRST:

```sh
docker exec <container> sh -c 'test -d /root/.let && cp -a /root/.let /data/.let || true'
docker exec <container> sh -c 'test -d /.let    && cp -a /.let    /data/.let || true'
```

Both the bucket credentials and `openaiApiKey` live in that file. Without this the
upgraded container starts unenrolled and `session-vault init` refuses with "no
credentials.json — run the enroll wizard first". A container driven entirely from the
environment (`FORTRESS_STORAGE_BUCKET` set) rebuilds the file on boot and needs none of
this.

**Before upgrading a container, check how it is started.** The image's
`ENTRYPOINT` is now `hx-fortress container-run`, and it REFUSES unless it is
pid 1 — it is what receives the runtime's SIGTERM and what orphans are
re-parented to, and started under an init wrapper it can do neither. So a
deployment that runs the image with `docker run --init`, with a shell wrapper,
or with its own `entrypoint:` override will come up refusing on the first boot
after the upgrade. Drop the wrapper, or run `hx-fortress host` directly as the
entrypoint and supervise the console yourself.

## A container on a platform that routes one port

Railway and platforms like it run the image as it is and route one port to it.
Five things are otherwise rediscovered the hard way.

**The console takes two variables and no shell.**

```sh
FORTRESS_UI_ENABLE=1
FORTRESS_UI_PUBLIC_URL=https://<the address the platform gives the service>
```

Such a platform is docker-class (`RAILWAY_*` is one of the detection signals),
so the first bind rule applies: the console binds dual-stack with no further
gesture, because the platform publishes through host indirection and terminates
TLS in front of it. `container-run` re-reads the enablement before every
respawn, so the variable IS the switch — `ui disable` refuses while it is set.

**Route the platform's one port at the CONSOLE, not the gateway.** The image
exposes 8787 (ingest gateway) and 8788 (console), and the platform routes one
port per service. An HX Fortress whose sessions all arrive over its connection
to the control plane needs no inbound gateway at all. Set `FORTRESS_UI_PORT` and
point the service's target port at it. Nothing reads the platform's own `$PORT`.

**Console accounts are created by shell, once per person — never per release.**

```sh
hx-fortress ui user create <login> --role operator   # prints a one-time setup link
```

Run it in a shell inside the container. There is no other way to make an
account. `sso/exchange` mints an ENTRY token that annotates a sign-in, never an
account, which is why the console says on every screen that logins are created
on this host by whoever has a shell on it. Hand over the printed link and the
person sets their own password; `ui user reset <login>` re-issues it.

Accounts persist across releases — `users.json` lives at `/data/ui/users.json`
and is PG-independent by design, so it survives an image replacement and a lost
database alike. Sign-in SESSIONS do not: that table is in memory, so a redeploy
asks everyone for their password again. Lockouts DO persist and are restored at
boot, so redeploying is not a way to clear one.

**All of that rests on `/data` being a real volume.** Without one it is the
container's writable layer, and a redeploy discards the accounts, the enrollment
credential, `pg.json` and the embedded cluster together — the symptom being
operators and enrollment that have to be recreated on every deploy. Mount it
writable by the image's uid 10001, or use a named volume, which inherits the
image's ownership.

**A frozen daemon ends the container, so the restart policy is what restarts
it.** When the daemon's heartbeat stops, `container-run` kills the daemon and
exits with code `70` (the `FORTRESS_WATCHDOG_*` settings in the README). The
platform starts the service again only if its restart policy restarts a failed
process, and an on-failure policy gives up after its retry limit. An HX Fortress
that freezes again soon after every boot therefore ends as a crashed service,
which the platform's dashboard shows, instead of a running one that does
nothing.

## The untrusted window

An older binary re-grants the daemon's write role full DML on its first boot,
through the blanket schema grant it issues before it knows better. So for as long
as a downgraded binary was running, five tables were writable by a role that
should not have reached them: `hx.admin_audit`, `hx.console_commands`,
`hx.audit_acks`, `hx.audit_settings` and `hx.ingest_control`.

The fifth is the one that is easy to miss. A blanket re-grant restores `DELETE`
on `hx.ingest_control`, and delete-then-reinsert mints a fresh pause anchor —
which is exactly the unbounded pause the clamp exists to bound.

A command row planted in that window is rejected by the boot fence of the binary
that comes back — it is never executed *by the upgraded binary*. What the fence
cannot undo is the downgraded one: it has no fence and its own poll loop, so a
row planted while it is running is claimed and executed there and then, as the
daemon, with whatever the executor for that kind does. Treat the window as one in
which the command plane is open, not merely one in which its records are
untrustworthy. The rows written in the window are still there.

Roster retention is the other thing a downgrade quietly changes. The older
binary's `writeConfig` has no `preserve` argument and its boot rewrites the file,
so the `roster` block is dropped and retention reverts to the 90-day default —
and that default is a real `DELETE FROM hx.roster`, not a display setting. Re-set
it before the downgraded binary has been up for longer than the shortest
retention you had configured.

After re-upgrading, reconcile the acknowledgements:

```sh
hx-fortress audit acks reconcile
hx-fortress audit acks reconcile --re-confirm
```

It compares against the **on-disk spool only**. `hx.admin_audit` is itself
writable inside the window, so it cannot be its own witness. Acknowledgements the
spool no longer covers are re-confirmed through the fenced routine, which puts
them back in a trail that a database role cannot forge.

## Standing rules

- **Never trust a job's exit code as proof that something shipped.** A job can
  go red on a log stream that failed while the build rolls out normally minutes
  later, and green while a step was skipped. Confirm with the thing itself: the
  release's tag and its files, and the version a running HX Fortress reports.
- **Dispatch tags, not branches.** `workflow_dispatch` runs and builds the
  workflow file at the ref it was dispatched on.
- **One version, one push.** The rolling step recreates the release and
  force-moves `builds/hx-fortress-<version>` every time it runs.
- **The image scan reads the data runner too.** The data runner is a Go program
  inside the image, and the release's image scan reads the version of Go and
  the modules it was built with. Unlike a package of the base image, they are
  not brought up to date when the image is built: they are the versions
  `data-runner/go.mod` names. An advisory against one of them is cleared by a
  new export of `data-runner/` from the program's home, with newer pins, and
  never by an edit of that folder here.
  - Every pull request runs the release's two scans on the image it builds
    (the CI job "Image"), and the dependency audit reads the same versions on
    every pull request and once a week. So an advisory is usually seen before
    a release.
  - An advisory that is published after a pull request's last run is first
    seen by the release. The run then fails at the image scan. That step comes
    after the build release was recreated and the image was pushed, and the
    job that attaches the pgvector files does not start. Until a run passes,
    `builds/hx-fortress-<version>` has no pgvector files.
