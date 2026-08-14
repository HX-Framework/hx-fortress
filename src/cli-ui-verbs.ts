// `hx-fortress ui <verb>` — everything about the console that is not serving it.
//
// Two properties hold across every verb here, and the tests assert both:
//
//   NO CREDENTIAL EVER REACHES THE TERMINAL. Accounts are provisioned by a
//   one-time setup URL, not by a typed password; the database DSN is read from
//   stdin, never from argv, because argv is visible in /proc/<pid>/cmdline, in
//   `ps` and in shell history; `--print-role-sql` emits a SCRAM verifier rather
//   than the password that produced it.
//
//   EVERY WRITE GOES THROUGH ONE DOOR. ui.json and users.json are read live by a
//   serving console in another process, so a verb that rewrote either directly
//   could tear a read or lose a concurrent write. Both stores take an O_EXCL lock
//   and a version CAS; a corrupt file is refused with a remediation and never
//   rebuilt from whatever this build happens to understand.

import os from "node:os";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { CliAudit, cliAuditAct } from "./cli-audit";
import { fortressPaths } from "./host/paths";
import { readPgJson } from "./host/postgres/pg-json";
import { generateRoleSql } from "./host/postgres/print-role-sql";
import { printedUrl } from "./ui/bind";
import {
  checkBind,
  checkPort,
  checkPublicUrl,
  checkSessionIdleMinutes,
  checkSessionTtlHours,
  checkTrustedProxies,
  effectiveUiEnabled,
  isStdinOnlyKey,
  isUiConfigSetKey,
  maskDatabaseUrl,
  printableUiConfig,
  stdinOnlyMessage,
  uiEnabledFromEnv,
  UiConfigStore,
  unknownKeyMessage,
  type UiConfig,
  type UiConfigSetKey,
  type ValueCheck,
} from "./ui/config";
import { detectContainer } from "./ui/container";
import {
  CONTAINER_DISABLE_NOTE,
  DISABLE_PROPAGATION_NOTE,
  ENV_ENABLED_DISABLE_REFUSAL,
  foregroundDisableRefusal,
  PEOPLE_VISIBILITY_DISCLOSURE,
  SETUP_LINK_NOTE,
  ssoRequiresEnablement,
  SSO_ON_DISCLOSURE,
} from "./ui/copy";
import { holderAlive, readInstanceLock } from "./ui/instance";
import { getUiServiceControl, type UiServiceControl } from "./ui/service-control";
import { forceUnlock } from "./ui/store-lock";
import { checkLogin, isUiRole, setupUrl, UsersStore, type UiRole, type UiUser } from "./ui/users";

/** The subcommands that are verbs rather than flags to the serving command. */
export const UI_SUBCOMMANDS = ["config", "user", "sso", "enable", "disable", "marker"] as const;

export function isUiSubcommand(arg: string | undefined): boolean {
  return arg !== undefined && (UI_SUBCOMMANDS as readonly string[]).includes(arg);
}

export interface UiVerbDeps {
  writeLine: (line: string) => void;
  env?: Record<string, string | undefined>;
  fortressRoot?: string;
  platform?: string;
  hostName?: string;
  now?: () => Date;
  /** Reads the whole of stdin. The ONLY channel a secret may arrive on. */
  readStdin?: () => Promise<string>;
  service?: UiServiceControl;
}

interface Ctx {
  write: (line: string) => void;
  audit: CliAudit;
  env: Record<string, string | undefined>;
  paths: ReturnType<typeof fortressPaths>;
  usersFile: string;
  instanceLock: string;
  config: UiConfigStore;
  users: UsersStore;
  service: UiServiceControl;
  platform: string;
  hostName: string;
  now: () => Date;
  readStdin: () => Promise<string>;
  forceUnlock: boolean;
}

async function readAllStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function makeCtx(args: readonly string[], deps: UiVerbDeps): { ctx: Ctx; rest: string[] } {
  const rest = args.filter((a) => a !== "--force-unlock");
  const paths = fortressPaths(deps.fortressRoot);
  const usersFile = path.join(paths.uiRoot, "users.json");
  const ctx: Ctx = {
    write: deps.writeLine,
    audit: new CliAudit({
      dir: paths.auditSpool,
      ...(deps.now ? { now: deps.now } : {}),
      onWarn: (message) => deps.writeLine(`warning: the audit record was incomplete - ${message}`),
    }),
    env: deps.env ?? process.env,
    paths,
    usersFile,
    instanceLock: path.join(paths.uiRoot, "instance.lock"),
    config: new UiConfigStore(paths.uiConfig),
    users: new UsersStore(usersFile),
    service: deps.service ?? getUiServiceControl({ platform: deps.platform }),
    platform: deps.platform ?? process.platform,
    hostName: deps.hostName ?? os.hostname(),
    now: deps.now ?? ((): Date => new Date()),
    readStdin: deps.readStdin ?? readAllStdin,
    forceUnlock: args.includes("--force-unlock"),
  };
  return { ctx, rest };
}

