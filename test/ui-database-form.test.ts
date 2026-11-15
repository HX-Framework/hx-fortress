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

import { AskFailure } from "../src/host/module-contract";
import { conform } from "../src/host/shape";
import { connectionFields } from "../src/modules/databases/connections";
import {
  CONNECTION_NAME_MAX_CHARS as MODULE_NAME_MAX,
  DATABASES_ACTS,
  DEFAULT_MIN_TLS as MODULE_MIN_TLS,
  ENCRYPTION_MODES,
  ENGINES as MODULE_ENGINES,
  TLS_VERSIONS as MODULE_TLS_VERSIONS,
} from "../src/modules/databases/manifest";
import { isSecretName as moduleIsSecretName } from "../src/secrets/types";
import {
  argsOf,
  CONNECTION_NAME_MAX_CHARS,
  DEFAULT_MIN_TLS,
  emptyForm,
  ENCRYPTION_LABEL,
  ENCRYPTIONS,
  encryptionsFor,
  ENGINE_INFO,
  ENGINES,
  FORM_FIRST,
  FORM_MORE,
  formOf,
  isFolded,
  isSecretName,
  keyNameProblem,
  moreSummary,
  nameOf,
  pastedConnection,
  problemsOf,
  readFailureOf,
  refusalOf,
  TLS_VERSIONS,
  withEngine,
  withPasted,
  type DatabaseForm,
} from "../ui/src/lib/database-form";

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

  test("the form refuses nothing the module would take", () => {
    // The module's own rules are not repeated in the form: what it lets
    // through here, the module judges.
    for (const changed of [
      { name: "Permits (2026)" },
      { host: "not a host" },
      { database: "a/b" },
      { user: "a:b" },
      { serverName: "not a host" },
    ]) {
      expect([changed, problemsOf({ ...PERMITS, ...changed })]).toEqual([changed, []]);
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
