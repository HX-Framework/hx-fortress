// The closed set of value kinds an ask may take and a reply may hold.
//
// The control plane can ask a module a question, and the answer travels back
// to it. The promise this file carries is about that answer: it is made only of
// counts, flags, states, times, names and ids, in lists and records. There is no
// free-text kind and no bytes kind, so an ask has no field a row, a transcript
// or a file could travel in.
//
// Three properties make that a fact about the code rather than a convention:
//
//   1. CLOSED. `Shape` is a union with no escape hatch. A manifest that declares
//      anything else does not type-check, and `shapeDefect` refuses it at
//      registration for the manifests TypeScript did not see.
//   2. REBUILT, NOT INSPECTED. `conform` does not approve the value a module
//      returned; it builds a new one, field by field, out of primitives it has
//      already checked. An object with a getter, a `toJSON`, a prototype or an
//      extra key therefore cannot ride along: nothing of the original object is
//      what gets serialized.
//   3. BOUNDED. Every list has a ceiling, every string a length, and the whole
//      value a node budget, so a reply's size is decided by its declared shape
//      and not by the module that filled it.
//
// What this does NOT prove is stated in SECURITY.md: a `name` is 128 characters
// from a fixed alphabet, so a module that put a row's value into a `name` would
// pass. The closed kinds bound how much can leave and in what form; what each
// field MEANS is the ask list in the module's manifest, which is compiled into
// the binary and is what a reviewer reads.

/**
 * Whether `key` is an own property of `object`.
 *
 * Spelled this way, and not as `Object.hasOwn`, because this file is also
 * compiled for the console's web app: the audit rules that app bundles take the
 * test for a name from here, and that build's language level is older than the
 * daemon's. The pull request check builds the web app, so a newer built-in used
 * anywhere in this file fails there.
 */
function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** Longest `name` a value may carry. */
export const NAME_MAX_CHARS = 128;
/** Longest `id` a value may carry. */
export const ID_MAX_CHARS = 128;
/** Most items any list may hold, whatever its shape declares. */
export const LIST_MAX_ITEMS = 500;
/** Most states one `state` shape may list. */
export const STATE_MAX_VALUES = 64;
/** Most fields one record may declare. */
export const RECORD_MAX_FIELDS = 64;
/** Deepest nesting a shape may declare. */
export const SHAPE_MAX_DEPTH = 6;
/** Most values (of any kind, at any depth) one conformed value may hold. A list
 *  of 500 records of 500 names is 250,000 nodes and megabytes of names; the
 *  per-list ceiling alone does not stop that, this does. */
export const VALUE_MAX_NODES = 20_000;

/** Longest string a value of any kind may hold: a name, an id, a state or a time. */
const STRING_MAX_CHARS = Math.max(NAME_MAX_CHARS, ID_MAX_CHARS, 64);
/** Longest field name a record may declare. */
const FIELD_MAX_CHARS = 64;

/** The characters a `name` may hold: letters, digits, space and `_ . : / @ -`. */
export const NAME_PATTERN = /^[A-Za-z0-9 _.:/@-]*$/;
/** Whether a value is a `name` as it stands: a string of at most 128 of those
 *  characters. The one test for it, used by `conform` and by anything else that
 *  must decide whether a string may be sent as a name. */
export function isName(value: unknown): value is string {
  return typeof value === "string" && value.length <= NAME_MAX_CHARS && NAME_PATTERN.test(value);
}

/** The characters an `id` may hold. No space and no slash: an id is one token. */
export const ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
/** A record's field name, and a state's value. */
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const STATE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
/** `Date#toISOString()` and nothing else: UTC, to the second or the millisecond.
 *  Every part has a fixed width, so there is one way to match any input. */
// eslint-disable-next-line security/detect-unsafe-regex
const TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z$/;

export type Shape =
  /** A whole number, zero or more. `max` bounds it where the ask needs a bound. */
  | { readonly kind: "count"; readonly max?: number }
  | { readonly kind: "flag" }
  /** One of a listed set of words. */
  | { readonly kind: "state"; readonly of: readonly string[] }
  /** An instant, as `Date#toISOString()` writes it. */
  | { readonly kind: "time" }
  /** At most 128 characters of `[A-Za-z0-9 _.:/@-]`. */
  | { readonly kind: "name" }
  /** One token of `[A-Za-z0-9_.:-]`, 1 to 128 characters. */
  | { readonly kind: "id" }
  /** Zero or more values of one shape. `max` defaults to, and may not pass, 500. */
  | { readonly kind: "list"; readonly of: Shape; readonly max?: number }
  /** Named values. A field listed in `optional` may be left out; every other
   *  field must be there, and a key the record does not declare is refused. */
  | {
      readonly kind: "record";
      readonly fields: Readonly<Record<string, Shape>>;
      readonly optional?: readonly string[];
    };

