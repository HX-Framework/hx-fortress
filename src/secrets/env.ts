// The `env` provider: a secret named `db-url` is the environment variable
// FORTRESS_SECRET_DB_URL.
//
// This is the default, and it is how a container already receives its
// settings. The fixed prefix is the safety property: a name can only ever
// reach a variable that starts with FORTRESS_SECRET_, so asking for the secret
// `home` reads FORTRESS_SECRET_HOME and never $HOME.
//
// What to know before choosing it: every process this one starts inherits the
// environment, so each of them can read every secret given this way.

import { secretValueFrom, SecretProviderBase } from "./provider-base";
import { assertSecretName, SecretMissing } from "./types";

export const SECRET_ENV_PREFIX = "FORTRESS_SECRET_";

/** `db-url` → `FORTRESS_SECRET_DB_URL`. Two different names never map to the
 *  same variable: letters only change case, and "-" is the only character that
 *  becomes "_". */
export function secretEnvName(name: string): string {
  assertSecretName(name);
  return `${SECRET_ENV_PREFIX}${name.toUpperCase().replaceAll("-", "_")}`;
}

export class EnvSecretProvider extends SecretProviderBase {
  readonly kind = "env" as const;

  // A `#` field, not a TypeScript `private` one. A `private` field is an
  // ordinary property at run time, so logging or serializing the provider
  // would print the whole environment, values included.
  readonly #env: Record<string, string | undefined>;

  /** The environment is read at every call, so a caller that changes it sees
   *  the change. */
  constructor(env: Record<string, string | undefined> = process.env) {
    super();
    this.#env = env;
  }

  async get(name: string): Promise<string> {
    const variable = secretEnvName(name);
    const source = `environment variable ${variable}`;
    // Own properties only, so nothing inherited is ever served as a secret.
    // The variable name is built from a checked secret name and a fixed prefix.
    // eslint-disable-next-line security/detect-object-injection
    const stored = Object.hasOwn(this.#env, variable) ? this.#env[variable] : undefined;
    if (stored === undefined) throw new SecretMissing(name, source);
    return secretValueFrom(name, stored, source);
  }
}
