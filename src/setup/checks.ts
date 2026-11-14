// The check behind each answer of the setup.
//
// EVERY ANSWER IS CHECKED WHEN IT IS GIVEN, in the browser, in the terminal
// and from a settings file alike, and again when the Fortress starts. A check
// does the real thing where it can: it asks the key store for the key, opens
// the database, writes a test file, fetches the sign-in provider's own
// description of itself. What it found is one plain line. A wrong answer is
// refused with a line that says what is wrong and, where there is one thing to
// do about it, what that is.
//
// A CHECK NEVER SHOWS A KEY. It asks the key store for the key by its name. A
// key store answers that by reading the key, so the value is in this
// program's memory for the moment of the call, and it goes nowhere a person
// can read. Where a check must USE a key, it uses it as the Fortress will: the
// database's address is opened, and the model's key is sent to the address the
// model's answer gives. So whoever gives the answers decides where a named key
// is sent, exactly as they decide it for the running Fortress. Nothing an
// outside service answers is repeated either: a line says that it answered, or
// a status, and no more.
//
// AN OPTION'S CHECK LIVES UNDER THE OPTION'S ID in `OPTION_CHECKS`. An option
// the list marks as built has an entry here, and an option that is not built
// has none. A test fails while the two disagree, so an option cannot be
// switched on in the list without a check.

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { FileCredentialStore, FilePendingEnrollmentStore } from "../cloud/credentials";
import {
  assertHttpsDownloadUrl,
  DEFAULT_OPENAI_BASE_URL,
  FileConfigStore,
  isOrganizationName,
  resolveEmbedConfig,
} from "../host/config";
import { MODULE_CATALOG, type CatalogEntry } from "../host/module-catalog";
import type { fortressPaths } from "../host/paths";
import { dbSqlState, isKillClassDbError } from "../host/postgres/pg-errors";
import { pgvectorPresent } from "../host/postgres/pgvector-install";
import { DEFAULT_PG_VERSION } from "../host/postgres/resolve";
import { withDeadline } from "../host/with-deadline";
import type { VaultCredentials } from "../modules/session-vault/credentials";
import { buildDirectStore } from "../modules/session-vault/store";
import { createSecretProvider, resolveSecretsConfig } from "../secrets/config";
import { secretProviderDefinition } from "../secrets/providers";
import { SECRET_ENV_PREFIX } from "../secrets/env";
import { assertDatabaseUrlSecret } from "../secrets/settings";
import { SecretUnavailable, type SecretProvider } from "../secrets/types";
import { checkPublicUrl } from "../ui/config";
import { OidcClient } from "../ui/oidc";
import { checkOidcClaimName, checkOidcClientId, checkOidcGroups, checkOidcIssuer } from "../ui/oidc-config";
import { checkLogin, UsersStore, type UsersFile } from "../ui/users";
import { answerText, hostOf, isKeyName, type SetupAnswers } from "./answers";
import { controlPlaneUrl } from "./control-plane";
import { choicesOf, NONE, SETUP_LIST, STEP_IDS, stepById, type StepId } from "./list";
import { reachOf } from "./reach";
import type { CheckLine, StepCheck } from "./view";

export type { CheckLine, StepCheck } from "./view";
import {
  heldFilesCredentials,
  KEY_STORE_ANSWER,
  needsFiles,
  needsModel,
  type PresentAnswers,
} from "./read";

type FortressPaths = ReturnType<typeof fortressPaths>;

/** What is known about the enrollment with the control plane the answer names. */
export interface EnrollmentView {
  /** The connection address the enrollment is for. */
  url: string;
  state: "waiting" | "ready" | "expired" | "refused";
  reason?: string;
}

export interface CheckDeps {
  paths: FortressPaths;
  env: Record<string, string | undefined>;
  /** The install as it is now: what is pinned, and what an earlier setup kept. */
  present: PresentAnswers;
  catalog?: readonly CatalogEntry[];
  /**
   * `given`: a person has given the answer, and each check does the real
   * thing.
   *
   * `typing`: a person is still typing the answer. No request leaves this
   * host: a check says what the host can see by itself, and the real thing
   * waits until the person leaves the field. A half-typed key name is then
   * never looked up in the organization's key store, and a half-typed address
   * is never called.
   *
   * `checkup`: somebody asked a running Fortress to check itself. A check that
   * would spend money (a question to the model), or that the Checkup's own
   * probes make (the database, the file store), is left out. The key store is
   * asked for each key that an answer names, as a start asks for it, and what
   * comes back is only whether it is there. The sign-in provider is asked
   * whether it still describes itself.
   *
   * `start`: the Fortress is starting. A start adds no request that leaves
   * this host. The sign-in provider is not asked, and a key store that is not
   * on this host is asked nothing: the start reads the keys it needs itself,
   * and says so when one is missing. A lookup of any other key would be one
   * more line in the organization's own log of who read which key, at every
   * start. What is left is what this host can see by itself: the shape of
   * each answer, a folder that is gone, a key that is no longer in a key store
   * on this host, an answer that the environment now decides otherwise.
   */
  when?: "given" | "typing" | "checkup" | "start";
  /** How long one outside call may take. */
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** The enrollment under way for the control plane question, if any. */
  enrollment?: EnrollmentView | null;
  /** Injected in tests. Each defaults to the real thing. */
  keyStore?: (answers: SetupAnswers) => Promise<SecretProvider> | SecretProvider;
  probeDatabase?: (url: string) => Promise<string>;
  probeFiles?: (credentials: VaultCredentials) => Promise<void>;
  users?: () => Promise<UsersFile>;
  /** The Sessions credentials file, as an earlier setup left it. */
  vaultCredentials?: () => Promise<VaultCredentials | null>;
}

