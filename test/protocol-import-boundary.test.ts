import { describe, expect, test } from "bun:test";

import manifest from "../package.json";

// The package the wire contract comes from, as package.json names it.
const PROTOCOL_PACKAGE = Object.keys(manifest.dependencies).find((name) => name.endsWith("/hx-protocol"));

function lint(source: string, filename = "src/example.ts") {
  return Bun.spawnSync(
    ["bun", "x", "eslint", "--stdin", "--stdin-filename", filename],
    {
      cwd: import.meta.dir + "/..",
      stdin: Buffer.from(source),
      stderr: "pipe",
      stdout: "pipe",
    },
  );
}

describe("protocol import boundary", () => {
  test("package.json names the protocol package", () => {
    expect(PROTOCOL_PACKAGE).toBeDefined();
  });

  test.each(["", "/frames"])("rejects a direct import of the protocol package%s", (subpath) => {
    const result = lint(`import { example } from "${PROTOCOL_PACKAGE}${subpath}";\nvoid example;\n`);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("no-restricted-imports");
  });

  test("rejects a re-export of the protocol package outside src/protocol", () => {
    const result = lint(`export * from "${PROTOCOL_PACKAGE}";\n`);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("no-restricted-imports");
  });

  test("src/protocol/index.ts is the one file that names the package", () => {
    const result = lint(`export * from "${PROTOCOL_PACKAGE}";\n`, "src/protocol/index.ts");

    expect(result.exitCode).toBe(0);
  });

  test("allows imports through the local protocol boundary", () => {
    const result = lint(
      'import { encodeFrame } from "./protocol";\nvoid encodeFrame;\n',
    );

    expect(result.exitCode).toBe(0);
  });
});
