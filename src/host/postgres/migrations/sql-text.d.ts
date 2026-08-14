// `.sql` files are imported as raw text via `import … with { type: "text" }`
// (Bun's text loader; embedded into the `bun build --compile` binary). One
// ambient declaration types every such import — no per-file sidecar needed.
declare module "*.sql" {
  const content: string;
  export default content;
}
