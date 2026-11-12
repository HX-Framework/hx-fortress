// Every secret provider this build has. This is the one list.
//
// The settings check, the error messages, the console's list of data paths and
// the docs all read it. Nothing else names a provider.
//
// The order is the order every message and every doc lists them in: first the
// providers that need no cloud, then each cloud's own, by the cloud's name. A
// test keeps the list in that order.
//
// To add a provider: write its file (the class and its definition, as env.ts,
// file.ts and azure-key-vault.ts do), add its definition below, and give it a
// rig in test/secrets-contract.test.ts. That file holds the tests every
// provider passes, and one of them fails while a listed provider has no rig.

import { AZURE_KEY_VAULT_SECRET_PROVIDER } from "./azure-key-vault";
import type { SecretProviderDefinition } from "./definition";
import { ENV_SECRET_PROVIDER } from "./env";
import { FILE_SECRET_PROVIDER } from "./file";

const LISTED = [ENV_SECRET_PROVIDER, FILE_SECRET_PROVIDER, AZURE_KEY_VAULT_SECRET_PROVIDER] as const;

/** What `resolveSecretsConfig` returns: the config of one listed provider. */
export type SecretsConfig = ReturnType<(typeof LISTED)[number]["resolve"]>;

export const SECRET_PROVIDERS: readonly SecretProviderDefinition[] = LISTED;

/** The provider a fortress uses when nothing chooses one. */
export const DEFAULT_SECRET_PROVIDER_KIND: string = ENV_SECRET_PROVIDER.kind;

/** The name of every provider this build has, in the order of the list. */
export const SECRET_PROVIDER_KINDS: readonly string[] = SECRET_PROVIDERS.map((provider) => provider.kind);

/** True when this build has a provider with that name. */
export function isSecretProviderKind(value: unknown): value is string {
  return typeof value === "string" && SECRET_PROVIDER_KINDS.includes(value);
}

/** The listed provider with that name, or null. */
export function secretProviderDefinition(kind: unknown): SecretProviderDefinition | null {
  return SECRET_PROVIDERS.find((provider) => provider.kind === kind) ?? null;
}
