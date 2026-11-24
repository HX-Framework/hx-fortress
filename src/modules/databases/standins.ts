// What the daemon hands the module for two things: a helper program, and a
// record that can hold a query's text.
//
// A HELPER PROGRAM IS THE MODULE HOST'S NOW. The context of every ask and act
// has `programs`, and the host runs DB IO for this module there: it looks the
// reach and the secrets' names up, writes the address and the password into
// the job, and records the run. This file hands that port on, and says the
// host's words for a failed run in this module's own.
//
// THE RECORD OF A QUERY CANNOT BE WRITTEN YET, so no query runs. The module
// host has no record that can hold a statement's text. That part of this file
// is still a stand-in, and it takes no recorder.
//
// So on this build a signed-in operator can add a connection and test it. On
// a host with no DB IO installed, the test ends with `program_not_installed`,
// and no secret is read for it.
//
// The two lists a person adds to (the hosts this HX Fortress may reach, and
// the names of secrets) are not here at all. They belong to the context of a
// person's act, which the host builds.

import type { ModuleContextV2, ProgramFailureCode } from "../../host/module-contract";
import type { DatabasesHostPorts, ProgramsPort, QueryRecordsPort } from "./host-ports";
import type { FailureCode } from "./manifest";

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

/**
 * This module's word for the host's word about a run that did not go well.
 *
 * The host has five words that this module's answers do not list. Each is said
 * as the nearest of the module's own, so that an answer to the control plane
 * and a line on the Databases page keep the words they have. The host's own
 * word is in the audit trail, in the record of the run.
 *
 *   reach_unresolved, reach_address_refused   the server could not be reached:
 *       its name was not found, or leads to an address that HX Fortress sends
 *       no program to
 *   job_invalid, audit_unavailable            the job was not taken: the host
 *       refused it as it was handed over, or could not record the run
 *   module_not_running                        the module was being stopped
 */
export function ownWordFor(code: ProgramFailureCode): FailureCode {
  switch (code) {
    case "reach_unresolved":
    case "reach_address_refused":
      return "unreachable";
    case "job_invalid":
    case "audit_unavailable":
      return "not_ready";
    case "module_not_running":
      return "interrupted";
    default:
      return code;
  }
}

/** The host's port for a helper program, in this module's words. */
function programsOf(ctx: ModuleContextV2): ProgramsPort {
  return {
    async run(program, run) {
      const end = await ctx.programs.run(program, run);
      return end.ok ? end : { ok: false, code: ownWordFor(end.code) };
    },
  };
}

export function createStandInPorts(): DatabasesHostPorts {
  return {
    forContext: (ctx) => ({ programs: programsOf(ctx), queryRecords: NO_QUERY_RECORDS }),
  };
}
