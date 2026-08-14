// Validation for hx.console_commands rows.
//
// The controlling rule is that a command row NEVER carries a secret. A row is
// readable by every principal with SELECT on the table, it is durable, and it
// outlives the operation — so a rotation's new credential travels as a 0600
// file plus a single-use reference id, and the validator refuses anything that
// even looks like the secret itself.

import { isConsoleCommandKind, type ConsoleCommandKind } from "../host/postgres/console-plane";

/** Credential reference ids: 32 lowercase hex characters. The shape is the
 *  first half of the traversal defence — no separator, no dot, no absolute
 *  path can be expressed in it — and the realpath check in the store is the
 *  second. */
export const CREDENTIAL_REF_PATTERN = /^[0-9a-f]{32}$/;

export function isCredentialRef(value: unknown): value is string {
  return typeof value === "string" && CREDENTIAL_REF_PATTERN.test(value);
}

/** Parameter names that would be carrying a secret whatever their value is. */
const SECRET_KEY_PATTERN =
  /(pass(word|phrase)?|secret|token|credential|private[_-]?key|api[_-]?key|access[_-]?key|session[_-]?token|bearer|authorization)/i;

/** Value shapes that are secrets regardless of the key they arrived under: PEM
 *  blocks, AWS access key ids, GCP service-account JSON, and long opaque
 *  high-entropy strings. Deliberately over-broad — a rejected legitimate
 *  parameter is a validation error the operator sees, a leaked one is not. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bA(?:KIA|SIA|ROA|IDA)[0-9A-Z]{12,}\b/,
  /"type"\s*:\s*"service_account"/,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
];

/** A long, dense, non-word string — the shape of a raw key or bearer token. */
function looksHighEntropy(value: string): boolean {
  if (value.length < 40) return false;
  if (/\s/.test(value)) return false;
  return /^[A-Za-z0-9+/=_-]+$/.test(value);
}

export type ParamValue = string | number | boolean | null | readonly string[];
export type CommandParams = Record<string, ParamValue>;

export type ParamCheck =
  | { ok: true; kind: ConsoleCommandKind; params: CommandParams }
  | { ok: false; reason: string };

interface KindSpec {
  required: readonly string[];
  optional: readonly string[];
}

/** Per-kind parameter surface. Every kind in the allowlist appears here, so a
 *  new kind cannot be added without stating what it accepts (the Record type is
 *  exhaustive over ConsoleCommandKind). */
const KIND_SPECS: Record<ConsoleCommandKind, KindSpec> = {
  update_apply: { required: [], optional: ["version"] },
  // The new credential travels as a 0600 file, and its reference travels in the
  // row's own credential_ref COLUMN — which is where the daemon reads it. It is
  // not a parameter: named as one it was written where nothing looks, and the
  // executor refused every rotation for want of a reference the console thought
  // it had sent.
  rotate_credentials: { required: [], optional: [] },
  run_migration: { required: ["phase"], optional: ["target"] },
  run_checkup: { required: [], optional: [] },
  self_test: { required: [], optional: [] },
  run_audit: { required: [], optional: ["scope"] },
  witness_toggle: { required: ["enabled"], optional: [] },
  acknowledge_finding: { required: ["org", "sessionId"], optional: ["reason"] },
};

/** The three phases a storage migration command drives. */
export const MIGRATION_PHASES = ["arm", "swap", "resume"] as const;

function isParamValue(value: unknown): value is ParamValue {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(value as number);
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function secretShaped(value: ParamValue): boolean {
  const strings = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return strings.some(
    (s) => SECRET_VALUE_PATTERNS.some((p) => p.test(s)) || looksHighEntropy(s),
  );
}

/** Validate one command row's kind + params. Rejects unknown kinds, unknown or
 *  missing parameters, non-scalar values, and anything secret-shaped. */
export function validateCommandParams(kind: unknown, rawParams: unknown): ParamCheck {
  if (!isConsoleCommandKind(kind)) {
    return { ok: false, reason: `unknown command kind: ${String(kind)}` };
  }
  if (rawParams === null || typeof rawParams !== "object" || Array.isArray(rawParams)) {
    return { ok: false, reason: "params must be an object" };
  }
  const spec = KIND_SPECS[kind];
  const allowed = new Set([...spec.required, ...spec.optional]);
  const params: CommandParams = {};
  for (const [key, value] of Object.entries(rawParams as Record<string, unknown>)) {
    if (!allowed.has(key)) return { ok: false, reason: `unexpected parameter for ${kind}: ${key}` };
    if (SECRET_KEY_PATTERN.test(key)) {
      return { ok: false, reason: `parameter ${key} names a secret; pass a credential reference instead` };
    }
    if (!isParamValue(value)) return { ok: false, reason: `parameter ${key} must be a scalar or string array` };
    if (secretShaped(value)) {
      return { ok: false, reason: `parameter ${key} looks like a secret; pass a credential reference instead` };
    }
    params[key] = value;
  }
  for (const key of spec.required) {
    if (!(key in params)) return { ok: false, reason: `${kind} requires parameter ${key}` };
  }

  if (kind === "run_migration") {
    const phase = params.phase;
    if (typeof phase !== "string" || !(MIGRATION_PHASES as readonly string[]).includes(phase)) {
      return { ok: false, reason: `run_migration phase must be one of ${MIGRATION_PHASES.join(", ")}` };
    }
  }
  if (kind === "witness_toggle" && typeof params.enabled !== "boolean") {
    return { ok: false, reason: "witness_toggle requires a boolean enabled" };
  }
  if (kind === "acknowledge_finding") {
    for (const key of ["org", "sessionId"]) {
      if (typeof params[key] !== "string" || (params[key] as string).length === 0) {
        return { ok: false, reason: `acknowledge_finding requires a non-empty ${key}` };
      }
    }
  }
  return { ok: true, kind, params };
}
