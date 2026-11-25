// What crosses a Secure Data Island's edge, from the page scripts as they run:
// which messages leave a frame, with which fields, to which origin, and what a
// frame does with what it is sent.
//
// The scripts run here against a stand-in for a page (./_page.ts), so this is
// part of the repository's own run. A driven run in three browser engines
// proves the same in real ones.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  FakePage,
  FakeWindow,
  TOKEN_KEY,
  deferred,
  freshScripts,
  json,
  settle,
  until,
  type Answer,
  type Edge,
  type EdgeScript,
  type FakePageOptions,
  type Kind,
  type Scripts,
} from "./_page";
import { PAGES } from "./_rig";

/** What the page around the frame holds of one Secure Data Island. */
const ISLAND = {
  id: "block-1",
  kind: "rows",
  target: "permits",
  settings: { query: "select permit_no, holder from permits", rows: 3 },
  link: `${PAGES}/docs/permits#block-1`,
};
// A session and a grant, put together when the test runs.
const SESSION = ["island", "session", "one"].join("-");
const GRANT = ["one", "grant", "for", "one", "read"].join(".");
const ROWS = {
  columns: [
    { name: "permit_no", type: "int" },
    { name: "holder", type: "varchar" },
  ],
  rows: [
    ["1041", "Ada Lovelace"],
    ["1042", null],
  ],
  more: false,
};

const hashOf = (domain: string, value: string): string =>
  createHash("sha256").update(domain + value, "utf8").digest("base64url");

let scripts: Scripts;
let page: FakePage;
/** Put a page where the scripts look for one. */
function open(options: FakePageOptions = {}): FakePage {
  page = new FakePage(scripts.base, options);
  page.install();
  return page;
}
beforeEach(async () => {
  scripts = await freshScripts();
  page = new FakePage(scripts.base);
});
afterEach(async () => {
  page.remove();
  await scripts.cleanup();
  // A page file calls HX Fortress, at the folder it was served from, and nothing else.
  expect(page.strays).toEqual([]);
});

interface Shown {
  edge: Edge | null;
  /** One entry for each time the edge script asked the kind to show itself. */
  shows: (() => boolean)[];
}
/** A kind that draws nothing, and keeps what the edge script handed it. */
function quietKind(shown: Shown): Kind {
  return {
    name: "rows",
    showsRows: true,
    mount(edge) {
      shown.edge = edge;
      return {
        show: (still) => {
          shown.shows.push(still);
          return Promise.resolve();
        },
        land: () => null,
        target: () => null,
      };
    },
  };
}

/** A frame with a quiet kind in it. With `signedIn`, this tab holds a live
 *  session, the page has said what to show, and the frame has taken both. */
async function frame(options: { signedIn?: boolean } = {}): Promise<{ edge: Edge; script: EdgeScript; shows: (() => boolean)[] }> {
  if (options.signedIn) {
    page.kept.set(TOKEN_KEY, SESSION);
    page.answers.set("session", () => json(200, {}));
  }
  page.install();
  const script = await scripts.island();
  const shown: Shown = { edge: null, shows: [] };
  await script.start(quietKind(shown));
  if (options.signedIn) {
    page.fromPage({ t: "init", island: ISLAND });
    await until(() => shown.shows.length === 1, "the kind to be shown");
  }
  if (!shown.edge) throw new Error("the edge script did not mount the kind");
  return { edge: shown.edge, script, shows: shown.shows };
}

const stateNow = (): unknown => page.last("state")?.s;
async function untilState(state: string): Promise<void> {
  await until(() => stateNow() === state, `the frame to say ${state}`);
}

