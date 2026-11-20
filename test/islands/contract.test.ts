// contract.json is the closed list of what crosses a Secure Data Island's
// edge, written for the page around the frame. The edge script holds the same
// lists as constants, and sends nothing that they do not name. This holds the
// two to each other by value, and holds the scripts' source to the few things
// a page file may do: call HX Fortress, and nothing else.
//
// What the scripts do with the lists as they run is in edge.test.ts. A driven
// run in three browser engines holds the same lists to what really crossed.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { readIslandFolder } from "../../scripts/gen-island-files";
import { canonicalJson } from "../../src/host/ask-scope";
import type { EdgeScript } from "./_page";
import { moduleScriptOf } from "./_rig";

interface Field {
  type: string;
  of?: string | string[];
  optional?: boolean;
  when?: string;
}
type Fields = Record<string, Field>;

const folder = readIslandFolder();
const text = (name: string): string => new TextDecoder().decode(folder.files.get(name));
const contract = JSON.parse(text("contract.json")) as {
  version: number;
  rules: string[];
  kinds: { kind: string; page: string; label: string; showsRows: boolean; settings: Record<string, unknown> }[];
  messages: {
    types: Record<string, string>;
    island: Fields;
    toIsland: Record<string, Fields>;
    toIslandNotes: Record<string, string>;
    toPage: Record<string, Fields>;
    betweenPages: Record<string, Fields | string>;
  };
  states: Record<string, string>;
  signIn: { page: string; challenge: string; values: string[]; return: string };
  open: { page: string };
  session: { header: string };
  read: { address: string; body: Fields; checks: string[] };
  refusals: Record<string, { status?: number; state: string }>;
  grant: { lifetimeSeconds: number; claims: Record<string, string>; checks: string[] };
  settingsHash: { cases: { settings: unknown; canonical: string; hash: string }[] };
  tokens: { kinds: Record<string, string>; flags: Record<string, string>; names: Record<string, string> };
  chords: { pattern: string };
  events: { address: string; kinds: string[] };
};

const SCRIPTS = [...folder.files.keys()].filter((name) => name.endsWith(".js")).sort();
const PAGES = [...folder.files.keys()].filter((name) => name.endsWith(".html")).sort();
const sources = new Map(SCRIPTS.map((name) => [name, text(name)]));
const source = (name: string): string => sources.get(name) ?? "";
const island = source("island.js");
const all = [...sources.values()].join("\n");
const uniq = (list: Iterable<string>): string[] => [...new Set(list)].sort();

// The edge script, as a browser loads it. It is plain JavaScript with no
// declaration file, so its address is put together here.
const edge = (await import(new URL("../../islands/v1/island.js", import.meta.url).href)) as EdgeScript;

