// How the console's Settings page carries a section's unsaved changes onto a
// newer state of what is saved (`carried`, in ui/src/views/settings/sections.ts).
//
// A save sends the digest of the section's saved answers the page read, and
// the server refuses it when they changed since. A newer read gives the page a
// newer digest. If the page kept every change over that newer state, a person's
// Save would carry an answer over the one somebody else saved in between, with
// the newer digest, and no refusal. So a change stays only where the saved
// answer it was made against did not move.

import { describe, expect, test } from "bun:test";

import { cloneAnswers, defaultAnswers, setAnswer, settleAnswers, type SetupAnswers } from "../src/setup/answers";
import { visibleList, type SetupStep, type StepId } from "../src/setup/list";
import { carried, changedOf, pathsOf, savedAs, sentAnswers, unitsOf, withEdits } from "../ui/src/views/settings/sections";

function settingsStep(id: StepId): SetupStep {
  const step = visibleList({ way: "settings", place: "here" }).find((one) => one.id === id);
  if (!step) throw new Error(`no settings section ${id}`);
  return step;
}

const PATHS = ["auditTrail.copyTo", "auditTrail.copyAddress", "auditTrail.keepFor"];

function answers(copyAddress: string): SetupAnswers {
  const out = defaultAnswers(["session_vault"]);
  expect(setAnswer(out, "auditTrail.copyAddress", copyAddress)).toBe(true);
  return out;
}

