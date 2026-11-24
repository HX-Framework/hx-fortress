// The key of the control plane this HX Fortress is connected to.
//
// A control plane signs its grants with a key it keeps for the organization,
// and HX Fortress pins that key the first time it sees it. The control plane
// may later present a different key for the organization. HX Fortress takes
// the new one only with a proof: a signature, made with the control plane's
// OWN key, over the organization, the new key and a time. This file is about
// that second key, the one the proof is checked against.
//
// No key of any control plane is compiled into this program. HX Fortress
// learns the key of its control plane in one of three ways, and in this order:
//
//   1. The organization names it where HX Fortress runs:
//      `FORTRESS_CONTROL_PLANE_KEY`, in the environment of the daemon. Then
//      that is the key, and nothing a control plane says changes it.
//   2. A person pins it on this host, after reading its fingerprint:
//      `hx-fortress control-plane pin`.
//   3. HX Fortress pins the key the control plane publishes at the moment of
//      its FIRST enrollment: when it presented a one-time token and held no
//      key of the organization yet. Nobody reads a fingerprint then, so
//      HX Fortress writes the fingerprint to its log and to the audit trail.
//
// THE THIRD WAY HAPPENS ONCE, OR NEVER. At a first enrollment HX Fortress has
// nothing to protect yet: it takes the organization's key on first sight too.
// At any later moment it holds a key of the organization, and a key that it
// fetched then would be one the control plane chose in the same breath as the
// change it wants checked. So after the first enrollment nothing a control
// plane sends or publishes pins a key: not a frame, not another enrollment.
//
// An HX Fortress that holds no key of its control plane keeps working: the
// organization's key it already pinned stays pinned, and grants are checked
// against it as before. What it refuses, with no key to check a proof against,
// is a CHANGE of the organization's key. A person on this host then pins the
// control plane's key, and the change is taken at the next connection.
//
// What a control plane publishes
// ------------------------------
// `GET <base>/control-plane-keys`, where <base> is the control plane's address
// with `https` for `wss` and without its last path segment: the same base the
// pairing requests use (src/cloud/address.ts). The answer is JSON:
//
//   { "v": 1, "keys": [ { "id": "cp-2026-11", "publicKey": "<base64url>" } ] }
//
// `publicKey` is the raw 32-byte Ed25519 public key, base64url, with no padding.
// A control plane lists the key it signs with now, and may list the one it
// moves to next. 404 means it publishes none. A redirect is refused: the key
// has to come from the address HX Fortress connects to.

import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";

import { AS_ON_THE_WIRE, isCompressed, readBoundedBytes } from "../../bounded-json";
import { controlPlaneHttpBase } from "../../cloud/address";
import { sameControlPlane } from "../../setup/control-plane";
import type { Named } from "../daemon-environment";
import { writePrivateJson } from "../private-json";

export interface ControlPlaneKey {
  /** The control plane's own name for the key. Shown beside the fingerprint. */
  id: string;
  /** The raw 32-byte Ed25519 public key, base64url without padding. */
  publicKey: string;
}

export const CONTROL_PLANE_KEY_ENV = "FORTRESS_CONTROL_PLANE_KEY";

/** The most keys a control plane may publish, or a host may name. One it signs
 *  with and one it moves to next is the whole use; the rest is room. */
export const MAX_CONTROL_PLANE_KEYS = 4;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 32 bytes in base64url are 43 characters, with no padding. */
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const PUBLISHED_MAX_BYTES = 16 * 1024;
const PUBLISHED_TIMEOUT_MS = 10_000;

