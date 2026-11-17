import { afterEach, describe, expect, test } from "bun:test";

import { StoreAlarms, WAKE_RETRIES, WakeLater } from "../../../src/modules/stores/host/alarms";

const running: StoreAlarms[] = [];
function alarms(options: ConstructorParameters<typeof StoreAlarms>[0]): StoreAlarms {
  const made = new StoreAlarms(options);
  running.push(made);
  return made;
}

afterEach(() => {
  for (const made of running.splice(0)) made.stop();
});

async function until(holds: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!holds()) {
    if (Date.now() > end) throw new Error("it did not happen in time");
    await Bun.sleep(5);
  }
}

describe("the alarm of each Store", () => {
  test("a Store is woken at its time, once", async () => {
    const woken: string[] = [];
    const set = alarms({ wake: async (key) => void woken.push(key) });
    const at = Date.now() + 250;
    set.set("permits", at);
    expect(set.at("permits")).toBe(at);
    await Bun.sleep(20);
    // Not before its time, however slow this machine is.
    if (Date.now() < at) expect(woken).toEqual([]);
    await until(() => woken.length === 1);
    expect(Date.now()).toBeGreaterThanOrEqual(at);
    await Bun.sleep(60);
    expect(woken).toEqual(["permits"]);
    // Spent.
    expect(set.at("permits")).toBeNull();
    expect(set.size).toBe(0);
  });

  test("a time in the past is due at once", async () => {
    const woken: string[] = [];
    const set = alarms({ wake: async (key) => void woken.push(key) });
    set.set("permits", Date.now() - 60_000);
    await until(() => woken.length === 1);
  });

  test("each Store has its own alarm", async () => {
    const woken: string[] = [];
    const set = alarms({ wake: async (key) => void woken.push(key) });
    set.set("second", Date.now() + 60);
    set.set("first", Date.now() + 20);
    await until(() => woken.length === 2);
    expect(woken).toEqual(["first", "second"]);
  });

  test("a new time replaces the old one, and no time removes it", async () => {
    const woken: string[] = [];
    const set = alarms({ wake: async (key) => void woken.push(key) });
    set.set("permits", Date.now() + 30);
    const later = Date.now() + 400;
    set.set("permits", later);
    await until(() => woken.length === 1);
    // Woken once, at the later time: the first time woke nothing.
    expect(Date.now()).toBeGreaterThanOrEqual(later);

    set.set("owners", Date.now() + 30);
    set.set("owners", null);
    await Bun.sleep(80);
    expect(woken).toEqual(["permits"]);
  });

  test("an alarm far ahead is looked at again, and fires when its time has come", async () => {
    let now = 1_000_000;
    let woken = 0;
    const set = alarms({
      now: () => now,
      longestWaitMs: 15,
      wake: async () => void (woken += 1),
    });
    set.set("permits", now + 10 * 24 * 60 * 60 * 1000);
    await Bun.sleep(70);
    expect(woken).toBe(0);
    expect(set.size).toBe(1);
    now += 10 * 24 * 60 * 60 * 1000;
    await until(() => woken === 1);
  });

  test("a forgotten Store and a stopped set wake nothing", async () => {
    let woken = 0;
    const set = alarms({ wake: async () => void (woken += 1) });
    set.set("removed", Date.now() + 20);
    set.forget("removed");
    set.set("stopped", Date.now() + 20);
    set.stop();
    set.set("after", Date.now() + 5);
    await Bun.sleep(80);
    expect(woken).toBe(0);
  });
});

describe("what the alarm is after a wake", () => {
  test("the time the wake answers is the next alarm", async () => {
    const woken: number[] = [];
    const set = alarms({
      wake: async () => {
        woken.push(Date.now());
        // The Store goes on with its job twice more.
        return woken.length < 3 ? Date.now() + 25 : null;
      },
    });
    set.set("permits", Date.now() + 10);
    await until(() => woken.length === 3);
    await Bun.sleep(60);
    expect(woken).toHaveLength(3);
    expect(set.size).toBe(0);
  });

  test("the answer decides, whatever was told while the Store was being woken", async () => {
    let woken = 0;
    const far = Date.now() + 60 * 60 * 1000;
    const set = alarms({
      wake: async () => {
        woken += 1;
        // Told on the way: a time that the Store then set again.
        set.set("permits", Date.now() + 5);
        return far;
      },
    });
    set.set("permits", Date.now());
    await until(() => woken === 1);
    await Bun.sleep(60);
    expect(woken).toBe(1);
    expect(set.at("permits")).toBe(far);
  });

  test("a Store that sets the time that just fired is woken again", async () => {
    // Two jobs due in the same moment: after the first, the alarm is that
    // moment again.
    let woken = 0;
    const at = Date.now();
    const set = alarms({
      wake: async () => {
        woken += 1;
        return woken === 1 ? at : null;
      },
    });
    set.set("permits", at);
    await until(() => woken === 2);
    expect(set.size).toBe(0);
  });

  test("where the wake answers nothing, what the Store told meanwhile is its alarm", async () => {
    const woken: number[] = [];
    const set = alarms({
      wake: async () => {
        woken.push(Date.now());
        if (woken.length < 3) set.set("permits", Date.now() + 25);
      },
    });
    set.set("permits", Date.now() + 10);
    await until(() => woken.length === 3);
    await Bun.sleep(60);
    expect(woken).toHaveLength(3);
    expect(set.size).toBe(0);
  });

  test("a Store that says it has no alarm while it is woken has none afterwards", async () => {
    let woken = 0;
    const set = alarms({
      wake: async () => {
        woken += 1;
        set.set("permits", null);
      },
    });
    set.set("permits", Date.now() + 10);
    await until(() => woken === 1);
    await Bun.sleep(40);
    expect(woken).toBe(1);
    expect(set.size).toBe(0);
  });
});

