// The present answers of an install: its settings, read as answers to the
// setup's questions.
//
// THERE IS NO SECOND COPY OF THE ANSWERS. An answer rests where the Fortress
// already keeps that setting: config.json, the console's own files beside it,
// the Sessions credentials file. This file reads those places into the shape
// the setup works with, and `apply.ts` writes them back. So an install that was
// made before the setup existed is read exactly like one the setup made, and a
// change made with another command shows here the next time anyone looks.
//
// THE ENVIRONMENT STILL WINS. A setting given in this host's environment
// decides its answer, as it does for the Fortress itself. Such an answer is
// reported as pinned, with the variable that pins it, and the setup does not
// change it.
//
// A PIN IS ONE ANSWER, NOT A QUESTION. A variable pins exactly the answers it
// decides, each by its own path: the screens lock that field, a settings file
// that gives it another value is refused, and `apply.ts` leaves it as it is.
// A field beside it that the variable does not decide stays an answer a person
// gives, and is written.

import path from "node:path";

import {
  DEFAULT_OPENAI_BASE_URL,
  MODULE_DEFAULTS_KEY,
  readConfigObject,
  SESSIONS_MODULE_ID,
  sessionsSettingFromEnv,
} from "../host/config";
import { parseVaultCredentialsFromEnv } from "../host/headless-bootstrap";
import { MODULE_CATALOG, type CatalogEntry } from "../host/module-catalog";
import type { fortressPaths } from "../host/paths";
import { readVaultCredentials, type VaultCredentials } from "../modules/session-vault/credentials";
import { resolveSecretsConfig } from "../secrets/config";
import { SECRET_PROVIDERS } from "../secrets/providers";
import { isSecretName } from "../secrets/types";
import { effectiveUiEnabled, UiConfigStore } from "../ui/config";
import { OidcConfigStore } from "../ui/oidc-config";
import { checkLogin, UsersStore, type UsersFile } from "../ui/users";
import { defaultAnswers, type SetupAnswers } from "./answers";
import { controlPlaneAddress } from "./control-plane";
import { NONE } from "./list";
import { isSetUpConfig, SETUP_MARK_KEY } from "./state";

type FortressPaths = ReturnType<typeof fortressPaths>;

/** The variable that names the key store. */
export const KEY_STORE_ENV = "FORTRESS_SECRETS_PROVIDER";

/**
 * The answer that each setting of a key store is, by the setting's key in the
 * `secrets` block of config.json. A setting that is not here has no field in
 * the setup: the setup neither shows it nor writes it, and config.json keeps
 * what it holds for it.
 */
export const KEY_STORE_ANSWER: Readonly<Record<string, string>> = {
  dir: "keys.folder",
  vaultUrl: "keys.address",
  clientId: "keys.clientId",
};

/** The variable that names the first console account of a container. */
export const FIRST_ACCOUNT_ENV = "FORTRESS_UI_BOOTSTRAP_USER";

export interface PresentAnswers {
  answers: SetupAnswers;
  /** Answers this host's environment decides: the answer's path, and the name
   *  of the variable that decides it. */
  pinned: Record<string, string>;
  /**
   * What an earlier way of setting this Fortress up left on the host that the
   * setup's questions cannot hold, because the setup asks for a key's name and
   * these are kept as values. Each stays as it is until its answer changes.
   */
  kept: {
    /** The model's key is in this host's environment or its credentials file. */
    modelKey: boolean;
    /** The database's address is in this host's environment or config.json. */
    databaseAddress: boolean;
    /** The file store's keys are in the credentials file. */
    filesKeys: boolean;
  };
  /** False for a Fortress that is not set up: see `state.ts`. */
  setUp: boolean;
  /**
   * The connection address of the control plane this Fortress was enrolled
   * with when the setup disconnected it. Null when a control plane is
   * connected, and when none ever was. The enrollment itself stays in the
   * identity folder, and it belongs to that control plane and to no other.
   */
  disconnectedFrom: string | null;
  /** Whether this Fortress's console is switched on, in its own settings or by
   *  the host's environment. A new install's setup switches it on. */
  consoleOn: boolean;
}

