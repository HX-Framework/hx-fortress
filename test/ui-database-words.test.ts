// The words of the console's Databases page against the Databases module's
// own lists: every state, every step of a test and every word for a failure
// has a sentence, and the page's own types name the same values.
//
// The page writes its lists out and imports none from the module, because the
// console's bundle takes only what it names. So this file is what keeps the
// two sides the same.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { conform } from "../src/host/shape";
import {
  CONNECTION_STATES,
  DATABASES_ACTS,
  FAILURE_CODES,
  JOB_STEPS,
  LINK_ENCRYPTIONS,
} from "../src/modules/databases/manifest";
import { isModuleOff, type DatabaseConnectionView, type DatabaseTestView } from "../ui/src/api";
import { moreSummary } from "../ui/src/lib/database-form";
import {
  catalogWords,
  FAILURE_WORDS,
  failureWords,
  linkWords,
  loginCanWrite,
  startedByWords,
  stateLine,
  stateWords,
  STEP_WORDS,
} from "../ui/src/lib/database-words";

// Every path below is a file of this repository.
/* eslint-disable security/detect-non-literal-fs-filename */

const TEST: DatabaseTestView = {
  job: "job_1",
  state: "done",
  step: "catalog",
  origin: "person",
  by: "marta",
  startedAt: "2027-03-14T09:00:00.000Z",
  finishedAt: "2027-03-14T09:00:02.000Z",
  encryption: "verified",
  canWrite: false,
  tables: 412,
  columns: 5930,
};

const PERMITS: DatabaseConnectionView = {
  name: "Northstar permits",
  engine: "sqlserver",
  reach: "direct",
  host: "sql01.northstar.example",
  port: 1433,
  database: "Permits",
  encryption: "verify",
  minTls: "1.2",
  user: "permits_reader",
  keyName: "permits-reader",
  state: "ready",
  addedAt: "2027-03-14T08:59:00.000Z",
  addedBy: "marta",
  test: TEST,
};

describe("the page's words cover the module's lists", () => {
  test("every word for a failed test has a sentence, and no sentence is for a word the module does not have", () => {
    expect(Object.keys(FAILURE_WORDS).sort()).toEqual([...FAILURE_CODES].sort());
    for (const code of FAILURE_CODES) {
      const words = failureWords(code);
      // A sentence of its own, and not the one for a word this build does not know.
      expect([code, words.endsWith("."), words.startsWith("The test failed:")]).toEqual([code, true, false]);
    }
  });

  test("a word this build does not know is shown as it is", () => {
    expect(failureWords("something_new")).toBe("The test failed: something_new");
    expect(failureWords(undefined)).toBe("The test failed.");
  });

  test("every step of a test has words", () => {
    expect(Object.keys(STEP_WORDS).sort()).toEqual([...JOB_STEPS].sort());
  });

  test("every state of a connection has a word and a line", () => {
    const labels = CONNECTION_STATES.map((state) => {
      const connection = { ...PERMITS, state };
      expect(stateLine(connection).length).toBeGreaterThan(10);
      return stateWords(connection).label;
    });
    expect(labels).toEqual(["Not tested", "Testing", "Ready", "Failed"]);
  });

  test("every way a link can be encrypted has words", () => {
    for (const encryption of LINK_ENCRYPTIONS) {
      expect([encryption, typeof linkWords(encryption)]).toEqual([encryption, "string"]);
    }
    expect(linkWords(undefined)).toBeNull();
  });

  test("a connection as the page types it is one the module's act may answer", () => {
    const read = DATABASES_ACTS.find((act) => act.name === "connections.read");
    const reply = { connections: [PERMITS, { ...PERMITS, name: "Northstar billing", state: "not_tested", test: undefined }] };
    // What `conform` hands back is the reply rebuilt from the declared shape.
    const conformed = conform(read?.reply as never, JSON.parse(JSON.stringify(reply)));
    expect(conformed.ok).toBe(true);
  });
});

