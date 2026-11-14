import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";

import {
  artifactUrlDefect,
  fetchReleaseArtifact,
  listedReleaseHosts,
  ReleaseFetchRefused,
  type ReleaseSources,
} from "../../src/host/release-fetch";

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function fakeFetch(routes: Record<string, Route>): { fetchImpl: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    // The lookup is by a URL the test itself wrote.
    // eslint-disable-next-line security/detect-object-injection
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    return route(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

async function ruleOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "fetched";
  } catch (error) {
    return error instanceof ReleaseFetchRefused ? error.rule : `unexpected: ${String(error)}`;
  }
}

const redirect = (location: string, status = 302): Route => () =>
  new Response(null, { status, headers: { location } });

/** A fortress enrolled at control.example, whose operator listed nothing
 *  more. */
const CONTROL_PLANE: ReleaseSources = { controlPlaneOrigin: "https://control.example", hosts: [] };
/** The same, with one more host the operator listed. */
const CONTROL_PLANE_AND_CDN: ReleaseSources = { controlPlaneOrigin: "https://control.example", hosts: ["cdn.example"] };
const ARTIFACT = "https://control.example/_api/hx-gateway/download/modules/a.bin";

describe("where an artifact may come from", () => {
  test("the control plane's own origin, exactly", () => {
    expect(artifactUrlDefect(ARTIFACT, CONTROL_PLANE)).toBeNull();
    expect(artifactUrlDefect("https://control.example/a.bin?v=1", CONTROL_PLANE)).toBeNull();
    // Another port, another scheme or another name is another origin.
    expect(artifactUrlDefect("https://control.example:8443/a.bin", CONTROL_PLANE)).toBe("url_host_not_allowed");
    expect(artifactUrlDefect("http://control.example/a.bin", CONTROL_PLANE)).toBe("url_not_https");
    expect(artifactUrlDefect("https://control.example.evil.test/a.bin", CONTROL_PLANE)).toBe("url_host_not_allowed");
    expect(artifactUrlDefect("https://evil.test/control.example/a.bin", CONTROL_PLANE)).toBe("url_host_not_allowed");
    expect(artifactUrlDefect("https://sub.control.example/a.bin", CONTROL_PLANE)).toBe("url_host_not_allowed");
  });

  test("a host nobody listed is refused, public or not", () => {
    expect(artifactUrlDefect("https://github.com/owner/repo/releases/download/v1/a.bin", CONTROL_PLANE)).toBe(
      "url_host_not_allowed",
    );
    expect(artifactUrlDefect("https://storage.example/a.bin", CONTROL_PLANE)).toBe("url_host_not_allowed");
  });

  test("a host the operator listed, over https, on the port that was listed", () => {
    expect(artifactUrlDefect("https://cdn.example/a.bin", CONTROL_PLANE_AND_CDN)).toBeNull();
    expect(artifactUrlDefect("https://CDN.example./a.bin", CONTROL_PLANE_AND_CDN)).toBeNull();
    // A name alone is port 443. A listed file server is not thereby reachable
    // on whatever else it has open.
    expect(artifactUrlDefect("https://cdn.example:8443/a.bin", CONTROL_PLANE_AND_CDN)).toBe("url_host_not_allowed");
    const withPort: ReleaseSources = { controlPlaneOrigin: null, hosts: ["files.example:8443"] };
    expect(artifactUrlDefect("https://files.example:8443/a.bin", withPort)).toBeNull();
    expect(artifactUrlDefect("https://files.example/a.bin", withPort)).toBe("url_host_not_allowed");
    expect(artifactUrlDefect("https://files.example:9000/a.bin", withPort)).toBe("url_host_not_allowed");
    expect(listedReleaseHosts({ FORTRESS_RELEASE_HOSTS: "Files.Example:8443, cdn.example." })).toEqual([
      "files.example:8443",
      "cdn.example",
    ]);
    // Port 443 is the name alone, however it is written, because a URL drops it.
    const written: ReleaseSources = {
      controlPlaneOrigin: null,
      hosts: listedReleaseHosts({ FORTRESS_RELEASE_HOSTS: "cdn.example:443, [2001:db8::7]:8443, [2001:db8::9]" }),
    };
    expect(written.hosts).toEqual(["cdn.example", "2001:db8::7:8443", "2001:db8::9"]);
    expect(artifactUrlDefect("https://cdn.example:443/a.bin", written)).toBeNull();
    expect(artifactUrlDefect("https://cdn.example/a.bin", written)).toBeNull();
    expect(artifactUrlDefect("https://[2001:db8::7]:8443/a.bin", written)).toBeNull();
    expect(artifactUrlDefect("https://[2001:db8::7]/a.bin", written)).toBe("url_host_not_allowed");
    expect(artifactUrlDefect("https://[2001:db8::9]/a.bin", written)).toBeNull();
    expect(artifactUrlDefect("http://cdn.example/a.bin", CONTROL_PLANE_AND_CDN)).toBe("url_not_https");
    expect(artifactUrlDefect("https://other.example/a.bin", CONTROL_PLANE_AND_CDN)).toBe("url_host_not_allowed");
    expect(listedReleaseHosts({ FORTRESS_RELEASE_HOSTS: " CDN.Example ,, other.example " })).toEqual([
      "cdn.example",
      "other.example",
    ]);
    expect(listedReleaseHosts({})).toEqual([]);
  });

  test("never an inside address, even one the operator listed by mistake", () => {
    const listed: ReleaseSources = {
      controlPlaneOrigin: "https://control.example",
      hosts: ["169.254.169.254", "127.0.0.1", "10.0.0.8", "::1", "localhost"],
    };
    for (const url of [
      "https://169.254.169.254/latest/meta-data/",
      "https://127.0.0.1/a.bin",
      "https://10.0.0.8/a.bin",
      "https://192.168.1.10/a.bin",
      "https://[::1]/a.bin",
      "https://[fd00::1]/a.bin",
      "https://[::ffff:169.254.169.254]/a.bin",
      "https://2852039166/a.bin",
      "https://0x7f000001/a.bin",
    ]) {
      expect([url, artifactUrlDefect(url, listed)]).toEqual([url, "url_private_address"]);
    }
  });

  test("a name is not an address because of how it starts", () => {
    // Each of these would read as an inside address to a check written for
    // addresses: fc00::/7, fd00::/8, fe80::/10, and an octal first part.
    const names = ["fcm.example.com", "fd-api.example.com", "feature.example.com", "01.example.com"];
    const listed: ReleaseSources = { controlPlaneOrigin: null, hosts: names };
    for (const name of names) {
      expect([name, artifactUrlDefect(`https://${name}/a.bin`, listed)]).toEqual([name, null]);
    }
  });

  test("a control plane on this machine, as one in development is, may serve over its own cleartext origin", () => {
    const local: ReleaseSources = { controlPlaneOrigin: "http://127.0.0.1:9000", hosts: [] };
    expect(artifactUrlDefect("http://127.0.0.1:9000/_api/hx-gateway/download/a.bin", local)).toBeNull();
    // Only that origin: not another port on the same machine, and not another machine.
    expect(artifactUrlDefect("http://127.0.0.1:8788/ui/api/config", local)).toBe("url_not_https");
    expect(artifactUrlDefect("http://localhost:9000/a.bin", local)).toBe("url_not_https");
    expect(artifactUrlDefect("https://127.0.0.1:9000/a.bin", local)).toBe("url_private_address");
  });

  test("a fortress with no readable cloud URL fetches from nowhere it was not told about", () => {
    const none: ReleaseSources = { controlPlaneOrigin: null, hosts: [] };
    expect(artifactUrlDefect(ARTIFACT, none)).toBe("url_host_not_allowed");
    expect(artifactUrlDefect("https://cdn.example/a.bin", { controlPlaneOrigin: null, hosts: ["cdn.example"] })).toBeNull();
  });

  test("malformed, oversized, credentialed and non-web URLs are refused", () => {
    expect(artifactUrlDefect("https://u:p@control.example/a.bin", CONTROL_PLANE)).toBe("url_credentials");
    expect(artifactUrlDefect("ftp://control.example/a.bin", CONTROL_PLANE)).toBe("url_not_https");
    expect(artifactUrlDefect("file:///etc/passwd", CONTROL_PLANE)).toBe("url_not_https");
    expect(artifactUrlDefect("", CONTROL_PLANE)).toBe("url_malformed");
    expect(artifactUrlDefect("not a url", CONTROL_PLANE)).toBe("url_malformed");
    expect(artifactUrlDefect(`https://control.example/${"a".repeat(3000)}`, CONTROL_PLANE)).toBe("url_malformed");
    expect(artifactUrlDefect(undefined, CONTROL_PLANE)).toBe("url_malformed");
    expect(artifactUrlDefect(42, CONTROL_PLANE)).toBe("url_malformed");
  });
});

