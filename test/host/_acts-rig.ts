// A module built to probe the act gate, and the way to send it an act as the
// console's hand-over does.

import type { AuditRecord } from "../../src/console/audit-spool";
import type { CatalogEntry } from "../../src/host/module-catalog";
import {
  AskFailure,
  type ActAnswer,
  type FortressModule,
  type ModuleActContext,
  type ModuleContextV2,
  type ModuleManifest,
  type Person,
} from "../../src/host/module-contract";
import type { ModuleHostDeps } from "../../src/host/module-host";
import { S } from "../../src/host/shape";
import { makeRig, ROW_VALUE, SECRET_VALUE, spoolRecords, type Rig } from "./_module-rig";

export const OPERATOR: Person = { login: "maya.chen", email: null, role: "operator" };
export const READER: Person = { login: "lena.hart", email: "lena.hart@northstar.example", role: "readonly" };
/** A console's own id for a sign-in: 32 hex characters. */
export const SESSION = "0123456789abcdef0123456789abcdef";

const THING = S.record({ name: S.name, host: S.name, port: S.count(65_535), keyName: S.name }, ["keyName"]);

export const ACTS_MANIFEST: ModuleManifest = {
  id: "probe",
  asks: [
    {
      name: "lists.count",
      args: S.none,
      reply: S.record({ reaches: S.count(), names: S.count(), canAdd: S.flag }),
    },
  ],
  acts: [
    {
      name: "things.read",
      role: "readonly",
      args: S.none,
      reply: S.record({
        reaches: S.list(S.record({ name: S.name, host: S.name, port: S.count(65_535), addedBy: S.name }), 64),
        names: S.list(S.name, 64),
      }),
    },
    { name: "thing.add", role: "operator", args: THING, reply: S.record({ name: S.name }) },
    {
      name: "thing.remove",
      role: "operator",
      args: S.record({ name: S.name, keyName: S.name }, ["keyName"]),
      reply: S.none,
    },
    // An act any signed-in person may do, written to try a change.
    { name: "sneak.add", role: "readonly", args: THING, reply: S.none },
    { name: "secret.length", role: "operator", args: S.record({ keyName: S.name }), reply: S.record({ length: S.count() }) },
    { name: "state.cycle", role: "operator", args: S.none, reply: S.record({ held: S.flag, gone: S.flag }) },
    { name: "leak.row", role: "readonly", args: S.none, reply: S.record({ name: S.name }) },
    { name: "big.reply", role: "readonly", args: S.none, reply: S.record({ rows: S.list(S.record({ a: S.name, b: S.name, c: S.name, d: S.name }), 500) }) },
    { name: "throw.secret", role: "operator", args: S.none, reply: S.none },
    { name: "throw.code", role: "operator", args: S.none, reply: S.none },
    { name: "never", role: "readonly", args: S.none, reply: S.none },
    { name: "never.changes", role: "operator", args: S.none, reply: S.none },
  ],
  egress: [],
  secrets: ["probe-token"],
};

export const ACTS_CATALOG: readonly CatalogEntry[] = [
  { id: "session_vault", title: "Agentic Sessions", summary: "transcripts", manifest: null, startOnly: true },
  { id: "probe", title: "Probe", summary: "a module for tests", manifest: ACTS_MANIFEST, startOnly: false },
];

export interface ActsProbe extends FortressModule {
  acted: { act: string; args: unknown; person: Person }[];
  /** The context of the last ask, and of the last act. */
  askContext: ModuleContextV2 | null;
  actContext: ModuleActContext | null;
}

interface Thing {
  name: string;
  host: string;
  port: number;
  keyName?: string;
}

