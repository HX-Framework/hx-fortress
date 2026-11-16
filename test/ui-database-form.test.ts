// The console's Add Database form, without a screen: its lists against the
// Databases module's, what it sends against what the module takes, the words
// it has for each refusal, and what it reads from a pasted connection string.
//
// The form writes its lists out and imports none from the module, because the
// console's bundle takes only what it names. So this file is what keeps the
// two sides the same.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

// Every path below is a file of this repository.
/* eslint-disable security/detect-non-literal-fs-filename */

import { ACT_INTERRUPTED, DAEMON_UNREACHABLE } from "../src/host/local-door-client";
import { AskFailure } from "../src/host/module-contract";
import { recordable } from "../src/host/module-lists";
import { conform, NAME_MAX_CHARS } from "../src/host/shape";
import { connectionFields, holdsLogin as moduleHoldsLogin } from "../src/modules/databases/connections";
import { HOST_MAX_CHARS, isHost } from "../src/modules/databases/host-text";
import {
  CONNECTION_NAME_MAX_CHARS as MODULE_NAME_MAX,
  DATABASES_ACTS,
  DEFAULT_MIN_TLS as MODULE_MIN_TLS,
  ENCRYPTION_MODES,
  ENGINES as MODULE_ENGINES,
  TLS_VERSIONS as MODULE_TLS_VERSIONS,
} from "../src/modules/databases/manifest";
import { isSecretName as moduleIsSecretName } from "../src/secrets/types";
import { actStatus } from "../src/ui/act-routes";
import {
  argsOf,
  CONNECTION_NAME_MAX_CHARS,
  CREDENTIAL_WORDS,
  DEFAULT_MIN_TLS,
  emptyForm,
  ENCRYPTION_LABEL,
  ENCRYPTIONS,
  encryptionsFor,
  ENGINE_INFO,
  ENGINES,
  FIELD_MAX_CHARS,
  FORM_FIRST,
  FORM_MORE,
  formOf,
  holdsLogin,
  isFolded,
  isOwnFault,
  isSecretName,
  keptOutProblems,
  keyNameProblem,
  looksLikeConnectionString,
  moreSummary,
  nameOf,
  pastedConnection,
  pastedInto,
  pasteProblem,
  problemsOf,
  readFailureOf,
  refusalOf,
  textProblem,
  TLS_VERSIONS,
  withEngine,
  withPasted,
  type DatabaseForm,
} from "../ui/src/lib/database-form";
import { FIELD_TEXTS, formWith, made } from "./modules/databases/_form-texts";

/** A form a person filled in, for the made-up company's permits database. */
const PERMITS: DatabaseForm = {
  ...emptyForm("sqlserver"),
  name: "Northstar permits",
  host: "sql01.northstar.example",
  database: "Permits",
  user: "permits_reader",
  keyName: "permits-reader",
};

describe("the form's lists are the Databases module's", () => {
  test("the engines, the encryptions, the TLS versions and the longest name", () => {
    expect([...ENGINES]).toEqual([...MODULE_ENGINES]);
    expect([...ENCRYPTIONS]).toEqual([...ENCRYPTION_MODES]);
    expect([...TLS_VERSIONS]).toEqual([...MODULE_TLS_VERSIONS]);
    expect(DEFAULT_MIN_TLS).toBe(MODULE_MIN_TLS);
    expect(CONNECTION_NAME_MAX_CHARS).toBe(MODULE_NAME_MAX);
    // The longest text of the other fields: what the act's declared shape
    // takes for a name, and what the module takes for a host.
    expect([FIELD_MAX_CHARS, FIELD_MAX_CHARS]).toEqual([NAME_MAX_CHARS, HOST_MAX_CHARS]);
  });

  test("every engine has a label, a port and its word for a database, and every encryption a label", () => {
    expect(Object.keys(ENGINE_INFO).sort()).toEqual([...MODULE_ENGINES].sort());
    expect(Object.keys(ENCRYPTION_LABEL).sort()).toEqual([...ENCRYPTION_MODES].sort());
    expect(ENGINE_INFO.oracle.database).toBe("Service Name");
    expect(Object.values(ENGINE_INFO).map((info) => info.port)).toEqual([1433, 1521, 3306, 5432]);
  });

  test("the fields are every field of the act, and no other", () => {
    const add = DATABASES_ACTS.find((act) => act.name === "connection.add");
    const shape = add?.args as { kind: string; fields: Record<string, unknown> };
    expect(([...FORM_FIRST, ...FORM_MORE] as string[]).sort()).toEqual(Object.keys(shape.fields).sort());
    expect(isFolded("encryption")).toBe(true);
    expect(isFolded("keyName")).toBe(false);
  });

  test("a secret's name is judged as the key store judges one", () => {
    for (const name of [
      "permits-reader",
      "a",
      "0",
      "db-url",
      "x".repeat(64),
      "x".repeat(65),
      "",
      "Permits-Reader",
      "permits_reader",
      "permits reader",
      "permits.reader",
      "pérmits",
      "-",
      "a--b",
      "-a",
      "a-",
      "hunter2!",
      "correct horse battery staple",
    ]) {
      expect([name, isSecretName(name)]).toEqual([name, moduleIsSecretName(name)]);
    }
  });
});

