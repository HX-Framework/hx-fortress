// An hx-fortress instance that touches nothing the developer owns.
//
// The vault's credential store resolves under $HOME at CALL time, so a rig that
// only overrode FORTRESS_ROOT would still read and — on an enrollment — WRITE
// the developer's real ~/.let/session-vault. That is a bucket credential and an
// OpenAI key belonging to a live fortress, and a test run has no business near
// either. So HOME and FORTRESS_ROOT point at the SAME temp directory, and the
// suite asserts the host's vault home is byte-identical after up and down.
//
// The cross-repo half of the harness (minting an org enroll token against a dev
// workbench, and connecting the tunnel) lives in let-forge and drives this side
// through the environment below.

import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface FortressRig {
  root: string;
  /** HOME for anything this rig runs — the same directory as the root. */
  home: string;
  /** The vault home INSIDE the rig, which is the one a rig run may write. */
  vaultHome: string;
  env: Record<string, string>;
  /** Idempotent. */
  down: () => Promise<void>;
}

export interface FortressRigOptions {
  /** Extra environment merged into `env`. */
  env?: Record<string, string>;
  /** Where the temp root is created. Defaults to the OS temp dir. */
  parent?: string;
}

export async function fortressRigUp(options: FortressRigOptions = {}): Promise<FortressRig> {
  const root = await mkdtemp(path.join(options.parent ?? os.tmpdir(), "hx-fortress-rig-"));
  let torn = false;
  return {
    root,
    home: root,
    vaultHome: path.join(root, ".let", "session-vault"),
    env: {
      FORTRESS_ROOT: root,
      HOME: root,
      ...options.env,
    },
    down: async () => {
      if (torn) return;
      torn = true;
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Run `fn` with HOME and FORTRESS_ROOT pointed at the rig, restoring the real
 *  environment afterwards even when `fn` throws — a leaked HOME would send every
 *  later test in the same process at the developer's home directory. */
export async function withFortressRig<T>(
  fn: (rig: FortressRig) => Promise<T>,
  options: FortressRigOptions = {},
): Promise<T> {
  const rig = await fortressRigUp(options);
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(rig.env)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn(rig);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rig.down();
  }
}

/** A content fingerprint of a directory tree: relative path, size and sha256 per
 *  file. Used to prove a rig run left the host's vault home untouched — an mtime
 *  comparison would miss a rewrite with preserved timestamps. */
export async function fingerprintTree(dir: string): Promise<string[]> {
  const entries: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let listing: string[];
    try {
      listing = await readdir(current);
    } catch {
      return;
    }
    for (const name of listing.sort()) {
      const full = path.join(current, name);
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) {
        await walk(full);
        continue;
      }
      const digest = new Bun.CryptoHasher("sha256").update(await readFile(full)).digest("hex");
      entries.push(`${path.relative(dir, full)} ${info.size} ${digest}`);
    }
  };
  await walk(dir);
  return entries;
}

/** The developer's real vault home, resolved the way the vault itself resolves
 *  it — from $HOME first, so this reports the directory a leak would land in. */
export function hostVaultHome(): string {
  const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir();
  return path.join(home, ".let", "session-vault");
}
