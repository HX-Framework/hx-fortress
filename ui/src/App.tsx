import React, { useEffect } from "react";

import { api, NO_ANSWER } from "./api";
import {
  DISCLOSURE_FOOTER,
  DISCLOSURE_INLINE,
} from "./disclosure";
import { useResource } from "./hooks";
import { closeAllMenus } from "./lib/util";
import { NAV_VIEWS, type NavView, type ViewName } from "./router";
import { AppProvider, useApp } from "./state";
import Bootstrap from "./views/Bootstrap";
import Compliance from "./views/Compliance";
import { Embeddings, Postgres, Storage } from "./views/Health";
import Logs from "./views/Logs";
import Ops from "./views/Ops";
import Overview from "./views/Overview";
import { People, PersonDetail } from "./views/People";
import Residency from "./views/Residency";
import { SessionDetail, Sessions } from "./views/Sessions";
import Setup from "./views/Setup";
import SignIn from "./views/SignIn";

const NAV_GROUPS: readonly { label: string; views: readonly NavView[] }[] = [
  { label: "Operate", views: ["overview", "sessions", "people"] },
  { label: "Compliance", views: ["residency", "compliance"] },
  { label: "Setup & health", views: ["postgres", "storage", "embeddings"] },
  { label: "System", views: ["ops", "logs"] },
];

/** Keyed by NavView, not by string: a view listed in a group with no label here
 *  used to render the word `undefined` into the sidebar. */
const NAV_LABEL: Record<NavView, string> = {
  overview: "Overview",
  sessions: "Sessions",
  people: "Adoption",
  residency: "Residency",
  compliance: "Posture & Audit",
  postgres: "Postgres",
  storage: "Object storage",
  embeddings: "Embeddings",
  ops: "Ops Tools",
  logs: "Logs",
};

/** Number keys 1-9 then 0, in nav order. */
const VIEW_KEYS: Record<string, ViewName> = Object.fromEntries(
  NAV_VIEWS.map((view, i) => [String((i + 1) % 10), view]),
);

