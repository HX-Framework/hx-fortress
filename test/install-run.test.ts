// One run of `hx-fortress install`: the keys a person types, the last step
// that hands everything to the place, and what is handed over. Nothing here is
// written on this computer: every run's folder is one that does not exist,
// and each test asserts that it still does not.

import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";

import { FIRST_ACCOUNT_DIGEST_ENV, FIRST_ACCOUNT_EXPIRES_ENV, DATABASE_KEY_NAME, handOverOf } from "../src/install/handover";
import type { HandOver } from "../src/install/place";
import { installAnswers, parseSettingsFile, settingsFileText, defaultAnswers, type SetupAnswers } from "../src/setup/answers";
import { keyFields } from "../src/setup/list";
import { installPlan } from "../src/setup/plan";
import { SetupRun, type SetupRunDeps } from "../src/setup/run";
import { SETUP_SETTINGS_ENV } from "../src/setup/state";
import { tempRoot } from "./host/_module-rig";
import { answerNorthstar, DNS_TARGET, installRun, providers, StandInPlace, until, untouchedRoot } from "./install-rig";
import { CONTROL, INSTALL_ID, MODULES, PAGES, providerDocument, runDeps, serve } from "./setup-rig";

// Built at run time so no secret-shaped literal sits in the repository.
const MODEL_KEY = ["sk", "ant", "typed", "Lm3vQ8NotAReal0ne"].join("-");
const OTHER_KEY = ["sk", "ant", "typed", "Zz1xNotTheFirst0ne"].join("-");
const CLIENT_SECRET = ["client", "secret", "Hq2Wn5NotReal"].join("_");
const CONNECTION = ["postgres://hx:", "Yp7dNotARealPassw0rd", "@db.northstar.example:5432/hx"].join("");
const TYPED = [MODEL_KEY, CLIENT_SECRET, CONNECTION];
const SEEDED = ["version", "organization", "signIn", "modules", "model", "network", "updates", "auditTrail"];

const cleanups: (() => Promise<void>)[] = [];
const folders: string[] = [];
afterEach(async () => {
  // The install wrote nothing on this computer: looked at before anything is removed.
  const left = [];
  for (const folder of folders.splice(0)) {
    if (await stat(folder).then(() => true, () => false)) left.push(folder);
  }
  for (const cleanup of cleanups.splice(0)) await cleanup();
  expect(left).toEqual([]);
});

async function open(places: StandInPlace[], over: Partial<SetupRunDeps> = {}): Promise<SetupRun> {
  const made = await untouchedRoot();
  cleanups.push(made.cleanup);
  folders.push(made.paths.root);
  return installRun(places, { paths: made.paths, ...over });
}

