// The check behind each answer, question by question: on the machine that
// runs HX Fortress, and for the address and the control plane in the install
// too. What the install alone checks is in install-checks.test.ts.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { FileCredentialStore, FilePendingEnrollmentStore } from "../src/cloud/credentials";
import { SecretUnavailable } from "../src/secrets/types";
import { defaultAnswers, installAnswers, type SetupAnswers } from "../src/setup/answers";
import { checkAll, checkStep, refusalsOf, type CheckDeps, type CheckLine } from "../src/setup/checks";
import { STEP_IDS } from "../src/setup/list";
import { readAnswers } from "../src/setup/read";
import type { PlaceRow } from "../src/setup/view";
import { UsersStore } from "../src/ui/users";
import { fixedSecrets, tempRoot, type Paths } from "./host/_module-rig";
import { CONTROL, DB_URL, EARLIER_CONTROL, INSTALL_ID, MODULES, PAGES, providerDocument } from "./setup-rig";

// Built at run time so no secret-shaped literal sits in the repository.
const MODEL_KEY = ["sk", "test", "model", "key"].join("-");
const KEYS = { "db-url": DB_URL, "sign-in-client-secret": "s", "model-key": MODEL_KEY, "install-id": INSTALL_ID };

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
    "https://api.anthropic.com/v1/models?limit=1": () => Response.json({ data: [] }),
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
    keyStore: () => fixedSecrets(KEYS),
    fetch: outside().fetch,
    probeDatabase: async () => "PostgreSQL 17.2",
    probeFiles: async () => {},
    timeoutMs: 2_000,
    ...over,
  };
}

/** The checks of the install, on an engineer's computer, for a place this
 *  build can make HX Fortress in and that this computer is signed in to. */
async function installDeps(paths: Paths, over: Partial<CheckDeps> = {}): Promise<CheckDeps> {
  const signedIn: PlaceRow = {
    id: "azure",
    offered: true,
    signedInAs: "marta.lindqvist, in Northstar Production",
    needsSignIn: true,
    signInCommand: "az login",
  };
  return deps(paths, {
    way: "install",
    place: (id) => ({ ...signedIn, id }),
    typed: { has: () => false, get: () => undefined },
    ...over,
  });
}

function answers(change: (a: SetupAnswers) => void = () => {}): SetupAnswers {
  const a = defaultAnswers(MODULES);
  a.organization = { name: "Northstar", firstAdministrator: "marta.lindqvist" };
  change(a);
  return a;
}

function install(change: (a: SetupAnswers) => void = () => {}): SetupAnswers {
  const a = installAnswers("azure", MODULES);
  a.organization = { name: "Northstar", firstAdministrator: "marta.lindqvist" };
  a.keys.vault = "northstar-hx-fortress";
  a.address.hostname = "hx.northstar.example";
  change(a);
  return a;
}

const texts = (lines: readonly CheckLine[]): string[] => lines.map((line) => line.text);

/** An environment that says where the search extension is downloaded from, so
 *  a test that switches Agentic Sessions on with Postgres on this disk is about
 *  what it names and not about that. */
const SEARCH = { FORTRESS_PGVECTOR_URL: "https://downloads.northstar.example/pgvector" };

describe("a new install on its plain answers", () => {
  test("every question passes with no cloud, no key and no outside service", async () => {
    const paths = await root();
    const silent = outside();
    const checks = await checkAll(answers(), await deps(paths, { fetch: silent.fetch }));
    expect(refusalsOf(checks)).toEqual([]);
    expect(checks.map((c) => c.step)).toEqual([...STEP_IDS]);
    expect(checks.every((c) => c.ok)).toBe(true);
    // Where it runs is a fact on the machine itself: nothing is said about it.
    expect(checks.find((c) => c.step === "where")?.lines).toEqual([]);
    // The only outside call is the one the Network question makes: to the
    // address an HX Fortress on its plain answers downloads its database program from.
    expect(silent.calls.map((c) => c.url)).toEqual(["https://repo1.maven.org"]);
  });
});

describe("organization", () => {
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
        text:
          "A login is a lowercase email address, or 2 to 64 lowercase letters, digits, dots, dashes or underscores " +
          "that start with a letter or a digit",
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
    expect(texts(removed.lines)).toEqual(["This login was removed from this HX Fortress. Choose another"]);
  });

  test("in the install there are no accounts to look at", async () => {
    const paths = await root();
    let read = 0;
    const check = await checkStep(
      "organization",
      install(),
      await installDeps(paths, {
        users: async () => {
          read += 1;
          return { version: 1, users: [] } as never;
        },
      }),
    );
    expect(check).toEqual({ step: "organization", ok: true, lines: [] });
    expect(read).toBe(0);
  });
});

