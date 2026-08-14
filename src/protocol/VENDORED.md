# Protocol boundary

The HX Fortress wire contract now lives in the public package
[`@let-ai/hx-protocol`](https://github.com/hx-framework/hx-protocol). This
directory is a thin re-export shim (`index.ts` → `export * from
"@let-ai/hx-protocol"`) so the rest of the repository keeps importing the
protocol from `../protocol`.

Only transport-neutral wire types and JSON encoding live in the package.
WebSocket dialing, enrollment persistence, authentication, heartbeat
scheduling, and reconnect backoff belong to the Fortress cloud-connection
layer. Vault RPC requests, results, and handlers belong to the `session_vault`
module.

To change the wire contract, open a PR against `hx-framework/hx-protocol`, then
re-pin the `@let-ai/hx-protocol` dependency in `package.json` to the new commit
SHA.
