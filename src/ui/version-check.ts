// Is there a newer fortress release - asked at most occasionally, answered
// honestly, and never allowed to hang a page.
//
// This is the console's only outbound request on a read path, so it carries
// three bounds rather than one. A TIMEOUT, because the update origin is reached
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

/** Only a plain stable semver is accepted. A prerelease or an HTML error page
 *  served with a 200 must never be rendered as "the latest version". */
const STABLE_SEMVER = /^\d+\.\d+\.\d+$/;

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? VERSION_CHECK_TIMEOUT_MS);
    try {
      const doFetch = options.fetchImpl ?? fetch;
      const res = await doFetch(`${base}/hx-fortress-version`, {
        headers: { "user-agent": `hx-fortress/${FORTRESS_VERSION}` },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!res.ok) {
        return { kind: "unavailable", reason: `update origin answered ${res.status}`, checkedAt, cached: false };
      }
      const raw = (await res.text()).trim();
      if (!STABLE_SEMVER.test(raw)) {
        return { kind: "unavailable", reason: "update origin did not answer with a version", checkedAt, cached: false };
      }
      return { kind: "available", version: raw, checkedAt, cached: false };
    } catch {
      // Timeout, DNS, TLS, an offline host - one answer for all of them, because
      // the operator's next step is the same and naming the transport would only
      // suggest the fortress is broken when it is merely private.
      return { kind: "unavailable", reason: "the update origin could not be reached", checkedAt, cached: false };
    } finally {
      clearTimeout(timer);
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
