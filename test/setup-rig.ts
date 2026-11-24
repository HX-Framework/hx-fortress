// What the setup's tests share.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { VaultCredentials } from "../src/modules/session-vault/credentials";
import type { Connect, SetupRun, SetupRunDeps } from "../src/setup/run";
import type { TerminalIo } from "../src/setup/terminal";
import { manifestOf, mapDistDir, type UiAssets } from "../src/ui/assets";
import { createSetupHandler, mintSetupLink, type SetupRequestHandler, type SetupServerCtx } from "../src/ui/setup-server";
import { FORTRESS_SETUP_API, SETUP_SESSION_HEADER } from "../src/ui/wire";
import { fixedSecrets, type Paths } from "./host/_module-rig";

// Built at run time so no secret-shaped literal sits in the repository.
export const DB_URL = ["postgres://hx:", "pw-for-a-test", "@db.northstar.example:5432/hx"].join("");
/** A one-time install id, as a control plane writes it into a command. */
export const INSTALL_ID = ["install", "id", "for", "a", "test"].join("-");
/** The connection address of the control plane at control.example. */
export const CONTROL = "wss://control.example/v1/connection";
/** Where an HX Fortress made before this build connected to the same control plane. */
export const EARLIER_CONTROL = "wss://control.example/_api/hx-gateway/vault-tunnel";
/** The origin of the control plane's own pages. */
export const PAGES = "https://app.control.example";
/** What `--connect` gives for control.example. */
export const CONNECT: Connect = { address: "control.example", id: INSTALL_ID };

/** Three modules of this build, by id: what these tests hand the setup's
 *  functions. The build's own list is its catalog. */
export const MODULES = ["session_vault", "host", "databases"];

/**
 * A sign-in provider's description of itself, as one that the console accepts
 * gives it: the issuer, and https addresses for sign-in, tokens and keys.
 */
export function providerDocument(issuer: string): Record<string, unknown> {
  const base = issuer.replace(/\/+$/, "");
  return {
    issuer,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    jwks_uri: `${base}/keys`,
    id_token_signing_alg_values_supported: ["RS256"],
  };
}

/** What the Agentic Sessions credentials file would hold, kept in memory: a
 *  test never reads or writes the one in the home folder of whoever runs it. */
export function vault(initial: VaultCredentials | null = null): {
  current: VaultCredentials | null;
  read: () => Promise<VaultCredentials | null>;
  update: NonNullable<NonNullable<SetupRunDeps["apply"]>["updateVaultCredentials"]>;
} {
  const box = {
    current: initial,
    read: async (): Promise<VaultCredentials | null> => box.current,
    update: async (mutate: (current: VaultCredentials | null) => VaultCredentials) => {
      const next = mutate(box.current);
      const version = (box.current?.version ?? 0) + 1;
      box.current = { ...next, version };
      return { credentials: box.current, version };
    },
  };
  return box;
}

/** A run on the machine itself, with every outside call answered by a fake. */
export function runDeps(paths: Paths, over: Partial<SetupRunDeps> = {}): SetupRunDeps {
  const box = vault();
  return {
    paths,
    env: {},
    read: { vaultCredentials: box.read },
    apply: { updateVaultCredentials: box.update },
    check: {
      keyStore: () => fixedSecrets({ "db-url": DB_URL, "install-id": INSTALL_ID }),
      fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      probeDatabase: async () => "PostgreSQL 17.2",
      probeFiles: async () => {},
      timeoutMs: 2_000,
    },
    ...over,
  };
}

export async function rawConfig(paths: Paths): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(paths.config, "utf8")) as Record<string, unknown>;
}

/** The two answers a new HX Fortress on its plain options needs. */
export function northstar(run: SetupRun): void {
  run.set("organization.name", "Northstar");
  run.set("organization.firstAdministrator", "marta.lindqvist");
}

/** A terminal that types a script. A prompt is answered by the first key of
 *  `answers` that its message holds; Enter keeps the default. */
export interface Scripted extends TerminalIo {
  /** Every line and every prompt, in order. */
  out: string[];
  /** The prompts that were read without showing what was typed. */
  secrets: string[];
}

