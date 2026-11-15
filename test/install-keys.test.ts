// The keys a person types into the install: which of them are handed over,
// under which names, and what never reaches a check or a place.

import { afterEach, describe, expect, test } from "bun:test";

import { handOverOf, typedInEffect } from "../src/install/handover";
import { keyFields, fieldsInEffect } from "../src/setup/list";
import { installPlan } from "../src/setup/plan";
import type { SetupRunDeps } from "../src/setup/run";
import { isKeyName } from "../src/setup/answers";
import { secretEnvName } from "../src/secrets/env";
import { answerNorthstar, installRun, providers, StandInPlace, untouchedRoot } from "./install-rig";

// Built at run time so no secret-shaped literal sits in the repository.
const MODEL_KEY = ["sk", "ant", "typed", "Qn7vNotAReal0ne"].join("-");
const ENGINEERS_KEY = ["sk", "the", "engineers", "own", "Zx3mNotAReal0ne"].join("-");
const DATABASE = "postgres://hx@db.northstar.example/hx";
const CLIENT_SECRET = ["oidc", "client", "Lw9pNotAReal0ne"].join("-");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function install(place: StandInPlace, over: Partial<Omit<SetupRunDeps, "paths">> = {}) {
  const made = await untouchedRoot();
  cleanups.push(made.cleanup);
  return installRun([place], { paths: made.paths, ...over });
}

async function handedOver(run: Awaited<ReturnType<typeof install>>, place: StandInPlace) {
  const started = await run.create("browser", null, { showAccountLink: false });
  if (!started.ok) throw new Error(JSON.stringify(started.checks.filter((check) => !check.ok)));
  await started.ended;
  return place.handOver;
}

/** Everything of a hand-over that could hold a key, as one text. */
const everything = (handOver: Awaited<ReturnType<typeof handedOver>>): string =>
  JSON.stringify([handOver.environment, handOver.secretEnvironment, handOver.keys]);

describe("the name a typed key gets", () => {
  test("every field that takes a typed key gives it a name of its own, which is a key's name and a variable's", () => {
    const names = [...keyFields().values()].map((field) => field.typedAs).filter((name): name is string => Boolean(name));
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect([name, isKeyName(name)]).toEqual([name, true]);
      expect(secretEnvName(name)).toMatch(/^FORTRESS_SECRET_[A-Z0-9_]+$/);
    }
  });

  test("an answer that names another key forgets the typed one, and a name that is none is refused", async () => {
    const place = new StandInPlace("azure");
    const run = await install(place);
    answerNorthstar(run, MODEL_KEY);
    expect(run.typedPaths()).toEqual(["model.key"]);
    expect(run.answers.model.key).toBe("model-key");

    // A request gives the field another name. The typed key does not follow it.
    expect(run.set("model.key", "../../Not A Name")).toBe(true);
    expect(run.typedPaths()).toEqual([]);
    const check = await run.check("model");
    expect(check.ok).toBe(false);
    expect(check.lines).toContainEqual({ ok: false, text: "Not a key's name", path: "model.key" });
  });

  test("the name of a key that was typed for another field cannot be borrowed", async () => {
    const place = new StandInPlace("azure");
    const run = await install(place);
    answerNorthstar(run, MODEL_KEY);
    run.set("data.database.store", "existing");
    expect(run.setTyped("data.database.address", DATABASE)).toBe(true);
    // The model's answer names the database's key: the model would be given the database's address.
    run.set("model.key", "database-address");
    expect(run.typedPaths()).toEqual(["data.database.address"]);
    const check = await run.check("model");
    expect(check.lines).toContainEqual({
      ok: false,
      text: "This is the name of another key that was typed here",
      path: "model.key",
    });
    const started = await run.create("browser", null, { showAccountLink: false });
    expect(started.ok).toBe(false);
    expect(place.makes).toBe(0);
  });

  test("an emptied key is forgotten, and its answer names nothing", async () => {
    const run = await install(new StandInPlace("azure"));
    answerNorthstar(run, MODEL_KEY);
    expect(run.setTyped("model.key", "   ")).toBe(true);
    expect(run.typedPaths()).toEqual([]);
    expect(run.answers.model.key).toBe("");
  });
});

