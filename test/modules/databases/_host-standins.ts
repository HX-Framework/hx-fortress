// A stand-in, for the tests, for the look-ups the module host does before it
// runs a helper program. The module host does them itself now
// (`ctx.programs.run`, src/host/module-context.ts). These tests keep the
// stand-in, with a launcher of their own, so that they run on a machine that
// has no such program.
//
// It is written to the rule the host's contract gives for the real thing, and
// it reads the host's own two lists. It is test code.
//
// The two lists a person adds to, and the context of an act, were stood in for
// here until the host had them. They are the host's own now, and the tests go
// through its gate (the rig's `act`).

import type { ModuleContextV2 } from "../../../src/host/module-contract";
import type { ProgramFailure, ProgramRun } from "../../../src/modules/databases/host-ports";
import { DATABASES_PROGRAMS } from "../../../src/modules/databases/manifest";

/** What the host has looked up for one run of a program, or why it starts none. */
export type LookedUp =
  | { ok: true; args: readonly string[]; reach: { host: string; port: number } }
  | { ok: false; code: ProgramFailure };

/** The look-ups the host does before it starts a program: the program is one
 *  the module declares, the reach is on the list, and so is each secret's name. */
export async function lookUp(ctx: ModuleContextV2, program: string, run: ProgramRun): Promise<LookedUp> {
  const declared = DATABASES_PROGRAMS.find((entry) => entry.id === program);
  if (!declared) return { ok: false, code: "program_not_declared" };
  const entry = (await ctx.reach.list()).find((reach) => reach.name === run.reach);
  if (!entry) return { ok: false, code: "reach_not_listed" };
  const added = await ctx.secretNames.list();
  for (const name of Object.values(run.secrets)) {
    if (!added.includes(name)) return { ok: false, code: "secret_not_added" };
  }
  return { ok: true, args: declared.args, reach: { host: entry.host, port: entry.port } };
}
