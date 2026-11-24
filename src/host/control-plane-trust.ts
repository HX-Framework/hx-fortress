// What the daemon does about the key of its control plane.
//
// No key of any control plane is compiled into the program
// (./trust/control-plane-keys.ts says how an HX Fortress learns one). This file is
// the two moments the daemon acts on it:
//
//   - At its FIRST enrollment it pins the key the control plane publishes,
//     unless its environment names one or a person pinned one ahead. Nobody
//     compared a fingerprint, so the fingerprint is written to the log and to
//     the audit trail. The connection decides that an enrollment is a first
//     one (src/cloud/connection.ts), and this is never called at any other
//     moment.
//   - When the control plane presents a different key for the organization,
//     the proof that comes with it is checked against the keys trusted for the
//     control plane the connection is open to.
//
// An HX Fortress that enrolled before this program stopped carrying a control
// plane's key has nothing pinned, and nothing is pinned for it on its own: an
// update of the program must not make a host start trusting a key, and neither
// must anything a control plane sends later. Its organization key stays pinned
// and its grants are checked as before. It refuses a CHANGE of that key until
// a person runs `hx-fortress control-plane pin`.

import { AUDIT_ACTIONS } from "../console/audit-actions";
import type { KeyProof } from "../protocol";
import { controlPlaneAddress } from "../setup/control-plane";
import {
  ControlPlaneKeyStore,
  keyFingerprint,
  pinAtFirstEnrollment,
  type ControlPlaneKeyPaths,
} from "./trust/control-plane-keys";
import { verifyKeyProof } from "./trust/signing-keys";

export interface ControlPlaneTrustDeps {
  paths: ControlPlaneKeyPaths;
  env: Record<string, string | undefined>;
  log: {
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
  };
  /** One record in the audit trail. It must not throw. */
  audit: (
    action: string,
    fields: { params: Record<string, string>; outcome: string },
  ) => Promise<unknown>;
}

export interface ControlPlaneTrust {
  /** Called once, after the control plane at `address` has accepted a FIRST
   *  enrollment. It never throws. */
  atFirstEnrollment(address: string): Promise<void>;
  /** Whether `proof` binds `key` to `orgId` under a key trusted for the
   *  control plane at `address`. False with no trusted key. It never throws. */
  verifyProof(address: string, orgId: string, key: string, proof: KeyProof): Promise<boolean>;
}

export function createControlPlaneTrust(deps: ControlPlaneTrustDeps): ControlPlaneTrust {
  const store = new ControlPlaneKeyStore(deps.paths, deps.env);
  return {
    async atFirstEnrollment(address) {
      const result = await pinAtFirstEnrollment(store, address);
      if (result.outcome === "pinned") {
        const params = {
          controlPlane: controlPlaneAddress(result.pin.address),
          ids: result.pin.keys.map((key) => key.id).join(", "),
          fingerprints: result.pin.keys.map((key) => keyFingerprint(key)).join(", "),
          how: result.pin.how,
        };
        deps.log.info(
          "pinned the key the control plane published at the first enrollment; nobody compared its " +
            "fingerprint, and `hx-fortress control-plane` shows it",
          params,
        );
        await deps.audit(AUDIT_ACTIONS.controlPlaneKey, { params, outcome: "pinned" });
      } else if (result.outcome === "not-pinned") {
        deps.log.warn(
          "no key of the control plane was pinned at the first enrollment, so a later change of the " +
            "organization's key will be refused until one is pinned: `hx-fortress control-plane pin`",
          { reason: result.reason },
        );
        await deps.audit(AUDIT_ACTIONS.controlPlaneKey, {
          params: { reason: result.reason },
          outcome: "not_pinned",
        });
      }
      // `unchanged`: this host already decided, and nothing was asked.
    },
    async verifyProof(address, orgId, key, proof) {
      return verifyKeyProof(orgId, key, proof, await store.trusted(address));
    },
  };
}
