import { describe, expect, test } from "bun:test";

import {
  answerAt,
  answersToFile,
  answerText,
  DEFAULT_MODEL_ADDRESS,
  defaultAnswers,
  parseSettingsFile,
  setAnswer,
  settingsFileText,
  summaryLines,
  type SetupAnswers,
} from "../src/setup/answers";
import { OPTION_CHECKS } from "../src/setup/checks";
import { controlPlaneAddress, controlPlaneUrl } from "../src/setup/control-plane";
import { choicesOf, NONE, SETUP_LIST, STEP_IDS, visibleList } from "../src/setup/list";
import { DEFAULT_OPENAI_BASE_URL } from "../src/host/config";
import { DEFAULT_PG_BINARIES_URL } from "../src/host/postgres/resolve";
import { isSecretProviderKind, SECRET_PROVIDERS } from "../src/secrets";
import { DATABASE_PROGRAM_HOST, reachOf } from "../src/setup/reach";
import { KEY_STORE_ANSWER } from "../src/setup/read";

const MODULES = ["session_vault", "host"];

/** A made-up company's answers: every question on a built option. */
function northstar(): SetupAnswers {
  const a = defaultAnswers(MODULES);
  a.organization = { name: "Northstar", firstAdministrator: "marta.lindqvist" };
  a.keys = { ...a.keys, store: "file", folder: "/run/secrets" };
  a.signIn = {
    ...a.signIn,
    provider: "openid-connect",
    issuer: "https://login.northstar.example",
    clientId: "hx-fortress",
    clientSecret: "oidc-client-secret",
    operatorGroups: ["fortress-admins"],
    readonlyGroups: ["auditors"],
    consoleAddress: "https://fortress.northstar.example",
  };
  a.data.database = { store: "postgres", address: "db-url" };
  a.modules.host = true;
  a.controlPlane = { ...a.controlPlane, connect: "yes", address: "control.example" };
  return a;
}

