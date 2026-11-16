// The reader that every network key store holds (src/secrets/network-reader.ts),
// driven by a toy store. What one real store does with it is tested in that
// store's own file. Nothing here leaves this machine.

import { afterEach, describe, expect, test } from "bun:test";

import { secretErrorForLog, SecretUnavailable } from "../src/secrets";
import {
  keepEndpointOffProxy,
  MAX_CREDENTIAL_LIFETIME_MS,
  NetworkSecretReader,
  noResponse,
  refreshTimeFor,
  type Attempt,
  type NetworkSecretIo,
  type NetworkSecretReaderOptions,
  type NetworkSecretSource,
  type TimedCredential,
} from "../src/secrets/network-reader";
import { fakeHttpServer, randomLabel, type FakeHttpServer } from "./rig/http-fakes";

const WORDS = { credential: "toy credential", credentialRequest: "the toy credential request" } as const;

interface Toy {
  reader: NetworkSecretReader<string>;
  clock: { now: number };
  /** The waits the reader asked for, in order. None of them is slept. */
  sleeps: number[];
  /** How many times each of the two requests was made. */
  made: { credential: number; secret: number };
}

/** A reader over a toy store. Each credential is `credential-<n>`, good for
 *  one hour, unless `parts` says otherwise. */
function toy(
  parts: Partial<NetworkSecretSource<string>>,
  options: NetworkSecretReaderOptions = {},
): Toy {
  const clock = { now: 1_800_000_000_000 };
  const sleeps: number[] = [];
  const made = { credential: 0, secret: 0 };
  const requestCredential =
    parts.requestCredential ??
    (async (io: NetworkSecretIo): Promise<Attempt<TimedCredential<string>>> => ({
      ok: true,
      value: { credential: `credential-${made.credential}`, refreshAt: io.now() + 3_600_000 },
    }));
  const requestSecret =
    parts.requestSecret ?? (async (): Promise<Attempt<string>> => ({ ok: true, value: "a-stored-value" }));
  const reader = new NetworkSecretReader<string>(
    {
      now: () => clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      requestTimeoutMs: 2_000,
      ...options,
    },
    {
      words: parts.words ?? WORDS,
      sourceOf: parts.sourceOf ?? ((name) => `toy secret ${name}`),
      requestCredential: (io) => {
        made.credential += 1;
        return requestCredential(io);
      },
      requestSecret: (name, credential, io) => {
        made.secret += 1;
        return requestSecret(name, credential, io);
      },
    },
  );
  return { reader, clock, sleeps, made };
}

async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/** Everything an error can show a reader. */
function everythingPrintable(thing: unknown): string {
  const e = thing as Error;
  return [
    e.message ?? "",
    String(e),
    JSON.stringify(e) ?? "",
    JSON.stringify({ ...e }),
    e.stack ?? "",
    Bun.inspect(thing),
    secretErrorForLog(thing),
  ].join("\n");
}

/** A door that a test opens when it wants a waiting request to go on. */
function gate(): { wait: Promise<void>; open(): void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Whether this machine has an IPv6 loopback address to listen on. */
const HAS_IPV6_LOOPBACK = ((): boolean => {
  try {
    void fakeHttpServer(() => new Response(), "::1").stop();
    return true;
  } catch {
    return false;
  }
})();

const servers: FakeHttpServer[] = [];
function server(handler: Parameters<typeof fakeHttpServer>[0], hostname?: string): FakeHttpServer {
  const made = fakeHttpServer(handler, hostname);
  servers.push(made);
  return made;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((made) => made.stop()));
});