describe("what a frame tells the page around it", () => {
  test("it says ready to the origin that HX Fortress names, and to no other", async () => {
    await frame();
    expect(page.around.posted).toEqual([{ message: { hx: 1, t: "ready", view: "rows" }, to: PAGES }]);
    expect(page.calls).toEqual([{ path: "config", method: "GET", body: undefined, token: null }]);
  });

  test("a state leaves with its listed fields, and with nothing else", async () => {
    const { edge } = await frame({ signedIn: true });
    edge.setState("ready", { rows: 2, value: "Ada Lovelace", columns: ["holder"], s: "error", t: "key", hx: 2 });
    expect(page.told.at(-1)).toEqual({ hx: 1, t: "state", s: "ready", rows: 2 });
    edge.setState("denied", { code: "grant-used", error: "This grant was used already." });
    expect(page.told.at(-1)).toEqual({ hx: 1, t: "state", s: "denied", code: "grant-used" });
    edge.setState("error", { code: "no-grant" });
    expect(page.told.at(-1)).toEqual({ hx: 1, t: "state", s: "error", code: "no-grant" });
  });

  test("a field whose value is not of its listed kind is left out", async () => {
    const { edge, script } = await frame({ signedIn: true });
    for (const extra of [
      { rows: "Ada Lovelace" },
      { rows: -1 },
      { rows: 1.5 },
      { rows: [2] },
      { rows: null },
      { code: "select holder from permits" },
      { code: 7 },
      { code: "constructor" },
      { code: "signed-out" },
      { signin: "https://elsewhere.example/island/v1/signin#c=Ada" },
      { signin: `${script.SIGNIN_ADDRESS}Ada` },
      { signin: `${script.SIGNIN_ADDRESS}${"A".repeat(43)}&holder=Ada` },
    ]) {
      edge.setState("ready", extra);
      expect(page.told.at(-1)).toEqual({ hx: 1, t: "state", s: "ready" });
    }
  });

  test("a state that is not listed is never said", async () => {
    const { edge } = await frame({ signedIn: true });
    const before = page.told.length;
    edge.setState("Ada Lovelace", { rows: 2 });
    edge.setState("constructor");
    expect(page.told.length).toBe(before);
  });

  test("the keyboard leaves at a listed edge, and an edge that is not listed is not named", async () => {
    const { edge } = await frame({ signedIn: true });
    edge.leave("top");
    expect(page.told.at(-1)).toEqual({ hx: 1, t: "leave", edge: "top" });
    edge.leave("bottom");
    expect(page.told.at(-1)).toEqual({ hx: 1, t: "leave", edge: "bottom" });
    edge.leave("Ada Lovelace");
    expect(page.told.at(-1)).toEqual({ hx: 1, t: "leave" });
    // Escape never dead-ends: it leaves from any state, with nothing asked of the page.
    expect(page.key({ key: "Escape", code: "Escape" })).toBe(true);
    expect(page.told.at(-1)).toEqual({ hx: 1, t: "leave", edge: "escape" });
  });

  test("a kind can say a state and an edge, and has no other way to the page", async () => {
    const { edge } = await frame({ signedIn: true });
    expect(Object.keys(edge).sort()).toEqual([
      "api", "askGrant", "def", "framed", "leave", "printNote", "problem", "refused", "root", "setState",
    ]);
    // What a kind draws, and the line it leaves for a printed page, stay in the frame.
    edge.printNote("2 rows of permits");
    edge.problem("The rows could not be read.", true);
    expect(page.root.words()).toBe("The rows could not be read. Try Again");
    expect(JSON.stringify(page.around.posted)).not.toContain("could not be read");
  });

  test("the frame says how tall it is, as a number of pixels, each time that changes", async () => {
    await frame({ signedIn: true });
    page.resized(120.4);
    expect(page.told.at(-1)).toEqual({ hx: 1, t: "size", h: 121 });
    const told = page.told.length;
    page.resized(120.9);
    expect(page.told.length).toBe(told);
    // Nothing is shown any more: the page takes the frame's height back to nothing.
    page.resized(0);
    expect(page.told.at(-1)).toEqual({ hx: 1, t: "size", h: 0 });
  });

  test("a chord is told when the page asked to hear it, and a plain key never is", async () => {
    await frame();
    page.fromPage({ t: "init", island: ISLAND, keys: ["mod+k", "mod+shift+/", "k", "shift+k", "mod+Ada", 7] });
    await untilState("signed-out");
    const told = (): number => page.told.filter((message) => message.t === "key").length;

    expect(page.key({ key: "k", code: "KeyK", metaKey: true })).toBe(true);
    expect(page.told.at(-1)).toEqual({ hx: 1, t: "key", chord: "mod+k" });
    expect(page.key({ key: "k", code: "KeyK", ctrlKey: true })).toBe(true);
    expect(told()).toBe(2);
    // Shift with the slash key types "?": the chord names the key.
    expect(page.key({ key: "?", code: "Slash", shiftKey: true, metaKey: true })).toBe(true);
    expect(page.told.at(-1)).toEqual({ hx: 1, t: "key", chord: "mod+shift+/" });

    // A plain key, a chord the page did not ask for, and the keys a person types: none leaves.
    for (const pressed of [
      { key: "k", code: "KeyK" },
      { key: "K", code: "KeyK", shiftKey: true },
      { key: "j", code: "KeyJ", metaKey: true },
      { key: "k", code: "KeyK", metaKey: true, altKey: true },
      { key: "a", code: "KeyA" },
      { key: "Enter", code: "Enter" },
    ]) {
      expect(page.key(pressed)).toBe(false);
    }
    expect(told()).toBe(3);
    // Every chord that left is one the page named, and holds Command or Control.
    expect(page.told.filter((message) => message.t === "key").map((message) => message.chord)).toEqual([
      "mod+k", "mod+k", "mod+shift+/",
    ]);
  });

  test("every message is addressed to the one origin, whatever a message asked for", async () => {
    const { edge } = await frame({ signedIn: true });
    edge.setState("ready", { rows: 2 });
    edge.leave("top");
    page.resized(40);
    void edge.askGrant();
    expect(page.told.map((message) => message.t)).toEqual(["ready", "state", "leave", "size", "grant?"]);
    expect([...new Set(page.around.posted.map((posted) => posted.to))]).toEqual([PAGES]);
  });

  test("an HX Fortress that shows no Secure Data Island tells no page anything", async () => {
    page.answers.set("config", () => json(200, { v: 1, pages: null, organization: null, signIn: "account" }));
    const { edge } = await frame();
    expect(page.root.words()).toBe("This HX Fortress shows no Secure Data Island now.");
    // Whatever arrives, from wherever, nothing begins and nothing leaves.
    page.fromPage({ t: "init", island: ISLAND });
    page.deliver({ hx: 1, t: "init", island: ISLAND }, { origin: "null", source: page.around });
    edge.setState("ready", { rows: 2 });
    edge.leave("top");
    await settle();
    expect(page.around.posted).toEqual([]);
    expect(page.calls.map((called) => called.path)).toEqual(["config"]);
  });

  test("when HX Fortress does not answer, the frame says so and tells no page anything", async () => {
    page.answers.delete("config");
    await frame();
    expect(page.root.words()).toBe("HX Fortress did not answer. Try Again");
    expect(page.around.posted).toEqual([]);
  });
});