const DEFAULT_TIMEOUT_MS = 8_000;
/** A name no key store holds. Asking for it proves that the store answers. */
const PROBE_KEY_NAME = "hx-fortress-setup-check";

// ── Small helpers ────────────────────────────────────────────────────────────

const refuse = (text: string, at?: string): CheckLine => ({ ok: false, text, ...(at ? { path: at } : {}) });
const found = (text: string, at?: string): CheckLine => ({ ok: true, text, ...(at ? { path: at } : {}) });
const soft = (text: string): CheckLine => ({ ok: false, text, soft: true });

/** A reason that this program's own code wrote, cut to a line. Never used
 *  for an error an outside service sent: see the two functions below. */
function shortReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 160) || "no reason given";
}

// WHAT AN OUTSIDE SERVICE SAYS IS NOT REPEATED. A database's error can name the
// user or the database that its address holds, and that address is a key. A
// file store's error can quote a key id. So a check reads the CLASS of a
// refusal (a five-character error class, an HTTP status, a deadline) and says
// it in a sentence of its own. No text the other side sent reaches the person
// who is answering.

const DEADLINE = "did not answer in time";

/** Why a database could not be opened. */
function databaseRefusal(error: unknown): string {
  const state = dbSqlState(error) ?? "";
  if (state === "28P01" || state === "28000") return "it refused the user name or the password";
  if (state === "3D000") return "it has no database with the name in the address";
  if (/^[0-9A-Z]{5}$/.test(state)) return `it answered with error class ${state}`;
  if (error instanceof Error && error.message.includes(DEADLINE)) return "it did not answer in time";
  if (isKillClassDbError(error)) return "it closed the connection";
  return "nothing answers at its address";
}

