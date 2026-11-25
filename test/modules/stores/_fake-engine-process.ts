// A Store's process for the module's tests: the host's own main loop, with a
// small stand-in in the place of the Store's engine. It answers the module's
// calls from the Store's real file, in the forms the engine answers in, words
// included: a column's sample values, a refusal's sentence, a job's own
// error. A test then shows that none of those words reach an answer.
//
// A RESTORE, AS THE ENGINE'S PROGRAM DOES ONE. The call readies it and asks for
// this process to be closed, and the Store has gone back only in its next
// process: the history has the restore's own line from then on. The stand-in
// keeps what it readied in the Store's file, and "goes back" as it starts.
// Each of its lines stands for one way a restore can end:
//
//   ev_1  no way back: it has no restore point
//   ev_2  a way back, and the restore is done
//   ev_3  a way back that the program refuses, with a sentence that quotes a row
//   ev_4  a way back that is readied and never done: the next process has no
//         line of a restore
//   ev_5  a way back that is readied, and whose answer holds a row's value
//         where the time goes
//   ev_7  a way back that is readied, and whose call is then refused
//   ev_6  a way back at the first reading of the history in a process, and
//         none after: the Store dropped its snapshot meanwhile

import { runStoreProcess } from "../../../src/modules/stores/host/store-process-main";

interface Column {
  name: string;
  type: string;
  pk: number;
}

/** The line a restore of each way back is done to the moment before. */
const RESTORED_TO = "2026-03-02T09:00:00.000Z";

