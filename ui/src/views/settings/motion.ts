import React from "react";

// The Settings page's motion: one panel growing or shrinking as one thing.
//
// A panel opens, closes, grows a footer or loses one. Its card is drawn by a
// layer of its own (`[data-panel-bg]`), so the card can morph without the
// content being cut: its bottom edge moves from the old height to the new one
// (`morphCard`), while the rows inside move as the setup's rows do. A row that stays glides to
// its new place, a row that is new unfolds, and a row that left folds away
// through an inert copy. Every panel below glides with it. Only `transform`,
// `clip-path` and `opacity` are animated, in one time and one easing, and
// nothing moves for a person who asked for reduced motion.
//
// EVERYTHING STARTS FROM WHERE IT IS DRAWN. Just before React changes the
// page, `PanelMotion` notes where each row is drawn at that moment, a glide in
// flight included. Once the change is drawn, a row whose place did not change
// keeps the glide it has; a row whose place changed glides from where it was
// drawn to its new place.

export const MORPH_MS = 320;
export const MORPH_EASE = "cubic-bezier(.2,.8,.2,1)";

/** Room for a card's shadow outside the clip. The console's card shadow
 *  reaches 26 px below a card. */
const SHADOW = 32;

/** A line under a section is replaced by the next line in the same place: it
 *  gives way, rather than fading through the new one. */
const GIVES_WAY = /^ln-/;

function calm(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** A row's key on the page: its panel's, then its own. Two sections draw rows
 *  with the same `data-k` (their controls come from one component), and one
 *  opening as another closes is two rows, not one that moved. */
function keyOf(node: Element): string {
  const own = node.getAttribute("data-k") ?? "";
  if (node.hasAttribute("data-panel")) return own;
  const panel = node.closest("[data-panel]")?.getAttribute("data-k") ?? "";
  return `${panel}/${own}`;
}

/** The rows of `root`, in the order of the page: the HTML elements with a
 *  `data-k`, other than the copies that fold away. */
function rowsOf(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll("[data-k]")).filter(
    (node): node is HTMLElement => node instanceof HTMLElement && !node.closest("[data-ghost]"),
  );
}

/** The row a row sits in, or null at the top of `root`. */
function rowAbove(node: HTMLElement, root: HTMLElement): HTMLElement | null {
  const up = node.parentElement?.closest<HTMLElement>("[data-k]") ?? null;
  return up && root.contains(up) && up !== root ? up : null;
}

/** Where a row is drawn, relative to `root`, just before a change. */
interface Drawn {
  node: HTMLElement;
  top: number;
  left: number;
  width: number;
  height: number;
  /** A panel's card: where its bottom edge is drawn, from the panel's top. */
  edge: number;
}

/** How a row that is moving is drawn at one moment: what a copy of it starts
 *  from, so it folds away from the state it was in. */
interface Frozen {
  opacity: string;
  clip: string;
  transform: string;
}

/** What `PanelMotion` notes just before a change. */
interface Snapshot {
  drawn: Map<string, Drawn>;
  /** The rows with an animation in flight, as they are drawn. */
  frozen: Map<HTMLElement, Frozen>;
}

/** Where a row rests, once a change is drawn: its place in the row it sits
 *  in (`rel`), with no glide. */
interface Rest {
  rel: number;
  parent: string | null;
  height: number;
}

/** How far a glide in flight has a row from where it rests. */
function shiftOf(node: HTMLElement): number {
  const transform = getComputedStyle(node).transform;
  if (!transform || transform === "none") return 0;
  try {
    return new DOMMatrixReadOnly(transform).m42;
  } catch {
    return 0;
  }
}

/** Fold a row away where it stood: the way it unfolded, run backwards, on a
 *  copy that takes no room and that nothing can reach. The copy starts from
 *  the state the row was drawn in: half unfolded, it folds from there, and a
 *  row inside it that was moving is held where it was. */