describe("what a frame takes from the page around it", () => {
  test("a message from another origin, or from another window, is dropped", async () => {
    await frame();
    const init = { hx: 1, t: "init", island: ISLAND };
    page.deliver(init, { origin: "https://elsewhere.example", source: page.around });
    page.deliver(init, { origin: PAGES, source: new FakeWindow() });
    page.deliver(init, { origin: `${PAGES}.elsewhere.example`, source: page.around });
    page.deliver(init, { origin: page.origin, source: page.self });
    for (const data of [null, "init", 7, { t: "init", island: ISLAND }, { hx: 2, t: "init", island: ISLAND }, { hx: 1, t: 7 }]) {
      page.deliver(data, { origin: PAGES, source: page.around });
    }
    await settle();
    expect(page.told.map((message) => message.t)).toEqual(["ready"]);
    // The same message from the page around the frame is taken.
    page.deliver(init, { origin: PAGES, source: page.around });
    await untilState("signed-out");
  });

  test("a message whose name is not listed is dropped", async () => {
    await frame();
    for (const t of ["session", "session?", "signed-out", "signin?", "signin!", "signin-done", "ready", "state", "constructor", "__proto__", "toString"]) {
      page.fromPage({ t, token: SESSION, island: ISLAND, c: "A".repeat(43) });
    }
    await settle();
    expect(page.told.map((message) => message.t)).toEqual(["ready"]);
    expect(page.calls.map((called) => called.path)).toEqual(["config"]);
  });

  test("an init for another kind, or with no target, begins nothing", async () => {
    await frame();
    for (const island of [{ ...ISLAND, kind: "connection" }, { ...ISLAND, target: "" }, { ...ISLAND, target: "p".repeat(129) }, "permits", null]) {
      page.fromPage({ t: "init", island });
    }
    await settle();
    expect(page.told.map((message) => message.t)).toEqual(["ready"]);
  });

  test("an init that arrives before the frame knows whose page is around it waits, and is taken then", async () => {
    const answered = deferred<Response>();
    page.answers.set("config", () => answered.promise);
    page.install();
    const script = await scripts.island();
    const starting = script.start(quietKind({ edge: null, shows: [] }));
    page.fromPage({ t: "init", island: ISLAND });
    answered.resolve(json(200, { v: 1, pages: PAGES, organization: null, signIn: "account" }));
    await starting;
    await untilState("signed-out");
    expect(page.told.map((message) => message.t)).toEqual(["ready", "state"]);
  });

  test("a theme sets the listed tokens to plain values, and the next theme takes its place", async () => {
    await frame();
    page.fromPage({
      t: "init",
      island: ISLAND,
      scheme: "dark",
      theme: {
        "--hx-fg": "#f4f4f5",
        "--hx-row": "36px",
        "--hx-font": "Inter",
        // Not on the list.
        "--hx-not-listed": "#000",
        color: "#000",
        // On the list, with a value that is not a plain colour, size or font.
        "--hx-muted": "red; background: url(https://elsewhere.example/x)",
        "--hx-line": "url(https://elsewhere.example/x)",
        "--hx-fs": "calc(1px)",
        "--hx-head": 7,
      },
    });
    expect(page.html.dataset.theme).toBe("dark");
    expect(Object.fromEntries(page.html.properties)).toEqual({ "--hx-fg": "#f4f4f5", "--hx-row": "36px", "--hx-font": "Inter" });

    page.fromPage({ t: "theme", scheme: "sepia", theme: { "--hx-row": "40px" } });
    expect(page.html.dataset.theme).toBe("dark");
    expect(Object.fromEntries(page.html.properties)).toEqual({ "--hx-row": "40px" });
    page.fromPage({ t: "theme", scheme: "light" });
    expect(page.html.dataset.theme).toBe("light");
    expect(Object.fromEntries(page.html.properties)).toEqual({});
    await untilState("signed-out");
  });

  test("a grant is taken only while the frame asks for one, and only as a short text", async () => {
    const { edge } = await frame({ signedIn: true });
    page.fromPage({ t: "grant", grant: GRANT }); // nobody asked
    const asked = edge.askGrant();
    expect(page.told.at(-1)).toEqual({ hx: 1, t: "grant?", n: 1 });
    page.fromPage({ t: "grant", grant: 7 });
    page.fromPage({ t: "grant", grant: "g".repeat(4097) });
    page.fromPage({ t: "grant" });
    page.fromPage({ t: "grant", grant: GRANT });
    expect(await asked).toBe(GRANT);
    // A grant is for one read: the next ask waits for the next grant.
    const next = edge.askGrant();
    const first = edge.askGrant();
    expect(await next).toBeNull(); // a newer ask ends the one before it
    page.fromPage({ t: "grant", grant: `${GRANT}.2` });
    expect(await first).toBe(`${GRANT}.2`);
    // An answer names the ask it is for. One that names an earlier ask is dropped.
    const fourth = edge.askGrant();
    expect(page.told.at(-1)).toEqual({ hx: 1, t: "grant?", n: 4 });
    page.fromPage({ t: "grant", grant: `${GRANT}.3`, n: 3 });
    page.fromPage({ t: "grant", grant: `${GRANT}.4`, n: "4" });
    page.fromPage({ t: "grant", grant: `${GRANT}.4`, n: 4 });
    expect(await fourth).toBe(`${GRANT}.4`);
  });

  test("a later init with another target or other settings makes a signed-in frame read again", async () => {
    const { shows } = await frame({ signedIn: true });
    page.fromPage({ t: "init", island: { ...ISLAND, id: "block-9", link: null } });
    await settle();
    expect(shows.length).toBe(1);
    page.fromPage({ t: "init", island: { ...ISLAND, settings: { query: "select 1" } } });
    await until(() => shows.length === 2, "the kind to be shown again");
    // What the first call waited for is thrown away when it arrives.
    expect(shows.map((still) => still())).toEqual([false, true]);
    page.fromPage({ t: "init", island: { ...ISLAND, target: "inspections", settings: { query: "select 1" } } });
    await until(() => shows.length === 3, "the kind to be shown for the other target");
    expect(shows.map((still) => still())).toEqual([false, false, true]);
  });
});