describe("a request of a provider that throws", () => {
  test("for a secret: the secret could not be read, and what was thrown is not repeated", async () => {
    // What a JSON parser throws repeats a word of what it was given.
    const marker = randomLabel("response-text");
    const { reader, made, sleeps } = toy({
      requestSecret: async () => {
        throw new SyntaxError(`JSON Parse error: Unexpected identifier "${marker}"`);
      },
    });
    for (const call of [() => reader.get("db-url"), () => reader.get("db-url")]) {
      const error = (await thrownBy(call)) as SecretUnavailable;
      expect(error).toBeInstanceOf(SecretUnavailable);
      expect(error.reason).toBe("the request for the secret could not be made");
      expect(error.transient).toBe(false);
      expect(error.secretName).toBe("db-url");
      expect(everythingPrintable(error)).not.toContain(marker);
    }
    // Not tried again, and no wait: nothing says a second try would differ.
    expect(made.secret).toBe(2);
    expect(sleeps).toEqual([]);
  });

  test("an answer that is called a value and is not text is not passed on", async () => {
    for (const notText of [5, null, undefined, { value: "x" }, ["x"]]) {
      const { reader } = toy({
        requestSecret: async () => ({ ok: true, value: notText as unknown as string }),
      });
      const error = (await thrownBy(() => reader.get("db-url"))) as SecretUnavailable;
      expect(error).toBeInstanceOf(SecretUnavailable);
      expect(error.reason).toBe("the request for the secret could not be made");
      expect(error.transient).toBe(false);
    }
  });

  test("for a credential: each secret that waited reports it under its own name", async () => {
    const marker = randomLabel("response-text");
    const { reader, made } = toy({
      requestCredential: async () => {
        throw new Error(`could not parse ${marker}`);
      },
    });
    const errors = (await Promise.all(
      ["db-url", "api-key"].map((name) => thrownBy(() => reader.get(name))),
    )) as SecretUnavailable[];
    expect(errors.map((error) => error.secretName)).toEqual(["db-url", "api-key"]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(SecretUnavailable);
      expect(error.reason).toBe("no toy credential: the toy credential request could not be made");
      expect(everythingPrintable(error)).not.toContain(marker);
    }
    // One request served both.
    expect(made.credential).toBe(1);
    expect(made.secret).toBe(0);
  });
});

describe("a store that refuses a credential", () => {
  test("gets one new credential, however many reads held the one it refused", async () => {
    const names = ["a", "b", "c", "d"];
    const gates = new Map(names.map((name) => [name, gate()]));
    let refused: string | null = null;
    const { reader, made } = toy({
      requestSecret: async (name, credential) => {
        if (credential === refused) {
          await gates.get(name)?.wait;
          return { ok: false, retry: false, transient: false, unauthorized: true, reason: "refused" };
        }
        return { ok: true, value: `value-of-${name}-with-${credential}` };
      },
    });
    // One read, so the reader holds a credential.
    expect(await reader.get("first")).toBe("value-of-first-with-credential-1");
    // The store now refuses that credential, and four reads go out with it.
    refused = "credential-1";
    const reads = new Map(names.map((name) => [name, reader.get(name)]));
    // Their refusals come back one after another. The first one fetches a
    // new credential. The later ones find it already there.
    const values: (string | undefined)[] = [];
    for (const name of names) {
      gates.get(name)?.open();
      values.push(await reads.get(name));
    }
    expect(values).toEqual(names.map((name) => `value-of-${name}-with-credential-2`));
    expect(made.credential).toBe(2);
  });

  test("a store that refuses every credential is asked for one new one for each read, not in a loop", async () => {
    const { reader, made } = toy({
      requestSecret: async () => ({
        ok: false,
        retry: false,
        transient: false,
        unauthorized: true,
        reason: "the toy store refused the credential",
      }),
    });
    const error = (await thrownBy(() => reader.get("db-url"))) as SecretUnavailable;
    expect(error).toBeInstanceOf(SecretUnavailable);
    expect(error.reason).toBe("the toy store refused the credential");
    expect(made.credential).toBe(2);
    expect(made.secret).toBe(2);
  });
});

