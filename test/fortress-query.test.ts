import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SUPPORTED_PROTOCOL_VERSION, WsCloudConnection } from "../src/cloud/connection";
import {
  FORTRESS_QUERY_TIMEOUT_MS,
  FortressQueryRegistry,
  FortressQueryUnavailable,
  isFortressQueryAnswer,
  MAX_IN_FLIGHT_QUERIES,
  POSTURE_STALE_AFTER_MS,
  postureFreshness,
  postureQualification,
  RoutingPostureCache,
} from "../src/cloud/fortress-query";
import type { FortressToHubFrame, HubToFortressFrame } from "../src/protocol";
import type { CloudCredential } from "../src/cloud/credentials";
import type { FortressConfig, HostLogger, MessageDispatcher } from "../src/host/types";
import { FakeHub } from "./fake-hub";

const TEST_TIMING = { heartbeatMs: 5_000, reconnectMinMs: 10, reconnectMaxMs: 50 };
const IDENTITY = { version: "0.0.0-test", protocolVersion: SUPPORTED_PROTOCOL_VERSION };
const CREDENTIAL: CloudCredential = {
  orgId: "test-org",
  fortressId: "test-fortress",
  credential: "test-credential",
};

const POSTURE = { cloudOnlySessions: 3, routedHere: 41, computedAt: "2026-07-31T09:00:00.000Z" };

function config(url: string): FortressConfig {
  return {
    schemaVersion: 1,
    cloud: { url },
    gateway: { publicUrl: "http://localhost:8787" },
    modules: { enabled: [] },
  };
}

function deps(overrides: Partial<ConstructorParameters<typeof WsCloudConnection>[0]> = {}) {
  const dispatcher: MessageDispatcher = { dispatch: async () => undefined };
  const logger: HostLogger = { error() {} };
  return {
    dispatcher,
    logger,
    identity: IDENTITY,
    credentialStore: {
      load: async (): Promise<CloudCredential | null> => CREDENTIAL,
      save: async (): Promise<void> => {},
    },
    ...TEST_TIMING,
    ...overrides,
  };
}

describe("who sends which frame", () => {
  test("the direction comes from the protocol package, not from this repo", () => {
    // These four lines are the pin. They are assignments to the PACKAGE's unions,
    // so they only compile while `fortressQuery` travels fortress→hub and the two
    // answers travel hub→fortress. This file used to re-declare the three
    // envelopes locally, which typechecks against itself forever: the local copy
    // agreed with a comment claiming the opposite direction, and nothing could
    // have caught the day the package moved one.
    const asked: FortressToHubFrame = {
      t: "fortressQuery",
      id: "fq-1",
      query: { kind: "routingPosture" },
    };
    const answered: HubToFortressFrame = {
      t: "fortressQueryResult",
      id: "fq-1",
      result: { kind: "routingPosture", routingPosture: POSTURE },
    };
    const refused: HubToFortressFrame = { t: "fortressQueryError", id: "fq-1", error: "nope" };
    expect([asked.t, answered.t, refused.t]).toEqual([
      "fortressQuery",
      "fortressQueryResult",
      "fortressQueryError",
    ]);
    // And the narrowing the registry settles on is those two answers, no wider.
    expect(isFortressQueryAnswer(answered)).toBe(true);
    expect(isFortressQueryAnswer(refused)).toBe(true);
    expect(isFortressQueryAnswer(asked)).toBe(false);
  });
});

