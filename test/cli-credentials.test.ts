import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FileCredentialStore } from "../src/cloud/credentials";
import { setFortressCredential } from "../src/cli-credentials";
import { fortressPaths } from "../src/host/paths";

describe("setFortressCredential", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-cli-credentials-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("replaces only the long-lived credential for an enrolled Fortress", async () => {
    const paths = fortressPaths(root);
    const store = new FileCredentialStore(paths.credentials);
    await store.save({
      orgId: "org-1",
      fortressId: "fortress-1",
      credential: "vlc_old",
    });

    const updated = await setFortressCredential("vlc_new", { root });

    expect(updated).toEqual({
      orgId: "org-1",
      fortressId: "fortress-1",
      credential: "vlc_new",
    });
    await expect(store.load()).resolves.toEqual(updated);
  });

  test("rejects a replacement key with the wrong format", async () => {
    await expect(setFortressCredential("not-a-fortress-key", { root })).rejects.toThrow(
      "usage: hx-fortress credentials set <key>",
    );
  });

  test("rejects credential replacement before enrollment", async () => {
    await expect(setFortressCredential("vlc_new", { root })).rejects.toThrow(
      "Fortress is not enrolled yet",
    );
  });
});
