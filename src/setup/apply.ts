// Writing the answers of the setup to where each one rests.
//
// An answer has no file of its own. It is written to the place the Fortress
// already reads that setting from: config.json, the console's own files beside
// it, the Sessions credentials file. So what the setup wrote and what another
// command wrote are the same settings, and the next read sees both.
//
// ONLY WHAT CHANGED IS WRITTEN. On an install that is already set up, a
// question whose answer is the same as before is not touched. So running the
// setup again and pressing Enter through every question changes nothing, and a
// key that an earlier setup kept on the host stays where it is.
//
// AN ANSWER THE HOST'S ENVIRONMENT DECIDES IS NOT WRITTEN, and that is decided
// answer by answer, by its own path. The field beside it, which a person gave,
// is written. So nothing a person was shown as theirs to answer is dropped.
//
// NO KEY IS WRITTEN, EVER. An answer that needs a key holds the key's name.
// The one value this file handles is a one-time enrollment token, which the
// Fortress spends the first time it connects to its control plane.
//
// config.json DECIDES. A Fortress is set up when that file is written, so a
// setup that fails before it leaves a Fortress that is still not set up, and
// running it again is safe. The files beside it are written first. Two things
// come after it, because each is worth nothing without it and neither may make
// a Fortress count as set up by itself: the one-time token for the first
// connection, and the first administrator's account. If one of them cannot be
// written, the settings stay saved and a line says what to do.

import path from "node:path";

import { FilePendingEnrollmentStore } from "../cloud/credentials";
import { MODULE_DEFAULTS_KEY, mergeConfigPatch, patchConfig, readConfigObject } from "../host/config";
import { MODULE_CATALOG, type CatalogEntry } from "../host/module-catalog";
import type { fortressPaths } from "../host/paths";
import {
  updateVaultCredentials,
  type CredentialsUpdate,
  type VaultCredentials,
} from "../modules/session-vault/credentials";
import { resolveSecretsConfig } from "../secrets/config";
import { secretProviderDefinition } from "../secrets/providers";
import { UiConfigStore } from "../ui/config";
import { OidcConfigStore } from "../ui/oidc-config";
import { UsersStore } from "../ui/users";
import type { SetupAnswers } from "./answers";
import { enrolledWith, filesCredentialsOf, secretsBlockOf } from "./checks";
import { controlPlaneUrl } from "./control-plane";
import { NONE, STEP_IDS, type StepId } from "./list";
import { KEY_STORE_ANSWER, type PresentAnswers } from "./read";
import { SETUP_MARK_KEY, setupMark, type SetupWay } from "./state";

type FortressPaths = ReturnType<typeof fortressPaths>;

export interface ApplyDeps {
  paths: FortressPaths;
  /** The install as it was read before the answers were given. */
  present: PresentAnswers;
  /** How the answers were given. Written into the mark the setup leaves. */
  way: SetupWay;
  /** A one-time enrollment token: from a person's sign-in at the control plane, or
   *  read by name from the key store. Needed when the answers name a control
   *  plane this Fortress is not enrolled with yet. */
  enrollmentToken?: string | null;
  catalog?: readonly CatalogEntry[];
  now?: () => Date;
  /** The port a new install's console listens on, when the setup was given
   *  one. The browser setup answers on it, and its last screen sends people to
   *  the console at the same address. */
  consolePort?: number | null;
  /** Injected in tests: the one door for changing the Sessions credentials. */
  updateVaultCredentials?: (
    mutate: (current: VaultCredentials | null) => VaultCredentials,
  ) => Promise<CredentialsUpdate>;
}

export interface ApplyResult {
  /** The questions whose answer was written. */
  changed: StepId[];
  /** Those of them a running Fortress reads only when it starts. */
  restart: StepId[];
  /** The first administrator's new account, with the token of its one-time
   *  password link. Null when no account was made. */
  firstAccount: { login: string; token: string } | null;
  /** A sentence for something that did not happen and does not undo the rest. */
  notes: string[];
}

/** The questions a running Fortress reads only when it starts. Modules are
 *  decided one by one, below. */
