// A place where `hx-fortress install` can make HX Fortress.
//
// THE SEAM BETWEEN THE SETUP AND THE THINGS THAT MAKE. The setup asks the
// questions, checks what an engineer's computer can check, and works out what
// has to exist: this file's `HandOver`. A place turns that into the real
// thing: a container, a disk, a key store, a database, an address. Each place
// is one object behind this interface (a cloud account, or a machine with
// Docker reached over SSH), and the setup knows nothing else about it.
//
// A PLACE USES THE ENGINEER'S OWN ACCESS: the cloud sign-in this computer
// already holds, or its SSH access. The setup holds no credential for any
// place and asks for none.
//
// NOTHING IS MADE BEFORE `make`. `signedIn` and `refusals` only look.

import type { SetupAnswers } from "../setup/answers";
import type { PlaceId } from "../setup/list";
import type { CheckLine, PlanRow } from "../setup/view";

/** Who this computer is, at a place. */
export interface SignedIn {
  /** A few words a person recognizes: "marta@northstar.example, in Northstar Production". */
  as: string;
  /** The organization's name, when the place knows one. It fills in the first
   *  answer of the Organization page, which a person can change. */
  organization?: string;
  /** The person's own login or email address, when the place knows it. It
   *  fills in the first administrator. */
  person?: string;
}

/** What a place reports while it makes. A row's id is one of the plan's. */
export interface MakeProgress {
  /** A row is being made now. */
  begin(row: string): void;
  /** A row is made. */
  done(row: string): void;
  /**
   * The place waits for a DNS record that a person makes at their own DNS
   * provider. `name` is the hostname, `target` what it must point at. Call
   * `done("dns")` when the record is found.
   */
  waitingForDns(record: { name: string; target: string }): void;
}

/** Thrown by `make` when it cannot go on. `text` is one plain sentence in the
 *  place's own words: it is shown to the person as it is, so it must not
 *  repeat what an outside service sent, and it must hold no key. */
export class MakeError extends Error {
  constructor(
    readonly row: string,
    readonly text: string,
  ) {
    super(text);
    this.name = "MakeError";
  }
}

/** What exists once a place is done. */
export interface Made {
  /** The https address HX Fortress answers at. */
  address: string;
  /** A sentence for something a person should know and that undoes nothing. */
  notes?: string[];
}

/** Everything a place needs in order to make one HX Fortress. */
export interface HandOver {
  /** The answers, as they were checked. */
  answers: SetupAnswers;
  /** The rows of the plan a person said yes to, in the order to make them. */
  rows: readonly PlanRow[];
  /**
   * The settings of HX Fortress's container, as environment variables. None
   * of them is a secret. A place adds the ones only it knows: the address of
   * a key store or a database it makes.
   */
  environment: Readonly<Record<string, string>>;
  /**
   * Settings that ARE secret, by variable. A place gives each to the
   * container the way its platform gives a secret, never as a plain setting,
   * and never writes one to a log.
   */
  secretEnvironment: Readonly<Record<string, string>>;
  /**
   * Keys to write into the key store the answers chose, once, with the
   * engineer's own access: the ones a person typed. `name` is the name
   * HX Fortress reads each by.
   */
  keys: readonly { name: string; value: string }[];
  /**
   * The name under which the place writes the connection string of a
   * database that it makes itself. Null when the database already exists: its
   * connection string is then one of `keys`, or is in the key store already.
   */
  databaseKey: string | null;
}

export interface Place {
  id: PlaceId;
  /** True when this computer must be signed in to the place before anything
   *  can be made there. False for a machine reached over SSH. */
  needsSignIn: boolean;
  /** Who this computer is signed in as there. Null when it is not. */
  signedIn(answers: SetupAnswers): Promise<SignedIn | null>;
  /**
   * What the place refuses in these answers, each line at the answer it is
   * about (`path`). It only looks: it makes nothing and changes nothing.
   */
  refusals?(answers: SetupAnswers): Promise<CheckLine[]>;
  /**
   * Make everything, in the order of `handOver.rows`, and report each row
   * through `progress`. Making again after a failure must be safe: what
   * exists is kept and what is missing is made.
   */
  make(handOver: HandOver, progress: MakeProgress, signal: AbortSignal): Promise<Made>;
}

/**
 * The places this build can make HX Fortress in. A place registers here; the
 * setup offers exactly these.
 */
export const PLACES_OF_THIS_BUILD: readonly Place[] = [];
