// `hx-fortress install`: the command, and its setup page served on an
// engineer's own computer. Every place is a stand-in, no browser is opened
// (each test gives its own opener, or none), and nothing is written on this
// computer: the install's folder does not exist after any test here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";

import { runInstallCommand, type InstallCommandDeps } from "../src/cli-install";
import { installPaths, INSTALL_PORT, openerPage, openInBrowser, runBrowserInstall, type BrowserInstallOptions } from "../src/install/browser";
import { INSTALL_PLACES, stepsAsked, type SetupStep } from "../src/setup/list";
import type { SetupRun } from "../src/setup/run";
import { FORTRESS_SETUP_API, SETUP_SESSION_HEADER } from "../src/ui/wire";
import { providers, StandInPlace, until } from "./install-rig";
import { INSTALL_ID, PAGES, scripted, setupPages } from "./setup-rig";

// Built at run time so no secret-shaped literal sits in the repository.
const TYPED = ["sk", "ant", "typed", "Rb6uNotAReal0ne"].join("-");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const absent = async (folder: string): Promise<boolean> => stat(folder).then(() => false, () => true);

// The install keeps nothing on this computer. Its folder is named, and never made.
beforeEach(async () => {
  expect(await absent(installPaths().root)).toBe(true);
});
afterEach(async () => {
  expect(await absent(installPaths().root)).toBe(true);
});

/** A settings file for Northstar's install, which every check of the install passes. */
function northstarFile(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    where: { place: "azure", region: "eastus2" },
    organization: { name: "Northstar", firstAdministrator: "marta.lindqvist" },
    keys: { store: "azure-key-vault", vault: "northstar-hx-fortress" },
    address: { hostname: "hx.northstar.example", certificate: "cloud-issued" },
    model: false,
    ...over,
  });
}

async function command(
  args: string[],
  over: Partial<InstallCommandDeps> = {},
): Promise<{ code: number; out: string[]; place: StandInPlace }> {
  const out: string[] = [];
  const place = new StandInPlace("azure");
  const code = await runInstallCommand(args, {
    writeLine: (line) => out.push(line),
    env: {},
    isTty: false,
    places: [place],
    run: { check: { fetch: providers().fetch, timeoutMs: 2_000 } },
    browser: async () => {
      throw new Error("no browser in this test");
    },
    ...over,
  });
  return { code, out, place };
}

// ── The command ──────────────────────────────────────────────────────────────

