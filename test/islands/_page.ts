// A page for the scripts of a Secure Data Island to run in, with no browser:
// the few things of a window and a document that the scripts touch.
//
// The scripts are plain files for a browser, and a driven run in three browser
// engines is what proves them there. This stand-in is for what can be said
// without one, in the repository's own run: which messages leave a frame, with
// which fields, to which origin, and what a frame does with what it is sent.

import { cp, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ISLAND_FOLDER } from "../../scripts/gen-island-files";
import { ORGANIZATION, PAGES } from "./_rig";

/** Where this tab keeps a Secure Data Island's session. */
export const TOKEN_KEY = "hx-fortress-island-token";

/** What a kind gets from the edge script. */
export interface Edge {
  root: FakeNode;
  framed: boolean;
  def(): { id: string; kind: string; target: string; settings: Record<string, unknown>; link: string | null };
  api(path: string, payload?: unknown): Promise<Response | null>;
  askGrant(): Promise<string | null>;
  setState(state: string, extra?: Record<string, unknown>): void;
  leave(edge: string): void;
  problem(text: string, again: boolean): void;
  refused(response: Response, still: () => boolean, words: string): Promise<void>;
  printNote(text: string): void;
}

/** A kind, as its own file hands it to `start`. */
export interface Kind {
  name: string;
  showsRows: boolean;
  mount(edge: Edge): {
    show(still: () => boolean): Promise<void>;
    land(where: string): FakeNode | null;
    target(): FakeNode | null;
    key?(event: unknown): void;
    count?(): number;
  };
}

/** What island.js exports. It is plain JavaScript with no declaration file. */
export interface EdgeScript {
  TOKEN_HEADER: string;
  TOKENS: Record<string, string>;
  VALID: Record<string, RegExp>;
  CHORD: RegExp;
  STATES: readonly string[];
  EDGES: readonly string[];
  REFUSALS: Record<string, string>;
  OWN_CODES: readonly string[];
  TO_PAGE: Record<string, Record<string, string>>;
  FROM_PAGE: readonly string[];
  BETWEEN: readonly string[];
  HASHED: RegExp;
  SIGNIN_ADDRESS: string;
  passOf(verifier: string): Promise<string>;
  challengeOf(pass: string): Promise<string>;
  keyName(event: { key: string; code: string; altKey?: boolean; shiftKey?: boolean }): string | null;
  tell(to: FakeWindow, t: string, fields?: Record<string, string>): void;
  start(kind: Kind): Promise<void>;
}

