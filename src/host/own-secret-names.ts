// The names of the secrets that this HX Fortress's own settings name.
//
// A person at the console can add the name of a secret that a module may then
// read (module-context.ts). The names here are not that person's to hand
// over. A module that could read one could present this HX Fortress's own
// database password, its sign-in's secret or its model's key as a login to a
// server of that person's choosing.
//
// EVERY SETTING THAT NAMES A SECRET IS HERE. There are six today:
//
//    FORTRESS_DATABASE_URL_SECRET       the environment
//    FORTRESS_INSTALL, certificateName  the environment, as JSON
//    postgres.urlSecret                 config.json
//    model.key                          config.json
//    install.certificateName            config.json
//    clientSecretName                   ui/oidc.json
//
// The certificate's name is in two places because an install hands it over in
// a variable, and the setup then writes no `install` block to config.json. An
// HX Fortress that was set up on its own machine has it in config.json.
//
// HX Fortress reads the database's, the model's and the sign-in's secret
// itself. It does not read the certificate: the place that an install made
// puts the organization's own certificate on the address. The name is here
// all the same, because a key store keeps a certificate's private key under
// the certificate's name, and a module that could read that name could read
// the key.
//
// A setting that is added later and names a secret is added here too. A test
// (test/host/own-secret-names.test.ts) reads the setup's own list of answers
// that are the name of a key, and the parsers of these places, and fails when
// one of them names a secret this file does not know.
//
// TWO READINGS, BOTH KEPT BACK. The names the running daemon read at its
// start, and the names the settings hold now. They differ after a person
// changed a setting: the daemon still uses the old name, and takes the new
// one at its next start. Neither is handed to a module.
//
// NOT HERE: the name of a one-time enrollment token, which a setup with
// nobody at the screen reads once. HX Fortress does not keep that name, and
// the token opens nothing after its first use.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { INSTALL_FACTS_ENV, parseInstallFacts } from "../setup/read";
import { OidcConfigStore } from "../ui/oidc-config";
import { parseFortressConfig } from "./config";
import type { fortressPaths } from "./paths";
import type { FortressConfig } from "./types";

type FortressPaths = ReturnType<typeof fortressPaths>;

export interface OwnSecretNameSources {
  /** The names this run read at its start: the database's and the model's.
   *  An entry that is null or undefined is a setting that named no secret. */
  atStart: readonly (string | null | undefined)[];
  /** config.json as it is now, or null when there is none. Rejects when the
   *  file is there and cannot be used. */
  config: () => Promise<Pick<FortressConfig, "model" | "postgres" | "install"> | null>;
  /** The sign-in's settings as they are now. Rejects when they cannot be read. */
  signIn: () => Promise<{ clientSecretName: string | null }>;
  /** This process's environment. An install hands the certificate's name over
   *  in `FORTRESS_INSTALL`. */
  env: Record<string, string | undefined>;
}

/**
 * One of the places that name a secret cannot be read, so which names are
 * taken is not known. `place` is one of a few fixed words, for the log: what
 * could not be read is not repeated, and neither is the reader's own error,
 * which can quote a part of a file.
 */
export class SettingUnreadable extends Error {
  readonly place: string;

  constructor(place: string) {
    super(`${place} cannot be read`);
    this.name = "SettingUnreadable";
    this.place = place;
  }
}

async function from<T>(place: string, read: () => T | Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    throw new SettingUnreadable(place);
  }
}

/** The names that the install's variable holds. Throws when the variable is
 *  set and is not the install's facts: what it names is then not known. */
function namesOfInstall(env: Record<string, string | undefined>): string[] {
  // eslint-disable-next-line security/detect-object-injection -- a constant of this build.
  const raw = env[INSTALL_FACTS_ENV]?.trim();
  if (!raw) return [];
  const facts = parseInstallFacts(raw);
  if (facts === null) throw new Error("not the install's facts");
  return facts.certificateName ? [facts.certificateName] : [];
}

/**
 * The names of the secrets that this HX Fortress's own settings name. Rejects
 * with `SettingUnreadable` when a setting cannot be read: which names are
 * taken is then not known, and the caller hands no added name to a module.
 */
export async function ownSecretNames(sources: OwnSecretNameSources): Promise<string[]> {
  const names = new Set<string>();
  for (const name of sources.atStart) if (name) names.add(name);
  for (const name of await from(`the variable ${INSTALL_FACTS_ENV}`, () => namesOfInstall(sources.env))) names.add(name);
  const config = await from("config.json", sources.config);
  if (config?.postgres?.urlSecret) names.add(config.postgres.urlSecret);
  if (config?.model?.key) names.add(config.model.key);
  if (config?.install?.certificateName) names.add(config.install.certificateName);
  const signIn = await from("ui/oidc.json", sources.signIn);
  if (signIn.clientSecretName) names.add(signIn.clientSecretName);
  return [...names];
}

/** config.json as it is now, or null when there is no such file. Rejects when
 *  the file is there and cannot be read, or is not a config.json. */
async function configNow(paths: FortressPaths): Promise<FortressConfig | null> {
  let text: string;
  try {
    text = await readFile(paths.config, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseFortressConfig(JSON.parse(text));
}

/** `ownSecretNames`, read from this HX Fortress's own files. What the daemon
 *  uses. */
export async function ownSecretNamesOf(
  paths: FortressPaths,
  atStart: () => readonly (string | null | undefined)[],
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  return ownSecretNames({
    atStart: atStart(),
    config: () => configNow(paths),
    signIn: () => new OidcConfigStore(path.join(paths.uiRoot, "oidc.json")).load(),
    env,
  });
}
