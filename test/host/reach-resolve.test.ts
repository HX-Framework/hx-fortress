// Where a host that a person added really leads, at the moment a program is
// to be sent there.

import { describe, expect, test } from "bun:test";

import {
  REACH_RESOLVE_MAX_ADDRESSES,
  resolveReach,
  type ReachLookup,
} from "../../src/host/reach-resolve";

/** A resolver that answers these addresses for every name, and says which
 *  names it was asked. */
function answering(addresses: readonly string[]): { lookup: ReachLookup; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    lookup: async (name) => {
      asked.push(name);
      return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
  };
}

const NAME = "db.northstar.example";

describe("a host that is an address", () => {
  test("is that address, and nothing is looked up", async () => {
    for (const address of ["203.0.113.7", "10.4.0.9", "2001:db8::7", "fd12:3456:789a::5"]) {
      const { lookup, asked } = answering(["198.51.100.1"]);
      expect([address, await resolveReach(address, { lookup })]).toEqual([address, { ok: true, address }]);
      expect(asked).toEqual([]);
    }
  });

  test("is judged again by the rule for a host: a list on the disk can be older than the rule", async () => {
    for (const address of ["127.0.0.1", "169.254.169.254", "0.0.0.0", "::1", "fe80::1", "224.0.0.1", "168.63.129.16"]) {
      const { lookup, asked } = answering(["198.51.100.1"]);
      expect([address, await resolveReach(address, { lookup })]).toEqual([
        address,
        { ok: false, code: "reach_address_refused" },
      ]);
      expect(asked).toEqual([]);
    }
  });
});

describe("a host that is a name", () => {
  test("is looked up, and the program is given the address", async () => {
    const { lookup, asked } = answering(["203.0.113.7"]);
    expect(await resolveReach(NAME, { lookup })).toEqual({ ok: true, address: "203.0.113.7" });
    expect(asked).toEqual([NAME]);
  });

  test("with an IPv4 address among its addresses, the first of those is the one that is used", async () => {
    expect(await resolveReach(NAME, answering(["2001:db8::7", "203.0.113.7", "203.0.113.8"]))).toEqual({
      ok: true,
      address: "203.0.113.7",
    });
    // With none, its first address.
    expect(await resolveReach(NAME, answering(["2001:db8::7", "2001:db8::8"]))).toEqual({
      ok: true,
      address: "2001:db8::7",
    });
  });

  test("that leads to this machine, a link-local address or a cloud's metadata address is refused", async () => {
    for (const address of [
      "127.0.0.1",
      "127.8.8.8",
      "::1",
      "169.254.169.254",
      "169.254.10.10",
      "fe80::1",
      "0.0.0.0",
      "224.0.0.251",
      "255.255.255.255",
      "168.63.129.16",
      "100.100.100.200",
      "fd00:ec2::254",
      "::ffff:127.0.0.1",
      "64:ff9b::7f00:1",
    ]) {
      expect([address, await resolveReach(NAME, answering([address]))]).toEqual([
        address,
        { ok: false, code: "reach_address_refused" },
      ]);
    }
  });

  test("is refused whole when one of its addresses is refused, wherever it stands", async () => {
    for (const addresses of [
      ["203.0.113.7", "127.0.0.1"],
      ["127.0.0.1", "203.0.113.7"],
      ["203.0.113.7", "2001:db8::7", "169.254.169.254"],
      ["2001:db8::7", "::1"],
    ]) {
      expect([addresses, await resolveReach(NAME, answering(addresses))]).toEqual([
        addresses,
        { ok: false, code: "reach_address_refused" },
      ]);
    }
  });

  test("a private address is taken: a database is usually at one", async () => {
    for (const address of ["10.4.0.9", "172.16.3.4", "192.168.1.20", "fd12:3456:789a::5"]) {
      expect([address, await resolveReach(NAME, answering([address]))]).toEqual([address, { ok: true, address }]);
    }
  });

  test("that is not found, or whose look-up fails, is unresolved, and nothing of the failure is kept", async () => {
    const failing: ReachLookup = async (name) => {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" });
    };
    expect(await resolveReach(NAME, { lookup: failing })).toEqual({ ok: false, code: "reach_unresolved" });
    expect(await resolveReach(NAME, answering([]))).toEqual({ ok: false, code: "reach_unresolved" });
  });

  test("whose look-up takes too long is unresolved", async () => {
    const never: ReachLookup = () => new Promise(() => {});
    const started = Date.now();
    expect(await resolveReach(NAME, { lookup: never, timeoutMs: 60 })).toEqual({ ok: false, code: "reach_unresolved" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("an answer that is no address is no answer: a name is never handed on in an address's place", async () => {
    for (const answer of [
      [{ address: "other.northstar.example", family: 4 }],
      [{ address: "", family: 4 }],
      [{ address: 7, family: 4 }],
      [{ family: 4 }],
      [null],
      ["203.0.113.7"],
      [{ address: "203.0.113.7", family: 4 }, { address: "localhost", family: 4 }],
      [{ address: "[2001:db8::7]", family: 6 }],
      [{ address: "203.0.113.7:5432", family: 4 }],
    ]) {
      const lookup = (async () => answer) as unknown as ReachLookup;
      expect([answer, await resolveReach(NAME, { lookup })]).toEqual([answer, { ok: false, code: "reach_unresolved" }]);
    }
    for (const answer of [null, undefined, "203.0.113.7", { address: "203.0.113.7" }, 7]) {
      const lookup = (async () => answer) as unknown as ReachLookup;
      expect([answer, await resolveReach(NAME, { lookup })]).toEqual([answer, { ok: false, code: "reach_unresolved" }]);
    }
  });

  test("with more addresses than are looked at is unresolved", async () => {
    const many = Array.from({ length: REACH_RESOLVE_MAX_ADDRESSES + 1 }, (_, i) => `203.0.113.${i + 1}`);
    expect(await resolveReach(NAME, answering(many))).toEqual({ ok: false, code: "reach_unresolved" });
    expect(await resolveReach(NAME, answering(many.slice(1)))).toEqual({ ok: true, address: "203.0.113.2" });
  });

  test("that means this machine, or a cloud's metadata service, is refused before anything is looked up", async () => {
    for (const name of ["localhost", "db.localhost", "metadata.google.internal", "metadata", "ip6-loopback"]) {
      const { lookup, asked } = answering(["203.0.113.7"]);
      expect([name, await resolveReach(name, { lookup })]).toEqual([name, { ok: false, code: "reach_address_refused" }]);
      expect(asked).toEqual([]);
    }
  });
});

describe("what is not a host", () => {
  test("is refused, and nothing is looked up", async () => {
    for (const host of ["", "db northstar", "http://db.northstar.example", "db.northstar.example:5432", "[::1]"]) {
      const { lookup, asked } = answering(["203.0.113.7"]);
      const answer = await resolveReach(host, { lookup });
      expect([host, answer.ok]).toEqual([host, false]);
      expect(asked).toEqual([]);
    }
  });
});
