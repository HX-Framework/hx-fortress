export type HostSignal = "SIGINT" | "SIGTERM";

export interface HostLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SignalSource {
  on(signal: HostSignal, listener: () => void): void;
  off(signal: HostSignal, listener: () => void): void;
}

export const processSignalSource: SignalSource = {
  on(signal, listener) {
    process.on(signal, listener);
  },
  off(signal, listener) {
    process.off(signal, listener);
  },
};

export async function runHost(
  runtime: HostLifecycle,
  signals: SignalSource = processSignalSource,
): Promise<void> {
  let resolveSignal: () => void = () => {};
  const receivedSignal = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  const onSignal = () => resolveSignal();

  signals.on("SIGINT", onSignal);
  signals.on("SIGTERM", onSignal);

  try {
    try {
      await runtime.start();
    } catch (error) {
      try {
        await runtime.stop();
      } catch {
        // Preserve the startup error; HostRuntime logs cleanup failures itself.
      }
      throw error;
    }

    await receivedSignal;
    await runtime.stop();
  } finally {
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
  }
}
