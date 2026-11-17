// The Add Database form: its fields, what it checks, what it sends, and what
// it reads from a pasted connection string.
//
// The form is the same one a control plane shows for a database: an engine,
// a name, a server and a port, a database, a user name and a password, and
// More Settings folded under them. This file is the part of it that has no
// screen, so a test can hold it to the Databases module's own lists and rules.
//
// THE PASSWORD FIELD HOLDS A NAME. A person's act carries no secret's value,
// and this HX Fortress writes to no key store. So the form asks for the name
// under which the password is kept in the organization's key store, and the
// module hands that name to the module host, which reads the value when it
// starts the data runner. Nothing here ever holds a password:
//
//   • every field takes only text that can be its value (`textProblem`). What
//     cannot be is not sent, and a paste of it is kept out of the field;
//   • a password inside a pasted connection string is dropped where the text
//     is read, and is in nothing this file returns.
//
// TWO THINGS THE FORM CANNOT TELL. A password made only of lower-case letters,
// digits and hyphens looks like a secret's name, and is taken as one. That is
// why the field says "Secret name" in front of what is typed. And a line of
// plain words can be a name, a database's name or a user's name, whatever the
// words say: only text with the marks of an address or a setting is kept out.
//
// THE MODULE HOST TURNS SOME ARGUMENTS AWAY WITHOUT NAMING A FIELD, for every
// module's acts, before the module is called. Its answer is `args_invalid`:
//
//   • an argument that does not have the shape the act declares. For this
//     form's fields that is a text of more than 128 characters, or one with a
//     character a name does not hold;
//   • an argument that the audit trail would replace a part of, because the
//     part has the form of a password, a key or a token.
//
// So the form applies both rules to each field before it sends
// (`FIELD_MAX_CHARS`, the alphabet of each field, `looksLikeCredential`), and
// says which field it is about. test/modules/databases/form-and-gate.test.ts
// sends what the form would send through the host's real gate, and fails when
// the gate turns away something the form let through.

import { redactCredentials } from "../../../src/ui/redact";

// ── The lists, as the Databases module has them ──────────────────────────────
//
// They are written out here and not imported: the console's bundle takes only
// what it names from the server's tree. test/ui-database-form.test.ts fails
// when one of these differs from the module's.

export const ENGINES = ["sqlserver", "oracle", "mysql", "postgres"] as const;
export type Engine = (typeof ENGINES)[number];

export const ENCRYPTIONS = ["verify", "require", "strict", "off"] as const;
export type Encryption = (typeof ENCRYPTIONS)[number];

export const TLS_VERSIONS = ["1.0", "1.1", "1.2", "1.3"] as const;
export type TlsVersion = (typeof TLS_VERSIONS)[number];
export const DEFAULT_MIN_TLS: TlsVersion = "1.2";

/** Longest name of a connection. */
export const CONNECTION_NAME_MAX_CHARS = 64;
/** Longest server, database, user name or certificate name: what the act's
 *  declared shape takes for a name (`NAME_MAX_CHARS` of the host's shapes). */
export const FIELD_MAX_CHARS = 128;

export interface EngineInfo {
  label: string;
  /** The port the engine listens on unless its administrator chose another. */
  port: number;
  /** What the engine calls the thing a login opens. */
  database: "Database" | "Service Name";
}

export const ENGINE_INFO: Readonly<Record<Engine, EngineInfo>> = {
  sqlserver: { label: "SQL Server", port: 1433, database: "Database" },
  oracle: { label: "Oracle", port: 1521, database: "Service Name" },
  mysql: { label: "MySQL", port: 3306, database: "Database" },
  postgres: { label: "PostgreSQL", port: 5432, database: "Database" },
};

export const ENCRYPTION_LABEL: Readonly<Record<Encryption, string>> = {
  verify: "TLS, Certificate Checked",
  require: "TLS, Certificate Not Checked",
  strict: "Strict TLS (TDS 8)",
  off: "Off",
};

/** True for the encryptions that check the server's certificate. Only those
 *  have a use for the name a certificate must carry. */
export function checksCertificate(encryption: Encryption): boolean {
  return encryption === "verify" || encryption === "strict";
}

/** The encryptions an engine takes. Strict TLS is SQL Server's alone. */
export function encryptionsFor(engine: Engine): Encryption[] {
  return ENCRYPTIONS.filter((mode) => mode !== "strict" || engine === "sqlserver");
}

// ── The form ─────────────────────────────────────────────────────────────────

/** What a person has typed. Every field is text, as a field holds it. */
export interface DatabaseForm {
  engine: Engine;
  /** Left empty, the name is the database's. */
  name: string;
  host: string;
  port: string;
  database: string;
  user: string;
  /** The name of the secret that holds the password. Never the password. */
  keyName: string;
  encryption: Encryption;
  minTls: TlsVersion;
  /** The name the server's certificate must carry, when it is not the server's. */
  serverName: string;
}

export type FieldName = keyof DatabaseForm;

/** The fields, in the order they show. The second list folds under More
 *  Settings. */
export const FORM_FIRST = ["engine", "name", "host", "port", "database", "user", "keyName"] as const;
export const FORM_MORE = ["encryption", "minTls", "serverName"] as const;

export function isFolded(field: FieldName): boolean {
  return (FORM_MORE as readonly string[]).includes(field);
}

