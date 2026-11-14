import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { defaultAnswers, type SetupAnswers } from "../src/setup/answers";
import { checkAll, checkStep, refusalsOf, type CheckDeps, type CheckLine } from "../src/setup/checks";
import { readAnswers } from "../src/setup/read";
import { UsersStore } from "../src/ui/users";
import { fixedSecrets, tempRoot, type Paths } from "./host/_module-rig";
import { providerDocument } from "./setup-rig";

const MODULES = ["session_vault", "host"];
// Built at run time so no secret-shaped literal sits in the repository.
const DB_URL = ["postgres://fortress:", "pw-for-a-test", "@db.northstar.example:5432/fortress"].join("");
const MODEL_KEY = ["sk", "test", "model", "key"].join("-");

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function root(): Promise<Paths> {
  const made = await tempRoot();
  cleanup = made.cleanup;
  return made.paths;
}

/** A sign-in provider, a model and a few hosts, as one fetch. */
function outside(overrides: Record<string, (init?: RequestInit) => Response | Promise<Response>> = {}): {
  fetch: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const routes: Record<string, (init?: RequestInit) => Response | Promise<Response>> = {
    "https://login.northstar.example/.well-known/openid-configuration": () =>
      Response.json(providerDocument("https://login.northstar.example")),
    "https://models.northstar.example/v1/embeddings": () => Response.json({ data: [{ embedding: [0.1] }] }),
    ...overrides,
  };
  const fake = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, ...(init ? { init } : {}) });
    // The lookup is by an address the test itself wrote.
    // eslint-disable-next-line security/detect-object-injection
    const route = routes[url];
    if (!route) throw new TypeError("fetch failed");
    return route(init);
  };
  return { fetch: fake as typeof fetch, calls };
}

async function deps(paths: Paths, over: Partial<CheckDeps> = {}): Promise<CheckDeps> {
  const env = over.env ?? {};
  return {
    paths,
    env,
    present: await readAnswers(paths, env, { vaultCredentials: async () => null }),
    keyStore: () => fixedSecrets({ "db-url": DB_URL, "oidc-client-secret": "s", "model-key": MODEL_KEY }),
    fetch: outside().fetch,
    probeDatabase: async () => "PostgreSQL 17.2",
    probeFiles: async () => {},
    timeoutMs: 2_000,
    ...over,
  };
}

function answers(change: (a: SetupAnswers) => void = () => {}): SetupAnswers {
  const a = defaultAnswers(MODULES);
  a.organization = { name: "Northstar", firstAdministrator: "marta.lindqvist" };
  change(a);
  return a;
}

const texts = (lines: readonly CheckLine[]): string[] => lines.map((line) => line.text);

/** An environment that says where the search extension is downloaded from, so
 *  a test that switches Sessions on with Postgres on this disk is about what
 *  it names and not about that. */
const SEARCH = { FORTRESS_PGVECTOR_URL: "https://downloads.northstar.example/pgvector" };

describe("a new install on its plain answers", () => {
  test("every question passes with no cloud, no key and no outside service", async () => {
    const paths = await root();
    const silent = outside();
    const checks = await checkAll(answers(), await deps(paths, { fetch: silent.fetch }));
    expect(refusalsOf(checks)).toEqual([]);
    expect(checks.map((c) => c.step)).toHaveLength(10);
    expect(checks.every((c) => c.ok)).toBe(true);
    // The only outside call is the one the network question makes: to the
    // address a Fortress on its plain answers downloads its database program from.
    expect(silent.calls.map((c) => c.url)).toEqual(["https://repo1.maven.org"]);
  });
});

describe("step 1 · organization", () => {
  test("a missing name and a login that is not one are refused in plain words", async () => {
    const paths = await root();
    const check = await checkStep(
      "organization",
      answers((a) => {
        a.organization = { name: "", firstAdministrator: "Marta Lindqvist" };
      }),
      await deps(paths),
    );
    expect(check.ok).toBe(false);
    expect(check.lines).toEqual([
      { ok: false, text: "Give the organization a name", path: "organization.name" },
      {
        ok: false,
        text: "A login is 2 to 64 lowercase letters, digits, dots, dashes or underscores, and starts with a letter or a digit",
        path: "organization.firstAdministrator",
      },
    ]);
  });

  test("an account that exists is left as it is, and a removed login is refused", async () => {
    const paths = await root();
    const users = new UsersStore(path.join(paths.uiRoot, "users.json"));
    await users.create("marta.lindqvist", "operator");
    await users.create("gone", "operator");
    await users.remove("gone");

    const kept = await checkStep("organization", answers(), await deps(paths));
    expect(kept.ok).toBe(true);
    expect(texts(kept.lines)).toEqual(["An account with this login exists. Setup leaves it as it is"]);

    const removed = await checkStep(
      "organization",
      answers((a) => {
        a.organization.firstAdministrator = "gone";
      }),
      await deps(paths),
    );
    expect(removed.ok).toBe(false);
    expect(texts(removed.lines)).toEqual(["This login was removed from this Fortress. Choose another"]);
  });
});

