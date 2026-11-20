// The first thing a page of this folder runs, before it paints: which theme it starts in.
//
// A framed page takes the theme that the page around it named in the address's fragment, which
// no server ever sees: `#theme=dark` or `#theme=light`. With no name it is light. The styles set
// the page's colour scheme from the theme. A browser gives a frame a solid background of its own
// when the frame's colour scheme differs from the page around it, so the theme is set here,
// before the first paint, and not once the page's module has loaded.
//
// HX Fortress's own pages (the sign-in window, and the page of a result) follow the computer's
// light or dark setting.
(() => {
  "use strict";
  const root = document.documentElement;
  if (root.classList.contains("hx-own")) {
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => {
      root.dataset.theme = dark.matches ? "dark" : "light";
    };
    follow();
    dark.addEventListener("change", follow);
    return;
  }
  const named = new URLSearchParams(location.hash.slice(1)).get("theme");
  root.dataset.theme = named === "dark" ? "dark" : "light";
})();
