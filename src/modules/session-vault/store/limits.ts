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
// The two that remain outside (155 MiB and 453 MiB) stay permanently unjudgeable BY
// DESIGN and are reported as deepVerifyFloor, because a metric that cannot converge
// must say so rather than let a falling backlog imply completeness. Lifting those
// needs a streaming record counter, not a bigger buffer: at 453 MB the read holds
// the Buffer and its utf8 string at once and then parses, which measures ~8x the
// object.
const DEFAULT_MAX_CANONICAL_BYTES = 128 * 1024 * 1024; // 128 MiB

export function maxCanonicalBytes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.FORTRESS_MAX_CANONICAL_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_CANONICAL_BYTES;
}

/** The bound on a REPAIR's whole-canonical read, deliberately looser than the
 *  detection cap.
 *
 *  The two workloads are not the same shape. Detection runs on every rotation and
 *  must stay cheap; a repair is rare and worth a spike. But it is not worth an
 *  UNBOUNDED spike: the repair path had no gate at all, and a whole-canonical
 *  repair holds the Buffer and its utf8 string simultaneously (2x the object) and
 *  then parses — measured at ~8x the object end to end, inside the live ingest
 *  process.
 *
 *  128 MiB is chosen from evidence, not taste: production repairs have already read
 *  and parsed 101.7 MB, 108.7 MB, 98.7 MB and 93.8 MB canonicals without an OOM,
 *  so anything at or below this has demonstrably worked. The largest object in the
 *  corpus is 453 MB, which the same measurement puts at ~3.6 GiB peak — 4x beyond
 *  anything the process has ever survived. Refusing that one is the whole point.
 *  Override with FORTRESS_MAX_REPAIR_BYTES.
 */
export function maxRepairBytes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.FORTRESS_MAX_REPAIR_BYTES);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  // Deliberately EQUAL to the read cap, not a multiple of it. An earlier revision
  // used 2x on the reasoning that repair is rarer than detection and worth a bigger
  // spike. With the cap at 128 MiB that would license a 256 MiB read — roughly 2 GiB
  // peak, well past anything this process has been shown to survive. One number,
  // held at the evidence line, is the safer shape; FORTRESS_MAX_REPAIR_BYTES is
  // there for an operator who has measured their own headroom.
  return maxCanonicalBytes(env);
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
