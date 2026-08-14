import { describe, expect, test } from "bun:test";

function lint(source: string) {
  return Bun.spawnSync(
    ["bun", "x", "eslint", "--stdin", "--stdin-filename", "src/example.ts"],
    {
      cwd: import.meta.dir + "/..",
      stdin: Buffer.from(source),
      stderr: "pipe",
      stdout: "pipe",
    },
  );
}

describe("protocol import boundary", () => {
  test.each([
    "@forge/session-store",
    "@forge/session-store/tunnel",
    "@forge/hx-client",
    "@forge/hx-client/connect",
  ])("rejects direct imports from %s", (source) => {
    const result = lint(`import { example } from "${source}";\nvoid example;\n`);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("no-restricted-imports");
  });

  test("allows imports through the local protocol boundary", () => {
    const result = lint(
      'import { encodeFrame } from "./protocol";\nvoid encodeFrame;\n',
    );

    expect(result.exitCode).toBe(0);
  });
});
