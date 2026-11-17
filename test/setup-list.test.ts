// The setup's list, the answers it is asked into, and the settings file that
// holds them: the shape every way of answering draws from.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_OPENAI_BASE_URL } from "../src/host/config";
import { DEFAULT_PG_BINARIES_URL } from "../src/host/postgres/resolve";
import { isSecretProviderKind, SECRET_PROVIDERS } from "../src/secrets";
import {
  answerAt,
  answersToFile,
  answerText,
  DEFAULT_MODEL_ADDRESS,
  defaultAnswers,
  hostnameFor,
  installAnswers,
  parseSettingsFile,
  routesOf,
  setAnswer,
  settingsFileText,
  settleAnswers,
  summaryLines,
  vaultNameFor,
  wordsOf,
  type SetupAnswers,
} from "../src/setup/answers";
import { OPTION_CHECKS, SWITCH_CHECKS } from "../src/setup/checks";
import { CONNECT_SHAPE, parseConnect } from "../src/setup/connect";
import {
  CONTROL_PLANE_PATH,
  controlPlaneAddress,
  controlPlaneUrl,
  EARLIER_CONTROL_PLANE_PATH,
  sameControlPlane,
} from "../src/setup/control-plane";
import {
  choiceAt,
  choicesOf,
  CLOUD_PLACES,
  fieldsOfStep,
  INSTALL_PLACES,
  isCloudPlace,
  keyFields,
  LAST_STEP,
  NONE,
  phrase,
  PLACE_IDS,
  PLACES,
  placeInfo,
  SETTINGS_ORDER,
  SETUP_LIST,
  STEP_IDS,
  stepsAsked,
  switchesOf,
  visibleList,
  type PlaceId,
  type SetupStep,
  type Way,
} from "../src/setup/list";
import { installPlan, PLAN_ROW_IDS } from "../src/setup/plan";
import { PICTURE_PART, pictureOf } from "../src/setup/picture";
import { DATABASE_PROGRAM_HOST, REACH_IS_HELD, reachLabel, reachOf } from "../src/setup/reach";
import { KEY_STORE_ANSWER } from "../src/setup/read";
import { RULES, scanText } from "./words-check";
import { CONTROL, EARLIER_CONTROL, INSTALL_ID, MODULES, PAGES } from "./setup-rig";

const WAYS: readonly Way[] = ["install", "setup", "settings"];

// Built at run time so no secret-shaped literal sits in the repository.
const PASTED_KEY = ["sk", "ant", "api03", "Xq7_Zt9vNotAReal0ne"].join("-");
const IDENTITY = ["0f3a9b7c", "1d2e", "4f5a", "8b6c", "7d8e9f0a1b2c"].join("-");

/** The answers a place starts with: the install's own, or a new machine's. */
function startOf(place: PlaceId): SetupAnswers {
  return place === "here" ? defaultAnswers(MODULES) : installAnswers(place, MODULES);
}

/** Every string in a value, however deep. */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsOf);
  return [];
}

/** Every option of every choice and of every field with options, in a list. */
function optionsOf(list: readonly SetupStep[]): { path: string; id: string; built?: boolean; places?: readonly PlaceId[] }[] {
  return list.flatMap((step) =>
    step.blocks.flatMap((block) => {
      const fieldOptions = (fields: readonly { path: string; options?: readonly { id: string; built?: boolean }[] }[]) =>
        fields.flatMap((field) => (field.options ?? []).map((option) => ({ path: field.path, ...option })));
      if (block.kind === "choice") {
        return block.options.flatMap((option) => [
          { path: block.path, id: option.id, built: option.built, ...(option.places ? { places: option.places } : {}) },
          ...fieldOptions(option.fields ?? []),
        ]);
      }
      if (block.kind === "fields") return fieldOptions(block.fields);
      if (block.kind === "switch") return fieldOptions(block.fields ?? []);
      return [];
    }),
  );
}

/** A made-up company's answers on the machine itself: every question on a built option. */
function northstar(): SetupAnswers {
  const a = defaultAnswers(MODULES);
  a.organization = { name: "Northstar", firstAdministrator: "marta.lindqvist" };
  a.keys = { ...a.keys, store: "file", folder: "/run/secrets" };
  a.address = { ...a.address, hostname: "hx.northstar.example" };
  a.signIn = {
    ...a.signIn,
    provider: "openid-connect",
    issuer: "https://login.northstar.example",
    clientId: "hx-fortress",
    clientSecret: "sign-in-client-secret",
    administratorGroups: ["hx-fortress-admins"],
    readonlyGroups: ["auditors"],
  };
  a.data.database = { store: "existing", address: "db-url" };
  a.modules.host = true;
  a.controlPlane = { ...a.controlPlane, connect: "yes", address: "control.example" };
  return a;
}

/** Answers with every part filled that a file can hold in this build. */
function everyPart(): SetupAnswers {
  const a = defaultAnswers(MODULES);
  a.organization = { name: "Northstar", firstAdministrator: "marta.lindqvist" };
  a.keys = {
    ...a.keys,
    store: "azure-key-vault",
    // On the machine itself the vault is named by its address. Its name is the install's to give.
    address: "https://northstar-hx-fortress.vault.azure.net",
    clientId: IDENTITY,
  };
  a.address = { hostname: "hx.northstar.example", certificate: "own", certificateName: "hx-fortress-cert" };
  a.signIn = {
    provider: "openid-connect",
    issuer: "https://login.northstar.example",
    clientId: "hx-fortress",
    clientSecret: "sign-in-client-secret",
    groupsClaim: "roles",
    administratorGroups: ["hx-fortress-admins"],
    operatorGroups: ["data-team"],
    readonlyGroups: ["auditors"],
    viewerGroups: ["data-viewers"],
  };
  a.data = {
    database: { store: "existing", address: "db-url" },
    files: {
      store: "s3-compatible",
      address: "https://minio.northstar.example",
      bucket: "northstar-hx-fortress",
      region: "eu-central-1",
      project: "",
      account: "",
      container: "",
    },
  };
  a.modules = { session_vault: true, host: true, databases: false };
  a.model = {
    provider: "openai",
    route: "direct",
    address: "https://models.northstar.example/v1",
    key: "model-key",
    name: "northstar-embed",
    region: "eu-central-1",
    project: "northstar",
  };
  a.controlPlane = { connect: "yes", address: "control.example", token: "install-id", connected: "off", pages: PAGES };
  return a;
}

