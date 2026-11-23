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
// THE ANSWERS HOLD NO KEY, and neither does a settings file. Where a key is
// needed, the answer is the name the key has in the organization's key store.
// A value written where a name belongs is refused, and the refusal does not
// repeat it. The install lets a person type a key itself: that value is kept
// apart from the answers (`SetupRun` holds it), and the answer is still the
// name the key will have.
//
// Free of Node: the console's pages import the types here.

import { isSecretName } from "../secrets/types";
import {
  NONE,
  SETUP_LIST,
  STEP_IDS,
  choiceAt,
  fieldsOfStep,
  isCloudPlace,
  isPlaceId,
  optionOffered,
  placeInfo,
  type PlaceId,
  type SetupStep,
  type StepId,
  type Way,
} from "./list";

export interface SetupAnswers {
  /** Where HX Fortress runs. `here` for a setup on the machine itself. */
  where: {
    place: string;
    /** The cloud's region, by its id there. Empty outside a cloud. */
    region: string;
    /** user@host of a machine with Docker. */
    ssh: string;
  };
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
    /** The name of a vault the install makes. */
    vault: string;
  };
  /** Where people reach HX Fortress. */
  address: {
    /** A hostname, with no scheme. Empty: this machine only. */
    hostname: string;
    certificate: string;
    /** The NAME the organization's own certificate has in the key store. */
    certificateName: string;
  };
  signIn: {
    provider: string;
    issuer: string;
    clientId: string;
    /** The NAME of the key that holds the client secret. Empty: a public client. */
    clientSecret: string;
    groupsClaim: string;
    administratorGroups: string[];
    operatorGroups: string[];
    readonlyGroups: string[];
    /** The groups of Viewers: people who see rows in Secure Data Islands,
     *  change nothing, and open nothing in the console. */
    viewerGroups: string[];
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
    /** How the provider is reached: directly, or through a cloud's service. */
    route: string;
    address: string;
    /** The NAME of the model's key. */
    key: string;
    name: string;
    region: string;
    project: string;
  };
  network: { route: string; proxy: string };
  updates: {
    securityFixes: string;
    /** Where a new version is downloaded from: `project-releases`, or
     *  `own-address`. No page asks it. It is named on the host: by a settings
     *  file, in config.json, or in the environment. */
    from: string;
    /** With `own-address`: the base address that holds one release's files. */
    address: string;
  };
  controlPlane: {
    /** `yes` once a control plane is named. Nobody is asked this: the install
     *  command names one, or a settings file does. */
    connect: string;
    address: string;
    /** The NAME of a key that holds a one-time install id, for a setup with
     *  nobody at the screen. Empty: the command gave the id, or none is needed. */
    token: string;
    /** `off`: HX Fortress keeps what it needs to connect and does not dial. */
    connected: string;
    /** The origin of the pages the control plane shows to people. Empty: none
     *  of its pages may show a page of this HX Fortress. */
    pages: string;
  };
  auditTrail: { copyTo: string; copyAddress: string; keepFor: string };
}

export const DEFAULT_GROUPS_CLAIM = "groups";

/** The two answers to where a new version comes from. They are the values of
 *  `updates.from` in config.json: a test holds the two lists together. */
export const UPDATES_FROM_PROJECT = "project-releases";
export const UPDATES_FROM_OWN = "own-address";
/** What the answer holds when this host's update settings cannot be
 *  understood. It is not an answer anybody can give: only the reader of the
 *  host sets it, a settings file cannot name it, and nothing writes it. It is
 *  there so that what describes the host does not show the project's releases
 *  for a host whose settings may have turned away from them. */
export const UPDATES_FROM_UNREADABLE = "cannot-be-read";

/** Where HX Fortress sends its questions to the model when the answer gives
 *  no address. The host's own constant (`DEFAULT_OPENAI_BASE_URL`), written
 *  again here because this file is free of Node: a test holds the two together. */
export const DEFAULT_MODEL_ADDRESS = "https://api.openai.com/v1";

