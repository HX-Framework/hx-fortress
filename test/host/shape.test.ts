import { describe, expect, test } from "bun:test";

import {
  conform,
  describeShape,
  describeShapeLines,
  isIsoInstant,
  LIST_MAX_ITEMS,
  S,
  SHAPE_LEGEND,
  shapeDefect,
  VALUE_MAX_NODES,
  withinShapeLimits,
  type Shape,
} from "../../src/host/shape";

function refusal(shape: Shape, value: unknown) {
  const result = conform(shape, value);
  if (result.ok) throw new Error("expected a refusal");
  return result.issue;
}

function accepted(shape: Shape, value: unknown): unknown {
  const result = conform(shape, value);
  if (!result.ok) throw new Error(`expected acceptance, got ${result.issue.rule}`);
  return result.value;
}

describe("the closed kinds", () => {
  test("a count is a whole number, zero or more, inside its bound", () => {
    expect(accepted(S.count(), 0)).toBe(0);
    expect(accepted(S.count(), 1204)).toBe(1204);
    expect(accepted(S.count(100), 100)).toBe(100);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "3", null, true]) {
      expect(refusal(S.count(), bad).rule).toBe("not_a_count");
    }
    expect(refusal(S.count(100), 101).rule).toBe("count_too_large");
  });

  test("a flag is a boolean and nothing that merely reads as one", () => {
    expect(accepted(S.flag, false)).toBe(false);
    for (const bad of [0, 1, "true", null, undefined]) {
      expect(refusal(S.flag, bad).rule).toBe("not_a_flag");
    }
  });

  test("a state is one of its listed words", () => {
    const shape = S.state("waiting", "installed");
    expect(accepted(shape, "waiting")).toBe("waiting");
    expect(refusal(shape, "WAITING").rule).toBe("not_a_state");
    expect(refusal(shape, "refused").rule).toBe("not_a_state");
    expect(refusal(shape, 1).rule).toBe("not_a_state");
  });

  test("a time is exactly what Date#toISOString writes, and a real instant", () => {
    expect(accepted(S.time, "2027-03-14T09:12:00.000Z")).toBe("2027-03-14T09:12:00.000Z");
    expect(accepted(S.time, "2027-03-14T09:12:00Z")).toBe("2027-03-14T09:12:00Z");
    for (const bad of [
      "2027-03-14",
      "2027-03-14T09:12:00+02:00",
      "2027-03-14 09:12:00Z",
      "2027-02-30T00:00:00.000Z",
      "2027-13-01T00:00:00.000Z",
      "2027-03-14T25:00:00.000Z",
      "yesterday",
      1794273988869,
      new Date(),
    ]) {
      expect(refusal(S.time, bad).rule).toBe("not_a_time");
    }
    expect(isIsoInstant(new Date().toISOString())).toBe(true);
  });

  test("a name is at most 128 characters from a fixed alphabet", () => {
    expect(accepted(S.name, "North Wing / orders_2027 @ desk-4:1.4")).toBe(
      "North Wing / orders_2027 @ desk-4:1.4",
    );
    expect(accepted(S.name, "")).toBe("");
    expect(accepted(S.name, "a".repeat(128))).toHaveLength(128);
    expect(refusal(S.name, "a".repeat(129)).rule).toBe("name_too_long");
    for (const bad of ["a,b", "line\nbreak", "tab\there", "semi;colon", "quo\"te", "é", "<b>", "50%", "{}"]) {
      expect(refusal(S.name, bad).rule).toBe("not_a_name");
    }
    expect(refusal(S.name, 5).rule).toBe("not_a_name");
  });

  test("an id is one token", () => {
    expect(accepted(S.id, "rel-0123456789abcdef")).toBe("rel-0123456789abcdef");
    expect(accepted(S.id, "1794273988869-ab12cd34-7")).toBe("1794273988869-ab12cd34-7");
    for (const bad of ["", "two words", "a/b", "a@b", null]) {
      expect(refusal(S.id, bad).rule).toBe("not_an_id");
    }
    expect(refusal(S.id, "a".repeat(129)).rule).toBe("id_too_long");
  });

  test("a list is bounded, and every item has the one shape", () => {
    expect(accepted(S.list(S.count()), [1, 2, 3])).toEqual([1, 2, 3]);
    expect(refusal(S.list(S.count(), 2), [1, 2, 3]).rule).toBe("list_too_long");
    expect(refusal(S.list(S.count()), { 0: 1, length: 1 }).rule).toBe("not_a_list");
    expect(refusal(S.list(S.count()), [1, "2"])).toEqual({ path: "[1]", rule: "not_a_count" });
    // A hole is not a value.
    const holed: unknown[] = new Array(3);
    holed[0] = true;
    holed[2] = false;
    expect(refusal(S.list(S.flag), holed)).toEqual({ path: "[1]", rule: "not_a_flag" });
    // The ceiling holds whatever a shape declares.
    const wide = { kind: "list", of: S.flag, max: 10_000 } as Shape;
    expect(refusal(wide, Array.from({ length: LIST_MAX_ITEMS + 1 }, () => true)).rule).toBe(
      "list_too_long",
    );
  });

  test("a record holds exactly its declared fields", () => {
    const shape = S.record({ id: S.id, at: S.time, note: S.name }, ["note"]);
    expect(accepted(shape, { id: "a1", at: "2027-01-01T00:00:00.000Z" })).toEqual({
      id: "a1",
      at: "2027-01-01T00:00:00.000Z",
    });
    expect(refusal(shape, { id: "a1" })).toEqual({ path: "at", rule: "field_missing" });
    expect(refusal(shape, { id: "a1", at: "2027-01-01T00:00:00.000Z", extra: 1 }).rule).toBe(
      "field_unknown",
    );
    // A null is not "absent": there are no nulls in a reply.
    expect(refusal(shape, { id: "a1", at: "2027-01-01T00:00:00.000Z", note: null }).rule).toBe(
      "not_a_name",
    );
    for (const bad of [null, [], "x", 3]) {
      expect(refusal(shape, bad).rule).toBe("not_a_record");
    }
  });
});