await runStoreProcess(({ storage, settings, startAnew }) => {
  const { sql } = storage;
  let limit = { rows: 2_000_000, own: false };
  // The stand-in's own record of restores is made by the first restore, so a
  // Store that never had one is not written to as its process starts.
  const keepsRestores = (): boolean =>
    sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = '_fake_restores'").toArray().length > 0;
  // A restore that the process before this one readied is done now.
  if (keepsRestores()) sql.exec("UPDATE _fake_restores SET done = 1 WHERE done = 0");
  /** How often the history was read in this process. */
  let readings = 0;
  // As the engine does: a call names its Store, and a process that was not
  // told which Store it holds takes none.
  const storeId = settings.store;
  const named = typeof storeId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(storeId);

  const tables = (): string[] =>
    sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 6) <> '_fake_' ORDER BY name",
      )
      .toArray()
      .map((row) => row.name);
  const quoted = (name: string): string => `"${name.split('"').join('""')}"`;
  const rowsOf = (table: string): number =>
    Number(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${quoted(table)}`).one().n);
  const day = (): string => new Date().toISOString().slice(0, 10);

  const tableOf = (table: string): unknown => {
    const columns = sql
      .exec<{ name: string; type: string; pk: number }>("SELECT name, type, pk FROM pragma_table_info(?)", table)
      .toArray() as unknown as Column[];
    // The first row's values, as the engine keeps a column's samples: words
    // that must stay on this side.
    const sample = [...sql.exec(`SELECT * FROM ${quoted(table)} LIMIT 1`).raw()].at(0) ?? [];
    return {
      database: "store",
      name: table,
      count: rowsOf(table),
      estimated: false,
      comment: `first row: ${sample.join(" | ")}`,
      key: columns.filter((column) => column.pk > 0).map((column) => column.name),
      kind: "managed",
      version: 1,
      columns: columns.map((column, place) => ({
        name: column.name,
        type: column.type,
        nullable: true,
        quiet: false,
        values: [String(sample.at(place) ?? "")],
      })),
    };
  };

  return {
    call(name: string, args: readonly unknown[]): unknown {
      if (!named) return { ok: false, status: 400, code: "bad_request", error: "A call names its store and who acts." };
      switch (name) {
        case "catalog": {
          const all = tables();
          const offset = Number(args.at(0));
          const most = Number(args.at(1));
          return {
            ok: true,
            value: { tables: all.slice(offset, offset + most).map(tableOf), total: all.length },
          };
        }
        case "stats":
          return {
            ok: true,
            value: {
              bytes: sql.databaseSize,
              tables: tables().length,
              rows: tables().reduce((sum, table) => sum + rowsOf(table), 0),
              files: 0,
              fileBytes: 0,
              busy: false,
              waitsUntil: null,
              writes: { day: day(), rows: 0, limit: limit.rows, shared: false, own: limit.own },
            },
          };
        case "history": {
          readings += 1;
          const done = keepsRestores()
            ? sql
                .exec<{ at: number; line: string }>("SELECT rowid AS at, line FROM _fake_restores WHERE done = 1 ORDER BY rowid DESC")
                .toArray()
            : [];
          const wayBack = (line: number, restorable = true): unknown => ({
            id: `ev_${line}`,
            at: `2026-03-02T09:0${line}:00.000Z`,
            kind: "migration",
            by: "user:lena",
            note: "Migration 0002_owners: Lena Hart",
            ...(restorable ? { restorePoint: `0000000${line}-aaaaaaaaaaaaaaaaaaaaaaaa` } : {}),
          });
          return {
            ok: true,
            value: {
              events: [
                // The newest first: each restore that was done, by the console.
                ...done.map((row) => ({
                  id: `ev_r${row.at}`,
                  at: `2026-03-03T10:0${row.at}:00.000Z`,
                  kind: "restore",
                  by: "console",
                  note: `Restored to ${RESTORED_TO}; 18 Mill Road`,
                  restorePoint: `0000010${row.at}-bbbbbbbbbbbbbbbbbbbbbbbb`,
                })),
                { id: "ev_1", at: "2026-03-02T09:14:00.000Z", kind: "table", by: "user:lena", note: "18 Mill Road was added" },
                wayBack(7),
                wayBack(6, readings === 1),
                wayBack(5),
                wayBack(4),
                wayBack(3),
                wayBack(2),
              ],
              restorableFrom: "2026-02-01T00:00:00.000Z",
            },
          };
        }
        case "restore": {
          const line = args.at(0);
          if (line === "ev_3") {
            return { ok: false, status: 501, code: "restore_unavailable", error: "Lena Hart's store keeps no earlier moments." };
          }
          if (line !== "ev_2" && line !== "ev_4" && line !== "ev_5" && line !== "ev_7") {
            return { ok: false, status: 400, code: "bad_request", error: "The Store cannot be taken back to that line: 18 Mill Road." };
          }
          // Readied in the Store's file, and done by the next process. A
          // restore of ev_4 is readied and then lost.
          if (line !== "ev_4") {
            sql.exec("CREATE TABLE IF NOT EXISTS _fake_restores (line TEXT, done INTEGER)");
            sql.exec("INSERT INTO _fake_restores (line, done) VALUES (?, 0)", line);
          }
          startAnew();
          // Readied, and the call fails all the same: as when the engine
          // fails after the storage was told which snapshot to go back to.
          if (line === "ev_7") {
            return { ok: false, status: 500, code: "internal", error: "Lena Hart's store could not do that." };
          }
          return {
            ok: true,
            value: {
              to: line === "ev_5" ? "18 Mill Road" : RESTORED_TO,
              // What the engine answers beside the time. None of it is read.
              restoredTo: "00000002-aaaaaaaaaaaaaaaaaaaaaaaa",
              note: "18 Mill Road",
            },
          };
        }
        case "review":
          // A Store that holds a table called `endless` never answers this
          // call: a statement of its program that does not end.
          if (tables().includes("endless")) {
            sql.exec("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c");
          }
          return { ok: true, value: { tables: tables().map((table) => ({ table, kind: "flags", flags: null, open: 1, stale: false })) } };
        case "jobSummary":
          // One job is there. Beside its summary stands what the engine keeps
          // of a job and a summary must never hold.
          if (args.at(0) === "job_1") {
            return {
              ok: true,
              value: {
                summary: {
                  id: "job_1",
                  kind: "pull",
                  state: "done",
                  step: null,
                  createdAt: "2026-03-02T09:00:00.000Z",
                  updatedAt: "2026-03-02T09:05:00.000Z",
                  waitsUntil: null,
                  refusal: null,
                  rowsWritten: 2,
                  estimatedRows: null,
                  progress: { done: 1, total: 1 },
                  counts: { tables: 1, rows: 2, read: 2, added: 2, changed: 0, removed: 0, cut: 0 },
                  tables: [{ table: "permits", version: 1, rows: 2, step: "new", counts: { read: 2, added: 2 } }],
                  error: "18 Mill Road could not be read",
                },
                result: { rows: [["BP-2026-0412", "18 Mill Road"]] },
              },
            };
          }
          // Any other: a refusal, with the sentence the engine says to a person.
          return { ok: false, status: 404, code: "not_found", error: `No job ${String(args.at(0))} for 18 Mill Road.` };
        case "setWriteLimit":
          // A word that is not on the module's list, with a row's value in it.
          if (Number(args.at(0)) === 4242) {
            return { ok: false, status: 400, code: "lena_hart_18_mill_road", error: "Lena Hart, 18 Mill Road." };
          }
          limit = { rows: Number(args.at(0)), own: true };
          return { ok: true, value: { day: day(), rows: 0, limit: limit.rows, shared: false, own: true } };
        default:
          return { ok: false, status: 400, code: "call_unknown", error: "No such call." };
      }
    },
  };
});
