import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runSetupCommand } from "../src/cli-setup";
import { configExists } from "../src/host/config";
import { SetupAudit } from "../src/setup/audit";
import { ALREADY_SET_UP, runBrowserSetup, setupLinkPath, type BrowserSetupOptions } from "../src/setup/browser";
import { SetupRun, type FinishResult, type SetupRunDeps } from "../src/setup/run";
import { manifestOf, mapDistDir, type UiAssets } from "../src/ui/assets";
import { UiConfigStore } from "../src/ui/config";
import {
  createSetupHandler,
  mintSetupLink,
  setupLinkUrl,
  takeAnswers,
  type SetupDone,
  type SetupRequestHandler,
  type SetupServerCtx,
} from "../src/ui/setup-server";
import { FORTRESS_SETUP_API as SETUP_API, SETUP_SESSION_HEADER } from "../src/ui/wire";
import { fixedSecrets, spoolRecords, tempRoot, type Paths } from "./host/_module-rig";

// Built at run time so no secret-shaped literal sits in the repository.
const DB_URL = ["postgres://fortress:", "pw-for-a-test", "@db.northstar.example:5432/fortress"].join("");
const PORT = 9120;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function root(): Promise<Paths> {
  const made = await tempRoot();
  cleanups.push(made.cleanup);
  return made.paths;
}

function runDeps(paths: Paths, over: Partial<SetupRunDeps> = {}): SetupRunDeps {
  return {
    paths,
    env: {},
    read: { vaultCredentials: async () => null },
    apply: {
      updateVaultCredentials: async () => {
        throw new Error("no test here keeps files");
      },
    },
    check: {
      keyStore: () => fixedSecrets({ "db-url": DB_URL }),
      fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      probeDatabase: async () => "PostgreSQL 17.2",
      probeFiles: async () => {},
      timeoutMs: 2_000,
    },
    ...over,
  };
}

/** The console's pages, as far as the setup needs them: a shell and one script. */
async function pages(): Promise<UiAssets> {
  const dist = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-setup-pages-"));
  cleanups.push(() => rm(dist, { recursive: true, force: true }));
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await writeFile(path.join(dist, "index.html"), '<!doctype html><div id="root"></div>');
  await writeFile(path.join(dist, "assets", "index-abc123.js"), "export const a = 1;\n");
  const files = mapDistDir(dist);
  return { mode: "disk", files, inlineScriptHashes: [], manifest: await manifestOf(files) };
}

interface Rig {
  paths: Paths;
  run: SetupRun;
  handler: SetupRequestHandler;
  token: string;
  clock: { now: number };
  seen: { opened: string[]; refused: number[]; done: number };
}

async function rig(over: { run?: Partial<SetupRunDeps>; paths?: Paths; doneGraceMs?: number } = {}): Promise<Rig> {
  const paths = over.paths ?? (await root());
  const run = await SetupRun.open(runDeps(paths, over.run));
  const link = mintSetupLink();
  const clock = { now: 1_000_000 };
  const seen: Rig["seen"] = { opened: [], refused: [], done: 0 };
  const audit = new SetupAudit(paths.auditSpool);
  const ctx: SetupServerCtx = {
    assets: await pages(),
    port: PORT,
    run,
    link,
    bind: "127.0.0.1",
    publicUrl: null,
    // Long, so that in these tests only the page's own word closes the setup.
    doneGraceMs: over.doneGraceMs ?? 60_000,
    finish: (): Promise<FinishResult> => run.finish("browser", { audit }),
    done: (result): SetupDone => ({
      consoleAddress: ORIGIN,
      firstAccount: result.applied.firstAccount
        ? { login: result.applied.firstAccount.login, link: `${ORIGIN}/setup#t=one-time` }
        : null,
      notes: result.applied.notes,
      summary: run.derived().summary,
      next: "Start the Fortress on its host: `hx-fortress start`",
    }),
    onDone: () => {
      seen.done += 1;
    },
    onOpened: (remote) => {
      seen.opened.push(remote);
    },
    onLinkRefused: (_remote, attempts) => {
      seen.refused.push(attempts);
    },
    now: () => clock.now,
  };
  return { paths, run, handler: createSetupHandler(ctx), token: link.token, clock, seen };
}

interface Call {
  session?: string | null;
  body?: unknown;
  host?: string | null;
  origin?: string | null;
}

