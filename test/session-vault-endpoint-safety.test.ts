import { describe, expect, test } from "bun:test";

import { assertS3EndpointSafe } from "../src/modules/session-vault/store/endpoint-safety";

// M-4 · a self-hosted vault's custom S3 endpoint must be https and must not aim
// at a loopback / link-local / private-range IP literal, unless the operator
// explicitly opts in. An optional host allowlist narrows further.

describe("assertS3EndpointSafe", () => {
  test("no custom endpoint is a no-op", () => {
    expect(() => assertS3EndpointSafe(undefined, {})).not.toThrow();
    expect(() => assertS3EndpointSafe("", {})).not.toThrow();
  });

  test("rejects a plaintext endpoint at the cloud-metadata address", () => {
    expect(() => assertS3EndpointSafe("http://169.254.169.254", {})).toThrow(
      /must use https/,
    );
  });

  test("rejects an https endpoint at a private-range IP literal", () => {
    expect(() => assertS3EndpointSafe("https://10.0.0.5", {})).toThrow(
      /private\/loopback address/,
    );
  });

  test("rejects the link-local metadata IP even over https", () => {
    expect(() => assertS3EndpointSafe("https://169.254.169.254", {})).toThrow(
      /private\/loopback address/,
    );
  });

  // SSRF IP-encoding bypass: an integer / hex / octal encoding of a loopback or
  // metadata address must be rejected too. The WHATWG URL parser canonicalizes
  // most of these to dotted-decimal (so the range classifier catches them); the
  // obfuscated-literal guard is the belt-and-suspenders for a parser that doesn't.
  test.each([
    ["decimal-integer metadata IP (2852039166 = 169.254.169.254)", "https://2852039166/"],
    ["hex loopback (0x7f000001 = 127.0.0.1)", "https://0x7f000001/"],
    ["octal loopback (0177.0.0.1 = 127.0.0.1)", "https://0177.0.0.1/"],
    ["decimal-integer loopback (2130706433 = 127.0.0.1)", "https://2130706433/"],
  ])("rejects an encoded-IP endpoint: %s", (_name, endpoint) => {
    expect(() => assertS3EndpointSafe(endpoint, {})).toThrow(
      /private\/loopback address|obfuscated IP literal/,
    );
  });

  test("rejects the unspecified 0.0.0.0 address (0.0.0.0/8)", () => {
    expect(() => assertS3EndpointSafe("https://0.0.0.0", {})).toThrow(/private\/loopback address/);
  });

  test("rejects a carrier-grade-NAT address (100.64.0.0/10)", () => {
    expect(() => assertS3EndpointSafe("https://100.64.0.1", {})).toThrow(/private\/loopback address/);
  });

  test("rejects an IPv4-mapped IPv6 metadata address (hex-normalized form)", () => {
    expect(() => assertS3EndpointSafe("https://[::ffff:169.254.169.254]", {})).toThrow(
      /private\/loopback address/,
    );
  });

  test("rejects an fe80::/10 link-local address the old fe80-prefix check missed", () => {
    expect(() => assertS3EndpointSafe("https://[fe9a::1]", {})).toThrow(/private\/loopback address/);
  });

  test("rejects a host that is not in the allowlist", () => {
    expect(() =>
      assertS3EndpointSafe("https://minio.other.example", {
        FORTRESS_S3_ENDPOINT_ALLOWLIST: "minio.corp.example, s3.corp.example",
      }),
    ).toThrow(/not in FORTRESS_S3_ENDPOINT_ALLOWLIST/);
  });

  test("accepts an allowlisted host", () => {
    expect(() =>
      assertS3EndpointSafe("https://minio.corp.example", {
        FORTRESS_S3_ENDPOINT_ALLOWLIST: "minio.corp.example",
      }),
    ).not.toThrow();
  });

  test("accepts a real https endpoint", () => {
    expect(() => assertS3EndpointSafe("https://s3.us-east-1.amazonaws.com", {})).not.toThrow();
  });

  test("opt-out allows a private https endpoint (private MinIO)", () => {
    expect(() =>
      assertS3EndpointSafe("https://10.0.0.5", { FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT: "1" }),
    ).not.toThrow();
  });

  test("opt-out allows a plaintext private endpoint", () => {
    expect(() =>
      assertS3EndpointSafe("http://192.168.1.10:9000", { FORTRESS_S3_ALLOW_PRIVATE_ENDPOINT: "true" }),
    ).not.toThrow();
  });
});
