// A person's act at the console: which paths are routes, who may reach them,
// what the console hands the daemon, and one run from a signed-in request down
// to the real Databases module.
//
// What is real here: the console's server and its one gate, its sessions, its
// rate buckets and its Origin check; and in the last block the daemon's door,
// its act gate, the module host and the Databases module. What is a stand-in:
// the console's read and write ports, which no act touches.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AUDIT_ACTIONS } from "../src/console/audit-actions";
import { AuditSpool } from "../src/console/audit-spool";
import { LocalDoor } from "../src/host/local-door";
import { DAEMON_UNREACHABLE, type ActRequest, type DoorAnswer } from "../src/host/local-door-client";
import { MODULE_CATALOG } from "../src/host/module-catalog";
import { recordable } from "../src/host/module-lists";
import { createDatabasesModule } from "../src/modules/databases/module";
import { createStandInPorts } from "../src/modules/databases/standins";
import { consoleActDoor } from "../src/ui/act-door";
import { actPath, createActRoutes, handleActRoute, parseActPath, REFUSED_ACT_REPORT_MS, reportRefusedAct } from "../src/ui/act-routes";
import { inlineScriptHashesOf, manifestOf, mapDistDir, type UiAssets } from "../src/ui/assets";
import { ConsoleAudit } from "../src/ui/audit-writer";
import { UiConfigStore } from "../src/ui/config";
import { READONLY_REFUSAL_COPY } from "../src/ui/copy";
import { MUTATE_PATHS } from "../src/ui/mutate-routes";
import { BUCKETS } from "../src/ui/rate-limit";
import { UiRuntime } from "../src/ui/runtime";
import { startUiServer } from "../src/ui/server";
import { SESSION_HEADER } from "../src/ui/sessions";
import { ACTS_CATALOG } from "./host/_acts-rig";
import { makeRig, publishStatus, spoolRecords, tempRoot, type Rig } from "./host/_module-rig";
import { CATALOG as DATABASES_TEST_CATALOG, PERMITS } from "./modules/databases/_rig";

