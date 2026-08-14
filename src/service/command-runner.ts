import { spawnSync } from "node:child_process";

import type { CommandResult, CommandRunner } from "./types";

export class NodeCommandRunner implements CommandRunner {
  run(command: string, args: readonly string[]): CommandResult {
    const result = spawnSync(command, [...args], {
      encoding: "utf8",
      shell: false,
      stdio: "pipe",
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
}

export function commandError(
  command: string,
  args: readonly string[],
  result: CommandResult,
): Error {
  const detail =
    result.stderr.trim() ||
    result.stdout.trim() ||
    `(exit ${result.status ?? "unknown"})`;
  return new Error(`${command} ${args.join(" ")} failed: ${detail}`);
}
