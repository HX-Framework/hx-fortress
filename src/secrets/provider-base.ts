// What every provider shares: `has` in terms of `get`, and the one rule for
// turning what a store holds into the value a caller gets.

import {
  MAX_SECRET_BYTES,
  SecretMissing,
  SecretUnavailable,
  type SecretProvider,
  type SecretProviderKind,
} from "./types";

export abstract class SecretProviderBase implements SecretProvider {
  abstract readonly kind: SecretProviderKind;
  abstract get(name: string): Promise<string>;

  async has(name: string): Promise<boolean> {
    try {
      await this.get(name);
      return true;
    } catch (error) {
      if (error instanceof SecretMissing) return false;
      throw error;
    }
  }
}

/** `echo value > file` appends one line ending, and so do most tools that
 *  write a secret to a file, a variable or a vault. Exactly one is removed: a
 *  value that really ends in spaces or blank lines keeps them. */
function withoutFinalNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/**
 * The value a caller gets for what the store holds under `name`.
 *
 * One rule for every provider, so the same secret reads the same from a file,
 * a variable and a vault:
 *
 *   - one final line ending is removed;
 *   - a value that is empty or only white space is a placeholder, and the
 *     secret is missing;
 *   - a value with a NUL character in it is not text, and a value past the
 *     size limit is not a secret. Both are refused, and neither is repeated.
 */
export function secretValueFrom(name: string, stored: string, source: string): string {
  const value = withoutFinalNewline(stored);
  if (value.trim() === "") throw new SecretMissing(name, source);
  if (value.includes("\0")) {
    throw new SecretUnavailable(name, "the value holds a NUL character, so it is not text", { source });
  }
  if (Buffer.byteLength(value) > MAX_SECRET_BYTES) {
    throw new SecretUnavailable(name, `the value is larger than ${MAX_SECRET_BYTES} bytes`, { source });
  }
  return value;
}
