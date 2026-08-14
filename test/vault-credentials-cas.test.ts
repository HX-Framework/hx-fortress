import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  credentialsPath,
  credentialsVersion,
  readVaultCredentials,
  redactCredentials,
  storeCredentialsForConsole,
  updateVaultCredentials,
  vaultHome,
  writeVaultCredentials,
  LiveCredentialsReader,
  type VaultCredentials,
} from "../src/modules/session-vault/credentials";
import { reattachUnmanaged } from "../src/host/headless-bootstrap";

const ORIGINAL_HOME = process.env.HOME;

const CREDS: VaultCredentials = {
  store: "s3",
  bucket: "b",
  region: "us-east-1",
  s3: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "shhh" },
  openaiApiKey: "sk-test-key",
};

describe("credentials.json path resolution", () => {
  let home = "";
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "hx-creds-home-"));
    process.env.HOME = home;
  });
  afterEach(async () => {
    process.env.HOME = ORIGINAL_HOME;
    await rm(home, { recursive: true, force: true });
  });

  test("HOME changed AFTER import retargets both the read and the write", async () => {
    // Nothing here is captured at import time: a module constant would have
    // pinned whatever HOME held when the module first loaded.
    await writeVaultCredentials(CREDS);
    expect(credentialsPath()).toBe(path.join(home, ".let", "session-vault", "credentials.json"));
    expect((await readVaultCredentials())?.bucket).toBe("b");

    const second = await mkdtemp(path.join(os.tmpdir(), "hx-creds-home2-"));
    try {
      process.env.HOME = second;
      expect(vaultHome()).toBe(path.join(second, ".let", "session-vault"));
      // The new home is empty…
      expect(await readVaultCredentials()).toBeNull();
      // …and a write lands there, not in the old one.
      await writeVaultCredentials({ ...CREDS, bucket: "second" });
      expect((await readVaultCredentials())?.bucket).toBe("second");
      process.env.HOME = home;
      expect((await readVaultCredentials())?.bucket).toBe("b");
    } finally {
      await rm(second, { recursive: true, force: true });
    }
  });

  test("the file is 0600 inside a 0700 directory", async () => {
    await writeVaultCredentials(CREDS);
    expect((await stat(credentialsPath())).mode & 0o777).toBe(0o600);
    expect((await stat(vaultHome())).mode & 0o777).toBe(0o700);
  });
});

describe("the version CAS", () => {
  let home = "";
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "hx-creds-cas-"));
    process.env.HOME = home;
  });
  afterEach(async () => {
    process.env.HOME = ORIGINAL_HOME;
    await rm(home, { recursive: true, force: true });
  });

  test("an absent version reads as 0", async () => {
    expect(credentialsVersion(null)).toBe(0);
    expect(credentialsVersion(CREDS)).toBe(0);
    expect(credentialsVersion({ ...CREDS, version: 3 })).toBe(3);
  });

  test("a version-less file rotates successfully and is stamped 1 in place", async () => {
    // 100% of enrolled fortresses hold a version-less file, and a strict CAS
    // that refused one would break the FIRST rotation on every one of them.
    await writeVaultCredentials(CREDS);
    const result = await updateVaultCredentials((current) => ({
      ...(current as VaultCredentials),
      bucket: "rotated",
    }));
    expect(result.version).toBe(1);
    const onDisk = await readVaultCredentials();
    expect(onDisk?.version).toBe(1);
    expect(onDisk?.bucket).toBe("rotated");
    // Every other field survives.
    expect(onDisk?.openaiApiKey).toBe("sk-test-key");
    expect(onDisk?.s3?.secretAccessKey).toBe("shhh");
  });

  test("the counter is monotonic across writes", async () => {
    await writeVaultCredentials(CREDS);
    for (const expected of [1, 2, 3]) {
      const result = await updateVaultCredentials((c) => c as VaultCredentials);
      expect(result.version).toBe(expected);
    }
  });

  test("a stale lock from a killed writer is broken, blocking nothing", async () => {
    await writeVaultCredentials(CREDS);
    const lock = `${credentialsPath()}.lock`;
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, JSON.stringify({ pid: 999999, bootId: "dead" }), { mode: 0o600 });
    const stale = new Date(Date.now() - 60_000);
    await utimes(lock, stale, stale);

    const result = await updateVaultCredentials((c) => ({ ...(c as VaultCredentials), bucket: "x" }));
    expect(result.version).toBe(1);
  });

  test("a temporary file left behind at a loose mode cannot publish that mode", async () => {
    // A crash mid-write leaves the temporary path behind. Re-opened, `mode` on
    // writeFile is ignored — it applies at CREATION — so the leftover's mode is
    // what the rename publishes onto the most sensitive file on the box. Every
    // write takes its own name and is chmod'd before the rename.
    const file = credentialsPath();
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(`${file}.tmp`, "{}\n", { mode: 0o644 });
    await writeVaultCredentials(CREDS);
    // Untouched: the write went through a name of its own, so a foreign inode's
    // mode is never what the rename publishes.
    expect(await readFile(`${file}.tmp`, "utf8")).toBe("{}\n");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("a FRESH lock whose owner no longer exists is reclaimed at once", async () => {
    await writeVaultCredentials(CREDS);
    const lock = `${credentialsPath()}.lock`;
    await mkdir(path.dirname(lock), { recursive: true });
    // Written a moment ago by a process that is gone — a container killed
    // mid-rotation, a daemon that crashed inside the cut. Age says "respect
    // it"; liveness says there is nobody to respect. Without the liveness half
    // this door was shut for the whole stale timer, and it is the door both a
    // rotation and a migration swap have to pass through.
    await writeFile(
      lock,
      JSON.stringify({ pid: 999_999, bootId: "gone", at: new Date().toISOString() }),
      { mode: 0o600 },
    );
    const result = await updateVaultCredentials((c) => ({ ...(c as VaultCredentials), bucket: "y" }));
    expect(result.version).toBe(1);
  });

  test("concurrent writers serialize instead of interleaving", async () => {
    await writeVaultCredentials(CREDS);
    const results = await Promise.all([
      updateVaultCredentials((c) => ({ ...(c as VaultCredentials), region: "a" })),
      updateVaultCredentials((c) => ({ ...(c as VaultCredentials), region: "b" })),
      updateVaultCredentials((c) => ({ ...(c as VaultCredentials), region: "c" })),
    ]);
    expect(results.map((r) => r.version).sort()).toEqual([1, 2, 3]);
    expect((await readVaultCredentials())?.version).toBe(3);
  });
});

