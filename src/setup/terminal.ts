// The setup in a terminal: its questions, asked one by one.
//
// It walks the same list the browser page draws and uses the same run, so it
// asks the same questions, checks each answer the same way and makes the same
// things. Enter keeps the answer shown in brackets, so setting up again and
// pressing Enter through every question changes nothing.
//
// On the machine that runs HX Fortress it never asks for a key: it asks for
// the name the key has in the organization's key store, and says at once
// whether the store holds it. In the install a person may type a key. It is
// read without being shown, kept in memory, and handed once to the place that
// makes HX Fortress.

import { answerAt, answerText, wordsOf } from "./answers";
import type { CheckLine, StepCheck } from "./checks";
import {
  keysAreTyped,
  placeInfo,
  visibleList,
  whenHolds,
  type PlaceId,
  type SetupBlock,
  type SetupField,
  type SetupStep,
  type StepId,
} from "./list";
import type { Fact } from "./facts";
import { reachLabel } from "./reach";
import type { CreateStart, FinishResult, SetupFrame, SetupRun } from "./run";
import type { PlanShown, SetupDone } from "./view";

/** What the terminal flow needs from a terminal. The command passes the real
 *  prompts; a test passes a script. */
export interface TerminalIo {
  line(text: string): void;
  text(message: string, options?: { default?: string }): Promise<string>;
  /** Read a line without showing it: a key a person types. */
  secret(message: string): Promise<string>;
  select<T>(
    message: string,
    choices: { label: string; value: T; hint?: string }[],
    options?: { defaultIndex?: number },
  ): Promise<T>;
  confirm(message: string, options?: { default?: boolean }): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export interface TerminalOptions {
  /** Start at this question, for `hx-fortress setup <question>`. */
  only?: StepId;
  /**
   * The last step. On the machine itself `finish` checks everything once more
   * and writes it down, and the command wraps it in its audit record. In the
   * install `create` starts the making, and this flow prints each thing as it
   * is made.
   */
  end: { finish: () => Promise<FinishResult> } | { create: () => Promise<CreateStart> };
}

export type TerminalOutcome =
  | { ended: "finished"; result: Extract<FinishResult, { ok: true }> | null; done: SetupDone | null }
  | { ended: "stopped" };

/** The answer that clears an optional field. Enter keeps what is shown, so an
 *  empty line cannot mean "empty". */
const CLEAR = "-";

const mark = (line: CheckLine): string => (line.ok ? "  ok  " : line.soft ? "  !   " : "  no  ");

function printFacts(io: TerminalIo, label: string | undefined, facts: readonly Fact[]): void {
  if (facts.length === 0) return;
  if (label) io.line(`  ${label}`);
  const width = Math.max(...facts.map((fact) => fact.label.length), 0);
  for (const fact of facts) {
    io.line(`    ${fact.label.padEnd(width)}  ${fact.value}${fact.note ? `  (${fact.note})` : ""}`);
  }
}

function printCheck(io: TerminalIo, check: StepCheck): void {
  for (const line of check.lines) io.line(`${mark(line)}${line.text}`);
}

/** The list as this run asks it now: for its way, and for the place the
 *  answers name. The place can change on the first page. */
function listNow(run: SetupRun): SetupStep[] {
  return visibleList({
    way: run.way,
    place: placeInfo(run.answers.where.place).id,
    words: wordsOf(run.answers),
  });
}

async function askField(io: TerminalIo, run: SetupRun, frame: SetupFrame, field: SetupField): Promise<void> {
  const read = (at: string): string => answerText(run.answers, at);
  if (!whenHolds(field.when, read)) return;
  const pinned = frame.pinned[field.path];
  const current = read(field.path);
  if (pinned) {
    io.line(`  ${field.label}: ${current || "(not set)"}  (set by this host: ${pinned})`);
    return;
  }
  // A closed set of values: one of them is picked. With one, it is said.
  if (field.options) {
    if (field.options.length <= 1) {
      const only = field.options[0];
      if (only) {
        if (current !== only.id) run.set(field.path, only.id);
        io.line(`  ${field.label}: ${only.name}`);
      }
      return;
    }
    const index = field.options.findIndex((o) => o.id === current);
    const chosen = await io.select(
      `  ${field.label}`,
      field.options.map((o) => ({ label: o.name, value: o.id })),
      { defaultIndex: index >= 0 ? index : 0 },
    );
    run.set(field.path, chosen);
    return;
  }
  // A key a person may type. Enter keeps the one that was typed before.
  if (field.kind === "key" && field.typedAs && keysAreTyped({ way: run.way })) {
    const held = run.typedPaths().includes(field.path);
    const typed = await io.secret(`  ${field.label}${held ? " (Enter keeps the one you typed)" : ""}:`);
    if (typed.trim() !== "") run.setTyped(field.path, typed.trim());
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
  const read = (at: string): string => answerText(run.answers, at);
  if (!whenHolds(block.when, read)) return;
  switch (block.kind) {
    case "fields": {
      if (block.label) io.line(`  ${block.label}`);
      for (const field of block.fields) await askField(io, run, frame, field);
      return;
    }
    case "choice": {
      if (block.neededBy && !run.derived().needsFiles) {
        io.line(`  ${block.label ?? "Files"}: ${block.neededBy.idle}`);
        return;
      }
      // The first page: only the places this build can make HX Fortress in,
      // each with whether this computer is signed in to it.
      const places = block.path === "where.place" ? run.derived().places : null;
      const options = places
        ? block.options.filter((o) => places.find((row) => row.id === o.id)?.offered === true)
        : block.options;
      const hintOf = (id: string, detail?: string): string | undefined => {
        const row = places?.find((p) => p.id === id);
        if (!row || !row.needsSignIn) return detail;
        return row.signedInAs ? `Signed in as ${row.signedInAs}.` : "Not signed in on this computer.";
      };
      const pinned = frame.pinned[block.path];
      const current = read(block.path);
      const label = block.label ? `${block.label}: ` : "";
      if (pinned) {
        const name = options.find((o) => o.id === current)?.name ?? current;
        io.line(`  ${label}${name}  (set by this host: ${pinned})`);
      } else if (options.length === 0) {
        io.line(`  ${label}nothing to choose in this build`);
        return;
      } else if (options.length === 1 && options[0]?.id === current) {
        // One option, and it is the answer: that is not a question. It is
        // said, and the setup goes on.
        io.line(`  ${label}${options[0].name}`);
      } else {
        const index = options.findIndex((o) => o.id === current);
        const chosen = await io.select(
          `  ${block.label ?? "Choose one"}`,
          options.map((o) => {
            const hint = hintOf(o.id, o.detail);
            return { label: o.name, value: o.id, ...(hint ? { hint } : {}) };
          }),
          { defaultIndex: index >= 0 ? index : 0 },
        );
        run.set(block.path, chosen);
      }
      // The fields of the chosen option, as the list shows them for the place
      // that is chosen now.
      const again = listNow(run)
        .flatMap((step) => step.blocks)
        .find((b) => b.kind === "choice" && b.path === block.path);
      const option =
        again?.kind === "choice" ? again.options.find((o) => o.id === read(block.path)) : undefined;
      for (const field of option?.fields ?? []) await askField(io, run, frame, field);
      return;
    }
    case "switch": {
      const pinned = frame.pinned[block.path];
      const on = read(block.path) === block.on;
      if (pinned) {
        io.line(`  ${block.label}: ${on ? "yes" : "no"}  (set by this host: ${pinned})`);
      } else {
        const detail = on ? block.detail : (block.detailOff ?? block.detail);
        if (detail) io.line(`  ${detail}`);
        run.set(block.path, (await io.confirm(`  ${block.label}?`, { default: on })) ? block.on : block.off);
      }
      if (read(block.path) === block.on) for (const field of block.fields ?? []) await askField(io, run, frame, field);
      return;
    }
    case "modules": {
      for (const module of frame.modules) {
        const at = `modules.${module.id}`;
        const on = answerAt(run.answers, at) === true;
        const pinned = frame.pinned[at];
        if (pinned) {
          io.line(`  ${module.title}: ${on ? "on" : "off"}  (set by this host: ${pinned})`);
          continue;
        }
        io.line(`  ${module.title}: ${module.summary}`);
        run.set(at, await io.confirm(`    Switch ${module.title} on?`, { default: on }));
      }
      return;
    }
    case "facts": {
      const derived = run.derived().facts;
      const facts =
        block.source === "host" || block.source === "auditTrail" || block.source === "updates"
          ? frame.facts[block.source]
          : derived[block.source];
      printFacts(io, block.label, facts);
      return;
    }
    case "reach": {
      const rows = run.derived().reach;
      io.line(`  ${reachLabel(rows.length)}`);
      const width = Math.max(...rows.map((row) => row.address.length), 0);
      for (const row of rows) io.line(`    ${row.address.padEnd(width)}  ${row.why}`);
      return;
    }
    case "note": {
      io.line(`  ${block.text}`);
      return;
    }
    case "connect":
      // A new install id is given with the command: `--connect`.
      return;
  }
}

/** Ask one question until its answer passes its check, or the person stops. */
async function askStep(
  io: TerminalIo,
  run: SetupRun,
  frame: SetupFrame,
  id: StepId,
): Promise<"answered" | "stopped"> {
  for (;;) {
    const list = listNow(run);
    const step = list.find((s) => s.id === id);
    if (!step) return "answered";
    io.line("");
    io.line(`Step ${list.indexOf(step) + 1} of ${list.length} · ${step.name}`);
    io.line(step.question);
    // The blocks are read again after each one: an answer can change what the
    // next block shows.
    for (let index = 0; ; index += 1) {
      const block = listNow(run).find((s) => s.id === id)?.blocks[index];
      if (!block) break;
      await askBlock(io, run, frame, block);
    }

    const check = await run.check(id);
    printCheck(io, check);
    if (check.ok) return "answered";
    if (!(await io.confirm("  Answer this question again?", { default: true }))) return "stopped";
  }
}

function printPlan(io: TerminalIo, plan: PlanShown): void {
  io.line(`  ${plan.heading}`);
  const width = Math.max(...plan.rows.map((row) => row.label.length), 0);
  for (const row of plan.rows) io.line(`    ${row.label.padEnd(width)}  ${row.value}`);
}

/** Print each thing as it is made, until everything is, or it stops. */
async function follow(io: TerminalIo, run: SetupRun, plan: PlanShown): Promise<"done" | "failed"> {
  const said = new Set<string>();
  let dnsSaid = false;
  for (;;) {
    const progress = run.progress();
    for (const id of progress.made) {
      if (said.has(id)) continue;
      said.add(id);
      const row = plan.rows.find((r) => r.id === id);
      if (row) io.line(`  ok  ${row.label}: ${row.value}`);
    }
    if (progress.dns && !dnsSaid) {
      dnsSaid = true;
      io.line("  Waiting for this record at your DNS provider:");
      io.line(`    CNAME ${progress.dns.name} → ${progress.dns.target}`);
    }
    if (progress.stage === "done") return "done";
    if (progress.stage === "failed") {
      const row = plan.rows.find((r) => r.id === progress.failure?.row);
      io.line(`  no  ${row ? `${row.label}: ` : ""}${progress.failure?.text ?? "It could not be made"}`);
      return "failed";
    }
    await io.sleep(500);
  }
}

/**
 * Ask the questions, show what they add up to, and make it.
 *
 * Nothing is made until the person says yes to the last step, and then only
 * when no answer is refused.
 */
export async function runTerminalSetup(
  run: SetupRun,
  io: TerminalIo,
  options: TerminalOptions,
): Promise<TerminalOutcome> {
  const frame = await run.frame();
  const nothing = run.way === "install" ? "Nothing was made." : "Nothing was saved.";
  io.line(run.way === "install" ? "HX Fortress install" : "HX Fortress setup");
  io.line(
    frame.setUp
      ? "This HX Fortress is set up. Enter keeps the answer shown in [brackets]."
      : "Each question comes with an answer. Enter keeps the answer shown in [brackets].",
  );
  io.line(
    keysAreTyped({ way: run.way })
      ? "A key you type is not shown, and it is kept only in the key store you choose."
      : "Where a key is needed, give the name it has in your key store. Setup never asks for the key.",
  );

  let steps: StepId[] = options.only ? [options.only] : listNow(run).map((step) => step.id);
  for (;;) {
    for (const id of steps) {
      if ((await askStep(io, run, frame, id)) === "stopped") {
        io.line("");
        io.line(`Setup stopped. ${nothing}`);
        return { ended: "stopped" };
      }
      // The place decides which questions follow it.
      if (id === "where" && !options.only) {
        const now = listNow(run).map((step) => step.id);
        steps.splice(0, steps.length, ...now);
      }
    }
    const plan = run.derived().plan;
    io.line("");
    io.line(frame.last.kicker);
    printPlan(io, plan);
    if (!(await io.confirm(frame.last.ask, { default: true }))) {
      io.line(`Setup stopped. ${nothing}`);
      return { ended: "stopped" };
    }

    let refused: StepCheck[];
    if ("finish" in options.end) {
      const result = await options.end.finish();
      if (result.ok) return { ended: "finished", result, done: null };
      refused = result.checks.filter((check) => !check.ok);
    } else {
      const started = await options.end.create();
      if (started.ok) {
        io.line("");
        io.line(frame.last.busy);
        if ((await follow(io, run, plan)) === "done") return { ended: "finished", result: null, done: run.done() };
        // What exists is kept. Saying yes again makes what is missing.
        if (!(await io.confirm("Try again?", { default: true }))) {
          io.line("Setup stopped. What was made so far is still there.");
          return { ended: "stopped" };
        }
        steps = [];
        continue;
      }
      refused = started.checks.filter((check) => !check.ok);
    }

    // An answer that passed alone can be refused beside the others: a module
    // switched on in one step can need a file store from another. Go back to
    // exactly the questions that are refused.
    io.line("");
    io.line("An answer is refused:");
    const names = new Map(listNow(run).map((step) => [step.id, step.name]));
    for (const check of refused) {
      for (const line of check.lines.filter((l) => !l.ok && !l.soft)) {
        io.line(`  ${names.get(check.step) ?? check.step}: ${line.text}`);
      }
    }
    if (!(await io.confirm("Answer those questions again?", { default: true }))) {
      io.line(`Setup stopped. ${nothing}`);
      return { ended: "stopped" };
    }
    const again = new Set(refused.map((check) => check.step));
    steps = listNow(run)
      .map((step) => step.id)
      .filter((id) => again.has(id));
  }
}

export type { PlaceId };
