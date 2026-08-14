import { describe, expect, test } from "bun:test";

import {
  DEFAULT_UI_PORT,
  parsePublicUrl,
  printedUrl,
  resolveUiBind,
  type BindInputs,
} from "../src/ui/bind";
import { containerFromSignals, type ContainerSignals } from "../src/ui/container";

const NO_SIGNALS: ContainerSignals = {
  dockerenv: false,
  containerenv: false,
  cgroup: null,
  initEnviron: null,
  kubernetes: false,
  railway: false,
};

const bareHost = containerFromSignals(NO_SIGNALS);
const dockerHost = containerFromSignals({ ...NO_SIGNALS, dockerenv: true });
const lxcHost = containerFromSignals({ ...NO_SIGNALS, cgroup: "1:name=systemd:/lxc/web" });

function inputs(overrides: Partial<BindInputs> = {}): BindInputs {
  return {
    bind: "127.0.0.1",
    port: DEFAULT_UI_PORT,
    publicUrl: null,
    uiEnable: false,
    containerBind: false,
    allowInsecureBind: false,
    container: bareHost,
    ...overrides,
  };
}

const RESIDUAL = /residual: a non-loopback listener is reachable/;

describe("bind rule", () => {
  test("loopback is the default, with nothing to warn about", () => {
    const resolved = resolveUiBind(inputs());
    expect(resolved).toMatchObject({ ok: true, clause: "loopback", hostname: "127.0.0.1" });
    if (resolved.ok) expect(resolved.notes).toEqual([]);
  });

  test("a detected container with no enablement stays on loopback", () => {
    expect(resolveUiBind(inputs({ container: dockerHost }))).toMatchObject({
      ok: true,
      clause: "loopback",
      hostname: "127.0.0.1",
    });
  });

  test("clause 1 — docker-class + FORTRESS_UI_ENABLE binds dual-stack and prints the publish line", () => {
    const resolved = resolveUiBind(inputs({ container: dockerHost, uiEnable: true }));
    expect(resolved).toMatchObject({ ok: true, clause: "container-publish", hostname: "::" });
    if (!resolved.ok) throw new Error("expected a bind");
    expect(resolved.dualStack).toBe(true);
    expect(resolved.notes.join("\n")).toMatch(RESIDUAL);
    expect(resolved.notes.join("\n")).toContain("-p 127.0.0.1:8788:8788");
    // Host networking is undetectable from inside, so the same bind may be a
    // real LAN bind — say so even on the permitted path.
    expect(resolved.notes.join("\n")).toMatch(/--network host/);
  });

  test("clause 2 — FORTRESS_UI_CONTAINER_BIND=1 binds dual-stack anywhere, with the residual", () => {
    for (const container of [bareHost, lxcHost, dockerHost]) {
      const resolved = resolveUiBind(inputs({ container, containerBind: true }));
      expect(resolved).toMatchObject({ ok: true, clause: "container-gesture", hostname: "::" });
      if (resolved.ok) expect(resolved.notes.join("\n")).toMatch(RESIDUAL);
    }
  });

  test("clause 2 — an lxc/nspawn guest with enablement alone is refused, and the gesture is named", () => {
    const resolved = resolveUiBind(inputs({ container: lxcHost, uiEnable: true }));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected a refusal");
    expect(resolved.reason).toMatch(/no published-port indirection/);
    expect(resolved.notes.join("\n")).toContain("FORTRESS_UI_CONTAINER_BIND=1");
    expect(resolved.notes.join("\n")).toContain("--allow-insecure-bind");
    expect(resolved.notes.join("\n")).toMatch(RESIDUAL);
  });

  test("clause 2 — --allow-insecure-bind is the equivalent gesture for that guest", () => {
    const resolved = resolveUiBind(
      inputs({ container: lxcHost, uiEnable: true, allowInsecureBind: true }),
    );
    expect(resolved).toMatchObject({ ok: true, clause: "container-gesture", hostname: "::" });
    if (resolved.ok) expect(resolved.notes.join("\n")).toMatch(RESIDUAL);
  });

  test("clause 3 — a non-loopback bind on a bare host with nothing is refused", () => {
    const resolved = resolveUiBind(inputs({ bind: "0.0.0.0" }));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected a refusal");
    expect(resolved.reason).toContain("https FORTRESS_UI_PUBLIC_URL");
    expect(resolved.reason).toContain("--allow-insecure-bind");
    expect(resolved.notes.join("\n")).toMatch(RESIDUAL);
  });

  test("clause 3 — an https public URL authorizes the bind the operator named", () => {
    expect(
      resolveUiBind(inputs({ bind: "0.0.0.0", publicUrl: "https://console.example.com" })),
    ).toMatchObject({ ok: true, clause: "public-url", hostname: "0.0.0.0" });
  });

  test("clause 3 — --allow-insecure-bind authorizes it too, with the residual printed", () => {
    const resolved = resolveUiBind(inputs({ bind: "10.0.0.5", allowInsecureBind: true }));
    expect(resolved).toMatchObject({ ok: true, clause: "insecure-flag", hostname: "10.0.0.5" });
    if (resolved.ok) expect(resolved.notes.join("\n")).toMatch(RESIDUAL);
  });

  test("an http public URL is refused; the explicit flag is the only way past, loudly", () => {
    const refused = resolveUiBind(inputs({ publicUrl: "http://console.example.com" }));
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.reason).toContain("must be https");
    expect(refused.notes.join("\n")).toContain("--allow-insecure-bind");

    // Accepted under the flag — but never silently: the operator is told what
    // crosses the wire, even on the loopback bind that is otherwise noteless.
    const forced = resolveUiBind(
      inputs({ publicUrl: "http://console.example.com", allowInsecureBind: true }),
    );
    expect(forced.ok).toBe(true);
    if (!forced.ok) throw new Error("expected a bind");
    expect(forced.notes.join("\n")).toMatch(/clear text/);
  });

  test("a malformed public URL is refused outright — no flag makes it correct", () => {
    for (const publicUrl of [
      "https://example.com/console",
      "https://example.com/?a=1",
      "not-a-url",
    ]) {
      const refused = resolveUiBind(inputs({ publicUrl, allowInsecureBind: true }));
      expect(refused.ok).toBe(false);
      if (refused.ok) throw new Error(`expected a refusal for ${publicUrl}`);
      expect(refused.notes).toEqual([]);
    }
    expect(
      (resolveUiBind(inputs({ publicUrl: "https://example.com/console" })) as { reason: string })
        .reason,
    ).toMatch(/bare origin/);
  });
});

