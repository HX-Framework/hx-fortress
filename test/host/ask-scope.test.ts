import { describe, expect, test } from "bun:test";

import { askScopeHash, askSubject, canonicalJson } from "../../src/host/ask-scope";

// The control plane carries the same function. These vectors are the contract
// between the two: if either side changes its canonical form, one of them stops
// matching here or there, before a single grant is refused in the field.
const VECTORS = [
  {
    scope: { module: "host", ask: "status", args: {} },
    canonical: '{"args":{},"ask":"status","module":"host"}',
    hash: "bjyQUZKJovDOs3NT2VtskemwJKOUF6k9GPJ7ISW-2nQ",
  },
  {
    scope: {
      module: "host",
      ask: "audit.read",
      args: { to: "2027-01-02T00:00:00.000Z", limit: 100, from: "2027-01-01T00:00:00.000Z" },
    },
    canonical:
      '{"args":{"from":"2027-01-01T00:00:00.000Z","limit":100,"to":"2027-01-02T00:00:00.000Z"},"ask":"audit.read","module":"host"}',
    hash: "E7exRmgOS9KFWvlElqa1jNCX1N-ha6N1tBK8cAqtFoA",
  },
  {
    scope: {
      module: "stores",
      ask: "store.count",
      args: { b: [{ z: 1, a: true }], a: 'café "q" \\ /', n: 0 },
    },
    canonical:
      '{"args":{"a":"café \\"q\\" \\\\ /","b":[{"a":true,"z":1}],"n":0},"ask":"store.count","module":"stores"}',
    hash: "LThXPQ-L2AjcXKn_gQo4ke3NJRgWHN24d21BL7L-_Io",
  },
];

describe("the scope hash of an ask", () => {
  test.each(VECTORS)("matches the shared vector for $scope.module:$scope.ask", (vector) => {
    expect(canonicalJson(vector.scope)).toBe(vector.canonical);
    expect(askScopeHash(vector.scope)).toBe(vector.hash);
  });

  test("does not depend on the order keys were written in", () => {
    const a = askScopeHash({ module: "host", ask: "audit.read", args: { from: "x", to: "y", limit: 5 } });
    const b = askScopeHash({ module: "host", ask: "audit.read", args: { limit: 5, to: "y", from: "x" } });
    expect(a).toBe(b);
  });

  test("survives the trip over the wire", () => {
    const args = { from: "2027-01-01T00:00:00.000Z", nested: { b: [1, 2, { c: false }], a: -0 } };
    const arrived = JSON.parse(JSON.stringify(args)) as typeof args;
    expect(askScopeHash({ module: "m", ask: "a", args: arrived })).toBe(
      askScopeHash({ module: "m", ask: "a", args }),
    );
  });

  test("changes when the module, the ask or any argument changes", () => {
    const base = { module: "host", ask: "audit.read", args: { from: "a", to: "b", limit: 5 } };
    const hashes = new Set([
      askScopeHash(base),
      askScopeHash({ ...base, module: "stores" }),
      askScopeHash({ ...base, ask: "audit.count" }),
      askScopeHash({ ...base, args: { ...base.args, limit: 6 } }),
      askScopeHash({ ...base, args: { ...base.args, extra: true } }),
      askScopeHash({ ...base, args: { from: "a", to: "b" } }),
    ]);
    expect(hashes.size).toBe(6);
  });

  test("an argument that is undefined is the same as one left out", () => {
    expect(askScopeHash({ module: "m", ask: "a", args: { x: 1, y: undefined } })).toBe(
      askScopeHash({ module: "m", ask: "a", args: { x: 1 } }),
    );
  });

  test("refuses what is not plain JSON rather than guessing its bytes", () => {
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(/plain object/);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/finite/);
    expect(() => canonicalJson({ big: 1n })).toThrow(/not JSON/);
    expect(() => canonicalJson(() => 1)).toThrow(/not JSON/);
  });

  test("the subject names the module and the ask", () => {
    expect(askSubject("host", "audit.read")).toBe("host:audit.read");
  });
});
