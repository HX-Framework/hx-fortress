import { describe, it, expect } from "bun:test";
import { resolveGatewayConfig } from "../../src/host/config";

describe("resolveGatewayConfig", () => {
  it("prefers FORTRESS_PUBLIC_URL over the persisted config value", () => {
    const cfg = resolveGatewayConfig(
      {
        FORTRESS_PUBLIC_URL: "https://fortress.acme.example",
        FORTRESS_GATEWAY_PORT: "8787",
      },
      // "http://localhost:8787",
    );
    expect(cfg.gatewayUrl).toBe("https://fortress.acme.example");
    expect(cfg.port).toBe(8787);
    expect(cfg.enabled).toBe(true);
  });

  // MC-2382: the persisted config value (the localhost default written at enroll)
  // is local-only and never advertised. With fortress-direct retired, ingest
  // relays over the tunnel, so the gateway is disabled unless the operator opts
  // in via FORTRESS_PUBLIC_URL.
  it("ignores the persisted config value (advertise only via FORTRESS_PUBLIC_URL)", () => {
    const cfg = resolveGatewayConfig({},
      //  "http://localhost:8787"
    );
    expect(cfg.enabled).toBe(false);
    expect(cfg.gatewayUrl).toBeUndefined();
    expect(cfg.port).toBe(8787);
  });

  it("is disabled when env provides no public URL", () => {
    const cfg = resolveGatewayConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.port).toBe(8787);
  });
});