describe("the query registry", () => {
  test("correlates each answer to its own caller", async () => {
    const registry = new FortressQueryRegistry();
    const first = registry.open();
    const second = registry.open();
    expect(first.id).not.toBe(second.id);
    expect(registry.inFlight).toBe(2);

    registry.settle({ t: "fortressQueryResult", id: second.id, result: { kind: "routingPosture", routingPosture: POSTURE } });
    await expect(second.answer).resolves.toMatchObject({ kind: "routingPosture" });
    expect(registry.inFlight).toBe(1);

    registry.settle({ t: "fortressQueryResult", id: first.id, result: { kind: "residencyWitness", residencyWitness: [] } });
    await expect(first.answer).resolves.toMatchObject({ kind: "residencyWitness" });
  });

  test("drops an answer to a question nobody is holding", () => {
    const registry = new FortressQueryRegistry();
    expect(registry.settle({ t: "fortressQueryError", id: "never-asked", error: "x" })).toBe(false);
  });

  test("a timeout ends the wait as unavailable, never as an answer", async () => {
    const registry = new FortressQueryRegistry();
    const opened = registry.open(20);
    const err = (await opened.answer.catch((e: unknown) => e)) as FortressQueryUnavailable;
    expect(err).toBeInstanceOf(FortressQueryUnavailable);
    expect(err.cause_).toBe("timeout");
    expect(registry.inFlight).toBe(0);
  });

  test("bounds in-flight questions rather than accumulating promises", async () => {
    const registry = new FortressQueryRegistry();
    const held = Array.from({ length: MAX_IN_FLIGHT_QUERIES }, () => registry.open(5_000));
    const refused = registry.open();
    expect(refused.id).toBe("");
    const err = (await refused.answer.catch((e: unknown) => e)) as FortressQueryUnavailable;
    expect(err.cause_).toBe("saturated");
    registry.drain("closed");
    for (const one of held) await expect(one.answer).rejects.toBeInstanceOf(FortressQueryUnavailable);
  });

  test("drain fails everything outstanding with its reason", async () => {
    const registry = new FortressQueryRegistry();
    const opened = registry.open(5_000);
    expect(registry.drain("offline")).toBe(1);
    const err = (await opened.answer.catch((e: unknown) => e)) as FortressQueryUnavailable;
    expect(err.cause_).toBe("offline");
  });

  test("the timeout budget leaves room for a caller's own deadline", () => {
    expect(FORTRESS_QUERY_TIMEOUT_MS).toBe(10_000);
  });
});

describe("request() over a live connection", () => {
  let hub: FakeHub;
  let connection: WsCloudConnection | null = null;

  afterEach(async () => {
    await connection?.close();
    connection = null;
    await hub.stop();
  });

  test("carries the question and returns the hub's answer", async () => {
    hub = await FakeHub.create({
      answerQuery: (query) =>
        query.kind === "routingPosture"
          ? { result: { kind: "routingPosture", routingPosture: POSTURE } }
          : { result: { kind: "residencyWitness", residencyWitness: [] } },
    });
    connection = new WsCloudConnection(deps());
    await connection.open(config(hub.url));
    const answer = await connection.request({ kind: "routingPosture" });
    expect(answer).toEqual({ kind: "routingPosture", routingPosture: POSTURE });
    expect(hub.received().some((f) => f.t === "fortressQuery")).toBe(true);
  });

  test("a hub that never learned the frame times out as unavailable", async () => {
    hub = await FakeHub.create(); // no answerQuery: silence, exactly like an old hub
    connection = new WsCloudConnection(deps());
    await connection.open(config(hub.url));
    const err = (await connection
      .request({ kind: "routingPosture" }, 40)
      .catch((e: unknown) => e)) as FortressQueryUnavailable;
    expect(err).toBeInstanceOf(FortressQueryUnavailable);
    expect(err.cause_).toBe("timeout");
  });

  test("an error answer is unavailable, not a negative result", async () => {
    hub = await FakeHub.create({ answerQuery: () => ({ error: "no such fortress" }) });
    connection = new WsCloudConnection(deps());
    await connection.open(config(hub.url));
    const err = (await connection
      .request({ kind: "routingPosture" })
      .catch((e: unknown) => e)) as FortressQueryUnavailable;
    expect(err.cause_).toBe("error");
    expect(err.message).toContain("no such fortress");
  });

  test("closing the connection ends an outstanding question at once", async () => {
    hub = await FakeHub.create(); // never answers
    connection = new WsCloudConnection(deps());
    await connection.open(config(hub.url));
    const pending = connection.request({ kind: "routingPosture" }, 60_000);
    await connection.close();
    connection = null;
    const err = (await pending.catch((e: unknown) => e)) as FortressQueryUnavailable;
    expect(err.cause_).toBe("closed");
  });

  test("a dropped socket drains outstanding questions rather than stranding them", async () => {
    hub = await FakeHub.create();
    connection = new WsCloudConnection(deps());
    await connection.open(config(hub.url));
    const pending = connection.request({ kind: "routingPosture" }, 60_000);
    hub.dropConnection();
    const err = (await pending.catch((e: unknown) => e)) as FortressQueryUnavailable;
    // Correlation ids mean nothing to the hub behind the next socket.
    expect(err.cause_).toBe("offline");
  });

  test("asking with no connection is unavailable, never a hang", async () => {
    hub = await FakeHub.create();
    const offline = new WsCloudConnection(deps());
    const err = (await offline
      .request({ kind: "routingPosture" })
      .catch((e: unknown) => e)) as FortressQueryUnavailable;
    expect(err.cause_).toBe("offline");
  });
});

