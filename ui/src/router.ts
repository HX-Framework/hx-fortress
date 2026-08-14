// Pretty URLs — the path is the single source of truth for what the console
// shows. Every stateful surface is a real, bookmarkable, semantically-named
// location, and a cold load of any of them lands where the link says because the
// server hands the shell to every non-asset path.
//
//   /                              Overview
//   /sessions                      the session list
//   /sessions/search/routing+gates …searched
//   /sessions/claude-cli/59e3ccf5  one session (its storage key)
//   /people · /people/erik         who is sending, and one of them
//   /residency · /compliance       the two compliance lenses
//   /postgres · /storage · /embeddings   setup and health
//   /ops · /logs                   system
//   /setup                         set a password from a one-time link
//   /sso/bootstrap                 the workbench hand-off
//
// THE FRAGMENT EXCEPTION. Three tokens arrive in location.hash and nowhere else:
// the setup token (#t=), the SSO entry token (#e=) and the bootstrap grant
// (#g=). A fragment is never sent to the server, so it cannot appear in a
// request line, an access log, a proxy log or a Referer header — which is the
// whole reason those three do not ride the path or the query. This module is the
// only place that reads them, and it CLEARS the fragment as it reads: a token
// left in the address bar is one a screenshot, a bookmark or a shared URL
// carries away.

export type ViewName =
  | "overview"
  | "sessions"
  | "session-detail"
  | "people"
  | "person-detail"
  | "residency"
  | "compliance"
  | "postgres"
  | "storage"
  | "embeddings"
  | "ops"
  | "logs"
  | "setup"
  | "sso-bootstrap";

export interface Route {
  view: ViewName;
  /** session list */
  query: string;
  family?: string;
  sid?: string;
  /** one person, by their external id */
  personId?: string;
  /** panel the page should scroll to and flash */
  anchor?: string;
  /** logs */
  logModule: string;
  logLevel: string;
  /** the keyboard map, over any page */
  shortcuts: boolean;
}

export const DEFAULT_ROUTE: Route = {
  view: "overview",
  query: "",
  logModule: "all",
  logLevel: "all",
  shortcuts: false,
};

/** The views a signed-in console navigates between, in nav order. Setup and the
 *  bootstrap hand-off are deliberately absent: they are arrival screens, not
 *  places, and neither has a nav entry or a shortcut. */
export const NAV_VIEWS = [
  "overview",
  "sessions",
  "people",
  "residency",
  "compliance",
  "postgres",
  "storage",
  "embeddings",
  "ops",
  "logs",
] as const satisfies readonly ViewName[];

/** A view that appears in the sidebar, narrowed from the list above so anything
 *  keyed by nav order cannot drift out of it. */
export type NavView = (typeof NAV_VIEWS)[number];

/** Views with a URL segment of their own. The segment IS the view's name in
 *  every case, so the two directions are DERIVED rather than written twice:
 *  as two hand-maintained objects they were identity inverses of each other,
 *  and a rename in one of them is a path that routes to nothing. */
const ROUTED_VIEWS = [
  "sessions",
  "people",
  "residency",
  "compliance",
  "postgres",
  "storage",
  "embeddings",
  "ops",
  "logs",
  "setup",
] as const satisfies readonly ViewName[];

const VIEW_SEGMENT: Partial<Record<ViewName, string>> = Object.fromEntries(
  ROUTED_VIEWS.map((view) => [view, view]),
);
const SEGMENT_VIEW: Record<string, ViewName> = Object.fromEntries(
  ROUTED_VIEWS.map((view) => [view, view]),
);

/** The pinned path of the workbench hand-off. Served by the index handler like
 *  every other view, so it costs no server route. */
export const BOOTSTRAP_PATH = "/sso/bootstrap";

const ANCHORS: Partial<Record<ViewName, readonly string[]>> = {
  compliance: ["paths", "retention", "trail"],
  ops: ["commands", "cli"],
};

const LOG_LEVELS: Record<string, string> = { warn: "warnings", error: "errors" };
const LOG_LEVEL_KEY: Record<string, string> = { warnings: "warn", errors: "error" };