describe("a clock that is set back", () => {
  test("a value is not served past its cache time", async () => {
    let stored = "before-the-rotation";
    const { reader, clock, made } = toy(
      { requestSecret: async () => ({ ok: true, value: stored }) },
      { cacheTtlMs: 60_000 },
    );
    expect(await reader.get("db-url")).toBe("before-the-rotation");
    expect(await reader.get("db-url")).toBe("before-the-rotation");
    expect(made.secret).toBe(1);

    // The secret is rotated, and the clock goes back an hour. Without a check
    // the old value would be served for an hour and a minute.
    stored = "after-the-rotation";
    clock.now -= 3_600_000;
    expect(await reader.get("db-url")).toBe("after-the-rotation");
    expect(made.secret).toBe(2);
    expect(reader.heldValues).toBe(1);
  });

  test("the credential is asked for again too", async () => {
    const { reader, clock, made } = toy({}, { cacheTtlMs: 0 });
    await reader.get("db-url");
    await reader.get("db-url");
    expect(made.credential).toBe(1);
    clock.now -= 3_600_000;
    await reader.get("db-url");
    expect(made.credential).toBe(2);
    // And it is kept from then on.
    await reader.get("db-url");
    expect(made.credential).toBe(2);
  });

  test("a clock that is set back while a credential is being fetched does not keep it alive", async () => {
    let stepped = false;
    const made = toy(
      {
        requestCredential: async (io) => {
          // The provider reads the clock, and then the clock goes back an
          // hour before the reader has the credential.
          const refreshAt = io.now() + 3_300_000;
          if (!stepped) {
            stepped = true;
            made.clock.now -= 3_600_000;
          }
          return { ok: true, value: { credential: "a-credential", refreshAt } };
        },
      },
      { cacheTtlMs: 0 },
    );
    await made.reader.get("db-url");
    // Without the check this credential would be used for an hour longer than
    // it lives.
    await made.reader.get("db-url");
    expect(made.made.credential).toBe(2);
    // The second one was fetched on a steady clock, and is kept.
    await made.reader.get("db-url");
    expect(made.made.credential).toBe(2);
  });

  test("a clock that goes forward ends a value and a credential at their times, as before", async () => {
    const { reader, clock, made } = toy({}, { cacheTtlMs: 60_000 });
    await reader.get("db-url");
    clock.now += 59_999;
    await reader.get("db-url");
    expect(made.secret).toBe(1);
    clock.now += 1;
    await reader.get("db-url");
    expect(made.secret).toBe(2);
    expect(made.credential).toBe(1);
    clock.now += 3_600_000;
    await reader.get("db-url");
    expect(made.credential).toBe(2);
  });
});

describe("an answer that is a redirect", () => {
  /** A toy store that sends real requests to `origin`. */
  function overHttp(origin: string, options: NetworkSecretReaderOptions = {}): Toy {
    return toy(
      {
        requestCredential: async (io) => {
          let response: Response;
          try {
            response = await io.request(`${origin}/credential`, { method: "GET", headers: {} });
          } catch (error) {
            return noResponse(error, "the toy platform");
          }
          return response.status === 200
            ? { ok: true, value: { credential: await response.text(), refreshAt: io.now() + 3_600_000 } }
            : { ok: false, retry: false, transient: false, reason: `the toy platform answered ${response.status}` };
        },
        requestSecret: async (name, credential, io) => {
          let response: Response;
          try {
            response = await io.request(`${origin}/secrets/${name}`, {
              method: "GET",
              headers: { authorization: `Bearer ${credential}` },
            });
          } catch (error) {
            return noResponse(error, "the toy store");
          }
          return response.status === 200
            ? { ok: true, value: await response.text() }
            : { ok: false, retry: false, transient: false, reason: `the toy store answered ${response.status}` };
        },
      },
      options,
    );
  }

  for (const status of [301, 302, 303, 307, 308]) {
    test(`${status} from the store is refused, named, and not tried again`, async () => {
      const credential = randomLabel("credential");
      const elsewhere = server(() => new Response("a value from somewhere else"));
      const store = server((_req, url) =>
        url.pathname === "/credential"
          ? new Response(credential)
          : new Response(null, { status, headers: { location: `${elsewhere.origin}${url.pathname}` } }),
      );
      const { reader, sleeps } = overHttp(store.origin, { attempts: 3 });
      const error = (await thrownBy(() => reader.get("db-url"))) as SecretUnavailable;
      expect(error).toBeInstanceOf(SecretUnavailable);
      expect(error.reason).toBe("the toy store answered with a redirect, which is not followed");
      // Something between this host and the store sends requests elsewhere.
      // Asking again, now or later, changes nothing.
      expect(error.transient).toBe(false);
      expect(store.requests.filter((request) => request.path === "/secrets/db-url")).toHaveLength(1);
      expect(sleeps).toEqual([]);
      // The credential went nowhere else.
      expect(elsewhere.requests).toHaveLength(0);
      expect(everythingPrintable(error)).not.toContain(credential);
      expect(everythingPrintable(error)).not.toContain(elsewhere.origin);
    });
  }

  test("a redirect from the platform's credential endpoint is refused the same way", async () => {
    const elsewhere = server(() => new Response("a credential from somewhere else"));
    const platform = server(
      () => new Response(null, { status: 302, headers: { location: `${elsewhere.origin}/credential` } }),
    );
    const { reader, sleeps } = overHttp(platform.origin, { attempts: 3 });
    const error = (await thrownBy(() => reader.get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe(
      "no toy credential: the toy platform answered with a redirect, which is not followed",
    );
    expect(error.transient).toBe(false);
    expect(platform.requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(elsewhere.requests).toHaveLength(0);
  });

  test("a 300 or a 304 is an answer like any other, and the provider reads its status", async () => {
    for (const status of [300, 304]) {
      const store = server((_req, url) =>
        url.pathname === "/credential" ? new Response("a-credential") : new Response(null, { status }),
      );
      const { reader } = overHttp(store.origin);
      const error = (await thrownBy(() => reader.get("db-url"))) as SecretUnavailable;
      expect(error.reason).toBe(`the toy store answered ${status}`);
    }
  });

  test("the connection of a refused redirect is closed at once, and not held until the time limit", async () => {
    // A redirect whose body never ends. The other end learns that the
    // request is over when its stream is cancelled.
    let cancelled = (): void => {};
    const closed = new Promise<"closed">((resolve) => {
      cancelled = () => resolve("closed");
    });
    const store = server((_req, url) => {
      if (url.pathname === "/credential") return new Response("a-credential");
      let timer: ReturnType<typeof setInterval> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
          timer = setInterval(() => {
            try {
              controller.enqueue(new TextEncoder().encode("y"));
            } catch {
              // The stream is closed: nothing more to send.
            }
          }, 20);
        },
        cancel() {
          clearInterval(timer);
          cancelled();
        },
      });
      return new Response(body, { status: 302, headers: { location: "http://127.0.0.1:1/elsewhere" } });
    });
    // The time limit is far away, so it cannot be what closes the connection.
    const { reader } = overHttp(store.origin, { attempts: 1, requestTimeoutMs: 30_000 });
    const error = (await thrownBy(() => reader.get("db-url"))) as SecretUnavailable;
    expect(error.reason).toBe("the toy store answered with a redirect, which is not followed");
    const ended = await Promise.race([closed, Bun.sleep(5_000).then(() => "still open" as const)]);
    expect(ended).toBe("closed");
  }, 15_000);
});