describe("which typed keys are handed over", () => {
  test("a key is handed over without the spaces around it: what is checked is what is handed over", async () => {
    const place = new StandInPlace("azure");
    const run = await install(place);
    answerNorthstar(run, `  ${MODEL_KEY}\n`);
    const handOver = await handedOver(run, place);
    expect(handOver.keys).toEqual([{ name: "model-key", value: MODEL_KEY }]);
  });

  test("a database address typed for an option that was given up stays behind, in a vault and in the container's settings", async () => {
    for (const id of ["azure", "docker"] as const) {
      const place = new StandInPlace(id);
      const run = await install(place);
      answerNorthstar(run, MODEL_KEY);
      if (id === "docker") {
        run.set("where.ssh", "marta@hx-fortress-vm.northstar.example");
        // A proxy in front holds the certificate, so none is named here.
        run.set("address.certificate", "none");
      }
      const first = run.answers.data.database.store;
      run.set("data.database.store", "existing");
      expect(run.setTyped("data.database.address", DATABASE)).toBe(true);
      // The person goes back to the database the place makes.
      run.set("data.database.store", first);
      const handOver = await handedOver(run, place);
      expect([id, everything(handOver).includes(DATABASE)]).toEqual([id, false]);
      // The place writes the database it makes under that name, and nothing else is there.
      expect([id, handOver.databaseKey]).toEqual([id, "database-address"]);
      expect([id, everything(handOver).includes(MODEL_KEY)]).toEqual([id, true]);
    }
  });

  test("a model key stays behind when no model is chosen, and a client secret when people do not sign in through a provider", async () => {
    const place = new StandInPlace("azure");
    const run = await install(place);
    answerNorthstar(run, MODEL_KEY);
    run.set("signIn.provider", "openid-connect");
    expect(run.setTyped("signIn.clientSecret", CLIENT_SECRET)).toBe(true);
    run.set("signIn.provider", "local");
    const handOver = await handedOver(run, place);
    expect(everything(handOver)).not.toContain(CLIENT_SECRET);
    expect(handOver.keys.map((key) => key.name)).toEqual(["model-key"]);

    // The hand-over itself holds to it, whatever it is given.
    const answers = structuredClone(run.answers);
    answers.model.provider = "none";
    const typed = new Map([["model.key", MODEL_KEY]]);
    expect(typedInEffect(answers, typed)).toEqual([]);
    const direct = handOverOf({ answers, typed, installId: null, account: null, rows: installPlan(answers, { needsFiles: false }).rows });
    expect(JSON.stringify(direct)).not.toContain(MODEL_KEY);
  });

  test("another provider starts with no key: a key is never offered to a provider it was not typed for", async () => {
    const world = providers();
    const place = new StandInPlace("azure");
    const run = await install(place, { check: { fetch: world.fetch } });
    answerNorthstar(run, MODEL_KEY);
    expect(run.answers.model.provider).toBe("anthropic");
    run.set("model.provider", "openai");
    expect(run.typedPaths()).toEqual([]);
    expect(run.answers.model).toMatchObject({ provider: "openai", key: "", name: "", address: "" });
    const check = await run.check("model");
    expect(check.ok).toBe(false);
    // Nothing was asked of the new provider with the old key.
    expect(JSON.stringify(world.calls)).not.toContain(MODEL_KEY);
  });

  test("the fields that count are those of the option that is chosen", () => {
    const answers: Record<string, string> = { "data.database.store": "existing", "signIn.provider": "local", "model.provider": "anthropic" };
    const read = (at: string): string => answers[at] ?? "";
    const paths = (place: "azure" | "docker"): string[] =>
      fieldsInEffect({ way: "install", place }, read).map((field) => field.path);
    expect(paths("azure")).toContain("data.database.address");
    expect(paths("azure")).toContain("model.key");
    expect(paths("azure")).not.toContain("signIn.clientSecret");
    answers["data.database.store"] = "managed";
    expect(paths("azure")).not.toContain("data.database.address");
    answers["model.provider"] = "none";
    expect(paths("azure")).not.toContain("model.key");
  });
});

describe("the engineer's own shell", () => {
  test("a model key and a model address in the engineer's variables are no part of the install's check", async () => {
    const world = providers();
    const place = new StandInPlace("azure");
    const run = await install(place, {
      env: {
        PATH: "/usr/bin",
        FORTRESS_OPENAI_API_KEY: ENGINEERS_KEY,
        FORTRESS_OPENAI_BASE_URL: "https://llm.the-engineers-own.example/v1",
        FORTRESS_SESSIONS: "on",
      },
      check: { fetch: world.fetch },
    });
    answerNorthstar(run, null);
    run.set("model.provider", "openai");
    run.set("modules.session_vault", true);
    expect(run.setTyped("model.key", MODEL_KEY)).toBe(true);
    const check = await run.check("model");
    expect(check.lines.filter((line) => !line.ok)).toEqual([]);

    const sent = JSON.stringify(world.calls);
    expect(world.calls.length).toBeGreaterThan(0);
    expect(sent).not.toContain(ENGINEERS_KEY);
    expect(sent).not.toContain("the-engineers-own.example");
    // The typed key went to the provider the answers name, in a header.
    expect(world.calls.every((call) => new URL(call.url).host === "api.openai.com")).toBe(true);
    expect(world.calls.every((call) => !call.url.includes(MODEL_KEY))).toBe(true);
    expect(sent).toContain(MODEL_KEY);
    // A variable of the engineer's shell pins no answer of the install.
    expect(run.present.pinned).toEqual({});
  });
});

describe("the first administrator's link, over two attempts", () => {
  test("a second attempt after a failure hands over the digest the first one did", async () => {
    const place = new StandInPlace("azure");
    const run = await install(place);
    answerNorthstar(run, MODEL_KEY);
    place.failNext = { at: "open", kind: "make", text: "The address did not answer yet" };
    const first = await run.create("browser", null, { showAccountLink: true });
    if (!first.ok) throw new Error("refused");
    await first.ended;
    expect(run.progress().stage).toBe("failed");
    const second = await run.create("browser", null, { showAccountLink: true });
    if (!second.ok) throw new Error("refused");
    await second.ended;
    expect(place.makes).toBe(2);
    const digests = place.handOvers.map((handOver) => handOver.environment.FORTRESS_UI_BOOTSTRAP_TOKEN_DIGEST);
    expect(digests[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(digests[1]).toBe(digests[0] as string);
    expect(place.handOvers[1]?.environment.FORTRESS_UI_BOOTSTRAP_TOKEN_EXPIRES).toBe(
      place.handOvers[0]?.environment.FORTRESS_UI_BOOTSTRAP_TOKEN_EXPIRES as string,
    );
    // The link on the last screen is the one whose digest was handed over, both times.
    expect(run.done()?.firstAccount?.link).toContain("/setup#t=");
  });
});