async function call(
  r: Rig,
  method: "GET" | "POST",
  route: string,
  options: Call = {},
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const headers: Record<string, string> = {};
  const host = options.host === undefined ? HOST : options.host;
  if (host !== null) headers.host = host;
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (method === "POST" && origin !== null) headers.origin = origin;
  if (options.session) headers[SETUP_SESSION_HEADER] = options.session;
  if (method === "POST") headers["content-type"] = "application/json";
  const response = await r.handler.handle(
    new Request(`http://${HOST}${SETUP_API}/${route}`, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {}),
    }),
    "127.0.0.1",
  );
  if (!response) throw new Error(`the setup did not answer ${route}`);
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

async function open(r: Rig): Promise<string> {
  const answer = await call(r, "POST", "open", { body: { token: r.token } });
  expect(answer.status).toBe(200);
  return answer.body.session as string;
}

const NORTHSTAR = { organization: { name: "Northstar", firstAdministrator: "marta.lindqvist" } };

describe("the one-time link", () => {
  test("carries its token in the fragment, where no request line, log or Referer sees it", () => {
    const link = mintSetupLink();
    const url = new URL(setupLinkUrl("http://127.0.0.1:9120/", link.token));
    expect(url.pathname).toBe("/setup");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#s=${link.token}`);
    // 256 random bits, and only its digest is kept.
    expect(Buffer.from(link.token, "base64url")).toHaveLength(32);
    expect(link.digest.toString("hex")).not.toContain(link.token);
  });

  test("opens once: the first browser gets a session, and a second one is refused in plain words", async () => {
    const r = await rig();
    const session = await open(r);
    expect(session.length).toBeGreaterThan(30);
    expect(r.seen.opened).toEqual(["127.0.0.1"]);

    const again = await call(r, "POST", "open", { body: { token: r.token } });
    expect(again.status).toBe(410);
    expect(again.body.error).toContain("already opened, and a link works once");
    expect(again.body.session).toBeUndefined();
    expect(r.seen.refused).toHaveLength(1);

    // The first browser's session still works.
    expect((await call(r, "GET", "state", { session })).status).toBe(200);
  });

  test("a wrong link is refused, and no number of them keeps the right link out", async () => {
    const r = await rig();
    for (let i = 1; i <= 25; i += 1) {
      const answer = await call(r, "POST", "open", { body: { token: `wrong-${i}` } });
      expect(answer.status).toBe(401);
      expect(answer.body.error).toBe("This is not this Fortress's setup link");
    }
    // The right link opens at once, in the same instant as the flood.
    expect(r.seen.opened).toEqual([]);
    await open(r);
    expect(r.seen.opened).toEqual(["127.0.0.1"]);
  });

  test("refused links are recorded up to ten in ten minutes, so a flood cannot fill the audit trail", async () => {
    const r = await rig();
    for (let i = 1; i <= 25; i += 1) await call(r, "POST", "open", { body: { token: `wrong-${i}` } });
    expect(r.seen.refused).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Still refused, and no longer recorded.
    expect((await call(r, "POST", "open", { body: { token: "wrong-26" } })).status).toBe(401);
    expect(r.seen.refused).toHaveLength(10);
    // Ten minutes later a refusal is recorded again.
    r.clock.now += 10 * 60_000 + 1;
    await call(r, "POST", "open", { body: { token: "wrong-27" } });
    expect(r.seen.refused).toHaveLength(11);
  });

  test("a token that is not a short string is refused like any wrong one", async () => {
    const r = await rig();
    for (const token of [undefined, 7, { a: 1 }, "x".repeat(200)]) {
      expect((await call(r, "POST", "open", { body: { token } })).status).toBe(401);
    }
  });
});

