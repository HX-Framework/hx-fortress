// The code of the second step, checked against the published values of the
// RFCs it follows, and the ticket table that holds a sign-in between its
// password and its code.

import { describe, expect, test } from "bun:test";

import {
  CEILING_CLOSED_MS,
  CEILING_WINDOW_MS,
  CEILING_WRONG_CODES,
  CodeCeiling,
  SecondStepTickets,
  TICKET_TTL_MS,
  TICKET_WRONG_CODES,
} from "../src/ui/second-step";
import {
  base32Decode,
  base32Encode,
  checkCode,
  hotp,
  newSecret,
  otpauthUri,
  stepAt,
} from "../src/ui/totp";

/** The key of RFC 4226 Appendix D and RFC 6238 Appendix B (SHA1). */
const RFC_KEY = Buffer.from("12345678901234567890", "ascii");
const RFC_SECRET = ["GEZDGNBVGY3TQOJQ", "GEZDGNBVGY3TQOJQ"].join("");

describe("base32 (RFC 4648)", () => {
  test("encodes the RFC's test vectors, without padding", () => {
    const vectors: Array<[string, string]> = [
      ["", ""],
      ["f", "MY"],
      ["fo", "MZXQ"],
      ["foo", "MZXW6"],
      ["foob", "MZXW6YQ"],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI"],
    ];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain, "ascii"))).toBe(encoded);
      expect(base32Decode(encoded)?.toString("ascii")).toBe(plain);
    }
  });

  test("decodes with or without padding, and refuses what is not base32", () => {
    expect(base32Decode("MZXW6YTBOI======")?.toString("ascii")).toBe("foobar");
    expect(base32Encode(RFC_KEY)).toBe(RFC_SECRET);
    expect(base32Decode("mzxw6ytboi")).toBeNull();
    expect(base32Decode("MZXW6YTBO1")).toBeNull();
    expect(base32Decode("MZXW 6YTB")).toBeNull();
  });

  test("a new secret is 20 random bytes in 32 characters", () => {
    const a = newSecret();
    const b = newSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(a)?.length).toBe(20);
    expect(a).not.toBe(b);
  });
});

describe("the code (RFC 4226 and RFC 6238)", () => {
  test("HOTP matches RFC 4226 Appendix D for counters 0 to 9", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, counter) => expect(hotp(RFC_KEY, counter)).toBe(code));
  });

  test("TOTP matches RFC 6238 Appendix B (SHA1), cut to six digits", () => {
    const vectors: Array<[number, string]> = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [seconds, eight] of vectors) {
      const code = eight.slice(-6);
      expect(hotp(RFC_KEY, stepAt(seconds * 1000))).toBe(code);
      expect(checkCode({ secret: RFC_SECRET, code, nowMs: seconds * 1000, lastStep: null })).toEqual({
        ok: true,
        step: Math.floor(seconds / 30),
      });
    }
  });

  test("the step before and the step after are accepted, two steps away is refused", () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    const code = (offset: number): string => hotp(RFC_KEY, step + offset);
    for (const offset of [-1, 0, 1]) {
      expect(checkCode({ secret: RFC_SECRET, code: code(offset), nowMs: now, lastStep: null })).toEqual({
        ok: true,
        step: step + offset,
      });
    }
    for (const offset of [-2, 2, -3, 3]) {
      expect(checkCode({ secret: RFC_SECRET, code: code(offset), nowMs: now, lastStep: null }).ok).toBe(false);
    }
  });

  test("the last accepted step, and every earlier one, is refused", () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    const current = hotp(RFC_KEY, step);
    expect(checkCode({ secret: RFC_SECRET, code: current, nowMs: now, lastStep: step }).ok).toBe(false);
    expect(checkCode({ secret: RFC_SECRET, code: current, nowMs: now, lastStep: step + 1 }).ok).toBe(false);
    expect(checkCode({ secret: RFC_SECRET, code: current, nowMs: now, lastStep: step - 1 })).toEqual({ ok: true, step });
    // The step before the current one is inside the window, and still refused
    // once the current one was spent.
    expect(checkCode({ secret: RFC_SECRET, code: hotp(RFC_KEY, step - 1), nowMs: now, lastStep: step }).ok).toBe(false);
    expect(checkCode({ secret: RFC_SECRET, code: hotp(RFC_KEY, step + 1), nowMs: now, lastStep: step })).toEqual({
      ok: true,
      step: step + 1,
    });
  });

  test("anything that is not six ASCII digits is refused", () => {
    const now = 1_700_000_000_000;
    const right = hotp(RFC_KEY, stepAt(now));
    for (const code of ["", right.slice(1), `${right}0`, ` ${right}`, `${right.slice(0, 3)} ${right.slice(3)}`, "abcdef", "١٢٣٤٥٦", "12345\n"]) {
      expect(checkCode({ secret: RFC_SECRET, code, nowMs: now, lastStep: null }).ok).toBe(false);
    }
  });

  test("a damaged secret refuses every code, and never throws", () => {
    const now = 1_700_000_000_000;
    const right = hotp(RFC_KEY, stepAt(now));
    for (const secret of ["", "not base32!", "GEZDGNBV", "gezdgnbvgy3tqojqgezdgnbvgy3tqojq"]) {
      expect(checkCode({ secret, code: right, nowMs: now, lastStep: null }).ok).toBe(false);
    }
    expect(checkCode({ secret: RFC_SECRET, code: right, nowMs: Number.NaN, lastStep: null }).ok).toBe(false);
  });

  test("the address an authenticator app reads", () => {
    expect(otpauthUri("marta.lindqvist", RFC_SECRET)).toBe(
      `otpauth://totp/HX%20Fortress:marta.lindqvist?secret=${RFC_SECRET}` +
        "&issuer=HX%20Fortress&algorithm=SHA1&digits=6&period=30",
    );
  });
});

