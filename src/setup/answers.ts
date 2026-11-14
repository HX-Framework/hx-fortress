// The answers to the setup's questions, and the settings file that holds
// them.
//
// TWO SHAPES, one meaning. In memory an answer is a flat record per question:
// every field is there, and a field the chosen option does not use is empty.
// That is what the browser, the terminal and the checks work with, because a
// field is then always a string at a path. On disk the settings file is the
// shape a person writes by hand: `false` where the answer is "none", a key's
// name as `{ "key": "db-url" }`, and only the fields of the option that was
// chosen. `answersToFile` and `parseSettingsFile` are the two directions.
//
// A SETTINGS FILE HOLDS NO KEY. Where a key is needed, the file gives the name
// the key has in the organization's key store. A value written where a name
// belongs is refused, and the refusal does not repeat it.
//
// Free of Node: the console's pages import the types here.

import { isSecretName } from "../secrets/types";
import { NONE, SETUP_LIST, STEP_IDS, choiceAt, type SetupStep, type StepId } from "./list";

export interface SetupAnswers {
  organization: {
    name: string;
    /** The login of the first console account. Empty: none is made. */
    firstAdministrator: string;
  };
  keys: {
    store: string;
    folder: string;
    address: string;
    clientId: string;
    region: string;
    project: string;
  };
  signIn: {
    provider: string;
    issuer: string;
    clientId: string;
    /** The NAME of the key that holds the client secret. Empty: a public client. */
    clientSecret: string;
    groupsClaim: string;
    operatorGroups: string[];
    readonlyGroups: string[];
    /** The console's own https address. Empty: this host only. */
    consoleAddress: string;
  };
  data: {
    database: {
      store: string;
      /** The NAME of the key that holds the database's address. */
      address: string;
    };
    files: {
      store: string;
      address: string;
      bucket: string;
      region: string;
      project: string;
      account: string;
      container: string;
    };
  };
  /** One switch for each module id. */
  modules: Record<string, boolean>;
  model: {
    provider: string;
    address: string;
    /** The NAME of the model's key. */
    key: string;
    name: string;
    region: string;
    project: string;
  };
  network: { route: string; proxy: string };
  records: { copyTo: string; copyAddress: string; keepFor: string };
  updates: { from: string; address: string; install: string };
  controlPlane: {
    connect: string;
    address: string;
    /** The NAME of a key that holds a one-time enrollment token, for a setup
     *  with nobody at the screen. Empty: a person signs in at the control plane. */
    token: string;
  };
}

export const DEFAULT_GROUPS_CLAIM = "groups";

/** Where the Fortress sends its questions to the model when the answer gives
 *  no address. The host's own constant (`DEFAULT_OPENAI_BASE_URL`), written
 *  again here because this file is free of Node: a test holds the two together. */
export const DEFAULT_MODEL_ADDRESS = "https://api.openai.com/v1";

/** The answers of an install nobody has set up: every question on its plain
 *  option, which needs no cloud, no key and no outside service. */
export function defaultAnswers(moduleIds: readonly string[] = []): SetupAnswers {
  return {
    organization: { name: "", firstAdministrator: "" },
    keys: { store: "env", folder: "", address: "", clientId: "", region: "", project: "" },
    signIn: {
      provider: "local",
      issuer: "",
      clientId: "",
      clientSecret: "",
      groupsClaim: DEFAULT_GROUPS_CLAIM,
      operatorGroups: [],
      readonlyGroups: [],
      consoleAddress: "",
    },
    data: {
      database: { store: "this-disk", address: "" },
      files: { store: NONE, address: "", bucket: "", region: "", project: "", account: "", container: "" },
    },
    modules: Object.fromEntries(moduleIds.map((id) => [id, false])),
    model: { provider: NONE, address: "", key: "", name: "", region: "", project: "" },
    network: { route: "direct", proxy: "" },
    records: { copyTo: NONE, copyAddress: "", keepFor: "until-removed" },
    updates: { from: "project-releases", address: "", install: "administrator-approves" },
    controlPlane: { connect: "no", address: "", token: "" },
  };
}

