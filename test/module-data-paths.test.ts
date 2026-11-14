// The console's "Data paths in and out of this host" list states what modules
// add to it: what the control plane may ask, where a release file is fetched
// from, and where a module may call. These rows are computed from which modules
// are switched on, so the tests switch modules and read the rows.

import { afterEach, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";

import { setModuleEnabled } from "../src/host/config";
import type { CatalogEntry } from "../src/host/module-catalog";
import { moduleDataPaths, publishModuleSettings } from "../src/host/modules-api";
import { RELEASE_MAX_BYTES } from "../src/host/release-fetch";
import { S } from "../src/host/shape";
import { UI_CONFIG_DEFAULTS } from "../src/ui/config";
import { dataPathRows, type DataPathRow, type EgressInputs } from "../src/ui/egress";
import { makeRig, PROBE_CATALOG, tempRoot, writeConfig, type Paths } from "./host/_module-rig";

const CLOUD_URL = "wss://control.example/_api/hx-gateway/vault-tunnel";

function inputs(modules?: EgressInputs["modules"]): EgressInputs {
  return {
    ui: { ...UI_CONFIG_DEFAULTS, bind: "127.0.0.1", trustedProxies: [] },
    boundPort: 8788,
    postgres: { mode: "unknown" },
    cloudUrl: CLOUD_URL,
    downloadBase: "https://control.example/_api/hx-gateway/download",
    postgresBinariesUrl: null,
    bucket: null,
    embeddingEndpoint: null,
    ssoAdvertised: false,
    rosterRetentionDays: 90,
    ...(modules ? { modules } : {}),
  };
}

function row(rows: DataPathRow[], id: string): DataPathRow {
  const found = rows.find((r) => r.id === id);
  if (!found) throw new Error(`no ${id} row`);
  return found;
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function root(enabled: string[]): Promise<Paths> {
  const made = await tempRoot();
  cleanup = made.cleanup;
  await writeConfig(made.paths, enabled);
  return made.paths;
}

describe("the module rows of the data-paths list", () => {
  test("are listed even when nothing computed them, and say so", () => {
    const rows = dataPathRows(inputs());
    for (const id of ["module-asks", "module-releases", "module-egress"]) {
      expect(rows.map((r) => r.id)).toContain(id);
    }
    expect(row(rows, "module-asks").carries).toBe("not resolved yet");
    expect(row(rows, "module-releases").peer).toBe("not resolved yet");
    expect(row(rows, "module-egress").peer).toBe("not resolved yet");
  });

  test("with only Sessions on, no ask can be sent and no host is called", async () => {
    const paths = await root(["session_vault"]);
    const modules = await moduleDataPaths(paths, { cloudUrl: CLOUD_URL, env: {} });
    expect(modules.on).toEqual([{ id: "session_vault", asks: [], egress: [] }]);
    const rows = dataPathRows(inputs(modules));
    expect(row(rows, "module-asks").carries).toBe("nothing - no module that takes asks is switched on");
    expect(row(rows, "module-asks").peer).toBe(CLOUD_URL);
    expect(row(rows, "module-egress").peer).toBe("none - no module that is switched on lists a host");
    expect(row(rows, "module-egress").notes).toEqual([]);
  });

  test("switching the host module on lists each of its asks and what the answer holds", async () => {
    const paths = await root(["session_vault"]);
    await setModuleEnabled(paths, "host", true);
    const rows = dataPathRows(inputs(await moduleDataPaths(paths, { cloudUrl: CLOUD_URL, env: {} })));
    const asks = row(rows, "module-asks");
    expect(asks.direction).toBe("both");
    expect(asks.carries).toStartWith("the answers to 3 asks of host:");
    expect(asks.carries).toContain("no field for free text or bytes");
    const notes = (asks.notes ?? []).join("\n");
    for (const name of ["host status", "host audit.count", "host audit.read"]) {
      expect(notes).toContain(`${name} - the answer holds`);
    }
    // What an audit line holds is stated field by field: this is what leaves.
    expect(notes).toContain("actor: name");
    expect(notes).toContain("action: name");
    expect(asks.gate).toContain("at most 60 seconds");

    // And switching it off takes the asks off the list again.
    await setModuleEnabled(paths, "host", false);
    const after = dataPathRows(inputs(await moduleDataPaths(paths, { cloudUrl: CLOUD_URL, env: {} })));
    expect(row(after, "module-asks").carries).toBe("nothing - no module that takes asks is switched on");
  });

  test("a release file comes from the control plane's own origin, and from a host the operator listed", async () => {
    const paths = await root(["session_vault"]);
    const plain = await moduleDataPaths(paths, { cloudUrl: CLOUD_URL, env: {} });
    expect(plain).toMatchObject({
      controlPlaneOrigin: "https://control.example",
      releaseHosts: [],
      // No daemon has started in this root, and the row says where its list is from.
      releaseHostsFrom: "reader",
      releaseMaxBytes: RELEASE_MAX_BYTES,
    });
    expect(row(dataPathRows(inputs(plain)), "module-releases").notes?.at(-1)).toContain(
      "No daemon has started on this host yet",
    );
    const releases = row(dataPathRows(inputs(plain)), "module-releases");
    expect(releases.direction).toBe("in");
    expect(releases.peer).toBe("https://control.example");
    expect(releases.carries).toContain("at most 64 MiB");
    expect(releases.gate).toContain("a key compiled into this binary");

    const listed = await moduleDataPaths(paths, {
      cloudUrl: CLOUD_URL,
      env: { FORTRESS_RELEASE_HOSTS: "Artifacts.Example, cdn.example" },
    });
    expect(row(dataPathRows(inputs(listed)), "module-releases").peer).toBe(
      "https://control.example, https://artifacts.example, https://cdn.example",
    );
  });

  test("the hosts listed are the ones the daemon was started with, not the reader's own", async () => {
    const paths = await root(["session_vault"]);
    // The daemon runs as one service and the console as another. Only the
    // daemon's environment names a mirror, and the daemon is what fetches.
    await publishModuleSettings(paths, { FORTRESS_RELEASE_HOSTS: "mirror.example:8443" });
    const asTheConsoleSeesIt = await moduleDataPaths(paths, { cloudUrl: CLOUD_URL, env: {} });
    expect(asTheConsoleSeesIt.releaseHosts).toEqual(["mirror.example:8443"]);
    expect(asTheConsoleSeesIt.releaseHostsFrom).toBe("daemon");
    expect(row(dataPathRows(inputs(asTheConsoleSeesIt)), "module-releases").notes?.at(-1)).toContain(
      "the ones the daemon was last started with",
    );
    expect(row(dataPathRows(inputs(asTheConsoleSeesIt)), "module-releases").peer).toBe(
      "https://control.example, https://mirror.example:8443",
    );
    // And the other way: a host only the console's environment names is not one
    // the daemon will fetch from, so it is not listed.
    await publishModuleSettings(paths, {});
    const other = await moduleDataPaths(paths, {
      cloudUrl: CLOUD_URL,
      env: { FORTRESS_RELEASE_HOSTS: "console-only.example" },
    });
    expect(other.releaseHosts).toEqual([]);
    expect((await stat(paths.moduleSettings)).mode & 0o777).toBe(0o600);
  });

  test("a module host that starts publishes them", async () => {
    const rig = await makeRig({ deps: { env: { FORTRESS_RELEASE_HOSTS: "files.example" } } });
    try {
      const seen = await moduleDataPaths(rig.paths, { cloudUrl: CLOUD_URL, env: {} }, { catalog: PROBE_CATALOG });
      expect(seen.releaseHosts).toEqual(["files.example"]);
    } finally {
      await rig.cleanup();
    }
  });

  test("before enrollment there is no origin to fetch a release from", async () => {
    const paths = await root(["session_vault"]);
    const modules = await moduleDataPaths(paths, { cloudUrl: null, env: {} });
    expect(modules.controlPlaneOrigin).toBeNull();
    const rows = dataPathRows({ ...inputs(modules), cloudUrl: null });
    expect(row(rows, "module-releases").peer).toBe("not enrolled");
    expect(row(rows, "module-asks").peer).toBe("not enrolled");
  });

  test("the hosts a switched-on module may call are listed, and a module that is off adds none", async () => {
    const catalog: CatalogEntry[] = [
      {
        id: "alpha",
        title: "Alpha",
        summary: "a module that calls two hosts",
        manifest: {
          id: "alpha",
          asks: [{ name: "count", args: S.none, reply: S.record({ n: S.count() }) }],
          egress: ["api.example", "*.storage.example"],
          secrets: [],
        },
        startOnly: false,
      },
      {
        id: "beta",
        title: "Beta",
        summary: "a module that calls one host and is off",
        manifest: { id: "beta", asks: [], egress: ["elsewhere.example"], secrets: [] },
        startOnly: false,
      },
    ];
    const paths = await root(["alpha"]);
    const modules = await moduleDataPaths(paths, { cloudUrl: CLOUD_URL, env: {} }, { catalog });
    expect(modules.on.map((m) => m.id)).toEqual(["alpha"]);
    const rows = dataPathRows(inputs(modules));
    const egress = row(rows, "module-egress");
    expect(egress.direction).toBe("out");
    expect(egress.peer).toBe("*.storage.example, api.example");
    expect(egress.notes).toEqual(["alpha may call api.example, *.storage.example"]);
    expect(row(rows, "module-asks").carries).toStartWith("the answers to 1 ask of alpha:");
  });
});
