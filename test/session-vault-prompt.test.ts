import { describe, expect, test } from "bun:test";

import { runSelectPrompt, runTextPrompt, type PromptIo } from "../src/modules/session-vault/prompt";

function fakeIo(input: string): { io: PromptIo; output: () => string; rawHistory: () => boolean[] } {
  let cursor = 0;
  let written = "";
  const rawStates: boolean[] = [];

  return {
    io: {
      close: () => {},
      readChar: () => {
        const ch = input[cursor];
        cursor += 1;
        if (ch === undefined) {
          throw new Error("prompt attempted to read past the supplied input");
        }
        return ch;
      },
      setRawMode: (enabled) => {
        rawStates.push(enabled);
      },
      write: (chunk) => {
        written += chunk;
      },
    },
    output: () => written,
    rawHistory: () => rawStates,
  };
}

describe("runTextPrompt", () => {
  test("returns the default when the operator presses Enter", async () => {
    const { io, output, rawHistory } = fakeIo("\r");

    await expect(
      runTextPrompt("GCP project (holds the bucket and service account):", { default: "acme-prod" }, io),
    ).resolves.toBe("acme-prod");

    expect(output()).toBe(
      "GCP project (holds the bucket and service account): [acme-prod] \r\n",
    );
    expect(rawHistory()).toEqual([true]);
  });

  test("echoes typed input and handles backspace", async () => {
    const { io, output } = fakeIo("abc\x7fd\r");

    await expect(runTextPrompt("Bucket name:", {}, io)).resolves.toBe("abd");

    expect(output()).toBe("Bucket name: abc\b \bd\r\n");
  });
});

describe("runSelectPrompt", () => {
  test("starts the menu on a fresh line before the first render", async () => {
    const { io, output } = fakeIo("1");

    await expect(
      runSelectPrompt(
        "Storage backend for session transcripts:",
        [
          { label: "Google Cloud Storage", value: "gcs" },
          { label: "Amazon S3", value: "s3" },
        ],
        {},
        io,
      ),
    ).resolves.toBe("gcs");

    expect(output()).toBe(
      "\r\n\x1b[0JStorage backend for session transcripts:\r\n❯ 1) Google Cloud Storage\r\n  2) Amazon S3\r\n\r\n",
    );
  });
});
