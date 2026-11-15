// Small pieces of the second step's screens, kept apart from React so they are
// tested on their own.

import { encodeQr, type QrMatrix } from "../qr";

/**
 * The QR code of an otpauth:// address, or null when it cannot be drawn. The
 * console never makes an address longer than a code holds (OTPAUTH_MAX_BYTES
 * in src/ui/totp.ts); should one come, the encoder's refusal stays here, and
 * the page shows the key as text.
 */
export function qrOf(uri: string): QrMatrix | null {
  try {
    return encodeQr(uri);
  } catch {
    return null;
  }
}

/** How long to wait, in whole minutes and never less than one, as a sentence. */
export function waitSentence(waitMs: number): string {
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
  return `Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}
