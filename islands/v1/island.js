// A Secure Data Island's edge: the part that every kind of Secure Data Island shares.
//
// A Secure Data Island is a small page that HX Fortress serves at its own address. The control
// plane's page shows it in a frame. Everything a person sees in it was fetched from this origin,
// and the page's Content-Security-Policy lets it send nothing to any other address.
//
// This file holds what crosses the frame's edge and what keeps a person signed in:
//
//   - the messages to and from the page around the frame. Every one that leaves goes through
//     `post`, which sends only what `TO_PAGE` lists: a message that is not listed is not sent,
//     and a field that is not listed, or whose value is not of its listed kind, is left out. No
//     listed field can hold a row's value or a typed character. contract.json holds the same
//     list for the page around the frame;
//   - the session: a token in a request header, kept for this tab, and never a cookie;
//   - the keyboard's way in and out;
//   - the guard on copy, cut, drag and print, for a kind that shows rows.
//
// What a kind shows is in a file of its own (rows.js), which calls `start` below.
//
// Rows need two keys. The person's own sign-in is kept here. The control plane's grant is asked
// from the page around the frame each time rows are read. HX Fortress checks both.

/** The folder these files are served from: `<origin>/island/v1/`. */
const BASE = new URL(".", import.meta.url);

/** The request header that carries a Secure Data Island's session. */
export const TOKEN_HEADER = "x-fortress-island-token";
/** Where this tab keeps it. */
const TOKEN_KEY = "hx-fortress-island-token";

/** How long the frame waits for the page around it to hand over a grant. */
const GRANT_WAIT_MS = 8000;
/** How long the frame asks whether the sign-in in the window has finished. */
const CLAIM_FOR_MS = 5 * 60 * 1000;
/** What a page says when it was opened with nothing to show. */
const OPEN_FROM_THE_PAGE = "Open this page from the page that shows these rows.";

// ── the closed lists ────────────────────────────────────────────────────────────────────────────
// contract.json holds each of these for the page around the frame, and a test holds the two to
// each other.

/** The style tokens the page around the frame may set, each with the kind of value it takes. */
export const TOKENS = /** @type {Record<string, keyof typeof VALID>} */ ({
  "--hx-fg": "color", "--hx-muted": "color", "--hx-faint": "color", "--hx-line": "color", "--hx-line-2": "color",
  "--hx-head": "color", "--hx-head-fg": "color", "--hx-hover": "color", "--hx-sel": "color", "--hx-sel-line": "color",
  "--hx-surface": "color", "--hx-stripe": "color", "--hx-edge-color": "color",
  "--hx-fs": "px", "--hx-fs-head": "px", "--hx-fs-sm": "px", "--hx-row": "px", "--hx-head-row": "px", "--hx-pad-x": "px", "--hx-pad-y": "px",
  "--hx-radius": "px", "--hx-edge": "px", "--hx-col": "px",
  "--hx-lh": "num", "--hx-weight-head": "num", "--hx-weight": "num", "--hx-head-case": "word", "--hx-head-space": "em",
  "--hx-font": "font",
});
export const VALID = {
  color: /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?(\s*[, ]\s*[\d.]+%?){2}(\s*[,/]\s*[\d.]+%?)?\s*\)|transparent)$/i,
  px: /^-?\d{1,3}(\.\d{1,3})?px$/,
  num: /^\d{1,4}(\.\d{1,4})?$/,
  em: /^-?\d(\.\d{1,3})?em$/,
  word: /^(none|uppercase)$/,
  font: /^(Inter|IBM Plex Mono|system-ui|ui-monospace)$/,
};

/** A key chord the page may ask to hear. Each holds the Command key or the Control key. */
export const CHORD = /^mod\+(shift\+)?(alt\+)?([a-z0-9]|\/|\.|,|\\|\[|\]|enter)$/;

/** What a frame says of itself to the page. */
export const STATES = /** @type {const} */ (["signed-out", "waiting", "loading", "ready", "denied", "error"]);
/** Where the keyboard leaves a frame. */
export const EDGES = /** @type {const} */ (["top", "bottom", "escape"]);

/** The codes HX Fortress answers a refused read with, and the state each one shows as. */
export const REFUSALS = /** @type {Record<string, "denied" | "error">} */ ({
  "grant-missing": "denied", "grant-signature": "denied", "grant-purpose": "denied", "grant-expired": "denied",
  "grant-other-island": "denied", "grant-other-settings": "denied", "grant-other-person": "denied", "grant-used": "denied",
  "not-allowed": "denied", "query-failed": "error", "unavailable": "error", "too-many": "error", "not-this-page": "error",
});
/** The frame's own two codes: HX Fortress did not answer, and the page gave no grant. */
export const OWN_CODES = /** @type {const} */ (["network", "no-grant"]);
/** The refusals that the same read may get past with a new grant, or a little later. */
const WORTH_ANOTHER_TRY = new Set(["grant-expired", "grant-used", "query-failed", "unavailable", "too-many"]);

/**
 * Everything a frame may tell the page around it: each message with its fields, and for each
 * field the kind of value it takes. `post` sends nothing else.
 *
 *   kind     this page's own kind                   state   one of STATES
 *   signin   the address of this HX Fortress's      count   a whole number, 0 or more
 *            sign-in page, with a challenge         code    one of REFUSALS or OWN_CODES
 *   px       a number of pixels, 0 or more          edge    one of EDGES
 *   chord    a chord that the page asked to hear
 */