describe("what the form sends", () => {
  test("the module takes it, and it has the shape the act declares", () => {
    const args = argsOf(PERMITS);
    expect(args).toEqual({
      name: "Northstar permits",
      engine: "sqlserver",
      host: "sql01.northstar.example",
      port: 1433,
      database: "Permits",
      encryption: "verify",
      minTls: "1.2",
      user: "permits_reader",
      keyName: "permits-reader",
    });
    expect(connectionFields(args)).toMatchObject({ name: "Northstar permits", port: 1433 });
    const add = DATABASES_ACTS.find((act) => act.name === "connection.add");
    expect(conform(add?.args as never, args)).toEqual({ ok: true, value: args });
  });

  test("a name left empty is the database's, and spaces around a field are not sent", () => {
    const form = { ...PERMITS, name: "  ", host: " sql01.northstar.example ", user: " permits_reader " };
    expect(nameOf(form)).toBe("Permits");
    expect(argsOf(form)).toMatchObject({ name: "Permits", host: "sql01.northstar.example", user: "permits_reader" });
  });

  test("a certificate name is sent when one is typed, and never for a connection with no encryption", () => {
    expect(argsOf({ ...PERMITS, serverName: " sql.northstar.example " }).serverName).toBe("sql.northstar.example");
    expect("serverName" in argsOf(PERMITS)).toBe(false);
    expect("serverName" in argsOf({ ...PERMITS, encryption: "off", serverName: "sql.northstar.example" })).toBe(false);
  });

  test("a connection read back fills the form it was added with", () => {
    const args = argsOf({ ...PERMITS, serverName: "sql.northstar.example", minTls: "1.3" });
    expect(argsOf(formOf(args))).toEqual(args);
    // An older connection has no TLS version and no certificate name of its own.
    const bare = { ...args };
    delete bare.minTls;
    delete bare.serverName;
    expect(formOf(bare)).toMatchObject({ minTls: "1.2", serverName: "" });
  });
});

describe("the engine", () => {
  test("the port follows the engine until a person types one", () => {
    const form = emptyForm();
    expect(form.port).toBe("1433");
    expect(withEngine(form, "postgres").port).toBe("5432");
    expect(withEngine(withEngine(form, "oracle"), "mysql").port).toBe("3306");
    expect(withEngine({ ...form, port: "14330" }, "postgres").port).toBe("14330");
    // A port cleared by hand is not one a person chose.
    expect(withEngine({ ...form, port: " " }, "postgres").port).toBe("5432");
  });

  test("Strict TLS is offered for SQL Server alone, and does not follow to another engine", () => {
    expect(encryptionsFor("sqlserver")).toEqual(["verify", "require", "strict", "off"]);
    for (const engine of ["oracle", "mysql", "postgres"] as const) {
      expect(encryptionsFor(engine)).toEqual(["verify", "require", "off"]);
    }
    const strict = { ...emptyForm("sqlserver"), encryption: "strict" as const };
    expect(withEngine(strict, "postgres").encryption).toBe("verify");
    expect(withEngine({ ...strict, encryption: "require" }, "postgres").encryption).toBe("require");
  });
});

describe("More Settings, folded", () => {
  test.each([
    [{}, "TLS 1.2 or newer, certificate checked"],
    [{ encryption: "require" }, "TLS 1.2 or newer, certificate not checked"],
    [{ encryption: "strict" }, "Strict TLS 1.2 or newer, certificate checked"],
    [{ minTls: "1.0" }, "TLS 1.0 or newer, certificate checked"],
    [{ minTls: "1.3" }, "TLS 1.3, certificate checked"],
    [{ encryption: "off", minTls: "1.3" }, "Not encrypted"],
  ] as const)("%j reads %s", (changed, words) => {
    expect(moreSummary({ ...emptyForm(), ...changed })).toBe(words);
  });
});

describe("what the form checks before it sends", () => {
  test("a filled form has nothing to say", () => {
    expect(problemsOf(PERMITS)).toEqual([]);
  });

  test("an empty form names each field that is needed, in the order they show", () => {
    expect(problemsOf(emptyForm()).map((problem) => problem.field)).toEqual(["host", "database", "user", "keyName"]);
    expect(problemsOf(emptyForm("oracle")).find((problem) => problem.field === "database")?.words).toBe(
      "Name the service.",
    );
  });

  test.each(["0", "65536", "14 33", "1433a", "-1", "", "1.5"])("the port %j is no port", (port) => {
    expect(problemsOf({ ...PERMITS, port }).map((problem) => problem.field)).toEqual(["port"]);
  });

  test("the password field takes a secret's name and nothing that looks like a password", () => {
    expect(keyNameProblem("permits-reader")).toBeNull();
    expect(keyNameProblem(" permits-reader ")).toBeNull();
    for (const typed of ["Tr0ub4dor&3", "correct horse", "Password1", "pa$$word", "x".repeat(65)]) {
      expect([typed, keyNameProblem(typed) === null]).toEqual([typed, false]);
      expect(problemsOf({ ...PERMITS, keyName: typed }).map((problem) => problem.field)).toEqual(["keyName"]);
    }
  });

  test("a name longer than the module keeps is told before it is sent", () => {
    expect(problemsOf({ ...PERMITS, name: "N".repeat(65) }).map((problem) => problem.field)).toEqual(["name"]);
    expect(problemsOf({ ...PERMITS, name: "", database: "D".repeat(65) }).map((problem) => problem.field)).toEqual([
      "name",
    ]);
  });

  test("the form refuses a text only where the module or the module host's gate would refuse it too", () => {
    // Each field's own rule is no stricter than the module's, and the form's
    // other rules are the gate's own: the shape the act declares for its
    // arguments, and no text that reads as a credential. So for every text of
    // the list: where the form says no, the module or the gate says no as well.
    // The real gate is asked about the same texts in
    // test/modules/databases/form-and-gate.test.ts.
    const add = DATABASES_ACTS.find((act) => act.name === "connection.add");
    const gateSaysNo = (args: object): boolean =>
      !conform(add?.args as never, JSON.parse(JSON.stringify(args))).ok ||
      Object.values(args).some((sent) => typeof sent === "string" && !recordable(sent));
    let refused = 0;
    let byTheGateAlone = 0;
    for (const [field, text] of FIELD_TEXTS) {
      const form = formWith(field, text);
      const formSaysNo = problemsOf(form).some((problem) => problem.field === field);
      let moduleSaysNo = false;
      try {
        connectionFields(argsOf(form));
      } catch {
        moduleSaysNo = true;
      }
      if (formSaysNo) refused += 1;
      if (formSaysNo && !moduleSaysNo) byTheGateAlone += 1;
      expect([field, text, formSaysNo && !moduleSaysNo && !gateSaysNo(argsOf(form))]).toEqual([field, text, false]);
    }
    // The form does say no to some of them: this is no test of a form that
    // lets everything through. And some of those only the gate refuses: held
    // to the module's rules alone, the form would fail here.
    expect(refused).toBeGreaterThan(20);
    expect(byTheGateAlone).toBeGreaterThan(8);
  });

  test("a host the module takes is a host the form takes", () => {
    for (const host of ["sql01", "SQL_01.corp.northstar.example", "10.20.30.40", "2001:db8::10", "::ffff:10.0.0.1", "a-b.c"]) {
      expect([host, isHost(host), textProblem("host", host)]).toEqual([host, true, null]);
    }
  });
});

