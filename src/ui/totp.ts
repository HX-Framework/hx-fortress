// The code of the second step at sign-in: six digits from an authenticator
// app, as RFC 6238 defines them. HMAC-SHA1 over the number of 30-second steps
// since 1970, cut to six digits the way RFC 4226 cuts an HOTP value.
//
// node:crypto only, and nothing here touches a file or the network: the
// caller decides which step was last accepted for an account and writes it
// down. What this module promises is narrower and easy to test:
//
//   • a code is accepted for the current step and for one step either side,
//     and for no other;
//   • a step at or before the last accepted one is refused, so a code that
//     was used once is refused for the rest of its life;
//   • the typed code is compared in constant time against every candidate,
//     and every candidate is computed whatever the typed code is;
//   • anything unexpected while checking is a refusal, never a pass.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Digits in a code. */
export const CODE_DIGITS = 6;
/** Seconds in one step. */
export const STEP_SECONDS = 30;
/** Steps on either side of the current one whose code is accepted too: a
 *  phone's clock drifts, and a person takes a few seconds to type. */
export const STEP_WINDOW = 1;
/** A new secret's length. 160 bits, the size RFC 4226 recommends. */
export const SECRET_BYTES = 20;
/** The shortest key this build will check a code against. A stored secret
 *  shorter than RFC 4226's floor is damaged, and a damaged secret refuses. */
const MIN_KEY_BYTES = 16;

/** The name an authenticator app shows above the code. */
export const TOTP_ISSUER = "HX Fortress";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, upper case, without the `=` padding authenticator apps
 *  do not want. Twenty bytes are exactly 32 characters, so a secret has none
 *  to drop. */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** The bytes behind a base32 string, or null for one that is not base32.
 *  Trailing `=` padding is allowed; any other character refuses. */
export function base32Decode(text: string): Buffer | null {
  const body = text.replace(/=+$/, "");
  if (!/^[A-Z2-7]*$/.test(body)) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of body) {
    buffer = ((buffer << 5) | BASE32_ALPHABET.indexOf(char)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226: the code for one counter value. */
export function hotp(key: Uint8Array, counter: number): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new RangeError("a counter is a whole number from 0");
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(message).digest();
  // Dynamic truncation: four bytes from the offset the last nibble names,
  // read big-endian, with the top bit cleared.
  const offset = mac.readUInt8(mac.length - 1) & 0x0f;
  const value = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, "0");
}

/** The step a moment falls in. */
export function stepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/** A new secret, in base32. */
export function newSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** Whether a string is shaped like a code at all. A code is six ASCII digits;
 *  spaces a person typed between the groups are dropped by the caller. */
export function isCodeShape(code: string): boolean {
  return /^[0-9]{6}$/.test(code);
}

export type CodeCheck = { ok: true; step: number } | { ok: false };

/**
 * Check a typed code against a secret.
 *
 * Accepted: a code for the current step or one step either side, when that
 * step is later than `lastStep`. The accepted step is returned so the caller
 * can write it down; when the code matches more than one step, the latest is
 * the one returned, so the most steps are spent.
 */
export function checkCode(args: {
  /** base32 */
  secret: string;
  code: string;
  nowMs: number;
  /** The last step accepted for this account, or null when none has been. */
  lastStep: number | null;
}): CodeCheck {
  try {
    if (!isCodeShape(args.code)) return { ok: false };
    const key = base32Decode(args.secret);
    if (!key || key.length < MIN_KEY_BYTES) return { ok: false };
    const typed = Buffer.from(args.code, "utf8");
    const floor = args.lastStep ?? -1;
    const current = stepAt(args.nowMs);
    let accepted = -1;
    for (let step = current - STEP_WINDOW; step <= current + STEP_WINDOW; step += 1) {
      if (step < 0) continue;
      // Every candidate is computed and compared; only then is it judged.
      const same = timingSafeEqual(Buffer.from(hotp(key, step), "utf8"), typed);
      if (same && step > floor && step > accepted) accepted = step;
    }
    return accepted >= 0 ? { ok: true, step: accepted } : { ok: false };
  } catch {
    // A security boundary fails closed: an error while checking is a refusal.
    return { ok: false };
  }
}

/**
 * The longest otpauth:// address, in bytes, that the console's QR code holds:
 * version 10 at error correction level M, in byte mode (see ui/src/qr.ts,
 * whose test holds the two numbers together).
 */
export const OTPAUTH_MAX_BYTES = 213;

/** What ends an account name that was shortened to fit. */
const SHORTENED = "…";

/**
 * The account part of the label, percent-encoded, in at most `room` bytes.
 *
 * The label is only what the app shows under the issuer; the key and the
 * issuer decide the codes. A login too long for the room keeps its beginning
 * and ends in "…". It is cut between characters, never inside the
 * percent-encoding of one.
 */
export function accountLabel(login: string, room: number): string {
  const whole = encodeURIComponent(login);
  if (whole.length <= room) return whole;
  const mark = encodeURIComponent(SHORTENED);
  // A room too small even for the mark holds no name at all.
  if (mark.length > room) return "";
  let kept = "";
  for (const char of login) {
    const next = kept + encodeURIComponent(char);
    if (next.length + mark.length > room) break;
    kept = next;
  }
  return `${kept}${mark}`;
}

/**
 * The address an authenticator app reads from the QR code. The login is the
 * account name the app shows under the issuer. A login is lower-case letters,
 * digits, `.`, `_` and `-`, or a lower-case email address, which adds `@` and
 * `+`. It is percent-encoded: `@` is sent as `%40` and `+` as `%2B`, so no app
 * reads the `+` as a space or the `@` as the start of a host, and the address
 * can never be taken apart differently.
 *
 * The whole address always fits in OTPAUTH_MAX_BYTES: a login longer than the
 * room left by the key and the issuer is shortened in the label alone.
 */
export function otpauthUri(login: string, secret: string): string {
  const issuer = encodeURIComponent(TOTP_ISSUER);
  const head = `otpauth://totp/${issuer}:`;
  const tail = `?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${CODE_DIGITS}&period=${STEP_SECONDS}`;
  return `${head}${accountLabel(login, OTPAUTH_MAX_BYTES - head.length - tail.length)}${tail}`;
}
