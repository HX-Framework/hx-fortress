import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  checkBind,
  checkPort,
  checkPublicUrl,
  checkSessionIdleMinutes,
  checkSessionTtlHours,
  checkTrustedProxies,
  effectiveUiEnabled,
  isStdinOnlyKey,
  isUiConfigSetKey,
  LiveUiConfig,
  maskDatabaseUrl,
  printableUiConfig,
  stdinOnlyMessage,
  UI_CONFIG_SET_KEYS,
  UiConfigColdStartError,
  UiConfigStore,
  unknownKeyMessage,
} from "../src/ui/config";
import { detectContainer } from "../src/ui/container";
import { StoreCorruptError } from "../src/ui/store-lock";

let root: string;
let file: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hx-ui-config-"));
  file = path.join(root, "ui.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ui.json read rules", () => {
  test("an absent file at the FIRST read resolves enabled:false", async () => {
    const live = new LiveUiConfig(file);
    const config = await live.read();
    expect(config.enabled).toBe(false);
    expect(effectiveUiEnabled(config, {})).toBe(false);
  });

  test("FORTRESS_UI_ENABLE alone satisfies the predicate", async () => {
    const config = await new LiveUiConfig(file).read();
    expect(effectiveUiEnabled(config, { FORTRESS_UI_ENABLE: "1" })).toBe(true);
    expect(effectiveUiEnabled(config, { FORTRESS_UI_ENABLE: "true" })).toBe(true);
    expect(effectiveUiEnabled(config, { FORTRESS_UI_ENABLE: "0" })).toBe(false);
  });

  test("a torn re-read keeps the last good snapshot and warns exactly once", async () => {
    const store = new UiConfigStore(file);
    await store.update((c) => ({ ...c, enabled: true, publicUrl: "https://console.example.com" }));
    const warnings: string[] = [];
    const live = new LiveUiConfig(file, (m) => warnings.push(m));
    expect((await live.read()).publicUrl).toBe("https://console.example.com");

    await writeFile(file, "{ not json");
    expect((await live.read()).publicUrl).toBe("https://console.example.com");
    expect((await live.read()).enabled).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  test("a file that vanishes at a RE-read keeps the last good value, never enabled:false", async () => {
    const store = new UiConfigStore(file);
    await store.update((c) => ({ ...c, enabled: true }));
    const live = new LiveUiConfig(file);
    expect((await live.read()).enabled).toBe(true);
    await unlink(file);
    expect((await live.read()).enabled).toBe(true);
  });

  test("an unparseable file at a COLD start refuses by name and names no fallback DSN", async () => {
    await writeFile(file, "}{");
    const live = new LiveUiConfig(file);
    let thrown: unknown;
    await live.read().catch((err: unknown) => {
      thrown = err;
    });
    expect(thrown).toBeInstanceOf(UiConfigColdStartError);
    expect((thrown as Error).message).toContain("does not parse");
    expect((thrown as Error).message).not.toContain("pg.json");
  });

  test("a writer against a corrupt file refuses with a remediation and writes nothing", async () => {
    await writeFile(file, "[]");
    const store = new UiConfigStore(file);
    await expect(store.update((c) => ({ ...c, enabled: true }))).rejects.toBeInstanceOf(
      StoreCorruptError,
    );
    await expect(store.update((c) => c)).rejects.toThrow(/never rebuilt automatically/);
    expect(await readFile(file, "utf8")).toBe("[]");
  });

  test("the file is written 0600", async () => {
    await new UiConfigStore(file).update((c) => ({ ...c, port: 9000 }));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("concurrent writers both land — the CAS retries rather than dropping one", async () => {
    const a = new UiConfigStore(file);
    const b = new UiConfigStore(file);
    await Promise.all([
      a.update((c) => ({ ...c, publicUrl: "https://console.example.com" })),
      b.update((c) => ({ ...c, sso: true })),
    ]);
    const final = await a.load();
    expect(final.publicUrl).toBe("https://console.example.com");
    expect(final.sso).toBe(true);
    expect(final.version).toBe(2);
  });
});

describe("the ui config set key set", () => {
  test("is exactly seven keys and databaseUrl is one of them", () => {
    expect([...UI_CONFIG_SET_KEYS]).toEqual([
      "publicUrl",
      "trustedProxies",
      "port",
      "bind",
      "sessionTtlHours",
      "sessionIdleMinutes",
      "databaseUrl",
    ]);
    expect(isUiConfigSetKey("databaseUrl")).toBe(true);
    expect(isStdinOnlyKey("databaseUrl")).toBe(true);
    expect(isStdinOnlyKey("publicUrl")).toBe(false);
  });

  test("an unknown key is refused with the enumerated list", () => {
    const message = unknownKeyMessage("bindAddress");
    expect(message).toContain("unknown config key 'bindAddress'");
    for (const key of UI_CONFIG_SET_KEYS) expect(message).toContain(key);
  });

  test("the databaseUrl refusal names --stdin rather than the generic message", () => {
    const message = stdinOnlyMessage("databaseUrl");
    expect(message).toContain("--stdin");
    expect(message).toContain("/proc/<pid>/cmdline");
    expect(message).not.toContain("unknown config key");
  });
});

describe("value validation", () => {
  test("publicUrl must be https", () => {
    const refused = checkPublicUrl("http://console.example.com");
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain("https");
  });

  test("publicUrl with a path is refused at the fortress, with the reason", () => {
    const refused = checkPublicUrl("https://console.example.com/hx");
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain("no path");
    expect(refused.ok === false && refused.reason).toContain("root-absolute");
  });

  test("publicUrl normalizes to a bare origin", () => {
    const ok = checkPublicUrl(" https://console.example.com ");
    expect(ok).toEqual({ ok: true, value: "https://console.example.com" });
  });

  test("trustedProxies takes IPs and CIDRs and rejects anything else", () => {
    expect(checkTrustedProxies("10.0.0.1, 10.1.0.0/16, ::1")).toEqual({
      ok: true,
      value: ["10.0.0.1", "10.1.0.0/16", "::1"],
    });
    const refused = checkTrustedProxies("10.0.0.1, proxy.internal");
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain("proxy.internal");
    expect(checkTrustedProxies("10.0.0.0/64").ok).toBe(false);
  });

  test("port, ttl and idle ranges", () => {
    expect(checkPort("8788")).toEqual({ ok: true, value: 8788 });
    expect(checkPort("0").ok).toBe(false);
    expect(checkPort("70000").ok).toBe(false);
    expect(checkSessionTtlHours("12")).toEqual({ ok: true, value: 12 });
    expect(checkSessionTtlHours("0").ok).toBe(false);
    expect(checkSessionIdleMinutes("60")).toEqual({ ok: true, value: 60 });
    expect(checkSessionIdleMinutes("-1").ok).toBe(false);
  });

  test("bind 0.0.0.0 with no publicUrl is refused AT SET TIME, with the remediation", () => {
    const refused = checkBind("0.0.0.0", {
      publicUrl: null,
      port: 8788,
      env: {},
      platform: "linux",
      container: detectContainer({ env: {}, platform: "linux", noContainerFlag: true }),
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain("refusing to bind 0.0.0.0");
    expect(refused.ok === false && refused.reason).toContain("publicUrl");
    expect(refused.ok === false && refused.reason).toContain("--allow-insecure-bind");
  });

  test("bind 0.0.0.0 is accepted once an https publicUrl exists", () => {
    expect(
      checkBind("0.0.0.0", {
        publicUrl: "https://console.example.com",
        port: 8788,
        env: {},
        platform: "linux",
        container: detectContainer({ env: {}, platform: "linux", noContainerFlag: true }),
      }),
    ).toEqual({ ok: true, value: "0.0.0.0" });
  });
});

describe("printing", () => {
  test("databaseUrl is masked to scheme, host and database", () => {
    expect(maskDatabaseUrl("postgresql://hx_ui:s3cret@db.internal:5432/hx-db")).toBe(
      "postgresql://db.internal:5432/hx-db",
    );
    expect(maskDatabaseUrl("not a url")).toBe("(unparseable connection string — redacted)");
  });

  test("the printout never carries a password", async () => {
    const store = new UiConfigStore(file);
    await store.update((c) => ({
      ...c,
      databaseUrl: "postgresql://hx_ui:s3cret@db.internal:5432/hx-db",
    }));
    const rendered = printableUiConfig(await store.load())
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    expect(rendered).not.toContain("s3cret");
    expect(rendered).toContain("postgresql://db.internal:5432/hx-db");
  });
});
