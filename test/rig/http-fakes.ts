// Fake HTTP servers for tests of code that calls a service over a network:
// a local server whose handler a test can replace, the requests it received,
// and a way to send this process's requests for one host to it. Nothing here
// leaves this machine.

import { randomBytes } from "node:crypto";

/** A label plus random hex. Made at run time, so the repository holds no
 *  token-shaped or secret-shaped literal and every run uses different ones. */
export const randomLabel = (label: string): string => `${label}-${randomBytes(12).toString("hex")}`;

export type FakeHandler = (req: Request, url: URL) => Response | Promise<Response>;

export interface FakeHttpServer {
  /** `http://127.0.0.1:<port>`, or `http://[::1]:<port>` */
  origin: string;
  /** Every request received, in order. */
  requests: { path: string; query: URLSearchParams; headers: Headers }[];
  /** Replaceable, so a test can make the server fail in a chosen way. */
  handler: FakeHandler;
  stop(): Promise<void>;
}

/** `hostname` is the address to listen on: `127.0.0.1`, or `::1` for a test
 *  that needs an IPv6 address. It throws when this machine has no such address. */
export function fakeHttpServer(handler: FakeHandler, hostname = "127.0.0.1"): FakeHttpServer {
  const fake: FakeHttpServer = {
    origin: "",
    requests: [],
    handler,
    stop: async () => {
      await server.stop(true);
    },
  };
  const server = Bun.serve({
    port: 0,
    hostname,
    fetch: (req) => {
      const url = new URL(req.url);
      fake.requests.push({ path: url.pathname, query: url.searchParams, headers: req.headers });
      return fake.handler(req, url);
    },
  });
  fake.origin = `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${server.port}`;
  return fake;
}

export const jsonResponse = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/**
 * Send this process's requests for `https://<host>` to a fake server.
 *
 * A real provider sends its credential only to its service's own address, and
 * a local server cannot have that address. A test that runs the real provider
 * from its settings therefore lets it name the real address and redirects it
 * here, where requests leave the process. Install it before the provider is
 * built. Returns a function that undoes it.
 */
export function routeHostToFake(host: string, fake: FakeHttpServer): () => void {
  const real = globalThis.fetch;
  const routed = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== host) return real(input, init);
    return real(`${fake.origin}${url.pathname}${url.search}`, init);
  };
  globalThis.fetch = routed as unknown as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}
