// The key of the control plane an HX Fortress is connected to: where it comes
// from, how it is pinned, and what a wrong or missing one does. Every key here
// is made for the test and thrown away with it.

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CONTROL_PLANE_KEY_ENV,
  ControlPlaneKeyInvalid,
  ControlPlaneKeyStore,
  MAX_CONTROL_PLANE_KEYS,
  controlPlaneKeyNamedBy,
  fetchPublishedKeys,
  keyFingerprint,
  parseControlPlaneKey,
  parseKeyList,
  pinAtFirstEnrollment,
  publishedKeysUrl,
  sameFingerprint,
  type ControlPlaneKey,
  type ControlPlanePin,
} from "../src/host/trust/control-plane-keys";
import { controlPlaneHttpBase, readControlPlaneAddress } from "../src/cloud/address";

const ADDRESS = "wss://control.example/v1/connection";
/** Where the control plane at ADDRESS publishes its keys. */
const KEYS_URL = "https://control.example/v1/control-plane-keys";
/** The same control plane, at the path an earlier build of the protocol used. */
const EARLIER_PATH = "wss://control.example/_api/hx-gateway/vault-tunnel";
const OTHER_CONTROL_PLANE = "wss://old.control.example/v1/connection";

async function makeKey(id: string): Promise<ControlPlaneKey> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { id, publicKey: Buffer.from(raw).toString("base64url") };
}

async function makeKeys(count: number, prefix = "k"): Promise<ControlPlaneKey[]> {
  return Promise.all(Array.from({ length: count }, (_, i) => makeKey(`${prefix}${i + 1}`)));
}

const asEnv = (keys: readonly ControlPlaneKey[]): string => keys.map((key) => `${key.id}:${key.publicKey}`).join(",");

/** A control plane that answers every request for its keys the same way, and
 *  remembers each request as it was sent. */
