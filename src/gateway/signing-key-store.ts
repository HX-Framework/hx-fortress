import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { KeyProof } from "../protocol";
import { verifyKeyProof } from "../host/trust/signing-keys";

/** The persisted signing-key record (H-2). `key` is the org Ed25519 public key
 *  (base64url) the hub pushes; `pinnedAt` is when it was first pinned; `rootVerified`
 *  records whether the pin (or its last accepted rotation) carried a valid root proof.
 *  `notBefore` is the accepted root proof's authenticated `notBefore` (null for a
 *  legacy/proofless pin) — the MONOTONIC floor a rotation must strictly exceed, so
 *  a replayed OLDER root proof can't roll the pin back to a prior key (H-2b). */
export interface PinnedSigningKey {
  key: string;
  pinnedAt: string | null;
  rootVerified: boolean;
  notBefore: string | null;
}

/** Persists the org Ed25519 public key (base64url) the hub pushes over the
 *  tunnel, so the gateway can verify capability tokens offline across restarts.
 *  H-2: the record is pinned on first sight; a LATER push that changes the key is
 *  rejected unless it carries a valid root proof (see resolveSigningKeyPin). */
export class FileSigningKeyStore {
  constructor(private readonly keyPath: string) {}

  /** The pinned key material (base64url), or null when none is pinned. Reads both
   *  the JSON record and a legacy bare-string file (pre-H-2 installs). */
  async load(): Promise<string | null> {
    return (await this.loadRecord())?.key ?? null;
  }

  /** Alias of load() for call sites that specifically want THE PINNED key (the
   *  verifyGrant closure) — clearer intent at the read site. */
  async pinnedKey(): Promise<string | null> {
    return this.load();
  }

  /** The full pinned record, or null when absent. A legacy bare-string file loads
   *  as an unverified pin (`pinnedAt:null, rootVerified:false`). */
  async loadRecord(): Promise<PinnedSigningKey | null> {
    let raw: string;
    try {
      raw = (await readFile(this.keyPath, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (raw.length === 0) return null;
    if (raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw) as Partial<PinnedSigningKey>;
        if (typeof parsed.key === "string" && parsed.key.length > 0) {
          return {
            key: parsed.key,
            pinnedAt: typeof parsed.pinnedAt === "string" ? parsed.pinnedAt : null,
            rootVerified: parsed.rootVerified === true,
            notBefore: typeof parsed.notBefore === "string" ? parsed.notBefore : null,
          };
        }
        return null;
      } catch {
        return null;
      }
    }
    // Legacy bare-string key (pre-H-2): treat as an unverified pin with no floor.
    return { key: raw, pinnedAt: null, rootVerified: false, notBefore: null };
  }

  /** Atomically persist the pinned record as JSON with 0600 perms. */
  async saveRecord(record: PinnedSigningKey): Promise<void> {
    await mkdir(path.dirname(this.keyPath), { recursive: true, mode: 0o700 });
    const tmp = `${this.keyPath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.keyPath);
  }
}

export type KeyPinDecision =
  | { action: "pin"; rootVerified: boolean }
  | { action: "noop" }
  | { action: "replace" }
  | { action: "reject" };

/** Pure pin-floor decision (H-2). `proofValid` is the pre-computed result of
 *  verifying the incoming key's root proof (false when no proof is supplied):
 *   • no pin yet         → PIN it (rootVerified = proofValid; TOFU on upgrade);
 *   • incoming === pin   → NO-OP (a benign re-push of the same key);
 *   • incoming ≠ pin,
 *       proof valid      → REPLACE (an authorized, root-signed rotation);
 *       proof invalid    → REJECT (a silent overwrite — keep the pin). */
export function resolveSigningKeyPin(
  current: PinnedSigningKey | null,
  incomingKey: string,
  proofValid: boolean,
): KeyPinDecision {
  if (!current) return { action: "pin", rootVerified: proofValid };
  if (current.key === incomingKey) return { action: "noop" };
  return proofValid ? { action: "replace" } : { action: "reject" };
}

export interface PersistSigningKeyPinArgs {
  store: Pick<FileSigningKeyStore, "loadRecord" | "saveRecord">;
  orgId: string;
  incomingKey: string;
  keyProof?: KeyProof;
  /** Injectable root-proof verifier (defaults to the baked-anchor verifyKeyProof). */
  verifyProof?: (orgId: string, key: string, proof: KeyProof) => Promise<boolean>;
  now?: () => Date;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/** H-2b · is `incoming` a valid timestamp STRICTLY newer than the stored floor?
 *  A null / absent / unparseable incoming is never newer (fail-closed); a null
 *  stored floor (legacy pin or proofless TOFU) admits any valid incoming proof. */
function isNewerNotBefore(incoming: string | null, stored: string | null): boolean {
  if (!incoming) return false;
  const inMs = Date.parse(incoming);
  if (Number.isNaN(inMs)) return false;
  if (!stored) return true;
  const stMs = Date.parse(stored);
  if (Number.isNaN(stMs)) return true; // corrupt stored floor → don't block a valid forward proof
  return inMs > stMs;
}

/** Apply the H-2 pin-floor to a pushed org signing key and persist the outcome.
 *  Returns the decision taken so callers/tests can assert on it. A rejected key
 *  change leaves the existing pin untouched and logs `signing_key_rotation_rejected`.
 *
 *  H-2b · a key CHANGE is accepted only when its root proof is valid AND its
 *  authenticated `notBefore` is strictly newer than the pinned floor — so a
 *  replayed OLDER root proof (a compromised hub / MITM) can't roll the pin back to
 *  a prior key. A same-key re-push stays a no-op; a genuine forward rotation wins. */
export async function persistSigningKeyPin(args: PersistSigningKeyPinArgs): Promise<KeyPinDecision["action"]> {
  const current = await args.store.loadRecord();
  const verify = args.verifyProof ?? verifyKeyProof;
  const proofValid = args.keyProof ? await verify(args.orgId, args.incomingKey, args.keyProof) : false;
  // Only a VALID proof's notBefore is trustworthy (it is bound into the signed
  // message); an absent/invalid proof carries no floor.
  const incomingNotBefore = proofValid && args.keyProof ? args.keyProof.notBefore : null;
  const decision = resolveSigningKeyPin(current, args.incomingKey, proofValid);
  const now = args.now ?? (() => new Date());

  // Monotonic rollback guard: downgrade an otherwise-authorized REPLACE to REJECT
  // when the incoming proof's notBefore is not strictly newer than the pinned one.
  if (decision.action === "replace" && !isNewerNotBefore(incomingNotBefore, current?.notBefore ?? null)) {
    args.log?.("signing_key_rotation_rejected", { orgId: args.orgId, reason: "stale_not_before" });
    return "reject";
  }

  switch (decision.action) {
    case "pin":
      await args.store.saveRecord({
        key: args.incomingKey,
        pinnedAt: now().toISOString(),
        rootVerified: decision.rootVerified,
        notBefore: incomingNotBefore,
      });
      break;
    case "replace":
      await args.store.saveRecord({
        key: args.incomingKey,
        pinnedAt: now().toISOString(),
        rootVerified: true,
        notBefore: incomingNotBefore,
      });
      break;
    case "noop":
      break;
    case "reject":
      args.log?.("signing_key_rotation_rejected", { orgId: args.orgId });
      break;
  }
  return decision.action;
}