describe("a request's time limit", () => {
  /** A store that never answers a request for a secret. */
  function silentStore(options: NetworkSecretReaderOptions, timeoutMs?: number): Toy & { release(): void } {
    const never = gate();
    const store = server(async () => {
      await never.wait;
      return new Response("too late");
    });
    // The credential needs no request here, so the limit is spent on the one
    // request this test is about.
    const made = toy(
      {
        requestSecret: async (name, credential, io) => {
          try {
            await io.request(`${store.origin}/secrets/${name}`, {
              method: "GET",
              headers: { authorization: `Bearer ${credential}` },
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            });
          } catch (error) {
            return noResponse(error, "the toy store");
          }
          return { ok: false, retry: false, transient: false, reason: "it answered" };
        },
      },
      options,
    );
    return Object.assign(made, { release: never.open });
  }

  test("a request that gets no answer in time may work later, and is tried again", async () => {
    const store = silentStore({ attempts: 2, requestTimeoutMs: 150 });
    const error = (await thrownBy(() => store.reader.get("db-url"))) as SecretUnavailable;
    store.release();
    expect(error.reason).toBe("the toy store did not answer (timed out)");
    expect(error.transient).toBe(true);
    expect(store.sleeps).toEqual([200]);
  });

  test("one request may have a shorter limit than the reader's, and never a longer one", async () => {
    // Shorter: the reader would wait half a minute, the request gives up at once.
    const shorter = silentStore({ attempts: 1, requestTimeoutMs: 30_000 }, 100);
    const began = performance.now();
    const first = (await thrownBy(() => shorter.reader.get("db-url"))) as SecretUnavailable;
    shorter.release();
    expect(first.reason).toBe("the toy store did not answer (timed out)");
    expect(performance.now() - began).toBeLessThan(5_000);

    // Longer: the reader's own limit still holds.
    const longer = silentStore({ attempts: 1, requestTimeoutMs: 100 }, 30_000);
    const again = performance.now();
    const second = (await thrownBy(() => longer.reader.get("db-url"))) as SecretUnavailable;
    longer.release();
    expect(second.reason).toBe("the toy store did not answer (timed out)");
    expect(performance.now() - again).toBeLessThan(5_000);
  }, 15_000);
});