describe("the words for a refusal", () => {
  const UNKNOWN = "This HX Fortress answered: ";

  test("every word the module's check of the fields can answer names its field", () => {
    const source = readFileSync(
      path.join(import.meta.dir, "..", "src", "modules", "databases", "connections.ts"),
      "utf8",
    );
    const body = source.slice(source.indexOf("export function connectionFields"));
    const words = [...body.slice(0, body.indexOf("\n}\n")).matchAll(/new AskFailure\("([a-z_]+)"\)/g)].map(
      (match) => match[1] as string,
    );
    expect(words.length).toBeGreaterThan(8);
    for (const word of words) {
      const refusal = refusalOf(`failed:${word}`);
      expect([word, refusal.words.startsWith(UNKNOWN), refusal.field !== undefined]).toEqual([word, false, true]);
    }
  });

  test("each field's refusal is the module's own, for the field it is about", () => {
    const cases: [Partial<Record<string, unknown>>, string][] = [
      [{ name: "-permits" }, "name"],
      [{ engine: "db2" }, "engine"],
      [{ host: "not a host" }, "host"],
      [{ port: 70_000 }, "port"],
      [{ database: "a/b" }, "database"],
      [{ user: "a:b" }, "user"],
      [{ keyName: "Permits Reader" }, "keyName"],
      [{ encryption: "tls" }, "encryption"],
      [{ engine: "postgres", encryption: "strict" }, "encryption"],
      [{ minTls: "1.4" }, "minTls"],
      [{ serverName: "not a host" }, "serverName"],
    ];
    for (const [changed, field] of cases) {
      let word = "";
      try {
        connectionFields({ ...argsOf(PERMITS), ...changed });
      } catch (thrown) {
        word = thrown instanceof AskFailure ? thrown.code : "";
      }
      expect([changed, refusalOf(`failed:${word}`).field] as unknown).toEqual([changed, field]);
    }
  });

  test("the words of the module host and of the act's route have sentences too", () => {
    for (const word of [
      "failed:name_taken",
      "failed:reach_address_refused",
      "failed:reach_host_invalid",
      "failed:secret_name_invalid",
      "failed:secret_name_reserved",
      "failed:connections_full",
      "failed:reach_list_full",
      "failed:secret_names_full",
      "failed:connection_unknown",
      "failed:connection_busy",
      "failed:login_refused",
      "failed:audit_unavailable",
      "failed:module_not_running",
      "failed:secret_unavailable",
      "failed:timeout",
      "failed:interrupted",
      "busy",
      "not_allowed",
      "daemon_unreachable",
      "module_off",
      "args_invalid",
    ]) {
      expect([word, refusalOf(word).words.startsWith(UNKNOWN)]).toEqual([word, false]);
    }
    expect(refusalOf("failed:reach_address_refused").field).toBe("host");
    expect(refusalOf("failed:secret_name_reserved").field).toBe("keyName");
  });

  test("an act that ran past its time is said to be still under way, and never that nothing was changed", () => {
    // The daemon does not stop such an act. It may still be carried out.
    const words = refusalOf("failed:timeout").words;
    expect(words).toContain("It may still carry this out");
    expect(words).not.toContain("othing");
  });

  test("a fault of this HX Fortress is told as one, and is never laid on what was typed", () => {
    const OWN = refusalOf("failed:internal").words;
    const OWN_READ = readFailureOf("failed:internal");
    expect(OWN).toContain("a fault of its own");
    expect(OWN_READ).toContain("a fault of its own");
    // The words the host has for a call or a folder that a module's manifest
    // does not allow, read from its contract.
    const contract = readFileSync(path.join(import.meta.dir, "..", "src", "host", "module-contract.ts"), "utf8");
    const notAllowed = [...new Set([...contract.matchAll(/"((?:egress|folder)_[a-z_]+)"/g)].map((match) => match[1] as string))];
    expect(notAllowed.length).toBeGreaterThanOrEqual(6);
    for (const word of [
      "reply_invalid",
      "failed:internal",
      "failed:request_invalid",
      "failed:secret_not_declared",
      "failed:not_allowed",
      "failed:organization_not_held",
      ...notAllowed.map((rule) => `failed:${rule}`),
    ]) {
      expect([word, actStatus(word), isOwnFault(word), refusalOf(word), readFailureOf(word)]).toEqual([
        word,
        500,
        true,
        { words: OWN },
        OWN_READ,
      ]);
    }
    // The route's word for a role reads like one of them, and is another word.
    expect([actStatus("not_allowed"), isOwnFault("not_allowed")]).toEqual([403, false]);
    expect(refusalOf("not_allowed").words).toBe("Your account can read this page and cannot change it.");
    // What a person can mend, or wait for, is none of them.
    for (const word of ["failed:name_taken", "failed:state_unreadable", "busy", "module_off", "args_invalid", "failed:timeout"]) {
      expect([word, isOwnFault(word), actStatus(word) === 500]).toEqual([word, false, false]);
    }
  });

  test("a fault met while an act was under way does not say that the act was not carried out", () => {
    // A module that failed half way may have changed something, and with
    // `reply_invalid` it did all of it: only its answer could not be shown.
    const OWN = refusalOf("reply_invalid").words;
    expect(OWN).toContain("Look at the list to see whether it was carried out");
    for (const claim of ["could not carry", "nothing was changed", "was not carried out"]) {
      expect([claim, OWN.includes(claim)]).toEqual([claim, false]);
    }
    // A read changes nothing, so its sentence says nothing about that at all.
    const OWN_READ = readFailureOf("reply_invalid");
    expect(OWN_READ).toContain("could not show its databases");
    expect(OWN_READ).not.toContain("carried out");
  });

  test("a word made up in the forms the route knows is a fault of this side exactly where the route answers 500", () => {
    // The route goes by a word's ending before its start: a failure that ends
    // in `_unavailable` or `_unreadable` is this HX Fortress's own state, and
    // the same request may work later, whatever the word starts with.
    const starts = ["", "egress_", "folder_", "secret_", "reach_", "state_", "audit_", "module_"];
    const ends = ["refused", "unavailable", "unreadable", "not_declared", "not_held", "too_deep", "not_running", "x"];
    let faults = 0;
    for (const start of starts) {
      for (const end of ends) {
        const word = `failed:${start}${end}`;
        if (isOwnFault(word)) faults += 1;
        expect([word, isOwnFault(word)]).toEqual([word, actStatus(word) === 500]);
      }
    }
    expect(faults).toBeGreaterThan(10);
    expect([actStatus("failed:folder_unreadable"), isOwnFault("failed:folder_unreadable")]).toEqual([503, false]);
    expect([actStatus("failed:egress_unavailable"), isOwnFault("failed:egress_unavailable")]).toEqual([503, false]);
  });

  test("a word the form does not know is shown as it is", () => {
    expect(refusalOf("failed:something_new")).toEqual({ words: "This HX Fortress answered: something_new" });
  });

  test("a database's name that cannot be the connection's name says to type one", () => {
    expect(refusalOf("failed:name_invalid", { ...PERMITS, name: "" }).words).toContain("Give it a name");
    expect(refusalOf("failed:name_invalid", PERMITS).words).toContain("starts and ends with a letter or a digit");
  });

  test("a list that could not be read says what the page waits for, and never that nothing was changed", () => {
    for (const word of [
      "daemon_unreachable",
      "failed:module_not_running",
      "busy",
      "failed:timeout",
      "failed:interrupted",
      "failed:state_unreadable",
      "module_off",
    ]) {
      const words = readFailureOf(word);
      expect([word, words.startsWith(UNKNOWN), words.includes("changed")]).toEqual([word, false, false]);
    }
    expect(readFailureOf("failed:something_new")).toBe("This HX Fortress answered: something_new");
  });

  test("no sentence names the product by one word", () => {
    const source = readFileSync(path.join(import.meta.dir, "..", "ui", "src", "lib", "database-form.ts"), "utf8");
    expect(source.match(/(?<!HX )Fortress/g)).toBeNull();
  });
});