export function scripted(answers: Record<string, string | boolean>): Scripted {
  const out: string[] = [];
  const secrets: string[] = [];
  let again = 0;
  const answer = <T>(message: string, fallback: T): T => {
    const key = Object.keys(answers).find((k) => message.includes(k));
    // The lookup is by a key the test itself wrote.
    // eslint-disable-next-line security/detect-object-injection
    return key === undefined ? fallback : (answers[key] as unknown as T);
  };
  return {
    out,
    secrets,
    line: (text) => {
      out.push(text);
    },
    text: async (message, options) => {
      out.push(message);
      return answer(message, options?.default ?? "");
    },
    secret: async (message) => {
      out.push(message);
      secrets.push(message);
      return answer(message, "");
    },
    select: async (message, choices, options) => {
      out.push(message);
      const wanted = answer<string | null>(message, null);
      const chosen = wanted === null ? choices[options?.defaultIndex ?? 0] : choices.find((c) => c.label === wanted);
      if (!chosen) throw new Error(`no such choice: ${String(wanted)}`);
      return chosen.value;
    },
    confirm: async (message, options) => {
      out.push(message);
      // A script gives the same answer every time, so a question that is asked
      // again and again would never end. Four times is a failed test.
      if (message.includes("Answer this question again?")) {
        again += 1;
        if (again > 3) throw new Error(`the same question was refused ${again} times:\n${out.slice(-12).join("\n")}`);
      }
      return answer(message, options?.default ?? true);
    },
    sleep: async () => {},
  };
}

/** The console's pages, as far as the setup needs them: a shell and one
 *  script, in a folder of their own that `register` removes. */
export async function setupPages(register: (cleanup: () => Promise<void>) => void): Promise<UiAssets> {
  const dist = await mkdtemp(path.join(os.tmpdir(), "hxf-pages-"));
  register(() => rm(dist, { recursive: true, force: true }));
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await writeFile(path.join(dist, "index.html"), '<!doctype html><div id="root"></div>');
  await writeFile(path.join(dist, "assets", "index-abc123.js"), "export const a = 1;\n");
  const files = mapDistDir(dist);
  return { mode: "disk", files, inlineScriptHashes: [], manifest: await manifestOf(files) };
}

/** The port a handler in these tests says it answers on. No socket is opened. */
export const SETUP_PORT = 9120;
export const SETUP_HOST = `127.0.0.1:${SETUP_PORT}`;
export const SETUP_ORIGIN = `http://${SETUP_HOST}`;

/** The setup's routes, answered in this process, with what each reply said. */
export interface Served {
  handler: SetupRequestHandler;
  token: string;
  /** The text of every reply, in order. */
  replies: string[];
  closed: () => number;
  call(
    method: "GET" | "POST",
    route: string,
    options?: { session?: string | null; body?: unknown; host?: string | null; origin?: string | null },
  ): Promise<{ status: number; body: Record<string, unknown>; text: string }>;
  open(): Promise<string>;
}

export async function serve(
  run: SetupRun,
  over: Partial<SetupServerCtx> & { register: (cleanup: () => Promise<void>) => void },
): Promise<Served> {
  const { register, ...ctxOver } = over;
  const link = mintSetupLink();
  let closed = 0;
  const replies: string[] = [];
  const handler = createSetupHandler({
    assets: await setupPages(register),
    port: SETUP_PORT,
    run,
    link,
    bind: "127.0.0.1",
    publicUrl: null,
    create: () => run.create("browser", null),
    onDone: () => {
      closed += 1;
    },
    doneGraceMs: null,
    ...ctxOver,
  });
  const call: Served["call"] = async (method, route, options = {}) => {
    const headers: Record<string, string> = {};
    const host = options.host === undefined ? SETUP_HOST : options.host;
    if (host !== null) headers.host = host;
    const origin = options.origin === undefined ? SETUP_ORIGIN : options.origin;
    if (method === "POST" && origin !== null) headers.origin = origin;
    if (options.session) headers[SETUP_SESSION_HEADER] = options.session;
    if (method === "POST") headers["content-type"] = "application/json";
    const response = await handler.handle(
      new Request(`http://${SETUP_HOST}${FORTRESS_SETUP_API}/${route}`, {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {}),
      }),
      "127.0.0.1",
    );
    if (!response) throw new Error(`the setup did not answer ${route}`);
    const text = await response.text();
    replies.push(text);
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
  };
  return {
    handler,
    token: link.token,
    replies,
    closed: () => closed,
    call,
    open: async () => {
      const answer = await call("POST", "open", { body: { token: link.token } });
      if (answer.status !== 200) throw new Error(`the link did not open: ${answer.text}`);
      return answer.body.session as string;
    },
  };
}