export interface ReadDeps {
  catalog?: readonly CatalogEntry[];
  /** Injected in tests. The default reads the Sessions credentials file. */
  vaultCredentials?: () => Promise<VaultCredentials | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The login of the first account that can change things here: the oldest
 *  live operator. Empty when there is none. */
export function firstOperator(users: UsersFile): string {
  const operators = users.users
    .filter((user) => user.role === "operator" && !user.deletedAt && !user.disabledAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return operators[0]?.login ?? "";
}

/** The file store an existing credentials file names, as an option's id. */
function filesStoreOf(creds: VaultCredentials): string {
  if (creds.store === "gcs") return "google-cloud-storage";
  return creds.endpoint ? "s3-compatible" : "amazon-s3";
}

export async function readAnswers(
  paths: FortressPaths,
  env: Record<string, string | undefined> = process.env,
  deps: ReadDeps = {},
): Promise<PresentAnswers> {
  const catalog = deps.catalog ?? MODULE_CATALOG;
  const raw = await readConfigObject(paths);
  const answers = defaultAnswers(catalog.map((entry) => entry.id));
  const pinned: Record<string, string> = {};
  const kept = { modelKey: false, databaseAddress: false, filesKeys: false };

  // 1 · Organization
  if (isRecord(raw?.organization)) answers.organization.name = text(raw.organization.name);
  const users = await new UsersStore(path.join(paths.uiRoot, "users.json")).load().catch(() => null);
  if (users) answers.organization.firstAdministrator = firstOperator(users);
  // A container may name its first account in the environment. The console
  // makes that account when it starts, so the answer is the same login, and
  // the setup makes it one step earlier.
  // eslint-disable-next-line security/detect-object-injection
  const envLogin = env[FIRST_ACCOUNT_ENV]?.trim() ?? "";
  if (!answers.organization.firstAdministrator && envLogin && checkLogin(envLogin) === null) {
    answers.organization.firstAdministrator = envLogin;
    pinned["organization.firstAdministrator"] = FIRST_ACCOUNT_ENV;
  }

  // 2 · Keys. Resolved by the same function the Fortress starts with, so the
  // answer is the store it really reads from.
  try {
    const secrets = resolveSecretsConfig({ env, config: raw, root: paths.root });
    answers.keys.store = secrets.provider;
    if (secrets.provider === "file") answers.keys.folder = secrets.dir;
    if (secrets.provider === "azure-key-vault") {
      answers.keys.address = secrets.vault.origin;
      answers.keys.clientId = secrets.clientId ?? "";
    }
    // Any other key store: each setting that has a field here is read where
    // the Fortress reads it, the environment first.
    if (secrets.provider !== "file" && secrets.provider !== "azure-key-vault") {
      const block = isRecord(raw?.secrets) ? raw.secrets : {};
      const fields = answers.keys as unknown as Record<string, string>;
      for (const setting of SECRET_PROVIDERS.find((p) => p.kind === secrets.provider)?.settings ?? []) {
        const at = KEY_STORE_ANSWER[setting.key]?.split(".")[1];
        // eslint-disable-next-line security/detect-object-injection
        if (at && Object.hasOwn(fields, at)) fields[at] = env[setting.env]?.trim() || text(block[setting.key]);
      }
    }
  } catch {
    // A block this build refuses. The Fortress says so when it starts; here the
    // question simply shows its default, and answering it writes a good block.
  }
  // The environment wins over config.json, setting by setting. The variables
  // come from the one list of key stores, so a key store that is added there
  // is pinned here with no change to this file.
  // eslint-disable-next-line security/detect-object-injection
  if (env[KEY_STORE_ENV]?.trim()) pinned["keys.store"] = KEY_STORE_ENV;
  for (const provider of SECRET_PROVIDERS) {
    for (const setting of provider.settings) {
      // Both keys come from the build's own lists, never from an answer.
      const at = KEY_STORE_ANSWER[setting.key];
      if (at && env[setting.env]?.trim()) pinned[at] = setting.env;
    }
  }

  // 3 · Sign-in
  const oidc = await new OidcConfigStore(path.join(paths.uiRoot, "oidc.json")).load().catch(() => null);
  if (oidc) {
    answers.signIn.provider = oidc.enabled ? "openid-connect" : "local";
    answers.signIn.issuer = oidc.issuer ?? "";
    answers.signIn.clientId = oidc.clientId ?? "";
    answers.signIn.clientSecret = oidc.clientSecretName ?? "";
    answers.signIn.groupsClaim = oidc.groupsClaim;
    answers.signIn.operatorGroups = [...oidc.operatorGroups];
    answers.signIn.readonlyGroups = [...oidc.readonlyGroups];
  }
  const ui = await new UiConfigStore(paths.uiConfig).load().catch(() => null);
  const envConsole = env.FORTRESS_UI_PUBLIC_URL?.trim();
  answers.signIn.consoleAddress = envConsole || ui?.publicUrl || "";
  if (envConsole) pinned["signIn.consoleAddress"] = "FORTRESS_UI_PUBLIC_URL";

  // 4 · Data: the database
  const postgres = isRecord(raw?.postgres) ? raw.postgres : {};
  const envDbName = env.FORTRESS_DATABASE_URL_SECRET?.trim();
  if (env.FORTRESS_DATABASE_URL?.trim()) {
    answers.data.database = { store: "postgres", address: "" };
    pinned["data.database.store"] = "FORTRESS_DATABASE_URL";
    pinned["data.database.address"] = "FORTRESS_DATABASE_URL";
    kept.databaseAddress = true;
  } else if (envDbName !== undefined && envDbName !== "") {
    answers.data.database = { store: "postgres", address: isSecretName(envDbName) ? envDbName : "" };
    pinned["data.database.store"] = "FORTRESS_DATABASE_URL_SECRET";
    pinned["data.database.address"] = "FORTRESS_DATABASE_URL_SECRET";
  } else if (text(postgres.urlSecret)) {
    answers.data.database = { store: "postgres", address: text(postgres.urlSecret) };
  } else if (text(postgres.externalUrl)) {
    answers.data.database = { store: "postgres", address: "" };
    kept.databaseAddress = true;
  }

  // 5 · Modules. A config that never had the default modules applied gets them
  // at its next start, so they count as on here too.
  const enabled =
    isRecord(raw?.modules) && Array.isArray(raw.modules.enabled)
      ? raw.modules.enabled.filter((id): id is string => typeof id === "string")
      : [];
  // A constant key of the host's config.
  // eslint-disable-next-line security/detect-object-injection
  const defaultsPending = isSetUpConfig(raw) && raw?.[MODULE_DEFAULTS_KEY] !== 1;
  for (const entry of catalog) {
    answers.modules[entry.id] =
      enabled.includes(entry.id) || (defaultsPending && entry.id === SESSIONS_MODULE_ID);
  }
  let sessionsFromEnv: "on" | "off" | null = null;
  try {
    sessionsFromEnv = sessionsSettingFromEnv(env);
  } catch {
    // A value that is neither on nor off. The Fortress refuses to start on it.
  }
  if (sessionsFromEnv !== null && Object.hasOwn(answers.modules, SESSIONS_MODULE_ID)) {
    answers.modules[SESSIONS_MODULE_ID] = sessionsFromEnv === "on";
    pinned[`modules.${SESSIONS_MODULE_ID}`] = "FORTRESS_SESSIONS";
  }

  // 4 · Data: the files, which only Sessions keeps today. The storage
  // variables decide every part of the answer when they name a bucket: a start
  // writes the credentials file from them, so they are read here as the start
  // reads them, whether or not that file exists yet.
  const creds = await (deps.vaultCredentials ?? readVaultCredentials)().catch(() => null);
  let envFiles: VaultCredentials | null = null;
  try {
    envFiles = parseVaultCredentialsFromEnv(env);
  } catch {
    // A storage variable this build refuses. The start says which.
  }
  const filesOf = envFiles ?? creds;
  if (filesOf && typeof filesOf.bucket === "string" && filesOf.bucket) {
    answers.data.files = {
      ...answers.data.files,
      store: filesStoreOf(filesOf),
      address: filesOf.endpoint ?? "",
      bucket: filesOf.bucket,
      region: filesOf.region ?? "",
      project: filesOf.projectId ?? "",
    };
    kept.filesKeys = Boolean(filesOf.gcs || filesOf.s3);
  }
  if (envFiles) {
    pinned["data.files.store"] = "FORTRESS_STORAGE_BUCKET";
    pinned["data.files.bucket"] = "FORTRESS_STORAGE_BUCKET";
    pinned["data.files.region"] = "FORTRESS_STORAGE_REGION";
    pinned["data.files.address"] = "FORTRESS_S3_ENDPOINT";
    pinned["data.files.project"] = "FORTRESS_GCS_PROJECT_ID";
  }

  // 6 · AI model. Three variables each decide one part of the answer, as they
  // do for the Fortress: the key, the address and the model's name.
  const envModelKey = Boolean(env.FORTRESS_OPENAI_API_KEY?.trim());
  if (isRecord(raw?.model) && text(raw.model.provider)) {
    answers.model = {
      ...answers.model,
      provider: text(raw.model.provider),
      address: text(raw.model.address),
      key: text(raw.model.key),
      name: text(raw.model.name),
    };
  } else if (envModelKey || creds?.openaiApiKey) {
    answers.model = { ...answers.model, provider: "openai-compatible", address: DEFAULT_OPENAI_BASE_URL };
  }
  if (envModelKey) {
    // The key itself is in the environment, so no name is asked for.
    answers.model = { ...answers.model, provider: "openai-compatible", key: "" };
    pinned["model.provider"] = "FORTRESS_OPENAI_API_KEY";
    pinned["model.key"] = "FORTRESS_OPENAI_API_KEY";
  }
  // A model with no key's name runs on a key that is kept on this host, when
  // there is one: in the environment, or in the credentials file.
  kept.modelKey =
    answers.model.provider !== NONE && !answers.model.key && (envModelKey || Boolean(creds?.openaiApiKey));
  const envModelAddress = env.FORTRESS_OPENAI_BASE_URL?.trim();
  if (envModelAddress) {
    answers.model.address = envModelAddress;
    pinned["model.address"] = "FORTRESS_OPENAI_BASE_URL";
  }
  const envModelName = env.FORTRESS_EMBED_MODEL?.trim();
  if (envModelName) {
    answers.model.name = envModelName;
    pinned["model.name"] = "FORTRESS_EMBED_MODEL";
  }

  // 7 · Network
  if (isRecord(raw?.network) && text(raw.network.proxy)) {
    answers.network = { route: "proxy", proxy: text(raw.network.proxy) };
  }

  // 8 · Records
  if (isRecord(raw?.records)) {
    if (text(raw.records.keepFor)) answers.records.keepFor = text(raw.records.keepFor);
    if (isRecord(raw.records.copyTo) && text(raw.records.copyTo.to)) {
      answers.records.copyTo = text(raw.records.copyTo.to);
      answers.records.copyAddress = text(raw.records.copyTo.address);
    }
  }

  // 9 · Updates
  if (isRecord(raw?.updates)) {
    if (text(raw.updates.from)) answers.updates.from = text(raw.updates.from);
    answers.updates.address = text(raw.updates.address);
    if (text(raw.updates.install)) answers.updates.install = text(raw.updates.install);
  }

  // 10 · Control plane
  const envCloud = env.FORTRESS_CLOUD_URL?.trim();
  const cloudUrl = isRecord(raw?.cloud) ? text(raw.cloud.url) : "";
  if (envCloud && env.FORTRESS_ENROLL_TOKEN?.trim()) {
    answers.controlPlane = { connect: "yes", address: controlPlaneAddress(envCloud), token: "" };
    pinned["controlPlane.connect"] = "FORTRESS_CLOUD_URL";
    pinned["controlPlane.address"] = "FORTRESS_CLOUD_URL";
  } else if (cloudUrl) {
    answers.controlPlane = { connect: "yes", address: controlPlaneAddress(cloudUrl), token: "" };
  }
  // eslint-disable-next-line security/detect-object-injection
  const mark = isRecord(raw?.[SETUP_MARK_KEY]) ? (raw[SETUP_MARK_KEY] as Record<string, unknown>) : {};
  const disconnectedFrom = cloudUrl ? null : text(mark.disconnectedFrom) || null;

  // A file store that no module uses is not an answer anybody gave.
  if (!needsFiles(answers) && !filesOf) answers.data.files.store = NONE;

  return {
    answers,
    pinned,
    kept,
    setUp: isSetUpConfig(raw),
    disconnectedFrom,
    consoleOn: effectiveUiEnabled({ enabled: ui?.enabled === true }, env),
  };
}

/**
 * The file store's settings WITH the keys an earlier way of setting this
 * Fortress up left on the host: the storage variables when they name a bucket,
 * else the Sessions credentials file. What the Fortress itself would open.
 */
export async function heldFilesCredentials(
  env: Record<string, string | undefined>,
  vaultCredentials: () => Promise<VaultCredentials | null> = readVaultCredentials,
): Promise<VaultCredentials | null> {
  try {
    const fromEnv = parseVaultCredentialsFromEnv(env);
    if (fromEnv) return fromEnv;
  } catch {
    // A storage variable this build refuses names no store.
  }
  return vaultCredentials();
}

/** The modules that keep files. Today that is Sessions alone. */
export const FILE_KEEPING_MODULES: readonly string[] = [SESSIONS_MODULE_ID];

/** Whether a module that is on keeps files, so a file store is needed. */
export function needsFiles(answers: SetupAnswers): boolean {
  return FILE_KEEPING_MODULES.some((id) => answers.modules[id] === true);
}

/** The modules that ask a model. Today that is Sessions alone, for search. */
export const MODEL_USING_MODULES: readonly string[] = [SESSIONS_MODULE_ID];

export function needsModel(answers: SetupAnswers): boolean {
  return MODEL_USING_MODULES.some((id) => answers.modules[id] === true);
}