describe("a conformed value is rebuilt, not approved", () => {
  const shape = S.record({ ok: S.flag, items: S.list(S.record({ name: S.name })) });

  test("it shares no object with what was passed in", () => {
    const input = { ok: true, items: [{ name: "orders" }] };
    const output = accepted(shape, input) as typeof input;
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect(output.items).not.toBe(input.items);
    expect(output.items[0]).not.toBe(input.items[0]);
  });

  test("a toJSON on the original cannot change what is serialized", () => {
    const input = {
      ok: true,
      items: [],
      toJSON() {
        return { ok: true, items: [], row: "a row value" };
      },
    };
    // toJSON is an own key the shape does not declare, so the value is refused…
    expect(refusal(shape, input).rule).toBe("field_unknown");
    // …and one inherited from a prototype is simply not carried over.
    class Sneaky {
      ok = true;
      items: unknown[] = [];
      toJSON(): unknown {
        return { row: "a row value" };
      }
    }
    expect(JSON.stringify(accepted(shape, new Sneaky()))).toBe('{"ok":true,"items":[]}');
  });

  test("a getter is read once and its result is checked like any value", () => {
    let reads = 0;
    const input = {
      items: [],
      get ok(): unknown {
        reads += 1;
        return reads === 1 ? true : "a row value";
      },
    };
    const output = accepted(shape, input) as { ok: unknown };
    expect(output.ok).toBe(true);
    expect(reads).toBe(1);
    expect(JSON.stringify(output)).not.toContain("row");
  });

  test("a field's name can never reach the new object's prototype", () => {
    // Not a shape a manifest could declare (shapeDefect refuses the name), and
    // still not a way in: the result is a plain object with one own property.
    const hostile = { kind: "record", fields: { ["__proto__"]: S.flag } } as Shape;
    const input = JSON.parse('{"__proto__": true}') as unknown;
    const output = accepted(hostile, input) as object;
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.keys(output)).toEqual(["__proto__"]);
    expect(shapeDefect(hostile)).not.toBeNull();
  });

  test("an issue names where and which rule, never what", () => {
    const secret = "sk-live=0f3a9b, a value that must not be repeated";
    const issue = refusal(shape, { ok: true, items: [{ name: "fine" }, { name: secret }] });
    expect(issue).toEqual({ path: "items[1].name", rule: "not_a_name" });
    expect(JSON.stringify(issue)).not.toContain("sk-live");
    // An undeclared KEY is a string the other side chose too.
    const keyed = refusal(shape, { ok: true, items: [], [secret]: 1 });
    expect(JSON.stringify(keyed)).not.toContain("sk-live");
  });

  test("the whole value has a size, whatever its lists allow", () => {
    const nested = S.list(S.list(S.flag, 500), 500);
    const big = Array.from({ length: 500 }, () => Array.from({ length: 500 }, () => true));
    expect(refusal(nested, big).rule).toBe("value_too_large");
    expect(VALUE_MAX_NODES).toBeLessThan(500 * 500);
  });
});

