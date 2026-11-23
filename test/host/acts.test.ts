// A person's act: what the act gate checks before a module hears it, what the
// module's context can then do, and what the audit trail holds afterwards.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { AUDIT_ACTIONS, MAX_ACTOR_CHARS } from "../../src/console/audit-actions";
import { ACT_REPLY_MAX_BYTES } from "../../src/host/act-gate";
import { AskFailure, manifestDefect, type ModuleManifest } from "../../src/host/module-contract";
import { ModuleLists, REACH_MAX_ENTRIES, SECRET_NAMES_MAX_ENTRIES } from "../../src/host/module-lists";
import { S } from "../../src/host/shape";
import {
  ACTS_MANIFEST,
  MADE_UP_KEY_NAME,
  MADE_UP_TOKEN_NAME,
  MADE_UP_VALUE,
  act,
  makeActsRig,
  OPERATOR,
  READER,
  recordsOf,
  SESSION,
  story,
  type ActsRig,
} from "./_acts-rig";
import { ask, ROW_VALUE, SECRET_VALUE, spoolRecords, spoolText, writeConfig, writeOrganizations } from "./_module-rig";

let rig: ActsRig;
afterEach(async () => {
  await rig?.cleanup();
});

const THING = { name: "orders-1", host: "db.northstar.example", port: 1433, keyName: "orders-reader" };
const listFile = (name: string): string => path.join(path.dirname(rig.paths.moduleState("probe")), name);
const logText = (): string => JSON.stringify(rig.logs);

describe("a manifest's acts", () => {
  test("a manifest with acts passes, and each rule of an act is checked", () => {
    expect(manifestDefect(ACTS_MANIFEST)).toBeNull();
    const withActs = (acts: unknown): ModuleManifest => ({ ...ACTS_MANIFEST, acts } as ModuleManifest);
    const one = { name: "thing.add", role: "operator", args: S.none, reply: S.none };
    expect(manifestDefect(withActs("no"))).toBe("the manifest's acts must be a list");
    expect(manifestDefect(withActs([{ ...one, name: "Thing Add" }]))).toBe(
      "an act's name must be lower-case words joined by dots",
    );
    expect(manifestDefect(withActs([one, one]))).toBe("the act thing.add is listed twice");
    expect(manifestDefect(withActs([{ ...one, role: "owner" }]))).toBe(
      "the role of thing.add must be operator or readonly",
    );
    expect(manifestDefect(withActs([{ ...one, args: S.name }]))).toBe("the args of thing.add must be a record");
    expect(manifestDefect(withActs([{ ...one, reply: { kind: "text" } }]))).toMatch(/^the reply of thing\.add: /);
    expect(manifestDefect(withActs(Array.from({ length: 65 }, (_, i) => ({ ...one, name: `thing.add${i}` }))))).toBe(
      "a module may list at most 64 acts",
    );
    // A manifest that lists none is what every manifest was before.
    const without: ModuleManifest = { ...ACTS_MANIFEST };
    delete without.acts;
    expect(manifestDefect(without)).toBeNull();
  });
});

describe("an operator's act", () => {
  test("it runs, and the trail holds it as a pair under the person's login", async () => {
    rig = await makeActsRig();
    expect(await act(rig, "thing.add", THING)).toEqual({ ok: true, reply: { name: "orders-1" } });
    expect(rig.acts.acted).toEqual([{ act: "thing.add", args: THING, person: OPERATOR }]);

    const [intent, outcome] = await recordsOf(rig, AUDIT_ACTIONS.consoleModuleAct);
    expect(intent).toMatchObject({
      kind: "intent",
      actor: "maya.chen",
      sessionRef: SESSION,
      params: { module: "probe", act: "thing.add" },
    });
    expect(outcome).toMatchObject({ kind: "outcome", outcome: "ok", error: null, refSeq: intent?.seq });
    // The act's record is first, and the changes it made are inside it.
    expect(await story(rig, "console.module.")).toEqual([
      "console.module.act intent - -",
      "console.module.reach.add intent - -",
      "console.module.reach.add outcome ok -",
      "console.module.secret.add intent - -",
      "console.module.secret.add outcome ok -",
      "console.module.act outcome ok -",
    ]);
  });

  test("what it added is on the two lists, in files only this user can read, beside the module's state", async () => {
    rig = await makeActsRig();
    await act(rig, "thing.add", THING);
    const reach: unknown = JSON.parse(await readFile(listFile("reach.json"), "utf8"));
    expect(reach).toEqual({
      version: 1,
      entries: [
        { name: "orders-1", host: "db.northstar.example", port: 1433, addedBy: "maya.chen", addedAt: rig.now.value.toISOString() },
      ],
    });
    const names = JSON.parse(await readFile(listFile("secret-names.json"), "utf8")) as { entries: unknown[] };
    expect(names.entries).toEqual([{ name: "orders-reader", addedBy: "maya.chen", addedAt: rig.now.value.toISOString() }]);
    for (const file of ["reach.json", "secret-names.json"]) {
      expect((await stat(listFile(file))).mode & 0o777).toBe(0o600);
    }
    // Not inside the state folder: a state key cannot name either file.
    expect(path.dirname(listFile("reach.json"))).toBe(path.dirname(rig.paths.moduleState("probe")));

    const [, added] = await recordsOf(rig, AUDIT_ACTIONS.consoleModuleReachAdd);
    const [reachIntent] = await recordsOf(rig, AUDIT_ACTIONS.consoleModuleReachAdd);
    expect(reachIntent).toMatchObject({
      actor: "maya.chen",
      sessionRef: SESSION,
      params: { module: "probe", name: "orders-1", host: "db.northstar.example", port: 1433 },
    });
    expect(added).toMatchObject({ outcome: "ok" });
    const [nameIntent] = await recordsOf(rig, AUDIT_ACTIONS.consoleModuleSecretAdd);
    expect(nameIntent).toMatchObject({ actor: "maya.chen", params: { module: "probe", name: "orders-reader" } });
  });

  test("every context of the module can read the two lists, and an ask cannot add to them", async () => {
    rig = await makeActsRig();
    await act(rig, "thing.add", THING);
    expect(await act(rig, "things.read", {}, READER)).toEqual({
      ok: true,
      reply: {
        reaches: [{ name: "orders-1", host: "db.northstar.example", port: 1433, addedBy: "maya.chen" }],
        names: ["orders-reader"],
      },
    });
    expect(await ask(rig, "probe", "lists.count")).toEqual({ ok: true, payload: { reaches: 1, names: 1, canAdd: false } });
  });

  test("removing takes an entry off its list, and removing what is not there changes and records nothing", async () => {
    rig = await makeActsRig();
    await act(rig, "thing.add", THING);
    expect(await act(rig, "thing.remove", { name: "orders-1", keyName: "orders-reader" })).toEqual({ ok: true, reply: {} });
    expect(await act(rig, "things.read", {}, READER)).toEqual({ ok: true, reply: { reaches: [], names: [] } });
    const removed = await recordsOf(rig, AUDIT_ACTIONS.consoleModuleReachRemove);
    expect(removed).toHaveLength(2);
    // The record of a removal says what was removed.
    expect(removed[0]).toMatchObject({ params: { module: "probe", name: "orders-1", host: "db.northstar.example", port: 1433 } });
    expect(await recordsOf(rig, AUDIT_ACTIONS.consoleModuleSecretRemove)).toHaveLength(2);

    // Again: nothing is there, so nothing happens and nothing is written.
    expect(await act(rig, "thing.remove", { name: "orders-1", keyName: "orders-reader" })).toEqual({ ok: true, reply: {} });
    expect(await act(rig, "thing.remove", { name: "never added" })).toEqual({ ok: true, reply: {} });
    expect(await recordsOf(rig, AUDIT_ACTIONS.consoleModuleReachRemove)).toHaveLength(2);
    expect(await recordsOf(rig, AUDIT_ACTIONS.consoleModuleSecretRemove)).toHaveLength(2);
  });

  test("a module can remove a key of its state", async () => {
    rig = await makeActsRig();
    expect(await act(rig, "state.cycle")).toEqual({ ok: true, reply: { held: true, gone: true } });
    await expect(stat(path.join(rig.paths.moduleState("probe"), "scratch.json"))).rejects.toMatchObject({ code: "ENOENT" });
    // A key is one segment of a path, for a removal as for a write.
    const state = rig.acts.actContext?.state;
    await expect(state?.remove("../config")).rejects.toThrow(TypeError);
  });
});

