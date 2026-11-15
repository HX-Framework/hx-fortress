// Which hosts a reach may name: a host and a port that a person adds to a
// module, for a helper program to be sent to.

import { describe, expect, test } from "bun:test";

import {
  ipv4Octets,
  ipv6Groups,
  isReachPort,
  REACH_HOST_MAX_CHARS,
  reachHostRefusal,
} from "../../src/host/reach-address";

describe("a host a reach may name", () => {
  test("a DNS name, a private address and a public address are taken", () => {
    for (const host of [
      "db.northstar.example",
      "DB.Northstar.Example",
      "db.northstar.example.",
      "sql_01.internal",
      "db",
      "10.0.4.17",
      "172.16.0.9",
      "192.168.1.20",
      "100.64.0.5",
      "8.8.8.8",
      "2001:db8::17",
      "fd12:3456:789a::5",
      "::ffff:10.0.4.17",
      "64:ff9b::a00:411",
    ]) {
      expect([host, reachHostRefusal(host)]).toEqual([host, null]);
    }
  });

  test("an address that means this machine, the link or a group of machines is refused", () => {
    for (const host of [
      "127.0.0.1",
      "127.8.9.10",
      "0.0.0.0",
      "0.1.2.3",
      "169.254.169.254",
      "169.254.0.1",
      "224.0.0.1",
      "239.255.255.250",
      "240.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "fe80::1",
      "febf::1",
      "ff02::1",
      // A cloud's metadata address over IPv6, in a range that is taken otherwise.
      "fd00:ec2::254",
      "FD00:EC2::254",
      "fd20:ce::254",
    ]) {
      expect([host, reachHostRefusal(host)]).toEqual([host, "reach_address_refused"]);
    }
  });

  test("a refused IPv4 address written inside an IPv6 one is refused too", () => {
    for (const host of [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::127.0.0.1",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe",
      "::ffff:0:127.0.0.1",
      "64:ff9b::127.0.0.1",
      "64:ff9b::a9fe:a9fe",
      "2002:7f00:1::",
      "2002:a9fe:a9fe::1",
    ]) {
      expect([host, reachHostRefusal(host)]).toEqual([host, "reach_address_refused"]);
    }
  });

  test("a name that means this machine, or a cloud's metadata, is refused", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "localhost.",
      "db.localhost",
      "localhost.localdomain",
      "localhost6",
      "ip6-localhost",
      "ip6-loopback",
      "metadata",
      "metadata.google.internal",
      "Metadata.Google.Internal.",
      "metadata.azure.internal",
      "instance-data",
      "instance-data.ec2.internal",
    ]) {
      expect([host, reachHostRefusal(host)]).toEqual([host, "reach_address_refused"]);
    }
  });

  test("a text that is not a host is refused, and so is every loose spelling of an address", () => {
    for (const host of [
      "",
      " ",
      "db northstar",
      "db.northstar.example:5432",
      "http://db.northstar.example",
      "user@db.northstar.example",
      "db.northstar.example/path",
      "*.northstar.example",
      "-db.northstar.example",
      "db-.northstar.example",
      "db..northstar.example",
      ".northstar.example",
      "db.northstar.example..",
      // One large number, a short form, hex and octal: anything that reads a
      // host loosely takes these for 127.0.0.1.
      "2130706433",
      "127.1",
      "0x7f.0.0.1",
      "0x7f000001",
      "0177.0.0.1",
      "127.0.0.01",
      "256.1.1.1",
      "1.2.3",
      "1.2.3.4.5",
      "[::1]",
      "[2001:db8::17]",
      "fe80::1%eth0",
      "2001:db8:::17",
      "2001:db8::17::1",
      "1:2:3:4:5:6:7:8:9",
      "1:2:3:4:5:6:7",
      "gggg::1",
      "::ffff:999.0.0.1",
      "a".repeat(64) + ".example",
      "a".repeat(REACH_HOST_MAX_CHARS + 1),
    ]) {
      expect([host, reachHostRefusal(host)]).toEqual([host, "reach_host_invalid"]);
    }
    for (const notText of [null, undefined, 5432, {}, ["db"]]) {
      expect(reachHostRefusal(notText)).toBe("reach_host_invalid");
    }
  });

  test("a host of the longest length is taken, and one character more is not", () => {
    // Four labels and three dots: 128 characters.
    const longest = [31, 31, 31, 32].map((length) => "a".repeat(length)).join(".");
    expect(longest.length).toBe(REACH_HOST_MAX_CHARS);
    expect(reachHostRefusal(longest)).toBeNull();
    expect(reachHostRefusal(`${longest}a`)).toBe("reach_host_invalid");
  });
});

describe("the two readers of an address", () => {
  test("an IPv4 address is four decimal numbers and nothing else", () => {
    expect(ipv4Octets("10.0.4.17")).toEqual([10, 0, 4, 17]);
    expect(ipv4Octets("0.0.0.0")).toEqual([0, 0, 0, 0]);
    for (const text of ["10.0.4", "10.0.4.17.1", "10.0.4.017", "10.0.4.256", "10.0.4.", "a.b.c.d", "1e1.0.0.1", "+1.0.0.1"]) {
      expect([text, ipv4Octets(text)]).toEqual([text, null]);
    }
  });

  test("an IPv6 address is read to its eight groups", () => {
    expect(ipv6Groups("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(ipv6Groups("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Groups("2001:db8::17")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0x17]);
    expect(ipv6Groups("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ipv6Groups("::ffff:10.0.4.17")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0411]);
    expect(ipv6Groups("1:2:3:4:5:6:7::")).toEqual([1, 2, 3, 4, 5, 6, 7, 0]);
    for (const text of ["", "1", "1:2", "1::2::3", "12345::1", "1:2:3:4:5:6:7:8::", "::1.2.3"]) {
      expect([text, ipv6Groups(text)]).toEqual([text, null]);
    }
  });
});

describe("a port a reach may name", () => {
  test("1 to 65535, as a whole number", () => {
    for (const port of [1, 22, 1433, 5432, 65_535]) expect([port, isReachPort(port)]).toEqual([port, true]);
    for (const port of [0, -1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5432", null, undefined]) {
      expect([port, isReachPort(port)]).toEqual([port, false]);
    }
  });
});