describe("a pasted connection string", () => {
  // Put together when the test runs: a scanner of secrets takes a made-up
  // word that is written out beside this name for a real one.
  const PASSWORD = ["Tr0ub4dor", "and", "3"].join("-");

  test.each([
    [
      `postgres://billing_reader:${PASSWORD}@pg02.northstar.example:5432/billing?sslmode=verify-full`,
      {
        engine: "postgres",
        host: "pg02.northstar.example",
        port: "5432",
        database: "billing",
        user: "billing_reader",
        encryption: "verify",
        hadPassword: true,
      },
    ],
    [
      "postgresql://billing_reader@pg02.northstar.example/billing?sslmode=disable",
      {
        engine: "postgres",
        host: "pg02.northstar.example",
        database: "billing",
        user: "billing_reader",
        encryption: "off",
        hadPassword: false,
      },
    ],
    [
      `mysql://reader:${PASSWORD}@my03.northstar.example:3306/parcels?ssl-mode=REQUIRED`,
      {
        engine: "mysql",
        host: "my03.northstar.example",
        port: "3306",
        database: "parcels",
        user: "reader",
        encryption: "require",
        hadPassword: true,
      },
    ],
    [
      `jdbc:sqlserver://sql01.northstar.example:1433;databaseName=Permits;user=permits_reader;password=${PASSWORD};encrypt=true;trustServerCertificate=false`,
      {
        engine: "sqlserver",
        host: "sql01.northstar.example",
        port: "1433",
        database: "Permits",
        user: "permits_reader",
        encryption: "verify",
        hadPassword: true,
      },
    ],
    [
      `Server=tcp:sql01.northstar.example,1433;Database=Permits;User ID=permits_reader;Password=${PASSWORD};Encrypt=True;TrustServerCertificate=True`,
      {
        engine: "sqlserver",
        host: "sql01.northstar.example",
        port: "1433",
        database: "Permits",
        user: "permits_reader",
        encryption: "require",
        hadPassword: true,
      },
    ],
    [
      "Data Source=sql01.northstar.example\\PERMITS;Initial Catalog=Permits;Encrypt=Strict",
      {
        engine: "sqlserver",
        host: "sql01.northstar.example",
        database: "Permits",
        encryption: "strict",
        hadPassword: false,
      },
    ],
    [
      "jdbc:oracle:thin:@//ora04.northstar.example:1521/PERMITSPDB",
      { engine: "oracle", host: "ora04.northstar.example", port: "1521", database: "PERMITSPDB", hadPassword: false },
    ],
    [
      `jdbc:oracle:thin:permits_reader/${PASSWORD}@ora04.northstar.example:1521:PERMITS`,
      {
        engine: "oracle",
        host: "ora04.northstar.example",
        port: "1521",
        database: "PERMITS",
        user: "permits_reader",
        hadPassword: true,
      },
    ],
    [
      "postgres://reader@[2001:db8::10]:6432/billing",
      { engine: "postgres", host: "2001:db8::10", port: "6432", database: "billing", user: "reader", hadPassword: false },
    ],
    [
      "mariadb://my%2Dreader@my03.northstar.example/par%20cels",
      { engine: "mysql", host: "my03.northstar.example", database: "par cels", user: "my-reader", hadPassword: false },
    ],
  ] as const)("%s", (text, fields) => {
    const read = pastedConnection(text);
    expect(read).toEqual(fields);
    // The password is in nothing that was read.
    expect(JSON.stringify(read)).not.toContain(PASSWORD);
  });

  test.each([
    "sql01.northstar.example",
    "sql01.northstar.example:1433",
    "https://northstar.example/permits",
    "permits_reader",
    "Database=Permits;User ID=permits_reader",
    "postgres://",
    "",
    "postgres://reader@pg02.northstar.example/billing\nand a second line",
  ])("%j is no connection string, and goes into the field as it is", (text) => {
    expect(pastedConnection(text)).toBeNull();
  });

  test("it fills the fields it names and leaves the others as the person has them", () => {
    const typed = { ...emptyForm("sqlserver"), name: "Northstar billing", keyName: "billing-reader", serverName: "pg.northstar.example" };
    const read = pastedConnection(`postgres://billing_reader:${PASSWORD}@pg02.northstar.example/billing?sslmode=require`);
    const filled = withPasted(typed, read as NonNullable<typeof read>);
    expect(filled).toEqual({
      engine: "postgres",
      name: "Northstar billing",
      host: "pg02.northstar.example",
      // The text named no port, so the port followed the engine.
      port: "5432",
      database: "billing",
      user: "billing_reader",
      keyName: "billing-reader",
      encryption: "require",
      minTls: "1.2",
      serverName: "pg.northstar.example",
    });
    // A pasted password reaches neither the form nor what the form sends.
    expect(JSON.stringify(filled)).not.toContain(PASSWORD);
    expect(JSON.stringify(argsOf(filled))).not.toContain(PASSWORD);
  });

  test("an encryption the engine does not have is not taken from a pasted text", () => {
    // Strict TLS in a text for another engine: the form keeps what it had.
    const read = { engine: "postgres" as const, host: "pg02.northstar.example", encryption: "strict" as const, hadPassword: false };
    expect(withPasted(emptyForm("postgres"), read).encryption).toBe("verify");
  });
});