describe("keys", () => {
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

  test("a Google Secret Manager with no project, or with what is not one, is refused before anything is asked", async () => {
    const paths = await root();
    const none = await checkStep(
      "keys",
      answers((a) => {
        a.keys.store = "google-secret-manager";
      }),
      await deps(paths, { keyStore: undefined }),
    );
    expect(none.lines).toEqual([{ ok: false, text: "Give the project's id", path: "keys.project" }]);
    // The project goes into the address of the request that carries the
    // token, so nothing that could change that address is taken.
    const wrong = await checkStep(
      "keys",
      answers((a) => {
        a.keys = { ...a.keys, store: "google-secret-manager", project: "northstar/secrets/other" };
      }),
      await deps(paths, { keyStore: undefined }),
    );
    expect(wrong.lines).toEqual([
      {
        ok: false,
        text: "A project's id (6 to 30 lowercase letters, digits or dashes) or its number",
        path: "keys.project",
      },
    ]);
  });

  test("a Google Secret Manager with a project is asked, and the finding names the project", async () => {
    const paths = await root();
    const check = await checkStep(
      "keys",
      answers((a) => {
        a.keys = { ...a.keys, store: "google-secret-manager", project: "northstar-hx-fortress" };
      }),
      await deps(paths),
    );
    expect(check.ok).toBe(true);
    expect(check.lines).toEqual([
      { ok: true, text: "Reached with this host's own service account, in the project northstar-hx-fortress" },
    ]);
  });

  test("a Google Secret Manager that refuses the made-up name was reached: its role is granted secret by secret", async () => {
    const paths = await root();
    // Secret Manager refuses every name this host's service account was not
    // granted, whether or not a secret has that name.
    const refusing = {
      kind: "google-secret-manager",
      get: async (name: string): Promise<string> => {
        throw new SecretUnavailable(name, "Secret Manager refused the request (403 PERMISSION_DENIED)", {
          transient: true,
          refused: true,
        });
      },
      has: async (name: string): Promise<boolean> => {
        throw new SecretUnavailable(name, "Secret Manager refused the request (403 PERMISSION_DENIED)", {
          transient: true,
          refused: true,
        });
      },
    };
    const google = answers((a) => {
      a.keys = { ...a.keys, store: "google-secret-manager", project: "northstar-hx-fortress" };
    });
    const check = await checkStep("keys", google, await deps(paths, { keyStore: () => refusing }));
    expect(check.ok).toBe(true);
    expect(check.lines).toEqual([
      {
        ok: true,
        text:
          "Secret Manager answers in the project northstar-hx-fortress. " +
          "This host's service account reads the secrets it was granted, and no other",
      },
    ]);

    // Any other failure is still a store that did not answer.
    const silent = {
      ...refusing,
      has: async (name: string): Promise<boolean> => {
        throw new SecretUnavailable(name, "Secret Manager did not answer (timed out)", { transient: true });
      },
    };
    const failed = await checkStep("keys", google, await deps(paths, { keyStore: () => silent }));
    expect(failed.ok).toBe(false);
    expect(failed.lines).toEqual([
      { ok: false, text: "The key store did not answer: Secret Manager did not answer (timed out)" },
    ]);

    // And a store that grants access as a whole is not excused by a refusal.
    const azure = answers((a) => {
      a.keys = { ...a.keys, store: "azure-key-vault", address: "https://northstar-hx-fortress.vault.azure.net" };
    });
    const whole = await checkStep("keys", azure, await deps(paths, { keyStore: () => refusing }));
    expect(whole.ok).toBe(false);
  });

  test("an option that is not in this build is refused at its choice", async () => {
    const paths = await root();
    const check = await checkStep(
      "keys",
      answers((a) => {
        a.keys.store = "aws-secrets-manager";
      }),
      await deps(paths),
    );
    expect(check.lines).toEqual([{ ok: false, text: "AWS Secrets Manager is not in this build yet", path: "keys.store" }]);
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
    expect(check.lines).toEqual([
      {
        ok: false,
        text: "This host's environment decides this answer (FORTRESS_SECRETS_PROVIDER). Remove the variable to change it here",
        path: "keys.store",
      },
    ]);
  });
});