export async function runUiVerb(args: readonly string[], deps: UiVerbDeps): Promise<number> {
  const { ctx, rest } = makeCtx(args, deps);
  if (ctx.forceUnlock) {
    await forceUnlock(ctx.paths.uiConfig);
    await forceUnlock(ctx.usersFile);
  }
  const dispatch = async (): Promise<number> => {
    switch (rest[0]) {
      case "config":
        return await configVerb(rest.slice(1), ctx);
      case "user":
        return await userVerb(rest.slice(1), ctx);
      case "sso":
        return await ssoVerb(rest.slice(1), ctx);
      case "enable":
        return await enableVerb(ctx);
      case "disable":
        return await disableVerb(ctx);
      case "marker":
        return await markerVerb(rest.slice(1), ctx);
      default:
        throw new Error(`unknown ui subcommand '${rest[0] ?? ""}'`);
    }
  };
  // The record is decided HERE rather than inside each verb, so a verb added
  // later is audited by default - the same rule the route classes follow, for
  // the same reason. The two reading verbs are the only ones that opt out.
  const act = cliAuditAct(rest);
  if (!act) return await dispatch();
  return await ctx.audit.run(act.action, act.params, dispatch);
}

// -- config ------------------------------------------------------------------

async function configVerb(args: readonly string[], ctx: Ctx): Promise<number> {
  if (args[0] === "--print-role-sql") return await printRoleSql(ctx);
  if (args[0] === "set") return await configSet(args.slice(1), ctx);
  if (args.length > 0) throw new Error(`usage: hx-fortress ui config [set <key> <value>] [--print-role-sql]`);

  const config = await ctx.config.load();
  ctx.write("HX Fortress console configuration");
  ctx.write(`  file: ${ctx.paths.uiConfig}`);
  for (const [key, value] of printableUiConfig(config)) {
    ctx.write(`  ${key}: ${value}`);
  }
  if (uiEnabledFromEnv(ctx.env) && !config.enabled) {
    ctx.write("  (enabled by FORTRESS_UI_ENABLE in the service environment)");
  }
  ctx.write(`  root: ${ctx.paths.root}`);
  const daemonRoot = await readDaemonRoot(ctx);
  ctx.write(`  daemon root: ${daemonRoot ?? "(unknown — the daemon has not written status.json)"}`);
  return 0;
}

async function readDaemonRoot(ctx: Ctx): Promise<string | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(ctx.paths.status, "utf8"));
    const host = (raw as { host?: { root?: unknown } }).host;
    return typeof host?.root === "string" ? host.root : null;
  } catch {
    return null;
  }
}

const SET_VALIDATORS: Record<
  Exclude<UiConfigSetKey, "databaseUrl">,
  (raw: string, config: UiConfig, ctx: Ctx) => ValueCheck<unknown>
> = {
  publicUrl: (raw) => checkPublicUrl(raw),
  trustedProxies: (raw) => checkTrustedProxies(raw),
  port: (raw) => checkPort(raw),
  bind: (raw, config, ctx) =>
    checkBind(raw, {
      publicUrl: config.publicUrl,
      port: config.port,
      env: ctx.env,
      platform: ctx.platform,
      container: detectContainer({ env: ctx.env, platform: ctx.platform }),
      allowInsecureBind: config.allowInsecureBind,
    }),
  sessionTtlHours: (raw) => checkSessionTtlHours(raw),
  sessionIdleMinutes: (raw) => checkSessionIdleMinutes(raw),
};

