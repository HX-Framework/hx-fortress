// What `hx-fortress install` hands to the place that makes HX Fortress.
//
// The install runs on an engineer's computer and writes nothing there. All it
// knows goes into one object: the settings of HX Fortress's container, the
// keys a person typed, and the plan. The place (`place.ts`) makes the
// resources and gives HX Fortress these settings. HX Fortress then sets
// itself up from them at its first start, checks every answer with the real
// thing, and starts.
//
// THE ENVIRONMENT CARRIES THE FACTS OF THE PLACE: where it runs, its key
// store, its address, its database, its control plane. HX Fortress reads each
// from the variable it always read it from, so these answers show in its
// console as set by the host, and running the install again changes them.
//
// ONE VARIABLE CARRIES THE REST, ONCE: `FORTRESS_SETUP_SETTINGS` holds a
// settings file with the answers an administrator may change later in the
// console (the organization's name, sign-in, modules, the model, the network,
// updates, the audit trail). It is read at the first start only. It holds no
// key: a key is given by its name, like everywhere else.
//
// A KEY A PERSON TYPED LEAVES THIS COMPUTER ONCE, to the key store the answers
// chose, written by the place with the engineer's own access. It is in no
// variable, unless the key store IS the container's own settings: then it is
// one of `secretEnvironment`, which the place gives the way its platform
// gives a secret.

import { CONTROL_PLANE_PAGES_ENV } from "../host/config";
import { answersToFile, publicAddress, type SetupAnswers } from "../setup/answers";
import { secretsBlockOf } from "../setup/checks";
import { controlPlaneUrl } from "../setup/control-plane";
import { INSTALL_PLACES, NONE, fieldsInEffect, isPlaceId, keyFields } from "../setup/list";
import { FIRST_ACCOUNT_ENV, INSTALL_FACTS_ENV, KEY_STORE_ENV } from "../setup/read";
import { SETUP_SETTINGS_ENV } from "../setup/state";
import type { PlanRow } from "../setup/view";
import { secretEnvName } from "../secrets/env";
import { secretProviderDefinition } from "../secrets/providers";
import { BOOTSTRAP_TOKEN_DIGEST_ENV, BOOTSTRAP_TOKEN_EXPIRES_ENV } from "../ui/bootstrap-user";
import type { HandOver } from "./place";

/** The variable that carries the digest of the first administrator's one-time
 *  token. HX Fortress makes the account with it, and the install shows the
 *  link. The token itself never leaves the engineer's computer. */
export const FIRST_ACCOUNT_DIGEST_ENV = BOOTSTRAP_TOKEN_DIGEST_ENV;
/** The variable that carries the time that link stops working. HX Fortress
 *  makes no account from a digest that comes without it. */
export const FIRST_ACCOUNT_EXPIRES_ENV = BOOTSTRAP_TOKEN_EXPIRES_ENV;

/** The name a database's connection string has in the key store when the
 *  install puts it there. */
export const DATABASE_KEY_NAME = "database-address";

/** The questions whose answers an administrator may change in the console.
 *  The settings file of the first start holds these, and no other. */
const SEEDED = ["organization", "signIn", "modules", "model", "network", "updates", "auditTrail"] as const;

export interface HandOverInput {
  /** The answers, as they were checked. */
  answers: SetupAnswers;
  /** The keys a person typed, by the path of the field. */
  typed: ReadonlyMap<string, string>;
  /** The one-time install id for the control plane the answers name. */
  installId: string | null;
  /** The first administrator's one-time link, when the install made it: the
   *  sha256 of its token, and the time it stops working as an ISO 8601 time.
   *  The two go together, because HX Fortress takes neither alone. */
  account: { digest: string; expires: string } | null;
  rows: readonly PlanRow[];
}

function answerAt(answers: SetupAnswers, at: string): string {
  let node: unknown = answers;
  for (const part of at.split(".")) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, part)) return "";
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : "";
}

/**
 * The paths of the typed keys that these answers use: the field is one the
 * install shows for them, and its answer is the name a typed key gets there.
 * The checks and the hand-over both go by this, so what is checked is what is
 * handed over.
 */
export function typedInEffect(answers: SetupAnswers, typed: { has(at: string): boolean }): string[] {
  const place = isPlaceId(answers.where.place) ? answers.where.place : INSTALL_PLACES[0];
  if (!place) return [];
  return fieldsInEffect({ way: "install", place }, (at) => answerAt(answers, at))
    .filter((field) => field.kind === "key" && field.typedAs && typed.has(field.path))
    .filter((field) => answerAt(answers, field.path) === field.typedAs)
    .map((field) => field.path);
}

