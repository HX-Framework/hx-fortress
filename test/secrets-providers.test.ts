import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EnvSecretProvider,
  FileSecretProvider,
  isSecretName,
  isSecretProviderKind,
  MAX_SECRET_BYTES,
  SECRET_PROVIDER_KINDS,
  secretEnvName,
  secretErrorForLog,
  SecretMissing,
  SecretNameInvalid,
  SecretUnavailable,
  type SecretProvider,
} from "../src/secrets";

// Built at run time so no secret-shaped literal sits in the repository.
const VALUE = ["value", "of", "the", "test", "secret"].join(" ");

/** Everything an error or a provider can show a reader: its message, its
 *  string form, its own fields and what an inspector prints. None of them may
 *  hold a value. */
function everythingPrintable(thing: unknown): string {
  const e = thing as Error;
  return [
    e.message ?? "",
    String(e),
    JSON.stringify(e) ?? "",
    JSON.stringify({ ...e }),
    e.stack ?? "",
    Bun.inspect(thing),
  ].join("\n");
}

async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("secret names", () => {
  test("a name is 1 to 64 characters of a-z, 0-9 and '-'", () => {
    for (const name of ["a", "db-url", "stores-db-url-2", "0", "-", "a".repeat(64)]) {
      expect(isSecretName(name)).toBe(true);
    }
    for (const name of [
      "",
      "a".repeat(65),
      "DB-URL",
      "db_url",
      "db.url",
      "db/url",
      "../db",
      "db url",
      "db\nurl",
      "db-url\n",
      "dbürl",
      null,
      undefined,
      7,
    ]) {
      expect(isSecretName(name)).toBe(false);
    }
  });

  test("the refusal of a bad name does not repeat what was passed", async () => {
    const env = new EnvSecretProvider({});
    // A caller that passes a value where a name belongs.
    const error = await thrownBy(() => env.get(VALUE));
    expect(error).toBeInstanceOf(SecretNameInvalid);
    expect(everythingPrintable(error)).not.toContain(VALUE);
  });

  test("an error built by hand with a bad name does not repeat it either", () => {
    expect(everythingPrintable(new SecretMissing(VALUE))).not.toContain(VALUE);
    expect(everythingPrintable(new SecretUnavailable(VALUE, "no answer"))).not.toContain(VALUE);
    expect(new SecretMissing("db-url").message).toBe('secret "db-url" is not set');
  });

  test("the three kinds are env, file and azure-key-vault", () => {
    expect([...SECRET_PROVIDER_KINDS]).toEqual(["env", "file", "azure-key-vault"]);
    expect(isSecretProviderKind("file")).toBe(true);
    expect(isSecretProviderKind("FILE")).toBe(false);
    expect(isSecretProviderKind(undefined)).toBe(false);
  });

  test("an unavailable secret says whether asking again may work", () => {
    expect(new SecretUnavailable("db-url", "no answer").transient).toBe(false);
    expect(new SecretUnavailable("db-url", "no answer", { transient: true }).transient).toBe(true);
  });

  test("where the provider looked is for this host's log, and is not in what an error serializes to", () => {
    const missing = new SecretMissing("db-url", "file /run/secrets/db-url");
    expect(missing.source).toBe("file /run/secrets/db-url");
    expect(missing.message).toBe('secret "db-url" is not set');
    expect(JSON.stringify(missing)).not.toContain("/run/secrets");
    expect(secretErrorForLog(missing)).toBe('secret "db-url" is not set (file /run/secrets/db-url)');

    const unavailable = new SecretUnavailable("db-url", "it is not a regular file", {
      source: "file /run/secrets/db-url",
    });
    expect(JSON.stringify(unavailable)).not.toContain("/run/secrets");
    expect(secretErrorForLog(unavailable)).toBe(
      'secret "db-url" could not be read: it is not a regular file (file /run/secrets/db-url)',
    );
    expect(secretErrorForLog(new SecretMissing("db-url"))).toBe('secret "db-url" is not set');
    expect(secretErrorForLog(new Error("something else"))).toBe("something else");
  });
});

