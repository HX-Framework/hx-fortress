// A Store's process for the module's tests: the host's own main loop, with a
// small stand-in where the Store's engine will be. It answers the module's
// calls from the Store's real file, in the forms the engine answers in, words
// included: a column's sample values, a refusal's sentence, a job's own
// error. A test then shows that none of those words reach an answer.

import { runStoreProcess } from "../../../src/modules/stores/host/store-process-main";

interface Column {
  name: string;
  type: string;
  pk: number;
}

await runStoreProcess(({ storage, settings }) => {
  const { sql } = storage;
  let limit = { rows: 2_000_000, own: false };
  // As the engine does: a call names its Store, and a process that was not
  // told which Store it holds takes none.
  const storeId = settings.store;
  const named = typeof storeId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(storeId);

  const tables = (): string[] =>
    sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
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
              writes: { day: day(), rows: 0, limit: limit.rows, own: limit.own },
            },
          };
        case "history":
          return {
            ok: true,
            value: {
              events: [
                { id: "ev_1", at: "2026-03-02T09:14:00.000Z", kind: "table", by: "user:lena", note: "18 Mill Road was added" },
              ],
              restorableFrom: "2026-02-01T00:00:00.000Z",
            },
          };
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
          return { ok: true, value: { day: day(), rows: 0, limit: limit.rows, own: true } };
        default:
          return { ok: false, status: 400, code: "call_unknown", error: "No such call." };
      }
    },
  };
});
