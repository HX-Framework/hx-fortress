import { describe, expect, test } from "bun:test";

import {
  buildHostAllowlist,
  checkHost,
  checkOrigin,
  splitHost,
} from "../src/ui/origin";
import { addressMatches, normalizeAddress, remoteKeyFor } from "../src/ui/remote-key";

const LOOPBACK = buildHostAllowlist({ bind: "127.0.0.1", port: 8788, publicUrl: null });
const PUBLIC = buildHostAllowlist({
  bind: "::",
  port: 8788,
  publicUrl: "https://console.example.com",
});

describe("the Host allowlist", () => {
  test("accepts literal loopback on ANY port — a published container remaps it", () => {
    for (const host of ["127.0.0.1:8788", "127.0.0.1:9000", "[::1]:31337", "localhost:8788"]) {
      expect(checkHost(host, LOOPBACK).ok).toBe(true);
    }
  });

  test("rejects a host nobody configured, which is what stops DNS rebinding", () => {
    const refused = checkHost("evil.example.com", LOOPBACK);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain("not configured");
  });

  test("rejects a wildcard Host outright", () => {
    expect(checkHost("0.0.0.0:8788", PUBLIC).ok).toBe(false);
    expect(checkHost("[::]:8788", PUBLIC).ok).toBe(false);
  });

  test("a trailing dot is the same name", () => {
    const dotted = checkHost("console.example.com.", PUBLIC);
    expect(dotted.ok).toBe(true);
    expect(dotted.ok && dotted.origin).toBe("https://console.example.com");
  });

  test("an IPv4-mapped IPv6 loopback is the same address", () => {
    expect(normalizeAddress("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(checkHost("[::ffff:127.0.0.1]:8788", LOOPBACK).ok).toBe(true);
  });

  test("the publicUrl origin is on the list, on its own port, as https", () => {
    const match = checkHost("console.example.com", PUBLIC);
    expect(match.ok && match.scheme).toBe("https");
    expect(match.ok && match.origin).toBe("https://console.example.com");
    // ...and only on its own port: a different one is a different origin.
    expect(checkHost("console.example.com:9443", PUBLIC).ok).toBe(false);
  });

  test("HSTS is claimed only where a configured host is https", () => {
    expect(PUBLIC.hsts).toBe(true);
    expect(LOOPBACK.hsts).toBe(false);
  });

  test("a non-loopback bind is reachable by its own address", () => {
    const allow = buildHostAllowlist({ bind: "10.0.0.5", port: 8788, publicUrl: null });
    expect(checkHost("10.0.0.5:8788", allow).ok).toBe(true);
    expect(checkHost("10.0.0.5:9999", allow).ok).toBe(false);
  });

  test("splitHost handles brackets, ports and rubbish", () => {
    expect(splitHost("[::1]:8788")).toEqual({ host: "::1", port: "8788" });
    expect(splitHost("example.com")).toEqual({ host: "example.com", port: null });
    expect(splitHost("example.com:notaport")).toBeNull();
    expect(splitHost("")).toBeNull();
  });
});

describe("the Origin rule", () => {
  const host = checkHost("console.example.com", PUBLIC);

  test("matches the origin derived from THIS request's host", () => {
    expect(checkOrigin("https://console.example.com", host)).toEqual({ ok: true });
  });

  test("fails closed on absent and on null", () => {
    expect(checkOrigin(null, host).ok).toBe(false);
    expect(checkOrigin("null", host).ok).toBe(false);
  });

  test("a different origin, scheme or port is refused", () => {
    expect(checkOrigin("https://evil.example.com", host).ok).toBe(false);
    expect(checkOrigin("http://console.example.com", host).ok).toBe(false);
    expect(checkOrigin("https://console.example.com:8443", host).ok).toBe(false);
  });

  test("a loopback arrival validates against loopback, not against the public URL", () => {
    const local = checkHost("127.0.0.1:8788", PUBLIC);
    expect(checkOrigin("http://127.0.0.1:8788", local)).toEqual({ ok: true });
    expect(checkOrigin("https://console.example.com", local).ok).toBe(false);
  });

  test("a refused Host refuses the Origin with it", () => {
    expect(checkOrigin("https://evil.example.com", checkHost("evil.example.com", PUBLIC)).ok).toBe(
      false,
    );
  });
});

describe("the remote key", () => {
  test("with no trusted proxies, X-Forwarded-For is ignored entirely", () => {
    expect(
      remoteKeyFor({ peer: "10.0.0.9", forwardedFor: "1.2.3.4", trustedProxies: [] }),
    ).toBe("10.0.0.9");
  });

  test("from an untrusted peer, X-Forwarded-For is ignored", () => {
    expect(
      remoteKeyFor({ peer: "10.0.0.9", forwardedFor: "1.2.3.4", trustedProxies: ["192.168.0.0/16"] }),
    ).toBe("10.0.0.9");
  });

  test("from a trusted peer, the walk stops at the first non-trusted entry FROM THE RIGHT", () => {
    expect(
      remoteKeyFor({
        peer: "10.0.0.1",
        forwardedFor: "203.0.113.7, 10.0.0.2, 10.0.0.3",
        trustedProxies: ["10.0.0.0/8"],
      }),
    ).toBe("203.0.113.7");
  });

  test("ADVERSARIAL: an attacker-prepended entry does not move the key", () => {
    const honest = remoteKeyFor({
      peer: "10.0.0.1",
      forwardedFor: "203.0.113.7, 10.0.0.2",
      trustedProxies: ["10.0.0.0/8"],
    });
    const attacked = remoteKeyFor({
      peer: "10.0.0.1",
      forwardedFor: "9.9.9.9, 8.8.8.8, 203.0.113.7, 10.0.0.2",
      trustedProxies: ["10.0.0.0/8"],
    });
    expect(attacked).toBe(honest);
    expect(attacked).toBe("203.0.113.7");
  });

  test("all-trusted, absent and malformed all fall back to the peer", () => {
    const trusted = ["10.0.0.0/8"];
    expect(remoteKeyFor({ peer: "10.0.0.1", forwardedFor: "10.0.0.2, 10.0.0.3", trustedProxies: trusted })).toBe("10.0.0.1");
    expect(remoteKeyFor({ peer: "10.0.0.1", forwardedFor: null, trustedProxies: trusted })).toBe("10.0.0.1");
    expect(remoteKeyFor({ peer: "10.0.0.1", forwardedFor: "not-an-address", trustedProxies: trusted })).toBe("10.0.0.1");
  });

  test("PROXIED FLOOD: one peer, distinct forwarded sources, distinct keys", () => {
    const keys = new Set(
      ["198.51.100.1", "198.51.100.2", "198.51.100.3"].map((source) =>
        remoteKeyFor({ peer: "10.0.0.1", forwardedFor: source, trustedProxies: ["10.0.0.0/8"] }),
      ),
    );
    expect(keys.size).toBe(3);
  });

  test("the hop cap bounds the walk", () => {
    const hops = Array.from({ length: 40 }, (_, i) => `10.0.0.${(i % 200) + 1}`).join(", ");
    expect(
      remoteKeyFor({ peer: "10.0.0.1", forwardedFor: `203.0.113.7, ${hops}`, trustedProxies: ["10.0.0.0/8"] }),
    ).toBe("10.0.0.1");
  });

  test("CIDR matching respects family and prefix", () => {
    expect(addressMatches("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(addressMatches("11.1.2.3", "10.0.0.0/8")).toBe(false);
    expect(addressMatches("10.1.2.3", "10.1.2.0/24")).toBe(true);
    expect(addressMatches("10.1.3.3", "10.1.2.0/24")).toBe(false);
    expect(addressMatches("::1", "10.0.0.0/8")).toBe(false);
    expect(addressMatches("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(addressMatches("::ffff:10.1.2.3", "10.0.0.0/8")).toBe(true);
  });
});
