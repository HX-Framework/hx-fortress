// A download follows a redirect by hand, and only to https: nothing the far
// side answers makes this host ask another host for anything in clear text.

import { afterEach, describe, expect, test } from "bun:test";

import { followingHttpsRedirects, RedirectRefused, redirectTarget } from "../src/https-redirects";

/** What `redirectTarget` threw, or "followed: <address>". */
function outcome(from: string, location: string | null): string {
  try {
    return `followed: ${redirectTarget(from, location)}`;
  } catch (error) {
    expect(error).toBeInstanceOf(RedirectRefused);
    return (error as Error).message;
  }
}

describe("where a redirect may lead", () => {
  test("a relative address is read against the address that answered", () => {
    expect(redirectTarget("http://127.0.0.1:9000/releases/hx-fortress-version", "/store/hx-fortress-version")).toBe(
      "http://127.0.0.1:9000/store/hx-fortress-version",
    );
    expect(redirectTarget("http://127.0.0.1:9000/releases/hx-fortress-version", "v2/hx-fortress-version")).toBe(
      "http://127.0.0.1:9000/releases/v2/hx-fortress-version",
    );
    expect(redirectTarget("https://updates.northstar.example/a/b/file", "../c/file")).toBe(
      "https://updates.northstar.example/a/c/file",
    );
  });

  test("an https address is followed, on any host", () => {
    expect(redirectTarget("https://updates.northstar.example/x", "https://objects.northstar.example/store/x?sig=abc")).toBe(
      "https://objects.northstar.example/store/x?sig=abc",
    );
    // From an address on this host itself, too.
    expect(redirectTarget("http://127.0.0.1:9000/x", "https://objects.northstar.example/x")).toBe(
      "https://objects.northstar.example/x",
    );
  });

  test("an http address is followed only on the origin that answered", () => {
    expect(outcome("http://127.0.0.1:9000/x", "http://127.0.0.1:9000/y")).toBe("followed: http://127.0.0.1:9000/y");
    // Another port, or another name for this host, is another origin.
    expect(outcome("http://127.0.0.1:9000/x", "http://127.0.0.1:9001/y")).toBe(
      "the answer is a redirect to http://127.0.0.1:9001, and a redirect is followed only to an https address",
    );
    expect(outcome("http://127.0.0.1:9000/x", "http://localhost:9000/y")).toBe(
      "the answer is a redirect to http://localhost:9000, and a redirect is followed only to an https address",
    );
    expect(outcome("http://127.0.0.1:9000/x", "http://objects.northstar.example/y")).toBe(
      "the answer is a redirect to http://objects.northstar.example, and a redirect is followed only to an https address",
    );
  });

  test("an https address never leads down to http, also on the same host", () => {
    expect(outcome("https://updates.northstar.example/x", "http://updates.northstar.example/y")).toBe(
      "the answer is a redirect to http://updates.northstar.example, and a redirect is followed only to an https address",
    );
  });

  test("an address that names no scheme takes the scheme of the one that answered", () => {
    expect(outcome("https://updates.northstar.example/x", "//objects.northstar.example/y")).toBe(
      "followed: https://objects.northstar.example/y",
    );
    expect(outcome("http://127.0.0.1:9000/x", "//objects.northstar.example/y")).toBe(
      "the answer is a redirect to http://objects.northstar.example, and a redirect is followed only to an https address",
    );
  });

  test("an address of another kind than https is refused", () => {
    for (const location of ["file:///etc/hosts", "data:text/plain,1.2.3", "ftp://objects.northstar.example/y"]) {
      expect([location, outcome("https://updates.northstar.example/x", location)]).toEqual([
        location,
        expect.stringContaining("and a redirect is followed only to an https address") as string,
      ]);
    }
  });

  test("an address that holds a user name or a password is refused, and the password is not repeated", () => {
    // Put together here, so that no password-shaped text is written in the file.
    const password = ["Tr0ub4dor", "and", "3"].join("-");
    for (const location of [
      "https://updater@objects.northstar.example/y",
      `https://updater:${password}@objects.northstar.example/y`,
      `https://:${password}@objects.northstar.example/y`,
    ]) {
      const said = outcome("https://updates.northstar.example/x", location);
      expect([location, said]).toEqual([
        location,
        "the answer is a redirect to an address that holds a user name or a password",
      ]);
    }
  });

  test("a redirect that names no address, or text that is no address, is refused", () => {
    expect(outcome("https://updates.northstar.example/x", null)).toBe("the answer is a redirect that names no address");
    expect(outcome("https://updates.northstar.example/x", "")).toBe("the answer is a redirect that names no address");
    expect(outcome("https://updates.northstar.example/x", "http://[")).toBe(
      "the answer is a redirect to something that is not an address",
    );
  });
});