async function configSet(args: readonly string[], ctx: Ctx): Promise<number> {
  const key = args[0];
  if (!key) throw new Error(`usage: hx-fortress ui config set <key> <value>`);
  if (!isUiConfigSetKey(key)) throw new Error(unknownKeyMessage(key));

  if (isStdinOnlyKey(key)) {
    // Enumerated so this refusal can be SPECIFIC. A generic unknown-key message
    // here would send the operator looking for a key that does exist.
    if (args[1] !== "--stdin") throw new Error(stdinOnlyMessage(key));
    const value = (await ctx.readStdin()).trim();
    if (!value) throw new Error(`nothing arrived on stdin for ${key}`);
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`${key} must be a connection URL`);
    }
    if (!parsed.protocol.startsWith("postgres")) {
      throw new Error(`${key} must be a postgres:// or postgresql:// URL`);
    }
    await ctx.config.update((current) => ({ ...current, databaseUrl: value }));
    ctx.write(`ui.json databaseUrl set (${parsed.protocol}//${parsed.host}${parsed.pathname}).`);
    return 0;
  }

  const raw = args[1];
  if (raw === undefined) throw new Error(`usage: hx-fortress ui config set ${key} <value>`);
  const current = await ctx.config.load();
  const check = SET_VALIDATORS[key](raw, current, ctx);
  if (!check.ok) throw new Error(check.reason);
  const value = check.value;
  await ctx.config.update((config) => ({ ...config, [key]: value }));
  ctx.write(`ui.json ${key} set to ${Array.isArray(value) ? value.join(", ") || "(none)" : String(value)}.`);
  // The serving console re-reads ui.json per request, so this lands on a running
  // unit with no restart; saying otherwise would send operators bouncing units
  // they do not need to bounce.
  ctx.write("A running console picks this up on its next request.");
  return 0;
}

/** The password arrives on stdin, the emitted SQL carries a SCRAM verifier, and
 *  the DSN that reaches ui.json is written through the 0600 door and printed
 *  masked. No secret exists in argv or on stdout at any point. */
async function printRoleSql(ctx: Ctx): Promise<number> {
  const pgJson = await readPgJson(ctx.paths.pgJson);
  if (!pgJson || pgJson.mode !== "external") {
    throw new Error(
      "this fortress runs the embedded Postgres, which provisions the console role itself. " +
        "--print-role-sql is for an external database: point the daemon at one first.",
    );
  }
  const password = (await ctx.readStdin()).trim();
  if (!password) {
    throw new Error(
      "no password on stdin. Pipe one in: " +
        "`printf %s \"$PW\" | hx-fortress ui config --print-role-sql` — it is never taken from the command line.",
    );
  }
  const generated = generateRoleSql({ password, databaseUrl: pgJson.databaseUrl });
  await ctx.config.update((config) => ({ ...config, databaseUrl: generated.consoleDatabaseUrl }));
  for (const line of generated.sql.split("\n")) ctx.write(line);
  // One masking rule for every DSN this CLI prints: scheme, host, database.
  ctx.write(`-- ui.json databaseUrl set to ${maskDatabaseUrl(generated.consoleDatabaseUrl)}`);
  return 0;
}

// -- enable / disable --------------------------------------------------------

async function enableVerb(ctx: Ctx): Promise<number> {
  await ctx.config.update((config) => ({ ...config, enabled: true }));
  ctx.write("Console enabled.");
  ctx.write("Start it with `hx-fortress ui --install-service`, or run `hx-fortress ui` in the foreground.");
  return 0;
}

/**
 * Flip the setting, stop the service, and revoke every live session.
 *
 * Four arms, because there are four things that can be running the console and
 * only two of them take orders from this file:
 *
 *   • enabled by FORTRESS_UI_ENABLE — a file write changes nothing, so refuse and
 *     name what would;
 *   • a unit — flip, stop, and revoke;
 *   • a SUPERVISED console — flip and revoke. There is no unit to stop, and the
 *     running console is the supervisor's child, not something this shell may
 *     kill: the supervisor re-reads this setting before every respawn and stops
 *     the child when it flips, so writing the file IS the act. Killing the pid
 *     here would be undone by the next respawn;
 *   • a foreground `hx-fortress ui` — no unit, no supervisor, nothing to notice
 *     the flip, so refuse and name the pid rather than silently doing nothing.
 *
 * Which of the last two is which is read off the console's own lock, not off the
 * container detector. A container is not a supervisor: a custom entrypoint or an
 * image built before `container-run` runs the console with nothing watching it,
 * and telling that operator "the supervisor stops it within a few seconds" names
 * a process that does not exist.
 */
