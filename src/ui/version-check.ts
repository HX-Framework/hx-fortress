// Is there a newer fortress release - asked at most occasionally, answered
// honestly, and never allowed to hang a page.
//
// This is the console's only outbound request on a read path, so it carries
// three bounds rather than one. A TIMEOUT, because the update source is reached
// over whatever network the fortress happens to be on and a page that waits on
// it is a page that hangs. A CACHE, because the version panel is polled and an
// origin that answers slowly must not be asked once per poll. And a BUDGET - a
// minimum interval between attempts - because a failing origin would otherwise
// be retried at exactly the poll rate, which is the shape of a small
// distributed attack on somebody else's server.
//
// The answer is a tri-state. "unavailable" is a first-class result, not an
// error: a fortress on a private network legitimately cannot reach the origin,
// and rendering that as "up to date" would be a lie that hides an upgrade.

import { fetchPublishedVersion } from "../update-source";
import { FORTRESS_VERSION } from "./../version";

export const VERSION_CHECK_TIMEOUT_MS = 4_000;
/** How long an answer stays good. */
export const VERSION_CACHE_TTL_MS = 10 * 60_000;
/** How soon a FAILED check may be retried. Shorter than the TTL, so a transient
 *  outage recovers within one panel visit, and long enough that a poll cannot
 *  turn into a retry loop. */
export const VERSION_RETRY_AFTER_MS = 60_000;

export type RemoteVersion =
  | { kind: "available"; version: string; checkedAt: string; cached: boolean }
  | { kind: "unavailable"; reason: string; checkedAt: string; cached: boolean };

interface CacheEntry {
  answer: RemoteVersion;
  at: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<RemoteVersion>>();

export interface VersionCheckOptions {
  now?: () => number;
  timeoutMs?: number;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Ask again even if a cached answer is still fresh. Bounded by the budget. */
  force?: boolean;
}

function ttlFor(answer: RemoteVersion): number {
  return answer.kind === "available" ? VERSION_CACHE_TTL_MS : VERSION_RETRY_AFTER_MS;
}

/**
 * The remote version, cached.
 *
 * Exported for the console alone. The TUI keeps its own path untouched: it runs
 * in a terminal where a slow answer is visible and cancellable, and giving both
 * surfaces one cache would make a console poll decide what a terminal shows.
 */
export async function fetchRemoteFortressVersion(
  downloadBase: string,
  options: VersionCheckOptions = {},
): Promise<RemoteVersion> {
  const now = options.now?.() ?? Date.now();
  const base = downloadBase.replace(/\/+$/, "");
  const entry = cache.get(base);
  if (entry && (!options.force || now - entry.at < VERSION_RETRY_AFTER_MS)) {
    if (now - entry.at < ttlFor(entry.answer)) return { ...entry.answer, cached: true };
  }
  const running = inFlight.get(base);
  if (running) return running;

  const attempt = (async (): Promise<RemoteVersion> => {
    const checkedAt = new Date(now).toISOString();
    try {
      // The one reader of a source's version: it has the deadline and the size
      // limit, and only a plain stable version counts. A prerelease, or an
      // error page served with a 200, is never shown as "the latest version".
      const published = await fetchPublishedVersion(base, {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        timeoutMs: options.timeoutMs ?? VERSION_CHECK_TIMEOUT_MS,
        userAgent: `hx-fortress/${FORTRESS_VERSION}`,
      });
      if (published.state === "version") {
        return { kind: "available", version: published.version, checkedAt, cached: false };
      }
      // A deadline, DNS, TLS, an offline host: one answer for all of them,
      // because the next step is the same, and naming the transport would
      // suggest that HX Fortress is broken when it is only private.
      const reason =
        published.state === "unreachable"
          ? "the update source could not be reached"
          : published.status >= 200 && published.status < 300
            ? "the update source did not answer with a version"
            : `the update source answered ${published.status}`;
      return { kind: "unavailable", reason, checkedAt, cached: false };
    } finally {
      inFlight.delete(base);
    }
  })();

  inFlight.set(base, attempt);
  const answer = await attempt;
  cache.set(base, { answer, at: now });
  return answer;
}

/** Test seam. Nothing in production clears the cache: a console restart does. */
export function resetVersionCache(): void {
  cache.clear();
  inFlight.clear();
}

/** What the panel says. `unavailable` never reads as up-to-date. */
export function versionCopy(local: string, remote: RemoteVersion): string {
  if (remote.kind === "unavailable") {
    return `running ${local}. Latest release: not checked - ${remote.reason}.`;
  }
  if (remote.version === local) return `running ${local}, which is the latest release.`;
  return `running ${local}. Latest release: ${remote.version}.`;
}
