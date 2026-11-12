# Where these files came from

`types.ts`, `gcs-store.ts`, `s3-store.ts` and `rpc.ts` began as a copy of a
session store that a control plane also uses. Only the Fortress's side is here.

Left out:

- the control plane's side of the vault RPC, which is not needed here
- an older frame protocol, replaced by `src/protocol/` in this repository
- a store on the local file system, used only in tests and development

These files are now maintained here. A change to the shapes in `rpc.ts` is a
change to the contract with a control plane, so both sides have to ship it.
