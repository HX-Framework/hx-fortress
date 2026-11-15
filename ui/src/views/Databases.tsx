// Data › Databases: the databases this HX Fortress connects to in its own
// network, the state of each, and Test.
//
// Everything on this page is an act of the Databases module (api.databases).
// A read is an act any signed-in person may do. Adding, changing, removing and
// testing are an operator's. The module lives in the daemon, so with the
// module off, the page says so and shows no list. With the daemon stopped, it
// says so: a list that was already showing stays, marked as one that may be
// out of date.
//
// THE KEYBOARD. The first database is selected as soon as the list arrives.
// ↑ and ↓ move the selection from anywhere on the page, so no click is needed
// to start. A adds, T tests, E edits and Delete removes the selected one. A
// dialog takes the keys while it is open.
//
// NO PASSWORD IS TYPED HERE. The form's Password field takes the name of the
// secret that holds it (lib/database-form.ts says why).

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { READONLY_REFUSAL_COPY } from "../../../src/ui/copy";
import { ApiError, api, isModuleOff, type DatabaseConnectionArgs, type DatabaseConnectionView } from "../api";
import { Panel, ResultLine, ViewLoading, useConfirm, useResultLine } from "../components";
import { ago, plural, when } from "../format";
import { useResource } from "../hooks";
import {
  argsOf,
  emptyForm,
  ENCRYPTION_LABEL,
  encryptionsFor,
  ENGINE_INFO,
  ENGINES,
  formOf,
  isFolded,
  checksCertificate,
  keyNameProblem,
  moreSummary,
  pasteProblem,
  pastedConnection,
  problemsOf,
  readFailureOf,
  refusalOf,
  TLS_VERSIONS,
  pastedInto,
  withEngine,
  type DatabaseForm,
  type Engine,
  type FieldName,
} from "../lib/database-form";
import {
  catalogWords,
  linkWords,
  loginCanWrite,
  startedByWords,
  stateLine,
  stateWords,
} from "../lib/database-words";
import { useApp, useOperator } from "../state";

/** How often the list is read: at rest, and while a test is running. */
const POLL_MS = 10_000;
const POLL_TESTING_MS = 1_000;

/** The word of a refusal: the route's own, or what this client says about an
 *  answer that never came. */
function wordOf(error: unknown): string {
  if (error instanceof ApiError) return error.fromBody ? error.message : `no_answer_${error.status}`;
  return "no_answer";
}

/** The sentence for an act that was not carried out. */
function sentenceOf(error: unknown): string {
  if (error instanceof ApiError && !error.fromBody) return error.message;
  return refusalOf(wordOf(error)).words;
}

/** The sentence for a list that could not be read. What the route answers is
 *  one word. Anything longer is this client's own sentence about an answer
 *  that never came, and is shown as it is. */
function loadWords(error: string | null): string {
  if (error === null) return "";
  return /^[a-z_:]+$/.test(error) ? readFailureOf(error) : error;
}

/** A control that changes something. A read-only account sees it, disabled:
 *  the panel it stands in says why, once (`ReadonlyNote`). */
function ActButton(props: {
  label: string;
  /** The key that does the same from anywhere on the page. */
  keycap: string;
  onClick: () => void;
  disabled?: boolean;
  kind?: "ghost" | "danger";
}): React.ReactElement {
  const operator = useOperator();
  return (
    <button
      type="button"
      className={props.kind ? `btn ${props.kind}` : "btn"}
      disabled={!operator || props.disabled === true}
      aria-keyshortcuts={props.keycap === "Del" ? "Delete" : props.keycap}
      onClick={props.onClick}
    >
      {props.label}{" "}
      <span className="kbd" aria-hidden="true">
        {props.keycap}
      </span>
    </button>
  );
}

/** The server's own sentence for an account that may read and not change. */
function ReadonlyNote(): React.ReactElement | null {
  return useOperator() ? null : <div className="dbreadonly">{READONLY_REFUSAL_COPY}</div>;
}