describe("the session", () => {
  test("every route but the link's needs it, and a wrong one is refused", async () => {
    const r = await rig();
    await open(r);
    for (const [method, route] of [
      ["GET", "state"],
      ["POST", "check"],
      ["POST", "enroll"],
      ["POST", "enroll/check"],
      ["POST", "finish"],
    ] as const) {
      expect((await call(r, method, route)).status).toBe(401);
      expect((await call(r, method, route, { session: "not-the-session" })).status).toBe(401);
    }
    expect(await configExists(r.paths)).toBe(false);
  });

  test("a request for another host name is refused, so no other site's name can reach the setup", async () => {
    const r = await rig();
    const session = await open(r);
    const answer = await call(r, "GET", "state", { session, host: "setup.attacker.example" });
    expect(answer.status).toBe(400);
    expect((await call(r, "GET", "state", { session, host: null })).status).toBe(400);
  });

  test("a write from another site's page, or with no Origin, is refused", async () => {
    const r = await rig();
    const session = await open(r);
    for (const origin of ["https://attacker.example", "null", null]) {
      const answer = await call(r, "POST", "check", { session, origin, body: { step: "organization" } });
      expect(answer.status).toBe(403);
    }
    // The link itself is held to the same rule.
    const fresh = await rig();
    const answer = await call(fresh, "POST", "open", { origin: "https://attacker.example", body: { token: fresh.token } });
    expect(answer.status).toBe(403);
    expect(fresh.seen.opened).toEqual([]);
  });

  test("it is asked for at most 240 checks a minute", async () => {
    const r = await rig();
    const session = await open(r);
    for (let i = 0; i < 240; i += 1) {
      expect((await call(r, "POST", "check", { session, body: {} })).status).toBe(200);
    }
    expect((await call(r, "POST", "check", { session, body: {} })).status).toBe(429);
    r.clock.now += 60_001;
    expect((await call(r, "POST", "check", { session, body: {} })).status).toBe(200);
  });
});

describe("what a page can send", () => {
  test("an answer is taken by its path, and nothing else is: no new key, no other type", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths));
    const before = JSON.stringify(run.answers);
    takeAnswers(run, {
      // Not answers of the setup.
      admin: true,
      __proto__: { polluted: "yes" },
      organization: { name: 42, owner: "somebody", "bad key": "x" },
      modules: { not_a_module: true, host: "yes" },
      keys: { store: ["env"] },
      // Too deep to be an answer.
      data: { files: { store: { a: { b: { c: "s3" } } } } },
    });
    expect(JSON.stringify(run.answers)).toBe(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    takeAnswers(run, { organization: { name: "Northstar" }, modules: { host: true }, signIn: { operatorGroups: ["admins"] } });
    expect(run.answers.organization.name).toBe("Northstar");
    expect(run.answers.modules.host).toBe(true);
    expect(run.answers.signIn.operatorGroups).toEqual(["admins"]);
  });

  test("an answer that the host's environment decides is left as the host set it", async () => {
    const r = await rig({ run: { env: { FORTRESS_SECRETS_PROVIDER: "env" } } });
    const session = await open(r);
    const answer = await call(r, "POST", "check", {
      session,
      body: { step: "keys", answers: { keys: { store: "file", folder: "/tmp/elsewhere" } } },
    });
    expect(answer.status).toBe(200);
    expect(r.run.answers.keys.store).toBe("env");
    // The page learns what the host decides when it loads, with everything else it draws from.
    const state = await call(r, "GET", "state", { session });
    expect((state.body.frame as { pinned: Record<string, string> }).pinned["keys.store"]).toBe("FORTRESS_SECRETS_PROVIDER");
  });

  test("a check answers with what it found in a few words, and never with a key", async () => {
    const r = await rig();
    const session = await open(r);
    const answers = { data: { database: { store: "postgres", address: "db-url" } } };
    const one = await call(r, "POST", "check", { session, body: { step: "data", answers } });
    const lines = (one.body.check as { lines: { text: string; ok: boolean }[] }).lines;
    expect(lines.map((line) => line.text)).toEqual(["Found", "Database reached. PostgreSQL 17.2"]);
    const all = await call(r, "POST", "check", { session, body: { step: "all" } });
    expect((all.body.checks as unknown[]).length).toBe(10);
    const state = await call(r, "GET", "state", { session });
    for (const text of [one.text, all.text, state.text]) {
      expect(text).not.toContain("pw-for-a-test");
      expect(text).not.toContain("db.northstar.example");
    }
  });

  test("a step it does not know is checked as nothing", async () => {
    const r = await rig();
    const session = await open(r);
    const answer = await call(r, "POST", "check", { session, body: { step: "__proto__" } });
    expect(answer.status).toBe(200);
    expect(answer.body.check).toBeNull();
  });
});