describe("the address", () => {
  const at = (lines: readonly CheckLine[]): CheckLine[] => lines.filter((line) => line.path === "address.hostname");
  const HOSTNAME = { ok: false, text: "A hostname, such as hx.your-company.com", path: "address.hostname" };

  test("is a hostname: no scheme, no path, no wildcard and no space", async () => {
    const paths = await root();
    const given = await installDeps(paths);
    for (const hostname of [
      "https://hx.northstar.example",
      "hx.northstar.example/console",
      "*.northstar.example",
      "hx northstar.example",
      "hx.northstar.example:8443",
      "user@hx.northstar.example",
      "hx",
      "-hx.northstar.example",
    ]) {
      const check = await checkStep("address", install((a) => {
        a.address.hostname = hostname;
      }), given);
      expect([hostname, at(check.lines)]).toEqual([hostname, [HOSTNAME]]);
    }
    const good = await checkStep("address", install(), given);
    expect(good).toEqual({ step: "address", ok: true, lines: [] });
  });

  test("the install needs one, and on the machine itself it may be left out", async () => {
    const paths = await root();
    const none = await checkStep("address", install((a) => {
      a.address.hostname = "";
    }), await installDeps(paths));
    expect(none.lines).toEqual([HOSTNAME]);
    const here = await checkStep("address", answers(), await deps(paths));
    expect(here).toEqual({ step: "address", ok: true, lines: [] });
  });

  test("the organization's own certificate needs a key's name", async () => {
    const paths = await root();
    const own = (name: string) =>
      install((a) => {
        a.address.certificate = "own";
        a.address.certificateName = name;
      });
    const given = await installDeps(paths);
    expect((await checkStep("address", own(""), given)).lines).toEqual([
      { ok: false, text: "Name the certificate", path: "address.certificateName" },
    ]);
    expect((await checkStep("address", own("the certificate of hx"), given)).lines).toEqual([
      { ok: false, text: "Not a key's name", path: "address.certificateName" },
    ]);
    // The install cannot open the key store: it says when the key is read.
    expect((await checkStep("address", own("hx-fortress-cert"), given)).lines).toEqual([
      { ok: true, text: "HX Fortress reads the key by this name when it starts", path: "address.certificateName" },
    ]);
  });

  test("a certificate the place does not offer is refused there", async () => {
    const paths = await root();
    const check = await checkStep("address", install((a) => {
      a.where.place = "docker";
      a.where.ssh = "marta@hx-fortress-vm.northstar.example";
      a.address.certificate = "cloud-issued";
    }), await installDeps(paths));
    expect(check.lines).toEqual([
      {
        ok: false,
        text: "address.certificate: cloud-issued is not offered on a machine of your own. It can be own, none",
        path: "address.certificate",
      },
    ]);
  });
});

describe("sign-in", () => {
  const provider = (a: SetupAnswers): void => {
    a.signIn = {
      ...a.signIn,
      provider: "openid-connect",
      issuer: "https://login.northstar.example",
      clientId: "hx-fortress",
      clientSecret: "sign-in-client-secret",
      administratorGroups: ["hx-fortress-admins"],
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
        a.signIn.administratorGroups = [];
      }),
      await deps(paths),
    );
    expect(check.lines).toContainEqual({
      ok: false,
      text: "Give at least one group a role",
      path: "signIn.administratorGroups",
    });
  });

  test("with only Auditors or Viewers, somebody must still be able to change things: a group, or an account on this HX Fortress", async () => {
    const paths = await root();
    const refusal = {
      ok: false,
      text: "Give a group to Administrators or Operators. Auditors only read, and Viewers open nothing in the console",
      path: "signIn.administratorGroups",
    };
    const only = (field: "readonlyGroups" | "viewerGroups", firstAdministrator = "") =>
      (a: SetupAnswers): void => {
        provider(a);
        a.signIn.administratorGroups = [];
        a.signIn.operatorGroups = [];
        a.signIn[field] = ["data-team"];
        a.organization.firstAdministrator = firstAdministrator;
      };
    // No group that changes anything, and no account: refused, for Viewers and for Auditors.
    for (const field of ["viewerGroups", "readonlyGroups"] as const) {
      const check = await checkStep("signIn", answers(only(field)), await deps(paths));
      expect([field, check.ok]).toEqual([field, false]);
      expect(check.lines.filter((line) => !line.ok)).toEqual([refusal]);
    }
    // The setup on the machine itself makes the first administrator's account, so that is a way in.
    expect((await checkStep("signIn", answers(only("viewerGroups", "marta.lindqvist")), await deps(paths))).ok).toBe(true);
    // An install makes no account when people sign in through a provider, whoever is named.
    const installed = await checkStep("signIn", install(only("viewerGroups", "marta.lindqvist")), await installDeps(paths));
    expect(installed.lines.filter((line) => !line.ok)).toEqual([refusal]);
    // A group of Operators alone is enough, in both.
    const operators = (a: SetupAnswers): void => {
      only("viewerGroups")(a);
      a.signIn.operatorGroups = ["data-platform"];
    };
    expect((await checkStep("signIn", answers(operators), await deps(paths))).ok).toBe(true);
    expect((await checkStep("signIn", install(operators), await installDeps(paths))).ok).toBe(true);
    // An account that already administers this HX Fortress is a way in too.
    await new UsersStore(path.join(paths.uiRoot, "users.json")).create("erik.holm", "operator");
    expect((await checkStep("signIn", answers(only("viewerGroups")), await deps(paths))).ok).toBe(true);
  });

  test("accounts on this HX Fortress need a first administrator, on a new one and in the install", async () => {
    const paths = await root();
    const none = (a: SetupAnswers): void => {
      a.organization.firstAdministrator = "";
    };
    const refusal = { ok: false, text: "Accounts on this HX Fortress need a first administrator. Name one under Organization" };
    expect((await checkStep("signIn", answers(none), await deps(paths))).lines).toEqual([refusal]);
    expect((await checkStep("signIn", install(none), await installDeps(paths))).lines).toEqual([refusal]);
  });
});