describe("step 2 · keys", () => {
  test("the environment store answers, and says how many keys are set", async () => {
    const paths = await root();
    const env = { FORTRESS_SECRET_DB_URL: DB_URL, FORTRESS_SECRET_EMPTY: " " };
    const check = await checkStep("keys", answers(), await deps(paths, { env, keyStore: undefined }));
    expect(check.lines).toEqual([{ ok: true, text: "1 key is set in this host's environment" }]);
  });

  test("a folder that does not exist is refused by its path", async () => {
    const paths = await root();
    const missing = path.join(paths.root, "no-such-folder");
    const check = await checkStep(
      "keys",
      answers((a) => {
        a.keys = { ...a.keys, store: "file", folder: missing };
      }),
      await deps(paths, { keyStore: undefined }),
    );
    expect(check.ok).toBe(false);
    expect(check.lines).toEqual([{ ok: false, text: `The folder ${missing} does not exist`, path: "keys.folder" }]);
  });

  test("a folder of files answers, and counts the keys in it", async () => {
    const paths = await root();
    const folder = path.join(paths.root, "keys");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "db-url"), DB_URL);
    await writeFile(path.join(folder, "model-key"), MODEL_KEY);
    await writeFile(path.join(folder, "README.txt"), "not a key's name");
    const check = await checkStep(
      "keys",
      answers((a) => {
        a.keys = { ...a.keys, store: "file", folder };
      }),
      await deps(paths, { keyStore: undefined }),
    );
    // Beside the folder's own field, so the folder is not written twice.
    expect(check.lines).toEqual([{ ok: true, text: "2 keys found", path: "keys.folder" }]);
  });

  test("a key vault with no address is refused before anything is asked", async () => {
    const paths = await root();
    const check = await checkStep(
      "keys",
      answers((a) => {
        a.keys.store = "azure-key-vault";
      }),
      await deps(paths, { keyStore: undefined }),
    );
    expect(check.lines).toEqual([{ ok: false, text: "Give the vault's address", path: "keys.address" }]);
  });

  test("an option that is not in this build is refused", async () => {
    const paths = await root();
    const check = await checkStep(
      "keys",
      answers((a) => {
        a.keys.store = "aws-secrets-manager";
      }),
      await deps(paths),
    );
    expect(check.ok).toBe(false);
    expect(texts(check.lines)).toEqual(["AWS Secrets Manager is not in this build yet"]);
  });

  test("a key store that the host's environment decides cannot be answered otherwise", async () => {
    const paths = await root();
    const env = { FORTRESS_SECRETS_PROVIDER: "env" };
    const check = await checkStep(
      "keys",
      answers((a) => {
        a.keys = { ...a.keys, store: "file", folder: "/run/secrets" };
      }),
      await deps(paths, { env }),
    );
    expect(check.ok).toBe(false);
    expect(check.lines).toEqual([
      {
        ok: false,
        text: "This host's environment decides this answer (FORTRESS_SECRETS_PROVIDER). Remove the variable to change it here",
        path: "keys.store",
      },
    ]);
  });
});

