import { describe, expect, test } from "bun:test";

import type { TuiApp } from "../src/tui/app";
import { handleTerminalKey } from "../src/tui/terminal";

describe("handleTerminalKey", () => {
  test("accepts SS3 arrow-key sequences", async () => {
    const rowMoves: number[] = [];
    const actionMoves: number[] = [];
    let activations = 0;
    const app: TuiApp = {
      model: () => ({ rows: [], footerNote: "" }),
      detailsModel: () => null,
      state: () => ({
        screen: "main",
        selectedRow: 0,
        selectedAction: 0,
        pendingDetailsFor: null,
        error: null,
        notice: null,
      }),
      moveRow: (delta) => rowMoves.push(delta),
      moveAction: (delta) => actionMoves.push(delta),
      activate: async () => {
        activations += 1;
      },
      goBack: () => {},
    };

    await expect(handleTerminalKey(app, "\u001bOA")).resolves.toBe(false);
    await expect(handleTerminalKey(app, "\u001bOB")).resolves.toBe(false);
    await expect(handleTerminalKey(app, "\u001bOC")).resolves.toBe(false);
    await expect(handleTerminalKey(app, "\u001bOD")).resolves.toBe(false);

    expect(rowMoves).toEqual([-1, 1]);
    expect(actionMoves).toEqual([1, -1]);
    expect(activations).toBe(0);
  });
});