describe("the database and its files", () => {
  const own = (a: SetupAnswers): void => {
    a.data.database = { store: "existing", address: "db-url" };
  };

  test("the plain database says where it runs", async () => {
    const paths = await root();
    const check = await checkStep("data", answers(), await deps(paths));
    expect(check.lines).toEqual([{ ok: true, text: "Postgres runs on this disk, in HX Fortress's folder" }]);
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
    const said = texts(check.lines).join("\n");
    expect(said).toContain("The database could not be opened: nothing answers at its address");
    expect(said).not.toContain("pw-for-a-test");
  });

  test("what a database says when it refuses is not repeated: only the class of the refusal is", async () => {
    const paths = await root();
    // What a real server sends: its words name the user and the database, and
    // both are parts of the address that the key holds.
    const refusals: [Record<string, unknown>, string][] = [
      [
        { code: "ERR_POSTGRES_SERVER_ERROR", errno: "28P01", message: 'password authentication failed for user "hx_prod"' },
        "it refused the user name or the password",
      ],
      [
        { code: "ERR_POSTGRES_SERVER_ERROR", errno: "3D000", message: 'database "northstar_ledger" does not exist' },
        "it has no database with the name in the address",
      ],
      [
        { code: "ERR_POSTGRES_SERVER_ERROR", errno: "53300", message: "sorry, too many clients already for role hx_prod" },
        "it answered with error class 53300",
      ],
      [{ code: "ERR_POSTGRES_CONNECTION_CLOSED", message: "Connection closed by hx_prod@db" }, "it closed the connection"],
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
      for (const part of ["hx_prod", "northstar_ledger", "10.1.2.3", "pw-for-a-test"]) expect(said).not.toContain(part);
    }
  });

  test("a key that holds something else than a database address is refused", async () => {
    const paths = await root();
    const check = await checkStep(
      "data",
      answers(own),
      await deps(paths, { keyStore: () => fixedSecrets({ "db-url": "host=db user=hx" }) }),
    );
    expect(check.ok).toBe(false);
    expect(texts(check.lines)).toEqual(["The key was read, but its value is not a postgres:// connection URL"]);
  });

  test("no key name is refused, unless an earlier setup kept the address on this host", async () => {
    const paths = await root();
    const none = (a: SetupAnswers): void => {
      a.data.database = { store: "existing", address: "" };
    };
    const refused = await checkStep("data", answers(none), await deps(paths));
    expect(refused.lines).toEqual([
      { ok: false, text: "Give the name of the key that holds the connection string", path: "data.database.address" },
    ]);

    const env = { FORTRESS_DATABASE_URL: DB_URL };
    const kept = await checkStep("data", answers(none), await deps(paths, { env }));
    expect(kept.ok).toBe(true);
    expect(texts(kept.lines)).toEqual(["The address is kept on this host by an earlier setup"]);
  });

  test("a database an install made is reached by its address on the machine itself, and the install opens none", async () => {
    const paths = await root();
    const made = (a: SetupAnswers): void => {
      a.where.place = "azure";
      a.data.database = { store: "managed", address: "db-url" };
    };
    let opened = 0;
    const probeDatabase = async (): Promise<string> => {
      opened += 1;
      return "PostgreSQL 17.2";
    };
    const here = await checkStep("data", answers(made), await deps(paths, { probeDatabase }));
    expect(texts(here.lines)).toEqual(["Found", "Database reached. PostgreSQL 17.2"]);
    expect(opened).toBe(1);
    const installed = await checkStep("data", install(), await installDeps(paths, { probeDatabase }));
    expect(installed).toEqual({ step: "data", ok: true, lines: [] });
    expect(opened).toBe(1);
  });

  test("with Agentic Sessions on a file store is needed, and it is tried with a test file", async () => {
    const paths = await root();
    const sessions = (a: SetupAnswers): void => {
      a.modules.session_vault = true;
    };
    const missing = await checkStep("data", answers(sessions), await deps(paths, { env: SEARCH }));
    expect(missing.ok).toBe(false);
    expect(texts(missing.lines)).toContain(
      "Agentic Sessions keeps files. Choose where they rest, or switch Agentic Sessions off under Modules",
    );

    const tried: unknown[] = [];
    const filled = await checkStep(
      "data",
      answers((a) => {
        sessions(a);
        a.data.files = { ...a.data.files, store: "s3-compatible", address: "https://minio.northstar.example", bucket: "northstar-hx-fortress" };
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
        bucket: "northstar-hx-fortress",
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
          a.data.files = { ...a.data.files, store: "s3-compatible", address: "https://minio.northstar.example", bucket: "northstar-hx-fortress" };
        }),
        await deps(paths, {
          env: SEARCH,
          probeFiles: async () => {
            throw Object.assign(new Error(String(fields.message)), fields);
          },
        }),
      );
      expect(texts(check.lines)).toContain(`The test file could not be written: ${sentence}`);
      const said = JSON.stringify(check);
      for (const part of ["AKIDEXAMPLENORTHSTAR", "northstar-ledger", "SlowDown", "ENOTFOUND"]) expect(said).not.toContain(part);
    }
  });

  test("a file store with a field missing is refused beside the field", async () => {
    const paths = await root();
    const check = await checkStep(
      "data",
      answers((a) => {
        a.modules.session_vault = true;
        a.data.files = { ...a.data.files, store: "amazon-s3", bucket: "northstar-hx-fortress" };
      }),
      await deps(paths, { env: SEARCH }),
    );
    expect(check.lines).toContainEqual({ ok: false, text: "Give the bucket's region", path: "data.files.region" });
  });

  test("a file store no module uses is not opened", async () => {
    const paths = await root();
    let tried = 0;
    const check = await checkStep(
      "data",
      answers((a) => {
        a.data.files = { ...a.data.files, store: "amazon-s3", bucket: "northstar-hx-fortress" };
      }),
      await deps(paths, {
        probeFiles: async () => {
          tried += 1;
        },
      }),
    );
    expect(check.ok).toBe(true);
    expect(tried).toBe(0);
  });
});

