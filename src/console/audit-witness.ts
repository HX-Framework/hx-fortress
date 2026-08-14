// The audit engine's witness, as it actually reaches let.ai.
//
// The direction is fixed by the protocol: the FORTRESS asks and the hub answers
// (`fortressQuery` rides the fortress→hub union), because `letaiCopy` is a fact
// about the hub's own session rows that this box cannot see.
//
// Two properties this adapter exists to hold:
//
//   AN UNANSWERED QUESTION IS NOT A NEGATIVE ANSWER. Every failure the transport
//   has — a timeout, a closed socket, a saturated registry, and above all a hub
//   too old to recognise the frame, which answers nothing at all — collapses to
//   `null`. The engine renders that as "the witness was not asked", by name. A
//   `false` in its place would print "let.ai reports no copy" about a question
//   nobody ever put.
//
//   A PARTIAL ANSWER IS ALSO NOT AN ANSWER. Ids go out in batches, and a batch
//   that fails after earlier ones succeeded abandons the whole run's witness
//   rather than returning what came back: the sessions in the failed batch would
//   otherwise be absent from `copies` for the same reason a session with no copy
//   is, and the engine cannot tell those two apart.
//
// Batches are serial, one in flight, because the ids are this organization's
// data and the budget that bounds an audit of a large fortress is the same
// budget that keeps it from becoming an outage of it.
//
//   A BUDGET REFUSAL IS A WAIT, NOT A FAILURE. That same budget makes a sweep of
//   a large fortress arrive as more questions than any burst holds, so the hub
//   answers `retryAfterMs` and this waits it out rather than collapsing the run.
//   Without it the two properties above turn into a third, unintended one: above
//   roughly a burst's worth of batches the witness is never obtainable at all,
//   and the operator reads a rate limit as a broken hub.

import type { WitnessAnswer } from "./audit-engine";
import { FORTRESS_QUERY_TIMEOUT_MS } from "../cloud/fortress-query";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
import { WITNESS_MAX_IDS, type FortressQueryPayload, type FortressQueryResultPayload } from "../protocol";

export interface WitnessClientDeps {
  /** The tunnel's bounded ask. Absent on a transport that cannot ask at all,
   *  which is reported as unavailable rather than as a clean answer. */
  request?: (query: FortressQueryPayload, timeoutMs?: number) => Promise<FortressQueryResultPayload>;
  /** Called once per run that could not be answered, with the reason as the
   *  transport named it. */
  onUnavailable?: (reason: string) => void;
  batchSize?: number;
  /** Test seam. Real runs wait on a timer; a test hands back a resolved promise
   *  so it can prove the retry happens without spending the wait. */
  wait?: (ms: number) => Promise<void>;
  /** Test seam for the wall-clock ceiling. */
  now?: () => number;
}

// Sizing the allowance has now gone wrong twice in opposite directions, so state
// the rule rather than a number: ONE WAIT PER BATCH IS WHAT SUCCESS COSTS.
//
// Once the hub's burst is spent, an honest hub refuses each remaining batch once
// and names a wait under a second. A flat count therefore makes the witness
// unobtainable above some session count — first at ~5,000 when the count was
// per-batch and too small, then at ~42,000 when it was per-run and flat. The
// budget scales with the sweep, and TIME is the ceiling that bounds a hostile
// peer, because time is the thing that actually costs anything.

/** Slack over one-wait-per-batch, for a hub whose burst is smaller than assumed. */
const EXTRA_WAITS = 12;
/** No single wait longer than this, whatever the hub asks for. An honest hub
 *  cannot exceed one second — its refusal is `ceil((1 - refilled) / refillPerMs)`
 *  with refilled in [0,1) — so anything larger is a broken or hostile peer, and
 *  D9 puts a compromised let.ai in scope. */
const MAX_WAIT_MS = 5_000;
/** Room for one honest wait per batch, plus slack. */
const WAIT_MS_PER_BATCH = 2_000;
/** The absolute ceiling, whatever the sweep. The whole console mutation plane
 *  runs behind this call — one poll pass at a time, executors serial — so an
 *  audit that parks parks everything, and it has to come back.
 *
 *  Chosen against the sweep it has to afford, not picked round: one honest wait
 *  per batch costs ~1s, so this covers roughly 240 batches — 120,000 ids at the
 *  protocol's cap. A fortress past that reports the witness as unavailable and
 *  names why, rather than quietly answering about a subset. */
const MAX_TOTAL_WAIT_MS = 240_000;

/**
 * Ask let.ai about a batch of eligible session ids.
 *
 * Returns null — never a partial or empty answer — the moment any batch cannot
 * be answered.
 */