describe("hx-fortress install", () => {
  test("an option it does not know is refused, and repeated only when it is a word", async () => {
    const flag = await command(["--everything"]);
    expect(flag.code).toBe(1);
    expect(flag.out[0]).toBe("error: unknown option --everything");
    expect(flag.out.join("\n")).toContain("usage: hx-fortress install");
    const pasted = await command([`--${["postgres", "user:pw@db"].join("://")}`]);
    expect(pasted.out[0]).toBe("error: unknown option (not shown)");
    const stray = await command(["azure"]);
    expect(stray.out[0]).toBe("error: hx-fortress install takes options only");
    const help = await command(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out.join("\n")).toContain(`questions: ${stepsAsked("install").join(", ")}`);
  });

  test("--connect with a bad value is refused in a sentence that does not repeat the value", async () => {
    for (const value of [`control.example/${INSTALL_ID}`, `http://control.example/i/${INSTALL_ID}`, `control.example/i/${TYPED};x`]) {
      const { code, out } = await command(["--connect", value, "--file", "f.json"], {
        readFile: async () => {
          throw new Error("the file is not read when --connect is refused");
        },
      });
      expect(code).toBe(1);
      expect(out).toEqual(["error: --connect needs a control plane's address and a one-time install id, written as <address>/i/<id>"]);
      expect(out.join("\n")).not.toContain(INSTALL_ID);
      expect(out.join("\n")).not.toContain("Rb6u");
    }
    const pages = await command(["--connect", `control.example/i/${INSTALL_ID}`, "--pages", `${PAGES}/x`]);
    expect(pages.out).toEqual(["error: --pages needs one origin, written as https://host, with no path"]);
  });

  test("--list prints the list for each place this command asks about, with only what this build has", async () => {
    const { code, out } = await command(["--list"], { places: [] });
    expect(code).toBe(0);
    const printed = JSON.parse(out.join("\n")) as Record<string, SetupStep[]>;
    expect(Object.keys(printed)).toEqual([...INSTALL_PLACES]);
    for (const place of INSTALL_PLACES) {
      // The lookup is by a place of the list itself.
      // eslint-disable-next-line security/detect-object-injection
      const list = printed[place] ?? [];
      expect([place, list.map((step) => step.id)]).toEqual([place, stepsAsked("install")]);
      const options = list.flatMap((step) => step.blocks.flatMap((block) => (block.kind === "choice" ? block.options : [])));
      expect(options.every((option) => option.built)).toBe(true);
    }
  });

  test("a build with no place to install into says so before it serves anything", async () => {
    let served = 0;
    const { code, out } = await command([], {
      places: [],
      browser: async () => {
        served += 1;
        return 0;
      },
    });
    expect(code).toBe(1);
    expect(out).toEqual([
      "error: this build has no place to install HX Fortress into yet.",
      "Set it up on the machine it runs on instead: hx-fortress setup",
    ]);
    expect(served).toBe(0);
  });

  test("--file makes HX Fortress in the stand-in place, says each row as it is made, and prints no link when its output is not a terminal", async () => {
    const { code, out, place } = await command(["--file", "hx-fortress.install.json"], {
      readFile: async () => northstarFile(),
      outputIsTty: false,
    });
    expect(code).toBe(0);
    expect(place.makes).toBe(1);
    expect(out[0]).toBe("In your Azure, East US 2");
    for (const row of place.handOver.rows) expect(out).toContain(`  ok  ${row.label}: ${row.value}`);
    expect(out).toContain("HX Fortress is live at https://hx.northstar.example");
    expect(out).toContain(
      "The link that sets the password of marta.lindqvist is in a file on HX Fortress's own disk, which only its user can read. It is not shown here.",
    );
    const said = out.join("\n");
    expect(said).not.toContain("#t=");
    expect(said).not.toContain("#s=");
    // No token was made: nothing could show its link.
    expect(place.handOver.environment.FORTRESS_UI_BOOTSTRAP_TOKEN_DIGEST).toBeUndefined();
  });

  test("--file at a terminal prints the first administrator's link, built on the address that was made", async () => {
    const { code, out } = await command(["--file", "hx-fortress.install.json"], {
      readFile: async () => northstarFile(),
      outputIsTty: true,
    });
    expect(code).toBe(0);
    expect(out).toContain("The account marta.lindqvist sets its password once, within 23 hours, at:");
    expect(out.some((line) => line.startsWith("  https://hx.northstar.example/setup#t="))).toBe(true);
  });

  test("--file with a control plane hands over its install id, and says it nowhere", async () => {
    const { code, out, place } = await command(
      ["--connect", `control.example/i/${INSTALL_ID}`, "--pages", PAGES, "--file", "hx-fortress.install.json"],
      { readFile: async () => northstarFile() },
    );
    expect(code).toBe(0);
    expect(place.handOver.secretEnvironment.FORTRESS_ENROLL_TOKEN).toBe(INSTALL_ID);
    expect(place.handOver.environment.FORTRESS_CONTROL_PLANE_PAGES).toBe(PAGES);
    expect(out.join("\n")).not.toContain(INSTALL_ID);
    expect(out).toContain("  ok  Control plane: control.example, as Northstar");
  });

  test("--file refuses a wrong file, or an answer that fails its check, and makes nothing", async () => {
    const wrong = await command(["--file", "f.json"], {
      readFile: async () => northstarFile({ keys: { store: "aws-secrets-manager" } }),
    });
    expect(wrong.code).toBe(1);
    expect(wrong.out[0]).toBe("The settings file is refused:");
    expect(wrong.out).toContain("  no  keys.store: AWS Secrets Manager is not in this build yet. It can be azure-key-vault, env, file");
    expect(wrong.out.at(-1)).toBe("Nothing was made.");
    expect(wrong.place.makes).toBe(0);

    const refused = await command(["--file", "f.json"], {
      readFile: async () => northstarFile({ address: { hostname: "https://hx.northstar.example", certificate: "cloud-issued" } }),
    });
    expect(refused.code).toBe(1);
    expect(refused.out).toEqual(["An answer is refused:", "  no  Address: A hostname, such as hx.your-company.com", "Nothing was made."]);
    expect(refused.place.makes).toBe(0);

    const unread = await command(["--file", "/no/such/file.json"], {
      readFile: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(unread.out).toEqual(["error: the settings file /no/such/file.json could not be read"]);
    expect((await command(["--file"])).out).toEqual(["error: --file needs the path of a settings file"]);
  });

  test("--file whose making fails says where, and that what was made is still there", async () => {
    const place = new StandInPlace("azure");
    place.failNext = { at: "dns", kind: "make", text: "The DNS zone northstar.example is not one this account holds" };
    const out: string[] = [];
    const code = await runInstallCommand(["--file", "f.json"], {
      writeLine: (line) => out.push(line),
      env: {},
      isTty: false,
      places: [place],
      readFile: async () => northstarFile(),
      run: { check: { fetch: providers().fetch } },
    });
    expect(code).toBe(1);
    expect(out).toContain("  no  DNS record: The DNS zone northstar.example is not one this account holds");
    expect(out.at(-1)).toBe("What was made so far is still there. Run the command again to go on.");
  });

  test("--terminal asks in a terminal, and with none it names the other way", async () => {
    const none = await command(["--terminal"], { isTty: false });
    expect(none.code).toBe(1);
    expect(none.out[0]).toBe("error: hx-fortress install --terminal asks its questions in a terminal, and there is none here.");

    const io = scripted({
      "Organization, such as": "Northstar",
      "First administrator, such as": "marta.lindqvist",
      "Address, such as": "hx.northstar.example",
      "API key": TYPED,
    });
    const { code, out, place } = await command(["--terminal"], { isTty: true, outputIsTty: true, io });
    expect(code).toBe(0);
    expect(place.makes).toBe(1);
    expect(io.secrets).toEqual(["  API key:"]);
    expect([...io.out, ...out].join("\n")).not.toContain(TYPED);
    expect(out.some((line) => line.startsWith("  https://hx.northstar.example/setup#t="))).toBe(true);
  });

  test("with no option it serves the setup in a browser, on the port given, with the places and the control plane", async () => {
    const seen: BrowserInstallOptions[] = [];
    const browser = async (options: BrowserInstallOptions): Promise<number> => {
      seen.push(options);
      return 0;
    };
    const { code } = await command(["--port", "9200", "--no-open", "--connect", `control.example/i/${INSTALL_ID}`], { browser });
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ port: 9200, noOpen: true, isTty: false });
    expect(seen[0]?.run?.places).toHaveLength(1);
    expect(seen[0]?.run?.connect).toEqual({ address: "control.example", id: INSTALL_ID });
    for (const port of ["0", "65536", "eighty", ""]) {
      const bad = await command(["--port", port], { browser });
      expect([port, bad.out]).toEqual([port, ["error: --port needs a number from 1 to 65535"]]);
    }
    expect(seen).toHaveLength(1);
  });
});

