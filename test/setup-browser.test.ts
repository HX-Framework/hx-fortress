// The setup's browser page: its routes (one link, one session, the checks,
// the typed keys and the last step), and `hx-fortress setup --browser`, which
// serves it on the machine itself from the link it prints to the moment it
// closes.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { runSetupCommand } from "../src/cli-setup";
import { configExists } from "../src/host/config";
import { cloneAnswers, setAnswer, settleAnswers, type SetupAnswers } from "../src/setup/answers";
import { SetupAudit } from "../src/setup/audit";
import { ALREADY_SET_UP, runBrowserSetup, setupLinkPath, type BrowserSetupOptions } from "../src/setup/browser";
import { STEP_IDS } from "../src/setup/list";
import { SetupRun, type SetupRunDeps } from "../src/setup/run";
import type { SetupDone, SetupState } from "../src/setup/view";
import { UiConfigStore } from "../src/ui/config";
import { mintSetupLink, setupLinkUrl, takeAnswers } from "../src/ui/setup-server";
import { FORTRESS_SETUP_API as SETUP_API, SETUP_SESSION_HEADER } from "../src/ui/wire";
import { fixedSecrets, spoolRecords, tempRoot, type Paths } from "./host/_module-rig";
import { answerNorthstar, installRun, StandInPlace, until, untouchedRoot } from "./install-rig";
import { DB_URL, serve, SETUP_ORIGIN, setupPages, type Served } from "./setup-rig";

// Built at run time so no secret-shaped literal sits in the repository.
const TYPED = ["sk", "ant", "typed", "Ft8kNotAReal0ne"].join("-");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const register = (cleanup: () => Promise<void>): void => {
  cleanups.push(cleanup);
};

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

interface Rig extends Served {
  paths: Paths;
  run: SetupRun;
  clock: { now: number };
  seen: { opened: string[]; refused: number[] };
}

/** The routes of a setup on the machine itself, answered in this process. */
async function machine(over: { run?: Partial<SetupRunDeps>; paths?: Paths; doneGraceMs?: number | null } = {}): Promise<Rig> {
  const paths = over.paths ?? (await root());
  const run = await SetupRun.open(runDeps(paths, over.run));
  const clock = { now: 1_000_000 };
  const seen: Rig["seen"] = { opened: [], refused: [] };
  const audit = new SetupAudit(paths.auditSpool);
  const served = await serve(run, {
    register,
    // Long, so that in these tests only the page's own word closes the setup.
    doneGraceMs: over.doneGraceMs === undefined ? 60_000 : over.doneGraceMs,
    create: () =>
      run.create(
        "browser",
        { consoleBase: SETUP_ORIGIN, next: "Start HX Fortress on its host: hx-fortress start" },
        { audit },
      ),
    onOpened: (remote) => {
      seen.opened.push(remote);
    },
    onLinkRefused: (_remote, attempts) => {
      seen.refused.push(attempts);
    },
    now: () => clock.now,
  });
  return { ...served, paths, run, clock, seen };
}

/** The routes of an install, answered in this process, for a stand-in place. */
async function install(place = new StandInPlace("azure")): Promise<Served & { run: SetupRun; place: StandInPlace }> {
  const made = await untouchedRoot();
  cleanups.push(made.cleanup);
  const run = await installRun([place], { paths: made.paths });
  const served = await serve(run, { register });
  return { ...served, run, place };
}

const NORTHSTAR = { organization: { name: "Northstar", firstAdministrator: "marta.lindqvist" } };

