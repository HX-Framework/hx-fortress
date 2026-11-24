// What the Databases module asks of the Stores module of this HX Fortress, for
// a write into a database.
//
// A write is a store job. The Store holds what is to be written: the saved
// previews of a write, or its own record of the write that an undo takes
// back. The Databases module holds the write login. So for one write the two
// modules work together, inside this process:
//
//   writeParts   what the write holds, read from the Store. It opens nothing.
//   openWrite    opens the store job for exactly that, and answers the job the
//                program works for.
//   endWrite     fails an open store job at once, when no program was started
//                for it.
//   jobState     how a store job stands, and the Store's one word for a job
//                that failed.
//
// THE STORES MODULE OWNS THESE CALLS. Its own file of types will name them
// (`src/modules/stores/for-modules.ts`). Until that file is there, this one
// holds them in the form the two modules agreed, and the Databases module is
// handed an object of this form or none. With none, a write is refused with
// `stores_off`.
//
// Types and lists of words only. No code of the Stores module comes with it.

import type { CallingContext, ConnectionRef, StoreJobTarget } from "./for-modules";

/** A table of a database, as the database spells its schema and its name. */
export interface WriteTarget {
  schema: string;
  name: string;
}

/** One preview a write names: the Store's table that holds it, and that
 *  table's version. */
export interface PreviewHandle {
  table: string;
  version: number;
}

/**
 * What is to be written.
 *
 * `writer` is `program:<id>@<version>` or `user:<id>`, as the control plane
 * names who writes. `by` is who the Store's history names: the person who
 * approved it, as `user:<id>`. For an undo, `write` is the store job of the
 * write it takes back.
 */
export type WriteRequest =
  | {
      kind: "push";
      connection: ConnectionRef;
      previews: PreviewHandle[];
      rehearse: boolean;
      writer: string;
      by: string;
    }
  | { kind: "push_undo"; connection: ConnectionRef; write: string; writer: string; by: string };

/**
 * One part of a write: a preview and the table of the database it is for.
 * `checksum` is the Store's own, over what the saved preview holds. An undo's
 * parts have none: they come from the write's own record.
 */
export interface WritePart {
  table: string;
  version: number;
  checksum?: string;
  target: WriteTarget;
}

export type StoreAnswer<T> = ({ ok: true } & T) | { ok: false; code: string };

/** How a store job stands. */
export const STORE_JOB_STATES = ["queued", "running", "done", "failed"] as const;
export type StoreJobState = (typeof STORE_JOB_STATES)[number];

/**
 * The Store's word for a store job that failed, or that waits for the day's
 * write limit. A closed list: the Stores module hands on no other word, and
 * the Databases module answers no other.
 */
export const STORE_JOB_WORDS = [
  // A write's previews, checked in the store job's first step.
  "preview_replaced",
  "preview_stale",
  "preview_written",
  "preview_twice",
  // The write an undo takes back.
  "write_not_found",
  "write_rehearsed",
  "write_elsewhere",
  "write_undone",
  // How the job ended.
  "push_timed_out",
  "push_gave_way",
  "push_failed",
  "push_link",
  "stopped",
  "write_limit_reached",
  "chunk_failed",
  "failed",
] as const;
export type StoreJobWord = (typeof STORE_JOB_WORDS)[number];

/**
 * The words `writeParts` and `openWrite` refuse with, which the Databases
 * module passes on as they are. Any other word is answered as
 * `store_refused`.
 */
export const STORE_CALL_WORDS = [
  "store_unknown",
  "preview_replaced",
  "write_not_found",
  "write_rehearsed",
  "write_undone",
  "write_elsewhere",
  "write_not_ended",
  "write_limit_reached",
  "busy",
  "stores_off",
] as const;
export type StoreCallWord = (typeof STORE_CALL_WORDS)[number];

export interface StoresForWrites {
  /** Read what a write holds. Opens nothing, so a refusal that follows leaves
   *  the Store as it was. */
  writeParts(caller: CallingContext, storeId: string, request: WriteRequest): Promise<StoreAnswer<{ parts: WritePart[] }>>;
  /** Open the store job for a write, and answer its parts once more: what the
   *  opened job holds. */
  openWrite(
    caller: CallingContext,
    storeId: string,
    request: WriteRequest,
  ): Promise<StoreAnswer<{ job: StoreJobTarget; parts: WritePart[] }>>;
  /** Fail an open store job at once, so that the Store takes its next job. */
  endWrite(caller: CallingContext, storeId: string, jobId: string): Promise<void>;
  /** How a store job stands, or null when the Store or the job is not there.
   *  `word` is there for a job that failed, and for one that waits for the
   *  day's write limit. */
  jobState(caller: CallingContext, storeId: string, jobId: string): Promise<{ state: StoreJobState; word?: string } | null>;
}
