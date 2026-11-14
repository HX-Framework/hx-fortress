// What a module grant commits to: one module, one ask, one set of arguments.
//
// The grant on an ask carries `scopeHash`. The Fortress recomputes it from the
// frame it actually received and compares, so a grant minted for
// `host:audit.read` over one date range cannot be replayed over another, or
// against another ask.
//
// The recipe is the one the read grants already use — base64url(sha256(utf8(
// canonical JSON))) — over a different object. `hashFortressScope` in the
// protocol package cannot be reused as it stands: it reads only a read scope's
// `identities` and `ownerGate`, so for `{ module, ask, args }` it returns the
// same constant every time, which commits to nothing. The canonical form below
// is therefore defined here, and the control plane carries the same few lines.
// The vectors in test/host/ask-scope.test.ts are what keeps the two from
// drifting.

import { createHash } from "node:crypto";

/**
 * JSON with every object's keys in sorted order and no whitespace.
 *
 * Both sides must produce the same bytes for the same value, so anything that
 * is not plain JSON is refused rather than guessed at: a `Date` would serialize
 * as a string on the wire and as `{}` here, and the two hashes would disagree
 * about a grant that is perfectly good.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("not JSON: a number that is not finite");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error("not JSON: not a plain object");
    }
    const record = value as Record<string, unknown>;
    // The default sort compares UTF-16 code units, which is the same order in
    // every JavaScript engine. A key whose value is undefined is left out, as
    // JSON.stringify leaves it out of the frame.
    // Every key below is one of the object's own, from Object.keys: nothing is
    // looked up by a name the caller chose separately from the object itself.
    /* eslint-disable security/detect-object-injection */
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
    /* eslint-enable security/detect-object-injection */
  }
  throw new Error("not JSON");
}

export interface AskScope {
  module: string;
  ask: string;
  args: Record<string, unknown>;
}

/** The `scopeHash` a grant for this ask must carry. */
export function askScopeHash(scope: AskScope): string {
  const canonical = canonicalJson({ module: scope.module, ask: scope.ask, args: scope.args });
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

/** The `sub` a grant for this ask must carry. */
export function askSubject(module: string, ask: string): string {
  return `${module}:${ask}`;
}
