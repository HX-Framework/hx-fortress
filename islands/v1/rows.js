// The `rows` kind of Secure Data Island: the rows of one query, as tall as they are.
//
// The statement is in the settings that the page around the frame handed over. HX Fortress runs
// it for the person who is signed in here, when the control plane's grant commits to exactly
// these settings. The rows are drawn here and are told to nobody: the page around the frame
// learns how many there are.

import { el, start } from "./island.js";

/** A type's name that reads as a number, so its column is set to the right. */
const NUMBER = /int|dec|num|float|double|real|money/i;
/** A value longer than this also gets its whole text as the cell's tip. */
const LONG = 60;

/**
 * @typedef {object} Answer What HX Fortress answers a read with.
 * @property {{ name: string, type: string }[]} columns
 * @property {(string | null)[][]} rows Every value is text, or null.
 * @property {boolean} more The statement has more rows than these, or a value was cut.
 */

/**
 * @param {unknown} said
 * @returns {Answer | null}
 */
function answerOf(said) {
  if (!said || typeof said !== "object") return null;
  const { columns, rows, more } = /** @type {Record<string, unknown>} */ (said);
  if (!Array.isArray(columns) || !Array.isArray(rows)) return null;
  return {
    columns: columns.map((c) => ({ name: String(c?.name ?? ""), type: String(c?.type ?? "") })),
    rows: rows.map((row) => (Array.isArray(row) ? row.map((v) => (v === null || v === undefined ? null : String(v))) : [])),
    more: more === true,
  };
}

start({
  name: "rows",
  showsRows: true,
  mount(edge) {
    const { root } = edge;
    /** @type {Answer | null} */
    let data = null;
    /** @type {HTMLElement | null} */
    let grid = null;
    /** @type {HTMLElement[]} */
    let rowEls = [];
    let sel = 0;

    function skeleton() {
      const bars = Array.from({ length: 3 }, () => el("div", { class: "hx-skel" }));
      root.replaceChildren(el("div", { class: "hx-skels", "aria-hidden": "true" }, bars));
    }

    /**
     * @param {number} i
     * @param {boolean} [scroll]
     */
    function select(i, scroll = true) {
      const row = rowEls[i];
      if (!grid || !row) return;
      rowEls[sel]?.setAttribute("aria-selected", "false");
      sel = i;
      row.setAttribute("aria-selected", "true");
      grid.setAttribute("aria-activedescendant", row.id);
      if (scroll) row.scrollIntoView({ block: "nearest", inline: "nearest" });
    }

    /** @param {KeyboardEvent} e */
    function onKey(e) {
      if (!data || !grid || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        // A table that is wider than its frame moves sideways.
        if (grid.scrollWidth <= grid.clientWidth) return;
        e.preventDefault();
        e.stopPropagation();
        grid.scrollBy({ left: e.key === "ArrowLeft" ? -120 : 120 });
        return;
      }
      const last = rowEls.length - 1;
      const moves = /** @type {Record<string, number>} */ ({
        ArrowDown: sel + 1, ArrowUp: sel - 1, Home: 0, End: last, PageDown: sel + 10, PageUp: sel - 10,
      });
      if (!Object.hasOwn(moves, e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      // Past the first or the last row, and from a result with no rows, the keyboard goes back to
      // the page around the frame.
      if (e.key === "ArrowDown" && moves.ArrowDown > last) edge.leave("bottom");
      else if (e.key === "ArrowUp" && moves.ArrowUp < 0) edge.leave("top");
      else select(Math.max(0, Math.min(last, moves[e.key])));
    }

    /** @param {Answer} answer */
    function draw(answer) {
      const def = edge.def();
      const side = answer.columns.map((c) => (NUMBER.test(c.type) ? "hx-num" : ""));
      const head = el("tr", {}, answer.columns.map((c, j) => el("th", { scope: "col", class: side[j], text: c.name })));
      rowEls = answer.rows.map((row, i) =>
        el("tr", { id: `hx-r${i}`, role: "row", "aria-selected": "false" },
          row.map((value, j) =>
            el("td", { class: side[j] ?? "" }, value === null
              ? el("span", { class: "hx-val hx-none", text: "null" })
              : el("span", { class: "hx-val", text: value, title: value.length > LONG && value }))),
        ),
      );
      const table = el("table", { class: "hx-table" }, [el("thead", {}, head), el("tbody", {}, rowEls)]);
      const made = el("div", { class: "hx-grid", role: "grid", tabindex: "0", "aria-label": def.target, "aria-rowcount": String(rowEls.length) }, table);
      made.addEventListener("keydown", onKey);
      // One listener for every row: a press on a row picks it.
      made.addEventListener("mousedown", (e) => {
        const row = e.target instanceof Element ? e.target.closest("tbody tr") : null;
        const i = row instanceof HTMLElement ? rowEls.indexOf(row) : -1;
        if (i >= 0) select(i, false);
      });
      grid = made;
      const under = rowEls.length === 0 ? "No rows" : answer.more ? "Not every row or value is shown." : "";
      root.replaceChildren(made, under ? el("div", { class: "hx-foot", text: under }) : "");
      edge.printNote(`${rowEls.length} rows of ${def.target} are kept at ${location.host}. They are not printed with this page.`);
      sel = 0;
      select(0, false);
    }

    return {
      async show(still) {
        edge.setState("loading");
        skeleton();
        const grant = await edge.askGrant();
        if (!still()) return;
        if (!grant) {
          edge.problem(edge.framed ? "The page around these rows did not answer." : "Open this page again from the page that shows these rows.", edge.framed);
          return edge.setState("error", { code: "no-grant" });
        }
        const def = edge.def();
        const response = await edge.api("read", { kind: def.kind, target: def.target, settings: def.settings, grant });
        if (!still()) return;
        if (!response) {
          edge.problem("HX Fortress did not answer.", true);
          return edge.setState("error", { code: "network" });
        }
        if (!response.ok) return edge.refused(response, still, "The rows could not be read.");
        const answer = answerOf(await response.json().catch(() => null));
        if (!still()) return;
        if (!answer) {
          edge.problem("The rows could not be read.", true);
          return edge.setState("error", { code: "unavailable" });
        }
        data = answer;
        draw(answer);
        edge.setState("ready", { rows: answer.rows.length });
      },
      land(where) {
        select(where === "last" ? rowEls.length - 1 : 0);
        return grid;
      },
      target: () => grid,
      key: onKey,
      count: () => data?.rows.length ?? 0,
    };
  },
});
