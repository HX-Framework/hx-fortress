// A3 · per-turn secret scrub, applied to user/assistant turn text BEFORE it is
// hashed + sent to OpenAI. Conversational turns can still contain pasted code,
// tokens, or credentials, and embedding is third-party egress (every hosted
// tier, not just sovereign). This is a focused redactor for the high-confidence
// secret shapes — it never blocks the embed, only sanitizes its input. The
// content_hash is taken over the SCRUBBED text so reuse stays consistent.

const REDACTED = "[REDACTED]";

// Each pattern targets a high-signal credential shape; ordered most-specific
// first. Kept deliberately conservative to avoid shredding normal prose.
const PATTERNS: RegExp[] = [
  // PEM private key blocks (multi-line).
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  // JWTs (header.payload.signature).
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // OpenAI / Anthropic style keys.
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  // GitHub tokens.
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  // Slack tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // AWS access key ids.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Authorization: Bearer <token>.
  /\bBearer\s+[A-Za-z0-9._-]{20,}/gi,
  // key=value assignments for sensitive-looking keys (json or shell style).
  /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?[A-Za-z0-9._\-+/=]{8,}["']?/gi,
  // Stripe underscore-form keys (secret / restricted / publishable, live|test).
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  // Stripe webhook signing secret, and GitHub fine-grained PATs.
  /\bwhsec_[A-Za-z0-9]{10,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Database connection strings that embed credentials (scheme://user:pass@host).
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s"'<>]+/gi,
  // Email address (PII). Every quantifier is BOUNDED so matching stays linear —
  // the unbounded `(?:\.[label]+)+` form was O(n²) and froze the single-thread Bun
  // loop on an adversarial `.a.a.a…` input (H-7 ReDoS). RFC-max local part {1,64},
  // each DNS label {1,63}, and a capped run of labels {1,10}.
  /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,10}\b/g,
  // US Social Security number.
  /\b\d{3}-\d{2}-\d{4}\b/g,
  // Phone number (loose international / US, separator-tolerant).
  /\b\+?\d{1,3}[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
];

// AWS 40-char secret access key — exactly 40 base64-ish chars, boundaried so a
// longer blob doesn't partially match. Applied via a callback (below) rather than
// inline in PATTERNS so it can SPARE an all-lowercase-hex run: that shape is a git
// commit SHA (coding sessions are full of them), never an AWS secret (AWS secret
// keys are base64 of random bytes and are effectively never all-hex). A real
// secret carries uppercase / `+` / `/` characters, so it still redacts.
const AWS_SECRET_40 = /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/g;
/** A 40-char run that is ALL lowercase hex — a git SHA, not an AWS secret. */
const GIT_SHA_40 = /^[0-9a-f]{40}$/;

// Candidate credit-card runs: 13–19 digits, each optionally followed by a single
// space or hyphen. Only runs whose digits pass the Luhn checksum are redacted, so
// plain long numbers (ids, counts) survive. Bounded reps ⇒ linear-time, no ReDoS.
const CARD = /\b(?:\d[ -]?){13,19}\b/g;

/** Luhn (mod-10) checksum over a run of digit characters. */
function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Redact high-confidence secret + PII shapes from one turn's text. Returns the
 *  text unchanged when nothing matches (the common case for conversational
 *  turns). Runs the Luhn-checked card pass FIRST so a card's digit run is gone
 *  before the numeric patterns (SSN/phone) see it. */
export function scrubSecrets(text: string): string {
  let out = text.replace(CARD, (match) =>
    luhnValid(match.replace(/[^\d]/g, "")) ? REDACTED : match,
  );
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  // AWS 40-char secret pass LAST (was the final PATTERNS entry) — redact a
  // boundaried base64-ish run but spare an all-lowercase-hex git SHA.
  out = out.replace(AWS_SECRET_40, (m) => (GIT_SHA_40.test(m) ? m : REDACTED));
  return out;
}
