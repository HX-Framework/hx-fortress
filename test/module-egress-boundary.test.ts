import { describe, expect, test } from "bun:test";

function lint(filename: string, source: string) {
  const result = Bun.spawnSync(["bun", "x", "eslint", "--stdin", "--stdin-filename", filename], {
    cwd: import.meta.dir + "/..",
    stdin: Buffer.from(source),
    stderr: "pipe",
    stdout: "pipe",
  });
  return { code: result.exitCode, out: result.stdout.toString() };
}

// A module reaches the network through `ctx.fetch`, which the host holds to the
// hosts the module's manifest lists. The lint rule is what keeps a module from
// stepping around that by accident.
describe("a module's way out is the context", () => {
  test("a bare fetch, a socket and a Node network import are refused in a module", () => {
    const result = lint(
      "src/modules/example/calls.ts",
      [
        'import net from "node:net";',
        'import { request } from "node:https";',
        "void net; void request;",
        'export const a = (): Promise<Response> => fetch("https://api.example.com/");',
        'export const b = (): WebSocket => new WebSocket("wss://api.example.com/");',
        'export const c = (): Promise<Response> => globalThis.fetch("https://api.example.com/");',
        "",
      ].join("\n"),
    );
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("no-restricted-imports");
    expect(result.out).toContain("no-restricted-globals");
    expect(result.out).toContain("no-restricted-properties");
    expect(result.out).toContain("A module calls out through ctx.fetch");
    // Both imports, both globals and the one property: five findings.
    expect(result.out.match(/A module calls out through ctx\.fetch/g)).toHaveLength(5);
  });

  test("the context's own fetch is the way out", () => {
    const result = lint(
      "src/modules/example/calls.ts",
      [
        "interface Ctx { fetch(url: string): Promise<Response> }",
        'export const a = (ctx: Ctx): Promise<Response> => ctx.fetch("https://api.example.com/");',
        "",
      ].join("\n"),
    );
    expect(result).toEqual({ code: 0, out: "" });
  });

  test("the wire contract's import boundary still holds inside a module", () => {
    const result = lint(
      "src/modules/example/wire.ts",
      'import { example } from "@forge/hx-client";\nvoid example;\n',
    );
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("Import the wire contract through src/protocol only");
  });

  test("the rest of the codebase, and the two modules that predate manifests, are not held to it", () => {
    const source = 'export const a = (): Promise<Response> => fetch("https://api.example.com/");\n';
    expect(lint("src/host/example.ts", source).code).toBe(0);
    expect(lint("src/modules/session-vault/example.ts", source).code).toBe(0);
    expect(lint("src/modules/embed-worker/example.ts", source).code).toBe(0);
  });
});
