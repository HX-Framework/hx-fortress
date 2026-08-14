import { describe, expect, test } from "bun:test";

import packageJson from "../package.json";

const read = (rel: string) => Bun.file(new URL(`../${rel}`, import.meta.url)).text();

const ci = await read(".github/workflows/ci.yml");
const dockerfile = await read("Dockerfile");
const dockerignore = await read(".dockerignore");
const dependabot = await read(".github/dependabot.yml");
const security = await read(".github/workflows/security.yml");
const uiPackageJson = JSON.parse(await read("ui/package.json")) as {
  packageManager?: string;
  devDependencies: Record<string, string>;
  pnpm?: unknown;
  trustedDependencies?: string[];
};

describe("console build pipeline", () => {
  test("the binary is built by build:ui -> gen:ui -> compile", () => {
    expect(packageJson.scripts["build:ui"]).toBe(
      "cd ui && bun install --frozen-lockfile && bun run build",
    );
    expect(packageJson.scripts["gen:ui"]).toBe("bun scripts/gen-ui-assets.ts");
    expect(packageJson.scripts.build).toBe(
      "bun run build:ui && bun run gen:ui && mkdir -p ./dist && " +
        "bun build ./src/cli.ts --compile --outfile ./dist/hx-fortress",
    );
  });

  test("the console workspace is on bun, with its TypeScript pinned", async () => {
    expect(uiPackageJson.packageManager).toBe("bun@1.3.14");
    expect(uiPackageJson.trustedDependencies).toEqual(["esbuild"]);
    expect(uiPackageJson.pnpm).toBeUndefined();
    // Exact, not a range: the ui typechecks in its own build step, and a
    // silent minor bump there fails the release rather than a PR.
    expect(uiPackageJson.devDependencies.typescript).toBe("5.9.3");
    expect(await Bun.file(new URL("../ui/bun.lock", import.meta.url)).exists()).toBe(true);
    expect(await Bun.file(new URL("../ui/pnpm-lock.yaml", import.meta.url)).exists()).toBe(false);
    expect(
      await Bun.file(new URL("../ui/pnpm-workspace.yaml", import.meta.url)).exists(),
    ).toBe(false);
  });

  test("no console asset reaches out to a font CDN", async () => {
    const indexHtml = await read("ui/index.html");
    expect(indexHtml).not.toContain("fonts.googleapis.com");
    expect(indexHtml).not.toContain("fonts.gstatic.com");
    expect(indexHtml).toContain('href="/fonts/fonts.css"');
    for (const name of ["fonts.css", "OFL.txt", "inter-400.woff2", "schibsted-grotesk-800.woff2"]) {
      expect(await Bun.file(new URL(`../ui/public/fonts/${name}`, import.meta.url)).exists()).toBe(
        true,
      );
    }
    const fontsCss = await read("ui/public/fonts/fonts.css");
    expect(fontsCss).not.toMatch(/https?:\/\//);
  });

  test("CI builds the console and compares an independent rebuild", () => {
    expect(ci).toContain("bun run build:ui");
    expect(ci).toContain("scripts/gen-ui-assets.ts --print-hash");
    expect(ci).toContain("rm -rf ui/dist");
    expect(ci).toContain('if [[ "$first" != "$second" ]]; then');
    expect(ci).toContain("exit 1");
    expect(ci).toContain("bun run gen:ui");
  });

  test("the image installs the console deps from its manifests and embeds fresh assets", () => {
    expect(dockerfile).toContain("COPY ui/package.json ui/bun.lock ui/");
    expect(dockerfile).toContain("RUN cd ui && bun install --frozen-lockfile");
    expect(dockerfile).toContain("RUN bun run build");
    // The ui install must precede the source copy, or every code edit
    // re-resolves the tree; and both must precede the build.
    expect(dockerfile.indexOf("COPY ui/package.json")).toBeLessThan(
      dockerfile.indexOf("COPY . ."),
    );
    expect(dockerfile.indexOf("RUN cd ui && bun install")).toBeLessThan(
      dockerfile.indexOf("RUN bun run build"),
    );
  });

  test("the build context excludes node_modules and dist at every level", () => {
    expect(dockerignore).toContain("**/node_modules");
    expect(dockerignore).toContain("**/dist");
  });

  test("the dependency gates cover the console lockfile", () => {
    expect(security).toContain("--lockfile=ui/bun.lock");
    expect(dependabot).toContain('directory: "/ui"');
  });

  test("the generated asset map is never committed and never linted", async () => {
    expect(await read(".gitignore")).toContain("src/ui-assets.gen.ts");
    const eslintConfig = await read("eslint.config.js");
    expect(eslintConfig).toContain('"src/ui-assets.gen.ts"');
    expect(eslintConfig).toContain('"ui/**"');
  });
});
