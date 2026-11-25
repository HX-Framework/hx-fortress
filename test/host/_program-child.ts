// A stand-in for a helper program, for the tests of the host's launcher. The
// tests copy this file into a throwaway folder under a first line that makes
// it a program of its own, so it imports nothing but the runtime.
//
// It reads one JSON job from its standard input, to the end, and does what
// the job's `do` says. A program that never got the end of its input would
// wait here for ever, and its test would time out.

import { writeSync } from "node:fs";

interface Job {
  do: string;
  [field: string]: unknown;
}

/** Written before the call returns, so that what is printed just before the
 *  program ends is not lost. */
const write = (fd: 1 | 2, bytes: Uint8Array): void => {
  let done = 0;
  while (done < bytes.byteLength) {
    try {
      done += writeSync(fd, bytes, done);
    } catch (thrown) {
      // The pipe is full for a moment: its reader has not caught up.
      if ((thrown as { code?: string }).code !== "EAGAIN") throw thrown;
    }
  }
};
const out = (text: string): void => write(1, new TextEncoder().encode(text));
const print = (value: unknown): void => out(`${JSON.stringify(value)}\n`);
const forEver = (): Promise<never> => new Promise<never>(() => setInterval(() => {}, 1_000));

const job = JSON.parse(await Bun.stdin.text()) as Job;

switch (job.do) {
  case "echo":
    // What it was started with, and the job as it arrived.
    print({ args: process.argv.slice(2), env: { ...process.env }, cwd: process.cwd(), job });
    break;
  case "lines":
    for (const value of job.values as unknown[]) print(value);
    break;
  case "blank-lines":
    out("\n   \n");
    print({ n: 1 });
    out("\n");
    break;
  case "no-line-end":
    print({ n: 1 });
    out(JSON.stringify({ n: 2 }));
    break;
  case "not-json":
    print({ n: 1 });
    out("this line is not JSON\n");
    print({ n: 3 });
    await forEver();
    break;
  case "not-text":
    write(1, new Uint8Array([0x7b, 0xff, 0xfe, 0x7d, 0x0a]));
    break;
  case "large":
    print({ pad: "x".repeat(job.bytes as number) });
    break;
  case "too-much":
    // More than a run may print, and then it stays.
    out(`${JSON.stringify({ pad: "x".repeat(job.bytes as number) })}\n`);
    await forEver();
    break;
  case "says":
    for (const line of job.lines as string[]) write(2, new TextEncoder().encode(`${line}\n`));
    print({ said: (job.lines as string[]).length });
    break;
  case "says-much": {
    const line = new TextEncoder().encode(`${"e".repeat(99)}\n`);
    for (let i = 0; i < (job.lines as number); i += 1) write(2, line);
    print({ said: job.lines });
    break;
  }
  case "leaves-a-child":
    // A process that this program leaves behind. It holds the program's two
    // outputs open, and prints one more line on each after the program ended.
    Bun.spawnSync(
      ["/bin/sh", "-c", `(sleep ${Number(job.afterSeconds)}; echo '{"late":true}'; echo late >&2) &`],
      { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
    );
    print({ n: 1 });
    process.exit(0);
    break;
  case "exit":
    if (job.print === true) print({ n: 1 });
    process.exit(job.code as number);
    break;
  case "hang":
    print({ started: true });
    await forEver();
    break;
  case "hang-through-a-stop":
    // Asked to stop, it stays.
    process.on("SIGTERM", () => {});
    print({ started: true });
    await forEver();
    break;
  case "answers-a-stop":
    // Asked to stop, it says so and ends well, as a program in the middle of
    // a write does.
    process.on("SIGTERM", () => {
      print({ stopped: true });
      process.exit(0);
    });
    print({ started: true });
    await forEver();
    break;
  default:
    process.exit(64);
}