export function emptyForm(engine: Engine = "sqlserver"): DatabaseForm {
  return {
    engine,
    name: "",
    host: "",
    // The engine's own port, until the person types another.
    port: String(ENGINE_INFO[engine].port),
    database: "",
    user: "",
    keyName: "",
    encryption: "verify",
    minTls: DEFAULT_MIN_TLS,
    serverName: "",
  };
}

/** The form with another engine. The port follows the engine unless the
 *  person typed one of their own, and Strict TLS does not follow to an engine
 *  that has none. */
export function withEngine(form: DatabaseForm, engine: Engine): DatabaseForm {
  const typedPort = form.port.trim() !== "" && form.port.trim() !== String(ENGINE_INFO[form.engine].port);
  return {
    ...form,
    engine,
    port: typedPort ? form.port : String(ENGINE_INFO[engine].port),
    encryption: form.encryption === "strict" && engine !== "sqlserver" ? "verify" : form.encryption,
  };
}

/** A connection as the module answers one, for the form that changes it. */
export interface ConnectionFields {
  name: string;
  engine: Engine;
  host: string;
  port: number;
  database: string;
  encryption: Encryption;
  minTls?: TlsVersion;
  serverName?: string;
  user: string;
  keyName: string;
}

export function formOf(connection: ConnectionFields): DatabaseForm {
  return {
    engine: connection.engine,
    name: connection.name,
    host: connection.host,
    port: String(connection.port),
    database: connection.database,
    user: connection.user,
    keyName: connection.keyName,
    encryption: connection.encryption,
    minTls: connection.minTls ?? DEFAULT_MIN_TLS,
    serverName: connection.serverName ?? "",
  };
}

/** The name the connection gets: the one typed, or the database's. */
export function nameOf(form: DatabaseForm): string {
  return form.name.trim() || form.database.trim();
}

/** What the act is handed. Text is trimmed, the port is a number, and a field
 *  that More Settings left at its start is sent as it stands. */
export function argsOf(form: DatabaseForm): ConnectionFields {
  const serverName = form.serverName.trim();
  return {
    name: nameOf(form),
    engine: form.engine,
    host: form.host.trim(),
    port: Number(form.port.trim()),
    database: form.database.trim(),
    encryption: form.encryption,
    minTls: form.minTls,
    ...(serverName === "" || !checksCertificate(form.encryption) ? {} : { serverName }),
    user: form.user.trim(),
    keyName: form.keyName.trim(),
  };
}

/**
 * More Settings' row while it is folded: what holds now, in a few words. The
 * Databases page says the same words about a connection it lists.
 *
 * A connection with no encryption says so first, because that is the one
 * setting here a person should not have to open the row to learn.
 */
export function moreSummary(form: Pick<DatabaseForm, "encryption" | "minTls">): string {
  if (form.encryption === "off") return "Not encrypted";
  const version = form.minTls === "1.3" ? "TLS 1.3" : `TLS ${form.minTls} or newer`;
  const lead = form.encryption === "strict" ? `Strict ${version}` : version;
  return `${lead}, certificate ${form.encryption === "require" ? "not checked" : "checked"}`;
}

// ── What the form checks before it sends ─────────────────────────────────────
//
// Only what a person can be told while they type: a field left empty, a port
// that is no port, a password field that does not hold a secret's name, and a
// text the module host takes as no argument. Every other rule is the module's,
// and its answer names the field (`refusalOf`). So the form never refuses what
// the module and the module host would take.

export interface FieldProblem {
  field: FieldName;
  words: string;
}

/** A secret's name: 1 to 64 characters of a to z, 0 to 9 and the hyphen. */
const SECRET_NAME = /^[a-z0-9-]{1,64}$/;

export function isSecretName(text: string): boolean {
  return SECRET_NAME.test(text);
}

/** Why the password field's text is no secret's name, or null when it is one. */
export function keyNameProblem(text: string): string | null {
  const name = text.trim();
  if (name === "") return "Name the secret that holds the password.";
  if (name.length > 64) return "A secret's name is at most 64 characters.";
  if (!isSecretName(name)) return "A secret's name holds a to z, 0 to 9 and the hyphen.";
  return null;
}

// What each field's text may be. The module host's gate judges the arguments
// first, and its answer names no field. Then the Databases module judges each
// field, and its answer names the field. These rules are no stricter than
// those two, so the form refuses nothing they would take, and they hold
// everything the gate would turn away: what the rules refuse is never sent.
// test/ui-database-form.test.ts holds the rules to the module's, and
// test/modules/databases/form-and-gate.test.ts holds them to the gate.

/** The characters a name of the module may hold (`NAME_PATTERN` of the host). */
const NAME_TEXT = /^[A-Za-z0-9 _.:/@-]+$/;
/** A host name or an IP address: no space, no slash, no `@`. */
const HOST_TEXT = /^[A-Za-z0-9._:-]+$/;
/** A database's name: a name without colon, slash and `@`. */
const DATABASE_FIELD = /^[A-Za-z0-9 _.-]+$/;
/** A user's name: a name without colon and slash. */
const USER_FIELD = /^[A-Za-z0-9 _.@-]+$/;