/** Builders, so a manifest reads as a description and not as object literals. */
export const S = {
  count: (max?: number): Shape => (max === undefined ? { kind: "count" } : { kind: "count", max }),
  flag: { kind: "flag" } as Shape,
  state: (...of: string[]): Shape => ({ kind: "state", of }),
  time: { kind: "time" } as Shape,
  name: { kind: "name" } as Shape,
  id: { kind: "id" } as Shape,
  list: (of: Shape, max: number = LIST_MAX_ITEMS): Shape => ({ kind: "list", of, max }),
  record: (fields: Record<string, Shape>, optional: readonly string[] = []): Shape =>
    optional.length === 0 ? { kind: "record", fields } : { kind: "record", fields, optional },
  /** A record with no fields: the args of an ask that takes none. */
  none: { kind: "record", fields: {} } as Shape,
} as const;

/** Why a value does not have its shape. `path` is built only from field names
 *  the SHAPE declares and from list positions; `rule` is one of a fixed set of
 *  words. Neither ever holds a piece of the value, because this is what gets
 *  written to the audit trail when a reply is refused, and a refused reply is
 *  exactly the value that must not be written anywhere. */
export interface ShapeIssue {
  path: string;
  rule: ShapeRule;
}

export type ShapeRule =
  | "not_a_count"
  | "count_too_large"
  | "not_a_flag"
  | "not_a_state"
  | "not_a_time"
  | "not_a_name"
  | "name_too_long"
  | "not_an_id"
  | "id_too_long"
  | "not_a_list"
  | "list_too_long"
  | "not_a_record"
  | "field_missing"
  | "field_unknown"
  | "value_too_large"
  | "unreadable";

export type Conformed = { ok: true; value: unknown } | { ok: false; issue: ShapeIssue };

/**
 * Build a new value that has `shape`, out of `value`.
 *
 * On success the result shares nothing with the input: every object and array
 * in it was created here, and every leaf is a primitive that passed its check.
 * On failure the issue names where and which rule, never what.
 *
 * It never throws. A value that throws while it is being read (a getter, a
 * proxy) is refused as `unreadable`, and what it threw is dropped here: its
 * message is the value's own text, and this function's callers must not log it.
 */
export function conform(shape: Shape, value: unknown): Conformed {
  const budget = { nodes: 0 };
  try {
    return { ok: true, value: build(shape, value, "", budget) };
  } catch (thrown) {
    if (thrown instanceof ShapeRefusal) return { ok: false, issue: thrown.issue };
    return { ok: false, issue: { path: "", rule: "unreadable" } };
  }
}

/**
 * Whether a value is small enough to be a value of SOME shape.
 *
 * `conform` holds a value to one shape. This needs no shape: it holds a value
 * to the limits every shape shares, which are the nesting, the number of
 * values, the length of a string, and the number and length of field names. It
 * stops at the first limit that is passed.
 *
 * It is the check to run on a value from outside before doing any work on it
 * that grows with its size. A value that fails it would fail `conform` against
 * every shape, so refusing it early changes no answer.
 */
export function withinShapeLimits(value: unknown): boolean {
  let nodes = 0;
  const walk = (current: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > VALUE_MAX_NODES) return false;
    if (typeof current === "string") return current.length <= STRING_MAX_CHARS;
    if (typeof current !== "object" || current === null) return true;
    if (depth > SHAPE_MAX_DEPTH) return false;
    if (Array.isArray(current)) {
      if (current.length > LIST_MAX_ITEMS) return false;
      for (const item of current as unknown[]) {
        if (!walk(item, depth + 1)) return false;
      }
      return true;
    }
    const names = Object.keys(current);
    if (names.length > RECORD_MAX_FIELDS) return false;
    for (const name of names) {
      if (name.length > FIELD_MAX_CHARS) return false;
      // An own key of the object, read back from the same object.
      // eslint-disable-next-line security/detect-object-injection
      if (!walk((current as Record<string, unknown>)[name], depth + 1)) return false;
    }
    return true;
  };
  return walk(value, 0);
}

class ShapeRefusal extends Error {
  constructor(readonly issue: ShapeIssue) {
    super(`${issue.rule} at ${issue.path || "(root)"}`);
  }
}

function refuse(path: string, rule: ShapeRule): never {
  throw new ShapeRefusal({ path, rule });
}