// ── The page, on this computer ───────────────────────────────────────────────

interface Served {
  exit: Promise<number>;
  lines: string[];
  link: string;
  port: number;
  run: SetupRun;
  stop: () => void;
  opened: string[];
}

async function serveInstall(place: StandInPlace, over: Partial<BrowserInstallOptions> = {}): Promise<Served> {
  const lines: string[] = [];
  const opened: string[] = [];
  let stop: () => void = () => {};
  const stopSignal = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const assets = await setupPages((cleanup) => cleanups.push(cleanup));
  const listening = Promise.withResolvers<{ link: string; port: number; run: SetupRun }>();
  const exit = runBrowserInstall({
    env: {},
    writeLine: (line) => lines.push(line),
    isTty: false,
    port: 0,
    open: (url) => {
      opened.push(url);
      return true;
    },
    run: { places: [place], check: { fetch: providers().fetch, timeoutMs: 2_000 } },
    loadAssets: async () => assets,
    stopSignal,
    onListening: (info) => listening.resolve(info),
    ...over,
  });
  void exit.then((code) => listening.reject(new Error(`the install ended with ${code}: ${lines.join(" | ")}`)));
  const info = await listening.promise;
  cleanups.push(async () => {
    stop();
    await exit.catch(() => {});
  });
  return { exit, lines, link: info.link, port: info.port, run: info.run, stop, opened };
}

