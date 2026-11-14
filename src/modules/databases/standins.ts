// What the daemon hands the module in place of two things the module host does
// not have yet: a helper program it starts for a module, and a record that can
// hold a query's text.
//
// NEITHER CAN BE MADE TO WORK FROM HERE. This file takes no launcher and no
// recorder. `programs.run` answers `program_not_installed` for every run, and
// the record of a query cannot be written, so no query runs. Starting a program
// is the host's to do, with its limits and its own audit record, and this
// module does not do it in the host's place.
//
// The two lists a person adds to (the hosts this HX Fortress may reach, and
// the names of secrets) are not here at all. They belong to the context of a
// person's act, which the host does not build yet, so on this build nothing can
// add a connection.
//
// When the host hands a module the real ports on its context, this file goes.

import type { DatabasesHostPorts, QueryRecordsPort } from "./host-ports";

/** The record of a query cannot be written on this host. */
export class QueryRecordUnavailable extends Error {
  constructor() {
    super("this HX Fortress cannot record a query's text yet, so it runs none");
    this.name = "QueryRecordUnavailable";
  }
}

const NO_QUERY_RECORDS: QueryRecordsPort = {
  open: () => Promise.reject(new QueryRecordUnavailable()),
  refused: () => Promise.reject(new QueryRecordUnavailable()),
};

export function createStandInPorts(): DatabasesHostPorts {
  return {
    forContext: () => ({
      programs: { run: async () => ({ ok: false, code: "program_not_installed" }) },
      queryRecords: NO_QUERY_RECORDS,
    }),
  };
}