async function disableVerb(ctx: Ctx): Promise<number> {
  if (uiEnabledFromEnv(ctx.env)) {
    throw new Error(ENV_ENABLED_DISABLE_REFUSAL);
  }
  const unitInstalled = await ctx.service.installed();
  const holder = unitInstalled ? null : await readInstanceLock(ctx.instanceLock);
  const live = holder && holderAlive(holder) ? holder : null;
  if (live && !live.supervised) {
    throw new Error(foregroundDisableRefusal(live.pid));
  }
  await ctx.config.update((config) => ({ ...config, enabled: false }));
  // The GLOBAL session epoch has exactly one writer, and this is it. Live
  // sessions live in another process's memory; the epoch is how they die.
  const users = await ctx.users.bumpSessionEpoch();
  if (unitInstalled) await ctx.service.stopAndDisable();
  ctx.write("Console disabled.");
  ctx.write(`Live sessions revoked (session epoch ${users.sessionEpoch}).`);
  if (live?.supervised) ctx.write(CONTAINER_DISABLE_NOTE);
  ctx.write(DISABLE_PROPAGATION_NOTE);
  return 0;
}

// -- marker ------------------------------------------------------------------

async function markerVerb(args: readonly string[], ctx: Ctx): Promise<number> {
  if (args[0] === "--clear") {
    await ctx.config.update((config) => ({ ...config, marker: null }));
    ctx.write("Banner phrase cleared.");
    return 0;
  }
  const phrase = args[0]?.trim();
  if (!phrase) throw new Error('usage: hx-fortress ui marker "<phrase>" | --clear');
  if (phrase.length > 80) throw new Error("the banner phrase must be 80 characters or fewer");
  await ctx.config.update((config) => ({ ...config, marker: phrase }));
  ctx.write(`Banner phrase set: ${phrase}`);
  // It renders to arrivals that carry a token, never on a plain sign-in page:
  // a phrase on the pre-auth surface would be a fact about this fortress that
  // anyone who can reach the port could read.
  ctx.write("People arriving through a setup link or the workbench button will see it.");
  return 0;
}

// -- sso ---------------------------------------------------------------------

async function ssoVerb(args: readonly string[], ctx: Ctx): Promise<number> {
  const config = await ctx.config.load();
  if (args[0] === "off") {
    await ctx.config.update((current) => ({ ...current, sso: false }));
    ctx.write("One-click entry from the workbench is off.");
    ctx.write(DISABLE_PROPAGATION_NOTE);
    return 0;
  }
  if (args[0] !== "on") throw new Error("usage: hx-fortress ui sso on|off");

  // When a unit exists, the shell's environment is not the console's: a
  // FORTRESS_UI_* set in this terminal would pass a check the unit can never
  // satisfy, and the operator would learn about it from the workbench.
  const unitInstalled = await ctx.service.installed();
  const env = unitInstalled ? {} : ctx.env;
  const container = detectContainer({ env: ctx.env, platform: ctx.platform });
  if (!effectiveUiEnabled(config, env)) {
    throw new Error(ssoRequiresEnablement(container.container));
  }
  if (!config.publicUrl) {
    throw new Error(
      "one-click entry needs a public https URL for this console — " +
        "set it with `hx-fortress ui config set publicUrl https://…` first",
    );
  }
  const users = await ctx.users.load();
  const operators = users.users.filter((u) => !u.deletedAt && !u.disabledAt && u.role === "operator");
  if (operators.length === 0) {
    throw new Error(
      "one-click entry lands on this console's sign-in form, and no operator account exists to sign in with. " +
        "Create one first: `hx-fortress ui user create <login> --role operator`",
    );
  }
  await ctx.config.update((current) => ({ ...current, sso: true }));
  ctx.write("One-click entry from the workbench is on.");
  for (const line of SSO_ON_DISCLOSURE) ctx.write(line);
  for (const line of PEOPLE_VISIBILITY_DISCLOSURE) ctx.write(line);
  ctx.write(`Console URL advertised to let.ai: ${config.publicUrl}`);
  ctx.write("An organization owner approves it in the workbench before the button appears.");
  return 0;
}

// -- user --------------------------------------------------------------------

async function userVerb(args: readonly string[], ctx: Ctx): Promise<number> {
  switch (args[0]) {
    case "create":
      return await userCreate(args.slice(1), ctx);
    case "list":
      return await userList(ctx);
    case "disable":
      return await userDisable(args.slice(1), ctx);
    case "delete":
      return await userDelete(args.slice(1), ctx);
    case "reset":
      return await userReset(args.slice(1), ctx);
    default:
      throw new Error("usage: hx-fortress ui user create|list|disable|delete|reset");
  }
}

function requireLogin(args: readonly string[], verb: string): string {
  const login = args[0];
  if (!login) throw new Error(`usage: hx-fortress ui user ${verb} <login>`);
  const problem = checkLogin(login);
  if (problem) throw new Error(problem);
  return login;
}

