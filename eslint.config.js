import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

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
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@forge/session-store", "@forge/session-store/*"],
              message: "Import the wire contract through src/protocol only.",
            },
            {
              group: ["@forge/hx-client", "@forge/hx-client/*"],
              message: "Import the wire contract through src/protocol only.",
            },
          ],
        },
      ],
    },
  },
);
