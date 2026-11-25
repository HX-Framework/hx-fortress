// The helper programs the host starts for modules. Its own file, with no
// imports, so the pure descriptions of a module (its manifest, the catalog)
// can check a program's id without pulling the launcher in.
//
// A program is another binary on this machine, not this one. The install puts
// it there and names its path in a variable of the daemon's environment.
// HX Fortress downloads no program.
//
// THE LIST IS CLOSED, AND IT FIXES EVERYTHING BUT THE JOB. For each program it
// says which one module it is for, which variable holds its path, which
// arguments it is started with and which variables it is given. No manifest,
// ask, release or act can add a program or change one of those. A module's
// manifest names the programs it has run by their id, and nothing else.

export interface ProgramEntry {
  /** The program's name, as a person reads it on a screen. */
  readonly title: string;
  /** The one module the program is for. */
  readonly module: string;
  /** The variable of the daemon's own environment that holds the program's
   *  absolute path. */
  readonly pathVariable: string;
  /** The arguments the program is started with: always these, and no other. */
  readonly args: readonly string[];
  /** Variables the program is given besides the ones every program gets
   *  (module-programs.ts says which those are). Never a secret. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The programs that can be started, by id.
 *
 * `data-runner` is DB IO: it signs in to one database with one login, does one
 * job, prints one line and ends. `run --job-stdin` makes it read its job from
 * its standard input, so a login is never on a command line or in a variable.
 * `DB_IO_NAMES_ITSELF=1` asks it to add its own version and commit to what it
 * prints. The Databases module asked for the variable. The program in this
 * repository's folder `data-runner/` does not read it yet: the version of the
 * program that does comes in a change of that module's.
 */
export const PROGRAMS: Readonly<Record<string, ProgramEntry>> = {
  "data-runner": {
    title: "DB IO",
    module: "databases",
    pathVariable: "FORTRESS_DATA_RUNNER",
    args: ["run", "--job-stdin"],
    env: { DB_IO_NAMES_ITSELF: "1" },
  },
};

/** A program's id as a manifest may name one. */
export const PROGRAM_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** The list's entry for this program, when the list gives it to this module.
 *  Null otherwise. */
export function programFor(moduleId: string, id: string): ProgramEntry | null {
  // An own property only: `toString` and `__proto__` are programs of no list.
  if (!Object.hasOwn(PROGRAMS, id)) return null;
  const entry = PROGRAMS[id as keyof typeof PROGRAMS] as ProgramEntry;
  return entry.module === moduleId ? entry : null;
}