/** The answers of an install nobody has set up, on the machine itself: every
 *  question on its plain option, which needs no cloud, no key and no outside
 *  service. `on` names the modules that start switched on. */
export function defaultAnswers(
  moduleIds: readonly string[] = [],
  options: { on?: readonly string[] } = {},
): SetupAnswers {
  const on = new Set(options.on ?? []);
  return {
    where: { place: "here", region: "", ssh: "" },
    organization: { name: "", firstAdministrator: "" },
    keys: { store: "env", folder: "", address: "", clientId: "", region: "", project: "", vault: "" },
    address: { hostname: "", certificate: NONE, certificateName: "" },
    signIn: {
      provider: "local",
      issuer: "",
      clientId: "",
      clientSecret: "",
      groupsClaim: DEFAULT_GROUPS_CLAIM,
      administratorGroups: [],
      operatorGroups: [],
      readonlyGroups: [],
      viewerGroups: [],
    },
    data: {
      database: { store: "beside", address: "" },
      files: { store: NONE, address: "", bucket: "", region: "", project: "", account: "", container: "" },
    },
    modules: Object.fromEntries(moduleIds.map((id) => [id, on.has(id)])),
    model: { provider: NONE, route: "direct", address: "", key: "", name: "", region: "", project: "" },
    network: { route: "direct", proxy: "" },
    updates: { securityFixes: "off", from: UPDATES_FROM_PROJECT, address: "" },
    controlPlane: { connect: "no", address: "", token: "", connected: "on", pages: "" },
    auditTrail: { copyTo: NONE, copyAddress: "", keepFor: "until-removed" },
  };
}

/** The model the install starts on. A person pastes its key, or picks None. */
export const INSTALL_MODEL = "anthropic";

/**
 * The answers the install starts with, for one place: each page comes with an
 * answer, and the place's own services are the ones chosen.
 */
export function installAnswers(
  place: PlaceId,
  moduleIds: readonly string[] = [],
  options: { on?: readonly string[]; list?: readonly SetupStep[] } = {},
): SetupAnswers {
  const answers = defaultAnswers(moduleIds, options);
  answers.where.place = place;
  settleAnswers(answers, "where.place", options.list, { install: true });
  answers.model.provider = INSTALL_MODEL;
  return answers;
}

/** The name of the vault an install makes for an organization, as a first
 *  answer a person can change: "northstar-hx-fortress". Empty when the
 *  organization's name gives nothing to build on. */
export function vaultNameFor(organization: string): string {
  const slug = organization
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // A vault's name starts with a letter and is at most 24 characters.
  if (!/^[a-z]/.test(slug)) return "";
  return `${slug.slice(0, 12).replace(/-+$/, "")}-hx-fortress`;
}

/** The address people reach HX Fortress at, as a first answer a person can
 *  change: "hx." and the domain of the first administrator's email address.
 *  Empty when that is not an email address. */
export function hostnameFor(firstAdministrator: string): string {
  const at = firstAdministrator.lastIndexOf("@");
  const domain = at > 0 ? firstAdministrator.slice(at + 1).trim().toLowerCase() : "";
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain) ? `hx.${domain}` : "";
}

/**
 * Make the other answers follow one that changed.
 *
 * When the place changes, the answers that named the old place's services
 * move to the new place's: its key store, a certificate it issues, a database
 * it manages. An answer that the new place does not offer at all moves to the
 * first one it does. Nothing a person typed is cleared.
 *
 * In an install (`install: true`) two answers start as a suggestion worked out
 * from another: the name of the vault from the organization's name, and the
 * address from the first administrator's email address. Each follows its
 * source for as long as nobody typed something else into it. `before` is the
 * answers as they were: with it, the suggestion that was there can be told
 * from what a person typed. Nowhere else is anything suggested: on the machine
 * that runs HX Fortress both are facts, and renaming the organization there
 * changes its name and nothing more.
 */
