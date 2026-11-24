// A fetch for a download: a redirect is followed by hand, and only to https.
//
// The update source is an address the project or the organization named, and
// that address is held to one rule: https, or http to this host itself. A
// redirect leaves the address. The project's releases answer a file's address
// with one, to the host that stores the file, so a redirect has to be
// followed. It is followed here and not by the runtime, so that every hop is
// held to a rule as well:
//
//   - the next address is https, or it has the origin of the one before it
//     (which is what keeps an http address on this host itself working);
//   - it holds no user name and no password;
//   - at most five redirects in a row.
//
// What arrives is not trusted because of where it came from: the checksum
// and, where the release is signed, the signature decide that afterwards.
// This rule is about the request itself. Nothing the far side answers makes
// this host ask another host for anything in clear text.

const MAX_REDIRECTS = 5;
/** The answers that send a request on to another address. Any other answer of
 *  the 300s (a 304, for one) leads nowhere and is the caller's to read. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export class RedirectRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RedirectRefused";
  }
}

/** The address a redirect from `from` to `location` leads to. Throws
 *  RedirectRefused when it is one this host does not follow. */
export function redirectTarget(from: string, location: string | null): string {
  if (!location) throw new RedirectRefused("the answer is a redirect that names no address");
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    throw new RedirectRefused("the answer is a redirect to something that is not an address");
  }
  if (next.username || next.password) {
    throw new RedirectRefused("the answer is a redirect to an address that holds a user name or a password");
  }
  if (next.protocol !== "https:" && next.origin !== new URL(from).origin) {
    throw new RedirectRefused(
      `the answer is a redirect to ${next.protocol}//${next.host}, and a redirect is followed only to an https address`,
    );
  }
  return next.toString();
}

/**
 * `fetchImpl`, following redirects under the rule above. Whatever the caller
 * passes goes with every hop, its deadline included, so one deadline covers
 * the whole of it. The answer it resolves to is never a redirect.
 */
export function followingHttpsRedirects(fetchImpl: typeof fetch = fetch): typeof fetch {
  const follow = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let current = input instanceof Request ? input.url : input.toString();
    for (let hop = 0; ; hop += 1) {
      const response = await fetchImpl(current, { ...init, redirect: "manual" });
      if (!REDIRECTS.has(response.status)) return response;
      // Nothing of a redirect's own body is read.
      await response.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) throw new RedirectRefused("the answer is one redirect after another");
      current = redirectTarget(current, response.headers.get("location"));
    }
  };
  return follow as typeof fetch;
}
