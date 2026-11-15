// What the install checks, on an engineer's computer, before anything exists:
// the first page (where HX Fortress runs, and whether this computer is signed
// in there), and a key a person typed, which is used once against the model
// provider and nowhere else. Nothing here is asked of a key store: the one
// the answers name does not exist yet.

import { afterEach, describe, expect, test } from "bun:test";

import { installAnswers, type SetupAnswers } from "../src/setup/answers";
import { checkAll, checkStep, type CheckDeps, type TypedKeys } from "../src/setup/checks";
import { placeInfo } from "../src/setup/list";
import { MODEL_HOSTS } from "../src/setup/reach";
import type { PlaceRow } from "../src/setup/view";
import type { SecretProvider } from "../src/secrets/types";
import { answerNorthstar, installRun, providers, StandInPlace, untouchedRoot } from "./install-rig";
import { MODULES } from "./setup-rig";

// Built at run time so no secret-shaped literal sits in the repository.
const TYPED = ["sk", "ant", "typed", "Kq9vZ2wNotAReal0ne"].join("-");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function paths(): Promise<CheckDeps["paths"]> {
  const made = await untouchedRoot();
  cleanups.push(made.cleanup);
  return made.paths;
}

function typedKeys(keys: Record<string, string>): TypedKeys {
  return {
    has: (at) => Object.hasOwn(keys, at),
    // eslint-disable-next-line security/detect-object-injection
    get: (at) => (Object.hasOwn(keys, at) ? keys[at] : undefined),
  };
}

/** A key store that counts every time it is built or asked. */
function countedStore(): { build: () => SecretProvider; count: { built: number; asked: number } } {
  const count = { built: 0, asked: 0 };
  return {
    count,
    build: () => {
      count.built += 1;
      return {
        kind: "env",
        has: async () => {
          count.asked += 1;
          return true;
        },
        get: async () => {
          count.asked += 1;
          return TYPED;
        },
      };
    },
  };
}

function row(over: Partial<PlaceRow> = {}): PlaceRow {
  return {
    id: "azure",
    offered: true,
    signedInAs: "marta.lindqvist, in Northstar Production",
    needsSignIn: true,
    signInCommand: "az login",
    ...over,
  };
}

async function deps(over: Partial<CheckDeps> = {}): Promise<CheckDeps> {
  return {
    paths: await paths(),
    env: {},
    present: {
      answers: installAnswers("azure", MODULES),
      pinned: {},
      kept: { modelKey: false, databaseAddress: false, filesKeys: false },
      setUp: false,
      disconnectedFrom: null,
      consoleOn: false,
    },
    way: "install",
    place: (id) => row({ id }),
    typed: typedKeys({}),
    fetch: providers().fetch,
    timeoutMs: 2_000,
    ...over,
  };
}

function northstar(change: (a: SetupAnswers) => void = () => {}): SetupAnswers {
  const a = installAnswers("azure", MODULES, { on: ["host", "databases"] });
  a.organization = { name: "Northstar", firstAdministrator: "marta.lindqvist" };
  a.keys.vault = "northstar-hx-fortress";
  a.address.hostname = "hx.northstar.example";
  change(a);
  return a;
}

/** The answers as the run leaves them once the model's key was typed: the
 *  field holds the name the key gets. */
function keyTyped(): SetupAnswers {
  return northstar((a) => {
    a.model.key = "model-key";
  });
}

// ── The first page ───────────────────────────────────────────────────────────

