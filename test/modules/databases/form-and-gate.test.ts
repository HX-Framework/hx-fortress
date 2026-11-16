// The console's Add Database form against the module host's own gate.
//
// The gate turns some arguments of an act away before the module is called,
// and its answer, `args_invalid`, names no field: an argument that does not
// have the shape the act declares, and one that reads as a password, a key or
// a token. The form applies both rules itself, so that it can say which field
// is wrong. This file sends what the form WOULD send, for a list of texts,
// through the real gate of a real module host, with the real module behind
// it. It holds two things:
//
//   • what the gate turns away without a field's name, the form refuses at
//     that field, so nothing of the kind is ever sent;
//   • what the form refuses, the gate or the module refuses too, so the form
//     is no stricter than they are.
//
// Each act is handed to the gate here, and not through the rig's `act`, which
// goes the same way: this file reads the gate's own answer, word for word.

import { afterEach, describe, expect, test } from "bun:test";

import type { ActAnswer } from "../../../src/host/module-contract";
import {
  argsOf,
  ENCRYPTIONS,
  encryptionsFor,
  ENGINES,
  problemsOf,
  refusalOf,
  TLS_VERSIONS,
  withEngine,
} from "../../../ui/src/lib/database-form";
import { FIELD_TEXTS, formWith, made, PERMITS_FORM } from "./_form-texts";
import { makeDatabasesRig, MARTA, type DatabasesRig } from "./_rig";

let rig: DatabasesRig | null = null;
afterEach(async () => {
  await rig?.cleanup();
  rig = null;
});

/** One act of an operator, handed to the gate as the daemon's door hands it over. */
const send = (of: DatabasesRig, act: string, args: unknown): Promise<ActAnswer> =>
  of.host.acts.handle({ v: 1, person: MARTA, session: null, module: "databases", act, args });

/** The answer as one word: `added`, or the word the person would be shown a sentence for. */
const wordOf = (answer: ActAnswer): string => (answer.ok ? "added" : answer.error);

describe("the Add Database form and the module host's gate", () => {
  test("what the gate turns away without naming a field, the form refuses at that field, and the form refuses nothing that is taken", async () => {
    rig = await makeDatabasesRig();
    const words = new Map<string, number>();
    for (const [index, [field, text, kind]] of FIELD_TEXTS.entries()) {
      // A name of its own for each form, so that no two ask for one name.
      const form = formWith(field, text, field === "name" ? text : `Case ${index}`);
      const formSaysNo = problemsOf(form).some((problem) => problem.field === field);
      const word = wordOf(await send(rig, "connection.add", argsOf(form)));
      words.set(word, (words.get(word) ?? 0) + 1);

      // The gate's answer with no field's name: never for what the form lets through.
      if (word === "args_invalid") {
        expect([field, text, "the form refuses it at its field", formSaysNo]).toEqual([
          field,
          text,
          "the form refuses it at its field",
          true,
        ]);
      }
      // The list says how the gate reads the text, and the gate agrees.
      if (kind !== "plain") expect([field, text, kind, word]).toEqual([field, text, kind, "args_invalid"]);
      // The form is no stricter than the gate and the module together.
      if (formSaysNo) expect([field, text, "taken although the form refuses it", word === "added"]).toEqual([
        field,
        text,
        "taken although the form refuses it",
        false,
      ]);
      // What the form let through and the module or the host did not take has a sentence of its own.
      if (!formSaysNo && word !== "added") {
        expect([field, text, word, refusalOf(word, form).words.startsWith("This HX Fortress answered: ")]).toEqual([
          field,
          text,
          word,
          false,
        ]);
      }
    }
    // The list holds texts of each kind: this is no test of a gate that takes
    // everything, or of a form that lets nothing through.
    expect(words.get("args_invalid") ?? 0).toBeGreaterThan(15);
    expect(words.get("added") ?? 0).toBeGreaterThan(20);
  });

  test("a database's name that reads as a credential is refused at Database when it would be the connection's name too", async () => {
    rig = await makeDatabasesRig();
    // The Name field is left empty, so the name that is sent is the database's.
    const form = { ...PERMITS_FORM, name: "", database: made("Token", " Database2027") };
    expect(argsOf(form).name).toBe(form.database);
    expect(problemsOf(form).map((problem) => problem.field)).toEqual(["database"]);
    expect(wordOf(await send(rig, "connection.add", argsOf(form)))).toBe("args_invalid");
  });

  test("a change is held to the same rules as an add", async () => {
    rig = await makeDatabasesRig();
    expect(wordOf(await send(rig, "connection.add", argsOf(PERMITS_FORM)))).toBe("added");
    for (const [field, text, kind] of FIELD_TEXTS) {
      // A change keeps the name and the engine: the form has no field for either.
      if (field === "name" || kind === "plain") continue;
      const form = formWith(field, text);
      expect([field, text, problemsOf(form).some((problem) => problem.field === field)]).toEqual([field, text, true]);
      expect([field, text, wordOf(await send(rig, "connection.change", argsOf(form)))]).toEqual([
        field,
        text,
        "args_invalid",
      ]);
    }
    // And a change of a plain kind is taken.
    const changed = formWith("user", "permits_reader_2");
    expect(problemsOf(changed)).toEqual([]);
    expect((await send(rig, "connection.change", argsOf(changed))).ok).toBe(true);
  });

  test("every engine, encryption and TLS version the form offers is taken", async () => {
    rig = await makeDatabasesRig();
    let sent = 0;
    for (const engine of ENGINES) {
      for (const encryption of encryptionsFor(engine)) {
        const minTls = TLS_VERSIONS[sent % TLS_VERSIONS.length] ?? TLS_VERSIONS[0];
        const form = { ...withEngine(PERMITS_FORM, engine), name: `Case ${sent}`, encryption, minTls };
        expect(problemsOf(form)).toEqual([]);
        expect([engine, encryption, minTls, wordOf(await send(rig, "connection.add", argsOf(form)))]).toEqual([
          engine,
          encryption,
          minTls,
          "added",
        ]);
        sent += 1;
      }
    }
    // Every encryption was sent for some engine, and every TLS version too.
    expect(sent).toBeGreaterThanOrEqual(Math.max(ENCRYPTIONS.length, TLS_VERSIONS.length));
    expect(new Set(ENGINES.flatMap((engine) => encryptionsFor(engine))).size).toBe(ENCRYPTIONS.length);
  });
});