describe("a person's session in a frame", () => {
  test("a frame with no session says signed-out, with the address of this HX Fortress's sign-in page", async () => {
    const { script } = await frame();
    page.fromPage({ t: "init", island: ISLAND });
    await untilState("signed-out");
    const said = page.last("state") ?? {};
    expect(Object.keys(said).sort()).toEqual(["hx", "s", "signin", "t"]);
    expect(String(said.signin).startsWith(script.SIGNIN_ADDRESS)).toBe(true);
    expect(String(said.signin).slice(script.SIGNIN_ADDRESS.length)).toMatch(script.HASHED);
  });

  test("a sign-in's three values are a chain, and each goes only where it belongs", async () => {
    const { script, shows } = await frame();
    page.fromPage({ t: "init", island: ISLAND });
    await untilState("signed-out");
    const challenge = String(page.last("state")?.signin).slice(script.SIGNIN_ADDRESS.length);

    // The sign-in window asks which page began its sign-in. Only its own challenge is answered.
    const opened = new FakeWindow();
    page.fromOwnPage(opened, { t: "signin?", c: "A".repeat(43) });
    page.fromOwnPage(opened, { t: "signin?" });
    expect(opened.posted).toEqual([]);
    page.fromOwnPage(opened, { t: "signin?", c: challenge });
    const pass = String(opened.posted[0]?.message.p);
    expect(opened.posted).toEqual([{ message: { hx: 1, t: "signin!", c: challenge, p: pass }, to: page.origin }]);
    expect(hashOf("hx-fortress island sign-in challenge\n", pass)).toBe(challenge);

    // The page opened the window on the person's click, and the window finished.
    const claimed: unknown[] = [];
    page.answers.set("claim", (body) => {
      claimed.push(body);
      return json(200, { token: SESSION });
    });
    page.fromPage({ t: "signin-started" });
    expect(page.last("state")).toEqual({ hx: 1, t: "state", s: "waiting" });
    page.fromOwnPage(opened, { t: "signin-done", c: "A".repeat(43) });
    await settle();
    expect(claimed).toEqual([]);
    page.fromOwnPage(opened, { t: "signin-done", c: challenge });
    await until(() => shows.length === 1, "the kind to be shown");

    // Only the frame's verifier takes the sign-in, and the pass was made from it.
    const verifier = String((claimed[0] as { verifier?: unknown }).verifier);
    expect(claimed).toEqual([{ verifier }]);
    expect(verifier).toMatch(script.HASHED);
    expect(hashOf("hx-fortress island sign-in window\n", verifier)).toBe(pass);
    expect(page.kept.get(TOKEN_KEY)).toBe(SESSION);
    // A frame that is signed in answers no sign-in window.
    page.fromOwnPage(opened, { t: "signin?", c: challenge });
    expect(opened.posted.length).toBe(1);

    // The page around the frame saw the challenge, and none of the rest.
    const told = JSON.stringify(page.around.posted);
    expect(told).toContain(challenge);
    for (const held of [verifier, pass, SESSION]) expect(told).not.toContain(held);
  });

  test("the page around the frame cannot ask for the pass, and cannot hand a session in", async () => {
    const { script } = await frame();
    page.fromPage({ t: "init", island: ISLAND });
    await untilState("signed-out");
    const challenge = String(page.last("state")?.signin).slice(script.SIGNIN_ADDRESS.length);
    const told = page.told.length;
    // The same words, from the page around the frame: its origin is not HX Fortress's.
    page.fromPage({ t: "signin?", c: challenge });
    page.fromPage({ t: "session", token: SESSION });
    page.deliver({ hx: 1, t: "signin?", c: challenge }, { origin: PAGES, source: new FakeWindow() });
    await settle();
    expect(page.told.length).toBe(told);
    expect(page.around.posted.some((posted) => posted.message.t === "signin!")).toBe(false);
    expect(page.calls.map((called) => called.path)).toEqual(["config"]);
  });

  test("a sign-in that is given up asks HX Fortress once more, then offers a new one", async () => {
    await frame();
    page.fromPage({ t: "init", island: ISLAND });
    await untilState("signed-out");
    const first = page.last("state")?.signin;
    page.answers.set("claim", () => json(404, {}));
    page.fromPage({ t: "signin-started" });
    expect(stateNow()).toBe("waiting");
    page.fromPage({ t: "signin-cancel" });
    await untilState("signed-out");
    expect(page.calls.filter((called) => called.path === "claim").length).toBe(1);
    // A sign-in address is used once.
    expect(page.last("state")?.signin).not.toBe(first);
    // A frame that is not waiting does nothing with it.
    page.fromPage({ t: "signin-cancel" });
    await settle();
    expect(page.calls.filter((called) => called.path === "claim").length).toBe(1);
  });

  test("a sign-in that the window finished while it was being given up is taken", async () => {
    const { shows } = await frame();
    page.fromPage({ t: "init", island: ISLAND });
    await untilState("signed-out");
    page.answers.set("claim", () => json(200, { token: SESSION }));
    page.fromPage({ t: "signin-started" });
    page.fromPage({ t: "signin-cancel" });
    await until(() => shows.length === 1, "the kind to be shown");
    expect(page.kept.get(TOKEN_KEY)).toBe(SESSION);
    expect(page.told.filter((message) => message.t === "state").map((message) => message.s)).toEqual(["signed-out", "waiting"]);
  });

  test("a session that this tab kept is checked at HX Fortress before it is used", async () => {
    page.kept.set(TOKEN_KEY, SESSION);
    page.answers.set("session", () => json(401, { code: "signed-out" }));
    const { shows } = await frame();
    page.fromPage({ t: "init", island: ISLAND });
    await untilState("signed-out");
    expect(page.calls.at(-1)).toEqual({ path: "session", method: "POST", body: {}, token: SESSION });
    expect(page.kept.has(TOKEN_KEY)).toBe(false);
    expect(shows.length).toBe(0);
  });

  test("a kept session is not thrown away because HX Fortress did not answer", async () => {
    page.kept.set(TOKEN_KEY, SESSION);
    const { shows } = await frame();
    page.fromPage({ t: "init", island: ISLAND });
    await untilState("error");
    expect(page.last("state")).toEqual({ hx: 1, t: "state", s: "error", code: "network" });
    expect(page.root.words()).toBe("HX Fortress did not answer. Try Again");
    expect(page.kept.get(TOKEN_KEY)).toBe(SESSION);
    // Try Again asks once more, and takes the session when HX Fortress answers.
    page.answers.set("session", () => json(200, {}));
    page.root.querySelector("button")?.fire("click");
    await until(() => shows.length === 1, "the kind to be shown");
  });

  test("one sign-in serves every frame of this HX Fortress on a page, and the page hears none of it", async () => {
    const { shows } = await frame();
    page.fromPage({ t: "init", island: ISLAND });
    await untilState("signed-out");
    const beside = new FakeWindow();
    page.answers.set("session", () => json(200, {}));
    page.fromOwnPage(beside, { t: "session", token: SESSION });
    await until(() => shows.length === 1, "the kind to be shown");
    expect(page.kept.get(TOKEN_KEY)).toBe(SESSION);
    // A frame that starts later asks, and is handed the session at HX Fortress's own origin.
    page.fromOwnPage(beside, { t: "session?" });
    expect(beside.posted).toEqual([{ message: { hx: 1, t: "session", token: SESSION }, to: page.origin }]);
    // A frame beside this one signed out: this one does too.
    page.fromOwnPage(beside, { t: "signed-out" });
    await until(() => page.told.filter((message) => message.s === "signed-out").length === 2, "the frame to say signed-out again");
    expect(page.kept.has(TOKEN_KEY)).toBe(false);
    expect(JSON.stringify(page.around.posted)).not.toContain(SESSION);
  });

  test("a page of this HX Fortress is told only a listed thing, and a window of another origin is told nothing", async () => {
    const { script } = await frame();
    const own = new FakeWindow();
    script.tell(own, "session?");
    script.tell(own, "signin-done", { c: "A".repeat(43) });
    expect(own.posted).toEqual([
      { message: { hx: 1, t: "session?" }, to: page.origin },
      { message: { hx: 1, t: "signin-done", c: "A".repeat(43) }, to: page.origin },
    ]);
    // A name from the list of what the page around a frame may be told is not one of these.
    for (const t of ["init", "state", "ready", "grant", "constructor"]) script.tell(own, t, { token: SESSION });
    expect(own.posted.length).toBe(2);
    // The page around the frames, and any other frame on it, is not a page of this HX Fortress.
    const other = new FakeWindow("https://elsewhere.example");
    script.tell(other, "session", { token: SESSION });
    script.tell(page.around, "session", { token: SESSION });
    expect(other.posted).toEqual([]);
    expect(page.around.posted.some((posted) => posted.message.t === "session")).toBe(false);
  });

  test("a sign-in that finishes while it is being given up is asked for once, and taken", async () => {
    const { script, shows } = await frame();
    page.fromPage({ t: "init", island: ISLAND });
    await untilState("signed-out");
    const challenge = String(page.last("state")?.signin).slice(script.SIGNIN_ADDRESS.length);
    const handed = deferred<Response>();
    page.answers.set("claim", () => handed.promise);
    page.fromPage({ t: "signin-started" });
    // The window finishes and says so. Then the page says that the window is gone, before
    // HX Fortress has answered the first ask.
    page.fromOwnPage(new FakeWindow(), { t: "signin-done", c: challenge });
    page.fromPage({ t: "signin-cancel" });
    handed.resolve(json(200, { token: SESSION }));
    await until(() => shows.length === 1, "the kind to be shown");
    // HX Fortress hands a sign-in over once: a second ask would have found nothing.
    expect(page.calls.filter((called) => called.path === "claim").length).toBe(1);
    expect(page.kept.get(TOKEN_KEY)).toBe(SESSION);
    expect(page.told.filter((message) => message.t === "state").map((message) => message.s)).toEqual(["signed-out", "waiting"]);
  });

  test("after five minutes the frame stops asking, and the same sign-in stays on offer", async () => {
    const { script, shows } = await frame();
    page.fromPage({ t: "init", island: ISLAND });
    await untilState("signed-out");
    const address = String(page.last("state")?.signin);
    page.answers.set("claim", () => json(202, {}));
    page.fromPage({ t: "signin-started" });
    expect(stateNow()).toBe("waiting");
    // The frame asks about once a second, and finds nothing.
    expect(page.elapse(1000)).toBe(1);
    await until(() => page.calls.filter((called) => called.path === "claim").length === 1, "the first ask");
    await settle();
    const now = Date.now;
    Date.now = () => now() + 6 * 60 * 1000;
    try {
      expect(page.elapse(3000)).toBe(1);
    } finally {
      Date.now = now;
    }
    // It says signed-out again, with the address it gave before, and asks no more.
    expect(page.last("state")).toEqual({ hx: 1, t: "state", s: "signed-out", signin: address });
    expect(page.elapse(60_000)).toBe(0);
    expect(page.calls.filter((called) => called.path === "claim").length).toBe(1);
    // The window finishes late and says so: the frame takes the sign-in then.
    page.answers.set("claim", () => json(200, { token: SESSION }));
    page.fromOwnPage(new FakeWindow(), { t: "signin-done", c: address.slice(script.SIGNIN_ADDRESS.length) });
    await until(() => shows.length === 1, "the kind to be shown");
  });

  test("a sign-out ends a sign-in that is on its way", async () => {
    const { script, shows } = await frame();
    page.fromPage({ t: "init", island: ISLAND });
    await untilState("signed-out");
    const challenge = String(page.last("state")?.signin).slice(script.SIGNIN_ADDRESS.length);
    const handed = deferred<Response>();
    page.answers.set("claim", () => handed.promise);
    page.answers.set("signout", () => json(200, {}));
    page.fromPage({ t: "signin-started" });
    page.fromOwnPage(new FakeWindow(), { t: "signin-done", c: challenge });
    page.fromPage({ t: "signout" });
    await until(() => page.told.filter((message) => message.s === "signed-out").length === 2, "the frame to say signed-out again");
    // HX Fortress hands the sign-in over all the same. Nobody would hold its session, so the
    // frame ends it.
    const late = ["a", "late", "session"].join("-");
    handed.resolve(json(200, { token: late }));
    await until(() => page.calls.some((called) => called.path === "signout"), "the late session to be ended");
    expect(page.calls.at(-1)).toEqual({ path: "signout", method: "POST", body: {}, token: late });
    expect(shows.length).toBe(0);
    expect(page.kept.has(TOKEN_KEY)).toBe(false);
  });

  test("a sign-out ends a kept session that is still being checked", async () => {
    page.kept.set(TOKEN_KEY, SESSION);
    const checked = deferred<Response>();
    page.answers.set("session", () => checked.promise);
    page.answers.set("signout", () => json(200, {}));
    const { shows } = await frame();
    page.fromPage({ t: "init", island: ISLAND });
    await until(() => page.calls.some((called) => called.path === "session"), "the kept session to be checked");
    page.fromPage({ t: "signout" });
    await untilState("signed-out");
    expect(page.calls.at(-1)).toEqual({ path: "signout", method: "POST", body: {}, token: SESSION });
    expect(page.kept.has(TOKEN_KEY)).toBe(false);
    // HX Fortress then says that the session was a live one. It is not taken.
    checked.resolve(json(200, {}));
    await settle();
    expect(stateNow()).toBe("signed-out");
    expect(shows.length).toBe(0);
    expect(page.kept.has(TOKEN_KEY)).toBe(false);
  });

  test("a sign-out before the page says what to show ends the session that this tab kept", async () => {
    page.kept.set(TOKEN_KEY, SESSION);
    page.answers.set("signout", () => json(200, {}));
    await frame();
    page.fromPage({ t: "signout" });
    expect(page.calls.at(-1)).toEqual({ path: "signout", method: "POST", body: {}, token: SESSION });
    expect(page.kept.has(TOKEN_KEY)).toBe(false);
    // Nothing is said until the page says what to show. Then nobody is signed in.
    await settle();
    expect(page.told.map((message) => message.t)).toEqual(["ready"]);
    page.fromPage({ t: "init", island: ISLAND });
    await untilState("signed-out");
    expect(page.calls.some((called) => called.path === "session")).toBe(false);
  });

  test("a frame beside this one signs out while this one checks the same session: it is not taken", async () => {
    page.kept.set(TOKEN_KEY, SESSION);
    const checked = deferred<Response>();
    page.answers.set("session", () => checked.promise);
    const { shows } = await frame();
    page.fromPage({ t: "init", island: ISLAND });
    await until(() => page.calls.some((called) => called.path === "session"), "the kept session to be checked");
    page.fromOwnPage(new FakeWindow(), { t: "signed-out" });
    await untilState("signed-out");
    checked.resolve(json(200, {}));
    await settle();
    expect(shows.length).toBe(0);
    expect(page.kept.has(TOKEN_KEY)).toBe(false);
    // The frame that signed out told HX Fortress. This one does not tell it a second time.
    expect(page.calls.some((called) => called.path === "signout")).toBe(false);
  });

  test("signout ends the session at HX Fortress and in this tab", async () => {
    const { shows } = await frame({ signedIn: true });
    page.answers.set("signout", () => json(200, {}));
    page.fromPage({ t: "signout" });
    await untilState("signed-out");
    expect(page.calls.at(-1)).toEqual({ path: "signout", method: "POST", body: {}, token: SESSION });
    expect(page.kept.has(TOKEN_KEY)).toBe(false);
    // What the frame was showing is over.
    expect(shows.map((still) => still())).toEqual([false]);
    // A frame with no session has nothing to end.
    page.fromPage({ t: "signout" });
    await settle();
    expect(page.calls.filter((called) => called.path === "signout").length).toBe(1);
  });
});