export function settleAnswers(
  answers: SetupAnswers,
  changed: string,
  list: readonly SetupStep[] = SETUP_LIST,
  options: { before?: SetupAnswers; install?: boolean } = {},
): void {
  const { before } = options;
  if (options.install === true && answers.where.place !== "here") {
    const was = before ?? answers;
    if (changed === "organization.name" || changed === "where.place") {
      const suggested = before ? vaultNameFor(was.organization.name) : "";
      if (answers.keys.vault === "" || answers.keys.vault === suggested) {
        answers.keys.vault = vaultNameFor(answers.organization.name);
      }
    }
    if (changed === "organization.firstAdministrator" || changed === "where.place") {
      const suggested = before ? hostnameFor(was.organization.firstAdministrator) : "";
      if (answers.address.hostname === "" || answers.address.hostname === suggested) {
        answers.address.hostname = hostnameFor(answers.organization.firstAdministrator);
      }
    }
  }
  const place = isPlaceId(answers.where.place) ? answers.where.place : "here";
  const info = placeInfo(place);
  const offered = (path: string, id: string): boolean => {
    const option = choiceAt(path, list)?.options.find((o) => o.id === id);
    return option !== undefined && optionOffered(option, { place });
  };
  if (changed === "where.place") {
    if (!info.regions.some((region) => region.id === answers.where.region)) {
      answers.where.region = info.regions[0]?.id ?? "";
    }
    const cloud = isCloudPlace(place);
    if (place !== "here") {
      answers.keys.store = info.keys && offered("keys.store", info.keys) ? info.keys : "env";
      answers.address.certificate = cloud ? "cloud-issued" : "own";
      answers.data.database.store = cloud ? "managed" : "beside";
      answers.data.files.store = info.files && offered("data.files.store", info.files) ? info.files : NONE;
    }
  }
  // An answer the place does not offer moves to the first one it does, when
  // the place changed. Any other change leaves them as they are: on the
  // machine itself they are what HX Fortress runs with, and renaming the
  // organization or choosing another model must not move its key store.
  if (changed === "where" || changed.startsWith("where.")) {
    for (const path of ["keys.store", "address.certificate", "data.database.store"]) {
      const current = answerText(answers, path);
      if (offered(path, current)) continue;
      const first = choiceAt(path, list)?.options.find((o) => optionOffered(o, { place }));
      if (first) setAnswer(answers, path, first.id);
    }
  }
  if (changed === "model.provider") {
    // A key, a model's name and an address belong to the provider they were
    // given for. Another provider starts with none of them, so that a key is
    // never offered to a provider it was not given for.
    answers.model.key = "";
    answers.model.name = "";
    answers.model.address = "";
    answers.model.region = "";
    answers.model.project = "";
  }
  if (changed === "model.provider" || changed === "where.place") {
    const routes = routesOf(answers.model.provider, list);
    if (!routes.includes(answers.model.route)) answers.model.route = routes[0] ?? "direct";
  }
}

/** The ways one provider can be reached in this build, by id. */
export function routesOf(provider: string, list: readonly SetupStep[] = SETUP_LIST): string[] {
  for (const step of list) {
    for (const block of step.blocks) {
      if (block.kind !== "fields") continue;
      for (const field of block.fields) {
        if (field.path !== "model.route" || !field.options || !field.when) continue;
        const is = field.when.is;
        if (field.when.path === "model.provider" && (typeof is === "string" ? is === provider : is.includes(provider))) {
          return field.options.filter((option) => option.built !== false).map((option) => option.id);
        }
      }
    }
  }
  return [];
}

/** The name of each key store as a sentence uses it, by option id. */
const KEY_STORE_WORDS: Readonly<Record<string, string>> = {
  "azure-key-vault": "Azure Key Vault",
  "aws-secrets-manager": "AWS Secrets Manager",
  "google-secret-manager": "Google Secret Manager",
};