describe("the AI model", () => {
  const openai = (a: SetupAnswers): void => {
    a.modules.session_vault = true;
    a.model = { ...a.model, provider: "openai", address: "https://models.northstar.example/v1", key: "model-key" };
  };

  test("with search on, the model is asked one fixed word, with the key in a header and nowhere else", async () => {
    const paths = await root();
    const world = outside();
    const check = await checkStep("model", answers(openai), await deps(paths, { fetch: world.fetch }));
    expect(check.lines).toEqual([
      { ok: true, text: "Found", path: "model.key" },
      { ok: true, text: "The model answered a test question", path: "model.key" },
    ]);
    expect(world.calls.map((call) => call.url)).toEqual(["https://models.northstar.example/v1/embeddings"]);
    const sent = world.calls[0]?.init;
    expect(JSON.parse(String(sent?.body))).toEqual({ model: "text-embedding-3-large", input: ["ready"], dimensions: 1024 });
    expect(new Headers(sent?.headers).get("authorization")).toBe(`Bearer ${MODEL_KEY}`);
    expect(sent?.redirect).toBe("error");
    expect(JSON.stringify(check)).not.toContain(MODEL_KEY);
  });

  test("a provider that refuses the key says so, beside the key, and repeats nothing it was sent", async () => {
    const paths = await root();
    const world = outside({
      "https://models.northstar.example/v1/embeddings": () => new Response(`{"error":"bad key ${MODEL_KEY}"}`, { status: 401 }),
    });
    const check = await checkStep("model", answers(openai), await deps(paths, { fetch: world.fetch }));
    expect(check.ok).toBe(false);
    expect(check.lines).toContainEqual({ ok: false, text: "OpenAI refused the key", path: "model.key" });
    expect(JSON.stringify(check)).not.toContain(MODEL_KEY);
  });

  test("a provider asked directly is asked for its models, with the key in its own header", async () => {
    const paths = await root();
    const world = outside();
    const check = await checkStep(
      "model",
      answers((a) => {
        a.model = { ...a.model, provider: "anthropic", key: "model-key" };
      }),
      await deps(paths, { fetch: world.fetch }),
    );
    expect(check.lines).toEqual([
      { ok: true, text: "Found", path: "model.key" },
      { ok: true, text: "Anthropic took the key", path: "model.key" },
    ]);
    expect(world.calls).toHaveLength(1);
    expect(new URL(world.calls[0]?.url ?? "").host).toBe("api.anthropic.com");
    expect(new Headers(world.calls[0]?.init?.headers).get("x-api-key")).toBe(MODEL_KEY);
    expect(world.calls[0]?.url).not.toContain(MODEL_KEY);
  });

  test("an address of the organization's own is taken only for a model asked the way OpenAI is", async () => {
    const paths = await root();
    const check = await checkStep(
      "model",
      answers((a) => {
        a.model = { ...a.model, provider: "anthropic", key: "model-key", address: "https://models.northstar.example/v1" };
      }),
      await deps(paths),
    );
    expect(check.lines).toEqual([
      { ok: false, text: "This build reaches Anthropic at its own address", path: "model.address" },
    ]);
  });

  test("when HX Fortress starts, the model is not asked: only its key is looked for", async () => {
    const paths = await root();
    const world = outside();
    const check = await checkStep("model", answers(openai), await deps(paths, { fetch: world.fetch, when: "start" }));
    expect(check.lines).toEqual([{ ok: true, text: "Found", path: "model.key" }]);
    expect(world.calls).toEqual([]);
  });

  test("Agentic Sessions with no model, or with one that makes no embeddings, is refused at the step that fixes it", async () => {
    const paths = await root();
    const none = await checkStep("model", answers((a) => {
      a.modules.session_vault = true;
    }), await deps(paths));
    expect(none.lines).toEqual([
      {
        ok: false,
        text: "Agentic Sessions needs an AI model for search. Choose one, or switch Agentic Sessions off under Modules",
      },
    ]);
    const anthropic = await checkStep("model", answers((a) => {
      a.modules.session_vault = true;
      a.model = { ...a.model, provider: "anthropic", key: "model-key" };
    }), await deps(paths));
    expect(texts(anthropic.lines)).toEqual([
      "Agentic Sessions searches with embeddings, and this build asks OpenAI for them. Choose OpenAI, or switch Agentic Sessions off under Modules",
    ]);
  });

  test("a route this build does not have is refused", async () => {
    const paths = await root();
    const check = await checkStep("model", answers((a) => {
      a.model = { ...a.model, provider: "anthropic", route: "amazon-bedrock", key: "model-key" };
    }), await deps(paths));
    expect(check.lines).toEqual([{ ok: false, text: "This build reaches Anthropic directly", path: "model.route" }]);
  });
});

