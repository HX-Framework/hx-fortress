// What the tests of `hx-fortress install` share: a place that stands in for a
// cloud account or a machine with Docker, and a run of the install on it.
//
// The stand-in makes nothing. It reports each row of the plan it is handed,
// it can wait at the DNS row until a test lets it go, it can fail at a row it
// is told, and it keeps every hand-over for the test to read. Nothing here
// opens a network connection or writes a file.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fortressPaths } from "../src/host/paths";
import {
  MakeError,
  type HandOver,
  type Made,
  type MakeProgress,
  type Place,
  type SignedIn,
} from "../src/install/place";
import type { PlaceId } from "../src/setup/list";
import { SetupRun, type SetupRunDeps } from "../src/setup/run";
import type { CheckLine } from "../src/setup/view";

/** Where the DNS record of a made HX Fortress points, in these tests. */
export const DNS_TARGET = "hx-fortress.northstar-made.example";

export interface Failure {
  /** The row at which `make` stops. */
  at: string;
  /** `make`: a MakeError, whose words are shown. `plain`: any other error. */
  kind: "make" | "plain";
  text: string;
  /** The row the MakeError names. Left out: the row it stops at. */
  names?: string;
}

/** A place that stands in for a real one. Every field a test may change is
 *  public, and every look and every make is counted. */
export class StandInPlace implements Place {
  readonly id: PlaceId;
  readonly needsSignIn: boolean;
  /** Who this computer is signed in as there. Null: signed out. */
  who: SignedIn | null;
  /** What `refusals` answers. */
  refused: CheckLine[] = [];
  /** Each look, counted. */
  readonly asked = { signedIn: 0, refusals: 0 };
  /** Every hand-over `make` was given, in order. */
  readonly handOvers: HandOver[] = [];
  /** Every report `make` gave, in order: "begin x", "done x", "dns x". */
  readonly reported: string[] = [];
  /** The next `make` stops here, once. */
  failNext: Failure | null = null;
  /** A row the plan does not hold, reported as begun and done before each row. */
  strayRow: string | null = null;
  /** While true, `make` waits at the DNS row until `releaseDns`. */
  holdDns = false;
  /** The address `make` answers with. Left out: https:// and the answer's hostname. */
  address: string | null = null;
  notes: string[] = [];
  /** True while `make` waits for the DNS record. */
  waitingForDns = false;
  private dnsGate = Promise.withResolvers<void>();
  private dnsSeen = Promise.withResolvers<void>();

  constructor(id: PlaceId, options: { signedIn?: SignedIn | null; needsSignIn?: boolean } = {}) {
    this.id = id;
    this.needsSignIn = options.needsSignIn ?? id !== "docker";
    this.who = options.signedIn === undefined ? { as: "marta.lindqvist, in Northstar Production" } : options.signedIn;
  }

  get makes(): number {
    return this.handOvers.length;
  }

  /** The last hand-over, or an error when nothing was made. */
  get handOver(): HandOver {
    const last = this.handOvers.at(-1);
    if (!last) throw new Error("make was never called");
    return last;
  }

  /** Resolves once `make` waits for the DNS record. */
  dnsAsked(): Promise<void> {
    return this.dnsSeen.promise;
  }

  /** The DNS record is there: `make` goes on. */
  releaseDns(): void {
    this.dnsGate.resolve();
  }

  async signedIn(): Promise<SignedIn | null> {
    this.asked.signedIn += 1;
    return this.who;
  }

  async refusals(): Promise<CheckLine[]> {
    this.asked.refusals += 1;
    return this.refused;
  }

  async make(handOver: HandOver, progress: MakeProgress, signal: AbortSignal): Promise<Made> {
    this.handOvers.push(handOver);
    const failure = this.failNext;
    this.failNext = null;
    for (const row of handOver.rows) {
      if (signal.aborted) throw new MakeError(row.id, "The install was stopped");
      if (this.strayRow) {
        progress.begin(this.strayRow);
        progress.done(this.strayRow);
        this.reported.push(`begin ${this.strayRow}`, `done ${this.strayRow}`);
      }
      progress.begin(row.id);
      this.reported.push(`begin ${row.id}`);
      if (failure?.at === row.id) {
        throw failure.kind === "make" ? new MakeError(failure.names ?? row.id, failure.text) : new Error(failure.text);
      }
      if (row.id === "dns" && this.holdDns) {
        progress.waitingForDns({ name: handOver.answers.address.hostname, target: DNS_TARGET });
        this.reported.push(`dns ${row.id}`);
        this.waitingForDns = true;
        this.dnsSeen.resolve();
        // A stop while it waits ends the wait, as a real place's would.
        const stopped = new Promise<"stopped">((resolve) => {
          signal.addEventListener("abort", () => resolve("stopped"), { once: true });
        });
        const ended = await Promise.race([this.dnsGate.promise.then(() => "found" as const), stopped]);
        this.waitingForDns = false;
        if (ended === "stopped") throw new MakeError(row.id, "The install was stopped while it waited for the DNS record");
      }
      progress.done(row.id);
      this.reported.push(`done ${row.id}`);
    }
    return {
      address: this.address ?? `https://${handOver.answers.address.hostname}`,
      ...(this.notes.length > 0 ? { notes: [...this.notes] } : {}),
    };
  }
}

/** A folder that does not exist, and that the install must not make. */
export async function untouchedRoot(): Promise<{ paths: ReturnType<typeof fortressPaths>; cleanup: () => Promise<void> }> {
  const work = await mkdtemp(path.join(os.tmpdir(), "hxf-install-"));
  return {
    paths: fortressPaths(path.join(work, "never-made")),
    cleanup: () => rm(work, { recursive: true, force: true }),
  };
}

/** A fetch that answers every model provider with a status, and writes down
 *  each request. Nothing leaves this process. */
export function providers(status = 200): {
  fetch: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return new Response('{"data":[]}', { status });
  };
  return { fetch: fake as typeof fetch, calls };
}

/** An install run on these places, with every outside call answered by a fake. */
export async function installRun(
  places: readonly Place[],
  over: Partial<SetupRunDeps> & { paths: SetupRunDeps["paths"] },
): Promise<SetupRun> {
  return SetupRun.open({
    env: {},
    way: "install",
    places,
    ...over,
    check: { fetch: providers().fetch, timeoutMs: 2_000, ...over.check },
  });
}

/** The answers of Northstar's install that pass every check of the install:
 *  the two that have no first answer, and a model key typed into its field. */
export function answerNorthstar(run: SetupRun, modelKey: string | null): void {
  run.set("organization.name", "Northstar");
  run.set("organization.firstAdministrator", "marta.lindqvist");
  run.set("address.hostname", "hx.northstar.example");
  if (modelKey === null) run.set("model.provider", "none");
  else run.setTyped("model.key", modelKey);
}

/** Wait until `done` holds, a few milliseconds at a time. */
export async function until(done: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`waited ${ms} ms for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