function fold(within: HTMLElement, row: Drawn, ghosts: Set<HTMLElement>, frozen: Map<HTMLElement, Frozen>): void {
  const ghost = row.node.cloneNode(true) as HTMLElement;
  const originals = [row.node, ...Array.from(row.node.querySelectorAll<HTMLElement>("*"))];
  const copies = [ghost, ...Array.from(ghost.querySelectorAll<HTMLElement>("*"))];
  copies.forEach((node, index) => {
    for (const name of ["data-k", "data-fid", "id", "role", "tabindex", "data-panel"]) node.removeAttribute(name);
    // An unfolding that was under way is not run again on the copy.
    node.classList.remove("su-reveal");
    const was = frozen.get(originals[index] as HTMLElement);
    if (was && index > 0) Object.assign(node.style, { opacity: was.opacity, clipPath: was.clip, transform: was.transform });
    // A copy takes the value a field holds. A code that was used, or a key,
    // is not drawn again while the copy folds away.
    if (node instanceof HTMLInputElement && (node.type === "password" || node.autocomplete === "one-time-code")) {
      node.value = "";
      node.removeAttribute("value");
    }
  });
  ghost.inert = true;
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("data-ghost", "");
  const own = frozen.get(row.node);
  const clip = own && own.clip !== "none" ? own.clip : "inset(0 0 0 0)";
  const opacity = own ? Number(own.opacity) : 1;
  Object.assign(ghost.style, {
    position: "absolute",
    top: `${row.top}px`,
    left: `${row.left}px`,
    width: `${row.width}px`,
    margin: "0",
    pointerEvents: "none",
    zIndex: "3",
  });
  within.appendChild(ghost);
  ghosts.add(ghost);
  const gone = ghost.animate(
    [
      { opacity, clipPath: clip },
      { opacity: 0, clipPath: "inset(0 0 100% 0)" },
    ],
    { duration: MORPH_MS, easing: MORPH_EASE, fill: "forwards" },
  );
  const remove = (): void => {
    ghost.remove();
    ghosts.delete(ghost);
  };
  gone.finished.then(remove, remove);
}

/** The card morph each panel has in flight, so a new one replaces it. */
interface CardMove {
  body: Animation;
  edge: Animation;
}
const cardMoves = new WeakMap<HTMLElement, CardMove>();

/** A card at rest: one layer, the panel's size, with nothing clipped. */
function cardAtRest(body: HTMLElement, edge: HTMLElement): void {
  body.style.bottom = "";
  edge.style.bottom = "";
  edge.style.visibility = "";
  edge.style.clipPath = "";
}

/** End a panel's card morph where it is: its edge is drawn where the panel
 *  now ends. */
function stopCard(panel: HTMLElement): void {
  const move = cardMoves.get(panel);
  if (!move) return;
  cardMoves.delete(panel);
  move.body.cancel();
  move.edge.cancel();
  const body = panel.querySelector<HTMLElement>(":scope > [data-panel-bg]");
  const edge = panel.querySelector<HTMLElement>(":scope > [data-panel-edge]");
  if (body && edge) cardAtRest(body, edge);
}

/**
 * A panel's card, from one height to another, as one card whose bottom edge
 * moves: its border, its rounded corners and its shadow stay whole.
 *
 * The card is drawn twice while it morphs. The panel's own card
 * (`[data-panel-bg]`) is clipped just above where the bottom edge is drawn,
 * leaving room for its shadow on the other three sides. A second, identical
 * card (`[data-panel-edge]`) shows only its bottom edge, a corner's height of
 * it with the shadow under it, and that edge is moved with `transform` to where
 * the bottom is drawn. Both cards are as tall as the taller of the two
 * heights, so neither is stretched. At the end the second card is hidden and
 * the first is the panel's size, which draws the same pixels.
 */
function morphCard(panel: HTMLElement, from: number, to: number): void {
  const body = panel.querySelector<HTMLElement>(":scope > [data-panel-bg]");
  const edge = panel.querySelector<HTMLElement>(":scope > [data-panel-edge]");
  if (!body || !edge) return;
  const was = cardMoves.get(panel);
  if (was) {
    was.body.cancel();
    was.edge.cancel();
  }
  const radius = parseFloat(getComputedStyle(body).borderBottomLeftRadius) || 0;
  const tall = Math.max(from, to);
  // While it shrinks, the card reaches below the panel, which is already its
  // new size.
  const below = tall - to;
  body.style.bottom = below > 0 ? `-${below}px` : "";
  edge.style.bottom = body.style.bottom;
  edge.style.visibility = "visible";
  const side = `-${SHADOW}px`;
  edge.style.clipPath = `inset(${tall - radius}px ${side} ${side} ${side})`;
  const timing: KeyframeAnimationOptions = { duration: MORPH_MS, easing: MORPH_EASE, fill: "forwards" };
  const move: CardMove = {
    body: body.animate(
      [
        { clipPath: `inset(${side} ${side} ${tall - from + radius}px ${side})` },
        { clipPath: `inset(${side} ${side} ${tall - to + radius}px ${side})` },
      ],
      timing,
    ),
    edge: edge.animate([{ transform: `translateY(${from - tall}px)` }, { transform: `translateY(${to - tall}px)` }], timing),
  };
  cardMoves.set(panel, move);
  const done = (): void => {
    if (cardMoves.get(panel) !== move) return;
    cardMoves.delete(panel);
    cardAtRest(body, edge);
    move.body.cancel();
    move.edge.cancel();
  };
  move.body.finished.then(done, () => {});
}

