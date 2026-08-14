// Browser affordances the console needs, and nothing that fakes work.

/** Copy through a throwaway textarea: it needs no permission prompt in any
 *  browser this console targets, and it works on a plain-http origin, which a
 *  console reached over an SSH forward always is. */
export function copyText(text: string, button?: HTMLElement | null, doneLabel?: string): void {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    if (button) {
      const previous = button.textContent;
      button.textContent = doneLabel ?? "Copied";
      setTimeout(() => (button.textContent = previous), 1200);
    }
  } catch {
    // A browser that refuses the clipboard leaves the text on screen, which is
    // still the answer.
  }
}

/** Scroll a panel into view and flash it — remove, reflow, add. */
export function flashPanel(el: HTMLElement | null): void {
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

/**
 * Save bytes the browser ALREADY HAS.
 *
 * This is not an export. It re-saves rows that were delivered over a classified
 * read route and are on screen right now — the streamed log buffer, and nothing
 * else. Anything that assembles a NEW artifact out of fortress data is a server
 * endpoint, because a copy that leaves the box has to leave a record behind.
 */
export function saveRenderedRows(text: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

/** Close every open custom menu — the document-level Esc behaviour. */
export const MENU_CLOSE_EVENT = "hx-close-menus";
export function closeAllMenus(): void {
  window.dispatchEvent(new CustomEvent(MENU_CLOSE_EVENT));
}
