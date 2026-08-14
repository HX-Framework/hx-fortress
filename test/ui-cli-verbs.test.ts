import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runUiVerb, type UiVerbDeps } from "../src/cli-ui-verbs";
import { runUiCommand } from "../src/cli-ui";
import { PEOPLE_VISIBILITY_DISCLOSURE } from "../src/ui/copy";
import { CLI_HELP, helpEntries, renderHelp } from "../src/ui/help";
import { machineBootId, processStartToken } from "../src/ui/instance";
import type { UiServiceControl } from "../src/ui/service-control";
import { UiConfigStore } from "../src/ui/config";
import { UsersStore, setupTokenDigest } from "../src/ui/users";
import type { UiAssets } from "../src/ui/assets";

const ASSETS: UiAssets = {
  mode: "embedded",
  files: { "/index.html": "/$bunfs/index.html" },
  inlineScriptHashes: [],
  manifest: { hash: "a".repeat(64), files: 3, bytes: 1024 },
};

let root: string;

class FakeService implements UiServiceControl {
  readonly name = "fake";
  stopped = 0;
  installs = 0;
  starts = 0;
  uninstalls = 0;

  constructor(private present: boolean) {}

  async installed(): Promise<boolean> {
    return this.present;
  }

  async install(): Promise<void> {
    this.installs += 1;
    this.present = true;
  }

  async start(): Promise<void> {
    this.starts += 1;
  }

  async uninstall(): Promise<void> {
    this.uninstalls += 1;
    this.present = false;
  }

  async stopAndDisable(): Promise<void> {
    this.stopped += 1;
  }
}

interface Run {
  code: number;
  out: string;
  lines: string[];
  error: string | null;
}