export function cloneAnswers(answers: SetupAnswers): SetupAnswers {
  return JSON.parse(JSON.stringify(answers)) as SetupAnswers;
}

// ── One answer, by its path ──────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object's own key, and never one it inherits. Written this way because
 *  the console's build reads this file with an older language library. */
function own(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** The value at a dotted path, or undefined when the path names nothing. */
export function answerAt(answers: SetupAnswers, path: string): string | boolean | string[] | undefined {
  let node: unknown = answers;
  for (const part of path.split(".")) {
    if (!isRecord(node) || !own(node, part)) return undefined;
    // `part` is checked to be an own key of a plain record.
    // eslint-disable-next-line security/detect-object-injection
    node = node[part];
  }
  if (typeof node === "string" || typeof node === "boolean") return node;
  if (Array.isArray(node) && node.every((item) => typeof item === "string")) return node as string[];
  return undefined;
}

/** The answer at a path as text: a list is joined with commas, a switch reads
 *  "on" or "off". */
export function answerText(answers: SetupAnswers, path: string): string {
  const value = answerAt(answers, path);
  if (value === undefined) return "";
  if (typeof value === "boolean") return value ? "on" : "off";
  return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * Set one answer. Only a path that already holds an answer can be set, and
 * only to a value of the kind it holds, so nothing a browser sends can add a
 * key to the answers or change a field's type. That holds for a module's
 * switch too: the answers list the build's modules from the start, and a
 * module they do not list has no switch to set.
 */
export function setAnswer(answers: SetupAnswers, path: string, value: unknown): boolean {
  const parts = path.split(".");
  const last = parts.pop();
  if (!last) return false;
  let node: unknown = answers;
  for (const part of parts) {
    if (!isRecord(node) || !own(node, part)) return false;
    // eslint-disable-next-line security/detect-object-injection
    node = node[part];
  }
  if (!isRecord(node)) return false;
  if (!own(node, last)) return false;
  if (parts.length === 1 && parts[0] === "modules") {
    if (typeof value !== "boolean") return false;
    node[last] = value;
    return true;
  }
  // eslint-disable-next-line security/detect-object-injection
  const current = node[last];
  if (typeof current === "string") {
    if (typeof value !== "string" || value.length > MAX_ANSWER_CHARS) return false;
    node[last] = value;
    return true;
  }
  if (Array.isArray(current)) {
    const list = typeof value === "string" ? splitList(value) : value;
    if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) return false;
    if (list.length > MAX_LIST_ITEMS || list.some((item) => item.length > MAX_ANSWER_CHARS)) return false;
    node[last] = [...list];
    return true;
  }
  return false;
}

/** The longest answer a field takes. An address or a group's name is far
 *  shorter; this is the ceiling on what is kept at all. */
export const MAX_ANSWER_CHARS = 1024;
const MAX_LIST_ITEMS = 50;

/** Names separated by commas, with the empty ones dropped. */
export function splitList(text: string): string[] {
  return [...new Set(text.split(",").map((item) => item.trim()).filter((item) => item !== ""))];
}

// ── A key's name ─────────────────────────────────────────────────────────────

// The rule is the key store's own (`src/secrets/types.ts`, which imports
// nothing, so a page may import it too). There is no second copy of it.

export const KEY_NAME_RULE = 'A key\'s name is 1 to 64 characters of a to z, 0 to 9 and "-"';

export function isKeyName(value: string): boolean {
  return isSecretName(value);
}

// ── The settings file ────────────────────────────────────────────────────────

export const SETTINGS_FILE_VERSION = 1;

/** A key, given by the name it has in the key store. */
export interface KeyRef {
  key: string;
}

/** The settings file, as it is written. Every question is one top-level key. */
export interface SettingsFile {
  version: 1;
  organization: { name: string; firstAdministrator?: string };
  keys: { store: string; folder?: string; address?: string; clientId?: string; region?: string; project?: string };
  signIn: {
    provider: string;
    issuer?: string;
    clientId?: string;
    clientSecret?: KeyRef | false;
    groupsClaim?: string;
    roles?: { operator: string[]; readonly: string[] };
    consoleAddress: string | false;
  };
  data: {
    database: { store: string; address?: KeyRef };
    files:
      | false
      | {
          store: string;
          address?: string;
          bucket?: string;
          region?: string;
          project?: string;
          account?: string;
          container?: string;
        };
  };
  modules: Record<string, boolean>;
  model: false | { provider: string; address?: string; key?: KeyRef; name?: string; region?: string; project?: string };
  network: { proxy: string | false };
  records: { keepFor: string; copyTo: false | { to: string; address?: string } };
  updates: { from: string; address?: string; install: string };
  controlPlane: false | { address: string; token?: KeyRef };
}

/** Leave a key out of an object when its value is empty. */
function given<K extends string>(key: K, value: string): { [P in K]?: string } {
  return (value ? { [key]: value } : {}) as { [P in K]?: string };
}

/** The fields the chosen option of a choice asks for, by the last part of
 *  their path. A field of another option is not written to the file. */
function fieldsOf(path: string, optionId: string, list: readonly SetupStep[]): Set<string> {
  const option = choiceAt(path, list)?.options.find((o) => o.id === optionId);
  return new Set((option?.fields ?? []).map((field) => field.path.slice(field.path.lastIndexOf(".") + 1)));
}

/** The answers in the shape of a settings file. */
export function answersToFile(answers: SetupAnswers, list: readonly SetupStep[] = SETUP_LIST): SettingsFile {
  const a = answers;
  const keys = fieldsOf("keys.store", a.keys.store, list);
  const files = fieldsOf("data.files.store", a.data.files.store, list);
  const model = fieldsOf("model.provider", a.model.provider, list);
  const oidc = a.signIn.provider === "openid-connect";
  return {
    version: SETTINGS_FILE_VERSION,
    organization: { name: a.organization.name, ...given("firstAdministrator", a.organization.firstAdministrator) },
    keys: {
      store: a.keys.store,
      ...(keys.has("folder") ? given("folder", a.keys.folder) : {}),
      ...(keys.has("address") ? given("address", a.keys.address) : {}),
      ...(keys.has("clientId") ? given("clientId", a.keys.clientId) : {}),
      ...(keys.has("region") ? given("region", a.keys.region) : {}),
      ...(keys.has("project") ? given("project", a.keys.project) : {}),
    },
    signIn: {
      provider: a.signIn.provider,
      ...(oidc
        ? {
            ...given("issuer", a.signIn.issuer),
            ...given("clientId", a.signIn.clientId),
            clientSecret: a.signIn.clientSecret ? { key: a.signIn.clientSecret } : false,
            ...(a.signIn.groupsClaim && a.signIn.groupsClaim !== DEFAULT_GROUPS_CLAIM
              ? { groupsClaim: a.signIn.groupsClaim }
              : {}),
            roles: { operator: [...a.signIn.operatorGroups], readonly: [...a.signIn.readonlyGroups] },
          }
        : {}),
      consoleAddress: a.signIn.consoleAddress || false,
    },
    data: {
      database:
        a.data.database.store === "postgres"
          ? { store: "postgres", ...(a.data.database.address ? { address: { key: a.data.database.address } } : {}) }
          : { store: a.data.database.store },
      files:
        a.data.files.store === NONE
          ? false
          : {
              store: a.data.files.store,
              ...(files.has("address") ? given("address", a.data.files.address) : {}),
              ...(files.has("bucket") ? given("bucket", a.data.files.bucket) : {}),
              ...(files.has("region") ? given("region", a.data.files.region) : {}),
              ...(files.has("project") ? given("project", a.data.files.project) : {}),
              ...(files.has("account") ? given("account", a.data.files.account) : {}),
              ...(files.has("container") ? given("container", a.data.files.container) : {}),
            },
    },
    modules: Object.fromEntries(Object.keys(a.modules).sort().map((id) => [id, a.modules[id] === true])),
    model:
      a.model.provider === NONE
        ? false
        : {
            provider: a.model.provider,
            ...(model.has("address") ? given("address", a.model.address) : {}),
            ...(model.has("key") && a.model.key ? { key: { key: a.model.key } } : {}),
            ...(model.has("name") ? given("name", a.model.name) : {}),
            ...(model.has("region") ? given("region", a.model.region) : {}),
            ...(model.has("project") ? given("project", a.model.project) : {}),
          },
    network: { proxy: a.network.route === "proxy" && a.network.proxy ? a.network.proxy : false },
    records: {
      keepFor: a.records.keepFor,
      copyTo:
        a.records.copyTo === NONE
          ? false
          : { to: a.records.copyTo, ...given("address", a.records.copyAddress) },
    },
    updates: {
      from: a.updates.from,
      ...(a.updates.from === "own-address" ? given("address", a.updates.address) : {}),
      install: a.updates.install,
    },
    controlPlane:
      a.controlPlane.connect === "yes"
        ? {
            address: a.controlPlane.address,
            ...(a.controlPlane.token ? { token: { key: a.controlPlane.token } } : {}),
          }
        : false,
  };
}

/** The settings file as text, as `hx-fortress setup --print` writes it. */
export function settingsFileText(answers: SetupAnswers, list: readonly SetupStep[] = SETUP_LIST): string {
  return `${JSON.stringify(answersToFile(answers, list), null, 2)}\n`;
}

export type ParsedSettings =
  | { ok: true; answers: SetupAnswers; given: StepId[] }
  | { ok: false; refusals: string[] };

/**
 * Read a settings file over the present answers.
 *
 * A question the file leaves out keeps its present answer. A question the file
 * gives is taken whole: a field it does not mention is empty, not kept.
 *
 * It is STRICT, and it refuses by name: a key the list does not know, an
 * option the list does not have, an option that is not in this build yet, and
 * a value written where a key's name belongs. Nothing the file holds is
 * repeated in a refusal, because a line pasted into the wrong place may be a
 * key.
 */
export function parseSettingsFile(
  text: string,
  present: SetupAnswers,
  options: { moduleIds: readonly string[]; list?: readonly SetupStep[] },
): ParsedSettings {
  const list = options.list ?? SETUP_LIST;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, refusals: ["The settings file is not valid JSON"] };
  }
  if (!isRecord(raw)) return { ok: false, refusals: ["The settings file must hold one JSON object"] };

  const refusals: string[] = [];
  const refuse = (line: string): void => {
    refusals.push(line);
  };
  const answers = cloneAnswers(present);
  const givenSteps: StepId[] = [];

  for (const key of Object.keys(raw)) {
    if (key !== "version" && !(STEP_IDS as readonly string[]).includes(key)) {
      refuse(`${shown(key)} is not a question of the setup. The questions are ${STEP_IDS.join(", ")}`);
    }
  }
  if (raw.version !== undefined && raw.version !== SETTINGS_FILE_VERSION) {
    refuse(`version must be ${SETTINGS_FILE_VERSION}`);
  }

  /** The keys an object may hold. Anything else is refused by name. */
  const only = (where: string, value: Record<string, unknown>, allowed: readonly string[]): void => {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        refuse(`${where}.${shown(key)} is not a setting. ${where} takes ${allowed.join(", ")}`);
      }
    }
  };
  const text_ = (where: string, value: unknown): string => {
    if (value === undefined) return "";
    if (typeof value !== "string") {
      refuse(`${where} must be text`);
      return "";
    }
    if (value.length > MAX_ANSWER_CHARS) {
      refuse(`${where} is longer than ${MAX_ANSWER_CHARS} characters`);
      return "";
    }
    return value.trim();
  };
  const keyName = (where: string, value: unknown): string => {
    if (value === undefined || value === false) return "";
    if (!isRecord(value) || typeof value.key !== "string" || Object.keys(value).length !== 1) {
      refuse(`${where} must be the name of a key, written as { "key": "<name>" }. The file never holds the key itself`);
      return "";
    }
    if (!isKeyName(value.key)) {
      refuse(`${where} is not a key's name. ${KEY_NAME_RULE}`);
      return "";
    }
    return value.key;
  };
  const names = (where: string, value: unknown): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      refuse(`${where} must be a list of names`);
      return [];
    }
    return splitList(value.join(","));
  };
  /** An option's id, checked against the list. */
  const option = (where: string, path: string, value: unknown): string | null => {
    const choice = choiceAt(path, list);
    const ids = (choice?.options ?? []).filter((o) => o.built).map((o) => o.id);
    if (typeof value !== "string") {
      refuse(`${where} must be one of ${ids.join(", ")}`);
      return null;
    }
    const found = choice?.options.find((o) => o.id === value);
    if (!found) {
      refuse(`${where} must be one of ${ids.join(", ")}`);
      return null;
    }
    if (!found.built) {
      refuse(`${where}: ${found.name} is not in this build yet. It can be ${ids.join(", ")}`);
      return null;
    }
    return found.id;
  };
  const block = (step: StepId): Record<string, unknown> | false | null => {
    // `step` is one of the list's own literal ids.
    // eslint-disable-next-line security/detect-object-injection
    const value = raw[step];
    if (value === undefined) return null;
    givenSteps.push(step);
    if (value === false) return false;
    if (!isRecord(value)) {
      refuse(`${step} must be an object`);
      return null;
    }
    return value;
  };
  const noFalse = (step: StepId, value: Record<string, unknown> | false | null): Record<string, unknown> | null => {
    if (value === false) {
      refuse(`${step} cannot be false`);
      return null;
    }
    return value;
  };

  const organization = noFalse("organization", block("organization"));
  if (organization) {
    only("organization", organization, ["name", "firstAdministrator"]);
    answers.organization = {
      name: text_("organization.name", organization.name),
      firstAdministrator: text_("organization.firstAdministrator", organization.firstAdministrator),
    };
  }

  const keys = noFalse("keys", block("keys"));
  if (keys) {
    only("keys", keys, ["store", "folder", "address", "clientId", "region", "project"]);
    const store = option("keys.store", "keys.store", keys.store);
    answers.keys = {
      store: store ?? answers.keys.store,
      folder: text_("keys.folder", keys.folder),
      address: text_("keys.address", keys.address),
      clientId: text_("keys.clientId", keys.clientId),
      region: text_("keys.region", keys.region),
      project: text_("keys.project", keys.project),
    };
  }

  const signIn = noFalse("signIn", block("signIn"));
  if (signIn) {
    only("signIn", signIn, [
      "provider",
      "issuer",
      "clientId",
      "clientSecret",
      "groupsClaim",
      "roles",
      "consoleAddress",
    ]);
    const provider = option("signIn.provider", "signIn.provider", signIn.provider);
    let operatorGroups: string[] = [];
    let readonlyGroups: string[] = [];
    if (signIn.roles !== undefined) {
      if (!isRecord(signIn.roles)) refuse("signIn.roles must be an object");
      else {
        only("signIn.roles", signIn.roles, ["operator", "readonly"]);
        operatorGroups = names("signIn.roles.operator", signIn.roles.operator);
        readonlyGroups = names("signIn.roles.readonly", signIn.roles.readonly);
      }
    }
    answers.signIn = {
      provider: provider ?? answers.signIn.provider,
      issuer: text_("signIn.issuer", signIn.issuer),
      clientId: text_("signIn.clientId", signIn.clientId),
      clientSecret: keyName("signIn.clientSecret", signIn.clientSecret),
      groupsClaim: text_("signIn.groupsClaim", signIn.groupsClaim) || DEFAULT_GROUPS_CLAIM,
      operatorGroups,
      readonlyGroups,
      consoleAddress: signIn.consoleAddress === false ? "" : text_("signIn.consoleAddress", signIn.consoleAddress),
    };
  }

  const data = noFalse("data", block("data"));
  if (data) {
    only("data", data, ["database", "files"]);
    if (data.database !== undefined) {
      if (!isRecord(data.database)) refuse("data.database must be an object");
      else {
        only("data.database", data.database, ["store", "address"]);
        const store = option("data.database.store", "data.database.store", data.database.store);
        answers.data.database = {
          store: store ?? answers.data.database.store,
          address: keyName("data.database.address", data.database.address),
        };
      }
    }
    if (data.files !== undefined) {
      const empty = defaultAnswers().data.files;
      if (data.files === false) answers.data.files = empty;
      else if (!isRecord(data.files)) refuse("data.files must be an object, or false for no file store");
      else {
        only("data.files", data.files, ["store", "address", "bucket", "region", "project", "account", "container"]);
        const store = option("data.files.store", "data.files.store", data.files.store);
        answers.data.files = {
          store: store ?? answers.data.files.store,
          address: text_("data.files.address", data.files.address),
          bucket: text_("data.files.bucket", data.files.bucket),
          region: text_("data.files.region", data.files.region),
          project: text_("data.files.project", data.files.project),
          account: text_("data.files.account", data.files.account),
          container: text_("data.files.container", data.files.container),
        };
      }
    }
  }

  const modules = noFalse("modules", block("modules"));
  if (modules) {
    for (const [id, value] of Object.entries(modules)) {
      if (!options.moduleIds.includes(id)) {
        refuse(
          `modules.${shown(id)} is not a module of this build. Its modules are ${options.moduleIds.join(", ") || "none"}`,
        );
        continue;
      }
      if (typeof value !== "boolean") {
        refuse(`modules.${id} must be true or false`);
        continue;
      }
      answers.modules[id] = value;
    }
  }

  const model = block("model");
  if (model === false) answers.model = defaultAnswers().model;
  else if (model) {
    only("model", model, ["provider", "address", "key", "name", "region", "project"]);
    const provider = option("model.provider", "model.provider", model.provider);
    answers.model = {
      provider: provider ?? answers.model.provider,
      address: text_("model.address", model.address),
      key: keyName("model.key", model.key),
      name: text_("model.name", model.name),
      region: text_("model.region", model.region),
      project: text_("model.project", model.project),
    };
  }

  const network = noFalse("network", block("network"));
  if (network) {
    only("network", network, ["proxy"]);
    if (network.proxy === false || network.proxy === undefined) answers.network = { route: "direct", proxy: "" };
    else {
      const route = option("network.proxy", "network.route", "proxy");
      const proxy = text_("network.proxy", network.proxy);
      if (route) answers.network = { route, proxy };
    }
  }

  const records = noFalse("records", block("records"));
  if (records) {
    only("records", records, ["keepFor", "copyTo"]);
    if (records.keepFor !== undefined) {
      const keepFor = option("records.keepFor", "records.keepFor", records.keepFor);
      if (keepFor) answers.records.keepFor = keepFor;
    }
    if (records.copyTo === false) {
      answers.records.copyTo = NONE;
      answers.records.copyAddress = "";
    } else if (records.copyTo !== undefined) {
      if (!isRecord(records.copyTo)) refuse("records.copyTo must be an object, or false for no copy");
      else {
        only("records.copyTo", records.copyTo, ["to", "address"]);
        const to = option("records.copyTo.to", "records.copyTo", records.copyTo.to);
        if (to) {
          answers.records.copyTo = to;
          answers.records.copyAddress = text_("records.copyTo.address", records.copyTo.address);
        }
      }
    }
  }

  const updates = noFalse("updates", block("updates"));
  if (updates) {
    only("updates", updates, ["from", "address", "install"]);
    if (updates.from !== undefined) {
      const from = option("updates.from", "updates.from", updates.from);
      if (from) answers.updates.from = from;
    }
    answers.updates.address = text_("updates.address", updates.address);
    if (updates.install !== undefined) {
      const install = option("updates.install", "updates.install", updates.install);
      if (install) answers.updates.install = install;
    }
  }

  const controlPlane = block("controlPlane");
  if (controlPlane === false) answers.controlPlane = defaultAnswers().controlPlane;
  else if (controlPlane) {
    only("controlPlane", controlPlane, ["address", "token"]);
    answers.controlPlane = {
      connect: "yes",
      address: text_("controlPlane.address", controlPlane.address),
      token: keyName("controlPlane.token", controlPlane.token),
    };
  }

  return refusals.length > 0 ? { ok: false, refusals } : { ok: true, answers, given: givenSteps };
}

