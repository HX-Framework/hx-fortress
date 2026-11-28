import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

// The wire contract is imported through src/protocol only: that one file
// names the package it comes from, so a change of the package is a change of
// one import.
const PROTOCOL_IMPORT_PATTERNS = [
  {
    group: ["@let-ai/hx-protocol", "@let-ai/hx-protocol/*"],
    message: "Import the wire contract through src/protocol only.",
  },
];

const MODULE_EGRESS_MESSAGE =
  "A module calls out through ctx.fetch, which is held to the hosts its manifest lists.";
const MODULE_DATABASES_MESSAGE =
  "Another module asks the Databases module through its for-modules file, and imports nothing else of it.";
const MODULE_PROCESS_MESSAGE =
  "A module starts no process. The module host starts a helper program for it.";

export default tseslint.config(
  {
    // ui/ is its own Vite/React workspace with its own toolchain and tsconfig;
    // the generated asset map is machine-written and carries @ts-nocheck.
    ignores: [
      "coverage/**",
      "dist/**",
      "node_modules/**",
      "ui/**",
      "src/ui-assets.gen.ts",
      // Written by scripts/gen-island-files.ts: one import for each page file
      // of a Secure Data Island.
      "src/island-files.gen.ts",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  // Security-aware linting (OSS Readiness Plan, Part 4.3). Start at recommended;
  // ratchet warn->error once existing findings are burned down (Part 2, §2.4).
  security.configs.recommended,
  {
    rules: {
      "no-restricted-imports": ["error", { patterns: PROTOCOL_IMPORT_PATTERNS }],
    },
  },
  {
    files: ["src/protocol/index.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // The page files of a Secure Data Island are plain JavaScript that a
    // browser runs as it is written. These are the browser's own names that
    // they use. Their types are checked from their JSDoc by
    // `tsc -p islands/tsconfig.json`.
    files: ["islands/**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: Object.fromEntries(
        [
          "window",
          "document",
          "location",
          "history",
          "fetch",
          "crypto",
          "sessionStorage",
          "btoa",
          "atob",
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "clearInterval",
          "Element",
          "HTMLElement",
          "URL",
          "URLSearchParams",
          "TextEncoder",
          "TextDecoder",
          "ResizeObserver",
          "DOMParser",
        ].map((name) => [name, "readonly"]),
      ),
    },
  },
  {
    // A module reaches the network through the context the host hands it, and
    // through nothing else: its manifest lists the hosts it may call, the
    // console shows that list as the module's data paths, and `ctx.fetch`
    // refuses any other. This rule is what keeps a module from stepping around
    // it by accident. A module starts no process either: a program a module
    // started would call out with no list to hold it to. It is a guard for code written in good faith, not a
    // sandbox (see src/host/module-context.ts): a library a module imports can
    // still open a socket, so a module hands such a library `ctx.fetch` to use.
    //
    // The two modules that predate manifests are outside it.
    files: ["src/modules/**/*.ts"],
    ignores: ["src/modules/session-vault/**", "src/modules/embed-worker/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: MODULE_EGRESS_MESSAGE },
        { name: "WebSocket", message: MODULE_EGRESS_MESSAGE },
        { name: "XMLHttpRequest", message: MODULE_EGRESS_MESSAGE },
        { name: "EventSource", message: MODULE_EGRESS_MESSAGE },
      ],
      "no-restricted-properties": [
        "error",
        { object: "globalThis", property: "fetch", message: MODULE_EGRESS_MESSAGE },
        { object: "Bun", property: "fetch", message: MODULE_EGRESS_MESSAGE },
        { object: "Bun", property: "connect", message: MODULE_EGRESS_MESSAGE },
        { object: "Bun", property: "udpSocket", message: MODULE_EGRESS_MESSAGE },
        { object: "Bun", property: "spawn", message: MODULE_PROCESS_MESSAGE },
        { object: "Bun", property: "spawnSync", message: MODULE_PROCESS_MESSAGE },
        { object: "Bun", property: "$", message: MODULE_PROCESS_MESSAGE },
      ],
      // A later block replaces an earlier one's setting for the same rule, so
      // the protocol boundary is restated here beside the module's own.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...PROTOCOL_IMPORT_PATTERNS,
            {
              group: [
                "node:http",
                "node:https",
                "node:http2",
                "node:net",
                "node:tls",
                "node:dgram",
                "http",
                "https",
                "http2",
                "net",
                "tls",
                "dgram",
                "undici",
              ],
              message: MODULE_EGRESS_MESSAGE,
            },
            {
              group: ["node:child_process", "child_process", "node:cluster", "cluster"],
              message: MODULE_PROCESS_MESSAGE,
            },
            {
              // The Databases module's own files import each other as "./x",
              // which this does not match.
              group: ["**/databases/*", "!**/databases/for-modules"],
              message: MODULE_DATABASES_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  {
    // The Store's engine is written into this folder by a script, from the
    // repository it is developed in, and nobody changes a file of it here
    // (src/modules/stores/engine/ENGINE.md; a test holds the folder to its
    // list: test/modules/stores/engine/engine-folder.test.ts). So these seven
    // rules about how code is written (a name that is not used, a `let` that
    // could be a `const`, a control character in a pattern) are its own
    // repository's to hold, not this one's. Every rule above that keeps a
    // module off the network and from starting a process holds for it.
    //
    // One rule more is held in part. A `case` that does something and then
    // runs on into the next one is refused there as everywhere. A `case` with
    // nothing in it may have a comment before the next `case`: the rule reads
    // that line as a gap, and the engine writes its lists of cases that way.
    files: ["src/modules/stores/engine/**/*.ts"],
    rules: {
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-control-regex": "off",
      "no-fallthrough": ["error", { allowEmptyCase: true }],
      "no-irregular-whitespace": "off",
      "no-useless-assignment": "off",
      "prefer-const": "off",
    },
  },
);
