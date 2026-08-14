import { describe, expect, test } from "bun:test";

import packageJson from "../package.json";
import * as host from "../src/host";

describe("project skeleton", () => {
  test("uses the hx-fortress package identity", () => {
    expect(packageJson.name).toBe("hx-fortress");
    expect(packageJson.private).toBe(true);
    expect(packageJson.type).toBe("module");
    expect(packageJson.bin).toEqual({
      "hx-fortress": "./src/cli.ts",
    });
    expect(packageJson.packageManager).toBe("bun@1.3.14");
    // NB: exact dependency versions are pinned in package.json (the source of
    // truth) and enforced by `bun install --frozen-lockfile`; re-asserting them
    // here only duplicated that pin and broke every Dependabot bump, so it is
    // intentionally omitted. The security-aware linter is still guaranteed by
    // eslint.config.js + the blocking lint step, not by a version assertion.
  });

  test("defines local dev and build scripts", () => {
    expect(packageJson.scripts).toMatchObject({
      dev: "bun --watch src/cli.ts",
      // The console is built and embedded before the compile, so a binary can
      // never ship without the assets it serves.
      build:
        "bun run build:ui && bun run gen:ui && mkdir -p ./dist && " +
        "bun build ./src/cli.ts --compile --outfile ./dist/hx-fortress",
    });
  });

  test("exposes the host lifecycle through one public boundary", () => {
    expect(host).toMatchObject({
      FileConfigStore: expect.any(Function),
      FileStatusStore: expect.any(Function),
      HostRuntime: expect.any(Function),
      fortressPaths: expect.any(Function),
      runFortressHost: expect.any(Function),
      runHost: expect.any(Function),
    });
  });
});