async function ui(
  args: readonly string[],
  overrides: Partial<UiVerbDeps> = {},
): Promise<Run> {
  const lines: string[] = [];
  let error: string | null = null;
  let code: number;
  try {
    code = await runUiVerb(args, {
      writeLine: (line) => lines.push(line),
      env: {},
      fortressRoot: root,
      platform: "linux",
      hostName: "fortress-1",
      service: new FakeService(false),
      ...overrides,
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    code = 1;
  }
  return { code, out: lines.join("\n"), lines, error };
}

function configStore(): UiConfigStore {
  return new UiConfigStore(path.join(root, "ui", "ui.json"));
}

function usersStore(): UsersStore {
  return new UsersStore(path.join(root, "ui", "users.json"));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hx-ui-verbs-"));
  await mkdir(path.join(root, "ui"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ui config", () => {
  test("prints the effective configuration with the DSN masked", async () => {
    await configStore().update((c) => ({
      ...c,
      publicUrl: "https://console.example.com",
      databaseUrl: "postgresql://hx_ui:s3cret@db.internal:5432/hx-db",
    }));
    const run = await ui(["config"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("publicUrl: https://console.example.com");
    expect(run.out).toContain("postgresql://db.internal:5432/hx-db");
    expect(run.out).not.toContain("s3cret");
    expect(run.out).toContain(`root: ${root}`);
  });

  test("names an env-sourced enablement rather than printing a false 'enabled: false'", async () => {
    const run = await ui(["config"], { env: { FORTRESS_UI_ENABLE: "1" } });
    expect(run.out).toContain("enabled by FORTRESS_UI_ENABLE");
  });
});

describe("ui config set", () => {
  test("refuses an unknown key and lists the settable ones", async () => {
    const run = await ui(["config", "set", "bindAddress", "0.0.0.0"]);
    expect(run.code).toBe(1);
    expect(run.error).toContain("unknown config key 'bindAddress'");
    expect(run.error).toContain("sessionIdleMinutes");
  });

  test("refuses a non-https publicUrl, and one carrying a path", async () => {
    expect((await ui(["config", "set", "publicUrl", "http://c.example.com"])).error).toContain("https");
    const withPath = await ui(["config", "set", "publicUrl", "https://c.example.com/hx"]);
    expect(withPath.error).toContain("no path");
    expect(await configStore().load()).toMatchObject({ publicUrl: null });
  });

  test("accepts a bare https origin and says the running console picks it up", async () => {
    const run = await ui(["config", "set", "publicUrl", "https://console.example.com"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("next request");
    expect((await configStore().load()).publicUrl).toBe("https://console.example.com");
  });

  test("refuses bind 0.0.0.0 with no publicUrl, naming what would allow it", async () => {
    const run = await ui(["config", "set", "bind", "0.0.0.0"]);
    expect(run.code).toBe(1);
    expect(run.error).toContain("refusing to bind 0.0.0.0");
    expect(run.error).toContain("--allow-insecure-bind");
    expect((await configStore().load()).bind).toBe("127.0.0.1");
  });

  test("...and accepts it once a publicUrl exists", async () => {
    await ui(["config", "set", "publicUrl", "https://console.example.com"]);
    expect((await ui(["config", "set", "bind", "0.0.0.0"])).code).toBe(0);
    expect((await configStore().load()).bind).toBe("0.0.0.0");
  });

  test("trustedProxies, port and the session budgets round-trip", async () => {
    await ui(["config", "set", "trustedProxies", "10.0.0.0/8, ::1"]);
    await ui(["config", "set", "port", "9100"]);
    await ui(["config", "set", "sessionTtlHours", "8"]);
    await ui(["config", "set", "sessionIdleMinutes", "30"]);
    expect(await configStore().load()).toMatchObject({
      trustedProxies: ["10.0.0.0/8", "::1"],
      port: 9100,
      sessionTtlHours: 8,
      sessionIdleMinutes: 30,
    });
    expect((await ui(["config", "set", "trustedProxies", "proxy.internal"])).error).toContain(
      "proxy.internal",
    );
  });

  test("databaseUrl positionally is refused with the --stdin remediation, not the unknown-key message", async () => {
    const run = await ui(["config", "set", "databaseUrl", "postgresql://u:p@h/db"]);
    expect(run.code).toBe(1);
    expect(run.error).toContain("--stdin");
    expect(run.error).toContain("/proc/<pid>/cmdline");
    expect(run.error).not.toContain("unknown config key");
    expect((await configStore().load()).databaseUrl).toBeNull();
  });

  test("databaseUrl --stdin succeeds and prints no password", async () => {
    const run = await ui(["config", "set", "databaseUrl", "--stdin"], {
      readStdin: async () => "postgresql://hx_ui:s3cret@db.internal:5432/hx-db\n",
    });
    expect(run.code).toBe(0);
    expect(run.out).not.toContain("s3cret");
    expect((await configStore().load()).databaseUrl).toBe(
      "postgresql://hx_ui:s3cret@db.internal:5432/hx-db",
    );
  });
});

describe("ui config --print-role-sql", () => {
  test("takes the password from stdin, emits a verifier, and prints no secret", async () => {
    await writeFile(
      path.join(root, "ui", "pg.json"),
      JSON.stringify({ mode: "external", databaseUrl: "postgresql://op:opw@db.internal:5432/hx-db" }),
    );
    const run = await ui(["config", "--print-role-sql"], {
      readStdin: async () => "console-role-password\n",
    });
    expect(run.code).toBe(0);
    expect(run.out).toContain("SCRAM-SHA-256$");
    expect(run.out).toContain("CREATE ROLE hx_ui");
    expect(run.out).not.toContain("console-role-password");
    expect(run.out).toContain("postgresql://db.internal:5432/hx-db");
    // The real DSN reached ui.json through the 0600 door instead of stdout.
    expect((await configStore().load()).databaseUrl).toContain("console-role-password");
  });

  test("refuses on an embedded fortress and explains why", async () => {
    await writeFile(
      path.join(root, "ui", "pg.json"),
      JSON.stringify({ mode: "embedded", host: "127.0.0.1", port: 5432, database: "hx-db", user: "hx_ui", password: "x" }),
    );
    expect((await ui(["config", "--print-role-sql"])).error).toContain("embedded Postgres");
  });
});

describe("ui enable / disable", () => {
  test("enable flips the stored setting", async () => {
    expect((await ui(["enable"])).code).toBe(0);
    expect((await configStore().load()).enabled).toBe(true);
  });

  test("disable flips it, bumps the GLOBAL session epoch, and stops the unit", async () => {
    await ui(["enable"]);
    const service = new FakeService(true);
    const run = await ui(["disable"], { service });
    expect(run.code).toBe(0);
    expect((await configStore().load()).enabled).toBe(false);
    expect((await usersStore().load()).sessionEpoch).toBe(1);
    expect(service.stopped).toBe(1);
    expect(run.out).toContain("next tunnel reconnect");
  });

  test("env-sourced enablement is refused by name — a file write would change nothing", async () => {
    const run = await ui(["disable"], { env: { FORTRESS_UI_ENABLE: "1" } });
    expect(run.code).toBe(1);
    expect(run.error).toContain("FORTRESS_UI_ENABLE");
    expect(run.error).toContain("redeploy");
    expect((await usersStore().load()).sessionEpoch).toBe(0);
  });

  test("a FOREGROUND console is refused by name rather than silently no-op'd", async () => {
    await writeFile(
      path.join(root, "ui", "instance.lock"),
      JSON.stringify({ pid: process.pid, bootId: machineBootId(), ...processStartToken(process.pid), port: 8788 }),
    );
    const run = await ui(["disable"]);
    expect(run.code).toBe(1);
    expect(run.error).toContain("running in the foreground");
    expect(run.error).toContain(String(process.pid));
  });
});

describe("ui marker", () => {
  test("sets and clears the banner phrase", async () => {
    expect((await ui(["marker", "Ada's fortress"])).code).toBe(0);
    expect((await configStore().load()).marker).toBe("Ada's fortress");
    await ui(["marker", "--clear"]);
    expect((await configStore().load()).marker).toBeNull();
  });

  test("refuses an empty or oversized phrase", async () => {
    expect((await ui(["marker"])).error).toContain("usage");
    expect((await ui(["marker", "x".repeat(81)])).error).toContain("80 characters");
  });
});

describe("ui sso", () => {
  test("refuses while the console is not enabled, naming the host remedy", async () => {
    const run = await ui(["sso", "on"]);
    expect(run.code).toBe(1);
    expect(run.error).toContain("--install-service");
    expect((await configStore().load()).sso).toBe(false);
  });

  test("names the CONTAINER remedy inside a container", async () => {
    const run = await ui(["sso", "on"], { env: { KUBERNETES_SERVICE_HOST: "10.0.0.1" } });
    expect(run.error).toContain("FORTRESS_UI_ENABLE=1");
    expect(run.error).toContain("redeploy");
  });

  test("refuses without an https publicUrl, and without an operator to sign in as", async () => {
    await ui(["enable"]);
    expect((await ui(["sso", "on"])).error).toContain("public https URL");
    await ui(["config", "set", "publicUrl", "https://console.example.com"]);
    expect((await ui(["sso", "on"])).error).toContain("--role operator");
  });

  test("turns on once every precondition holds, and discloses what it exposes", async () => {
    await ui(["enable"]);
    await ui(["config", "set", "publicUrl", "https://console.example.com"]);
    await ui(["user", "create", "ada", "--role", "operator"]);
    const run = await ui(["sso", "on"]);
    expect(run.code).toBe(0);
    expect((await configStore().load()).sso).toBe(true);
    for (const line of PEOPLE_VISIBILITY_DISCLOSURE) expect(run.lines).toContain(line);
  });

  test("ignores the invoking shell's environment when a unit is installed", async () => {
    // A unit carries no FORTRESS_UI_*; letting this shell's value pass would
    // green-light a check the unit can never satisfy.
    const run = await ui(["sso", "on"], {
      env: { FORTRESS_UI_ENABLE: "1" },
      service: new FakeService(true),
    });
    expect(run.code).toBe(1);
    expect(run.error).toContain("--install-service");
  });

  test("off flips it back and states when the button disappears", async () => {
    await ui(["enable"]);
    await ui(["config", "set", "publicUrl", "https://console.example.com"]);
    await ui(["user", "create", "ada", "--role", "operator"]);
    await ui(["sso", "on"]);
    const run = await ui(["sso", "off"]);
    expect((await configStore().load()).sso).toBe(false);
    expect(run.out).toContain("next tunnel reconnect");
  });
});

describe("ui user", () => {
  beforeEach(async () => {
    await ui(["enable"]);
  });

  test("create prints the disclosure, then a fragment-borne setup link and no password", async () => {
    const run = await ui(["user", "create", "ada", "--role", "operator"]);
    expect(run.code).toBe(0);
    for (const line of PEOPLE_VISIBILITY_DISCLOSURE) expect(run.lines).toContain(line);
    const link = run.lines.find((l) => l.includes("/setup#t="));
    expect(link).toBeDefined();
    expect(run.out).not.toMatch(/password:/i);
    expect(run.out).toContain("ssh -L 8788:127.0.0.1:8788 fortress-1");

    // Only the digest is stored; the link itself exists once, on this screen.
    const token = (link as string).split("#t=")[1] as string;
    expect(await readFile(path.join(root, "ui", "users.json"), "utf8")).toContain(
      setupTokenDigest(token),
    );
  });

  test("the disclosure is byte-identical across every site that prints a URL", async () => {
    const create = await ui(["user", "create", "ada", "--role", "operator"]);
    const reset = await ui(["user", "reset", "ada"]);
    await ui(["config", "set", "publicUrl", "https://console.example.com"]);
    const sso = await ui(["sso", "on"]);
    const serving: string[] = [];
    await runUiCommand([], {
      writeLine: (line) => serving.push(line),
      env: {},
      platform: "linux",
      hostName: "fortress-1",
      fortressRoot: await mkdtemp(path.join(root, "serve-")),
      loadAssets: async () => ASSETS,
      serve: () => ({ port: 8788 }),
    });
    for (const lines of [create.lines, reset.lines, sso.lines, serving]) {
      for (const line of PEOPLE_VISIBILITY_DISCLOSURE) expect(lines).toContain(line);
    }
  });

  test("uses the public URL for the link once one is set", async () => {
    await ui(["config", "set", "publicUrl", "https://console.example.com"]);
    const run = await ui(["user", "create", "ada", "--role", "readonly"]);
    expect(run.out).toContain("https://console.example.com/setup#t=");
    expect(run.out).not.toContain("ssh -L");
  });

  test("uses FORTRESS_UI_PUBLIC_URL too — a container has no ui.json to read", async () => {
    // A container is configured by ENVIRONMENT. On Railway or Kubernetes the
    // public URL is a variable and ui.json carries none, so this printed a link
    // at the bind address — 0.0.0.0 or 127.0.0.1 — that nobody outside the
    // container could open, on the one command whose whole output is a link
    // somebody is meant to click. The advertiser and the runtime already
    // resolved it env-first; this did not.
    const run = await ui(["user", "create", "grace", "--role", "operator"], {
      env: { FORTRESS_UI_ENABLE: "1", FORTRESS_UI_PUBLIC_URL: "https://fortress.up.railway.app" },
    });
    expect(run.out).toContain("https://fortress.up.railway.app/setup#t=");
    expect(run.out).not.toContain("0.0.0.0");
    expect(run.out).not.toContain("127.0.0.1");
  });

  test("requires a role, and validates the login", async () => {
    expect((await ui(["user", "create", "ada"])).error).toContain("--role is required");
    expect((await ui(["user", "create", "ada", "--role", "admin"])).error).toContain("--role is required");
    expect((await ui(["user", "create", "../etc", "--role", "operator"])).error).toContain("invalid login");
  });

  test("refuses to mint a link when the console is not serving", async () => {
    const cold = await mkdtemp(path.join(root, "cold-"));
    const run = await ui(["user", "create", "ada", "--role", "operator"], { fortressRoot: cold });
    expect(run.code).toBe(1);
    expect(run.error).toContain("only useful once the console answers");
  });

  test("list shows state without ever showing a hash", async () => {
    await ui(["user", "create", "ada", "--role", "operator"]);
    await ui(["user", "create", "bob", "--role", "readonly"]);
    await ui(["user", "disable", "bob"]);
    const run = await ui(["user", "list"]);
    expect(run.out).toContain("ada");
    expect(run.out).toContain("awaiting setup");
    expect(run.out).toContain("disabled");
    expect(run.out).not.toContain("argon2");
  });

  test("delete removes the account from the listing", async () => {
    await ui(["user", "create", "ada", "--role", "operator"]);
    await ui(["user", "delete", "ada"]);
    expect((await ui(["user", "list"])).out).toContain("No console accounts yet");
  });

  test("reset says the current password keeps working until the link completes", async () => {
    await ui(["user", "create", "ada", "--role", "operator"]);
    const run = await ui(["user", "reset", "ada"]);
    expect(run.out).toContain("keeps working until this link is completed");
    expect(run.out).toContain("/setup#t=");
  });

  test("no verb leaves a token anywhere on disk after it is consumed", async () => {
    const created = await ui(["user", "create", "ada", "--role", "operator"]);
    const token = (created.lines.find((l) => l.includes("#t=")) as string).split("#t=")[1] as string;
    await usersStore().completeSetup(token, "correct-horse-battery");
    const stored = await readFile(path.join(root, "ui", "users.json"), "utf8");
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(setupTokenDigest(token));
  });
});

describe("--force-unlock", () => {
  test("clears a lock a killed writer left behind", async () => {
    const lock = `${path.join(root, "ui", "ui.json")}.lock`;
    await writeFile(lock, JSON.stringify({ pid: 1, bootId: "someone-else", at: new Date().toISOString() }));
    const run = await ui(["config", "set", "port", "9100", "--force-unlock"]);
    expect(run.code).toBe(0);
    expect((await configStore().load()).port).toBe(9100);
  });
});

describe("the help registry", () => {
  test("covers every verb group the console offers", () => {
    expect(CLI_HELP.map((s) => s.name)).toEqual([
      "fortress",
      "console",
      "residency audit",
      "roster",
      "console users",
      "console sso",
    ]);
    const usages = helpEntries().map((e) => e.usage);
    for (const verb of [
      "hx-fortress ui config set <key> <value>",
      "hx-fortress ui user create <login> --role operator|readonly",
      "hx-fortress ui sso on",
      "hx-fortress container-run",
      "hx-fortress roster purge-inactive [--days <n>]",
    ]) {
      expect(usages).toContain(verb);
    }
  });

  test("renders one line per entry, and every entry has a summary", () => {
    const rendered = renderHelp().join("\n");
    for (const entry of helpEntries()) {
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(rendered).toContain(entry.usage);
    }
  });
});
