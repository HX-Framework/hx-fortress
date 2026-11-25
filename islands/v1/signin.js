// The sign-in window's first page, at HX Fortress's own address.
//
// It signs a person in with an account on this HX Fortress, or sends them to the organization's
// identity provider. Its address holds a challenge. Before it shows anything to type into, it
// asks the page that opened it for the pass that the challenge was made from. A window that was
// opened any other way gets no pass, and signs nobody in.
//
//   #c=<challenge>               what HX Fortress offers first: the provider when it is on
//   #c=<challenge>&how=account   an account on this HX Fortress, also when the provider is on

import { HASHED, at, call } from "./island.js";
import { CLOSE_AND_RETRY, askForPass, keep, kept, open } from "./signin-shared.js";

/** @param {string} id */
const field = (id) => /** @type {HTMLInputElement} */ (at(id));

const fragment = new URLSearchParams(location.hash.slice(1));
const challenge = fragment.get("c") ?? "";
// The page that opened this window can send it another sign-in address while it is open. Only
// the fragment changes then, and the browser does not load the page again. A sign-in belongs to
// one challenge, so the window starts over with the new one.
window.addEventListener("hashchange", () => location.reload());
const page = await open();
const account = page.organization ? `your ${page.organization} account` : "your account";
/** The pass of the page that began this sign-in. */
let pass = "";

/**
 * One line under a form's fields, or none.
 *
 * @param {string} id
 * @param {string} text
 */
function line(id, text) {
  at(id).textContent = text;
  at(id).hidden = text === "";
}

/**
 * What HX Fortress said about a step that did not pass, in its own words.
 *
 * @param {Response | null} response
 */
async function wordsOf(response) {
  if (!response) return { error: "HX Fortress did not answer. Try again.", help: "", restart: false };
  /** @type {{ error?: unknown, recovery?: unknown, restart?: unknown }} */
  const said = await response.json().catch(() => ({}));
  return {
    error: typeof said.error === "string" && said.error ? said.error : "The sign-in did not pass.",
    help: typeof said.recovery === "string" ? said.recovery : "",
    restart: said.restart === true,
  };
}

/**
 * @param {string} [problem]
 * @param {string} [help]
 */
function showAccount(problem = "", help = "") {
  page.say(`Sign in with ${account}`);
  at("hx-other").hidden = true;
  at("hx-second").hidden = true;
  at("hx-account").hidden = false;
  line("hx-account-problem", problem);
  line("hx-account-help", help);
  const login = field("hx-login");
  (login.value ? field("hx-password") : login).focus();
}

/** The ticket that carries this sign-in from the password to its code. */
let ticket = "";
function showSecond() {
  page.say(`Sign in with ${account}`, "Enter the 6-digit code from your authenticator app.");
  at("hx-account").hidden = true;
  at("hx-second").hidden = false;
  line("hx-second-problem", "");
  field("hx-code").value = "";
  field("hx-code").focus();
}

/** @param {unknown} name */
function signedIn(name) {
  at("hx-account").hidden = true;
  at("hx-second").hidden = true;
  page.done(String(name ?? ""), challenge);
}

/**
 * Run one step while its button is off, so that a second press of Enter sends nothing.
 *
 * @param {string} button
 * @param {() => Promise<void>} step
 */
async function once(button, step) {
  const go = /** @type {HTMLButtonElement} */ (at(button));
  if (go.disabled) return;
  go.disabled = true;
  try {
    await step();
  } finally {
    go.disabled = false;
  }
}

at("hx-account").addEventListener("submit", (e) => {
  e.preventDefault();
  void once("hx-account-go", async () => {
    const response = await call("signin/password", { pass, login: field("hx-login").value.trim(), password: field("hx-password").value });
    field("hx-password").value = "";
    if (response?.ok) {
      const said = await response.json().catch(() => ({}));
      if (said.done === true) return signedIn(said.name);
      if (said.secondStep === "code" && typeof said.ticket === "string") {
        ticket = said.ticket;
        return showSecond();
      }
    }
    const said = await wordsOf(response?.ok ? null : response);
    showAccount(said.error, said.help);
  });
});

at("hx-second").addEventListener("submit", (e) => {
  e.preventDefault();
  void once("hx-second-go", async () => {
    const response = await call("signin/code", { pass, ticket, code: field("hx-code").value });
    if (response?.ok) {
      const said = await response.json().catch(() => ({}));
      if (said.done === true) return signedIn(said.name);
    }
    const said = await wordsOf(response?.ok ? null : response);
    // The sign-in in progress is over: only the password starts another.
    if (said.restart) return showAccount(said.error, said.help);
    line("hx-second-problem", said.error);
    field("hx-code").select();
  });
});

async function toProvider() {
  page.say(page.organization ? `Taking you to ${page.organization}’s sign‑in` : "Taking you to your sign‑in");
  const response = await call("signin/provider", { pass });
  /** @type {{ authorizationUrl?: unknown, verifier?: unknown, error?: unknown } | null} */
  const said = response ? await response.json().catch(() => null) : null;
  if (response?.ok && typeof said?.authorizationUrl === "string" && /^https?:\/\//.test(said.authorizationUrl) && typeof said.verifier === "string") {
    // The verifier stays in this window. The last page sends it back with the provider's code.
    keep({ challenge, pass, verifier: said.verifier });
    return location.replace(said.authorizationUrl);
  }
  page.stopped("This sign‑in cannot start", typeof said?.error === "string" ? said.error : "");
  page.offerAccount(() => showAccount());
}

if (!HASHED.test(challenge) || !page.config || page.config.pages === null) {
  page.stopped("This sign‑in cannot start", CLOSE_AND_RETRY);
} else {
  // A sign-in that went on to the identity provider and came back goes on with what this window
  // kept. Every other one asks the page that opened this window.
  const held = kept();
  pass = held?.challenge === challenge ? held.pass : ((await askForPass(challenge)) ?? "");
  if (!pass) {
    page.stopped("This sign‑in cannot start", CLOSE_AND_RETRY);
  } else {
    keep({ challenge, pass });
    if (page.config.signIn === "provider" && fragment.get("how") !== "account") await toProvider();
    else showAccount();
  }
}