describe("the env provider", () => {
  test("reads FORTRESS_SECRET_<NAME>", async () => {
    const provider = new EnvSecretProvider({ FORTRESS_SECRET_DB_URL: VALUE });
    expect(provider.kind).toBe("env");
    expect(secretEnvName("db-url")).toBe("FORTRESS_SECRET_DB_URL");
    expect(secretEnvName("stores-key-2")).toBe("FORTRESS_SECRET_STORES_KEY_2");
    expect(await provider.get("db-url")).toBe(VALUE);
    expect(await provider.has("db-url")).toBe(true);
  });

  test("with no argument it reads the process environment", async () => {
    const variable = "FORTRESS_SECRET_PROVIDER_TEST_PROBE";
    // eslint-disable-next-line security/detect-object-injection
    process.env[variable] = VALUE;
    try {
      expect(await new EnvSecretProvider().get("provider-test-probe")).toBe(VALUE);
    } finally {
      // eslint-disable-next-line security/detect-object-injection
      delete process.env[variable];
    }
  });

  test("a name never reaches a variable outside the prefix", async () => {
    const provider = new EnvSecretProvider({ HOME: "/home/someone", PATH: "/usr/bin", DB_URL: VALUE });
    for (const name of ["home", "path", "db-url"]) {
      expect(await provider.has(name)).toBe(false);
      expect(await thrownBy(() => provider.get(name))).toBeInstanceOf(SecretMissing);
    }
  });

  test("a variable that is only inherited is not a secret", async () => {
    const inherited = Object.create({ FORTRESS_SECRET_INHERITED: VALUE }) as Record<string, string>;
    const provider = new EnvSecretProvider(inherited);
    expect(await provider.has("inherited")).toBe(false);
  });

  test("an unset, empty or blank variable is a missing secret", async () => {
    const provider = new EnvSecretProvider({
      FORTRESS_SECRET_EMPTY: "",
      FORTRESS_SECRET_BLANK: "   ",
      FORTRESS_SECRET_NEWLINE: "\n",
    });
    for (const name of ["empty", "blank", "newline"]) expect(await provider.has(name)).toBe(false);
    const error = (await thrownBy(() => provider.get("absent"))) as SecretMissing;
    expect(error).toBeInstanceOf(SecretMissing);
    expect(error.secretName).toBe("absent");
    expect(error.message).toBe('secret "absent" is not set');
    // Where it looked is on the error for this host's own log, not in the message.
    expect(error.source).toBe("environment variable FORTRESS_SECRET_ABSENT");
  });

  test("one final line ending is removed and nothing else, and the environment is read at every call", async () => {
    const env: Record<string, string | undefined> = { FORTRESS_SECRET_PADDED: `  ${VALUE} \n` };
    const provider = new EnvSecretProvider(env);
    expect(await provider.get("padded")).toBe(`  ${VALUE} `);
    env.FORTRESS_SECRET_PADDED = "second";
    expect(await provider.get("padded")).toBe("second");
  });

  test("a value past the size limit or with a NUL in it is refused and not repeated", async () => {
    const marker = "the-oversized-contents-marker";
    const provider = new EnvSecretProvider({
      FORTRESS_SECRET_LARGE: marker + "x".repeat(MAX_SECRET_BYTES),
      FORTRESS_SECRET_BINARY: `${marker}\0`,
    });
    const large = (await thrownBy(() => provider.get("large"))) as SecretUnavailable;
    expect(large.reason).toBe(`the value is larger than ${MAX_SECRET_BYTES} bytes`);
    const binary = (await thrownBy(() => provider.get("binary"))) as SecretUnavailable;
    expect(binary.reason).toBe("the value holds a NUL character, so it is not text");
    expect(everythingPrintable(large) + everythingPrintable(binary)).not.toContain(marker);
  });

  test("printing or serializing the provider shows nothing from the environment", () => {
    const provider = new EnvSecretProvider({ FORTRESS_SECRET_DB_URL: VALUE, OTHER: "another value" });
    const printed = everythingPrintable(provider);
    expect(printed).not.toContain(VALUE);
    expect(printed).not.toContain("another value");
    expect(JSON.stringify({ provider })).toBe('{"provider":{"kind":"env"}}');
  });
});

