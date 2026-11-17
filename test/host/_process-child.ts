// A module's process, for the tests of the host's launcher: this file stands in
// for a word of the command line. It answers what it was started with, echoes
// what it is sent, and does a few things a test asks for by name.
//
// It keeps the two rules that the host cannot keep for a word's code: it
// listens before anything else, and it ends when its channel closes.

import { fstatSync, statSync } from "node:fs";

const channel = process as unknown as { send?: (message: unknown) => void; disconnect?: () => void };
const send = channel.send?.bind(process);

/** Whether one of this process's three standard files is the null device:
 *  nothing can be read from it, and what is written to it goes nowhere. */
function isNullDevice(fd: number): boolean {
  try {
    const [held, nothing] = [fstatSync(fd), statSync("/dev/null")];
    return held.isCharacterDevice() && held.rdev === nothing.rdev;
  } catch {
    return false;
  }
}
if (!send) {
  process.exit(64);
}

/** Set by a test that wants this process to go on with its channel closed. */
let staysWithoutChannel = false;
process.on("disconnect", () => {
  // The daemon is gone, or it closed the channel: nothing is left to work for.
  if (!staysWithoutChannel) process.exit(0);
});

process.on("message", (message: unknown) => {
  const asked = (message as { do?: string } | null)?.do;
  if (asked === "exit") process.exit(7);
  if (asked === "print") {
    // What a process prints is read by nobody.
    console.log("a row's value on standard output");
    console.error("a row's value on standard error");
    send({ printed: true });
    return;
  }
  if (asked === "hang") {
    // A statement that never ends: the process answers nothing from here on.
    for (;;) {
      // Busy for good.
    }
  }
  if (asked === "close the channel") {
    // Still running, and nothing can be sent to it any more.
    staysWithoutChannel = true;
    channel.disconnect?.();
    setTimeout(() => process.exit(0), 20_000);
    return;
  }
  send({ echo: message });
});

send({
  started: true,
  word: process.argv[process.argv.length - 1],
  cwd: process.cwd(),
  // The names only: what the process was given, and nothing of its parent's.
  env: Object.keys(process.env).sort(),
  tmp: process.env.SQLITE_TMPDIR ?? null,
  // Whether code that a file in some folder named was run before this file.
  preloaded: (globalThis as { plantedCodeRan?: boolean }).plantedCodeRan === true,
  // Its input, its output and its error output, in that order.
  closed: [0, 1, 2].map(isNullDevice),
});