export class ControlPlaneKeyInvalid extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ControlPlaneKeyInvalid";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One key, checked. `where` names the place it was read, for the refusal. */
export function parseControlPlaneKey(value: unknown, where: string): ControlPlaneKey {
  if (!isRecord(value)) throw new ControlPlaneKeyInvalid(`${where} must hold an id and a publicKey`);
  const { id, publicKey } = value;
  if (typeof id !== "string" || !KEY_ID.test(id)) {
    throw new ControlPlaneKeyInvalid(
      `the id of ${where} must be 1 to 64 letters, digits, dots, dashes or underscores`,
    );
  }
  if (typeof publicKey !== "string" || !PUBLIC_KEY.test(publicKey)) {
    throw new ControlPlaneKeyInvalid(
      `the publicKey of ${where} must be a 32-byte Ed25519 public key in base64url, 43 characters`,
    );
  }
  // 43 characters can still spell something that is not 32 bytes of key: the
  // last character carries only two bits of the 256.
  if (Buffer.from(publicKey, "base64url").toString("base64url") !== publicKey) {
    throw new ControlPlaneKeyInvalid(`the publicKey of ${where} is not canonical base64url`);
  }
  return { id, publicKey };
}

/** A list of keys, checked: at most four, and no id twice. */
export function parseKeyList(value: unknown, where: string): ControlPlaneKey[] {
  if (!Array.isArray(value)) throw new ControlPlaneKeyInvalid(`${where} must be a list of keys`);
  if (value.length > MAX_CONTROL_PLANE_KEYS) {
    throw new ControlPlaneKeyInvalid(`${where} holds more than ${MAX_CONTROL_PLANE_KEYS} keys`);
  }
  const keys = value.map((entry, index) => parseControlPlaneKey(entry, `key ${index + 1} of ${where}`));
  const ids = new Set(keys.map((key) => key.id));
  if (ids.size !== keys.length) throw new ControlPlaneKeyInvalid(`${where} names one id twice`);
  return keys;
}

/**
 * A fingerprint a person can read aloud and compare: the first 128 bits of the
 * SHA-256 of the raw public key, as eight groups of four hex digits.
 */
export function keyFingerprint(key: Pick<ControlPlaneKey, "publicKey">): string {
  const digest = createHash("sha256").update(Buffer.from(key.publicKey, "base64url")).digest("hex");
  return (digest.slice(0, 32).match(/.{4}/g) ?? []).join(" ");
}

/** The fingerprint as a person may type it back: case and spaces do not count. */
export function sameFingerprint(a: string, b: string): boolean {
  const plain = (value: string): string => value.replace(/[\s:]/g, "").toLowerCase();
  return plain(a).length > 0 && plain(a) === plain(b);
}

// ── Where a control plane publishes its keys ─────────────────────────────────

/** Throws ControlPlaneKeyInvalid on a value that is not a control plane's address. */
export function publishedKeysUrl(address: string): string {
  try {
    return `${controlPlaneHttpBase(address)}/control-plane-keys`;
  } catch (error) {
    throw new ControlPlaneKeyInvalid(reasonOf(error));
  }
}

/**
 * The keys a control plane publishes now. An empty list means it publishes
 * none. Anything else that is not a well-formed answer is an error: the caller
 * must be able to tell "no key" from "could not ask".
 */