/** Why a file store did not take a test file. */
function filesRefusal(error: unknown): string {
  const e = (typeof error === "object" && error !== null ? error : {}) as {
    name?: unknown;
    Code?: unknown;
    code?: unknown;
    status?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const name = [e.Code, e.name].find((value): value is string => typeof value === "string") ?? "";
  const status = [e.$metadata?.httpStatusCode, e.status, e.code].find(
    (value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599,
  );
  if (status === 401 || status === 403 || /^(AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch)$/.test(name)) {
    return "the store refused this host's access";
  }
  if (status === 404 || name === "NoSuchBucket") return "the store has no bucket with this name";
  if (error instanceof Error && error.message.includes(DEADLINE)) return "the store did not answer in time";
  if (status !== undefined && status >= 400) return `the store answered ${status}`;
  return "nothing answers at the store's address";
}

/** The `secrets` block of config.json that an answer to the keys question
 *  makes. The settings come from the build's one list of key stores, and
 *  `KEY_STORE_ANSWER` says which field of the question each one is, so a key
 *  store that is added to that list needs no line here. */
export function secretsBlockOf(keys: SetupAnswers["keys"]): Record<string, string> {
  const block: Record<string, string> = { provider: keys.store };
  const fields = keys as unknown as Record<string, unknown>;
  for (const setting of secretProviderDefinition(keys.store)?.settings ?? []) {
    const field = KEY_STORE_ANSWER[setting.key]?.split(".")[1];
    // `field` comes from the build's own table, never from an answer.
    // eslint-disable-next-line security/detect-object-injection
    const value = field ? fields[field] : undefined;
    if (typeof value === "string" && value) block[setting.key] = value;
  }
  return block;
}

/** True for an https address, or one on this host itself, that holds no user
 *  name and no password. A credential pasted into an address would be written
 *  down with it, and shown wherever the address is. */
function plainHttpsAddress(address: string): boolean {
  try {
    assertHttpsDownloadUrl(address, "address");
    const url = new URL(address);
    return !url.username && !url.password;
  } catch {
    return false;
  }
}

/** "under Modules": where a person changes the answer of another question.
 *  The name comes from the list, so it stays right when the list changes. */
const under = (step: StepId): string => `under ${stepById(step).name}`;

/** The Sessions credentials an answer to the files question makes: where the
 *  bucket is, and no key. The store then reads this host's own credentials. */
export function filesCredentialsOf(files: SetupAnswers["data"]["files"]): VaultCredentials | null {
  switch (files.store) {
    case "s3-compatible":
      return {
        store: "s3",
        bucket: files.bucket,
        region: files.region || "us-east-1",
        endpoint: files.address,
        forcePathStyle: true,
      };
    case "amazon-s3":
      return { store: "s3", bucket: files.bucket, region: files.region };
    case "google-cloud-storage":
      return { store: "gcs", bucket: files.bucket, projectId: files.project };
    default:
      return null;
  }
}

/**
 * True when asking the key store in the answers makes a request that leaves
 * this host. The key store's own definition says so. A store that cannot be
 * resolved counts as one that does, so that nothing is asked of it by mistake.
 */
function keyStoreLeavesHost(answers: SetupAnswers, deps: Pick<CheckDeps, "paths" | "env">): boolean {
  try {
    const config = resolveSecretsConfig({
      env: deps.env,
      config: { secrets: secretsBlockOf(answers.keys) },
      root: deps.paths.root,
    });
    const definition = secretProviderDefinition(config.provider);
    return definition ? definition.path(config).leavesHost : true;
  } catch {
    return true;
  }
}

/** The key store the answers name, built with the function the Fortress
 *  starts with. */
export function keyStoreOf(
  answers: SetupAnswers,
  deps: Pick<CheckDeps, "paths" | "env" | "keyStore">,
): Promise<SecretProvider> {
  return Promise.resolve(
    deps.keyStore
      ? deps.keyStore(answers)
      : createSecretProvider(
          resolveSecretsConfig({
            env: deps.env,
            config: { secrets: secretsBlockOf(answers.keys) },
            root: deps.paths.root,
          }),
          { env: deps.env },
        ),
  );
}

// ── What a check works with ──────────────────────────────────────────────────

/**
 * What one run of the checks may do. Worked out once from `CheckDeps.when`,
 * and enforced in the two doors every outside call goes through (`ctx.fetch`
 * and `ctx.keyValue`), so a check that forgets to look cannot make a call its
 * mode forbids.
 */
interface May {
  /** A request may leave this host. */
  leaveHost: boolean;
  /** The real thing may be done: a key's value read to be used, a store
   *  opened, a question asked of the model. */
  act: boolean;
}

interface Ctx {
  answers: SetupAnswers;
  deps: CheckDeps;
  timeoutMs: number;
  may: May;
  /** False when asking the key store makes a request that leaves this host. */
  keysOnHost: boolean;
  /** The key store the answers name, built once for one run of the checks. */
  keyStore: () => Promise<SecretProvider>;
  /** Check the name of a key at `path`. Null when the field is empty. */
  key: (at: string) => Promise<CheckLine | null>;
  /** The value of the key named at `path`, for the one call that needs it. */
  keyValue: (at: string) => Promise<string>;
  fetch: typeof fetch;
}

function makeCtx(answers: SetupAnswers, deps: CheckDeps): Ctx {
  let store: Promise<SecretProvider> | null = null;
  const keyStore = (): Promise<SecretProvider> => {
    store ??= keyStoreOf(answers, deps);
    return store;
  };
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const when = deps.when ?? "given";
  const may: May = { leaveHost: when === "given" || when === "checkup", act: when === "given" };
  const keysOnHost = !keyStoreLeavesHost(answers, deps);
  // Whether this run may ask the key store about a key that an answer names.
  const askKeys = may.leaveHost || keysOnHost;
  const calls = deps.fetch ?? fetch;
  const notNow = (): Promise<never> => Promise.reject(new Error("this run of the checks makes no outside call"));
  return {
    answers,
    deps,
    timeoutMs,
    may,
    keysOnHost,
    keyStore,
    fetch: may.leaveHost ? calls : (notNow as unknown as typeof fetch),
    key: async (at) => {
      const name = answerText(answers, at);
      if (!name) return null;
      if (!isKeyName(name)) return refuse("Not a key's name", at);
      // Nothing was asked, so nothing is said.
      if (!askKeys) return null;
      try {
        const has = await withDeadline(
          (await keyStore()).has(name),
          timeoutMs,
          "the key store did not answer in time",
        );
        return has ? found("Found", at) : refuse("No key with this name", at);
      } catch (error) {
        return refuse(
          error instanceof SecretUnavailable
            ? `The key store did not answer: ${error.reason}`
            : "The key store could not be opened",
          at,
        );
      }
    },
    keyValue: async (at) => {
      if (!may.act) return notNow();
      return withDeadline(
        (await keyStore()).get(answerText(answers, at)),
        timeoutMs,
        "the key store did not answer in time",
      );
    },
  };
}

type OptionCheck = (ctx: Ctx) => Promise<CheckLine[]> | CheckLine[];

const nothingToCheck: OptionCheck = () => [];

// ── Step 2 · Keys ────────────────────────────────────────────────────────────

/** Ask the store for a name it does not hold. Any answer proves it answers. */
async function keyStoreAnswers(
  ctx: Ctx,
  says: () => Promise<string> | string,
  /** The field the finding is about, when it is about one. */
  at?: string,
): Promise<CheckLine[]> {
  // The store is asked for a name it does not hold only when a person has
  // given the answer: that is how the setup learns that the store answers at
  // all. Afterwards the lookups of the named keys say it. A made-up name would
  // be a refused read in the organization's key store log, again and again.
  if (!ctx.may.act) return ctx.keysOnHost ? [found(await says(), at)] : [];
  let store: SecretProvider;
  try {
    store = await ctx.keyStore();
  } catch (error) {
    return [refuse(`The key store could not be opened: ${shortReason(error).replace(/^Invalid secrets config: /, "")}`)];
  }
  try {
    await withDeadline(store.has(PROBE_KEY_NAME), ctx.timeoutMs, "the key store did not answer in time");
  } catch (error) {
    return [
      refuse(
        error instanceof SecretUnavailable
          ? `The key store did not answer: ${error.reason}`
          : "The key store did not answer",
      ),
    ];
  }
  return [found(await says(), at)];
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const keysEnv: OptionCheck = (ctx) =>
  keyStoreAnswers(ctx, () => {
    const set = Object.keys(ctx.deps.env).filter(
      // The key is one of the object's own keys.
      // eslint-disable-next-line security/detect-object-injection
      (name) => name.startsWith(SECRET_ENV_PREFIX) && (ctx.deps.env[name] ?? "").trim() !== "",
    ).length;
    return set === 0
      ? `No key is set in this host's environment yet. A key named db-url is the variable ${SECRET_ENV_PREFIX}DB_URL`
      : `${count(set, "key is", "keys are")} set in this host's environment`;
  });

const keysFile: OptionCheck = async (ctx) => {
  const folder = ctx.answers.keys.folder || path.resolve(ctx.deps.paths.root, "secrets");
  if (!path.isAbsolute(folder)) return [refuse("The folder must be a full path, such as /run/secrets", "keys.folder")];
  // The folder a person named for the keys of their own install.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const info = await stat(folder).catch(() => null);
  if (!info) return [refuse(`The folder ${folder} does not exist`, "keys.folder")];
  if (!info.isDirectory()) return [refuse(`${folder} is not a folder`, "keys.folder")];
  return keyStoreAnswers(
    ctx,
    async () => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const names = await readdir(folder).catch(() => [] as string[]);
      const keys = names.filter((name) => isKeyName(name)).length;
      // Beside the folder's own field, so the folder is not written twice.
      return keys === 0 ? "No key in this folder yet" : `${count(keys, "key", "keys")} found`;
    },
    "keys.folder",
  );
};

const keysAzure: OptionCheck = (ctx) => {
  if (!ctx.answers.keys.address) return [refuse("Give the vault's address", "keys.address")];
  return keyStoreAnswers(ctx, () => `Reached with this host's own identity, at ${hostOf(ctx.answers.keys.address)}`);
};

// ── Step 3 · Sign-in ─────────────────────────────────────────────────────────

const signInLocal: OptionCheck = async (ctx) => {
  if (ctx.answers.organization.firstAdministrator) return [];
  // An install from before the setup may run with its console off. Nobody
  // signs in to a console that is off, so it needs no account. A new install's
  // setup switches the console on, and then somebody has to be able to sign in.
  if (ctx.deps.present.setUp && !ctx.deps.present.consoleOn) return [];
  const users = await readUsers(ctx.deps);
  const anyOperator = users.users.some((u) => u.role === "operator" && !u.deletedAt && !u.disabledAt);
  return anyOperator
    ? []
    : [refuse(`Accounts on this Fortress need a first administrator. Name one ${under("organization")}`)];
};

const signInProvider: OptionCheck = async (ctx) => {
  const a = ctx.answers.signIn;
  const lines: CheckLine[] = [];

  if (!a.clientId) lines.push(refuse("Give the client ID", "signIn.clientId"));
  else if (!checkOidcClientId(a.clientId).ok) {
    lines.push(refuse("A client ID is 1 to 256 characters with no spaces", "signIn.clientId"));
  }
  const secret = await ctx.key("signIn.clientSecret");
  if (secret) lines.push(secret);

  const operators = checkOidcGroups("operatorGroups", a.operatorGroups.join(","));
  const readers = checkOidcGroups("readonlyGroups", a.readonlyGroups.join(","));
  if (!operators.ok) lines.push(refuse("A group's name is at most 256 characters, and at most 50 groups have a role", "signIn.operatorGroups"));
  if (!readers.ok) lines.push(refuse("A group's name is at most 256 characters, and at most 50 groups have a role", "signIn.readonlyGroups"));
  if (a.operatorGroups.length === 0 && a.readonlyGroups.length === 0) {
    lines.push(refuse("Give at least one group a role", "signIn.operatorGroups"));
  }
  if (!checkOidcClaimName("groupsClaim", a.groupsClaim).ok) {
    lines.push(refuse("The groups claim is a claim's name: letters, digits and _ . : / -"));
  }

  if (!a.issuer) {
    lines.push(refuse("Give the issuer's address", "signIn.issuer"));
    return lines;
  }
  if (!checkOidcIssuer(a.issuer).ok) {
    lines.push(refuse("The issuer's address must be https, with no query", "signIn.issuer"));
    return lines;
  }
  // A start asks nobody outside this host, and neither does a check made
  // while a person types. The Checkup asks.
  if (!ctx.may.leaveHost) return lines;
  // The provider's own description of itself, read and judged by the console's
  // own code: the same request, and the same rules a sign-in is held to. So
  // "Provider found" here means the console will take this provider, and not
  // only that something answered. The reasons are this program's own words; a
  // provider's text is never repeated.
  const console_ = new OidcClient({
    secrets: ctx.keyStore,
    fetch: ((input, init) =>
      ctx.fetch(input, { ...init, signal: AbortSignal.timeout(ctx.timeoutMs) })) as typeof fetch,
  });
  const described = await console_.metadata(a.issuer);
  if (described.ok) {
    lines.push(found(`Provider found at ${hostOf(a.issuer)}`));
  } else if (described.refusal !== "provider_metadata_invalid") {
    lines.push(refuse("No sign-in provider answers at this address", "signIn.issuer"));
  } else if (described.detail?.includes("different issuer")) {
    lines.push(
      refuse(
        "The provider at this address names another issuer. Copy the issuer exactly as the provider states it",
        "signIn.issuer",
      ),
    );
  } else {
    lines.push(
      refuse(
        `The provider at this address cannot sign people in to this console: ${described.detail ?? "its description of itself is not usable"}`,
        "signIn.issuer",
      ),
    );
  }
  return lines;
};

// ── Step 4 · Data ────────────────────────────────────────────────────────────

async function defaultProbeDatabase(url: string, timeoutMs: number): Promise<string> {
  const client = new Bun.SQL(url, { max: 1, connectionTimeout: Math.max(1, Math.ceil(timeoutMs / 1000)) });
  try {
    const rows = await withDeadline(
      client`SELECT version() AS version`.then((result) => result as { version?: unknown }[]),
      timeoutMs,
      `it ${DEADLINE}`,
    );
    const version = /^PostgreSQL \d+(?:\.\d+)?/.exec(String(rows[0]?.version ?? ""));
    return version ? version[0] : "PostgreSQL";
  } finally {
    // Detached: a close can hang on a dead socket, and a check must end.
    void client.close({ timeout: 1 }).catch(() => {});
  }
}

/**
 * Whether the database program on this disk can get the extension that search
 * needs. This build downloads it from an address it works out from the control
 * plane's, or from `FORTRESS_PGVECTOR_URL`. A Fortress that has neither, and
 * does not have the extension on its disk from an earlier start, cannot bring
 * its database up while a module that searches is on. The start would fail
 * there, so the answer is refused here, in words.
 */
async function searchExtensionReachable(ctx: Ctx): Promise<boolean> {
  if (!needsModel(ctx.answers)) return true;
  if (ctx.answers.controlPlane.connect === "yes") return true;
  if (ctx.deps.env.FORTRESS_PGVECTOR_URL?.trim()) return true;
  const config = await new FileConfigStore(ctx.deps.paths).load().catch(() => null);
  if (config?.postgres?.pgvectorUrl) return true;
  const version = ctx.deps.env.FORTRESS_PG_VERSION?.trim() || config?.postgres?.version || DEFAULT_PG_VERSION;
  return pgvectorPresent(ctx.deps.paths.postgresVersionDir(version));
}

// The folder itself is on the setup's first screen, and in `hx-fortress status`.
const databaseThisDisk: OptionCheck = async (ctx) =>
  (await searchExtensionReachable(ctx))
    ? [found("Postgres runs on this disk, in the Fortress's folder")]
    : [
        refuse(
          "Sessions searches with a database extension, and this build downloads it through a control plane. " +
            `Connect one, use your own Postgres, or switch Sessions off ${under("modules")}`,
        ),
      ];

const databaseOwn: OptionCheck = async (ctx) => {
  const at = "data.database.address";
  const name = ctx.answers.data.database.address;
  if (!name) {
    // An install made before the setup may hold the address itself, in its
    // environment or its config. That stays as it is until the answer changes.
    return ctx.deps.present.kept.databaseAddress
      ? [found("The address is kept on this host by an earlier setup")]
      : [refuse("Give the name of the key that holds the database's address", at)];
  }
  const key = await ctx.key(at);
  if (key && !key.ok) return [key];
  if (!ctx.may.act) return key ? [key] : [];
  let url: string;
  try {
    url = await ctx.keyValue(at);
    assertDatabaseUrlSecret(name, url);
  } catch (error) {
    return [
      refuse(
        error instanceof SecretUnavailable
          ? `The key was read, but ${error.reason}`
          : "The key could not be read",
        at,
      ),
    ];
  }
  try {
    const version = await (ctx.deps.probeDatabase ?? ((u: string) => defaultProbeDatabase(u, ctx.timeoutMs)))(url);
    return [...(key ? [key] : []), found(`Database reached. ${version}`)];
  } catch (error) {
    return [...(key ? [key] : []), refuse(`The database could not be opened: ${databaseRefusal(error)}`)];
  }
};

function filesFields(ctx: Ctx, required: readonly ("address" | "bucket" | "region" | "project")[]): CheckLine[] {
  const files = ctx.answers.data.files;
  const names: Record<string, string> = {
    address: "Give the storage's address",
    bucket: "Give the bucket's name",
    region: "Give the bucket's region",
    project: "Give the project that holds the bucket",
  };
  const lines: CheckLine[] = [];
  for (const field of required) {
    // `field` is one of four literal keys.
    // eslint-disable-next-line security/detect-object-injection
    if (!files[field]) lines.push(refuse(names[field] ?? "Give a value", `data.files.${field}`));
  }
  if (files.address && !plainHttpsAddress(files.address)) {
    lines.push(
      refuse("The storage's address must be https, with no user name or password in it", "data.files.address"),
    );
  }
  return lines;
}

async function filesProbe(ctx: Ctx): Promise<CheckLine[]> {
  if (!ctx.may.act) return [];
  let credentials = filesCredentialsOf(ctx.answers.data.files);
  if (!credentials) return [];
  // Keys that an earlier way of setting this Fortress up left on the host stay
  // in use while the answer still names the same bucket. The test write uses
  // them, as the Fortress does. Without them it would test this host's own
  // access, which such an install may not have, and refuse a store that works.
  const unchanged =
    JSON.stringify(ctx.answers.data.files) === JSON.stringify(ctx.deps.present.answers.data.files);
  if (ctx.deps.present.kept.filesKeys && unchanged) {
    credentials =
      (await heldFilesCredentials(ctx.deps.env, ctx.deps.vaultCredentials).catch(() => null)) ?? credentials;
  }
  try {
    await withDeadline(
      (ctx.deps.probeFiles ?? ((c: VaultCredentials) => buildDirectStore(c).selfTest()))(credentials),
      Math.max(ctx.timeoutMs, 15_000),
      `the store ${DEADLINE}`,
    );
    return [found("A test file was written, read and removed")];
  } catch (error) {
    return [refuse(`The test file could not be written: ${filesRefusal(error)}`)];
  }
}

const filesWith =
  (required: readonly ("address" | "bucket" | "region" | "project")[]): OptionCheck =>
  async (ctx) => {
    // A file store that no module uses is not opened.
    if (!needsFiles(ctx.answers)) return [];
    const fields = filesFields(ctx, required);
    return fields.length > 0 ? fields : filesProbe(ctx);
  };

// ── Step 6 · AI model ────────────────────────────────────────────────────────

const modelNone: OptionCheck = (ctx) =>
  needsModel(ctx.answers)
    ? [refuse(`Sessions needs an AI model for search. Choose one, or switch Sessions off ${under("modules")}`)]
    : [];

const modelOpenAiCompatible: OptionCheck = async (ctx) => {
  const model = ctx.answers.model;
  const address = model.address || DEFAULT_OPENAI_BASE_URL;
  if (!plainHttpsAddress(address)) {
    return [refuse("The model's address must be https, with no user name or password in it", "model.address")];
  }
  if (!model.key) {
    return ctx.deps.present.kept.modelKey
      ? [found("The model's key is kept on this host by an earlier setup")]
      : [refuse("Give the name of the model's key", "model.key")];
  }
  const key = await ctx.key("model.key");
  if (key && !key.ok) return [key];
  if (model.name && !/^[\x21-\x7e]{1,128}$/.test(model.name)) {
    return [refuse("A model's name is 1 to 128 characters with no spaces", "model.name")];
  }
  // A question to the model costs a little each time, so it is asked when a
  // person gives the answer and not at every start.
  if (!ctx.may.act) return key ? [key] : [];
  // What is asked is what the Fortress will ask: its own function works out
  // the address, the model's name and the size of an answer, so the check and
  // the running Fortress cannot call two different places.
  let asked: ReturnType<typeof resolveEmbedConfig>;
  try {
    asked = resolveEmbedConfig(ctx.deps.env, await ctx.keyValue("model.key"), {
      address,
      ...(model.name ? { name: model.name } : {}),
    });
  } catch {
    return [refuse("The model's key could not be read", "model.key")];
  }
  // One fixed word. Nothing of the organization's is sent.
  let status: number;
  try {
    const response = await ctx.fetch(`${asked.baseUrl}/embeddings`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${asked.apiKey}` },
      body: JSON.stringify({ model: asked.model, input: ["ready"], dimensions: asked.dimensions }),
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
    status = response.status;
    await response.body?.cancel().catch(() => {});
  } catch {
    return [...(key ? [key] : []), refuse("The model did not answer: nothing answers at this address")];
  }
  if (status >= 200 && status < 300) return [...(key ? [key] : []), found("The model answered a test question")];
  const why =
    status === 401 || status === 403
      ? `${status}, so it refused the key`
      : status === 404
        ? "404, so it does not know this model, or the address is not an OpenAI-compatible one"
        : String(status);
  return [...(key ? [key] : []), refuse(`The model did not answer: ${why}`)];
};

// ── Step 7 · Network ─────────────────────────────────────────────────────────

const networkDirect: OptionCheck = async (ctx) => {
  if (!ctx.may.act) return [];
  const rows = reachOf(ctx.answers, {
    needsFiles: needsFiles(ctx.answers),
    needsModel: needsModel(ctx.answers),
  }).filter((row) => row.probe !== null);
  if (rows.length === 0) return [];
  const answered = await Promise.all(
    rows.map(async (row) => {
      try {
        const response = await ctx.fetch(row.probe as string, {
          method: "HEAD",
          redirect: "manual",
          signal: AbortSignal.timeout(Math.min(ctx.timeoutMs, 5_000)),
        });
        await response.body?.cancel().catch(() => {});
        return true;
      } catch {
        return false;
      }
    }),
  );
  const silent = rows.filter((_, index) => answered[index] !== true);
  if (silent.length === 0) {
    // By name while they fit on a line: the list above may hold addresses that
    // the setup cannot ask, and a bare count would read as some of them silent.
    const names = rows.map((row) => row.address);
    return [
      found(
        names.length <= 3
          ? `${names.join(", ")} answered from this host`
          : `${names.length} addresses answered from this host`,
      ),
    ];
  }
  // Not a wrong answer: the network between this host and the address is
  // closed. The setup says so and goes on.
  return silent.map((row) => soft(`${row.address} did not answer from this host`));
};

// ── Step 10 · Control plane ──────────────────────────────────────────────────

const ENROLLED_ELSEWHERE = "This Fortress is enrolled with another control plane.";
const ENROLLED_UNKNOWN =
  "This Fortress holds an enrollment, and its settings do not say with which control plane.";

function removeEnrollment(paths: FortressPaths): string {
  return (
    `To connect it here, stop it, remove the folder ${path.dirname(paths.credentials)}, ` +
    "and answer this question again. It then enrolls as a new Fortress"
  );
}

/**
 * Whether this Fortress holds an enrollment, and the connection address of the
 * control plane it belongs to. The address is config.json's while a control
 * plane is connected. After the setup disconnected one, it is what the setup
 * wrote down at that moment. Null: an enrollment is held and nothing on this
 * host says whose it is.
 *
 * The checks and `apply.ts` both ask this one function, so they cannot
 * disagree about what "enrolled" means.
 */
export async function enrolledWith(
  deps: Pick<CheckDeps, "paths" | "present">,
): Promise<{ held: boolean; url: string | null }> {
  const credential = await new FileCredentialStore(deps.paths.credentials).load().catch(() => null);
  if (!credential) return { held: false, url: null };
  const config = await new FileConfigStore(deps.paths).load().catch(() => null);
  return { held: true, url: config?.cloud?.url ?? deps.present.disconnectedFrom };
}

const controlPlaneNo: OptionCheck = () => [];

const controlPlaneYes: OptionCheck = async (ctx) => {
  const at = "controlPlane.address";
  const parsed = controlPlaneUrl(ctx.answers.controlPlane.address);
  if (!parsed.ok) return [refuse(parsed.reason, at)];

  // A Fortress that holds a credential is enrolled with ONE control plane,
  // and what it stores belongs to the organization it enrolled for. The same
  // address needs nothing more. Any other address is refused until a person
  // removes the enrollment by hand: an answer in the setup never hands a
  // Fortress, with what it holds, to another control plane. "Enrolled" is the
  // word for a credential that is held; whether the link is up is the
  // status's to say.
  const enrolled = await enrolledWith(ctx.deps);
  if (enrolled.held) {
    if (enrolled.url === parsed.url) return [found("This Fortress is enrolled there")];
    return [refuse(`${enrolled.url ? ENROLLED_ELSEWHERE : ENROLLED_UNKNOWN} ${removeEnrollment(ctx.deps.paths)}`, at)];
  }
  if (ctx.deps.present.pinned["controlPlane.connect"]) {
    return [found("The control plane is set by this host's environment")];
  }
  const { token } = ctx.answers.controlPlane;
  // A setup with nobody at the screen gives an enrollment token by the name it
  // has in the key store. It is read when the setup ends.
  if (token) {
    const key = await ctx.key("controlPlane.token");
    if (key && !key.ok) return [key];
    return [found("The enrollment token is read from the key store when the setup ends")];
  }
  const pending = await new FilePendingEnrollmentStore(ctx.deps.paths.pendingEnrollment).load().catch(() => null);
  if (pending?.cloudUrl === parsed.url) {
    return [found("An enrollment token is held for the first connection. This Fortress connects when it starts")];
  }

  const enrollment = ctx.deps.enrollment;
  if (enrollment && enrollment.url === parsed.url) {
    if (enrollment.state === "ready") return [found("Signed in. This Fortress connects when it starts")];
    if (enrollment.state === "refused") {
      return [refuse(enrollment.reason ?? "The control plane refused the code", at)];
    }
    if (enrollment.state === "expired") {
      return [{ ...refuse("The code ran out. Ask for a new one"), needs: "enrollment" }];
    }
    return [
      {
        ...refuse("Waiting for the sign-in at the control plane. Sign in there and confirm the code, or choose No"),
        needs: "enrollment",
      },
    ];
  }
  return [
    {
      ...refuse("Nobody has signed in at the control plane for this Fortress yet. Get a code and sign in, or choose No"),
      needs: "enrollment",
    },
  ];
};

// ── Step 9 · Updates ─────────────────────────────────────────────────────────

// What this build does with the answer, said in the answer's own place. Today
// `hx-fortress update` downloads a new version through the control plane, and
// refuses when there is none.
const updatesFrom: OptionCheck = (ctx) =>
  ctx.answers.controlPlane.connect === "yes"
    ? [found("In this build a new version is downloaded through the control plane")]
    : [found("In this build a new version is downloaded through a control plane. With none, a new build is installed on the host")];

// ── The checks, by option id ─────────────────────────────────────────────────

/**
 * One check for every option the list marks as built: the choice's path, then
 * the option's id. An option with nothing to check still has its entry, so
 * that a missing one is a mistake and not a silence.
 */
export const OPTION_CHECKS: Readonly<Record<string, Readonly<Record<string, OptionCheck>>>> = {
  "keys.store": {
    env: keysEnv,
    file: keysFile,
    "azure-key-vault": keysAzure,
  },
  "signIn.provider": {
    local: signInLocal,
    "openid-connect": signInProvider,
  },
  "data.database.store": {
    "this-disk": databaseThisDisk,
    postgres: databaseOwn,
  },
  "data.files.store": {
    "s3-compatible": filesWith(["address", "bucket"]),
    "amazon-s3": filesWith(["bucket", "region"]),
    "google-cloud-storage": filesWith(["bucket", "project"]),
  },
  "model.provider": {
    [NONE]: modelNone,
    "openai-compatible": modelOpenAiCompatible,
  },
  "network.route": {
    direct: networkDirect,
  },
  "records.copyTo": {
    [NONE]: nothingToCheck,
  },
  "records.keepFor": {
    "until-removed": nothingToCheck,
  },
  "updates.from": {
    "project-releases": updatesFrom,
  },
  "updates.install": {
    "administrator-approves": nothingToCheck,
  },
  "controlPlane.connect": {
    no: controlPlaneNo,
    yes: controlPlaneYes,
  },
};

// ── The parts of a step that are not a choice ────────────────────────────────

async function readUsers(deps: CheckDeps): Promise<UsersFile> {
  if (deps.users) return deps.users();
  return new UsersStore(path.join(deps.paths.uiRoot, "users.json")).load();
}

async function organizationFields(ctx: Ctx): Promise<CheckLine[]> {
  const lines: CheckLine[] = [];
  const { name, firstAdministrator } = ctx.answers.organization;
  if (!name) lines.push(refuse("Give the organization a name", "organization.name"));
  else if (!isOrganizationName(name)) {
    lines.push(refuse("An organization's name is 1 to 80 characters", "organization.name"));
  }
  if (firstAdministrator) {
    const at = "organization.firstAdministrator";
    if (checkLogin(firstAdministrator) !== null) {
      lines.push(
        refuse(
          "A login is 2 to 64 lowercase letters, digits, dots, dashes or underscores, and starts with a letter or a digit",
          at,
        ),
      );
    } else {
      const users = await readUsers(ctx.deps).catch(() => null);
      const existing = users?.users.find((user) => user.login === firstAdministrator);
      if (existing?.deletedAt) {
        lines.push(refuse("This login was removed from this Fortress. Choose another", at));
      } else if (existing) {
        lines.push(found("An account with this login exists. Setup leaves it as it is", at));
      }
    }
  }
  return lines;
}

function consoleAddress(ctx: Ctx): CheckLine[] {
  const address = ctx.answers.signIn.consoleAddress;
  if (!address) return [];
  return checkPublicUrl(address).ok
    ? []
    : [refuse("The console's address must be https, with no path", "signIn.consoleAddress")];
}

function filesNeeded(ctx: Ctx): CheckLine[] {
  return needsFiles(ctx.answers) && ctx.answers.data.files.store === NONE
    ? [refuse(`Sessions keeps files. Choose where they rest, or switch Sessions off ${under("modules")}`)]
    : [];
}

function moduleIds(ctx: Ctx): CheckLine[] {
  const known = new Set((ctx.deps.catalog ?? MODULE_CATALOG).map((entry) => entry.id));
  return Object.keys(ctx.answers.modules)
    .filter((id) => ctx.answers.modules[id] === true && !known.has(id))
    .map((id) => refuse(`${/^[a-z][a-z0-9_]{0,63}$/.test(id) ? id : "A module"} is not a module of this build`));
}

/** An answer the host's environment decides cannot be given another value. */
function pinnedConflicts(step: StepId, ctx: Ctx): CheckLine[] {
  const lines: CheckLine[] = [];
  for (const [at, variable] of Object.entries(ctx.deps.present.pinned)) {
    if (at.split(".")[0] !== step) continue;
    if (answerText(ctx.answers, at) === answerText(ctx.deps.present.answers, at)) continue;
    lines.push(
      refuse(`This host's environment decides this answer (${variable}). Remove the variable to change it here`, at),
    );
  }
  return lines;
}

// ── Running the checks ───────────────────────────────────────────────────────

async function linesOf(step: StepId, ctx: Ctx): Promise<CheckLine[]> {
  const pinned = pinnedConflicts(step, ctx);
  if (pinned.length > 0) return pinned;

  const lines: CheckLine[] = [];
  if (step === "organization") lines.push(...(await organizationFields(ctx)));
  if (step === "signIn") lines.push(...consoleAddress(ctx));
  if (step === "data") lines.push(...filesNeeded(ctx));
  if (step === "modules") lines.push(...moduleIds(ctx));

  for (const { step: owner, block } of choicesOf(SETUP_LIST)) {
    if (owner !== step) continue;
    const chosen = answerText(ctx.answers, block.path);
    const option = block.options.find((o) => o.id === chosen);
    // "None" on a choice that is only asked while something needs it.
    if (!option && chosen === NONE && block.neededBy) continue;
    if (!option) {
      lines.push(refuse(`${block.label ?? stepById(step).name}: choose one of the options`, block.path));
      continue;
    }
    if (!option.built) {
      lines.push(refuse(`${option.name} is not in this build yet`, block.path));
      continue;
    }
    // The path and the id come from the list, never from an answer.
    const check = OPTION_CHECKS[block.path]?.[option.id];
    if (!check) {
      lines.push(refuse(`${option.name} has no check in this build, so it cannot be chosen`, block.path));
      continue;
    }
    try {
      lines.push(...(await check(ctx)));
    } catch {
      // Whatever went wrong is not this person's to read: it could quote
      // something the check was holding. The terminal's `setup check` and the
      // Fortress's own log say more.
      lines.push(refuse("The check could not be made"));
    }
  }
  // An answer that this host's environment decides cannot be put right here.
  // The line says where it can.
  return lines.map((line) => {
    const variable = line.path && !line.ok ? ctx.deps.present.pinned[line.path] : undefined;
    return variable
      ? { ...line, text: `${line.text}. This host's environment decides this answer: set ${variable} there` }
      : line;
  });
}

/** Check one question's answer. */
export async function checkStep(step: StepId, answers: SetupAnswers, deps: CheckDeps): Promise<StepCheck> {
  const lines = await linesOf(step, makeCtx(answers, deps));
  return { step, ok: !lines.some((line) => !line.ok && !line.soft), lines };
}

/** Check every question's answer, in the list's order. One key store is built
 *  for the whole run. */
export async function checkAll(answers: SetupAnswers, deps: CheckDeps): Promise<StepCheck[]> {
  const ctx = makeCtx(answers, deps);
  const results: StepCheck[] = [];
  for (const step of STEP_IDS) {
    const lines = await linesOf(step, ctx);
    results.push({ step, ok: !lines.some((line) => !line.ok && !line.soft), lines });
  }
  return results;
}

/** The lines that refuse an answer, each with the step it belongs to: what a
 *  terminal or a settings file prints when the setup cannot go on. */
export function refusalsOf(checks: readonly StepCheck[]): { step: StepId; text: string }[] {
  return checks.flatMap((check) =>
    check.lines.filter((line) => !line.ok && !line.soft).map((line) => ({ step: check.step, text: line.text })),
  );
}