describe("what the page says about a connection", () => {
  test("a login that can change data is told apart from a ready one, in the pill and in the line", () => {
    const writes = { ...PERMITS, test: { ...TEST, canWrite: true, writableTables: 2 } };
    expect(loginCanWrite(PERMITS)).toBe(false);
    expect(loginCanWrite(writes)).toBe(true);
    expect(stateWords(PERMITS)).toEqual({ label: "Ready", tone: "ok" });
    expect(stateWords(writes)).toEqual({ label: "Login can write", tone: "warn" });
    expect(stateLine(writes)).toBe("This login can change data. A query runs only with a login that can only read.");
    // A test that failed after an earlier one found a writing login says the failure.
    expect(loginCanWrite({ ...writes, state: "failed" })).toBe(false);
  });

  test("a running test says the step it is on, and a failed one says why", () => {
    expect(stateLine({ ...PERMITS, state: "testing", test: { ...TEST, state: "running", step: "sign_in" } })).toBe(
      "Signing in",
    );
    expect(stateLine({ ...PERMITS, state: "failed", test: { ...TEST, state: "failed", code: "login" } })).toBe(
      "The server refused this login.",
    );
    expect(stateLine({ ...PERMITS, state: "not_tested", test: undefined })).toBe("No test has run yet.");
  });

  test("what a test read is counted, with what it left out", () => {
    expect(catalogWords(TEST)).toBe("412 tables, 5,930 columns");
    expect(catalogWords({ ...TEST, tables: 1, columns: 1 })).toBe("1 table, 1 column");
    expect(catalogWords({ ...TEST, leftOutTables: 3, leftOutColumns: 1 })).toBe(
      "412 tables, 5,930 columns. Left out: 3 tables and 1 column",
    );
    expect(catalogWords({ ...TEST, truncated: true })).toBe(
      "412 tables, 5,930 columns. The database has more than this HX Fortress keeps",
    );
    expect(catalogWords({ ...TEST, tables: undefined })).toBeNull();
  });

  test("who started a test", () => {
    expect(startedByWords(TEST)).toBe("marta");
    expect(startedByWords({ ...TEST, origin: "control_plane", by: undefined })).toBe("the control plane");
    expect(startedByWords({ ...TEST, by: undefined })).toBe("a person at this console");
  });

  test("a connection's encryption reads as More Settings does in the form", () => {
    expect(moreSummary(PERMITS)).toBe("TLS 1.2 or newer, certificate checked");
    expect(moreSummary({ ...PERMITS, encryption: "off" })).toBe("Not encrypted");
  });
});

describe("a module that is off", () => {
  test("is told from every other answer by what the console says for a path it does not serve", () => {
    // A POST to a path that is no route, a GET to one, and the daemon's word.
    expect(isModuleOff({ status: 405, error: "the fortress answered 405" })).toBe(true);
    expect(isModuleOff({ status: 404, error: "the fortress answered 404" })).toBe(true);
    expect(isModuleOff({ status: 409, error: "module_off" })).toBe(true);
    // A word of the act route is an answer of a module that is on, whatever
    // its status: this one says that the daemon is another build.
    expect(isModuleOff({ status: 404, error: "act_unknown" })).toBe(false);
    expect(isModuleOff({ status: 404, error: "failed:connection_unknown" })).toBe(false);
    // A daemon that is stopped, a console that is gone, and an answer.
    expect(isModuleOff({ status: 503, error: "daemon_unreachable" })).toBe(false);
    expect(isModuleOff({ status: 0, error: "this console did not answer" })).toBe(false);
    expect(isModuleOff({ status: null, error: null })).toBe(false);
  });
});

describe("the page's own words", () => {
  const read = (file: string): string => readFileSync(path.join(import.meta.dir, "..", "ui", "src", file), "utf8");

  test("the product is named by both its words, and the piece that shows rows by its full name", () => {
    for (const file of ["views/Databases.tsx", "lib/database-words.ts", "lib/database-form.ts"]) {
      const source = read(file);
      // In any spelling: "this fortress" is the bare word too. The command's
      // own name, hx-fortress, is not.
      // `"fortress"` in quotes is the design system's class for its accent pill.
      const read_ = source.replaceAll('"fortress"', '""');
      expect([file, read_.match(/(?<![Hh][Xx][ -])[Ff]ortress/g)]).toEqual([file, null]);
      expect([file, source.match(/(?<!Secure )[Dd]ata [Ii]sland/g)]).toEqual([file, null]);
    }
  });

  test("no label of a control ends in an ellipsis, and nothing on the page is marked as new", () => {
    const page = read("views/Databases.tsx");
    expect(page.match(/(…|\.\.\.)\s*(<\/button>|["'`]\s*\}?\s*(keycap|onClick))/g)).toBeNull();
    expect(page.match(/\b(NEW|BETA|SOON)\b/g)).toBeNull();
  });

  test("the page's style gives nothing the hand of a link: the arrow, as in an app", () => {
    const css = read("console.css");
    const own = css.slice(css.indexOf("Data › Databases"));
    expect(own.length).toBeGreaterThan(500);
    expect(own).not.toContain("cursor: pointer");
    // The console's own buttons have the hand. Every button inside this page,
    // the confirmation's too, is told otherwise by the page's own class.
    expect(own).toContain(".dbview .btn, .dbview .modal .x, .dbmore, .dbengine, .dbrow { cursor: default; }");
    const page = read("views/Databases.tsx");
    expect(page.match(/<section className="view active dbview">/g)).toHaveLength(2);
    // Nothing moves under the pointer: a hover changes a colour only.
    expect(own.match(/:hover[^}]*transform/g)).toBeNull();
  });
});