const READ_AT_START: readonly StepId[] = ["keys", "data", "model", "network", "records", "controlPlane"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The questions the setup writes: every one on a Fortress that is not set up
 * yet, and on one that is, those whose answer differs from the present one.
 * The audit record and the terminal's last lines name these same questions.
 */
export function changedSteps(answers: SetupAnswers, present: PresentAnswers): StepId[] {
  return STEP_IDS.filter(
    // `step` is one of the list's own literal ids.
    // eslint-disable-next-line security/detect-object-injection
    (step) => !present.setUp || !same(answers[step], present.answers[step]),
  );
}

export async function applyAnswers(answers: SetupAnswers, deps: ApplyDeps): Promise<ApplyResult> {
  const { paths, present } = deps;
  const before = present.answers;
  const now = deps.now ?? ((): Date => new Date());
  const catalog = deps.catalog ?? MODULE_CATALOG;
  const fresh = !present.setUp;
  const notes: string[] = [];

  const changed = changedSteps(answers, present);
  const touched = (step: StepId): boolean => changed.includes(step);
  /** True when this host's environment decides the answer at this path. */
  // eslint-disable-next-line security/detect-object-injection
  const pinnedAt = (at: string): boolean => present.pinned[at] !== undefined;

  const raw = (await readConfigObject(paths)) ?? {};
  const patch: Record<string, unknown> = {};

  // 1 · Organization
  if (touched("organization")) patch.organization = { name: answers.organization.name };

  // 2 · Keys. Checked with the function the Fortress starts with, before
  // anything is written. The answers are checked whole. Then each setting is
  // written by itself: one that the host's environment decides is not written,
  // and config.json keeps what it holds for it.
  if (touched("keys")) {
    const answered: Record<string, unknown> = secretsBlockOf(answers.keys);
    resolveSecretsConfig({ env: {}, config: { secrets: answered }, root: paths.root });
    const held: Record<string, unknown> = isRecord(raw.secrets) ? raw.secrets : {};
    const block: Record<string, unknown> = {};
    const settle = (key: string, at: string): void => {
      // `key` is a setting's key from the build's own list.
      // eslint-disable-next-line security/detect-object-injection
      const value = pinnedAt(at) ? held[key] : answered[key];
      // eslint-disable-next-line security/detect-object-injection
      if (value !== undefined) block[key] = value;
    };
    settle("provider", "keys.store");
    for (const [key, at] of Object.entries(KEY_STORE_ANSWER)) settle(key, at);
    // A setting of the chosen key store that the setup has no field for stays
    // as it is: how long a value is remembered, for example.
    for (const setting of secretProviderDefinition(answered.provider)?.settings ?? []) {
      const untouched = !(setting.key in KEY_STORE_ANSWER) && held[setting.key] !== undefined;
      if (untouched) block[setting.key] = held[setting.key];
    }
    patch.secrets = Object.keys(block).length > 0 ? block : undefined;
  }

  // 4 · Data: the database. The key's NAME is written. An address an earlier
  // setup kept on the host stays until the answer names a key or moves away.
  // The environment decides both parts of this answer together, or neither.
  if (touched("data") && !pinnedAt("data.database.store")) {
    const postgres: Record<string, unknown> = isRecord(raw.postgres) ? { ...raw.postgres } : {};
    if (answers.data.database.store === "postgres") {
      if (answers.data.database.address) {
        postgres.urlSecret = answers.data.database.address;
        delete postgres.externalUrl;
      }
    } else {
      delete postgres.urlSecret;
      delete postgres.externalUrl;
    }
    patch.postgres = Object.keys(postgres).length > 0 ? postgres : undefined;
  }

  // 5 · Modules. A module this build does not list keeps its place in the
  // file: it was not asked about, so it is not switched.
  if (touched("modules")) {
    const listed =
      isRecord(raw.modules) && Array.isArray(raw.modules.enabled)
        ? raw.modules.enabled.filter((id): id is string => typeof id === "string")
        : [];
    const asked = new Set(catalog.map((entry) => entry.id));
    const enabled = listed.filter((id) => !asked.has(id) || answers.modules[id] === true);
    for (const entry of catalog) {
      if (answers.modules[entry.id] === true && !enabled.includes(entry.id)) enabled.push(entry.id);
    }
    patch.modules = { enabled };
  }
  // The modules are now a person's own list. Without this key the next start
  // would switch the default modules back on.
  // eslint-disable-next-line security/detect-object-injection
  if (fresh || touched("modules")) patch[MODULE_DEFAULTS_KEY] = 1;

  // The connection. A new HX Fortress keeps session content off its
  // connection: a call that reads or writes a session is refused by the
  // connection itself (src/cloud/kinds.ts). No question asks for this. It is
  // written once, when an HX Fortress is first set up, and only where the file
  // makes no choice already. So a choice a person wrote ahead of the setup
  // stays, an install from before the setup is not changed, and a later run
  // of the setup does not put it back. A block that is there and makes no
  // choice gets the choice: an empty block must not leave a new HX Fortress
  // less closed than no block. A block that cannot be read is left alone, and
  // the check below then refuses the whole file.
  if (fresh) {
    const held: unknown = raw.connection;
    if (held === undefined) patch.connection = { sessionContent: "off" };
    else if (isRecord(held) && held.sessionContent === undefined) patch.connection = { ...held, sessionContent: "off" };
  }

  // 6 · AI model. Each part is written by itself: the address and the model's
  // name are a person's to give even where the key is in the host's
  // environment, or was kept on the host by an earlier setup. A part the
  // environment decides keeps what config.json holds for it. With no key's
  // name in the block, the Fortress goes on using the key it has.
  if (touched("model")) {
    const model = answers.model;
    const held: Record<string, unknown> = isRecord(raw.model) ? raw.model : {};
    if (model.provider === NONE) {
      if (!pinnedAt("model.provider")) patch.model = undefined;
    } else {
      const part = (key: "address" | "key" | "name"): unknown =>
        // eslint-disable-next-line security/detect-object-injection
        pinnedAt(`model.${key}`) ? held[key] : model[key] || undefined;
      const block: Record<string, unknown> = { provider: model.provider };
      for (const key of ["address", "key", "name"] as const) {
        const value = part(key);
        // eslint-disable-next-line security/detect-object-injection
        if (value !== undefined) block[key] = value;
      }
      patch.model = block;
    }
  }

  // 7 · Network, 8 · Records, 9 · Updates
  if (touched("network")) {
    patch.network =
      answers.network.route === "proxy" && answers.network.proxy ? { proxy: answers.network.proxy } : undefined;
  }
  if (touched("records")) {
    patch.records = {
      keepFor: answers.records.keepFor,
      ...(answers.records.copyTo !== NONE
        ? {
            copyTo: {
              to: answers.records.copyTo,
              ...(answers.records.copyAddress ? { address: answers.records.copyAddress } : {}),
            },
          }
        : {}),
    };
  }
  if (touched("updates")) {
    patch.updates = {
      from: answers.updates.from,
      ...(answers.updates.address ? { address: answers.updates.address } : {}),
      install: answers.updates.install,
    };
  }

  // 10 · Control plane. `enrolledWith` is the same question the check asks,
  // so what the check accepted is what is written. A token in hand is used
  // even when the answer did not change: a Fortress whose settings name a
  // control plane it holds no enrollment for is enrolled by this sign-in.
  const pending = new FilePendingEnrollmentStore(paths.pendingEnrollment);
  let firstConnection: { token: string; cloudUrl: string } | null = null;
  let disconnect = false;
  let disconnectedFrom = present.disconnectedFrom;
  if ((touched("controlPlane") || deps.enrollmentToken) && !pinnedAt("controlPlane.connect")) {
    const enrolled = await enrolledWith({ paths, present });
    if (answers.controlPlane.connect === "yes") {
      const parsed = controlPlaneUrl(answers.controlPlane.address);
      if (!parsed.ok) throw new Error(parsed.reason);
      if (enrolled.held) {
        // An enrollment belongs to one control plane. The check refused any
        // other; this is the same rule, held where the file is written.
        if (enrolled.url !== parsed.url) {
          throw new Error("This Fortress is enrolled with another control plane, so it was not connected to this one");
        }
      } else if (deps.enrollmentToken) {
        firstConnection = { token: deps.enrollmentToken, cloudUrl: parsed.url };
      } else {
        // A token an earlier step left for this same control plane is the
        // first connection's. Anything else means that nobody signed in.
        const waiting = await pending.load().catch(() => null);
        if (waiting?.cloudUrl !== parsed.url) {
          throw new Error("Nobody signed in at the control plane for this Fortress, so it was not enrolled");
        }
      }
      patch.cloud = { url: parsed.url };
      disconnectedFrom = null;
    } else {
      // The enrollment stays in the identity folder. Which control plane it
      // belongs to is written down here, because config.json stops saying it.
      const was = isRecord(raw.cloud) && typeof raw.cloud.url === "string" ? raw.cloud.url : null;
      if (enrolled.held) disconnectedFrom = was ?? present.disconnectedFrom;
      patch.cloud = undefined;
      disconnect = true;
    }
  }

  // eslint-disable-next-line security/detect-object-injection
  patch[SETUP_MARK_KEY] = { ...setupMark(deps.way, now()), ...(disconnectedFrom ? { disconnectedFrom } : {}) };

  // Everything above is checked against the parser the host starts with before
  // any file is written, by the function that writes config.json at the end.
  mergeConfigPatch(raw, patch);

  // ── The files beside config.json ───────────────────────────────────────────

  // 3 · Sign-in
  if (touched("signIn")) {
    const store = new OidcConfigStore(path.join(paths.uiRoot, "oidc.json"));
    const current = await store.load();
    if (answers.signIn.provider === "openid-connect") {
      await store.update((config) => ({
        ...config,
        enabled: true,
        issuer: answers.signIn.issuer,
        clientId: answers.signIn.clientId,
        clientSecretName: answers.signIn.clientSecret || null,
        groupsClaim: answers.signIn.groupsClaim,
        operatorGroups: [...answers.signIn.operatorGroups],
        readonlyGroups: [...answers.signIn.readonlyGroups],
      }));
    } else if (current.enabled) {
      // Switched off, with its settings kept for the day it is switched on again.
      await store.update((config) => ({ ...config, enabled: false }));
    }
  }
  const consoleChanged =
    touched("signIn") &&
    !pinnedAt("signIn.consoleAddress") &&
    (fresh || answers.signIn.consoleAddress !== before.signIn.consoleAddress);
  if (consoleChanged || fresh) {
    await new UiConfigStore(paths.uiConfig).update((config) => ({
      ...config,
      ...(consoleChanged ? { publicUrl: answers.signIn.consoleAddress || null } : {}),
      // A new install that answered how people sign in has a console to sign in
      // to. A later run of the setup leaves the switch as the operator set it.
      ...(fresh ? { enabled: true } : {}),
      ...(fresh && deps.consolePort ? { port: deps.consolePort } : {}),
    }));
  }

  // 4 · Data: the files. Where the bucket is, and no key. A key an earlier
  // setup kept stays only while the answer still names the same bucket.
  if (touched("data") && !pinnedAt("data.files.store") && !same(answers.data.files, before.data.files)) {
    const next = filesCredentialsOf(answers.data.files);
    if (next) {
      await (deps.updateVaultCredentials ?? updateVaultCredentials)((current) => {
        const sameBucket =
          current !== null &&
          current.store === next.store &&
          current.bucket === next.bucket &&
          (current.endpoint ?? "") === (next.endpoint ?? "");
        return {
          ...next,
          ...(sameBucket && current.gcs ? { gcs: current.gcs } : {}),
          ...(sameBucket && current.s3 ? { s3: current.s3 } : {}),
          ...(current?.openaiApiKey ? { openaiApiKey: current.openaiApiKey } : {}),
        };
      });
    }
  }

  // 10 · Control plane. A token that waited for a control plane this Fortress
  // no longer connects to is removed before the settings say so.
  if (disconnect) await pending.clear().catch(() => {});

  // ── config.json ────────────────────────────────────────────────────────────
  await patchConfig(paths, patch);

  // 10 · Control plane: the token for the first connection. After config.json,
  // so that a setup that is cut off here leaves a Fortress whose settings are
  // whole and that is simply not enrolled yet. The other order would leave a
  // token with no settings, and a start would build settings from the token.
  if (firstConnection) {
    try {
      await pending.save(firstConnection);
    } catch (error) {
      notes.push(
        "The settings were saved, but the sign-in could not be kept for the first connection " +
          `(${error instanceof Error ? error.message : String(error)}). ` +
          "Sign in again: hx-fortress setup control-plane",
      );
    }
  }

  // 1 · The first administrator. After the settings are saved, because this is
  // the one step that hands back something that cannot be asked for twice.
  let firstAccount: ApplyResult["firstAccount"] = null;
  const login = answers.organization.firstAdministrator;
  if (login && touched("organization")) {
    const users = new UsersStore(path.join(paths.uiRoot, "users.json"));
    try {
      const file = await users.load();
      if (!file.users.some((user) => user.login === login)) {
        const created = await users.create(login, "operator", now());
        firstAccount = { login, token: created.token };
      }
    } catch (error) {
      notes.push(
        `The settings were saved, but the account for ${login} could not be made ` +
          `(${error instanceof Error ? error.message : String(error)}). ` +
          `Make it with: hx-fortress ui user create ${login} --role operator`,
      );
    }
  }

  const startOnly = new Set(catalog.filter((entry) => entry.startOnly).map((entry) => entry.id));
  const moduleNeedsStart =
    touched("modules") &&
    [...startOnly].some((id) => (answers.modules[id] === true) !== (before.modules[id] === true));
  const restart = fresh
    ? []
    : changed.filter((step) => READ_AT_START.includes(step) || (step === "modules" && moduleNeedsStart));

  return { changed, restart, firstAccount, notes };
}