describe("a pasted connection string whose password holds marks of its own", () => {
  // A password can hold any character. What the form reads from such a text is
  // right, or it reads nothing: no field ever gets a piece of the password.
  const TRUE = { host: "db.northstar.example", port: "5432", database: "permits", user: "reader" } as const;
  const PASSWORDS = [
    "Tr0ub4dor&3",
    "p@ss",
    "pa/ss",
    "a:b",
    "p?x",
    "p#x",
    "x;y",
    "x;y=z",
    "100;y",
    "a@b/c",
    "a@b?c",
    "a@b#c",
    "a@b;c",
    "a@b/c?d#e;f=g",
    "pa ss",
    "p%40ss",
    "100",
    "x;user=admin",
    "x;Server=evil.northstar.example",
    "x&user=admin",
    "x@evil.northstar.example",
    "x@evil.northstar.example/other",
  ];
  const TEMPLATES: [string, (password: string) => string][] = [
    ["a PostgreSQL address", (pw) => `postgres://reader:${pw}@db.northstar.example:5432/permits`],
    ["a MySQL address with a setting", (pw) => `mysql://reader:${pw}@db.northstar.example:5432/permits?ssl-mode=REQUIRED`],
    ["a JDBC PostgreSQL address", (pw) => `jdbc:postgresql://db.northstar.example:5432/permits?user=reader&password=${pw}`],
    ["a JDBC SQL Server address", (pw) => `jdbc:sqlserver://db.northstar.example:5432;databaseName=permits;user=reader;password=${pw}`],
    ["a SQL Server address with a login", (pw) => `sqlserver://reader:${pw}@db.northstar.example:5432?database=permits`],
    ["SQL Server's own form", (pw) => `Server=db.northstar.example,5432;Database=permits;User ID=reader;Password=${pw}`],
    ["Oracle's thin form", (pw) => `jdbc:oracle:thin:reader/${pw}@//db.northstar.example:5432/permits`],
  ];

  test.each(TEMPLATES)("%s names the true fields or none, whatever its password holds", (_what, make) => {
    let readRight = 0;
    for (const password of PASSWORDS) {
      const text = make(password);
      const read = pastedConnection(text);
      if (read === null) {
        // Not read: the page then keeps the text out of the field.
        expect([text, looksLikeConnectionString(text)]).toEqual([text, true]);
        continue;
      }
      readRight += 1;
      for (const field of ["host", "port", "database", "user"] as const) {
        // A field it does not name is left to the person. One it names is the true one.
        const value = read[field];
        expect([text, field, value === undefined || value === TRUE[field]]).toEqual([text, field, true]);
      }
      expect([text, read.host, read.hadPassword]).toEqual([text, TRUE.host, true]);
    }
    // The plain cases are read: this is no test of a reader that reads nothing.
    expect(readRight).toBeGreaterThan(3);
  });

  test("a text setting after a password is not read, and the encryption still is", () => {
    const read = pastedConnection(
      "Server=db.northstar.example;Password=x;User ID=admin;Database=other;Encrypt=True;TrustServerCertificate=True",
    );
    expect(read).toEqual({ engine: "sqlserver", host: "db.northstar.example", encryption: "require", hadPassword: true });
  });

  test.each([
    "mongodb://reader:Tr0ub4dor@db.northstar.example/permits",
    "postgres://reader:pa/ss@db.northstar.example/permits",
    "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(HOST=db.northstar.example)))",
    "Password=Tr0ub4dor;User ID=reader",
    "Data Source=db one;Password=x",
  ])("%j is not read, and is known for a connection string, so it stays out of the field", (text) => {
    expect(pastedConnection(text)).toBeNull();
    expect(looksLikeConnectionString(text)).toBe(true);
  });

  test.each(["sql01.northstar.example", "sql01.northstar.example:1433", "permits_reader", "10.20.30.40"])(
    "%j is no connection string, and is pasted as it is",
    (text) => {
      expect(pastedConnection(text)).toBeNull();
      expect(looksLikeConnectionString(text)).toBe(false);
    },
  );
});

