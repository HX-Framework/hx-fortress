import { afterEach, describe, expect, test } from "bun:test";

import { startGatewayServer, type GatewayHandle } from "../../src/gateway/server";
import type { SessionStore } from "../../src/modules/session-vault/store/types";

const fakeStore = {} as SessionStore;
let handle: GatewayHandle | null = null;
afterEach(() => {
  handle?.stop();
  handle = null;
});

function start(storeReady: boolean, pgReady: boolean): GatewayHandle {
  return startGatewayServer({
    port: 0,
    logger: { info: () => {}, error: () => {} },
    signingKey: async () => null,
    store: () => (storeReady ? fakeStore : null),
    postgresReady: () => pgReady,
    db: () => null,
    dbRead: () => null,
  });
}

describe("/readyz", () => {
  test("503 when postgres not ready even if store is live", async () => {
    handle = start(true, false);
    const res = await fetch(`http://localhost:${handle.port}/readyz`);
    expect(res.status).toBe(503);
  });

  test("200 when store and postgres are both ready", async () => {
    handle = start(true, true);
    const res = await fetch(`http://localhost:${handle.port}/readyz`);
    expect(res.status).toBe(200);
  });
});
