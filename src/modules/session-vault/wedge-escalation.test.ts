// The wedge-escalation policy: restart-futility gate, supervisor branch, and
// the bounded embedded-Postgres stop that precedes a hard exit.
import { describe, expect, it } from "bun:test";
import { createWedgeEscalation } from "./store.js";

const settle = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("createWedgeEscalation", () => {
  it("never exits when the write path never succeeded — restart is known-futile", async () => {
    let exited = -1;
    const cb = createWedgeEscalation({ exit: (c) => (exited = c), supervised: () => true });
    cb({ hadCountedSuccess: false });
    await settle();
    expect(exited).toBe(-1);
  });

  it("stays degraded without a supervisor", async () => {
    let exited = -1;
    const cb = createWedgeEscalation({ exit: (c) => (exited = c), supervised: () => false });
    cb({ hadCountedSuccess: true });
    await settle();
    expect(exited).toBe(-1);
  });

  it("stops the embedded Postgres first, then exits 1", async () => {
    const order: string[] = [];
    let exited = -1;
    const cb = createWedgeEscalation({
      exit: (c) => {
        exited = c;
        order.push("exit");
      },
      supervised: () => true,
      beforeExit: async () => {
        order.push("pg-stop");
      },
    });
    cb({ hadCountedSuccess: true });
    await settle();
    expect(exited).toBe(1);
    expect(order).toEqual(["pg-stop", "exit"]);
  });

  it("a hanging beforeExit cannot hold the exit past its bound", async () => {
    let exited = -1;
    const cb = createWedgeEscalation({
      exit: (c) => (exited = c),
      supervised: () => true,
      beforeExitBoundMs: 20,
      beforeExit: () => new Promise<void>(() => {}),
    });
    cb({ hadCountedSuccess: true });
    await settle(60);
    expect(exited).toBe(1);
  });
});
