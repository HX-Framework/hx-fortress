import React, { useEffect, useState } from "react";

import { peekFragmentToken } from "../router";
import AccountPassword from "./setup/AccountPassword";
import { readSetupSession } from "./setup/client";
import FortressSetup from "./setup/FortressSetup";

/** Which screen the address opens. A `#t=` link is one person's password link,
 *  whatever this tab still holds from a setup. */
function opens(): "fortress" | "password" {
  if (peekFragmentToken("t") !== null) return "password";
  return peekFragmentToken("s") !== null || readSetupSession() !== null ? "fortress" : "password";
}

/**
 * `/setup` is two arrivals, told apart by what the link carries.
 *
 * `#s=` is the one-time link of the Fortress setup: the questions a new
 * install asks. A separate, short-lived listener serves it, and this screen is
 * all it shows. A tab that already opened that link keeps its session for a
 * reload, so it lands here again without the fragment.
 *
 * `#t=` is one person's link to set a console password, as it always was.
 *
 * Decided on the first render, before either screen clears the fragment. A
 * link pasted into this tab changes only the fragment, so the page does not
 * load again: it is decided again then, and the screen starts afresh.
 */
export default function Setup(): React.ReactElement {
  const [arrival, setArrival] = useState(() => ({ screen: opens(), count: 0 }));
  useEffect(() => {
    const onHash = (): void => {
      if (peekFragmentToken("t") === null && peekFragmentToken("s") === null) return;
      setArrival((was) => ({ screen: opens(), count: was.count + 1 }));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return arrival.screen === "fortress" ? (
    <FortressSetup key={arrival.count} />
  ) : (
    <AccountPassword key={arrival.count} />
  );
}