export async function fetchPublishedKeys(
  address: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<ControlPlaneKey[]> {
  const url = publishedKeysUrl(address);
  const doFetch = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      // The answer as it is on the wire: a compressed one would be inflated
      // before the limit below could count it.
      ...AS_ON_THE_WIRE,
      headers: { ...AS_ON_THE_WIRE.headers, accept: "application/json" },
      // The key has to come from the address HX Fortress connects to.
      redirect: "manual",
      // The deadline covers the answer's body too.
      signal: AbortSignal.timeout(PUBLISHED_TIMEOUT_MS),
    });
  } catch {
    throw new ControlPlaneKeyInvalid("the control plane did not answer when asked for its key");
  }
  if (!res.ok || isCompressed(res)) {
    // Nothing of such an answer is read.
    await res.body?.cancel().catch(() => {});
    if (res.status === 404) return [];
    if (res.status >= 300 && res.status < 400) {
      throw new ControlPlaneKeyInvalid(
        "the control plane answered with a redirect when asked for its key, and a redirect is not followed",
      );
    }
    throw new ControlPlaneKeyInvalid(
      res.ok
        ? "the control plane's answer about its key is compressed, and such an answer is not read"
        : `the control plane answered ${res.status} when asked for its key`,
    );
  }
  // Read with the limit: an answer that is longer is given up at the limit,
  // and no more of it is held.
  const answer = await readBoundedBytes(res, PUBLISHED_MAX_BYTES);
  if (answer.state === "too-large") {
    throw new ControlPlaneKeyInvalid("the control plane's answer about its key is too large");
  }
  if (answer.state === "cut") {
    throw new ControlPlaneKeyInvalid("the control plane's answer about its key did not arrive whole");
  }
  let body: unknown;
  try {
    body = JSON.parse(answer.bytes.toString("utf8"));
  } catch {
    throw new ControlPlaneKeyInvalid("the control plane's answer about its key is not JSON");
  }
  if (!isRecord(body) || body.v !== 1) {
    throw new ControlPlaneKeyInvalid("the control plane's answer about its key has an unknown form");
  }
  return parseKeyList(body.keys, "the control plane's answer");
}

// ── What an environment names ────────────────────────────────────────────────

/** `id:publicKey`, or several separated by commas. */
function keysFromEnv(value: string): ControlPlaneKey[] {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) throw new ControlPlaneKeyInvalid(`${CONTROL_PLANE_KEY_ENV} is set and empty`);
  return parseKeyList(
    entries.map((entry) => {
      const at = entry.indexOf(":");
      if (at < 0) {
        throw new ControlPlaneKeyInvalid(`${CONTROL_PLANE_KEY_ENV} must be written as <id>:<publicKey>`);
      }
      return { id: entry.slice(0, at), publicKey: entry.slice(at + 1) };
    }),
    CONTROL_PLANE_KEY_ENV,
  );
}

/** What an environment names for FORTRESS_CONTROL_PLANE_KEY: nothing, keys, or
 *  why the value is not one. */
export function controlPlaneKeyNamedBy(env: Record<string, string | undefined>): Named<ControlPlaneKey[]> {
  // A constant of this file names the variable.
  // eslint-disable-next-line security/detect-object-injection
  const given = env[CONTROL_PLANE_KEY_ENV];
  if (given === undefined) return null;
  try {
    return { value: keysFromEnv(given) };
  } catch (error) {
    return { invalid: reasonOf(error) };
  }
}

// ── The pin ─────────────────────────────────────────────────────────────────

export interface ControlPlanePin {
  v: 1;
  /** The connection address of the control plane these keys belong to. A pin
   *  for another control plane is not a pin for this one: see `pinFor`. */
  address: string;
  keys: ControlPlaneKey[];
  pinnedAt: string;
  /** `person`: somebody on this host read the fingerprint and pinned it.
   *  `enrollment`: HX Fortress pinned what was published at its first
   *  enrollment. */
  how: "person" | "enrollment";
}

export interface ControlPlaneKeyPaths {
  controlPlaneKeys: string;
}

function parsePin(value: unknown): ControlPlanePin | null {
  if (!isRecord(value) || value.v !== 1) return null;
  if (typeof value.address !== "string" || typeof value.pinnedAt !== "string") return null;
  if (value.how !== "person" && value.how !== "enrollment") return null;
  try {
    const keys = parseKeyList(value.keys, "the pinned keys");
    if (keys.length === 0) return null;
    return { v: 1, address: value.address, keys, pinnedAt: value.pinnedAt, how: value.how };
  } catch {
    return null;
  }
}

