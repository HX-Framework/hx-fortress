import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { api, openEventStream, readToken, setUnauthorizedHandler, writeToken, ApiError } from "./api";
import {
  BOOTSTRAP_PATH,
  DEFAULT_ROUTE,
  formatPath,
  parsePath,
  takeFragmentToken,
  type Route,
  type ViewName,
} from "./router";
import { flashPanel } from "./lib/util";

export type { ViewName } from "./router";

export interface Principal {
  login: string;
  role: "operator" | "readonly";
  workbenchSub: string | null;
  createdAt: string;
}

export type AuthState =
  | { kind: "unknown" }
  | { kind: "anonymous" }
  | { kind: "signed-in"; principal: Principal };

/** What the workbench said about the person who clicked the button.
 *
 *  Held in MEMORY for the life of the tab and never stored: it is an annotation
 *  for the audit record, it conveys no capability, and a copy on disk would
 *  outlive the arrival it describes. Absent means a plain sign-in — no fetch, no
 *  extra route, no empty banner. */
export interface SsoIdentity {
  workbenchUser?: string;
  organization?: string;
}

/** The daemon's live log, as the events stream delivers it. */
export interface LogLine {
  /** The raw JSONL record, kept verbatim — a torn write is exactly what somebody
   *  reading the log at 3am needs to see. */
  line: string;
  ts: string | null;
  module: string | null;
  level: string | null;
  message: string | null;
  fields: Record<string, unknown>;
}

/** How many lines the tab holds. A follower with no ceiling is a memory leak
 *  with a scrollbar. */
const LOG_BUFFER = 2_000;

export type LiveState =
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "reconnecting"; reason: string };

interface NavOptions {
  replace?: boolean;
  modal?: boolean;
}

interface AppState {
  route: Route;
  view: ViewName;
  navigate: (patch: Partial<Route>, options?: NavOptions) => void;
  goto: (view: ViewName, anchor?: string) => void;
  registerPanel: (key: string, el: HTMLElement | null) => void;

  auth: AuthState;
  signIn: (login: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** The session budgets, as the server stated them at sign-in. */
  sessionBudgets: string | null;
  ssoIdentity: SsoIdentity | null;
  setSsoIdentity: (identity: SsoIdentity | null) => void;
  /** Names the server-side record of a one-click arrival. Display-free: it
   *  carries no identity of its own, only a reference to one. */
  setEntryId: (entryId: string | null) => void;
  /** The operator's banner phrase, once a valid setup or entry token was
   *  presented. Null before that, on every arrival. */
  marker: string | null;
  setMarker: (marker: string | null) => void;

  live: LiveState;

  theme: string;
  toggleTheme: () => void;
  shortcutsOpen: boolean;
  toggleShortcuts: () => void;
  closeShortcuts: () => void;
}

const Ctx = createContext<AppState>(null as unknown as AppState);
export const useApp = (): AppState => useContext(Ctx);

/** True only for a signed-in operator. Every mutation control asks this, and
 *  renders disabled with the server's own refusal sentence when it is false. */
export function useOperator(): boolean {
  const app = useApp();
  return app.auth.kind === "signed-in" && app.auth.principal.role === "operator";
}

function parseLogLine(line: string): LogLine {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const known = new Set(["ts", "module", "level", "message", "msg"]);
    const fields: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) if (!known.has(key)) fields[key] = entry;
    return {
      line,
      ts: typeof value.ts === "string" ? value.ts : null,
      module: typeof value.module === "string" ? value.module : null,
      level: typeof value.level === "string" ? value.level : null,
      message:
        typeof value.message === "string"
          ? value.message
          : typeof value.msg === "string"
            ? value.msg
            : null,
      fields,
    };
  } catch {
    return { line, ts: null, module: null, level: null, message: null, fields: {} };
  }
}

