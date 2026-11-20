// HX Fortress's own page of a result: the rows of one Secure Data Island, in a window of their
// own, where the browser's address bar shows whose page it is.
//
// The page around a frame opens it. Its address holds the settings and one grant in the fragment,
// which no server sees. The rows are read as in a frame: with this person's sign-in here, and
// with that one grant.

import { at, readConfig } from "./island.js";
import { brand, org } from "./mark.js";

// "HX Fortress" with its mark, and the organization with its avatar: two things, side by side.
const config = await readConfig();
at("hx-top").prepend(brand(), ...(config?.organization ? [org(config.organization)] : []));

await import("./rows.js");