function build(shape: Shape, value: unknown, path: string, budget: { nodes: number }): unknown {
  budget.nodes += 1;
  if (budget.nodes > VALUE_MAX_NODES) refuse(path, "value_too_large");
  switch (shape.kind) {
    case "count": {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        refuse(path, "not_a_count");
      }
      if (shape.max !== undefined && value > shape.max) refuse(path, "count_too_large");
      return value;
    }
    case "flag": {
      if (typeof value !== "boolean") refuse(path, "not_a_flag");
      return value;
    }
    case "state": {
      if (typeof value !== "string" || !shape.of.includes(value)) refuse(path, "not_a_state");
      return value;
    }
    case "time": {
      if (typeof value !== "string" || !isIsoInstant(value)) refuse(path, "not_a_time");
      return value;
    }
    case "name": {
      if (typeof value !== "string") refuse(path, "not_a_name");
      if (value.length > NAME_MAX_CHARS) refuse(path, "name_too_long");
      if (!NAME_PATTERN.test(value)) refuse(path, "not_a_name");
      return value;
    }
    case "id": {
      if (typeof value !== "string" || value.length === 0) refuse(path, "not_an_id");
      if (value.length > ID_MAX_CHARS) refuse(path, "id_too_long");
      if (!ID_PATTERN.test(value)) refuse(path, "not_an_id");
      return value;
    }
    case "list": {
      if (!Array.isArray(value)) refuse(path, "not_a_list");
      const max = Math.min(shape.max ?? LIST_MAX_ITEMS, LIST_MAX_ITEMS);
      // Read once. A list that answers a different length each time it is asked
      // is held to the first answer, which is the one that was checked.
      const length = (value as unknown[]).length;
      if (!Number.isSafeInteger(length) || length < 0) refuse(path, "not_a_list");
      if (length > max) refuse(path, "list_too_long");
      const out: unknown[] = [];
      // Indexed, never iterated: an array's iterator is a method a caller can
      // replace, and a hole reads as `undefined` here, which every kind refuses.
      for (let i = 0; i < length; i += 1) {
        // A position in an array, counted here.
        // eslint-disable-next-line security/detect-object-injection
        out.push(build(shape.of, (value as unknown[])[i], `${path}[${i}]`, budget));
      }
      return out;
    }
    case "record": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        refuse(path, "not_a_record");
      }
      const source = value as Record<string, unknown>;
      // Own keys only, and every one of them must be declared. The key itself is
      // not put in the issue: it is a string the other side chose.
      for (const key of Object.keys(source)) {
        if (!hasOwn(shape.fields, key)) refuse(path, "field_unknown");
      }
      const optional = shape.optional ?? [];
      const out: Record<string, unknown> = {};
      for (const [field, fieldShape] of Object.entries(shape.fields)) {
        const at = path ? `${path}.${field}` : field;
        // Read ONCE. A getter may answer differently each time it is asked, and
        // the value that is checked must be the value that is kept.
        // `field` is a name the SHAPE declares, and only an own property is read.
        // eslint-disable-next-line security/detect-object-injection
        const held: unknown = hasOwn(source, field) ? source[field] : undefined;
        if (held === undefined) {
          if (optional.includes(field)) continue;
          refuse(at, "field_missing");
        }
        // Defined, not assigned: an own property whatever the field is called,
        // so no declared name can reach the new object's prototype.
        Object.defineProperty(out, field, {
          value: build(fieldShape, held, at, budget),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
  }
}

/** True for an instant written exactly as `Date#toISOString()` writes one, and
 *  naming a real date. `2027-02-30T00:00:00Z` matches the pattern and is not a
 *  day, so the parsed value is compared back against its own fields. */
export function isIsoInstant(text: string): boolean {
  const match = TIME_PATTERN.exec(text);
  if (!match) return false;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return false;
  const date = new Date(ms);
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3]) &&
    date.getUTCHours() === Number(match[4]) &&
    date.getUTCMinutes() === Number(match[5]) &&
    date.getUTCSeconds() === Number(match[6])
  );
}

/**
 * What is wrong with a shape as DECLARED, or null when nothing is.
 *
 * TypeScript checks the manifests in this repository. This checks the same
 * thing at registration, for a manifest that reached the host as a plain value:
 * a kind outside the set, a bound outside its ceiling, a field or state name
 * that is not one word.
 */
