// The words a module may have started as a process of its own. Its own file,
// with no imports, so the pure descriptions of a module (its manifest, the
// catalog) can check a word without pulling the launcher in.
//
// A word is a command of this program's own command line (src/cli.ts),
// compiled into the binary, and each word is for one module. The list is
// closed: no manifest, ask, release or act can add a word.

/** The words that can be started, each with the one module it is for. */
export const PROCESS_WORDS: Readonly<Record<string, string>> = {
  "store-engine": "stores",
};

/** A word as a manifest may name one: what a command of this program looks
 *  like. */
export const PROCESS_WORD_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Whether the list gives this word to this module. */
export function processWordFor(moduleId: string, word: string): boolean {
  // An own property only: `toString` and `__proto__` are words of no list.
  return Object.hasOwn(PROCESS_WORDS, word) && PROCESS_WORDS[word as keyof typeof PROCESS_WORDS] === moduleId;
}