const parse = (text: string, present: SetupAnswers = defaultAnswers(MODULES), install = false) =>
  parseSettingsFile(text, present, { moduleIds: MODULES, ...(install ? { install: true } : {}) });

const refusalsOf = (text: string, install = false): string[] => {
  const parsed = parse(text, defaultAnswers(MODULES), install);
  return parsed.ok ? [] : parsed.refusals;
};

// ── The list ─────────────────────────────────────────────────────────────────

describe("the setup's list", () => {
  test("it asks its questions in the order of the settings file's keys", () => {
    expect(SETUP_LIST.map((step) => step.id)).toEqual([...STEP_IDS]);
    expect(STEP_IDS).toHaveLength(12);
    for (const step of SETUP_LIST) {
      expect(step.name.length).toBeGreaterThan(0);
      expect(step.question.endsWith("?")).toBe(true);
      expect(step.asked.length).toBeGreaterThan(0);
    }
    // Settings shows the sections it asks, each a step of the list.
    for (const id of SETTINGS_ORDER) expect(STEP_IDS).toContain(id);
  });

  test("every built option of every choice has a check, and an option that is not built has none", () => {
    for (const { block } of choicesOf()) {
      // The path and the ids come from the list.
      const checks = OPTION_CHECKS[block.path] ?? {};
      const built = block.options.filter((o) => o.built).map((o) => o.id).sort();
      expect({ path: block.path, ids: Object.keys(checks).sort() }).toEqual({ path: block.path, ids: built });
    }
    // And no check for a choice the list does not have.
    const paths = new Set(choicesOf().map(({ block }) => block.path));
    for (const path of Object.keys(OPTION_CHECKS)) expect(paths.has(path)).toBe(true);
  });

  test("both sides of every built switch have a check, and a switch that is not built has only its off side", () => {
    for (const { block } of switchesOf()) {
      const checks = SWITCH_CHECKS[block.path] ?? {};
      const sides = block.built ? [block.on, block.off].sort() : [block.off];
      expect({ path: block.path, sides: Object.keys(checks).sort() }).toEqual({ path: block.path, sides });
    }
    const paths = new Set(switchesOf().map(({ block }) => block.path));
    for (const path of Object.keys(SWITCH_CHECKS)) expect(paths.has(path)).toBe(true);
    // Both kinds are in the list today, so the rule is held on each.
    expect(switchesOf().some(({ block }) => block.built)).toBe(true);
    expect(switchesOf().some(({ block }) => !block.built)).toBe(true);
  });

  test("every choice has a built option, and option ids are unique within a choice", () => {
    for (const { block } of choicesOf()) {
      expect(block.options.some((o) => o.built)).toBe(true);
      const ids = block.options.map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  test("the first answer of every choice and every switch is one this build has, and needs no cloud", () => {
    const defaults = defaultAnswers(MODULES);
    for (const { block } of choicesOf()) {
      const chosen = answerText(defaults, block.path);
      // Where it runs is asked by the install, which starts on its own answers.
      if (block.path === "where.place") continue;
      if (chosen === NONE && block.neededBy) continue;
      const option = block.options.find((o) => o.id === chosen);
      expect({ path: block.path, built: option?.built, places: option?.places ?? "any" }).toEqual({
        path: block.path,
        built: true,
        places: option?.places?.includes("here") ? option.places : "any",
      });
    }
    for (const { block } of switchesOf()) {
      const side = answerText(defaults, block.path);
      expect([block.path, side === block.off || (block.built && side === block.on)]).toEqual([block.path, true]);
    }
    expect(defaults.where.place).toBe("here");
    expect(defaults.keys.store).toBe("env");
    expect(defaults.signIn.provider).toBe("local");
    expect(defaults.data.database.store).toBe("beside");
    expect(defaults.controlPlane.connect).toBe("no");
    expect(Object.values(defaults.modules).every((on) => on === false)).toBe(true);
  });

  test("every field's path names an answer, and lies under its own step", () => {
    const answers = defaultAnswers(MODULES);
    for (const step of SETUP_LIST) {
      for (const field of fieldsOfStep(step)) {
        expect({ path: field.path, known: answerAt(answers, field.path) !== undefined }).toEqual({
          path: field.path,
          known: true,
        });
        expect(field.path.split(".")[0]).toBe(step.id);
      }
      for (const block of step.blocks) {
        if (block.kind === "choice" || block.kind === "switch") expect(answerAt(answers, block.path)).toBeDefined();
      }
    }
  });

  test("a key that a person may type has the name it gets in the key store, and that name is a key's name", () => {
    const typed = [...keyFields().values()].filter((field) => field.typedAs);
    expect(typed.map((field) => field.path).sort()).toEqual(["data.database.address", "model.key", "signIn.clientSecret"]);
    for (const field of typed) expect(field.typedAs).toMatch(/^[a-z0-9-]{1,64}$/);
    // The certificate is named, never typed: it is not one string.
    expect(keyFields().get("address.certificateName")?.typedAs).toBeUndefined();
  });
});

describe("the key stores the list offers", () => {
  const options = choiceAt("keys.store")?.options ?? [];

  test("are exactly the key stores this build has: an option is built when its provider is listed", () => {
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect([option.id, option.built]).toEqual([option.id, isSecretProviderKind(option.id)]);
    }
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

  test("a place's own key store, database and file store are options of the list", () => {
    for (const place of PLACES) {
      if (place.keys) expect(choiceAt("keys.store")?.options.map((o) => o.id)).toContain(place.keys);
      if (place.files) expect(choiceAt("data.files.store")?.options.map((o) => o.id)).toContain(place.files);
      expect(isCloudPlace(place.id)).toBe(CLOUD_PLACES.includes(place.id));
    }
    expect(PLACES.map((place) => place.id)).toEqual([...PLACE_IDS]);
  });
});

// ── The list, as each way shows it ───────────────────────────────────────────

describe("the list as a person is shown it, for every way and every place", () => {
  const views = WAYS.flatMap((way) => PLACE_IDS.map((place) => ({ way, place })));

  test("it holds no option that is not built, no option of another place, and every step its way asks", () => {
    for (const { way, place } of views) {
      const shown = visibleList({ way, place, words: wordsOf(startOf(place)) });
      expect([way, place, shown.map((step) => step.id)]).toEqual([way, place, stepsAsked(way)]);
      expect(shown).toHaveLength(stepsAsked(way).length);
      for (const option of optionsOf(shown)) {
        expect([way, place, option.path, option.id, option.built !== false]).toEqual([way, place, option.path, option.id, true]);
        // The list's own entry for the option, with its places.
        const own = choiceAt(option.path)?.options.find((o) => o.id === option.id);
        if (own?.places) expect([way, place, option.id, own.places.includes(place)]).toEqual([way, place, option.id, true]);
      }
      for (const step of shown) {
        for (const block of step.blocks) {
          if (block.kind === "switch") expect([block.path, block.built]).toEqual([block.path, true]);
          if (block.ways) expect(block.ways).toContain(way);
          if (block.places) expect(block.places).toContain(place);
        }
        for (const field of fieldsOfStep(step)) if (field.ways) expect(field.ways).toContain(way);
      }
    }
  });

  test("the roles at an identity provider stand two by two, each field with its label and an example group", () => {
    for (const { way, place } of views) {
      const signIn = visibleList({ way, place, words: wordsOf(startOf(place)) }).find((step) => step.id === "signIn");
      const roles = signIn?.blocks.find((block) => block.kind === "fields" && block.label === "A role for each group");
      if (roles?.kind !== "fields") throw new Error(`${way}, ${place}: the Sign-in step has no block of roles`);
      // Four short fields. One on a line each, they reach the page's foot, so a page draws them in two columns.
      expect([way, place, roles.draw]).toEqual([way, place, "two-by-two"]);
      expect(roles.when).toEqual({ path: "signIn.provider", is: "openid-connect" });
      expect(roles.fields.map((field) => [field.label, field.path, field.example, field.optional === true])).toEqual([
        ["Administrators", "signIn.administratorGroups", "hx-fortress-admins", false],
        ["Operators", "signIn.operatorGroups", "data-team", true],
        ["Auditors, read only", "signIn.readonlyGroups", "auditors", true],
        ["Viewers, see rows only", "signIn.viewerGroups", "data-viewers", true],
      ]);
    }
  });

  test("a block drawn two by two holds only plain fields a person types, and the page draws it with the class its styles lay out", () => {
    const blocks = SETUP_LIST.flatMap((step) =>
      step.blocks.flatMap((block) => (block.kind === "fields" && block.draw === "two-by-two" ? [block] : [])),
    );
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      for (const field of block.fields) {
        // A condition would fold the field away by itself, out of its column; a
        // menu, a tag or a typed key has parts that do not fit half a line.
        expect([field.path, field.kind === "text" || field.kind === "list", field.when, field.options, field.tag, field.typedAs]).toEqual([
          field.path,
          true,
          undefined,
          undefined,
          undefined,
          undefined,
        ]);
      }
    }
    const page = readFileSync(path.join(import.meta.dir, "../ui/src/views/setup/blocks.tsx"), "utf8");
    const styles = readFileSync(path.join(import.meta.dir, "../ui/src/setup.css"), "utf8");
    expect(page).toContain('block.draw === "two-by-two" ? "su-flds two" : "su-flds"');
    expect(styles).toContain(".su-flds.two { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);");
  });

  test("every word in braces is filled in, from the answers", () => {
    for (const { way, place } of views) {
      const shown = stringsOf(visibleList({ way, place, words: wordsOf(startOf(place)) }));
      expect([way, place, shown.filter((text) => text.includes("{") || text.includes("}"))]).toEqual([way, place, []]);
    }
    // Without the words, the braces are there to be filled.
    expect(stringsOf(visibleList({ way: "install", place: "azure" })).some((text) => text.includes("{cloud}"))).toBe(true);
    // A word that is not known stays as it is, so a missing word shows here.
    expect(phrase("Have {cloud} issue a new one", {})).toBe("Have {cloud} issue a new one");
    expect(phrase("Have {cloud} issue a new one", wordsOf(startOf("aws")))).toBe("Have AWS issue a new one");
  });

  test("no sentence a person reads says how many questions there are", () => {
    const counted = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:questions?|steps?)\b/i;
    const read = [
      ...views.flatMap(({ way, place }) => stringsOf(visibleList({ way, place, words: wordsOf(startOf(place)) }))),
      ...stringsOf(LAST_STEP),
      ...stringsOf(PLACES),
    ];
    expect(read.filter((text) => counted.test(text))).toEqual([]);
  });

  test("a key is asked by its name everywhere but in the install, where a person may type it", () => {
    for (const { way, place } of views) {
      for (const step of visibleList({ way, place, words: wordsOf(startOf(place)) })) {
        for (const field of fieldsOfStep(step).filter((f) => f.kind === "key")) {
          expect([way, field.path, field.label.endsWith("by name")]).toEqual([
            way,
            field.path,
            way !== "install" || field.label.endsWith("by name"),
          ]);
        }
      }
    }
    const typedHere = fieldsOfStep(visibleList({ way: "install", place: "azure" }).find((s) => s.id === "model") as SetupStep);
    expect(typedHere.find((f) => f.path === "model.key")?.label).toBe("API key");
  });

  test("in a cloud the cloud's own service leads, and on the machine itself what needs no cloud comes first", () => {
    const keys = (place: PlaceId, way: Way): string[] =>
      choicesOf(visibleList({ way, place })).find(({ block }) => block.path === "keys.store")?.block.options.map((o) => o.id) ?? [];
    expect(keys("azure", "install")).toEqual(["azure-key-vault", "env", "file"]);
    expect(keys("google-cloud", "install")).toEqual(["google-secret-manager", "env", "file"]);
    expect(keys("aws", "install")).toEqual(["env", "file"]);
    expect(keys("here", "setup")).toEqual(["env", "file", "azure-key-vault", "google-secret-manager"]);
    const database = (place: PlaceId): string[] =>
      choicesOf(visibleList({ way: "install", place })).find(({ block }) => block.path === "data.database.store")?.block.options.map((o) => o.id) ?? [];
    expect(database("google-cloud")).toEqual(["managed", "beside", "existing"]);
    expect(database("docker")).toEqual(["beside", "existing"]);
  });

  test("each cloud offers its own regions, and the first page offers the places of an install", () => {
    for (const place of CLOUD_PLACES) {
      const where = choicesOf(visibleList({ way: "install", place })).find(({ block }) => block.path === "where.place");
      const field = where?.block.options.find((o) => o.id === place)?.fields?.[0];
      expect(field?.options?.map((o) => o.id)).toEqual(placeInfo(place).regions.map((r) => r.id));
      expect(where?.block.options.map((o) => o.id)).toEqual([...INSTALL_PLACES]);
    }
  });
});

describe("the words a person reads in the list", () => {
  const read = [
    ...stringsOf(SETUP_LIST),
    ...WAYS.flatMap((way) => PLACE_IDS.flatMap((place) => stringsOf(visibleList({ way, place, words: wordsOf(startOf(place)) })))),
    ...stringsOf(PLACES),
    ...stringsOf(LAST_STEP),
  ];

  test("the product is always named HX Fortress, in full", () => {
    expect(read.filter((text) => /(?<!HX )Fortress/.test(text))).toEqual([]);
    // The product's name is there to be found.
    expect(read.some((text) => text.includes("HX Fortress"))).toBe(true);
  });

  test("the module is always named Agentic Sessions, in full", () => {
    expect(read.filter((text) => /(?<!Agentic )Sessions/.test(text))).toEqual([]);
  });

  test("no string names a vendor of a control plane", () => {
    const vendor = RULES.filter((rule) => rule.id === "vendor");
    expect(vendor).toHaveLength(1);
    const findings = read.flatMap((text) => scanText("the setup's list", text, [], new Map(), vendor));
    expect(findings).toEqual([]);
  });
});

// ── One answer, by its path ──────────────────────────────────────────────────

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
    expect(setAnswer(a, "modules.not_a_module", true)).toBe(false);
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

// ── The settings file ────────────────────────────────────────────────────────

describe("the settings file", () => {
  test("it has one key per question, and gives a key by its name", () => {
    const file = answersToFile(northstar());
    // Where it runs is a question of the install only.
    expect(Object.keys(file)).toEqual(["version", ...STEP_IDS.filter((id) => id !== "where")]);
    expect(file.signIn.clientSecret).toEqual({ key: "sign-in-client-secret" });
    expect(file.data.database).toEqual({ store: "existing", address: { key: "db-url" } });
    expect(file.data.files).toBe(false);
    expect(file.model).toBe(false);
    expect(file.network).toEqual({ proxy: false });
    expect(file.updates).toEqual({ securityFixes: false });
    expect(file.auditTrail).toEqual({ keepFor: "until-removed", copyTo: false });
    expect(file.controlPlane).toEqual({ address: "control.example", connected: true });
    expect(file.modules).toEqual({ databases: false, host: true, session_vault: false });
    expect(file.address).toEqual({ hostname: "hx.northstar.example", certificate: false });
    // The install's file says where it runs.
    expect(Object.keys(answersToFile(installAnswers("azure", MODULES)))).toEqual(["version", ...STEP_IDS]);
  });

  test("it holds only the fields of the option that was chosen", () => {
    const a = northstar();
    a.keys.address = "https://left-over.vault.azure.net";
    a.data.files = { ...a.data.files, bucket: "left-over" };
    expect(answersToFile(a).keys).toEqual({ store: "file", folder: "/run/secrets" });
    a.signIn.provider = "local";
    expect(answersToFile(a).signIn).toEqual({ provider: "local" });
    a.address.certificateName = "left-over";
    expect(answersToFile(a).address).toEqual({ hostname: "hx.northstar.example", certificate: false });
  });

  test("what is written reads back as the same answers: the first answers, each place's, and every part filled", () => {
    const back = (a: SetupAnswers, install = false): SetupAnswers | string[] => {
      const parsed = parse(settingsFileText(a), defaultAnswers(MODULES), install);
      return parsed.ok ? parsed.answers : parsed.refusals;
    };
    expect(back(defaultAnswers(MODULES))).toEqual(defaultAnswers(MODULES));
    for (const place of INSTALL_PLACES) {
      const a = installAnswers(place, MODULES, { on: ["host", "databases"] });
      expect([place, back(a, true)]).toEqual([place, a]);
    }
    expect(back(everyPart())).toEqual(everyPart());
    // The install's, with every part of where it runs.
    const docker = installAnswers("docker", MODULES);
    docker.where.ssh = "marta@hx-fortress-vm.northstar.example";
    docker.organization = { name: "Northstar", firstAdministrator: "marta.lindqvist" };
    docker.address = { hostname: "hx.northstar.example", certificate: "own", certificateName: "hx-fortress-cert" };
    docker.keys = { ...docker.keys, store: "file", folder: "/run/secrets" };
    expect(back(docker, true)).toEqual(docker);
    const azure = installAnswers("azure", MODULES);
    azure.where.region = "westeurope";
    azure.keys.vault = "northstar-hx-fortress";
    expect(back(azure, true)).toEqual(azure);
  });

  test("the viewers' groups are written only when there are some, a file without them reads as none, and a role nobody has is refused", () => {
    const a = everyPart();
    const roles = (answers: SetupAnswers): unknown => (answersToFile(answers).signIn as { roles?: unknown }).roles;
    expect(roles(a)).toEqual({
      administrator: ["hx-fortress-admins"],
      operator: ["data-team"],
      readonly: ["auditors"],
      viewer: ["data-viewers"],
    });
    a.signIn.viewerGroups = [];
    expect(roles(a)).toEqual({ administrator: ["hx-fortress-admins"], operator: ["data-team"], readonly: ["auditors"] });
    const back = parse(settingsFileText(a), defaultAnswers(MODULES));
    expect(back.ok && back.answers.signIn.viewerGroups).toEqual([]);

    const file = JSON.parse(settingsFileText(a)) as { signIn: { roles: Record<string, string[]> } };
    file.signIn.roles.owner = ["everyone"];
    const refused = parse(JSON.stringify(file), defaultAnswers(MODULES));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusals.join("\n")).toContain("signIn.roles");
  });

  test("a field belongs to the ways that ask it: an install takes no address for its vault, and a machine no name for one", () => {
    const inInstall = parse(
      JSON.stringify({
        keys: { store: "azure-key-vault", vault: "northstar-hx-fortress", address: "https://another.vault.azure.net" },
      }),
      installAnswers("azure", MODULES),
      true,
    );
    expect(inInstall.ok).toBe(false);
    if (!inInstall.ok) {
      expect(inInstall.refusals).toEqual([
        "keys.address is asked by a setup on the machine that runs HX Fortress, and not here",
      ]);
    }
    const onTheMachine = parse(
      JSON.stringify({
        keys: {
          store: "azure-key-vault",
          vault: "northstar-hx-fortress",
          address: "https://northstar-hx-fortress.vault.azure.net",
        },
      }),
      defaultAnswers(MODULES),
    );
    expect(onTheMachine.ok).toBe(false);
    if (!onTheMachine.ok) expect(onTheMachine.refusals).toEqual(["keys.vault is asked by hx-fortress install, and not here"]);
  });

  test("a name in a list is one name: one that holds a comma is refused, and is not read as two groups", () => {
    const file = JSON.parse(settingsFileText(everyPart())) as { signIn: { roles: Record<string, string[]> } };
    file.signIn.roles.administrator = ["CN=hx-admins,OU=Groups"];
    const parsed = parse(JSON.stringify(file), defaultAnswers(MODULES));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.refusals).toEqual([
        "signIn.roles.administrator: a name cannot hold a comma. Give each name as its own item",
      ]);
    }
  });

  test("a file that names the place the answers already have moves no other answer, and another place moves them", () => {
    const present = installAnswers("azure", MODULES);
    present.data.database = { store: "existing", address: "db-url" };
    present.address.certificate = "own";
    present.address.certificateName = "hx-fortress-cert";
    const same = parse(JSON.stringify({ where: { place: "azure" } }), present, true);
    expect(same.ok).toBe(true);
    if (same.ok) {
      expect(same.answers.data.database).toEqual({ store: "existing", address: "db-url" });
      expect(same.answers.address.certificate).toBe("own");
      expect(same.answers.keys.store).toBe(present.keys.store);
      // A region the file leaves out is the place's first one, as on the page.
      expect(same.answers.where.region).toBe(present.where.region);
    }
    const moved = parse(
      JSON.stringify({ where: { place: "docker", ssh: "marta@hx-fortress-vm.northstar.example" } }),
      present,
      true,
    );
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      expect(moved.answers.data.database.store).toBe("beside");
      expect(moved.answers.keys.store).toBe("env");
    }
  });

  test("a question the file leaves out keeps its present answer, and one it gives is taken whole", () => {
    const present = northstar();
    const parsed = parse(JSON.stringify({ organization: { name: "Tallgrass Title" } }), present);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.answers.organization).toEqual({ name: "Tallgrass Title", firstAdministrator: "" });
    expect(parsed.answers.keys).toEqual(present.keys);
    expect(parsed.given).toEqual(["organization"]);
  });

  test("a key the list does not know is refused by name, at the top and in a block", () => {
    const said = refusalsOf(JSON.stringify({ organisation: { name: "x" }, keys: { store: "env", folders: "/x" } })).join("\n");
    expect(said).toContain(`organisation is not a question of the setup. The questions are ${STEP_IDS.join(", ")}`);
    expect(said).toContain("keys.folders is not a setting. keys takes store, folder, address, clientId, region, project, vault");
    // One that is not a word is not repeated.
    const pasted = refusalsOf(JSON.stringify({ [`postgres://user:${PASTED_KEY}@db/x`]: true })).join("\n");
    expect(pasted).toContain("a key is not a question of the setup");
    expect(pasted).not.toContain(PASTED_KEY);
  });

  test("an option that does not exist, and one that is not in this build yet, are refused in plain words", () => {
    expect(refusalsOf(JSON.stringify({ keys: { store: "a-vault-of-dreams" } }))).toEqual([
      "keys.store must be one of azure-key-vault, google-secret-manager, env, file",
    ]);
    expect(refusalsOf(JSON.stringify({ keys: { store: "aws-secrets-manager" } }))).toEqual([
      "keys.store: AWS Secrets Manager is not in this build yet. It can be azure-key-vault, google-secret-manager, env, file",
    ]);
    expect(refusalsOf(JSON.stringify({ auditTrail: { copyTo: { to: "syslog", address: "syslog.northstar.example" } } }))).toEqual([
      "auditTrail.copyTo.to: Syslog is not in this build yet. It can be none",
    ]);
    expect(refusalsOf(JSON.stringify({ auditTrail: { keepFor: "7-years" } }))).toEqual([
      "auditTrail.keepFor: 7 years is not in this build yet. It can be until-removed",
    ]);
    expect(refusalsOf(JSON.stringify({ updates: { securityFixes: true } }))).toEqual([
      "updates.securityFixes: security fixes that install by themselves are not in this build yet. It can be false",
    ]);
    expect(refusalsOf(JSON.stringify({ network: { proxy: "http://proxy.northstar.example:3128" } }))).toEqual([
      "network.proxy: a proxy is not in this build yet. It can be false",
    ]);
    expect(refusalsOf(JSON.stringify({ model: { provider: "anthropic", route: "amazon-bedrock" } }))).toEqual([
      "model.route must be one of direct",
    ]);
    // An id an earlier build wrote is no option any more.
    expect(refusalsOf(JSON.stringify({ data: { database: { store: "postgres" } } }))).toEqual([
      "data.database.store must be one of managed, beside, existing",
    ]);
  });

  test("a value where a key's name belongs is refused, and no refusal repeats it", () => {
    const address = ["postgres://admin:", "hunter2-not-a-real-one", "@db.northstar.example/hx"].join("");
    for (const given of [address, { key: address }, { key: "db-url", value: address }, 7]) {
      const said = refusalsOf(JSON.stringify({ data: { database: { store: "existing", address: given } } })).join("\n");
      expect(said).toContain("data.database.address");
      expect(said).not.toContain("hunter2");
      expect(said).not.toContain("northstar.example");
    }
    // A key pasted where its name belongs, in each place that takes a name.
    for (const file of [
      { model: { provider: "openai", key: PASTED_KEY } },
      { model: { provider: "openai", key: { key: PASTED_KEY } } },
      { signIn: { provider: "openid-connect", clientSecret: { key: PASTED_KEY } } },
      { address: { hostname: "hx.northstar.example", certificate: "own", certificateName: PASTED_KEY } },
      { controlPlane: { address: "control.example", connected: true, token: { key: PASTED_KEY } } },
    ]) {
      const said = refusalsOf(JSON.stringify(file));
      expect(said.length).toBeGreaterThan(0);
      expect(said.join("\n")).not.toContain(PASTED_KEY);
      expect(said.join("\n")).not.toContain("Xq7");
    }
  });

  test("a file cannot give the control plane's key: nothing in this build would hold HX Fortress to it", () => {
    const said = refusalsOf(
      JSON.stringify({
        controlPlane: {
          address: "control.example",
          connected: true,
          key: { id: "cp-2026-11", publicKey: ["2Mky", "pwQYWd8sFrN2hvhWzkf4gf6wg8KFB50Njy", "l5Os"].join("_") },
        },
      }),
    );
    expect(said).toEqual(["controlPlane.key is not a setting. controlPlane takes address, connected, pages, token"]);
  });

  test("where it runs is a question of the install, and a file for the machine itself may not give it", () => {
    const file = JSON.stringify({ where: { place: "azure", region: "westeurope" } });
    expect(refusalsOf(file)).toEqual([
      "where is asked by hx-fortress install. A setup on the machine itself runs HX Fortress on that machine",
    ]);
    const install = parse(file, installAnswers("aws", MODULES), true);
    expect(install.ok).toBe(true);
    if (install.ok) expect(install.answers.where).toEqual({ place: "azure", region: "westeurope", ssh: "" });
    expect(refusalsOf(JSON.stringify({ where: { place: "here" } }), true)).toEqual([
      "where.place must be one of azure, aws, google-cloud, docker",
    ]);
  });

  test("a module that is not in this build is refused", () => {
    expect(refusalsOf(JSON.stringify({ modules: { stores: true } }))[0]).toContain(
      "modules.stores is not a module of this build",
    );
  });

  test("text that is not one JSON object is refused", () => {
    for (const text of ["", "not json", "[]", "null", '"x"']) expect(parse(text).ok).toBe(false);
    expect(refusalsOf(JSON.stringify({ version: 2 }))).toEqual(["version must be 1"]);
  });
});

