# The page files of a Secure Data Island

A Secure Data Island is a small page that HX Fortress serves at its own address. A control
plane's page shows it in a frame. The person in front of it signs in at HX Fortress, and what
the page shows comes from HX Fortress and goes to that person's browser. The control plane's
page learns a state, a count and a height.

The folder `v1/` holds every file of such a page. HX Fortress serves each one at
`/island/v1/<its name>`, exactly as it is here, to anyone, with no sign-in: a page file holds
no data. A page also answers without `.html`.

| File | What it is |
| --- | --- |
| `contract.json` | The closed list: the kinds, every message that may cross a frame's edge with its fields, the style tokens, the key chords, the refusal codes, the grant's claims, and the one spelling of the settings that a grant commits to, with test cases |
| `island.js` | What every kind shares: the messages, the session, the keyboard's way in and out, and the guard on copy, cut, drag and print |
| `rows.js`, `rows.html` | The `rows` kind: the rows of one query |
| `open.js`, `open.html` | The same rows as a page at HX Fortress's own address, in a window of their own |
| `signin.js`, `signin.html` | The sign-in window's first page: an account on this HX Fortress, or the way to the organization's identity provider |
| `callback.js`, `callback.html` | The sign-in window's last page: where an identity provider sends the person back |
| `signin-shared.js` | What the two pages of the sign-in window share |
| `mark.js` | The mark, "HX Fortress" with its mark, an organization with its avatar, and the picture of a sign-in |
| `island.css` | The styles |
| `theme.js` | The first thing a page runs, before it paints: whether it starts light or dark |
| `SHA256SUMS` | Each file's checksum, in the form `shasum -c` reads |

## The rules of this folder

- **Plain HTML, CSS, JavaScript, SVG and JSON.** No TypeScript, no bundler, no minifier, and no
  file that a tool made, except `SHA256SUMS`. So a file that an HX Fortress serves is, byte for
  byte, the file in this repository at that release's tag.
- **No inline script and no inline style** in any page. The pages' Content-Security-Policy
  allows neither, and needs no hash.
- **A script calls HX Fortress and nothing else,** and loads only the scripts beside it. The
  fonts are the console's own files.
- **Within `v1` the closed list only grows.** A change that breaks an older page of a control
  plane is a folder `v2/`, served beside this one.
- **No file here names a vendor.** A script reads three values from HX Fortress at run time
  (`GET /island/v1/config`): the origin of the control plane's pages, the organization's name,
  and whether its people sign in with an account on this HX Fortress or through the
  organization's identity provider.
- **A script sends the page around a frame only what `contract.json` lists.** `island.js` holds
  the same lists as constants, and its one function that posts to the page sends nothing else.
  A kind's own script (`rows.js`) has no other way to the page.

The types of the scripts are checked from their JSDoc comments
(`tsc -p islands/tsconfig.json`, part of `bun run typecheck`), which changes no byte of them.

## After a change to a file

```bash
bun run gen:islands
```

This writes `v1/SHA256SUMS` and `src/island-files.gen.ts`, the module whose imports embed each
file in the binary as it is. Both are in the repository. A test fails when either is stale, and
so does every build: `bun run check:islands` writes nothing and exits 1.

The tests are in `test/islands/`. They hold the scripts' lists to `contract.json`, and run the
scripts against a stand-in for a page to check what leaves a frame.

## Checking a file that an HX Fortress serves

```bash
curl -s https://hx.northstar.example/island/v1/island.js | shasum -a 256
```

Compare the result with the line for `island.js` in `v1/SHA256SUMS` at the tag of the release
that HX Fortress runs. The check shows what that HX Fortress serves to whoever runs it.

A console reads these files once, when it starts, and compares them with `SHA256SUMS`. When
they do not match, it serves none of them and says so in its first lines.
