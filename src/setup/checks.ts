// The check behind each answer of the setup.
//
// EVERY ANSWER IS CHECKED WHEN IT IS GIVEN, in the browser, in the terminal
// and from a settings file alike, and again when HX Fortress starts. A check
// does the real thing where it can: it asks the key store for the key, opens
// the database, writes a test file, fetches the sign-in provider's own
// description of itself.
//
// WHERE THE CHECK RUNS DECIDES WHAT IT CAN DO. A setup on the machine that
// runs HX Fortress checks with that machine's own key store, database and
// network: the real thing. `hx-fortress install` runs on an engineer's
// computer before anything exists, so it checks what that computer can: the
// shape of each answer, whether the computer is signed in to the place, a key
// a person typed (it is sent to the model's own address, once), and the
// sign-in provider's description of itself. What it cannot see from there,
// HX Fortress checks with the real thing at its first start. What it found is one plain line. A wrong answer is
// refused with a line that says what is wrong and, where there is one thing to
// do about it, what that is.
//
// A CHECK NEVER SHOWS A KEY. It asks the key store for the key by its name. A
// key store answers that by reading the key, so the value is in this
// program's memory for the moment of the call, and it goes nowhere a person
// can read. Where a check must USE a key, it uses it as HX Fortress will: the
// database's address is opened, and the model's key is sent to the address the
// model's answer gives. So whoever gives the answers decides where a named key
// is sent, exactly as they decide it for the running HX Fortress. Nothing an
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
  pagesOrigin,
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
import { answerText, hostOf, isKeyName, routesOf, type SetupAnswers } from "./answers";
import { controlPlaneUrl, sameControlPlane } from "./control-plane";
import {
  choicesOf,
  INSTALL_PLACES,
  isCloudPlace,
  keyFields,
  NONE,
  optionOffered,
  phrase,
  placeInfo,
  SETUP_LIST,
  STEP_IDS,
  stepById,
  switchesOf,
  type PlaceId,
  type StepId,
  type Way,
} from "./list";
import { MODEL_HOSTS, reachOf } from "./reach";
import type { CheckLine, PlaceRow, StepCheck } from "./view";

export type { CheckLine, StepCheck } from "./view";
import {
  heldFilesCredentials,
  KEY_STORE_ANSWER,
  needsFiles,
  needsModel,
  type PresentAnswers,
} from "./read";

type FortressPaths = ReturnType<typeof fortressPaths>;

/** The keys a person typed in the install, kept apart from the answers. */
export interface TypedKeys {
  /** True when a key was typed for the field at this path. */
  has(path: string): boolean;
  /** The key itself, for the one call that uses it. */
  get(path: string): string | undefined;
}

