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
    // A module reaches the network through the context the host hands it, and
    // through nothing else: its manifest lists the hosts it may call, the
    // console shows that list as the module's data paths, and `ctx.fetch`
    // refuses any other. This rule is what keeps a module from stepping around
    // it by accident. It is a guard for code written in good faith, not a
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
          ],
        },
      ],
    },
  },
);
