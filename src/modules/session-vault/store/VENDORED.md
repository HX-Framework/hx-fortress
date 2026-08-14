# Vendored: @forge/session-store (subset)

These files are copied from `packages/session-store/src/` in the `let-forge` private monorepo.
Only the vault-side subset is included: `types.ts`, `gcs-store.ts`, `s3-store.ts`, `rpc.ts`.

Excluded (workbench-only or superseded by Fortress):

- `remote-vault-store.ts` — workbench side, not needed here
- `tunnel.ts` — old frame protocol, replaced by `src/protocol/` in this repo
- `fs-store.ts` — test/dev only

Future: once `@forge/session-store` (or the relevant subset) is published to npm, replace this
directory with a versioned package dependency and remove this note.