describe("the rows kind", () => {
  /** A signed-in frame of the real `rows` kind, up to the read it sends. */
  async function rowsFrame(read: Answer, island: Record<string, unknown> = ISLAND, grant: string | null = GRANT): Promise<void> {
    page.kept.set(TOKEN_KEY, SESSION);
    page.answers.set("session", () => json(200, {}));
    page.answers.set("read", read);
    page.answers.set("event", () => json(200, {}));
    page.install();
    await scripts.rows();
    await until(() => page.last("ready") !== null, "the frame to say ready");
    page.fromPage({ t: "init", island });
    await until(() => page.last("grant?") !== null, "the frame to ask for a grant");
    if (grant !== null) page.fromPage({ t: "grant", grant });
  }
  const reads = (): unknown[] => page.calls.filter((called) => called.path === "read");

  test("the rows are drawn in the frame, and the page around it learns how many", async () => {
    await rowsFrame(() => json(200, ROWS));
    await untilState("ready");
    // A read carries the kind, the target, the settings and the grant, with the person's session.
    expect(reads()).toEqual([
      { path: "read", method: "POST", body: { kind: "rows", target: "permits", settings: ISLAND.settings, grant: GRANT }, token: SESSION },
    ]);
    expect(page.told.map((message) => message.t)).toEqual(["ready", "state", "grant?", "state"]);
    expect(page.last("state")).toEqual({ hx: 1, t: "state", s: "ready", rows: 2 });
    expect(page.root.words()).toBe("permit_no holder 1041 Ada Lovelace 1042 null");

    // Nothing of the rows, of the statement, of the grant or of the session left the frame.
    const told = JSON.stringify(page.around.posted);
    for (const kept of ["Ada", "1041", "1042", "permit_no", "holder", "select", "permits", GRANT, SESSION]) {
      expect(told).not.toContain(kept);
    }
  });

  test("rows that arrive after a sign-out are not drawn", async () => {
    const read = deferred<Response>();
    await rowsFrame(() => read.promise);
    await until(() => reads().length === 1, "the read to be sent");
    page.answers.set("signout", () => json(200, {}));
    page.fromPage({ t: "signout" });
    await untilState("signed-out");

    read.resolve(json(200, ROWS));
    await settle();
    expect(stateNow()).toBe("signed-out");
    expect(page.root.words()).toBe("");
    expect(page.told.some((message) => message.s === "ready")).toBe(false);
  });

  test("a sign-out does not wait for HX Fortress: rows on their way are not drawn while its answer is out", async () => {
    const read = deferred<Response>();
    await rowsFrame(() => read.promise);
    await until(() => reads().length === 1, "the read to be sent");
    // HX Fortress never answers the sign-out.
    page.answers.set("signout", () => deferred<Response>().promise);
    page.fromPage({ t: "signout" });
    await untilState("signed-out");
    expect(page.calls.at(-1)).toEqual({ path: "signout", method: "POST", body: {}, token: SESSION });
    expect(page.kept.has(TOKEN_KEY)).toBe(false);

    read.resolve(json(200, ROWS));
    await settle();
    expect(stateNow()).toBe("signed-out");
    expect(page.root.words()).toBe("");
    expect(page.told.some((message) => message.s === "ready")).toBe(false);
  });

  test("a newer read ends the one before it: each asks for a grant of its own", async () => {
    const first = deferred<Response>();
    const answers = [() => first.promise, () => json(200, { ...ROWS, rows: [["7", "Grace Hopper"]] })];
    await rowsFrame(() => (answers.shift() ?? (() => null))());
    await until(() => reads().length === 1, "the first read to be sent");

    // The page changed what the frame shows while the first read was on its way.
    page.fromPage({ t: "init", island: { ...ISLAND, settings: { query: "select 7" } } });
    await until(() => page.told.filter((message) => message.t === "grant?").length === 2, "a second grant to be asked for");
    page.fromPage({ t: "grant", grant: `${GRANT}.2` });
    await untilState("ready");
    expect(reads().map((called) => (called as { body: { grant: string } }).body.grant)).toEqual([GRANT, `${GRANT}.2`]);
    expect(page.root.words()).toBe("permit_no holder 7 Grace Hopper");

    // The first read answers late: its rows are thrown away.
    first.resolve(json(200, ROWS));
    await settle();
    expect(page.root.words()).toBe("permit_no holder 7 Grace Hopper");
    expect(page.last("state")).toEqual({ hx: 1, t: "state", s: "ready", rows: 1 });
  });

  test("a grant that answers an earlier ask is dropped, and the read waits for its own", async () => {
    await rowsFrame(() => json(200, ROWS), ISLAND, null);
    expect(page.last("grant?")).toEqual({ hx: 1, t: "grant?", n: 1 });
    // The page changed what the frame shows before it answered the first ask.
    page.fromPage({ t: "init", island: { ...ISLAND, settings: { query: "select 7" } } });
    await until(() => page.last("grant?")?.n === 2, "a second grant to be asked for");
    // The answer to the first ask comes late. Its grant is for the settings of before.
    page.fromPage({ t: "grant", grant: GRANT, n: 1 });
    await settle();
    expect(reads()).toEqual([]);
    page.fromPage({ t: "grant", grant: `${GRANT}.2`, n: 2 });
    await untilState("ready");
    expect(reads().map((called) => (called as { body: unknown }).body)).toEqual([
      { kind: "rows", target: "permits", settings: { query: "select 7" }, grant: `${GRANT}.2` },
    ]);
  });

  test("a refused read reaches the page as its code, and HX Fortress's own words stay in the frame", async () => {
    await rowsFrame(() => json(403, { code: "grant-other-settings", error: "This grant is for other settings than these." }));
    await untilState("denied");
    expect(page.last("state")).toEqual({ hx: 1, t: "state", s: "denied", code: "grant-other-settings" });
    // A new grant would not get past this one, so there is nothing to try again.
    expect(page.root.words()).toBe("This grant is for other settings than these.");
    expect(JSON.stringify(page.around.posted)).not.toContain("other settings than these");
  });

  test("a refusal that the same read may get past offers Try Again, which reads with a new grant", async () => {
    const answers = [
      () => json(422, { code: "query-failed", error: "Invalid object name 'permits'." }),
      () => json(200, ROWS),
    ];
    await rowsFrame(() => (answers.shift() ?? (() => null))());
    await untilState("error");
    expect(page.last("state")).toEqual({ hx: 1, t: "state", s: "error", code: "query-failed" });
    expect(page.root.words()).toBe("Invalid object name 'permits'. Try Again");
    expect(JSON.stringify(page.around.posted)).not.toContain("Invalid object");

    page.root.querySelector("button")?.fire("click");
    await until(() => page.told.filter((message) => message.t === "grant?").length === 2, "a second grant to be asked for");
    page.fromPage({ t: "grant", grant: `${GRANT}.2` });
    await untilState("ready");
  });

  test("a code that the frame does not know reaches the page as unavailable", async () => {
    await rowsFrame(() => json(418, { code: "Ada Lovelace", error: 7 }));
    await untilState("error");
    expect(page.last("state")).toEqual({ hx: 1, t: "state", s: "error", code: "unavailable" });
    expect(page.root.words()).toBe("The rows could not be read. Try Again");
  });

  test("a read that finds the session ended goes back to signed-out", async () => {
    await rowsFrame(() => json(401, { code: "signed-out" }));
    await untilState("signed-out");
    expect(page.kept.has(TOKEN_KEY)).toBe(false);
  });

  test("when the page around the frame hands over no grant, nothing is read", async () => {
    await rowsFrame(() => json(200, ROWS), ISLAND, null);
    // The frame waits 8 seconds for a grant.
    expect(page.elapse(8000)).toBe(1);
    await untilState("error");
    expect(page.last("state")).toEqual({ hx: 1, t: "state", s: "error", code: "no-grant" });
    expect(reads()).toEqual([]);
    expect(page.root.words()).toBe("The page around these rows did not answer. Try Again");
  });

  test("a result with no rows says so, and the keyboard can leave it both ways", async () => {
    await rowsFrame(() => json(200, { ...ROWS, rows: [] }));
    await untilState("ready");
    expect(page.last("state")).toEqual({ hx: 1, t: "state", s: "ready", rows: 0 });
    expect(page.root.words()).toBe("permit_no holder No rows");
    const grid = page.root.querySelector(".hx-grid");
    const press = (key: string): void =>
      grid?.fire("keydown", { key, metaKey: false, ctrlKey: false, altKey: false, preventDefault: () => undefined, stopPropagation: () => undefined });
    press("ArrowDown");
    expect(page.told.at(-1)).toEqual({ hx: 1, t: "leave", edge: "bottom" });
    press("ArrowUp");
    expect(page.told.at(-1)).toEqual({ hx: 1, t: "leave", edge: "top" });
  });

  test("the keyboard moves among the rows, and leaves past the first and the last", async () => {
    await rowsFrame(() => json(200, ROWS));
    await untilState("ready");
    const grid = page.root.querySelector(".hx-grid");
    const selected = (): string | undefined => grid?.attributes.get("aria-activedescendant");
    const press = (key: string): void =>
      grid?.fire("keydown", { key, metaKey: false, ctrlKey: false, altKey: false, preventDefault: () => undefined, stopPropagation: () => undefined });
    const left = (): number => page.told.filter((message) => message.t === "leave").length;

    expect(selected()).toBe("hx-r0");
    press("ArrowDown");
    expect(selected()).toBe("hx-r1");
    expect(left()).toBe(0);
    press("ArrowDown");
    expect(page.told.at(-1)).toEqual({ hx: 1, t: "leave", edge: "bottom" });
    press("Home");
    press("ArrowUp");
    expect(page.told.at(-1)).toEqual({ hx: 1, t: "leave", edge: "top" });
    expect(left()).toBe(2);
    // A letter, a digit and Enter stay in the frame, and so does every key in it.
    for (const key of ["a", "7", "Enter", " "]) press(key);
    expect(left()).toBe(2);
    expect(page.told.some((message) => message.t === "key")).toBe(false);
  });

  test("a copy puts the block's link on the clipboard, never a row, and a cut or a drag takes nothing", async () => {
    await rowsFrame(() => json(200, ROWS));
    await untilState("ready");
    const put = new Map<string, string>();
    let stopped = 0;
    const event = {
      preventDefault: () => {
        stopped += 1;
      },
      clipboardData: { setData: (type: string, value: string) => void put.set(type, value) },
    };
    page.fire("copy", event);
    expect(stopped).toBe(1);
    expect(Object.fromEntries(put)).toEqual({
      "text/plain": ISLAND.link,
      "text/html": `<a href="${ISLAND.link}" data-secure-data-island="block-1">permits</a>`,
    });
    page.fire("cut", event);
    page.fire("dragstart", event);
    expect(stopped).toBe(3);
    expect(put.size).toBe(2);

    // HX Fortress is told what happened, for its audit trail: a count and the target's name.
    await until(() => page.calls.filter((called) => called.path === "event").length === 3, "the three events to be told");
    expect(page.calls.filter((called) => called.path === "event")).toEqual(
      ["copy-link", "cut-stopped", "drag-stopped"].map((kind) => ({
        path: "event",
        method: "POST",
        body: { kind, target: "permits", rows: 2 },
        token: SESSION,
      })),
    );
    expect(page.html.dataset.guard).toBe("rows");
  });

  test("a copy with no link of the page's own puts nothing on the clipboard", async () => {
    // A link must be an address of the page around the frame.
    await rowsFrame(() => json(200, ROWS), { ...ISLAND, link: "https://elsewhere.example/docs/permits" });
    await untilState("ready");
    const put = new Map<string, string>();
    let stopped = 0;
    page.fire("copy", {
      preventDefault: () => {
        stopped += 1;
      },
      clipboardData: { setData: (type: string, value: string) => void put.set(type, value) },
    });
    expect(stopped).toBe(1);
    expect(put.size).toBe(0);
  });
});

