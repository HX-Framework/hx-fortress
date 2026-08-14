import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { READONLY_REFUSAL_COPY } from "../../src/ui/copy";
import { MENU_CLOSE_EVENT } from "./lib/util";
import { useOperator } from "./state";
import type { Resource } from "./hooks";

// ── Custom dropdown menu (gpill + menu) — closes on pick, outside click, Esc.
// The open menu is PORTALED to <body>, fixed-positioned and given a z-index
// above dialogs, so it floats over everything and never grows a scroll
// container. It is placed by measuring the real menu height after mount: opens
// downward when it fits, flips up when it does not, clamps + scrolls internally
// when neither side has room. Always positioned via `top` (never `bottom`), so
// it never conflicts with the .menu class's own `top` rule.
export interface MenuItem {
  key: string;
  label: string;
}
interface MenuPos {
  left: number;
  top: number;
  minWidth: number;
  maxHeight: number;
}
export function MenuPill(props: {
  label?: string;
  value: string;
  mini?: boolean;
  items: MenuItem[];
  selKey: string;
  onPick: (key: string) => void;
  style?: React.CSSProperties;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Provisional downward placement so the menu can render and be measured.
  const openMenu = (): void => {
    const el = pillRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: r.left,
      top: r.bottom + 8,
      minWidth: Math.max(r.width, 230),
      maxHeight: window.innerHeight - r.bottom - 16,
    });
    setOpen(true);
  };

  // Correct the placement once the real menu height is known.
  useLayoutEffect(() => {
    if (!open || !menuRef.current || !pillRef.current) return;
    const r = pillRef.current.getBoundingClientRect();
    const h = menuRef.current.scrollHeight;
    const spaceBelow = window.innerHeight - r.bottom - 16;
    const spaceAbove = r.top - 16;
    let top: number;
    let maxHeight: number;
    if (h <= spaceBelow || spaceBelow >= spaceAbove) {
      top = r.bottom + 8;
      maxHeight = spaceBelow;
    } else {
      maxHeight = spaceAbove;
      top = Math.max(8, r.top - 8 - Math.min(h, spaceAbove));
    }
    setPos((p) => (p && (p.top !== top || p.maxHeight !== maxHeight) ? { ...p, top, maxHeight } : p));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (pillRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const close = (): void => setOpen(false);
    document.addEventListener("click", onDoc, true);
    window.addEventListener(MENU_CLOSE_EVENT, close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("click", onDoc, true);
      window.removeEventListener(MENU_CLOSE_EVENT, close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <div
      className={props.mini ? "gpill mini" : "gpill"}
      ref={pillRef}
      style={props.style}
      onClick={() => (open ? setOpen(false) : openMenu())}
    >
      {props.label ? (
        <>
          <span className="lbl">{props.label}</span>{" "}
        </>
      ) : null}
      <span>{props.value}</span> <span className="caret"></span>
      {open && pos
        ? createPortal(
            <div
              className="menu openm"
              ref={menuRef}
              style={{
                position: "fixed",
                left: pos.left,
                top: pos.top,
                bottom: "auto",
                minWidth: pos.minWidth,
                maxHeight: pos.maxHeight,
                overflowY: "auto",
                zIndex: 200,
              }}
            >
              {props.items.map((it) => (
                <button
                  key={it.key}
                  className={it.key === props.selKey ? "sel" : undefined}
                  onClick={() => {
                    setOpen(false);
                    props.onPick(it.key);
                  }}
                >
                  {it.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export function SearchBox(props: {
  placeholder: string;
  value: string;
  onInput: (value: string) => void;
  compact?: boolean;
  style?: React.CSSProperties;
}): React.ReactElement {
  return (
    <div className={props.compact ? "search compact" : "search"} style={props.style}>
      <svg
        className="ic s"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        style={{ color: "var(--text-subtle)" }}
      >
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
      <input
        placeholder={props.placeholder}
        value={props.value}
        onChange={(e) => props.onInput(e.target.value)}
      />
    </div>
  );
}

/** Terminal-style output. Takes TEXT, never markup: the lines it renders come
 *  from a fortress, and a console that interpolated them into HTML would be
 *  rendering whatever an operator typed into a log line. */
export function Term({ lines }: { lines: readonly string[] }): React.ReactElement | null {
  if (lines.length === 0) return null;
  return <div className="term on">{lines.join("\n")}</div>;
}

export function Panel(props: {
  title?: string;
  sub?: string;
  id?: string;
  panelKey?: string;
  register?: (key: string, el: HTMLElement | null) => void;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div
      className={props.className ? `panel ${props.className}` : "panel"}
      id={props.id}
      ref={(el) => props.panelKey && props.register?.(props.panelKey, el)}
    >
      {props.title ? <h2>{props.title}</h2> : null}
      {props.sub ? <div className="h2sub">{props.sub}</div> : null}
      {props.children}
    </div>
  );
}

export function FactRow(props: {
  k: React.ReactNode;
  v: React.ReactNode;
  vs?: React.ReactNode;
  tone?: "ok" | "warn";
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="frw">
      <span className="k">{props.k}</span>
      <span>
        <span className="v">{props.v}</span>
        {props.vs === undefined ? null : (
          <div className={props.tone ? `vs ${props.tone}v` : "vs"}>{props.vs}</div>
        )}
      </span>
      {props.action ?? null}
    </div>
  );
}

export function Stat(props: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  onClick?: () => void;
}): React.ReactElement {
  return (
    <div className="stat">
      <span className="lbl">{props.label}</span>
      <div className={props.onClick ? "big statlink" : "big"} onClick={props.onClick}>
        {props.value}
      </div>
      {props.sub === undefined ? null : <div className="sub">{props.sub}</div>}
    </div>
  );
}

/** Nothing to render from yet — still in flight, or it failed and has no last
 *  good answer to fall back on. Either way the page must not do arithmetic on
 *  it. */
export function awaiting(resource: { data: unknown }): boolean {
  return resource.data === null;
}

/**
 * What a view shows instead of itself while it has no data.
 *
 * A first load that FAILED is a different screen from one still in flight, and
 * both are different from zero: `?? 0` on a headline figure turns "we have not
 * been told" into "this fortress holds nothing", which is a claim, not a
 * placeholder.
 */
export function ViewFallback({
  resources,
}: {
  resources: readonly { data: unknown; error: string | null; reload: () => void }[];
}): React.ReactElement {
  const failed = resources.find((r) => r.data === null && r.error !== null);
  if (failed) {
    return (
      <div className="banner warn">
        <span className="badge">!</span>
        <span className="btxt">{failed.error}</span>
        <button className="btn" onClick={failed.reload}>
          Try again
        </button>
      </div>
    );
  }
  return <ViewLoading />;
}

/**
 * The view's whole content area, while its data is still on the way.
 *
 * Rendered INSTEAD of the page, because the alternative is worse than a wait:
 * every headline number on this console is a `?? 0` away from stating that a
 * fortress holds nothing, and a tile that reads "0 sessions · unavailable"
 * during a routine first paint is not slower than the truth, it is a different
 * claim. The shell and the menu stay, so the console never looks gone.
 */
export function ViewLoading({ what }: { what?: string }): React.ReactElement {
  return (
    <div className="vload">
      <div className="spin" />
      <div className="vloadtxt">{what ?? "Reading the fortress…"}</div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="empty">{children}</div>;
}

/**
 * The four states of a panel that reads the fortress, rendered once.
 *
 * A panel with no answer says so and says why. A panel whose refresh failed
 * keeps its numbers AND wears a banner, because silently ageing figures on a
 * compliance surface is the failure this component exists to prevent.
 */
export function Loaded<T>(props: {
  resource: Resource<T>;
  children: (data: T) => React.ReactNode;
  /** What to say when the fortress answered with nothing at all. */
  emptyWhen?: (data: T) => boolean;
  empty?: React.ReactNode;
}): React.ReactElement {
  const { data, error, stale, loading } = props.resource;
  if (data === null) {
    if (error !== null) {
      return (
        <div className="banner warn">
          <span className="badge">!</span>
          <span className="btxt">{error}</span>
          <button className="btn" onClick={props.resource.reload}>
            Try again
          </button>
        </div>
      );
    }
    return <Empty>{loading ? "Reading the fortress…" : "Nothing to show yet."}</Empty>;
  }
  if (props.emptyWhen?.(data) && props.empty !== undefined) {
    return <>{props.empty}</>;
  }
  return (
    <>
      {stale && error !== null ? (
        <div className="banner warn" style={{ marginBottom: 14 }}>
          <span className="badge">!</span>
          <span className="btxt">
            <b>These figures are no longer current.</b> {error}
          </span>
          <button className="btn" onClick={props.resource.reload}>
            Retry
          </button>
        </div>
      ) : null}
      {props.children(data)}
    </>
  );
}

/**
 * A control that changes something on the fortress.
 *
 * A readonly account sees it, disabled, carrying the server's own refusal
 * sentence — the same words the route would answer with. Hiding it instead would
 * leave an auditor unable to tell a capability they lack from one the console
 * does not have.
 */
export function MutationControl(props: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  small?: boolean;
  /** Why this control is unavailable for reasons other than the role. */
  reason?: string;
}): React.ReactElement {
  const operator = useOperator();
  const blocked = !operator || props.disabled === true;
  const why = !operator ? READONLY_REFUSAL_COPY : props.reason;
  const className = [
    "btn",
    props.danger ? "danger" : "",
    props.small ? "sm" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
      <button className={className} disabled={blocked} onClick={props.onClick}>
        {props.label}
      </button>
      {blocked && why ? (
        <span style={{ fontSize: 13, color: "var(--text-subtle)", textAlign: "right", maxWidth: 260 }}>
          {why}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The confirmation every destructive or host-affecting action passes through.
 *
 * One dialog rather than a per-panel one, so the words a person reads before
 * stopping a fortress are written in one place and cannot drift into a softer
 * version somewhere else. It states what will happen to the thing in front of
 * them, not a generic "are you sure".
 */
export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
}

export function useConfirm(): [
  React.ReactElement | null,
  (request: ConfirmRequest) => Promise<boolean>,
] {
  const [pending, setPending] = useState<
    (ConfirmRequest & { resolve: (ok: boolean) => void }) | null
  >(null);
  const ask = (request: ConfirmRequest): Promise<boolean> =>
    new Promise<boolean>((resolve) => setPending({ ...request, resolve }));
  const close = (ok: boolean): void => {
    pending?.resolve(ok);
    setPending(null);
  };
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  // The listener reads the CURRENT pending through a ref, so the effect can
  // depend on nothing but "is a dialog open" — see the dependency list below.
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const open = pending !== null;

  // The console's own cheatsheet says "Esc — Close dialogs and menus", and this
  // dialog listened for nothing: Escape fell through to the app-level handler,
  // which knows about the shortcuts overlay and the menus but not about this.
  // CAPTURE phase, so it wins over the number-key view shortcuts — one of those
  // hid the section owning the dialog and left `ask()` unsettled forever.
  //
  // KEYED ON `open`, not on every render. A dep-less effect re-runs after each
  // render of the host component, and these panels poll every ten seconds — so
  // the focus call below fired on a timer and yanked focus back to the
  // confirming control while somebody was Tabbing to Cancel, on dialogs whose
  // confirm button is the destructive one.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        pendingRef.current?.resolve(false);
        setPending(null);
        return;
      }
      // Every other key stays inside the dialog while it is open.
      if (event.key !== "Tab") event.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    // Focus lands on the confirming control ONCE, when the dialog appears,
    // before any user action — so the first key press acts rather than summoning
    // a selection, and nothing moves it afterwards.
    confirmRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  const element = pending ? (
    <div className="overlayw open" onClick={() => close(false)} role="dialog" aria-modal="true">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="mhead">
          <div className="row1">
            <h3>{pending.title}</h3>
            <button className="x" onClick={() => close(false)} aria-label="Close">
              ×
            </button>
          </div>
          <div className="msub">{pending.body}</div>
        </div>
        <div className="mfoot">
          <span className="grow"></span>
          <button className="btn ghost" onClick={() => close(false)}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            className={pending.danger ? "btn danger" : "btn"}
            onClick={() => close(true)}
          >
            {pending.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  ) : null;
  return [element, ask];
}

/** The 6s result line the console uses to answer an action in place. */
export function useResultLine(): [
  { text: string; on: boolean; warn: boolean },
  (message: string, warn?: boolean) => void,
] {
  const [state, setState] = useState({ text: "", on: false, warn: false });
  const timer = useRef<number | undefined>(undefined);
  const show = (message: string, warn?: boolean): void => {
    setState({ text: message, on: true, warn: warn === true });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState((s) => ({ ...s, on: false })), 6000);
  };
  return [state, show];
}

export function ResultLine({
  state,
}: {
  state: { text: string; on: boolean; warn: boolean };
}): React.ReactElement {
  return (
    <div className={`resultline${state.warn ? " warnr" : ""}${state.on ? " on" : ""}`}>
      {state.text}
    </div>
  );
}