describe("the ticket table", () => {
  const record = (now: number, setupDigest: string | null = null) => ({
    kind: setupDigest === null ? ("code" as const) : ("setup" as const),
    login: "marta",
    remoteKey: "203.0.113.5",
    controlPlaneSub: null,
    credentialEpoch: 0,
    pwdVersion: 1,
    lockoutEpoch: 0,
    secret: null,
    setupDigest,
    pwdHash: null,
    createdAt: now,
  });

  test("a ticket is 32 random bytes, kept by its digest only", () => {
    const tickets = new SecondStepTickets();
    const ticket = tickets.issue(record(1_000));
    expect(ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(tickets.find(ticket, "203.0.113.5", 1_000)?.record.login).toBe("marta");
    expect(JSON.stringify([...(tickets as unknown as { byDigest: Map<string, unknown> }).byDigest.keys()])).not.toContain(ticket);
    expect(tickets.issue(record(1_000))).not.toBe(ticket);
  });

  test("a ticket from another network is refused, and still works on its own", () => {
    const tickets = new SecondStepTickets();
    const ticket = tickets.issue(record(1_000));
    expect(tickets.find(ticket, "198.51.100.7", 1_000)).toBeNull();
    expect(tickets.find(ticket, "203.0.113.5", 1_000)).not.toBeNull();
  });

  test("a ticket lasts five minutes", () => {
    const tickets = new SecondStepTickets();
    const ticket = tickets.issue(record(1_000));
    expect(tickets.find(ticket, "203.0.113.5", 1_000 + TICKET_TTL_MS - 1)).not.toBeNull();
    expect(tickets.find(ticket, "203.0.113.5", 1_000 + TICKET_TTL_MS)).toBeNull();
    expect(tickets.size).toBe(0);
  });

  test("five wrong codes void it", () => {
    const tickets = new SecondStepTickets();
    const ticket = tickets.issue(record(1_000));
    for (let i = 1; i < TICKET_WRONG_CODES; i += 1) {
      const held = tickets.find(ticket, "203.0.113.5", 1_000);
      expect(held).not.toBeNull();
      expect(tickets.wrong(held!)).toBe(false);
    }
    const last = tickets.find(ticket, "203.0.113.5", 1_000);
    expect(tickets.wrong(last!)).toBe(true);
    expect(tickets.find(ticket, "203.0.113.5", 1_000)).toBeNull();
  });

  test("anything not shaped like a ticket finds nothing", () => {
    const tickets = new SecondStepTickets();
    tickets.issue(record(1_000));
    for (const presented of [undefined, null, 42, "", "x".repeat(64), "A".repeat(64), {}]) {
      expect(tickets.find(presented, "203.0.113.5", 1_000)).toBeNull();
    }
  });

  test("a ticket is claimed once: the first caller has it, every later one finds it gone", () => {
    const tickets = new SecondStepTickets();
    const ticket = tickets.issue(record(1_000));
    const first = tickets.find(ticket, "203.0.113.5", 1_000);
    const second = tickets.find(ticket, "203.0.113.5", 1_000);
    expect(tickets.claim(first!)).toBe(true);
    // Found before the claim, and still refused after it.
    expect(tickets.claim(second!)).toBe(false);
    expect(tickets.find(ticket, "203.0.113.5", 1_000)).toBeNull();
  });

  test("a newer setup of the same link replaces the older one", () => {
    const tickets = new SecondStepTickets();
    const older = tickets.issue(record(1_000, "a".repeat(64)));
    const other = tickets.issue(record(1_000, "b".repeat(64)));
    const newer = tickets.issue(record(1_000, "a".repeat(64)));
    expect(tickets.find(older, "203.0.113.5", 1_000)).toBeNull();
    expect(tickets.find(newer, "203.0.113.5", 1_000)).not.toBeNull();
    expect(tickets.find(other, "203.0.113.5", 1_000)).not.toBeNull();
  });

  test("the sweep drops what has expired and keeps what has not", () => {
    const tickets = new SecondStepTickets();
    tickets.issue(record(1_000));
    const fresh = tickets.issue(record(1_000 + TICKET_TTL_MS - 1));
    expect(tickets.size).toBe(2);
    expect(tickets.sweep(1_000 + TICKET_TTL_MS)).toBe(1);
    expect(tickets.find(fresh, "203.0.113.5", 1_000 + TICKET_TTL_MS)).not.toBeNull();
  });
});

describe("the ceiling on wrong codes for one account", () => {
  test(`${CEILING_WRONG_CODES} wrong codes inside the window close it for its time, and then it opens`, () => {
    const ceiling = new CodeCeiling();
    for (let i = 0; i < CEILING_WRONG_CODES - 1; i += 1) expect(ceiling.wrong("marta", 0, 1_000 + i)).toBe(false);
    expect(ceiling.closedFor("marta", 0, 2_000)).toBe(0);
    expect(ceiling.wrong("marta", 0, 2_000)).toBe(true);
    expect(ceiling.closedFor("marta", 0, 2_000)).toBe(CEILING_CLOSED_MS);
    expect(ceiling.closedFor("erik", 0, 2_000)).toBe(0);
    expect(ceiling.closedFor("marta", 0, 2_000 + CEILING_CLOSED_MS - 1)).toBe(1);
    expect(ceiling.closedFor("marta", 0, 2_000 + CEILING_CLOSED_MS)).toBe(0);
  });

  test("wrong codes older than the window do not add up", () => {
    const ceiling = new CodeCeiling();
    for (let i = 0; i < CEILING_WRONG_CODES - 1; i += 1) ceiling.wrong("marta", 0, 1_000);
    ceiling.wrong("marta", 0, 1_000 + CEILING_WINDOW_MS);
    expect(ceiling.closedFor("marta", 0, 1_000 + CEILING_WINDOW_MS)).toBe(0);
  });

  test("the sweep forgets what has aged out, and keeps one record per account", () => {
    const ceiling = new CodeCeiling();
    ceiling.wrong("marta", 0, 1_000);
    ceiling.wrong("erik", 0, 1_000);
    expect(ceiling.size).toBe(2);
    ceiling.sweep(1_000 + CEILING_WINDOW_MS);
    expect(ceiling.size).toBe(0);
    for (let i = 0; i < CEILING_WRONG_CODES - 1; i += 1) ceiling.wrong("marta", 0, 2_000 + CEILING_WINDOW_MS);
    expect(ceiling.closedFor("marta", 0, 2_000 + CEILING_WINDOW_MS)).toBe(0);
    // However many wrong codes, the record holds a few numbers.
    for (let i = 0; i < 1_000; i += 1) ceiling.wrong("erik", 0, 3_000 + CEILING_WINDOW_MS);
    const held = ceiling.snapshot(3_000 + CEILING_WINDOW_MS);
    expect(held).toHaveLength(2);
    expect(held.every(([, record]) => record.wrongAt.length <= CEILING_WRONG_CODES)).toBe(true);
  });

  test("a reset raises the lockout epoch, and that reopens it; nothing else does", () => {
    const ceiling = new CodeCeiling();
    for (let i = 0; i < CEILING_WRONG_CODES; i += 1) ceiling.wrong("marta", 3, 1_000);
    expect(ceiling.closedFor("marta", 3, 1_000)).toBe(CEILING_CLOSED_MS);
    // Asked about the same epoch, from anywhere, it stays closed.
    expect(ceiling.closedFor("marta", 3, 2_000)).toBeGreaterThan(0);
    // The epoch after a reset counts from nothing.
    expect(ceiling.closedFor("marta", 4, 2_000)).toBe(0);
    // ...and the record of the earlier epoch is gone, so asking with it again
    // finds nothing to close.
    expect(ceiling.closedFor("marta", 3, 2_000)).toBe(0);
    // A record counted under a later epoch than the one asked about still
    // counts: an account file that went backwards does not reopen it.
    for (let i = 0; i < CEILING_WRONG_CODES; i += 1) ceiling.wrong("erik", 5, 1_000);
    expect(ceiling.closedFor("erik", 4, 2_000)).toBeGreaterThan(0);
  });

  test("a snapshot is read back after a restart, and a damaged one is skipped entry by entry", () => {
    const ceiling = new CodeCeiling();
    for (let i = 0; i < CEILING_WRONG_CODES; i += 1) ceiling.wrong("marta", 1, 1_000);
    ceiling.wrong("erik", 0, 1_000);
    const saved = JSON.parse(JSON.stringify(ceiling.snapshot(1_000))) as unknown;

    const restarted = new CodeCeiling();
    restarted.hydrate(saved, 2_000);
    expect(restarted.closedFor("marta", 1, 2_000)).toBe(CEILING_CLOSED_MS - 1_000);
    for (let i = 0; i < CEILING_WRONG_CODES - 2; i += 1) restarted.wrong("erik", 0, 2_000);
    expect(restarted.closedFor("erik", 0, 2_000)).toBe(0);
    restarted.wrong("erik", 0, 2_000);
    expect(restarted.closedFor("erik", 0, 2_000)).toBe(CEILING_CLOSED_MS);

    const damaged = new CodeCeiling();
    damaged.hydrate(
      [
        ["marta", { epoch: -1, wrongAt: [], closedUntil: 9e15 }],
        ["erik", { epoch: 0, wrongAt: "soon", closedUntil: 9e15 }],
        ["ines", { epoch: 0, wrongAt: Array.from({ length: CEILING_WRONG_CODES + 1 }, () => 1_000), closedUntil: 0 }],
        [7, { epoch: 0, wrongAt: [], closedUntil: 9e15 }],
        "not an entry",
        ["lena", { epoch: 0, wrongAt: [], closedUntil: 9e15 }],
      ],
      2_000,
    );
    expect(damaged.size).toBe(1);
    expect(damaged.closedFor("lena", 0, 2_000)).toBeGreaterThan(0);
    for (const nothing of [null, undefined, {}, "x", 42]) {
      const empty = new CodeCeiling();
      empty.hydrate(nothing, 2_000);
      expect(empty.size).toBe(0);
    }
  });
});