describe("no field takes a text that may hold a password", () => {
  const TEXT_FIELDS = ["name", "host", "port", "database", "user", "keyName", "serverName"] as const;
  // Each of these holds a password, and none of them is read by the form.
  const SECRET = ["S3cret", "tiger"];
  const UNREAD = [
    "host=db.example port=5432 dbname=permits user=reader password=S3cret",
    '"postgres://reader:S3cret@db.example:5432/permits"',
    "DATABASE_URL=postgres://reader:S3cret@db.example:5432/permits",
    "scott/tiger@//db.example:1521/PERMITS",
    "reader:S3cret@tcp(db.example:3306)/permits",
    "reader:S3cret@db.example:3306",
    "db.example/permits?user=reader&password=S3cret",
    "//reader:S3cret@db.example/permits",
    "mongodb://reader:S3cret@db.example/permits",
  ];
  // A line of plain words. Server and the fields with an alphabet of their
  // own keep it out. A name, a database's name and a user's name are made of
  // plain words themselves, so nothing can tell this line from one of them.
  const PLAIN_WORDS = "-h db.example -U reader -W S3cret";
  const holdsSecret = (value: unknown): boolean => SECRET.some((word) => JSON.stringify(value).includes(word));

  test("a pasted text that is not read stays out of every field", () => {
    for (const text of UNREAD) {
      expect([text, pastedConnection(text)]).toEqual([text, null]);
      for (const field of TEXT_FIELDS) {
        expect([text, field, pasteProblem(field, text) === null]).toEqual([text, field, false]);
      }
    }
    expect(pastedConnection(PLAIN_WORDS)).toBeNull();
    for (const field of ["host", "port", "keyName", "serverName"] as const) {
      expect([field, pasteProblem(field, PLAIN_WORDS) === null]).toEqual([field, false]);
    }
  });

  test("a pasted text that is read never puts a piece of the password into a field", () => {
    // Each of these was once read wrongly: an `@` after the address part.
    for (const text of [
      "postgres://reader:12345?sslmode=x@db.example/permits",
      "postgres://reader:5432/secretpart?sslmode=require@db.example/permits",
      "sqlserver://sa:1433;encrypt=true@db.example;databaseName=permits",
      "postgres://reader:p@ss/x?password=@db.example/permits",
      "Server=db.example;Encrypt=true@x;Database=permits",
    ]) {
      expect([text, pastedConnection(text)]).toEqual([text, null]);
      expect([text, pasteProblem("host", text) === null]).toEqual([text, false]);
    }
    // A password with an `@` in the address part is still read right.
    expect(pastedConnection("postgres://reader:p@ss@db.example:5432/permits")).toEqual({
      engine: "postgres",
      host: "db.example",
      port: "5432",
      database: "permits",
      user: "reader",
      hadPassword: true,
    });
  });

  test("what a field takes by paste is what can be its value", () => {
    const fine: [(typeof TEXT_FIELDS)[number], string][] = [
      ["name", "Northstar permits"],
      ["host", "sql01.northstar.example"],
      ["host", "10.20.30.40"],
      ["port", "1433"],
      ["database", "Permits"],
      ["user", "permits_reader"],
      ["keyName", "permits-reader"],
      ["serverName", "sql.northstar.example"],
    ];
    for (const [field, text] of fine) expect([field, text, pasteProblem(field, text)]).toEqual([field, text, null]);
    // A connection string belongs in Server, and the other fields say so.
    expect(pasteProblem("name", "postgres://reader@db.example/permits")).toBe("Paste a connection string into Server.");
    expect(pasteProblem("host", "postgres://reader:pa/ss@db.example/permits")).toContain("does not read that connection string");
    expect(pasteProblem("port", "")).toBeNull();
  });

  test("a text typed into a field is not sent unless it can be the field's value", () => {
    for (const text of UNREAD) {
      for (const field of ["name", "host", "database", "user", "keyName"] as const) {
        const form = { ...PERMITS, [field]: text };
        expect([text, field, problemsOf(form).some((problem) => problem.field === field)]).toEqual([text, field, true]);
      }
    }
    expect(holdsSecret(UNREAD)).toBe(true);
  });

  test("a name that holds an address with a login is no name, for the form and for the module alike", () => {
    const names: [string, boolean][] = [
      ["postgres://reader:S3cret@db.example:5432/permits", true],
      ["mysql://reader:hunter2@db.example/permits", true],
      ["reader:S3cret@db.example:3306", true],
      ["scott/tiger@db.example", true],
      ["sqlserver://db.example", true],
      ["Northstar permits", false],
      ["permits@sql01", false],
      ["sql01:1433/Permits", false],
      ["reader@northstar: permits", false],
    ];
    for (const [name, login] of names) {
      expect([name, holdsLogin(name), moduleHoldsLogin(name)]).toEqual([name, login, login]);
      const form = { ...PERMITS, name };
      expect([name, problemsOf(form).some((problem) => problem.field === "name")]).toEqual([name, login]);
      let word = "";
      try {
        connectionFields({ ...argsOf(PERMITS), name });
      } catch (thrown) {
        word = thrown instanceof AskFailure ? thrown.code : "threw";
      }
      expect([name, word]).toEqual([name, login ? "name_holds_login" : ""]);
    }
    expect(refusalOf("failed:name_holds_login").field).toBe("name");
  });

  test("a certificate's name is sent only where the certificate is checked", () => {
    const named = { ...PERMITS, serverName: "sql.northstar.example" };
    expect(argsOf({ ...named, encryption: "verify" }).serverName).toBe("sql.northstar.example");
    expect(argsOf({ ...named, encryption: "strict" }).serverName).toBe("sql.northstar.example");
    expect("serverName" in argsOf({ ...named, encryption: "require" })).toBe(false);
    expect("serverName" in argsOf({ ...named, encryption: "off" })).toBe(false);
    // And it is not judged where it is not sent.
    expect(problemsOf({ ...named, encryption: "require", serverName: "not a host" })).toEqual([]);
  });
});