async function post(served: Served, route: string, session: string | null, body: unknown): Promise<Response> {
  const origin = `http://127.0.0.1:${served.port}`;
  return fetch(`${origin}${FORTRESS_SETUP_API}/${route}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...(session ? { [SETUP_SESSION_HEADER]: session } : {}) },
    body: JSON.stringify(body),
  });
}

async function get(served: Served, route: string, session: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${served.port}${FORTRESS_SETUP_API}/${route}`, { headers: { [SETUP_SESSION_HEADER]: session } });
}

describe("hx-fortress install in a browser", () => {
  test("it listens on this computer's own address only, and hands the link to the opener", async () => {
    const served = await serveInstall(new StandInPlace("azure"));
    expect(served.opened).toEqual([served.link]);
    // The address, never the name `localhost`: a name may be answered at ::1, where the setup does not listen.
    expect(served.link).toStartWith(`http://127.0.0.1:${served.port}/setup#s=`);
    expect(served.lines).toContain(`Setup is open at http://127.0.0.1:${served.port}, on this computer only.`);
    // The link was handed to the opener, and not printed.
    const token = new URL(served.link).hash.slice("#s=".length);
    expect(served.lines.join("\n")).not.toContain(token);
    expect((await fetch(`http://127.0.0.1:${served.port}/setup`)).status).toBe(200);
    // Not on any other address of this computer.
    const others = Object.values(os.networkInterfaces())
      .flat()
      .filter((address) => address !== undefined && address.family === "IPv4" && !address.internal);
    for (const other of others) {
      const answered = await fetch(`http://${other?.address}:${served.port}/setup`, { signal: AbortSignal.timeout(1_000) }).then(
        () => "answers",
        () => "silent",
      );
      expect([other?.address, answered]).toEqual([other?.address, "silent"]);
    }
  });

  test("a whole install over the wire writes nothing on this computer, and ends when the page has seen the last screen", async () => {
    const place = new StandInPlace("azure");
    const served = await serveInstall(place);
    const token = new URL(served.link).hash.slice("#s=".length);
    const opened = await post(served, "open", null, { token });
    expect(opened.status).toBe(200);
    const session = ((await opened.json()) as { session: string }).session;
    const answers = {
      organization: { name: "Northstar", firstAdministrator: "marta.lindqvist" },
      address: { hostname: "hx.northstar.example" },
    };
    expect((await post(served, "typed", session, { path: "model.key", value: TYPED })).status).toBe(200);
    const created = await post(served, "create", session, { answers });
    expect(created.status).toBe(200);
    expect(((await created.json()) as { checks?: unknown }).checks).toBeUndefined();
    await until(() => served.run.done() !== null, "the install to be made");
    const state = (await (await get(served, "state", session)).json()) as { done: { address: string; firstAccount: { link: string } } };
    expect(state.done.address).toBe("https://hx.northstar.example");
    expect(state.done.firstAccount.link).toStartWith("https://hx.northstar.example/setup#t=");
    // The listener waits for the page's word, with no limit of its own.
    expect(await Promise.race([served.exit, new Promise((resolve) => setTimeout(() => resolve("waiting"), 50))])).toBe("waiting");
    expect((await post(served, "seen", session, {})).status).toBe(200);
    expect(await served.exit).toBe(0);
    expect(served.lines.at(-1)).toBe("HX Fortress is live at https://hx.northstar.example. The setup is closed.");
    expect(served.lines.join("\n")).not.toContain(TYPED);
    expect(place.makes).toBe(1);
  });

  test("stopped before the last step, it says that nothing was made", async () => {
    const served = await serveInstall(new StandInPlace("azure"));
    served.stop();
    expect(await served.exit).toBe(1);
    expect(served.lines.at(-1)).toBe("Setup stopped. Nothing was made.");
  });

  test("with no browser and no terminal it refuses, and prints no link", async () => {
    const lines: string[] = [];
    const code = await runBrowserInstall({
      env: {},
      writeLine: (line) => lines.push(line),
      isTty: false,
      port: 0,
      open: () => false,
      run: { places: [new StandInPlace("azure")] },
      loadAssets: () => setupPages((cleanup) => cleanups.push(cleanup)),
      stopSignal: new Promise<void>(() => {}),
    });
    expect(code).toBe(1);
    expect(lines).toContain("error: no browser could be opened, and the setup's link is shown only in a terminal.");
    expect(lines.join("\n")).not.toContain("#s=");
  });

  test("with no browser at a terminal it prints the link there", async () => {
    const served = await serveInstall(new StandInPlace("azure"), { open: () => false, isTty: true });
    expect(served.lines).toContain(`  ${served.link}`);
  });

  test("a port a person named is not moved when it is taken", async () => {
    const holder = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("taken") });
    cleanups.push(async () => {
      await holder.stop(true);
    });
    const port = holder.port ?? 0;
    const lines: string[] = [];
    const code = await runBrowserInstall({
      env: {},
      writeLine: (line) => lines.push(line),
      isTty: true,
      port,
      noOpen: true,
      run: { places: [new StandInPlace("azure")] },
      loadAssets: () => setupPages((cleanup) => cleanups.push(cleanup)),
      stopSignal: new Promise<void>(() => {}),
    });
    expect(code).toBe(1);
    expect(lines).toEqual([
      `error: port ${port} is in use on this computer, so the setup cannot be served there.`,
      "Give another port: hx-fortress install --port <n>",
    ]);
  });

  // The one test of the port rule: it holds the install's own port, which is fixed.
  test("when its own port is taken it moves to the next one", async () => {
    let holder: ReturnType<typeof Bun.serve> | null = null;
    try {
      holder = Bun.serve({ port: INSTALL_PORT, hostname: "127.0.0.1", fetch: () => new Response("taken") });
    } catch {
      // Something else holds it already, which is the same for this test.
    }
    cleanups.push(async () => {
      await holder?.stop(true);
    });
    const served = await serveInstall(new StandInPlace("azure"), { port: null, noOpen: true, isTty: true });
    expect(served.port).toBeGreaterThan(INSTALL_PORT);
    expect(served.port).toBeLessThanOrEqual(INSTALL_PORT + 10);
    // The address, never the name `localhost`: a name may be answered at ::1, where the setup does not listen.
    expect(served.link).toStartWith(`http://127.0.0.1:${served.port}/setup#s=`);
  });
});