function publishing(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const asked: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (input: string | URL | Request, options?: RequestInit) => {
    asked.push({ url: String(input), init: options });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: init.headers ?? { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, asked, urls: (): string[] => asked.map((request) => request.url) };
}

/** A control plane that does not answer at all. */
const down = (async () => {
  throw new Error("connect ECONNREFUSED");
}) as unknown as typeof fetch;

/** A text of exactly `bytes` bytes that is the answer `{ v: 1, keys }`. */
function paddedAnswer(keys: readonly ControlPlaneKey[], bytes: number): string {
  const text = JSON.stringify({ v: 1, keys });
  return text + " ".repeat(bytes - Buffer.byteLength(text));
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function folder(config?: unknown): Promise<{ config: string; controlPlaneKeys: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hx-fortress-control-plane-keys-"));
  dirs.push(dir);
  const paths = {
    config: path.join(dir, "config.json"),
    controlPlaneKeys: path.join(dir, "identity", "control-plane-keys.json"),
  };
  if (config !== undefined) await writeFile(paths.config, typeof config === "string" ? config : JSON.stringify(config));
  return paths;
}

describe("a control plane's key", () => {
  test("is an id and a 32-byte Ed25519 public key, and anything else is refused", async () => {
    const key = await makeKey("cp-2026-11");
    expect(parseControlPlaneKey(key, "a test")).toEqual(key);
    const refused = [
      null,
      "a string",
      { id: key.id },
      { id: "", publicKey: key.publicKey },
      { id: "has a space", publicKey: key.publicKey },
      { id: "x".repeat(65), publicKey: key.publicKey },
      { id: key.id, publicKey: key.publicKey.slice(0, 42) },
      { id: key.id, publicKey: `${key.publicKey}=` },
      { id: key.id, publicKey: key.publicKey.replace(/.$/, "+") },
    ];
    for (const value of refused) {
      expect(() => parseControlPlaneKey(value, "a test")).toThrow(ControlPlaneKeyInvalid);
    }
  });

  test("43 characters that do not spell 32 bytes exactly are refused", () => {
    // The last character of 43 carries two bits. "B" there sets bits that no
    // 32-byte value has, so decoding and encoding again gives another string.
    const notCanonical = `${"A".repeat(42)}B`;
    expect(() => parseControlPlaneKey({ id: "k", publicKey: notCanonical }, "a test")).toThrow(/canonical/);
  });

  test("has a fingerprint a person can compare, and typing it back loosely still matches", async () => {
    const key = await makeKey("cp-2026-11");
    const fingerprint = keyFingerprint(key);
    expect(fingerprint).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
    expect(keyFingerprint(key)).toBe(fingerprint);
    const other = keyFingerprint(await makeKey("other"));
    expect(other).not.toBe(fingerprint);
    expect(sameFingerprint(fingerprint, fingerprint.toUpperCase().replace(/ /g, ":"))).toBe(true);
    expect(sameFingerprint(fingerprint, fingerprint.replace(/ /g, ""))).toBe(true);
    expect(sameFingerprint(fingerprint, other)).toBe(false);
    // Half a fingerprint is not the fingerprint.
    expect(sameFingerprint(fingerprint, fingerprint.slice(0, 19))).toBe(false);
    expect(sameFingerprint(fingerprint, "")).toBe(false);
    expect(sameFingerprint("", "")).toBe(false);
  });

  test("the fingerprint is the first 128 bits of the SHA-256 of the raw 32-byte key, so a control plane can state the same one", async () => {
    const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
    const first128Bits = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const key = { id: "cp-2026-11", publicKey: Buffer.from(raw).toString("base64url") };
    expect(keyFingerprint(key).replace(/ /g, "")).toBe(first128Bits);
  });

  test("a list of keys holds at most four, and no id twice", async () => {
    const four = await makeKeys(MAX_CONTROL_PLANE_KEYS);
    expect(parseKeyList(four, "a test")).toEqual(four);
    expect(parseKeyList([], "a test")).toEqual([]);
    const five = await makeKeys(MAX_CONTROL_PLANE_KEYS + 1);
    expect(() => parseKeyList(five, "a test")).toThrow("a test holds more than 4 keys");
    const [a, b] = four as [ControlPlaneKey, ControlPlaneKey];
    expect(() => parseKeyList([a, { ...b, id: a.id }], "a test")).toThrow("a test names one id twice");
    expect(() => parseKeyList({ keys: [a] }, "a test")).toThrow("a test must be a list of keys");
    expect(() => parseKeyList(null, "a test")).toThrow(ControlPlaneKeyInvalid);
    // A key that is wrong is named by its place in the list.
    expect(() => parseKeyList([a, { id: "b", publicKey: "short" }], "a test")).toThrow("key 2 of a test");
  });

  test("an environment names nothing, keys, or a value that is not one, with the reason, and never throws", async () => {
    const [a, b] = (await makeKeys(2)) as [ControlPlaneKey, ControlPlaneKey];
    expect(controlPlaneKeyNamedBy({})).toBeNull();
    expect(controlPlaneKeyNamedBy({ [CONTROL_PLANE_KEY_ENV]: undefined })).toBeNull();
    expect(controlPlaneKeyNamedBy({ [CONTROL_PLANE_KEY_ENV]: asEnv([a]) })).toEqual({ value: [a] });
    // The key in use and the next one, with spaces around them and a comma at the end.
    expect(controlPlaneKeyNamedBy({ [CONTROL_PLANE_KEY_ENV]: ` ${a.id}:${a.publicKey} , ${b.id}:${b.publicKey} ,` })).toEqual(
      { value: [a, b] },
    );
    expect(controlPlaneKeyNamedBy({ [CONTROL_PLANE_KEY_ENV]: "" })).toEqual({
      invalid: "FORTRESS_CONTROL_PLANE_KEY is set and empty",
    });
    expect(controlPlaneKeyNamedBy({ [CONTROL_PLANE_KEY_ENV]: " , " })).toEqual({
      invalid: "FORTRESS_CONTROL_PLANE_KEY is set and empty",
    });
    expect(controlPlaneKeyNamedBy({ [CONTROL_PLANE_KEY_ENV]: "no-colon" })).toEqual({
      invalid: "FORTRESS_CONTROL_PLANE_KEY must be written as <id>:<publicKey>",
    });
    const wrong: [string, string][] = [
      [`${a.id}:tooshort`, "the publicKey of key 1 of FORTRESS_CONTROL_PLANE_KEY"],
      [`${a.id}:${a.publicKey},${a.id}:${b.publicKey}`, "FORTRESS_CONTROL_PLANE_KEY names one id twice"],
      [asEnv(await makeKeys(5)), "FORTRESS_CONTROL_PLANE_KEY holds more than 4 keys"],
      [`has space:${a.publicKey}`, "the id of key 1 of FORTRESS_CONTROL_PLANE_KEY"],
    ];
    for (const [value, reason] of wrong) {
      const named = controlPlaneKeyNamedBy({ [CONTROL_PLANE_KEY_ENV]: value });
      expect(named !== null && "invalid" in named ? named.invalid : null).toContain(reason);
    }
  });
});

describe("where a control plane publishes its keys", () => {
  test("beside the address HX Fortress connects to, over https", () => {
    expect(publishedKeysUrl(ADDRESS)).toBe(KEYS_URL);
    // An HX Fortress that enrolled earlier asks beside the address it has.
    expect(publishedKeysUrl(EARLIER_PATH)).toBe("https://control.example/_api/hx-gateway/control-plane-keys");
    // The same rule for any path: the last segment is the connection itself.
    expect(publishedKeysUrl("wss://control.example:8443/fortress/link?x=1#y")).toBe(
      "https://control.example:8443/fortress/control-plane-keys",
    );
    expect(publishedKeysUrl("wss://user:pw@control.example/a/connection/")).toBe(
      "https://control.example/a/control-plane-keys",
    );
    expect(publishedKeysUrl("wss://control.example")).toBe("https://control.example/control-plane-keys");
  });

  test("clear text only to this host itself", () => {
    expect(publishedKeysUrl("ws://127.0.0.1:9000/hub/connection")).toBe(
      "http://127.0.0.1:9000/hub/control-plane-keys",
    );
    expect(publishedKeysUrl("ws://control.example/hub/connection")).toBe(
      "https://control.example/hub/control-plane-keys",
    );
  });

  test("an address that is not a control plane's is refused", () => {
    for (const address of ["https://control.example/x", "control.example", "", "not an address"]) {
      expect(() => publishedKeysUrl(address)).toThrow(ControlPlaneKeyInvalid);
    }
  });

  test("the request is sent so that the answer is read as it is on the wire, and a redirect is not followed", async () => {
    const cp = publishing({ v: 1, keys: [await makeKey("cp-now")] });
    await fetchPublishedKeys(ADDRESS, { fetchImpl: cp.fetchImpl });
    expect(cp.urls()).toEqual([KEYS_URL]);
    const sent = cp.asked[0]?.init as (RequestInit & { decompress?: boolean }) | undefined;
    expect(sent?.redirect).toBe("manual");
    // A compressed answer would be inflated before the limit could count it.
    expect(sent?.decompress).toBe(false);
    const headers = new Headers(sent?.headers);
    expect(headers.get("accept-encoding")).toBe("identity");
    expect(headers.get("accept")).toBe("application/json");
    // A request with a deadline: the signal is there, and has not fired.
    expect(sent?.signal).toBeInstanceOf(AbortSignal);
    expect(sent?.signal?.aborted).toBe(false);
  });

  test("the answer is read as a list of keys", async () => {
    const [now, next] = [await makeKey("cp-now"), await makeKey("cp-next")];
    const cp = publishing({ v: 1, keys: [now, next] });
    expect(await fetchPublishedKeys(ADDRESS, { fetchImpl: cp.fetchImpl })).toEqual([now, next]);
    expect(cp.urls()).toEqual([KEYS_URL]);
    // An answer that says it is not compressed is read as any other.
    const plain = publishing({ v: 1, keys: [now] }, { headers: { "content-type": "application/json", "content-encoding": "identity" } });
    expect(await fetchPublishedKeys(ADDRESS, { fetchImpl: plain.fetchImpl })).toEqual([now]);
  });

  test("404 means it publishes none", async () => {
    const cp = publishing("not found", { status: 404 });
    expect(await fetchPublishedKeys(ADDRESS, { fetchImpl: cp.fetchImpl })).toEqual([]);
  });

  test("a redirect is refused, and the address it names is never asked", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const cp = publishing("moved", { status, headers: { location: "https://elsewhere.example/control-plane-keys" } });
      await expect(fetchPublishedKeys(ADDRESS, { fetchImpl: cp.fetchImpl })).rejects.toThrow(
        "the control plane answered with a redirect when asked for its key, and a redirect is not followed",
      );
      expect(cp.urls()).toEqual([KEYS_URL]);
    }
  });

  test("a compressed answer is refused, also when what it holds would be a list of keys", async () => {
    const key = await makeKey("cp-now");
    for (const encoding of ["gzip", "br", "deflate"]) {
      const cp = publishing({ v: 1, keys: [key] }, { headers: { "content-type": "application/json", "content-encoding": encoding } });
      await expect(fetchPublishedKeys(ADDRESS, { fetchImpl: cp.fetchImpl })).rejects.toThrow(
        "the control plane's answer about its key is compressed, and such an answer is not read",
      );
    }
  });

  test("any other status is refused by its number, so 'no key' is never mistaken for 'could not ask'", async () => {
    for (const status of [400, 401, 403, 410, 429, 500, 503]) {
      const cp = publishing("no", { status });
      await expect(fetchPublishedKeys(ADDRESS, { fetchImpl: cp.fetchImpl })).rejects.toThrow(
        `the control plane answered ${status} when asked for its key`,
      );
    }
  });

  test("an answer that is not JSON, or not of the known form, or not a list of good keys, is refused", async () => {
    const key = await makeKey("cp-now");
    const wrong: [unknown, string][] = [
      ["<html>", "the control plane's answer about its key is not JSON"],
      ["", "the control plane's answer about its key is not JSON"],
      [[], "the control plane's answer about its key has an unknown form"],
      [null, "the control plane's answer about its key has an unknown form"],
      [JSON.stringify("a string"), "the control plane's answer about its key has an unknown form"],
      [{ v: 2, keys: [key] }, "the control plane's answer about its key has an unknown form"],
      [{ v: "1", keys: [key] }, "the control plane's answer about its key has an unknown form"],
      [{ v: 1 }, "the control plane's answer must be a list of keys"],
      [{ v: 1, keys: [key, key] }, "the control plane's answer names one id twice"],
      [{ v: 1, keys: [{ id: "x", publicKey: "short" }] }, "the publicKey of key 1 of the control plane's answer"],
      [{ v: 1, keys: await makeKeys(5) }, "the control plane's answer holds more than 4 keys"],
    ];
    for (const [body, reason] of wrong) {
      const cp = publishing(body);
      const error = await fetchPublishedKeys(ADDRESS, { fetchImpl: cp.fetchImpl }).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ControlPlaneKeyInvalid);
      expect((error as Error).message).toContain(reason);
    }
  });

  test("a control plane that does not answer is said so", async () => {
    await expect(fetchPublishedKeys(ADDRESS, { fetchImpl: down })).rejects.toThrow(
      "the control plane did not answer when asked for its key",
    );
  });

  test("an answer of 16 KiB is read, one byte more is too large, and an endless one is given up at the limit", async () => {
    const key = await makeKey("cp-now");
    const exactly = publishing(paddedAnswer([key], 16 * 1024));
    expect(await fetchPublishedKeys(ADDRESS, { fetchImpl: exactly.fetchImpl })).toEqual([key]);
    const over = publishing(paddedAnswer([key], 16 * 1024 + 1));
    await expect(fetchPublishedKeys(ADDRESS, { fetchImpl: over.fetchImpl })).rejects.toThrow(
      "the control plane's answer about its key is too large",
    );

    let pulled = 0;
    const endless = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            controller.enqueue(new Uint8Array(4096).fill(0x20));
          },
        }),
      )) as unknown as typeof fetch;
    await expect(fetchPublishedKeys(ADDRESS, { fetchImpl: endless })).rejects.toThrow("is too large");
    // 16 KiB is five chunks of 4 KiB. The answer has no end, and reading stopped.
    expect(pulled).toBeLessThan(10);
  });

  test("an answer that ends before it is whole is said so", async () => {
    const cut = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error("the connection ended"));
          },
        }),
      )) as unknown as typeof fetch;
    await expect(fetchPublishedKeys(ADDRESS, { fetchImpl: cut })).rejects.toThrow(
      "the control plane's answer about its key did not arrive whole",
    );
  });
});