interface PanelMotionProps {
  /** False while the page is not shown: nothing is measured or moved. */
  active: boolean;
  className: string;
  /** Given the element the rows are drawn in. It must be positioned: a row
   *  that folds away is drawn over its old place inside it. */
  rootRef: React.MutableRefObject<HTMLDivElement | null>;
  onKeyDownCapture?: React.KeyboardEventHandler<HTMLDivElement>;
  children?: React.ReactNode;
}

/**
 * The element the panels are drawn in, which animates what changed in it
 * since the last draw. Rows are the HTML elements with a `data-k`; a panel is
 * a row with `data-panel`, whose card is its child with `data-panel-bg`.
 *
 * It is a class for one reason: `getSnapshotBeforeUpdate` runs after React
 * has worked out a change and before the page shows it, so it can see where
 * every row is drawn at that moment.
 */
export class PanelMotion extends React.Component<PanelMotionProps, unknown, Snapshot | null> {
  private root: HTMLDivElement | null = null;
  /** Where each row rested after the last change, by key. */
  private rest: Map<string, Rest> | null = null;
  private glides = new Map<HTMLElement, Animation>();
  private ghosts = new Set<HTMLElement>();

  private readonly attach = (node: HTMLDivElement | null): void => {
    this.root = node;
    this.props.rootRef.current = node;
  };

  componentDidMount(): void {
    this.rest = this.props.active ? this.measure() : null;
  }

  componentWillUnmount(): void {
    for (const glide of this.glides.values()) glide.cancel();
    this.glides.clear();
    for (const ghost of this.ghosts) ghost.remove();
    this.ghosts.clear();
  }

  getSnapshotBeforeUpdate(previous: PanelMotionProps): Snapshot | null {
    const root = this.root;
    if (!root || !previous.active || !this.props.active || !this.rest || calm()) return null;
    const base = root.getBoundingClientRect();
    const drawn = new Map<string, Drawn>();
    const frozen = new Map<HTMLElement, Frozen>();
    for (const node of rowsOf(root)) {
      const box = node.getBoundingClientRect();
      // A card that is morphing has its bottom edge where its second card
      // is drawn; one at rest, at the panel's foot.
      const edge = node.hasAttribute("data-panel") && cardMoves.has(node)
        ? (node.querySelector(":scope > [data-panel-edge]")?.getBoundingClientRect().bottom ?? box.bottom) - box.top
        : box.height;
      drawn.set(keyOf(node), {
        node,
        top: box.top - base.top,
        left: box.left - base.left,
        width: box.width,
        height: box.height,
        edge,
      });
      if (node.getAnimations().length > 0) {
        const style = getComputedStyle(node);
        frozen.set(node, { opacity: style.opacity, clip: style.clipPath, transform: style.transform });
      }
    }
    return { drawn, frozen };
  }

  componentDidUpdate(_previous: PanelMotionProps, _state: unknown, snapshot: Snapshot | null): void {
    if (!this.props.active || !this.root) {
      this.rest = null;
      return;
    }
    const before = this.rest;
    const now = this.measure();
    this.rest = now;
    if (snapshot && before) this.play(snapshot, before, now);
  }

  /** Where every row rests now, with the glides in flight taken out. */
  private measure(): Map<string, Rest> {
    const root = this.root;
    const out = new Map<string, Rest>();
    if (!root) return out;
    const base = root.getBoundingClientRect().top;
    // How far each row is drawn from where it rests: its own glide, and those
    // of the rows it sits in.
    const shift = new Map<HTMLElement, number>();
    const top = new Map<HTMLElement, number>();
    for (const node of rowsOf(root)) {
      const above = rowAbove(node, root);
      const own = this.glides.has(node) ? shiftOf(node) : 0;
      const total = own + (above ? (shift.get(above) ?? 0) : 0);
      shift.set(node, total);
      const box = node.getBoundingClientRect();
      const at = box.top - base - total;
      top.set(node, at);
      out.set(keyOf(node), {
        rel: at - (above ? (top.get(above) ?? 0) : 0),
        parent: above ? keyOf(above) : null,
        height: box.height,
      });
    }
    return out;
  }