describe("credential views", () => {
  test("the console gets the storage block minus the non-store secret", () => {
    const view = storeCredentialsForConsole({ ...CREDS, version: 4 });
    // Signing HEAD/LIST needs exactly these; the OpenAI key has no store use.
    expect(view.s3?.secretAccessKey).toBe("shhh");
    expect(view.openaiApiKey).toBeUndefined();
    expect(view.version).toBe(4);
  });

  test("the rendered view never carries key material", () => {
    const view = JSON.stringify(redactCredentials({ ...CREDS, version: 2 }));
    expect(view).not.toContain("shhh");
    expect(view).not.toContain("sk-test-key");
    expect(view).toContain('"version":2');
  });
});

describe("the live console reader", () => {
  let home = "";
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "hx-creds-live-"));
    process.env.HOME = home;
  });
  afterEach(async () => {
    process.env.HOME = ORIGINAL_HOME;
    await rm(home, { recursive: true, force: true });
  });

  test("picks up a rotation with no restart", async () => {
    await writeVaultCredentials(CREDS);
    const reader = new LiveCredentialsReader();
    expect((await reader.read())?.bucket).toBe("b");
    expect(reader.version).toBe(0);

    await updateVaultCredentials((c) => ({ ...(c as VaultCredentials), bucket: "rotated" }));
    // A cached copy across a version bump would keep signing with a key the
    // provider has already revoked.
    expect((await reader.read())?.bucket).toBe("rotated");
    expect(reader.version).toBe(1);
  });
});

describe("headless rebuild", () => {
  test("re-attaches exactly the fields the environment does not manage", async () => {
    const fromEnv: VaultCredentials = { store: "s3", bucket: "envbucket" };
    const merged = reattachUnmanaged(fromEnv, { ...CREDS, version: 7 });
    expect(merged.openaiApiKey).toBe("sk-test-key");
    // Without this the counter would reset to absent on every redeploy and the
    // console would see 1 → 1 across genuinely different credentials.
    expect(merged.version).toBe(7);
    // A REMOVED env var still takes effect.
    expect(merged.region).toBeUndefined();
    expect(merged.s3).toBeUndefined();
  });

  test("a fresh volume has nothing to carry over", () => {
    const fromEnv: VaultCredentials = { store: "gcs", bucket: "b" };
    expect(reattachUnmanaged(fromEnv, null)).toEqual(fromEnv);
  });

  test("the CAS stays monotonic across a redeploy", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "hx-creds-redeploy-"));
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      await writeVaultCredentials(CREDS);
      await updateVaultCredentials((c) => c as VaultCredentials); // version 1
      const existing = await readVaultCredentials();
      await writeVaultCredentials(reattachUnmanaged({ store: "s3", bucket: "envbucket" }, existing));
      const next = await updateVaultCredentials((c) => c as VaultCredentials);
      expect(next.version).toBe(2);
    } finally {
      process.env.HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });
});