describe("the first page", () => {
  test("a place this build cannot make HX Fortress in is refused", async () => {
    for (const [place, said] of [
      ["azure", "This build cannot make HX Fortress in Azure yet"],
      ["google-cloud", "This build cannot make HX Fortress in Google Cloud yet"],
      ["docker", "This build cannot make HX Fortress on a machine with Docker yet"],
    ] as const) {
      const answers = northstar((a) => {
        a.where = { place, region: placeInfo(place).regions[0]?.id ?? "", ssh: "marta@hx-fortress-vm.northstar.example" };
      });
      for (const unknown of [null, row({ id: place, offered: false })]) {
        const check = await checkStep("where", answers, await deps({ place: () => unknown }));
        expect([place, check.lines]).toEqual([place, [{ ok: false, text: said, path: "where.place" }]]);
      }
    }
  });

  test("a place this computer is not signed in to says which command signs it in, and a screen offers to check again", async () => {
    const check = await checkStep("where", northstar(), await deps({ place: () => row({ signedInAs: "" }) }));
    expect(check.ok).toBe(false);
    expect(check.lines).toEqual([
      {
        ok: false,
        text: "This computer is not signed in to Azure. Run az login, then check again",
        path: "where.place",
        needs: "signIn",
      },
    ]);
    // Signed in, the page passes with nothing to say: the place's own row says who.
    const signedIn = await checkStep("where", northstar(), await deps());
    expect(signedIn).toEqual({ step: "where", ok: true, lines: [] });
  });

  test("a machine reached over SSH needs no sign-in, and its address is held to user@host", async () => {
    const docker = (ssh: string): SetupAnswers =>
      northstar((a) => {
        a.where = { place: "docker", region: "", ssh };
      });
    const plain = await deps({ place: (id) => row({ id, signedInAs: "", needsSignIn: false, signInCommand: "" }) });
    for (const ssh of ["marta@hx-fortress-vm.northstar.example", "deploy@10.0.0.5:2222"]) {
      expect([ssh, await checkStep("where", docker(ssh), plain)]).toEqual([ssh, { step: "where", ok: true, lines: [] }]);
    }
    for (const ssh of [
      "-oProxyCommand=x@host",
      "marta@hx-fortress-vm .northstar.example",
      "marta@hx-fortress-vm.northstar.example'",
      'marta"@hx-fortress-vm.northstar.example',
      "marta@hx-fortress-vm.northstar.example;id",
      "marta@`hostname`.northstar.example",
      "marta@$HOST",
      "marta@ops@hx-fortress-vm.northstar.example",
      "hx-fortress-vm.northstar.example",
      "@hx-fortress-vm.northstar.example",
      "",
    ]) {
      const check = await checkStep("where", docker(ssh), plain);
      expect([ssh, check.lines]).toEqual([ssh, [{ ok: false, text: "Write it as user@host", path: "where.ssh" }]]);
    }
  });

  test("a cloud needs one of its own regions", async () => {
    const check = await checkStep("where", northstar((a) => {
      a.where.region = "us-east-1";
    }), await deps());
    expect(check.lines).toEqual([{ ok: false, text: "Choose a region", path: "where.region" }]);
  });

  test("while a person still types, the place is asked nothing, nor what it refuses", async () => {
    let asked = 0;
    let refusals = 0;
    const given = await deps({
      when: "typing",
      place: () => {
        asked += 1;
        return row({ signedInAs: "" });
      },
      placeRefusals: () => {
        refusals += 1;
        return [{ ok: false, text: "The vault's name is taken", path: "keys.vault" }];
      },
    });
    for (const step of ["where", "keys", "address"] as const) await checkStep(step, northstar(), given);
    // The shape of the answer is still said.
    const shape = await checkStep("where", northstar((a) => {
      a.where.region = "nowhere";
    }), given);
    expect(shape.lines).toEqual([{ ok: false, text: "Choose a region", path: "where.region" }]);
    expect([asked, refusals]).toEqual([0, 0]);
  });

  test("what the place refuses is said at the step it belongs to", async () => {
    const given = await deps({
      placeRefusals: () => [
        { ok: false, text: "A vault with this name exists in another subscription", path: "keys.vault" },
        { ok: false, text: "This name is taken in Azure", path: "address.hostname" },
      ],
    });
    expect((await checkStep("keys", northstar(), given)).lines).toEqual([
      { ok: false, text: "A vault with this name exists in another subscription", path: "keys.vault" },
    ]);
    expect((await checkStep("address", northstar(), given)).lines).toEqual([
      { ok: false, text: "This name is taken in Azure", path: "address.hostname" },
    ]);
    expect((await checkStep("organization", northstar(), given)).ok).toBe(true);
    // A place whose look fails is a check that could not be made, and says nothing more.
    const broken = await deps({
      placeRefusals: () => {
        throw new Error(`the cloud said: ${TYPED}`);
      },
    });
    const check = await checkStep("keys", northstar(), broken);
    expect(check.lines).toEqual([{ ok: false, text: "The check could not be made" }]);
  });

  test("the run asks the stand-in place, opens on the place this computer is signed in to, and checks the first page again when asked", async () => {
    const root = await paths();
    const azure = new StandInPlace("azure", { signedIn: null });
    const aws = new StandInPlace("aws", { signedIn: { as: "marta.lindqvist, in account 1234", organization: "Northstar", person: "Marta.Lindqvist" } });
    const run = await installRun([azure, aws], { paths: root });
    // The first place this computer is signed in to, and what it knows of the person.
    expect(run.answers.where.place).toBe("aws");
    expect(run.answers.organization).toEqual({ name: "Northstar", firstAdministrator: "marta.lindqvist" });
    expect(run.derived().places.map((p) => [p.id, p.offered, p.signedInAs])).toEqual([
      ["azure", true, ""],
      ["aws", true, "marta.lindqvist, in account 1234"],
      ["google-cloud", false, ""],
      ["docker", false, ""],
    ]);
    // A person signs in at the other place, and checks the page again.
    run.set("where.place", "azure");
    expect((await run.check("where")).lines[0]?.needs).toBe("signIn");
    azure.who = { as: "marta.lindqvist, in Northstar Production" };
    const quick = azure.asked.signedIn;
    await run.check("where", { quick: true });
    expect(azure.asked.signedIn).toBe(quick);
    expect((await run.check("where")).ok).toBe(true);
    expect(azure.asked.signedIn).toBe(quick + 1);
  });

  test("with no place this computer is signed in to, the install opens on the first place this build has", async () => {
    const root = await paths();
    const run = await installRun([new StandInPlace("docker"), new StandInPlace("google-cloud", { signedIn: null })], { paths: root });
    expect(run.answers.where.place).toBe("google-cloud");
    expect(run.answers.keys.store).toBe("env");
    expect(run.answers.data.database.store).toBe("managed");
  });
});

