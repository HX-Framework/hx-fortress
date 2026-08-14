import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli";
import { runUiCommand, stopConsole, type UiCommandDeps } from "../src/cli-ui";
import type { UiAssets } from "../src/ui/assets";

const ASSETS: UiAssets = {
  mode: "embedded",
  files: { "/index.html": "/$bunfs/index.html" },
  inlineScriptHashes: [],
  manifest: { hash: "a".repeat(64), files: 16, bytes: 1_500_000 },
};

// The serving verb takes a root-scoped instance lock before it binds, so every
// run needs a root of its own.
let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hx-ui-verb-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Run {
  code: number;
  lines: string[];
  out: string;
  served: { hostname: string; fallback?: string } | null;
}

async function runUi(
  args: readonly string[],
  env: Record<string, string | undefined> = {},
  overrides: Partial<UiCommandDeps> = {},
): Promise<Run> {
  const lines: string[] = [];
  let served: Run["served"] = null;
  const code = await runUiCommand(args, {
    writeLine: (line) => lines.push(line),
    env,
    fortressRoot: await mkdtemp(path.join(root, "run-")),
    platform: "linux",
    hostName: "fortress-1",
    loadAssets: async () => ASSETS,
    serve: (_ctx, hostname, fallback) => {
      served = { hostname, fallback };
      return { port: 8788 };
    },
    ...overrides,
  });
  return { code, lines, out: lines.join("\n"), served };
}

describe("hx-fortress ui", () => {
  test("is dispatched by the CLI and listed in help", async () => {
    let received: readonly string[] | undefined;
    const code = await runCli(["ui", "--port", "9999"], {
      runUi: async (args) => {
        received = args;
        return 0;
      },
      writeLine: () => {},
    });
    expect(code).toBe(0);
    expect(received).toEqual(["--port", "9999"]);

    const help: string[] = [];
    await runCli(["help"], { writeLine: (line) => help.push(line) });
    expect(help.join("\n")).toContain("hx-fortress ui ");
  });

  test("binds loopback by default and prints the URL plus the SSH forward", async () => {
    const run = await runUi([]);
    expect(run.code).toBe(0);
    expect(run.served).toEqual({ hostname: "127.0.0.1", fallback: undefined });
    expect(run.out).toContain("listening on 127.0.0.1:8788");
    expect(run.out).toContain("open http://127.0.0.1:8788");
    expect(run.out).toContain("ssh -L 8788:127.0.0.1:8788 fortress-1");
  });

  test("logs the asset manifest so a running console can be matched to a release", async () => {
    const run = await runUi([]);
    expect(run.out).toContain(`sha256 ${"a".repeat(64)}`);
    expect(run.out).toContain("embedded, 16 files");
  });

  test("prints no credential and no fortress identity", async () => {
    const run = await runUi([], { FORTRESS_UI_PUBLIC_URL: "https://console.example.com" });
    expect(run.out).not.toMatch(/token|password|secret|key/i);
    expect(run.out).toContain("open https://console.example.com");
  });

  test("--url overrides the printed base without moving the bind", async () => {
    const run = await runUi(["--url", "https://tunnel.example.com"]);
    expect(run.out).toContain("open https://tunnel.example.com");
    expect(run.served).toMatchObject({ hostname: "127.0.0.1" });
  });

  test("--port and FORTRESS_UI_PORT move the listener", async () => {
    const run = await runUi(["--port", "9100"], {}, {
      serve: () => ({ port: 9100 }),
    });
    expect(run.out).toContain("listening on 127.0.0.1:9100");
    const fromEnv = await runUi([], { FORTRESS_UI_PORT: "9200" }, { serve: () => ({ port: 9200 }) });
    expect(fromEnv.out).toContain("listening on 127.0.0.1:9200");
  });

  test("a docker-class container with FORTRESS_UI_ENABLE binds dual-stack with an IPv4 retry", async () => {
    const run = await runUi([], { KUBERNETES_SERVICE_HOST: "10.0.0.1", FORTRESS_UI_ENABLE: "1" });
    expect(run.code).toBe(0);
    expect(run.served).toEqual({ hostname: "::", fallback: "0.0.0.0" });
    expect(run.out).toContain("listening on [::]:8788");
    expect(run.out).toContain("open http://127.0.0.1:8788");
    expect(run.out).not.toContain("ssh -L");
    expect(run.out).toMatch(/residual:/);
    expect(run.out).toContain("-p 127.0.0.1:8788:8788");
  });

  test("a refused bind exits non-zero, names the reason and never starts a listener", async () => {
    const run = await runUi(["--bind", "0.0.0.0"]);
    expect(run.code).toBe(1);
    expect(run.served).toBeNull();
    expect(run.out).toContain("error: refusing to bind 0.0.0.0:8788");
    expect(run.out).toMatch(/residual:/);
  });

  test("--allow-insecure-bind is the gesture that accepts it", async () => {
    const run = await runUi(["--bind", "0.0.0.0", "--allow-insecure-bind"]);
    expect(run.code).toBe(0);
    expect(run.served).toMatchObject({ hostname: "0.0.0.0" });
    expect(run.out).toMatch(/residual:/);
  });

  test("--no-container forces host behavior on a detected box", async () => {
    const run = await runUi(["--no-container"], {
      KUBERNETES_SERVICE_HOST: "10.0.0.1",
      FORTRESS_UI_ENABLE: "1",
    });
    expect(run.served).toMatchObject({ hostname: "127.0.0.1" });
  });

  test("a build with no console assets refuses with the build gesture", async () => {
    const run = await runUi([], {}, { loadAssets: async () => null });
    expect(run.code).toBe(1);
    expect(run.served).toBeNull();
    expect(run.out).toContain("bun run build:ui");
  });

  test("unknown options and bad ports are named, not ignored", async () => {
    await expect(runUi(["--wat"])).rejects.toThrow(/unknown option --wat/);
    await expect(runUi(["--port", "0"])).rejects.toThrow(/invalid port/);
    await expect(runUi(["--bind"])).rejects.toThrow(/--bind needs a value/);
  });

  test("the CLI turns those into a message and a non-zero exit", async () => {
    const lines: string[] = [];
    const code = await runCli(["ui", "--wat"], { writeLine: (line) => lines.push(line) });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("unknown option --wat");
  });
});

describe("stopping the console", () => {
  test("a signal ends the process, and flushes before it does", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    await stopConsole("SIGTERM", {
      write: (line) => lines.push(line),
      stopServer: () => order.push("server"),
      stopSweep: () => order.push("sweep"),
      stopDrain: () => order.push("drain"),
      flush: async () => void order.push("flush"),
      releaseLock: async () => void order.push("lock"),
      exit: (code) => order.push(`exit:${code}`),
    });
    // The server closes before the flush so no request can append a record
    // after the window it covers was written, and the EXIT is the point: a stop
    // that only released things left the admin surface serving through the
    // runtime's whole grace period.
    expect(order).toEqual(["server", "sweep", "drain", "flush", "lock", "exit:0"]);
    expect(lines).toEqual(["stopping on SIGTERM"]);
  });

  test("it still exits when a release throws", async () => {
    const order: string[] = [];
    await stopConsole("SIGINT", {
      write: () => {},
      stopServer: () => order.push("server"),
      stopSweep: () => order.push("sweep"),
      stopDrain: () => order.push("drain"),
      flush: async () => {
        throw new Error("postgres went away");
      },
      releaseLock: async () => {
        throw new Error("read-only filesystem");
      },
      exit: (code) => order.push(`exit:${code}`),
    });
    expect(order).toEqual(["server", "sweep", "drain", "exit:0"]);
  });
});