describe("an act any signed-in person may do", () => {
  test("it runs for a read-only person, and is not recorded one by one", async () => {
    rig = await makeActsRig();
    expect(await act(rig, "things.read", {}, READER)).toEqual({ ok: true, reply: { reaches: [], names: [] } });
    expect(rig.acts.acted[0]?.person).toEqual(READER);
    expect(await story(rig, "console.module.")).toEqual([]);
  });

  test("its context can add no host and no secret's name, whoever does it", async () => {
    rig = await makeActsRig();
    for (const person of [READER, OPERATOR]) {
      expect(await act(rig, "sneak.add", THING, person)).toEqual({ ok: false, error: "failed:not_allowed" });
    }
    await expect(stat(listFile("reach.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(listFile("secret-names.json"))).rejects.toMatchObject({ code: "ENOENT" });
    // The module tried the change, and the person asked for an act that
    // changes nothing: the record is the module's own refused call, and it
    // names nobody.
    expect(await recordsOf(rig, AUDIT_ACTIONS.consoleModuleReachAdd)).toEqual([]);
    const refused = await recordsOf(rig, AUDIT_ACTIONS.moduleRefused);
    expect(refused[0]).toMatchObject({ outcome: "refused", actor: null, params: { module: "probe", rule: "list_change_not_allowed" } });
    // What was asked for is not in the record.
    expect(await spoolText(rig.paths)).not.toContain("db.northstar.example");
  });
});

describe("every change an act for any signed-in person can try", () => {
  test("it can remove no host, and add or remove no secret's name either, and each try is recorded", async () => {
    rig = await makeActsRig();
    expect(await act(rig, "thing.add", THING)).toMatchObject({ ok: true });
    for (const person of [READER, OPERATOR]) {
      expect(await act(rig, "sneak.all", {}, person)).toEqual({
        ok: true,
        reply: {
          tried: [
            "reach.add: not_allowed",
            "reach.remove: not_allowed",
            "secretNames.add: not_allowed",
            "secretNames.remove: not_allowed",
          ],
        },
      });
    }
    // Both lists are as the operator left them.
    const entries = async (file: string): Promise<string[]> =>
      (JSON.parse(await readFile(listFile(file), "utf8")) as { entries: { name: string }[] }).entries.map((entry) => entry.name);
    expect(await entries("reach.json")).toEqual(["orders-1"]);
    expect(await entries("secret-names.json")).toEqual(["orders-reader"]);
    // The tries are in the trail as the module's own refused calls: eight of
    // them, as the first and a count of the seven that followed. No record of
    // a person's change says that anybody was refused.
    await rig.host.audit.flush();
    for (const action of [
      AUDIT_ACTIONS.consoleModuleReachAdd,
      AUDIT_ACTIONS.consoleModuleReachRemove,
      AUDIT_ACTIONS.consoleModuleSecretAdd,
      AUDIT_ACTIONS.consoleModuleSecretRemove,
    ]) {
      const refused = (await recordsOf(rig, action)).filter((record) => record.outcome === "refused");
      expect([action, refused]).toEqual([action, []]);
    }
    const tries = (await recordsOf(rig, AUDIT_ACTIONS.moduleRefused)).map((record) => [record.actor, record.params]);
    expect(tries).toMatchObject([
      [null, { module: "probe", rule: "list_change_not_allowed" }],
      [null, { module: "probe", rule: "list_change_not_allowed", attempts: 7 }],
    ]);
    expect(await spoolText(rig.paths)).not.toContain("sneaked");
  });
});

describe("a context that a module kept", () => {
  test("after its act has ended it can change neither list, and the try is recorded as the module's own, under nobody's login", async () => {
    rig = await makeActsRig();
    expect(await act(rig, "thing.add", THING)).toMatchObject({ ok: true });
    // The module kept the context of that act, which was an operator's.
    const kept = rig.acts.actContext;
    if (!kept) throw new Error("the probe kept no context");
    await expect(kept.reach.add("later", { host: "other.northstar.example", port: 5432 })).rejects.toMatchObject({
      name: "ReachRefused",
      rule: "not_allowed",
    });
    await expect(kept.reach.remove("orders-1")).rejects.toMatchObject({ rule: "not_allowed" });
    await expect(kept.secretNames.add("later-key")).rejects.toMatchObject({
      name: "SecretNameRefused",
      rule: "not_allowed",
    });
    await expect(kept.secretNames.remove("orders-reader")).rejects.toMatchObject({ rule: "not_allowed" });
    // Reading still works, and nothing changed.
    expect((await kept.reach.list()).map((entry) => entry.name)).toEqual(["orders-1"]);
    expect(await kept.secretNames.list()).toEqual(["orders-reader"]);
    // The person's act ended long ago. Nothing says that she was refused.
    for (const action of [AUDIT_ACTIONS.consoleModuleReachAdd, AUDIT_ACTIONS.consoleModuleSecretAdd]) {
      expect((await recordsOf(rig, action)).filter((record) => record.outcome === "refused")).toEqual([]);
    }
    const refused = await recordsOf(rig, AUDIT_ACTIONS.moduleRefused);
    expect(refused[0]).toMatchObject({ actor: null, params: { module: "probe", rule: "list_change_not_allowed" } });
    expect(await spoolText(rig.paths)).not.toContain("other.northstar.example");
  });

  test("while its act still runs past the deadline, it still works: the act is still being carried out", async () => {
    rig = await makeActsRig({ deps: { actDeadlineMs: 20 } });
    expect(await act(rig, "never.changes")).toEqual({ ok: false, error: "failed:timeout" });
    const running = rig.acts.actContext;
    if (!running) throw new Error("the probe kept no context");
    await running.reach.add("late-but-running", { host: "db.northstar.example", port: 5432 });
    expect((await running.reach.list()).map((entry) => entry.name)).toEqual(["late-but-running"]);
  });
});

describe("what a module records in an act", () => {
  /** The module's own records of one action, as the trail holds them. */
  const noted = async (action: string): Promise<unknown[]> =>
    (await recordsOf(rig, `module.probe.${action}`)).map((record) => ({
      actor: record.actor,
      sessionRef: record.sessionRef,
      params: record.params,
      outcome: record.outcome,
    }));
  /** A record is written without being waited for. */
  const until = async (action: string, count = 1): Promise<unknown[]> => {
    for (let i = 0; i < 400 && (await noted(action)).length < count; i += 1) await Bun.sleep(5);
    return noted(action);
  };
  /** Start an act that waits until the test ends it, and hand back its context. */
  const held = async (name: "held" | "held.changes", person: unknown = OPERATOR) => {
    const before = rig.acts.held.length;
    const answer = act(rig, name, {}, person);
    while (rig.acts.held.length === before) await Bun.sleep(1);
    const context = rig.acts.actContext;
    if (!context) throw new Error("the probe kept no context");
    return { answer, context, end: () => rig.acts.held[before]?.end() };
  };

  test("a record of the act is under the person's login, as the act's own pair is", async () => {
    rig = await makeActsRig();
    const running = await held("held.changes");
    // The module passes no login: the host knows who is acting.
    running.context.audit.recordAct("thing.noted", { target: "orders-1", rows: 3 });
    expect(await until("thing.noted")).toEqual([
      { actor: "maya.chen", sessionRef: SESSION, params: { target: "orders-1", rows: 3 }, outcome: "done" },
    ]);
    running.end();
    expect(await running.answer).toMatchObject({ ok: true });
    // The same login and the same sign-in as on the pair of the act itself.
    const pair = await recordsOf(rig, AUDIT_ACTIONS.consoleModuleAct);
    expect(pair.map((record) => [record.actor, record.sessionRef])).toEqual([
      ["maya.chen", SESSION],
      ["maya.chen", SESSION],
    ]);
  });

  test("any other record names nobody, also while the act runs: the module says which record is the person's", async () => {
    rig = await makeActsRig();
    const running = await held("held.changes");
    // Work the module does on the way, which is not what the person asked
    // for: it closes a job that another caller started and that was lost.
    running.context.audit.record("job.lost", { target: "orders-1" });
    running.context.audit.recordAct("thing.noted", { target: "orders-1" });
    expect(await until("thing.noted")).toMatchObject([{ actor: "maya.chen", sessionRef: SESSION }]);
    expect(await until("job.lost")).toEqual([
      { actor: null, sessionRef: null, params: { target: "orders-1" }, outcome: "done" },
    ]);
    running.end();
    await running.answer;
    // Nothing of the module's own is under her login but the one record.
    const hers = (await spoolRecords(rig.paths)).filter(
      (record) => record.actor === "maya.chen" && record.action.startsWith("module."),
    );
    expect(hers.map((record) => record.action)).toEqual(["module.probe.thing.noted"]);
  });

  test("a login that no name can hold is on the record whole, with nothing passed by the module", async () => {
    rig = await makeActsRig();
    // A login the console's sign-in takes. A plus sign is in no name, so as a
    // detail field of the module's own it would be left out of the record.
    const login = "ada+ops@northstar.example";
    const running = await held("held.changes", { login, email: login, role: "operator" });
    running.context.audit.recordAct("thing.noted", { target: "orders-1" });
    expect(await until("thing.noted")).toEqual([
      { actor: login, sessionRef: SESSION, params: { target: "orders-1" }, outcome: "done" },
    ]);
    running.end();
    await running.answer;
  });

  test("in an act that every signed-in person may do, it is under that person's login too", async () => {
    rig = await makeActsRig();
    const running = await held("held", READER);
    running.context.audit.recordAct("thing.read", { target: "orders-1" });
    expect(await until("thing.read")).toEqual([
      { actor: "lena.hart", sessionRef: SESSION, params: { target: "orders-1" }, outcome: "done" },
    ]);
    running.end();
    await running.answer;
    // The host records no pair for such an act. The module's own line is all there is.
    expect(await recordsOf(rig, AUDIT_ACTIONS.consoleModuleAct)).toEqual([]);
  });

  test("through a context the module kept, after the act's work has ended, it names nobody", async () => {
    rig = await makeActsRig();
    const running = await held("held.changes");
    running.end();
    expect(await running.answer).toMatchObject({ ok: true });
    // A job that the act started ends later, and the module writes that with
    // the context it kept. Nobody is acting any more, whichever way it writes.
    running.context.audit.recordAct("job.ended", { target: "orders-1" });
    running.context.audit.record("thing.noted", { target: "orders-1" });
    expect(await until("thing.noted")).toEqual([
      { actor: null, sessionRef: null, params: { target: "orders-1" }, outcome: "done" },
    ]);
    expect(await until("job.ended")).toEqual([
      { actor: null, sessionRef: null, params: { target: "orders-1" }, outcome: "done" },
    ]);
  });

  test("past the deadline it is still under the person's login for as long as the work goes on, and then under nobody's", async () => {
    rig = await makeActsRig({ deps: { actDeadlineMs: 20 } });
    const running = await held("held.changes");
    expect(await running.answer).toEqual({ ok: false, error: "failed:timeout" });
    // Answered as timed out, and still being carried out.
    running.context.audit.recordAct("thing.noted", { target: "still-running" });
    expect(await until("thing.noted")).toMatchObject([{ actor: "maya.chen", sessionRef: SESSION }]);
    running.end();
    // The work has ended once the record of its late end is written.
    for (let i = 0; i < 400 && (await recordsOf(rig, AUDIT_ACTIONS.consoleModuleActEndedLate)).length === 0; i += 1) {
      await Bun.sleep(5);
    }
    running.context.audit.recordAct("thing.noted", { target: "after-the-end" });
    expect(await until("thing.noted", 2)).toMatchObject([
      { actor: "maya.chen", params: { target: "still-running" } },
      { actor: null, sessionRef: null, params: { target: "after-the-end" } },
    ]);
  });

  test("an act that failed leaves its context as one that ended: a later record names nobody", async () => {
    rig = await makeActsRig();
    const before = rig.acts.held.length;
    const answer = act(rig, "held.changes");
    while (rig.acts.held.length === before) await Bun.sleep(1);
    const context = rig.acts.actContext;
    if (!context) throw new Error("the probe kept no context");
    rig.acts.held[before]?.fail(new AskFailure("connection_unknown"));
    expect(await answer).toEqual({ ok: false, error: "failed:connection_unknown" });
    context.audit.recordAct("thing.noted", { target: "orders-1" });
    expect(await until("thing.noted")).toMatchObject([{ actor: null, sessionRef: null }]);
  });

  test("two people's acts at once: each record is under the login of the act it was written in", async () => {
    rig = await makeActsRig();
    const first = await held("held.changes");
    const second = await held("held", READER);
    second.context.audit.recordAct("thing.noted", { target: "second" });
    first.context.audit.recordAct("thing.noted", { target: "first" });
    const records = (await until("thing.noted", 2)) as { actor: string; params: { target: string } }[];
    expect(records.map((record) => [record.params.target, record.actor]).sort()).toEqual([
      ["first", "maya.chen"],
      ["second", "lena.hart"],
    ]);
    first.end();
    second.end();
    await Promise.all([first.answer, second.answer]);
  });

  test("an ask's context has no way to name a person, and a field is a field, whatever it is called", async () => {
    rig = await makeActsRig();
    const grant = await rig.key.grant("probe", "lists.count", {});
    expect(await ask(rig, "probe", "lists.count", {}, grant)).toMatchObject({ ok: true });
    const asked = rig.acts.askContext;
    if (!asked) throw new Error("the probe kept no context");
    // Only the context of an act has the second way to write a record.
    expect("recordAct" in asked.audit).toBe(false);
    asked.audit.record("thing.noted", { target: "for-an-ask", actor: "somebody.else", sessionRef: "0".repeat(32) });
    expect(await until("thing.noted")).toEqual([
      {
        actor: null,
        sessionRef: null,
        params: { target: "for-an-ask", actor: "somebody.else", sessionRef: "0".repeat(32) },
        outcome: "done",
      },
    ]);
    // In an act the person is the one the console named, and such a field
    // changes nothing about that.
    const running = await held("held.changes");
    running.context.audit.recordAct("thing.claimed", { target: "in-an-act", actor: "somebody.else" });
    expect(await until("thing.claimed")).toEqual([
      { actor: "maya.chen", sessionRef: SESSION, params: { target: "in-an-act", actor: "somebody.else" }, outcome: "done" },
    ]);
    running.end();
    await running.answer;
  });

  test("a record of the act is held to a module's action like any other", async () => {
    rig = await makeActsRig();
    const running = await held("held.changes");
    expect(() => running.context.audit.recordAct("Thing Noted!", {})).toThrow(TypeError);
    expect(() => running.context.audit.recordAct("../console.module.act", {})).toThrow(TypeError);
    running.end();
    await running.answer;
    expect((await spoolRecords(rig.paths)).filter((record) => record.action.startsWith("module."))).toEqual([]);
  });
});

describe("an act the gate turns away", () => {
  test("a read-only person cannot do an operator's act, and the module hears nothing", async () => {
    rig = await makeActsRig();
    expect(await act(rig, "thing.add", THING, READER)).toEqual({ ok: false, error: "not_allowed" });
    expect(rig.acts.acted).toEqual([]);
    expect(await recordsOf(rig, AUDIT_ACTIONS.consoleModuleAct)).toMatchObject([
      { outcome: "refused", actor: "lena.hart", params: { module: "probe", act: "thing.add", rule: "role" } },
    ]);
  });

  test("a module that is switched off, one this build does not ship, and an act that is not on the list", async () => {
    rig = await makeActsRig();
    expect(await act(rig, "thing.add", THING, OPERATOR, { module: "evil_module" })).toEqual({ ok: false, error: "act_unknown" });
    expect(await act(rig, "thing.add", THING, OPERATOR, { module: "../../etc" })).toEqual({ ok: false, error: "act_unknown" });
    expect(await act(rig, "made.up")).toEqual({ ok: false, error: "act_unknown" });
    expect(await act(rig, "Not A Name")).toEqual({ ok: false, error: "act_unknown" });
    // An ask's name is not an act.
    expect(await act(rig, "lists.count")).toEqual({ ok: false, error: "act_unknown" });
    await writeConfig(rig.paths, ["session_vault"]);
    expect(await act(rig, "thing.add", THING)).toEqual({ ok: false, error: "module_off" });
    expect(rig.acts.acted).toEqual([]);

    const rules = (await recordsOf(rig, AUDIT_ACTIONS.consoleModuleAct)).map((record) => {
      const params = record.params as { module: string; act: string; rule: string };
      return `${params.module} ${params.act} ${params.rule}`;
    });
    expect(rules).toEqual([
      "unknown unknown module_unknown",
      "probe unknown act_not_in_manifest",
      "probe unknown act_malformed",
      "probe thing.add module_off",
    ]);
    // A name somebody sent is never copied into the trail.
    const spool = await spoolText(rig.paths);
    for (const sent of ["evil_module", "etc", "made.up", "Not A Name", "lists.count"]) expect(spool).not.toContain(sent);
  });

  test("a module that is on and takes no acts answers like an act that does not exist", async () => {
    rig = await makeActsRig();
    expect(await act(rig, "thing.add", THING, OPERATOR, { module: "session_vault" })).toEqual({
      ok: false,
      error: "act_unknown",
    });
  });

  test("a request that is not one, and a person who is not one", async () => {
    rig = await makeActsRig();
    for (const request of [null, "act", [], { v: 2, person: OPERATOR, module: "probe", act: "thing.add", args: THING }]) {
      expect(await rig.host.acts.handle(request)).toEqual({ ok: false, error: "failed:request_invalid" });
    }
    for (const person of [
      null,
      "maya.chen",
      { login: "", email: null, role: "operator" },
      { login: "x".repeat(MAX_ACTOR_CHARS + 1), email: null, role: "operator" },
      { login: "maya\nchen", email: null, role: "operator" },
      { login: "maya.chen", email: null, role: "owner" },
      { login: "maya.chen", role: "operator" },
      { login: "maya.chen", email: "Maya.Chen@northstar.example", role: "operator" },
      { login: "maya.chen", email: "not an address", role: "operator" },
      // An email is held to the one test for an email (shape.ts).
      { login: "maya.chen", email: "", role: "operator" },
      { login: "maya.chen", email: "maya.chen@northstar", role: "operator" },
      { login: "maya.chen", email: "maya chen@northstar.example", role: "operator" },
      { login: "maya.chen", email: "maya&chen@northstar.example", role: "operator" },
      { login: "maya.chen", email: `${"m".repeat(65)}@northstar.example`, role: "operator" },
      { login: "maya.chen", email: 7, role: "operator" },
    ]) {
      expect(await act(rig, "thing.add", THING, person)).toEqual({ ok: false, error: "failed:request_invalid" });
    }
    expect(rig.acts.acted).toEqual([]);
    const rules = (await recordsOf(rig, AUDIT_ACTIONS.consoleModuleAct)).map(
      (record) => (record.params as { rule: string }).rule,
    );
    expect(new Set(rules)).toEqual(new Set(["request_malformed", "person_malformed"]));
    // An address with a plus sign and an apostrophe is one, and the module is
    // handed it as it is.
    const person = { login: "o.brien", email: "o'brien+ops@northstar.example", role: "operator" as const };
    expect(await act(rig, "state.cycle", {}, person)).toMatchObject({ ok: true });
    expect(rig.acts.acted.at(-1)?.person).toEqual(person);
  });

  test("arguments that do not have the declared shape", async () => {
    rig = await makeActsRig();
    expect(await act(rig, "thing.add", { ...THING, port: "1433" })).toEqual({ ok: false, error: "args_invalid" });
    expect(await act(rig, "thing.add", { ...THING, extra: true })).toEqual({ ok: false, error: "args_invalid" });
    expect(await act(rig, "thing.add", [THING])).toEqual({ ok: false, error: "args_invalid" });
    expect(await act(rig, "thing.add", null)).toEqual({ ok: false, error: "args_invalid" });
    expect(rig.acts.acted).toEqual([]);
    const refused = await recordsOf(rig, AUDIT_ACTIONS.consoleModuleAct);
    expect(refused[0]).toMatchObject({ params: { module: "probe", act: "thing.add", field: "port" } });
    expect((refused[0]?.params as { rule: string }).rule).toMatch(/^args_/);
    expect(refused.some((record) => (record.params as { rule: string }).rule === "args_not_an_object")).toBe(true);
  });

  test("an argument that looks like a credential is refused before anything is saved under it", async () => {
    rig = await makeActsRig();
    const header = ["Authorization", ": ", ["Zm9vOmJh", "cjEyMzQ1"].join("")].join("");
    const address = ["postgres://reader", ":", "hunter2-not-a-real-one", "@db.northstar.example/billing"].join("");
    for (const [field, args] of [
      ["name", { ...THING, name: MADE_UP_TOKEN_NAME }],
      ["name", { ...THING, name: header }],
      ["name", { ...THING, name: address }],
      ["keyName", { ...THING, keyName: MADE_UP_KEY_NAME }],
      // An ordinary word in front of an ordinary name is taken for one too.
      ["name", { ...THING, name: "token database of Northstar" }],
    ] as const) {
      expect([field, await act(rig, "thing.add", args)]).toEqual([field, { ok: false, error: "args_invalid" }]);
    }
    // One record for each field at once, and one count of the three that
    // followed for `name` when its minute closes. Each says the rule and the
    // field, under the person's login.
    await rig.host.audit.flush();
    const refused = (await recordsOf(rig, AUDIT_ACTIONS.consoleModuleAct)).filter((record) => record.outcome === "refused");
    expect(refused.every((record) => record.actor === "maya.chen")).toBe(true);
    expect(refused.map((record) => record.params)).toEqual([
      { module: "probe", act: "thing.add", rule: "args_look_like_a_credential", field: "name" },
      { module: "probe", act: "thing.add", rule: "args_look_like_a_credential", field: "keyName" },
      expect.objectContaining({ rule: "args_look_like_a_credential", field: "name", attempts: 3 }),
    ]);
    // The module heard nothing, nothing was saved, and none of the texts is in the trail or the log.
    expect(rig.acts.acted).toEqual([]);
    await expect(stat(listFile("reach.json"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const text of [await spoolText(rig.paths), logText()]) {
      for (const sent of [MADE_UP_VALUE, MADE_UP_KEY_NAME, "hunter2", "Zm9vOmJh", "token database"]) {
        expect(text).not.toContain(sent);
      }
    }
    // Names that only hold such a word are taken.
    for (const name of ["Northstar tokens", "Authorization", "Key store 2", "passwords"]) {
      expect([name, await act(rig, "thing.add", { ...THING, name })]).toMatchObject([name, { ok: true }]);
    }
  });

  test("a session that is not the console's own id is left out of the record, and the act still runs", async () => {
    rig = await makeActsRig();
    // The console's id is 32 hex characters. Nothing else is one.
    const notIds = ["not an id\nfake record", "0123456789abcdef", `${SESSION}0`, SESSION.toUpperCase(), 7, null];
    for (const session of notIds) {
      expect([session, await act(rig, "state.cycle", {}, OPERATOR, { session })]).toMatchObject([session, { ok: true }]);
    }
    const intents = (await recordsOf(rig, AUDIT_ACTIONS.consoleModuleAct)).filter((record) => record.kind === "intent");
    expect(intents.map((record) => record.sessionRef)).toEqual(notIds.map(() => null));
    // The control: the console's own id is in the record.
    expect(await act(rig, "state.cycle")).toMatchObject({ ok: true });
    expect((await recordsOf(rig, AUDIT_ACTIONS.consoleModuleAct)).at(-1)?.sessionRef).toBe(SESSION);
  });
});

describe("what comes back from an act", () => {
  test("a reply that does not have its shape is refused whole, and its value goes nowhere", async () => {
    rig = await makeActsRig();
    expect(await act(rig, "leak.row", {}, READER)).toEqual({ ok: false, error: "reply_invalid" });
    expect(await spoolText(rig.paths)).not.toContain("Maria Okafor");
    expect(logText()).not.toContain("Maria Okafor");
  });

  test("a reply larger than an act may show is refused", async () => {
    rig = await makeActsRig();
    const size = Buffer.byteLength(JSON.stringify({ rows: Array.from({ length: 500 }, () => ({ a: "a".repeat(128), b: "b".repeat(128), c: "c".repeat(128), d: "d".repeat(128) })) }));
    expect(size).toBeGreaterThan(ACT_REPLY_MAX_BYTES);
    expect(await act(rig, "big.reply", {}, READER)).toEqual({ ok: false, error: "reply_invalid" });
  });

  test("a failure the module names is one word, and any other failure is `internal` with no message anywhere", async () => {
    rig = await makeActsRig();
    expect(await act(rig, "throw.code")).toEqual({ ok: false, error: "failed:connection_unknown" });
    expect(await act(rig, "throw.secret")).toEqual({ ok: false, error: "failed:internal" });
    const outcomes = (await recordsOf(rig, AUDIT_ACTIONS.consoleModuleAct)).filter((record) => record.kind === "outcome");
    expect(outcomes.map((record) => `${record.outcome} ${record.error}`)).toEqual([
      "failed connection_unknown",
      "failed internal",
    ]);
    for (const text of [await spoolText(rig.paths), logText()]) {
      expect(text).not.toContain(SECRET_VALUE);
      expect(text).not.toContain(ROW_VALUE);
    }
  });

  test("an act that never answers is answered failed:timeout, and its record says so", async () => {
    rig = await makeActsRig({ deps: { actDeadlineMs: 20 } });
    expect(await act(rig, "never.changes")).toEqual({ ok: false, error: "failed:timeout" });
    expect((await recordsOf(rig, AUDIT_ACTIONS.consoleModuleAct))[1]).toMatchObject({ outcome: "failed", error: "timeout" });
  });
});

describe("an operator's act that ran past its deadline, and then ended", () => {
  const lateEnds = async (): Promise<unknown[]> =>
    (await recordsOf(rig, AUDIT_ACTIONS.consoleModuleActEndedLate)).map((record) => ({
      actor: record.actor,
      sessionRef: record.sessionRef,
      params: record.params,
      outcome: record.outcome,
      error: record.error,
    }));
  const until = async (count: number): Promise<unknown[]> => {
    for (let i = 0; i < 200 && (await lateEnds()).length < count; i += 1) await Bun.sleep(5);
    return lateEnds();
  };

  test("one more record says how it ended, under the person's login, after the pair that says it timed out", async () => {
    rig = await makeActsRig({ deps: { actDeadlineMs: 20 } });
    expect(await act(rig, "held.changes")).toEqual({ ok: false, error: "failed:timeout" });
    // Still running: nothing says that it ended.
    expect(await lateEnds()).toEqual([]);
    rig.acts.held[0]?.end();
    expect(await until(1)).toEqual([
      { actor: "maya.chen", sessionRef: SESSION, params: { module: "probe", act: "held.changes" }, outcome: "ok", error: null },
    ]);
    // One that fails, with the module's own word for it.
    expect(await act(rig, "held.changes")).toEqual({ ok: false, error: "failed:timeout" });
    rig.acts.held[1]?.fail(new AskFailure("connection_unknown"));
    expect((await until(2))[1]).toMatchObject({ outcome: "failed", error: "connection_unknown" });
    // And one that fails with a message: the message goes nowhere.
    expect(await act(rig, "held.changes")).toEqual({ ok: false, error: "failed:timeout" });
    rig.acts.held[2]?.fail(new Error(`could not sign in with ${SECRET_VALUE}`));
    expect((await until(3))[2]).toMatchObject({ outcome: "failed", error: "internal" });
    expect(await spoolText(rig.paths)).not.toContain(SECRET_VALUE);

    const told = await story(rig, "console.module.act");
    expect(told.map((line) => line.split(" ").filter((word) => word !== "event" && word !== "intent" && word !== "outcome").join(" "))).toEqual([
      "console.module.act - -",
      "console.module.act failed timeout",
      "console.module.act.ended_late ok -",
      "console.module.act - -",
      "console.module.act failed timeout",
      "console.module.act.ended_late failed connection_unknown",
      "console.module.act - -",
      "console.module.act failed timeout",
      "console.module.act.ended_late failed internal",
    ]);
  });

  test("an act that ended while its timeout was being recorded has one such record, after the pair", async () => {
    rig = await makeActsRig({ deps: { actDeadlineMs: 20 } });
    const outcome = rig.host.audit.outcome.bind(rig.host.audit);
    // The work ends in the moment between the deadline and the record of it.
    rig.host.audit.outcome = async (intent, how, error) => {
      rig.acts.held[0]?.end();
      await Bun.sleep(10);
      return outcome(intent, how, error);
    };
    expect(await act(rig, "held.changes")).toEqual({ ok: false, error: "failed:timeout" });
    expect(await until(1)).toHaveLength(1);
    await Bun.sleep(30);
    expect(await lateEnds()).toHaveLength(1);
    const actions = (await story(rig, "console.module.act")).map((line) => line.split(" ")[0]);
    expect(actions).toEqual(["console.module.act", "console.module.act", "console.module.act.ended_late"]);
  });

  test("an act that ended in time, one that never ends, and one that is not recorded leave no such record", async () => {
    rig = await makeActsRig({ deps: { actDeadlineMs: 20 } });
    expect(await act(rig, "state.cycle")).toMatchObject({ ok: true });
    expect(await act(rig, "never.changes")).toEqual({ ok: false, error: "failed:timeout" });
    // An act any signed-in person may do is not recorded, and neither is how it ended.
    expect(await act(rig, "held", {}, READER)).toEqual({ ok: false, error: "failed:timeout" });
    rig.acts.held[0]?.end();
    await Bun.sleep(40);
    expect(await lateEnds()).toEqual([]);
  });
});

describe("an act that cannot be recorded", () => {
  test("an operator's act whose record cannot be written does not run", async () => {
    rig = await makeActsRig();
    rig.host.audit.intent = async () => {
      throw new Error("disk full");
    };
    expect(await act(rig, "thing.add", THING)).toEqual({ ok: false, error: "failed:audit_unavailable" });
    expect(rig.acts.acted).toEqual([]);
  });

  test("a change whose own record cannot be written is not made", async () => {
    rig = await makeActsRig();
    const intent = rig.host.audit.intent.bind(rig.host.audit);
    // The act's own record is written. The record of the change is not.
    rig.host.audit.intent = async (action, fields) => {
      if (action === AUDIT_ACTIONS.consoleModuleReachAdd) throw new Error("disk full");
      return intent(action, fields);
    };
    expect(await act(rig, "thing.add", THING)).toEqual({ ok: false, error: "failed:audit_unavailable" });
    await expect(stat(listFile("reach.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await recordsOf(rig, AUDIT_ACTIONS.consoleModuleAct))[1]).toMatchObject({
      outcome: "failed",
      error: "audit_unavailable",
    });
  });
});

describe("capacity", () => {
  test("acts beyond the ones that may run at once are refused as busy, and the slot comes back", async () => {
    rig = await makeActsRig({ deps: { actDeadlineMs: 40 } });
    const gate = rig.host.acts as unknown as { deps: { maxInFlight?: number } };
    gate.deps.maxInFlight = 2;
    const replies = await Promise.all(Array.from({ length: 5 }, () => act(rig, "never", {}, READER)));
    const errors = replies.map((reply) => (reply.ok ? null : reply.error));
    expect(errors.filter((error) => error === "failed:timeout")).toHaveLength(2);
    expect(errors.filter((error) => error === "busy")).toHaveLength(3);
    expect(rig.acts.acted).toHaveLength(2);
  });

  test("a slot comes back when the act that held it ends", async () => {
    rig = await makeActsRig();
    (rig.host.acts as unknown as { deps: { maxInFlight?: number } }).deps.maxInFlight = 1;
    const first = act(rig, "held", {}, READER);
    while (rig.acts.held.length === 0) await Bun.sleep(1);
    expect(await act(rig, "things.read", {}, READER)).toEqual({ ok: false, error: "busy" });
    rig.acts.held[0]?.end();
    expect(await first).toMatchObject({ ok: true });
    expect(await act(rig, "things.read", {}, READER)).toMatchObject({ ok: true });
  });

  test("the slot of an act whose record could not be written, or whose module failed, comes back at once", async () => {
    rig = await makeActsRig();
    (rig.host.acts as unknown as { deps: { maxInFlight?: number } }).deps.maxInFlight = 1;
    const intent = rig.host.audit.intent.bind(rig.host.audit);
    rig.host.audit.intent = async () => {
      throw new Error("disk full");
    };
    expect(await act(rig, "thing.add", THING)).toEqual({ ok: false, error: "failed:audit_unavailable" });
    expect(await act(rig, "thing.add", THING)).toEqual({ ok: false, error: "failed:audit_unavailable" });
    rig.host.audit.intent = intent;
    // A module that fails, twice.
    expect(await act(rig, "throw.code")).toEqual({ ok: false, error: "failed:connection_unknown" });
    expect(await act(rig, "throw.secret")).toEqual({ ok: false, error: "failed:internal" });
    // A reply that is refused.
    expect(await act(rig, "leak.row", {}, READER)).toEqual({ ok: false, error: "reply_invalid" });
    // The one slot is free after each of them.
    expect(await act(rig, "thing.add", THING)).toMatchObject({ ok: true });
  });

  test("no minute holds more acts of operators than the limit, and reads are not counted", async () => {
    rig = await makeActsRig();
    const gate = rig.host.acts as unknown as { recorded: unknown; deps: { maxRecordedPerMinute?: number } };
    const { RateWindow } = await import("../../src/host/rate-window");
    gate.recorded = new RateWindow(2);
    expect(await act(rig, "state.cycle")).toMatchObject({ ok: true });
    expect(await act(rig, "state.cycle")).toMatchObject({ ok: true });
    expect(await act(rig, "state.cycle")).toEqual({ ok: false, error: "busy" });
    for (let i = 0; i < 5; i += 1) expect(await act(rig, "things.read", {}, READER)).toMatchObject({ ok: true });
    rig.now.value = new Date(rig.now.value.getTime() + 60_001);
    expect(await act(rig, "state.cycle")).toMatchObject({ ok: true });
    const busy = (await recordsOf(rig, AUDIT_ACTIONS.consoleModuleAct)).filter(
      (record) => (record.params as { rule?: string } | null)?.rule === "busy_rate",
    );
    expect(busy).toHaveLength(1);
  });
});

describe("a reach", () => {
  test("a private address is taken, and the addresses that mean this machine are not", async () => {
    rig = await makeActsRig();
    expect(await act(rig, "thing.add", { name: "inside", host: "10.0.4.17", port: 5432 })).toMatchObject({ ok: true });
    for (const host of ["127.0.0.1", "169.254.169.254", "::1", "localhost", "metadata.google.internal", "::ffff:127.0.0.1", "0.0.0.0"]) {
      expect([host, await act(rig, "thing.add", { name: "x", host, port: 5432 })]).toEqual([
        host,
        { ok: false, error: "failed:reach_address_refused" },
      ]);
    }
    expect(await act(rig, "thing.add", { name: "x", host: "db northstar", port: 5432 })).toEqual({
      ok: false,
      error: "failed:reach_host_invalid",
    });
    expect(await act(rig, "thing.add", { name: "x", host: "db.northstar.example", port: 0 })).toEqual({
      ok: false,
      error: "failed:reach_port_invalid",
    });
    const reach = JSON.parse(await readFile(listFile("reach.json"), "utf8")) as { entries: { name: string }[] };
    expect(reach.entries.map((entry) => entry.name)).toEqual(["inside"]);
  });

  test("a name is one address: a name that is taken is refused, and nothing changes under it", async () => {
    rig = await makeActsRig();
    await act(rig, "thing.add", THING);
    expect(await act(rig, "thing.add", { ...THING, host: "other.northstar.example" })).toEqual({
      ok: false,
      error: "failed:reach_name_taken",
    });
    expect(await act(rig, "things.read", {}, READER)).toMatchObject({
      reply: { reaches: [{ name: "orders-1", host: "db.northstar.example" }] },
    });
    // The refusal is the outcome of the change's own record.
    expect(await story(rig, AUDIT_ACTIONS.consoleModuleReachAdd)).toEqual([
      "console.module.reach.add intent - -",
      "console.module.reach.add outcome ok -",
      "console.module.reach.add intent - -",
      "console.module.reach.add outcome refused reach_name_taken",
    ]);
  });

  test("a name that is not one, and a name the audit trail would write as [redacted]", async () => {
    rig = await makeActsRig();
    // Each of these is a `name` for the act's own shape, and is not one a reach takes.
    for (const name of ["", " padded ", "x".repeat(65)]) {
      expect([name, await act(rig, "thing.add", { name, host: "db.northstar.example", port: 5432 })]).toEqual([
        name,
        { ok: false, error: "failed:reach_name_invalid" },
      ]);
    }
    // A name that looks like a credential cannot come in as an argument (the
    // gate refuses it). Made by the module itself, the list refuses it.
    expect(await act(rig, "made.reach")).toEqual({ ok: false, error: "failed:reach_name_invalid" });
    await expect(stat(listFile("reach.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await spoolText(rig.paths)).not.toContain(MADE_UP_VALUE);
  });

  test("one module and organization has at most 64", async () => {
    rig = await makeActsRig();
    const gate = rig.host.acts as unknown as { recorded: unknown };
    const { RateWindow } = await import("../../src/host/rate-window");
    gate.recorded = new RateWindow(1_000);
    for (let i = 0; i < REACH_MAX_ENTRIES; i += 1) {
      expect(await act(rig, "thing.add", { name: `db-${i}`, host: "db.northstar.example", port: 5432 })).toMatchObject({ ok: true });
    }
    expect(await act(rig, "thing.add", { name: "one-more", host: "db.northstar.example", port: 5432 })).toEqual({
      ok: false,
      error: "failed:reach_list_full",
    });
  });

  test("a list that cannot be read is not an empty list: nothing is added to it and nothing is written over it", async () => {
    rig = await makeActsRig();
    await mkdir(path.dirname(listFile("reach.json")), { recursive: true });
    // A file somebody edited by hand to hold an address this HX Fortress refuses.
    const edited = JSON.stringify({
      version: 1,
      entries: [{ name: "own-db", host: "127.0.0.1", port: 5432, addedBy: "somebody", addedAt: "2027-03-14T09:00:00.000Z" }],
    });
    for (const content of ["{ not json", JSON.stringify({ version: 2, entries: [] }), edited]) {
      await writeFile(listFile("reach.json"), content);
      expect(await act(rig, "things.read", {}, READER)).toEqual({ ok: false, error: "failed:reach_list_unreadable" });
      expect(await act(rig, "thing.add", { name: "x", host: "db.northstar.example", port: 5432 })).toEqual({
        ok: false,
        error: "failed:reach_list_unreadable",
      });
      expect(await act(rig, "thing.remove", { name: "own-db" })).toEqual({ ok: false, error: "failed:reach_list_unreadable" });
      expect(await readFile(listFile("reach.json"), "utf8")).toBe(content);
    }
    expect((await recordsOf(rig, AUDIT_ACTIONS.moduleRefused)).some(
      (record) => (record.params as { rule?: string }).rule === "reach_list_unreadable",
    )).toBe(true);
  });
});

describe("a secret's name", () => {
  test("a name a person added can be read by the module, and a name nobody added cannot", async () => {
    rig = await makeActsRig();
    rig.secrets.values["orders-reader"] = "a-password-of-22-chars";
    rig.secrets.values["someone-elses"] = "another";
    expect(await act(rig, "secret.length", { keyName: "orders-reader" })).toEqual({
      ok: false,
      error: "failed:secret_not_declared",
    });
    await act(rig, "thing.add", THING);
    expect(await act(rig, "secret.length", { keyName: "orders-reader" })).toEqual({ ok: true, reply: { length: 22 } });
    expect(await act(rig, "secret.length", { keyName: "someone-elses" })).toEqual({
      ok: false,
      error: "failed:secret_not_declared",
    });
    // A name from the manifest is read as before.
    expect(await act(rig, "secret.length", { keyName: "probe-token" })).toEqual({ ok: true, reply: { length: SECRET_VALUE.length } });
    // Removed: the next read is refused.
    await act(rig, "thing.remove", { name: "orders-1", keyName: "orders-reader" });
    expect(await act(rig, "secret.length", { keyName: "orders-reader" })).toEqual({
      ok: false,
      error: "failed:secret_not_declared",
    });
    // Adding a name read no secret, and no value is in the trail or the log.
    for (const text of [await spoolText(rig.paths), logText()]) expect(text).not.toContain("a-password-of-22-chars");
  });

  test("a name this HX Fortress's own settings read, and a name a manifest lists, cannot be handed to a module", async () => {
    rig = await makeActsRig({ deps: { reservedSecretNames: async () => ["fortress-database-url", "sign-in-client"] } });
    for (const keyName of ["fortress-database-url", "sign-in-client", "probe-token"]) {
      expect([keyName, await act(rig, "thing.add", { ...THING, name: `r-${keyName}`, keyName })]).toEqual([
        keyName,
        { ok: false, error: "failed:secret_name_reserved" },
      ]);
    }
    await expect(stat(listFile("secret-names.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a name that came to be reserved after it was added is not read for the module any more", async () => {
    const reserved: string[] = [];
    let readable = true;
    rig = await makeActsRig({
      deps: {
        reservedSecretNames: async () => {
          if (!readable) throw new Error("oidc.json cannot be read");
          return reserved;
        },
      },
    });
    rig.secrets.values["sign-in-client"] = "the sign-in's own secret";
    // Added while nothing reads that name: an operator who knows which name
    // the sign-in's secret will be kept under adds it first.
    expect(await act(rig, "thing.add", { ...THING, keyName: "sign-in-client" })).toMatchObject({ ok: true });
    expect(await act(rig, "secret.length", { keyName: "sign-in-client" })).toEqual({ ok: true, reply: { length: 24 } });
    // Then this HX Fortress's own settings come to read it.
    reserved.push("sign-in-client");
    const reads = rig.secrets.reads.length;
    expect(await act(rig, "secret.length", { keyName: "sign-in-client" })).toEqual({
      ok: false,
      error: "failed:secret_name_reserved",
    });
    // The key store was not asked.
    expect(rig.secrets.reads).toHaveLength(reads);
    // And while the settings cannot be read, no added name is read at all.
    reserved.length = 0;
    readable = false;
    expect(await act(rig, "secret.length", { keyName: "sign-in-client" })).toEqual({
      ok: false,
      error: "failed:secret_names_unreadable",
    });
    expect(rig.secrets.reads).toHaveLength(reads);
    // A name from the manifest needs no such look.
    expect(await act(rig, "secret.length", { keyName: "probe-token" })).toMatchObject({ ok: true });
    const rules = (await recordsOf(rig, AUDIT_ACTIONS.moduleRefused)).map(
      (record) => (record.params as { rule?: string } | null)?.rule,
    );
    expect(rules).toEqual(["secret_name_reserved", "secret_names_unreadable"]);
    for (const text of [await spoolText(rig.paths), logText()]) expect(text).not.toContain("the sign-in's own secret");
  });

  test("while the settings that say which names are taken cannot be read, no name is added", async () => {
    rig = await makeActsRig({
      deps: {
        reservedSecretNames: async () => {
          throw new Error("oidc.json cannot be read");
        },
      },
    });
    expect(await act(rig, "thing.add", THING)).toEqual({ ok: false, error: "failed:secret_names_unreadable" });
    await expect(stat(listFile("secret-names.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("the same change asked for twice at the same moment is one `ok` in the trail", async () => {
    rig = await makeActsRig();
    const outcomes = async (action: string): Promise<(string | null)[]> =>
      (await recordsOf(rig, action)).filter((record) => record.kind === "outcome").map((record) => record.outcome);
    const oneOk = (ended: (string | null)[]): void => {
      expect(ended.filter((outcome) => outcome === "ok")).toHaveLength(1);
      // The act that came second found the list as it wanted it.
      expect(ended.filter((outcome) => outcome !== "ok")).toEqual(ended.length > 1 ? ["unchanged"] : []);
    };
    // One secret's name, added twice at the same moment by one act.
    expect(await act(rig, "twice.secret", { keyName: "orders-reader" })).toMatchObject({ ok: true });
    oneOk(await outcomes(AUDIT_ACTIONS.consoleModuleSecretAdd));
    expect(await act(rig, "thing.add", { name: "orders-1", host: "db.northstar.example", port: 1433 })).toMatchObject({ ok: true });
    // The same host and the same name, removed twice.
    const removed = await Promise.all([
      act(rig, "thing.remove", { name: "orders-1", keyName: "orders-reader" }),
      act(rig, "thing.remove", { name: "orders-1", keyName: "orders-reader" }),
    ]);
    expect(removed).toMatchObject([{ ok: true }, { ok: true }]);
    oneOk(await outcomes(AUDIT_ACTIONS.consoleModuleReachRemove));
    oneOk(await outcomes(AUDIT_ACTIONS.consoleModuleSecretRemove));
    expect(JSON.parse(await readFile(listFile("secret-names.json"), "utf8"))).toMatchObject({ entries: [] });
  });

  test("the name another organization's secret is kept under cannot be handed to a module, and is not read for it", async () => {
    rig = await makeActsRig();
    const theirs = "alder dental's own login";
    rig.secrets.values["alder-probe-token"] = theirs;
    rig.secrets.values["orders-reader"] = "a-password-of-22-chars";
    expect(await act(rig, "thing.add", THING)).toMatchObject({ ok: true });
    // Added while the list of organizations does not hold the name.
    expect(await act(rig, "thing.add", { ...THING, name: "alder", keyName: "alder-probe-token" })).toMatchObject({ ok: true });
    expect(await act(rig, "secret.length", { keyName: "alder-probe-token" })).toEqual({ ok: true, reply: { length: theirs.length } });
    // Then the list comes to keep another organization's secret under it.
    await writeOrganizations(rig.paths, [
      { id: "alder-dental", modules: ["probe"], keys: { probe: { "probe-token": "alder-probe-token" } } },
      // A name for a module that the entry does not list is taken as well.
      { id: "birch-books", keys: { ledger: { "ledger-token": "birch-ledger-token" } } },
    ]);
    const reads = rig.secrets.reads.length;
    expect(await act(rig, "secret.length", { keyName: "alder-probe-token" })).toEqual({
      ok: false,
      error: "failed:secret_name_reserved",
    });
    expect(rig.secrets.reads).toHaveLength(reads);
    for (const keyName of ["alder-probe-token", "birch-ledger-token"]) {
      expect([keyName, await act(rig, "thing.add", { ...THING, name: `r-${keyName}`, keyName })]).toEqual([
        keyName,
        { ok: false, error: "failed:secret_name_reserved" },
      ]);
    }
    // A name nobody else's secret is kept under is read as before.
    expect(await act(rig, "secret.length", { keyName: "orders-reader" })).toEqual({ ok: true, reply: { length: 22 } });

    // A list that cannot be used: which names it holds is not known. So no
    // added name is read, and none is added.
    await writeFile(rig.paths.organizations, "{ not json");
    const said = (): unknown[] =>
      rig.logs.filter((record) => String(record.msg).includes("a place that names a secret")).map((record) => record.fields);
    expect(said()).toEqual([]);
    const before = rig.secrets.reads.length;
    expect(await act(rig, "secret.length", { keyName: "orders-reader" })).toEqual({
      ok: false,
      error: "failed:secret_names_unreadable",
    });
    expect(await act(rig, "thing.add", { ...THING, name: "later", keyName: "later-reader" })).toEqual({
      ok: false,
      error: "failed:secret_names_unreadable",
    });
    expect(rig.secrets.reads).toHaveLength(before);
    // The log says which place cannot be read, once for the two refusals.
    expect(said()).toEqual([{ place: "organizations.json" }]);
    // A name from the manifest needs no such look.
    expect(await act(rig, "secret.length", { keyName: "probe-token" })).toMatchObject({ ok: true });
    for (const text of [await spoolText(rig.paths), logText()]) expect(text).not.toContain(theirs);
  });

  test("while the list of added names cannot be read, an added name is not read, and the word says that it is the list", async () => {
    rig = await makeActsRig();
    rig.secrets.values["orders-reader"] = "a-password-of-22-chars";
    expect(await act(rig, "thing.add", THING)).toMatchObject({ ok: true });
    expect(await act(rig, "secret.length", { keyName: "orders-reader" })).toMatchObject({ ok: true });
    await writeFile(listFile("secret-names.json"), "{ not json");
    const reads = rig.secrets.reads.length;
    // Not `secret_not_declared`: the module asked for a name that a person
    // added. What fails is this HX Fortress's own file.
    expect(await act(rig, "secret.length", { keyName: "orders-reader" })).toEqual({
      ok: false,
      error: "failed:secret_names_unreadable",
    });
    expect(rig.secrets.reads).toHaveLength(reads);
    // A name from the manifest does not need the list.
    expect(await act(rig, "secret.length", { keyName: "probe-token" })).toMatchObject({ ok: true });
    const rules = (await recordsOf(rig, AUDIT_ACTIONS.moduleRefused)).map(
      (record) => (record.params as { rule?: string } | null)?.rule,
    );
    expect(rules).toEqual(["secret_names_unreadable"]);
    // A name that nobody added cannot be told from one that was: the same word.
    expect(await act(rig, "secret.length", { keyName: "someone-elses" })).toEqual({
      ok: false,
      error: "failed:secret_names_unreadable",
    });
  });

  test("a reserved name that was written into the list's file by hand is not read for the module", async () => {
    rig = await makeActsRig({ deps: { reservedSecretNames: async () => ["fortress-database-url"] } });
    rig.secrets.values["fortress-database-url"] = "the address of this HX Fortress's own database";
    await mkdir(path.dirname(listFile("secret-names.json")), { recursive: true });
    await writeFile(
      listFile("secret-names.json"),
      JSON.stringify({
        version: 1,
        entries: [{ name: "fortress-database-url", addedBy: "somebody", addedAt: "2027-03-14T09:00:00.000Z" }],
      }),
    );
    const reads = rig.secrets.reads.length;
    expect(await act(rig, "secret.length", { keyName: "fortress-database-url" })).toEqual({
      ok: false,
      error: "failed:secret_name_reserved",
    });
    expect(rig.secrets.reads).toHaveLength(reads);
  });

  test("a name that breaks the rule of a key store, and one that looks like a credential", async () => {
    rig = await makeActsRig();
    const names = ["Orders Reader", "orders_reader", "x".repeat(65)];
    for (const [index, keyName] of names.entries()) {
      expect([keyName, await act(rig, "thing.add", { ...THING, name: `reach-${index}`, keyName })]).toEqual([
        keyName,
        { ok: false, error: "failed:secret_name_invalid" },
      ]);
    }
    // A name that looks like a credential, made by the module itself.
    expect(await act(rig, "made.secret")).toEqual({ ok: false, error: "failed:secret_name_invalid" });
    await expect(stat(listFile("secret-names.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await spoolText(rig.paths)).not.toContain(MADE_UP_KEY_NAME);
  });

  test("adding a name twice is one entry and one record, and the list holds at most 192", async () => {
    rig = await makeActsRig();
    const gate = rig.host.acts as unknown as { recorded: unknown };
    const { RateWindow } = await import("../../src/host/rate-window");
    gate.recorded = new RateWindow(1_000);
    await act(rig, "thing.add", THING);
    expect(await act(rig, "thing.add", { ...THING, name: "orders-2" })).toMatchObject({ ok: true });
    expect(await recordsOf(rig, AUDIT_ACTIONS.consoleModuleSecretAdd)).toHaveLength(2);
    // One name is on the list. Put 190 more beside it with the list's own
    // writer, as 190 earlier acts would have left them. The list of hosts
    // holds 64, so 190 acts would fill that one first.
    expect(SECRET_NAMES_MAX_ENTRIES).toBe(192);
    const names = new ModuleLists().secretNames(path.dirname(listFile("secret-names.json")));
    for (let i = 1; i <= SECRET_NAMES_MAX_ENTRIES - 2; i += 1) {
      expect(await names.add({ name: `key-${i}`, addedBy: "maya.chen", addedAt: "2027-03-14T09:00:00.000Z" })).toEqual({
        ok: true,
        added: true,
      });
    }
    // An act adds the 192nd name. The next act's name is one too many.
    expect(
      await act(rig, "thing.add", { name: "db-192", host: "db.northstar.example", port: 5432, keyName: "key-the-last" }),
    ).toMatchObject({ ok: true });
    expect(await act(rig, "thing.add", { name: "db-last", host: "db.northstar.example", port: 5432, keyName: "one-more" })).toEqual({
      ok: false,
      error: "failed:secret_names_full",
    });
    expect(await names.has("one-more")).toBe(false);
    expect(await names.list()).toHaveLength(SECRET_NAMES_MAX_ENTRIES);
    // Refused before any change was to be made: one record with the rule,
    // under the person's login, and the name that was asked for is in none.
    const refusedAdds = (await recordsOf(rig, AUDIT_ACTIONS.consoleModuleSecretAdd)).filter(
      (record) => record.outcome === "refused",
    );
    expect(refusedAdds).toHaveLength(1);
    expect(refusedAdds[0]).toMatchObject({ actor: "maya.chen", params: { module: "probe", rule: "secret_names_full" } });
    expect(await spoolText(rig.paths)).not.toContain("one-more");
    // A name that is on the full list can be named again: nothing is added.
    expect(
      await act(rig, "thing.add", { name: "db-again", host: "db.northstar.example", port: 5432, keyName: "key-7" }),
    ).toMatchObject({ ok: true });
  });
});

describe("another organization this HX Fortress holds", () => {
  test("it has no list of its own to read from the own organization's, and cannot read a name that was added there", async () => {
    const OTHER = "cedar-labs";
    rig = await makeActsRig();
    await writeOrganizations(rig.paths, [{ id: OTHER, modules: ["probe"] }]);
    rig.secrets.values["orders-reader"] = "a-password-of-22-chars";
    await act(rig, "thing.add", THING);
    const grant = await rig.key.grant("probe", "lists.count", {}, { org: OTHER });
    expect(await ask(rig, "probe", "lists.count", {}, grant)).toEqual({ ok: true, payload: { reaches: 0, names: 0, canAdd: false } });
    const other = rig.acts.askContext;
    expect(other?.organization.own).toBe(false);
    await expect(other?.secrets.get("orders-reader")).rejects.toMatchObject({ name: "SecretNotDeclared" });
  });
});