const NAME_WORDS = "A name holds letters, digits, single spaces and _ . : / @ -";
const LOGIN_IN_NAME = "A name cannot hold an address with a login in it. Give the database a plain name.";
const HOST_WORDS = "A server is a host name or an IP address.";
const CERTIFICATE_WORDS = "A certificate name is a host name or an IP address.";
const PORT_WORDS = "A port is a number from 1 to 65535.";
const DATABASE_WORDS = "A database's name holds letters, digits, spaces and _ . -";
const USER_WORDS = "A user name holds letters, digits, spaces and _ . @ -";
const HOST_LONG = `A server's name is at most ${FIELD_MAX_CHARS} characters.`;
const CERTIFICATE_LONG = `A certificate name is at most ${FIELD_MAX_CHARS} characters.`;
const DATABASE_LONG = `A database's name is at most ${FIELD_MAX_CHARS} characters.`;
const USER_LONG = `A user name is at most ${FIELD_MAX_CHARS} characters.`;

/**
 * True for a text that holds an address with a login in it: `scheme://…`,
 * `user:password@host`, `user/password@host`. A connection's name is shown to
 * every signed-in person, so such a text is no name. The module has the same
 * rule (`holdsLogin` in src/modules/databases/connections.ts).
 */
export function holdsLogin(text: string): boolean {
  return text.includes("://") || /[:/][^@]*@/.test(text);
}

/**
 * True for a text that no act takes as an argument: the audit trail would
 * replace a part of it, because that part has the form of a password, a key
 * or a token. The module host refuses such an argument for every module,
 * before the module is called (`recordable` in src/host/module-lists.ts). The
 * rule here calls the function that the host's rule calls, the audit trail's
 * own `redactCredentials`.
 *
 * It is no guess about what a person meant. "Token Northstar2027" is a plain
 * name to a person, and the audit trail would still write it as "Token" and a
 * replaced word. So a server, a database or a user whose real name has such a
 * form cannot be added to an HX Fortress. That limit is the module host's.
 */
export function looksLikeCredential(text: string): boolean {
  return redactCredentials(text) !== text;
}

/** What a field says for such a text. It does not repeat the text, and it
 *  names the cause that is the usual one, not every one. */
export const CREDENTIAL_WORDS =
  "This HX Fortress reads part of this as a password, a key or a token, and takes no such text. Often the cause is a word such as token or password in front of other text.";

/** Why a text cannot be a field's value, or null when it can. */
export function textProblem(field: FieldName, text: string): string | null {
  const value = text.trim();
  const own = fieldRuleProblem(field, value);
  if (own !== null) return own;
  return looksLikeCredential(value) ? CREDENTIAL_WORDS : null;
}