// ── The answers that follow another ──────────────────────────────────────────

describe("the answers that follow the place", () => {
  /** What a person typed, which no place may clear. */
  function typedInto(a: SetupAnswers): void {
    a.organization = { name: "Northstar", firstAdministrator: "marta.lindqvist" };
    a.where.ssh = "marta@hx-fortress-vm.northstar.example";
    a.keys.vault = "northstar-own-vault";
    a.keys.folder = "/run/secrets";
    a.address.hostname = "hx.northstar.example";
    a.address.certificateName = "hx-fortress-cert";
    a.signIn = { ...a.signIn, issuer: "https://login.northstar.example", clientId: "hx-fortress", clientSecret: "sign-in-client-secret" };
    a.data.database.address = "db-url";
    a.model.key = "model-key";
  }

  /** The place's own key store, certificate, database and file store, where this build has them. */
  function ownServices(place: PlaceId): { keys: string; certificate: string; database: string; files: string } {
    const info = placeInfo(place);
    const built = (path: string, id: string | undefined): boolean =>
      id !== undefined && choiceAt(path)?.options.find((o) => o.id === id)?.built === true;
    const cloud = isCloudPlace(place);
    return {
      keys: built("keys.store", info.keys) ? (info.keys as string) : "env",
      certificate: cloud ? "cloud-issued" : "own",
      database: cloud ? "managed" : "beside",
      files: built("data.files.store", info.files) ? (info.files as string) : NONE,
    };
  }

  test("a new place moves the key store, the certificate, the database and the file store to its own, and clears nothing typed", () => {
    for (const from of INSTALL_PLACES) {
      for (const to of INSTALL_PLACES) {
        const a = installAnswers(from, MODULES);
        typedInto(a);
        const before = structuredClone(a);
        a.where.place = to;
        settleAnswers(a, "where.place", undefined, { before, install: true });
        expect([from, to, { keys: a.keys.store, certificate: a.address.certificate, database: a.data.database.store, files: a.data.files.store }]).toEqual([
          from,
          to,
          ownServices(to),
        ]);
        expect(placeInfo(to).regions.some((r) => r.id === a.where.region) || placeInfo(to).regions.length === 0).toBe(true);
        // Nothing a person typed is cleared.
        expect(a.organization).toEqual(before.organization);
        expect(a.where.ssh).toBe(before.where.ssh);
        expect([a.keys.vault, a.keys.folder]).toEqual(["northstar-own-vault", "/run/secrets"]);
        expect([a.address.hostname, a.address.certificateName]).toEqual(["hx.northstar.example", "hx-fortress-cert"]);
        expect(a.signIn).toEqual(before.signIn);
        expect([a.data.database.address, a.model.key]).toEqual(["db-url", "model-key"]);
      }
    }
  });

  test("each place's first answers are its own services", () => {
    for (const place of INSTALL_PLACES) {
      const a = installAnswers(place, MODULES);
      expect([place, { keys: a.keys.store, certificate: a.address.certificate, database: a.data.database.store, files: a.data.files.store }]).toEqual([
        place,
        ownServices(place),
      ]);
      expect(a.model.provider).toBe("anthropic");
      expect(routesOf(a.model.provider)).toContain(a.model.route);
    }
  });

  test("a new provider takes a route this build has for it", () => {
    const a = installAnswers("azure", MODULES);
    a.model.route = "amazon-bedrock";
    a.model.provider = "openai";
    settleAnswers(a, "model.provider");
    expect(a.model.route).toBe("direct");
    expect(routesOf("openai")).toEqual(["direct"]);
    expect(routesOf(NONE)).toEqual([]);
  });
});