export function createWitnessClient(
  deps: WitnessClientDeps,
): (ids: readonly string[]) => Promise<WitnessAnswer | null> {
  // The cap comes from the protocol package, not from a local 500. It is part of
  // the contract — a request carrying more MUST be refused rather than shortened
  // — and two repositories that release separately, each holding its own copy of
  // the number, are one release apart from a question the asking side believes
  // is whole and the answering side silently truncates.
  // CLAMPED to the protocol's cap, not merely defaulted to it. The contract says
  // a question carrying more than this MUST be answered with an error and MUST
  // NOT be truncated, so a caller that asked for a larger batch would be asking
  // the hub to break its own rule — and the seam that decides it is here.
  const batchSize = Math.max(1, Math.min(deps.batchSize ?? WITNESS_MAX_IDS, WITNESS_MAX_IDS));
  return async (ids) => {
    const ask = deps.request;
    if (!ask) {
      deps.onUnavailable?.("this fortress has no cloud transport to ask");
      return null;
    }
    // No ids is a complete answer about nothing: the run asked everything it was
    // allowed to ask, and every eligible session is accounted for.
    if (ids.length === 0) {
      return { copies: new Set<string>(), known: new Set<string>(), routedHere: new Set<string>() };
    }

    const copies = new Set<string>();
    const known = new Set<string>();
    const routedHere = new Set<string>();
    // One budget for the whole sweep, sized to it rather than to a constant.
    const batches = Math.ceil(ids.length / batchSize);
    let waitsLeft = batches + EXTRA_WAITS;
    const totalWaitCap = Math.min(batches * WAIT_MS_PER_BATCH + 10_000, MAX_TOTAL_WAIT_MS);
    // WALL-CLOCK, not accumulated sleep. A hub that answers slowly without ever
    // refusing spends no waits at all, so a sleep-only ceiling does not bound it
    // — and `run_audit` executes inside the command plane's single serial pass,
    // so a sweep that runs long holds every other command behind it until they
    // age out on their request deadline.
    const startedAt = deps.now?.() ?? Date.now();
    const elapsed = (): number => (deps.now?.() ?? Date.now()) - startedAt;
    let waitedMs = 0;
    for (let from = 0; from < ids.length; from += batchSize) {
      const batch = ids.slice(from, from + batchSize);
      if (elapsed() > totalWaitCap) {
        deps.onUnavailable?.(
          `the sweep of ${batches} batches did not finish within ${Math.round(totalWaitCap / 1000)}s`,
        );
        return null;
      }
      let result: FortressQueryResultPayload | null = null;
      while (result === null) {
        // Inside the loop, not only between batches. A hub that answers slowly
        // and THEN refuses spends its time in `ask`, which `waitedMs` does not
        // count — so a single batch could sit here for many times the stated
        // ceiling while the console mutation plane waited behind it.
        const remaining = totalWaitCap - elapsed();
        if (remaining <= 0) {
          deps.onUnavailable?.(
            `the sweep of ${batches} batches did not finish within ${Math.round(totalWaitCap / 1000)}s`,
          );
          return null;
        }
        try {
          // The remaining budget, but never MORE than the transport's own
          // ceiling. Passing the whole run budget as one question's timeout
          // would let a silent hub hold a single request for minutes — and the
          // extra wait buys nothing, because a timeout carries no retryAfterMs
          // and the run collapses the moment it returns.
          result = await ask(
            { kind: "residencyWitness", sessionIds: [...batch] },
            Math.min(remaining, FORTRESS_QUERY_TIMEOUT_MS),
          );
        } catch (err) {
          // Only a refusal that names its wait is worth sitting out, and only
          // while the RUN still has budget. Everything else — a timeout, a
          // closed socket, an old hub — is the unanswered question this adapter
          // reports as such.
          const retryAfterMs = (err as { retryAfterMs?: unknown })?.retryAfterMs;
          const wait = typeof retryAfterMs === "number" && retryAfterMs > 0 ? Math.min(retryAfterMs, MAX_WAIT_MS) : 0;
          if (wait === 0 || waitsLeft <= 0 || waitedMs + wait > totalWaitCap) {
            // Name the budget when it is the budget. "unavailable" alone reads
            // as a broken hub, and an operator would go looking for one.
            const spent = waitsLeft <= 0 || waitedMs + wait > totalWaitCap;
            deps.onUnavailable?.(
              spent
                ? `the hub's rate limit did not allow a full sweep of ${batches} batches within ${Math.round(totalWaitCap / 1000)}s`
                : err instanceof Error
                  ? err.message
                  : String(err),
            );
            return null;
          }
          waitsLeft -= 1;
          waitedMs += wait;
          await (deps.wait ?? sleep)(wait);
        }
      }
      // A hub that answered a DIFFERENT question has not answered this one. The
      // shape is checked rather than trusted because the alternative is reading
      // an absent array as "no copies".
      const answers = result.kind === "residencyWitness" ? result.residencyWitness : undefined;
      if (!Array.isArray(answers)) {
        deps.onUnavailable?.("the hub answered without a residency witness");
        return null;
      }
      for (const answer of answers) {
        if (answer.letaiCopy) copies.add(answer.sessionId);
        if (answer.anyDestinationRecord) known.add(answer.sessionId);
        // The THIRD boolean, carried rather than collapsed. `not_delivered_here`
        // is keyed on it: "let.ai recorded THIS fortress as a destination" is a
        // narrower claim than "a destination row exists somewhere", and reading
        // the incident off the broader one accused this appliance of losing a
        // session the hub never said it sent here.
        if (answer.hubRoutedHere) routedHere.add(answer.sessionId);
      }
    }
    return { copies, known, routedHere };
  };
}
