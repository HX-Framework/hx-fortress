// Reads one secret through the azure-key-vault provider, built from settings
// the way a fortress builds it, in a process whose environment names a proxy.
//
// It is run only as a child process of test/secrets-azure-key-vault.test.ts:
// which requests the runtime sends through a proxy is decided from the
// process's own environment, and a test must not change its own.
//
// The parent starts three local servers and passes their addresses: a fake
// identity endpoint, a fake vault, and a server that plays the proxy. Nothing
// here reaches Azure or any other host.

import { createSecretProvider, resolveSecretsConfig } from "../../src/secrets/config";
import { routeHostToFake, type FakeHttpServer } from "./azure-fakes";

const vaultOrigin = process.env.TEST_VAULT_ORIGIN;
const identityEndpoint = process.env.IDENTITY_ENDPOINT;
if (!vaultOrigin || !identityEndpoint || !process.env.HTTP_PROXY) {
  throw new Error("usage: run by the test with TEST_VAULT_ORIGIN, IDENTITY_ENDPOINT and HTTP_PROXY set");
}

// The control: before the provider exists, a request to the identity endpoint
// is carried by the proxy. Without this the test below would prove nothing.
const control = await (await fetch(identityEndpoint)).text();

routeHostToFake("fortress-test.vault.azure.net", { origin: vaultOrigin } as FakeHttpServer);
const provider = createSecretProvider(
  resolveSecretsConfig({ env: process.env, config: null, root: process.cwd() }),
  { env: process.env },
);
const value = await provider.get("db-url");
console.log(JSON.stringify({ control, value, noProxy: process.env.NO_PROXY ?? null }));
