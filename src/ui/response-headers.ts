// The headers every answer to a browser carries, written once.
//
// The console's own answers and the answers of a Secure Data Island's door
// differ in two things: their Content-Security-Policy, and how long an answer
// may be kept. Everything else is the same and is set here, so a header that
// is added for one of them is added for both.

/** What `Strict-Transport-Security` says, where it is sent at all. */
export const HSTS_VALUE = "max-age=31536000";

export interface ResponseRules {
  /** The whole Content-Security-Policy of this answer. */
  csp: string;
  /** The whole `Cache-Control` of this answer. */
  cache: string;
  /** True only where the request arrived over https. Asserting it on a
   *  plain-http listener would pin a browser to a scheme that listener cannot
   *  serve. */
  hsts: boolean;
}

/** Set the headers on an answer, and hand the same answer back. */
export function withResponseHeaders(res: Response, rules: ResponseRules): Response {
  res.headers.set("content-security-policy", rules.csp);
  res.headers.set("x-content-type-options", "nosniff");
  res.headers.set("referrer-policy", "no-referrer");
  res.headers.set("cache-control", rules.cache);
  if (rules.hsts) res.headers.set("strict-transport-security", HSTS_VALUE);
  return res;
}

/** The `Retry-After` of a refusal that says when to come back: whole seconds,
 *  and at least one. */
export function retryAfterHeader(retryAfterMs: number): Record<string, string> {
  return { "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) };
}