describe("the end", () => {
  test("a refused answer writes nothing and says which question refused", async () => {
    const r = await rig();
    const session = await open(r);
    const answer = await call(r, "POST", "finish", { session, body: { answers: { organization: { name: "" } } } });
    expect(answer.status).toBe(200);
    expect(answer.body.done).toBeUndefined();
    const refused = (answer.body.checks as { step: string; ok: boolean }[]).filter((check) => !check.ok);
    expect(refused.map((check) => check.step)).toContain("organization");
    expect(await configExists(r.paths)).toBe(false);
    expect(r.seen.done).toBe(0);
    const records = (await spoolRecords(r.paths)).filter((record) => record.action === "fortress.setup.finished");
    expect(records.map((record) => [record.kind, record.outcome])).toEqual([
      ["intent", null],
      ["outcome", "refused"],
    ]);
  });

  test("finishing writes the answers, closes the setup, and leaves one thing to ask: the last screen", async () => {
    const r = await rig();
    const session = await open(r);
    const answer = await call(r, "POST", "finish", { session, body: { answers: NORTHSTAR } });
    expect(answer.status).toBe(200);
    const done = answer.body.done as SetupDone;
    expect(done.firstAccount?.login).toBe("marta.lindqvist");
    expect(done.summary.controlPlane).toBe("None");
    expect(await configExists(r.paths)).toBe(true);
    expect(r.handler.finished()).toBe(true);
    // The listener waits for the page's word that the last screen arrived: it
    // holds the first administrator's link, which is handed out once.
    await Promise.resolve();
    expect(r.seen.done).toBe(0);

    // A reload of the last screen.
    const again = await call(r, "GET", "state", { session });
    expect(again.status).toBe(200);
    expect((again.body.done as SetupDone).consoleAddress).toBe(ORIGIN);
    // Nothing else answers, with or without answers to write.
    for (const route of ["check", "enroll", "enroll/check", "finish"]) {
      const late = await call(r, "POST", route, { session, body: { answers: { organization: { name: "Other" } } } });
      expect(late.status).toBe(410);
      expect(late.body.error).toContain("Setup is closed");
    }
    const config = JSON.parse(await readFile(r.paths.config, "utf8")) as { organization: { name: string } };
    expect(config.organization.name).toBe("Northstar");

    // The trail says that the setup ran in a browser and which questions it
    // wrote. It holds no answer.
    const records = await spoolRecords(r.paths);
    const finished = records.filter((record) => record.action === "fortress.setup.finished");
    expect(finished.map((record) => [record.kind, record.outcome])).toEqual([
      ["intent", null],
      ["outcome", "done"],
    ]);
    expect(finished[0]?.actor).toBe("holder of the one-time setup link (browser)");
    // Every question of a new install was written, and the record names them
    // all. The one answer it holds is the login of the account the setup made.
    expect(finished[0]?.params).toEqual({
      way: "browser",
      changed: "organization,keys,signIn,data,modules,model,network,records,updates,controlPlane",
      account: "marta.lindqvist",
    });
    expect(JSON.stringify(records)).not.toContain("Northstar");
  });

  test("the page's word that the last screen arrived closes the setup at once", async () => {
    const r = await rig();
    const session = await open(r);
    await call(r, "POST", "finish", { session, body: { answers: NORTHSTAR } });
    expect(r.seen.done).toBe(0);
    const seen = await call(r, "POST", "seen", { session });
    expect(seen.status).toBe(200);
    await Promise.resolve();
    expect(r.seen.done).toBe(1);
    // Said twice, it closes once.
    await call(r, "POST", "seen", { session });
    await Promise.resolve();
    expect(r.seen.done).toBe(1);
  });

  test("with no word from the page the setup closes by itself after a short wait", async () => {
    const r = await rig({ doneGraceMs: 20 });
    const session = await open(r);
    await call(r, "POST", "finish", { session, body: { answers: NORTHSTAR } });
    expect(r.seen.done).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(r.seen.done).toBe(1);
  });

  test("before the end, the page's word does nothing: the setup stays open", async () => {
    const r = await rig();
    const session = await open(r);
    expect((await call(r, "POST", "seen", { session })).status).toBe(404);
    expect(r.seen.done).toBe(0);
    expect((await call(r, "GET", "state", { session })).status).toBe(200);
  });
});

