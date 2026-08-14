import { describe, expect, test } from "bun:test";

import { runHost, type HostLifecycle, type SignalSource } from "../src/host/run-host";

describe("runHost", () => {
  test.each(["SIGINT", "SIGTERM"] as const)(
    "installs handlers and gracefully stops on %s",
    async (signal) => {
      const events: string[] = [];
      const signals = new MemorySignalSource(events);
      const runtime: HostLifecycle = {
        async start() {
          events.push("runtime:start");
        },
        async stop() {
          events.push("runtime:stop");
        },
      };

      const running = runHost(runtime, signals);
      await Promise.resolve();
      signals.emit(signal);
      await running;

      expect(events).toEqual([
        "signal:on:SIGINT",
        "signal:on:SIGTERM",
        "runtime:start",
        "runtime:stop",
        "signal:off:SIGINT",
        "signal:off:SIGTERM",
      ]);
      expect(signals.listenerCount()).toBe(0);
    },
  );

  test("cleans up handlers and partial runtime state after startup fails", async () => {
    const events: string[] = [];
    const signals = new MemorySignalSource(events);
    const runtime: HostLifecycle = {
      async start() {
        events.push("runtime:start");
        throw new Error("startup failed");
      },
      async stop() {
        events.push("runtime:stop");
      },
    };

    await expect(runHost(runtime, signals)).rejects.toThrow("startup failed");

    expect(events).toEqual([
      "signal:on:SIGINT",
      "signal:on:SIGTERM",
      "runtime:start",
      "runtime:stop",
      "signal:off:SIGINT",
      "signal:off:SIGTERM",
    ]);
    expect(signals.listenerCount()).toBe(0);
  });
});

class MemorySignalSource implements SignalSource {
  private readonly listeners = new Map<NodeJS.Signals, Set<() => void>>();

  constructor(private readonly events: string[]) {}

  on(signal: NodeJS.Signals, listener: () => void): void {
    this.events.push(`signal:on:${signal}`);
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  off(signal: NodeJS.Signals, listener: () => void): void {
    this.events.push(`signal:off:${signal}`);
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: NodeJS.Signals): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce(
      (count, listeners) => count + listeners.size,
      0,
    );
  }
}