export function shapeDefect(shape: unknown, depth = 0): string | null {
  if (depth > SHAPE_MAX_DEPTH) return `nested deeper than ${SHAPE_MAX_DEPTH} levels`;
  if (typeof shape !== "object" || shape === null || Array.isArray(shape)) return "not a shape";
  const s = shape as Record<string, unknown>;
  switch (s.kind) {
    case "count":
      if (s.max !== undefined && (!Number.isSafeInteger(s.max) || (s.max as number) < 0)) {
        return "a count's max must be a whole number, zero or more";
      }
      return null;
    case "flag":
    case "time":
    case "name":
    case "id":
      return null;
    case "state": {
      if (!Array.isArray(s.of) || s.of.length === 0) return "a state must list its values";
      if (s.of.length > STATE_MAX_VALUES) return `a state may list at most ${STATE_MAX_VALUES} values`;
      for (const value of s.of) {
        if (typeof value !== "string" || !STATE_PATTERN.test(value)) {
          return "a state's values must be single words";
        }
      }
      if (new Set(s.of).size !== s.of.length) return "a state lists a value twice";
      return null;
    }
    case "list": {
      if (
        s.max !== undefined &&
        (!Number.isSafeInteger(s.max) || (s.max as number) < 0 || (s.max as number) > LIST_MAX_ITEMS)
      ) {
        return `a list's max must be between 0 and ${LIST_MAX_ITEMS}`;
      }
      return shapeDefect(s.of, depth + 1);
    }
    case "record": {
      if (typeof s.fields !== "object" || s.fields === null || Array.isArray(s.fields)) {
        return "a record must declare its fields";
      }
      const fields = s.fields as Record<string, unknown>;
      const names = Object.keys(fields);
      if (names.length > RECORD_MAX_FIELDS) return `a record may declare at most ${RECORD_MAX_FIELDS} fields`;
      for (const name of names) {
        if (!FIELD_PATTERN.test(name)) return "a record's field names must be single words";
        // One of the object's own keys, from Object.keys above.
        // eslint-disable-next-line security/detect-object-injection
        const defect = shapeDefect(fields[name], depth + 1);
        if (defect) return defect;
      }
      if (s.optional !== undefined) {
        if (!Array.isArray(s.optional)) return "a record's optional list must be a list";
        for (const name of s.optional) {
          if (typeof name !== "string" || !hasOwn(fields, name)) {
            return "a record's optional list names a field it does not declare";
          }
        }
      }
      return null;
    }
    default:
      return "a kind outside the closed set";
  }
}

/** A shape in one line of plain words, for `hx-fortress modules list` and for
 *  the console page that lists what the control plane may ask. */
export function describeShape(shape: Shape): string {
  switch (shape.kind) {
    case "count":
      return shape.max === undefined ? "count" : `count up to ${shape.max}`;
    case "flag":
      return "flag";
    case "state":
      return `one of ${shape.of.join(" | ")}`;
    case "time":
      return "time";
    case "name":
      return "name";
    case "id":
      return "id";
    case "list":
      return `list of up to ${Math.min(shape.max ?? LIST_MAX_ITEMS, LIST_MAX_ITEMS)} (${describeShape(shape.of)})`;
    case "record": {
      const optional = shape.optional ?? [];
      const parts = Object.entries(shape.fields).map(
        ([name, field]) => `${name}${optional.includes(name) ? "?" : ""}: ${describeShape(field)}`,
      );
      return parts.length === 0 ? "nothing" : `{ ${parts.join(", ")} }`;
    }
  }
}

/** The words for one value kind that is not a list or a record. */
function leafWords(shape: Shape): string | null {
  return shape.kind === "list" || shape.kind === "record" ? null : describeShape(shape);
}

/**
 * A shape as lines, one field to a line, nested fields indented under theirs.
 * What an operator reads to see everything an ask takes or an answer can hold.
 */
export function describeShapeLines(shape: Shape): string[] {
  if (shape.kind === "record") {
    const names = Object.keys(shape.fields);
    if (names.length === 0) return ["nothing"];
    const optional = shape.optional ?? [];
    return names.flatMap((name) => {
      // One of the record's own declared fields.
      // eslint-disable-next-line security/detect-object-injection
      const field = shape.fields[name] as Shape;
      const label = optional.includes(name) ? `${name} (optional)` : name;
      const lines = describeShapeLines(field);
      // A record's fields go on the lines under its name. Anything else starts
      // beside the name.
      if (field.kind === "record" && lines[0] !== "nothing") {
        return [`${label}:`, ...lines.map((line) => `  ${line}`)];
      }
      const [first, ...rest] = lines;
      return [`${label}: ${first}`, ...rest.map((line) => `  ${line}`)];
    });
  }
  if (shape.kind === "list") {
    const max = Math.min(shape.max ?? LIST_MAX_ITEMS, LIST_MAX_ITEMS);
    const leaf = leafWords(shape.of);
    if (leaf !== null) return [`list of up to ${max} (${leaf})`];
    return [`list of up to ${max}, each:`, ...describeShapeLines(shape.of)];
  }
  return [describeShape(shape)];
}

/** What each word in a described shape means, for the foot of a listing. */
export const SHAPE_LEGEND: readonly string[] = [
  "count: a whole number, zero or more. flag: yes or no. time: an instant, in UTC.",
  `name: at most ${NAME_MAX_CHARS} characters of letters, digits, space and _ . : / @ -`,
  "id: one token of letters, digits and _ . : -",
  "No ask takes free text or bytes, and no answer can hold either.",
];