/** The scripts a page loads: the one it names, and every script that one imports. */
function scriptsOf(page: string): string[] {
  const loaded = new Set<string>();
  const load = (name: string): void => {
    if (loaded.has(name)) return;
    loaded.add(name);
    for (const found of source(name).matchAll(/(?:from|import\()\s*"\.\/([a-z0-9-]+\.js)"/g)) load(found[1] as string);
  };
  const own = moduleScriptOf(text(page));
  if (own) load(own);
  return [...loaded].sort();
}

describe("contract.json", () => {
  test("it is version 1, and lists one kind: rows", () => {
    expect(contract.version).toBe(1);
    expect(contract.kinds.map((entry) => entry.kind)).toEqual(["rows"]);
    expect(contract.kinds[0]).toMatchObject({ page: "/island/v1/rows", label: "reads", showsRows: true });
    expect(Object.keys(contract.kinds[0]?.settings ?? {})).toEqual(["query", "rows"]);
  });

  test("every case of the settings' one spelling gives the listed text and the listed hash", () => {
    expect(contract.settingsHash.cases.length).toBeGreaterThanOrEqual(5);
    for (const entry of contract.settingsHash.cases) {
      const canonical = canonicalJson(entry.settings);
      expect(canonical).toBe(entry.canonical);
      expect(createHash("sha256").update(canonical, "utf8").digest("base64url")).toBe(entry.hash);
    }
  });

  test("the grant's claims and the order of its checks are the module host's", () => {
    expect(Object.keys(contract.grant.claims)).toEqual([
      "v", "purpose", "aud", "org", "fortress", "kind", "target", "settingsHash", "person", "iat", "exp", "jti",
    ]);
    expect(contract.grant.claims.purpose).toBe("secure-data-island");
    expect(contract.grant.claims.v).toBe("2");
    expect(contract.grant.lifetimeSeconds).toBe(60);
    expect(contract.grant.checks).toEqual([
      "signature", "v", "purpose", "aud", "fortress", "kind and target", "settingsHash", "person", "iat and exp", "jti", "org",
    ]);
  });

  test("a read's body is the kind, the target, the settings and the grant, and nothing else", () => {
    expect(contract.read.address).toBe("POST /island/v1/read");
    expect(Object.keys(contract.read.body)).toEqual(["kind", "target", "settings", "grant"]);
    expect(contract.read.checks.length).toBe(7);
  });

  test("no message to the page has a field that can hold a value: no text, and no object", () => {
    for (const [name, fields] of Object.entries(contract.messages.toPage)) {
      for (const [field, spec] of Object.entries(fields)) {
        expect(`${name}.${field}: ${spec.type}`).toMatch(/: (word|count|px|address)$/);
        // A word is one of a listed set, never a free one.
        if (spec.type === "word") expect(spec.of).toBeDefined();
      }
    }
  });

  test("every refusal shows as a listed state", () => {
    for (const [code, entry] of Object.entries(contract.refusals)) {
      expect(`${code}: ${Object.keys(contract.states).includes(entry.state)}`).toBe(`${code}: true`);
      // The one that means signed out is HX Fortress's 401, and nothing else is.
      expect(entry.status === 401).toBe(code === "signed-out");
    }
  });
});

describe("the edge script holds the same lists as contract.json", () => {
  test("what a frame tells the page: the same messages, the same fields, each with its kind of value", () => {
    // How the script names a field's kind of value, and how contract.json writes the same thing.
    const written: Record<string, (spec: Field) => boolean> = {
      kind: (spec) => spec.type === "word" && spec.of === "kinds",
      state: (spec) => spec.type === "word" && JSON.stringify(spec.of) === JSON.stringify(edge.STATES),
      signin: (spec) => spec.type === "address",
      count: (spec) => spec.type === "count",
      code: (spec) => spec.type === "word" && spec.of === "refusals",
      px: (spec) => spec.type === "px",
      edge: (spec) => spec.type === "word" && JSON.stringify(spec.of) === JSON.stringify(edge.EDGES),
      chord: (spec) => spec.type === "word" && spec.of === "chords",
    };
    expect(Object.keys(edge.TO_PAGE)).toEqual(Object.keys(contract.messages.toPage));
    for (const [name, fields] of Object.entries(edge.TO_PAGE)) {
      const listed = contract.messages.toPage[name] ?? {};
      expect(`${name}: ${Object.keys(fields).join(" ")}`).toBe(`${name}: ${Object.keys(listed).join(" ")}`);
      for (const [field, kind] of Object.entries(fields)) {
        const same = written[kind]?.(listed[field] as Field) ?? false;
        expect(`${name}.${field} is a ${kind}: ${same}`).toBe(`${name}.${field} is a ${kind}: true`);
      }
    }
  });

  test("what a frame takes from the page, and what pages of one HX Fortress say to each other", () => {
    expect([...edge.FROM_PAGE]).toEqual(Object.keys(contract.messages.toIsland));
    for (const name of Object.keys(contract.messages.toIslandNotes)) expect(edge.FROM_PAGE).toContain(name);
    expect([...edge.BETWEEN]).toEqual(Object.keys(contract.messages.betweenPages).filter((name) => name !== "note"));
    // No name is on both lists: a message's name says which side it may come from.
    for (const name of edge.BETWEEN) expect(edge.FROM_PAGE).not.toContain(name);
  });

  test("the states and the edges", () => {
    expect([...edge.STATES]).toEqual(contract.messages.toPage.state?.s?.of as string[]);
    expect([...edge.STATES]).toEqual(Object.keys(contract.states));
    expect([...edge.EDGES]).toEqual(contract.messages.toPage.leave?.edge?.of as string[]);
  });

  test("the codes of a refused read, each with the state it shows as", () => {
    const answered = Object.entries(contract.refusals).filter(([, entry]) => entry.status !== undefined && entry.status !== 401);
    expect(edge.REFUSALS).toEqual(Object.fromEntries(answered.map(([code, entry]) => [code, entry.state])));
    // The frame's own codes are the ones HX Fortress never answers.
    const own = Object.entries(contract.refusals).filter(([, entry]) => entry.status === undefined);
    expect([...edge.OWN_CODES]).toEqual(own.map(([code]) => code));
    // A code that a script names is one of these, or it would never reach the page.
    const named = uniq([...all.matchAll(/setState\("[a-z-]+", \{ code: "([a-z-]+)" \}\)/g)].map((m) => m[1] as string));
    expect(named).toEqual(["network", "no-grant", "unavailable"]);
    for (const code of named) expect(Object.hasOwn(edge.REFUSALS, code) || edge.OWN_CODES.includes(code)).toBe(true);
  });

  test("the style tokens a page may set, each with its kind of value", () => {
    expect(edge.TOKENS).toEqual(contract.tokens.names);
    expect(Object.keys(edge.TOKENS).length).toBe(29);
    expect(Object.fromEntries(Object.entries(edge.VALID).map(([kind, pattern]) => [kind, pattern.source]))).toEqual(
      contract.tokens.kinds,
    );
    expect(Object.fromEntries(Object.entries(edge.VALID).flatMap(([kind, p]) => (p.flags ? [[kind, p.flags]] : [])))).toEqual(
      contract.tokens.flags,
    );
    // Every token's kind has a pattern, and every token is one the styles use.
    for (const [name, kind] of Object.entries(edge.TOKENS)) {
      expect(Object.keys(edge.VALID)).toContain(kind);
      expect(`${name}: ${text("island.css").includes(`var(${name}`)}`).toBe(`${name}: true`);
    }

    // A value that is not a plain colour or size is dropped: nothing that could
    // load an address, and nothing that could carry a second declaration.
    for (const refused of ["url(https://elsewhere.example/x)", "red; background: url(x)", "expression(1)", "var(--x)", "#12", "calc(1px)"]) {
      expect(edge.VALID.color?.test(refused)).toBe(false);
    }
    for (const taken of ["#2d5f8a", "#fff", "rgba(45, 95, 138, 0.2)", "rgb(1 2 3 / 50%)", "transparent"]) {
      expect(edge.VALID.color?.test(taken)).toBe(true);
    }
    expect(edge.VALID.px?.test("36px")).toBe(true);
    expect(edge.VALID.px?.test("36")).toBe(false);
    expect(edge.VALID.font?.test("Inter")).toBe(true);
    expect(edge.VALID.font?.test("Inter, url(x)")).toBe(false);
  });

  test("the chords a page may ask to hear", () => {
    expect(edge.CHORD.source).toBe(contract.chords.pattern);
    // A chord holds Command or Control. A plain key is never one.
    for (const chord of ["mod+k", "mod+shift+p", "mod+alt+7", "mod+shift+alt+/", "mod+enter", "mod+\\", "mod+["]) {
      expect(`${chord}: ${edge.CHORD.test(chord)}`).toBe(`${chord}: true`);
    }
    for (const chord of ["k", "shift+k", "alt+k", "mod+", "mod+kk", "mod+K", "mod+alt+shift+k", "mod+k ", "mod+?", "ctrl+k"]) {
      expect(`${chord}: ${edge.CHORD.test(chord)}`).toBe(`${chord}: false`);
    }
  });

  test("a chord names the key, and not the character that Shift or Option turns it into", () => {
    const named: [Parameters<EdgeScript["keyName"]>[0], string | null][] = [
      [{ key: "k", code: "KeyK" }, "k"],
      [{ key: "K", code: "KeyK", shiftKey: true }, "k"],
      [{ key: "7", code: "Digit7" }, "7"],
      [{ key: "/", code: "Slash" }, "/"],
      // Shift with the slash key types "?", and with the 1 key "!".
      [{ key: "?", code: "Slash", shiftKey: true }, "/"],
      [{ key: "!", code: "Digit1", shiftKey: true }, "1"],
      [{ key: "<", code: "Comma", shiftKey: true }, ","],
      // Option turns a letter into another character, or into a dead key.
      [{ key: "˚", code: "KeyK", altKey: true }, "k"],
      [{ key: "Dead", code: "KeyE", altKey: true }, "e"],
      // A layout that types another letter with this key: the letter it types.
      [{ key: "a", code: "KeyQ" }, "a"],
      // A layout with no Latin letters: the key where the letter is.
      [{ key: "л", code: "KeyK" }, "k"],
      [{ key: "Enter", code: "Enter" }, "enter"],
      [{ key: "Enter", code: "NumpadEnter" }, "enter"],
      [{ key: "[", code: "BracketLeft" }, "["],
      [{ key: "\\", code: "Backslash" }, "\\"],
      // A key with no code, as some on-screen keyboards send one.
      [{ key: "e", code: "" }, "e"],
      // No chord has these.
      [{ key: "F5", code: "F5" }, null],
      [{ key: "ArrowUp", code: "ArrowUp" }, null],
      [{ key: "Shift", code: "ShiftLeft", shiftKey: true }, null],
      [{ key: "Unidentified", code: "" }, null],
      [{ key: "Process", code: "constructor" }, null],
    ];
    for (const [pressed, name] of named) {
      expect(`${JSON.stringify(pressed)} → ${edge.keyName(pressed)}`).toBe(`${JSON.stringify(pressed)} → ${name}`);
    }
  });

  test("the session's header, and the shape of a sign-in's three values", () => {
    expect(edge.TOKEN_HEADER).toBe(contract.session.header);
    expect(edge.HASHED.source).toBe(contract.signIn.challenge);
    // The address of the sign-in page ends where the challenge begins.
    expect(edge.SIGNIN_ADDRESS.endsWith("/signin#c=")).toBe(true);
    expect(contract.signIn.page).toBe("/island/v1/signin");
  });

  test("a sign-in's pass and challenge are the hashes that contract.json describes", async () => {
    const window = "hx-fortress island sign-in window\n";
    const challenge = "hx-fortress island sign-in challenge\n";
    // contract.json gives each hash's first words, written as in JSON.
    expect(contract.signIn.values.length).toBe(3);
    expect(contract.signIn.values[1]).toContain(JSON.stringify(window));
    expect(contract.signIn.values[2]).toContain(JSON.stringify(challenge));

    const hashOf = (words: string, value: string): string => createHash("sha256").update(words + value, "utf8").digest("base64url");
    for (const verifier of ["A".repeat(43), Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")]) {
      const pass = await edge.passOf(verifier);
      expect(pass).toBe(hashOf(window, verifier));
      expect(pass).toMatch(edge.HASHED);
      const made = await edge.challengeOf(pass);
      expect(made).toBe(hashOf(challenge, pass));
      expect(made).toMatch(edge.HASHED);
      // The two hashes begin with different words, so neither value stands in for another.
      expect(await edge.challengeOf(verifier)).not.toBe(pass);
    }
  });

  test("what a frame tells HX Fortress for its audit trail is on the list", () => {
    const told = uniq([...island.matchAll(/record\("([a-z-]+)"\)/g)].map((m) => m[1] as string));
    expect(told).toEqual(uniq(contract.events.kinds));
    expect(contract.events.address).toBe("POST /island/v1/event");
  });

  test("the pages a script names are the ones the list names", () => {
    expect(island).toContain('export const SIGNIN_ADDRESS = `${new URL("signin", BASE).href}#c=`;');
    expect(contract.signIn.return).toBe("/island/v1/callback");
    expect(contract.open.page).toBe("/island/v1/open");
    for (const page of ["signin", "callback", "open", "rows"]) expect(folder.files.has(`${page}.html`)).toBe(true);
    // The sign-in window's last page goes back to its first, in the same folder.
    expect(source("callback.js")).toContain("location.replace(`./signin#c=${held.challenge}&how=account`)");
  });
});

describe("what a page script may do", () => {
  test("a message is posted from two places, each to one fixed origin", () => {
    expect(all.match(/\.postMessage\(/g)?.length).toBe(2);
    // To the page around the frame: the origin that HX Fortress named, and no other.
    expect(island).toContain("window.parent.postMessage(message, pages);");
    expect(island).toContain("const pages = config?.pages ?? null;");
    // To a page of this HX Fortress: this origin, and no other, and a listed name only.
    expect(island).toContain("if (BETWEEN.includes(t) && ownPage(to)) to.postMessage({ hx: 1, t, ...fields }, location.origin);");
    for (const name of SCRIPTS.filter((script) => script !== "island.js")) expect(source(name)).not.toContain("postMessage");
  });

  test("the one way out to the page sends a listed message, with its listed fields of the listed kind", () => {
    const post = island.slice(island.indexOf("  function post(t, fields = {}) {"), island.indexOf("  function setState("));
    expect(post).toContain("if (!framed || pages === null || !Object.hasOwn(TO_PAGE, t)) return;");
    expect(post).toContain("if (Object.hasOwn(TO_PAGE[t], name) && fits(TO_PAGE[t][name], value)) message[name] = value;");
    // Nothing else in the script reaches the page around the frame.
    expect(island.match(/window\.parent\b/g)?.length).toBe(4);
    expect(island).toContain("const framed = window.parent !== window;");
    expect(island).toContain("const around = framed ? window.parent : window.opener;");
    expect(island).toContain("e.source !== window.parent || e.origin !== pages");
  });

  test("a message is taken from the page around the frame, or from a page of this HX Fortress, and from nothing else", () => {
    const onMessage = island.slice(island.indexOf("  function onMessage(e) {"), island.indexOf("  async function begin() {"));
    expect(onMessage).toContain('if (!d || typeof d !== "object" || d.hx !== 1 || typeof d.t !== "string") return;');
    expect(onMessage).toContain("if (e.origin === location.origin && e.source && e.source !== window) return fromOwnPage(d, /** @type {Window} */ (e.source));");
    expect(onMessage).toContain("if (!framed || pages === null || e.source !== window.parent || e.origin !== pages) return;");
    expect(onMessage).toContain("const name = FROM_PAGE.find((known) => known === d.t);");
    // The sign-in window takes one answer, from this origin, for its own challenge.
    expect(source("signin-shared.js")).toContain(
      'if (e.origin !== location.origin || !d || d.hx !== 1 || d.t !== "signin!" || d.c !== challenge) return;',
    );
    // Those are the only two places a script listens for a message.
    expect(all.match(/addEventListener\("message"/g)?.length).toBe(2);
    // A sign-in window whose address changes starts over with the new challenge.
    expect(source("signin.js")).toContain('window.addEventListener("hashchange", () => location.reload());');
    // The address of an identity provider is a web address, whatever HX Fortress answered.
    expect(source("signin.js")).toContain("/^https?:\\/\\//.test(said.authorizationUrl)");
  });

  test("a kind's script has no window but its own", () => {
    for (const kind of contract.kinds) {
      const script = source(`${kind.page.split("/").at(-1)}.js`);
      expect(script).not.toBe("");
      expect(script).not.toMatch(/\b(?:parent|opener|top|frames)\s*[.[]|postMessage|window\.open/);
      // It shows what it shows through the edge script, and loads nothing else.
      expect([...script.matchAll(/(?:from|import\()\s*"([^"]+)"/g)].map((m) => m[1])).toEqual(["./island.js"]);
    }
  });

  test("a script calls HX Fortress and nothing else, with no cookie", () => {
    for (const [name, script] of sources) {
      const calls = script.match(/\bfetch\([^\n]*/g) ?? [];
      for (const call of calls) {
        // Every address is made from the folder the scripts are served from.
        expect(`${name}: ${call}`).toMatch(/fetch\(new URL\((path|"config"), BASE\)/);
      }
      expect(script.match(/credentials: "omit"/g)?.length ?? 0).toBe(calls.length);
      for (const banned of [
        "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "localStorage", "indexedDB", "document.cookie",
        "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "importScripts",
        "serviceWorker", "SharedWorker", "BroadcastChannel", "navigator.", "createObjectURL", "window.name",
      ]) {
        expect(`${name} holds ${banned}: ${script.includes(banned)}`).toBe(`${name} holds ${banned}: false`);
      }
      // A script loads only the scripts beside it.
      for (const from of [...script.matchAll(/(?:from|import\()\s*"([^"]+)"/g)].map((m) => m[1] as string)) {
        expect(SCRIPTS).toContain(from.replace(/^\.\//, ""));
        expect(from.startsWith("./")).toBe(true);
      }
    }
    expect(all.match(/\bfetch\(/g)?.length).toBe(2);
  });

  test("what a tab keeps is the session, and what the sign-in window hands from one of its pages to the next", () => {
    const kept = [...all.matchAll(/sessionStorage\.(?:getItem|setItem|removeItem)\(([A-Za-z_"-]+)/g)].map((m) => m[1] as string);
    expect(uniq(kept)).toEqual(["KEPT", "TOKEN_KEY"]);
    expect(island).toContain('const TOKEN_KEY = "hx-fortress-island-token";');
    expect(source("signin-shared.js")).toContain('const KEPT = "hx-fortress-island-signin";');
    // The sign-in window never holds a session: only the page that began the sign-in takes it.
    for (const name of ["signin.js", "signin-shared.js", "callback.js"]) {
      expect(source(name)).not.toContain("TOKEN_HEADER");
      expect(source(name)).not.toMatch(/\btoken\b/);
    }
  });

  test("markup is made from a script's own constants, and a value is only ever set as text", () => {
    for (const name of SCRIPTS.filter((script) => script !== "mark.js")) expect(source(name)).not.toContain("DOMParser");
    const mark = source("mark.js");
    expect(uniq([...mark.matchAll(/\bdrawing\(([A-Za-z]+)\)/g)].map((m) => m[1] as string))).toEqual(["PICTURE", "SMALL", "markup"]);
    // The drawings are put together from this file's own constants and numbers, and hold no
    // value: a name goes in afterwards, as text.
    const drawings = mark.slice(0, mark.indexOf("export function picture("));
    expect(uniq([...drawings.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1] as string))).toEqual([
      "ROOK", "SVG", "arrow(200, 252)", "arrow(64, 116)", "x1", "x2", "x2 - 8",
    ]);
    expect(mark.match(/textContent = /g)?.length).toBe(2);
  });

  test("a copy puts a link on the clipboard, and never a row", () => {
    const copy = island.slice(island.indexOf('addEventListener("copy"'), island.indexOf('addEventListener("cut"'));
    expect(copy).toContain("e.preventDefault();");
    // Two things are put on the clipboard: the link as text, and the link as one <a>.
    expect(all.match(/setData\(/g)?.length).toBe(2);
    expect(copy).toContain('e.clipboardData.setData("text/plain", def.link);');
    expect(copy).toContain(
      'e.clipboardData.setData("text/html", `<a href="${esc(def.link)}" data-secure-data-island="${esc(def.id)}">${esc(def.target)}</a>`);',
    );
    // Where a browser offers Copy only to a page that handles it, the page says that it does.
    expect(island).toContain('document.addEventListener("beforecopy", (e) => e.preventDefault());');
    expect(island).toContain('document.addEventListener("beforecut", (e) => e.preventDefault());');
    // A kind that shows rows says so, and only then is the guard on.
    expect(island).toContain("if (kind.showsRows) {");
    expect(source("rows.js")).toContain("showsRows: true,");
  });

  test("every element a script asks for by its id is in every page that loads the script", () => {
    /** The ids a script must find: `at` and the three small helpers over it. */
    const needs = (script: string): string[] =>
      uniq([...script.matchAll(/\b(?:at|field|line|once)\("(hx-[a-z-]+)"/g)].map((m) => m[1] as string));
    /** The ids a script can do without: it looks, and goes on when there is none. */
    const looksFor = (script: string): string[] =>
      uniq([...script.matchAll(/document\.getElementById\("(hx-[a-z-]+)"\)/g)].map((m) => m[1] as string));
    const idsOf = (page: string): string[] => [...text(page).matchAll(/\bid="([a-z-]+)"/g)].map((m) => m[1] as string);

    let asked = 0;
    for (const page of PAGES) {
      const ids = idsOf(page);
      expect(new Set(ids).size).toBe(ids.length);
      for (const script of scriptsOf(page)) {
        for (const id of needs(source(script))) {
          asked += 1;
          expect(`${page} has #${id} for ${script}: ${ids.includes(id)}`).toBe(`${page} has #${id} for ${script}: true`);
        }
      }
    }
    expect(asked).toBeGreaterThan(20);
    // An id that a script only looks for is in at least one page.
    const somewhere = PAGES.flatMap(idsOf);
    expect(looksFor(all)).toEqual(["hx-crumb", "hx-signout"]);
    for (const id of looksFor(all)) expect(somewhere).toContain(id);
    // And no page holds an id that no script asks for.
    const used = new Set([...needs(all), ...looksFor(all)]);
    for (const id of somewhere) expect(`#${id} is used: ${used.has(id)}`).toBe(`#${id} is used: true`);
  });

  test("each page loads its own script, and names beforehand every script that one loads", () => {
    expect(Object.fromEntries(PAGES.map((page) => [page, scriptsOf(page)]))).toEqual({
      "callback.html": ["callback.js", "island.js", "mark.js", "signin-shared.js"],
      "open.html": ["island.js", "mark.js", "open.js", "rows.js"],
      "rows.html": ["island.js", "rows.js"],
      "signin.html": ["island.js", "mark.js", "signin-shared.js", "signin.js"],
    });
    for (const page of PAGES) {
      const own = moduleScriptOf(text(page));
      const preloaded = [...text(page).matchAll(/<link rel="modulepreload" href="\.\/([a-z0-9-]+\.js)">/g)].map((m) => m[1] as string);
      // The browser fetches them side by side, and not one after the other.
      expect([...preloaded, own].sort()).toEqual(scriptsOf(page));
    }
  });
});