export interface Scripts {
  /** The address the copies are loaded from, as `import.meta.url` gives their folder. */
  base: string;
  /** The edge script. */
  island(): Promise<EdgeScript>;
  /** The `rows` kind. Loading it starts it on the page that is installed. */
  rows(): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * A copy of the folder's scripts, to load afresh. A module is loaded once for
 * an address, and the edge script remembers what HX Fortress said of itself,
 * so each test loads its own copy.
 */
export async function freshScripts(): Promise<Scripts> {
  // The folder under its real name: a module's own address names the real folder, and a
  // temporary folder is often reached through a link.
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "hx-island-scripts-")));
  for (const name of await readdir(ISLAND_FOLDER)) {
    if (name.endsWith(".js")) await cp(path.join(ISLAND_FOLDER, name), path.join(dir, name));
  }
  const address = (name: string): string => Bun.pathToFileURL(path.join(dir, name)).href;
  return {
    base: new URL(".", address("island.js")).href,
    island: async () => (await import(address("island.js"))) as EdgeScript,
    rows: async () => {
      await import(address("rows.js"));
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

type Listener = (event: unknown) => unknown;

/** An element, as far as the scripts use one. */
export class FakeNode {
  className = "";
  textContent = "";
  hidden = false;
  /** How tall the element is. A test sets it, for the frame to measure. */
  height = 0;
  children: (FakeNode | string)[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  /** The custom properties set on this element's style. */
  readonly properties = new Map<string, string>();
  readonly style = {
    setProperty: (name: string, value: string): void => void this.properties.set(name, value),
    removeProperty: (name: string): void => void this.properties.delete(name),
  };
  readonly classList = {
    add: (name: string): void => {
      if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim();
    },
    remove: (name: string): void => {
      this.className = this.className.split(" ").filter((held) => held !== name).join(" ");
    },
    contains: (name: string): boolean => this.className.split(" ").includes(name),
  };
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly tag: string,
    private readonly page: FakePage,
  ) {}

  get id(): string {
    return this.attributes.get("id") ?? "";
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  append(...nodes: (FakeNode | string)[]): void {
    this.children.push(...nodes);
  }
  prepend(...nodes: (FakeNode | string)[]): void {
    this.children.unshift(...nodes);
  }
  replaceChildren(...nodes: (FakeNode | string)[]): void {
    this.children = nodes;
  }
  /** The first element under this one with the tag, or with the class of `.name`. */
  querySelector(selector: string): FakeNode | null {
    for (const child of this.children) {
      if (typeof child === "string") continue;
      const fits = selector.startsWith(".") ? child.classList.contains(selector.slice(1)) : child.tag === selector;
      const found = fits ? child : child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  getBoundingClientRect(): { height: number } {
    return { height: this.height };
  }
  focus(): void {
    this.page.document.activeElement = this;
  }
  scrollIntoView(): void {
    // Nothing scrolls here.
  }
  /** What a click, or a key, on this element does. */
  fire(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) void listener(event);
  }
  /** Every word that this element and the ones under it show. */
  words(): string {
    return [this.textContent, ...this.children.map((child) => (typeof child === "string" ? child : child.words()))]
      .filter((text) => text !== "")
      .join(" ");
  }
}

/** One message, with the origin it was addressed to. */
export interface Posted {
  message: Record<string, unknown>;
  to: string;
}

/** The address of the made-up HX Fortress. */
export const FORTRESS = "https://fortress.northstar.example";

/** A window that a script can send a message to: it keeps what it was sent. */
export class FakeWindow {
  readonly posted: Posted[] = [];
  readonly length = 0;
  readonly location: { origin: string };
  /** A window that shows a page of HX Fortress, or of the origin given. */
  constructor(origin: string = FORTRESS) {
    this.location = { origin };
  }
  postMessage(message: Record<string, unknown>, to: string): void {
    this.posted.push({ message, to });
  }
}

/** One call a script made to HX Fortress. */
export interface Called {
  path: string;
  method: string;
  body: unknown;
  /** The session the call carried, or null. */
  token: string | null;
}

export type Answer = (body: unknown) => Response | null | Promise<Response | null>;

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const GLOBALS = [
  "window", "document", "location", "sessionStorage", "ResizeObserver", "history", "fetch", "setTimeout", "clearTimeout", "setInterval",
];

/** A timer of a second or more does not run by itself here. A test lets it run with `elapse`,
 *  so that no test depends on how fast the machine is. */
const SLOW_MS = 1000;

export interface FakePageOptions {
  /** The address of HX Fortress. */
  origin?: string;
  /** False for a page in a window of its own. */
  framed?: boolean;
  /** True for one of HX Fortress's own pages. */
  own?: boolean;
  /** The fragment of the page's address, without its `#`. */
  hash?: string;
}

/**
 * One page of HX Fortress in a frame: its window, its document, and the page
 * around it. `install` puts it where the scripts look for it, and `remove`
 * takes it away again with everything the scripts left waiting.
 */
export class FakePage {
  /** The page around the frame: a page of the control plane. */
  readonly around = new FakeWindow(PAGES);
  /** What HX Fortress was asked, in order. */
  readonly calls: Called[] = [];
  /** A call that a script made to any other address. There is never one. */
  readonly strays: string[] = [];
  /** What HX Fortress answers, by the address under `/island/v1/`. No answer: it does not answer. */
  readonly answers = new Map<string, Answer>([
    ["config", () => json(200, { v: 1, pages: PAGES, organization: ORGANIZATION, signIn: "account" })],
  ]);
  /** What this tab keeps. */
  readonly kept = new Map<string, string>();
  readonly html: FakeNode;
  readonly body: FakeNode;
  readonly origin: string;
  readonly document: {
    documentElement: FakeNode;
    body: FakeNode;
    activeElement: FakeNode | null;
    createElement(tag: string): FakeNode;
    getElementById(id: string): FakeNode | null;
    hasFocus(): boolean;
    addEventListener(type: string, listener: Listener): void;
  };
  /** The frame's own window. */
  readonly self: Record<string, unknown>;
  private readonly location: Record<string, unknown>;
  private readonly listeners = new Map<string, Listener[]>();
  private readonly observers: (() => void)[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** The slow timers that wait for the test to let them run. */
  private readonly held = new Map<number, { run: () => void; ms: number }>();
  private lastHeld = 1_000_000_000;
  private readonly saved = new Map<string, PropertyDescriptor | undefined>();

  constructor(
    private readonly base: string,
    options: FakePageOptions = {},
  ) {
    this.origin = options.origin ?? FORTRESS;
    this.html = new FakeNode("html", this);
    if (options.own) this.html.classList.add("hx-own");
    this.body = new FakeNode("body", this);
    const listen = (type: string, listener: Listener): void => {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    };
    this.document = {
      documentElement: this.html,
      body: this.body,
      activeElement: null,
      createElement: (tag) => new FakeNode(tag, this),
      getElementById: () => null,
      hasFocus: () => false,
      addEventListener: (type, listener) => listen(`document ${type}`, listener),
    };
    this.self = { opener: null, addEventListener: listen };
    this.self.parent = options.framed === false ? this.self : this.around;
    this.location = {
      origin: this.origin,
      host: new URL(this.origin).host,
      hash: options.hash ? `#${options.hash}` : "",
      pathname: "/island/v1/rows",
      reload: () => undefined,
    };
  }

  /** The element the edge script draws in. */
  get root(): FakeNode {
    const root = this.body.querySelector(".hx-root");
    if (!root) throw new Error("the edge script has not started on this page");
    return root;
  }

  /** What the frame told the page around it, in order. */
  get told(): Record<string, unknown>[] {
    return this.around.posted.map((posted) => posted.message);
  }
  /** The newest message of one name that the frame told the page, or null. */
  last(t: string): Record<string, unknown> | null {
    return this.told.filter((message) => message.t === t).at(-1) ?? null;
  }

  install(): void {
    const observers = this.observers;
    const track = <T extends ReturnType<typeof setTimeout>>(timer: T): T => {
      this.timers.add(timer);
      return timer;
    };
    const realTimeout = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const realInterval = globalThis.setInterval;
    const put: Record<string, unknown> = {
      window: this.self,
      document: this.document,
      location: this.location,
      sessionStorage: {
        getItem: (key: string) => this.kept.get(key) ?? null,
        setItem: (key: string, value: string) => void this.kept.set(key, value),
        removeItem: (key: string) => void this.kept.delete(key),
      },
      ResizeObserver: class {
        constructor(private readonly changed: () => void) {}
        observe(): void {
          observers.push(this.changed);
        }
      },
      history: { replaceState: () => undefined },
      fetch: (input: URL | string, init?: RequestInit) => this.answer(String(input), init),
      setTimeout: (run: () => void, ms = 0) => {
        if (ms < SLOW_MS) return track(realTimeout(run, ms));
        this.lastHeld += 1;
        this.held.set(this.lastHeld, { run, ms });
        return this.lastHeld;
      },
      clearTimeout: (timer: unknown) => {
        if (typeof timer === "number" && this.held.delete(timer)) return;
        realClear(timer as ReturnType<typeof setTimeout>);
      },
      setInterval: (run: () => void, ms?: number) => track(realInterval(run, ms)),
    };
    for (const name of GLOBALS) {
      this.saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      // A name from the list above.
      // eslint-disable-next-line security/detect-object-injection
      Object.defineProperty(globalThis, name, { value: put[name], configurable: true, writable: true });
    }
  }

  /** Take the page away, with every timer a script left waiting. */
  remove(): void {
    for (const [name, was] of this.saved) {
      if (was) Object.defineProperty(globalThis, name, was);
      else Reflect.deleteProperty(globalThis, name);
    }
    this.saved.clear();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.held.clear();
  }

  private async answer(address: string, init: RequestInit | undefined): Promise<Response> {
    if (!address.startsWith(this.base)) {
      this.strays.push(address);
      throw new TypeError("a page file called another address");
    }
    const called = address.slice(this.base.length);
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({
      path: called,
      method: init?.method ?? "GET",
      body,
      token: new Headers(init?.headers).get("x-fortress-island-token"),
    });
    const response = (await this.answers.get(called)?.(body)) ?? null;
    if (!response) throw new TypeError("HX Fortress did not answer");
    return response;
  }

  /** Let the slow timers of up to this many milliseconds run, as if that time had passed. How
   *  many ran. */
  elapse(ms: number): number {
    const due = [...this.held].filter(([, timer]) => timer.ms <= ms);
    for (const [id, timer] of due) {
      this.held.delete(id);
      timer.run();
    }
    return due.length;
  }

  /** A message, as the browser hands one to the page. */
  deliver(data: unknown, from: { origin: string; source: unknown }): void {
    for (const listener of this.listeners.get("message") ?? []) void listener({ data, origin: from.origin, source: from.source });
  }
  /** A message from the page around the frame. */
  fromPage(message: Record<string, unknown>): void {
    this.deliver({ hx: 1, ...message }, { origin: PAGES, source: this.around });
  }
  /** A message from another page of this HX Fortress. */
  fromOwnPage(from: FakeWindow, message: Record<string, unknown>): void {
    this.deliver({ hx: 1, ...message }, { origin: this.origin, source: from });
  }

  /** Something that happens on the document: a copy, a cut, a drag. */
  fire(type: string, event: unknown): void {
    for (const listener of this.listeners.get(`document ${type}`) ?? []) void listener(event);
  }

  /** A key pressed in the frame. True when the frame kept the key from the browser. */
  key(event: { key: string; code?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): boolean {
    let kept = false;
    const pressed = {
      code: "",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...event,
      preventDefault: () => {
        kept = true;
      },
      stopPropagation: () => undefined,
    };
    this.fire("keydown", pressed);
    return kept;
  }

  /** The frame's content changed its height. */
  resized(height: number): void {
    this.root.height = height;
    for (const changed of this.observers) changed();
  }
}

/** Wait until something is so. */
export async function until(check: () => boolean, what: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 4000) throw new Error(`waited for ${what}, and it did not come`);
    await Bun.sleep(2);
  }
}

/** Let what is already under way finish. */
export async function settle(): Promise<void> {
  await Bun.sleep(25);
}

/** A promise with its two ends. */
export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
