// What one secret provider tells the rest of the fortress about itself.
//
// A provider is one file: the class that reads values, and one definition of
// the shape below. `providers.ts` lists every definition. Everything that needs
// to know which providers exist reads that list: the settings check, the error
// messages, the console's list of data paths and the docs. So adding a provider
// is its own file and one line in the list, and no other file names it.

import type { SecretProvider } from "./types";

/** One setting that belongs to a provider. */
export interface SecretProviderSetting {
  /** Its key in the `secrets` block of config.json. */
  readonly key: string;
  /** Its environment variable. It starts with FORTRESS_SECRETS_, and a
   *  provider's own settings add the provider's short name after that. */
  readonly env: string;
  /** One sentence for the docs. */
  readonly meaning: string;
  /** True when the value may also be written as a JSON number in config.json. */
  readonly numeric?: boolean;
  /**
   * How to tell this setting when its variable is written one letter short.
   *
   * FORTRESS_SECRET_DIR is one letter short of FORTRESS_SECRETS_DIR, and it is
   * also the valid variable of a secret named `dir`, so the name alone does
   * not say which was meant. `when` says whether a value has the shape this
   * setting takes, and `holds` names that shape in the refusal. A setting
   * without this is not looked for under the short name.
   */
  readonly oneLetterShort?: {
    readonly holds: string;
    readonly when: (value: string) => boolean;
  };
}

/** A setting as it was given: its value, and where it was set. `where` is an
 *  environment variable's name or "secrets.<key> in config.json", so a message
 *  can point at the place without repeating the value. */
export interface GivenSetting {
  readonly value: string;
  readonly where: string;
}

export interface SecretProviderResolveArgs {
  /** One of this provider's own settings, or null when it is not set. */
  setting(key: string): GivenSetting | null;
  /** The fortress root. */
  readonly root: string;
}

/**
 * Where a provider's values come from, for a person who checks what leaves
 * this host. The console shows these sentences as they are.
 */
export interface SecretProviderPath {
  /** True when reading a secret makes a request that leaves this host. */
  readonly leavesHost: boolean;
  /** The other end: a place on this host, or an address. */
  readonly peer: string;
  /** What travels, when it is more than the values coming in. */
  readonly carries?: string;
  /** Who decides which values this fortress may read. */
  readonly gate: string;
  readonly notes: readonly string[];
}

export interface SecretProviderDefinition<
  Kind extends string = string,
  Config extends { provider: Kind } = { provider: Kind },
> {
  /** The provider's name: what FORTRESS_SECRETS_PROVIDER and `secrets.provider`
   *  hold, and what a status report says. */
  readonly kind: Kind;
  /** The cloud whose service this provider reads, by its common name. Null
   *  for a provider that needs no cloud. */
  readonly cloud: string | null;
  /** One sentence for the docs: where the secret `db-url` is read from. */
  readonly summary: string;
  /** What the provider needs from the host it runs on, beyond its settings.
   *  Null when it needs nothing. A provider with a need cannot be chosen on
   *  every host, and the docs say so beside it. */
  readonly needs: string | null;
  /** The settings that belong to this provider. */
  readonly settings: readonly SecretProviderSetting[];
  /**
   * Prefixes, beyond FORTRESS_SECRETS_, under which every variable is refused:
   * prefixes this provider's settings had under an earlier name.
   *
   * A variable that starts with one of them is a setting under a name that is
   * not read. Ignoring it would leave the fortress reading its secrets with a
   * setting the operator believes they made.
   */
  readonly guardedEnvPrefixes?: readonly string[];
  /**
   * Check this provider's settings and return its config.
   *
   * Throws `invalidSecretsConfig` for a setting that cannot be used. The reason
   * names the setting by `where` and never repeats a value: a line pasted into
   * the wrong setting can be a credential.
   */
  resolve(args: SecretProviderResolveArgs): Config;
  /** Build the provider. No secret is read and no request is made here. */
  create(config: Config, deps: { env?: Record<string, string | undefined> }): SecretProvider;
  /** One short line for a log or a status: the kind and where the values are.
   *  Never anything read from there. */
  describe(config: Config): string;
  path(config: Config): SecretProviderPath;
}

/** The error for a secrets setting that cannot be used. */
export function invalidSecretsConfig(reason: string): Error {
  return new Error(`Invalid secrets config: ${reason}`);
}