const PASSPHRASE = "seventeen-quiet-copper-lanterns";
const INDEX_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>HX Fortress</title></head>
<body><div id="root"></div><script type="module" src="/assets/app-abc123.js"></script></body></html>`;

describe("an act's path", () => {
  test("it names a module and an act, and nothing else is one", () => {
    expect(parseActPath("/ui/api/modules/databases/acts/connection.add")).toEqual({ module: "databases", act: "connection.add" });
    expect(actPath("databases", "connection.add")).toBe("/ui/api/modules/databases/acts/connection.add");
    for (const pathname of [
      "/ui/api/modules/databases/acts/",
      "/ui/api/modules/databases/acts",
      "/ui/api/modules/databases/acts/connection.add/",
      "/ui/api/modules/databases/acts/connection.add/more",
      "/ui/api/modules/databases/asks/connections.list",
      "/ui/api/modules//acts/connection.add",
      "/ui/api/modules/Databases/acts/connection.add",
      "/ui/api/modules/databases/acts/Connection.Add",
      "/ui/api/modules/..%2f/acts/connection.add",
      "/ui/api/modules/databases/acts/..",
      "/ui/api/commands",
    ]) {
      expect([pathname, parseActPath(pathname)]).toEqual([pathname, null]);
    }
  });
});

describe("which acts are routes", () => {
  const routes = (enabled: readonly string[] | null) => createActRoutes({ enabled: async () => enabled, catalog: ACTS_CATALOG });

  test("an act is a route while its module is switched on, and its role decides its class", async () => {
    const on = routes(["session_vault", "probe"]);
    expect(await on.resolve("POST", actPath("probe", "thing.add"))).toMatchObject({
      module: "probe",
      spec: { name: "thing.add", role: "operator" },
      route: { method: "POST", path: actPath("probe", "thing.add"), cls: "mutate", bucket: "moduleAct" },
    });
    const read = await on.resolve("POST", actPath("probe", "things.read"));
    expect(read?.route).toEqual({ method: "POST", path: actPath("probe", "things.read"), cls: "read" });
  });

  test("a module that is off, an act that is not on the list and another method are no route", async () => {
    const on = routes(["session_vault", "probe"]);
    expect(await routes(["session_vault"]).resolve("POST", actPath("probe", "thing.add"))).toBeNull();
    expect(await on.resolve("POST", actPath("probe", "made.up"))).toBeNull();
    expect(await on.resolve("POST", actPath("probe", "lists.count"))).toBeNull();
    expect(await on.resolve("POST", actPath("session_vault", "thing.add"))).toBeNull();
    expect(await on.resolve("POST", actPath("nowhere", "thing.add"))).toBeNull();
    for (const method of ["GET", "HEAD", "PUT", "DELETE", "PATCH"]) {
      expect([method, await on.resolve(method, actPath("probe", "thing.add"))]).toEqual([method, null]);
    }
  });

  test("a switch that cannot be read switches nothing on", async () => {
    expect(await routes(null).resolve("POST", actPath("probe", "thing.add"))).toBeNull();
    const throwing = createActRoutes({
      enabled: async () => {
        throw new Error("config.json cannot be read");
      },
      catalog: ACTS_CATALOG,
    });
    expect(await throwing.resolve("POST", actPath("probe", "thing.add"))).toBeNull();
    expect(await throwing.listed()).toEqual([]);
  });

  test("the switch is read for every path that has an act's shape, and for no other", async () => {
    let reads = 0;
    const counting = createActRoutes({
      enabled: async () => {
        reads += 1;
        return ["probe"];
      },
      catalog: ACTS_CATALOG,
    });
    await counting.resolve("POST", "/ui/api/commands");
    await counting.resolve("POST", "/ui/api/modules/probe");
    expect(reads).toBe(0);
    // One that exists, one that does not, and one of a module nobody ships.
    await counting.resolve("POST", actPath("probe", "thing.add"));
    await counting.resolve("POST", actPath("probe", "made.up"));
    await counting.resolve("GET", actPath("nowhere", "made.up"));
    expect(reads).toBe(3);
  });

  test("this build's own catalog: with every module on, the acts are the Databases module's six", async () => {
    const all = createActRoutes({ enabled: async () => MODULE_CATALOG.map((entry) => entry.id) });
    expect((await all.listed()).map((act) => `${act.route.cls} ${act.route.path}`)).toEqual([
      "read /ui/api/modules/databases/acts/connections.read",
      "mutate /ui/api/modules/databases/acts/connection.add",
      "mutate /ui/api/modules/databases/acts/connection.change",
      "mutate /ui/api/modules/databases/acts/connection.remove",
      "mutate /ui/api/modules/databases/acts/connection.test",
      "read /ui/api/modules/databases/acts/job.read",
    ]);
    // As this build is installed, Databases is off: no act is a route.
    const asInstalled = createActRoutes({ enabled: async () => ["session_vault", "host"] });
    expect(await asInstalled.listed()).toEqual([]);
  });
});

// ── The console's server, with a door that records what it is handed ─────────

interface Console {
  root: string;
  runtime: UiRuntime;
  origin: string;
  enabled: { value: readonly string[] | null };
  /** How often the console read the module switch. */
  reads: { count: number };
  handed: ActRequest[];
  answer: { value: DoorAnswer };
  stop: () => Promise<void>;
}

async function startConsole(options: { door?: (request: ActRequest) => Promise<DoorAnswer>; catalog?: typeof ACTS_CATALOG } = {}): Promise<Console> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hx-console-acts-"));
  const dist = path.join(root, "dist");
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await writeFile(path.join(dist, "index.html"), INDEX_HTML);
  await writeFile(path.join(dist, "assets", "app-abc123.js"), "export const a = 1;\n");
  const files = mapDistDir(dist);
  const assets: UiAssets = { mode: "disk", files, inlineScriptHashes: inlineScriptHashesOf(INDEX_HTML), manifest: await manifestOf(files) };
  const uiConfigFile = path.join(root, "ui.json");
  await new UiConfigStore(uiConfigFile).update((current) => ({ ...current, enabled: true }));
  const enabled = { value: ["session_vault", "probe"] as readonly string[] | null };
  const handed: ActRequest[] = [];
  const reads = { count: 0 };
  const answer = { value: { ok: true, reply: { name: "orders-1" } } as DoorAnswer };
  const runtime = new UiRuntime({
    uiRoot: root,
    uiConfigFile,
    cmdCredsDir: path.join(root, "cmd-creds"),
    env: {},
    acts: createActRoutes({
      enabled: async () => {
        reads.count += 1;
        return enabled.value;
      },
      catalog: options.catalog ?? ACTS_CATALOG,
    }),
  });
  const audit = new ConsoleAudit(new AuditSpool({ dir: path.join(root, "spool"), writer: "ui" }));
  const server = startUiServer(
    {
      assets,
      port: 0,
      runtime,
      audit,
      acts: {
        door:
          options.door ??
          (async (request) => {
            handed.push(request);
            return answer.value;
          }),
      },
    },
    "127.0.0.1",
  );
  return {
    root,
    runtime,
    origin: `http://127.0.0.1:${server.port}`,
    enabled,
    reads,
    handed,
    answer,
    stop: async () => {
      runtime.streams.closeAll("shutdown");
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function tokenFor(c: Console, login: string, role: "operator" | "readonly"): Promise<string> {
  const created = await c.runtime.users.create(login, role);
  await c.runtime.users.completeSetup(created.token, PASSPHRASE);
  const file = await c.runtime.readUsers();
  const user = file.users.find((candidate) => candidate.login === login);
  if (!user) throw new Error(`no such user: ${login}`);
  return c.runtime.sessions.issue({ user, file, remoteAddr: "127.0.0.1" }).token;
}

function post(c: Console, pathname: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${c.origin}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: c.origin, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const THING = { name: "orders-1", host: "db.northstar.example", port: 1433 };

describe("the act route of the console", () => {
  let c: Console;
  afterEach(async () => {
    await c?.stop();
  });

  test("an operator's act is handed to the daemon with who the person is, and the daemon's reply is shown", async () => {
    c = await startConsole();
    const token = await tokenFor(c, "maya.chen", "operator");
    const res = await post(c, actPath("probe", "thing.add"), { args: THING }, { [SESSION_HEADER]: token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: { name: "orders-1" } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(c.handed).toHaveLength(1);
    expect(c.handed[0]).toEqual({
      v: 1,
      person: { login: "maya.chen", email: null, role: "operator" },
      session: expect.stringMatching(/^[0-9a-f]{32}$/),
      module: "probe",
      act: "thing.add",
      args: THING,
    });
    // The id of the sign-in is handed over. The token that proves it is not.
    expect(JSON.stringify(c.handed)).not.toContain(token);
  });

  test("a person whose login is an email address is handed over with that address, and any other login with none", async () => {
    c = await startConsole();
    const byAddress = await tokenFor(c, "maya.chen@northstar.example", "operator");
    const byName = await tokenFor(c, "lena.hart", "readonly");
    c.answer.value = { ok: true, reply: { reaches: [], names: [] } };
    await post(c, actPath("probe", "things.read"), {}, { [SESSION_HEADER]: byAddress });
    await post(c, actPath("probe", "things.read"), {}, { [SESSION_HEADER]: byName });
    expect(c.handed.map((request) => request.person)).toEqual([
      { login: "maya.chen@northstar.example", email: "maya.chen@northstar.example", role: "operator" },
      // Never a guess made from a login.
      { login: "lena.hart", email: null, role: "readonly" },
    ]);
  });

  test("a Viewer does no act: the console makes no session for one, and the route hands nothing over for one that exists anyway", async () => {
    c = await startConsole();
    const token = await tokenFor(c, "maya.chen", "operator");
    // The console's own sign-in refuses a Viewer, so no such session is made
    // there. This one is made by hand, as nothing in the console can.
    const viewer = await c.runtime.users.create("vera.lund", "viewer");
    await c.runtime.users.completeSetup(viewer.token, PASSPHRASE);
    const file = await c.runtime.readUsers();
    const user = file.users.find((candidate) => candidate.login === "vera.lund");
    if (!user) throw new Error("no such user");
    const session = c.runtime.sessions.issue({ user, file, remoteAddr: "127.0.0.1" });
    expect(session.session.role).toBe("viewer");
    // The console does not take it for a sign-in at all.
    for (const name of ["things.read", "thing.add"]) {
      const res = await post(c, actPath("probe", name), { args: THING }, { [SESSION_HEADER]: session.token });
      expect([name, res.status]).toEqual([name, 401]);
    }
    // And the route itself, were the gate ever to let one through.
    const act = await createActRoutes({ enabled: async () => ["probe"], catalog: ACTS_CATALOG }).resolve("POST", actPath("probe", "things.read"));
    if (!act) throw new Error("no such act");
    const door = async (request: ActRequest): Promise<DoorAnswer> => {
      c.handed.push(request);
      return { ok: true, reply: {} };
    };
    const direct = await handleActRoute(
      new Request(`${c.origin}${actPath("probe", "things.read")}`, { method: "POST", body: "{}" }),
      { door, act, session: session.session },
    );
    expect([direct.status, await direct.json()]).toEqual([403, { error: "not_allowed" }]);
    await reportRefusedAct({ door, act, session: session.session });
    // The daemon heard of none of it.
    expect(c.handed).toEqual([]);
    // The control: an operator's act goes through.
    expect((await post(c, actPath("probe", "thing.add"), { args: THING }, { [SESSION_HEADER]: token })).status).toBe(200);
  });

  test("with no sign-in, an act that exists and a path that does not are answered alike", async () => {
    c = await startConsole();
    const known = await post(c, actPath("probe", "thing.add"), { args: THING });
    const unknown = await post(c, actPath("probe", "made.up"), { args: THING });
    const off = await post(c, actPath("session_vault", "thing.add"), { args: THING });
    for (const res of [known, unknown, off]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "sign in to continue" });
    }
    // A token that is not one is no sign-in either.
    const forged = await post(c, actPath("probe", "thing.add"), { args: THING }, { [SESSION_HEADER]: "A".repeat(43) });
    expect(forged.status).toBe(401);
    expect(c.handed).toEqual([]);
    // The switch was not read for any of them: the console did the same work
    // for a path that is an act and for one that is not.
    expect(c.reads.count).toBe(0);
  });

  test("a read-only person, and a page of another site, cannot use up the budget of the operators' acts", async () => {
    c = await startConsole();
    const operator = await tokenFor(c, "maya.chen", "operator");
    const reader = await tokenFor(c, "lena.hart", "readonly");
    for (let i = 0; i < BUCKETS.moduleAct.limit + 10; i += 1) {
      const refused = await post(c, actPath("probe", "thing.add"), { args: THING }, { [SESSION_HEADER]: reader });
      if (refused.status !== 403) throw new Error(`try ${i} of a read-only person was answered ${refused.status}`);
    }
    for (let i = 0; i < BUCKETS.moduleAct.limit + 10; i += 1) {
      const refused = await post(c, actPath("probe", "thing.add"), { args: THING }, { [SESSION_HEADER]: operator, origin: "https://attacker.example" });
      if (refused.status !== 403) throw new Error(`try ${i} from another site was answered ${refused.status}`);
    }
    const res = await post(c, actPath("probe", "thing.add"), { args: THING }, { [SESSION_HEADER]: operator });
    expect(res.status).toBe(200);
    // The daemon was handed the operator's act once. Of the read-only
    // person's tries it was told a few, and of the other site's page none.
    expect(c.handed.filter((request) => request.person.role === "operator")).toHaveLength(1);
    const told = c.handed.filter((request) => request.person.role === "readonly");
    expect(told).toHaveLength(BUCKETS.moduleActRefused.limit);
    expect(new Set(told.map((request) => JSON.stringify(request.args)))).toEqual(new Set(["{}"]));
  });

  test("a caller with no sign-in cannot use up the budget of the operators' acts", async () => {
    c = await startConsole();
    const token = await tokenFor(c, "maya.chen", "operator");
    for (let i = 0; i < BUCKETS.moduleAct.limit + 10; i += 1) {
      const res = await post(c, actPath("probe", "thing.add"), { args: THING });
      if (res.status !== 401) throw new Error(`call ${i} with no sign-in was answered ${res.status}`);
    }
    const res = await post(c, actPath("probe", "thing.add"), { args: THING }, { [SESSION_HEADER]: token });
    expect(res.status).toBe(200);
    expect(c.handed).toHaveLength(1);
  });

  test("a read-only person may do what any signed-in person may, and is refused an operator's act by the gate", async () => {
    c = await startConsole();
    const token = await tokenFor(c, "lena.hart", "readonly");
    c.answer.value = { ok: true, reply: { reaches: [], names: [] } };
    const read = await post(c, actPath("probe", "things.read"), {}, { [SESSION_HEADER]: token });
    expect(read.status).toBe(200);
    expect(c.handed[0]).toMatchObject({ person: { login: "lena.hart", role: "readonly" }, act: "things.read", args: {} });

    const write = await post(c, actPath("probe", "thing.add"), { args: THING }, { [SESSION_HEADER]: token });
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({ error: READONLY_REFUSAL_COPY });
    // The same answer a path nobody serves gets: a read-only person cannot map
    // which acts exist.
    const unknown = await post(c, actPath("probe", "made.up"), {}, { [SESSION_HEADER]: token });
    expect([unknown.status, await unknown.json()]).toEqual([403, { error: READONLY_REFUSAL_COPY }]);
    // The daemon was told of the try at the act that exists, so that it is in
    // the audit trail: who the person is and which act, and none of the
    // arguments. Of the path nobody serves it was told nothing.
    expect(c.handed).toHaveLength(2);
    expect(c.handed[1]).toEqual({
      v: 1,
      person: { login: "lena.hart", email: null, role: "readonly" },
      session: expect.stringMatching(/^[0-9a-f]{32}$/),
      module: "probe",
      act: "thing.add",
      args: {},
    });
  });

  test("a read-only person is refused all the same when the daemon cannot be told, or does not answer", async () => {
    const waiting: (() => void)[] = [];
    c = await startConsole({
      door: (request) => {
        if (request.person.login === "lena.hart") throw new Error("the door's file cannot be read");
        // A daemon that took the call and never answers.
        return new Promise((resolve) => waiting.push(() => resolve({ ok: false, error: "not_allowed" })));
      },
    });
    const failing = await tokenFor(c, "lena.hart", "readonly");
    const res = await post(c, actPath("probe", "thing.add"), { args: THING }, { [SESSION_HEADER]: failing });
    expect([res.status, await res.json()]).toEqual([403, { error: READONLY_REFUSAL_COPY }]);
    const slow = await tokenFor(c, "ruth.vale", "readonly");
    const started = Date.now();
    const held = await post(c, actPath("probe", "thing.add"), { args: THING }, { [SESSION_HEADER]: slow });
    expect([held.status, await held.json()]).toEqual([403, { error: READONLY_REFUSAL_COPY }]);
    // It waited for the daemon a little, and not for as long as an act may run.
    expect(Date.now() - started).toBeLessThan(REFUSED_ACT_REPORT_MS + 3_000);
    for (const end of waiting) end();
  });

  test("an act of a module that is switched off is not a route, and the daemon is not called", async () => {
    c = await startConsole();
    const token = await tokenFor(c, "maya.chen", "operator");
    c.enabled.value = ["session_vault"];
    const off = await post(c, actPath("probe", "thing.add"), { args: THING }, { [SESSION_HEADER]: token });
    const unknown = await post(c, "/ui/api/nothing-here", {}, { [SESSION_HEADER]: token });
    // What the console answers a POST to any path it does not serve.
    expect(unknown.status).toBe(405);
    expect([off.status, await off.text()]).toEqual([unknown.status, await unknown.text()]);
    c.enabled.value = null;
    expect((await post(c, actPath("probe", "thing.add"), { args: THING }, { [SESSION_HEADER]: token })).status).toBe(405);
    expect(c.handed).toEqual([]);
    // Switched on again: a route again, with no restart of the console.
    c.enabled.value = ["session_vault", "probe"];
    expect((await post(c, actPath("probe", "thing.add"), { args: THING }, { [SESSION_HEADER]: token })).status).toBe(200);
  });

  test("an act from another site's page is refused, for a read as for a change", async () => {
    c = await startConsole();
    const token = await tokenFor(c, "maya.chen", "operator");
    for (const name of ["thing.add", "things.read"]) {
      const res = await post(c, actPath("probe", name), { args: THING }, { [SESSION_HEADER]: token, origin: "https://attacker.example" });
      expect([name, res.status]).toEqual([name, 403]);
    }
    expect(c.handed).toEqual([]);
  });

  test("an act is never a GET, so its arguments are never in an address", async () => {
    c = await startConsole();
    const token = await tokenFor(c, "maya.chen", "operator");
    const res = await fetch(`${c.origin}${actPath("probe", "things.read")}?name=orders-1`, { headers: { [SESSION_HEADER]: token } });
    expect(res.status).toBe(404);
    expect(c.handed).toEqual([]);
  });

  test("a body that is not an object of JSON is refused before the daemon is called", async () => {
    c = await startConsole();
    const token = await tokenFor(c, "maya.chen", "operator");
    for (const body of ["{ not json", "[]", '"args"', "null"]) {
      const res = await post(c, actPath("probe", "thing.add"), body, { [SESSION_HEADER]: token });
      expect([body, res.status, await res.json()]).toEqual([body, 400, { error: "args_invalid" }]);
    }
    expect(c.handed).toEqual([]);
  });

  test("each word of the daemon is shown as it is, with a status that says what kind it is", async () => {
    c = await startConsole();
    const token = await tokenFor(c, "maya.chen", "operator");
    for (const [error, status] of [
      ["args_invalid", 400],
      ["not_allowed", 403],
      ["act_unknown", 404],
      ["module_off", 409],
      ["busy", 503],
      [DAEMON_UNREACHABLE, 503],
      ["reply_invalid", 500],
      ["failed:internal", 500],
      ["failed:request_invalid", 500],
      // What the module or one of the host's lists refused: about the request.
      ["failed:reach_address_refused", 422],
      ["failed:name_taken", 422],
      ["failed:secret_name_reserved", 422],
      ["failed:connection_unknown", 422],
      // The secret a person named is not in the key store, and a word of the
      // module's own.
      ["failed:secret_missing", 422],
      ["failed:program_not_installed", 422],
      // This HX Fortress's own state: the same request may work later.
      ["failed:audit_unavailable", 503],
      ["failed:module_not_running", 503],
      ["failed:secret_unavailable", 503],
      ["failed:reach_list_unreadable", 503],
      ["failed:secret_names_unreadable", 503],
      // A module's own word for a state of its own that cannot be read.
      ["failed:state_unreadable", 503],
      // A module that did what its manifest does not allow: a defect here.
      ["failed:secret_not_declared", 500],
      ["failed:not_allowed", 500],
      ["failed:egress_not_declared", 500],
      ["failed:egress_private_address", 500],
      ["failed:folder_too_deep", 500],
      ["failed:organization_not_held", 500],
      // A process of the module's own that the host did not start. A word the
      // manifest does not name, a folder the module did not make and a program
      // that could not be started are a fault of this side.
      ["failed:process_not_declared", 500],
      ["failed:folder_missing", 500],
      ["failed:process_start_failed", 500],
      // As many running as the module may have: the same request may find
      // room later. It is a word of its own, so that `failed:busy`, which a
      // module answers for a limit of its own, keeps the status it had.
      ["failed:processes_unavailable", 503],
      ["failed:busy", 422],
      ["failed:timeout", 504],
      ["failed:interrupted", 502],
    ] as const) {
      c.answer.value = { ok: false, error } as DoorAnswer;
      const res = await post(c, actPath("probe", "thing.add"), { args: THING }, { [SESSION_HEADER]: token });
      expect([error, res.status, await res.json()]).toEqual([error, status, { error }]);
    }
  });

  test("the acts of operators draw from a budget of their own, and reads draw from none", async () => {
    c = await startConsole();
    const token = await tokenFor(c, "maya.chen", "operator");
    const limit = BUCKETS.moduleAct.limit;
    for (let i = 0; i < limit; i += 1) {
      const res = await post(c, actPath("probe", "thing.add"), { args: THING }, { [SESSION_HEADER]: token });
      if (res.status !== 200) throw new Error(`act ${i} was answered ${res.status}`);
    }
    const over = await post(c, actPath("probe", "thing.add"), { args: THING }, { [SESSION_HEADER]: token });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).not.toBeNull();
    expect((await post(c, actPath("probe", "things.read"), {}, { [SESSION_HEADER]: token })).status).toBe(200);
    expect(c.handed).toHaveLength(limit + 1);
    // The console's own writes keep their own budget: with the acts' budget
    // used up, a write of the console's own is still judged on its merits.
    const own = await post(c, MUTATE_PATHS.commands, {}, { [SESSION_HEADER]: token });
    expect(own.status).not.toBe(429);
  });

  test("a reply is shown as the daemon gave it, and a text in it that looks like a credential is not", async () => {
    c = await startConsole();
    const token = await tokenFor(c, "maya.chen", "operator");
    const show = async (reply: unknown): Promise<unknown> => {
      c.answer.value = { ok: true, reply };
      const res = await post(c, actPath("probe", "thing.add"), { args: THING }, { [SESSION_HEADER]: token });
      return ((await res.json()) as { reply: unknown }).reply;
    };
    // Names as a person writes them, some with a word that a credential's
    // label also has.
    const names = ["Northstar permits", "token store", "key-1", "orders/2027 @ db.northstar.example"];
    expect(await show({ names, port: 1433, on: true })).toEqual({ names, port: 1433, on: true });
    // The console shows a name unchanged exactly when the daemon would let a
    // person save something under it: both go by the same rule. So nothing
    // that was saved comes back with a part of its name replaced.
    const looksLikeOne = ["bearer", " ", "abcdefgh", "12345"].join("");
    for (const name of [...names, "Authorization database", looksLikeOne]) {
      const shown = (await show({ name })) as { name: string };
      expect([name, shown.name === name]).toEqual([name, recordable(name)]);
    }
    // A module's reply has no field for a secret. If a text that looks like
    // one is there all the same, the console does not show it.
    expect(recordable(looksLikeOne)).toBe(false);
    expect(JSON.stringify(await show({ name: looksLikeOne }))).not.toContain("abcdefgh12345");
  });

  test("a way to the daemon that fails in a way nobody foresaw shows one word, and nothing of what was thrown", async () => {
    c = await startConsole({
      door: () => {
        throw new Error("could not open /var/lib/hx-fortress/runtime/local-door.json");
      },
    });
    const token = await tokenFor(c, "maya.chen", "operator");
    const res = await post(c, actPath("probe", "thing.add"), { args: THING }, { [SESSION_HEADER]: token });
    expect([res.status, await res.json()]).toEqual([500, { error: "failed:internal" }]);
  });

  test("the console's own table of routes holds no act: its write surface is what it was", async () => {
    c = await startConsole();
    const mutating = c.runtime.routes.all().filter((route) => route.cls === "mutate").map((route) => route.path).sort();
    expect(mutating).toEqual([MUTATE_PATHS.commands, MUTATE_PATHS.service].sort());
    expect(c.runtime.routes.all().some((route) => route.path.includes("/modules/"))).toBe(false);
  });

  test("a console that was given no acts serves none, also to an operator who is signed in", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hx-console-no-acts-"));
    const uiConfigFile = path.join(root, "ui.json");
    await new UiConfigStore(uiConfigFile).update((current) => ({ ...current, enabled: true }));
    const judge = async (runtime: UiRuntime): Promise<unknown> => {
      const created = await runtime.users.create("maya.chen", "operator");
      await runtime.users.completeSetup(created.token, PASSPHRASE);
      const file = await runtime.readUsers();
      const user = file.users.find((candidate) => candidate.login === "maya.chen");
      if (!user) throw new Error("no such user");
      const { token } = runtime.sessions.issue({ user, file, remoteAddr: "127.0.0.1" });
      return runtime.authorize(
        new Request(`http://127.0.0.1:8788${actPath("probe", "thing.add")}`, {
          method: "POST",
          headers: { origin: "http://127.0.0.1:8788", host: "127.0.0.1:8788", [SESSION_HEADER]: token },
        }),
        "127.0.0.1",
        8788,
      );
    };
    try {
      // No acts were given: the path is one the console does not know. The
      // gate lets an operator's request through with no route, and the server
      // then answers it as it answers every path it does not serve.
      const without = (await judge(
        new UiRuntime({ uiRoot: root, uiConfigFile, cmdCredsDir: path.join(root, "cmd-creds"), env: {} }),
      )) as { ok: boolean; route: unknown; act?: unknown };
      expect(without).toMatchObject({ ok: true, route: null });
      expect(without.act).toBeUndefined();
      // The control: the same request to a console that was given the acts.
      const other = await mkdtemp(path.join(os.tmpdir(), "hx-console-with-acts-"));
      try {
        const otherConfig = path.join(other, "ui.json");
        await new UiConfigStore(otherConfig).update((current) => ({ ...current, enabled: true }));
        const withActs = await judge(
          new UiRuntime({
            uiRoot: other,
            uiConfigFile: otherConfig,
            cmdCredsDir: path.join(other, "cmd-creds"),
            env: {},
            acts: createActRoutes({ enabled: async () => ["probe"], catalog: ACTS_CATALOG }),
          }),
        );
        expect(withActs).toMatchObject({ ok: true, act: { module: "probe", spec: { name: "thing.add" } } });
      } finally {
        await rm(other, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ── The console's own call to the daemon's door ──────────────────────────────

describe("the console's call to the daemon's door", () => {
  const REQUEST: ActRequest = {
    v: 1,
    person: { login: "maya.chen", email: null, role: "operator" },
    session: null,
    module: "probe",
    act: "things.read",
    args: {},
  };
  const UNREACHABLE = { ok: false, error: DAEMON_UNREACHABLE } as const;

  test("it is made only when the daemon's own status file names the door's process, with a fresh heartbeat", async () => {
    const { paths, cleanup } = await tempRoot();
    const handed: unknown[] = [];
    const door = new LocalDoor({
      file: paths.localDoor,
      act: async (request) => {
        handed.push(request);
        return { ok: true, reply: { reached: "the door" } };
      },
      refused: () => {},
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    await door.open();
    try {
      const call = consoleActDoor(paths);
      // The door is open and its file is right. Whether the console uses it
      // is decided by the daemon's status file.
      expect(await call(REQUEST)).toEqual(UNREACHABLE);
      await publishStatus(paths, [], { pid: process.pid + 1 });
      expect(await call(REQUEST)).toEqual(UNREACHABLE);
      const stale = new Date(Date.now() - 60_000).toISOString();
      await publishStatus(paths, [], { pid: process.pid, writtenAt: stale, updatedAt: stale });
      expect(await call(REQUEST)).toEqual(UNREACHABLE);
      await publishStatus(paths, [], { pid: process.pid, state: "stopped" });
      expect(await call(REQUEST)).toEqual(UNREACHABLE);
      expect(handed).toEqual([]);
      // It names the door's process, and its heartbeat is of now.
      await publishStatus(paths, [], { pid: process.pid });
      expect(await call(REQUEST)).toEqual({ ok: true, reply: { reached: "the door" } });
      expect(handed).toEqual([REQUEST]);
    } finally {
      await door.close();
      await cleanup();
    }
  });
});

// ── From a signed-in request to the real Databases module ────────────────────

describe("an act, from the console to the Databases module", () => {
  let c: Console;
  let rig: Rig;
  afterEach(async () => {
    await c?.stop();
    await rig?.cleanup();
  });

  async function boot(): Promise<{ operator: string; reader: string }> {
    rig = await makeRig({
      enabled: ["session_vault", "databases"],
      // The real clock: the console's call to the door says the time of now.
      deps: { catalog: DATABASES_TEST_CATALOG, clock: () => new Date() },
      start: false,
    });
    // As the daemon provides it: no launcher for a helper program yet.
    rig.host.provide(createDatabasesModule({ ports: createStandInPorts() }));
    await rig.host.start();
    await rig.registry.startAll(["session_vault", "databases"]);
    await rig.host.started();
    // What the daemon's runtime writes for the console to read: which process
    // is the daemon now.
    await publishStatus(rig.paths, [{ id: "databases", state: "running" }], { pid: process.pid });
    c = await startConsole({
      catalog: DATABASES_TEST_CATALOG,
      // The console's real way to the daemon, as the console itself builds
      // it: the door's file, the daemon's status file, and a socket.
      door: consoleActDoor(rig.paths),
    });
    c.enabled.value = ["session_vault", "databases"];
    return { operator: await tokenFor(c, "marta", "operator"), reader: await tokenFor(c, "ruth", "readonly") };
  }

  test("an operator adds a connection, and everyone signed in can read it", async () => {
    const { operator, reader } = await boot();
    const added = await post(c, actPath("databases", "connection.add"), { args: PERMITS }, { [SESSION_HEADER]: operator });
    expect([added.status, await added.json()]).toEqual([200, { reply: { name: "Northstar permits" } }]);

    const read = await post(c, actPath("databases", "connections.read"), {}, { [SESSION_HEADER]: reader });
    expect(read.status).toBe(200);
    const { reply } = (await read.json()) as { reply: { connections: Record<string, unknown>[] } };
    expect(reply.connections).toHaveLength(1);
    expect(reply.connections[0]).toMatchObject({
      name: "Northstar permits",
      engine: "sqlserver",
      host: "sql01.northstar.example",
      port: 1433,
      user: "permits_reader",
      keyName: "permits-reader",
      addedBy: "marta",
    });

    // The host and the secret's name are on the host's two lists, added by her.
    const dir = path.dirname(rig.paths.moduleState("databases"));
    const reach = JSON.parse(await readFile(path.join(dir, "reach.json"), "utf8")) as { entries: Record<string, unknown>[] };
    expect(reach.entries).toMatchObject([{ host: "sql01.northstar.example", port: 1433, addedBy: "marta" }]);
    const names = JSON.parse(await readFile(path.join(dir, "secret-names.json"), "utf8")) as { entries: Record<string, unknown>[] };
    expect(names.entries).toMatchObject([{ name: "permits-reader", addedBy: "marta" }]);

    // The trail: her act, the two changes inside it, and the module's own line.
    // All of it is under her login. The host writes her login on the module's
    // line as well, because the module wrote it while it carried out her act.
    const hers = (await spoolRecords(rig.paths)).filter((record) => record.actor === "marta");
    expect(hers.map((record) => `${record.action} ${record.kind} ${record.outcome ?? "-"}`)).toEqual([
      "console.module.act intent -",
      "console.module.reach.add intent -",
      "console.module.reach.add outcome ok",
      "console.module.secret.add intent -",
      "console.module.secret.add outcome ok",
      "module.databases.connection.add outcome done",
      "console.module.act outcome ok",
    ]);
    // The module's line names the connection, which the act's own pair does not.
    expect(hers.find((record) => record.action === "module.databases.connection.add")?.params).toMatchObject({
      target: "Northstar permits",
    });
    // Every record of the module's own is under somebody's login here: nothing
    // of this act was written under nobody's.
    expect(
      (await spoolRecords(rig.paths)).filter((record) => record.action.startsWith("module.") && record.actor === null),
    ).toEqual([]);
    // The read left no record of its own.
    expect((await spoolRecords(rig.paths)).some((record) => record.actor === "ruth")).toBe(false);
  });

  test("a read-only person cannot add one, and an address this HX Fortress refuses is not added for anybody", async () => {
    const { operator, reader } = await boot();
    const refused = await post(c, actPath("databases", "connection.add"), { args: PERMITS }, { [SESSION_HEADER]: reader });
    expect([refused.status, await refused.json()]).toEqual([403, { error: READONLY_REFUSAL_COPY }]);
    // The try is in the audit trail under her login, with the rule that
    // decided it, and with nothing of what she asked for.
    const tries = (await spoolRecords(rig.paths)).filter((record) => record.actor === "ruth");
    expect(tries).toMatchObject([
      {
        action: AUDIT_ACTIONS.consoleModuleAct,
        outcome: "refused",
        params: { module: "databases", act: "connection.add", rule: "role" },
      },
    ]);
    expect(JSON.stringify(tries)).not.toContain("sql01.northstar.example");
    expect(JSON.stringify(tries)).not.toContain("permits");
    const metadata = await post(c, actPath("databases", "connection.add"), { args: { ...PERMITS, host: "169.254.169.254" } }, { [SESSION_HEADER]: operator });
    expect([metadata.status, await metadata.json()]).toEqual([422, { error: "failed:reach_address_refused" }]);
    const own = await post(c, actPath("databases", "connection.add"), { args: { ...PERMITS, host: "localhost" } }, { [SESSION_HEADER]: operator });
    expect(await own.json()).toEqual({ error: "failed:reach_address_refused" });
    const read = await post(c, actPath("databases", "connections.read"), {}, { [SESSION_HEADER]: operator });
    expect(await read.json()).toEqual({ reply: { connections: [] } });
    const rules = (await spoolRecords(rig.paths))
      .filter((record) => record.action === AUDIT_ACTIONS.consoleModuleReachAdd)
      .map((record) => (record.params as { rule?: string } | null)?.rule);
    expect(rules).toEqual(["reach_address_refused"]);
  });

  test("with the daemon stopped, the console says that the daemon cannot be reached", async () => {
    const { operator } = await boot();
    await rig.host.stop();
    const res = await post(c, actPath("databases", "connections.read"), {}, { [SESSION_HEADER]: operator });
    expect([res.status, await res.json()]).toEqual([503, { error: DAEMON_UNREACHABLE }]);
  });
});
