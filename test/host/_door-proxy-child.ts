// Run as a process of its own by local-door.test.ts.
//
// It names a proxy in its own environment and then calls the door, to show
// that the console's side of the door does not go through it. It is a process
// of its own because the runtime keeps using a proxy once it has seen one in
// the environment, also after the variable is removed: set in the test's own
// process, the proxy would stay in the way of every test that runs after it.
//
// Prints one line of JSON.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DOOR_ACT_PATH, LocalDoor } from "../../src/host/local-door";
import { readDoorFile, sendAct, type ActRequest } from "../../src/host/local-door-client";

const root = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-door-proxy-"));
const file = path.join(root, "runtime", "local-door.json");
const handed: unknown[] = [];
const door = new LocalDoor({
  file,
  act: async (request) => {
    handed.push(request);
    return { ok: true, reply: { reached: "the door" } };
  },
  refused: () => {},
  logger: { debug() {}, info() {}, warn() {}, error() {} },
});
const seen: string[] = [];
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (req) => {
    seen.push(`${req.method} ${new URL(req.url).pathname} authorization=${req.headers.has("authorization") ? "sent" : "none"}`);
    return new Response("from the proxy");
  },
});
try {
  await door.open();
  const opened = await readDoorFile(file);
  if (!opened) throw new Error("the door did not open");
  for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    process.env[name] = `http://127.0.0.1:${proxy.port}`;
  }
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  // What the door's caller must not do: the runtime's own `fetch` goes through the proxy.
  const viaFetch = await fetch(`http://127.0.0.1:${opened.port}${DOOR_ACT_PATH}`, {
    method: "POST",
    headers: { authorization: "HXDoor a-code-of-the-caller" },
    body: "{}",
  }).then((response) => response.text());
  const sawFromFetch = seen.splice(0);
  const request: ActRequest = {
    v: 1,
    person: { login: "maya.chen", email: null, role: "operator" },
    session: null,
    module: "probe",
    act: "things.read",
    args: {},
  };
  const viaSendAct = await sendAct(file, request);
  console.log(JSON.stringify({ viaFetch, sawFromFetch, viaSendAct, sawFromSendAct: seen, handed: handed.length }));
} finally {
  await door.close();
  await proxy.stop(true);
  await rm(root, { recursive: true, force: true });
}