// ── The link and the session ─────────────────────────────────────────────────

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
    const r = await machine();
    const session = await r.open();
    expect(session.length).toBeGreaterThan(30);
    expect(r.seen.opened).toEqual(["127.0.0.1"]);

    const again = await r.call("POST", "open", { body: { token: r.token } });
    expect(again.status).toBe(410);
    expect(again.body.error).toContain("already opened, and a link works once");
    expect(again.body.session).toBeUndefined();
    expect(r.seen.refused).toHaveLength(1);

    // The first browser's session still works.
    expect((await r.call("GET", "state", { session })).status).toBe(200);
  });

  test("a wrong link is refused, and no number of them keeps the right link out", async () => {
    const r = await machine();
    for (let i = 1; i <= 25; i += 1) {
      const answer = await r.call("POST", "open", { body: { token: `wrong-${i}` } });
      expect(answer.status).toBe(401);
      expect(answer.body.error).toBe("This is not this setup's link");
    }
    // The right link opens at once, in the same instant as the flood.
    expect(r.seen.opened).toEqual([]);
    await r.open();
    expect(r.seen.opened).toEqual(["127.0.0.1"]);
  });

  test("refused links are recorded up to ten in ten minutes, so a flood cannot fill the audit trail", async () => {
    const r = await machine();
    for (let i = 1; i <= 25; i += 1) await r.call("POST", "open", { body: { token: `wrong-${i}` } });
    expect(r.seen.refused).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect((await r.call("POST", "open", { body: { token: "wrong-26" } })).status).toBe(401);
    expect(r.seen.refused).toHaveLength(10);
    r.clock.now += 10 * 60_000 + 1;
    await r.call("POST", "open", { body: { token: "wrong-27" } });
    expect(r.seen.refused).toHaveLength(11);
  });

  test("a token that is not a short string is refused like any wrong one", async () => {
    const r = await machine();
    for (const token of [undefined, 7, { a: 1 }, "x".repeat(200)]) {
      expect((await r.call("POST", "open", { body: { token } })).status).toBe(401);
    }
  });
});

describe("the session", () => {
  const ROUTES = [
    ["GET", "state"],
    ["GET", "progress"],
    ["POST", "check"],
    ["POST", "typed"],
    ["POST", "create"],
    ["POST", "seen"],
  ] as const;

  test("every route but the link's needs it, and a wrong one is refused", async () => {
    for (const r of [await machine(), await install()]) {
      await r.open();
      for (const [method, route] of ROUTES) {
        expect([route, (await r.call(method, route)).status]).toEqual([route, 401]);
        expect([route, (await r.call(method, route, { session: "not-the-session" })).status]).toEqual([route, 401]);
      }
    }
  });

  test("a request for another host name is refused, so no other site's name can reach the setup", async () => {
    const r = await machine();
    const session = await r.open();
    expect((await r.call("GET", "state", { session, host: "setup.attacker.example" })).status).toBe(400);
    expect((await r.call("GET", "state", { session, host: null })).status).toBe(400);
  });

  test("a write from another site's page, or with no Origin, is refused", async () => {
    const r = await machine();
    const session = await r.open();
    for (const origin of ["https://attacker.example", "null", null]) {
      expect((await r.call("POST", "check", { session, origin, body: { step: "organization" } })).status).toBe(403);
    }
    // The link itself is held to the same rule.
    const fresh = await machine();
    const answer = await fresh.call("POST", "open", { origin: "https://attacker.example", body: { token: fresh.token } });
    expect(answer.status).toBe(403);
    expect(fresh.seen.opened).toEqual([]);
  });

  test("it is asked for at most 240 checks a minute", async () => {
    const r = await machine();
    const session = await r.open();
    for (let i = 0; i < 240; i += 1) {
      expect((await r.call("POST", "check", { session, body: { step: "organization" } })).status).toBe(200);
    }
    expect((await r.call("POST", "check", { session, body: { step: "organization" } })).status).toBe(429);
    r.clock.now += 60_001;
    expect((await r.call("POST", "check", { session, body: { step: "organization" } })).status).toBe(200);
  });
});