describe("when waking a Store fails", () => {
  test("the alarm stands and the Store is woken again later", async () => {
    let tries = 0;
    const set = alarms({
      retryBaseMs: 10,
      wake: async () => {
        tries += 1;
        if (tries < 3) throw new Error("the Store's process did not start");
        return null;
      },
    });
    set.set("permits", Date.now() + 5);
    await until(() => tries === 3);
    await Bun.sleep(80);
    expect(tries).toBe(3);
    expect(set.size).toBe(0);
  });

  test("after the last try it gives up, and says which Store", async () => {
    let tries = 0;
    const gaveUp: string[] = [];
    const set = alarms({
      retryBaseMs: 1,
      wake: async () => {
        tries += 1;
        throw new Error("no");
      },
      onGiveUp: (key) => gaveUp.push(key),
    });
    set.set("permits", Date.now());
    await until(() => gaveUp.length === 1);
    expect(tries).toBe(WAKE_RETRIES + 1);
    expect(gaveUp).toEqual(["permits"]);
    expect(set.size).toBe(0);
  });

  test("being told the same time again does not start the tries anew", async () => {
    // Each try starts a new process of the Store, and a process that opens
    // tells the alarm's time as its file has it.
    let tries = 0;
    const gaveUp: string[] = [];
    const at = Date.now();
    const set = alarms({
      retryBaseMs: 1,
      wake: async (key) => {
        tries += 1;
        set.set(key, at);
        throw new Error("the wake ran past its limit");
      },
      onGiveUp: (key) => gaveUp.push(key),
    });
    set.set("permits", at);
    await until(() => gaveUp.length === 1);
    await Bun.sleep(60);
    expect(tries).toBe(WAKE_RETRIES + 1);

    // An alarm that was given up is not taken again at the same time: a
    // process that opens for a call tells it once more.
    set.set("permits", at);
    await Bun.sleep(60);
    expect(tries).toBe(WAKE_RETRIES + 1);
    expect(set.size).toBe(0);
    // A call that changes the Store's alarm starts it anew.
    set.set("permits", at + 1);
    await until(() => tries > WAKE_RETRIES + 1);
  });

  test("a new time that the Store set before it failed is its alarm, and is waited for", async () => {
    let tries = 0;
    const far = Date.now() + 60 * 60 * 1000;
    const set = alarms({
      retryBaseMs: 5,
      wake: async (key) => {
        tries += 1;
        set.set(key, far);
        throw new Error("failed after it set a new time");
      },
    });
    set.set("permits", Date.now());
    await until(() => tries === 1);
    await Bun.sleep(60);
    // Not tried again at once: the new time has not come.
    expect(tries).toBe(1);
    expect(set.at("permits")).toBe(far);
  });

  test("a listener that throws when the alarm is given up stops nothing", async () => {
    let tries = 0;
    const set = alarms({
      retryBaseMs: 1,
      wake: async () => {
        tries += 1;
        throw new Error("no");
      },
      onGiveUp: () => {
        throw new Error("a listener's own failure");
      },
    });
    set.set("permits", Date.now());
    await until(() => tries === WAKE_RETRIES + 1);
    await Bun.sleep(40);
    expect(set.size).toBe(0);
  });
});

describe("a wake that has to wait", () => {
  test("is tried again as often as it takes, is not counted as a failure, and is never given up", async () => {
    let tries = 0;
    const givenUp: string[] = [];
    const set = alarms({
      retryBaseMs: 5,
      onGiveUp: (key) => void givenUp.push(key),
      wake: async () => {
        tries += 1;
        // No room, more often than a failing wake is tried at all.
        if (tries <= WAKE_RETRIES + 4) throw new WakeLater();
        return null;
      },
    });
    set.set("permits", Date.now() - 1);
    await until(() => tries === WAKE_RETRIES + 5);
    await Bun.sleep(30);
    expect(tries).toBe(WAKE_RETRIES + 5);
    expect(givenUp).toEqual([]);
    expect(set.at("permits")).toBeNull();
  });

  test("the waits do not use up the tries of a wake that then fails", async () => {
    let tries = 0;
    const givenUp: string[] = [];
    const set = alarms({
      retryBaseMs: 1,
      onGiveUp: (key) => void givenUp.push(key),
      wake: async () => {
        tries += 1;
        if (tries <= 5) throw new WakeLater();
        throw new Error("the Store could not be woken");
      },
    });
    set.set("permits", Date.now() - 1);
    // Five waits, then the first try and its six new tries.
    await until(() => givenUp.length === 1, 5_000);
    expect(tries).toBe(5 + 1 + WAKE_RETRIES);
  });

  test("a time the Store was told while its wake waited is its alarm, and none is none", async () => {
    let tries = 0;
    const set = alarms({
      retryBaseMs: 5,
      wake: async (key) => {
        tries += 1;
        if (tries === 1) {
          set.set(key, later);
          throw new WakeLater();
        }
        if (key === "owners") {
          set.set(key, null);
          throw new WakeLater();
        }
        return null;
      },
    });
    const later = Date.now() + 120;
    set.set("permits", Date.now() - 1);
    await until(() => tries === 1);
    await Bun.sleep(10);
    expect(set.at("permits")).toBe(later);
    await until(() => tries === 2);
    expect(Date.now()).toBeGreaterThanOrEqual(later);
    set.set("owners", Date.now() - 1);
    await until(() => tries === 3);
    await Bun.sleep(10);
    expect(set.at("owners")).toBeNull();
    await Bun.sleep(30);
    expect(tries).toBe(3);
  });
});