describe("the network", () => {
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
          administratorGroups: ["hx-fortress-admins"],
        };
        // Its address is in a key, so the setup cannot ask it. It is listed, and not counted.
        a.data.database = { store: "existing", address: "db-url" };
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
    expect(check.lines).toEqual([{ ok: false, text: "repo1.maven.org did not answer from this host", soft: true }]);
  });

  test("a proxy, which this build does not have, is refused", async () => {
    const paths = await root();
    const check = await checkStep("network", answers((a) => {
      a.network = { route: "proxy", proxy: "http://proxy.northstar.example:3128" };
    }), await deps(paths));
    expect(check.lines).toEqual([
      { ok: false, text: "Use a proxy to reach these addresses is not in this build yet", path: "network.route" },
    ]);
  });
});

describe("the control plane", () => {
  const named = (address = "control.example") => (a: SetupAnswers): void => {
    a.controlPlane = { ...a.controlPlane, connect: "yes", address };
  };

  async function enrolledAt(paths: Paths, url: string): Promise<void> {
    await mkdir(path.dirname(paths.config), { recursive: true });
    await writeFile(
      paths.config,
      JSON.stringify({ schemaVersion: 1, cloud: { url }, gateway: { publicUrl: "http://localhost:8787" }, modules: { enabled: [] } }),
    );
    await new FileCredentialStore(paths.credentials).save({
      orgId: "org_northstar",
      fortressId: "hx_1",
      credential: ["credential", "for", "a", "test"].join("-"),
    });
  }

  test("none named needs nothing", async () => {
    const paths = await root();
    expect(await checkStep("controlPlane", answers(), await deps(paths))).toEqual({ step: "controlPlane", ok: true, lines: [] });
    expect(await checkStep("controlPlane", install(), await installDeps(paths))).toEqual({ step: "controlPlane", ok: true, lines: [] });
  });

  test("an address that is not one is refused beside its field", async () => {
    const paths = await root();
    const check = await checkStep("controlPlane", answers(named("http://control.example")), await deps(paths));
    expect(check.lines).toEqual([
      { ok: false, text: "The control plane's address must be https", path: "controlPlane.address" },
    ]);
  });

  test("with an install id it passes, and with none it is refused with how to give one", async () => {
    const paths = await root();
    expect((await checkStep("controlPlane", answers(named()), await deps(paths, { installId: true }))).lines).toEqual([
      { ok: true, text: "An install id is held for the first connection" },
    ]);
    expect((await checkStep("controlPlane", answers(named()), await deps(paths))).lines).toEqual([
      {
        ok: false,
        text: "No install id was given for this control plane. Give one: hx-fortress setup --connect <address>/i/<id>",
        path: "controlPlane.address",
      },
    ]);
    // The install's command carries the id. Without it the command is copied again.
    expect((await checkStep("controlPlane", install(named()), await installDeps(paths, { installId: true }))).lines).toEqual([
      { ok: true, text: "HX Fortress connects to control.example when it starts" },
    ]);
    expect((await checkStep("controlPlane", install(named()), await installDeps(paths))).lines).toEqual([
      {
        ok: false,
        text: "The install command carries no install id for this control plane. Copy the command again",
        path: "controlPlane.address",
      },
    ]);
  });

  test("an install id given by the name of its key is looked for, and read only when the setup ends", async () => {
    const paths = await root();
    const byName = (token: string) => (a: SetupAnswers): void => {
      named()(a);
      a.controlPlane.token = token;
    };
    let read = 0;
    const store = fixedSecrets(KEYS);
    const counted = await deps(paths, {
      keyStore: () => ({
        ...store,
        get: async (name: string) => {
          read += 1;
          return store.get(name);
        },
      }),
    });
    expect((await checkStep("controlPlane", answers(byName("install-id")), counted)).lines).toEqual([
      { ok: true, text: "The install id is read from the key store when the setup ends" },
    ]);
    expect(read).toBe(0);
    expect((await checkStep("controlPlane", answers(byName("no-such-key")), counted)).lines).toEqual([
      { ok: false, text: "No key with this name", path: "controlPlane.token" },
    ]);
  });

  test("an install id that waits for this control plane passes, at this path and at the earlier one", async () => {
    const paths = await root();
    const pending = new FilePendingEnrollmentStore(paths.pendingEnrollment);
    for (const cloudUrl of [CONTROL, EARLIER_CONTROL]) {
      await pending.save({ token: INSTALL_ID, cloudUrl });
      expect([cloudUrl, (await checkStep("controlPlane", answers(named()), await deps(paths))).lines]).toEqual([
        cloudUrl,
        [{ ok: true, text: "An install id is held for the first connection. This HX Fortress connects when it starts" }],
      ]);
    }
    // One that waits for another control plane is not this one's.
    await pending.save({ token: INSTALL_ID, cloudUrl: "wss://other.example/v1/connection" });
    expect((await checkStep("controlPlane", answers(named()), await deps(paths))).ok).toBe(false);
  });

  test("an HX Fortress enrolled with another control plane is refused, and one enrolled here passes at either path", async () => {
    for (const [url, ok] of [
      ["wss://other.example/v1/connection", false],
      [CONTROL, true],
      [EARLIER_CONTROL, true],
    ] as const) {
      const paths = await root();
      await enrolledAt(paths, url);
      const check = await checkStep("controlPlane", answers(named()), await deps(paths));
      if (ok) {
        expect([url, check.lines]).toEqual([url, [{ ok: true, text: "This HX Fortress is enrolled there" }]]);
      } else {
        expect(check.lines).toEqual([
          {
            ok: false,
            text:
              "This HX Fortress is enrolled with another control plane. To connect it here, stop it, remove the folder " +
              `${path.dirname(paths.credentials)}, and give an install id for this control plane. It then enrolls as a new HX Fortress`,
            path: "controlPlane.address",
          },
        ]);
      }
      await cleanup?.();
      cleanup = null;
    }
  });

  test("the control plane's pages are exactly one origin", async () => {
    const paths = await root();
    const pages = (value: string) => (a: SetupAnswers): void => {
      named()(a);
      a.controlPlane.pages = value;
    };
    for (const value of ["https://app.control.example/pages", "https://*.control.example", "http://app.control.example", `${PAGES} ${PAGES}`]) {
      expect([value, (await checkStep("controlPlane", answers(pages(value)), await deps(paths, { installId: true }))).lines]).toEqual([
        value,
        [
          {
            ok: false,
            text: "The address of the control plane's pages must be one origin, written as https://host, with no path",
            path: "controlPlane.pages",
          },
        ],
      ]);
    }
    expect((await checkStep("controlPlane", answers(pages(PAGES)), await deps(paths, { installId: true }))).ok).toBe(true);
    expect((await checkStep("controlPlane", install(pages(PAGES)), await installDeps(paths, { installId: true }))).ok).toBe(true);
  });

  test("a control plane the host's environment names is the environment's", async () => {
    const paths = await root();
    const env = { FORTRESS_CLOUD_URL: CONTROL, FORTRESS_ENROLL_TOKEN: INSTALL_ID };
    const check = await checkStep("controlPlane", answers(named()), await deps(paths, { env }));
    expect(check.lines).toEqual([{ ok: true, text: "The control plane is set by this host's environment" }]);
  });
});