describe("two answers of an install start as a suggestion", () => {
  /** Change one answer as a page or the run does: set it, then settle what follows it. */
  function change(a: SetupAnswers, at: string, value: string, install = true): void {
    const before = structuredClone(a);
    setAnswer(a, at, value);
    settleAnswers(a, at, undefined, { before, install });
  }

  test("the vault's name follows the organization's name", () => {
    expect(vaultNameFor("Northstar")).toBe("northstar-hx-fortress");
    const a = installAnswers("azure", MODULES);
    expect(a.keys.vault).toBe("");
    change(a, "organization.name", "Northstar");
    expect(a.keys.vault).toBe("northstar-hx-fortress");
    change(a, "organization.name", "Tallgrass Title Company");
    expect(a.keys.vault).toBe(vaultNameFor("Tallgrass Title Company"));
    // Short enough for a vault, and of its letters.
    expect(a.keys.vault).toMatch(/^[a-z][a-z0-9-]{2,23}$/);
    expect(vaultNameFor("2026 Holdings")).toBe("");
  });

  test("the address follows the first administrator's email address", () => {
    expect(hostnameFor("marta.lindqvist@northstar.example")).toBe("hx.northstar.example");
    expect(hostnameFor("marta.lindqvist")).toBe("");
    const a = installAnswers("aws", MODULES);
    change(a, "organization.firstAdministrator", "marta.lindqvist@northstar.example");
    expect(a.address.hostname).toBe("hx.northstar.example");
    change(a, "organization.firstAdministrator", "marta@tallgrass.example");
    expect(a.address.hostname).toBe("hx.tallgrass.example");
  });

  test("once a person typed another value, it never changes again", () => {
    const a = installAnswers("azure", MODULES);
    change(a, "organization.name", "Northstar");
    change(a, "organization.firstAdministrator", "marta.lindqvist@northstar.example");
    change(a, "keys.vault", "northstar-own-vault");
    change(a, "address.hostname", "data.northstar.example");
    for (const [name, login] of [
      ["Tallgrass Title", "marta@tallgrass.example"],
      ["Northstar", "marta.lindqvist@northstar.example"],
    ] as const) {
      change(a, "organization.name", name);
      change(a, "organization.firstAdministrator", login);
      expect([a.keys.vault, a.address.hostname]).toEqual(["northstar-own-vault", "data.northstar.example"]);
    }
    // A new place keeps them too.
    change(a, "where.place", "google-cloud");
    expect([a.keys.vault, a.address.hostname]).toEqual(["northstar-own-vault", "data.northstar.example"]);
  });

  test("an emptied field takes the suggestion again", () => {
    const a = installAnswers("azure", MODULES);
    change(a, "organization.name", "Northstar");
    change(a, "keys.vault", "");
    change(a, "organization.name", "Northstar Analytics");
    expect(a.keys.vault).toBe(vaultNameFor("Northstar Analytics"));
  });

  test("neither applies on the machine itself, also on one that an install made", () => {
    const here = defaultAnswers(MODULES);
    change(here, "organization.name", "Northstar", false);
    change(here, "organization.firstAdministrator", "marta.lindqvist@northstar.example", false);
    expect([here.keys.vault, here.address.hostname]).toEqual(["", ""]);
    // An HX Fortress the install made runs in its place, and is set up on the machine itself.
    const made = installAnswers("azure", MODULES);
    made.organization = { name: "Northstar", firstAdministrator: "marta.lindqvist@northstar.example" };
    made.keys.vault = "northstar-hx-fortress";
    made.address.hostname = "hx.northstar.example";
    change(made, "organization.name", "Northstar Analytics", false);
    change(made, "organization.firstAdministrator", "marta@tallgrass.example", false);
    expect([made.keys.vault, made.address.hostname]).toEqual(["northstar-hx-fortress", "hx.northstar.example"]);
    // And the place "here" has neither, whoever asks.
    const plain = defaultAnswers(MODULES);
    change(plain, "organization.name", "Northstar", true);
    expect(plain.keys.vault).toBe("");
  });
});