  /** Move every row from where it was drawn to where it rests now. */
  private play({ drawn, frozen }: Snapshot, before: Map<string, Rest>, now: Map<string, Rest>): void {
    const root = this.root as HTMLDivElement;
    // The rows that are gone and fold away. One that sat inside a row that is
    // gone too is carried by that row's copy.
    const folding: Drawn[] = [];
    for (const [key, row] of drawn) {
      if (now.has(key) || GIVES_WAY.test(key.slice(key.indexOf("/") + 1))) continue;
      const parent = before.get(key)?.parent ?? null;
      if (parent !== null && !now.has(parent)) continue;
      folding.push(row);
    }
    const base = root.getBoundingClientRect();
    // How far each row starts from where it rests, its own glide and those of
    // the rows it sits in: a row inside a row that moves is carried by it.
    const start = new Map<HTMLElement, number>();
    const opened = new Set<HTMLElement>();
    for (const node of rowsOf(root)) {
      const key = keyOf(node);
      const above = rowAbove(node, root);
      const carried = above ? (start.get(above) ?? 0) : 0;
      const was = drawn.get(key);
      const rested = before.get(key);
      const rests = now.get(key) as Rest;
      if (!was || !rested) {
        // New. Inside a row that is new too, it is carried by that row.
        start.set(node, carried);
        if (above && (opened.has(above) || above.closest(".su-reveal"))) {
          opened.add(node);
          continue;
        }
        opened.add(node);
        // Where it unfolds, a row that is gone may still be folding away.
        // Two rows never fade through each other in the same pixels: this
        // one waits until that one is gone.
        const box = node.getBoundingClientRect();
        const top = (topOf(node, now, root) ?? box.top - base.top) + carried;
        const left = box.left - base.left;
        const meets = folding.some(
          (gone) =>
            Math.min(top + rests.height, gone.top + gone.height) - Math.max(top, gone.top) > 1 &&
            Math.min(left + box.width, gone.left + gone.width) - Math.max(left, gone.left) > 1,
        );
        if (meets) {
          node.style.animationDelay = `${MORPH_MS}ms`;
          node.style.animationFillMode = "backwards";
        }
        node.classList.add("su-reveal");
        const ended = (event: AnimationEvent): void => {
          if (event.target !== node) return;
          node.classList.remove("su-reveal");
          node.style.animationDelay = "";
          node.style.animationFillMode = "";
          node.removeEventListener("animationend", ended);
        };
        node.addEventListener("animationend", ended);
        continue;
      }
      // A card whose height changed morphs from where its edge is drawn: a
      // morph that was under way goes on from there, the other way or
      // further. One whose height did not change keeps the morph it has.
      if (node.hasAttribute("data-panel") && Math.abs(rests.height - rested.height) >= 1) {
        if (Math.abs(was.edge - rests.height) >= 1) morphCard(node, was.edge, rests.height);
        else stopCard(node);
      }
      const glide = this.glides.get(node);
      const own = glide ? shiftOf(node) : 0;
      if (rests.parent === rested.parent && Math.abs(rests.rel - rested.rel) < 1) {
        // Its place did not change: a glide in flight goes on as it is.
        start.set(node, carried + own);
        continue;
      }
      // From where it was drawn, to where it rests now.
      const restTop = (above ? (topOf(above, now, root) ?? 0) : 0) + rests.rel;
      const from = was.top - restTop - carried;
      glide?.cancel();
      this.glides.delete(node);
      start.set(node, carried + from);
      if (Math.abs(from) < 1) continue;
      const next = node.animate([{ transform: `translateY(${from}px)` }, { transform: "none" }], {
        duration: MORPH_MS,
        easing: MORPH_EASE,
      });
      this.glides.set(node, next);
      const ended = (): void => {
        if (this.glides.get(node) === next) this.glides.delete(node);
      };
      next.finished.then(ended, ended);
    }
    for (const row of folding) fold(root, row, this.ghosts, frozen);
  }

  render(): React.ReactNode {
    return React.createElement(
      "div",
      { className: this.props.className, ref: this.attach, onKeyDownCapture: this.props.onKeyDownCapture },
      this.props.children,
    );
  }
}

/** Where a row rests relative to `root`, from the rests of the rows it sits
 *  in. */
function topOf(node: HTMLElement, rests: Map<string, Rest>, root: HTMLElement): number | null {
  let top = 0;
  let at: HTMLElement | null = node;
  while (at) {
    const rest = rests.get(keyOf(at));
    if (!rest) return null;
    top += rest.rel;
    at = rowAbove(at, root);
  }
  return top;
}
