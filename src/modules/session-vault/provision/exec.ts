// Spawn helpers for provisioning. `capture` runs a command and collects its
// output; `interactive` inherits stdio so browser-auth flows (gcloud auth login)
// show their output and block until the operator finishes. All provisioning runs
// through the operator's own local CLI — let.ai is never in the loop.

import { spawn } from "node:child_process";

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function capture(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("close", (code) => resolve({ ok: code === 0, stdout: out.trim(), stderr: err.trim() }));
    p.on("error", (e) => resolve({ ok: false, stdout: "", stderr: String(e) }));
  });
}

/** Inherit stdio so the operator sees prompts/URLs and the call blocks until the
 *  child exits. Returns true on exit code 0. */
export function interactive(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("close", (code) => resolve(code === 0));
    p.on("error", () => resolve(false));
  });
}
