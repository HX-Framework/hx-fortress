// What the setup's tests share.

import { readFile } from "node:fs/promises";

import type { VaultCredentials } from "../src/modules/session-vault/credentials";
import type { EnrollmentDeps } from "../src/setup/control-plane";
import type { SetupRun, SetupRunDeps } from "../src/setup/run";
import { fixedSecrets, type Paths } from "./host/_module-rig";

// Built at run time so no secret-shaped literal sits in the repository.
export const DB_URL = ["postgres://fortress:", "pw-for-a-test", "@db.northstar.example:5432/fortress"].join("");
export const TOKEN = ["connection", "token", "for", "a", "test"].join("-");
export const CONTROL = "wss://control.example/_api/hx-gateway/vault-tunnel";


/**
 * A sign-in provider's description of itself, as one that the console accepts
 * gives it: the issuer, and https addresses for sign-in, tokens and keys.
 */
export function providerDocument(issuer: string): Record<string, unknown> {
  const base = issuer.replace(/\/+$/, "");
  return {
    issuer,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    jwks_uri: `${base}/keys`,
    id_token_signing_alg_values_supported: ["RS256"],
  };
}

/** What the Sessions credentials file would hold, kept in memory: a test never
 *  reads or writes the one in the home folder of whoever runs it. */
export function vault(initial: VaultCredentials | null = null): {
  current: VaultCredentials | null;
  read: () => Promise<VaultCredentials | null>;
  update: NonNullable<NonNullable<SetupRunDeps["apply"]>["updateVaultCredentials"]>;
} {
  const box = {
    current: initial,
    read: async (): Promise<VaultCredentials | null> => box.current,
    update: async (mutate: (current: VaultCredentials | null) => VaultCredentials) => {
      const next = mutate(box.current);
      const version = (box.current?.version ?? 0) + 1;
      box.current = { ...next, version };
      return { credentials: box.current, version };
    },
  };
  return box;
}

/** A control plane that hands out one code, and where a person signs in when told. */
export function controlPlane(): { deps: EnrollmentDeps; signIn: () => void; asked: string[] } {
  let signedIn = false;
  const asked: string[] = [];
  return {
    asked,
    signIn: () => {
      signedIn = true;
    },
    deps: {
      requestCode: async (base) => {
        asked.push(base);
        return {
          userCode: "K7Q-42M",
          deviceCode: "device-code-for-a-test",
          verificationUriComplete: "https://control.example/install?code=K7Q-42M",
          interval: 1,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        };
      },
      poll: async () => (signedIn ? { kind: "ready", token: TOKEN } : { kind: "expired" }),
    },
  };
}

export function runDeps(paths: Paths, over: Partial<SetupRunDeps> = {}): SetupRunDeps {
  const box = vault();
  return {
    paths,
    env: {},
    read: { vaultCredentials: box.read },
    apply: { updateVaultCredentials: box.update },
    check: {
      keyStore: () => fixedSecrets({ "db-url": DB_URL, "connection-token": TOKEN }),
      fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      probeDatabase: async () => "PostgreSQL 17.2",
      probeFiles: async () => {},
      timeoutMs: 2_000,
    },
    ...over,
  };
}

export async function rawConfig(paths: Paths): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(paths.config, "utf8")) as Record<string, unknown>;
}

export function northstar(run: SetupRun): void {
  run.set("organization.name", "Northstar");
  run.set("organization.firstAdministrator", "marta.lindqvist");
}