describe("the routing-posture cache", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "hx-posture-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("round-trips an answer with its fetchedAt", async () => {
    const cache = new RoutingPostureCache(path.join(dir, "runtime", "routing-posture.json"));
    const fetchedAt = new Date().toISOString();
    await cache.write({ fetchedAt, data: POSTURE });
    expect(await cache.read()).toEqual({ fetchedAt, data: POSTURE });
  });

  test("an unavailable answer REPLACES the last good one, with its own timestamp", async () => {
    const file = path.join(dir, "routing-posture.json");
    const cache = new RoutingPostureCache(file);
    await cache.write({ fetchedAt: new Date().toISOString(), data: POSTURE });
    await cache.recordUnavailable("timeout");
    const snapshot = await cache.read();
    // Leaving the old data would let a stale posture read as current forever.
    expect(snapshot?.data).toBeUndefined();
    expect(snapshot?.unavailable).toBe("timeout");
    expect(JSON.parse(await readFile(file, "utf8")).fetchedAt).toBeDefined();
  });

  test("an unreadable cache reads as absent rather than as an answer", async () => {
    const file = path.join(dir, "routing-posture.json");
    await writeFile(file, "{ torn");
    expect(await new RoutingPostureCache(file).read()).toBeNull();
  });

  test("freshness is fresh, stale, unavailable or never-fetched", () => {
    const now = Date.UTC(2026, 6, 31, 12, 0, 0);
    const fresh = { fetchedAt: new Date(now - 60_000).toISOString(), data: POSTURE };
    const old = { fetchedAt: new Date(now - POSTURE_STALE_AFTER_MS - 1_000).toISOString(), data: POSTURE };
    expect(postureFreshness(fresh, now)).toBe("fresh");
    expect(postureFreshness(old, now)).toBe("stale");
    expect(postureFreshness({ fetchedAt: new Date(now).toISOString(), unavailable: "timeout" }, now)).toBe("unavailable");
    expect(postureFreshness(null, now)).toBe("never-fetched");
  });
});

describe("what unavailable renders downstream", () => {
  const now = Date.UTC(2026, 6, 31, 12, 0, 0);

  test("an unavailable posture is NOT CHECKED, never a clean verdict", () => {
    for (const snapshot of [
      null,
      { fetchedAt: new Date(now).toISOString(), unavailable: "timeout" },
      { fetchedAt: "not-a-date", data: POSTURE },
    ]) {
      expect(postureQualification(snapshot, 0, now)).toBe(
        "unqualified — posture unavailable, cloud-only sessions not checked",
      );
      expect(postureQualification(snapshot, 7, now)).toContain("not checked");
    }
  });

  test("a fetched posture qualifies the verdict and names its asOf", () => {
    const fetchedAt = new Date(now - 60_000).toISOString();
    expect(postureQualification({ fetchedAt, data: POSTURE }, 3, now)).toBe("qualified (3 cloud-only)");
    expect(postureQualification({ fetchedAt, data: POSTURE }, 0, now)).toBe(
      `unqualified (posture asOf ${fetchedAt})`,
    );
  });
});
