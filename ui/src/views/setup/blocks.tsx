import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

import { answerAt, answerText, type SetupAnswers } from "../../../../src/setup/answers";
import {
  whenHolds,
  type SetupBlock,
  type SetupField,
  type SetupOption,
  type SetupStep,
} from "../../../../src/setup/list";
import type { CheckLine, Fact, SetupDerived, SetupFrame, StepCheck } from "../../../../src/setup/view";

/** Everything a block of a step draws from, and the few things it can do. */
export interface SetupView {
  frame: SetupFrame;
  answers: SetupAnswers;
  derived: SetupDerived;
  /** What the current step's check last found, or null before the first. */
  check: StepCheck | null;
  /** Paths whose answer changed since the last check came back. */
  pending: ReadonlySet<string>;
  /** True on a question the person has not left yet. An empty field is then
   *  not called wrong: nobody has had the chance to fill it in. */
  quiet: boolean;
  /** The raw text of a field that holds a list, as it is being typed. */
  texts: Record<string, string>;
  /** Change one answer: "typing" while a person types, "now" for a choice, a
   *  switch or a menu. `focus` is the `data-fid` of the control that holds the
   *  keyboard once the change is drawn. Left out, the keyboard stays put. */
  change: (path: string, value: string | boolean, how: "now" | "typing", focus?: string) => void;
  typeList: (path: string, text: string) => void;
  /** A field of the question lost the keyboard. */
  blurred: () => void;
  /** Ask the control plane for a code to sign in with, and ask whether a person has signed in. */
  getCode: () => void;
  checkCode: () => void;
  enrollBusy: boolean;
  enrollError: string | null;
}

const Ctx = createContext<SetupView>(null as unknown as SetupView);
export const SetupViewProvider = Ctx.Provider;
const useSetup = (): SetupView => useContext(Ctx);

export const CHECK_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 8.5l3.2 3.2L13 4.8" />
  </svg>
);

/** A check's line beside a field is a word or two. A sentence goes under it. */
const BESIDE_MAX = 26;

function linesAt(check: StepCheck | null, path: string): CheckLine[] {
  return (check?.lines ?? []).filter((line) => line.path === path);
}

// ── A field ──────────────────────────────────────────────────────────────────

function Field({ field }: { field: SetupField }): React.ReactElement {
  const s = useSetup();
  const pinned = s.frame.pinned[field.path];
  const isList = field.kind === "list";
  const value = isList ? (s.texts[field.path] ?? answerText(s.answers, field.path)) : answerText(s.answers, field.path);
  const unanswered = s.quiet && value === "";
  const lines = s.pending.has(field.path)
    ? []
    : linesAt(s.check, field.path).filter((line) => line.ok || !unanswered);
  const beside = lines.find((line) => line.text.length <= BESIDE_MAX);
  const under = lines.filter((line) => line !== beside);
  const id = `su-${field.path}`;
  const waiting = s.pending.has(field.path) && field.kind === "key" && value !== "";
  return (
    <div className={waiting || beside ? "su-fld chk" : "su-fld"} data-k={`fld-${field.path}`}>
      <label htmlFor={id}>{field.label}</label>
      <input
        id={id}
        className={field.mono || field.kind === "key" ? "su-inp mono" : "su-inp"}
        data-fid={`in:${field.path}`}
        value={value}
        placeholder={field.example ?? ""}
        readOnly={pinned !== undefined}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        onChange={(e) => {
          if (isList) s.typeList(field.path, e.target.value);
          else s.change(field.path, e.target.value, "typing");
        }}
        onBlur={s.blurred}
      />
      {waiting ? (
        <span className="su-chk wait">
          <span className="su-spin" />
        </span>
      ) : beside ? (
        <span className={beside.ok ? "su-chk ok" : "su-chk bad"}>
          <i />
          <Words text={beside.text} />
        </span>
      ) : null}
      {pinned !== undefined ? <div className="su-under info">Set by this host: {pinned}</div> : null}
      {under.map((line) => (
        <div className={line.ok ? "su-under ok" : "su-under"} key={line.text}>
          <Words text={line.text} />
        </div>
      ))}
    </div>
  );
}

// ── A list of options ────────────────────────────────────────────────────────

