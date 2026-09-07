// M-9c · a whole-object canonical read materializes the full session transcript
// in memory (base64 over the tunnel, or parsed locally). Cap it so one
// pathological session can't OOM the fortress; a read above the cap fails-fast
// with a typed reason the caller maps to a user-facing "session too large".
// Override via FORTRESS_MAX_CANONICAL_BYTES.

// 128 MiB, chosen from the corpus rather than from a round number. At 64 MiB the
// count sweep could not judge TWELVE sessions, and byte accounting could not judge
// two of them either (75.7 MiB and 65.5 MiB overshoot their claim, so only a RECORD
// count can settle them). 128 MiB brings 10 of the 12 inside the oracle, including
// both of those, and including two that hold real gaps (117 MiB and 122 MiB).
// Production repairs have already read and parsed 101.7 MB, 108.7 MB, 98.7 MB and
// 93.8 MB canonicals with no OOM, so this is ~1.2x the largest read the process has
// demonstrably survived — not a leap.
//
// The two that remain outside (155 MiB and 453 MiB) stay unjudgeable FOR
// COMPLETENESS BY DESIGN and are reported as deepVerifyFloor, because a metric that
// cannot converge must say so rather than let a falling backlog imply completeness.
// Lifting THIS ceiling — the per-rotation deep-verify oracle — needs a streaming
// record counter, not a bigger buffer: at 453 MB the read holds the Buffer and its
// utf8 string at once and then parses, which measures ~8x the object.
//
// REPAIR is a SEPARATE, rare, single-flight path and is bounded differently:
// `maxRepairBytes` below is raised to 1 GiB so the guarantor can HEAL these very
// sizes into an index (an unindexed 453 MB orphan is no longer permanently
// oversizedUnindexed) — worth one ~8x spike because it runs alone. The frequent
// oracle here stays at 128 MiB precisely so it never pays that spike. The two caps
// are independent by design; see the RAM note on maxRepairBytes.
const DEFAULT_MAX_CANONICAL_BYTES = 128 * 1024 * 1024; // 128 MiB

export function maxCanonicalBytes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.FORTRESS_MAX_CANONICAL_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_CANONICAL_BYTES;
}

/** The bound on a REPAIR's whole-canonical read, deliberately looser than the
 *  detection cap — this is what lets the guarantor HEAL an oversized session
 *  instead of leaving it permanently `oversizedUnindexed` (LETAIR: raise the cap).
 *
 *  The two workloads are not the same shape. Detection (`maxCanonicalBytes`) runs
 *  on every rotation and must stay cheap; a repair is rare and worth a spike. A
 *  whole-canonical repair holds the Buffer + its utf8 string and then parses —
 *  measured at ~8× the object end to end.
 *
 *  RAM REQUIREMENT (why this is a knob with a documented cost, not a constant):
 *  the guarantor runs repairs SINGLE-FLIGHT and serially within a pass (see
 *  guarantor.ts — one `inFlight` pass at a time, orphans repaired one by one), so
 *  at most ONE large repair read is ever in flight. Peak ≈ **8 × this cap, once**.
 *  At the 1 GiB default that is ~8 GiB; budget the fortress at **≥ ~16 GiB** (repair
 *  peak + embedded Postgres + concurrent live ingest + headroom). The reference
 *  fortress runs **24 GiB** (measured; ~0.5 GiB idle), so 1 GiB is comfortable and
 *  finally heals the 155/304/453 MB sessions the old 128 MiB bound refused. A
 *  memory-CONSTRAINED self-hosted fortress MUST lower FORTRESS_MAX_REPAIR_BYTES to
 *  ≈ (its spare RAM ÷ 8); detection stays at 128 MiB regardless, so live ingest is
 *  never exposed to the larger spike.
 *
 *  Override with FORTRESS_MAX_REPAIR_BYTES.
 */
const DEFAULT_MAX_REPAIR_BYTES = 1024 * 1024 * 1024; // 1 GiB → ~8 GiB peak (see RAM note)

export function maxRepairBytes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.FORTRESS_MAX_REPAIR_BYTES);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  // Never LOWER than the detection cap: repair is the LOOSER bound (it reads a
  // canonical detection can only stat), so if an operator raises
  // FORTRESS_MAX_CANONICAL_BYTES above the 1 GiB floor, repair follows it up —
  // preserving the invariant the old `return maxCanonicalBytes(env)` guaranteed.
  return Math.max(DEFAULT_MAX_REPAIR_BYTES, maxCanonicalBytes(env));
}

// A vault-RPC read RESULT rides ONE tunnel frame as base64 (+ a JSON envelope),
// so it must stay under the peer's frame cap (FORTRESS_MAX_FRAME_BYTES / the hub's
// WebSocket maxPayload) — otherwise the WS layer rejects the message (close 1009)
// and tears down the whole tunnel. Bound the RAW object so base64 (×4/3) + envelope
// fits with headroom, failing fast with a typed reason instead of killing the
// socket. The LOCAL read path (read-events) keeps the larger maxCanonicalBytes
// because it never crosses the tunnel.
const DEFAULT_MAX_FRAME_BYTES = 32 * 1024 * 1024; // keep in sync with cloud/connection.ts

export function maxTunnelResultBytes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.FORTRESS_MAX_FRAME_BYTES);
  const frame = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_FRAME_BYTES;
  return Math.floor(frame * 0.7); // reserve ~30% for base64 expansion + JSON envelope
}

// A staging PUT signature is honoured by the bucket directly, so the quiesce
// barrier before a storage swap has to wait every outstanding one out. A caller
// draining for a swap may therefore cut new signatures SHORT; it may never
// lengthen them past the default, or the barrier would never converge.
export const STAGING_PUT_TTL_S = 15 * 60;

export function clampStagingTtl(requested: number | undefined): number {
  return typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? Math.min(Math.trunc(requested), STAGING_PUT_TTL_S)
    : STAGING_PUT_TTL_S;
}