// ── A key a person typed ─────────────────────────────────────────────────────

describe("in the install", () => {
  test("no key store is ever built or asked, whatever the answers name", async () => {
    for (const store of ["env", "file", "azure-key-vault"]) {
      const counted = countedStore();
      const answers = northstar((a) => {
        a.keys.store = store;
        a.keys.folder = "/run/secrets";
        a.signIn = {
          ...a.signIn,
          provider: "openid-connect",
          issuer: "https://login.northstar.example",
          clientId: "hx-fortress",
          clientSecret: "sign-in-client-secret",
          administratorGroups: ["hx-fortress-admins"],
        };
        a.address = { ...a.address, certificate: "own", certificateName: "hx-fortress-cert" };
        a.data.database = { store: "existing", address: "db-url" };
        a.model.key = "model-key";
        a.controlPlane = { ...a.controlPlane, connect: "yes", address: "control.example", token: "install-id" };
      });
      await checkAll(answers, await deps({ keyStore: counted.build, typed: typedKeys({ "data.database.address": "postgres://hx@db/hx" }) }));
      expect([store, counted.count]).toEqual([store, { built: 0, asked: 0 }]);
    }
  });

  test("a typed key is sent only to the provider's own host, in a header and never in the address, and never followed", async () => {
    const header: Record<string, (value: string) => boolean> = {
      anthropic: (value) => value === TYPED,
      openai: (value) => value === `Bearer ${TYPED}`,
      google: (value) => value === TYPED,
    };
    const name: Record<string, string> = { anthropic: "x-api-key", openai: "authorization", google: "x-goog-api-key" };
    for (const provider of ["anthropic", "openai", "google"]) {
      const world = providers();
      const check = await checkStep(
        "model",
        northstar((a) => {
          a.model.provider = provider;
          a.model.key = "model-key";
        }),
        await deps({ fetch: world.fetch, typed: typedKeys({ "model.key": TYPED }) }),
      );
      expect([provider, check.ok]).toEqual([provider, true]);
      expect(world.calls).toHaveLength(1);
      const call = world.calls[0] as { url: string; init: RequestInit };
      // The lookup is by a provider the test itself wrote.
      // eslint-disable-next-line security/detect-object-injection
      expect([provider, new URL(call.url).host]).toEqual([provider, MODEL_HOSTS[provider]]);
      expect(call.url).not.toContain(TYPED);
      expect(call.url).not.toContain("Kq9v");
      // eslint-disable-next-line security/detect-object-injection
      expect(header[provider]?.(new Headers(call.init.headers).get(name[provider] ?? "") ?? "")).toBe(true);
      expect(call.init.redirect).toBe("error");
      expect(call.init.body).toBeUndefined();
      expect(JSON.stringify(check)).not.toContain(TYPED);
    }
  });

  test("a key that is only named is not read: it is read when HX Fortress starts", async () => {
    const world = providers();
    const counted = countedStore();
    const check = await checkStep(
      "model",
      northstar((a) => {
        a.model.key = "model-key";
      }),
      await deps({ fetch: world.fetch, keyStore: counted.build }),
    );
    expect(check).toEqual({
      step: "model",
      ok: true,
      lines: [{ ok: true, text: "HX Fortress reads the key by this name when it starts", path: "model.key" }],
    });
    expect(world.calls).toEqual([]);
    expect(counted.count).toEqual({ built: 0, asked: 0 });
    // Neither a name nor a key: the install asks for one.
    const none = await checkStep("model", northstar(), await deps());
    expect(none.lines).toEqual([{ ok: false, text: "Paste the key, or choose None", path: "model.key" }]);
  });

  test("when nothing answers from this computer, the line is soft and the step still passes", async () => {
    const closed = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const check = await checkStep("model", keyTyped(), await deps({ fetch: closed, typed: typedKeys({ "model.key": TYPED }) }));
    expect(check).toEqual({
      step: "model",
      ok: true,
      lines: [{ ok: false, soft: true, text: "api.anthropic.com did not answer from this computer, so the key was not checked" }],
    });
  });

  test("a key the provider refuses is refused beside the key, and nothing the provider answered is repeated", async () => {
    for (const status of [401, 403]) {
      const world = (async () =>
        new Response(`{"error":{"message":"invalid x-api-key ${TYPED} for org northstar-secret-org"}}`, { status })) as unknown as typeof fetch;
      const check = await checkStep("model", keyTyped(), await deps({ fetch: world, typed: typedKeys({ "model.key": TYPED }) }));
      expect([status, check.lines]).toEqual([status, [{ ok: false, text: "Anthropic refused the key", path: "model.key" }]]);
    }
    for (const [status, said] of [
      [500, "The model did not answer: 500"],
      [404, "The model did not answer: 404, so it does not know this model, or the address is not the right one"],
    ] as const) {
      const world = (async () =>
        new Response(`upstream northstar-secret-org failed with ${TYPED}`, { status })) as unknown as typeof fetch;
      const check = await checkStep("model", keyTyped(), await deps({ fetch: world, typed: typedKeys({ "model.key": TYPED }) }));
      expect(check.lines).toEqual([{ ok: false, text: said }]);
      expect(JSON.stringify(check)).not.toContain("northstar-secret-org");
      expect(JSON.stringify(check)).not.toContain(TYPED);
    }
  });

  test("a typed connection string is held to its shape, and the database is not opened from here", async () => {
    let opened = 0;
    const probeDatabase = async (): Promise<string> => {
      opened += 1;
      return "PostgreSQL 17.2";
    };
    const existing = northstar((a) => {
      a.data.database = { store: "existing", address: "database-address" };
    });
    const good = await checkStep("data", existing, await deps({ probeDatabase, typed: typedKeys({ "data.database.address": "postgres://hx@db.northstar.example/hx" }) }));
    expect(good).toEqual({ step: "data", ok: true, lines: [] });
    const wrong = await checkStep("data", existing, await deps({ probeDatabase, typed: typedKeys({ "data.database.address": "host=db user=hx" }) }));
    expect(wrong.lines).toEqual([{ ok: false, text: "It starts with postgres://", path: "data.database.address" }]);
    expect(JSON.stringify(wrong)).not.toContain("user=hx");
    expect(opened).toBe(0);
  });

  test("a vault the install makes is named, not addressed", async () => {
    for (const [vault, ok] of [
      ["northstar-hx-fortress", true],
      ["", false],
      ["NorthStar", false],
      ["https://northstar.vault.azure.net", false],
      ["a".repeat(25), false],
    ] as const) {
      const check = await checkStep("keys", northstar((a) => {
        a.keys.vault = vault;
      }), await deps());
      expect([vault, check.ok]).toEqual([vault, ok]);
      if (!ok) expect(check.lines).toEqual([{ ok: false, text: "3 to 24 lowercase letters, digits or dashes", path: "keys.vault" }]);
    }
  });

  test("the run's typed keys are what the checks see, and they come back only as paths", async () => {
    const root = await paths();
    const place = new StandInPlace("azure");
    const world = providers();
    const run = await installRun([place], { paths: root, check: { fetch: world.fetch } });
    answerNorthstar(run, TYPED);
    expect(run.typedPaths()).toEqual(["model.key"]);
    expect(run.answers.model.key).toBe("model-key");
    const checks = await run.checkAll();
    expect(checks.filter((check) => !check.ok)).toEqual([]);
    expect(world.calls.map((call) => new URL(call.url).host)).toEqual(["api.anthropic.com"]);
    expect(JSON.stringify(checks)).not.toContain(TYPED);
  });
});

// ── Waiting for the other branch ─────────────────────────────────────────────

describe("a login that is an email address", () => {
  describe("with an email address as the login", () => {
    test("the first administrator may be an email address", async () => {
      const check = await checkStep(
        "organization",
        northstar((a) => {
          a.organization.firstAdministrator = "marta.lindqvist@northstar.example";
        }),
        await deps(),
      );
      expect(check).toEqual({ step: "organization", ok: true, lines: [] });
    });

    test("what the place knows of the person fills in the first answers, and they pass", async () => {
      const root = await paths();
      const place = new StandInPlace("azure", {
        signedIn: { as: "marta.lindqvist@northstar.example", organization: "Northstar", person: "Marta.Lindqvist@Northstar.example" },
      });
      const run = await installRun([place], { paths: root });
      expect(run.answers.organization).toEqual({ name: "Northstar", firstAdministrator: "marta.lindqvist@northstar.example" });
      expect(run.answers.address.hostname).toBe("hx.northstar.example");
      expect(run.answers.keys.vault).toBe("northstar-hx-fortress");
      expect((await run.check("organization")).ok).toBe(true);
      expect((await run.check("address")).ok).toBe(true);
    });
  });
});