/** Why a text breaks the rule of its own field, or null when it does not. */
function fieldRuleProblem(field: FieldName, value: string): string | null {
  switch (field) {
    case "name":
      if (value.length > CONNECTION_NAME_MAX_CHARS) return `A name is at most ${CONNECTION_NAME_MAX_CHARS} characters.`;
      if (!NAME_TEXT.test(value)) return NAME_WORDS;
      return holdsLogin(value) ? LOGIN_IN_NAME : null;
    case "host":
      if (value.length > FIELD_MAX_CHARS) return HOST_LONG;
      return HOST_TEXT.test(value) ? null : HOST_WORDS;
    case "serverName":
      if (value.length > FIELD_MAX_CHARS) return CERTIFICATE_LONG;
      return HOST_TEXT.test(value) ? null : CERTIFICATE_WORDS;
    case "port":
      return /^[0-9]{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65_535 ? null : PORT_WORDS;
    case "database":
      if (value.length > FIELD_MAX_CHARS) return DATABASE_LONG;
      return DATABASE_FIELD.test(value) ? null : DATABASE_WORDS;
    case "user":
      if (value.length > FIELD_MAX_CHARS) return USER_LONG;
      return USER_FIELD.test(value) ? null : USER_WORDS;
    case "keyName":
      return keyNameProblem(value);
    default:
      return null;
  }
}

export function problemsOf(form: DatabaseForm): FieldProblem[] {
  const problems: FieldProblem[] = [];
  /** `empty` is what to say for a field left empty, or null when it may be. */
  const check = (field: FieldName, text: string, empty: string | null): void => {
    const words = text.trim() === "" ? empty : textProblem(field, text);
    if (words !== null) problems.push({ field, words });
  };
  if (form.name.trim() !== "") {
    check("name", form.name, null);
  } else if (nameOf(form).length > CONNECTION_NAME_MAX_CHARS) {
    // A name left empty is the database's, which may be longer than a name.
    problems.push({ field: "name", words: `A name is at most ${CONNECTION_NAME_MAX_CHARS} characters.` });
  }
  check("host", form.host, "Name the server.");
  check("port", form.port, PORT_WORDS);
  check("database", form.database, form.engine === "oracle" ? "Name the service." : "Name the database.");
  check("user", form.user, "Name the user.");
  check("keyName", form.keyName, "Name the secret that holds the password.");
  if (checksCertificate(form.encryption)) check("serverName", form.serverName, null);
  return problems;
}

// ── What the module, or this HX Fortress, answered ───────────────────────────

/**
 * The words for an act that was not carried out, and the field they are about
 * when they are about one.
 *
 * `word` is what the act's route answered: `failed:` and the module's or the
 * host's own word, or one of the route's own words. A word this file does not
 * know is shown as it is, so nothing is ever hidden behind a general sentence.
 */
const BUILDS_DIFFER =
  "The daemon of this HX Fortress does not know this request. Its console and its daemon may be of different builds.";
/**
 * A fault of this side met while an act was under way. Whether the act was
 * carried out is not known then: a module that failed half way may have
 * changed something, and with `reply_invalid` the module did all of it and
 * only its answer could not be shown. So the sentence does not say that
 * nothing was changed.
 */
const OWN_FAULT =
  "This HX Fortress met a fault of its own while it worked on this. Look at the list to see whether it was carried out. Its log says more.";
/** The same for a read of the list, which changes nothing. */
const OWN_FAULT_READ = "This HX Fortress could not show its databases, because of a fault of its own. Its log says more.";

/** The failures that are a defect on this side, by their word after `failed:`. */
const OWN_FAULT_WORDS: readonly string[] = [
  "internal",
  "request_invalid",
  "secret_not_declared",
  "not_allowed",
  "organization_not_held",
  "process_not_declared",
];
/** And every refusal of a call or of a folder that the module's manifest does
 *  not allow. */
const OWN_FAULT_PREFIXES: readonly string[] = ["egress_", "folder_"];

/** A failure of this HX Fortress's own state that the same request may not
 *  meet later, by its word after `failed:`. The route answers it 503, and it
 *  goes by the word's ending before anything else (`notNow` in
 *  src/ui/act-routes.ts). */
function notNow(code: string): boolean {
  return code === "module_not_running" || /^[a-z0-9_]*_(?:unavailable|unreadable)$/.test(code);
}

/**
 * True for a failure that is a defect on this side: of the console, of the
 * daemon, or of a module that tried what its own manifest does not allow.
 * Nothing a person typed causes one, and nothing they can change mends it. The
 * act's route answers each of them with status 500 (`actStatus` in
 * src/ui/act-routes.ts), and test/ui-database-form.test.ts holds this to it,
 * for the words the route has and for words made up in their forms.
 *
 * `not_allowed` is two words. Alone, it is what a person is answered whose
 * role may not do the act: the daemon's gate says it before the module runs.
 * With `failed:` in front it came from behind that check: from the host's
 * lists, when an act that only reads tried to change one, or from the module,
 * which looks at the role once more. A person's role is settled before
 * either, so both are a defect of this side.
 */
export function isOwnFault(word: string): boolean {
  if (word === "reply_invalid") return true;
  if (!word.startsWith("failed:")) return false;
  const code = word.slice("failed:".length);
  if (notNow(code)) return false;
  return OWN_FAULT_WORDS.includes(code) || OWN_FAULT_PREFIXES.some((prefix) => code.startsWith(prefix));
}

export function refusalOf(word: string, form?: DatabaseForm): { field?: FieldName; words: string } {
  if (isOwnFault(word)) return { words: OWN_FAULT };
  const code = word.startsWith("failed:") ? word.slice("failed:".length) : word;
  switch (code) {
    case "name_invalid":
      return {
        field: "name",
        words:
          form && form.name.trim() === ""
            ? "The database's name cannot be this connection's name. Give it a name of letters, digits and spaces."
            : "A name starts and ends with a letter or a digit, and holds letters, digits, single spaces and _ . : / @ -",
      };
    case "name_taken":
      return { field: "name", words: "Another database on this HX Fortress has this name." };
    case "engine_invalid":
      return { field: "engine", words: "This HX Fortress does not know this engine." };
    case "host_invalid":
    case "reach_host_invalid":
      return { field: "host", words: "A server is a host name or an IP address." };
    case "reach_address_refused":
      return {
        field: "host",
        words: "This HX Fortress does not connect to that address: it is this machine's own, or one no database is at.",
      };
    case "port_invalid":
    case "reach_port_invalid":
      return { field: "port", words: "A port is a number from 1 to 65535." };
    case "database_invalid":
      return { field: "database", words: "A database's name holds no colon, slash or @ sign." };
    case "user_invalid":
      return { field: "user", words: "A user name holds no colon and no slash." };
    case "key_name_invalid":
    case "secret_name_invalid":
      return { field: "keyName", words: "A secret's name holds a to z, 0 to 9 and the hyphen." };
    case "secret_name_reserved":
      return { field: "keyName", words: "This secret is one of this HX Fortress's own. A database's login cannot use it." };
    case "encryption_invalid":
      return { field: "encryption", words: "This HX Fortress does not know this encryption." };
    case "encryption_not_for_engine":
      return { field: "encryption", words: "Strict TLS is SQL Server's alone." };
    case "min_tls_invalid":
      return { field: "minTls", words: "This HX Fortress does not know this TLS version." };
    case "server_name_invalid":
      return { field: "serverName", words: "A certificate name is a host name or an IP address." };
    case "connections_full":
    case "reach_list_full":
    case "secret_names_full":
      return { words: "This HX Fortress holds as many databases as it can: 64. Remove one first." };
    case "connection_unknown":
      return { words: "This database is no longer on this HX Fortress." };
    case "connection_busy":
      return { words: "A test of this database is running. Try again when it has ended." };
    case "login_refused":
      return { words: "The server refused this login at the last test. Change the login, then test again." };
    case "busy":
      return { words: "This HX Fortress is doing as much as it can at once. Try again in a moment." };
    case "not_allowed":
      return { words: "Your account can read this page and cannot change it." };
    case "daemon_unreachable":
    case "module_not_running":
      return { words: "The HX Fortress daemon is not running, so nothing was changed." };
    case "module_off":
      return { words: "Databases is switched off on this HX Fortress." };
    case "audit_unavailable":
      return { words: "This HX Fortress could not write its audit record, so nothing was changed." };
    case "secret_unavailable":
      return { words: "The key store did not answer, so nothing was changed." };
    case "reach_list_unreadable":
    case "secret_names_unreadable":
    case "state_unreadable":
      return { words: "This HX Fortress could not read what it keeps about its databases, so nothing was changed." };
    // The act is not stopped when its time is over: the daemon goes on with it.
    case "timeout":
      return { words: "This HX Fortress did not finish in time. It may still carry this out: look at the list in a moment." };
    case "interrupted":
      return { words: "The daemon stopped while it worked on this. It may have been carried out: look at the list." };
    case "name_holds_login":
      return { field: "name", words: LOGIN_IN_NAME };
    case "act_unknown":
    case "act_not_implemented":
      return { words: BUILDS_DIFFER };
    // The names of the hosts on this HX Fortress's list are the module's own:
    // it makes them up, and no person types one. So a refusal of such a name
    // is a fault of this side too, though the route answers it like a refusal
    // of what was asked (422), and `isOwnFault` goes by the route.
    case "reach_name_invalid":
    case "reach_name_taken":
      return { words: OWN_FAULT };
    case "args_invalid":
      return { words: "A field holds something this HX Fortress does not take. Check each field." };
    default:
      return { words: `This HX Fortress answered: ${code}` };
  }
}

/**
 * The sentence for a list that could not be read. A read changes nothing, so
 * it does not say that nothing was changed: it says what the page waits for.
 * The page reads the list again by itself.
 */
export function readFailureOf(word: string): string {
  if (isOwnFault(word)) return OWN_FAULT_READ;
  const code = word.startsWith("failed:") ? word.slice("failed:".length) : word;
  switch (code) {
    case "daemon_unreachable":
    case "module_not_running":
      return "The HX Fortress daemon is not running. Its databases show here once it runs.";
    case "busy":
      return "This HX Fortress is doing as much as it can at once. The list is read again in a moment.";
    case "timeout":
    case "interrupted":
      return "This HX Fortress did not answer in time. The list is read again in a moment.";
    case "state_unreadable":
      return "This HX Fortress could not read what it keeps about its databases.";
    case "module_off":
      return "Databases is switched off on this HX Fortress.";
    case "act_unknown":
    case "act_not_implemented":
      return BUILDS_DIFFER;
    default:
      return `This HX Fortress answered: ${code}`;
  }
}

// ── A pasted connection string ───────────────────────────────────────────────
//
// WHAT IT READS IS RIGHT, OR IT USES NOTHING. A connection string can hold a
// password, and a password can hold any character: `/`, `?`, `;`, `@`. A text
// that is cut in the wrong place would put a piece of the password into a
// field, on the screen. So the text is cut by the standard rules only, and
// every sign that it was cut wrongly makes the whole text unread:
//
//   • In a URL, an `@` stands only inside the address part (before the first
//     `/`, `?` or `#`). In SQL Server's own form it stands only in the value
//     of a password setting. Anywhere else, the text is not read.
//   • After a password setting, no setting that holds text is read: nobody
//     can say where a password ends. Only the encryption is still read there,
//     because its values come from a fixed list.
//   • What would go into a field must look like that field's value.
//
// A text that looks like a connection string and was not read is not put into
// the field either (`looksLikeConnectionString`): it may hold a password.
//
// What is left: a password that itself holds the words `;password=` can make
// a SQL Server address read wrongly. Nothing short of not reading such
// addresses at all would end that.

/** The fields a connection string named. It has no password: one in the text
 *  is dropped where the text is read. */
export interface PastedConnection {
  engine?: Engine;
  host?: string;
  port?: string;
  database?: string;
  user?: string;
  encryption?: Encryption;
  /** True when the text held a password, which is not in this value. */
  hadPassword: boolean;
  /**
   * The fields the text named with a value that no act takes: one that reads
   * as a password, a key or a token (`looksLikeCredential`), or one that is
   * too long. Such a value is in nothing here, so it goes into no field, and
   * `words` is what its field says: that the value was not filled in, and why.
   */
  keptOut?: { field: PastedField; words: string }[];
}

/** The fields a connection string can name with a text of its own. */
export type PastedField = "host" | "database" | "user";

const SCHEMES: Readonly<Record<string, Engine>> = {
  postgres: "postgres",
  postgresql: "postgres",
  mysql: "mysql",
  mariadb: "mysql",
  sqlserver: "sqlserver",
  mssql: "sqlserver",
  oracle: "oracle",
};

/** What the Server field says when a pasted connection string was not read. */
export const UNREAD_PASTE = "This form does not read that connection string. Type the server's name.";

/**
 * Why a pasted text stays out of a field, or null when it may go in.
 *
 * A field takes by paste only what can be its value. So a connection string in
 * a form this file does not read, a line of a settings file, or anything else
 * that may hold a password never lands in a field, whatever it looks like.
 * Server reads a connection string first (`pastedConnection`); this is asked
 * for what it did not read.
 */
export function pasteProblem(field: FieldName, text: string): string | null {
  if (text.trim() === "") return null;
  const connection = looksLikeConnectionString(text);
  if (connection && field !== "host") return "Paste a connection string into Server.";
  const words = textProblem(field, text);
  if (words === null) return null;
  return connection ? UNREAD_PASTE : words;
}

/** True for a text that looks like a connection string, read or not. It only
 *  chooses the sentence: what keeps a text out of a field is `textProblem`. */
export function looksLikeConnectionString(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ||
    /^(jdbc|oracle):/i.test(trimmed) ||
    /(^|;)\s*(password|pwd|user id|uid|server|data source|initial catalog)\s*=/i.test(trimmed)
  );
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Where the first of `chars` stands in `text`, or -1. */
function firstOf(text: string, chars: string): number {
  for (let at = 0; at < text.length; at += 1) {
    if (chars.includes(text.charAt(at))) return at;
  }
  return -1;
}

const PASSWORD_KEYS: ReadonlySet<string> = new Set(["password", "pwd"]);
/** The settings whose values come from a fixed list. */
const LISTED_KEYS: ReadonlySet<string> = new Set(["encrypt", "trustservercertificate", "sslmode", "ssl-mode"]);

interface Settings {
  /** Settings that hold text, each as it was first given. */
  text: Map<string, string>;
  /** Settings whose values come from a fixed list. */
  listed: Map<string, string>;
  hadPassword: boolean;
}

/**
 * The settings of a text, read in the order they stand. Null when an `@`
 * stands where no password is: the text was cut in the wrong place.
 */
function settingsOf(parts: readonly string[]): Settings | null {
  const settings: Settings = { text: new Map(), listed: new Map(), hadPassword: false };
  let afterPassword = false;
  for (const part of parts) {
    const at = part.indexOf("=");
    const key = at <= 0 ? "" : part.slice(0, at).trim().toLowerCase();
    const value = at <= 0 ? "" : part.slice(at + 1).trim();
    if (PASSWORD_KEYS.has(key)) {
      settings.hadPassword ||= value !== "";
      afterPassword = true;
      continue;
    }
    if (LISTED_KEYS.has(key)) {
      // A value from a fixed list never holds an `@`.
      if (part.includes("@")) return null;
      if (!settings.listed.has(key)) settings.listed.set(key, value);
      continue;
    }
    // From here on a part may be a piece of the password.
    if (afterPassword) continue;
    if (part.includes("@")) return null;
    if (key !== "" && !settings.text.has(key)) settings.text.set(key, value);
  }
  return settings;
}

function first(found: Map<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = found.get(key);
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/** `sslmode` (PostgreSQL) and `ssl-mode` (MySQL) in the form's words. */
function encryptionOfSslMode(value: string | undefined): Encryption | undefined {
  if (!value) return undefined;
  const mode = decoded(value).toLowerCase().replace(/_/g, "-");
  if (mode === "disable" || mode === "disabled") return "off";
  if (mode === "require" || mode === "required") return "require";
  if (mode === "verify-ca" || mode === "verify-full" || mode === "verify-identity") return "verify";
  return undefined;
}

/** SQL Server's `Encrypt` and `TrustServerCertificate` in the form's words. */
function encryptionOfSqlServer(encrypt: string | undefined, trust: string | undefined): Encryption | undefined {
  const word = encrypt?.toLowerCase();
  if (word === undefined) return undefined;
  if (word === "strict") return "strict";
  if (word === "false" || word === "no" || word === "optional") return "off";
  if (word === "true" || word === "yes" || word === "mandatory") {
    const trusted = trust?.toLowerCase();
    return trusted === "true" || trusted === "yes" ? "require" : "verify";
  }
  return undefined;
}

function encryptionOf(engine: Engine, listed: Map<string, string>): Encryption | undefined {
  return engine === "sqlserver"
    ? encryptionOfSqlServer(listed.get("encrypt"), listed.get("trustservercertificate"))
    : encryptionOfSslMode(first(listed, "sslmode", "ssl-mode"));
}

const HOST_NAME = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/;
const IPV6 = /^[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*$/;

/**
 * A host and a port out of `host`, `host:1433`, `[::1]:5432` or SQL Server's
 * `tcp:host,1433` and `host\instance`. Null when the text is neither a host
 * name nor an IPv6 address in brackets, with or without a port.
 */
function hostAndPort(text: string): { host: string; port?: string } | null {
  let rest = text.trim();
  if (/^tcp:/i.test(rest)) rest = rest.slice("tcp:".length);
  // A named instance of SQL Server is found by a port of its own.
  const instance = rest.indexOf("\\");
  if (instance >= 0) rest = rest.slice(0, instance);
  if (rest.startsWith("[")) {
    const end = rest.indexOf("]");
    if (end < 0 || !IPV6.test(rest.slice(1, end))) return null;
    const after = rest.slice(end + 1);
    const port = /^:([0-9]{1,5})$/.exec(after)?.[1];
    if (after !== "" && port === undefined) return null;
    return { host: rest.slice(1, end), ...(port ? { port } : {}) };
  }
  const split = /^([^,:]*)[,:]([0-9]{1,5})$/.exec(rest);
  const host = split ? (split[1] as string) : rest;
  if (!HOST_NAME.test(host)) return null;
  return { host, ...(split ? { port: split[2] as string } : {}) };
}

/** A user name a text may name: one word, with none of the marks that part a
 *  connection string. */
const USER_TEXT = /^[^\s:/?#;=&]+$/;
/** A database's name a text may name. */
const DATABASE_TEXT = /^[^:/@?#;=&]+$/;

/** The value with only the fields that were found. Null when one of them does
 *  not look like its field's value: the text was not read right. */
function found(value: {
  engine: Engine;
  address: { host: string; port?: string } | null;
  database?: string | undefined;
  user?: string | undefined;
  encryption?: Encryption | undefined;
  hadPassword: boolean;
}): PastedConnection | null {
  if (value.address === null) return null;
  if (value.user !== undefined && value.user !== "" && !USER_TEXT.test(value.user)) return null;
  if (value.database !== undefined && value.database !== "" && !DATABASE_TEXT.test(value.database)) return null;
  const named: [PastedField, RegExp, string | undefined][] = [
    ["host", HOST_TEXT, value.address.host],
    ["database", DATABASE_FIELD, value.database],
    ["user", USER_FIELD, value.user],
  ];
  // The text was read right only when each value it names is made of the
  // characters its field holds. A value that is not is a sign that the text
  // was cut at the wrong place, and then nothing of it is used.
  for (const [, alphabet, text] of named) {
    if (text !== undefined && text !== "" && !alphabet.test(text)) return null;
  }
  // A value that was read right and that no act takes is another matter: one
  // that reads as a password, a key or a token, or one that is too long. The
  // rest of the text is used, that value goes into no field, and the field
  // says why (`keptOutProblems`).
  const { engine, hadPassword } = value;
  const out: PastedConnection = { engine, hadPassword };
  const keptOut: { field: PastedField; words: string }[] = [];
  for (const [field, , text] of named) {
    if (text === undefined || text === "") continue;
    const words = textProblem(field, text);
    if (words !== null) {
      // The field stays as it was, so its words first say what was kept out.
      keptOut.push({ field, words: `${KEPT_OUT_LEAD[field]} ${words}` });
      continue;
    }
    out[field] = text;
  }
  if (value.address.port) out.port = value.address.port;
  if (value.encryption !== undefined) out.encryption = value.encryption;
  if (keptOut.length > 0) out.keptOut = keptOut;
  return out;
}

/** What a field first says when a pasted connection string named a value
 *  for it that was kept out: the person does not see that value in the field. */
const KEPT_OUT_LEAD: Readonly<Record<PastedField, string>> = {
  host: "The server named in the pasted text was not filled in.",
  database: "The database named in the pasted text was not filled in.",
  user: "The user name in the pasted text was not filled in.",
};

/**
 * What to say at each field that a pasted connection string named with a
 * value the form kept out: that the value was not filled in, and then the
 * words the field says for such a text typed into it.
 */
export function keptOutProblems(pasted: PastedConnection): Partial<Record<FieldName, string>> {
  return Object.fromEntries((pasted.keptOut ?? []).map((kept) => [kept.field, kept.words]));
}

/** SQL Server's own form: `Server=tcp:db,1433;Database=permits;User ID=reader`. */
function keyValueForm(text: string): PastedConnection | null {
  const settings = settingsOf(text.split(";"));
  if (settings === null) return null;
  const server = first(settings.text, "server", "data source", "address", "addr", "network address");
  if (server === undefined) return null;
  return found({
    engine: "sqlserver",
    address: hostAndPort(server),
    database: first(settings.text, "database", "initial catalog"),
    user: first(settings.text, "user id", "uid", "user"),
    encryption: encryptionOf("sqlserver", settings.listed),
    hadPassword: settings.hadPassword,
  });
}

/** Oracle's thin form: `oracle:thin:@//db:1521/PERMITS`, with or without a
 *  login before the `@`. The login ends at the LAST `@`, and its user name at
 *  its first `/`: what stands between the two is the password. */
function oracleThin(text: string): PastedConnection | null {
  const thin = /^oracle:thin:(.*)@(?:\/\/)?([^@]*)$/i.exec(text);
  if (!thin) return null;
  const login = thin[1] as string;
  const address = thin[2] as string;
  const slash = login.indexOf("/");
  const user = slash < 0 ? login : login.slice(0, slash);
  const stop = firstOf(address, "/?");
  const where = stop < 0 ? address : address.slice(0, stop);
  // `host:1521:SID` names the database after a second colon.
  const sid = /^([^:]+):([0-9]{1,5}):([^:]+)$/.exec(where);
  const service = stop >= 0 && address.charAt(stop) === "/" ? address.slice(stop + 1).split("?")[0] : undefined;
  return found({
    engine: "oracle",
    address: sid ? hostAndPort(`${sid[1] as string}:${sid[2] as string}`) : hostAndPort(where),
    database: sid ? (sid[3] as string) : service,
    user: user === "" ? undefined : user,
    hadPassword: slash >= 0 && slash < login.length - 1,
  });
}

/** A URL: `postgres://reader:pw@db.example:5432/permits?sslmode=verify-full`,
 *  or SQL Server's `sqlserver://db:1433;databaseName=permits;user=reader`. */
function urlForm(text: string): PastedConnection | null {
  const url = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(text);
  if (!url) return null;
  const engine = new Map(Object.entries(SCHEMES)).get((url[1] as string).toLowerCase());
  if (engine === undefined) return null;
  const whole = url[2] as string;
  // SQL Server's address also ends at a `;`, where its settings start.
  const marks = engine === "sqlserver" ? "/?#;" : "/?#";

  // The address part, by the standard rule: up to the first `/`, `?` or `#`.
  // A login stands inside it, before its last `@`. The user name is what
  // stands before the login's first colon. From that colon to the `@` is the
  // password, whatever it holds, and it is read no further.
  const end = firstOf(whole, marks);
  const authority = end < 0 ? whole : whole.slice(0, end);
  let rest = end < 0 ? "" : whole.slice(end);
  // Every `@` of a URL stands in its address part. One that stands after it
  // says that the address part was cut short: a password held a mark. This
  // holds for a password setting's value too, because a password that holds
  // `@` and a mark makes two readings of the text, and only one is right.
  if (rest.includes("@")) return null;
  const at = authority.lastIndexOf("@");
  const login = at < 0 ? null : authority.slice(0, at);
  const colon = login === null ? -1 : login.indexOf(":");
  const loginUser = login === null ? undefined : decoded(colon < 0 ? login : login.slice(0, colon));
  const loginPassword = login !== null && colon >= 0 && colon < login.length - 1;

  let path = "";
  if (rest.startsWith("/")) {
    const stop = firstOf(rest.slice(1), marks.slice(1));
    path = stop < 0 ? rest.slice(1) : rest.slice(1, 1 + stop);
    rest = stop < 0 ? "" : rest.slice(1 + stop);
  }
  // An `@` after the address part: the text was cut in the wrong place.
  if (path.includes("@")) return null;
  if (rest.startsWith("#")) return rest.includes("@") ? null : urlFields(engine, authority, at, path, loginUser, loginPassword, []);
  const parts = rest === "" ? [] : rest.slice(1).split(rest.startsWith(";") ? ";" : "&");
  return urlFields(engine, authority, at, path, loginUser, loginPassword, parts);
}

function urlFields(
  engine: Engine,
  authority: string,
  at: number,
  path: string,
  loginUser: string | undefined,
  loginPassword: boolean,
  parts: readonly string[],
): PastedConnection | null {
  const settings = settingsOf(parts);
  if (settings === null) return null;
  const text = new Map([...settings.text].map(([key, value]) => [key, decoded(value)] as const));
  return found({
    engine,
    address: hostAndPort(at < 0 ? authority : authority.slice(at + 1)),
    // SQL Server's path names an instance, never the database.
    database: (engine === "sqlserver" ? "" : decoded(path)) || first(text, "databasename", "database"),
    user: loginUser || first(text, "user", "username"),
    encryption: encryptionOf(engine, settings.listed),
    hadPassword: loginPassword || settings.hadPassword,
  });
}

/**
 * The fields a pasted text names, when the text is a connection string that
 * was read right. Null for anything else.
 *
 * It reads a URL with one of the schemes above, with or without `jdbc:` in
 * front; Oracle's thin form; and SQL Server's `Server=…;Database=…`.
 */
export function pastedConnection(text: string): PastedConnection | null {
  let rest = text.trim();
  if (rest === "" || /[\r\n]/.test(rest)) return null;
  if (/^jdbc:/i.test(rest)) rest = rest.slice("jdbc:".length);
  if (/^oracle:thin:/i.test(rest)) return oracleThin(rest);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rest)) return urlForm(rest);
  return rest.includes("=") ? keyValueForm(rest) : null;
}

/** The form with the fields a connection string named. A field the text did
 *  not name stays as the person has it. */
export function withPasted(form: DatabaseForm, pasted: PastedConnection): DatabaseForm {
  let next = pasted.engine && pasted.engine !== form.engine ? withEngine(form, pasted.engine) : form;
  next = {
    ...next,
    ...(pasted.host ? { host: pasted.host } : {}),
    ...(pasted.port ? { port: pasted.port } : {}),
    ...(pasted.database ? { database: pasted.database } : {}),
    ...(pasted.user ? { user: pasted.user } : {}),
  };
  if (pasted.encryption && encryptionsFor(next.engine).includes(pasted.encryption)) {
    next = { ...next, encryption: pasted.encryption };
  }
  return next;
}

/**
 * What a connection string that was read does to the form: the new form, or
 * the sentence that says why it was not taken.
 *
 * The engine of a database that exists does not change (`keepEngine`). A
 * string for another engine would bring that engine's port and encryption
 * with it, so it is not taken at all.
 */
export function pastedInto(form: DatabaseForm, pasted: PastedConnection, keepEngine: boolean): DatabaseForm | string {
  if (!keepEngine) return withPasted(form, pasted);
  if (pasted.engine && pasted.engine !== form.engine) {
    return `This connection string is for ${ENGINE_INFO[pasted.engine].label}. This database is ${ENGINE_INFO[form.engine].label}.`;
  }
  const fields = { ...pasted };
  delete fields.engine;
  return withPasted(form, fields);
}
