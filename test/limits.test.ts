import { describe, expect, test } from "bun:test";

import { maxCanonicalBytes, maxRepairBytes } from "../src/modules/session-vault/store/limits";

const MiB = 1024 * 1024;
const GiB = 1024 * 1024 * 1024;

describe("maxCanonicalBytes (detection / live cap)", () => {
  test("defaults to 128 MiB", () => {
    expect(maxCanonicalBytes({})).toBe(128 * MiB);
  });

  test("env override wins; set-but-garbage/0/negative fall back to the default", () => {
    expect(maxCanonicalBytes({ FORTRESS_MAX_CANONICAL_BYTES: String(64 * MiB) })).toBe(64 * MiB);
    expect(maxCanonicalBytes({ FORTRESS_MAX_CANONICAL_BYTES: "" })).toBe(128 * MiB);
    expect(maxCanonicalBytes({ FORTRESS_MAX_CANONICAL_BYTES: "nope" })).toBe(128 * MiB);
    expect(maxCanonicalBytes({ FORTRESS_MAX_CANONICAL_BYTES: "0" })).toBe(128 * MiB);
    expect(maxCanonicalBytes({ FORTRESS_MAX_CANONICAL_BYTES: "-1" })).toBe(128 * MiB);
  });
});

describe("maxRepairBytes (guarantor repair cap — the LETAIR cap-raise)", () => {
  test("defaults to 1 GiB, so the guarantor heals the 155/304/453 MB sessions the 128 MiB bound refused", () => {
    expect(maxRepairBytes({})).toBe(GiB);
  });

  test("env override wins; set-but-garbage/0/negative fall back to the 1 GiB default", () => {
    expect(maxRepairBytes({ FORTRESS_MAX_REPAIR_BYTES: String(2 * GiB) })).toBe(2 * GiB);
    expect(maxRepairBytes({ FORTRESS_MAX_REPAIR_BYTES: "" })).toBe(GiB);
    expect(maxRepairBytes({ FORTRESS_MAX_REPAIR_BYTES: "nope" })).toBe(GiB);
    expect(maxRepairBytes({ FORTRESS_MAX_REPAIR_BYTES: "0" })).toBe(GiB);
    expect(maxRepairBytes({ FORTRESS_MAX_REPAIR_BYTES: "-1" })).toBe(GiB);
  });

  test("a memory-constrained fortress may LOWER the repair cap below the 1 GiB default", () => {
    // The RAM note: a constrained self-host sets this to ~(spare RAM ÷ 8).
    expect(maxRepairBytes({ FORTRESS_MAX_REPAIR_BYTES: String(256 * MiB) })).toBe(256 * MiB);
  });

  test("INVARIANT: repair is never LOWER than detection — it is the looser bound", () => {
    // Repair reads a canonical detection can only stat, so it must be >= detection
    // at all times. The old code guaranteed this by returning maxCanonicalBytes(env)
    // as the fallback; the raised default keeps it via Math.max.
    // Default vs default: 1 GiB >= 128 MiB.
    expect(maxRepairBytes({})).toBeGreaterThanOrEqual(maxCanonicalBytes({}));

    // An operator who raises DETECTION above the 1 GiB repair floor (without
    // setting a repair override) must not create a detectable-but-unhealable band:
    // repair follows detection UP.
    const env = { FORTRESS_MAX_CANONICAL_BYTES: String(4 * GiB) };
    expect(maxCanonicalBytes(env)).toBe(4 * GiB);
    expect(maxRepairBytes(env)).toBe(4 * GiB);
    expect(maxRepairBytes(env)).toBeGreaterThanOrEqual(maxCanonicalBytes(env));
  });

  test("an explicit repair override BELOW a raised detection cap is honored (operator's deliberate RAM choice)", () => {
    // The floor only fills in the ABSENCE of an override. If the operator both
    // raises detection AND explicitly sets a smaller repair cap, that is a
    // conscious memory decision (detection stays cheap; repair is the spike) and
    // is respected as-is — the explicit value is not clamped up.
    const env = {
      FORTRESS_MAX_CANONICAL_BYTES: String(4 * GiB),
      FORTRESS_MAX_REPAIR_BYTES: String(512 * MiB),
    };
    expect(maxRepairBytes(env)).toBe(512 * MiB);
  });
});
