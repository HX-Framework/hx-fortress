// The console's Copy buttons: whether the copy worked is told apart from
// whether it did not, and the textarea that carried the text never stays in
// the page. The text can be the key of a second step.

import { afterEach, describe, expect, test } from "bun:test";

import { copyText } from "../ui/src/lib/util";

interface FakeArea {
  value: string;
  selected: boolean;
  removed: boolean;
  select(): void;
  remove(): void;
}

/** A page whose `execCommand("copy")` answers `answer`, or throws. */
function fakePage(answer: boolean | "throws"): { areas: FakeArea[]; attached: FakeArea[] } {
  const areas: FakeArea[] = [];
  const attached: FakeArea[] = [];
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => {
      expect(tag).toBe("textarea");
      const area: FakeArea = {
        value: "",
        selected: false,
        removed: false,
        select() {
          this.selected = true;
        },
        remove() {
          this.removed = true;
        },
      };
      areas.push(area);
      return area;
    },
    body: { appendChild: (area: FakeArea) => attached.push(area) },
    execCommand: (command: string) => {
      expect(command).toBe("copy");
      if (answer === "throws") throw new Error("the clipboard is not available");
      return answer;
    },
  };
  return { areas, attached };
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

describe("copyText", () => {
  test("true when the browser copied, and the textarea is gone", () => {
    const page = fakePage(true);
    expect(copyText("JBSWY3DPEHPK3PXP")).toBe(true);
    expect(page.areas).toHaveLength(1);
    expect(page.areas[0]).toMatchObject({ value: "JBSWY3DPEHPK3PXP", selected: true, removed: true });
  });

  test("false when the browser said no, and the textarea is gone", () => {
    const page = fakePage(false);
    expect(copyText("JBSWY3DPEHPK3PXP")).toBe(false);
    expect(page.areas[0]?.removed).toBe(true);
  });

  test("false when the copy threw, and the textarea is gone all the same", () => {
    const page = fakePage("throws");
    expect(copyText("JBSWY3DPEHPK3PXP")).toBe(false);
    expect(page.attached).toHaveLength(1);
    expect(page.areas[0]?.removed).toBe(true);
  });

  test("a button says which it was, for a moment", async () => {
    fakePage(true);
    const copied = { textContent: "Copy" } as HTMLElement;
    copyText("text", copied);
    expect(copied.textContent).toBe("Copied");

    fakePage(false);
    const failed = { textContent: "Copy" } as HTMLElement;
    copyText("text", failed);
    expect(failed.textContent).toBe("Copy failed");

    fakePage("throws");
    const threw = { textContent: "Copy" } as HTMLElement;
    copyText("text", threw);
    expect(threw.textContent).toBe("Copy failed");

    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect([copied.textContent, failed.textContent, threw.textContent]).toEqual(["Copy", "Copy", "Copy"]);
  });
});
