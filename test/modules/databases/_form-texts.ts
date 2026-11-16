// Texts a person may type into a field of the console's Add Database form.
//
// Two tests read this one list. test/ui-database-form.test.ts holds the form's
// rules to the module's own rules and to what the module host's gate is known
// to turn away. test/modules/databases/form-and-gate.test.ts sends what the
// form would send through the host's real gate and the real module. So a rule
// that one side changes shows in one of them, on the same texts.

import { emptyForm, FIELD_MAX_CHARS, type DatabaseForm, type FieldName } from "../../../ui/src/lib/database-form";

/**
 * A text put together when the test runs. This repository's secret scan reads
 * every literal on every branch, and would take some of these for a secret.
 */
export const made = (...parts: string[]): string => parts.join("");

/** A form a person filled in, for the made-up company's permits database. */
export const PERMITS_FORM: DatabaseForm = {
  ...emptyForm("sqlserver"),
  name: "Northstar permits",
  host: "sql01.northstar.example",
  database: "Permits",
  user: "permits_reader",
  keyName: "permits-reader",
};

/** A host name of exactly this many characters, with no label too long. */
export const hostOf = (length: number): string => ["a".repeat(60), "b".repeat(60), "c".repeat(length - 122)].join(".");

/**
 * How a text reads to the module host's gate, as far as this list knows:
 *   `credential`  the audit trail would replace a part of it
 *   `long`        longer than the act's declared shape takes
 *   `plain`       neither
 * The gate's answer to the first two names no field.
 */
export type TextKind = "credential" | "long" | "plain";

export const FIELD_TEXTS: readonly (readonly [field: FieldName, text: string, kind: TextKind])[] = [
  // ── Name ──
  ["name", "Northstar permits", "plain"],
  ["name", "Tokens of Northstar", "plain"],
  ["name", "Permits token", "plain"],
  ["name", "Token 2027", "plain"],
  ["name", "Token of the Northstar permits", "plain"],
  ["name", "Password", "plain"],
  ["name", "permits@sql01", "plain"],
  ["name", "sql01:1433/Permits", "plain"],
  ["name", "x".repeat(64), "plain"],
  ["name", "Permits (2026)", "plain"],
  ["name", "a  b", "plain"],
  ["name", "-permits", "plain"],
  ["name", made("Token", " Northstar2027"), "credential"],
  ["name", made("Token", " Exchange"), "credential"],
  ["name", made("Authorization", " database"), "credential"],
  ["name", made("Bearer", " permits.reader"), "credential"],
  ["name", made("Password", ": permits"), "credential"],
  ["name", made("AKIA", "NORTHSTAR", "PERMITS1"), "credential"],
  // ── Server ──
  ["host", "sql01.northstar.example", "plain"],
  ["host", "SQL_01", "plain"],
  ["host", "10.20.30.40", "plain"],
  ["host", "2001:db8::10", "plain"],
  ["host", "not a host", "plain"],
  ["host", "db/x", "plain"],
  ["host", "db@x", "plain"],
  ["host", "a=b", "plain"],
  ["host", hostOf(FIELD_MAX_CHARS), "plain"],
  ["host", hostOf(FIELD_MAX_CHARS + 1), "long"],
  ["host", made("sk", "-prod-sqlserver-northstar-01"), "credential"],
  ["host", made("token", ":abcdefgh.example"), "credential"],
  // ── Database ──
  ["database", "Permits", "plain"],
  ["database", "par cels", "plain"],
  ["database", "PERMITS.PDB-1", "plain"],
  ["database", "Tokens", "plain"],
  ["database", "a/b", "plain"],
  ["database", "a:b", "plain"],
  ["database", "a@b", "plain"],
  ["database", "a;b", "plain"],
  ["database", "d".repeat(FIELD_MAX_CHARS), "plain"],
  ["database", "d".repeat(FIELD_MAX_CHARS + 1), "long"],
  ["database", made("Token", " Database2027"), "credential"],
  // ── User Name ──
  ["user", "permits_reader", "plain"],
  ["user", "reader@northstar", "plain"],
  ["user", "token_reader", "plain"],
  ["user", "a b", "plain"],
  ["user", "a:b", "plain"],
  ["user", "a/b", "plain"],
  ["user", "a=b", "plain"],
  ["user", "u".repeat(FIELD_MAX_CHARS), "plain"],
  ["user", "u".repeat(FIELD_MAX_CHARS + 1), "long"],
  ["user", made("token", " permits_reader"), "credential"],
  // ── Password, which holds a secret's name ──
  ["keyName", "permits-reader", "plain"],
  ["keyName", "token-reader", "plain"],
  ["keyName", "sk-reader", "plain"],
  ["keyName", "Permits Reader", "plain"],
  ["keyName", "k".repeat(65), "plain"],
  ["keyName", made("sk", "-permits-reader-production"), "credential"],
  // ── Certificate Name ──
  ["serverName", "sql.northstar.example", "plain"],
  ["serverName", "not a host", "plain"],
  ["serverName", "a/b", "plain"],
  ["serverName", hostOf(FIELD_MAX_CHARS + 1), "long"],
  ["serverName", made("AKIA", "NORTHSTAR", "PERMITS1"), "credential"],
];

/** The form with one field's text put in. A name of its own keeps two forms
 *  apart where the text is not the name. */
export function formWith(field: FieldName, text: string, name: string = PERMITS_FORM.name): DatabaseForm {
  return { ...PERMITS_FORM, name, [field]: text };
}
