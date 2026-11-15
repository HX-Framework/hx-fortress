// The token of a one-time link that sets a password, kept for one tab.
//
// The page that sets a password takes the token from the address bar on its
// first render and keeps it in this tab's sessionStorage, so a reload comes
// back to the password field: where the console requires a second step,
// nothing is saved until the first right code, so the link is still live after
// a reload (see views/setup/AccountPassword.tsx).
//
// It is kept for that page and for nothing else. It goes when the setup is
// finished or the link is refused as dead, on every sign-in, every sign-out and
// every dropped session, and whenever the tab loads a path other than the setup
// page. Otherwise a live link would outlive its page: open a link, go to the
// console, sign in as somebody else, sign out, type /setup, and the page would
// offer to set the first account's password.

const LINK_KEY = "hx-fortress-setup-link";

export function keepSetupLink(token: string): void {
  try {
    sessionStorage.setItem(LINK_KEY, token);
  } catch {
    // Storage denied: a reload then needs the link again, and nothing else
    // changes.
  }
}

export function keptSetupLink(): string | null {
  try {
    return sessionStorage.getItem(LINK_KEY);
  } catch {
    return null;
  }
}

export function forgetSetupLink(): void {
  try {
    sessionStorage.removeItem(LINK_KEY);
  } catch {
    // Nothing kept, nothing to forget.
  }
}

/** The tab is on another page than the setup page: it keeps no link. */
export function settleSetupLink(onSetupPage: boolean): void {
  if (!onSetupPage) forgetSetupLink();
}
