// The half of a sign-in through the identity provider that this tab holds
// while the browser is away at the provider.
//
// The console gives the tab a PKCE verifier and keeps no copy. The tab must
// present it again with the code, so a code that reaches any other browser is
// useless there. It lives in sessionStorage, which is per tab, and it is
// removed the moment it is read.

const KEY = "hx-fortress-oidc-flow";

export interface OidcFlow {
  verifier: string;
  /** The `state` this tab sent to the provider. The answer must carry it back. */
  state: string;
}

export function saveOidcFlow(flow: OidcFlow): void {
  sessionStorage.setItem(KEY, JSON.stringify(flow));
}

export function takeOidcFlow(): OidcFlow | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OidcFlow>;
    return typeof parsed.verifier === "string" && typeof parsed.state === "string"
      ? { verifier: parsed.verifier, state: parsed.state }
      : null;
  } catch {
    return null;
  }
}