export function handOverOf(input: HandOverInput): HandOver {
  const { answers } = input;
  const environment: Record<string, string> = {};
  const secretEnvironment: Record<string, string> = {};
  const keys: { name: string; value: string }[] = [];

  // Where it runs, and what goes with the place.
  // eslint-disable-next-line security/detect-object-injection
  environment[INSTALL_FACTS_ENV] = JSON.stringify({
    place: answers.where.place,
    ...(answers.where.region ? { region: answers.where.region } : {}),
    ...(answers.where.place === "docker" && answers.where.ssh ? { ssh: answers.where.ssh } : {}),
    certificate: answers.address.certificate,
    ...(answers.address.certificate === "own" && answers.address.certificateName
      ? { certificateName: answers.address.certificateName }
      : {}),
    database: answers.data.database.store,
  });

  // The key store, by the variables HX Fortress reads it from.
  const store = answers.keys.store;
  // eslint-disable-next-line security/detect-object-injection
  environment[KEY_STORE_ENV] = store;
  const block = secretsBlockOf(answers.keys);
  for (const setting of secretProviderDefinition(store)?.settings ?? []) {
    const value = block[setting.key];
    if (value) environment[setting.env] = value;
  }

  // The keys a person typed, each under the name its field gives it. Only a
  // key whose field the final answers use is handed over: one that was typed
  // for an option the person gave up afterwards stays on this computer, and is
  // forgotten there with the rest.
  for (const at of typedInEffect(answers, input.typed)) {
    const name = keyFields().get(at)?.typedAs;
    const value = input.typed.get(at);
    if (!name || value === undefined) continue;
    // With the container's own settings as the key store, a key is one of
    // them: a secret one.
    if (store === "env") secretEnvironment[secretEnvName(name)] = value;
    else keys.push({ name, value });
  }

  // The address people reach it at, and the console that answers there.
  const address = publicAddress(answers);
  if (address) environment.FORTRESS_UI_PUBLIC_URL = address;
  environment.FORTRESS_UI_ENABLE = "1";

  // The database: reached by an address, under one name in the key store. A
  // database the place makes gets that name from here.
  const made = answers.data.database.store !== "existing";
  const databaseName = made ? DATABASE_KEY_NAME : answers.data.database.address;
  if (databaseName) environment.FORTRESS_DATABASE_URL_SECRET = databaseName;

  // The control plane, and the one-time id that connects to it.
  if (answers.controlPlane.connect === "yes" && answers.controlPlane.connected !== "off") {
    const parsed = controlPlaneUrl(answers.controlPlane.address);
    if (parsed.ok && input.installId) {
      environment.FORTRESS_CLOUD_URL = parsed.url;
      secretEnvironment.FORTRESS_ENROLL_TOKEN = input.installId;
    }
    // eslint-disable-next-line security/detect-object-injection
    if (answers.controlPlane.pages) environment[CONTROL_PLANE_PAGES_ENV] = answers.controlPlane.pages;
  }
  // Session content does not travel on the connection of a new install.
  environment.FORTRESS_CONNECTION_SESSION_CONTENT = "off";

  // The first administrator's account. With a digest, it is made for a token
  // that stays on the engineer's computer, and the install shows its link.
  // Without one, HX Fortress makes the account itself at its first start and
  // keeps the link in a file on its own disk.
  const login = answers.organization.firstAdministrator;
  if (login && answers.signIn.provider === "local") {
    // eslint-disable-next-line security/detect-object-injection
    environment[FIRST_ACCOUNT_ENV] = login;
    if (input.account) {
      // eslint-disable-next-line security/detect-object-injection
      environment[FIRST_ACCOUNT_DIGEST_ENV] = input.account.digest;
      // eslint-disable-next-line security/detect-object-injection
      environment[FIRST_ACCOUNT_EXPIRES_ENV] = input.account.expires;
    }
  }

  // The rest, once, as a settings file. The first administrator is made from
  // the variables above, so the file names the organization only.
  const file = answersToFile(answers) as unknown as Record<string, unknown>;
  const seed: Record<string, unknown> = { version: file.version };
  // eslint-disable-next-line security/detect-object-injection
  for (const step of SEEDED) seed[step] = file[step];
  seed.organization = { name: answers.organization.name };
  // A file store the place makes is the place's to name.
  if (answers.model.provider === NONE) seed.model = false;
  // eslint-disable-next-line security/detect-object-injection
  environment[SETUP_SETTINGS_ENV] = JSON.stringify(seed);

  return {
    answers,
    rows: input.rows,
    environment,
    secretEnvironment,
    keys,
    databaseKey: made ? DATABASE_KEY_NAME : null,
  };
}
