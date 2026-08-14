import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FileCredentialStore } from "../src/cloud/credentials";
import type { CloudCredential } from "../src/cloud/credentials";

describe("FileCredentialStore", () => {
  let root: string;
  let credentialPath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-credentials-"));
    credentialPath = path.join(root, "identity", "credentials.json");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("returns null when credentials do not exist", async () => {
    await expect(new FileCredentialStore(credentialPath).load()).resolves.toBeNull();
  });

  test("saves and loads credentials with a private file mode", async () => {
    const store = new FileCredentialStore(credentialPath);
    const credential = sampleCredential();

    await store.save(credential);

    await expect(store.load()).resolves.toEqual(credential);
    const contents = await readFile(credentialPath, "utf8");
    expect(JSON.parse(contents)).toEqual(credential);
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
  });

  test("rejects malformed credentials without exposing secrets", async () => {
    const store = new FileCredentialStore(credentialPath);
    await Bun.write(
      credentialPath,
      '{"credential":"secret","orgId":1,"fortressId":"fortress"}',
    );

    await expect(store.load()).rejects.toThrow("Invalid Fortress credentials");
  });
});

function sampleCredential(): CloudCredential {
  return {
    orgId: "org-1",
    fortressId: "fortress-1",
    credential: "cred-1",
  };
}
