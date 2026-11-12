// The two tables about secret providers that the docs show, written from the
// list in providers.ts.
//
// README.md holds each of these tables once, and a test compares the whole
// table: a row more or a row less fails it. So a provider or a setting that is
// added to the list and not to the docs fails that test, and the docs cannot
// describe a provider this build does not have.

import { DEFAULT_SECRET_PROVIDER_KIND, SECRET_PROVIDERS } from "./providers";

function code(text: string): string {
  return `\`${text}\``;
}

/** "`a`", "`a` or `b`", "`a`, `b` or `c`". */
function oneOf(names: readonly string[]): string {
  const quoted = names.map(code);
  const last = quoted.pop() ?? "";
  return quoted.length === 0 ? last : `${quoted.join(", ")} or ${last}`;
}

/** One row per provider: its name, where a secret is read from, and what the
 *  provider needs from the host. */
export function secretProvidersTable(): string {
  const rows = SECRET_PROVIDERS.map((provider) => {
    const name = provider.kind === DEFAULT_SECRET_PROVIDER_KIND ? `${code(provider.kind)} (default)` : code(provider.kind);
    return `| ${name} | ${provider.summary} | ${provider.needs ?? "Nothing."} |`;
  });
  return [
    "| Provider | Where the secret `db-url` is read from | What it needs from the host |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** One row per setting: its variable, its key in config.json, and its purpose. */
export function secretSettingsTable(): string {
  const kinds = SECRET_PROVIDERS.map((provider) => provider.kind);
  const rows = [
    `| ${code("FORTRESS_SECRETS_PROVIDER")} | ${code("provider")} | ` +
      `${oneOf(kinds)}. Default ${code(DEFAULT_SECRET_PROVIDER_KIND)}. |`,
  ];
  const seen = new Set<string>();
  for (const provider of SECRET_PROVIDERS) {
    for (const setting of provider.settings) {
      if (seen.has(setting.key)) continue;
      seen.add(setting.key);
      const owners = SECRET_PROVIDERS.filter((other) =>
        other.settings.some((theirs) => theirs.key === setting.key),
      ).map((other) => other.kind);
      rows.push(`| ${code(setting.env)} | ${code(setting.key)} | ${oneOf(owners)} only. ${setting.meaning} |`);
    }
  }
  return ["| Variable | `secrets` key in `config.json` | Purpose |", "| --- | --- | --- |", ...rows].join("\n");
}