/** The words that fill the braces of the list, from the answers. */
export function wordsOf(answers: SetupAnswers): Record<string, string> {
  const place = placeInfo(answers.where.place);
  const here = answers.where.place === "here";
  const store = answers.keys.store;
  const keys = own(KEY_STORE_WORDS, store)
    ? String(KEY_STORE_WORDS[store as keyof typeof KEY_STORE_WORDS])
    : store === "file"
      ? `the folder ${answers.keys.folder || "of keys"}`
      : here
        ? "this host's settings"
        : "this container's settings";
  return {
    cloud: place.short,
    postgres: place.postgres ?? "Postgres",
    keys,
    controlPlane: hostOf(answers.controlPlane.address) || "a control plane",
    organization: answers.organization.name.trim() || "this organization",
  };
}

/** The https address people reach HX Fortress at, or "" when it answers on
 *  its own machine only. */
export function publicAddress(answers: SetupAnswers): string {
  const hostname = answers.address.hostname.trim();
  return hostname ? `https://${hostname}` : "";
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
    // A list of names is kept as it will be read back once written: names
    // separated by commas, each without the spaces around it, no empty name and
    // none twice (`checkOidcGroups` reads the identity provider's lists so).
    // Whichever way it arrives, as text or as a list, the checks then count the
    // names it really holds, and `[" "]` is the empty list it reads back as.
    if (typeof value !== "string" && !(Array.isArray(value) && value.every((item) => typeof item === "string"))) {
      return false;
    }
    const list = splitList(typeof value === "string" ? value : (value as string[]).join(","));
    if (list.length > MAX_LIST_ITEMS || list.some((item) => item.length > MAX_ANSWER_CHARS)) return false;
    node[last] = list;
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
  /** Only in a file for `hx-fortress install`. */
  where?: { place: string; region?: string; ssh?: string };
  organization: { name: string; firstAdministrator?: string };
  keys: {
    store: string;
    folder?: string;
    address?: string;
    clientId?: string;
    region?: string;
    project?: string;
    vault?: string;
  };
  address: { hostname: string | false; certificate: string | false; certificateName?: KeyRef };
  signIn: {
    provider: string;
    issuer?: string;
    clientId?: string;
    clientSecret?: KeyRef | false;
    groupsClaim?: string;
    roles?: { administrator: string[]; operator: string[]; readonly: string[]; viewer?: string[] };
  };
  modules: Record<string, boolean>;
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
  model:
    | false
    | {
        provider: string;
        route?: string;
        key?: KeyRef;
        address?: string;
        name?: string;
        region?: string;
        project?: string;
      };
  network: { proxy: string | false };
  updates: { securityFixes: boolean; from?: string; address?: string };
  controlPlane: false | { address: string; connected: boolean; pages?: string; token?: KeyRef };
  auditTrail: { keepFor: string; copyTo: false | { to: string; address?: string } };
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
  const oidc = a.signIn.provider === "openid-connect";
  const elsewhere = a.where.place !== "here";
  return {
    version: SETTINGS_FILE_VERSION,
    ...(elsewhere
      ? { where: { place: a.where.place, ...given("region", a.where.region), ...given("ssh", a.where.place === "docker" ? a.where.ssh : "") } }
      : {}),
    organization: { name: a.organization.name, ...given("firstAdministrator", a.organization.firstAdministrator) },
    keys: {
      store: a.keys.store,
      ...(keys.has("folder") ? given("folder", a.keys.folder) : {}),
      ...(keys.has("address") ? given("address", a.keys.address) : {}),
      ...(keys.has("clientId") ? given("clientId", a.keys.clientId) : {}),
      ...(keys.has("region") ? given("region", a.keys.region) : {}),
      ...(keys.has("project") ? given("project", a.keys.project) : {}),
      ...(keys.has("vault") ? given("vault", a.keys.vault) : {}),
    },
    address: {
      hostname: a.address.hostname || false,
      certificate: a.address.certificate === NONE ? false : a.address.certificate,
      ...(a.address.certificate === "own" && a.address.certificateName
        ? { certificateName: { key: a.address.certificateName } }
        : {}),
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
            roles: {
              administrator: [...a.signIn.administratorGroups],
              operator: [...a.signIn.operatorGroups],
              readonly: [...a.signIn.readonlyGroups],
              // Named only when a group has it: most installs have none.
              ...(a.signIn.viewerGroups.length > 0 ? { viewer: [...a.signIn.viewerGroups] } : {}),
            },
          }
        : {}),
    },
    modules: Object.fromEntries(Object.keys(a.modules).sort().map((id) => [id, a.modules[id] === true])),
    data: {
      database:
        a.data.database.store === "existing"
          ? { store: "existing", ...(a.data.database.address ? { address: { key: a.data.database.address } } : {}) }
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
    model:
      a.model.provider === NONE
        ? false
        : {
            provider: a.model.provider,
            ...(a.model.route && a.model.route !== "direct" ? { route: a.model.route } : {}),
            ...(a.model.key ? { key: { key: a.model.key } } : {}),
            ...given("address", a.model.address),
            ...given("name", a.model.name),
            ...given("region", a.model.region),
            ...given("project", a.model.project),
          },
    network: { proxy: a.network.route === "proxy" && a.network.proxy ? a.network.proxy : false },
    updates: {
      securityFixes: a.updates.securityFixes === "on",
      // Written only when it is not the project's releases, so a file says
      // nothing about the source until an organization names its own.
      ...(a.updates.from === UPDATES_FROM_OWN ? { from: UPDATES_FROM_OWN, address: a.updates.address } : {}),
    },
    controlPlane:
      a.controlPlane.connect === "yes"
        ? {
            address: a.controlPlane.address,
            connected: a.controlPlane.connected !== "off",
            ...given("pages", a.controlPlane.pages),
            ...(a.controlPlane.token ? { token: { key: a.controlPlane.token } } : {}),
          }
        : false,
    auditTrail: {
      keepFor: a.auditTrail.keepFor,
      copyTo:
        a.auditTrail.copyTo === NONE
          ? false
          : { to: a.auditTrail.copyTo, ...given("address", a.auditTrail.copyAddress) },
    },
  };
}