describe("a control plane's address", () => {
  test("its https base is the address without its last path segment", () => {
    expect(controlPlaneHttpBase(ADDRESS)).toBe("https://control.example/v1");
    // The path of an HX Fortress that enrolled earlier.
    expect(controlPlaneHttpBase(EARLIER_PATH)).toBe("https://control.example/_api/hx-gateway");
    expect(controlPlaneHttpBase("wss://control.example")).toBe("https://control.example");
    expect(controlPlaneHttpBase("wss://control.example/")).toBe("https://control.example");
    expect(controlPlaneHttpBase("wss://control.example/connect")).toBe("https://control.example");
    expect(controlPlaneHttpBase("wss://control.example/v1/connection/")).toBe("https://control.example/v1");
    expect(controlPlaneHttpBase("wss://control.example:8443/a/b/c")).toBe("https://control.example:8443/a/b");
    // What belongs to the connection alone is dropped.
    expect(controlPlaneHttpBase("wss://user:secret@control.example/v1/connection?x=1#y")).toBe(
      "https://control.example/v1",
    );
    expect(controlPlaneHttpBase("ws://localhost:9000/cp/_api/hx-gateway/vault-tunnel")).toBe(
      "http://localhost:9000/cp/_api/hx-gateway",
    );
    // Clear text to another host is never worked out from a `ws` address.
    expect(controlPlaneHttpBase("ws://control.example/connection")).toBe("https://control.example");
    expect(() => controlPlaneHttpBase("https://control.example")).toThrow(/wss:\/\//);
    expect(() => controlPlaneHttpBase("control.example")).toThrow(/not an address/);
  });

  test("is read from config.json, and an HX Fortress with none, or with a file that cannot be read, has none", async () => {
    expect(await readControlPlaneAddress(await folder())).toBeNull();
    expect(await readControlPlaneAddress(await folder({ schemaVersion: 1, modules: { enabled: [] } }))).toBeNull();
    expect(await readControlPlaneAddress(await folder({ cloud: { url: "https://not-a-control-plane.example" } }))).toBeNull();
    expect(await readControlPlaneAddress(await folder({ cloud: { url: 7 } }))).toBeNull();
    expect(await readControlPlaneAddress(await folder("{ not json"))).toBeNull();
    expect(await readControlPlaneAddress(await folder({ cloud: { url: ADDRESS } }))).toBe(ADDRESS);
  });
});

describe("the pin, and the keys an HX Fortress trusts", () => {
  test("none, until one is named or pinned", async () => {
    const store = new ControlPlaneKeyStore(await folder(), {});
    expect(await store.readPin()).toBeNull();
    expect(await store.pinFor(ADDRESS)).toBeNull();
    expect(store.named()).toBeNull();
    expect(await store.trusted(ADDRESS)).toEqual([]);
  });

  test("a pin is a private file that holds the connection's address, the keys, when, and how", async () => {
    const paths = await folder();
    const store = new ControlPlaneKeyStore(paths, {});
    const key = await makeKey("cp-now");
    const pin = await store.pin(ADDRESS, [key], "person", new Date("2026-11-12T09:00:00.000Z"));
    expect(pin).toEqual({ v: 1, address: ADDRESS, keys: [key], pinnedAt: "2026-11-12T09:00:00.000Z", how: "person" });
    expect(JSON.parse(await readFile(paths.controlPlaneKeys, "utf8"))).toEqual(pin);
    expect((await stat(paths.controlPlaneKeys)).mode & 0o777).toBe(0o600);
    expect(await store.readPin()).toEqual(pin);
    expect(await store.trusted(ADDRESS)).toEqual([key]);

    // Pinned again over a file that somebody made readable: the new pin is
    // the owner's alone again.
    await chmod(paths.controlPlaneKeys, 0o644);
    const next = await makeKey("cp-next");
    const again = await store.pin(ADDRESS, [next], "enrollment", new Date("2026-11-13T09:00:00.000Z"));
    expect((await stat(paths.controlPlaneKeys)).mode & 0o777).toBe(0o600);
    expect(await store.readPin()).toEqual(again);
    expect(await store.trusted(ADDRESS)).toEqual([next]);

    await store.forget();
    expect(await store.readPin()).toBeNull();
    expect(await store.trusted(ADDRESS)).toEqual([]);
    // Forgetting with nothing pinned is not an error.
    await store.forget();
  });

  test("a pin holds for the control plane it was made for, at either path of the protocol, and for no other", async () => {
    const store = new ControlPlaneKeyStore(await folder(), {});
    const key = await makeKey("cp-now");
    const pin = await store.pin(ADDRESS, [key], "person");

    expect(await store.pinFor(ADDRESS)).toEqual(pin);
    // The same address a person would give, control.example, with the path an
    // earlier build connected at: the same control plane.
    expect(await store.pinFor(EARLIER_PATH)).toEqual(pin);
    expect(await store.trusted(EARLIER_PATH)).toEqual([key]);

    const others = [
      // Another path prefix on the same host is another control plane.
      "wss://control.example/other/v1/connection",
      // Another host, and another port.
      "wss://other.example/v1/connection",
      "wss://control.example:8443/v1/connection",
      // A connection address of another shape is the same only as itself.
      "wss://control.example/v1/elsewhere",
    ];
    for (const address of others) {
      expect(await store.pinFor(address)).toBeNull();
      expect(await store.trusted(address)).toEqual([]);
    }
    // The file is still there for the control plane it was made for.
    expect(await store.readPin()).toEqual(pin);
  });

  test("the keys this process's environment names win over a pin, and config.json names no key", async () => {
    const [pinned, inConfig, inEnv] = [await makeKey("pinned"), await makeKey("in-config"), await makeKey("in-env")];
    // A key written into config.json is not read: a rewrite of that file by
    // the setup would drop it without a word, and the key would then be
    // whatever is published.
    const paths = await folder({ schemaVersion: 1, cloud: { url: ADDRESS, key: inConfig } });
    await new ControlPlaneKeyStore(paths, {}).pin(ADDRESS, [pinned], "person");
    expect(await new ControlPlaneKeyStore(paths, {}).trusted(ADDRESS)).toEqual([pinned]);
    const named = new ControlPlaneKeyStore(paths, { [CONTROL_PLANE_KEY_ENV]: asEnv([inEnv]) });
    expect(named.named()).toEqual([inEnv]);
    expect(await named.trusted(ADDRESS)).toEqual([inEnv]);
    // Also for an address the pin is not for: the named key is the key.
    expect(await named.trusted("wss://other.example/v1/connection")).toEqual([inEnv]);
  });

  test("named() gives null, the keys, or throws on a value that is present and wrong", async () => {
    const [a, b] = (await makeKeys(2)) as [ControlPlaneKey, ControlPlaneKey];
    expect(new ControlPlaneKeyStore(await folder(), {}).named()).toBeNull();
    expect(new ControlPlaneKeyStore(await folder(), { [CONTROL_PLANE_KEY_ENV]: asEnv([a, b]) }).named()).toEqual([a, b]);
    const wrong = new ControlPlaneKeyStore(await folder(), { [CONTROL_PLANE_KEY_ENV]: "no-colon" });
    expect(() => wrong.named()).toThrow(ControlPlaneKeyInvalid);
    expect(() => wrong.named()).toThrow("FORTRESS_CONTROL_PLANE_KEY must be written as <id>:<publicKey>");
  });

  test("a value that is present and wrong yields no key at all, never throws, and a pin does not stand in for it", async () => {
    const key = await makeKey("a");
    for (const value of ["", "no-colon", `${key.id}:tooshort`, `${key.id}:${key.publicKey},${key.id}:${key.publicKey}`]) {
      const store = new ControlPlaneKeyStore(await folder(), { [CONTROL_PLANE_KEY_ENV]: value });
      await store.pin(ADDRESS, [key], "person");
      expect(await store.trusted(ADDRESS)).toEqual([]);
      expect(() => store.named()).toThrow(ControlPlaneKeyInvalid);
    }
  });

  test("a pin file that is not a pin is no pin", async () => {
    const paths = await folder();
    const store = new ControlPlaneKeyStore(paths, {});
    const key = await makeKey("a");
    await store.pin(ADDRESS, [key], "person");
    const good = JSON.parse(await readFile(paths.controlPlaneKeys, "utf8")) as Record<string, unknown>;
    const noAddress = Object.fromEntries(Object.entries(good).filter(([name]) => name !== "address"));
    for (const broken of [
      "{ not json",
      "",
      "null",
      "[]",
      JSON.stringify("a pin"),
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, v: "1" }),
      JSON.stringify({ ...good, keys: [] }),
      JSON.stringify({ ...good, keys: undefined }),
      JSON.stringify({ ...good, keys: [{ id: "a", publicKey: "short" }] }),
      JSON.stringify({ ...good, keys: [key, key] }),
      JSON.stringify({ ...good, how: "somehow" }),
      JSON.stringify({ ...good, how: undefined }),
      JSON.stringify({ ...good, pinnedAt: undefined }),
      JSON.stringify(noAddress),
      JSON.stringify({ ...noAddress, origin: "wss://control.example" }),
      JSON.stringify({ ...good, address: 7 }),
    ]) {
      await writeFile(paths.controlPlaneKeys, broken);
      expect(await store.readPin()).toBeNull();
      expect(await store.pinFor(ADDRESS)).toBeNull();
      expect(await store.trusted(ADDRESS)).toEqual([]);
    }
  });

  test("nothing is pinned for an address that is not a control plane's, without a key, with more than four, or with one id twice, and the pin before stays", async () => {
    const paths = await folder();
    const store = new ControlPlaneKeyStore(paths, {});
    const key = await makeKey("a");
    await store.pin(ADDRESS, [key], "person", new Date("2026-11-12T09:00:00.000Z"));
    const before = await readFile(paths.controlPlaneKeys, "utf8");

    for (const address of ["https://control.example", "control.example", "not an address", ""]) {
      await expect(store.pin(address, [key], "person")).rejects.toThrow(ControlPlaneKeyInvalid);
    }
    await expect(store.pin(ADDRESS, [], "person")).rejects.toThrow("there is no key to pin");
    await expect(store.pin(ADDRESS, await makeKeys(5), "person")).rejects.toThrow("holds more than 4 keys");
    await expect(store.pin(ADDRESS, [key, { ...(await makeKey("b")), id: key.id }], "person")).rejects.toThrow(
      "names one id twice",
    );
    await expect(store.pin(ADDRESS, [{ id: "b", publicKey: "short" }], "person")).rejects.toThrow(ControlPlaneKeyInvalid);

    expect(await readFile(paths.controlPlaneKeys, "utf8")).toBe(before);
  });
});

