import { FileCredentialStore } from "./cloud/credentials";
import type { CloudCredential } from "./cloud/credentials";
import { fortressPaths } from "./host/paths";

export interface SetFortressCredentialOptions {
  root?: string;
}

export async function setFortressCredential(
  credential: string,
  options: SetFortressCredentialOptions = {},
): Promise<CloudCredential> {
  const normalized = parseCredentialValue(credential);
  const paths = fortressPaths(options.root);
  const store = new FileCredentialStore(paths.credentials);
  const current = await store.load();
  if (!current) {
    throw new Error("Fortress is not enrolled yet. Run `hx-fortress enroll` first.");
  }

  const updated = { ...current, credential: normalized };
  await store.save(updated);
  return updated;
}

function parseCredentialValue(value: string): string {
  const normalized = value.trim();
  if (!normalized.startsWith("vlc_") || normalized.length <= 4 || /\s/.test(normalized)) {
    throw new Error("usage: hx-fortress credentials set <key>");
  }
  return normalized;
}
