import { describe, expect, test } from "bun:test";

const workflowPath = new URL("../.github/workflows/release.yml", import.meta.url);
const workflow = await Bun.file(workflowPath).text();

describe("release workflow", () => {
  test("builds the four supported hx-fortress binaries with checksums and gzip assets", () => {
    for (const target of [
      "bun-darwin-arm64",
      "bun-darwin-x64",
      "bun-linux-arm64",
      "bun-linux-x64",
    ]) {
      expect(workflow).toContain(target);
    }

    expect(workflow).toContain("hx-fortress-${target#bun-}");
    expect(workflow).toContain("./src/cli.ts");
    // x64 builds must use the -baseline runtime so they run on CPUs without
    // AVX2 (MC-2366); the build target is derived from $target at runtime.
    expect(workflow).toContain('*-x64) build_target="${target}-baseline" ;;');
    expect(workflow).toContain('--target="$build_target"');
    expect(workflow).toContain('> "${out_path}.sha256"');
    expect(workflow).toContain('gzip -9 -f "$out_path"');
    expect(workflow).toContain("dist/hx-fortress-version");
  });

  test("builds the console before the compile and refuses an irreproducible rebuild", () => {
    expect(workflow).toContain("bun run build:ui");
    expect(workflow).toContain("scripts/gen-ui-assets.ts --print-hash");
    expect(workflow).toContain('if [[ "$first" != "$second" ]]; then');
    expect(workflow).toContain("bun run gen:ui");
    // Order is load-bearing: the compile embeds whatever gen:ui wrote.
    expect(workflow.indexOf("bun run gen:ui")).toBeLessThan(
      workflow.indexOf("Compile darwin/linux binaries"),
    );
  });

  test("a console-only change triggers the release", () => {
    expect(workflow).toContain('- "ui/**"');
    expect(workflow).toContain('- "scripts/**"');
  });

  test("publishes rolling releases and immutable releases on manual dispatch", () => {
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain('gh release create "$tag" dist/hx-fortress-*');
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
  });

  test("the rolling release publishes only on a push to main", () => {
    // A workflow_dispatch is how the IMMUTABLE release is cut, from a build tag
    // that already exists. Ungated, the rolling step would run there too and
    // delete that tag's release, then force-move the very tag the pre-dispatch
    // check verified — underneath the ceremony reading it.
    const step = workflow.indexOf("- name: Publish rolling release");
    expect(step).toBeGreaterThan(-1);
    const gate = workflow.indexOf(
      "if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
      step,
    );
    expect(gate).toBeGreaterThan(step);
    // The gate is this step's own, not one belonging to a later step.
    expect(gate).toBeLessThan(workflow.indexOf('gh release create "$tag"', step));
  });

  test("signs artifacts and attests build provenance (supply-chain)", () => {
    // Ed25519 detached signatures over the binaries + pgvector tarball…
    expect(workflow).toContain("scripts/sign-artifact.ts");
    // WHAT is signed, and WHEN. The signature sidecar the updater fetches is
    // `<name>.sig` for the UNCOMPRESSED artifact, so signing after the gzip — a
    // natural "sign what you upload" edit — publishes `<name>.gz.sig`. Every
    // fortress then 404s on the path it asks for, and because enforcement is off
    // by default the missing-signature branch warns and installs anyway: an
    // authenticity gate disabled fleet-wide with this suite green.
    const signAt = workflow.indexOf("scripts/sign-artifact.ts");
    const gzipAt = workflow.indexOf("gzip -9 -f");
    expect(gzipAt).toBeGreaterThan(-1);
    expect(signAt).toBeLessThan(gzipAt);
    expect(workflow).toMatch(/sign-artifact\.ts[^\n]*"\$out_path"/);
    expect(workflow).toContain("FORTRESS_SIGNING_KEY");
    // …plus GitHub build-provenance attestation…
    expect(workflow).toContain("attest-build-provenance");
    expect(workflow).toContain("id-token: write");
    // …while keeping the same-origin .sha256 integrity sidecars.
    expect(workflow).toContain('> "${out_path}.sha256"');
  });

  test("publishes GHCR tags and dispatches let-forge after a successful image push", () => {
    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("docker/setup-buildx-action");
    expect(workflow).toContain("docker/metadata-action");
    expect(workflow).toContain("docker/build-push-action");
    expect(workflow).toContain("ghcr.io/hx-framework/hx-fortress");
    expect(workflow).toContain("type=raw,value=latest");
    expect(workflow).toContain("type=raw,value=${{ steps.version.outputs.value }}");
    expect(workflow).toContain("type=raw,value=sha-");
    expect(workflow).toContain("LET_FORGE_REPO_DISPATCH_TOKEN");
    expect(workflow).toContain("event-type: hx-fortress-image-published");
  });
});