// ── What a page can send ─────────────────────────────────────────────────────

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

    takeAnswers(run, { organization: { name: "Northstar" }, modules: { host: false }, signIn: { administratorGroups: ["admins"] } });
    expect(run.answers.organization.name).toBe("Northstar");
    expect(run.answers.modules.host).toBe(false);
    expect(run.answers.signIn.administratorGroups).toEqual(["admins"]);
  });

  test("an answer that the host's environment decides is left as the host set it", async () => {
    const r = await machine({ run: { env: { FORTRESS_SECRETS_PROVIDER: "env" } } });
    const session = await r.open();
    const answer = await r.call("POST", "check", {
      session,
      body: { step: "keys", answers: { keys: { store: "file", folder: "/tmp/elsewhere" } } },
    });
    expect(answer.status).toBe(200);
    expect(r.run.answers.keys.store).toBe("env");
    // The page learns what the host decides when it loads, with everything else it draws from.
    const state = await r.call("GET", "state", { session });
    expect((state.body.frame as { pinned: Record<string, string> }).pinned["keys.store"]).toBe("FORTRESS_SECRETS_PROVIDER");
  });

  test("on the machine itself a page cannot change where HX Fortress runs, nor the answers that follow a place", async () => {
    const r = await machine();
    const session = await r.open();
    const before = cloneAnswers(r.run.answers);
    const answer = await r.call("POST", "check", {
      session,
      body: { step: "keys", answers: { where: { place: "azure", region: "eastus2" } } },
    });
    expect(answer.status).toBe(200);
    expect(r.run.answers.where).toEqual(before.where);
    expect([r.run.answers.keys.store, r.run.answers.address.certificate, r.run.answers.data.database.store]).toEqual([
      before.keys.store,
      before.address.certificate,
      before.data.database.store,
    ]);
  });

  test("a check answers with what it found in a few words, and never with a key", async () => {
    const r = await machine();
    const session = await r.open();
    const answers = { data: { database: { store: "existing", address: "db-url" } } };
    const one = await r.call("POST", "check", { session, body: { step: "data", answers } });
    const lines = (one.body.check as { lines: { text: string; ok: boolean }[] }).lines;
    expect(lines.map((line) => line.text)).toEqual(["Found", "Database reached. PostgreSQL 17.2"]);
    const all = await r.call("POST", "check", { session, body: { step: "all" } });
    // Every question but where it runs, which is a fact on the machine itself.
    expect((all.body.checks as { step: string }[]).map((check) => check.step)).toEqual(STEP_IDS.filter((id) => id !== "where"));
    const state = await r.call("GET", "state", { session });
    for (const text of [one.text, all.text, state.text]) {
      expect(text).not.toContain("pw-for-a-test");
      expect(text).not.toContain("db.northstar.example");
    }
  });

  test("a check while a person types asks nothing outside this computer", async () => {
    let calls = 0;
    const r = await machine({
      run: {
        check: {
          keyStore: () => fixedSecrets({ "db-url": DB_URL }),
          fetch: (async () => {
            calls += 1;
            return new Response(null, { status: 200 });
          }) as unknown as typeof fetch,
          probeDatabase: async () => {
            calls += 1;
            return "PostgreSQL 17.2";
          },
        },
      },
    });
    const session = await r.open();
    const quick = await r.call("POST", "check", {
      session,
      body: { step: "data", quick: true, answers: { data: { database: { store: "existing", address: "db-url" } } } },
    });
    expect(quick.status).toBe(200);
    expect(calls).toBe(0);
  });

  test("a step it does not know is checked as nothing", async () => {
    const r = await machine();
    const session = await r.open();
    const answer = await r.call("POST", "check", { session, body: { step: "__proto__" } });
    expect(answer.status).toBe(200);
    expect(answer.body.check).toBeNull();
  });

  test("a whole body from a page that applied the same rule to its suggestions ends with the page's answers", async () => {
    const r = await install();
    const session = await r.open();
    // The page's own copy: each change set, then settled by the same rule.
    let page: SetupAnswers = cloneAnswers(r.run.answers);
    const change = (at: string, value: string): void => {
      const before = page;
      page = cloneAnswers(page);
      setAnswer(page, at, value);
      settleAnswers(page, at, undefined, { before, install: true });
    };
    const send = async (): Promise<void> => {
      expect((await r.call("POST", "check", { session, body: { step: "organization", quick: true, answers: page } })).status).toBe(200);
      expect(r.run.answers).toEqual(page);
    };
    change("organization.name", "Northstar");
    change("organization.firstAdministrator", "marta.lindqvist@northstar.example");
    await send();
    expect(page.keys.vault).toBe("northstar-hx-fortress");
    // Two changes before the next request, and one a person typed over.
    change("organization.name", "Northstar Analytics");
    change("address.hostname", "data.northstar.example");
    change("organization.firstAdministrator", "marta@tallgrass.example");
    await send();
    expect(page.address.hostname).toBe("data.northstar.example");
    // A new place, sent with everything else.
    change("where.place", "aws");
    change("keys.vault", "northstar-own-vault");
    change("organization.name", "Tallgrass Title");
    await send();
    expect(page.keys.vault).toBe("northstar-own-vault");
  });
});