// Search terms ride in the path: spaces become "+", everything else is
// percent-encoded, so "a+b" and "a b" stay distinguishable both ways.
const encodeQ = (q: string): string => encodeURIComponent(q).replace(/%20/g, "+");
const decodeQ = (s: string): string => decodeURIComponent(s.replace(/\+/g, " "));

// ── the fragment exception ───────────────────────────────────────────────────

export type FragmentKey = "t" | "e" | "g";

/** Read one of the three fragment-carried tokens WITHOUT clearing it. Used to
 *  decide which arrival screen to render before anything is consumed. */
export function peekFragmentToken(key: FragmentKey, hash = window.location.hash): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw.startsWith(`${key}=`)) return null;
  const value = raw.slice(key.length + 1);
  return value.length > 0 ? value : null;
}

/** Read it and clear the address bar in the same breath. The token stays in
 *  memory for as long as the screen that consumes it lives, and nowhere else. */
export function takeFragmentToken(key: FragmentKey): string | null {
  const value = peekFragmentToken(key);
  if (value !== null) clearFragment();
  return value;
}

export function clearFragment(): void {
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
}

// ── parse ────────────────────────────────────────────────────────────────────

export function parsePath(pathname: string): Route {
  const raw = pathname.split("/").filter(Boolean);
  const route: Route = { ...DEFAULT_ROUTE };

  if (pathname.replace(/\/+$/, "") === BOOTSTRAP_PATH) {
    return { ...route, view: "sso-bootstrap" };
  }

  // The keyboard map overlays any page, so it is always the last segment.
  const segments = raw[raw.length - 1] === "shortcuts" ? raw.slice(0, -1) : raw;
  route.shortcuts = segments.length !== raw.length;
  if (segments.length === 0) return route;

  const head = segments[0] as string;
  const rest = segments.slice(1);
  const view = SEGMENT_VIEW[head];
  if (!view) return route; // an unknown path is the Overview, rewritten once
  route.view = view;

  if (view === "people") {
    if (rest[0]) {
      route.view = "person-detail";
      route.personId = decodeQ(rest[0] as string);
    }
    return route;
  }

  if (view === "sessions") {
    if (rest[0] === "search" && rest[1]) {
      route.query = decodeQ(rest[1] as string);
    } else if (rest[0] && rest[1]) {
      route.view = "session-detail";
      route.family = decodeQ(rest[0] as string);
      route.sid = decodeQ(rest[1] as string);
    }
    return route;
  }

  if (view === "logs") {
    for (const segment of rest) {
      if (LOG_LEVEL_KEY[segment]) route.logLevel = LOG_LEVEL_KEY[segment] as string;
      else route.logModule = segment;
    }
    return route;
  }

  const allowed = ANCHORS[view] ?? [];
  if (rest[0] && allowed.includes(rest[0] as string)) route.anchor = rest[0];
  return route;
}

// ── format ───────────────────────────────────────────────────────────────────

export function formatPath(route: Route): string {
  const tail = route.shortcuts ? ["shortcuts"] : [];
  const done = (parts: readonly string[]): string => `/${[...parts, ...tail].join("/")}`;

  if (route.view === "sso-bootstrap") return BOOTSTRAP_PATH;
  if (route.view === "person-detail") {
    return route.personId ? done(["people", encodeQ(route.personId)]) : done(["people"]);
  }
  if (route.view === "session-detail") {
    return route.family && route.sid
      ? done(["sessions", encodeQ(route.family), encodeQ(route.sid)])
      : done(["sessions"]);
  }

  const head = VIEW_SEGMENT[route.view];
  if (!head) return done([]);
  const parts: string[] = [head];
  if (route.view === "sessions" && route.query.trim()) {
    parts.push("search", encodeQ(route.query.trim()));
  } else if (route.view === "logs") {
    if (route.logModule !== "all") parts.push(route.logModule);
    if (route.logLevel !== "all") parts.push(LOG_LEVELS[route.logLevel] as string);
  } else if (route.anchor && (ANCHORS[route.view] ?? []).includes(route.anchor)) {
    parts.push(route.anchor);
  }
  return done(parts);
}