// ── Waiting for the other branch ─────────────────────────────────────────────

describe("a control plane whose connection is switched off", () => {
  const OFF = "The connection is switched off. HX Fortress does not dial the control plane";
  const named = (connected: string) => (a: SetupAnswers): void => {
    a.controlPlane = { ...a.controlPlane, connect: "yes", address: "control.example", connected };
  };

  test("needs nothing more to connect, on the machine itself and in the install", async () => {
    const paths = await root();
    // No install id and no enrollment: switched on, this is refused.
    expect((await checkStep("controlPlane", answers(named("on")), await deps(paths))).ok).toBe(false);
    expect(await checkStep("controlPlane", answers(named("off")), await deps(paths))).toEqual({
      step: "controlPlane",
      ok: true,
      lines: [{ ok: true, text: OFF }],
    });
    expect((await checkStep("controlPlane", install(named("off")), await installDeps(paths))).lines).toEqual([
      { ok: true, text: OFF },
    ]);
  });

  test("gives no search extension: a start that would fail for want of it is refused here", async () => {
    const paths = await root();
    const searching = (connected: string) => (a: SetupAnswers): void => {
      named(connected)(a);
      a.modules.session_vault = true;
    };
    const extension = /Agentic Sessions searches with a database extension/;
    const on = await checkStep("data", answers(searching("on")), await deps(paths, { installId: true }));
    expect(texts(on.lines).some((text) => extension.test(text))).toBe(false);
    const off = await checkStep("data", answers(searching("off")), await deps(paths, { installId: true }));
    expect(texts(off.lines.filter((line) => !line.ok)).some((text) => extension.test(text))).toBe(true);
  });
});