/** A key of the file as it may be repeated in a refusal: only when it looks
 *  like a key. Anything else was not meant to be a key, and stays out. */
function shown(key: string): string {
  return /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(key) ? key : "a key";
}

// ── The review ───────────────────────────────────────────────────────────────

/** One line per question: the answer in a few words. `reachCount` is how many
 *  addresses the worked-out list holds. */
export function summaryLines(
  answers: SetupAnswers,
  options: {
    moduleTitles: Record<string, string>;
    reachCount: number;
    list?: readonly SetupStep[];
  },
): Record<StepId, string> {
  const list = options.list ?? SETUP_LIST;
  const a = answers;
  const name = (path: string, id: string): string =>
    choiceAt(path, list)?.options.find((o) => o.id === id)?.name ?? id;
  const on = Object.keys(a.modules)
    .filter((id) => a.modules[id] === true)
    // The id is an own key of the titles given.
    // eslint-disable-next-line security/detect-object-injection
    .map((id) => (own(options.moduleTitles, id) ? options.moduleTitles[id] : id) ?? id);
  const dot = " · ";
  return {
    organization: [a.organization.name || "No name yet", a.organization.firstAdministrator].filter(Boolean).join(dot),
    keys: name("keys.store", a.keys.store),
    signIn:
      a.signIn.provider === "openid-connect"
        ? [name("signIn.provider", a.signIn.provider), hostOf(a.signIn.issuer)].filter(Boolean).join(dot)
        : name("signIn.provider", a.signIn.provider),
    data: [
      name("data.database.store", a.data.database.store),
      a.data.files.store === NONE ? "" : name("data.files.store", a.data.files.store),
    ]
      .filter(Boolean)
      .join(dot),
    modules: on.length > 0 ? on.join(", ") : "None",
    model: name("model.provider", a.model.provider),
    network: `${name("network.route", a.network.route)}${dot}${options.reachCount} ${options.reachCount === 1 ? "address" : "addresses"}`,
    records: `Kept ${name("records.keepFor", a.records.keepFor).toLowerCase()}${dot}copy to ${name("records.copyTo", a.records.copyTo).toLowerCase()}`,
    updates: `${name("updates.from", a.updates.from)}${dot}${name("updates.install", a.updates.install).toLowerCase()}`,
    controlPlane: a.controlPlane.connect === "yes" ? a.controlPlane.address || "No address yet" : "None",
  };
}

/** The host of an address, or the text itself when it is not an address. */
export function hostOf(address: string): string {
  const text = address.trim();
  if (!text) return "";
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).host.toLowerCase();
  } catch {
    return text;
  }
}
