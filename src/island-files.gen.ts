// Written by scripts/gen-island-files.ts from the folder islands/v1/. Do not edit.
// One import for each file of that folder: `bun build --compile` embeds each one as
// it is, and in a source checkout the import gives the file's own path. A test
// fails when this module no longer matches the folder (test/islands/files.test.ts),
// and so does every build (`bun run check:islands`).
// @ts-nocheck: tsc has no model for `with { type: "file" }`.

import f0 from "../islands/v1/SHA256SUMS" with { type: "file" };
import f1 from "../islands/v1/callback.html" with { type: "file" };
import f2 from "../islands/v1/callback.js" with { type: "file" };
import f3 from "../islands/v1/contract.json" with { type: "file" };
import f4 from "../islands/v1/island.css" with { type: "file" };
import f5 from "../islands/v1/island.js" with { type: "file" };
import f6 from "../islands/v1/mark.js" with { type: "file" };
import f7 from "../islands/v1/open.html" with { type: "file" };
import f8 from "../islands/v1/open.js" with { type: "file" };
import f9 from "../islands/v1/rows.html" with { type: "file" };
import f10 from "../islands/v1/rows.js" with { type: "file" };
import f11 from "../islands/v1/signin-shared.js" with { type: "file" };
import f12 from "../islands/v1/signin.html" with { type: "file" };
import f13 from "../islands/v1/signin.js" with { type: "file" };
import f14 from "../islands/v1/theme.js" with { type: "file" };

export const ISLAND_FILES: Record<string, string> = {
  "SHA256SUMS": f0,
  "callback.html": f1,
  "callback.js": f2,
  "contract.json": f3,
  "island.css": f4,
  "island.js": f5,
  "mark.js": f6,
  "open.html": f7,
  "open.js": f8,
  "rows.html": f9,
  "rows.js": f10,
  "signin-shared.js": f11,
  "signin.html": f12,
  "signin.js": f13,
  "theme.js": f14,
};