describe("step 3 · sign-in", () => {
  const provider = (a: SetupAnswers): void => {
    a.signIn = {
      ...a.signIn,
      provider: "openid-connect",
      issuer: "https://login.northstar.example",
      clientId: "hx-fortress",
      clientSecret: "oidc-client-secret",
      operatorGroups: ["fortress-admins"],
    };
  };

  test("a provider that describes itself with the same issuer is found", async () => {
    const paths = await root();
    const check = await checkStep("signIn", answers(provider), await deps(paths));
    expect(check.ok).toBe(true);
    expect(check.lines).toEqual([
      { ok: true, text: "Found", path: "signIn.clientSecret" },
      { ok: true, text: "Provider found at login.northstar.example" },
    ]);
  });

  test("a wrong name for the client secret is refused beside its field", async () => {
    const paths = await root();
    const check = await checkStep(
      "signIn",
      answers((a) => {
        provider(a);
        a.signIn.clientSecret = "oidc-secret";
      }),
      await deps(paths),
    );
    expect(check.ok).toBe(false);
    expect(check.lines[0]).toEqual({ ok: false, text: "No key with this name", path: "signIn.clientSecret" });
  });

  test("a value typed where a key's name belongs is refused, and is not repeated", async () => {
    const paths = await root();
    const pasted = ["Zx9", "really-a-secret", "Q=="].join("_");
    const check = await checkStep(
      "signIn",
      answers((a) => {
        provider(a);
        a.signIn.clientSecret = pasted;
      }),
      await deps(paths),
    );
    expect(check.lines[0]).toEqual({ ok: false, text: "Not a key's name", path: "signIn.clientSecret" });
    expect(JSON.stringify(check)).not.toContain("really-a-secret");
  });

  test("an address where no provider answers is refused", async () => {
    const paths = await root();
    const check = await checkStep(
      "signIn",
      answers((a) => {
        provider(a);
        a.signIn.issuer = "https://nothing.northstar.example";
      }),
      await deps(paths),
    );
    expect(check.ok).toBe(false);
    expect(texts(check.lines)).toContain("No sign-in provider answers at this address");
  });

  test("a provider that names another issuer is refused", async () => {
    const paths = await root();
    const other = outside({
      "https://login.northstar.example/.well-known/openid-configuration": () =>
        Response.json(providerDocument("https://login.northstar.example/")),
    });
    const check = await checkStep("signIn", answers(provider), await deps(paths, { fetch: other.fetch }));
    expect(check.ok).toBe(false);
    expect(texts(check.lines)).toContain(
      "The provider at this address names another issuer. Copy the issuer exactly as the provider states it",
    );
  });

  test("a cleartext issuer is refused before it is asked anything", async () => {
    const paths = await root();
    const world = outside();
    const check = await checkStep(
      "signIn",
      answers((a) => {
        provider(a);
        a.signIn.issuer = "http://login.northstar.example";
      }),
      await deps(paths, { fetch: world.fetch }),
    );
    expect(check.ok).toBe(false);
    expect(world.calls).toEqual([]);
  });

  test("no group with a role is refused", async () => {
    const paths = await root();
    const check = await checkStep(
      "signIn",
      answers((a) => {
        provider(a);
        a.signIn.operatorGroups = [];
      }),
      await deps(paths),
    );
    expect(texts(check.lines)).toContain("Give at least one group a role");
  });

  test("accounts on this Fortress need a first administrator", async () => {
    const paths = await root();
    const check = await checkStep(
      "signIn",
      answers((a) => {
        a.organization.firstAdministrator = "";
      }),
      await deps(paths),
    );
    expect(check.lines).toEqual([
      { ok: false, text: "Accounts on this Fortress need a first administrator. Name one under Organization" },
    ]);
  });

  test("the console's address must be https with no path", async () => {
    const paths = await root();
    for (const address of ["http://fortress.northstar.example", "https://fortress.northstar.example/console"]) {
      const check = await checkStep(
        "signIn",
        answers((a) => {
          a.signIn.consoleAddress = address;
        }),
        await deps(paths),
      );
      expect(check.lines).toEqual([
        { ok: false, text: "The console's address must be https, with no path", path: "signIn.consoleAddress" },
      ]);
    }
  });
});