describe("the page that hands the link to the system's browser", () => {
  test("a link cannot end its script, whatever it holds", () => {
    const link = `http://localhost:${INSTALL_PORT}/setup#s=a</script><script>alert(1)</script>"'\\\n\u2028`;
    const page = openerPage(link);
    const script = page.slice(page.indexOf("<script>") + "<script>".length);
    // The only "<" after the opening tag is the closing tag's.
    expect(script.indexOf("<")).toBe(script.length - "</script>".length);
    expect(script.endsWith("</script>")).toBe(true);
    // And the script sends the browser to exactly that link.
    const target = /^location\.replace\((.*)\);<\/script>$/s.exec(script)?.[1] ?? "";
    expect(JSON.parse(target)).toBe(link);
    expect(page).not.toContain("\n");
  });

  test("on a system with no opener nothing is opened and no folder is made", async () => {
    const before = (await readdir(os.tmpdir())).filter((name) => name.startsWith("hx-fortress-open-"));
    const forget: (() => Promise<void>)[] = [];
    expect(await openInBrowser(`http://localhost:${INSTALL_PORT}/setup#s=x`, forget, "win32")).toBe(false);
    expect(forget).toEqual([]);
    const after = (await readdir(os.tmpdir())).filter((name) => name.startsWith("hx-fortress-open-"));
    expect(after.sort()).toEqual(before.sort());
  });
});
