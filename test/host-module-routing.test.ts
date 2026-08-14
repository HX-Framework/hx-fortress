import { describe, expect, test } from "bun:test";

import { LogBus } from "../src/host/logging";
import { ModuleRegistry } from "../src/host/module-registry";
import type { Module } from "../src/host/types";
import {
  decodeFrame,
  encodeFrame,
  type FortressToHubFrame,
  type HubToFortressFrame,
} from "../src/protocol";

// The "done when" for MC-2258: a core module handles a routed message end to
// end through `onMessage`, never touching a socket or a frame. This stands in
// for the bundled `session_vault` core module (its real refactor is MC-2267).

interface VaultRpcRequest {
  method: "selfTest";
}

interface VaultRpcResult {
  status: "ok";
}

function sessionVaultModule(): Module {
  return {
    id: "session_vault",
    onMessage(data) {
      const request = data.payload as VaultRpcRequest;
      const result: VaultRpcResult = handleVaultRpc(request);
      return { ok: true, payload: result };
    },
  };
}

function handleVaultRpc(request: VaultRpcRequest): VaultRpcResult {
  if (request.method === "selfTest") return { status: "ok" };
  throw new Error(`Unknown vault method: ${request.method}`);
}

describe("module message routing through the protocol seam", () => {
  test("routes a hub moduleMessage frame to the core module and replies", async () => {
    const registry = new ModuleRegistry(silentBus());
    registry.register(sessionVaultModule());
    await registry.startAll(["session_vault"]);

    // What the cloud connection (MC-2259) will receive on the wire.
    const inboundWire = encodeFrame({
      t: "moduleMessage",
      data: {
        module: "session_vault",
        id: "rpc-42",
        kind: "request",
        payload: { method: "selfTest" },
      },
    });

    const inbound = decodeFrame<HubToFortressFrame>(inboundWire);
    if (inbound.t !== "moduleMessage") throw new Error("expected moduleMessage");

    const reply = await registry.dispatch(inbound.data);
    if (!reply) throw new Error("expected a reply for a request");

    // What the connection will send back, correlated by the request id.
    const outbound: FortressToHubFrame = {
      t: "moduleReply",
      id: inbound.data.id,
      reply,
    };
    const roundTripped = decodeFrame<FortressToHubFrame>(encodeFrame(outbound));

    expect(roundTripped).toEqual({
      t: "moduleReply",
      id: "rpc-42",
      reply: { ok: true, payload: { status: "ok" } },
    });
  });
});

function silentBus(): LogBus {
  return new LogBus({ write: () => {} });
}
