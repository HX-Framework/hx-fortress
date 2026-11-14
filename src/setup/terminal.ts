// `hx-fortress setup` in a terminal: the setup's questions, asked one by
// one.
//
// It walks the same list the browser draws and uses the same run, so it asks
// the same questions, checks each answer the same way and writes the same
// files. Enter keeps the answer shown in brackets, so setting up again and
// pressing Enter through every question changes nothing.
//
// It never asks for a key. Where a key is needed it asks for the name the key
// has in the organization's key store, and says at once whether the store
// holds it.

import { answerAt, answerText, type SetupAnswers } from "./answers";
import type { CheckLine, StepCheck } from "./checks";
import {
  STEP_IDS,
  stepNumber,
  whenHolds,
  type SetupBlock,
  type SetupField,
  type SetupStep,
  type StepId,
} from "./list";
import type { Fact } from "./facts";
import type { FinishResult, SetupFrame, SetupRun } from "./run";

/** What the terminal flow needs from a terminal. The command passes the real
 *  prompts; a test passes a script. */
export interface TerminalIo {
  line(text: string): void;
  text(message: string, options?: { default?: string }): Promise<string>;
  select<T>(
    message: string,
    choices: { label: string; value: T; hint?: string }[],
    options?: { defaultIndex?: number },
  ): Promise<T>;
  confirm(message: string, options?: { default?: boolean }): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export interface TerminalOptions {
  /** How long to wait for a person to sign in at the control plane. */
  signInWaitMs?: number;
  /** Start at this question, for `hx-fortress setup <question>`. */
  only?: StepId;
  /** Ends the setup: checks everything once more and writes it down. The
   *  command wraps this in its audit record. */
  finish: () => Promise<FinishResult>;
}

export type TerminalOutcome =
  | { ended: "finished"; result: Extract<FinishResult, { ok: true }> }
  | { ended: "stopped" };

/** The answer that clears an optional field. Enter keeps what is shown, so an
 *  empty line cannot mean "empty". */
const CLEAR = "-";

const mark = (line: CheckLine): string => (line.ok ? "  ok  " : line.soft ? "  !   " : "  no  ");

function printFacts(io: TerminalIo, label: string | undefined, facts: readonly Fact[]): void {
  if (label) io.line(`  ${label}`);
  const width = Math.max(...facts.map((fact) => fact.label.length), 0);
  for (const fact of facts) {
    io.line(`    ${fact.label.padEnd(width)}  ${fact.value}${fact.note ? `  (${fact.note})` : ""}`);
  }
}

function printCheck(io: TerminalIo, check: StepCheck): void {
  for (const line of check.lines) io.line(`${mark(line)}${line.text}`);
}

async function askField(io: TerminalIo, run: SetupRun, frame: SetupFrame, field: SetupField): Promise<void> {
  const pinned = frame.pinned[field.path];
  const current = answerText(run.answers, field.path);
  if (pinned) {
    io.line(`  ${field.label}: ${current || "(not set)"}  (set by this host: ${pinned})`);
    return;
  }
  const hint = field.kind === "list" ? ", separated by commas" : "";
  const example = !current && field.example ? `, such as ${field.example}` : "";
  const clear = field.optional && current ? `, ${CLEAR} for none` : "";
  const typed = await io.text(`  ${field.label}${hint}${example}${clear}:`, current ? { default: current } : {});
  const value = typed.trim() === CLEAR && field.optional ? "" : typed.trim();
  run.set(field.path, value);
}

async function askBlock(io: TerminalIo, run: SetupRun, frame: SetupFrame, block: SetupBlock): Promise<void> {
  const read = (path: string): string => answerText(run.answers, path);
  switch (block.kind) {
    case "fields": {
      if (!whenHolds(block.when, read)) return;
      if (block.label) io.line(`  ${block.label}`);
      for (const field of block.fields) await askField(io, run, frame, field);
      return;
    }
    case "choice": {
      if (!whenHolds(block.when, read)) return;
      if (block.neededBy && !run.derived().needsFiles) {
        io.line(`  ${block.label ?? "Files"}: ${block.neededBy.idle}`);
        return;
      }
      const pinned = frame.pinned[block.path];
      const current = read(block.path);
      if (pinned) {
        const name = block.options.find((o) => o.id === current)?.name ?? current;
        io.line(`  ${block.label ? `${block.label}: ` : ""}${name}  (set by this host: ${pinned})`);
      } else if (block.options.length === 1 && block.options[0]?.id === current) {
        // One option, and it is the answer: that is not a question. It is
        // said, and the setup goes on.
        io.line(`  ${block.label ? `${block.label}: ` : ""}${block.options[0].name}`);
      } else {
        const index = block.options.findIndex((o) => o.id === current);
        const chosen = await io.select(
          `  ${block.label ?? "Choose one"}`,
          block.options.map((o) => ({ label: o.name, value: o.id, ...(o.detail ? { hint: o.detail } : {}) })),
          { defaultIndex: index >= 0 ? index : 0 },
        );
        run.set(block.path, chosen);
      }
      const option = block.options.find((o) => o.id === read(block.path));
      for (const field of option?.fields ?? []) await askField(io, run, frame, field);
      return;
    }
    case "modules": {
      for (const module of frame.modules) {
        const path = `modules.${module.id}`;
        const on = answerAt(run.answers, path) === true;
        const pinned = frame.pinned[path];
        if (pinned) {
          io.line(`  ${module.title}: ${on ? "on" : "off"}  (set by this host: ${pinned})`);
          continue;
        }
        io.line(`  ${module.title}: ${module.summary}`);
        run.set(path, await io.confirm(`    Switch ${module.title} on?`, { default: on }));
      }
      return;
    }
    case "facts": {
      // `source` is one of three literal keys.
      printFacts(io, block.label, frame.facts[block.source]);
      return;
    }
    case "reach": {
      const rows = run.derived().reach;
      io.line(`  ${rows.length} ${rows.length === 1 ? "address" : "addresses"} this Fortress calls`);
      const width = Math.max(...rows.map((row) => row.address.length), 0);
      for (const row of rows) io.line(`    ${row.address.padEnd(width)}  ${row.why}`);
      return;
    }
    case "asks": {
      if (!whenHolds(block.when, read)) return;
      io.line(`  ${block.label}`);
      for (const row of run.derived().asks) {
        const what = !row.on
          ? "off: it answers nothing"
          : row.asks.length > 0
            ? row.asks.join(", ")
            : row.note || "nothing";
        io.line(`    ${row.title}: ${what}`);
      }
      return;
    }
    case "note": {
      if (whenHolds(block.when, read)) io.line(`  ${block.text}`);
      return;
    }
    case "enrollment":
      // Asked after the step's own check, once the address is known to be one.
      return;
  }
}

/**
 * Enroll with the control plane in the answers: show where to sign in and the
 * code to confirm there, and wait until a person has done so.
 *
 * Returns false when nobody signed in, so the caller can ask again or let the
 * person choose No.
 */
async function enroll(io: TerminalIo, run: SetupRun, waitMs: number): Promise<boolean> {
  let shown;
  try {
    shown = await run.enroll();
  } catch (error) {
    io.line(`  no  ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  io.line("");
  io.line(`  Sign in at:  ${shown.signInAt}`);
  io.line(`  Code:        ${shown.code}`);
  if (shown.key) io.line(`  The control plane's key: ${shown.key.id}  ${shown.key.fingerprint}`);
  io.line("  The page shows the same code. Confirm it there.");
  io.line("  This Fortress then belongs to the organization you signed in to.");
  io.line("  Waiting for the sign-in. Ctrl+C stops the setup, and nothing is saved.");
  // As often as the control plane asked to be asked, and never more than
  // every two seconds.
  const every = Math.max(2, shown.interval) * 1000;
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    await io.sleep(every);
    const now = await run.enrollCheck();
    // The question's own check says that a person signed in. It runs next.
    if (now.state === "ready") return true;
    if (now.state === "refused") {
      io.line(`  no  ${now.reason || "The control plane refused the code"}`);
      return false;
    }
    if (now.state === "expired") {
      io.line("  no  The code ran out before anybody signed in");
      return false;
    }
  }
  io.line("  no  Nobody signed in in time");
  return false;
}

/** Whether the control plane question still waits for a sign-in. */
function needsEnrollment(check: StepCheck, answers: SetupAnswers): boolean {
  return answers.controlPlane.connect === "yes" && check.lines.some((line) => line.needs === "enrollment");
}

/** Ask one question until its answer passes its check, or the person stops. */
async function askStep(
  io: TerminalIo,
  run: SetupRun,
  frame: SetupFrame,
  step: SetupStep,
  options: TerminalOptions,
): Promise<"answered" | "stopped"> {
  for (;;) {
    io.line("");
    io.line(`Step ${stepNumber(step.id)} of ${STEP_IDS.length} · ${step.name}`);
    io.line(step.question);
    for (const block of step.blocks) await askBlock(io, run, frame, block);

    let check = await run.check(step.id);
    if (step.id === "controlPlane" && needsEnrollment(check, run.answers)) {
      if (await enroll(io, run, options.signInWaitMs ?? 10 * 60_000)) check = await run.check(step.id);
    }
    printCheck(io, check);
    if (check.ok) return "answered";
    if (!(await io.confirm("  Answer this question again?", { default: true }))) return "stopped";
  }
}

function printReview(io: TerminalIo, run: SetupRun, frame: SetupFrame): void {
  const summary = run.derived().summary;
  const width = Math.max(...frame.list.map((step) => step.name.length));
  io.line("");
  io.line("Review");
  for (const step of frame.list) {
    // `step.id` is one of the list's own literal ids.
    io.line(`  ${String(stepNumber(step.id)).padStart(2)}  ${step.name.padEnd(width)}  ${summary[step.id]}`);
  }
}

/**
 * Ask the questions, show the review, and end the setup.
 *
 * Nothing is written until the person says to finish, and then only when no
 * answer is refused.
 */
export async function runTerminalSetup(
  run: SetupRun,
  io: TerminalIo,
  options: TerminalOptions,
): Promise<TerminalOutcome> {
  const frame = await run.frame();
  io.line("HX Fortress setup");
  io.line(
    frame.setUp
      ? "This Fortress is set up. Enter keeps the answer shown in [brackets]."
      : `${frame.list.length} questions. Enter keeps the answer shown in [brackets].`,
  );
  io.line("Where a key is needed, give the name it has in your key store. Setup never asks for the key.");

  let steps = options.only ? frame.list.filter((step) => step.id === options.only) : frame.list;
  for (;;) {
    for (const step of steps) {
      if ((await askStep(io, run, frame, step, options)) === "stopped") {
        io.line("");
        io.line("Setup stopped. Nothing was saved.");
        return { ended: "stopped" };
      }
    }
    printReview(io, run, frame);
    if (!(await io.confirm("Finish setup?", { default: true }))) {
      io.line("Setup stopped. Nothing was saved.");
      return { ended: "stopped" };
    }
    const result = await options.finish();
    if (result.ok) return { ended: "finished", result };

    // An answer that passed alone can be refused beside the others: Sessions
    // switched on in step 5 needs a file store from step 4. Go back to exactly
    // the questions that are refused.
    io.line("");
    io.line("Setup cannot finish yet:");
    const refused = result.checks.filter((check) => !check.ok);
    for (const check of refused) {
      for (const line of check.lines.filter((l) => !l.ok && !l.soft)) {
        io.line(`  Step ${stepNumber(check.step)}: ${line.text}`);
      }
    }
    if (!(await io.confirm("Answer those questions again?", { default: true }))) {
      io.line("Setup stopped. Nothing was saved.");
      return { ended: "stopped" };
    }
    const again = new Set(refused.map((check) => check.step));
    steps = frame.list.filter((step) => again.has(step.id));
  }
}