/** Everything that may leave the run, as text. */
async function whatLeaves(run: SetupRun): Promise<string> {
  return JSON.stringify([
    run.answers,
    run.derived(),
    await run.frame(),
    run.progress(),
    run.done(),
    settingsFileText(run.answers),
    run.typedPaths(),
  ]);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const tokenOf = (link: string): string => link.slice(link.indexOf("#t=") + 3);

// ── A key a person types ─────────────────────────────────────────────────────

describe("a key a person types in the install", () => {
  test("is taken only in the install, only for a key field that has a name to give it, and the answer becomes that name", async () => {
    const run = await open([new StandInPlace("azure")]);
    const typed = [...keyFields().values()].filter((field) => field.typedAs);
    for (const field of typed) {
      expect([field.path, run.setTyped(field.path, MODEL_KEY)]).toEqual([field.path, true]);
      expect(run.answers).toBeDefined();
      expect([field.path, JSON.stringify(run.answers).includes(field.typedAs as string)]).toEqual([field.path, true]);
    }
    expect(run.answers.model.key).toBe("model-key");
    expect(run.answers.signIn.clientSecret).toBe("sign-in-client-secret");
    expect(run.answers.data.database.address).toBe("database-address");
    expect(run.typedPaths().sort()).toEqual(typed.map((field) => field.path).sort());
    // A key field with no name to give, any other field, and what is not text.
    expect(run.setTyped("address.certificateName", MODEL_KEY)).toBe(false);
    expect(run.setTyped("organization.name", MODEL_KEY)).toBe(false);
    expect(run.setTyped("model.provider", MODEL_KEY)).toBe(false);
    expect(run.setTyped("model.key", 7)).toBe(false);
    expect(run.setTyped("model.key", "k".repeat(16_385))).toBe(false);
    // An empty value forgets the key.
    expect(run.setTyped("model.key", "")).toBe(true);
    expect(run.typedPaths()).not.toContain("model.key");

    // A setup on the machine itself takes none.
    const machine = await tempRoot();
    cleanups.push(machine.cleanup);
    const setup = await SetupRun.open(runDeps(machine.paths));
    expect(setup.setTyped("model.key", MODEL_KEY)).toBe(false);
    expect(setup.typedPaths()).toEqual([]);
    expect(JSON.stringify(setup.answers)).not.toContain(MODEL_KEY);
  });

  test("is in nothing that leaves the run, nor in any reply of the server, for a whole install", async () => {
    const place = new StandInPlace("azure");
    place.holdDns = true;
    // The sign-in provider describes itself; the model provider takes the key.
    const outside = (async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith("/.well-known/openid-configuration")
        ? Response.json(providerDocument("https://login.northstar.example"))
        : new Response('{"data":[]}', { status: 200 })) as unknown as typeof fetch;
    const run = await open([place], { check: { fetch: outside } });
    const served = await serve(run, { register: (cleanup) => cleanups.push(cleanup) });
    const session = await served.open();

    await served.call("GET", "state", { session });
    await served.call("POST", "check", {
      session,
      body: {
        answers: {
          organization: { name: "Northstar", firstAdministrator: "marta.lindqvist" },
          address: { hostname: "hx.northstar.example" },
          data: { database: { store: "existing" } },
          signIn: {
            provider: "openid-connect",
            issuer: "https://login.northstar.example",
            clientId: "hx-fortress",
            administratorGroups: ["hx-fortress-admins"],
          },
        },
        step: "organization",
      },
    });
    for (const [at, value] of [
      ["model.key", MODEL_KEY],
      ["signIn.clientSecret", CLIENT_SECRET],
      ["data.database.address", CONNECTION],
    ] as const) {
      const typed = await served.call("POST", "typed", { session, body: { path: at, value } });
      expect(typed.status).toBe(200);
      expect(Object.keys(typed.body)).toEqual(["typed"]);
    }
    for (const step of ["model", "signIn", "data"]) {
      await served.call("POST", "check", { session, body: { step, quick: true } });
      await served.call("POST", "check", { session, body: { step } });
    }
    await served.call("POST", "check", { session, body: {} });
    const before = await whatLeaves(run);

    const created = await served.call("POST", "create", { session, body: {} });
    expect(created.status).toBe(200);
    expect(created.body.checks).toBeUndefined();
    await place.dnsAsked();
    const during = await whatLeaves(run);
    await served.call("GET", "progress", { session });
    await served.call("GET", "state", { session });
    place.releaseDns();
    await until(() => run.done() !== null, "the install to be made");
    await served.call("GET", "progress", { session });
    await served.call("GET", "state", { session });
    await served.call("POST", "seen", { session });
    const after = await whatLeaves(run);

    for (const text of [before, during, after, ...served.replies]) {
      for (const key of TYPED) expect(text).not.toContain(key);
      expect(text).not.toContain("Lm3v");
      expect(text).not.toContain("Yp7d");
    }
    // The keys went to the place, once, and nowhere else.
    expect(place.makes).toBe(1);
    expect(JSON.stringify(place.handOver.keys)).toContain(MODEL_KEY);
    // Handed over, nothing of them stays in this process.
    expect(run.typedPaths()).toEqual([]);
  });
});

// ── The last step ────────────────────────────────────────────────────────────

describe("the last step of the install", () => {
  test("the answers and the typed keys are copied before anything is awaited", async () => {
    const place = new StandInPlace("azure");
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asked = 0;
    const slow = (async () => {
      asked += 1;
      await held;
      return new Response('{"data":[]}', { status: 200 });
    }) as unknown as typeof fetch;
    const run = await open([place], { check: { fetch: slow } });
    answerNorthstar(run, MODEL_KEY);
    const started = run.create("browser", null);
    await until(() => asked > 0, "the model's check to begin");
    expect(run.busy).toBe(false);
    // Changed while the checks run, through the run itself.
    run.set("organization.name", "Changed while the checks ran");
    run.setTyped("model.key", OTHER_KEY);
    release();
    const start = await started;
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    await start.ended;
    expect(place.handOver.answers.organization.name).toBe("Northstar");
    expect(place.handOver.keys).toEqual([{ name: "model-key", value: MODEL_KEY }]);
    expect(JSON.stringify(place.handOver)).not.toContain(OTHER_KEY);
  });

  test("one at a time: two calls make once", async () => {
    const place = new StandInPlace("azure");
    const run = await open([place]);
    answerNorthstar(run, MODEL_KEY);
    const [a, b] = await Promise.all([run.create("browser", null), run.create("browser", null)]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    if (!a.ok || !b.ok) return;
    await Promise.all([a.ended, b.ended]);
    expect(place.makes).toBe(1);
    // And once it is made, a third starts nothing.
    const c = await run.create("browser", null);
    expect(c).toMatchObject({ ok: true, checks: [] });
    expect(place.makes).toBe(1);
  });

  test("after a failure a person can say yes again, and the place is asked to make again", async () => {
    const place = new StandInPlace("azure");
    place.failNext = { at: "database", kind: "make", text: "The database could not be made in East US 2: the quota is used up" };
    const run = await open([place]);
    answerNorthstar(run, MODEL_KEY);
    const first = await run.create("browser", null);
    if (!first.ok) throw new Error("refused");
    await first.ended;
    expect(run.progress()).toMatchObject({
      stage: "failed",
      made: ["container", "disk", "keys"],
      failure: { row: "database", text: "The database could not be made in East US 2: the quota is used up" },
    });
    expect(run.done()).toBeNull();
    // The typed key is still here for the second yes.
    expect(run.typedPaths()).toEqual(["model.key"]);
    const second = await run.create("browser", null);
    if (!second.ok) throw new Error("refused");
    await second.ended;
    expect(run.progress().stage).toBe("done");
    expect(place.makes).toBe(2);
    expect(place.handOvers[1]?.keys).toEqual([{ name: "model-key", value: MODEL_KEY }]);
  });

  test("a MakeError's words are shown, and no other error's words are", async () => {
    const plain = new StandInPlace("azure");
    plain.failNext = { at: "keys", kind: "plain", text: `the cloud said 403 for ${MODEL_KEY} at 10.1.2.3` };
    const run = await open([plain]);
    answerNorthstar(run, MODEL_KEY);
    const start = await run.create("browser", null);
    if (!start.ok) throw new Error("refused");
    await start.ended;
    expect(run.progress().failure).toEqual({
      row: "keys",
      text: "It could not be made",
    });
    expect(JSON.stringify(run.progress())).not.toContain("10.1.2.3");
  });

  test("a row the plan does not hold is ignored, in what is made and in where it stopped", async () => {
    const place = new StandInPlace("azure");
    place.strayRow = "a-row-of-its-own";
    place.failNext = { at: "dns", kind: "make", names: "another-row-of-its-own", text: "The record could not be made" };
    const run = await open([place]);
    answerNorthstar(run, MODEL_KEY);
    const start = await run.create("browser", null);
    if (!start.ok) throw new Error("refused");
    await start.ended;
    const progress = run.progress();
    expect(progress.made).toEqual(["container", "disk", "keys", "database"]);
    expect(progress.failure).toEqual({ row: "dns", text: "The record could not be made" });
    expect(JSON.stringify(progress)).not.toContain("of-its-own");
  });

  test("while it waits for the DNS record the record is shown, and a stop ends it as failed", async () => {
    const place = new StandInPlace("azure");
    place.holdDns = true;
    const run = await open([place]);
    answerNorthstar(run, MODEL_KEY);
    const start = await run.create("browser", null);
    if (!start.ok) throw new Error("refused");
    await place.dnsAsked();
    expect(run.busy).toBe(true);
    expect(run.progress()).toMatchObject({
      stage: "making",
      now: "dns",
      dns: { name: "hx.northstar.example", target: DNS_TARGET },
    });
    run.stop();
    await start.ended;
    expect(run.progress()).toMatchObject({
      stage: "failed",
      dns: null,
      failure: { row: "dns", text: "The install was stopped while it waited for the DNS record" },
    });
  });

  test("when it is made, the first administrator's link is built on the made address, and only its digest is handed over", async () => {
    const place = new StandInPlace("azure");
    place.address = "https://hx-fortress.northstar-made.example";
    place.notes = ["The DNS record for hx.northstar.example points at hx-fortress.northstar-made.example"];
    const run = await open([place]);
    answerNorthstar(run, MODEL_KEY);
    const start = await run.create("browser", null);
    if (!start.ok) throw new Error("refused");
    await start.ended;
    const done = run.done();
    expect(done?.address).toBe("https://hx-fortress.northstar-made.example");
    expect(done?.notes).toEqual(place.notes);
    expect(done?.firstAccount?.login).toBe("marta.lindqvist");
    expect(done?.firstAccount?.link).toStartWith("https://hx-fortress.northstar-made.example/setup#t=");
    const token = tokenOf(done?.firstAccount?.link ?? "");
    expect(token.length).toBeGreaterThan(30);
    // The environment carries the digest of the token, and the token is in nothing handed over.
    expect(place.handOver.environment[FIRST_ACCOUNT_DIGEST_ENV]).toBe(sha256(token));
    expect(place.handOver.environment.FORTRESS_UI_BOOTSTRAP_USER).toBe("marta.lindqvist");
    expect(JSON.stringify(place.handOver)).not.toContain(token);
    expect(run.progress()).toEqual({
      stage: "done",
      made: place.handOver.rows.map((row) => row.id),
      now: null,
      dns: null,
      failure: null,
    });
  });

  test("with no screen to show the link on, no token is made, and a note says where the link is", async () => {
    const place = new StandInPlace("azure");
    const run = await open([place]);
    answerNorthstar(run, MODEL_KEY);
    const start = await run.create("file", null, { showAccountLink: false });
    if (!start.ok) throw new Error("refused");
    await start.ended;
    const done = run.done();
    expect(done?.firstAccount).toBeNull();
    expect(done?.notes).toEqual([
      "The link that sets the password of marta.lindqvist is in a file on HX Fortress's own disk, which only its user can read. It is not shown here.",
    ]);
    expect(place.handOver.environment[FIRST_ACCOUNT_DIGEST_ENV]).toBeUndefined();
    // HX Fortress still makes the account at its first start.
    expect(place.handOver.environment.FORTRESS_UI_BOOTSTRAP_USER).toBe("marta.lindqvist");
  });

  test("a refused answer makes nothing, and says which step refused it", async () => {
    const place = new StandInPlace("azure");
    const run = await open([place]);
    answerNorthstar(run, null);
    run.set("address.hostname", "");
    const start = await run.create("browser", null);
    expect(start.ok).toBe(false);
    if (start.ok) return;
    expect(start.checks.filter((check) => !check.ok).map((check) => check.step)).toEqual(["address"]);
    expect(place.makes).toBe(0);
    expect(run.progress().stage).toBe("asking");
  });

  test("a place this computer has signed out of in the meantime is refused at the first page", async () => {
    const place = new StandInPlace("azure");
    const run = await open([place]);
    answerNorthstar(run, null);
    place.who = null;
    const start = await run.create("browser", null);
    expect(start.ok).toBe(false);
    if (start.ok) return;
    expect(start.checks.find((check) => check.step === "where")?.lines[0]?.needs).toBe("signIn");
    expect(place.makes).toBe(0);
  });
});

// ── What is handed over ──────────────────────────────────────────────────────

describe("what the install hands to the place", () => {
  function answers(change: (a: SetupAnswers) => void = () => {}): SetupAnswers {
    const a = installAnswers("azure", MODULES, { on: ["host", "databases"] });
    a.organization = { name: "Northstar", firstAdministrator: "marta.lindqvist" };
    a.keys.vault = "northstar-hx-fortress";
    a.address.hostname = "hx.northstar.example";
    a.model.key = "model-key";
    change(a);
    return a;
  }

  /** The time a test's link stops working: an ISO 8601 time, as the install writes it. */
  const LINK_ENDS = "2026-11-16T09:00:00.000Z";

  function handOver(a: SetupAnswers, typed: Record<string, string> = {}, installId: string | null = null, accountDigest: string | null = null): HandOver {
    return handOverOf({
      answers: a,
      typed: new Map(Object.entries(typed)),
      installId,
      account: accountDigest ? { digest: accountDigest, expires: LINK_ENDS } : null,
      rows: installPlan(a, { needsFiles: false }).rows,
    });
  }

  const connected = (a: SetupAnswers): void => {
    a.controlPlane = { connect: "yes", address: "control.example", token: "", connected: "on", pages: PAGES };
  };

  test("the environment holds no typed key and no install id; the id is only the secret FORTRESS_ENROLL_TOKEN", async () => {
    const given = handOver(answers(connected), { "model.key": MODEL_KEY }, INSTALL_ID);
    const environment = JSON.stringify(given.environment);
    expect(environment).not.toContain(MODEL_KEY);
    expect(environment).not.toContain(INSTALL_ID);
    expect(given.secretEnvironment).toEqual({ FORTRESS_ENROLL_TOKEN: INSTALL_ID });
    expect(given.environment.FORTRESS_CLOUD_URL).toBe(CONTROL);
    expect(given.environment.FORTRESS_CONTROL_PLANE_PAGES).toBe(PAGES);
    expect(JSON.stringify(given.keys)).not.toContain(INSTALL_ID);
    // With no id, no connection is handed over, and the pages still are.
    const none = handOver(answers(connected), {}, null);
    expect(none.environment.FORTRESS_CLOUD_URL).toBeUndefined();
    expect(none.secretEnvironment).toEqual({});
  });

  test("with the container's own settings as the key store a typed key is a secret setting; with any other store it is a key to write", async () => {
    const env = handOver(answers((a) => {
      a.keys.store = "env";
    }), { "model.key": MODEL_KEY, "signIn.clientSecret": CLIENT_SECRET });
    expect(env.keys).toEqual([]);
    expect(env.secretEnvironment).toEqual({ FORTRESS_SECRET_MODEL_KEY: MODEL_KEY });
    // A typed key whose answer holds no name is not handed over at all.
    expect(JSON.stringify(env)).not.toContain(CLIENT_SECRET);

    for (const store of ["azure-key-vault", "file"]) {
      const other = handOver(answers((a) => {
        a.keys.store = store;
        a.keys.folder = "/run/secrets";
      }), { "model.key": MODEL_KEY });
      expect([store, other.keys]).toEqual([store, [{ name: "model-key", value: MODEL_KEY }]]);
      expect([store, other.secretEnvironment]).toEqual([store, {}]);
    }
  });

  test("the settings of the first start are a file the machine itself accepts, with the seeded questions only and no key's value", async () => {
    const a = answers((x) => {
      connected(x);
      x.signIn = {
        ...x.signIn,
        provider: "openid-connect",
        issuer: "https://login.northstar.example",
        clientId: "hx-fortress",
        clientSecret: "sign-in-client-secret",
        administratorGroups: ["hx-fortress-admins"],
      };
    });
    const given = handOver(a, { "model.key": MODEL_KEY, "signIn.clientSecret": CLIENT_SECRET }, INSTALL_ID);
    const text = given.environment[SETUP_SETTINGS_ENV] ?? "";
    for (const secret of [MODEL_KEY, CLIENT_SECRET, INSTALL_ID]) expect(text).not.toContain(secret);
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual([...SEEDED].sort());
    const parsed = parseSettingsFile(text, defaultAnswers(MODULES), { moduleIds: MODULES });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.given.map(String).sort()).toEqual(SEEDED.filter((id) => id !== "version").sort());
    expect(parsed.answers.organization.name).toBe("Northstar");
    expect(parsed.answers.signIn.clientSecret).toBe("sign-in-client-secret");
    expect(parsed.answers.model).toMatchObject({ provider: "anthropic", key: "model-key" });
    // A model of None is written as none.
    const none = handOver(answers((x) => {
      x.model.provider = "none";
    }));
    expect((JSON.parse(none.environment[SETUP_SETTINGS_ENV] ?? "{}") as { model: unknown }).model).toBe(false);
  });

  test("FORTRESS_INSTALL holds the place's facts, and the session content is off", async () => {
    const azure = handOver(answers());
    expect(JSON.parse(azure.environment.FORTRESS_INSTALL ?? "{}")).toEqual({
      place: "azure",
      region: "eastus2",
      certificate: "cloud-issued",
      database: "managed",
    });
    expect(azure.environment.FORTRESS_CONNECTION_SESSION_CONTENT).toBe("off");
    expect(azure.environment.FORTRESS_SECRETS_PROVIDER).toBe("azure-key-vault");
    expect(azure.environment.FORTRESS_SECRETS_AZURE_VAULT_URL).toBe("https://northstar-hx-fortress.vault.azure.net");
    expect(azure.environment.FORTRESS_UI_PUBLIC_URL).toBe("https://hx.northstar.example");
    expect(azure.environment.FORTRESS_UI_ENABLE).toBe("1");

    const docker = handOver(answers((a) => {
      a.where = { place: "docker", region: "", ssh: "marta@hx-fortress-vm.northstar.example" };
      a.keys.store = "env";
      a.address = { hostname: "hx.northstar.example", certificate: "own", certificateName: "hx-fortress-cert" };
      a.data.database.store = "beside";
    }));
    expect(JSON.parse(docker.environment.FORTRESS_INSTALL ?? "{}")).toEqual({
      place: "docker",
      ssh: "marta@hx-fortress-vm.northstar.example",
      certificate: "own",
      certificateName: "hx-fortress-cert",
      database: "beside",
    });
  });

  test("the database's key is named exactly when the place makes the database", async () => {
    for (const [store, made] of [
      ["managed", true],
      ["beside", true],
      ["existing", false],
    ] as const) {
      const given = handOver(answers((a) => {
        a.data.database = { store, address: store === "existing" ? "db-url" : "" };
      }));
      expect([store, given.databaseKey]).toEqual([store, made ? DATABASE_KEY_NAME : null]);
      expect([store, given.environment.FORTRESS_DATABASE_URL_SECRET]).toEqual([store, made ? DATABASE_KEY_NAME : "db-url"]);
    }
  });

  test("the first administrator is handed over for accounts on this HX Fortress, with the link's digest and its end time only when there is a link", async () => {
    const digest = sha256("a token for a test");
    expect(handOver(answers(), {}, null, digest).environment).toMatchObject({
      FORTRESS_UI_BOOTSTRAP_USER: "marta.lindqvist",
      [FIRST_ACCOUNT_DIGEST_ENV]: digest,
      [FIRST_ACCOUNT_EXPIRES_ENV]: LINK_ENDS,
    });
    const without = handOver(answers()).environment;
    expect(without.FORTRESS_UI_BOOTSTRAP_USER).toBe("marta.lindqvist");
    expect(without[FIRST_ACCOUNT_DIGEST_ENV]).toBeUndefined();
    expect(without[FIRST_ACCOUNT_EXPIRES_ENV]).toBeUndefined();
    const provider = handOver(answers((a) => {
      a.signIn.provider = "openid-connect";
    }), {}, null, digest).environment;
    expect(provider.FORTRESS_UI_BOOTSTRAP_USER).toBeUndefined();
    expect(provider[FIRST_ACCOUNT_DIGEST_ENV]).toBeUndefined();
    expect(provider[FIRST_ACCOUNT_EXPIRES_ENV]).toBeUndefined();
  });

  test("the run hands over what it checked, with the plan the person said yes to", async () => {
    const place = new StandInPlace("aws");
    const run = await open([place], { connect: { address: "control.example", id: INSTALL_ID, pages: PAGES } });
    answerNorthstar(run, MODEL_KEY);
    const plan = run.derived().plan;
    const start = await run.create("browser", null);
    if (!start.ok) throw new Error(JSON.stringify(start.checks.filter((check) => !check.ok)));
    await start.ended;
    expect(place.handOver.rows).toEqual(plan.rows);
    expect(place.handOver.rows.map((row) => row.id)).toContain("controlPlane");
    expect(place.handOver.secretEnvironment).toEqual({ FORTRESS_SECRET_MODEL_KEY: MODEL_KEY, FORTRESS_ENROLL_TOKEN: INSTALL_ID });
    expect(place.handOver.environment.FORTRESS_CLOUD_URL).toBe(CONTROL);
    expect(JSON.stringify(place.handOver.environment)).not.toContain(MODEL_KEY);
    expect(providers().calls).toEqual([]);
  });
});
