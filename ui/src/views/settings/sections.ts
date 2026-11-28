// What the Settings page works out about a section, with no React in it.
//
// A section is one step of the setup's list, asked the `settings` way. Each
// one is an answer sheet of its own over what HX Fortress holds now: a section
// keeps the answers it changed, and nothing else, so saving one section
// never writes another's unsaved changes.

import { answerAt, answerText, cloneAnswers, setAnswer, settleAnswers, type SetupAnswers } from "../../../../src/setup/answers";
import type { SetupBlock, SetupStep } from "../../../../src/setup/list";
import type { ConnectionShown } from "../../api";

type SwitchBlock = Extract<SetupBlock, { kind: "switch" }>;

/** One answer, as the answers hold it. */
export type AnswerValue = string | boolean | string[];

/** A section's changed answers, by path. */
export type Edits = Record<string, AnswerValue>;

/** Every answer a section asks, by path: what a save of it may write. Worked
 *  out from the list, as the server's own `settablePaths` is. */
export function pathsOf(step: SetupStep, moduleIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const block of step.blocks) {
    if (block.kind === "choice") {
      out.add(block.path);
      for (const option of block.options) for (const field of option.fields ?? []) out.add(field.path);
    } else if (block.kind === "fields") {
      for (const field of block.fields) out.add(field.path);
    } else if (block.kind === "switch") {
      out.add(block.path);
      for (const field of block.fields ?? []) out.add(field.path);
    } else if (block.kind === "modules") {
      for (const id of moduleIds) out.add(`modules.${id}`);
    }
  }
  return Array.from(out);
}

/** What a section would save: the answers HX Fortress holds, with the
 *  section's own changes over them. */
export function withEdits(saved: SetupAnswers, edits: Edits | undefined): SetupAnswers {
  const out = cloneAnswers(saved);
  for (const path of Object.keys(edits ?? {})) {
    const value = (edits as Edits)[path];
    if (value !== undefined) setAnswer(out, path, value);
  }
  return out;
}

/** A section's changes: the answers among `paths` that differ from the
 *  saved ones, by path. A section keeps only these, so a newer state shows
 *  through every answer the person did not change. */