describe("an install and the control plane", () => {
  test("takes no install id by the name of a key: the plan would name a control plane, and nothing would be handed over", async () => {
    const paths = await root();
    const check = await checkStep(
      "controlPlane",
      install((a) => {
        a.controlPlane = { ...a.controlPlane, connect: "yes", address: "control.example", token: "install-id" };
      }),
      await installDeps(paths),
    );
    expect(check.lines).toEqual([
      {
        ok: false,
        text: "An install takes the install id from its own command, and not from a key store. Copy the command again",
        path: "controlPlane.token",
      },
    ]);
  });
});

describe("a login that is an email address", () => {
  describe("with an email address as the login", () => {
    test("on the machine itself the first administrator may be an email address", async () => {
      const paths = await root();
      const check = await checkStep(
        "organization",
        answers((a) => {
          a.organization.firstAdministrator = "marta.lindqvist@northstar.example";
        }),
        await deps(paths),
      );
      expect(check).toEqual({ step: "organization", ok: true, lines: [] });
      // A login of another shape is still refused.
      const wrong = await checkStep("organization", answers((a) => {
        a.organization.firstAdministrator = "Marta Lindqvist <marta@northstar.example>";
      }), await deps(paths));
      expect(wrong.ok).toBe(false);
    });
  });
});
