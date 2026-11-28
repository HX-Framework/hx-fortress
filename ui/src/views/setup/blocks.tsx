import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { reachLabel } from "../../../../src/setup/reach";
import { answerAt, answerText, wordsOf, type SetupAnswers } from "../../../../src/setup/answers";
import {
  keysAreTyped,
  placeInfo,
  whenHolds,
  type SetupBlock,
  type SetupField,
  type SetupOption,
  type SetupStep,
} from "../../../../src/setup/list";
import type { CheckLine, Fact, PlaceRow, SetupDerived, SetupFrame, StepCheck } from "../../../../src/setup/view";

// The controls of one step of the setup, drawn from the list.
//
// Nothing here holds a question, an option or a label of its own: every word
// comes from the step it is given (one step of `visibleList`), from the
// frame and from what the host worked out. It knows nothing of the stepper or
// of the footer, so a page that shows one step's controls in a panel draws
// them with `StepControls` as they are.
//
// Every row that can come, go or move has a `data-k`, and every control that
// can hold the keyboard a `data-fid`. A page that wants motion measures the
// rows by `data-k`; one that moves the keyboard finds a control by `data-fid`.

/** How an answer changed: typed into a field, or picked (an option, a tile, a
 *  switch, a module or a menu). A page checks the first when the typing
 *  pauses, and the second at once. */
export type SetHow = "type" | "pick";

export interface StepControlsProps {
  /** One step of `visibleList(...)`. */
  step: SetupStep;
  frame: SetupFrame;
  answers: SetupAnswers;
  derived: SetupDerived;
  /** The lines to show. A line that refuses (`ok` false and not `soft`)
   *  shows over its field, or under the step when it has no field here. A
   *  line that does not refuse shows beside its field, or under the step. */
  check: StepCheck | null;
  /** Change one answer. */
  onSet: (path: string, value: string | boolean, how: SetHow) => void;
  /** A key a person typed into a field, in the install. The caller sends it
   *  on; the field forgets it. */
  onTyped: (path: string, value: string) => void;
  /** A field lost the keyboard. */
  onLeave?: (path: string) => void;
  /** Why nothing here can be changed: a read-only session, in the server's
   *  own words. Every control is then disabled and carries the sentence as
   *  its tooltip. Left out, everything can be changed. */
  disabled?: string;
  /** True while a save of these answers is on its way (the console's Settings
   *  page): every control holds its value and takes no change. A field is
   *  read-only, and a switch, an option, a tile or a menu does nothing, but
   *  each keeps the keyboard. Left out, as the setup leaves it, nothing is
   *  held. */
  saving?: boolean;
  /** What a page draws for a `connect` block (the one-time id that connects
   *  HX Fortress to a control plane). Left out, nothing. */
  connect?: React.ReactNode;
}

interface Ctx extends StepControlsProps {
  read: (path: string) => string;
  words: Record<string, string>;
  /** Fields that hold a typed key, by path. */
  typed: ReadonlySet<string>;
}

const Context = createContext<Ctx>(null as unknown as Ctx);
const useCtx = (): Ctx => useContext(Context);

/** A check's line beside a field is a word or two. A sentence goes under it. */
const BESIDE_MAX = 26;

/** What a filled key field shows in place of the key. */
const DOTS = "••••••••••";

const EASE = "cubic-bezier(.2,.8,.2,1)";

export const CHECK_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 8.5l3.2 3.2L13 4.8" />
  </svg>
);

const LOCK_ICON = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2.2" y="5.3" width="7.6" height="5.2" rx="1.3" />
    <path d="M4 5.3V4a2 2 0 0 1 4 0v1.3" />
  </svg>
);

export function Spinner(): React.ReactElement {
  return <span className="su-spin" aria-hidden="true" />;
}

function refuses(line: CheckLine): boolean {
  return !line.ok && !line.soft;
}

/** A line about a place's sign-in is said by the place's own row, which
 *  offers the command and Check Again. */
function shownLine(line: CheckLine): boolean {
  return line.needs !== "signIn";
}

function linesAt(check: StepCheck | null, path: string): CheckLine[] {
  return (check?.lines ?? []).filter((line) => line.path === path && shownLine(line));
}

/** A sentence from the host, with what is typed at a command line set apart.
 *  The host marks it with backticks. Text only: nothing is set as markup. */
