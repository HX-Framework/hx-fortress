// Shared, defensive boolean-env parsing for the fortress. One documented truthy
// set — `1` / `true` / `yes` / `on` (case-insensitive, trimmed) — so every
// operator flag (grant-enforce, PG pinning, S3 private-endpoint, re-enroll, …)
// reads the same spellings. Anything else (unset, empty, `0`, `false`, junk)
// is off. Kept local to the Fortress.

/** True only for the truthy spellings `1` / `true` / `yes` / `on`. */
export function parseBooleanEnv(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
