// The sign-in window's last page: where the organization's identity provider sends the person
// back. The page hands the provider's one-time code to HX Fortress, with the verifier that the
// first page kept, and closes. It never holds a session: the page that began the sign-in takes
// it.

import { call } from "./island.js";
import { CLOSE_AND_RETRY, keep, kept, open } from "./signin-shared.js";

// The code may come back in the address's query or in its fragment.
const answer = new URLSearchParams(location.search.length > 1 ? location.search : `?${location.hash.slice(1)}`);
history.replaceState(null, "", location.pathname); // the code leaves the address bar at once

const page = await open();
const held = kept();
page.say("Signing you in");

/** @param {string} sentence */
function notFinished(sentence) {
  if (!held) return page.stopped("The sign‑in did not finish", CLOSE_AND_RETRY);
  page.stopped("The sign‑in did not finish", sentence);
  // The person may still sign in with an account on this HX Fortress, in this window. The
  // provider's verifier is spent, and is not kept.
  keep({ challenge: held.challenge, pass: held.pass });
  page.offerAccount(() => location.replace(`./signin#c=${held.challenge}&how=account`));
}

const code = answer.get("code");
const state = answer.get("state");
if (!held?.verifier || !code || !state) {
  notFinished("");
} else {
  const response = await call("signin/provider/finish", { code, state, verifier: held.verifier });
  /** @type {{ done?: unknown, name?: unknown, error?: unknown }} */
  const said = response ? await response.json().catch(() => ({})) : {};
  if (response?.ok && said.done === true) page.done(String(said.name ?? ""), held.challenge);
  else notFinished(typeof said.error === "string" ? said.error : "");
}