describe("step 4 · data", () => {
  const own = (a: SetupAnswers): void => {
    a.data.database = { store: "postgres", address: "db-url" };
  };

  test("the plain database says where it runs", async () => {
    const paths = await root();
    const check = await checkStep("data", answers(), await deps(paths));
    expect(check.lines).toEqual([{ ok: true, text: "Postgres runs on this disk, in the Fortress's folder" }]);
  });

  test("a database given by key name is opened, and the line holds no part of its address", async () => {
    const paths = await root();
    const opened: string[] = [];
    const check = await checkStep(
      "data",
      answers(own),
      await deps(paths, {
        probeDatabase: async (url) => {
          opened.push(url);
          return "PostgreSQL 17.2";
        },
      }),
    );
    expect(opened).toEqual([DB_URL]);
    expect(check.lines).toEqual([
      { ok: true, text: "Found", path: "data.database.address" },
      { ok: true, text: "Database reached. PostgreSQL 17.2" },
    ]);
    expect(JSON.stringify(check)).not.toContain("pw-for-a-test");
  });

  test("a database that does not answer is refused, and the reason holds no password", async () => {
    const paths = await root();
    const check = await checkStep(
      "data",
      answers(own),
      await deps(paths, {
        probeDatabase: async (url) => {
          throw new Error(`connect ECONNREFUSED while opening ${url}`);
        },
      }),
    );
    expect(check.ok).toBe(false);
    const said = check.lines.map((line) => line.text).join("\n");
    expect(said).toContain("The database could not be opened: nothing answers at its address");
    expect(said).not.toContain("pw-for-a-test");
  });

  test("what a database says when it refuses is not repeated: only the class of the refusal is", async () => {
    const paths = await root();
    // What a real server sends: its words name the user and the database, and
    // both are parts of the address that the key holds.
    const refusals: [Record<string, unknown>, string][] = [
      [
        { code: "ERR_POSTGRES_SERVER_ERROR", errno: "28P01", message: 'password authentication failed for user "fortress_prod"' },
        "it refused the user name or the password",
      ],
      [
        { code: "ERR_POSTGRES_SERVER_ERROR", errno: "3D000", message: 'database "northstar_ledger" does not exist' },
        "it has no database with the name in the address",
      ],
      [
        { code: "ERR_POSTGRES_SERVER_ERROR", errno: "53300", message: "sorry, too many clients already for role fortress_prod" },
        "it answered with error class 53300",
      ],
      [{ code: "ERR_POSTGRES_CONNECTION_CLOSED", message: "Connection closed by fortress_prod@db" }, "it closed the connection"],
      [{ message: "it did not answer in time" }, "it did not answer in time"],
      [{ errno: -61, code: "ECONNREFUSED", message: "connect ECONNREFUSED 10.1.2.3:5432" }, "nothing answers at its address"],
    ];
    for (const [fields, sentence] of refusals) {
      const check = await checkStep(
        "data",
        answers(own),
        await deps(paths, {
          probeDatabase: async () => {
            throw Object.assign(new Error(String(fields.message)), fields);
          },
        }),
      );
      expect(texts(check.lines)).toEqual(["Found", `The database could not be opened: ${sentence}`]);
      const said = JSON.stringify(check);
      for (const part of ["fortress_prod", "northstar_ledger", "10.1.2.3", "pw-for-a-test"]) {
        expect(said).not.toContain(part);
      }
    }
  });

  test("a key that holds something else than a database address is refused", async () => {
    const paths = await root();
    const check = await checkStep(
      "data",
      answers(own),
      await deps(paths, { keyStore: () => fixedSecrets({ "db-url": "host=db user=fortress" }) }),
    );
    expect(check.ok).toBe(false);
    expect(texts(check.lines)).toEqual(["The key was read, but its value is not a postgres:// connection URL"]);
  });

  test("no key name is refused, unless an earlier setup kept the address on this host", async () => {
    const paths = await root();
    const none = (a: SetupAnswers): void => {
      a.data.database = { store: "postgres", address: "" };
    };
    const refused = await checkStep("data", answers(none), await deps(paths));
    expect(texts(refused.lines)).toEqual(["Give the name of the key that holds the database's address"]);

    const env = { FORTRESS_DATABASE_URL: DB_URL };
    const kept = await checkStep("data", answers(none), await deps(paths, { env }));
    expect(kept.ok).toBe(true);
    expect(texts(kept.lines)).toEqual(["The address is kept on this host by an earlier setup"]);
  });

  test("with Sessions on a file store is needed, and it is tried with a test file", async () => {
    const paths = await root();
    const sessions = (a: SetupAnswers): void => {
      a.modules.session_vault = true;
    };
    const missing = await checkStep("data", answers(sessions), await deps(paths, { env: SEARCH }));
    expect(missing.ok).toBe(false);
    expect(texts(missing.lines)).toContain(
      "Sessions keeps files. Choose where they rest, or switch Sessions off under Modules",
    );

    const tried: unknown[] = [];
    const filled = await checkStep(
      "data",
      answers((a) => {
        sessions(a);
        a.data.files = { ...a.data.files, store: "s3-compatible", address: "https://minio.northstar.example", bucket: "fortress" };
      }),
      await deps(paths, {
        env: SEARCH,
        probeFiles: async (credentials) => {
          tried.push(credentials);
        },
      }),
    );
    expect(filled.ok).toBe(true);
    expect(texts(filled.lines)).toContain("A test file was written, read and removed");
    // Where the bucket is, and no key.
    expect(tried).toEqual([
      {
        store: "s3",
        bucket: "fortress",
        region: "us-east-1",
        endpoint: "https://minio.northstar.example",
        forcePathStyle: true,
      },
    ]);
  });

  test("what a file store says when it refuses is not repeated either", async () => {
    const paths = await root();
    const refusals: [Record<string, unknown>, string][] = [
      [
        { name: "InvalidAccessKeyId", $metadata: { httpStatusCode: 403 }, message: "The AWS Access Key Id AKIDEXAMPLENORTHSTAR does not exist" },
        "the store refused this host's access",
      ],
      [{ name: "NoSuchBucket", message: "The specified bucket northstar-ledger does not exist" }, "the store has no bucket with this name"],
      [{ code: 404, message: "bucket northstar-ledger not found" }, "the store has no bucket with this name"],
      [{ $metadata: { httpStatusCode: 503 }, message: "SlowDown northstar-ledger" }, "the store answered 503"],
      [{ message: "the store did not answer in time" }, "the store did not answer in time"],
      [{ message: "getaddrinfo ENOTFOUND minio.northstar.example" }, "nothing answers at the store's address"],
    ];
    for (const [fields, sentence] of refusals) {
      const check = await checkStep(
        "data",
        answers((a) => {
          a.modules.session_vault = true;
          a.model = { ...a.model, provider: "openai-compatible", address: "https://models.northstar.example/v1", key: "model-key" };
          a.data.files = { ...a.data.files, store: "s3-compatible", address: "https://minio.northstar.example", bucket: "fortress" };
        }),
        await deps(paths, {
          probeFiles: async () => {
            throw Object.assign(new Error(String(fields.message)), fields);
          },
        }),
      );
      expect(texts(check.lines)).toContain(`The test file could not be written: ${sentence}`);
      const said = JSON.stringify(check);
      for (const part of ["AKIDEXAMPLENORTHSTAR", "northstar-ledger", "SlowDown", "ENOTFOUND"]) {
        expect(said).not.toContain(part);
      }
    }
  });

  test("a file store with a field missing is refused beside the field", async () => {
    const paths = await root();
    const check = await checkStep(
      "data",
      answers((a) => {
        a.modules.session_vault = true;
        a.data.files = { ...a.data.files, store: "amazon-s3", bucket: "fortress" };
      }),
      await deps(paths),
    );
    expect(check.lines).toContainEqual({ ok: false, text: "Give the bucket's region", path: "data.files.region" });
  });
});