export function AppProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [route, setRoute] = useState<Route>(() => parsePath(window.location.pathname));
  const routeRef = useRef(route);
  routeRef.current = route;

  const [auth, setAuth] = useState<AuthState>({ kind: "unknown" });
  const [sessionBudgets, setSessionBudgets] = useState<string | null>(null);
  const [ssoIdentity, setSsoIdentity] = useState<SsoIdentity | null>(null);
  const [marker, setMarker] = useState<string | null>(null);
  // Held in memory, seeded from the fragment so a RELOAD after the hand-off
  // still records the dual identity — the annotation is cosmetic and does not
  // survive, but the record does.
  const entryIdRef = useRef<string | null>(takeFragmentToken("e"));
  const [live, setLive] = useState<LiveState>({ kind: "connecting" });
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [theme, setTheme] = useState<string>(() =>
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Back and forward are real navigations — the URL drives the console.
  useEffect(() => {
    const onPop = (): void => setRoute(parsePath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Normalize the entry URL once. The bootstrap path is left alone: it is a
  // pinned location the workbench links to, not a view with a canonical form.
  useEffect(() => {
    if (window.location.pathname.replace(/\/+$/, "") === BOOTSTRAP_PATH) return;
    const canonical = formatPath(routeRef.current);
    if (canonical !== window.location.pathname) {
      window.history.replaceState(window.history.state, "", canonical + window.location.hash);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigate = useCallback((patch: Partial<Route>, options?: NavOptions) => {
    const current = routeRef.current;
    // Going somewhere else dismisses whatever dialog is open — otherwise an
    // overlay would ride along and pile up in every later URL.
    const leaving = patch.view !== undefined && patch.view !== current.view;
    const next: Route = { ...current, ...(leaving ? { shortcuts: false, anchor: undefined } : {}), ...patch };
    const path = formatPath(next);
    if (path !== window.location.pathname) {
      const state = options?.modal ? { hxDialog: true } : {};
      window.history[options?.replace ? "replaceState" : "pushState"](state, "", path);
    }
    routeRef.current = next;
    setRoute(next);
  }, []);

  const goto = useCallback(
    (view: ViewName, anchor?: string) => {
      navigate({ view, anchor, query: view === "sessions" ? "" : routeRef.current.query });
      window.scrollTo(0, 0);
    },
    [navigate],
  );

  const panels = useRef<Record<string, HTMLElement | null>>({});
  const registerPanel = useCallback((key: string, el: HTMLElement | null) => {
    panels.current[key] = el;
  }, []);

  // A panel anchor in the URL scrolls to that panel and flashes it — on click
  // and on a cold load of the deep link alike.
  useEffect(() => {
    if (!route.anchor) return;
    const timer = setTimeout(() => flashPanel(panels.current[route.anchor as string] ?? null), 60);
    return () => clearTimeout(timer);
  }, [route.view, route.anchor]);

  // ── the session ────────────────────────────────────────────────────────────

  const forgetSession = useCallback(() => {
    writeToken(null);
    setAuth({ kind: "anonymous" });
    setSessionBudgets(null);
    setLogLines([]);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => forgetSession());
  }, [forgetSession]);

  // A reload keeps the tab signed in: the token survives in sessionStorage, so
  // the console asks who it is rather than dropping the person back at a form.
  useEffect(() => {
    let cancelled = false;
    const resume = async (): Promise<void> => {
      if (!readToken()) {
        if (!cancelled) setAuth({ kind: "anonymous" });
        return;
      }
      try {
        const principal = await api.whoami();
        if (!cancelled) setAuth({ kind: "signed-in", principal });
      } catch {
        if (!cancelled) forgetSession();
      }
    };
    void resume();
    return () => {
      cancelled = true;
    };
  }, [forgetSession]);

  const signIn = useCallback(async (login: string, password: string) => {
    // The entry id rides along when there is one. It is a NAME for a record the
    // server holds; the workbench identity stamped on this session comes from
    // that record, so a client that made one up annotates nothing.
    const result = await api.signIn(login, password, entryIdRef.current);
    writeToken(result.token);
    setSessionBudgets(result.sessions);
    const principal = await api.whoami();
    setAuth({ kind: "signed-in", principal });
  }, []);

  const setEntryId = useCallback((entryId: string | null) => {
    entryIdRef.current = entryId;
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.signOut();
    } catch (err) {
      // A session the server already dropped is a session this tab does not
      // have either; anything else still ends the tab's own copy.
      if (!(err instanceof ApiError)) throw err;
    }
    forgetSession();
  }, [forgetSession]);

  // ── the marker ─────────────────────────────────────────────────────────────
  //
  // Rendered only to an arrival that presented a live setup or entry token. A
  // console that showed its operator's banner phrase to any stranger who reached
  // the port would be disclosing which fortress this is before anyone signed in.
  useEffect(() => {
    // READ AND CLEARED at construction: the entry id leaves the address bar
    // immediately, so a screenshot, a bookmark or a shared URL does not carry
    // it. The banner phrase for a one-click arrival came back with the exchange
    // itself; the setup screen takes its own token the same way, during its
    // first render.
    const carried = takeFragmentToken("e");
    if (carried) entryIdRef.current = carried;
  }, [route.view]);

  // ── the one long-lived connection ──────────────────────────────────────────

  useEffect(() => {
    if (auth.kind !== "signed-in") return;
    setLive({ kind: "connecting" });
    const close = openEventStream({
      onOpen: () => setLive({ kind: "live" }),
      onClosed: (reason) => setLive({ kind: "reconnecting", reason }),
      onEvent: (event, data) => {
        if (event !== "log") return;
        const line = (data as { line?: unknown }).line;
        if (typeof line !== "string") return;
        setLogLines((prev) => {
          const next = [...prev, parseLogLine(line)];
          return next.length > LOG_BUFFER ? next.slice(next.length - LOG_BUFFER) : next;
        });
      },
    });
    return close;
  }, [auth.kind]);

  const clearLogLines = useCallback(() => setLogLines([]), []);
  const toggleTheme = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);

  const shortcutsOpen = route.shortcuts;
  const closeShortcuts = useCallback(() => {
    if ((window.history.state as { hxDialog?: boolean } | null)?.hxDialog) window.history.back();
    else navigate({ shortcuts: false }, { replace: true });
  }, [navigate]);
  const toggleShortcuts = useCallback(() => {
    if (routeRef.current.shortcuts) closeShortcuts();
    else navigate({ shortcuts: true }, { modal: true });
  }, [navigate, closeShortcuts]);

  const value = useMemo<AppState>(
    () => ({
      route,
      view: route.view,
      navigate,
      goto,
      registerPanel,
      auth,
      signIn,
      signOut,
      sessionBudgets,
      ssoIdentity,
      setSsoIdentity,
      setEntryId,
      marker,
      setMarker,
      live,
      theme,
      toggleTheme,
      shortcutsOpen,
      toggleShortcuts,
      closeShortcuts,
    }),
    [
      route,
      navigate,
      goto,
      registerPanel,
      auth,
      signIn,
      signOut,
      sessionBudgets,
      ssoIdentity,
      marker,
      live,
      theme,
      toggleTheme,
      shortcutsOpen,
      toggleShortcuts,
      closeShortcuts,
    ],
  );

  // The daemon log is its OWN context. Held in the app-state memo, every line
  // that arrived rebuilt that object — so all twelve mounted views re-rendered
  // and App's two document keydown listeners were torn down and re-added, at the
  // rate the daemon writes. Only the Logs view reads these.
  const logsValue = useMemo<LogLinesState>(
    () => ({ logLines, clearLogLines }),
    [logLines, clearLogLines],
  );

  return (
    <Ctx.Provider value={value}>
      <LogsCtx.Provider value={logsValue}>{children}</LogsCtx.Provider>
    </Ctx.Provider>
  );
}

export interface LogLinesState {
  logLines: LogLine[];
  clearLogLines: () => void;
}

const LogsCtx = createContext<LogLinesState | null>(null);

/** The live daemon log. Separate from `useApp` on purpose — see the provider. */
export function useLogLines(): LogLinesState {
  const value = useContext(LogsCtx);
  if (!value) throw new Error("useLogLines outside the provider");
  return value;
}

export { DEFAULT_ROUTE, takeFragmentToken };