describe("a text the module host takes as no argument of an act", () => {
  const credentials = FIELD_TEXTS.filter(([, , kind]) => kind === "credential");
  const long = FIELD_TEXTS.filter(([, , kind]) => kind === "long");
  /** Plain texts with the same words in them. */
  const TAKEN: [keyof DatabaseForm, string][] = [
    ["name", "Northstar permits"],
    ["name", "Tokens of Northstar"],
    ["name", "Token of the Northstar permits"],
    ["name", "Permits token"],
    ["name", "Token 2027"],
    ["name", "Password"],
    ["database", "Tokens"],
    ["user", "token_reader"],
    ["keyName", "token-reader"],
    ["keyName", "sk-reader"],
  ];

  test("one that reads as a password, a key or a token is told at its field before the form sends it", () => {
    expect(credentials.length).toBeGreaterThan(10);
    // Every field that holds a text has such a text in the list.
    expect([...new Set<string>(credentials.map(([field]) => field))].sort()).toEqual(
      ["database", "host", "keyName", "name", "serverName", "user"].sort(),
    );
    for (const [field, text] of credentials) {
      expect([field, text, problemsOf(formWith(field, text))]).toEqual([field, text, [{ field, words: CREDENTIAL_WORDS }]]);
      // The module host says no to this text, with an answer that names no field.
      expect([text, recordable(text)]).toEqual([text, false]);
    }
    expect(CREDENTIAL_WORDS).toContain("as a password, a key or a token");
  });

  test("the words for it do not repeat the text, or a part of it", () => {
    for (const [field, text] of credentials) {
      const words = textProblem(field, text) ?? "";
      for (const part of text.split(/[ :]/).filter((piece) => piece.length >= 8)) {
        expect([text, part, words.includes(part)]).toEqual([text, part, false]);
      }
    }
  });

  test("one that is longer than an act takes is told at its field too, and one character less is taken", () => {
    expect(long.map(([field]): string => field).sort()).toEqual(["database", "host", "serverName", "user"]);
    for (const [field, text] of long) {
      expect(text.length).toBe(FIELD_MAX_CHARS + 1);
      const problems = problemsOf(formWith(field, text));
      expect(problems.map((problem) => problem.field)).toEqual([field]);
      expect([field, problems[0]?.words ?? ""]).toEqual([field, textProblem(field, text) ?? "no words"]);
      expect([field, problems[0]?.words.endsWith(`is at most ${FIELD_MAX_CHARS} characters.`)]).toEqual([field, true]);
      expect([field, problemsOf(formWith(field, text.slice(1)))]).toEqual([field, []]);
    }
  });

  test("and a plain text with the same words in it is taken", () => {
    for (const [field, text] of TAKEN) {
      // Each is a text of the list, so the real gate is asked about it too.
      expect([field, text, FIELD_TEXTS.some(([f, listed, kind]) => f === field && listed === text && kind === "plain")]).toEqual([
        field,
        text,
        true,
      ]);
      expect([field, text, problemsOf(formWith(field, text))]).toEqual([field, text, []]);
      expect([text, recordable(text)]).toEqual([text, true]);
    }
  });

  test("what a filled form sends, and every value of the form's lists, is taken by the host", () => {
    const sent = Object.values(argsOf({ ...PERMITS, serverName: "sql.northstar.example" })).filter(
      (value): value is string => typeof value === "string",
    );
    expect(sent.length).toBeGreaterThan(7);
    for (const text of [...sent, ...ENGINES, ...ENCRYPTIONS, ...TLS_VERSIONS]) {
      expect([text, recordable(text)]).toEqual([text, true]);
    }
  });

  test("a paste of such a text is kept out of every field, Server too, with the words the field has for it", () => {
    for (const [field, text] of [...credentials, ...long]) {
      const words = pasteProblem(field, text);
      expect([field, text, words === null]).toEqual([field, text, false]);
      expect([field, text, words ?? ""]).toEqual([field, text, textProblem(field, text) ?? "no words"]);
    }
    for (const [field, text] of TAKEN) {
      expect([field, text, pasteProblem(field, text)]).toEqual([field, text, null]);
    }
  });

  test("a connection string that names such a value fills the other fields, and that value's field says why", () => {
    const read = pastedConnection(
      `Server=sql01.northstar.example;Database=${made("Token", " Exchange")};User ID=reader`,
    );
    // The text is read: it is no connection string the form cannot read.
    expect(read).toEqual({
      engine: "sqlserver",
      host: "sql01.northstar.example",
      user: "reader",
      hadPassword: false,
      // The field stays empty, so its words first say what was kept out of it.
      keptOut: [
        { field: "database", words: `The database named in the pasted text was not filled in. ${CREDENTIAL_WORDS}` },
      ],
    });
    const pasted = read as NonNullable<typeof read>;
    expect(keptOutProblems(pasted)).toEqual({
      database: `The database named in the pasted text was not filled in. ${CREDENTIAL_WORDS}`,
    });
    const filled = pastedInto(emptyForm("postgres"), pasted, false);
    expect(filled).toMatchObject({ engine: "sqlserver", host: "sql01.northstar.example", user: "reader", database: "" });
    // The value is in nothing the form holds.
    expect(JSON.stringify([pasted, filled])).not.toContain("Exchange");
    // A connection string with nothing of the kind names no field to keep out.
    const plain = pastedConnection("Server=sql01.northstar.example;Database=Permits;User ID=reader");
    expect(plain?.keptOut).toBeUndefined();
    expect(keptOutProblems(plain as NonNullable<typeof plain>)).toEqual({});
  });

  test("the server and the user name a connection string names are held to the rule as its database is", () => {
    const key = made("sk", "-prod-sqlserver-northstar-01");
    const read = pastedConnection(`Server=${key};Database=Permits;User ID=reader`);
    expect(read).toEqual({
      engine: "sqlserver",
      database: "Permits",
      user: "reader",
      hadPassword: false,
      keptOut: [{ field: "host", words: `The server named in the pasted text was not filled in. ${CREDENTIAL_WORDS}` }],
    });
    const filled = pastedInto(emptyForm("sqlserver"), read as NonNullable<typeof read>, false);
    expect(filled).toMatchObject({ host: "", database: "Permits", user: "reader" });
    expect(JSON.stringify([read, filled])).not.toContain(key);

    // A user name in the form of a key. One with a word such as token in front
    // of other text cannot come out of a connection string at all: the reader
    // takes one word for a user name.
    const login = made("AKIA", "NORTHSTAR", "PERMITS1");
    const named = pastedConnection(`Server=sql01.northstar.example;Database=Permits;User ID=${login}`);
    expect(named).toEqual({
      engine: "sqlserver",
      host: "sql01.northstar.example",
      database: "Permits",
      hadPassword: false,
      keptOut: [{ field: "user", words: `The user name in the pasted text was not filled in. ${CREDENTIAL_WORDS}` }],
    });
    expect(pastedConnection(`Server=sql01.northstar.example;Database=Permits;User ID=${made("token", " permits_reader")}`)).toBeNull();
    // Two values of one text, each said at its own field.
    const both = pastedConnection(`Server=${key};Database=${made("Token", " Exchange")};User ID=reader`);
    expect(Object.keys(keptOutProblems(both as NonNullable<typeof both>)).sort()).toEqual(["database", "host"]);
  });

  test("a value that is too long is kept out the same way, and one of the wrong characters means the text was not read", () => {
    const read = pastedConnection(`postgres://reader@db.northstar.example/${"d".repeat(FIELD_MAX_CHARS + 1)}`);
    expect(read).toEqual({
      engine: "postgres",
      host: "db.northstar.example",
      user: "reader",
      hadPassword: false,
      keptOut: [
        {
          field: "database",
          words: `The database named in the pasted text was not filled in. A database's name is at most ${FIELD_MAX_CHARS} characters.`,
        },
      ],
    });
    // A value with a character its field does not hold is a sign that the
    // text was cut at the wrong place. Nothing of such a text is used.
    expect(pastedConnection("Server=sql01.northstar.example;Database=per(mits);User ID=reader")).toBeNull();
  });
});