describe("the end, while other requests arrive", () => {
  /** A rig whose checks wait until the test lets them go on. */
  async function held(): Promise<{ r: Rig; session: string; release: () => void; waiting: () => number }> {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting = 0;
    // The users file is read by the Organization and Sign-in checks: holding
    // it holds every end of the setup at its checks.
    const paths = await root();
    const slow = await rig({
      paths,
      run: {
        ...runDeps(paths),
        check: {
          ...runDeps(paths).check,
          users: async () => {
            waiting += 1;
            await gate;
            return { version: 1, users: [] } as never;
          },
        },
      },
    });
    return { r: slow, session: await open(slow), release, waiting: () => waiting };
  }

  test("what is written is what was checked: an answer that arrives during the end is not written", async () => {
    const { r, session, release, waiting } = await held();
    const ending = call(r, "POST", "finish", { session, body: { answers: NORTHSTAR } });
    while (waiting() === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    // A request that would change an answer is refused while the end runs.
    const late = await call(r, "POST", "check", {
      session,
      body: { step: "organization", answers: { organization: { name: "Other" } } },
    });
    expect(late.status).toBe(409);
    expect(late.body.error).toBe("The setup is being saved");
    // And so is a change made behind the listener's back: the end works on its own copy.
    r.run.set("organization.name", "Changed after the checks began");
    release();
    expect((await ending).status).toBe(200);
    const config = JSON.parse(await readFile(r.paths.config, "utf8")) as { organization: { name: string } };
    expect(config.organization.name).toBe("Northstar");
  });

  test("two ends at once write once, and both get the same last screen", async () => {
    const { r, session, release, waiting } = await held();
    const first = call(r, "POST", "finish", { session, body: { answers: NORTHSTAR } });
    while (waiting() === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = call(r, "POST", "finish", { session, body: { answers: { organization: { name: "Other" } } } });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // The one-time link of the first administrator is the same in both: it was made once.
    expect((a.body.done as SetupDone).firstAccount).toEqual((b.body.done as SetupDone).firstAccount);
    expect((a.body.done as SetupDone).firstAccount?.login).toBe("marta.lindqvist");
    const finished = (await spoolRecords(r.paths)).filter((record) => record.action === "fortress.setup.finished");
    expect(finished.map((record) => record.kind)).toEqual(["intent", "outcome"]);
    const config = JSON.parse(await readFile(r.paths.config, "utf8")) as { organization: { name: string } };
    expect(config.organization.name).toBe("Northstar");
  });
});

// ── The listener, from the link it writes to the moment it closes ────────────

/** A port nothing listens on right now. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port ?? 0;
  void probe.stop(true);
  return port;
}

interface Served {
  exit: Promise<number>;
  lines: string[];
  link: string;
  port: number;
  stop: () => void;
}

async function serve(paths: Paths, over: Partial<BrowserSetupOptions> = {}): Promise<Served> {
  const lines: string[] = [];
  let stop: () => void = () => {};
  const stopSignal = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const assets = await pages();
  const port = freePort();
  const listening = Promise.withResolvers<{ link: string; port: number }>();
  const exit = runBrowserSetup({
    paths,
    env: {},
    writeLine: (line) => lines.push(line),
    isTty: false,
    port,
    noContainer: true,
    hostName: "fortress-host",
    doneGraceMs: 50,
    run: runDeps(paths),
    loadAssets: async () => assets,
    stopSignal,
    onListening: (info) => listening.resolve(info),
    ...over,
  });
  // A setup that cannot run ends before it listens.
  void exit.then((code) => listening.reject(new Error(`the setup ended with ${code}: ${lines.join(" | ")}`)));
  const info = await listening.promise;
  cleanups.push(async () => {
    stop();
    await exit.catch(() => {});
  });
  return { exit, lines, link: info.link, port: info.port, stop };
}

async function post(served: Served, route: string, session: string | null, body: unknown): Promise<Response> {
  const origin = `http://127.0.0.1:${served.port}`;
  return fetch(`${origin}${SETUP_API}/${route}`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      ...(session ? { [SETUP_SESSION_HEADER]: session } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("hx-fortress setup --browser", () => {
  test("a Fortress that is set up refuses it, and says how an answer is changed from then on", async () => {
    const paths = await root();
    const run = await SetupRun.open(runDeps(paths));
    takeAnswers(run, NORTHSTAR);
    expect((await run.finish("terminal")).ok).toBe(true);

    const lines: string[] = [];
    const code = await runBrowserSetup({
      paths,
      env: {},
      writeLine: (line) => lines.push(line),
      run: runDeps(paths),
      loadAssets: pages,
    });
    expect(code).toBe(1);
    expect(lines).toEqual([`error: ${ALREADY_SET_UP}`]);
    expect(ALREADY_SET_UP).toContain("hx-fortress setup");
  });

  test("with nobody at a terminal the link is not printed: it is kept in a file only the Fortress's user can read", async () => {
    const paths = await root();
    const served = await serve(paths);
    const token = new URL(served.link).hash.slice("#s=".length);
    expect(token.length).toBeGreaterThan(30);
    expect(served.lines.join("\n")).not.toContain(token);
    expect(served.lines.join("\n")).toContain("hx-fortress setup link");

    const file = setupLinkPath(paths);
    expect((await readFile(file, "utf8")).trim()).toBe(served.link);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // The command a person on the host types for it.
    const printed: string[] = [];
    expect(await runSetupCommand(["link"], { writeLine: (line) => printed.push(line), fortressRoot: paths.root })).toBe(0);
    expect(printed).toEqual([served.link]);

    served.stop();
    expect(await served.exit).toBe(1);
    expect(served.lines.at(-1)).toBe("Setup stopped. Nothing was saved.");
    expect(await stat(file).catch(() => null)).toBeNull();
    expect(await configExists(paths)).toBe(false);
  });

  test("with a person at a terminal the link is printed there", async () => {
    const paths = await root();
    const served = await serve(paths, { isTty: true });
    expect(served.lines).toContain(`    ${served.link}`);
    expect(served.link).toStartWith(`http://127.0.0.1:${served.port}/setup#s=`);
  });

  test("it listens on this host only, and has no flag that widens it", async () => {
    const paths = await root();
    const served = await serve(paths);
    expect(served.lines).toContain(`  listening on 127.0.0.1:${served.port}`);
    const lines: string[] = [];
    for (const flag of ["--bind", "--allow-insecure-bind"]) {
      const code = await runSetupCommand(["--browser", flag, "0.0.0.0"], {
        writeLine: (line) => lines.push(line),
        fortressRoot: paths.root,
        browser: async () => {
          throw new Error("the setup must not start");
        },
      });
      expect(code).toBe(1);
    }
    expect(lines.filter((line) => line.startsWith("error: unknown option"))).toHaveLength(2);
  });

  test("serves the console's own pages, and none of the console's routes", async () => {
    const paths = await root();
    const served = await serve(paths);
    const origin = `http://127.0.0.1:${served.port}`;
    const page = await fetch(`${origin}/setup`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="root">');
    expect(page.headers.get("content-security-policy")).toContain("default-src");
    expect(page.headers.get("set-cookie")).toBeNull();
    for (const route of ["/ui/api/session", "/ui/api/login", "/ui/api/setup"]) {
      expect((await fetch(`${origin}${route}`)).status).toBe(404);
    }
  });

  test("a whole setup over the wire: open, answer, finish, and the listener is gone", async () => {
    const paths = await root();
    const served = await serve(paths);
    const token = new URL(served.link).hash.slice("#s=".length);

    const opened = await post(served, "open", null, { token });
    expect(opened.status).toBe(200);
    expect(opened.headers.get("set-cookie")).toBeNull();
    const session = ((await opened.json()) as { session: string }).session;

    const check = await post(served, "check", session, { step: "organization", answers: NORTHSTAR });
    expect(((await check.json()) as { check: { ok: boolean } }).check.ok).toBe(true);

    const finished = await post(served, "finish", session, { answers: NORTHSTAR });
    const done = ((await finished.json()) as { done: SetupDone }).done;
    // The console answers where the setup did.
    expect(done.consoleAddress).toBe(`http://127.0.0.1:${served.port}`);
    expect(done.firstAccount?.link).toStartWith(`http://127.0.0.1:${served.port}/setup#t=`);
    expect(done.next).toContain("hx-fortress start");

    expect(await served.exit).toBe(0);
    expect(served.lines.at(-1)).toBe("Setup is saved, and the browser setup is closed.");
    // The first account's link is a credential too, and is not in the output.
    expect(served.lines.join("\n")).not.toContain(done.firstAccount?.link.split("#t=")[1] as string);
    expect(await stat(setupLinkPath(paths)).catch(() => null)).toBeNull();
    expect(await fetch(`http://127.0.0.1:${served.port}/healthz`).then(() => "answers", () => "gone")).toBe("gone");

    // The port the setup was given is the console's from now on, and the
    // console is on: there is something to sign in to.
    const ui = await new UiConfigStore(paths.uiConfig).load();
    expect(ui).toMatchObject({ enabled: true, port: served.port, bind: "127.0.0.1", allowInsecureBind: false });

    const actions = (await spoolRecords(paths)).map((record) => `${record.action} ${record.kind} ${record.outcome}`);
    expect(actions).toEqual([
      "fortress.setup.opened outcome done",
      "fortress.setup.finished intent null",
      "fortress.setup.finished outcome done",
    ]);
  });

  test("a container's entry point is told that the Fortress starts next, and the last screen says so", async () => {
    const paths = await root();
    const served = await serve(paths, { startsAfter: true });
    const token = new URL(served.link).hash.slice("#s=".length);
    const session = ((await (await post(served, "open", null, { token })).json()) as { session: string }).session;
    const finished = await post(served, "finish", session, { answers: NORTHSTAR });
    const done = ((await finished.json()) as { done: SetupDone }).done;
    expect(done.next).toBe("The Fortress starts now. The console answers in a moment");
    expect(await served.exit).toBe(0);
  });

  test("in a container the link is never printed, even with a terminal attached: the output is the container's log", async () => {
    const paths = await root();
    const served = await serve(paths, {
      isTty: true,
      noContainer: false,
      platform: "linux",
      env: { KUBERNETES_SERVICE_HOST: "10.0.0.1" },
    });
    const token = new URL(served.link).hash.slice("#s=".length);
    const said = served.lines.join("\n");
    expect(said).not.toContain(token);
    expect(said).toContain("print it in this container: hx-fortress setup link");
    // And the listener is as wide as the console's would be here: with the
    // console not switched on by the environment, that is the container itself.
    expect(served.lines).toContain(`  listening on 127.0.0.1:${served.port}`);
    expect(said).toContain("this listener answers inside the container only, as the console would");
    expect(said).toContain("FORTRESS_UI_ENABLE=1");
  });

  test("a stop that arrives while the answers are being written waits, and says what happened", async () => {
    const paths = await root();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting = 0;
    const deps = runDeps(paths);
    const served = await serve(paths, {
      run: {
        ...deps,
        check: {
          ...deps.check,
          users: async () => {
            waiting += 1;
            await gate;
            return { version: 1, users: [] } as never;
          },
        },
      },
    });
    const token = new URL(served.link).hash.slice("#s=".length);
    const session = ((await (await post(served, "open", null, { token })).json()) as { session: string }).session;
    const finishing = post(served, "finish", session, { answers: NORTHSTAR }).catch(() => null);
    while (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    served.stop();
    // Not ended yet: the end of the setup is under way.
    const early = await Promise.race([served.exit, new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 30))]);
    expect(early).toBe("waiting");
    release();
    expect(await served.exit).toBe(0);
    expect(served.lines.at(-1)).toBe("Setup is saved, and the browser setup is closed.");
    expect(served.lines.join("\n")).not.toContain("Nothing was saved");
    expect(await configExists(paths)).toBe(true);
    await finishing;
  });

  test("a setup that cannot go on after it began to listen stops listening", async () => {
    const paths = await root();
    // The folder its link is kept in cannot be made: a file is in its place.
    await mkdir(path.dirname(paths.uiRoot), { recursive: true });
    await writeFile(paths.uiRoot, "in the way\n");
    const port = freePort();
    const assets = await pages();
    const lines: string[] = [];
    const ended = runBrowserSetup({
      paths,
      env: {},
      writeLine: (line) => lines.push(line),
      isTty: false,
      port,
      noContainer: true,
      run: runDeps(paths),
      loadAssets: async () => assets,
      stopSignal: new Promise<void>(() => {}),
    });
    expect(await ended.then(() => "ended", () => "failed")).toBe("failed");
    expect(await fetch(`http://127.0.0.1:${port}/setup`).then(() => "answers", () => "gone")).toBe("gone");
    expect(await configExists(paths)).toBe(false);
  });
});
