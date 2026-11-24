// Writing the answers of the setup to where each one rests, on the machine
// that runs HX Fortress.
//
// An answer has no file of its own. It is written to the place HX Fortress
// already reads that setting from: config.json, the console's own files beside
// it, the Agentic Sessions credentials file. So what the setup wrote and what
// another command wrote are the same settings, and the next read sees both.
//
// This is what `hx-fortress setup` ends with, what the console's Settings page
// saves with, and what a container does on its first start with the settings
// an install handed it. `hx-fortress install` itself writes nothing here: it
// runs on another computer and hands everything over (`src/install`).
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
// The one value this file handles is a one-time install id, which
// HX Fortress spends the first time it connects to its control plane.
//
// config.json DECIDES. An HX Fortress is set up when that file is written, so
// a setup that fails before it leaves one that is still not set up, and
// running it again is safe. The files beside it are written first. Two things
// come after it, because each is worth nothing without it and neither may make
// an HX Fortress count as set up by itself: the one-time id for the first
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
import { judgeMintedLink } from "../ui/bootstrap-user";
import { UiConfigStore } from "../ui/config";
import { OidcConfigStore } from "../ui/oidc-config";
import { UsersStore } from "../ui/users";
import type { SetupAnswers } from "./answers";
import { enrolledWith, filesCredentialsOf, secretsBlockOf } from "./checks";
import { controlPlaneUrl, sameControlPlane } from "./control-plane";
import { answersToFile, publicAddress, UPDATES_FROM_OWN, UPDATES_FROM_UNREADABLE } from "./answers";
import { NONE, STEP_IDS, type StepId } from "./list";
import { AUDIT_TRAIL_KEY, INSTALL_FACTS_KEY, KEY_STORE_ANSWER, type PresentAnswers } from "./read";
import { SETUP_MARK_KEY, setupMark, type SetupWay } from "./state";

type FortressPaths = ReturnType<typeof fortressPaths>;

export interface ApplyDeps {
  paths: FortressPaths;
  /** The install as it was read before the answers were given. */
  present: PresentAnswers;
  /** How the answers were given. Written into the mark the setup leaves. */
  way: SetupWay;
  /** A one-time install id: from the install command, or read by name from the
   *  key store. Needed when the answers name a control plane this HX Fortress
   *  is not enrolled with yet. */
  enrollmentToken?: string | null;
  catalog?: readonly CatalogEntry[];
  now?: () => Date;
  /** The port a new install's console listens on, when the setup was given
   *  one. The browser setup answers on it, and its last screen sends people to
   *  the console at the same address. */
  consolePort?: number | null;
  /** A one-time password link that was made where HX Fortress was installed,
   *  as the environment holds it beside the first administrator's login: the
   *  sha256 of its token, and the time it stops working. The account is then
   *  made for that link, and no link is made here. */
  mintedLink?: { digest: string | undefined; expires: string | undefined } | null;
  /** Injected in tests: the one door for changing the Agentic Sessions credentials. */
  updateVaultCredentials?: (
    mutate: (current: VaultCredentials | null) => VaultCredentials,
  ) => Promise<CredentialsUpdate>;
}

export interface ApplyResult {
  /** The questions whose answer was written. */
  changed: StepId[];
  /** Those of them a running HX Fortress reads only when it starts. */
  restart: StepId[];
  /** The first administrator's new account, with the token of its one-time
   *  password link. The token is null when the account was made for a link
   *  that was minted where HX Fortress was installed: that link is there, and
   *  nothing of it is here. Null when no account was made. */
  firstAccount: { login: string; token: string | null } | null;
  /** A sentence for something that did not happen and does not undo the rest. */
  notes: string[];
}

/** The questions a running HX Fortress reads only when it starts. Modules are
 *  decided one by one, below. */