export default function Databases(): React.ReactElement {
  const app = useApp();
  const active = app.view === "databases";
  const operator = useOperator();

  const [testing, setTesting] = useState(false);
  const list = useResource(() => api.databases.read(), [], {
    active,
    pollMs: testing ? POLL_TESTING_MS : POLL_MS,
  });
  const connections = useMemo(() => list.data?.connections ?? [], [list.data]);
  const anyTesting = connections.some((connection) => connection.state === "testing");
  // Each read says again whether a test runs. A test that ended before the
  // first read after it started never shows as running, and the fast poll
  // that Test asked for must end with that read all the same.
  useEffect(() => {
    setTesting(anyTesting);
  }, [anyTesting, list.data]);

  // ── the selection ──────────────────────────────────────────────────────────
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const selected = connections.find((connection) => connection.name === selectedName) ?? null;
  // A database that was just added is selected as soon as the list holds it.
  const justAdded = useRef<string | null>(null);
  // The first database is selected once the list arrives, and again when the
  // selected one is gone. A selection a person made is never moved.
  useEffect(() => {
    const has = (name: string | null): boolean => connections.some((connection) => connection.name === name);
    if (justAdded.current !== null && has(justAdded.current)) {
      setSelectedName(justAdded.current);
      justAdded.current = null;
      return;
    }
    if (connections.length === 0) {
      if (selectedName !== null) setSelectedName(null);
      return;
    }
    if (!has(selectedName)) setSelectedName((connections[0] as DatabaseConnectionView).name);
  }, [connections, selectedName]);

  // ── the dialogs ────────────────────────────────────────────────────────────
  const [dialog, setDialog] = useState<{ mode: "add" } | { mode: "edit"; connection: DatabaseConnectionView } | null>(
    null,
  );
  const [confirmElement, confirm] = useConfirm();
  const [result, showResult] = useResultLine();
  const [busy, setBusy] = useState(false);
  const { reload } = list;

  const test = useCallback(
    async (connection: DatabaseConnectionView): Promise<void> => {
      if (!operator || busy || connection.state === "testing") return;
      setBusy(true);
      try {
        await api.databases.test(connection.name);
        setTesting(true);
        reload();
      } catch (error) {
        showResult(sentenceOf(error), true);
      } finally {
        setBusy(false);
      }
    },
    [busy, operator, reload, showResult],
  );

  const remove = useCallback(
    async (connection: DatabaseConnectionView): Promise<void> => {
      if (!operator || busy) return;
      const yes = await confirm({
        title: `Remove ${connection.name}`,
        body:
          "This HX Fortress forgets this database and takes its server off the list of hosts it may reach. " +
          "A program or a Secure Data Island that names it stops working. The database itself is not touched.",
        confirmLabel: "Remove Database",
        danger: true,
      });
      if (!yes) return;
      setBusy(true);
      try {
        await api.databases.remove(connection.name);
        showResult(`Removed ${connection.name}.`);
        reload();
      } catch (error) {
        showResult(sentenceOf(error), true);
      } finally {
        setBusy(false);
      }
    },
    [busy, confirm, operator, reload, showResult],
  );

  // ── the keys ───────────────────────────────────────────────────────────────
  const overlay = dialog !== null || confirmElement !== null;
  // The keys are the list's: without a list on the screen there is nothing to
  // select, and a dialog opened then would wait behind another screen.
  const listShown = list.data !== null && !isModuleOff(list);
  useEffect(() => {
    if (!active || overlay || !listShown) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const at = connections.findIndex((connection) => connection.name === selectedName);
      const move = (to: number): void => {
        const next = connections[Math.max(0, Math.min(connections.length - 1, to))];
        if (!next) return;
        event.preventDefault();
        setSelectedName(next.name);
      };
      switch (event.key) {
        case "ArrowDown":
          return move(at + 1);
        case "ArrowUp":
          return move(at - 1);
        case "Home":
          return move(0);
        case "End":
          return move(connections.length - 1);
        // A key held down moves the selection on, and does nothing else twice.
        case "a":
        case "A":
          if (!operator || event.repeat) return;
          event.preventDefault();
          return setDialog({ mode: "add" });
        case "t":
        case "T":
          if (selected && !event.repeat) {
            event.preventDefault();
            void test(selected);
          }
          return;
        case "e":
        case "E":
          // As the Edit button: not while a test of it runs.
          if (selected && operator && !busy && selected.state !== "testing" && !event.repeat) {
            event.preventDefault();
            setDialog({ mode: "edit", connection: selected });
          }
          return;
        case "Backspace":
        case "Delete":
          if (selected && !event.repeat) {
            event.preventDefault();
            void remove(selected);
          }
          return;
        default:
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, busy, connections, listShown, operator, overlay, remove, selected, selectedName, test]);

  // The selected row is kept in sight as the selection moves.
  const rows = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!active || selectedName === null) return;
    rows.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, selectedName]);

  // ── what is shown ──────────────────────────────────────────────────────────
  if (!active) return <section className="view" />;

  // A module that is off has no acts. What the page showed before is then not
  // shown: it is no longer something this HX Fortress does.
  if (isModuleOff(list)) return <DatabasesOff />;

  const head = (
    <>
      <div className="kicker">Data</div>
      <h1>Databases</h1>
      <p className="lede">
        The databases this HX Fortress connects to, in its own network. A login names the secret that holds its
        password, so no password is typed or shown here.
      </p>
    </>
  );

  if (list.data === null) {
    return (
      <section className="view active dbview">
        {head}
        {list.error === null ? (
          <ViewLoading what="Reading this HX Fortress's databases" />
        ) : (
          <div className="banner warn">
            <span className="badge">!</span>
            <span className="btxt">{loadWords(list.error)}</span>
            <button className="btn" onClick={list.reload}>
              Try again
            </button>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="view active dbview">
      {head}

      {list.stale ? (
        <div className="banner warn">
          <span className="badge">!</span>
          <span className="btxt">
            <b>This list may be out of date.</b> {loadWords(list.error)}
          </span>
        </div>
      ) : null}

      <Panel className="dbpanel">
        <div className="dbhead">
          <h2>{connections.length === 0 ? "No database yet" : "Databases"}</h2>
          <span className="grow" />
          <ActButton label="Add Database" keycap="A" onClick={() => setDialog({ mode: "add" })} />
        </div>
        <ReadonlyNote />
        {connections.length === 0 ? null : (
          <div
            className="dbrows"
            role="listbox"
            aria-label="Databases"
            tabIndex={0}
            aria-activedescendant={selected ? optionId(selected.name) : undefined}
            ref={rows}
          >
            {connections.map((connection) => (
              <DatabaseRow
                key={connection.name}
                connection={connection}
                selected={connection.name === selectedName}
                onSelect={() => setSelectedName(connection.name)}
              />
            ))}
          </div>
        )}
        <ResultLine state={result} />
      </Panel>

      {selected ? (
        <DatabaseDetail
          connection={selected}
          busy={busy}
          onTest={() => void test(selected)}
          onEdit={() => setDialog({ mode: "edit", connection: selected })}
          onRemove={() => void remove(selected)}
        />
      ) : null}

      {dialog ? (
        <DatabaseDialog
          editing={dialog.mode === "edit" ? dialog.connection : null}
          onClose={() => setDialog(null)}
          onDone={(name, added) => {
            setDialog(null);
            justAdded.current = name;
            showResult(added ? `Added ${name}.` : `Saved ${name}.`);
            reload();
          }}
        />
      ) : null}
      {confirmElement}
    </section>
  );
}

/** Shown in place of the page on an HX Fortress whose Databases module is off. */
function DatabasesOff(): React.ReactElement {
  return (
    <section className="view active">
      <div className="kicker">Data</div>
      <h1>Databases is off on this HX Fortress</h1>
      <p className="lede">
        This HX Fortress connects to no database of its organization, so this page has nothing to show.
      </p>
      <div className="banner info">
        <span className="badge">i</span>
        <span className="btxt">
          Databases is switched on or off on this host. It cannot be switched from this console or from a control
          plane. <code className="hx">hx-fortress modules list</code> shows every module of this build and whether
          it is on, and the <code className="hx">hx-fortress</code> README says how to switch one on, under
          “Modules, asks and releases”.
        </span>
      </div>
    </section>
  );
}

/** The id of a database's row. A name holds spaces and marks an id may not. */
function optionId(name: string): string {
  return `db-row-${Array.from(name, (char) => char.charCodeAt(0).toString(16)).join("-")}`;
}

function StatePill({ connection }: { connection: DatabaseConnectionView }): React.ReactElement {
  const words = stateWords(connection);
  const tone = words.tone === "busy" ? "fortress" : words.tone;
  return <span className={`pill ${tone}`}>{words.label}</span>;
}

function DatabaseRow(props: {
  connection: DatabaseConnectionView;
  selected: boolean;
  onSelect: () => void;
}): React.ReactElement {
  const { connection } = props;
  const tone = stateWords(connection).tone;
  const dot = tone === "ok" ? "" : tone === "warn" || tone === "busy" ? " warn" : tone === "danger" ? " bad" : " offd";
  return (
    <div
      className={props.selected ? "dbrow sel" : "dbrow"}
      role="option"
      id={optionId(connection.name)}
      aria-selected={props.selected}
      onClick={props.onSelect}
    >
      <span className={`dot${dot}`} />
      <span className="who">
        <b>{connection.name}</b>
        <div className="sub">
          {ENGINE_INFO[connection.engine].label}, {connection.database} on {connection.host}
          {connection.port === ENGINE_INFO[connection.engine].port ? "" : `:${connection.port}`}
        </div>
      </span>
      <span className="dbwhen">{connection.test ? ago(connection.test.finishedAt ?? connection.test.startedAt) : ""}</span>
      <span className="dbstate">
        <StatePill connection={connection} />
      </span>
    </div>
  );
}

function DatabaseDetail(props: {
  connection: DatabaseConnectionView;
  busy: boolean;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
}): React.ReactElement {
  const { connection } = props;
  const info = ENGINE_INFO[connection.engine];
  const test = connection.test;
  const running = connection.state === "testing";
  const link = test ? linkWords(test.encryption) : null;
  const catalog = test && test.state === "done" ? catalogWords(test) : null;
  const tone = stateWords(connection).tone;

  return (
    <Panel className="dbpanel">
      <div className="dbhead">
        <h2>{connection.name}</h2>
        <StatePill connection={connection} />
        <span className="grow" />
        <ActButton label={running ? "Testing" : "Test"} keycap="T" onClick={props.onTest} disabled={props.busy || running} />
        <ActButton label="Edit" keycap="E" kind="ghost" onClick={props.onEdit} disabled={props.busy || running} />
        <ActButton label="Remove" keycap="Del" kind="danger" onClick={props.onRemove} disabled={props.busy} />
      </div>
      <ReadonlyNote />

      <div
        className={
          tone === "danger" ? "dbline bad" : tone === "warn" ? "dbline warn" : tone === "ok" ? "dbline ok" : "dbline"
        }
        aria-live="polite"
      >
        {stateLine(connection)}
      </div>

      <div className="facts wide">
        <div className="frw">
          <span className="k">Engine</span>
          <span className="v">{info.label}</span>
          <span />
        </div>
        <div className="frw">
          <span className="k">Server</span>
          <span>
            <span className="v mono">
              {connection.host}:{connection.port}
            </span>
            <div className="vs">This HX Fortress reaches it straight from this host.</div>
          </span>
          <span />
        </div>
        <div className="frw">
          <span className="k">{info.database}</span>
          <span className="v mono">{connection.database}</span>
          <span />
        </div>
        <div className="frw">
          <span className="k">Login</span>
          <span>
            <span className="v mono">{connection.user}</span>
            <div className="vs">
              Its password is the secret <code className="hx">{connection.keyName}</code> in this HX Fortress's key
              store.
            </div>
          </span>
          <span />
        </div>
        <div className="frw">
          <span className="k">Encryption</span>
          <span>
            <span className="v">{moreSummary(connection)}</span>
            {connection.serverName && checksCertificate(connection.encryption) ? (
              <div className="vs">
                The certificate must name <span className="mono">{connection.serverName}</span>.
              </div>
            ) : null}
          </span>
          <span />
        </div>
        <div className="frw">
          <span className="k">Added</span>
          <span>
            <span className="v">{when(connection.addedAt)}</span>
            <div className="vs">
              {connection.addedBy ? `by ${connection.addedBy}` : ""}
              {connection.changedAt
                ? `${connection.addedBy ? ", " : ""}changed ${when(connection.changedAt)}${
                    connection.changedBy ? ` by ${connection.changedBy}` : ""
                  }`
                : ""}
            </div>
          </span>
          <span />
        </div>
        {test ? (
          <div className="frw">
            <span className="k">Last test</span>
            <span>
              <span className="v">{when(test.finishedAt ?? test.startedAt)}</span>
              <div className="vs">started by {startedByWords(test)}</div>
              {link ? <div className="vs">{link}.</div> : null}
              {catalog ? <div className="vs">{catalog}.</div> : null}
              {test.state === "done" && test.canWrite === false ? (
                <div className="vs okv">This login can only read.</div>
              ) : null}
              {loginCanWrite(connection) ? (
                <div className="vs warnv">
                  This login can change data{test.writableTables ? ` in ${plural(test.writableTables, "table")}` : ""}.
                </div>
              ) : null}
            </span>
            <span />
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

// ── Add Database, and Edit ───────────────────────────────────────────────────

/** The id of a field's control, so a refusal can put the keyboard on it. */
const fieldId = (field: FieldName): string => `db-field-${field}`;

function DatabaseDialog(props: {
  /** The connection being changed, or null for Add Database. */
  editing: DatabaseConnectionView | null;
  onClose: () => void;
  onDone: (name: string, added: boolean) => void;
}): React.ReactElement {
  const { editing } = props;
  const [form, setForm] = useState<DatabaseForm>(() => (editing ? formOf(editing) : emptyForm()));
  // More Settings folds the way it opened: `closing` is the fold running back,
  // and the fields are taken away when it has ended.
  const [more, setMore] = useState<"closed" | "open" | "closing">("closed");
  const toggleMore = (): void =>
    setMore((now) => {
      if (now !== "open") return "open";
      // With motion reduced there is no fold to wait for.
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "closed" : "closing";
    });
  const [problems, setProblems] = useState<Partial<Record<FieldName, string>>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // False once the dialog is closed: an answer that arrives later is for a
  // dialog that is gone, and must not close or change the one open now.
  const open = useRef(true);
  useEffect(
    () => () => {
      open.current = false;
    },
    [],
  );
  const modal = useRef<HTMLDivElement | null>(null);
  const info = ENGINE_INFO[form.engine];

  const set = (changed: Partial<DatabaseForm>): void => {
    setForm((current) => ({ ...current, ...changed }));
    // What was said about a field is about what it held then.
    setProblems((current) => {
      const next = { ...current };
      for (const field of Object.keys(changed) as FieldName[]) delete next[field];
      return next;
    });
    setGeneral(null);
  };

  const focusNow = (field: FieldName): void => {
    modal.current
      ?.querySelector<HTMLElement>(field === "engine" ? '[role="radio"][aria-checked="true"]' : `#${fieldId(field)}`)
      ?.focus();
  };
  /** Put the keyboard on a field, opening More Settings first when it is folded. */
  const focusField = (field: FieldName): void => {
    if (isFolded(field)) setMore("open");
    // After the fold has opened.
    window.setTimeout(() => focusNow(field), 0);
  };

  // The keyboard lands on the first control once, as the dialog appears and
  // before anything is drawn: the engine for a new database, the server for
  // one being changed. So the first key pressed after A already acts here.
  useLayoutEffect(() => {
    focusNow(editing ? "host" : "engine");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While the dialog is open the keyboard is the dialog's. Esc closes it, Tab
  // goes round inside it, and a key pressed with the focus anywhere else acts
  // on nothing behind it. A key pressed inside reaches the fields first and
  // goes no further (`onKeyDown` on the overlay): the page's keys and the
  // console's own do not hear it.
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const formRef = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const box = modal.current;
      const inside = box !== null && event.target instanceof Node && box.contains(event.target);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key === "Tab") {
        const stops = [
          ...(box?.querySelectorAll<HTMLElement>(
            'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled])',
          ) ?? []),
        ];
        const first = stops[0];
        const last = stops[stops.length - 1];
        if (!inside || (event.shiftKey && document.activeElement === first)) {
          event.preventDefault();
          (inside ? last : first)?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
        return;
      }
      if (!inside) event.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  const onKeyInside = (event: React.KeyboardEvent): void => {
    // ↵ adds from the engine too: a choice of one of four has no use for it.
    if (event.key === "Enter" && (event.target as HTMLElement).getAttribute("role") === "radio") {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
    event.stopPropagation();
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (sending) return;
    const found = problemsOf(form);
    if (found.length > 0) {
      setProblems(Object.fromEntries(found.map((problem) => [problem.field, problem.words])));
      focusField((found[0] as { field: FieldName }).field);
      return;
    }
    const args: DatabaseConnectionArgs = argsOf(form);
    setSending(true);
    try {
      const reply = editing ? await api.databases.change(args) : await api.databases.add(args);
      if (!open.current) return;
      props.onDone(reply.name, editing === null);
    } catch (error) {
      if (!open.current) return;
      if (error instanceof ApiError && !error.fromBody) {
        setGeneral(error.message);
      } else {
        const refusal = refusalOf(wordOf(error), form);
        if (refusal.field) {
          setProblems({ [refusal.field]: refusal.words });
          focusField(refusal.field);
        } else {
          setGeneral(refusal.words);
        }
      }
    } finally {
      if (open.current) setSending(false);
    }
  };

  // A connection string pasted into Server fills the fields it names. A
  // password in it is dropped where the text is read, and the keyboard goes to
  // the field that asks for the secret's name.
  const onServerPaste = (event: React.ClipboardEvent<HTMLInputElement>): void => {
    const text = event.clipboardData.getData("text");
    const pasted = pastedConnection(text);
    if (!pasted) {
      // What is not read goes in only when it can be a server's name. Anything
      // else may hold a password, so nothing of it goes into the field.
      const words = pasteProblem("host", text);
      if (words !== null) {
        event.preventDefault();
        setProblems({ host: words });
      }
      return;
    }
    event.preventDefault();
    const next = pastedInto(form, pasted, editing !== null);
    if (typeof next === "string") {
      setProblems({ host: next });
      return;
    }
    setForm(next);
    setProblems({});
    setGeneral(null);
    focusField(pasted.user ? "keyName" : "user");
  };

  /** A paste into any other field: text that cannot be the field's value
   *  stays out of it. */
  const guardPaste =
    (field: FieldName) =>
    (event: React.ClipboardEvent<HTMLInputElement>): void => {
      const words = pasteProblem(field, event.clipboardData.getData("text"));
      if (words === null) return;
      event.preventDefault();
      setProblems((current) => ({ ...current, [field]: words }));
    };

  const bad = (field: FieldName): boolean => problems[field] !== undefined;
  const said = (field: FieldName): React.ReactElement | null =>
    problems[field] ? (
      <div className="dberr" id={`${fieldId(field)}-said`}>
        {problems[field]}
      </div>
    ) : null;
  const describedBy = (field: FieldName): string | undefined => (bad(field) ? `${fieldId(field)}-said` : undefined);

  // While it is typed, the password field says at once when it holds something
  // that no secret's name can be.
  const keyNameSaid =
    problems.keyName ?? (form.keyName.trim() === "" ? undefined : (keyNameProblem(form.keyName) ?? undefined));

  const title = editing ? `Edit ${editing.name}` : "Add Database";
  return (
    <div
      className="overlayw open"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={props.onClose}
      onKeyDown={onKeyInside}
    >
      <div className="modal dbmodal" ref={modal} onMouseDown={(event) => event.stopPropagation()}>
        <form ref={formRef} onSubmit={(event) => void submit(event)} noValidate autoComplete="off">
          <div className="mhead">
            <div className="row1">
              <h3>{title}</h3>
              <button type="button" className="x" onClick={props.onClose} aria-label="Close">
                ×
              </button>
            </div>
          </div>

          <div className="mbody dbform">
            {editing ? null : (
              <EnginePicker engine={form.engine} onPick={(engine) => setForm((current) => withEngine(current, engine))} />
            )}

            {editing ? null : (
              <div className="dbfield">
                <label htmlFor={fieldId("name")}>Name</label>
                <input
                  id={fieldId("name")}
                  value={form.name}
                  placeholder={form.database.trim() || "The database's name"}
                  aria-invalid={bad("name")}
                  aria-describedby={describedBy("name")}
                  onPaste={guardPaste("name")}
                  onChange={(event) => set({ name: event.target.value })}
                />
                {said("name")}
              </div>
            )}

            <div className="dbpair wide">
              <div className="dbfield">
                <label htmlFor={fieldId("host")}>Server</label>
                <input
                  id={fieldId("host")}
                  className="mono"
                  spellCheck={false}
                  value={form.host}
                  placeholder="sql01.northstar.example"
                  aria-invalid={bad("host")}
                  aria-describedby={describedBy("host")}
                  onPaste={onServerPaste}
                  onChange={(event) => set({ host: event.target.value })}
                />
                {said("host")}
              </div>
              <div className="dbfield">
                <label htmlFor={fieldId("port")}>Port</label>
                <input
                  id={fieldId("port")}
                  className="mono"
                  inputMode="numeric"
                  value={form.port}
                  placeholder={String(info.port)}
                  aria-invalid={bad("port")}
                  aria-describedby={describedBy("port")}
                  onPaste={guardPaste("port")}
                  onChange={(event) => set({ port: event.target.value })}
                />
                {said("port")}
              </div>
            </div>

            <div className="dbfield">
              <label htmlFor={fieldId("database")}>{info.database}</label>
              <input
                id={fieldId("database")}
                className="mono"
                spellCheck={false}
                value={form.database}
                placeholder={info.database === "Service Name" ? "PERMITS" : "permits"}
                aria-invalid={bad("database")}
                aria-describedby={describedBy("database")}
                onPaste={guardPaste("database")}
                onChange={(event) => set({ database: event.target.value })}
              />
              {said("database")}
            </div>

            <div className="dbpair">
              <div className="dbfield">
                <label htmlFor={fieldId("user")}>User Name</label>
                <input
                  id={fieldId("user")}
                  className="mono"
                  spellCheck={false}
                  value={form.user}
                  placeholder="permits_reader"
                  aria-invalid={bad("user")}
                  aria-describedby={describedBy("user")}
                  onPaste={guardPaste("user")}
                  onChange={(event) => set({ user: event.target.value })}
                />
                {said("user")}
              </div>
              <div className="dbfield">
                <label htmlFor={fieldId("keyName")}>Password</label>
                {/* A name, shown as one: plain text, with what it is in front
                    of it. Nothing here is a password field to a browser or to
                    a password manager, so neither fills one in. */}
                <div className={keyNameSaid ? "dbsecret bad" : "dbsecret"}>
                  <span className="dbsecretk" id="db-secret-is">
                    Secret name
                  </span>
                  <input
                    id={fieldId("keyName")}
                    name="secret-name"
                    className="mono"
                    type="text"
                    spellCheck={false}
                    autoCapitalize="none"
                    autoComplete="off"
                    data-1p-ignore=""
                    data-lpignore="true"
                    value={form.keyName}
                    placeholder="permits-reader"
                    aria-invalid={keyNameSaid !== undefined}
                    aria-describedby={keyNameSaid ? `db-secret-is ${fieldId("keyName")}-said` : "db-secret-is"}
                    onPaste={guardPaste("keyName")}
                    onChange={(event) => set({ keyName: event.target.value })}
                  />
                </div>
                {keyNameSaid ? (
                  <div className="dberr" id={`${fieldId("keyName")}-said`}>
                    {keyNameSaid}
                  </div>
                ) : null}
              </div>
            </div>

            <button
              type="button"
              className="dbmore"
              aria-expanded={more === "open"}
              aria-controls={more === "closed" ? undefined : "db-more"}
              onClick={toggleMore}
            >
              <span className="dbmorek">More Settings</span>
              <span className="dbmorev">{more === "open" ? "" : moreSummary(form)}</span>
              <span className={more === "open" ? "chev open" : "chev"} aria-hidden="true" />
            </button>

            {more !== "closed" ? (
              <div
                className={more === "closing" ? "dbmorebody closing" : "dbmorebody"}
                id="db-more"
                onAnimationEnd={() => setMore((now) => (now === "closing" ? "closed" : now))}
              >
                <div className="dbpair">
                  <div className="dbfield">
                    <label htmlFor={fieldId("encryption")}>Encryption</label>
                    <select
                      id={fieldId("encryption")}
                      value={form.encryption}
                      aria-invalid={bad("encryption")}
                      aria-describedby={describedBy("encryption")}
                      onChange={(event) => set({ encryption: event.target.value as DatabaseForm["encryption"] })}
                    >
                      {encryptionsFor(form.engine).map((mode) => (
                        <option key={mode} value={mode}>
                          {ENCRYPTION_LABEL[mode]}
                        </option>
                      ))}
                    </select>
                    {said("encryption")}
                  </div>
                  <div className="dbfield">
                    <label htmlFor={fieldId("minTls")}>Oldest TLS Version</label>
                    <select
                      id={fieldId("minTls")}
                      value={form.minTls}
                      disabled={form.encryption === "off"}
                      aria-invalid={bad("minTls")}
                      aria-describedby={describedBy("minTls")}
                      onChange={(event) => set({ minTls: event.target.value as DatabaseForm["minTls"] })}
                    >
                      {TLS_VERSIONS.map((version) => (
                        <option key={version} value={version}>
                          TLS {version}
                        </option>
                      ))}
                    </select>
                    {said("minTls")}
                  </div>
                </div>
                <div className="dbfield">
                  <label htmlFor={fieldId("serverName")}>Certificate Name</label>
                  <input
                    id={fieldId("serverName")}
                    className="mono"
                    spellCheck={false}
                    value={form.serverName}
                    disabled={form.encryption === "off" || form.encryption === "require"}
                    placeholder={form.host.trim() || "sql01.northstar.example"}
                    aria-invalid={bad("serverName")}
                    aria-describedby={describedBy("serverName")}
                    onPaste={guardPaste("serverName")}
                  onChange={(event) => set({ serverName: event.target.value })}
                  />
                  {said("serverName")}
                </div>
              </div>
            ) : null}

            {general ? (
              <div className="banner warn dbsaid" role="alert">
                <span className="badge">!</span>
                <span className="btxt">{general}</span>
              </div>
            ) : null}
          </div>

          <div className="mfoot">
            <span className="grow"></span>
            <button type="button" className="btn ghost" onClick={props.onClose}>
              Cancel <span className="kbd">Esc</span>
            </button>
            <button type="submit" className="btn" disabled={sending}>
              {editing ? "Save" : "Add Database"} <span className="kbd">↵</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** The four engines, side by side. ← and → move the choice, as in any group
 *  of which one is chosen. */
function EnginePicker(props: { engine: Engine; onPick: (engine: Engine) => void }): React.ReactElement {
  const group = useRef<HTMLDivElement | null>(null);
  const pick = (engine: Engine): void => {
    props.onPick(engine);
    // The keyboard follows the choice.
    window.setTimeout(() => group.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus(), 0);
  };
  const onKey = (event: React.KeyboardEvent): void => {
    const at = ENGINES.indexOf(props.engine);
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    pick(ENGINES[(at + step + ENGINES.length) % ENGINES.length] as Engine);
  };
  return (
    <div className="dbfield">
      <span className="dblabel" id="db-engine-label">
        Engine
      </span>
      <div className="dbengines" role="radiogroup" aria-labelledby="db-engine-label" ref={group} onKeyDown={onKey}>
        {ENGINES.map((engine) => {
          const chosen = engine === props.engine;
          return (
            <button
              key={engine}
              type="button"
              role="radio"
              aria-checked={chosen}
              tabIndex={chosen ? 0 : -1}
              className={chosen ? "dbengine on" : "dbengine"}
              onClick={() => pick(engine)}
            >
              {ENGINE_INFO[engine].label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
