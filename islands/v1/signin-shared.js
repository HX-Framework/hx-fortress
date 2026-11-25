// What the two pages of the sign-in window share: the picture, the heading with its one
// sentence, the foot, what the window keeps while a sign-in is under way, and how it finds the
// page that began the sign-in.
//
// The window is HX Fortress's own page, opened from the page around a Secure Data Island. Its
// address bar shows whose page it is. It never holds a session. It holds a pass: the page that
// began the sign-in hands it over, and with it the window can keep a proved sign-in for that
// page at HX Fortress. Only that page can take it.

import { HASHED, at, challengeOf, ownPage, readConfig, tell } from "./island.js";
import { picture, poweredBy } from "./mark.js";

/** Where this window keeps what one page hands to the next: a sign-in through an identity
 *  provider leaves this page and comes back to another. */
const KEPT = "hx-fortress-island-signin";

/** What a sign-in that cannot go on tells the person to do. */
export const CLOSE_AND_RETRY = "Close this window and choose Sign In again.";

/**
 * @typedef {object} Kept What this window keeps while its sign-in is under way.
 * @property {string} challenge The challenge in this window's address.
 * @property {string} pass The pass that the page which began the sign-in handed over.
 * @property {string} [verifier] The verifier of the sign-in at the identity provider, while the person is there.
 */

/** @param {Kept | null} value */
export function keep(value) {
  try {
    if (value) sessionStorage.setItem(KEPT, JSON.stringify(value));
    else sessionStorage.removeItem(KEPT);
  } catch {
    // No storage in this window. A sign-in through an identity provider then cannot finish, and
    // the last page says so.
  }
}

/** @returns {Kept | null} */
export function kept() {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEPT) ?? "null");
    if (!value || !HASHED.test(value.challenge) || !HASHED.test(value.pass)) return null;
    const verifier = typeof value.verifier === "string" && value.verifier.length <= 256 ? value.verifier : undefined;
    return { challenge: value.challenge, pass: value.pass, ...(verifier ? { verifier } : {}) };
  } catch {
    return null; // nothing kept, or not what this window wrote
  }
}

/** The most windows that are looked at. A page holds far fewer. */
const MOST_WINDOWS = 4096;

/** The pages of this HX Fortress among the window that opened this one and the frames in it,
 *  nearest first: one of them began this sign-in. @returns {Window[]} */
function openerPages() {
  /** @type {Window[]} */
  const own = [];
  try {
    if (!window.opener) return own;
    /** @type {{ win: Window, depth: number }[]} */
    const seen = [{ win: window.opener, depth: 0 }];
    for (let at = 0; at < seen.length; at++) {
      const { win, depth } = seen[at];
      if (ownPage(win)) own.push(win);
      // A frame of the page is one level down. A frame may sit inside another, a few levels deep.
      for (let i = 0; depth < 4 && i < win.length && seen.length < MOST_WINDOWS; i++) seen.push({ win: win[i], depth: depth + 1 });
    }
  } catch {
    // A window that cannot be reached has nothing to say.
  }
  return own;
}

/**
 * Ask the page that opened this window which of its pages began this sign-in. The one that did
 * answers with its pass. The question and the answer are delivered to pages of this
 * HX Fortress's origin only.
 *
 * Null when none answers: this window was not opened by a page that holds the frame, as when
 * its address was passed on to somebody. It then signs nobody in.
 *
 * @param {string} challenge
 * @returns {Promise<string | null>}
 */
export function askForPass(challenge) {
  return new Promise((resolve) => {
    const pages = openerPages();
    if (pages.length === 0) return resolve(null);
    /** @param {string | null} pass */
    const finish = (pass) => {
      clearInterval(asking);
      clearTimeout(givingUp);
      window.removeEventListener("message", onAnswer);
      resolve(pass);
    };
    /** @param {MessageEvent} e */
    const onAnswer = async (e) => {
      const d = e.data;
      if (e.origin !== location.origin || !d || d.hx !== 1 || d.t !== "signin!" || d.c !== challenge) return;
      // The pass is the one that this window's challenge was made from.
      if (typeof d.p === "string" && HASHED.test(d.p) && (await challengeOf(d.p)) === challenge) finish(d.p);
    };
    window.addEventListener("message", onAnswer);
    const ask = () => {
      for (const page of pages) tell(page, "signin?", { c: challenge });
    };
    const asking = setInterval(ask, 250);
    const givingUp = setTimeout(() => finish(null), 2500);
    ask();
  });
}

/**
 * Draw what both pages show, and hand back the few things a page says with it.
 */
export async function open() {
  const config = await readConfig();
  const organization = config?.organization ?? null;
  const drawn = picture(organization);
  at("hx-pic").replaceChildren(drawn);
  at("hx-foot").prepend(poweredBy());
  at("hx-addr").textContent = location.host;

  /**
   * @param {string} heading
   * @param {string} [sentence]
   */
  const say = (heading, sentence = "") => {
    drawn.classList.remove("is-off");
    at("hx-h").textContent = heading;
    at("hx-p").textContent = sentence;
    at("hx-p").hidden = sentence === "";
    document.title = `${heading} · HX Fortress`;
  };

  return {
    config,
    organization,
    say,
    /**
     * The sign-in cannot go on. The picture shows the broken line.
     *
     * @param {string} heading
     * @param {string} [sentence]
     */
    stopped(heading, sentence = "") {
      say(heading, sentence);
      drawn.classList.add("is-off");
    },
    /**
     * The person may sign in with an account on this HX Fortress in place of the identity
     * provider. `go` is called on the click.
     *
     * @param {() => void} go
     */
    offerAccount(go) {
      at("hx-other").hidden = false;
      const button = at("hx-use-account");
      button.addEventListener("click", go, { once: true });
      button.focus();
    },
    /**
     * Signed in. The page that began the sign-in takes the session, and this window closes.
     *
     * @param {string} name
     * @param {string} challenge
     */
    done(name, challenge) {
      at("hx-other").hidden = true;
      say(`Signed in as ${name}`);
      keep(null);
      // The page that began the sign-in asks HX Fortress for it now, and not at its next turn.
      for (const page of openerPages()) tell(page, "signin-done", { c: challenge });
      setTimeout(() => {
        window.close();
        // A browser may refuse to let a page close a window that passed through another site.
        setTimeout(() => say(`Signed in as ${name}`, "You can close this window."), 300);
      }, 600);
    },
  };
}
