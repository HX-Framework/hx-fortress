# HX Fortress UI

The administration console `hx-fortress ui` serves. Vite + React + TypeScript,
no backend: every number, name and log line is demo data in `src/data.ts`.

```sh
bun install && bun run dev   # http://localhost:5641
bun run build                # typecheck + bundle to dist/
```

Bun, like the fortress itself — one toolchain, one lockfile format, one
`--frozen-lockfile` gate in CI and in the image build. TypeScript is pinned to
an exact version here rather than tracking the root pin: this workspace
typechecks against the DOM and React JSX libs, so it moves on its own schedule.

`bun run build` writes `dist/`, and the repo root turns that into the binary:
`bun run gen:ui` maps every built file into `src/ui-assets.gen.ts`, and
`bun build --compile` embeds them. CI builds the ui twice and compares the
asset hash, so what ships is provably what these sources produce.

Fonts are vendored under `public/fonts` (OFL, see `OFL.txt`). Nothing here may
load a resource from another origin: the console runs on appliances with no
egress, and the CSP it is served under would block it anyway.

## URLs

Every stateful surface is addressable. No query strings, no hashes — the path
is the source of truth, parsed in `src/router.ts` and rendered from there, so
a cold load of any link below lands exactly where it says.

| Path | Shows |
| --- | --- |
| `/` | Overview |
| `/sessions` | Metadata explorer |
| `/sessions/by/{team\|person\|project\|repo\|newest}` | …grouped |
| `/sessions/search/routing+gates` | …searched (spaces are `+`) |
| `/sessions/{family}/{sessionId}` | One session — its storage key, e.g. `/sessions/claude-cli/59e3ccf5-8f8b` |
| `/sessions/{family}/{sessionId}/verify` | …its residency proof, re-run on load |
| `/people/{id}` | One person, e.g. `/people/erik` |
| `/adoption` | Roster vs reality |
| `/adoption/by/{team\|group\|coverage\|status}` | …grouped |
| `/adoption/{not-installed\|quiet\|gone-quiet\|partial\|outdated}` | …one cohort |
| `/adoption/search/{q}` | …searched |
| `/residency` | Residency proof |
| `/residency/gates` | …scrolled to the routing gates |
| `/residency/incident` | …the incident preview |
| `/residency/verify/{family}/{sessionId}` | …proving one session, without leaving the audit |
| `/compliance` | Posture, egress, retention, audit |
| `/compliance/{egress\|retention\|audit}` | …at that panel |
| `/postgres` · `/postgres/failed-boot` | Postgres, and the failed-boot preview |
| `/storage` · `/embeddings` | Blob storage · embeddings |
| `/storage/credentials` | …rotating the store key, inline in its row |
| `/storage/target` | …the change-target dialog |
| `/storage/runs/{runId}` | One migration run and its log, e.g. `/storage/runs/mig_7f3a` |
| `/ops` · `/ops/keys` | Ops tools, and the keys panel |
| `/logs` | Log viewer |
| `/logs/{source}/{warnings\|errors}/{1h\|7d\|boot}` | …filtered, e.g. `/logs/session_vault/errors/7d` |
| `…/shortcuts` | The keyboard map, over any page — `/shortcuts`, `/logs/errors/shortcuts` |

Segments compose (`/adoption/by/coverage/not-installed`) and defaults are
omitted, so the URL is always the shortest thing that says what you mean. The
log segments use disjoint vocabularies, so order doesn't matter and any subset
works — `/logs/boot`, `/logs/errors`, `/logs/postgres/boot` all parse.

Dialogs are locations too. They nest under the page they cover, so the backdrop
is never lost and a shared link opens the dialog over the right context.
Opening one pushes a marked history entry, so dismissing it — button, `Esc`, or
browser Back — rewinds instead of leaving debris; a dialog link opened cold
rewrites to the page underneath instead. Navigating to another section
dismisses whatever dialog is open, so overlays never pile up in later URLs.

Unknown paths rewrite themselves to `/`.

**Serving this:** it is a single-page app, so the host must return `index.html`
for any unmatched path (Vite's dev server and `vite preview` already do).
`hx-fortress ui` does the same from the embedded map: an unmatched path that
does not name a file gets the shell, an unmatched path that does gets a 404, and
`/ui/api/*` is reserved for the console's own API.

## Changing where transcripts rest

The blob-storage credential is edited in place on `/storage` — S3 takes both
halves of the key, GCS a whole service-account document — and needs only a
service restart, because the store is built once at module init. **Test
connection** on the Store panel writes a probe, reads it back and deletes it, so
you can confirm the credential can actually write to the bucket (a green
"store initialized" can't). The other keys rotate on the page that uses them:
the relay/vault key on `/ops`, the OpenAI key on `/embeddings`.

Changing the **provider, bucket or region** is different: the new target is
empty, so it opens as a dialog — form first, then the one question that matters
before anything moves.

- **Copy & switch** — a run copies every object to the new bucket, verifies the
  byte counts, and only then rewrites `credentials.json`. Nothing is deleted
  from the old bucket.
- **Start fresh** — the switch is immediate and the objects already stored stay
  behind. They stop resolving from this fortress, so residency verification
  fails for them; the page says so, before and after.

Runs are addressable and kept forever with their logs. A failed run switches
nothing, and **Retry** resumes — the inventory counts what already landed and
moves only the remainder, because a copy is idempotent.

## Layout

- `src/data.ts` — the demo world. Replace this module to wire real data.
- `src/router.ts` — path ⇆ state.
- `src/state.tsx` — route + service/version/audit-trail state.
- `src/render.ts` — row/list/table markup shared across views.
- `src/views/` — one file per section.
- `src/styles.css` — the design system, byte-identical to the approved prototype.