export function changedOf(saved: SetupAnswers, answers: SetupAnswers, paths: readonly string[]): Edits {
  const out: Edits = {};
  for (const path of paths) {
    if (answerText(saved, path) === answerText(answers, path)) continue;
    const value = answerAt(answers, path);
    if (value !== undefined) out[path] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

/** The answer of Settings that moves others when it changes: a model's key,
 *  name and route belong to the provider they were given for. The server
 *  moves them as the page does (`settleAnswers`). */
const SETTLES: ReadonlySet<string> = new Set(["model.provider"]);

/**
 * What a save of one section sends: only the answers the person changed,
 * against the answers the page read, as the nested objects the server walks
 * (`{ model: { provider: "openai" } }`). An answer the person did not change
 * is not sent, so the save cannot put back an answer that changed elsewhere.
 *
 * The server takes the answers one by one, in the order they are sent, and a
 * change of the model's provider moves the model's other answers there as it
 * does here. So the provider is sent first, and an answer the person gave
 * after it is sent as well wherever the server would otherwise move it: a
 * key's name typed again as it was before the provider changed, for one.
 */
export function sentAnswers(saved: SetupAnswers, answers: SetupAnswers, paths: readonly string[]): Record<string, unknown> {
  const first = (list: readonly string[]): string[] => [...list.filter((p) => SETTLES.has(p)), ...list.filter((p) => !SETTLES.has(p))];
  let sent = first(paths.filter((path) => answerText(saved, path) !== answerText(answers, path)));
  for (let round = 0; round < 3; round += 1) {
    // Where the server's answers land, taking these as it does.
    const landed = cloneAnswers(saved);
    for (const path of sent) {
      const before = answerText(landed, path);
      setAnswer(landed, path, answerAt(answers, path));
      if (SETTLES.has(path) && answerText(landed, path) !== before) settleAnswers(landed, path);
    }
    const astray = paths.filter((path) => !sent.includes(path) && answerText(landed, path) !== answerText(answers, path));
    if (astray.length === 0) break;
    sent = first([...sent, ...astray]);
  }
  const out: Record<string, unknown> = {};
  for (const path of sent) {
    const value = answerAt(answers, path);
    if (value === undefined) continue;
    const parts = path.split(".");
    const leaf = parts.pop() as string;
    let node = out;
    for (const part of parts) {
      const next = node[part];
      if (next && typeof next === "object" && !Array.isArray(next)) node = next as Record<string, unknown>;
      else {
        const made: Record<string, unknown> = {};
        node[part] = made;
        node = made;
      }
    }
    node[leaf] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

/** True when a section has a control a person can change: a field, a choice
 *  of more than one option, a switch or a module, that the host's
 *  environment does not decide. A section of facts, or of choices that offer
 *  one option each, changes nothing. */
export function canChange(step: SetupStep, pinned: Readonly<Record<string, string>>, moduleIds: readonly string[]): boolean {
  const free = (path: string): boolean => !Object.prototype.hasOwnProperty.call(pinned, path);
  return step.blocks.some((block) => {
    switch (block.kind) {
      case "fields":
        return block.fields.some((field) => free(field.path) && (!field.options || field.options.length > 1));
      case "choice":
        return (
          (free(block.path) && block.options.length > 1) ||
          block.options.some((option) => (option.fields ?? []).some((field) => free(field.path)))
        );
      case "switch":
        return free(block.path);
      case "modules":
        return moduleIds.some((id) => free(`modules.${id}`));
      default:
        return false;
    }
  });
}

/**
 * The answers of a step that mean something only together: a picker (a
 * choice, or a switch), the fields of its options, and every field or block
 * shown on a condition of one of these, directly or through another. The
 * model's provider is one with its key, its route and the route's region and
 * project; the sign-in's provider is one with its groups.
 *
 * A key's name given for one provider means nothing for another, so a change
 * is carried onto a newer state only together with the rest of its unit.
 */
export function unitsOf(step: SetupStep): string[][] {
  // Paths joined when one is shown on a condition of the other, or is a
  // field of the other's options.
  const joined = new Map<string, Set<string>>();
  const join = (a: string, b: string | undefined): void => {
    if (!b || a === b) return;
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      const set = joined.get(x) ?? new Set<string>();
      set.add(y);
      joined.set(x, set);
    }
  };
  const pickers: string[] = [];
  for (const block of step.blocks) {
    const shownOn = block.when?.path;
    if (block.kind === "choice") {
      pickers.push(block.path);
      join(block.path, shownOn);
      for (const option of block.options) {
        for (const field of option.fields ?? []) {
          join(field.path, block.path);
          join(field.path, field.when?.path);
        }
      }
    } else if (block.kind === "switch") {
      pickers.push(block.path);
      join(block.path, shownOn);
      for (const field of block.fields ?? []) {
        join(field.path, block.path);
        join(field.path, field.when?.path);
      }
    } else if (block.kind === "fields") {
      for (const field of block.fields) {
        join(field.path, shownOn);
        join(field.path, field.when?.path);
      }
    }
  }
  // Each picker with everything joined to it, directly or through another.
  const units: string[][] = [];
  const seen = new Set<string>();
  for (const picker of pickers) {
    if (seen.has(picker)) continue;
    const unit: string[] = [];
    const queue = [picker];
    seen.add(picker);
    while (queue.length > 0) {
      const path = queue.shift() as string;
      unit.push(path);
      for (const other of joined.get(path) ?? []) {
        if (seen.has(other)) continue;
        seen.add(other);
        queue.push(other);
      }
    }
    units.push(unit);
  }
  return units;
}

/**
 * A section's changes, carried onto a newer state of what is saved: after
 * another section's save, a return to the page, or a save that came too late.
 *
 * A change stays only where the saved answers it was made against did not
 * move: its own, and every other answer of its unit (`unitsOf`). Where
 * someone else saved one of them meanwhile, the person's changes to the whole
 * unit are dropped, so the fields show what is saved now, and each dropped
 * path is named in `moved`. A Save after that sends nothing for them: the
 * newer state's digest can no longer carry an answer over one somebody else
 * saved, nor a key given for one provider over to another.
 *
 * `sent` is what this page itself sent in a save of the section (one on its
 * way, or one given up). An answer that moved to exactly that is the
 * person's own: the change it covers goes quietly (`quiet`), with no line.
 */
export function carried(
  before: SetupAnswers,
  next: SetupAnswers,
  changes: Edits,
  paths: readonly string[],
  units: readonly (readonly string[])[] = [],
  sent: Edits = {},
): { kept: Edits; moved: string[]; quiet: string[] } {
  const moves = (path: string): boolean => answerText(before, path) !== answerText(next, path);
  const ours = (path: string): boolean => path in sent && holds(next, path, sent[path] as AnswerValue);
  const moved: string[] = [];
  const quiet: string[] = [];
  const stays: Edits = {};
  for (const path of Object.keys(changes)) {
    const unit = units.find((one) => one.includes(path)) ?? [path];
    const shifted = unit.filter(moves);
    if (shifted.length === 0) {
      // A path of the section's own changes, read back as it was set.
      // eslint-disable-next-line security/detect-object-injection
      stays[path] = changes[path] as AnswerValue;
    } else if (shifted.every(ours)) quiet.push(path);
    else moved.push(path);
  }
  return { kept: changedOf(next, withEdits(next, stays), paths), moved, quiet };
}

/** True when `answers` hold `value` at `path`, as the answers read it. */
function holds(answers: SetupAnswers, path: string, value: AnswerValue): boolean {
  return answerText(answers, path) === answerText(withEdits(answers, { [path]: value }), path);
}

/** True when what is saved holds every answer a save sent: the save landed,
 *  even if its answer never reached the page. */
export function savedAs(saved: SetupAnswers, sent: Edits): boolean {
  return Object.keys(sent).every((path) => holds(saved, path, sent[path] as AnswerValue));
}

/** Said under a field whose change was dropped by `carried`. */
export const SAVED_ELSEWHERE = "Someone else saved this while you were changing it.";

/** True when a section's answers differ from what is saved. */
export function differs(saved: SetupAnswers, answers: SetupAnswers, paths: readonly string[]): boolean {
  return paths.some((path) => answerText(saved, path) !== answerText(answers, path));
}

/** How the connection to the control plane stands, in plain words, from the
 *  daemon's status and the answer that is saved (`switchedOff`: the saved
 *  `controlPlane.connected` is `off`). `word` is the daemon's own word, shown
 *  as it is. `then` says what the next start changes. */
export function connectionLine(
  connection: ConnectionShown,
  switchedOff: boolean,
): { text: string; word: string | null; tone: "ok" | "off" | "bad"; then: string | null } {
  if (connection.state === "connected") {
    return {
      text: "Connected",
      word: null,
      tone: "ok",
      then: switchedOff ? "The connection ends when HX Fortress starts again." : null,
    };
  }
  if (switchedOff) return { text: "Switched off here", word: null, tone: "off", then: null };
  // A new install id was given, and is taken at the next start: whatever the
  // daemon says until then (refused, offline, connecting, or nothing that can
  // be read), that is what comes next. Read defensively: a server that does
  // not say leaves the field out.
  if (connection.idWaiting === true) return { text: ID_WAITS, word: null, tone: "off", then: null };
  if (connection.refused) {
    return { text: "The control plane refused the connection", word: connection.reason, tone: "bad", then: null };
  }
  return { text: NOT_CONNECTED, word: null, tone: "off", then: null };
}

/**
 * What the control plane's section shows of a new install id. The server
 * takes a new id only while the daemon's status says the control plane
 * refused the connection, so only then is one asked for: its field, or,
 * while an id already waits for the next start, the way to give another
 * (`another`). While an id waits and the connection is not refused (a start
 * that failed for another reason, or one still connecting), the section only
 * says that it waits: in the line under the switch, or (`said`) on its own
 * when that line says something that comes first. Nothing while connected.
 */
export function installIdShown(
  connection: ConnectionShown,
  now: { another: boolean; lineSaysWaiting: boolean },
): "field" | "another" | "said" | null {
  if (connection.state === "connected") return null;
  const waiting = connection.idWaiting === true;
  if (connection.refused) return waiting && !now.another ? "another" : "field";
  return waiting && !now.lineSaysWaiting ? "said" : null;
}

/**
 * How the control plane's section stands, for its header, its picture, its
 * switch and its line to say the same thing.
 *
 * The saved answer takes effect when HX Fortress starts again, so between a
 * save and that start the daemon can still be connected with the answer off.
 * While the person has not changed the switch, the section follows the
 * daemon: it is connected until the next start. While they have, the picture
 * and the switch say what the change does.
 */
export function controlPlaneNow(
  saved: SetupAnswers,
  answers: SetupAnswers,
  connection: ConnectionShown,
): {
  /** The daemon is connected now. */
  connected: boolean;
  /** Connected, with the saved answer off and the switch as saved: the
   *  connection ends when HX Fortress starts again. */
  endsAtStart: boolean;
  /** The picture draws a connected control plane. */
  pictureOn: boolean;
  /** The switch is on, and the control plane refused the connection or how
   *  it stands cannot be known: the picture draws none. */
  onButDown: boolean;
  /** The person changed the switch and has not saved it. */
  changed: boolean;
} {
  const named = answers.controlPlane.connect === "yes";
  const connected = connection.state === "connected";
  const changed = answers.controlPlane.connected !== saved.controlPlane.connected;
  const on = answers.controlPlane.connected !== "off";
  const endsAtStart = named && connected && !changed && saved.controlPlane.connected === "off";
  // Connecting, or offline with no refusal, is a connection still being
  // dialled, and is drawn. A refusal, or a status that cannot be read or is
  // too old to trust, is not.
  const onButDown = named && on && (connection.refused || connection.state === "unknown");
  return { connected, endsAtStart, pictureOn: named && ((on && !onButDown) || endsAtStart), onButDown, changed };
}

/** The picture's words in the control plane's place while the switch is on
 *  and no connection is drawn: the line's own words, which fit the place. */
export const NOT_CONNECTED = "Not connected";

/** The line while a new install id waits to be used. */
export const ID_WAITS = "A new install id waits for the next start of HX Fortress";

/** The header's few words while the connection ends at the next start. */
export const CONNECTED_UNTIL_START = "Connected until HX Fortress starts again";

/**
 * The control plane's switch, with the words of the list that are true now.
 *
 * The list gives the switch a label, a line for when it is on and a line for
 * when it is off. The label says the connection stands, and so does the line
 * for on. So a switch that is on while the connection is refused or down
 * says neither: it is named by its step's name alone. A switch that is off
 * while the connection still stands (until the next start, the change not
 * yet made) keeps the line for on, since the line for off says HX Fortress
 * calls nothing there.
 */
export function switchWords(block: SwitchBlock, stepName: string, now: { on: boolean; connected: boolean; changed: boolean }): SwitchBlock {
  if (now.on && !now.connected) {
    const { detail: _detail, detailOff: _detailOff, ...rest } = block;
    return { ...rest, label: stepName };
  }
  if (!now.on && now.connected && !now.changed && block.detail) return { ...block, detailOff: block.detail };
  return block;
}

/** The command that names a control plane, for an HX Fortress that names
 *  none. The words in angle brackets are what the control plane's own page
 *  gives. */
export const CONNECT_COMMAND = "hx-fortress setup --connect <address>/i/<id>";