describe("step 6 · AI model", () => {
  const model = (a: SetupAnswers): void => {
    a.model = { ...a.model, provider: "openai-compatible", address: "https://models.northstar.example/v1", key: "model-key" };
  };

  test("the model is asked one fixed word, with the key in the request and nowhere else", async () => {
    const paths = await root();
    const world = outside();
    const check = await checkStep("model", answers(model), await deps(paths, { fetch: world.fetch }));
    expect(check.lines).toEqual([
      { ok: true, text: "Found", path: "model.key" },
      { ok: true, text: "The model answered a test question" },
    ]);
    expect(world.calls).toHaveLength(1);
    const sent = world.calls[0]?.init;
    expect(JSON.parse(String(sent?.body))).toEqual({ model: "text-embedding-3-large", input: ["ready"], dimensions: 1024 });
    expect((sent?.headers as Record<string, string>).authorization).toBe(`Bearer ${MODEL_KEY}`);
    expect(JSON.stringify(check)).not.toContain(MODEL_KEY);
  });

  test("a model that refuses the key says so, and repeats nothing it was sent", async () => {
    const paths = await root();
    const world = outside({
      "https://models.northstar.example/v1/embeddings": () =>
        new Response(`{"error":"bad key ${MODEL_KEY}"}`, { status: 401 }),
    });
    const check = await checkStep("model", answers(model), await deps(paths, { fetch: world.fetch }));
    expect(check.ok).toBe(false);
    expect(texts(check.lines)).toContain("The model did not answer: 401, so it refused the key");
    expect(JSON.stringify(check)).not.toContain(MODEL_KEY);
  });

  test("when the Fortress starts, the model is not asked: only its key is looked for", async () => {
    const paths = await root();
    const world = outside();
    const check = await checkStep("model", answers(model), await deps(paths, { fetch: world.fetch, when: "start" }));
    expect(check.lines).toEqual([{ ok: true, text: "Found", path: "model.key" }]);
    expect(world.calls).toEqual([]);
  });

  test("Sessions with no model is refused at the step that fixes it", async () => {
    const paths = await root();
    const check = await checkStep(
      "model",
      answers((a) => {
        a.modules.session_vault = true;
      }),
      await deps(paths),
    );
    expect(check.lines).toEqual([
      { ok: false, text: "Sessions needs an AI model for search. Choose one, or switch Sessions off under Modules" },
    ]);
  });
});

