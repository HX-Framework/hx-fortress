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

export async function readBoundedJson(response: Response, limitBytes: number): Promise<JsonBody> {
  const reader = response.body?.getReader();
  if (!reader) return { state: "not-json" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) return { state: "not-json" };
      chunks.push(value);
    }
  } catch {
    return { state: "cut" };
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return { state: "json", value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { state: "not-json" };
  }
}