interface Call {
  url: string;
  init: RequestInit & { decompress?: boolean };
}

/** A fetch that answers with `answer`, and keeps each request it was given. */
function standIn(answer: (url: string, hop: number) => Response): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, init: init ?? {} });
    return answer(url, calls.length - 1);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const redirect = (location: string, status = 302): Response =>
  new Response(null, { status, headers: { location } });

/** What a call threw. Fails the test when it did not throw. */
async function refused(work: Promise<unknown>): Promise<RedirectRefused> {
  const settled = await work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  if (!("error" in settled)) throw new Error("expected the redirect to be refused");
  expect(settled.error).toBeInstanceOf(RedirectRefused);
  return settled.error as RedirectRefused;
}

describe("a fetch that follows redirects only under the rule", () => {
  test("an answer that is no redirect is given back untouched, after one request", async () => {
    for (const status of [200, 204, 404, 500]) {
      const answer = new Response(status === 204 ? null : `answer ${status}`, { status, headers: { "x-kept": "yes" } });
      const { fetchImpl, calls } = standIn(() => answer);
      const response = await followingHttpsRedirects(fetchImpl)("https://updates.northstar.example/x");
      expect([status, response === answer, calls.length]).toEqual([status, true, 1]);
    }
  });

  test("an answer of the 300s that is no redirect is given back untouched", async () => {
    // A 304 says the copy the asker holds is current. It leads nowhere, and
    // it is not a redirect that "names no address".
    const answer = new Response(null, { status: 304 });
    const { fetchImpl, calls } = standIn(() => answer);
    expect(await followingHttpsRedirects(fetchImpl)("https://updates.northstar.example/x")).toBe(answer);
    expect(calls).toHaveLength(1);
  });

  test("every request leaves with redirect manual, also when the caller asked for another", async () => {
    const { fetchImpl, calls } = standIn((_url, hop) =>
      hop === 0 ? redirect("https://objects.northstar.example/y") : new Response("1.2.3"),
    );
    await followingHttpsRedirects(fetchImpl)("https://updates.northstar.example/x", { redirect: "follow" });
    expect(calls.map((call) => call.init.redirect)).toEqual(["manual", "manual"]);
  });

  test("the caller's request goes with every hop: its headers, its deadline and the rest", async () => {
    const headers = { "Accept-Encoding": "identity", "User-Agent": "hx-fortress/0.0.0-test" };
    const signal = AbortSignal.timeout(5_000);
    const { fetchImpl, calls } = standIn((_url, hop) =>
      hop < 2 ? redirect(`https://objects.northstar.example/hop-${hop + 1}`) : new Response("1.2.3"),
    );
    const init = { method: "GET", headers, signal, decompress: false } as RequestInit;
    const response = await followingHttpsRedirects(fetchImpl)("https://updates.northstar.example/x", init);
    expect(await response.text()).toBe("1.2.3");
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.init.headers).toBe(headers);
      expect(call.init.signal).toBe(signal);
      expect(call.init.method).toBe("GET");
      expect(call.init.decompress).toBe(false);
    }
  });

  test("a relative address is read against the hop that answered it, not the first request", async () => {
    const { fetchImpl, calls } = standIn((_url, hop) => {
      if (hop === 0) return redirect("https://objects.northstar.example/store/a/first");
      if (hop === 1) return redirect("second");
      return new Response("1.2.3");
    });
    await followingHttpsRedirects(fetchImpl)("https://updates.northstar.example/releases/x");
    expect(calls.map((call) => call.url)).toEqual([
      "https://updates.northstar.example/releases/x",
      "https://objects.northstar.example/store/a/first",
      "https://objects.northstar.example/store/a/second",
    ]);
  });

  test("each kind of redirect is followed", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { fetchImpl, calls } = standIn((_url, hop) =>
        hop === 0 ? redirect("https://objects.northstar.example/y", status) : new Response("1.2.3"),
      );
      const response = await followingHttpsRedirects(fetchImpl)("https://updates.northstar.example/x");
      expect([status, response.status, calls.length]).toEqual([status, 200, 2]);
    }
  });

  test("five redirects in a row are followed", async () => {
    const { fetchImpl, calls } = standIn((_url, hop) =>
      hop < 5 ? redirect(`https://objects.northstar.example/hop-${hop + 1}`) : new Response("1.2.3"),
    );
    const response = await followingHttpsRedirects(fetchImpl)("https://updates.northstar.example/x");
    expect(await response.text()).toBe("1.2.3");
    expect(calls).toHaveLength(6);
  });

  test("a sixth redirect in a row is refused, and no seventh request is made", async () => {
    const { fetchImpl, calls } = standIn((_url, hop) => redirect(`https://objects.northstar.example/hop-${hop + 1}`));
    const error = await refused(followingHttpsRedirects(fetchImpl)("https://updates.northstar.example/x"));
    expect(error.message).toBe("the answer is one redirect after another");
    expect(calls).toHaveLength(6);
  });

  test("a redirect the rule refuses is not followed: the other host is never asked", async () => {
    const { fetchImpl, calls } = standIn(() => redirect("http://objects.northstar.example/hx-fortress-version"));
    const error = await refused(followingHttpsRedirects(fetchImpl)("https://updates.northstar.example/x"));
    expect(error.message).toBe(
      "the answer is a redirect to http://objects.northstar.example, and a redirect is followed only to an https address",
    );
    expect(calls.map((call) => call.url)).toEqual(["https://updates.northstar.example/x"]);
  });

  test("a redirect that names no address is refused", async () => {
    const { fetchImpl } = standIn(() => new Response(null, { status: 302 }));
    const error = await refused(followingHttpsRedirects(fetchImpl)("https://updates.northstar.example/x"));
    expect(error.message).toBe("the answer is a redirect that names no address");
  });

  test("the body of a redirect is let go, not read", async () => {
    let letGo = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("Moved. "));
      },
      cancel() {
        letGo = true;
      },
    });
    const { fetchImpl } = standIn((_url, hop) =>
      hop === 0
        ? new Response(body, { status: 302, headers: { location: "https://objects.northstar.example/y" } })
        : new Response("1.2.3"),
    );
    await followingHttpsRedirects(fetchImpl)("https://updates.northstar.example/x");
    expect(letGo).toBe(true);
  });
});

