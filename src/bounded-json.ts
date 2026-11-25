// One way to read a JSON answer from a server this fortress asked something.
//
// It reads with a size limit, so a server that is not what it should be cannot
// make this process hold a large answer. And it tells two failures apart that
// call for different words and different next steps:
//
//   - `not-json`: the whole body arrived and is not JSON, or it is too large.
//     Asking again gets the same answer.
//   - `cut`: the connection ended or stalled before the body was whole. The
//     server was reached and did not finish. Asking again may work.

export type JsonBody = { state: "json"; value: unknown } | { state: "not-json" } | { state: "cut" };

export type BoundedBody = { state: "whole"; bytes: Buffer } | { state: "too-large" } | { state: "cut" };

/**
 * The body of an answer, read with a size limit. `too-large` is said as soon as
 * the limit is passed, and the rest is not read. An answer with no body is
 * whole and empty. For an answer that is not JSON, or where a caller says "too
 * large" in words of its own.
 */
export async function readBoundedBytes(response: Response, limitBytes: number): Promise<BoundedBody> {
  const reader = response.body?.getReader();
  if (!reader) return { state: "whole", bytes: Buffer.alloc(0) };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) return { state: "too-large" };
      chunks.push(value);
    }
  } catch {
    return { state: "cut" };
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { state: "whole", bytes: Buffer.concat(chunks) };
}

export async function readBoundedJson(response: Response, limitBytes: number): Promise<JsonBody> {
  const body = await readBoundedBytes(response, limitBytes);
  if (body.state === "cut") return { state: "cut" };
  if (body.state === "too-large") return { state: "not-json" };
  try {
    return { state: "json", value: JSON.parse(body.bytes.toString("utf8")) as unknown };
  } catch {
    return { state: "not-json" };
  }
}

/**
 * What a request sends so that its answer arrives as it is on the wire.
 *
 * Without it the runtime inflates a compressed answer before any limit here
 * counts it: a few KiB on the wire can become many MiB in memory, and the
 * reader above sees them as one chunk. A caller that bounds an answer sends
 * these, and refuses an answer that says it is compressed all the same
 * (`isCompressed`), because nothing would inflate it.
 */
export const AS_ON_THE_WIRE = { decompress: false, headers: { "Accept-Encoding": "identity" } } as const;

/** True when an answer says it is compressed. */
export function isCompressed(response: Response): boolean {
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  return encoding !== undefined && encoding !== "" && encoding !== "identity";
}
