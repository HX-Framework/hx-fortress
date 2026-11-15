// The setup's checks, made again after the setup has ended.
//
// An answer that passed its check on the day it was given can stop being true:
// a key is removed from the key store, the sign-in provider moves, a folder is
// unmounted. So the same checks run again when HX Fortress starts, and each
// time somebody runs the Checkup. They read the answers from where the
// HX Fortress itself reads them, so what is checked is what is in force.
//
// They run in one of the checks' two modes for an HX Fortress that is set up
// (`CheckDeps.when`). Neither asks the model a question, which costs money, nor
// opens the database or the file store, which the start and the Checkup probe
// themselves. A start adds no request that leaves this host: it checks what
// the host can see by itself. The Checkup also asks the sign-in provider
// whether it still describes itself, and the key store for each named key. A
// key store answers that by reading the key, as it does at every start; what
// is kept here is only whether the key is still there.
//
// The key store they ask is HX Fortress's own, while the Keys answer is the
// one the daemon started with: the caller passes the store the daemon already
// holds, so that a check opens no second one and asks the host's identity for
// no second token.
//
// A refused answer here does not stop HX Fortress. What must stop a start
// has its own gate in the start itself. This says which answer no longer
// holds, in the words the setup used when it was given.

import type { CatalogEntry } from "../host/module-catalog";
import type { fortressPaths } from "../host/paths";
import { checkAll, refusalsOf, type CheckDeps, type StepCheck } from "./checks";
import { stepById } from "./list";
import { readAnswers, type PresentAnswers } from "./read";

type FortressPaths = ReturnType<typeof fortressPaths>;

export interface CheckAgainDeps {
  paths: FortressPaths;
  env: Record<string, string | undefined>;
  /** Why the checks run: HX Fortress is starting, or somebody asked for the Checkup. */
  when: "start" | "checkup";
  catalog?: readonly CatalogEntry[];
  /** Injected in tests: how the answers are read, and fakes for the checks. */
  read?: (paths: FortressPaths, env: Record<string, string | undefined>) => Promise<PresentAnswers>;
  check?: Partial<CheckDeps>;
}

/** Every question's check, on the answers this HX Fortress runs with. */
export async function checkAnswersAgain(deps: CheckAgainDeps): Promise<StepCheck[]> {
  const present = await (deps.read ??
    ((paths, env) => readAnswers(paths, env, deps.catalog ? { catalog: deps.catalog } : {})))(deps.paths, deps.env);
  return checkAll(present.answers, {
    paths: deps.paths,
    env: deps.env,
    present,
    ...(deps.catalog ? { catalog: deps.catalog } : {}),
    ...deps.check,
    // Last, so that nothing a caller passes can turn this into the mode in
    // which a person answers: that mode asks the model a question.
    when: deps.when,
  });
}

/** One sentence for each answer that is refused: the question, then why. */
export function refusedSentences(checks: readonly StepCheck[]): string[] {
  return refusalsOf(checks).map(({ step, text }) => `${stepById(step).name}: ${text}`);
}