export function Words({ text }: { text: string }): React.ReactElement {
  return (
    <>
      {text.split("`").map((part, index) =>
        index % 2 === 1 ? (
          <code className="su-code" key={index}>
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

// ── Copy ─────────────────────────────────────────────────────────────────────

function copyText(text: string): Promise<boolean> {
  const fallback = (): boolean => {
    // A page served over plain http to another machine has no clipboard API.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    Object.assign(area.style, { position: "fixed", top: "0", left: "0", opacity: "0", pointerEvents: "none" });
    document.body.appendChild(area);
    const before = document.activeElement as HTMLElement | null;
    area.select();
    let done = false;
    try {
      done = document.execCommand("copy");
    } catch {
      done = false;
    }
    area.remove();
    before?.focus({ preventScroll: true });
    return done;
  };
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      return navigator.clipboard.writeText(text).then(
        () => true,
        () => fallback(),
      );
    }
  } catch {
    // Fall through.
  }
  return Promise.resolve(fallback());
}

/** A small button that copies a line of text, and says so for a moment. */
export function CopyButton({ text, fid }: { text: string; fid: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      className="su-btn ghost sm"
      data-fid={fid}
      onClick={() => {
        void copyText(text).then((done) => {
          if (!done) return;
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// ── Small pieces of a row ────────────────────────────────────────────────────

/** A field the host's environment decides: the variable that decides it. */
function Pin({ variable }: { variable: string }): React.ReactElement {
  return (
    <span className="su-chk src su-pin">
      {LOCK_ICON}
      <span className="mono">{variable}</span>
    </span>
  );
}

function CheckTag({ line }: { line: CheckLine }): React.ReactElement {
  return (
    <span className={line.ok ? "su-chk ok" : "su-chk bad"}>
      <i />
      <Words text={line.text} />
    </span>
  );
}

function Under({ lines }: { lines: CheckLine[] }): React.ReactElement {
  return (
    <>
      {lines.map((line) => (
        <div className={line.ok ? "su-under ok" : "su-under"} key={line.text}>
          <Words text={line.text} />
        </div>
      ))}
    </>
  );
}

/** The lines about a control that is not a field (a module's switch, a
 *  switch that stands alone, a choice drawn as tiles), under it. The setup's
 *  own checks name no such control; the console's Settings page says there
 *  when someone else saved its answer, or when a save refused it. */
function RowLines({ path }: { path: string }): React.ReactElement | null {
  const s = useCtx();
  const lines = linesAt(s.check, path);
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((line) => (
        <div
          className={refuses(line) ? "su-under su-rowline bad" : line.ok ? "su-under su-rowline ok" : "su-under su-rowline"}
          key={line.text}
          role={refuses(line) ? "alert" : undefined}
        >
          <Words text={line.text} />
        </div>
      ))}
    </>
  );
}

/** True for a click on a line of `RowLines`. The lines are drawn in the
 *  switch's row, inside the element that flips it, so the row's click passes
 *  them by. */
function onLine(target: EventTarget): boolean {
  return target instanceof Element && target.closest(".su-rowline") !== null;
}

/** A refused line, over its field. It takes no room, so nothing moves when it
 *  comes or goes. */
function Refusal({ line, id }: { line: CheckLine; id: string }): React.ReactElement {
  return (
    <div className="su-err" role="alert" id={id}>
      <Words text={line.text} />
    </div>
  );
}

function fieldDomId(path: string): string {
  return `su-${path.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** The lines of a field: the one that refuses, one short one beside it, and
 *  the rest under it. */
function fieldLines(check: StepCheck | null, path: string): { refused: CheckLine | null; beside: CheckLine | null; under: CheckLine[] } {
  const lines = linesAt(check, path);
  const refused = lines.find(refuses) ?? null;
  const notes = lines.filter((line) => !refuses(line));
  const beside = notes.find((line) => line.text.length <= BESIDE_MAX) ?? null;
  return { refused, beside, under: notes.filter((line) => line !== beside) };
}

// ── Fields ───────────────────────────────────────────────────────────────────

/** A field that holds a key the person types: the install's. Anywhere else a
 *  key is given by the name it has in the key store, in a plain field. A key
 *  field with no name to give the typed key (`typedAs`) is a name too. */
function typesKey(frame: SetupFrame, field: SetupField): boolean {
  return field.kind === "key" && keysAreTyped(frame) && Boolean(field.typedAs);
}

function FieldRow({ field }: { field: SetupField }): React.ReactElement | null {
  const s = useCtx();
  if (!whenHolds(field.when, s.read)) return null;
  if (field.options) return <MenuField field={field} />;
  if (typesKey(s.frame, field)) return <KeyField field={field} />;
  return <TextField field={field} />;
}

function TextField({ field }: { field: SetupField }): React.ReactElement {
  const s = useCtx();
  const pinned = s.frame.pinned[field.path];
  const locked = pinned !== undefined || s.disabled !== undefined || s.saving === true;
  const isList = field.kind === "list";
  // A list is typed as text. While the field holds the keyboard it keeps the
  // text as typed, so a comma at the end is not taken away mid-word.
  const [raw, setRaw] = useState<string | null>(null);
  const value = isList && raw !== null ? raw : s.read(field.path);
  const { refused, beside, under } = fieldLines(s.check, field.path);
  const id = fieldDomId(field.path);
  const tag =
    pinned !== undefined ? (
      <Pin variable={pinned} />
    ) : beside ? (
      <CheckTag line={beside} />
    ) : field.tag ? (
      <span className="su-chk src">{field.tag}</span>
    ) : null;
  const classes = ["su-fld", tag ? "tagged" : "", refused ? "err" : ""].filter(Boolean).join(" ");
  return (
    <div className={classes} data-k={`fld-${field.path}`}>
      <label htmlFor={id}>{field.label}</label>
      <input
        id={id}
        className={field.mono || field.kind === "key" ? "su-inp mono" : "su-inp"}
        data-fid={`in:${field.path}`}
        value={value}
        placeholder={field.example ?? ""}
        readOnly={locked}
        title={s.disabled}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        aria-invalid={refused ? true : undefined}
        aria-describedby={refused ? `${id}-why` : undefined}
        onFocus={() => {
          if (isList && !locked) setRaw(s.read(field.path));
        }}
        onChange={(e) => {
          if (locked) return;
          if (isList) setRaw(e.target.value);
          s.onSet(field.path, e.target.value, "type");
        }}
        onBlur={() => {
          if (isList) setRaw(null);
          s.onLeave?.(field.path);
        }}
      />
      {tag}
      {refused ? <Refusal line={refused} id={`${id}-why`} /> : null}
      <Under lines={under} />
    </div>
  );
}

/**
 * A field for a key the person types, in the install.
 *
 * The key is held here only until the field is left, or Enter is pressed with
 * something in it. Then it goes to the caller and is forgotten: the field
 * shows dots once the host says it holds one. Typing again replaces it.
 */
function KeyField({ field }: { field: SetupField }): React.ReactElement {
  const s = useCtx();
  // The key is never in this page's state, and never in an attribute of the
  // field: the field keeps it by itself, it is read once when it is sent, and
  // the field is emptied in the same breath. So nothing that reads the page
  // can find it, and Enter and the blur after it cannot send it twice.
  const input = useRef<HTMLInputElement>(null);
  // Only whether something is typed.
  const [typing, setTyping] = useState(false);
  const filled = s.typed.has(field.path);
  const { refused, under, beside } = fieldLines(s.check, field.path);
  const id = fieldDomId(field.path);
  const send = (): void => {
    const el = input.current;
    const key = el?.value ?? "";
    if (!el || !key) return;
    el.value = "";
    setTyping(false);
    s.onTyped(field.path, key);
  };
  // A refusal is about the key that was sent. While a new one is typed it waits.
  const shownRefusal = refused && !typing ? refused : null;
  const notes = [beside, ...under].filter((line): line is CheckLine => line !== null);
  return (
    <div className={shownRefusal ? "su-fld tagged err" : "su-fld tagged"} data-k={`fld-${field.path}`}>
      <label htmlFor={id}>{field.label}</label>
      <input
        id={id}
        type="password"
        className="su-inp mono"
        data-fid={`in:${field.path}`}
        ref={input}
        placeholder={filled ? DOTS : ""}
        readOnly={s.disabled !== undefined || s.saving === true}
        title={s.disabled}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        data-1p-ignore=""
        data-lpignore="true"
        aria-invalid={shownRefusal ? true : undefined}
        aria-describedby={shownRefusal ? `${id}-why` : undefined}
        onChange={(e) => setTyping(e.target.value !== "")}
        onBlur={send}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          send();
        }}
      />
      <span className="su-chk src">Kept in {s.words.keys ?? ""}</span>
      {shownRefusal ? <Refusal line={shownRefusal} id={`${id}-why`} /> : null}
      <Under lines={notes} />
    </div>
  );
}

/** A field with a closed set of values: a value with a menu, or, when the set
 *  holds one value, a plain row that says it. */
function MenuField({ field }: { field: SetupField }): React.ReactElement {
  const s = useCtx();
  const options = field.options ?? [];
  const value = s.read(field.path);
  const pinned = s.frame.pinned[field.path];
  const { refused, beside, under } = fieldLines(s.check, field.path);
  const id = fieldDomId(field.path);
  if (options.length <= 1) {
    return (
      <div className={refused ? "su-fld err" : "su-fld"} data-k={`fld-${field.path}`}>
        <span className="k">{field.label}</span>
        <span className="su-sv">{options[0]?.name ?? value}</span>
        {refused ? <Refusal line={refused} id={`${id}-why`} /> : null}
        <Under lines={[beside, ...under].filter((line): line is CheckLine => line !== null)} />
      </div>
    );
  }
  const tag = pinned !== undefined ? <Pin variable={pinned} /> : beside ? <CheckTag line={beside} /> : null;
  return (
    <div className={refused ? "su-fld tagged err" : "su-fld tagged"} data-k={`fld-${field.path}`}>
      <span className="k" id={`${id}-label`}>
        {field.label}
      </span>
      <MenuPill
        fid={`menu:${field.path}`}
        labelledBy={`${id}-label`}
        options={options}
        value={value}
        disabled={pinned !== undefined || s.disabled !== undefined}
        held={s.saving === true}
        title={s.disabled}
        onPick={(picked) => {
          if (picked !== value) s.onSet(field.path, picked, "pick");
        }}
      />
      {tag ?? <span />}
      {refused ? <Refusal line={refused} id={`${id}-why`} /> : null}
      <Under lines={under} />
    </div>
  );
}

// ── A value picked from a menu ───────────────────────────────────────────────

/**
 * A value with a menu. Space or Down opens it; it opens down and to the
 * right, and flips only where the window ends. The arrows walk it, Enter or
 * Space picks, and Escape, Tab or Left closes it. Enter on the closed value
 * is left to the page: there it is the page's main button.
 */
function MenuPill(props: {
  fid: string;
  labelledBy?: string;
  options: readonly { id: string; name: string }[];
  value: string;
  disabled?: boolean;
  /** Held while a save of it is on its way: it does not open, and it keeps
   *  the keyboard (a disabled button would drop it). */
  held?: boolean;
  /** Why it is disabled, as its tooltip. */
  title?: string;
  onPick: (id: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const pill = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const current = props.options.find((o) => o.id === props.value);

  const close = (refocus: boolean): void => {
    setOpen(false);
    setAt(null);
    if (refocus) pill.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!open || !pill.current || !menu.current) return;
    const r = pill.current.getBoundingClientRect();
    const mh = menu.current.offsetHeight;
    const mw = menu.current.offsetWidth;
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    let left = r.left;
    if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8);
    setAt({ top, left });
  }, [open]);

  // Once it stands in its place (a hidden menu cannot take the keyboard), the
  // chosen value holds the keyboard.
  useLayoutEffect(() => {
    if (!open || !at || !menu.current) return;
    (menu.current.querySelector<HTMLButtonElement>("button.sel") ?? menu.current.querySelector<HTMLButtonElement>("button"))?.focus({
      preventScroll: true,
    });
  }, [open, at]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !pill.current?.contains(target)) close(false);
    };
    const moved = (e: Event): void => {
      if (menu.current && e.target instanceof Node && menu.current.contains(e.target)) return;
      close(false);
    };
    document.addEventListener("mousedown", away);
    window.addEventListener("resize", moved);
    window.addEventListener("scroll", moved, true);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("resize", moved);
      window.removeEventListener("scroll", moved, true);
    };
  }, [open]);

  const pick = (id: string): void => {
    close(true);
    props.onPick(id);
  };

  return (
    <>
      <button
        type="button"
        ref={pill}
        className="su-pill"
        data-fid={props.fid}
        data-menu=""
        aria-haspopup="menu"
        aria-expanded={open}
        aria-labelledby={props.labelledBy ? `${props.labelledBy} ${props.fid}-value` : undefined}
        disabled={props.disabled}
        aria-disabled={props.held ? true : undefined}
        title={props.title}
        onClick={() => {
          if (props.held) return;
          if (open) close(true);
          else setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "ArrowDown") {
            e.preventDefault();
            if (!props.held) setOpen(true);
          }
        }}
      >
        <span id={`${props.fid}-value`}>{current?.name ?? "—"}</span>
        <span className="su-caret" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              className="su-menu"
              role="menu"
              ref={menu}
              data-menu-open=""
              style={at ? { top: at.top, left: at.left } : { top: 0, left: 0, visibility: "hidden" }}
              onKeyDown={(e) => {
                const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
                const index = items.indexOf(document.activeElement as HTMLButtonElement);
                e.stopPropagation();
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  items[(index + 1) % items.length]?.focus();
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  items[(index - 1 + items.length) % items.length]?.focus();
                } else if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  const id = items[index]?.dataset.pick;
                  if (id !== undefined) pick(id);
                } else if (e.key === "Escape" || e.key === "Tab" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  close(true);
                }
              }}
            >
              {props.options.map((option) => (
                <button
                  type="button"
                  key={option.id}
                  role="menuitemradio"
                  aria-checked={option.id === props.value}
                  className={option.id === props.value ? "sel" : undefined}
                  data-pick={option.id}
                  onClick={() => pick(option.id)}
                >
                  {option.name}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

// ── Options ──────────────────────────────────────────────────────────────────

function useFields(fields: readonly SetupField[] | undefined): SetupField[] {
  const s = useCtx();
  return (fields ?? []).filter((field) => whenHolds(field.when, s.read));
}

function OptionFields({ fields }: { fields: readonly SetupField[] | undefined }): React.ReactElement | null {
  const shown = useFields(fields);
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((field) => (
        <FieldRow key={field.path} field={field} />
      ))}
    </>
  );
}

/**
 * A list of options. One is always chosen, and the chosen one shows its
 * fields inside it. The arrows move the choice itself.
 */
function OptionList({
  block,
  options,
  detailOf,
  bodyOf,
}: {
  block: Extract<SetupBlock, { kind: "choice" }>;
  options: readonly SetupOption[];
  detailOf: (option: SetupOption) => string | undefined;
  bodyOf: (option: SetupOption) => React.ReactNode;
}): React.ReactElement {
  const s = useCtx();
  const chosen = s.read(block.path);
  const pinned = s.frame.pinned[block.path];
  const locked = pinned !== undefined || s.disabled !== undefined || s.saving === true;
  const anyChosen = options.some((o) => o.id === chosen);
  const tight = options.every((o) => !detailOf(o));
  const pick = (option: SetupOption): boolean => {
    if (locked) return false;
    if (option.id !== chosen) s.onSet(block.path, option.id, "pick");
    return true;
  };
  return (
    <div className={tight ? "su-opts tight" : "su-opts"} role="radiogroup" aria-label={block.label} data-k={`opts-${block.path}`}>
      {options.map((option, index) => {
        const sel = option.id === chosen;
        const detail = detailOf(option);
        const body = sel ? bodyOf(option) : null;
        return (
          <div
            key={option.id}
            className={sel ? "su-opt sel" : "su-opt"}
            role="radio"
            aria-checked={sel}
            aria-disabled={locked && !sel ? true : undefined}
            title={s.disabled}
            tabIndex={sel || (!anyChosen && index === 0) ? 0 : -1}
            data-fid={`${block.path}:${option.id}`}
            data-k={`opt-${block.path}-${option.id}`}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("input, button, a, .su-menu")) return;
              pick(option);
              e.currentTarget.focus({ preventScroll: true });
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              e.preventDefault();
              const to = index + (e.key === "ArrowDown" ? 1 : -1);
              const next = options[to];
              if (!next || !pick(next)) return;
              (e.currentTarget.parentElement?.children[to] as HTMLElement | undefined)?.focus({ preventScroll: true });
            }}
          >
            <div className="su-rad" />
            <div className="su-optm">
              <div className="nm">{option.name}</div>
              {detail ? <div className="ds">{detail}</div> : null}
              {body ? (
                <div className="su-optf" data-k={`optf-${block.path}-${option.id}`}>
                  {body}
                </div>
              ) : null}
            </div>
            <div className="meta">{sel && pinned !== undefined ? <Pin variable={pinned} /> : (option.meta ?? "")}</div>
          </div>
        );
      })}
    </div>
  );
}

function hasShownFields(option: SetupOption, read: (path: string) => string): boolean {
  return (option.fields ?? []).some((field) => whenHolds(field.when, read));
}

/** The first page: where HX Fortress runs, and whether this computer is
 *  signed in there. */
function Places({ block }: { block: Extract<SetupBlock, { kind: "choice" }> }): React.ReactElement {
  const s = useCtx();
  const rows = s.derived.places;
  const rowOf = (id: string): PlaceRow | undefined => rows.find((row) => row.id === id);
  const options = rows.length > 0 ? block.options.filter((option) => rowOf(option.id)?.offered === true) : block.options;
  return (
    <OptionList
      block={block}
      options={options}
      detailOf={(option) => {
        const row = rowOf(option.id);
        if (row?.signedInAs) return `Signed in as ${row.signedInAs}.`;
        if (row?.needsSignIn) return "Not signed in on this computer.";
        return option.detail ?? placeInfo(option.id).detail;
      }}
      bodyOf={(option) => {
        const row = rowOf(option.id);
        if (row?.needsSignIn && !row.signedInAs) {
          return (
            <div className="su-fld tagged" data-k={`signin-${option.id}`}>
              <span className="k">Sign in first</span>
              <span className="su-sv mono">{row.signInCommand}</span>
              <CopyButton text={row.signInCommand} fid={`copy:signin-${option.id}`} />
            </div>
          );
        }
        return hasShownFields(option, s.read) ? <OptionFields fields={option.fields} /> : null;
      }}
    />
  );
}

/** Options as tiles side by side. Left and right move the choice. */
function Tiles({ block }: { block: Extract<SetupBlock, { kind: "choice" }> }): React.ReactElement {
  const s = useCtx();
  const chosen = s.read(block.path);
  const pinned = s.frame.pinned[block.path];
  const locked = pinned !== undefined || s.disabled !== undefined || s.saving === true;
  const anyChosen = block.options.some((o) => o.id === chosen);
  const pick = (option: SetupOption): boolean => {
    if (locked) return false;
    if (option.id !== chosen) s.onSet(block.path, option.id, "pick");
    return true;
  };
  return (
    <>
    <div className="su-tiles" role="radiogroup" aria-label={block.label} data-k={`tiles-${block.path}`}>
      {block.options.map((option, index) => {
        const sel = option.id === chosen;
        return (
          <div
            key={option.id}
            className={sel ? "su-tile sel" : "su-tile"}
            role="radio"
            aria-checked={sel}
            aria-disabled={locked && !sel ? true : undefined}
            title={s.disabled}
            tabIndex={sel || (!anyChosen && index === 0) ? 0 : -1}
            data-fid={`${block.path}:${option.id}`}
            onClick={(e) => {
              pick(option);
              e.currentTarget.focus({ preventScroll: true });
            }}
            onKeyDown={(e) => {
              if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return;
              e.preventDefault();
              const to = index + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1);
              const next = block.options[to];
              if (!next || !pick(next)) return;
              (e.currentTarget.parentElement?.children[to] as HTMLElement | undefined)?.focus({ preventScroll: true });
            }}
          >
            <div className="nm">{option.name}</div>
            {option.detail ? <div className="ds">{option.detail}</div> : null}
            {sel && pinned !== undefined ? <Pin variable={pinned} /> : null}
          </div>
        );
      })}
    </div>
    <RowLines path={block.path} />
    </>
  );
}

/** A choice drawn as a value with a menu, and the fields of the chosen value
 *  under it. A choice of one value is a row that says it. */
function MenuChoice({ block }: { block: Extract<SetupBlock, { kind: "choice" }> }): React.ReactElement {
  const s = useCtx();
  const value = s.read(block.path);
  const chosen = block.options.find((o) => o.id === value);
  const pinned = s.frame.pinned[block.path];
  const id = fieldDomId(block.path);
  const fields = useFields(chosen?.fields);
  return (
    <>
      {block.options.length <= 1 ? (
        <div className="su-fld" data-k={`fld-${block.path}`}>
          <span className="k">{block.label ?? ""}</span>
          <span className="su-sv">{block.options[0]?.name ?? ""}</span>
        </div>
      ) : (
        <div className="su-fld tagged" data-k={`fld-${block.path}`}>
          <span className="k" id={`${id}-label`}>
            {block.label ?? ""}
          </span>
          <MenuPill
            fid={`menu:${block.path}`}
            labelledBy={`${id}-label`}
            options={block.options}
            value={value}
            disabled={pinned !== undefined || s.disabled !== undefined}
            held={s.saving === true}
            title={s.disabled}
            onPick={(picked) => {
              if (picked !== value) s.onSet(block.path, picked, "pick");
            }}
          />
          {pinned !== undefined ? <Pin variable={pinned} /> : <span />}
        </div>
      )}
      {chosen && fields.length > 0 ? (
        <div className="su-flds su-under-menu" data-k={`menuf-${block.path}-${chosen.id}`}>
          {fields.map((field) => (
            <FieldRow key={field.path} field={field} />
          ))}
        </div>
      ) : null}
    </>
  );
}

// ── Switches ─────────────────────────────────────────────────────────────────

/** A yes or no that stands alone, as a checkbox. Space flips it. Its fields
 *  show while it is on, and the first one takes the keyboard. */
function Checkbox({ block }: { block: Extract<SetupBlock, { kind: "switch" }> }): React.ReactElement {
  const s = useCtx();
  const on = s.read(block.path) === block.on;
  const pinned = s.frame.pinned[block.path];
  const locked = pinned !== undefined || s.disabled !== undefined || s.saving === true;
  const fields = useFields(on ? block.fields : undefined);
  const handOver = useRef(false);
  useLayoutEffect(() => {
    if (!handOver.current) return;
    handOver.current = false;
    const first = fields[0];
    if (first) document.querySelector<HTMLElement>(`[data-fid="in:${first.path}"], [data-fid="menu:${first.path}"]`)?.focus();
  });
  const flip = (): void => {
    if (locked) return;
    if (!on) handOver.current = true;
    s.onSet(block.path, on ? block.off : block.on, "pick");
  };
  const detail = on ? block.detail : (block.detailOff ?? block.detail);
  return (
    <>
      <div
        className={on ? "su-cbx on" : "su-cbx"}
        role="checkbox"
        aria-checked={on}
        aria-disabled={locked ? true : undefined}
        title={s.disabled}
        tabIndex={0}
        data-fid={`cbx:${block.path}`}
        data-k={`cbx-${block.path}`}
        onClick={(e) => {
          // A line under the switch says something about it: a click on it
          // flips nothing.
          if (!onLine(e.target)) flip();
          e.currentTarget.focus({ preventScroll: true });
        }}
        onKeyDown={(e) => {
          if (e.key !== " ") return;
          e.preventDefault();
          flip();
        }}
      >
        <span className="box">{CHECK_ICON}</span>
        <div>
          <div className="nm">{block.label}</div>
          {detail ? <div className="ds">{detail}</div> : null}
          {pinned !== undefined ? <Pin variable={pinned} /> : null}
          <RowLines path={block.path} />
        </div>
      </div>
      {fields.length > 0 ? (
        <div className="su-flds su-cin" data-k={`cbxf-${block.path}`}>
          {fields.map((field) => (
            <FieldRow key={field.path} field={field} />
          ))}
        </div>
      ) : null}
    </>
  );
}

/** One switch for each module of this build. Space flips one, left and right
 *  set it, up and down walk the rows. */
function Modules(): React.ReactElement {
  const s = useCtx();
  return (
    <div className="su-mods" data-k="mods">
      {s.frame.modules.map((module) => {
        const path = `modules.${module.id}`;
        const on = answerAt(s.answers, path) === true;
        const pinned = s.frame.pinned[path];
        const locked = pinned !== undefined || s.disabled !== undefined || s.saving === true;
        const set = (want: boolean): void => {
          if (!locked && want !== on) s.onSet(path, want, "pick");
        };
        return (
          <div
            key={module.id}
            className={on ? "su-mod on" : "su-mod"}
            role="switch"
            aria-checked={on}
            aria-disabled={locked ? true : undefined}
            title={s.disabled}
            tabIndex={0}
            data-fid={`mod:${module.id}`}
            data-k={`mod-${module.id}`}
            onClick={(e) => {
              if (!onLine(e.target)) set(!on);
              e.currentTarget.focus({ preventScroll: true });
            }}
            onKeyDown={(e) => {
              const rows = Array.from(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>(".su-mod") ?? []);
              const here = rows.indexOf(e.currentTarget);
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                rows[here + (e.key === "ArrowDown" ? 1 : -1)]?.focus({ preventScroll: true });
              } else if (e.key === " ") {
                e.preventDefault();
                set(!on);
              } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                set(e.key === "ArrowRight");
              }
            }}
          >
            <div>
              <div className="nm">{module.title}</div>
              <div className="ds">{module.summary}</div>
              <RowLines path={path} />
            </div>
            <div className="su-switch-side">
              <div className="su-switch">
                <div className="track" />
              </div>
              {pinned !== undefined ? <Pin variable={pinned} /> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Facts, and the list worked out from the answers ──────────────────────────

function Facts({ facts, source }: { facts: readonly Fact[]; source: string }): React.ReactElement {
  return (
    <div className="su-facts">
      {facts.map((fact) => (
        <div className="su-frw" key={fact.label} data-k={`fact-${source}-${fact.label}`}>
          <div className="k">{fact.label}</div>
          <div className="v">{fact.mono ? <span className="mono">{fact.value}</span> : fact.value}</div>
          <div className={fact.ok === true ? "vs okv" : fact.ok === false ? "vs warnv" : "vs"}>{fact.note}</div>
        </div>
      ))}
    </div>
  );
}

function factsOf(s: Ctx, source: Extract<SetupBlock, { kind: "facts" }>["source"]): readonly Fact[] {
  switch (source) {
    case "host":
    case "auditTrail":
    case "updates":
      return s.frame.facts[source] ?? [];
    case "install":
    case "files":
    case "controlPlane":
    case "signIn":
    case "thisInstall":
      return s.derived.facts[source] ?? [];
  }
}

/** True for a host. A phrase ("the Postgres that is made") is set as words. */
function isHost(address: string): boolean {
  return !/\s/.test(address);
}

// ── One block ────────────────────────────────────────────────────────────────

function Group({ label, k, children }: { label?: string; k: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="su-grp" data-k={k}>
      {label ? <div className="su-lbl">{label}</div> : null}
      {children}
    </div>
  );
}

function Block({ block, index }: { block: SetupBlock; index: number }): React.ReactElement | null {
  const s = useCtx();
  const k = `blk-${index}`;
  if (!whenHolds(block.when, s.read)) return null;
  switch (block.kind) {
    case "fields": {
      const shown = block.fields.filter((field) => whenHolds(field.when, s.read));
      if (shown.length === 0) return null;
      return (
        <Group label={block.label} k={k}>
          <div className={block.draw === "two-by-two" ? "su-flds two" : "su-flds"}>
            {shown.map((field) => (
              <FieldRow key={field.path} field={field} />
            ))}
          </div>
        </Group>
      );
    }
    case "choice": {
      if (block.neededBy && !s.derived.needsFiles) {
        return (
          <Group k={k}>
            <div className="su-fld" data-k={`fld-${block.path}`}>
              <span className="k">{block.label ?? ""}</span>
              <span className="su-sv">{block.neededBy.idle}</span>
            </div>
          </Group>
        );
      }
      if (block.path === "where.place") {
        return (
          <Group label={block.label} k={k}>
            <Places block={block} />
          </Group>
        );
      }
      if (block.draw === "menu" || block.options.length <= 1) {
        // A choice of one value is a row that says it, whatever its draw.
        return (
          <Group k={k}>
            <MenuChoice block={block} />
          </Group>
        );
      }
      if (block.draw === "tiles") {
        return (
          <Group label={block.label} k={k}>
            <Tiles block={block} />
          </Group>
        );
      }
      return (
        <Group label={block.label} k={k}>
          <OptionList
            block={block}
            options={block.options}
            detailOf={(option) => option.detail}
            bodyOf={(option) => (hasShownFields(option, s.read) ? <OptionFields fields={option.fields} /> : null)}
          />
        </Group>
      );
    }
    case "switch":
      return (
        <Group k={k}>
          <Checkbox block={block} />
        </Group>
      );
    case "modules":
      return (
        <Group k={k}>
          <Modules />
        </Group>
      );
    case "facts": {
      const facts = factsOf(s, block.source);
      if (facts.length === 0) return null;
      return (
        <Group label={block.label} k={k}>
          <Facts facts={facts} source={block.source} />
        </Group>
      );
    }
    case "reach": {
      const rows = s.derived.reach;
      return (
        <Group label={reachLabel(rows.length)} k={k}>
          <div className="su-rows" data-k="reach">
            {rows.map((row) => (
              <div className="su-rw" key={`${row.address}|${row.why}`} data-k={`rw-${row.address}-${row.why}`}>
                <div className={isHost(row.address) ? "h mono" : "h"}>{row.address}</div>
                <div className="w">{row.why}</div>
              </div>
            ))}
          </div>
        </Group>
      );
    }
    case "connect":
      // The one-time id that connects HX Fortress to a control plane. Only the
      // console's Settings page asks for it, and it gives what to draw here.
      return s.connect ? <Group k={k}>{s.connect}</Group> : null;
    case "note":
      return (
        <div className="su-note" data-k={`note-${index}`}>
          <Words text={block.text} />
        </div>
      );
  }
}

/** The paths of the fields this step draws now, and of the controls that say
 *  their own lines (`RowLines`): a line about one of them shows at it, and
 *  every other line under the step. */
function drawnFields(step: SetupStep, s: Ctx): Set<string> {
  const out = new Set<string>();
  const add = (fields: readonly SetupField[] | undefined): void => {
    for (const field of fields ?? []) if (whenHolds(field.when, s.read)) out.add(field.path);
  };
  for (const block of step.blocks) {
    if (!whenHolds(block.when, s.read)) continue;
    if (block.kind === "fields") add(block.fields);
    else if (block.kind === "modules") {
      for (const module of s.frame.modules) out.add(`modules.${module.id}`);
    } else if (block.kind === "choice") {
      if (block.neededBy && !s.derived.needsFiles) continue;
      if (block.draw === "tiles" && block.options.length > 1 && block.path !== "where.place") out.add(block.path);
      const chosen = block.options.find((option) => option.id === s.read(block.path));
      if (!chosen) continue;
      if (block.path === "where.place") {
        const row = s.derived.places.find((place) => place.id === chosen.id);
        if (row?.needsSignIn && !row.signedInAs) continue;
      }
      add(chosen.fields);
    } else if (block.kind === "switch") {
      out.add(block.path);
      if (s.read(block.path) === block.on) add(block.fields);
    }
  }
  return out;
}

/**
 * Every block of one step, and under them the lines of its check that belong
 * to no field. This is all a page needs to show one step's controls: the
 * setup draws it inside its card, and Settings can draw it in a panel.
 */
export function StepControls(props: StepControlsProps): React.ReactElement {
  const read = (path: string): string => answerText(props.answers, path);
  const ctx: Ctx = {
    ...props,
    read,
    words: wordsOf(props.answers),
    typed: new Set(props.derived.typed),
  };
  const drawn = drawnFields(props.step, ctx);
  const loose = (props.check?.lines ?? []).filter((line) => shownLine(line) && (!line.path || !drawn.has(line.path)));
  return (
    <Context.Provider value={ctx}>
      {props.step.blocks.map((block, index) => (
        <Block key={`${props.step.id}-${index}`} block={block} index={index} />
      ))}
      {loose.map((line) => (
        <div
          className={refuses(line) ? "su-line bad" : line.ok ? "su-line ok" : "su-line soft"}
          key={`${line.path ?? ""}|${line.text}`}
          data-k={`ln-${line.text}`}
          role={refuses(line) ? "alert" : undefined}
        >
          <i />
          <span>
            <Words text={line.text} />
          </span>
        </div>
      ))}
    </Context.Provider>
  );
}

/** How long a row takes to open, to close and to glide. */
export const MORPH_MS = 320;
export const MORPH_EASE = EASE;