describe("step 7 · network", () => {
  test("the addresses that answered are named, so the list above is not read as some of them silent", async () => {
    const paths = await root();
    const net = outside({
      "https://login.northstar.example": () => new Response(null, { status: 404 }),
    });
    const check = await checkStep(
      "network",
      answers((a) => {
        a.signIn = {
          ...a.signIn,
          provider: "openid-connect",
          issuer: "https://login.northstar.example",
          clientId: "hx-fortress",
          operatorGroups: ["fortress-admins"],
        };
        // Its address is in a key, so the setup cannot ask it. It is listed, and not counted.
        a.data.database = { store: "postgres", address: "db-url" };
      }),
      await deps(paths, { fetch: net.fetch }),
    );
    expect(check.lines).toEqual([{ ok: true, text: "login.northstar.example answered from this host" }]);
    // Asked with HEAD, and never followed anywhere else.
    expect(net.calls.map((c) => [c.url, c.init?.method, c.init?.redirect])).toEqual([
      ["https://login.northstar.example", "HEAD", "manual"],
    ]);
  });

  test("an address that does not answer is said, and does not stop the setup", async () => {
    const paths = await root();
    const check = await checkStep("network", answers(), await deps(paths, { fetch: outside().fetch }));
    expect(check.ok).toBe(true);
    expect(check.lines).toEqual([
      { ok: false, text: "repo1.maven.org did not answer from this host", soft: true },
    ]);
  });
});

describe("step 10 · control plane", () => {
  const yes = (a: SetupAnswers): void => {
    a.controlPlane = { ...a.controlPlane, connect: "yes", address: "control.example" };
  };

  test("No needs nothing", async () => {
    const paths = await root();
    const check = await checkStep("controlPlane", answers(), await deps(paths));
    expect(check).toEqual({ step: "controlPlane", ok: true, lines: [] });
  });

  test("an address that is not one is refused beside its field", async () => {
    const paths = await root();
    const check = await checkStep(
      "controlPlane",
      answers((a) => {
        a.controlPlane = { ...a.controlPlane, connect: "yes", address: "http://control.example" };
      }),
      await deps(paths),
    );
    expect(check.lines).toEqual([
      { ok: false, text: "The control plane's address must be https", path: "controlPlane.address" },
    ]);
  });

  test("Yes cannot finish until a person has signed in there", async () => {
    const paths = await root();
    const url = "wss://control.example/_api/hx-gateway/vault-tunnel";
    const none = await checkStep("controlPlane", answers(yes), await deps(paths));
    expect(none.ok).toBe(false);
    expect(texts(none.lines)).toEqual([
      "Nobody has signed in at the control plane for this Fortress yet. Get a code and sign in, or choose No",
    ]);

    const waiting = await checkStep("controlPlane", answers(yes), await deps(paths, { enrollment: { url, state: "waiting" } }));
    expect(waiting.ok).toBe(false);

    const signedIn = await checkStep("controlPlane", answers(yes), await deps(paths, { enrollment: { url, state: "ready" } }));
    expect(signedIn).toEqual({
      step: "controlPlane",
      ok: true,
      lines: [{ ok: true, text: "Signed in. This Fortress connects when it starts" }],
    });

    // A sign-in for another address counts for nothing here.
    const other = await checkStep(
      "controlPlane",
      answers(yes),
      await deps(paths, { enrollment: { url: "wss://elsewhere.example/_api/hx-gateway/vault-tunnel", state: "ready" } }),
    );
    expect(other.ok).toBe(false);
  });
});
