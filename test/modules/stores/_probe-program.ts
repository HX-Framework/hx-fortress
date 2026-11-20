// A small program in the engine's place, for tests. It runs a statement
// through the Store's `sql`, so a test can see what the host does with one,
// from the other side of the process boundary.

import type { StoreProgramFactory } from "../../../src/modules/stores/host/store-process-main";

const ENDLESS =
  "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c";

export const probeProgram: StoreProgramFactory = async (context) => {
  const { storage } = context;
  // A Store that takes a while to open, when a test asks for one.
  const openDelay = Number(context.settings.PROBE_OPEN_DELAY_MS ?? 0);
  if (openDelay > 0) await Bun.sleep(openDelay);
  let woken = 0;
  const note = (body: unknown): void => {
    storage.sql.exec("INSERT INTO notes (body) VALUES (?)", String(body));
  };
  return {
    async call(name: string, args: readonly unknown[]): Promise<unknown> {
      switch (name) {
        case "exec": {
          const [sql, ...bindings] = args as [string, ...unknown[]];
          const cursor = storage.sql.exec(sql, ...bindings);
          return {
            columns: cursor.columnNames,
            rows: [...cursor.raw()],
            written: cursor.rowsWritten,
          };
        }
        // A write, and then a failure: what was written before it is kept.
        case "write_then_fail": {
          note(args.at(0));
          throw Object.assign(new Error("the table notes could not be changed"), {
            code: "probe_failed",
          });
        }
        // A write, and then a statement that never ends, with no wait between.
        case "write_then_spin": {
          note(args.at(0));
          storage.sql.exec(ENDLESS);
          return null;
        }
        // A write in a transaction of its own, and then a statement that never
        // ends: how the engine counts a job's tries before the job's work.
        case "transaction_then_spin": {
          storage.transactionSync(() => note(args.at(0)));
          storage.sql.exec(ENDLESS);
          return null;
        }
        // A write, a wait, a second write, and then a statement that never ends.
        case "write_wait_write_spin": {
          note(args.at(0));
          await Bun.sleep(30);
          note(args.at(1));
          storage.sql.exec(ENDLESS);
          return null;
        }
        // Empty the Store, write again, and then a statement that never ends.
        case "empty_write_spin": {
          await storage.deleteAll();
          storage.sql.exec("CREATE TABLE fresh (a)");
          storage.sql.exec("INSERT INTO fresh VALUES (1)");
          storage.sql.exec(ENDLESS);
          return null;
        }
        case "in_transaction": {
          return storage.transactionSync(() => {
            note(args.at(0));
            if (args.at(1) === "fail") throw new Error("undone");
            return "kept";
          });
        }
        case "set_alarm":
          storage.alarm = args.at(0) as number | null;
          return null;
        case "alarm":
          return storage.alarm;
        case "woken":
          return woken;
        case "pid":
          return process.pid;
        case "environment":
          return {
            names: Object.keys(process.env).sort(),
            umask: process.umask(),
            cwd: process.cwd(),
            // A folder's path, and no row's value.
            temporary: process.env.SQLITE_TMPDIR ?? null,
          };
        case "settings":
          return context.settings;
        case "unreadable":
          return () => 1;
        case "abort":
          context.abort("a test asked");
          return null;
        case "size":
          return storage.sql.databaseSize;
        default:
          throw Object.assign(new Error("no such call"), { code: "call_unknown" });
      }
    },
    async wake(): Promise<void> {
      woken += 1;
      const next = storage.sql.exec("SELECT body FROM notes WHERE body LIKE 'wake:%' LIMIT 1").toArray();
      const body = next.at(0)?.body;
      if (body === "wake:fail") throw new Error("the wake failed");
      if (body === "wake:spin") {
        // A job's work: a count kept in a transaction of its own, a wait for
        // something, and then work that never returns.
        storage.transactionSync(() => note("the wake began"));
        await Bun.sleep(40);
        storage.sql.exec(ENDLESS);
      }
      if (typeof body === "string" && body.startsWith("wake:again:")) {
        storage.alarm = Number(body.slice("wake:again:".length));
      }
    },
  };
};