describe("a connection string pasted while a database is edited", () => {
  const editing = { ...emptyForm("sqlserver"), name: "Northstar permits", host: "sql01.northstar.example", encryption: "strict" as const };

  test("one for another engine is not taken, and changes nothing", () => {
    const read = pastedConnection("postgres://reader@db2.northstar.example/permits");
    expect(pastedInto(editing, read as NonNullable<typeof read>, true)).toBe(
      "This connection string is for PostgreSQL. This database is SQL Server.",
    );
  });

  test("one for the same engine fills the fields it names, and the engine's own settings stay", () => {
    const read = pastedConnection("sqlserver://sql02.northstar.example:14330;databaseName=Permits;user=permits_reader");
    expect(pastedInto(editing, read as NonNullable<typeof read>, true)).toMatchObject({
      engine: "sqlserver",
      name: "Northstar permits",
      host: "sql02.northstar.example",
      port: "14330",
      database: "Permits",
      user: "permits_reader",
      encryption: "strict",
    });
  });

  test("for a new database the engine follows the string", () => {
    const read = pastedConnection("postgres://reader@db2.northstar.example/permits");
    expect(pastedInto(emptyForm("sqlserver"), read as NonNullable<typeof read>, false)).toMatchObject({
      engine: "postgres",
      port: "5432",
    });
  });
});

describe("every answer an act of this page can get has a sentence", () => {
  const source = (file: string): string => readFileSync(path.join(import.meta.dir, "..", file), "utf8");
  const UNKNOWN = "This HX Fortress answered: ";

  /** The words of the module that no act of this page is answered with: each
   *  belongs to an ask of the control plane, or to an act the page never makes. */
  const NOT_THIS_PAGE = ["ask_not_implemented", "catalog_changed", "catalog_not_read", "job_unknown", "page_unknown"];

  test("the module's own words, read from its source", () => {
    const words = new Set<string>();
    for (const file of ["src/modules/databases/module.ts", "src/modules/databases/connections.ts"]) {
      for (const match of source(file).matchAll(/new AskFailure\("([a-z_]+)"\)/g)) words.add(match[1] as string);
    }
    expect(words.size).toBeGreaterThan(15);
    const without: string[] = [];
    for (const word of words) {
      if (NOT_THIS_PAGE.includes(word)) continue;
      if (refusalOf(`failed:${word}`).words.startsWith(UNKNOWN)) without.push(word);
      // A fault of this side exactly where the route answers 500.
      expect([word, isOwnFault(`failed:${word}`)]).toEqual([word, actStatus(`failed:${word}`) === 500]);
    }
    expect(without).toEqual([]);
    // The list of words left out holds no word the module no longer has.
    expect(NOT_THIS_PAGE.filter((word) => !words.has(word))).toEqual([]);
  });

  test("the words of the module host's two lists, read from its contract", () => {
    const words = [...source("src/host/module-contract.ts").matchAll(/\| "((?:reach|secret)_[a-z_]+)"/g)].map(
      (match) => match[1] as string,
    );
    expect(words.length).toBeGreaterThan(8);
    expect(words.filter((word) => refusalOf(`failed:${word}`).words.startsWith(UNKNOWN))).toEqual([]);
    // The route answers none of them as a fault of this side (500): each is
    // about what was asked, or about a list that cannot be read now.
    expect(words.filter((word) => isOwnFault(`failed:${word}`) || actStatus(`failed:${word}`) === 500)).toEqual([]);
    // Two of them get the sentence for a fault all the same. A reach's name is
    // the module's own: it makes the name up, and no person types one.
    const OWN = refusalOf("failed:internal").words;
    expect(words.filter((word) => refusalOf(`failed:${word}`).words === OWN).sort()).toEqual([
      "reach_name_invalid",
      "reach_name_taken",
    ]);
  });

  test("the words of the act route, read from the function that gives each its status", () => {
    const routes = source("src/ui/act-routes.ts");
    const from = routes.indexOf("function notNow");
    const to = routes.indexOf("export async function handleActRoute");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    // Every word in quotes there: the words `actStatus` names, the failures
    // that are a defect of this side, and the two starts of a word that are.
    const words = [...routes.slice(from, to).matchAll(/"((?:failed:)?[a-z_]+)"/g)].map((match) => match[1] as string);
    expect(words.length).toBeGreaterThan(13);
    // Two more are constants there: the daemon that is not running, and the act cut short.
    for (const word of [...words, DAEMON_UNREACHABLE, ACT_INTERRUPTED]) {
      expect([word, refusalOf(word).words.startsWith(UNKNOWN)]).toEqual([word, false]);
      expect([word, isOwnFault(word)]).toEqual([word, actStatus(word) === 500]);
    }
    // A failure of this HX Fortress's own state, which the same request may
    // not meet later, is no fault of this side and has a sentence of its own.
    for (const word of ["failed:module_not_running", "failed:audit_unavailable", "failed:secret_names_unreadable", "failed:state_unreadable"]) {
      expect([word, actStatus(word), isOwnFault(word), refusalOf(word).words.startsWith(UNKNOWN)]).toEqual([
        word,
        503,
        false,
        false,
      ]);
    }
  });
});