// ── The control plane's address ──────────────────────────────────────────────

describe("the control plane's address", () => {
  test("a host becomes a secure connection at the protocol's path", () => {
    expect(controlPlaneUrl("control.example")).toEqual({ ok: true, url: `wss://control.example${CONTROL_PLANE_PATH}` });
    expect(CONTROL).toBe(`wss://control.example${CONTROL_PLANE_PATH}`);
    expect(controlPlaneUrl(" https://control.example/base/ ")).toEqual({
      ok: true,
      url: `wss://control.example/base${CONTROL_PLANE_PATH}`,
    });
  });

  test("an address that is already a connection is kept as typed", () => {
    expect(controlPlaneUrl("wss://control.example/own/path")).toEqual({ ok: true, url: "wss://control.example/own/path" });
  });

  test("cleartext is accepted to this host only", () => {
    expect(controlPlaneUrl("http://localhost:9000/base")).toEqual({
      ok: true,
      url: `ws://localhost:9000/base${CONTROL_PLANE_PATH}`,
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

  test("a stored connection reads back as what a person would type, at this path and at the earlier one", () => {
    for (const typed of ["control.example", "control.example/base", "http://localhost:9000/base"]) {
      const parsed = controlPlaneUrl(typed);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(controlPlaneAddress(parsed.url)).toBe(typed);
    }
    expect(EARLIER_CONTROL).toBe(`wss://control.example${EARLIER_CONTROL_PLANE_PATH}`);
    expect(controlPlaneAddress(EARLIER_CONTROL)).toBe("control.example");
    expect(controlPlaneAddress("wss://control.example/own/path")).toBe("wss://control.example/own/path");
  });

  test("the earlier path is the same control plane, and another host is not", () => {
    expect(sameControlPlane(CONTROL, EARLIER_CONTROL)).toBe(true);
    expect(sameControlPlane(EARLIER_CONTROL, CONTROL)).toBe(true);
    expect(sameControlPlane(CONTROL, "wss://other.example/v1/connection")).toBe(false);
    expect(sameControlPlane(EARLIER_CONTROL, "wss://other.example/_api/hx-gateway/vault-tunnel")).toBe(false);
    expect(sameControlPlane("wss://control.example/own/path", CONTROL)).toBe(false);
  });

  test("--connect names a control plane and its one-time install id, and a refusal repeats neither", () => {
    expect(parseConnect(`control.example/i/${INSTALL_ID}`)).toEqual({
      ok: true,
      connect: { address: "control.example", id: INSTALL_ID },
    });
    expect(parseConnect(`https://control.example/i/${INSTALL_ID}`, `${PAGES}/`)).toEqual({
      ok: true,
      connect: { address: "control.example", id: INSTALL_ID, pages: PAGES },
    });
    for (const value of [`control.example/${INSTALL_ID}`, `control.example/i/${PASTED_KEY}?x=1`, "", null]) {
      const parsed = parseConnect(value);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toContain(CONNECT_SHAPE);
        expect(parsed.reason).not.toContain(INSTALL_ID);
        expect(parsed.reason).not.toContain("Xq7");
      }
    }
    const pages = parseConnect(`control.example/i/${INSTALL_ID}`, "https://app.control.example/pages");
    expect(pages).toEqual({ ok: false, reason: "--pages needs one origin, written as https://host, with no path" });
  });
});

// ── What the answers add up to ───────────────────────────────────────────────

describe("what the answers add up to", () => {
  test("the addresses are worked out from the answers, each with its reason", () => {
    const rows = reachOf(northstar(), { needsFiles: false });
    expect(rows.map((row) => [row.address, row.why])).toEqual([
      ["the address in db-url", "database"],
      ["login.northstar.example", "sign-in"],
      // A provider may keep its keys and tokens at other hosts than its issuer's.
      ["the addresses this provider names for its keys and tokens", "sign-in"],
      // A new version is downloaded through the control plane in this build,
      // so the Updates answer adds no address of its own.
      ["control.example", "control plane, new versions"],
    ]);
    // Only an https origin the setup can ask is probed.
    expect(rows.map((row) => row.probe)).toEqual([null, "https://login.northstar.example", null, null]);
    // A control plane that is switched off is called by nothing.
    const off = northstar();
    off.controlPlane.connected = "off";
    expect(reachOf(off, { needsFiles: false }).map((row) => row.why)).not.toContain("control plane, new versions");
  });

  test("a model with no address is asked at its provider's own, and the list says so", () => {
    const a = northstar();
    a.model = { ...a.model, provider: "openai", address: "", key: "model-key" };
    expect(reachOf(a, { needsFiles: false }).map((row) => [row.address, row.why])).toContainEqual([
      new URL(DEFAULT_MODEL_ADDRESS).host,
      "AI model",
    ]);
    // One address, in the file a page can import and in the host's own code.
    expect(DEFAULT_MODEL_ADDRESS).toBe(DEFAULT_OPENAI_BASE_URL);
    a.model.provider = "anthropic";
    expect(reachOf(a, { needsFiles: false }).map((row) => row.address)).toContain("api.anthropic.com");
  });

  test("Postgres on this machine's disk is downloaded once, and the list says from where", () => {
    const a = northstar();
    a.data.database = { store: "beside", address: "" };
    expect(reachOf(a, { needsFiles: false }).map((row) => [row.address, row.why])).toContainEqual([
      DATABASE_PROGRAM_HOST,
      "database program, once",
    ]);
    expect(new URL(DEFAULT_PG_BINARIES_URL).host).toBe(DATABASE_PROGRAM_HOST);
    // A database the install makes beside HX Fortress elsewhere is not downloaded here.
    const elsewhere = installAnswers("docker", MODULES);
    expect(reachOf(elsewhere, { needsFiles: false }).map((row) => row.why)).not.toContain("database program, once");
  });

  test("the words over the list say how many addresses, and claim no more than this build holds to", () => {
    expect(REACH_IS_HELD).toBe(false);
    expect(reachLabel(1)).toBe("1 address");
    expect(reachLabel(5)).toBe("5 addresses");
    for (const count of [0, 1, 5]) expect(reachLabel(count)).not.toContain("and no other");
  });

  test("a file store nothing uses calls nothing", () => {
    const a = northstar();
    a.data.files = { ...a.data.files, store: "s3-compatible", address: "https://minio.northstar.example", bucket: "b" };
    expect(reachOf(a, { needsFiles: false }).map((row) => row.why)).not.toContain("files");
    expect(reachOf(a, { needsFiles: true }).map((row) => row.why)).toContain("files");
  });

  test("the summary says each answer in a few words", () => {
    const lines = summaryLines(northstar(), {
      moduleTitles: { session_vault: "Agentic Sessions", host: "Host", databases: "Databases" },
      reachCount: 3,
    });
    expect(lines).toEqual({
      where: "This machine",
      organization: "Northstar · marta.lindqvist",
      keys: "A folder of files",
      address: "hx.northstar.example · None. A proxy or load balancer in front holds it",
      signIn: "login.northstar.example",
      modules: "Host",
      data: "Connect to an existing Postgres",
      model: "None",
      network: "3 addresses",
      updates: "An administrator approves each",
      controlPlane: "control.example, as Northstar",
      auditTrail: "Until removed by hand",
    });
  });

  test("an install's plan has one row for each thing it makes, in the order it is made", () => {
    const plan = (place: PlaceId): ReturnType<typeof installPlan> => {
      const a = installAnswers(place, MODULES, { on: ["host", "databases"] });
      a.organization = { name: "Northstar", firstAdministrator: "marta.lindqvist" };
      a.keys.vault = "northstar-hx-fortress";
      a.address.hostname = "hx.northstar.example";
      a.where.ssh = "marta@hx-fortress-vm.northstar.example";
      a.address.certificateName = place === "docker" ? "hx-fortress-cert" : "";
      return installPlan(a, { needsFiles: false });
    };
    const azure = plan("azure");
    expect(azure.heading).toBe("In your Azure, East US 2");
    expect(azure.rows).toEqual([
      { id: "container", label: "Azure Container Apps", value: "hx-fortress, 1 copy" },
      { id: "disk", label: "Disk", value: "32 GB" },
      { id: "keys", label: "Azure Key Vault", value: "northstar-hx-fortress" },
      { id: "database", label: "Azure Database for PostgreSQL", value: "reached only by HX Fortress" },
      { id: "dns", label: "DNS record", value: "hx.northstar.example" },
      { id: "certificate", label: "SSL certificate", value: "from Azure, renewed by Azure" },
      { id: "open", label: "On the internet", value: "https://hx.northstar.example" },
    ]);
    // A key store this build cannot make in AWS yet is not made there.
    expect(plan("aws").rows.map((row) => row.id)).toEqual(["container", "disk", "database", "dns", "certificate", "open"]);
    const docker = plan("docker");
    expect(docker.heading).toBe("On hx-fortress-vm.northstar.example");
    expect(docker.rows.map((row) => [row.id, row.value])).toEqual([
      ["container", "hx-fortress, 1 copy, on hx-fortress-vm.northstar.example"],
      ["disk", "32 GB"],
      ["database", "a second container"],
      ["dns", "hx.northstar.example"],
      ["certificate", "yours, hx-fortress-cert"],
      ["open", "https://hx.northstar.example"],
    ]);
    for (const place of INSTALL_PLACES) {
      for (const row of plan(place).rows) expect(PLAN_ROW_IDS).toContain(row.id as (typeof PLAN_ROW_IDS)[number]);
    }
  });

  test("the picture beside each page lights up its own part", () => {
    expect(PICTURE_PART.organization).toBe("hx-fortress");
    expect(PICTURE_PART.modules).toBe("hx-fortress");
    const picture = pictureOf(northstar(), { moduleTitles: { host: "Host" } });
    expect(picture.band).toBe("This machine");
    expect(picture.calls.map((call) => [call.id, call.name])).toEqual([
      ["controlPlane", "control.example"],
      ["signIn", "Identity provider"],
    ]);
    expect([picture.address, picture.lock, picture.via]).toEqual(["https://hx.northstar.example", false, "through your proxy"]);
    const azure = installAnswers("azure", MODULES);
    // An install with no address yet is still reached over https, once it has one.
    expect(pictureOf(azure, { moduleTitles: {} })).toMatchObject({ address: "no address yet", via: "https" });
    azure.address.hostname = "hx.northstar.example";
    expect(pictureOf(azure, { moduleTitles: {} })).toMatchObject({ band: "Your Azure · East US 2", lock: true, via: "https" });
    // Only the machine itself answers on that machine alone.
    expect(pictureOf(defaultAnswers(MODULES), { moduleTitles: {} })).toMatchObject({
      address: "this machine only",
      via: "on this machine",
      lock: false,
    });
  });
});