describe("the setup's list", () => {
  test("it asks its questions in the order of the settings file's keys", () => {
    expect(SETUP_LIST.map((step) => step.id)).toEqual([...STEP_IDS]);
    expect(STEP_IDS).toHaveLength(10);
    for (const step of SETUP_LIST) {
      expect(step.name.length).toBeGreaterThan(0);
      expect(step.question.endsWith("?")).toBe(true);
    }
  });

  test("every option that is built has a check, and no other option has one", () => {
    for (const { block } of choicesOf()) {
      const checks = OPTION_CHECKS[block.path] ?? {};
      const built = block.options.filter((o) => o.built).map((o) => o.id).sort();
      expect({ path: block.path, ids: Object.keys(checks).sort() }).toEqual({ path: block.path, ids: built });
    }
    // And no check for a choice the list does not have.
    const paths = new Set(choicesOf().map(({ block }) => block.path));
    for (const path of Object.keys(OPTION_CHECKS)) expect(paths.has(path)).toBe(true);
  });

  test("every choice has a built option, and option ids are unique within a choice", () => {
    for (const { block } of choicesOf()) {
      expect(block.options.some((o) => o.built)).toBe(true);
      const ids = block.options.map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  test("the default answer of every choice is a built option, which needs no cloud", () => {
    const defaults = defaultAnswers(MODULES);
    for (const { block } of choicesOf()) {
      const chosen = answerText(defaults, block.path);
      if (chosen === NONE && block.neededBy) continue;
      const option = block.options.find((o) => o.id === chosen);
      expect({ path: block.path, built: option?.built }).toEqual({ path: block.path, built: true });
    }
    expect(defaults.keys.store).toBe("env");
    expect(defaults.signIn.provider).toBe("local");
    expect(defaults.data.database.store).toBe("this-disk");
    expect(defaults.controlPlane.connect).toBe("no");
    expect(Object.values(defaults.modules).every((on) => on === false)).toBe(true);
  });

  test("a person is shown only the options that are built", () => {
    const shown = visibleList();
    const ids = (path: string): string[] =>
      choicesOf(shown).find(({ block }) => block.path === path)?.block.options.map((o) => o.id) ?? [];
    expect(ids("keys.store")).toEqual(["env", "file", "azure-key-vault"]);
    expect(ids("network.route")).toEqual(["direct"]);
    expect(ids("records.copyTo")).toEqual([NONE]);
    // The whole list still pins the ids of what is planned.
    const all = choicesOf().find(({ block }) => block.path === "keys.store")?.block.options.map((o) => o.id);
    expect(all).toContain("aws-secrets-manager");
    expect(all).toContain("google-secret-manager");
  });

  test("every field's path names an answer", () => {
    const answers = defaultAnswers(MODULES);
    for (const step of SETUP_LIST) {
      for (const block of step.blocks) {
        const fields =
          block.kind === "fields"
            ? block.fields
            : block.kind === "choice"
              ? block.options.flatMap((o) => o.fields ?? [])
              : [];
        for (const field of fields) {
          expect({ path: field.path, known: answerAt(answers, field.path) !== undefined }).toEqual({
            path: field.path,
            known: true,
          });
          expect(field.path.split(".")[0]).toBe(step.id);
        }
        if (block.kind === "choice") expect(answerAt(answers, block.path)).toBeDefined();
      }
    }
  });
});

describe("the key stores the list offers", () => {
  const options = choicesOf().find(({ block }) => block.path === "keys.store")?.block.options ?? [];

  test("are exactly the key stores this build has: an option is built when its provider is listed", () => {
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect([option.id, option.built]).toEqual([option.id, isSecretProviderKind(option.id)]);
    }
    // And the other way: a key store that the build has is a question's option.
    for (const provider of SECRET_PROVIDERS) {
      expect(options.map((option) => option.id)).toContain(provider.kind);
    }
  });

  test("each setting the setup writes is a setting of a listed key store, and an answer of the Keys question", () => {
    const settings = new Set(SECRET_PROVIDERS.flatMap((provider) => provider.settings.map((setting) => setting.key)));
    const defaults = defaultAnswers(MODULES);
    for (const [key, at] of Object.entries(KEY_STORE_ANSWER)) {
      expect(settings.has(key)).toBe(true);
      expect(answerAt(defaults, at)).toBe("");
      expect(at.startsWith("keys.")).toBe(true);
    }
  });
});

describe("one answer, by its path", () => {
  test("a field is set only to a value of the kind it holds", () => {
    const a = defaultAnswers(MODULES);
    expect(setAnswer(a, "organization.name", "Northstar")).toBe(true);
    expect(a.organization.name).toBe("Northstar");
    expect(setAnswer(a, "organization.name", 7)).toBe(false);
    expect(setAnswer(a, "signIn.operatorGroups", "admins, data-team ,admins")).toBe(true);
    expect(a.signIn.operatorGroups).toEqual(["admins", "data-team"]);
    expect(setAnswer(a, "modules.host", true)).toBe(true);
    expect(setAnswer(a, "modules.host", "yes")).toBe(false);
  });

  test("a path that names no answer adds nothing", () => {
    const a = defaultAnswers(MODULES);
    const before = JSON.stringify(a);
    expect(setAnswer(a, "organization.extra", "x")).toBe(false);
    expect(setAnswer(a, "__proto__.polluted", "x")).toBe(false);
    expect(setAnswer(a, "constructor.prototype.polluted", "x")).toBe(false);
    expect(setAnswer(a, "nothing", "x")).toBe(false);
    expect(JSON.stringify(a)).toBe(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("an answer longer than a field takes is not kept", () => {
    const a = defaultAnswers(MODULES);
    expect(setAnswer(a, "organization.name", "x".repeat(5000))).toBe(false);
    expect(a.organization.name).toBe("");
  });
});

describe("the settings file", () => {
  test("it has one key per question, and gives a key by its name", () => {
    const file = answersToFile(northstar());
    expect(Object.keys(file)).toEqual(["version", ...STEP_IDS]);
    expect(file.signIn.clientSecret).toEqual({ key: "oidc-client-secret" });
    expect(file.data.database).toEqual({ store: "postgres", address: { key: "db-url" } });
    expect(file.data.files).toBe(false);
    expect(file.model).toBe(false);
    expect(file.network).toEqual({ proxy: false });
    expect(file.records).toEqual({ keepFor: "until-removed", copyTo: false });
    expect(file.controlPlane).toEqual({ address: "control.example" });
    expect(file.modules).toEqual({ host: true, session_vault: false });
  });

  test("it holds only the fields of the option that was chosen", () => {
    const a = northstar();
    a.keys.address = "https://left-over.vault.azure.net";
    expect(answersToFile(a).keys).toEqual({ store: "file", folder: "/run/secrets" });
    a.signIn.provider = "local";
    const signIn = answersToFile(a).signIn;
    expect(signIn).toEqual({ provider: "local", consoleAddress: "https://fortress.northstar.example" });
  });

  test("what is printed reads back as the same answers", () => {
    const a = northstar();
    const parsed = parseSettingsFile(settingsFileText(a), defaultAnswers(MODULES), { moduleIds: MODULES });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(answersToFile(parsed.answers)).toEqual(answersToFile(a));
      expect(parsed.given).toEqual([...STEP_IDS]);
    }
  });

  test("a question the file leaves out keeps its present answer", () => {
    const present = northstar();
    const parsed = parseSettingsFile(JSON.stringify({ organization: { name: "Tallgrass Title" } }), present, {
      moduleIds: MODULES,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.answers.organization).toEqual({ name: "Tallgrass Title", firstAdministrator: "" });
      expect(parsed.answers.keys).toEqual(present.keys);
      expect(parsed.given).toEqual(["organization"]);
    }
  });

  test("a key the list does not know is refused by name", () => {
    const parsed = parseSettingsFile(
      JSON.stringify({ organisation: { name: "x" }, keys: { store: "env", folders: "/x" } }),
      defaultAnswers(MODULES),
      { moduleIds: MODULES },
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.refusals.join("\n")).toContain("organisation is not a question of the setup");
      expect(parsed.refusals.join("\n")).toContain("keys.folders is not a setting");
    }
  });

  test("an option that is planned and not built is refused in plain words", () => {
    const parsed = parseSettingsFile(JSON.stringify({ keys: { store: "aws-secrets-manager" } }), defaultAnswers(MODULES), {
      moduleIds: MODULES,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.refusals).toEqual([
        "keys.store: AWS Secrets Manager is not in this build yet. It can be env, file, azure-key-vault",
      ]);
    }
  });

  test("a value where a key's name belongs is refused, and is not repeated", () => {
    const pasted = ["postgres://admin:", "hunter2-not-a-real-one", "@db.northstar.example/fortress"].join("");
    for (const address of [pasted, { key: pasted }, { key: "db-url", value: pasted }]) {
      const parsed = parseSettingsFile(
        JSON.stringify({ data: { database: { store: "postgres", address } } }),
        defaultAnswers(MODULES),
        { moduleIds: MODULES },
      );
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        const said = parsed.refusals.join("\n");
        expect(said).toContain("data.database.address");
        expect(said).not.toContain("hunter2");
        expect(said).not.toContain("northstar.example");
      }
    }
  });

  test("a module that is not in this build is refused", () => {
    const parsed = parseSettingsFile(JSON.stringify({ modules: { stores: true } }), defaultAnswers(MODULES), {
      moduleIds: MODULES,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.refusals[0]).toContain("modules.stores is not a module of this build");
  });

  test("text that is not a JSON object is refused", () => {
    for (const text of ["", "not json", "[]", "null", '"x"']) {
      expect(parseSettingsFile(text, defaultAnswers(MODULES), { moduleIds: MODULES }).ok).toBe(false);
    }
  });
});

describe("the control plane's address", () => {
  test("a host becomes a secure connection at the protocol's path", () => {
    expect(controlPlaneUrl("control.example")).toEqual({
      ok: true,
      url: "wss://control.example/_api/hx-gateway/vault-tunnel",
    });
    expect(controlPlaneUrl(" https://control.example/base/ ")).toEqual({
      ok: true,
      url: "wss://control.example/base/_api/hx-gateway/vault-tunnel",
    });
  });

  test("an address that is already a connection is kept as typed", () => {
    expect(controlPlaneUrl("wss://control.example/own/path")).toEqual({ ok: true, url: "wss://control.example/own/path" });
  });

  test("cleartext is accepted to this host only", () => {
    expect(controlPlaneUrl("http://localhost:9000/base")).toEqual({
      ok: true,
      url: "ws://localhost:9000/base/_api/hx-gateway/vault-tunnel",
    });
    expect(controlPlaneUrl("http://control.example")).toEqual({
      ok: false,
      reason: "The control plane's address must be https",
    });
    expect(controlPlaneUrl("ws://control.example/x").ok).toBe(false);
  });

  test("what is not an address is refused in plain words", () => {
    expect(controlPlaneUrl("")).toEqual({ ok: false, reason: "Give the control plane's address" });
    expect(controlPlaneUrl("two words").ok).toBe(false);
    expect(controlPlaneUrl("nodots").ok).toBe(false);
    expect(controlPlaneUrl("https://user:pw@control.example").ok).toBe(false);
    expect(controlPlaneUrl("control.example?x=1").ok).toBe(false);
  });

  test("a stored connection reads back as what a person would type", () => {
    for (const typed of ["control.example", "control.example/base", "http://localhost:9000/base"]) {
      const parsed = controlPlaneUrl(typed);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(controlPlaneAddress(parsed.url)).toBe(typed);
    }
    expect(controlPlaneAddress("wss://control.example/own/path")).toBe("wss://control.example/own/path");
  });
});

describe("what the answers add up to", () => {
  test("the addresses are worked out from the answers, each with its reason", () => {
    const rows = reachOf(northstar(), { needsFiles: false, needsModel: false });
    expect(rows.map((row) => [row.address, row.why])).toEqual([
      ["login.northstar.example", "sign-in"],
      ["the address in db-url", "database"],
      // In this build a new version is downloaded through the control plane,
      // so the Updates answer adds no address of its own.
      ["control.example", "control plane, new versions"],
    ]);
  });

  test("a model with no address is asked at the default one, and the list says so", () => {
    const a = northstar();
    a.model = { ...a.model, provider: "openai-compatible", address: "", key: "model-key" };
    const rows = reachOf(a, { needsFiles: false, needsModel: true });
    expect(rows.map((row) => [row.address, row.why])).toContainEqual([new URL(DEFAULT_MODEL_ADDRESS).host, "AI model"]);
    // One address, in the file a page can import and in the host's own code.
    expect(DEFAULT_MODEL_ADDRESS).toBe(DEFAULT_OPENAI_BASE_URL);
  });

  test("Postgres on this disk is downloaded once, and the list says from where", () => {
    const a = northstar();
    a.data.database = { store: "this-disk", address: "" };
    const rows = reachOf(a, { needsFiles: false, needsModel: false });
    expect(rows.map((row) => [row.address, row.why])).toContainEqual(["repo1.maven.org", "database program, once"]);
    // The address the list names is the one the Fortress downloads from.
    expect(new URL(DEFAULT_PG_BINARIES_URL).host).toBe(DATABASE_PROGRAM_HOST);
  });

  test("an answer nothing uses calls nothing", () => {
    const a = northstar();
    a.data.files = { ...a.data.files, store: "s3-compatible", address: "https://minio.northstar.example", bucket: "b" };
    a.model = { ...a.model, provider: "openai-compatible", address: "https://models.northstar.example/v1" };
    const off = reachOf(a, { needsFiles: false, needsModel: false }).map((row) => row.why);
    expect(off).not.toContain("files");
    expect(off).not.toContain("AI model");
    const on = reachOf(a, { needsFiles: true, needsModel: true }).map((row) => row.why);
    expect(on).toContain("files");
    expect(on).toContain("AI model");
  });

  test("the review says each answer in a few words", () => {
    const lines = summaryLines(northstar(), {
      moduleTitles: { session_vault: "Sessions", host: "Host" },
      reachCount: 4,
    });
    expect(lines.organization).toBe("Northstar · marta.lindqvist");
    expect(lines.keys).toBe("A folder of files");
    expect(lines.signIn).toBe("Your identity provider · login.northstar.example");
    expect(lines.modules).toBe("Host");
    expect(lines.network).toBe("Direct · 4 addresses");
    expect(lines.controlPlane).toBe("control.example");
  });
});