describe("parsePublicUrl", () => {
  test("accepts a bare https origin and normalizes it", () => {
    const parsed = parsePublicUrl("https://console.example.com:8443/");
    expect(parsed).toMatchObject({ ok: true, origin: "https://console.example.com:8443" });
  });

  test("rejects http, paths, query, fragment and userinfo, and says which kind", () => {
    const kinds: Record<string, string> = {
      "http://console.example.com": "not-https",
      "https://console.example.com/x": "not-an-origin",
      "https://console.example.com/?a=1": "not-an-origin",
      "https://console.example.com/#f": "not-an-origin",
      "https://user:pw@console.example.com": "not-an-origin",
      "not-a-url": "not-a-url",
    };
    for (const [raw, kind] of Object.entries(kinds)) {
      const parsed = parsePublicUrl(raw);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error(`expected a refusal for ${raw}`);
      expect(parsed.kind).toBe(kind as never);
    }
  });
});

describe("printed URL derivation", () => {
  const base = { hostname: "127.0.0.1", dualStack: false, port: 8788, hostName: "fortress-1" };

  test("no public URL: the bind address plus the SSH forward that reaches it", () => {
    const printed = printedUrl({ ...base, urlOverride: null, publicUrl: null });
    expect(printed.base).toBe("http://127.0.0.1:8788");
    expect(printed.notes.join("\n")).toContain("ssh -L 8788:127.0.0.1:8788 fortress-1");
  });

  test("an https public URL replaces the base and the tunnel line", () => {
    const printed = printedUrl({
      ...base,
      urlOverride: null,
      publicUrl: "https://console.example.com",
    });
    expect(printed.base).toBe("https://console.example.com");
    expect(printed.notes).toEqual([]);
  });

  test("--url wins over everything and loses its trailing slash", () => {
    const printed = printedUrl({
      ...base,
      urlOverride: "https://via-tunnel.example.com/",
      publicUrl: "https://console.example.com",
    });
    expect(printed.base).toBe("https://via-tunnel.example.com");
  });

  test("a dual-stack bind prints 127.0.0.1, never localhost, and drops the SSH line", () => {
    const printed = printedUrl({
      ...base,
      hostname: "::",
      dualStack: true,
      urlOverride: null,
      publicUrl: null,
    });
    expect(printed.base).toBe("http://127.0.0.1:8788");
    // You cannot ssh into a container; the publish guidance is the answer there.
    expect(printed.notes).toEqual([]);
  });

  test("an explicit non-loopback bind prints that address, brackets IPv6, and needs no tunnel", () => {
    const printed = printedUrl({
      ...base,
      hostname: "10.0.0.5",
      urlOverride: null,
      publicUrl: null,
    });
    expect(printed.base).toBe("http://10.0.0.5:8788");
    expect(printed.notes).toEqual([]);
    expect(
      printedUrl({ ...base, hostname: "fd00::1", urlOverride: null, publicUrl: null }).base,
    ).toBe("http://[fd00::1]:8788");
  });
});