const READ_AT_START: readonly StepId[] = ["keys", "data", "model", "network", "auditTrail", "controlPlane"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The questions the setup writes: every one on an HX Fortress that is not set
 * up yet, and on one that is, those whose answer differs from the present one.
 * The audit record and the terminal's last lines name these same questions.
 */
export function changedSteps(answers: SetupAnswers, present: PresentAnswers): StepId[] {
  // Each question is compared as a settings file writes it: by what is in
  // effect. An answer that stands under an option nobody chose (the issuer of
  // a provider that is switched off) writes nothing, so it changes nothing.
  const now = answersToFile(answers) as unknown as Record<string, unknown>;
  const was = answersToFile(present.answers) as unknown as Record<string, unknown>;
  return STEP_IDS.filter((step) => {
    // Where it runs is a question only in the install. On the machine itself
    // nobody answered it: it is `here`, or the host's environment says where,
    // and either way nothing of it was written.
    if (step === "where") {
      const here = answers.where.place === "here" && present.answers.where.place === "here";
      if (here || present.pinned["where.place"] !== undefined) return false;
      return !present.setUp || !same(answers.where, present.answers.where);
    }
    // An update source that could not be read, and the project's releases
    // that a settings file now names, write the same in a file's form:
    // nothing. They are not the same answer. The one that was given is
    // written over the block that could not be read.
    if (
      step === "updates" &&
      present.answers.updates.from === UPDATES_FROM_UNREADABLE &&
      answers.updates.from !== UPDATES_FROM_UNREADABLE
    ) {
      return true;
    }
    // `step` is one of the list's own literal ids.
    // eslint-disable-next-line security/detect-object-injection
    return !present.setUp || !same(now[step], was[step]);
  });
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

  // 2 · Keys. Checked with the function HX Fortress starts with, before
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

  // 5 · Database. The key's NAME is written. An address an earlier setup kept
  // on the host stays until the answer names a key or moves away. The
  // environment decides the address, or it does not.
  //
  // A database that an install made is reached by an address too, under a
  // name the install gave it. Only Postgres on this machine's own disk has no
  // address: HX Fortress starts and stops that one itself.
  if (touched("data") && !pinnedAt("data.database.address")) {
    const postgres: Record<string, unknown> = isRecord(raw.postgres) ? { ...raw.postgres } : {};
    const database = answers.data.database;
    if (database.address) {
      postgres.urlSecret = database.address;
      delete postgres.externalUrl;
    } else if (database.store !== "existing") {
      delete postgres.urlSecret;
      delete postgres.externalUrl;
    }
    patch.postgres = Object.keys(postgres).length > 0 ? postgres : undefined;
  }

  // 0 · Where it runs, and the facts that go with the place: how the address
  // gets its certificate, and which database was made. An HX Fortress on its
  // own machine has none of them. The environment decides them all, or none.
  const elsewhere = answers.where.place !== "here";
  if ((touched("where") || touched("address") || touched("data")) && !pinnedAt("where.place")) {
    // eslint-disable-next-line security/detect-object-injection
    patch[INSTALL_FACTS_KEY] = elsewhere
      ? {
          place: answers.where.place,
          ...(answers.where.region ? { region: answers.where.region } : {}),
          ...(answers.where.place === "docker" && answers.where.ssh ? { ssh: answers.where.ssh } : {}),
          certificate: answers.address.certificate,
          ...(answers.address.certificate === "own" && answers.address.certificateName
            ? { certificateName: answers.address.certificateName }
            : {}),
          database: answers.data.database.store,
        }
      : undefined;
  }

  // 4 · Modules. A module this build does not list keeps its place in the
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
  // name in the block, HX Fortress goes on using the key it has.
  if (touched("model")) {
    const model = answers.model;
    const held: Record<string, unknown> = isRecord(raw.model) ? raw.model : {};
    if (model.provider === NONE) {
      if (!pinnedAt("model.provider")) patch.model = undefined;
    } else {
      const parts = ["address", "key", "name", "region", "project"] as const;
      const part = (key: (typeof parts)[number]): unknown =>
        // eslint-disable-next-line security/detect-object-injection
        pinnedAt(`model.${key}`) ? held[key] : model[key] || undefined;
      const block: Record<string, unknown> = {
        // What the host's environment decides is not written as if a person
        // had chosen it: the file keeps the provider it holds.
        provider: pinnedAt("model.provider") ? (held.provider ?? model.provider) : model.provider,
        ...(model.route && model.route !== "direct" ? { route: model.route } : {}),
      };
      for (const key of parts) {
        const value = part(key);
        // eslint-disable-next-line security/detect-object-injection
        if (value !== undefined) block[key] = value;
      }
      patch.model = block;
    }
  }

  // 7 · Network, 8 · Updates, 10 · Audit trail
  if (touched("network")) {
    patch.network =
      answers.network.route === "proxy" && answers.network.proxy ? { proxy: answers.network.proxy } : undefined;
  }
  if (touched("updates")) {
    // Where a new version comes from is written as the answers hold it. An
    // address that the host's environment names is not written as if a person
    // had chosen it: config.json keeps what it holds for it. So it does for a
    // setting that could not be understood: nobody gave another one, and
    // writing "the project's releases" over it would be a choice nobody made.
    const held: Record<string, unknown> = isRecord(raw.updates) ? raw.updates : {};
    const source: Record<string, unknown> =
      pinnedAt("updates.from") || pinnedAt("updates.address") || answers.updates.from === UPDATES_FROM_UNREADABLE
        ? {
            ...(held.from !== undefined ? { from: held.from } : {}),
            ...(held.address !== undefined ? { address: held.address } : {}),
          }
        : answers.updates.from === UPDATES_FROM_OWN
          ? { from: UPDATES_FROM_OWN, address: answers.updates.address }
          : {};
    const block = { ...(answers.updates.securityFixes === "on" ? { securityFixes: true } : {}), ...source };
    patch.updates = Object.keys(block).length > 0 ? block : undefined;
  }
  if (touched("auditTrail")) {
    // The earlier list kept this answer under `records`. One place holds it.
    if (raw.records !== undefined) patch.records = undefined;
    // eslint-disable-next-line security/detect-object-injection
    patch[AUDIT_TRAIL_KEY] = {
      keepFor: answers.auditTrail.keepFor,
      ...(answers.auditTrail.copyTo !== NONE
        ? {
            copyTo: {
              to: answers.auditTrail.copyTo,
              ...(answers.auditTrail.copyAddress ? { address: answers.auditTrail.copyAddress } : {}),
            },
          }
        : {}),
    };
  }

  // 9 · Control plane. `enrolledWith` is the same question the check asks,
  // so what the check accepted is what is written. An id in hand is used
  // even when the answer did not change: an HX Fortress whose settings name a
  // control plane it holds no enrollment for is enrolled by this id.
  const pending = new FilePendingEnrollmentStore(paths.pendingEnrollment);
  let firstConnection: { token: string; cloudUrl: string } | null = null;
  let disconnect = false;
  let disconnectedFrom = present.disconnectedFrom;
  if ((touched("controlPlane") || deps.enrollmentToken) && !pinnedAt("controlPlane.connect")) {
    const enrolled = await enrolledWith({ paths, present });
    const named = answers.controlPlane.connect === "yes";
    if (named && answers.controlPlane.connected !== "off") {
      const parsed = controlPlaneUrl(answers.controlPlane.address);
      if (!parsed.ok) throw new Error(parsed.reason);
      // The address that is written. An HX Fortress that is enrolled keeps the
      // very address it enrolled at, path and all: the answer names the same
      // control plane, and this build's own path is for a new connection only.
      let url = parsed.url;
      if (enrolled.held) {
        // An enrollment belongs to one control plane. The check refused any
        // other; this is the same rule, held where the file is written.
        if (!enrolled.url || !sameControlPlane(enrolled.url, parsed.url)) {
          throw new Error("This HX Fortress is enrolled with another control plane, so it was not connected to this one");
        }
        url = enrolled.url;
      } else if (deps.enrollmentToken) {
        firstConnection = { token: deps.enrollmentToken, cloudUrl: parsed.url };
      } else {
        // An id an earlier step left for this same control plane is the first
        // connection's. Anything else means that none was given.
        const waiting = await pending.load().catch(() => null);
        if (!waiting || !sameControlPlane(waiting.cloudUrl, parsed.url)) {
          throw new Error("No install id was given for this control plane, so this HX Fortress was not enrolled");
        }
        url = waiting.cloudUrl;
      }
      patch.cloud = { url };
      disconnectedFrom = null;
    } else {
      // The enrollment stays in the identity folder. Which control plane it
      // belongs to is written down here, because config.json stops saying it.
      //
      // This is also what "connected: off" writes. config.json stops naming
      // the control plane, so the daemon does not dial; the enrollment stays;
      // and the mark keeps the address, so switching it on writes it back.
      const was = isRecord(raw.cloud) && typeof raw.cloud.url === "string" ? raw.cloud.url : null;
      const parsed = named ? controlPlaneUrl(answers.controlPlane.address) : null;
      if (enrolled.held) disconnectedFrom = was ?? present.disconnectedFrom;
      else if (parsed?.ok) disconnectedFrom = parsed.url;
      // No control plane is named and no enrollment is held: nothing is left
      // to come back to, so the mark names none either.
      else disconnectedFrom = null;
      patch.cloud = undefined;
      // An install id that waits for a control plane which is only switched
      // off is kept: it works once, and it is spent when the switch goes on.
      disconnect = !named;
    }
  }

  // Where the control plane's pages are. It is its own setting, outside
  // `cloud`: it stays while the connection is switched off, and the one
  // reader (`controlPlanePages`) answers "none" for as long as it is.
  if (touched("controlPlane") && !pinnedAt("controlPlane.pages")) {
    patch.controlPlane = answers.controlPlane.pages ? { pages: answers.controlPlane.pages } : undefined;
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
        administratorGroups: [...answers.signIn.administratorGroups],
        operatorGroups: [...answers.signIn.operatorGroups],
        readonlyGroups: [...answers.signIn.readonlyGroups],
        viewerGroups: [...answers.signIn.viewerGroups],
      }));
    } else if (current.enabled) {
      // Switched off, with its settings kept for the day it is switched on again.
      await store.update((config) => ({ ...config, enabled: false }));
    }
  }
  // 3 · Address: where people reach the console.
  const consoleChanged =
    touched("address") &&
    !pinnedAt("address.hostname") &&
    (fresh || answers.address.hostname !== before.address.hostname);
  // The second step at sign-in is asked of every account with a password on
  // an HX Fortress that starts with none: its console is made to be reached
  // from the internet. One that already has accounts keeps its setting, since
  // an account with a password and no app could no longer sign in. Accounts
  // that cannot be read are accounts all the same: the setting is then left
  // as it is, for the day the file is put right.
  const accountsBefore = fresh
    ? await new UsersStore(path.join(paths.uiRoot, "users.json")).load().then(
        (file) => file.users.length,
        () => null,
      )
    : null;
  const asksSecondStep = fresh && accountsBefore === 0;
  if (consoleChanged || fresh) {
    await new UiConfigStore(paths.uiConfig).update((config) => ({
      ...config,
      ...(consoleChanged ? { publicUrl: publicAddress(answers) || null } : {}),
      // A new install that answered how people sign in has a console to sign in
      // to. A later run of the setup leaves the switch as the operator set it.
      ...(fresh ? { enabled: true } : {}),
      ...(fresh && deps.consolePort ? { port: deps.consolePort } : {}),
      ...(asksSecondStep ? { secondStep: "required" as const } : {}),
    }));
  }

  // 5 · Database: the files. Where the bucket is, and no key. A key an earlier
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

  // 9 · Control plane. An id that waited for a control plane this HX Fortress
  // no longer connects to is removed before the settings say so.
  if (disconnect) await pending.clear().catch(() => {});

  // ── config.json ────────────────────────────────────────────────────────────
  await patchConfig(paths, patch);

  // 9 · Control plane: the id for the first connection. After config.json, so
  // that a setup that is cut off here leaves an HX Fortress whose settings are
  // whole and that is simply not enrolled yet. The other order would leave an
  // id with no settings, and a start would build settings from the id.
  if (firstConnection) {
    try {
      await pending.save(firstConnection);
    } catch (error) {
      notes.push(
        "The settings were saved, but the install id could not be kept for the first connection " +
          `(${error instanceof Error ? error.message : String(error)}). ` +
          "Give it again: hx-fortress setup --connect <address>/i/<id>",
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
        // The console's own rule for a link that was minted elsewhere.
        const minted = judgeMintedLink({
          tokenDigest: deps.mintedLink?.digest,
          tokenExpires: deps.mintedLink?.expires,
          accounts: file.users.length,
          now: now(),
        });
        if (minted.use === "digest") {
          await users.createWithSetupDigest(login, "operator", minted.digest, minted.end, now());
          firstAccount = { login, token: null };
        } else if (minted.use === "refused") {
          notes.push(
            `The settings were saved, but the account for ${login} was not made. ${minted.said} ` +
              `Make it with: hx-fortress ui user create ${login} --role operator`,
          );
        } else {
          const created = await users.create(login, "operator", now());
          firstAccount = { login, token: created.token };
        }
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