function Options({
  block,
  inside,
}: {
  block: Extract<SetupBlock, { kind: "choice" }>;
  /** Something drawn inside one option while it is the chosen one. */
  inside?: { optionId: string; node: React.ReactNode };
}): React.ReactElement {
  const s = useSetup();
  const chosen = answerText(s.answers, block.path);
  const pinned = s.frame.pinned[block.path];
  const tight = block.options.every((o) => !o.detail) || block.options.length > 3 || block.label !== undefined;
  // A click focuses the option it lands on. An arrow key hands the keyboard to
  // the option it chose, so the next arrow goes on from there.
  const pick = (option: SetupOption, byKey: boolean): void => {
    if (pinned !== undefined || option.id === chosen) return;
    s.change(block.path, option.id, "now", byKey ? `${block.path}:${option.id}` : undefined);
  };
  return (
    <div className={tight ? "su-opts tight" : "su-opts"} role="radiogroup" data-k={`g-${block.path}`}>
      {block.options.map((option, index) => {
        const sel = option.id === chosen;
        return (
          <div
            key={option.id}
            className={sel ? "su-opt sel" : "su-opt"}
            role="radio"
            aria-checked={sel}
            aria-disabled={pinned !== undefined && !sel}
            tabIndex={sel ? 0 : -1}
            data-fid={`${block.path}:${option.id}`}
            data-k={`o-${block.path}-${option.id}`}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("input, button, a, .gpill")) return;
              pick(option, false);
              (e.currentTarget as HTMLElement).focus();
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              e.preventDefault();
              const next = block.options[index + (e.key === "ArrowDown" ? 1 : -1)];
              if (next) pick(next, true);
            }}
          >
            <div className="su-rad" />
            <div>
              <div className="nm">{option.name}</div>
              {option.detail ? <div className="ds">{option.detail}</div> : null}
              {sel && (option.fields?.length || inside?.optionId === option.id) ? (
                <div className="su-optf" data-k={`f-${block.path}-${option.id}`}>
                  {(option.fields ?? []).map((field) => (
                    <Field key={field.path} field={field} />
                  ))}
                  {inside?.optionId === option.id ? inside.node : null}
                </div>
              ) : null}
            </div>
            <div className="meta">{option.meta ?? ""}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── A value picked from a menu ───────────────────────────────────────────────

function MenuPill({ block }: { block: Extract<SetupBlock, { kind: "choice" }> }): React.ReactElement {
  const s = useSetup();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const pill = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const chosen = answerText(s.answers, block.path);
  const pinned = s.frame.pinned[block.path];
  const name = block.options.find((o) => o.id === chosen)?.name ?? "Choose";

  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) pill.current?.focus();
  };

  // Opens down and to the right, and flips only where the window ends.
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
    (menu.current.querySelector<HTMLButtonElement>("button.sel") ?? menu.current.querySelector("button"))?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !pill.current?.contains(target)) setOpen(false);
    };
    const resized = (): void => setOpen(false);
    document.addEventListener("mousedown", away);
    window.addEventListener("resize", resized);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("resize", resized);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        ref={pill}
        className="gpill"
        data-fid={`menu:${block.path}`}
        data-menu=""
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={pinned !== undefined}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{name}</span>
        <span className="caret" />
      </button>
      {open ? (
        <div
          className="su-menu"
          role="menu"
          ref={menu}
          data-menu-open=""
          style={{ top: at.top, left: at.left }}
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
            } else if (e.key === "Escape" || e.key === "Tab" || e.key === "ArrowLeft") {
              e.preventDefault();
              close(true);
            }
          }}
        >
          {block.options.map((option) => (
            <button
              type="button"
              key={option.id}
              role="menuitemradio"
              aria-checked={option.id === chosen}
              className={option.id === chosen ? "sel" : undefined}
              onClick={() => {
                if (option.id !== chosen) s.change(block.path, option.id, "now");
                close(true);
              }}
            >
              {option.name}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

// ── Facts, and the lists worked out from the answers ─────────────────────────

function Facts({ facts }: { facts: readonly Fact[] }): React.ReactElement {
  return (
    <div className="facts">
      {facts.map((fact) => (
        <div className="frw" key={fact.label}>
          <div className="k">{fact.label}</div>
          <div className="v">{fact.mono ? <span className="mono">{fact.value}</span> : fact.value}</div>
          <div className={fact.ok === true ? "vs okv" : fact.ok === false ? "vs warnv" : "vs"}>{fact.note}</div>
        </div>
      ))}
    </div>
  );
}

function Enrollment(): React.ReactElement {
  const s = useSetup();
  const enrollment = s.derived.enrollment;
  return (
    <>
      <div className="su-fld" data-k="enroll">
        <label>Sign-in</label>
        <div className="su-enroll">
          {enrollment.state === "none" ? (
            <button
              type="button"
              className="btn ghost sm"
              data-fid="act:enroll"
              disabled={s.enrollBusy || !s.answers.controlPlane.address.trim()}
              onClick={s.getCode}
            >
              Get a code
            </button>
          ) : (
            <span className="su-code">{enrollment.code}</span>
          )}
          {enrollment.state === "waiting" ? (
            <>
              <span className="su-spin" />
              <span className="wait">Waiting for the sign-in</span>
            </>
          ) : null}
          {enrollment.state === "ready" ? (
            <span className="su-chk ok">
              <i />
              Signed in
            </span>
          ) : null}
          {enrollment.state === "expired" || enrollment.state === "refused" ? (
            <span className="su-chk bad">
              <i />
              {enrollment.state === "expired" ? "Ran out" : "Refused"}
            </span>
          ) : null}
        </div>
        {enrollment.state === "waiting" ? (
          <button type="button" className="btn ghost sm" data-fid="act:enroll-check" disabled={s.enrollBusy} onClick={s.checkCode}>
            Check
          </button>
        ) : enrollment.state === "expired" || enrollment.state === "refused" ? (
          <button type="button" className="btn ghost sm" data-fid="act:enroll" disabled={s.enrollBusy} onClick={s.getCode}>
            New code
          </button>
        ) : null}
        {enrollment.state === "waiting" ? (
          <div className="su-under info">
            <a href={enrollment.signInAt} target="_blank" rel="noopener noreferrer">
              Sign in at {enrollment.signInHost}
            </a>
          </div>
        ) : null}
        {s.enrollError ? (
          <div className="su-under">
            <Words text={s.enrollError} />
          </div>
        ) : null}
      </div>
      {enrollment.key ? (
        <div className="su-fld" data-k="enroll-key">
          <label>Its key</label>
          <span className="su-code" style={{ letterSpacing: 0, fontSize: 12.5 }}>
            {enrollment.key.id} · {enrollment.key.fingerprint}
          </span>
        </div>
      ) : null}
    </>
  );
}

// ── One block of a step ──────────────────────────────────────────────────────

function Block({ block, index }: { block: SetupBlock; index: number }): React.ReactElement | null {
  const s = useSetup();
  const read = (path: string): string => answerText(s.answers, path);
  const group = (label: string | undefined, key: string, inner: React.ReactNode): React.ReactElement => (
    <div className="su-grp" data-k={`grp-${key}`}>
      {label ? <div className="lbl">{label}</div> : null}
      {inner}
    </div>
  );

  switch (block.kind) {
    case "fields": {
      if (!whenHolds(block.when, read)) return null;
      return group(
        block.label,
        `fields-${index}`,
        <div className="su-flds">
          {block.fields.map((field) => (
            <Field key={field.path} field={field} />
          ))}
        </div>,
      );
    }
    case "choice": {
      if (!whenHolds(block.when, read)) return null;
      const pinned = s.frame.pinned[block.path];
      const pinLine =
        pinned !== undefined ? (
          <div className="su-note" data-k={`pin-${block.path}`}>
            Set by this host: {pinned}
          </div>
        ) : null;
      if (block.neededBy && !s.derived.needsFiles) {
        // One row says it all: the row's own label is the group's.
        return group(
          undefined,
          block.path,
          <div className="facts">
            <div className="frw">
              <div className="k">{block.label ?? "Files"}</div>
              <div className="v">{block.neededBy.idle}</div>
              <div className="vs" />
            </div>
          </div>,
        );
      }
      if (block.menu) {
        const chosen = block.options.find((o) => o.id === read(block.path));
        // A menu that lists only the answer could change nothing: the row says
        // the answer, as the terminal does.
        const only = block.options.length === 1 ? chosen : undefined;
        return group(
          only ? undefined : block.label,
          block.path,
          <>
            {only ? (
              <div className="facts">
                <div className="frw">
                  <div className="k">{block.label ?? ""}</div>
                  <div className="v">{only.name}</div>
                  <div className="vs" />
                </div>
              </div>
            ) : (
              <MenuPill block={block} />
            )}
            {chosen?.fields?.length ? (
              <div className="su-flds" style={{ marginTop: 8 }} data-k={`f-${block.path}`}>
                {chosen.fields.map((field) => (
                  <Field key={field.path} field={field} />
                ))}
              </div>
            ) : null}
            {pinLine}
          </>,
        );
      }
      // The sign-in belongs inside the option that connects a control plane.
      const inside = block.path === "controlPlane.connect" ? { optionId: "yes", node: <Enrollment /> } : undefined;
      return group(
        block.label,
        block.path,
        <>
          <Options block={block} {...(inside ? { inside } : {})} />
          {pinLine}
        </>,
      );
    }
    case "modules": {
      return group(
        undefined,
        "modules",
        <div className="su-mods">
          {s.frame.modules.map((module) => {
            const path = `modules.${module.id}`;
            const on = answerAt(s.answers, path) === true;
            const pinned = s.frame.pinned[path];
            const set = (want: boolean): void => {
              if (pinned === undefined && want !== on) s.change(path, want, "now");
            };
            return (
              <div
                key={module.id}
                className={on ? "su-mod on" : "su-mod"}
                role="switch"
                aria-checked={on}
                aria-disabled={pinned !== undefined}
                tabIndex={0}
                data-fid={`mod:${module.id}`}
                data-k={`m-${module.id}`}
                onClick={(e) => {
                  set(!on);
                  (e.currentTarget as HTMLElement).focus();
                }}
                onKeyDown={(e) => {
                  const mods = Array.from(
                    (e.currentTarget.parentElement as HTMLElement).querySelectorAll<HTMLElement>(".su-mod"),
                  );
                  const here = mods.indexOf(e.currentTarget as HTMLElement);
                  if (e.key === "ArrowDown" && here < mods.length - 1) {
                    e.preventDefault();
                    mods[here + 1]?.focus();
                  } else if (e.key === "ArrowUp" && here > 0) {
                    e.preventDefault();
                    mods[here - 1]?.focus();
                  } else if (e.key === " ") {
                    e.preventDefault();
                    set(!on);
                  } else if (e.key === "ArrowRight") {
                    e.preventDefault();
                    set(true);
                  } else if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    set(false);
                  }
                }}
              >
                <div>
                  <div className="nm">{module.title}</div>
                  <div className="ds">{module.summary}</div>
                  {pinned !== undefined ? <div className="ds">Set by this host: {pinned}</div> : null}
                </div>
                <div className="switch">
                  <div className="track" />
                </div>
              </div>
            );
          })}
        </div>,
      );
    }
    case "facts":
      return group(block.label, `facts-${block.source}`, <Facts facts={s.frame.facts[block.source]} />);
    case "reach": {
      const rows = s.derived.reach;
      return group(
        `${rows.length} ${rows.length === 1 ? "address" : "addresses"} this Fortress calls`,
        "reach",
        <div className="su-rows" data-k="reach">
          {rows.map((row) => (
            <div className="su-rw" key={`${row.address}|${row.why}`}>
              <div className="h">{row.address}</div>
              <div className="w">{row.why}</div>
            </div>
          ))}
        </div>,
      );
    }
    case "asks": {
      if (!whenHolds(block.when, read)) return null;
      return group(
        block.label,
        "asks",
        <div className="su-rows" data-k="asks">
          {s.derived.asks.map((row) => (
            <div className="su-ask" key={row.module}>
              <div className="m">{row.title}</div>
              {!row.on ? (
                <div className="a">Off. It answers nothing</div>
              ) : row.asks.length > 0 ? (
                <div className="a mono">{row.asks.join(" · ")}</div>
              ) : (
                <div className="a">{row.note}</div>
              )}
            </div>
          ))}
        </div>,
      );
    }
    case "note":
      return whenHolds(block.when, read) ? (
        <div className="su-note" data-k={`nt-${index}`}>
          <Words text={block.text} />
        </div>
      ) : null;
    case "enrollment":
      // Drawn inside the option that connects a control plane.
      return null;
  }
}

/** The questions of one step, and under them what its check found. */
export function StepBody({ step, checking }: { step: SetupStep; checking: boolean }): React.ReactElement {
  const s = useSetup();
  // A line that names a field is drawn beside that field. The rest go here.
  const fieldPaths = new Set<string>();
  for (const block of step.blocks) {
    if (block.kind === "fields") for (const f of block.fields) fieldPaths.add(f.path);
    if (block.kind === "choice") for (const o of block.options) for (const f of o.fields ?? []) fieldPaths.add(f.path);
  }
  // So does what the sign-in is waiting for: its own row shows that.
  const lines = (s.check?.lines ?? []).filter(
    (line) => (!line.path || !fieldPaths.has(line.path)) && line.needs !== "enrollment",
  );
  return (
    <>
      {step.blocks.map((block, index) => (
        <Block key={`${step.id}-${index}`} block={block} index={index} />
      ))}
      {lines.map((line) => (
        <div className={line.ok ? "su-line ok" : "su-line bad"} key={line.text} data-k={`ln-${line.text}`}>
          <i />
          <span>
            <Words text={line.text} />
          </span>
        </div>
      ))}
      {checking && lines.length === 0 && !s.check ? (
        <div className="su-line wait" data-k="ln-checking">
          <span className="su-spin" />
          <span>Checking</span>
        </div>
      ) : null}
    </>
  );
}

/** A sentence from the host, with what is typed at a command line set apart.
 *  The host marks it with backticks. Text only: nothing is set as markup. */
export function Words({ text }: { text: string }): React.ReactElement {
  return (
    <>
      {text.split("`").map((part, index) =>
        index % 2 === 1 ? (
          <code className="hx" key={index}>
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** The settings file, with its strings in colour. Text only: nothing here is
 *  ever set as markup. */
export function FileText({ text }: { text: string }): React.ReactElement {
  const parts: React.ReactNode[] = [];
  const pattern = /("(?:[^"\\]|\\.)*")(\s*:)?/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (match[2]) parts.push(match[0]);
    else
      parts.push(
        <span className="s" key={match.index}>
          {match[1]}
        </span>,
      );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
