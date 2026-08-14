import { describe, expect, test } from "bun:test";
import {
  installBaseFromCloudUrl,
  requestInstallCode,
  pollInstallToken,
} from "../src/modules/session-vault/browser-enroll";

describe("installBaseFromCloudUrl", () => {
  test("wss vault-tunnel → https hx-gateway base", () => {
    expect(installBaseFromCloudUrl("wss://beta.let.ai/_api/hx-gateway/vault-tunnel")).toBe(
      "https://beta.let.ai/_api/hx-gateway",
    );
  });
});

describe("pollInstallToken", () => {
  test("returns ready with token when server flips to ready", async () => {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname.endsWith("/install/poll")) {
          hits += 1;
          const body = hits < 2 ? { status: "pending" } : { status: "ready", token: "vlt_abc" };
          return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
        }
        return new Response("nope", { status: 404 });
      },
    });
    const base = `http://localhost:${server.port}/_api/hx-gateway`;
    const res = await pollInstallToken(base, "dvc_x", {
      intervalMs: 1,
      deadlineMs: 10_000,
      now: () => Date.now(),
      sleep: async () => {},
    });
    server.stop();
    expect(res).toEqual({ kind: "ready", token: "vlt_abc" });
  });

  test("stops with expired at the deadline", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ status: "pending" }), {
          headers: { "content-type": "application/json" },
        }),
    });
    const base = `http://localhost:${server.port}/_api/hx-gateway`;
    let t = 0;
    const res = await pollInstallToken(base, "dvc_x", {
      intervalMs: 1,
      deadlineMs: 5,
      now: () => (t += 3),
      sleep: async () => {},
    });
    server.stop();
    expect(res).toEqual({ kind: "expired" });
  });

  test("retries gracefully on a thrown fetch instead of crashing", async () => {
    let calls = 0;
    const failingFetch = Object.assign(
      (): Promise<Response> => {
        calls += 1;
        if (calls < 2) throw new Error("network down");
        return Promise.resolve(
          new Response(JSON.stringify({ status: "ready", token: "vlt_retry" }), {
            headers: { "content-type": "application/json" },
          }),
        );
      },
      { preconnect: fetch.preconnect },
    ) satisfies typeof fetch;

    const res = await pollInstallToken("http://localhost:1", "dvc_x", {
      intervalMs: 1,
      deadlineMs: 10_000,
      now: () => Date.now(),
      sleep: async () => {},
      fetchImpl: failingFetch,
    });
    expect(res).toEqual({ kind: "ready", token: "vlt_retry" });
    expect(calls).toBe(2);
  });
});

describe("requestInstallCode", () => {
  test("posts to install/code and returns parsed InstallCode", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname.endsWith("/install/code") && req.method === "POST") {
          return new Response(
            JSON.stringify({
              userCode: "ABCD-1234",
              deviceCode: "dvc_x",
              verificationUriComplete: "https://example.com/verify?code=ABCD-1234",
              interval: 5,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("nope", { status: 404 });
      },
    });
    const base = `http://localhost:${server.port}/_api/hx-gateway`;
    const code = await requestInstallCode(base);
    server.stop();
    expect(code.userCode).toBe("ABCD-1234");
    expect(code.deviceCode).toBe("dvc_x");
    expect(code.interval).toBe(5);
  });

  test("throws on non-ok response", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) });
    const base = `http://localhost:${server.port}/_api/hx-gateway`;
    await expect(requestInstallCode(base)).rejects.toThrow();
    server.stop();
  });
});