export interface CheckDeps {
  paths: FortressPaths;
  env: Record<string, string | undefined>;
  /** The install as it is now: what is pinned, and what an earlier setup kept. */
  present: PresentAnswers;
  catalog?: readonly CatalogEntry[];
  /**
   * How the answers are being given. `install` is an engineer's computer,
   * before anything exists: see the top of this file. Left out: a setup on
   * the machine that runs HX Fortress.
   */
  way?: Way;
  /** In the install: the keys a person typed. */
  typed?: TypedKeys;
  /** In the install: one place of this build, as this computer sees it. Null
   *  when this build cannot make HX Fortress there. */
  place?: (place: PlaceId) => Promise<PlaceRow | null> | PlaceRow | null;
  /** In the install: what the place itself refuses in these answers. */
  placeRefusals?: (answers: SetupAnswers) => Promise<CheckLine[]> | CheckLine[];
  /** In the install: true when the command gave a one-time install id. */
  installId?: boolean;
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
   * `checkup`: somebody asked a running HX Fortress to check itself. A check that
   * would spend money (a question to the model), or that the Checkup's own
   * probes make (the database, the file store), is left out. The key store is
   * asked for each key that an answer names, as a start asks for it, and what
   * comes back is only whether it is there. The sign-in provider is asked
   * whether it still describes itself.
   *
   * `start`: HX Fortress is starting. A start adds no request that leaves
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
  /** Injected in tests. Each defaults to the real thing. */
  keyStore?: (answers: SetupAnswers) => Promise<SecretProvider> | SecretProvider;
  probeDatabase?: (url: string) => Promise<string>;
  probeFiles?: (credentials: VaultCredentials) => Promise<void>;
  users?: () => Promise<UsersFile>;
  /** The Agentic Sessions credentials file, as an earlier setup left it. */
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
export function secretsBlockOf(given: SetupAnswers["keys"]): Record<string, string> {
  // A vault that the install made is named, and its address follows from the
  // name.
  const keys =
    given.store === "azure-key-vault" && !given.address && given.vault
      ? { ...given, address: `https://${given.vault}.vault.azure.net` }
      : given;
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

/** The Agentic Sessions credentials an answer to the files question makes: where the
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

/** The key store the answers name, built with the function HX Fortress
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
  /** True on an engineer's computer, before anything exists. */
  install: boolean;
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
  const install = deps.way === "install";
  // The key store of an install does not exist yet, so nothing is asked of it.
  const keysOnHost = !install && !keyStoreLeavesHost(answers, deps);
  // Whether this run may ask the key store about a key that an answer names.
  const askKeys = !install && (may.leaveHost || keysOnHost);
  const calls = deps.fetch ?? fetch;
  const notNow = (): Promise<never> => Promise.reject(new Error("this run of the checks makes no outside call"));
  return {
    answers,
    deps,
    timeoutMs,
    may,
    install,
    keysOnHost,
    keyStore: install ? notNow : keyStore,
    fetch: may.leaveHost ? calls : (notNow as unknown as typeof fetch),
    key: async (at) => {
      const name = answerText(answers, at);
      // A key a person typed is written to the key store when everything is
      // made, under the name its field gives it. There is nothing to look up,
      // and nothing to say. Any other name with a typed key is not an answer.
      if (install && deps.typed?.has(at)) {
        return name === keyFields().get(at)?.typedAs ? null : refuse("Not a key's name", at);
      }
      if (!name) return null;
      if (!isKeyName(name)) return refuse("Not a key's name", at);
      if (install) {
        // The name a typed key gets belongs to that key. An answer that
        // borrowed it would be given the other key when HX Fortress starts.
        for (const [other, field] of keyFields()) {
          if (other !== at && field.typedAs === name && deps.typed?.has(other)) {
            return refuse("This is the name of another key that was typed here", at);
          }
        }
        return found("HX Fortress reads the key by this name when it starts", at);
      }
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
      if (install) {
        const typed = deps.typed?.get(at);
        return typed === undefined ? notNow() : typed;
      }
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

// In the install the key store does not exist yet, or is not this computer's
// to open: only the shape of the answer is checked there.
const keysEnv: OptionCheck = (ctx) =>
  ctx.install
    ? []
    : keyStoreAnswers(ctx, () => {
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
  if (ctx.install) {
    const named = ctx.answers.keys.folder;
    return named && !named.startsWith("/") ? [refuse("A folder starts with /", "keys.folder")] : [];
  }
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
  if (ctx.install) {
    // The install makes the vault, so it is named, not addressed.
    return /^[a-z0-9-]{3,24}$/.test(ctx.answers.keys.vault)
      ? []
      : [refuse("3 to 24 lowercase letters, digits or dashes", "keys.vault")];
  }
  const address = secretsBlockOf(ctx.answers.keys).vaultUrl ?? "";
  if (!address) return [refuse("Give the vault's address", "keys.address")];
  return keyStoreAnswers(ctx, () => `Reached with this host's own identity, at ${hostOf(address)}`);
};

// ── Step 1 · Where ───────────────────────────────────────────────────────────

/**
 * user@host, with an optional :port. A place hands this to the system's own
 * `ssh`, so it is held to plain names here: a value that starts with a dash
 * would be read as an option of that command, and a space or a quote would
 * split it. A place must still pass it after `--`.
 */
const SSH_ADDRESS =
  /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?$/;

/** Where HX Fortress runs. Asked by the install alone. */
async function whereLines(ctx: Ctx): Promise<CheckLine[]> {
  const { place, region, ssh } = ctx.answers.where;
  if (!(INSTALL_PLACES as readonly string[]).includes(place)) {
    return [refuse("Choose where HX Fortress runs", "where.place")];
  }
  const info = placeInfo(place);
  if (place === "docker") {
    if (!SSH_ADDRESS.test(ssh)) return [refuse("Write it as user@host", "where.ssh")];
  } else if (!info.regions.some((r) => r.id === region)) {
    return [refuse("Choose a region", "where.region")];
  }
  // Whether this computer is signed in there is asked of the place itself,
  // and not while a person is still typing.
  if (!ctx.may.leaveHost) return [];
  const row = (await ctx.deps.place?.(info.id)) ?? null;
  if (!row || !row.offered) {
    return [
      refuse(
        `This build cannot make HX Fortress ${place === "docker" ? "on a machine with Docker" : `in ${info.short}`} yet`,
        "where.place",
      ),
    ];
  }
  if (row.needsSignIn && !row.signedInAs) {
    return [
      {
        ...refuse(
          `This computer is not signed in to ${info.short}. Run ${row.signInCommand}, then check again`,
          "where.place",
        ),
        needs: "signIn",
      },
    ];
  }
  // Who this computer is signed in as stands in the place's own row. A line
  // here would say it twice.
  return [];
}

// ── Step 3 · Address ─────────────────────────────────────────────────────────

/** A hostname: labels of letters, digits and dashes, with a dot between. */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function addressLines(ctx: Ctx): CheckLine[] {
  const { hostname } = ctx.answers.address;
  const at = "address.hostname";
  if (!hostname) {
    // On its own machine an HX Fortress may answer there only.
    return ctx.install ? [refuse("A hostname, such as hx.your-company.com", at)] : [];
  }
  if (!HOSTNAME.test(hostname) || !checkPublicUrl(`https://${hostname}`).ok) {
    return [refuse("A hostname, such as hx.your-company.com", at)];
  }
  return [];
}

const certificateOwn: OptionCheck = async (ctx) => {
  const at = "address.certificateName";
  if (!ctx.answers.address.certificateName) return [refuse("Name the certificate", at)];
  const key = await ctx.key(at);
  return key ? [key] : [];
};

// ── Step 3 · Sign-in ─────────────────────────────────────────────────────────

const signInLocal: OptionCheck = async (ctx) => {
  const login = ctx.answers.organization.firstAdministrator;
  const none = `Accounts on this HX Fortress need a first administrator. Name one ${under("organization")}`;
  // An install starts from nothing, so somebody has to be named.
  if (ctx.install) return login ? [] : [refuse(none)];
  // An install from before the setup may run with its console off. Nobody
  // signs in to a console that is off, so it needs no account. A new install's
  // setup switches the console on, and then somebody has to be able to sign in
  // and change things: the account the setup makes for the login that is
  // named, or one that administers already.
  if (await somebodyAdministers(ctx)) return [];
  // A login that is named and already has an account keeps that account as it
  // is. One that only reads, or is switched off, is no first administrator.
  return [
    refuse(
      login
        ? `The account ${login} exists and does not administer this HX Fortress. Name another first administrator ${under("organization")}`
        : none,
    ),
  ];
};

/** Whether somebody can change things in the console without a group at the
 *  identity provider: an account on this HX Fortress that administers it. */
async function somebodyAdministers(ctx: Ctx): Promise<boolean> {
  // An install makes no account on HX Fortress when people sign in through a
  // provider: the first administrator is then a member of a group. (With
  // accounts on HX Fortress, the install's own check asks for the login.)
  if (ctx.install) return false;
  // Nobody signs in to a console that is off.
  if (ctx.deps.present.setUp && !ctx.deps.present.consoleOn) return true;
  const users = await readUsers(ctx.deps).catch(() => null);
  const administers = (u: UsersFile["users"][number]): boolean => u.role === "operator" && !u.deletedAt && !u.disabledAt;
  // On the machine itself the setup makes the first administrator's account.
  // A login that already has an account keeps that account as it is, so it
  // counts only when that account administers.
  const login = ctx.answers.organization.firstAdministrator;
  if (login) {
    const existing = users?.users.find((u) => u.login === login);
    if (!existing || administers(existing)) return true;
  }
  return users?.users.some(administers) ?? false;
}

const signInProvider: OptionCheck = async (ctx) => {
  const a = ctx.answers.signIn;
  const lines: CheckLine[] = [];

  if (!a.clientId) lines.push(refuse("Give the client ID", "signIn.clientId"));
  else if (!checkOidcClientId(a.clientId).ok) {
    lines.push(refuse("A client ID is 1 to 256 characters with no spaces", "signIn.clientId"));
  }
  const secret = await ctx.key("signIn.clientSecret");
  if (secret) lines.push(secret);

  const groups = [
    ["administratorGroups", a.administratorGroups],
    ["operatorGroups", a.operatorGroups],
    ["readonlyGroups", a.readonlyGroups],
    ["viewerGroups", a.viewerGroups],
  ] as const;
  for (const [field, names] of groups) {
    if (!checkOidcGroups(field, names.join(",")).ok) {
      lines.push(
        refuse("A group's name is at most 256 characters, and at most 50 groups have a role", `signIn.${field}`),
      );
    }
  }
  if (groups.every(([, names]) => names.length === 0)) {
    lines.push(refuse("Give at least one group a role", "signIn.administratorGroups"));
  } else if (a.administratorGroups.length === 0 && a.operatorGroups.length === 0 && !(await somebodyAdministers(ctx))) {
    // Auditors read, and Viewers open nothing in the console. With only their
    // groups, and no account on this HX Fortress that administers it, nobody
    // could change anything in the console.
    lines.push(
      refuse(
        "Give a group to Administrators or Operators. Auditors only read, and Viewers open nothing in the console",
        "signIn.administratorGroups",
      ),
    );
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
 * plane's, or from `FORTRESS_PGVECTOR_URL`. An HX Fortress that has neither, and
 * does not have the extension on its disk from an earlier start, cannot bring
 * its database up while a module that searches is on. The start would fail
 * there, so the answer is refused here, in words.
 */
async function searchExtensionReachable(ctx: Ctx): Promise<boolean> {
  if (!needsModel(ctx.answers)) return true;
  // A control plane whose connection is switched off is asked for nothing.
  if (ctx.answers.controlPlane.connect === "yes" && ctx.answers.controlPlane.connected !== "off") return true;
  if (ctx.deps.env.FORTRESS_PGVECTOR_URL?.trim()) return true;
  const config = await new FileConfigStore(ctx.deps.paths).load().catch(() => null);
  if (config?.postgres?.pgvectorUrl) return true;
  const version = ctx.deps.env.FORTRESS_PG_VERSION?.trim() || config?.postgres?.version || DEFAULT_PG_VERSION;
  return pgvectorPresent(ctx.deps.paths.postgresVersionDir(version));
}

// The folder itself is on the setup's first screen, and in `hx-fortress status`.
const databaseThisDisk: OptionCheck = async (ctx) =>
  (await searchExtensionReachable(ctx))
    ? [found("Postgres runs on this disk, in HX Fortress's folder")]
    : [
        refuse(
          "Agentic Sessions searches with a database extension, and this build downloads it through a control plane. " +
            `Connect one, use an existing Postgres, or switch Agentic Sessions off ${under("modules")}`,
        ),
      ];

/** What a connection string starts with. Only that is looked at: the string
 *  holds a password. */
const CONNECTION_STRING = /^postgres(?:ql)?:\/\/\S+$/i;

/** A database that is reached by an address: one the organization already
 *  runs, and on the machine itself also one that an install made. */
const databaseByAddress: OptionCheck = async (ctx) => {
  const at = "data.database.address";
  const name = ctx.answers.data.database.address;
  if (ctx.install) {
    // The engineer's computer is usually not where the database can be
    // reached from, so it is not opened here. HX Fortress opens it when it
    // starts.
    const typed = ctx.deps.typed?.get(at);
    if (typed !== undefined) {
      return CONNECTION_STRING.test(typed.trim()) ? [] : [refuse("It starts with postgres://", at)];
    }
    if (!name) return [refuse("Paste the connection string", at)];
    const key = await ctx.key(at);
    return key ? [key] : [];
  }
  if (!name) {
    // An install made before the setup may hold the address itself, in its
    // environment or its config. That stays as it is until the answer changes.
    return ctx.deps.present.kept.databaseAddress
      ? [found("The address is kept on this host by an earlier setup")]
      : [refuse("Give the name of the key that holds the connection string", at)];
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
  // Keys that an earlier way of setting this HX Fortress up left on the host stay
  // in use while the answer still names the same bucket. The test write uses
  // them, as HX Fortress does. Without them it would test this host's own
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

const AGENTIC_SESSIONS = "Agentic Sessions";

const modelNone: OptionCheck = (ctx) =>
  needsModel(ctx.answers)
    ? [
        refuse(
          `${AGENTIC_SESSIONS} needs an AI model for search. Choose one, or switch ${AGENTIC_SESSIONS} off ${under("modules")}`,
        ),
      ]
    : [];

/**
 * How each provider is asked whether a key is good: one request that lists
 * its models. It costs nothing and sends nothing of the organization's. The
 * key goes in a header, never in the address.
 */
const KEY_PROBES: Readonly<Record<string, (key: string) => { url: string; headers: Record<string, string> }>> = {
  anthropic: (key) => ({
    url: `https://${MODEL_HOSTS.anthropic}/v1/models?limit=1`,
    headers: { "x-api-key": key, "anthropic-version": "2026-10-21" },
  }),
  openai: (key) => ({
    url: `https://${MODEL_HOSTS.openai}/v1/models`,
    headers: { authorization: `Bearer ${key}` },
  }),
  google: (key) => ({
    url: `https://${MODEL_HOSTS.google}/v1beta/models?pageSize=1`,
    headers: { "x-goog-api-key": key },
  }),
};

/** One of the providers this build asks directly. */
const modelProvider =
  (provider: "anthropic" | "openai" | "google"): OptionCheck =>
  async (ctx) => {
    const model = ctx.answers.model;
    const name = stepById("model").blocks.flatMap((block) =>
      block.kind === "choice" ? block.options.filter((o) => o.id === provider).map((o) => o.name) : [],
    )[0] ?? provider;

    if (!routesOf(provider).includes(model.route)) {
      return [refuse(`This build reaches ${name} directly`, "model.route")];
    }
    // An address of the organization's own is taken only for a model that is
    // asked the way OpenAI is.
    const address = model.address || (provider === "openai" ? DEFAULT_OPENAI_BASE_URL : "");
    if (model.address && provider !== "openai") {
      return [refuse(`This build reaches ${name} at its own address`, "model.address")];
    }
    if (address && !plainHttpsAddress(address)) {
      return [refuse("The model's address must be https, with no user name or password in it", "model.address")];
    }
    if (model.name && !/^[\x21-\x7e]{1,128}$/.test(model.name)) {
      return [refuse("A model's name is 1 to 128 characters with no spaces", "model.name")];
    }
    // Search needs a model that makes embeddings, and this build asks OpenAI
    // for them.
    if (needsModel(ctx.answers) && provider !== "openai") {
      return [
        refuse(
          `${AGENTIC_SESSIONS} searches with embeddings, and this build asks OpenAI for them. ` +
            `Choose OpenAI, or switch ${AGENTIC_SESSIONS} off ${under("modules")}`,
        ),
      ];
    }

    const typed = ctx.install && ctx.deps.typed?.has("model.key") === true;
    if (!typed && !model.key) {
      if (ctx.install) return [refuse("Paste the key, or choose None", "model.key")];
      return ctx.deps.present.kept.modelKey
        ? [found("The model's key is kept on this host by an earlier setup")]
        : [refuse("Give the name of the model's key", "model.key")];
    }
    const key = await ctx.key("model.key");
    if (key && !key.ok) return [key];
    const said = key ? [key] : [];
    // A key that is only named cannot be read from an engineer's computer.
    if (ctx.install && !typed) return said;
    // The provider is asked when a person gives the answer, and not at every
    // start.
    if (!ctx.may.act) return said;

    let value: string;
    try {
      value = (await ctx.keyValue("model.key")).trim();
    } catch {
      return [refuse("The model's key could not be read", "model.key")];
    }

    // With search on, what is asked is what HX Fortress will ask: its own
    // function works out the address, the model's name and the size of an
    // answer, so the check and the running HX Fortress cannot call two
    // different places. One fixed word is sent, and nothing of the
    // organization's.
    let request: { url: string; init: RequestInit };
    if (provider === "openai" && needsModel(ctx.answers)) {
      const asked = resolveEmbedConfig(ctx.deps.env, value, { address, ...(model.name ? { name: model.name } : {}) });
      request = {
        url: `${asked.baseUrl}/embeddings`,
        init: {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${asked.apiKey}` },
          body: JSON.stringify({ model: asked.model, input: ["ready"], dimensions: asked.dimensions }),
        },
      };
    } else if (provider === "openai" && model.address) {
      request = {
        url: `${model.address.replace(/\/+$/, "")}/models`,
        init: { method: "GET", headers: { authorization: `Bearer ${value}` } },
      };
    } else {
      // `provider` is one of the three literal ids above.
      // eslint-disable-next-line security/detect-object-injection
      const probe = (KEY_PROBES[provider] as (key: string) => { url: string; headers: Record<string, string> })(value);
      request = { url: probe.url, init: { method: "GET", headers: probe.headers } };
    }

    let status: number;
    try {
      const response = await ctx.fetch(request.url, {
        ...request.init,
        redirect: "error",
        signal: AbortSignal.timeout(ctx.timeoutMs),
      });
      status = response.status;
      await response.body?.cancel().catch(() => {});
    } catch {
      // From an engineer's computer a closed network says nothing about the
      // key. On the machine itself it says the model cannot be reached.
      return ctx.install
        ? [...said, soft(`${hostOf(request.url)} did not answer from this computer, so the key was not checked`)]
        : [...said, refuse("The model did not answer: nothing answers at this address")];
    }
    if (status >= 200 && status < 300) {
      return [...said, found(needsModel(ctx.answers) ? "The model answered a test question" : `${name} took the key`, "model.key")];
    }
    if (status === 401 || status === 403) return [...said, refuse(`${name} refused the key`, "model.key")];
    return [
      ...said,
      refuse(
        status === 404
          ? "The model did not answer: 404, so it does not know this model, or the address is not the right one"
          : `The model did not answer: ${status}`,
      ),
    ];
  };

// ── Step 7 · Network ─────────────────────────────────────────────────────────

const networkDirect: OptionCheck = async (ctx) => {
  // Whether an address answers is a question for the machine that will call
  // it. An engineer's computer is another network.
  if (!ctx.may.act || ctx.install) return [];
  const rows = reachOf(ctx.answers, { needsFiles: needsFiles(ctx.answers) }).filter((row) => row.probe !== null);
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

// ── Step 9 · Control plane ───────────────────────────────────────────────────

const ENROLLED_ELSEWHERE = "This HX Fortress is enrolled with another control plane.";
const ENROLLED_UNKNOWN =
  "This HX Fortress holds an enrollment, and its settings do not say with which control plane.";

function removeEnrollment(paths: FortressPaths): string {
  return (
    `To connect it here, stop it, remove the folder ${path.dirname(paths.credentials)}, ` +
    "and give an install id for this control plane. It then enrolls as a new HX Fortress"
  );
}

/**
 * Whether this HX Fortress holds an enrollment, and the connection address of
 * the control plane it belongs to. The address is config.json's while a
 * control plane is connected. After the connection was switched off, it is
 * what the setup wrote down at that moment. Null: an enrollment is held and
 * nothing on this host says whose it is.
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

/** How a person gives an install id for a control plane. */
const GIVE_AN_ID = "Give one: hx-fortress setup --connect <address>/i/<id>";

/**
 * The control plane, when one is named. Nobody is asked whether to connect:
 * the install command names the control plane and carries a one-time install
 * id, or a settings file does. This says whether that is enough to connect.
 */
async function controlPlaneLines(ctx: Ctx): Promise<CheckLine[]> {
  if (ctx.answers.controlPlane.connect !== "yes") return [];
  const at = "controlPlane.address";
  const parsed = controlPlaneUrl(ctx.answers.controlPlane.address);
  if (!parsed.ok) return [refuse(parsed.reason, at)];
  const { token, pages } = ctx.answers.controlPlane;
  // It decides who may frame a page of this HX Fortress, so it is exactly one
  // origin or it is refused.
  if (pages && pagesOrigin(pages) !== pages) {
    return [
      refuse(
        "The address of the control plane's pages must be one origin, written as https://host, with no path",
        "controlPlane.pages",
      ),
    ];
  }

  // Switched off: HX Fortress does not dial, so nothing more is needed to
  // connect. The address stays for the day the connection is switched on.
  const off = ctx.answers.controlPlane.connected === "off";
  const OFF = "The connection is switched off. HX Fortress does not dial the control plane";

  if (ctx.install) {
    if (off) return [found(OFF)];
    if (ctx.deps.installId) return [found(`HX Fortress connects to ${hostOf(parsed.url)} when it starts`)];
    // The key store of an install is not made yet, so no id can wait in it.
    // The plan would list a control plane, and nothing would be handed over.
    if (token) {
      return [
        refuse(
          "An install takes the install id from its own command, and not from a key store. Copy the command again",
          "controlPlane.token",
        ),
      ];
    }
    return [refuse("The install command carries no install id for this control plane. Copy the command again", at)];
  }

  // An HX Fortress that holds a credential is enrolled with ONE control
  // plane, and what it stores belongs to the organization it enrolled for.
  // The same address needs nothing more. Any other address is refused until a
  // person removes the enrollment by hand: an answer in the setup never hands
  // an HX Fortress, with what it holds, to another control plane. "Enrolled"
  // is the word for a credential that is held; whether the link is up is the
  // status's to say.
  const enrolled = await enrolledWith(ctx.deps);
  if (enrolled.held) {
    if (enrolled.url && sameControlPlane(enrolled.url, parsed.url)) {
      return [found(off ? "This HX Fortress is enrolled there. The connection is switched off" : "This HX Fortress is enrolled there")];
    }
    return [refuse(`${enrolled.url ? ENROLLED_ELSEWHERE : ENROLLED_UNKNOWN} ${removeEnrollment(ctx.deps.paths)}`, at)];
  }
  if (off) return [found(OFF)];
  if (ctx.deps.present.pinned["controlPlane.connect"]) {
    return [found("The control plane is set by this host's environment")];
  }
  if (ctx.deps.installId) return [found("An install id is held for the first connection")];
  // A setup with nobody at the screen gives the install id by the name it has
  // in the key store. It is read when the setup ends.
  if (token) {
    const key = await ctx.key("controlPlane.token");
    if (key && !key.ok) return [key];
    return [found("The install id is read from the key store when the setup ends")];
  }
  const pending = await new FilePendingEnrollmentStore(ctx.deps.paths.pendingEnrollment).load().catch(() => null);
  if (pending && sameControlPlane(pending.cloudUrl, parsed.url)) {
    return [found("An install id is held for the first connection. This HX Fortress connects when it starts")];
  }
  return [refuse(`No install id was given for this control plane. ${GIVE_AN_ID}`, at)];
}

// ── The checks, by option id ─────────────────────────────────────────────────

/**
 * One check for every option the list marks as built: the choice's path, then
 * the option's id. An option with nothing to check still has its entry, so
 * that a missing one is a mistake and not a silence.
 */
export const OPTION_CHECKS: Readonly<Record<string, Readonly<Record<string, OptionCheck>>>> = {
  // The place itself is checked whole, in `whereLines`.
  "where.place": {
    azure: nothingToCheck,
    aws: nothingToCheck,
    "google-cloud": nothingToCheck,
    docker: nothingToCheck,
  },
  "keys.store": {
    env: keysEnv,
    file: keysFile,
    "azure-key-vault": keysAzure,
  },
  "address.certificate": {
    "cloud-issued": nothingToCheck,
    own: certificateOwn,
    [NONE]: nothingToCheck,
  },
  "signIn.provider": {
    local: signInLocal,
    "openid-connect": signInProvider,
  },
  "data.database.store": {
    // A database the install makes has no address yet on an engineer's
    // computer. On the machine itself it is reached by one.
    managed: (ctx) => (ctx.install ? [] : databaseByAddress(ctx)),
    beside: (ctx) =>
      ctx.install ? [] : ctx.answers.data.database.address ? databaseByAddress(ctx) : databaseThisDisk(ctx),
    existing: databaseByAddress,
  },
  "data.files.store": {
    "s3-compatible": filesWith(["address", "bucket"]),
    "amazon-s3": filesWith(["bucket", "region"]),
    "google-cloud-storage": filesWith(["bucket", "project"]),
  },
  "model.provider": {
    anthropic: modelProvider("anthropic"),
    openai: modelProvider("openai"),
    google: modelProvider("google"),
    [NONE]: modelNone,
  },
  "auditTrail.copyTo": {
    [NONE]: nothingToCheck,
  },
  "auditTrail.keepFor": {
    "until-removed": nothingToCheck,
  },
};

/**
 * One check for each side of every switch the list marks as built: the
 * switch's path, then `on` or `off` as the list names them. A switch that is
 * not built has one side only: the one that needs no code.
 */
export const SWITCH_CHECKS: Readonly<Record<string, Readonly<Record<string, OptionCheck>>>> = {
  "network.route": {
    direct: networkDirect,
  },
  "updates.securityFixes": {
    off: nothingToCheck,
  },
  "controlPlane.connected": {
    on: nothingToCheck,
    off: nothingToCheck,
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
          "A login is a lowercase email address, or 2 to 64 lowercase letters, digits, dots, dashes or underscores " +
            "that start with a letter or a digit",
          at,
        ),
      );
    } else if (!ctx.install) {
      // On an engineer's computer there are no accounts to look at.
      const users = await readUsers(ctx.deps).catch(() => null);
      const existing = users?.users.find((user) => user.login === firstAdministrator);
      if (existing?.deletedAt) {
        lines.push(refuse("This login was removed from this HX Fortress. Choose another", at));
      } else if (existing) {
        lines.push(found("An account with this login exists. Setup leaves it as it is", at));
      }
    }
  }
  return lines;
}

function filesNeeded(ctx: Ctx): CheckLine[] {
  if (!needsFiles(ctx.answers)) return [];
  const chosen = ctx.answers.data.files.store;
  if (ctx.install) {
    // In a cloud the files go to that cloud's own store, made with HX Fortress.
    // Where this build has no such store, nothing can keep the files.
    const place = placeInfo(ctx.answers.where.place);
    const built = choicesOf(SETUP_LIST)
      .find((c) => c.block.path === "data.files.store")
      ?.block.options.some((o) => o.id === chosen && o.built);
    return built
      ? []
      : [
          refuse(
            `${AGENTIC_SESSIONS} keeps files, and this build has no file store for ${
              isCloudPlace(place.id) ? place.short : "a machine with Docker"
            } yet. Switch ${AGENTIC_SESSIONS} off ${under("modules")}`,
          ),
        ];
  }
  return chosen === NONE
    ? [
        refuse(
          `${AGENTIC_SESSIONS} keeps files. Choose where they rest, or switch ${AGENTIC_SESSIONS} off ${under("modules")}`,
        ),
      ]
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
  // Where it runs is a fact on the machine itself: nobody answers it there.
  if (step === "where" && !ctx.install) return [];
  const pinned = ctx.install ? [] : pinnedConflicts(step, ctx);
  if (pinned.length > 0) return pinned;

  const place: PlaceId = placeInfo(ctx.answers.where.place).id;
  const view = { way: ctx.deps.way ?? ("setup" as Way), place };
  const lines: CheckLine[] = [];
  if (step === "where") lines.push(...(await whereLines(ctx)));
  if (step === "organization") lines.push(...(await organizationFields(ctx)));
  if (step === "address") lines.push(...addressLines(ctx));
  if (step === "data") lines.push(...filesNeeded(ctx));
  if (step === "modules") lines.push(...moduleIds(ctx));
  if (step === "controlPlane") lines.push(...(await controlPlaneLines(ctx)));

  const run = async (check: OptionCheck | undefined, name: string, at: string): Promise<void> => {
    if (!check) {
      lines.push(refuse(`${name} has no check in this build, so it cannot be chosen`, at));
      return;
    }
    try {
      lines.push(...(await check(ctx)));
    } catch {
      // Whatever went wrong is not this person's to read: it could quote
      // something the check was holding. The terminal's `setup check` and
      // HX Fortress's own log say more.
      lines.push(refuse("The check could not be made"));
    }
  };

  for (const { step: owner, block } of choicesOf(SETUP_LIST)) {
    if (owner !== step) continue;
    // A choice that this way or this place does not ask has no answer to
    // check: the place settles it.
    if (block.ways && !block.ways.includes(view.way) && view.way !== "settings") continue;
    if (block.places && !block.places.includes(place)) continue;
    const chosen = answerText(ctx.answers, block.path);
    const option = block.options.find((o) => o.id === chosen);
    // "None" on a choice that is only asked while something needs it.
    if (!option && chosen === NONE && block.neededBy) continue;
    const name = option ? phrase(option.name, { cloud: placeInfo(place).short }) : "";
    if (!option) {
      lines.push(refuse(`${block.label ?? stepById(step).name}: choose one of the options`, block.path));
      continue;
    }
    if (!option.built) {
      lines.push(refuse(`${name} is not in this build yet`, block.path));
      continue;
    }
    if (!optionOffered(option, { place })) {
      // Only a settings file can name such an option: a page does not show it.
      // So the refusal speaks the file's language, ids and all.
      const where =
        place === "here" ? "on the machine itself" : isCloudPlace(place) ? `in ${placeInfo(place).short}` : "on a machine of your own";
      const offered = block.options.filter((o) => optionOffered(o, { place })).map((o) => o.id);
      lines.push(refuse(`${block.path}: ${option.id} is not offered ${where}. It can be ${offered.join(", ")}`, block.path));
      continue;
    }
    // The path and the id come from the list, never from an answer.
    await run(OPTION_CHECKS[block.path]?.[option.id], name, block.path);
  }

  for (const { step: owner, block } of switchesOf(SETUP_LIST)) {
    if (owner !== step) continue;
    const chosen = answerText(ctx.answers, block.path);
    if (chosen !== block.on && chosen !== block.off) {
      lines.push(refuse(`${block.label}: it is on or off`, block.path));
      continue;
    }
    // The side that needs code is the one a switch that is not built lacks.
    if (!block.built && chosen === block.on) {
      lines.push(refuse(`${phrase(block.label)} is not in this build yet`, block.path));
      continue;
    }
    await run(SWITCH_CHECKS[block.path]?.[chosen], block.label, block.path);
  }

  // What the place itself refuses, said at the step it belongs to.
  if (ctx.install && ctx.may.leaveHost && ctx.deps.placeRefusals) {
    try {
      const refused = await ctx.deps.placeRefusals(ctx.answers);
      lines.push(...refused.filter((line) => (line.path ?? "").split(".")[0] === step));
    } catch {
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
