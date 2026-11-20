// Splitting SQL into statements the way SQLite does (`sqlite3_complete`): `;` ends a statement
// except inside a string, a quoted name, a comment or a trigger's body, where only END closes it.
//
// Its own file, with no platform types, so code outside a Durable Object reads statements exactly as
// the store runs them: the api's Modern Apps deployer classifies a migration's statements
// before the store runs them (`store-object/split`).

/** Statements end at `;`, except inside strings, quoted names, comments and a trigger's body
 *  (SQLite's own `sqlite3_complete` rules). Statements holding only comments are dropped. */
export function splitStatements(text: string): string[] {
  const out: string[] = [];
  const n = text.length;
  let start = 0;
  let i = 0;
  let content = false;
  type State = "start" | "normal" | "create" | "trigger" | "semi" | "end";
  let state: State = "start";
  const finish = (end: number) => {
    const stmt = text.slice(start, end).trim();
    if (content && stmt) out.push(stmt);
    start = end + 1;
    content = false;
    state = "start";
  };
  const other = () => {
    content = true;
    if (state === "start" || state === "create") state = "normal";
    else if (state === "semi" || state === "end") state = "trigger";
  };
  while (i < n) {
    const c = text[i]!;
    if (c === "-" && text[i + 1] === "-") {
      const j = text.indexOf("\n", i);
      i = j < 0 ? n : j + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const j = text.indexOf("*/", i + 2);
      i = j < 0 ? n : j + 2;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f") {
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === c) {
          if (text[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      i = j + 1;
      other();
      continue;
    }
    if (c === "[") {
      const j = text.indexOf("]", i);
      i = j < 0 ? n : j + 1;
      other();
      continue;
    }
    if (c === ";") {
      if (state === "trigger" || state === "semi") {
        state = "semi";
        i++;
        continue;
      }
      finish(i);
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j]!)) j++;
      const word = text.slice(i, j).toUpperCase();
      i = j;
      content = true;
      if (state === "start") state = word === "CREATE" ? "create" : "normal";
      else if (state === "create") state = word === "TEMP" || word === "TEMPORARY" ? "create" : word === "TRIGGER" ? "trigger" : "normal";
      else if (state === "semi") state = word === "END" ? "end" : "trigger";
      else if (state === "end") state = "trigger";
      continue;
    }
    i++;
    other();
  }
  const rest = text.slice(start).trim();
  if (content && rest) out.push(rest);
  return out;
}

/** The parts of a migration: drizzle-kit's `--> statement-breakpoint` chunks, each split again. */
export function migrationStatements(text: string): string[] {
  return text.split("--> statement-breakpoint").flatMap((chunk) => splitStatements(chunk));
}