export const TO_PAGE = /** @type {Record<string, Record<string, "kind" | "state" | "signin" | "count" | "code" | "px" | "edge" | "chord">>} */ ({
  ready: { view: "kind" },
  state: { s: "state", signin: "signin", rows: "count", code: "code" },
  size: { h: "px" },
  "grant?": { n: "count" },
  "focus-ok": {},
  "focus-in": {},
  leave: { edge: "edge" },
  key: { chord: "chord" },
});

/** Everything a frame takes from the page around it. A message with another name is dropped. */
export const FROM_PAGE = /** @type {const} */ (["init", "theme", "grant", "focus", "signin-started", "signin-cancel", "signout"]);

/** What pages of one HX Fortress say to each other: the frames of one page, the page of a
 *  result, and the sign-in window. The page around a frame is never sent these. */
export const BETWEEN = /** @type {const} */ (["session?", "session", "signed-out", "signin?", "signin!", "signin-done"]);

// ── a sign-in's three values ────────────────────────────────────────────────────────────────────
// Each is the hash of the one before it. The frame makes the verifier and never hands it out.
// The pass goes to the sign-in window and to nothing else, by a message that the browser
// delivers to a page of this origin only. The challenge is in the sign-in window's address,
// which the page around the frame opens: it is no secret. The challenge lets its holder do
// nothing. The pass lets the window keep a proved sign-in for the frame. Only the verifier
// takes it.

/** The shape of a verifier, a pass and a challenge: base64url of 32 bytes. */
export const HASHED = /^[A-Za-z0-9_-]{43}$/;
const PASS_DOMAIN = "hx-fortress island sign-in window\n";
const CHALLENGE_DOMAIN = "hx-fortress island sign-in challenge\n";

/** base64url of some bytes, without padding. */
function b64url(/** @type {Uint8Array} */ bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/**
 * @param {string} domain
 * @param {string} value
 */
async function hashed(domain, value) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(domain + value))));
}
/** The pass a sign-in window holds, from the frame's verifier. */
export const passOf = (/** @type {string} */ verifier) => hashed(PASS_DOMAIN, verifier);
/** The challenge in a sign-in window's address, from the window's pass. */
export const challengeOf = (/** @type {string} */ pass) => hashed(CHALLENGE_DOMAIN, pass);

/** The address of this HX Fortress's sign-in page, up to the challenge. */
export const SIGNIN_ADDRESS = `${new URL("signin", BASE).href}#c=`;

// ── small things every page of this folder uses ─────────────────────────────────────────────────

/**
 * Make one element. A value is only ever set as text, never as markup.
 *
 * @param {string} tag
 * @param {Record<string, unknown>} [props]
 * @param {(Node | string | null | undefined | false)[] | Node | string | null} [children]
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name === "class") node.className = String(value);
    else if (name === "text") node.textContent = String(value);
    else if (name.startsWith("on") && typeof value === "function") node.addEventListener(name.slice(2), /** @type {EventListener} */ (value));
    else if (value !== false && value != null) node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) if (child) node.append(child);
  return node;
}

/** An element of the page, by its id. @param {string} id */
export function at(id) {
  return /** @type {HTMLElement} */ (document.getElementById(id));
}

/**
 * One call to HX Fortress. Every call but the one for `config` is a POST from a page of this
 * folder, so HX Fortress can tell it from a request that another site caused. Null when
 * HX Fortress did not answer.
 *
 * @param {string} path
 * @param {unknown} [payload]
 * @param {string | null} [token] A Secure Data Island's session, when the caller holds one.
 * @returns {Promise<Response | null>}
 */
export function call(path, payload = {}, token = null) {
  return fetch(new URL(path, BASE), {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { [TOKEN_HEADER]: token } : {}) },
    body: JSON.stringify(payload),
    credentials: "omit",
    cache: "no-store",
  }).catch(() => null);
}

/**
 * True for a window that shows a page of this HX Fortress. Reading a window of another origin
 * throws.
 *
 * @param {Window} win
 */
export function ownPage(win) {
  try {
    return win.location.origin === location.origin;
  } catch {
    return false;
  }
}

/**
 * Say something to another page of this HX Fortress. A window that shows any other page is told
 * nothing, and the browser delivers the message to a window of this origin only, whatever it
 * shows by then.
 *
 * @param {Window} to
 * @param {(typeof BETWEEN)[number]} t
 * @param {Record<string, string>} [fields]
 */
export function tell(to, t, fields = {}) {
  if (BETWEEN.includes(t) && ownPage(to)) to.postMessage({ hx: 1, t, ...fields }, location.origin);
}

/** @typedef {{ pages: string | null, organization: string | null, signIn: "account" | "provider" }} Config */
/** @type {Promise<Config | null> | null} */
let asked = null;
/**
 * What HX Fortress says of itself to a page file: who may frame it, the organization's name,
 * and how its people sign in. It holds no data and needs no sign-in. One request for a page,
 * however many of its scripts ask. Null when HX Fortress did not answer.
 *
 * @returns {Promise<Config | null>}
 */
