// The `file` provider: a secret named `db-url` is the file `<dir>/db-url`.
//
// This is the layout Docker secrets and Kubernetes secret volumes already
// use, and it is what a host install gets when it keeps its own directory of
// 0600 files.
//
// The file is read at every call and nothing is kept, so replacing the file
// replaces the secret with no restart.

import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";

import { secretValueFrom, SecretProviderBase } from "./provider-base";
import { assertSecretName, MAX_SECRET_BYTES, SecretMissing, SecretUnavailable } from "./types";

/** The most bytes read from one file: the largest value, plus one line ending
 *  that will be removed, plus one byte that proves the file holds more. */
const READ_LIMIT_BYTES = MAX_SECRET_BYTES + 2 + 1;

function errnoCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "unknown error";
}

export class FileSecretProvider extends SecretProviderBase {
  readonly kind = "file" as const;
  readonly #dir: string;

  constructor(dir: string) {
    super();
    if (!path.isAbsolute(dir)) {
      throw new Error("the secrets directory must be an absolute path");
    }
    this.#dir = dir;
  }

  async get(name: string): Promise<string> {
    assertSecretName(name);
    // A checked name holds no "/" and no ".", so the joined path is always a
    // direct child of the directory. A symlink there is followed on purpose:
    // a Kubernetes secret volume is made of them.
    const file = path.join(this.#dir, name);
    const source = `file ${file}`;

    let handle;
    try {
      // Non-blocking, so opening a named pipe returns at once and the
      // regular-file check below refuses it. A plain open of a pipe with no
      // writer never returns.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        throw new SecretUnavailable(name, `the file could not be opened (${errnoCode(error)})`, { source });
      }
      // "No such file" is also what a directory that does not exist answers.
      // That is a mistyped setting or a volume that is not mounted, and
      // calling it a missing secret would hide it.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const dir = await stat(this.#dir).catch(() => null);
      if (!dir?.isDirectory()) {
        throw new SecretUnavailable(name, "the secrets directory does not exist", {
          source: `directory ${this.#dir}`,
        });
      }
      throw new SecretMissing(name, source);
    }

    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new SecretUnavailable(name, "it is not a regular file", { source });
      const buffer = Buffer.alloc(READ_LIMIT_BYTES);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length === buffer.length) {
        throw new SecretUnavailable(name, `the value is larger than ${MAX_SECRET_BYTES} bytes`, { source });
      }
      bytes = buffer.subarray(0, length);
    } catch (error) {
      if (error instanceof SecretUnavailable) throw error;
      throw new SecretUnavailable(name, `the file could not be read (${errnoCode(error)})`, { source });
    } finally {
      await handle.close().catch(() => {});
    }

    let text: string;
    try {
      // A byte-order mark at the start is dropped by the decoder. Anything
      // that is not UTF-8 is refused.
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      // The decoder's own error is not passed on. This module never forwards
      // anything derived from a value.
      throw new SecretUnavailable(name, "the file is not UTF-8 text", { source });
    }
    return secretValueFrom(name, text, source);
  }
}