describe("the file provider", () => {
  let dir: string;
  let provider: SecretProvider;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hx-fortress-secrets-"));
    provider = new FileSecretProvider(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reads <dir>/<name> and removes exactly one final line ending", async () => {
    await writeFile(path.join(dir, "plain"), VALUE);
    await writeFile(path.join(dir, "with-newline"), `${VALUE}\n`);
    await writeFile(path.join(dir, "with-crlf"), `${VALUE}\r\n`);
    await writeFile(path.join(dir, "two-newlines"), `${VALUE}\n\n`);
    expect(provider.kind).toBe("file");
    expect(await provider.get("plain")).toBe(VALUE);
    expect(await provider.get("with-newline")).toBe(VALUE);
    expect(await provider.get("with-crlf")).toBe(VALUE);
    expect(await provider.get("two-newlines")).toBe(`${VALUE}\n`);
    expect(await provider.has("plain")).toBe(true);
  });

  test("a file that is absent, empty or blank is a missing secret", async () => {
    await writeFile(path.join(dir, "empty"), "");
    await writeFile(path.join(dir, "only-newline"), "\n");
    await writeFile(path.join(dir, "blank-lines"), "  \n\n");
    for (const name of ["absent", "empty", "only-newline", "blank-lines"]) {
      expect(await provider.has(name)).toBe(false);
      const error = (await thrownBy(() => provider.get(name))) as SecretMissing;
      expect(error).toBeInstanceOf(SecretMissing);
      expect(error.message).toBe(`secret "${name}" is not set`);
      expect(error.message).not.toContain(dir);
      expect(error.source).toBe(`file ${path.join(dir, name)}`);
    }
  });

  test("a directory that does not exist is unavailable, not a missing secret", async () => {
    const absent = new FileSecretProvider(path.join(dir, "not-mounted"));
    const error = (await thrownBy(() => absent.get("db-url"))) as SecretUnavailable;
    expect(error).toBeInstanceOf(SecretUnavailable);
    expect(error.reason).toBe("the secrets directory does not exist");
    expect(error.source).toBe(`directory ${path.join(dir, "not-mounted")}`);
    // `has` cannot say no for a store that is not there.
    expect(await thrownBy(() => absent.has("db-url"))).toBeInstanceOf(SecretUnavailable);

    await writeFile(path.join(dir, "a-file"), VALUE);
    const notADirectory = new FileSecretProvider(path.join(dir, "a-file"));
    expect(await thrownBy(() => notADirectory.get("db-url"))).toBeInstanceOf(SecretUnavailable);
  });

  test("replacing the file replaces the secret with no restart", async () => {
    await writeFile(path.join(dir, "rotated"), "first\n");
    expect(await provider.get("rotated")).toBe("first");
    await writeFile(path.join(dir, "rotated"), "second\n");
    expect(await provider.get("rotated")).toBe("second");
  });

  test("a name cannot leave the directory", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "hx-fortress-outside-"));
    try {
      await writeFile(path.join(outside, "target"), VALUE);
      const relative = path.relative(dir, path.join(outside, "target"));
      for (const name of [relative, `../${path.basename(outside)}/target`, path.join(outside, "target")]) {
        expect(await thrownBy(() => provider.get(name))).toBeInstanceOf(SecretNameInvalid);
        expect(await thrownBy(() => provider.has(name))).toBeInstanceOf(SecretNameInvalid);
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("follows a symlink, the way a Kubernetes secret volume is laid out", async () => {
    await mkdir(path.join(dir, "..data"));
    await writeFile(path.join(dir, "..data", "db-url"), `${VALUE}\n`);
    await symlink(path.join("..data", "db-url"), path.join(dir, "db-url"));
    expect(await provider.get("db-url")).toBe(VALUE);
  });

  test("a directory, a named pipe and a file that is not text are unavailable", async () => {
    await mkdir(path.join(dir, "a-directory"));
    const directory = (await thrownBy(() => provider.get("a-directory"))) as SecretUnavailable;
    expect(directory).toBeInstanceOf(SecretUnavailable);
    expect(directory.reason).toBe("it is not a regular file");
    // Unavailable is not missing: `has` cannot answer, so it does not answer no.
    expect(await thrownBy(() => provider.has("a-directory"))).toBeInstanceOf(SecretUnavailable);

    // A pipe with no writer. A plain open would wait on it for ever.
    execFileSync("mkfifo", [path.join(dir, "a-pipe")]);
    const pipe = (await thrownBy(() => provider.get("a-pipe"))) as SecretUnavailable;
    expect(pipe).toBeInstanceOf(SecretUnavailable);
    expect(pipe.reason).toBe("it is not a regular file");

    // These bytes are read before they are refused, so the refusal is where a
    // leak would show.
    const marker = "the-binary-contents-marker";
    await writeFile(
      path.join(dir, "binary"),
      Buffer.concat([Buffer.from(marker), Buffer.from([0xff, 0xfe, 0x6f])]),
    );
    const binary = (await thrownBy(() => provider.get("binary"))) as SecretUnavailable;
    expect(binary).toBeInstanceOf(SecretUnavailable);
    expect(binary.reason).toBe("the file is not UTF-8 text");
    expect(everythingPrintable(binary)).not.toContain(marker);

    await writeFile(path.join(dir, "utf16"), Buffer.from(`${marker}`, "utf16le"));
    const utf16 = (await thrownBy(() => provider.get("utf16"))) as SecretUnavailable;
    expect(utf16.reason).toBe("the value holds a NUL character, so it is not text");
    expect(everythingPrintable(utf16)).not.toContain(marker);
  });

  test("the size limit is on the value: the line ending does not count, and one byte more is refused", async () => {
    const atLimit = "v".repeat(MAX_SECRET_BYTES);
    await writeFile(path.join(dir, "at-limit"), atLimit);
    await writeFile(path.join(dir, "at-limit-newline"), `${atLimit}\n`);
    await writeFile(path.join(dir, "at-limit-crlf"), `${atLimit}\r\n`);
    expect(await provider.get("at-limit")).toBe(atLimit);
    expect(await provider.get("at-limit-newline")).toBe(atLimit);
    expect(await provider.get("at-limit-crlf")).toBe(atLimit);

    const marker = "the-oversized-contents-marker";
    for (const [name, body] of [
      ["one-over", `${marker}${"x".repeat(MAX_SECRET_BYTES + 1 - marker.length)}`],
      ["one-over-newline", `${marker}${"x".repeat(MAX_SECRET_BYTES + 1 - marker.length)}\n`],
      ["far-over", `${marker}${"x".repeat(4 * MAX_SECRET_BYTES)}`],
    ] as const) {
      await writeFile(path.join(dir, name), body);
      const error = (await thrownBy(() => provider.get(name))) as SecretUnavailable;
      expect(error).toBeInstanceOf(SecretUnavailable);
      expect(error.reason).toBe(`the value is larger than ${MAX_SECRET_BYTES} bytes`);
      expect(everythingPrintable(error)).not.toContain(marker);
    }
  });

  // Root can read a file whatever its mode, so this refusal cannot happen there.
  test.skipIf(process.getuid?.() === 0)(
    "a file this process may not read is unavailable, with the error code and nothing else",
    async () => {
      const file = path.join(dir, "locked");
      await writeFile(file, VALUE);
      await chmod(file, 0o000);
      try {
        const error = (await thrownBy(() => provider.get("locked"))) as SecretUnavailable;
        expect(error).toBeInstanceOf(SecretUnavailable);
        expect(error.reason).toBe("the file could not be opened (EACCES)");
      } finally {
        await chmod(file, 0o600);
      }
    },
  );

  test("printing or serializing the provider shows only its kind", () => {
    expect(JSON.stringify({ provider })).toBe('{"provider":{"kind":"file"}}');
  });

  test("the directory must be an absolute path", () => {
    expect(() => new FileSecretProvider("secrets")).toThrow("must be an absolute path");
  });
});
