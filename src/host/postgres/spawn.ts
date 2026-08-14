export interface Spawner {
  // `stdout` is optional so existing mock spawners (which only surface exit code
  // + stderr) still satisfy the type; the real spawner always captures it, which
  // safe-extract's archive audit relies on.
  run(
    cmd: string[],
    // `maxStdoutBytes` bounds how much stdout is captured — a caller reading an
    // attacker-influenced listing (a billions-of-members archive) passes it so the
    // child is killed and the read throws instead of OOMing the fortress.
    opts?: { cwd?: string; maxStdoutBytes?: number },
  ): Promise<{ code: number; stdout?: string; stderr: string }>;
}

/** Read a stream to text, aborting (via `onExceed`, which kills the child) once
 *  more than `maxBytes` have been read so an unbounded producer can't OOM us. */
async function readCappedText(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onExceed: () => void,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        onExceed();
        throw new Error(`captured stdout exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const defaultSpawner: Spawner = {
  async run(cmd, opts) {
    const proc = Bun.spawn(cmd, { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe" });
    const max = opts?.maxStdoutBytes;
    // Read both pipes concurrently before awaiting exit so a child that fills
    // one pipe's buffer can't deadlock waiting for us to drain the other.
    const stdoutP =
      max && max > 0
        ? readCappedText(proc.stdout as ReadableStream<Uint8Array>, max, () => proc.kill())
        : new Response(proc.stdout).text();
    const [stdout, stderr, code] = await Promise.all([
      stdoutP,
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  },
};