describe("with the runtime's own fetch", () => {
  const servers: Array<ReturnType<typeof Bun.serve>> = [];
  afterEach(() => {
    for (const server of servers.splice(0)) void server.stop(true);
  });
  function serve(answer: (pathname: string) => Response): { origin: string; asked: string[] } {
    const asked: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);
        asked.push(pathname);
        return answer(pathname);
      },
    });
    servers.push(server);
    return { origin: `http://127.0.0.1:${server.port}`, asked };
  }

  test("a redirect on the origin that answered is followed", async () => {
    const source = serve((pathname) =>
      pathname === "/releases/hx-fortress-version"
        ? new Response(null, { status: 302, headers: { location: "/store/hx-fortress-version" } })
        : new Response("3.4.5"),
    );
    const response = await followingHttpsRedirects()(`${source.origin}/releases/hx-fortress-version`);
    expect(await response.text()).toBe("3.4.5");
    expect(source.asked).toEqual(["/releases/hx-fortress-version", "/store/hx-fortress-version"]);
  });

  test("a redirect to plain http on another origin is refused, and that origin is never asked", async () => {
    const elsewhere = serve(() => new Response("6.6.6"));
    const source = serve(
      () => new Response(null, { status: 302, headers: { location: `${elsewhere.origin}/hx-fortress-version` } }),
    );
    await refused(followingHttpsRedirects()(`${source.origin}/hx-fortress-version`));
    expect(source.asked).toEqual(["/hx-fortress-version"]);
    expect(elsewhere.asked).toEqual([]);
  });
});
