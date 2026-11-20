// The brand of a piece that HX Fortress serves, in one file. HX Fortress's own pages take it
// from here: the sign-in window, and the page of a result.
//
// Four things, each its own:
//   the mark      a chess rook with a gold padlock at its foot
//   brand()       the mark and the words "HX Fortress", always together
//   org(name)     an organization's avatar and its name, always together
//   picture()     you, an arrow, the rook in outline, an arrow, the organization
//
// "HX Fortress" and an organization's name are never joined into one phrase on a screen.
//
// The rook takes the colour of the text around it. Every other colour of a drawing is set by
// island.css, through the classes on its parts: no drawing here has a style attribute, because
// these pages allow no inline style. A name is only ever set as text.

import { el } from "./island.js";

const SVG = "http://www.w3.org/2000/svg";

/**
 * A drawing from its markup. The markup is a constant of this file and holds no value.
 *
 * @param {string} markup
 * @returns {SVGSVGElement}
 */
function drawing(markup) {
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
  return /** @type {SVGSVGElement} */ (/** @type {unknown} */ (document.importNode(parsed, true)));
}

/** The first character of a name, whole: a character that takes two code units is not cut. */
const first = (/** @type {string} */ name) => [...name][0] ?? "";

// The mark at label size, drawn on a 16 px grid: every edge lands on a whole pixel at 16 px. The
// rook leaves a 1 px gap around the padlock, so the mark needs no background colour.
const SMALL =
  `<svg xmlns="${SVG}" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">` +
  `<path d="M1 1h2v2h2V1h2v2h2V1h2v4h-1v1H9v3H8v6H1v-2h1V5H1Z"/>` +
  `<path class="hx-lock-fill" d="M9 10h6v5H9ZM10 10V9a2 2 0 0 1 4 0v1h-1V9a1 1 0 0 0-2 0v1Z"/></svg>`;

/** The mark, 16 px. */
export const small = () => drawing(SMALL);

/** "HX Fortress" with its mark: one thing, written the same way everywhere. */
export const brand = () => el("span", { class: "hxl" }, [small(), el("span", { text: "HX Fortress" })]);

/**
 * An organization with its avatar: one thing. The avatar is the first letter on a tile.
 *
 * @param {string} name
 */
export const org = (name) =>
  el("span", { class: "hxl" }, [el("span", { class: "hxl-av", "aria-hidden": "true", text: first(name) }), el("span", { text: name })]);

/** The line that says whose work a page is. */
export const poweredBy = () => el("span", { class: "hxl-by" }, ["Powered by ", brand()]);

// The rook for 32 px and more, on a 64 px grid, as a line with a padlock that has a keyhole. A
// mask cuts the gap around the padlock out of the rook.
const ROOK =
  `<mask id="hx-rook-gap" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#fff"/>` +
  `<rect x="36" y="40" width="24" height="20" rx="3" fill="#000" stroke="#000" stroke-width="7"/><path d="M41 41v-7a7 7 0 0 1 14 0v7" stroke="#000" stroke-width="11"/></mask>` +
  `<g mask="url(#hx-rook-gap)"><path d="M6 6h6v8h10V6h8v8h10V6h6v14h-4v32h4v6H6v-6h4V20H6Z" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round"/></g>` +
  `<path class="hx-lock-fill" fill-rule="evenodd" d="M39 40h18a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H39a3 3 0 0 1-3-3V43a3 3 0 0 1 3-3ZM48 45.4a2.9 2.9 0 0 0-1.4 5.4v3.8h2.8v-3.8A2.9 2.9 0 0 0 48 45.4Z"/>` +
  `<path class="hx-lock-stroke" d="M41 41v-7a7 7 0 0 1 14 0v7" stroke-width="4"/>`;

/** A line with an arrow's head, from x1 to x2 on the picture's middle line. */
const arrow = (/** @type {number} */ x1, /** @type {number} */ x2) =>
  `<path d="M${x1} 36H${x2 - 8}" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M${x2} 36l-9-5.5v11Z" fill="currentColor"/>`;

// The picture of a sign-in: you go to the rook, and the rook lets you into your organization.
// Everything is laid out around the rook. The same drawing holds the lines of the state in which
// the sign-in cannot go on: the class `is-off` on it shows them (island.css). A page holds one
// picture, so the rook's mask has one id.
const PICTURE =
  `<svg xmlns="${SVG}" class="hx-picture" viewBox="0 0 340 92" width="340" height="92" fill="none" role="img">` +
  `<circle class="hx-pic-disc" cx="30" cy="36" r="22" stroke-width="1.5"/>` +
  `<g class="hx-pic-person" stroke-width="2.5" stroke-linecap="round"><circle cx="30" cy="31" r="6.5"/><path d="M19 49a11 9 0 0 1 22 0"/></g>` +
  `<g class="hx-pic-on">${arrow(64, 116)}${arrow(200, 252)}</g>` +
  `<g class="hx-pic-offline"><path class="hx-pic-faint" d="M64 36H112" stroke-width="2" stroke-linecap="round" stroke-dasharray="1 6"/>` +
  `<circle class="hx-pic-knot" cx="88" cy="36" r="9" stroke-width="1.5"/>` +
  `<path class="hx-pic-cross" d="M84.5 32.5l7 7M91.5 32.5l-7 7" stroke-width="2" stroke-linecap="round"/>` +
  `<path class="hx-pic-faint" d="M200 36H244" stroke-width="2" stroke-linecap="round"/><path class="hx-pic-faint-fill" d="M252 36l-9-5.5v11Z"/></g>` +
  `<g transform="translate(124 4)">${ROOK}</g>` +
  `<rect class="hx-pic-tile" x="264" y="16" width="40" height="40" rx="10.5"/>` +
  `<text class="hx-pic-letter" data-part="letter" x="284" y="43.2" text-anchor="middle" font-size="20" font-weight="700"></text>` +
  `<text class="hx-pic-cap" x="30" y="84" text-anchor="middle" font-size="12" font-weight="600">You</text>` +
  `<text class="hx-pic-cap" data-part="name" x="284" y="84" text-anchor="middle" font-size="12" font-weight="600"></text></svg>`;

/**
 * The picture: you, the rook, the organization.
 *
 * @param {string | null} name The organization's name, when HX Fortress said it.
 */
export function picture(name) {
  const svg = drawing(PICTURE);
  const shown = name ?? "Your organization";
  svg.setAttribute("aria-label", `You, then HX Fortress, then ${shown}`);
  const letter = svg.querySelector('[data-part="letter"]');
  const caption = svg.querySelector('[data-part="name"]');
  if (letter) letter.textContent = name ? first(name) : "";
  // A long name is cut here, between two characters: the page's heading holds it whole.
  const characters = [...shown];
  if (caption) caption.textContent = characters.length > 18 ? `${characters.slice(0, 17).join("")}…` : shown;
  return svg;
}