describe("at a first enrollment", () => {
  test("the keys the control plane publishes are pinned for the address that was dialed, as pinned at the enrollment", async () => {
    const paths = await folder();
    const store = new ControlPlaneKeyStore(paths, {});
    const [now, next] = [await makeKey("cp-now"), await makeKey("cp-next")];
    const cp = publishing({ v: 1, keys: [now, next] });
    const outcome = await pinAtFirstEnrollment(store, ADDRESS, {
      fetchImpl: cp.fetchImpl,
      now: () => new Date("2026-11-12T09:00:00.000Z"),
    });
    const pin: ControlPlanePin = {
      v: 1,
      address: ADDRESS,
      keys: [now, next],
      pinnedAt: "2026-11-12T09:00:00.000Z",
      how: "enrollment",
    };
    expect(outcome).toEqual({ outcome: "pinned", pin });
    expect(cp.urls()).toEqual([KEYS_URL]);
    expect(await store.readPin()).toEqual(pin);
    expect((await stat(paths.controlPlaneKeys)).mode & 0o777).toBe(0o600);
    expect(await store.trusted(ADDRESS)).toEqual([now, next]);
  });

  test("nothing is asked when this process's environment names the key", async () => {
    const key = await makeKey("named");
    const store = new ControlPlaneKeyStore(await folder(), { [CONTROL_PLANE_KEY_ENV]: asEnv([key]) });
    const cp = publishing({ v: 1, keys: [await makeKey("published")] });
    expect(await pinAtFirstEnrollment(store, ADDRESS, { fetchImpl: cp.fetchImpl })).toEqual({ outcome: "unchanged" });
    expect(cp.urls()).toEqual([]);
    expect(await store.readPin()).toBeNull();
  });

  test("nothing is asked when a key is pinned for this control plane, and the pin stays as it is", async () => {
    for (const how of ["person", "enrollment"] as const) {
      for (const pinnedAt of [ADDRESS, EARLIER_PATH]) {
        const paths = await folder();
        const store = new ControlPlaneKeyStore(paths, {});
        await store.pin(pinnedAt, [await makeKey("pinned-ahead")], how, new Date("2026-11-01T00:00:00.000Z"));
        const before = await readFile(paths.controlPlaneKeys, "utf8");
        const cp = publishing({ v: 1, keys: [await makeKey("published")] });
        expect(await pinAtFirstEnrollment(store, ADDRESS, { fetchImpl: cp.fetchImpl })).toEqual({ outcome: "unchanged" });
        expect(cp.urls()).toEqual([]);
        expect(await readFile(paths.controlPlaneKeys, "utf8")).toBe(before);
      }
    }
  });

  test("with nothing named and nothing pinned, every answer that is not a list of keys pins nothing, and says why", async () => {
    const key = await makeKey("cp-now");
    const answers: [typeof fetch, string][] = [
      [publishing("not found", { status: 404 }).fetchImpl, "the control plane publishes no key"],
      [down, "the control plane did not answer when asked for its key"],
      [
        publishing("moved", { status: 302, headers: { location: "https://elsewhere.example/keys" } }).fetchImpl,
        "the control plane answered with a redirect when asked for its key, and a redirect is not followed",
      ],
      [
        publishing({ v: 1, keys: [key] }, { headers: { "content-encoding": "gzip" } }).fetchImpl,
        "the control plane's answer about its key is compressed, and such an answer is not read",
      ],
      [publishing("oops", { status: 500 }).fetchImpl, "the control plane answered 500 when asked for its key"],
      [publishing(paddedAnswer([key], 16 * 1024 + 1)).fetchImpl, "the control plane's answer about its key is too large"],
      [publishing("<html>").fetchImpl, "the control plane's answer about its key is not JSON"],
      [publishing({ v: 2, keys: [key] }).fetchImpl, "the control plane's answer about its key has an unknown form"],
      [publishing({ v: 1, keys: await makeKeys(5) }).fetchImpl, "the control plane's answer holds more than 4 keys"],
    ];
    for (const [fetchImpl, reason] of answers) {
      const store = new ControlPlaneKeyStore(await folder(), {});
      expect(await pinAtFirstEnrollment(store, ADDRESS, { fetchImpl })).toEqual({ outcome: "not-pinned", reason });
      expect(await store.readPin()).toBeNull();
      expect(await store.trusted(ADDRESS)).toEqual([]);
    }
  });

  test("a value in the environment that is not a key pins nothing, and the control plane is not asked", async () => {
    const env = { [CONTROL_PLANE_KEY_ENV]: "no-colon" };
    const store = new ControlPlaneKeyStore(await folder(), env);
    const cp = publishing({ v: 1, keys: [await makeKey("published")] });
    expect(await pinAtFirstEnrollment(store, ADDRESS, { fetchImpl: cp.fetchImpl })).toEqual({
      outcome: "not-pinned",
      reason: "FORTRESS_CONTROL_PLANE_KEY must be written as <id>:<publicKey>",
    });
    expect(cp.urls()).toEqual([]);
    expect(await store.readPin()).toBeNull();
  });

  test("it never throws: an address that is not a control plane's, or a pin that cannot be written, pins nothing", async () => {
    const key = await makeKey("cp-now");
    const store = new ControlPlaneKeyStore(await folder(), {});
    const cp = publishing({ v: 1, keys: [key] });
    expect(await pinAtFirstEnrollment(store, "https://control.example", { fetchImpl: cp.fetchImpl })).toEqual({
      outcome: "not-pinned",
      reason: "the control plane's address must start with wss://",
    });
    expect(cp.urls()).toEqual([]);

    // The folder the pin goes in is a file.
    const paths = await folder();
    await writeFile(path.dirname(paths.controlPlaneKeys), "not a folder");
    const unwritable = new ControlPlaneKeyStore(paths, {});
    const outcome = await pinAtFirstEnrollment(unwritable, ADDRESS, { fetchImpl: cp.fetchImpl });
    expect(outcome.outcome).toBe("not-pinned");
    expect(await unwritable.readPin()).toBeNull();
  });

  test("a pin held for another control plane stays on disk when nothing is pinned, and is replaced when a key is", async () => {
    const paths = await folder();
    const store = new ControlPlaneKeyStore(paths, {});
    const old = await store.pin(OTHER_CONTROL_PLANE, [await makeKey("old")], "person", new Date("2026-11-01T00:00:00.000Z"));
    const before = await readFile(paths.controlPlaneKeys, "utf8");
    const key = await makeKey("cp-now");

    for (const fetchImpl of [
      publishing("not found", { status: 404 }).fetchImpl,
      publishing("oops", { status: 500 }).fetchImpl,
      down,
      publishing("<html>").fetchImpl,
    ]) {
      expect((await pinAtFirstEnrollment(store, ADDRESS, { fetchImpl })).outcome).toBe("not-pinned");
      expect(await readFile(paths.controlPlaneKeys, "utf8")).toBe(before);
      // It is still no pin for this control plane.
      expect(await store.pinFor(ADDRESS)).toBeNull();
      expect(await store.readPin()).toEqual(old);
    }

    const cp = publishing({ v: 1, keys: [key] });
    const outcome = await pinAtFirstEnrollment(store, ADDRESS, {
      fetchImpl: cp.fetchImpl,
      now: () => new Date("2026-11-12T09:00:00.000Z"),
    });
    expect(outcome.outcome).toBe("pinned");
    expect(await store.readPin()).toEqual({
      v: 1,
      address: ADDRESS,
      keys: [key],
      pinnedAt: "2026-11-12T09:00:00.000Z",
      how: "enrollment",
    });
    expect(await store.pinFor(OTHER_CONTROL_PLANE)).toBeNull();
  });
});