function Chrome(): React.ReactElement {
  const app = useApp();

  const status = useResource(() => api.status(), [], { pollMs: 5_000 });
  const identity = useResource(() => api.identity(), [], { pollMs: 60_000 });

  // Land the keyboard somewhere on arrival. The shell mounted with focus on
  // `document.body`, so the first Tab out of a keyboard sign-in went to the
  // skip-link and the second to the nav — a surface that opens keyboard
  // homeless. Once, at mount, and only while nothing else already holds focus:
  // a poll must never yank focus out from under someone mid-type.
  const nav = React.useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    const landing =
      nav.current?.querySelector<HTMLButtonElement>("button.active") ??
      nav.current?.querySelector<HTMLButtonElement>("button");
    landing?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") {
        app.toggleShortcuts();
        return;
      }
      const view = VIEW_KEYS[e.key];
      if (view) app.goto(view);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [app]);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (app.shortcutsOpen) {
        app.closeShortcuts();
        return;
      }
      closeAllMenus();
    };
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [app]);

  const principal = app.auth.kind === "signed-in" ? app.auth.principal : null;
  const daemon = status.data;
  // A status endpoint that does not answer AT ALL means the console process
  // itself went away — a restart, an update, a crash. It is a different fact
  // from a stopped daemon, and from a console that answered with a refusal, so
  // it gets its own words whether or not a page was already rendered.
  const consoleUnreachable = status.status === NO_ANSWER && status.error !== null;

  return (
    <>
      <div className="topbar">
        <div className="mark">
          <i></i>
          <i></i>
          <i></i>
          <i></i>
        </div>
        <div className="wordmark">HX Fortress</div>

        <div className="chip" style={{ marginLeft: 8 }}>
          <span
            className="dot"
            style={{
              background:
                daemon?.daemon === "running"
                  ? "var(--ok)"
                  : daemon?.daemon === "stale" || daemon?.daemon === "failed"
                    ? "var(--danger)"
                    : "var(--border-strong)",
            }}
          ></span>{" "}
          <span>{daemon ? daemon.copy : "…"}</span>
          <div className="pop left">
            <div className="plbl">Fortress daemon</div>
            <span>{daemon ? daemon.copy : "reading the daemon's status file"}</span>
            <div className="plbl">Process</div>
            <span className="mono" style={{ fontSize: 13.5 }}>
              {daemon?.pid === null || daemon?.pid === undefined ? "no process" : `pid ${daemon.pid}`}
            </span>
            <div className="plbl">Metadata database</div>
            <span>{daemon ? databaseLine(daemon.database) : "unknown"}</span>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button className="btn ghost sm" onClick={() => app.goto("ops")}>
                Ops Tools →
              </button>
              <button className="btn ghost sm" onClick={() => app.goto("logs")}>
                Logs →
              </button>
            </div>
          </div>
        </div>

        <div className="spacer"></div>

        <button className="iconbtn" title="Switch theme" onClick={app.toggleTheme}>
          <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            {app.theme === "dark" ? (
              <>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
              </>
            ) : (
              <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
            )}
          </svg>
        </button>

        <div className="chip click" onClick={() => app.goto("ops")}>
          <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M12 3l7 3v5c0 4.8-3.2 7.7-7 9-3.8-1.3-7-4.2-7-9V6z" />
          </svg>
          <b>{identity.data?.boundOrgId ?? "This fortress"}</b>
          <div className="pop">
            <div className="pname">{identity.data?.boundOrgId ?? "This fortress"}</div>
            <div className="psub">
              {identity.data?.boundOrgId
                ? "runs on this host, under this organization's own keys"
                : "not enrolled to an organization yet"}
            </div>
            <div className="plbl">Fortress id</div>
            <span className="mono" style={{ fontSize: 13 }}>
              {identity.data?.fortressId ?? "—"}
            </span>
            <div className="plbl">Fortress root</div>
            <span className="mono" style={{ fontSize: 13 }}>
              {identity.data?.root ?? "—"}
            </span>
          </div>
        </div>

        {principal ? (
          <div className="chip">
            <span className="avatar">{principal.login.slice(0, 2).toUpperCase()}</span>{" "}
            <b>{principal.login}</b>
            <div className="pop">
              <div className="pname">{principal.login}</div>
              <div className="psub">
                {principal.role === "operator"
                  ? "operator — full read and every control this console has"
                  : "read-only — every view, no controls"}
              </div>
              {principal.workbenchSub ? (
                <>
                  <div className="plbl">Arrived from the workbench as</div>
                  <span className="mono" style={{ fontSize: 13 }}>
                    {principal.workbenchSub}
                  </span>
                </>
              ) : null}
              <div className="plbl">This console shows</div>
              {DISCLOSURE_INLINE}
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button className="btn ghost sm" onClick={() => void app.signOut()}>
                  Sign out
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="shell">
        <nav className="side" ref={nav}>
          {NAV_GROUPS.map((group) => (
            <React.Fragment key={group.label}>
              <div className="navlbl">{group.label}</div>
              {group.views.map((view) => (
                <NavButton key={view} view={view} />
              ))}
            </React.Fragment>
          ))}
        </nav>

        <main>
          {consoleUnreachable ? (
            <div className="banner warn">
              <span className="badge">!</span>
              <span className="btxt">
                <b>This console is not answering.</b> {status.error}. This page reconnects on its
                own once it does; the fortress daemon and its ingest are unaffected.
              </span>
            </div>
          ) : null}
          {app.live.kind === "reconnecting" ? (
            <div className="banner warn">
              <span className="badge">!</span>
              <span className="btxt">
                <b>Reconnecting the live feed.</b> {app.live.reason}. Panels below still refresh on
                their own; the log tail resumes where it stopped.
              </span>
            </div>
          ) : null}
          {daemon?.externalBanner ? (
            <div className="banner dangerb">
              <span className="badge">!</span>
              <span className="btxt">
                {daemon.externalBanner.map((line, i) => (
                  <p className="saidby" key={i}>
                    {line}
                  </p>
                ))}
              </span>
            </div>
          ) : null}
          {daemon?.rootMatch === "different" ? (
            <div className="banner warn">
              <span className="badge">!</span>
              <span className="btxt">
                <b>This console and the daemon are reading different fortress roots.</b> The console
                serves {identity.data?.root ?? "its own root"}; the daemon published{" "}
                {identity.data?.daemonRoot ?? "another"}.
              </span>
            </div>
          ) : null}

          <Overview />
          <Sessions />
          <SessionDetail />
          <People />
          <PersonDetail />
          <Residency />
          <Compliance />
          <Postgres />
          <Storage />
          <Embeddings />
          <Ops />
          <Logs />
        </main>
      </div>

      <footer>
        <div className="inner">
          <div className="mark" style={{ marginTop: 5 }}>
            <i></i>
            <i></i>
            <i></i>
            <i></i>
          </div>
          <div className="txt">
            <b>
              HX Fortress runs on this host, as part of the <code className="hx">hx-fortress</code>{" "}
              service.
            </b>
            <br />
            {DISCLOSURE_FOOTER[0]}
            <br />
            {DISCLOSURE_FOOTER[1]}
          </div>
        </div>
      </footer>

      <div
        className={app.shortcutsOpen ? "overlayw open" : "overlayw"}
        onClick={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).closest("[data-close]")) {
            app.closeShortcuts();
          }
        }}
      >
        <div className="modal" style={{ width: "min(560px,100%)" }}>
          <div className="mhead">
            <div className="row1">
              <h3>Keyboard Shortcuts</h3>
              <button className="x" data-close>
                ✕
              </button>
            </div>
            <p className="msub">Available anywhere, except while typing in a field.</p>
          </div>
          <div className="mbody scrolly" style={{ paddingBottom: 26 }}>
            <div className="clirow">
              <span className="c">
                <span className="kbd">1</span> – <span className="kbd">9</span>,{" "}
                <span className="kbd">0</span>
              </span>
              <span className="d">
                Go to a section, in the order of the sidebar: {NAV_VIEWS.map((v) => NAV_LABEL[v]).join(", ")}.
              </span>
            </div>
            <div className="clirow">
              <span className="c">
                <span className="kbd">?</span>
              </span>
              <span className="d">Show or hide this menu.</span>
            </div>
            <div className="clirow">
              <span className="c">
                <span className="kbd">Esc</span>
              </span>
              <span className="d">Close dialogs and menus.</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function databaseLine(state: { kind: string; mode?: string }): string {
  if (state.kind === "ready") {
    return state.mode === "external" ? "external Postgres" : "embedded Postgres";
  }
  return state.kind.split("-").join(" ");
}

function NavButton({ view }: { view: NavView }): React.ReactElement {
  const app = useApp();
  const index = NAV_VIEWS.indexOf(view);
  const active =
    app.view === view ||
    (view === "sessions" && app.view === "session-detail") ||
    (view === "people" && app.view === "person-detail");
  return (
    <button className={active ? "active" : undefined} onClick={() => app.goto(view)}>
      <span className="n">{String(index + 1).padStart(2, "0")}</span> {NAV_LABEL[view]}
    </button>
  );
}

/** Which screen the tab is on. The three arrival screens are decided BEFORE the
 *  session is, because two of them exist precisely for someone who has none. */
function Screen(): React.ReactElement | null {
  const app = useApp();
  if (app.view === "sso-bootstrap") return <Bootstrap />;
  if (app.view === "setup") return <Setup />;
  if (app.auth.kind === "unknown") return null;
  if (app.auth.kind === "anonymous") return <SignIn />;
  return <Chrome />;
}

export default function App(): React.ReactElement {
  return (
    <AppProvider>
      <Screen />
    </AppProvider>
  );
}