export function readConfig() {
  asked ??= fetch(new URL("config", BASE), { credentials: "omit", cache: "no-store" })
    .then(async (res) => {
      if (!res.ok) return null;
      const said = await res.json();
      return /** @type {Config} */ ({
        pages: typeof said.pages === "string" ? said.pages : null,
        organization: typeof said.organization === "string" && said.organization ? said.organization : null,
        signIn: said.signIn === "provider" ? "provider" : "account",
      });
    })
    .catch(() => null)
    .then((config) => {
      // An answer that did not come is asked for again the next time.
      if (config === null) asked = null;
      return config;
    });
  return asked;
}

/** The keys that have a name of their own in a chord, by where they are on the keyboard. */
const KEY_NAMES = /** @type {Record<string, string>} */ ({
  Slash: "/", Period: ".", Comma: ",", Backslash: "\\", BracketLeft: "[", BracketRight: "]", Enter: "enter", NumpadEnter: "enter",
});
/**
 * The name of the key in a chord. A letter or a digit is named by the character the keyboard's
 * layout gives it. A key that Shift or Option turned into another character ("?" for "/", "!"
 * for "1") is named by the key itself, so that "mod+shift+/" is Shift with the slash key.
 *
 * @param {Pick<KeyboardEvent, "key" | "code" | "altKey" | "shiftKey">} e
 * @returns {string | null}
 */
export function keyName(e) {
  if (e.key === "Enter") return "enter";
  const typed = e.key.length === 1 ? e.key.toLowerCase() : "";
  if (!e.altKey && /^[a-z0-9]$/.test(typed)) return typed;
  if (!e.altKey && !e.shiftKey && Object.values(KEY_NAMES).includes(typed)) return typed;
  const letter = /^Key([A-Z])$/.exec(e.code)?.[1]?.toLowerCase();
  const digit = /^Digit([0-9])$/.exec(e.code)?.[1];
  return letter ?? digit ?? (Object.hasOwn(KEY_NAMES, e.code) ? KEY_NAMES[e.code] : null);
}

// ── one kind, on one page ───────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} IslandDef What the page around the frame holds of one Secure Data Island.
 * @property {string} id
 * @property {string} kind
 * @property {string} target
 * @property {Record<string, unknown>} settings
 * @property {string | null} link
 */

/**
 * @typedef {object} Kind One kind of Secure Data Island, as its own file describes it.
 * @property {string} name The kind's name, as contract.json lists it.
 * @property {boolean} showsRows True for a kind that shows values: copy gives a link, and print leaves the rows out.
 * @property {(edge: Edge) => KindView} mount
 */

/**
 * @typedef {object} KindView What a kind does once it is on the page.
 * @property {(still: () => boolean) => Promise<void>} show Fetch what the kind shows, and draw it. `still` turns false when the person signed out, or a newer call began: after every wait, a kind that finds it false draws nothing and says nothing.
 * @property {(where: "first" | "last") => HTMLElement | null} land Put the selection where the keyboard comes from, and say what takes the keyboard.
 * @property {() => HTMLElement | null} target What takes the keyboard, with the selection left as it is.
 * @property {(event: KeyboardEvent) => void} [key] A key that was pressed while nothing in the frame held the keyboard.
 * @property {() => number} [count] How many rows are shown now.
 */

/**
 * @typedef {object} Edge What a kind gets from this file. It can say a state and where the keyboard leaves, and nothing else, to the page around the frame.
 * @property {HTMLElement} root Where the kind draws.
 * @property {boolean} framed True in a frame. False on HX Fortress's own page of a result.
 * @property {() => IslandDef} def The settings, as the page around the frame handed them over.
 * @property {(path: string, payload?: unknown) => Promise<Response | null>} api One call to HX Fortress, with this person's session. Null when it did not answer.
 * @property {() => Promise<string | null>} askGrant A grant for one read. Null when none came.
 * @property {(state: (typeof STATES)[number], extra?: { rows?: number, code?: string }) => void} setState
 * @property {(edge: "top" | "bottom") => void} leave The keyboard goes back to the page, past the first or the last thing shown.
 * @property {(text: string, again: boolean) => void} problem One sentence in place of what the kind shows, with Try Again under it when that can help.
 * @property {(response: Response, still: () => boolean, words: string) => Promise<void>} refused Show a read that HX Fortress refused: its own words here, or `words` when it gave none, and a code to the page.
 * @property {(text: string) => void} printNote The one line a printed page shows in place of the rows.
 */

/**
 * Start one kind of Secure Data Island on this page.
 *
 * @param {Kind} kind
 */