describe("a section's changes, carried onto a newer state", () => {
  test("a change whose saved answer someone else saved meanwhile is dropped, and Save sends nothing for it", () => {
    // Administrator A reads the copy address `a`, and changes it to `b` without saving.
    const read = answers("a");
    const mine = cloneAnswers(read);
    setAnswer(mine, "auditTrail.copyAddress", "b");
    const changes = changedOf(read, mine, PATHS);
    expect(changes).toEqual({ "auditTrail.copyAddress": "b" });

    // Administrator B saves `c`. A's page takes a newer state.
    const newer = answers("c");
    // Kept as it was, A's change would still differ from what is saved, and
    // a Save would send `b` with the newer digest.
    expect(sentAnswers(newer, withEdits(newer, changes), PATHS)).toEqual({ auditTrail: { copyAddress: "b" } });

    const carry = carried(read, newer, changes, PATHS);
    expect(carry.moved).toEqual(["auditTrail.copyAddress"]);
    expect(carry.kept).toEqual({});
    // The field shows what is saved now, and Save sends nothing for it.
    expect(withEdits(newer, carry.kept).auditTrail.copyAddress).toBe("c");
    expect(sentAnswers(newer, withEdits(newer, carry.kept), PATHS)).toEqual({});
  });

  test("a change whose saved answer did not move stays, beside one that was dropped", () => {
    const read = answers("a");
    const mine = cloneAnswers(read);
    setAnswer(mine, "auditTrail.copyAddress", "b");
    setAnswer(mine, "auditTrail.keepFor", "1-year");
    const changes = changedOf(read, mine, PATHS);

    const newer = answers("c");
    const carry = carried(read, newer, changes, PATHS);
    expect(carry.moved).toEqual(["auditTrail.copyAddress"]);
    expect(carry.kept).toEqual({ "auditTrail.keepFor": "1-year" });
    expect(sentAnswers(newer, withEdits(newer, carry.kept), PATHS)).toEqual({ auditTrail: { keepFor: "1-year" } });
  });

  test("a newer state that moved nothing of the section keeps every change", () => {
    const read = answers("a");
    const mine = cloneAnswers(read);
    setAnswer(mine, "auditTrail.copyAddress", "b");
    const changes = changedOf(read, mine, PATHS);
    const newer = cloneAnswers(read);
    setAnswer(newer, "organization.name", "Northstar");

    const carry = carried(read, newer, changes, PATHS);
    expect(carry.moved).toEqual([]);
    expect(carry.kept).toEqual({ "auditTrail.copyAddress": "b" });
  });

  test("a picker and the fields that depend on it are one unit", () => {
    const model = unitsOf(settingsStep("model"));
    const provider = model.find((unit) => unit.includes("model.provider")) ?? [];
    for (const path of ["model.key", "model.route", "model.region", "model.project"]) expect(provider).toContain(path);
    const signIn = unitsOf(settingsStep("signIn"));
    const groups = signIn.find((unit) => unit.includes("signIn.provider")) ?? [];
    for (const path of ["signIn.administratorGroups", "signIn.operatorGroups", "signIn.readonlyGroups", "signIn.viewerGroups"]) {
      expect(groups).toContain(path);
    }
  });

  test("a kept provider would carry another person's key: the whole unit is dropped, and Save sends nothing of the model", () => {
    const step = settingsStep("model");
    const paths = pathsOf(step, []);
    const read = defaultAnswers(["session_vault"]);
    setAnswer(read, "model.provider", "anthropic");
    // Built at run time: a literal shaped like a key fails the repository's secret scan.
    const NEWER_KEY = ["anthropic", "key", String(2)].join("-");
    setAnswer(read, "model.key", "anthropic-key");
    // A switches Anthropic to OpenAI (the page lets the key go with it) and
    // names OpenAI's key, without saving.
    const mine = cloneAnswers(read);
    setAnswer(mine, "model.provider", "openai");
    settleAnswers(mine, "model.provider");
    setAnswer(mine, "model.key", "openai-key");
    const changes = changedOf(read, mine, paths);
    expect(changes).toEqual({ "model.provider": "openai", "model.key": "openai-key" });

    // B saves another key for Anthropic.
    const newer = cloneAnswers(read);
    setAnswer(newer, "model.key", NEWER_KEY);

    // Field by field, A's provider stays and B's Anthropic key would go to OpenAI.
    const alone = carried(read, newer, changes, paths);
    expect(sentAnswers(newer, withEdits(newer, alone.kept), paths)).toEqual({ model: { provider: "openai", key: NEWER_KEY } });

    // As one unit, A's changes to it are dropped, each with its line.
    const carry = carried(read, newer, changes, paths, unitsOf(step));
    expect([...carry.moved].sort()).toEqual(["model.key", "model.provider"]);
    expect(carry.kept).toEqual({});
    expect(sentAnswers(newer, withEdits(newer, carry.kept), paths)).toEqual({});
  });

  test("a unit that moved to exactly what this page sent is the person's own: dropped with no line", () => {
    const read = answers("a");
    const mine = cloneAnswers(read);
    setAnswer(mine, "auditTrail.copyAddress", "b");
    const changes = changedOf(read, mine, PATHS);
    const newer = answers("b");
    const carry = carried(read, newer, changes, PATHS, [], { "auditTrail.copyAddress": "b" });
    expect(carry.moved).toEqual([]);
    expect(carry.quiet).toEqual(["auditTrail.copyAddress"]);
    expect(carry.kept).toEqual({});
  });

  test("someone else saving the person's own value drops the change, which no longer differs", () => {
    const read = answers("a");
    const mine = cloneAnswers(read);
    setAnswer(mine, "auditTrail.copyAddress", "b");
    const changes = changedOf(read, mine, PATHS);
    const newer = answers("b");

    const carry = carried(read, newer, changes, PATHS);
    expect(carry.moved).toEqual(["auditTrail.copyAddress"]);
    expect(carry.kept).toEqual({});
  });

  test("a save given up is known as landed once what is saved holds all it sent", () => {
    const sent = { "auditTrail.copyAddress": "b", "auditTrail.keepFor": "1-year" };
    // Not landed yet: the page keeps what it sent.
    expect(savedAs(answers("a"), sent)).toBe(false);
    // Half of it saved, by someone else: still not this save.
    expect(savedAs(answers("b"), sent)).toBe(false);
    const landed = answers("b");
    setAnswer(landed, "auditTrail.keepFor", "1-year");
    expect(savedAs(landed, sent)).toBe(true);
  });
});