describe("what a request with no response came to", () => {
  test("a time limit and a lost connection may work on the next try", () => {
    const timedOut = noResponse(new DOMException("The operation timed out.", "TimeoutError"), "the vault");
    expect(timedOut).toEqual({
      ok: false,
      retry: true,
      transient: true,
      reason: "the vault did not answer (timed out)",
    });
    // A fetch error can repeat the address it was given. The reason does not.
    const address = `https://${randomLabel("host")}.example/secrets/db-url`;
    const lost = noResponse(new TypeError(`fetch failed for ${address}`), "the vault");
    expect(lost).toEqual({
      ok: false,
      retry: true,
      transient: true,
      reason: "the vault did not answer (network error)",
    });
  });

  test("the runtime's own refusal of a redirect is named as a redirect", () => {
    const refused = Object.assign(new Error("UnexpectedRedirect fetching an address"), {
      code: "UnexpectedRedirect",
    });
    expect(noResponse(refused, "the vault")).toEqual({
      ok: false,
      retry: false,
      transient: false,
      reason: "the vault answered with a redirect, which is not followed",
    });
  });
});

describe("how long a credential is used", () => {
  const now = 1_800_000_000_000;

  test("until five minutes before it expires, or for half of a short life", () => {
    expect(refreshTimeFor(now, 3_600_000)).toBe(now + 3_300_000);
    expect(refreshTimeFor(now, 600_001)).toBe(now + 300_001);
    expect(refreshTimeFor(now, 600_000)).toBe(now + 300_000);
    expect(refreshTimeFor(now, 240_000)).toBe(now + 120_000);
    expect(refreshTimeFor(now, 0)).toBe(now);
    expect(refreshTimeFor(now, -5_000)).toBe(now);
  });

  test("never for more than a day, whatever its lifetime is said to be", () => {
    const day = 24 * 3_600_000;
    expect(MAX_CREDENTIAL_LIFETIME_MS).toBe(day);
    expect(refreshTimeFor(now, day)).toBe(now + day - 300_000);
    expect(refreshTimeFor(now, 30 * day)).toBe(now + day - 300_000);
    expect(refreshTimeFor(now, Number.MAX_VALUE)).toBe(now + day - 300_000);
  });

  test("a lifetime that is not a finite number is a lifetime nobody stated: the credential is not kept", async () => {
    expect(refreshTimeFor(now, Number.NaN)).toBe(now);
    expect(refreshTimeFor(now, Date.parse("not a date") - now)).toBe(now);
    // A JSON answer can hold a number too large to be one. It reads as infinite.
    const parsed = (JSON.parse('{"expires_in":1e999}') as { expires_in: number }).expires_in;
    expect(refreshTimeFor(now, parsed)).toBe(now);
    expect(refreshTimeFor(now, Number.NEGATIVE_INFINITY)).toBe(now);

    const { reader, made } = toy(
      {
        requestCredential: async (io) => ({
          ok: true,
          value: {
            credential: "a-credential",
            refreshAt: refreshTimeFor(io.now(), Date.parse("not a date") - io.now()),
          },
        }),
      },
      { cacheTtlMs: 0 },
    );
    await reader.get("db-url");
    await reader.get("db-url");
    expect(made.credential).toBe(2);
  });

  test("a refresh time that is not a number ends the credential's use at once", async () => {
    const { reader, made } = toy(
      {
        requestCredential: async () => ({
          ok: true,
          value: { credential: "a-credential", refreshAt: Number.NaN },
        }),
      },
      { cacheTtlMs: 0 },
    );
    await reader.get("db-url");
    await reader.get("db-url");
    expect(made.credential).toBe(2);
  });
});