/** A setup link that points at nothing is the failure this guards. Serving is
 *  either a live console on this root or an enablement the supervisor honors -
 *  a foreground console is self-authorizing, so it counts. */
async function assertConsoleServing(ctx: Ctx): Promise<void> {
  const holder = await readInstanceLock(ctx.instanceLock);
  if (holder && holderAlive(holder)) return;
  const config = await ctx.config.load();
  if (effectiveUiEnabled(config, ctx.env)) return;
  const container = detectContainer({ env: ctx.env, platform: ctx.platform });
  throw new Error(
    `${ssoRequiresEnablement(container.container)} — a setup link is only useful once the console answers`,
  );
}

async function printSetupLink(ctx: Ctx, login: string, token: string): Promise<void> {
  const config = await ctx.config.load();
  const url = printedUrl({
    urlOverride: null,
    // The ENV var first, exactly as the advertiser and the runtime resolve it.
    // A container is configured by environment, not by ui.json — so on Railway
    // or Kubernetes, where FORTRESS_UI_PUBLIC_URL is the whole configuration,
    // this printed a link at the BIND address (0.0.0.0/127.0.0.1) that nobody
    // could open, on the one command whose entire output is a link somebody is
    // meant to click.
    publicUrl: ctx.env.FORTRESS_UI_PUBLIC_URL?.trim() || config.publicUrl,
    hostname: config.bind,
    dualStack: false,
    port: config.port,
    hostName: ctx.hostName,
  });
  for (const line of PEOPLE_VISIBILITY_DISCLOSURE) ctx.write(line);
  ctx.write("");
  ctx.write(`Setup link for ${login}:`);
  ctx.write(`  ${setupUrl(url.base, token)}`);
  for (const note of url.notes) ctx.write(`  ${note}`);
  for (const line of SETUP_LINK_NOTE) ctx.write(line);
}

async function userCreate(args: readonly string[], ctx: Ctx): Promise<number> {
  const login = requireLogin(args, "create <login> --role operator|readonly");
  const roleFlag = args.indexOf("--role");
  const roleValue = roleFlag >= 0 ? args[roleFlag + 1] : undefined;
  if (!roleValue || !isUiRole(roleValue)) {
    throw new Error("--role is required and must be operator or readonly");
  }
  const role: UiRole = roleValue;
  await assertConsoleServing(ctx);
  const created = await ctx.users.create(login, role, ctx.now());
  ctx.write(`Created ${login} (${role}).`);
  await printSetupLink(ctx, login, created.token);
  return 0;
}

function userState(user: UiUser): string {
  if (user.deletedAt) return "deleted";
  if (user.disabledAt) return "disabled";
  if (!user.pwdHash) return "awaiting setup";
  return "active";
}

async function userList(ctx: Ctx): Promise<number> {
  const file = await ctx.users.load();
  const users = file.users.filter((u) => !u.deletedAt);
  if (users.length === 0) {
    ctx.write("No console accounts yet.");
    ctx.write("Create one: `hx-fortress ui user create <login> --role operator`");
    return 0;
  }
  const width = Math.max(...users.map((u) => u.login.length));
  for (const user of users) {
    const pending = user.setupTokens.length > 0 ? ", setup link outstanding" : "";
    ctx.write(`  ${user.login.padEnd(width)}  ${user.role.padEnd(8)}  ${userState(user)}${pending}`);
  }
  return 0;
}

async function userDisable(args: readonly string[], ctx: Ctx): Promise<number> {
  const login = requireLogin(args, "disable");
  await ctx.users.disable(login, ctx.now());
  ctx.write(`Disabled ${login}.`);
  ctx.write("Live sessions for that account end on their next request, and outstanding setup links are dead.");
  return 0;
}

async function userDelete(args: readonly string[], ctx: Ctx): Promise<number> {
  const login = requireLogin(args, "delete");
  await ctx.users.remove(login, ctx.now());
  ctx.write(`Deleted ${login}.`);
  ctx.write("Live sessions for that account end on their next request, and outstanding setup links are dead.");
  return 0;
}

async function userReset(args: readonly string[], ctx: Ctx): Promise<number> {
  const login = requireLogin(args, "reset");
  await assertConsoleServing(ctx);
  const reset = await ctx.users.reset(login, ctx.now());
  ctx.write(`Reset ${login}. Any lockout is cleared and older setup links are dead.`);
  ctx.write("The current password keeps working until this link is completed.");
  await printSetupLink(ctx, login, reset.token);
  return 0;
}
