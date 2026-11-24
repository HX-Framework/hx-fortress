// The one bounded reader: an answer is read with a size limit, and no more of
// it is read once the limit is passed.

import { afterEach, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";

import { AS_ON_THE_WIRE, isCompressed, readBoundedBytes, readBoundedJson } from "../src/bounded-json";

/** An answer whose body arrives in chunks of `size` bytes, `count` of them at
 *  most, and that counts how many were asked for. `failAt` makes that chunk an
 *  error, as a connection that ends early does. */
function chunked(size: number, count: number, failAt?: number): { response: Response; pulled: () => number } {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      if (failAt !== undefined && pulled === failAt) {
        controller.error(new Error("the connection ended"));
        return;
      }
      if (pulled > count) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
  return { response: new Response(body), pulled: () => pulled };
}

describe("an answer read with a size limit", () => {
  test("a whole answer under the limit is given back as it arrived", async () => {
    expect(await readBoundedBytes(new Response("1.4.0\n"), 64)).toEqual({ state: "whole", bytes: Buffer.from("1.4.0\n") });
    const exact = await readBoundedBytes(chunked(16, 4).response, 64);
    expect(exact.state === "whole" && exact.bytes.byteLength).toBe(64);
  });

  test("an answer over the limit is given up at the limit, and the rest is not read", async () => {
    const long = chunked(1024, 10_000);
    expect(await readBoundedBytes(long.response, 4096)).toEqual({ state: "too-large" });
    // Five chunks pass the limit. Nothing like the ten thousand is asked for.
    expect(long.pulled()).toBeLessThan(10);
  });

  test("an answer that ends before it is whole is said to be cut", async () => {
    expect(await readBoundedBytes(chunked(16, 100, 3).response, 4096)).toEqual({ state: "cut" });
  });

  test("an answer with no body is whole and empty", async () => {
    expect(await readBoundedBytes(new Response(null, { status: 204 }), 64)).toEqual({ state: "whole", bytes: Buffer.alloc(0) });
  });

  test("the JSON reader tells JSON, what is not JSON or too large, and a cut answer apart", async () => {
    expect(await readBoundedJson(Response.json({ a: 1 }), 64)).toEqual({ state: "json", value: { a: 1 } });
    expect(await readBoundedJson(new Response("<html>"), 64)).toEqual({ state: "not-json" });
    expect(await readBoundedJson(new Response(JSON.stringify({ a: "x".repeat(100) })), 64)).toEqual({ state: "not-json" });
    expect(await readBoundedJson(new Response(null, { status: 204 }), 64)).toEqual({ state: "not-json" });
    expect(await readBoundedJson(chunked(16, 100, 2).response, 4096)).toEqual({ state: "cut" });
  });
});

// A limit counts what arrives. If the runtime inflated a compressed answer
// first, a few KiB on the wire could become many MiB before the limit saw them.
describe("an answer taken as it is on the wire", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  afterEach(() => {
    void server?.stop(true);
    server = null;
  });

  /** A server that compresses its answer whatever it is asked, as a server
   *  that is not what it should be may do, and keeps what it was asked. */
  function compressingServer(plain: string): { url: string; asked: Array<string | null> } {
    const asked: Array<string | null> = [];
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        asked.push(request.headers.get("accept-encoding"));
        return new Response(gzipSync(plain), { headers: { "content-encoding": "gzip" } });
      },
    });
    return { url: `http://127.0.0.1:${server.port}/answer`, asked };
  }

  test("asks for no compression, and a compressed answer arrives compressed, to be counted as it is", async () => {
    const plain = "a".repeat(100_000);
    const { url, asked } = compressingServer(plain);
    const response = await fetch(url, { ...AS_ON_THE_WIRE });
    expect(asked).toEqual(["identity"]);
    // The bytes on the wire: far fewer than the text they hold, and still gzip.
    const body = await readBoundedBytes(response, 4096);
    expect(body.state).toBe("whole");
    if (body.state === "whole") {
      expect(body.bytes.byteLength).toBeLessThan(4096);
      expect([body.bytes[0], body.bytes[1]]).toEqual([0x1f, 0x8b]);
    }
    expect(isCompressed(response)).toBe(true);
  });

  test("without it, the runtime would inflate the answer before any limit saw it", async () => {
    // What the constant is for: the same answer, asked the runtime's own way.
    const plain = "a".repeat(100_000);
    const { url } = compressingServer(plain);
    const response = await fetch(url);
    expect(await readBoundedBytes(response, 4096)).toEqual({ state: "too-large" });
  });
});

describe("whether an answer says it is compressed", () => {
  const answer = (encoding?: string): Response =>
    new Response("1.2.3", encoding === undefined ? {} : { headers: { "content-encoding": encoding } });

  test.each(["gzip", "br", "deflate", "zstd", "GZIP", " gzip ", "gzip, identity"])("%p is compressed", (encoding) => {
    expect(isCompressed(answer(encoding))).toBe(true);
  });

  test.each([undefined, "", "identity", " Identity "])("%p is not compressed", (encoding) => {
    expect(isCompressed(answer(encoding))).toBe(false);
  });
});