export async function start(kind) {
  const framed = window.parent !== window;
  const root = el("div", { class: "hx-root" });
  const note = el("p", { class: "hx-print-note" });
  document.body.append(root, note);

  // A message that comes before this page knows whose page is around it waits here.
  /** @type {MessageEvent[]} */
  const early = [];
  /** @type {((e: MessageEvent) => void) | null} */
  let deliver = null;
  window.addEventListener("message", (e) => {
    if (e.source === window) return; // a page has nothing to say to itself
    if (deliver) deliver(e);
    else if (early.length < 32) early.push(e);
  });

  const hash = new URLSearchParams(location.hash.slice(1));
  const config = await readConfig();
  /** The one origin whose pages this frame talks to. HX Fortress names it, never a message. */
  const pages = config?.pages ?? null;

  // ── what this page holds ──────────────────────────────────────────────────────────────────────
  /** What this Secure Data Island shows: settings the page hands over, never code. @type {IslandDef | null} */
  let def = null;
  /** @type {string} */
  let state = "boot";
  /** The session's token. @type {string | null} */
  let token = null;
  /** @typedef {{ verifier: string, pass: string, challenge: string }} Attempt The three values of one sign-in. */
  /** The sign-in this frame would begin next, or has begun. Null while one is being made. @type {Attempt | null} */
  let attempt = null;
  /** The sign-in whose window is open now: the frame asks HX Fortress for it until it is there. @type {Attempt | null} */
  let waiting = null;
  /** The one ask for a finished sign-in that is on its way. @type {{ of: Attempt, answer: Promise<string | null> } | null} */
  let claiming = null;
  /** How many checks of a session are on their way. */
  let checking = 0;
  /** How many times this tab's session was ended. A session that was being checked when one ended is not taken. */
  let ended = 0;
  /** One grant that HX Fortress's own page of a result got in its address. @type {string | null} */
  let ownGrant = null;
  /** The chords the page asked to hear. @type {Set<string>} */
  let hostKeys = new Set();
  /** Where the keyboard was handed in while there was nothing to give it to. @type {"first" | "last" | null} */
  let wanted = null;
  /** The tokens the page set, so that its next theme takes the place of this one. @type {Set<string>} */
  const themed = new Set();
  /** HX Fortress's own page of a result has a Sign Out button. A frame has none: the page around it asks. */
  const signOutButton = framed ? null : document.getElementById("hx-signout");

  // Whatever waits on HX Fortress or on the page belongs to one turn. A sign-out, a sign-in and
  // a new read each begin a turn, and what an earlier turn waited for is then thrown away when
  // it arrives: rows that come after a sign-out are never drawn.
  let turn = 0;
  function newTurn() {
    const mine = ++turn;
    return () => mine === turn;
  }

  /**
   * @param {unknown} given
   * @returns {IslandDef | null}
   */
  function takeDef(given) {
    if (!given || typeof given !== "object") return null;
    const d = /** @type {Record<string, unknown>} */ (given);
    if (d.kind !== kind.name || typeof d.target !== "string" || d.target === "" || d.target.length > 128) return null;
    const settings = d.settings && typeof d.settings === "object" && !Array.isArray(d.settings) ? /** @type {Record<string, unknown>} */ (d.settings) : {};
    // The link a copy puts on the clipboard must be an address of the page around this frame.
    const link = typeof d.link === "string" && pages !== null && d.link.startsWith(`${pages}/`) ? d.link : null;
    return { id: String(d.id ?? "").slice(0, 64), kind: kind.name, target: d.target, settings, link };
  }

  // ── to the page around the frame ──────────────────────────────────────────────────────────────
  /**
   * @param {string} listed The kind of value a field takes.
   * @param {unknown} value
   */
  function fits(listed, value) {
    if (listed === "kind") return value === kind.name;
    if (listed === "state") return STATES.some((known) => known === value);
    if (listed === "signin") return typeof value === "string" && value.startsWith(SIGNIN_ADDRESS) && HASHED.test(value.slice(SIGNIN_ADDRESS.length));
    if (listed === "count") return Number.isInteger(value) && /** @type {number} */ (value) >= 0;
    if (listed === "code") return typeof value === "string" && (Object.hasOwn(REFUSALS, value) || OWN_CODES.some((own) => own === value));
    if (listed === "px") return typeof value === "number" && Number.isFinite(value) && value >= 0;
    if (listed === "edge") return EDGES.some((known) => known === value);
    if (listed === "chord") return typeof value === "string" && CHORD.test(value) && hostKeys.has(value);
    return false;
  }
  /**
   * Tell the page around the frame one thing. THE ONE WAY OUT: a message that `TO_PAGE` does not
   * list is not sent, and a field that it does not list for this message, or whose value is not
   * of its listed kind, is left out.
   *
   * @param {string} t
   * @param {Record<string, unknown>} [fields]
   */
  function post(t, fields = {}) {
    if (!framed || pages === null || !Object.hasOwn(TO_PAGE, t)) return;
    /** @type {Record<string, unknown>} */
    const message = { hx: 1, t };
    for (const [name, value] of Object.entries(fields)) {
      if (Object.hasOwn(TO_PAGE[t], name) && fits(TO_PAGE[t][name], value)) message[name] = value;
    }
    // A message addressed to an origin that the parent does not have is dropped by the browser.
    window.parent.postMessage(message, pages);
  }

  /**
   * @param {(typeof STATES)[number]} next
   * @param {Record<string, unknown>} [extra]
   */
  function setState(next, extra = {}) {
    if (!STATES.some((known) => known === next)) return; // a state that is not listed is never set, and never said
    state = next;
    if (signOutButton) signOutButton.hidden = token === null;
    post("state", { ...extra, s: next });
    // The keyboard was handed in while what the kind shows was on its way: it lands now.
    if (next === "ready" && wanted) {
      const where = wanted;
      wanted = null;
      landFocus(where);
    }
  }

  // ── size: a frame tells the page how tall what it shows is, and nothing else ──────────────────
  if (framed) {
    let last = 0;
    new ResizeObserver(() => {
      const h = Math.ceil(root.getBoundingClientRect().height);
      if (h !== last) {
        last = h;
        post("size", { h });
      }
    }).observe(root);
  }

  // ── theme: the page's own colours and sizes, from a fixed list ────────────────────────────────
  /** @param {Record<string, unknown>} d An `init` or a `theme` message. */
  function applyTheme(d) {
    if (d.scheme === "dark" || d.scheme === "light") document.documentElement.dataset.theme = d.scheme;
    const style = document.documentElement.style;
    const given = /** @type {Record<string, unknown>} */ (d.theme && typeof d.theme === "object" ? d.theme : {});
    // A theme holds every token the page sets. One that it leaves out goes back to this page's own value.
    for (const name of [...themed]) {
      if (!Object.hasOwn(given, name)) {
        style.removeProperty(name);
        themed.delete(name);
      }
    }
    for (const [name, value] of Object.entries(given)) {
      // A token that is not on the list, or whose value is not a plain colour or size, is dropped.
      if (!Object.hasOwn(TOKENS, name) || typeof value !== "string" || !VALID[TOKENS[name]].test(value)) continue;
      style.setProperty(name, value);
      themed.add(name);
    }
  }

  // ── the grant: asked from the page each time rows are read ────────────────────────────────────
  /** The one ask that waits now. @type {{ resolve: (grant: string | null) => void, timer: number, n: number } | null} */
  let grantWait = null;
  /** How many grants this frame has asked for. An ask carries its number, and the page's answer names it. */
  let asks = 0;
  /** @param {string | null} grant */
  function settleGrant(grant) {
    if (!grantWait) return;
    const waiting = grantWait;
    grantWait = null;
    clearTimeout(waiting.timer);
    waiting.resolve(grant);
  }
  /** @returns {Promise<string | null>} */
  function askGrant() {
    if (!framed) {
      const once = ownGrant;
      ownGrant = null;
      return Promise.resolve(once);
    }
    settleGrant(null); // an earlier ask is over
    return new Promise((resolve) => {
      const n = ++asks;
      grantWait = { resolve, n, timer: setTimeout(() => settleGrant(null), GRANT_WAIT_MS) };
      post("grant?", { n });
    });
  }

  // ── the session: a token in a request header, kept for this tab, and never a cookie ───────────
  // A browser may refuse a frame its storage. Then the session lives in this page's memory, and a
  // reload asks the person to sign in again.
  const kept = {
    get() {
      try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
    },
    /** @param {string | null} value */
    set(value) {
      try {
        if (value) sessionStorage.setItem(TOKEN_KEY, value);
        else sessionStorage.removeItem(TOKEN_KEY);
      } catch {
        // No storage for this frame: the session stays in memory.
      }
    },
  };
  /**
   * @param {string} path
   * @param {unknown} [payload]
   */
  const api = (path, payload = {}) => call(path, payload, token);

  /** The other pages of this HX Fortress that this one can reach: the frames beside it, or the
   *  frames of the page that opened it. @returns {Window[]} */
  function siblings() {
    /** @type {Window[]} */
    const out = [];
    try {
      const around = framed ? window.parent : window.opener;
      for (let i = 0; around && i < around.length; i++) if (around[i] !== window) out.push(around[i]);
    } catch {
      // A window that cannot be reached has nothing to say.
    }
    return out;
  }
  /**
   * @param {(typeof BETWEEN)[number]} t
   * @param {Record<string, string>} [fields]
   */
  function tellSiblings(t, fields) {
    for (const w of siblings()) tell(w, t, fields);
  }

  /** Show what the kind shows, for the session of this moment. A new call ends the one before it. */
  async function show() {
    const still = newTurn();
    settleGrant(null);
    await view.show(still);
  }

  /**
   * This frame is signed in with this session.
   *
   * @param {string} session
   */
  async function signedIn(session) {
    token = session;
    waiting = null;
    kept.set(session);
    await show();
  }

  /**
   * Take a session that this tab kept, or that another page of this HX Fortress handed over.
   *
   *   "live"     it is this frame's session now
   *   "ended"    HX Fortress says it is no session
   *   "unknown"  HX Fortress did not answer, and nothing is known of it
   *   "dropped"  the person signed out while it was being checked
   *
   * @param {string} candidate
   * @returns {Promise<"live" | "ended" | "unknown" | "dropped">}
   */
  async function adopt(candidate) {
    const before = ended;
    checking += 1;
    const res = await call("session", {}, candidate);
    checking -= 1;
    if (ended !== before) return "dropped";
    if (token) return "live"; // a sign-in finished meanwhile, and stands
    if (res?.ok) {
      await signedIn(candidate);
      return "live";
    }
    return res?.status === 401 ? "ended" : "unknown";
  }

  // The sign-in page opens in a window of its own, where the browser's address bar shows whose
  // page it is. A sign-in is prepared before any click, so that the click itself can open the
  // window: some browsers refuse a window that opens after a wait.
  async function signedOut() {
    const still = newTurn();
    settleGrant(null);
    token = null;
    attempt = null;
    waiting = null;
    kept.set(null);
    root.replaceChildren();
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const pass = await passOf(verifier);
    const challenge = await challengeOf(pass);
    if (!still()) return;
    attempt = { verifier, pass, challenge }; // a new sign-in, with an address of its own
    offerSignIn();
  }

  /** Say that nobody is signed in, and where the sign-in that this frame holds begins. */
  function offerSignIn() {
    if (!attempt || token) return;
    waiting = null;
    // In a frame the page draws the words and the button, and opens the window. The frame says where.
    setState("signed-out", { signin: SIGNIN_ADDRESS + attempt.challenge });
    if (!framed) renderGate("signed-out");
  }

  /**
   * Ask HX Fortress once for the sign-in that a window finished. The answer is the session's
   * token, or null when there is none yet. Two askers at the same moment share one ask:
   * HX Fortress hands a sign-in over once, and a second ask would find nothing.
   *
   * @param {Attempt} mine
   * @returns {Promise<string | null>}
   */
  function askClaim(mine) {
    if (claiming?.of === mine) return claiming.answer;
    const answer = (async () => {
      const res = await call("claim", { verifier: mine.verifier });
      if (res?.status !== 200) return null;
      /** @type {{ token?: unknown } | null} */
      const said = await res.json().catch(() => null);
      return typeof said?.token === "string" ? said.token : null;
    })();
    const asking = { of: mine, answer };
    claiming = asking;
    void answer.then(() => {
      if (claiming === asking) claiming = null;
    });
    return answer;
  }

  /**
   * Take the sign-in that the window finished, when there is one. True when this sign-in is
   * over: its session was taken, or the frame has moved on from it.
   *
   * @param {Attempt} mine
   */
  async function claim(mine) {
    const session = await askClaim(mine);
    if (session !== null && token === session) return true; // the other asker took it
    const over = attempt !== mine || token !== null;
    if (session === null) return over;
    if (over) {
      // The person signed out, or signed in another way, while HX Fortress answered. Nobody
      // would hold this session, so it is ended.
      void call("signout", {}, session);
      return true;
    }
    tellSiblings("session", { token: session });
    await signedIn(session);
    return true;
  }

  /** The page opened the sign-in window: ask for the finished sign-in until it is there. */
  function waitForSignIn() {
    if (!def || !attempt || token || waiting === attempt) return;
    const mine = attempt;
    waiting = mine;
    setState("waiting");
    if (!framed) renderGate("waiting");
    const started = Date.now();
    let wait = 1000;
    const again = async () => {
      if (waiting !== mine) return;
      // After five minutes the frame stops asking. The same sign-in stays on offer: when its
      // window still finishes, the window says so, and the frame takes it then.
      if (Date.now() - started > CLAIM_FOR_MS) return offerSignIn();
      if ((await claim(mine)) || waiting !== mine) return;
      wait = Math.min(wait + 250, 3000);
      setTimeout(again, wait);
    };
    setTimeout(again, wait);
  }

  /** The person gave the sign-in up, or its window is gone: ask once more now, and offer a new
   *  sign-in when there is nothing to take. */
  async function endWaiting() {
    const mine = waiting;
    if (!mine) return;
    waiting = null; // the frame stops asking by itself
    if (await claim(mine)) return;
    if (attempt === mine && token === null && waiting === null) await signedOut();
  }

  /** True while this tab holds a session in any way: in use, kept from before, or being checked. */
  const holdsSession = () => token !== null || checking > 0 || kept.get() !== null;

  /** The session is over in this tab, also when the frame only kept it or was still checking it. */
  async function dropSession() {
    ended += 1;
    if (def) await signedOut();
    else kept.set(null); // the page has not said what to show yet: nothing is drawn, and nothing is kept
  }

  /**
   * End this person's session: at HX Fortress, here, and on every page of this HX Fortress that
   * this one can reach. The frame is signed out at once and does not wait for HX Fortress's
   * answer, so rows that are on their way are not drawn. A session that this tab only kept, or
   * was still checking, ends too, and so does a sign-in that is on its way.
   */
  async function signOut() {
    if (!holdsSession() && waiting === null && claiming === null) return;
    const session = token ?? kept.get();
    if (session) void call("signout", {}, session);
    tellSiblings("signed-out");
    await dropSession();
  }
  signOutButton?.addEventListener("click", () => void signOut());

  /**
   * Another page of this HX Fortress speaks. One sign-in serves them all, and the page around
   * them hears none of it.
   *
   * @param {Record<string, unknown>} d
   * @param {Window} from
   */
  function fromOwnPage(d, from) {
    if (d.t === "session" && typeof d.token === "string" && !token && def) void adopt(d.token);
    else if (d.t === "session?" && token) tell(from, "session", { token });
    // A page of this HX Fortress ended the session. It is over here too.
    else if (d.t === "signed-out" && holdsSession()) void dropSession();
    // A sign-in window asks which page began its sign-in. The one that did hands it the pass.
    else if (d.t === "signin?" && attempt && !token && d.c === attempt.challenge) tell(from, "signin!", { c: attempt.challenge, p: attempt.pass });
    // The sign-in window says that it finished: ask for the sign-in now, and not at the next turn
    // of the clock. This also takes a sign-in that finished after the frame stopped asking.
    else if (d.t === "signin-done" && attempt && !token && d.c === attempt.challenge) void claim(attempt);
  }

  // HX Fortress's own page of a result, outside any frame, draws its own words and button.
  /** @param {"signed-out" | "waiting"} which */
  function renderGate(which) {
    const account = config?.organization ? `your ${config.organization} account` : "your account";
    const line = which === "waiting" ? "Finish signing in in the window that opened." : `Sign in with ${account} to see these rows.`;
    const button = which === "waiting"
      ? el("button", { class: "hx-btn", type: "button", text: "Cancel", onclick: () => void endWaiting() })
      : el("button", {
          class: "hx-btn hx-btn-primary", type: "button", text: "Sign In",
          onclick: () => {
            if (!attempt) return;
            window.open(SIGNIN_ADDRESS + attempt.challenge, "hx-signin", "popup,width=480,height=680");
            waitForSignIn();
          },
        });
    root.replaceChildren(el("div", { class: "hx-gate" }, [el("span", { class: "hx-gate-line", text: line }), button]));
    button.focus({ preventScroll: true });
  }

  /**
   * One sentence in place of what the kind shows, with Try Again under it when there is
   * something to try.
   *
   * @param {string} text
   * @param {(() => unknown) | null} retry
   */
  function problem(text, retry) {
    const button = retry ? el("button", { class: "hx-btn", type: "button", text: "Try Again", onclick: () => void retry() }) : null;
    root.replaceChildren(el("div", { class: "hx-gate" }, [el("span", { class: "hx-gate-line", text }), button]));
    // The keyboard is here, or was handed in while the rows were on their way: Enter tries again.
    if (button && (!framed || wanted || document.hasFocus())) {
      wanted = null;
      button.focus({ preventScroll: true });
    }
  }

  // ── focus: the page hands the keyboard in, and the frame hands it back at its edges ───────────
  /** @param {"first" | "last"} where */
  function landFocus(where) {
    root.classList.add("has-focus");
    const target = state === "ready" ? view.land(where) : root.querySelector("button");
    target?.focus({ preventScroll: true });
  }
  const onNothing = () => {
    const held = document.activeElement;
    return !held || held === document.body || held === document.documentElement;
  };
  if (document.hasFocus()) root.classList.add("has-focus");
  window.addEventListener("focus", () => {
    root.classList.add("has-focus");
    post("focus-in");
    // The frame's focus can arrive after the page's message did, and Tab can land on the frame's
    // document and not on something in it. Either way the keyboard goes to what the kind shows,
    // with its selection left where it is, so the next key does something.
    const settle = () => {
      if (!onNothing() || !document.hasFocus()) return;
      const target = state === "ready" ? view.target() : root.querySelector("button");
      target?.focus({ preventScroll: true });
    };
    setTimeout(settle, 0); // once the browser has finished moving focus into the frame
    setTimeout(settle, 60);
  });
  window.addEventListener("blur", () => {
    root.classList.remove("has-focus");
    wanted = null; // the keyboard went elsewhere, and is not pulled back when the rows arrive
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // Escape never dead-ends: it puts the keyboard back on the block in the page.
      e.preventDefault();
      wanted = null;
      post("leave", { edge: "escape" });
      return;
    }
    // The frame holds the keyboard and nothing in it does (Tab can land on the frame's document
    // in Firefox): what the kind shows still answers the keys.
    if (state === "ready" && onNothing() && !(e.metaKey || e.ctrlKey || e.altKey)) view.key?.(e);
    if (!(e.metaKey || e.ctrlKey)) return; // a plain key never leaves the frame
    const name = keyName(e);
    const chord = name === null ? "" : `mod+${e.shiftKey ? "shift+" : ""}${e.altKey ? "alt+" : ""}${name}`;
    if (hostKeys.has(chord)) {
      e.preventDefault();
      post("key", { chord });
    }
  }, true);

  // ── copy, cut, drag and print, for a kind that shows rows ─────────────────────────────────────
  /**
   * Tell HX Fortress what happened, for its audit trail: a count and the target's name.
   *
   * @param {string} what
   */
  function record(what) {
    if (token && def) void api("event", { kind: what, target: def.target, rows: view.count?.() ?? 0 });
  }
  let tipTimer = 0;
  /** @param {string} text */
  function tip(text) {
    let node = root.querySelector(".hx-tip");
    if (!node) root.append((node = el("div", { class: "hx-tip", role: "status" })));
    node.textContent = text;
    node.classList.add("is-on");
    clearTimeout(tipTimer);
    const shown = node;
    tipTimer = setTimeout(() => shown.classList.remove("is-on"), 2200);
  }
  /** @param {string} s */
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

  if (kind.showsRows) {
    // The styles leave the rows out of a printed page for a kind that says so.
    document.documentElement.dataset.guard = "rows";
    document.addEventListener("copy", (e) => {
      e.preventDefault();
      // A copy puts the block's address in the page around the frame on the clipboard, never the rows.
      if (state !== "ready" || !def?.link || !e.clipboardData) return;
      e.clipboardData.setData("text/plain", def.link);
      e.clipboardData.setData("text/html", `<a href="${esc(def.link)}" data-secure-data-island="${esc(def.id)}">${esc(def.target)}</a>`);
      record("copy-link");
      tip("Copied a link to these rows");
    });
    document.addEventListener("cut", (e) => {
      e.preventDefault();
      record("cut-stopped");
    });
    // With nothing selected, WebKit offers Copy and Cut only to a page that says it handles them.
    // Without this, Command-C in a frame would do nothing there: the rows cannot be selected.
    document.addEventListener("beforecopy", (e) => e.preventDefault());
    document.addEventListener("beforecut", (e) => e.preventDefault());
    document.addEventListener("dragstart", (e) => {
      e.preventDefault();
      record("drag-stopped");
    });
    window.addEventListener("beforeprint", () => record("print-without-rows"));
  }

  // ── the kind ──────────────────────────────────────────────────────────────────────────────────
  /** @type {Edge} */
  const edge = {
    root,
    framed,
    def: () => /** @type {IslandDef} */ (def),
    api,
    askGrant,
    setState,
    leave: (where) => post("leave", { edge: where }),
    problem: (text, again) => problem(text, again ? show : null),
    async refused(response, still, words) {
      if (response.status === 401) return signedOut();
      /** @type {{ code?: unknown, error?: unknown }} */
      const answer = await response.json().catch(() => ({}));
      if (!still()) return;
      // A code that this file does not know is shown as the read not being available: the list
      // of codes that reach the page is closed.
      const code = typeof answer.code === "string" && Object.hasOwn(REFUSALS, answer.code) ? answer.code : "unavailable";
      // HX Fortress's own words stay here. The page around the frame gets the code.
      problem(typeof answer.error === "string" && answer.error ? answer.error : words, WORTH_ANOTHER_TRY.has(code) ? show : null);
      setState(REFUSALS[code], { code });
    },
    printNote: (text) => {
      note.textContent = text;
    },
  };
  const view = kind.mount(edge);

  // ── from the page around the frame ────────────────────────────────────────────────────────────
  /** @type {Record<(typeof FROM_PAGE)[number], (d: Record<string, unknown>) => void>} */
  const handlers = {
    init(d) {
      applyTheme(d);
      // The page names the chords it wants to hear. Each must hold Command or Control: a plain key is refused.
      if (Array.isArray(d.keys)) hostKeys = new Set(d.keys.filter((k) => typeof k === "string" && CHORD.test(k)));
      const before = def;
      def = takeDef(d.island) ?? def;
      if (!def) return;
      if (!before) void begin();
      // The page changed what this frame shows: a signed-in frame reads again.
      else if (token && JSON.stringify([before.target, before.settings]) !== JSON.stringify([def.target, def.settings])) void show();
    },
    theme(d) {
      applyTheme(d);
    },
    // The page has let go of its own focus and says which edge the keyboard comes from. The frame
    // puts its own focus on what it shows, then answers, and the page focuses the frame. (Firefox
    // does not let a frame's script take focus from an element of the page around it, so the page
    // lets go first.)
    focus(d) {
      if (!def) return;
      const where = d.from === "below" ? "last" : "first";
      if (state === "ready" || state === "error" || state === "denied") landFocus(where);
      else wanted = where; // what the kind shows is still on its way: land when it is here
      post("focus-ok");
    },
    // The control plane's grant for this Secure Data Island: for one read, for at most a minute.
    // An answer that names an earlier ask is dropped: its grant may be for what this frame showed
    // before.
    grant(d) {
      if (typeof d.grant !== "string" || d.grant.length > 4096) return;
      if (d.n !== undefined && d.n !== grantWait?.n) return;
      settleGrant(d.grant);
    },
    // The page opened the sign-in window on the person's click. A frame may not open a window.
    "signin-started"() {
      waitForSignIn();
    },
    // The person gave the sign-in up, or its window is gone.
    "signin-cancel"() {
      void endWaiting();
    },
    // The page ends this person's session here: on their word, or when they sign out of the page.
    signout() {
      void signOut();
    },
  };

  /** @param {MessageEvent} e */
  function onMessage(e) {
    const d = e.data;
    if (!d || typeof d !== "object" || d.hx !== 1 || typeof d.t !== "string") return;
    if (e.origin === location.origin && e.source && e.source !== window) return fromOwnPage(d, /** @type {Window} */ (e.source));
    if (!framed || pages === null || e.source !== window.parent || e.origin !== pages) return;
    const name = FROM_PAGE.find((known) => known === d.t);
    if (name) handlers[name](d);
  }

  async function begin() {
    const stored = kept.get();
    if (stored) {
      const found = await adopt(stored);
      if (found === "live" || found === "dropped") return;
      if (found === "unknown") {
        problem("HX Fortress did not answer.", begin);
        return setState("error", { code: "network" });
      }
    }
    await signedOut();
    tellSiblings("session?");
  }

  // ── start ─────────────────────────────────────────────────────────────────────────────────────
  if (config === null) return problem("HX Fortress did not answer.", () => location.reload());
  // No page may frame a Secure Data Island now, so there is nobody to talk to and nothing to show.
  if (pages === null) return problem("This HX Fortress shows no Secure Data Island now.", null);

  deliver = onMessage;
  if (framed) {
    post("ready", { view: kind.name });
  } else if (!document.documentElement.classList.contains("hx-own")) {
    // A kind's page is made for a frame. In a window of its own it has nobody to ask for a grant,
    // and its own rules let it open no sign-in window.
    problem(OPEN_FROM_THE_PAGE, null);
  } else {
    // HX Fortress's own page of a result gets its settings and one grant in the address's
    // fragment, which no server sees, and drops them from the address bar at once.
    try {
      const packed = (hash.get("d") ?? "").replace(/-/g, "+").replace(/_/g, "/");
      def = takeDef(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(packed), (c) => c.charCodeAt(0)))));
    } catch {
      def = null;
    }
    ownGrant = hash.get("g");
    history.replaceState(null, "", location.pathname);
    if (def) {
      const crumb = document.getElementById("hx-crumb");
      if (crumb) crumb.textContent = def.target;
      void begin();
    } else {
      problem(OPEN_FROM_THE_PAGE, null);
    }
  }
  for (const e of early.splice(0)) onMessage(e);
}