describe("a page in a window of its own", () => {
  const packed = Buffer.from(JSON.stringify(ISLAND)).toString("base64url");

  test("HX Fortress's own page of a result reads with the one grant in its address, and tells no page anything", async () => {
    open({ framed: false, own: true, hash: `d=${packed}&g=${GRANT}` });
    page.kept.set(TOKEN_KEY, SESSION);
    page.answers.set("session", () => json(200, {}));
    const script = await scripts.island();
    const shown: Shown = { edge: null, shows: [] };
    await script.start(quietKind(shown));
    await until(() => shown.shows.length === 1, "the kind to be shown");
    const edge = shown.edge as Edge;
    expect(edge.framed).toBe(false);
    expect(edge.def()).toEqual(ISLAND);
    // The grant is for one read.
    expect(await edge.askGrant()).toBe(GRANT);
    expect(await edge.askGrant()).toBeNull();
    edge.setState("ready", { rows: 2 });
    edge.leave("top");
    expect(page.around.posted).toEqual([]);
  });

  test("with nobody signed in, it draws its own Sign In button", async () => {
    open({ framed: false, own: true, hash: `d=${packed}&g=${GRANT}` });
    const script = await scripts.island();
    await script.start(quietKind({ edge: null, shows: [] }));
    await until(() => page.root.querySelector("button") !== null, "the Sign In button");
    expect(page.root.words()).toBe("Sign in with your Northstar account to see these rows. Sign In");
    expect(page.document.activeElement).toBe(page.root.querySelector("button"));
  });

  test("with nothing in its address, it says where to open it from", async () => {
    open({ framed: false, own: true });
    const script = await scripts.island();
    await script.start(quietKind({ edge: null, shows: [] }));
    expect(page.root.words()).toBe("Open this page from the page that shows these rows.");
    expect(page.calls.map((called) => called.path)).toEqual(["config"]);
  });

  test("a kind's page that is opened outside a frame begins nothing", async () => {
    // Its own rules let it open no sign-in window, and nobody is there to hand it a grant.
    open({ framed: false, hash: `d=${packed}&g=${GRANT}` });
    page.kept.set(TOKEN_KEY, SESSION);
    page.answers.set("session", () => json(200, {}));
    const script = await scripts.island();
    const shown: Shown = { edge: null, shows: [] };
    await script.start(quietKind(shown));
    await settle();
    expect(page.root.words()).toBe("Open this page from the page that shows these rows.");
    expect(shown.shows.length).toBe(0);
    expect(page.calls.map((called) => called.path)).toEqual(["config"]);
  });
});