/** The settings file as text, as `--print` writes it. */
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
 *
 * `install` says which command reads the file. Where HX Fortress runs is the
 * install's question: a file for a setup on the machine itself may not give it.
 */
export function parseSettingsFile(
  text: string,
  present: SetupAnswers,
  options: { moduleIds: readonly string[]; list?: readonly SetupStep[]; install?: boolean },
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
  const yesNo = (where: string, value: unknown, missing: boolean): boolean => {
    if (value === undefined) return missing;
    if (typeof value !== "boolean") {
      refuse(`${where} must be true or false`);
      return missing;
    }
    return value;
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
    // Everywhere else a list of names is typed with commas between them, so a
    // name cannot hold one. A file that gives such a name is refused: read as
    // two names, it would give a role to two other groups.
    if (value.some((item) => (item as string).includes(","))) {
      refuse(`${where}: a name cannot hold a comma. Give each name as its own item`);
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

  // Where it runs comes first: the answers after it follow the place.
  const where = noFalse("where", block("where"));
  if (where) {
    if (!options.install) {
      refuse("where is asked by hx-fortress install. A setup on the machine itself runs HX Fortress on that machine");
    } else {
      only("where", where, ["place", "region", "ssh"]);
      const place = option("where.place", "where.place", where.place);
      if (place) {
        // Only another place moves the answers that follow the place. A file
        // that names the place the answers already have leaves the questions
        // it does not give as they are.
        const moved = place !== answers.where.place;
        answers.where = { place, region: text_("where.region", where.region), ssh: text_("where.ssh", where.ssh) };
        if (moved) settleAnswers(answers, "where.place", list, { install: true });
        // A region the file leaves out is the place's first one, as it is on
        // the page.
        else if (!placeInfo(place).regions.some((region) => region.id === answers.where.region)) {
          answers.where.region = placeInfo(place).regions[0]?.id ?? "";
        }
        if (where.region !== undefined) answers.where.region = text_("where.region", where.region);
      }
    }
  }

  // A field belongs to the ways that ask it, and a file gives no other. An
  // install names the vault it makes and takes no address for it. On the
  // machine itself it is the other way round.
  const way: Way = options.install === true ? "install" : "setup";
  for (const step of list) {
    for (const field of fieldsOfStep(step)) {
      if (!field.ways || field.ways.includes(way)) continue;
      let given: unknown = raw;
      for (const part of field.path.split(".")) {
        // This file is also part of the page's build, which has no `Object.hasOwn`.
        given =
          isRecord(given) && Object.prototype.hasOwnProperty.call(given, part)
            ? (given as Record<string, unknown>)[part]
            : undefined;
      }
      if (given === undefined || given === "" || given === false) continue;
      refuse(
        `${field.path} is asked ${
          field.ways.includes("install") ? "by hx-fortress install" : "by a setup on the machine that runs HX Fortress"
        }, and not here`,
      );
    }
  }

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
    only("keys", keys, ["store", "folder", "address", "clientId", "region", "project", "vault"]);
    const store = option("keys.store", "keys.store", keys.store);
    answers.keys = {
      store: store ?? answers.keys.store,
      folder: text_("keys.folder", keys.folder),
      address: text_("keys.address", keys.address),
      clientId: text_("keys.clientId", keys.clientId),
      region: text_("keys.region", keys.region),
      project: text_("keys.project", keys.project),
      vault: text_("keys.vault", keys.vault),
    };
  }

  const address = noFalse("address", block("address"));
  if (address) {
    only("address", address, ["hostname", "certificate", "certificateName"]);
    const certificate =
      address.certificate === false || address.certificate === undefined
        ? NONE
        : option("address.certificate", "address.certificate", address.certificate);
    answers.address = {
      hostname: address.hostname === false ? "" : text_("address.hostname", address.hostname),
      certificate: certificate ?? answers.address.certificate,
      certificateName: keyName("address.certificateName", address.certificateName),
    };
  }

  const signIn = noFalse("signIn", block("signIn"));
  if (signIn) {
    only("signIn", signIn, ["provider", "issuer", "clientId", "clientSecret", "groupsClaim", "roles"]);
    const provider = option("signIn.provider", "signIn.provider", signIn.provider);
    let administratorGroups: string[] = [];
    let operatorGroups: string[] = [];
    let readonlyGroups: string[] = [];
    let viewerGroups: string[] = [];
    if (signIn.roles !== undefined) {
      if (!isRecord(signIn.roles)) refuse("signIn.roles must be an object");
      else {
        only("signIn.roles", signIn.roles, ["administrator", "operator", "readonly", "viewer"]);
        administratorGroups = names("signIn.roles.administrator", signIn.roles.administrator);
        operatorGroups = names("signIn.roles.operator", signIn.roles.operator);
        readonlyGroups = names("signIn.roles.readonly", signIn.roles.readonly);
        viewerGroups = names("signIn.roles.viewer", signIn.roles.viewer);
      }
    }
    answers.signIn = {
      provider: provider ?? answers.signIn.provider,
      issuer: text_("signIn.issuer", signIn.issuer),
      clientId: text_("signIn.clientId", signIn.clientId),
      clientSecret: keyName("signIn.clientSecret", signIn.clientSecret),
      groupsClaim: text_("signIn.groupsClaim", signIn.groupsClaim) || DEFAULT_GROUPS_CLAIM,
      administratorGroups,
      operatorGroups,
      readonlyGroups,
      viewerGroups,
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
    only("model", model, ["provider", "route", "key", "address", "name", "region", "project"]);
    const provider = option("model.provider", "model.provider", model.provider);
    const routes = routesOf(provider ?? answers.model.provider, list);
    let route = "direct";
    if (model.route !== undefined) {
      if (typeof model.route === "string" && routes.includes(model.route)) route = model.route;
      else refuse(`model.route must be one of ${routes.join(", ") || "direct"}`);
    }
    answers.model = {
      provider: provider ?? answers.model.provider,
      route,
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
      refuse("network.proxy: a proxy is not in this build yet. It can be false");
    }
  }

  const updates = noFalse("updates", block("updates"));
  if (updates) {
    only("updates", updates, ["securityFixes", "from", "address"]);
    const fixes = yesNo("updates.securityFixes", updates.securityFixes, false);
    if (fixes) refuse("updates.securityFixes: security fixes that install by themselves are not in this build yet. It can be false");
    // Where a new version comes from. A file that does not name it leaves it
    // as it is: every other question a file gives is taken whole, and this one
    // answer is not, because a source that a file dropped by not mentioning it
    // would move HX Fortress back to the project's releases without a word.
    // To go back, a file says `"from": "project-releases"`.
    // Here the address only has to be text: whether a download may start from
    // it is its check's to say.
    const address = text_("updates.address", updates.address);
    answers.updates.securityFixes = "off";
    if (updates.from === UPDATES_FROM_OWN) {
      if (address) answers.updates = { ...answers.updates, from: UPDATES_FROM_OWN, address };
      else refuse(`updates.address must hold an address when updates.from is ${UPDATES_FROM_OWN}`);
    } else if (updates.from !== undefined && updates.from !== UPDATES_FROM_PROJECT) {
      refuse(`updates.from must be one of ${UPDATES_FROM_PROJECT}, ${UPDATES_FROM_OWN}`);
    } else if (updates.address !== undefined) {
      refuse(`updates.address is given, and updates.from is not ${UPDATES_FROM_OWN}`);
    } else if (updates.from === UPDATES_FROM_PROJECT) {
      answers.updates = { ...answers.updates, from: UPDATES_FROM_PROJECT, address: "" };
    }
  }

  const controlPlane = block("controlPlane");
  if (controlPlane === false) answers.controlPlane = defaultAnswers().controlPlane;
  else if (controlPlane) {
    only("controlPlane", controlPlane, ["address", "connected", "pages", "token"]);
    answers.controlPlane = {
      connect: "yes",
      address: text_("controlPlane.address", controlPlane.address),
      token: keyName("controlPlane.token", controlPlane.token),
      connected: yesNo("controlPlane.connected", controlPlane.connected, true) ? "on" : "off",
      pages: text_("controlPlane.pages", controlPlane.pages),
    };
  }

  const auditTrail = noFalse("auditTrail", block("auditTrail"));
  if (auditTrail) {
    only("auditTrail", auditTrail, ["keepFor", "copyTo"]);
    if (auditTrail.keepFor !== undefined) {
      const keepFor = option("auditTrail.keepFor", "auditTrail.keepFor", auditTrail.keepFor);
      if (keepFor) answers.auditTrail.keepFor = keepFor;
    }
    if (auditTrail.copyTo === false) {
      answers.auditTrail.copyTo = NONE;
      answers.auditTrail.copyAddress = "";
    } else if (auditTrail.copyTo !== undefined) {
      if (!isRecord(auditTrail.copyTo)) refuse("auditTrail.copyTo must be an object, or false for no copy");
      else {
        only("auditTrail.copyTo", auditTrail.copyTo, ["to", "address"]);
        const to = option("auditTrail.copyTo.to", "auditTrail.copyTo", auditTrail.copyTo.to);
        if (to) {
          answers.auditTrail.copyTo = to;
          answers.auditTrail.copyAddress = text_("auditTrail.copyTo.address", auditTrail.copyTo.address);
        }
      }
    }
  }

  return refusals.length > 0 ? { ok: false, refusals } : { ok: true, answers, given: givenSteps };
}

/** A key of the file as it may be repeated in a refusal: only when it looks
 *  like a key. Anything else was not meant to be a key, and stays out. */
function shown(key: string): string {
  return /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(key) ? key : "a key";
}

// ── The answers in a few words ───────────────────────────────────────────────

/** One line per question: the answer in a few words. Settings shows it beside
 *  each section's name, and the terminal shows it before it saves.
 *  `reachCount` is how many addresses the worked-out list holds. */
export function summaryLines(
  answers: SetupAnswers,
  options: {
    moduleTitles: Record<string, string>;
    reachCount: number;
    /** False when no module that is on keeps files: the file store is then
     *  not made and not called, and the summary does not name it. */
    needsFiles?: boolean;
    list?: readonly SetupStep[];
  },
): Record<StepId, string> {
  const list = options.list ?? SETUP_LIST;
  const a = answers;
  const place = placeInfo(a.where.place);
  const words = { cloud: place.short, postgres: place.postgres ?? "Postgres" };
  const name = (path: string, id: string): string => {
    const option = choiceAt(path, list)?.options.find((o) => o.id === id);
    if (!option) return id;
    const text = (a.where.place === "here" && option.here?.name) || option.name;
    return text.replace(/\{([a-zA-Z]+)\}/g, (whole, word: string) =>
      own(words, word) ? String(words[word as keyof typeof words]) : whole,
    );
  };
  const on = Object.keys(a.modules)
    .filter((id) => a.modules[id] === true)
    // The id is an own key of the titles given.
    // eslint-disable-next-line security/detect-object-injection
    .map((id) => (own(options.moduleTitles, id) ? options.moduleTitles[id] : id) ?? id);
  const dot = " · ";
  const region = place.regions.find((r) => r.id === a.where.region)?.name ?? a.where.region;
  const provider = name("model.provider", a.model.provider);
  return {
    where:
      a.where.place === "docker"
        ? [place.compute, hostOf(a.where.ssh.replace(/^[^@]*@/, ""))].filter(Boolean).join(", ")
        : [place.compute, region].filter(Boolean).join(", "),
    organization: [a.organization.name || "No name yet", a.organization.firstAdministrator].filter(Boolean).join(dot),
    keys: name("keys.store", a.keys.store),
    address: a.address.hostname
      ? [a.address.hostname, name("address.certificate", a.address.certificate)].join(dot)
      : "This machine only",
    signIn:
      a.signIn.provider === "openid-connect"
        ? hostOf(a.signIn.issuer) || name("signIn.provider", a.signIn.provider)
        : name("signIn.provider", a.signIn.provider),
    modules: on.length > 0 ? on.join(", ") : "None switched on",
    data: [
      name("data.database.store", a.data.database.store),
      a.data.files.store === NONE || options.needsFiles === false ? "" : name("data.files.store", a.data.files.store),
    ]
      .filter(Boolean)
      .join(dot),
    model:
      a.model.provider === NONE
        ? "None"
        : a.model.address
          ? // An address of the organization's own, where a settings file gave one.
            `${provider}, at ${hostOf(a.model.address) || "its own address"}`
          : a.model.route === "direct" || !a.model.route
            ? `${provider}, directly`
            : `${provider}, through ${a.model.route}`,
    network: `${options.reachCount} ${options.reachCount === 1 ? "address" : "addresses"}${a.network.route === "proxy" ? ", through a proxy" : ""}`,
    updates: `An administrator approves each${a.updates.securityFixes === "on" ? ", except security fixes" : ""}`,
    controlPlane:
      a.controlPlane.connect !== "yes"
        ? "None"
        : a.controlPlane.connected === "off"
          ? "Disconnected"
          : [a.controlPlane.address || "No address yet", a.organization.name ? `as ${a.organization.name}` : ""]
              .filter(Boolean)
              .join(", "),
    auditTrail: `${name("auditTrail.keepFor", a.auditTrail.keepFor)}${
      a.auditTrail.copyTo === NONE ? "" : `, copied to ${name("auditTrail.copyTo", a.auditTrail.copyTo).toLowerCase()}`
    }`,
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