describe("a value that misbehaves while it is read", () => {
  test("a field that throws is refused as unreadable, and what it threw is dropped", () => {
    const value = {
      get name(): string {
        throw new Error("could not load invoice #4471");
      },
    };
    const result = conform(S.record({ name: S.name }), value);
    expect(result).toEqual({ ok: false, issue: { path: "", rule: "unreadable" } });
    expect(JSON.stringify(result)).not.toContain("4471");
  });

  test("a proxy that throws from any trap is refused the same way", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("no");
        },
        get() {
          throw new Error("no");
        },
      },
    );
    expect(conform(S.record({ ok: S.flag }), hostile)).toMatchObject({ ok: false });
    expect(conform(S.list(S.flag), new Proxy([], { get: () => { throw new Error("no"); } }))).toMatchObject({
      ok: false,
    });
  });

  test("a list is held to the length it had when it was checked", () => {
    // An array that grows each time one of its items is read.
    const growing: unknown[] = ["a"];
    let reads = 0;
    Object.defineProperty(growing, "0", {
      enumerable: true,
      get() {
        reads += 1;
        for (let i = 0; i < 50; i += 1) growing.push("more");
        return "a";
      },
    });
    const result = conform(S.list(S.name, 3), growing);
    expect(result).toEqual({ ok: true, value: ["a"] });
    expect(reads).toBe(1);
    expect(growing.length).toBeGreaterThan(3);
  });
});