export function createActsProbe(): ActsProbe {
  const module: ActsProbe = {
    id: "probe",
    manifest: ACTS_MANIFEST,
    acted: [],
    askContext: null,
    actContext: null,
    onMessage() {
      return { ok: false, error: "ask_unknown" };
    },
    async onAsk(_ask, _args, ctx) {
      module.askContext = ctx;
      return {
        reaches: (await ctx.reach.list()).length,
        names: (await ctx.secretNames.list()).length,
        // An ask's context has no way to add to either list.
        canAdd: "add" in ctx.reach || "add" in ctx.secretNames,
      };
    },
    async onAct(act, args, ctx, person) {
      module.acted.push({ act, args, person });
      module.actContext = ctx;
      switch (act) {
        case "things.read":
          return {
            reaches: (await ctx.reach.list()).map(({ name, host, port, addedBy }) => ({ name, host, port, addedBy })),
            names: await ctx.secretNames.list(),
          };
        case "thing.add":
        case "sneak.add": {
          const thing = args as Thing;
          await ctx.reach.add(thing.name, { host: thing.host, port: thing.port });
          if (thing.keyName !== undefined) await ctx.secretNames.add(thing.keyName);
          return act === "thing.add" ? { name: thing.name } : {};
        }
        case "thing.remove": {
          const thing = args as { name: string; keyName?: string };
          await ctx.reach.remove(thing.name);
          if (thing.keyName !== undefined) await ctx.secretNames.remove(thing.keyName);
          return {};
        }
        case "secret.length":
          // The value never leaves this line: only how long it is.
          return { length: (await ctx.secrets.get((args as { keyName: string }).keyName)).length };
        case "state.cycle": {
          await ctx.state.write("scratch", { n: 1 });
          const held = (await ctx.state.read("scratch")) !== null;
          await ctx.state.remove("scratch");
          // A second removal of the same key changes nothing and does not fail.
          await ctx.state.remove("scratch");
          return { held, gone: (await ctx.state.read("scratch")) === null };
        }
        case "leak.row":
          return { name: ROW_VALUE };
        case "big.reply":
          return {
            rows: Array.from({ length: 500 }, () => ({
              a: "a".repeat(128),
              b: "b".repeat(128),
              c: "c".repeat(128),
              d: "d".repeat(128),
            })),
          };
        case "throw.secret":
          throw new Error(`could not sign in with ${SECRET_VALUE} for ${ROW_VALUE}`);
        case "throw.code":
          throw new AskFailure("connection_unknown");
        case "never":
        case "never.changes":
          return new Promise(() => {});
        default:
          throw new AskFailure("act_not_implemented");
      }
    },
  };
  return module;
}

export interface ActsRig extends Rig {
  acts: ActsProbe;
}

export async function makeActsRig(
  options: { enabled?: readonly string[]; deps?: Partial<ModuleHostDeps>; start?: boolean; restartOf?: Rig } = {},
): Promise<ActsRig> {
  const acts = createActsProbe();
  const rig = await makeRig({
    ...options,
    // The rig's probe type is the gate's own; this one has acts as well.
    probe: acts as unknown as Rig["probe"],
    deps: { catalog: ACTS_CATALOG, ...options.deps },
  });
  return { ...rig, acts };
}

/** Send one act through the gate, as the door hands it over. */
export function act(
  rig: Rig,
  name: string,
  args: unknown = {},
  person: unknown = OPERATOR,
  extra: Record<string, unknown> = {},
): Promise<ActAnswer> {
  return rig.host.acts.handle({ v: 1, person, session: SESSION, module: "probe", act: name, args, ...extra });
}

/** The records of one action, oldest first. */
export async function recordsOf(rig: Rig, action: string): Promise<AuditRecord[]> {
  return (await spoolRecords(rig.paths)).filter((record) => record.action === action);
}

/** Every record whose action starts with `prefix`, as `action outcome error`. */
export async function story(rig: Rig, prefix: string): Promise<string[]> {
  return (await spoolRecords(rig.paths))
    .filter((record) => record.action.startsWith(prefix))
    .map((record) => [record.action, record.kind, record.outcome ?? "-", record.error ?? "-"].join(" "));
}
