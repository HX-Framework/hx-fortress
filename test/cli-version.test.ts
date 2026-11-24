// `hx-fortress version`: the version alone, on one line.
//
// The install script asks the program that is already on a computer for its
// version, so that it never puts an older program over a newer one. So the
// answer has to be the version and nothing else.

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli";
import { FORTRESS_VERSION, parseStableSemver } from "../src/version";

describe("hx-fortress version", () => {
  for (const word of ["version", "--version"]) {
    test(`${word} prints the version alone and ends with 0`, async () => {
      const lines: string[] = [];
      const code = await runCli([word], { writeLine: (line) => lines.push(line) });
      expect(code).toBe(0);
      expect(lines).toEqual([FORTRESS_VERSION]);
    });
  }

  test("the version is three numbers with dots, which is what the install script compares", () => {
    expect(parseStableSemver(FORTRESS_VERSION)).not.toBeNull();
    expect(FORTRESS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the help lists the command", async () => {
    const lines: string[] = [];
    await runCli(["help"], { writeLine: (line) => lines.push(line) });
    expect(lines.join("\n")).toContain("hx-fortress version");
  });
});