describe("the limits every shape shares", () => {
  test("an ordinary value of some shape is inside them", () => {
    expect(withinShapeLimits({})).toBe(true);
    expect(withinShapeLimits({ from: "2027-01-01T00:00:00.000Z", limit: 100, kinds: ["ask", "release"] })).toBe(true);
    expect(withinShapeLimits({ a: { b: { c: { d: { e: { f: "deep" } } } } } })).toBe(true);
    expect(withinShapeLimits(Array.from({ length: LIST_MAX_ITEMS }, () => "x".repeat(128)))).toBe(true);
  });

  test("anything past one of them is outside, and the walk stops there", () => {
    expect(withinShapeLimits({ pad: "x".repeat(129) })).toBe(false);
    expect(withinShapeLimits(Array.from({ length: LIST_MAX_ITEMS + 1 }, () => 1))).toBe(false);
    expect(withinShapeLimits(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${i}`, 1])))).toBe(false);
    expect(withinShapeLimits({ ["k".repeat(65)]: 1 })).toBe(false);
    // Nested past what any shape may declare.
    let deep: unknown = "x";
    for (let i = 0; i < 9; i += 1) deep = { d: deep };
    expect(withinShapeLimits(deep)).toBe(false);
    // More values than one answer may hold, spread so no single list is too long.
    const wide = Array.from({ length: 500 }, () => Array.from({ length: 50 }, () => 1));
    expect(wide.flat().length).toBeGreaterThan(VALUE_MAX_NODES);
    expect(withinShapeLimits(wide)).toBe(false);
  });

  test("a value that fails it would fail every shape, so refusing it early changes no answer", () => {
    const tooLong = { name: "x".repeat(129) };
    expect(withinShapeLimits(tooLong)).toBe(false);
    for (const shape of [S.record({ name: S.name }), S.record({ name: S.id }), S.record({ name: S.time })]) {
      expect(conform(shape, tooLong).ok).toBe(false);
    }
  });
});

describe("a shape as declared", () => {
  test("the builders produce shapes with no defect", () => {
    for (const shape of [
      S.count(),
      S.count(5),
      S.flag,
      S.time,
      S.name,
      S.id,
      S.none,
      S.state("a", "b"),
      S.list(S.name),
      S.record({ a: S.list(S.record({ b: S.count() })) }, ["a"]),
    ]) {
      expect(shapeDefect(shape)).toBeNull();
    }
  });

  test("a kind outside the set is refused", () => {
    for (const bad of [{ kind: "text" }, { kind: "bytes" }, { kind: "any" }, {}, null, "name", []]) {
      expect(shapeDefect(bad)).not.toBeNull();
    }
    expect(shapeDefect({ kind: "text" })).toContain("closed set");
    expect(shapeDefect({ kind: "list", of: { kind: "json" } })).toContain("closed set");
    expect(shapeDefect({ kind: "record", fields: { a: { kind: "string" } } })).toContain("closed set");
  });

  test("bounds and names are held to their ceilings", () => {
    expect(shapeDefect({ kind: "list", of: S.flag, max: 501 })).toContain("between 0 and 500");
    expect(shapeDefect({ kind: "count", max: -1 })).not.toBeNull();
    expect(shapeDefect({ kind: "state", of: [] })).not.toBeNull();
    expect(shapeDefect({ kind: "state", of: ["a", "a"] })).toContain("twice");
    expect(shapeDefect({ kind: "state", of: ["two words"] })).not.toBeNull();
    expect(shapeDefect({ kind: "record", fields: { "bad key": S.flag } })).not.toBeNull();
    expect(shapeDefect({ kind: "record", fields: { a: S.flag }, optional: ["b"] })).toContain(
      "does not declare",
    );
    let deep: unknown = S.flag;
    for (let i = 0; i < 8; i += 1) deep = { kind: "list", of: deep };
    expect(shapeDefect(deep)).toContain("nested deeper");
  });

  test("a shape reads as lines, a field to a line", () => {
    expect(describeShapeLines(S.none)).toEqual(["nothing"]);
    expect(describeShapeLines(S.count(100))).toEqual(["count up to 100"]);
    expect(
      describeShapeLines(
        S.record(
          {
            version: S.name,
            modules: S.list(S.record({ id: S.id, on: S.flag }), 64),
            tags: S.list(S.name, 3),
            decidedAt: S.time,
            inner: S.record({ a: S.count() }),
            empty: S.none,
          },
          ["decidedAt", "modules"],
        ),
      ),
    ).toEqual([
      "version: name",
      "modules (optional): list of up to 64, each:",
      "  id: id",
      "  on: flag",
      "tags: list of up to 3 (name)",
      "decidedAt (optional): time",
      "inner:",
      "  a: count",
      "empty: nothing",
    ]);
    // Every field of every shape is on a line of its own: nothing is elided.
    expect(SHAPE_LEGEND.join(" ")).toContain("No ask takes free text or bytes");
  });

  test("a shape reads as plain words", () => {
    expect(describeShape(S.none)).toBe("nothing");
    expect(describeShape(S.record({ from: S.time, limit: S.count(100), kind: S.state("a", "b") }, ["kind"]))).toBe(
      "{ from: time, limit: count up to 100, kind?: one of a | b }",
    );
    expect(describeShape(S.list(S.name, 3))).toBe("list of up to 3 (name)");
  });
});
