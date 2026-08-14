import { describe, expect, test } from "bun:test";

const workflowPath = new URL("../.github/workflows/dev-build.yml", import.meta.url);
const workflow = await Bun.file(workflowPath).text();

describe("dev-build workflow", () => {
  test("is manual-dispatch only", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("push:");
  });

  test("cross-compiles the four binaries with baseline x64 + checksums + gzip", () => {
    for (const target of ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-arm64", "bun-linux-x64"]) {
      expect(workflow).toContain(target);
    }
    expect(workflow).toContain("./src/cli.ts");
    expect(workflow).toContain('*-x64) build_target="${target}-baseline" ;;');
    expect(workflow).toContain('gzip -9 -f "$out_path"');
    expect(workflow).toContain("dist/hx-fortress-version");
  });

  test("builds and embeds the console before the compile", () => {
    expect(workflow).toContain("bun run build:ui");
    expect(workflow).toContain("bun run gen:ui");
    expect(workflow.indexOf("bun run gen:ui")).toBeLessThan(
      workflow.indexOf("Compile darwin/linux binaries"),
    );
    // A dev build carries the ui step only — the rebuild comparison is a
    // release and PR gate, not a per-branch one.
    expect(workflow).not.toContain("--print-hash");
  });

  test("publishes an overwriting per-branch dev release", () => {
    expect(workflow).toContain('tag="dev/hx-fortress-${slug}"');
    expect(workflow).toContain("gh release delete");
    expect(workflow).toContain('gh release create "$tag" dist/hx-fortress-*');
    expect(workflow).toContain("--prerelease=true");
  });

  test("does not build docker images or dispatch let-forge", () => {
    expect(workflow).not.toContain("docker/build-push-action");
    expect(workflow).not.toContain("repository-dispatch");
    expect(workflow).not.toContain("ghcr.io/hx-framework/hx-fortress");
  });
});