export class ControlPlaneKeyStore {
  constructor(
    private readonly paths: ControlPlaneKeyPaths,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  /** The pin file as it is, whichever control plane it was made for. A file
   *  that cannot be read as a pin is no pin: it is never half-trusted. */
  async readPin(): Promise<ControlPlanePin | null> {
    try {
      // HX Fortress's own pin file, under its identity folder.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      return parsePin(JSON.parse(await readFile(this.paths.controlPlaneKeys, "utf8")));
    } catch {
      return null;
    }
  }

  /**
   * The pin, when it was made for the control plane at `address`.
   *
   * "The same control plane" is the setup's own rule (`sameControlPlane`): the
   * address a person would give is the same. So a pin holds when only the
   * connection's own path changed, and a control plane under another path of
   * the same host is another control plane, as it is for the setup, and as the
   * address its key is asked at says.
   */
  async pinFor(address: string): Promise<ControlPlanePin | null> {
    const pin = await this.readPin();
    return pin && sameControlPlane(pin.address, address) ? pin : null;
  }

  /** The keys this process's environment names, or null when it names none.
   *  Throws on a value that is present and wrong: a mistyped key must not
   *  read as "no key". */
  named(): ControlPlaneKey[] | null {
    const named = controlPlaneKeyNamedBy(this.env);
    if (named && "invalid" in named) throw new ControlPlaneKeyInvalid(named.invalid);
    return named?.value ?? null;
  }

  /**
   * The keys a proof from the control plane at `address` is checked against.
   *
   * It never throws. A setting that is present and wrong yields no key, so a
   * proof fails closed, and `named()` is what tells a person why.
   */
  async trusted(address: string): Promise<ControlPlaneKey[]> {
    try {
      const named = this.named();
      if (named) return named;
    } catch {
      return [];
    }
    return (await this.pinFor(address))?.keys ?? [];
  }

  async pin(
    address: string,
    keys: readonly ControlPlaneKey[],
    how: ControlPlanePin["how"],
    now: Date = new Date(),
  ): Promise<ControlPlanePin> {
    // Throws on a value that is not a control plane's address.
    publishedKeysUrl(address);
    const checked = parseKeyList([...keys], "the keys to pin");
    if (checked.length === 0) throw new ControlPlaneKeyInvalid("there is no key to pin");
    const pin: ControlPlanePin = { v: 1, address, keys: checked, pinnedAt: now.toISOString(), how };
    await writePrivateJson(this.paths.controlPlaneKeys, pin, { pretty: true });
    return pin;
  }

  async forget(): Promise<void> {
    // HX Fortress's own pin file.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await rm(this.paths.controlPlaneKeys, { force: true });
  }
}

export type FirstEnrollmentPin =
  /** Nothing was asked: this host names the key, or a person pinned one for
   *  this control plane ahead of the enrollment. */
  | { outcome: "unchanged" }
  | { outcome: "pinned"; pin: ControlPlanePin }
  /** No key is pinned: the control plane publishes none, or it could not be
   *  read. `reason` says which. */
  | { outcome: "not-pinned"; reason: string };

/**
 * What HX Fortress does about the control plane's key at its FIRST
 * enrollment. The caller decides that it is one: this function does not know
 * whether a key of the organization is held.
 *
 * It never throws: an enrollment must not fail because a key could not be
 * read, and with no key pinned a later change of the organization's key is
 * refused, which is the safe side.
 */
export async function pinAtFirstEnrollment(
  store: ControlPlaneKeyStore,
  address: string,
  options: { fetchImpl?: typeof fetch; now?: () => Date } = {},
): Promise<FirstEnrollmentPin> {
  try {
    if (store.named() || (await store.pinFor(address))) return { outcome: "unchanged" };
    // Asked first, and the file is written only with an answer in hand: a
    // pin that is there for another control plane stays until it is replaced.
    const published = await fetchPublishedKeys(address, options.fetchImpl ? { fetchImpl: options.fetchImpl } : {});
    if (published.length === 0) return { outcome: "not-pinned", reason: "the control plane publishes no key" };
    return {
      outcome: "pinned",
      pin: await store.pin(address, published, "enrollment", options.now?.() ?? new Date()),
    };
  } catch (error) {
    return { outcome: "not-pinned", reason: reasonOf(error) };
  }
}