describe("how a request is sent", () => {
  test("with the method, the headers and the body it was given, a time limit, and no redirect followed", async () => {
    const seen: { url: string; init: RequestInit | undefined; self: unknown }[] = [];
    const { reader } = toy(
      {
        requestSecret: async (name, credential, io) => {
          const response = await io.request(`https://store.example/secrets/${name}`, {
            method: "POST",
            headers: { authorization: `Bearer ${credential}` },
            body: '{"asked":true}',
          });
          return { ok: true, value: await response.text() };
        },
      },
      {
        fetch: function (this: unknown, input: Parameters<typeof fetch>[0], init?: RequestInit) {
          seen.push({ url: String(input), init, self: this });
          return Promise.resolve(new Response("a-stored-value"));
        } as typeof fetch,
      },
    );
    expect(await reader.get("db-url")).toBe("a-stored-value");
    expect(seen).toHaveLength(1);
    const sent = seen[0];
    expect(sent?.url).toBe("https://store.example/secrets/db-url");
    expect(sent?.init?.method).toBe("POST");
    expect(sent?.init?.headers).toEqual({ authorization: "Bearer credential-1" });
    expect(sent?.init?.body).toBe('{"asked":true}');
    expect(sent?.init?.redirect).toBe("manual");
    expect(sent?.init?.signal).toBeInstanceOf(AbortSignal);
    // Called as a plain function: an injected fetch is not handed the reader,
    // or the provider that holds it.
    expect(sent?.self).toBeUndefined();
  });
});

describe("an endpoint with an IPv6 address, and a proxy named in the environment", () => {
  const proxied = (extra: Record<string, string> = {}): Record<string, string | undefined> => ({
    HTTP_PROXY: "http://proxy.internal.example:3128",
    ...extra,
  });

  test("the address is listed in brackets, which the runtime matches, and bare", () => {
    const env = proxied();
    keepEndpointOffProxy(env, "http://[fd00:ec2::254]/latest/meta-data/");
    expect(env.NO_PROXY).toBe("[fd00:ec2::254],fd00:ec2::254");
    expect(env.no_proxy).toBe("[fd00:ec2::254],fd00:ec2::254");
  });

  test("a form that is already listed is not listed twice, and the other form is added", () => {
    const bare = proxied({ NO_PROXY: "localhost,::1" });
    keepEndpointOffProxy(bare, "http://[::1]:8080/token");
    expect(bare.NO_PROXY).toBe("localhost,::1,[::1]");

    const both = proxied({ no_proxy: "[FD20:CE::254],fd20:ce::254" });
    keepEndpointOffProxy(both, "http://[fd20:ce::254]/computeMetadata/v1/");
    expect(both.NO_PROXY).toBe("[FD20:CE::254],fd20:ce::254");
    expect(both.no_proxy).toBe("[FD20:CE::254],fd20:ce::254");
  });

  test("a name and an IPv4 address are listed once, as they are", () => {
    const name = proxied();
    keepEndpointOffProxy(name, "http://Metadata.Internal.Example/token");
    expect(name.NO_PROXY).toBe("metadata.internal.example");
    const v4 = proxied();
    keepEndpointOffProxy(v4, "http://169.254.169.254/latest/api/token");
    expect(v4.NO_PROXY).toBe("169.254.169.254");
  });

  // On a machine with no IPv6 loopback address this test is reported as
  // skipped. The three tests above still hold the list to its form.
  test.skipIf(!HAS_IPV6_LOOPBACK)("a request to the endpoint then goes straight to it, and the proxy never sees it", async () => {
    const endpoint = server(() => new Response("answered-by-the-endpoint"), "::1");
    const proxy = server(() => new Response("answered-by-the-proxy"));
    const child = Bun.spawn([process.execPath, new URL("./rig/endpoint-off-proxy-child.ts", import.meta.url).pathname], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        HTTP_PROXY: proxy.origin,
        http_proxy: proxy.origin,
        TEST_ENDPOINT: `${endpoint.origin}/token`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    const result = JSON.parse(stdout) as { before: string; after: string; noProxy: string | null };
    // The control: in that process the proxy carried a request to the
    // endpoint, until the endpoint was kept off it.
    expect(result.before).toBe("answered-by-the-proxy");
    expect(result.after).toBe("answered-by-the-endpoint");
    expect(result.noProxy).toBe("[::1],::1");
    expect(proxy.requests).toHaveLength(1);
    expect(endpoint.requests).toHaveLength(1);
  }, 20_000);
});