describe("fetching an artifact", () => {
  test("returns the bytes", async () => {
    const { fetchImpl } = fakeFetch({ [ARTIFACT]: () => new Response("hello") });
    const bytes = await fetchReleaseArtifact(ARTIFACT, { fetchImpl, sources: CONTROL_PLANE });
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });

  test("asks for the bytes as they are, and refuses a body that was encoded", async () => {
    const asked: (string | null)[] = [];
    const { fetchImpl } = fakeFetch({
      [ARTIFACT]: (_url, init) => {
        asked.push(new Headers(init?.headers).get("accept-encoding"));
        return new Response("small on the wire", { headers: { "content-encoding": "zstd" } });
      },
    });
    // A compressed body is counted after it is inflated, so the limit would see
    // it too late. It is refused by its header, before a byte is read.
    expect(await ruleOf(fetchReleaseArtifact(ARTIFACT, { fetchImpl, sources: CONTROL_PLANE }))).toBe("fetch_encoded");
    expect(asked).toEqual(["identity"]);
  });

  test("the real fetch: a compressed response is refused, and is never inflated", async () => {
    // Eight MiB that travel as eight KiB. The limit here is one MiB: counted as
    // they arrive, these bytes fit; inflated, they are eight times past it.
    const inflated = Buffer.alloc(8 * 1024 * 1024, 0x61);
    const wire = gzipSync(inflated);
    expect(wire.byteLength).toBeLessThan(64 * 1024);
    const asked: (string | null)[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        asked.push(request.headers.get("accept-encoding"));
        const named = new URL(request.url).pathname === "/named.bin";
        return new Response(wire, named ? { headers: { "content-encoding": "gzip" } } : {});
      },
    });
    try {
      // A control plane on this machine, as one in development is: its own
      // origin.
      const origin = `http://127.0.0.1:${server.port}`;
      const sources: ReleaseSources = { controlPlaneOrigin: origin, hosts: [] };
      const options = { sources, maxBytes: 1024 * 1024 };
      expect(await ruleOf(fetchReleaseArtifact(`${origin}/named.bin`, options))).toBe("fetch_encoded");
      // The same bytes with no encoding named are the file itself: they arrive
      // as they were sent, and are counted as they arrive.
      const plain = await fetchReleaseArtifact(`${origin}/plain.bin`, options);
      expect(plain.byteLength).toBe(wire.byteLength);
      expect(asked).toEqual(["identity", "identity"]);
    } finally {
      await server.stop(true);
    }
  });

  test("a URL that breaks the rule is never dialed", async () => {
    const { fetchImpl, seen } = fakeFetch({});
    expect(await ruleOf(fetchReleaseArtifact("https://storage.example/a.bin", { fetchImpl, sources: CONTROL_PLANE }))).toBe(
      "url_host_not_allowed",
    );
    expect(seen).toEqual([]);
  });

  test("never lets the runtime follow a redirect on its own", async () => {
    let seenRedirect: RequestRedirect | undefined;
    const { fetchImpl } = fakeFetch({
      [ARTIFACT]: (_url, init) => {
        seenRedirect = init?.redirect;
        return new Response("x");
      },
    });
    await fetchReleaseArtifact(ARTIFACT, { fetchImpl, sources: CONTROL_PLANE });
    expect(seenRedirect).toBe("manual");
  });

  test("follows a redirect within the allowed places", async () => {
    const { fetchImpl, seen } = fakeFetch({
      [ARTIFACT]: redirect("https://cdn.example/objects/a.bin"),
      "https://cdn.example/objects/a.bin": redirect("/objects/final.bin", 307),
      "https://cdn.example/objects/final.bin": () => new Response("bytes"),
    });
    const bytes = await fetchReleaseArtifact(ARTIFACT, { fetchImpl, sources: CONTROL_PLANE_AND_CDN });
    expect(new TextDecoder().decode(bytes)).toBe("bytes");
    expect(seen).toHaveLength(3);
  });

  test.each([
    "https://storage.example/a.bin",
    "http://control.example/a.bin",
    "https://169.254.169.254/latest/meta-data/",
    "https://127.0.0.1:8443/admin",
    "https://u:p@control.example/a.bin",
    "file:///etc/passwd",
  ])("refuses a redirect to %s, and never dials it", async (location) => {
    const { fetchImpl, seen } = fakeFetch({ [ARTIFACT]: redirect(location) });
    expect(await ruleOf(fetchReleaseArtifact(ARTIFACT, { fetchImpl, sources: CONTROL_PLANE }))).toBe(
      "fetch_redirect_refused",
    );
    expect(seen).toEqual([ARTIFACT]);
  });

  test("gives up on a redirect loop, and on a redirect with no location", async () => {
    const { fetchImpl, seen } = fakeFetch({ [ARTIFACT]: redirect(ARTIFACT) });
    expect(await ruleOf(fetchReleaseArtifact(ARTIFACT, { fetchImpl, sources: CONTROL_PLANE }))).toBe(
      "fetch_redirect_refused",
    );
    expect(seen.length).toBeLessThanOrEqual(6);
    const bare = fakeFetch({ [ARTIFACT]: () => new Response(null, { status: 302 }) });
    expect(await ruleOf(fetchReleaseArtifact(ARTIFACT, { fetchImpl: bare.fetchImpl, sources: CONTROL_PLANE }))).toBe(
      "fetch_redirect_refused",
    );
  });

  test("refuses a body past the limit, whatever Content-Length says", async () => {
    const big = new Uint8Array(4096);
    // An honest length is refused before a byte is read.
    const honest = fakeFetch({
      [ARTIFACT]: () => new Response(big, { headers: { "content-length": "4096" } }),
    });
    expect(
      await ruleOf(fetchReleaseArtifact(ARTIFACT, { fetchImpl: honest.fetchImpl, sources: CONTROL_PLANE, maxBytes: 1024 })),
    ).toBe("fetch_too_large");
    // A streamed body with no length is counted as it arrives.
    const streamed = fakeFetch({
      [ARTIFACT]: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let i = 0; i < 8; i += 1) controller.enqueue(new Uint8Array(512));
              controller.close();
            },
          }),
        ),
    });
    expect(
      await ruleOf(fetchReleaseArtifact(ARTIFACT, { fetchImpl: streamed.fetchImpl, sources: CONTROL_PLANE, maxBytes: 1024 })),
    ).toBe("fetch_too_large");
    // And a body exactly at the limit is fine.
    const exact = fakeFetch({ [ARTIFACT]: () => new Response(new Uint8Array(1024)) });
    const bytes = await fetchReleaseArtifact(ARTIFACT, {
      fetchImpl: exact.fetchImpl,
      sources: CONTROL_PLANE,
      maxBytes: 1024,
    });
    expect(bytes.byteLength).toBe(1024);
  });

  test("names a failed status, a failed connection and a timeout", async () => {
    const missing = fakeFetch({});
    expect(await ruleOf(fetchReleaseArtifact(ARTIFACT, { fetchImpl: missing.fetchImpl, sources: CONTROL_PLANE }))).toBe(
      "fetch_status",
    );
    const down = (async () => {
      throw new Error("ECONNREFUSED 10.1.2.3:443");
    }) as unknown as typeof fetch;
    expect(await ruleOf(fetchReleaseArtifact(ARTIFACT, { fetchImpl: down, sources: CONTROL_PLANE }))).toBe("fetch_failed");
    const hung = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    expect(
      await ruleOf(fetchReleaseArtifact(ARTIFACT, { fetchImpl: hung, sources: CONTROL_PLANE, timeoutMs: 20 })),
    ).toBe("fetch_timeout");
  });

  test("a refusal says which rule and never repeats the URL", async () => {
    const error = await fetchReleaseArtifact(`${ARTIFACT}?sig=secret-token`, {
      fetchImpl: fakeFetch({}).fetchImpl,
      sources: CONTROL_PLANE,
    }).catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain("secret-token");
  });
});