// ── The typed keys and the last step of an install ───────────────────────────

describe("the routes of an install", () => {
  test("typed takes a key for a key field only, and answers with the paths alone", async () => {
    const r = await install();
    const session = await r.open();
    const typed = await r.call("POST", "typed", { session, body: { path: "model.key", value: TYPED } });
    expect(typed.status).toBe(200);
    expect(typed.body).toEqual({ typed: ["model.key"] });
    expect(typed.text).not.toContain(TYPED);
    for (const body of [
      { path: "organization.name", value: TYPED },
      { path: "address.certificateName", value: TYPED },
      { path: "model.key", value: 7 },
      { value: TYPED },
    ]) {
      const refused = await r.call("POST", "typed", { session, body });
      expect(refused.status).toBe(400);
      expect(refused.body).toEqual({ error: "This field does not take a typed key" });
    }
    const state = await r.call("GET", "state", { session });
    expect((state.body.derived as { typed: string[] }).typed).toEqual(["model.key"]);
    expect(state.text).not.toContain(TYPED);
  });

  test("a paste that is too long to be a key is refused in words at its field, and the setup goes on", async () => {
    const r = await install();
    const session = await r.open();
    const long = "k".repeat(16_385);
    const refused = await r.call("POST", "typed", { session, body: { path: "model.key", value: long } });
    // An answer, and not an error: the page shows the sentence and stays open.
    expect(refused.status).toBe(200);
    expect(refused.body).toEqual({ typed: [], refused: "This is longer than a key can be, so it was not kept" });
    expect(refused.text).not.toContain("kkkkkkkk");
    // The session is as good as before, and the right key is taken next.
    const typed = await r.call("POST", "typed", { session, body: { path: "model.key", value: TYPED } });
    expect(typed.body).toEqual({ typed: ["model.key"] });
    // A field that takes no key is refused as before, however long the value.
    expect((await r.call("POST", "typed", { session, body: { path: "organization.name", value: long } })).status).toBe(400);
  });

  test("typed is not a route of a setup on the machine itself", async () => {
    const r = await machine();
    const session = await r.open();
    expect((await r.call("POST", "typed", { session, body: { path: "model.key", value: TYPED } })).status).toBe(404);
    expect(JSON.stringify(r.run.answers)).not.toContain(TYPED);
  });

  test("two creates at once start one making; while it is under way check and typed wait, and state and progress answer", async () => {
    const place = new StandInPlace("azure");
    place.holdDns = true;
    const r = await install(place);
    const session = await r.open();
    answerNorthstar(r.run, TYPED);
    const [a, b] = await Promise.all([
      r.call("POST", "create", { session, body: {} }),
      r.call("POST", "create", { session, body: {} }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    await place.dnsAsked();
    expect(place.makes).toBe(1);
    expect((await r.call("POST", "check", { session, body: { step: "organization" } })).status).toBe(409);
    expect((await r.call("POST", "typed", { session, body: { path: "model.key", value: "another" } })).status).toBe(409);
    const progress = await r.call("GET", "progress", { session });
    expect(progress.status).toBe(200);
    expect((progress.body.progress as { stage: string; now: string }).stage).toBe("making");
    expect((progress.body.progress as { now: string }).now).toBe("dns");
    expect((await r.call("GET", "state", { session })).status).toBe(200);
    // A third create while it is under way starts nothing either.
    await r.call("POST", "create", { session, body: {} });
    place.releaseDns();
    await until(() => r.run.done() !== null, "the install to be made");
    expect(place.makes).toBe(1);

    // After the end, state still returns the whole state, with what was made.
    const state = (await r.call("GET", "state", { session })).body as unknown as SetupState;
    expect(Object.keys(state).sort()).toEqual(["answers", "derived", "done", "frame", "progress"]);
    expect(state.done?.address).toBe("https://hx.northstar.example");
    expect(state.progress.stage).toBe("done");
    // Nothing but the page's word is taken any more.
    expect((await r.call("POST", "check", { session, body: { step: "organization" } })).status).toBe(410);
    // With no limit to its wait, the listener stays until the page says the last screen arrived.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.closed()).toBe(0);
    expect((await r.call("POST", "seen", { session })).status).toBe(200);
    await Promise.resolve();
    expect(r.closed()).toBe(1);
  });

  test("a refused answer starts nothing, and says which step refused it", async () => {
    const r = await install();
    const session = await r.open();
    const answer = await r.call("POST", "create", { session, body: { answers: NORTHSTAR } });
    expect(answer.status).toBe(200);
    const refused = (answer.body.checks as { step: string; ok: boolean }[]).filter((check) => !check.ok).map((check) => check.step);
    expect(refused).toEqual(["address", "model"]);
    expect(r.place.makes).toBe(0);
    expect(r.run.done()).toBeNull();
  });
});

// ── The end of a setup on the machine itself ─────────────────────────────────

describe("the end", () => {
  test("a refused answer writes nothing and says which question refused", async () => {
    const r = await machine();
    const session = await r.open();
    const answer = await r.call("POST", "create", { session, body: { answers: { organization: { name: "" } } } });
    expect(answer.status).toBe(200);
    expect(answer.body.done).toBeUndefined();
    const refused = (answer.body.checks as { step: string; ok: boolean }[]).filter((check) => !check.ok);
    expect(refused.map((check) => check.step)).toContain("organization");
    expect(await configExists(r.paths)).toBe(false);
    expect(r.closed()).toBe(0);
    const records = (await spoolRecords(r.paths)).filter((record) => record.action === "fortress.setup.finished");
    expect(records.map((record) => [record.kind, record.outcome])).toEqual([
      ["intent", null],
      ["outcome", "refused"],
    ]);
  });

  test("saying yes writes the answers, and leaves one thing to ask: the last screen", async () => {
    const r = await machine();
    const session = await r.open();
    const answer = await r.call("POST", "create", { session, body: { answers: NORTHSTAR } });
    expect(answer.status).toBe(200);
    const done = answer.body.done as SetupDone;
    expect(done.address).toBe(SETUP_ORIGIN);
    expect(done.firstAccount?.login).toBe("marta.lindqvist");
    expect(done.firstAccount?.link).toStartWith(`${SETUP_ORIGIN}/setup#t=`);
    expect(await configExists(r.paths)).toBe(true);
    expect(r.handler.finished()).toBe(true);
    // The listener waits for the page's word that the last screen arrived: it
    // holds the first administrator's link, which is handed out once.
    await Promise.resolve();
    expect(r.closed()).toBe(0);

    // A reload of the last screen.
    const again = await r.call("GET", "state", { session });
    expect(again.status).toBe(200);
    expect((again.body.done as SetupDone).address).toBe(SETUP_ORIGIN);
    // Nothing else answers, with or without answers to write.
    for (const route of ["check", "typed", "create"]) {
      const late = await r.call("POST", route, { session, body: { answers: { organization: { name: "Other" } } } });
      expect([route, late.status]).toEqual([route, 410]);
      expect(late.body.error).toBe("Setup is closed");
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
    // all. Where it runs is no question on the machine itself.
    expect(finished[0]?.params).toEqual({
      way: "browser",
      changed: STEP_IDS.filter((id) => id !== "where").join(","),
      account: "marta.lindqvist",
    });
    expect(JSON.stringify(records)).not.toContain("Northstar");
  });

  test("the page's word that the last screen arrived closes the setup at once", async () => {
    const r = await machine();
    const session = await r.open();
    await r.call("POST", "create", { session, body: { answers: NORTHSTAR } });
    expect(r.closed()).toBe(0);
    expect((await r.call("POST", "seen", { session })).status).toBe(200);
    await Promise.resolve();
    expect(r.closed()).toBe(1);
    // Said twice, it closes once.
    await r.call("POST", "seen", { session });
    await Promise.resolve();
    expect(r.closed()).toBe(1);
  });

  test("with no word from the page the setup closes by itself after a short wait", async () => {
    const r = await machine({ doneGraceMs: 20 });
    const session = await r.open();
    await r.call("POST", "create", { session, body: { answers: NORTHSTAR } });
    expect(r.closed()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(r.closed()).toBe(1);
  });

  test("with no limit to its wait, the setup stays open until the page says so", async () => {
    const r = await machine({ doneGraceMs: null });
    const session = await r.open();
    await r.call("POST", "create", { session, body: { answers: NORTHSTAR } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(r.closed()).toBe(0);
    await r.call("POST", "seen", { session });
    await Promise.resolve();
    expect(r.closed()).toBe(1);
  });

  test("before the end, the page's word does nothing: the setup stays open", async () => {
    const r = await machine();
    const session = await r.open();
    expect((await r.call("POST", "seen", { session })).status).toBe(404);
    expect(r.closed()).toBe(0);
    expect((await r.call("GET", "state", { session })).status).toBe(200);
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
    const slow = await machine({
      paths,
      run: {
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
    return { r: slow, session: await slow.open(), release, waiting: () => waiting };
  }

  test("what is written is what was checked: an answer that arrives during the end is not written", async () => {
    const { r, session, release, waiting } = await held();
    const ending = r.call("POST", "create", { session, body: { answers: NORTHSTAR } });
    while (waiting() === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    // A request that would change an answer is refused while the end runs.
    const late = await r.call("POST", "check", {
      session,
      body: { step: "organization", answers: { organization: { name: "Other" } } },
    });
    expect(late.status).toBe(409);
    expect(late.body.error).toBe("The last step is under way");
    // The state still answers.
    expect((await r.call("GET", "state", { session })).status).toBe(200);
    // And a change made behind the listener's back is not written: the end works on its own copy.
    r.run.set("organization.name", "Changed after the checks began");
    release();
    expect((await ending).status).toBe(200);
    const config = JSON.parse(await readFile(r.paths.config, "utf8")) as { organization: { name: string } };
    expect(config.organization.name).toBe("Northstar");
  });

  test("two ends at once write once, and both get the same last screen", async () => {
    const { r, session, release, waiting } = await held();
    const first = r.call("POST", "create", { session, body: { answers: NORTHSTAR } });
    while (waiting() === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = r.call("POST", "create", { session, body: { answers: { organization: { name: "Other" } } } });
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

/** A port nothing listens on right now, from the system's own choice. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port ?? 0;
  void probe.stop(true);
  return port;
}

interface Listening {
  exit: Promise<number>;
  lines: string[];
  link: string;
  port: number;
  stop: () => void;
}

async function listen(paths: Paths, over: Partial<BrowserSetupOptions> = {}): Promise<Listening> {
  const lines: string[] = [];
  let stop: () => void = () => {};
  const stopSignal = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const assets = await setupPages(register);
  const listening = Promise.withResolvers<{ link: string; port: number }>();
  const exit = runBrowserSetup({
    paths,
    env: {},
    writeLine: (line) => lines.push(line),
    isTty: false,
    port: freePort(),
    noContainer: true,
    hostName: "hx-host",
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

async function post(served: Listening, route: string, session: string | null, body: unknown): Promise<Response> {
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

async function sessionOf(served: Listening): Promise<string> {
  const token = new URL(served.link).hash.slice("#s=".length);
  return ((await (await post(served, "open", null, { token })).json()) as { session: string }).session;
}

describe("hx-fortress setup --browser", () => {
  test("an HX Fortress that is set up refuses it, and says how an answer is changed from then on", async () => {
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
      loadAssets: () => setupPages(register),
    });
    expect(code).toBe(1);
    expect(lines).toEqual([`error: ${ALREADY_SET_UP}`]);
    expect(ALREADY_SET_UP).toContain("hx-fortress setup");
  });

  test("with nobody at a terminal the link is not printed: it is kept in a file only HX Fortress's user can read", async () => {
    const paths = await root();
    const served = await listen(paths);
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
    const served = await listen(paths, { isTty: true });
    expect(served.lines).toContain(`    ${served.link}`);
    expect(served.link).toStartWith(`http://127.0.0.1:${served.port}/setup#s=`);
  });

  test("it listens on this host only, and has no flag that widens it", async () => {
    const paths = await root();
    const served = await listen(paths);
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
    const served = await listen(paths);
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

  test("a whole setup over the wire: open, answer, say yes, and the listener is gone", async () => {
    const paths = await root();
    const served = await listen(paths);
    const token = new URL(served.link).hash.slice("#s=".length);

    const opened = await post(served, "open", null, { token });
    expect(opened.status).toBe(200);
    expect(opened.headers.get("set-cookie")).toBeNull();
    const session = ((await opened.json()) as { session: string }).session;

    const check = await post(served, "check", session, { step: "organization", answers: NORTHSTAR });
    expect(((await check.json()) as { check: { ok: boolean } }).check.ok).toBe(true);

    const created = await post(served, "create", session, { answers: NORTHSTAR });
    const done = ((await created.json()) as { done: SetupDone }).done;
    // The console answers where the setup did.
    expect(done.address).toBe(`http://127.0.0.1:${served.port}`);
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

  test("a container's entry point is told that HX Fortress starts next, and the last screen says so", async () => {
    const paths = await root();
    const served = await listen(paths, { startsAfter: true });
    const session = await sessionOf(served);
    const created = await post(served, "create", session, { answers: NORTHSTAR });
    const done = ((await created.json()) as { done: SetupDone }).done;
    expect(done.next).toBe("HX Fortress starts now. Its console answers in a moment.");
    expect(await served.exit).toBe(0);
  });

  test("in a container the link is never printed, even with a terminal attached: the output is the container's log", async () => {
    const paths = await root();
    const served = await listen(paths, {
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
    const served = await listen(paths, {
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
    const session = await sessionOf(served);
    const creating = post(served, "create", session, { answers: NORTHSTAR }).catch(() => null);
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
    await creating;
  });

  test("a setup that cannot go on after it began to listen stops listening", async () => {
    const paths = await root();
    // The folder its link is kept in cannot be made: a file is in its place.
    await mkdir(path.dirname(paths.uiRoot), { recursive: true });
    await writeFile(paths.uiRoot, "in the way\n");
    const port = freePort();
    const lines: string[] = [];
    const ended = runBrowserSetup({
      paths,
      env: {},
      writeLine: (line) => lines.push(line),
      isTty: false,
      port,
      noContainer: true,
      run: runDeps(paths),
      loadAssets: () => setupPages(register),
      stopSignal: new Promise<void>(() => {}),
    });
    expect(await ended.then(() => "ended", () => "failed")).toBe("failed");
    expect(await fetch(`http://127.0.0.1:${port}/setup`).then(() => "answers", () => "gone")).toBe("gone");
    expect(await configExists(paths)).toBe(false);
  });
});
