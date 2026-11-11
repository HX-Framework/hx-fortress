import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import {
  ASK_MAX_IN_FLIGHT,
  ASK_MAX_IN_FLIGHT_CEILING,
  ASK_MAX_PER_MINUTE,
  ASK_MAX_PER_MINUTE_CEILING,
  askLimits,
  grantDigest,
} from "../../src/host/ask-gate";
import { verifyGrant } from "../../src/gateway/capability-token";
import { askScopeHash } from "../../src/host/ask-scope";
import { setModuleEnabled } from "../../src/host/config";
import {
  ask,
  makeRig,
  ORG,
  ROW_VALUE,
  SECRET_VALUE,
  spoolRecords,
  spoolText,
  writeConfig,
  type Rig,
} from "./_module-rig";

let rig: Rig;
afterEach(async () => {
  await rig?.cleanup();
});

/** The `relay.ask` records, as (kind, outcome, params, error). */
async function askRecords(r: Rig) {
  await r.host.audit.flush();
  return (await spoolRecords(r.paths))
    .filter((record) => record.action === "relay.ask")
    .map((record) => ({
      kind: record.kind,
      outcome: record.outcome,
      params: record.params,
      error: record.error,
      actor: record.actor,
    }));
}

describe("an ask with a valid grant", () => {
  test("reaches the module and gets a reply of the declared shape", async () => {
    rig = await makeRig();
    const reply = await ask(rig, "probe", "count.double", { n: 21 });
    expect(reply).toEqual({ ok: true, payload: { n: 42 } });
    expect(rig.probe.calls).toEqual([{ ask: "count.double", args: { n: 21 } }]);
  });

  test("is written to the trail before the module runs, and again when it ends", async () => {
    rig = await makeRig();
    await ask(rig, "probe", "tables.list", {});
    expect(await askRecords(rig)).toEqual([
      {
        kind: "intent",
        outcome: null,
        // The module, the ask, and a digest of the grant that was spent on it.
        params: { module: "probe", ask: "tables.list", grant: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) },
        error: null,
        actor: "relay",
      },
      { kind: "outcome", outcome: "ok", params: null, error: null, actor: "relay" },
    ]);
  });

  test("gives the module a context whose identity is read when asked", async () => {
    rig = await makeRig();
    expect(await ask(rig, "probe", "context.probe")).toEqual({ ok: true, payload: { identity: false } });
    rig.registry.setFortressIdentity({ orgId: ORG, fortressId: "f1", credential: "c" });
    expect(await ask(rig, "probe", "context.probe")).toEqual({ ok: true, payload: { identity: true } });
  });

  test("hands the module arguments rebuilt from the declared shape", async () => {
    rig = await makeRig();
    const args = { prefix: "ord" };
    await ask(rig, "probe", "tables.list", args);
    expect(rig.probe.calls[0]?.args).toEqual(args);
    expect(rig.probe.calls[0]?.args).not.toBe(args);
  });
});

describe("the grant is required", () => {
  test("no grant: refused as grant_missing, and the module never runs", async () => {
    rig = await makeRig();
    expect(await ask(rig, "probe", "count.double", { n: 1 }, null)).toEqual({
      ok: false,
      error: "grant_missing",
    });
    expect(await ask(rig, "probe", "count.double", { n: 1 }, "")).toEqual({
      ok: false,
      error: "grant_missing",
    });
    expect(rig.probe.calls).toEqual([]);
    const records = await askRecords(rig);
    expect(records[0]).toEqual({
      kind: "outcome",
      outcome: "refused",
      params: { module: "probe", ask: "count.double", rule: "grant_missing" },
      error: null,
      actor: "relay",
    });
  });

  test.each([
    ["grant_signature", async () => "not.a.jwt"],
    ["grant_signature", async (r: Rig) => (await r.key.grant("probe", "count.double", { n: 1 })).slice(0, -4) + "AAAA"],
    ["grant_purpose", (r: Rig) => r.key.grant("probe", "count.double", { n: 1 }, { purpose: "read" })],
    ["grant_organization", (r: Rig) => r.key.grant("probe", "count.double", { n: 1 }, { org: "org_other", aud: "org_other" })],
    ["grant_subject", (r: Rig) => r.key.grant("probe", "tables.list", { n: 1 })],
    ["grant_subject", (r: Rig) => r.key.grant("host", "count.double", { n: 1 })],
    ["grant_scope", (r: Rig) => r.key.grant("probe", "count.double", { n: 2 }, { sub: "probe:count.double" })],
    ["grant_expired", (r: Rig) => r.key.grant("probe", "count.double", { n: 1 }, {}, { iat: Math.floor(r.now.value.getTime() / 1000) - 300 })],
    ["grant_lifetime", (r: Rig) => r.key.grant("probe", "count.double", { n: 1 }, {}, { ttl: 600 })],
    ["grant_single_use_id", (r: Rig) => r.key.grant("probe", "count.double", { n: 1 }, {}, { jti: null })],
  ])("a wrong grant is refused as grant_invalid and recorded as %s", async (expectedRule, mint) => {
    rig = await makeRig();
    const reply = await ask(rig, "probe", "count.double", { n: 1 }, await mint(rig));
    expect(reply).toEqual({ ok: false, error: "grant_invalid" });
    expect(rig.probe.calls).toEqual([]);
    const records = await askRecords(rig);
    expect(records).toHaveLength(1);
    expect(records[0]?.params).toEqual({ module: "probe", ask: "count.double", rule: expectedRule });
  });

  test("a grant signed by another organization's key is refused", async () => {
    rig = await makeRig();
    const other = await makeRig();
    try {
      const foreign = await other.key.grant("probe", "count.double", { n: 1 });
      expect(await ask(rig, "probe", "count.double", { n: 1 }, foreign)).toEqual({
        ok: false,
        error: "grant_invalid",
      });
      expect((await askRecords(rig))[0]?.params).toMatchObject({ rule: "grant_signature" });
    } finally {
      await other.cleanup();
    }
  });

  test("a fortress with no pinned key refuses every ask", async () => {
    rig = await makeRig({
      deps: {
        verifyGrant: async () => {
          throw new Error("no pinned signing key");
        },
      },
    });
    expect(await ask(rig, "probe", "count.double", { n: 1 })).toEqual({ ok: false, error: "grant_invalid" });
    expect((await askRecords(rig))[0]?.params).toMatchObject({ rule: "grant_unverifiable" });
  });

  test("a grant works once", async () => {
    rig = await makeRig();
    const grant = await rig.key.grant("probe", "count.double", { n: 4 });
    expect(await ask(rig, "probe", "count.double", { n: 4 }, grant)).toEqual({ ok: true, payload: { n: 8 } });
    expect(await ask(rig, "probe", "count.double", { n: 4 }, grant)).toEqual({ ok: false, error: "grant_invalid" });
    expect(rig.probe.calls).toHaveLength(1);
    const refused = (await askRecords(rig)).filter((record) => record.outcome === "refused");
    expect(refused[0]?.params).toMatchObject({ rule: "grant_replayed" });
  });

  test("a grant that ran an ask is still used after the daemon restarts", async () => {
    rig = await makeRig();
    const first = rig;
    const grant = await rig.key.grant("probe", "count.double", { n: 4 });
    expect(await ask(rig, "probe", "count.double", { n: 4 }, grant)).toEqual({ ok: true, payload: { n: 8 } });
    // The daemon stops, and a new one starts over the same directory five
    // seconds later. Its table of used grants is new, and empty.
    await first.host.stop();
    first.now.value = new Date(first.now.value.getTime() + 5_000);
    const second = await makeRig({ restartOf: first });
    try {
      // The same frame, sent again. The grant has 55 seconds left and verifies.
      expect(await ask(second, "probe", "count.double", { n: 4 }, grant)).toEqual({
        ok: false,
        error: "grant_invalid",
      });
      expect(second.probe.calls).toEqual([]);
      // A new grant works as before.
      expect(await ask(second, "probe", "count.double", { n: 4 })).toEqual({ ok: true, payload: { n: 8 } });
    } finally {
      await second.cleanup();
    }
  });

  test("what the trail keeps of a grant is a digest, not its id", async () => {
    rig = await makeRig();
    const jti = "grant-id-chosen-by-whoever-minted-it";
    const grant = await rig.key.grant("probe", "count.double", { n: 1 }, {}, { jti });
    await ask(rig, "probe", "count.double", { n: 1 }, grant);
    const [intent] = await askRecords(rig);
    expect(intent?.params).toEqual({ module: "probe", ask: "count.double", grant: grantDigest(jti) });
    expect(grantDigest(jti)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await spoolText(rig.paths)).not.toContain(jti);
  });

  test("a used grant is remembered past the instant it expires", async () => {
    // The verifier reads the clock before it checks the signature, and the gate
    // reads it afterwards. Here the two are two seconds apart, so a grant can
    // still verify at a moment the gate already calls expired.
    const made: Rig = await makeRig({
      deps: {
        verifyGrant: (token, bind) =>
          verifyGrant(token, made.key.publicKey, ORG, {
            purpose: "module",
            ...bind,
            now: () => new Date(made.now.value.getTime() - 2_000),
          }),
      },
    });
    rig = made;
    const grant = await rig.key.grant("probe", "count.double", { n: 4 });
    expect(await ask(rig, "probe", "count.double", { n: 4 }, grant)).toMatchObject({ ok: true });
    // One second after the grant's expiry by the gate's clock.
    rig.now.value = new Date(rig.now.value.getTime() + 61_000);
    expect(await ask(rig, "probe", "count.double", { n: 4 }, grant)).toEqual({ ok: false, error: "grant_invalid" });
    expect(rig.probe.calls).toHaveLength(1);
    expect((await askRecords(rig)).at(-1)?.params).toMatchObject({ rule: "grant_replayed" });
  });

  test("a grant for one set of arguments does not carry to another", async () => {
    rig = await makeRig();
    const grant = await rig.key.grant("probe", "count.double", { n: 1 });
    expect(await ask(rig, "probe", "count.double", { n: 1000 }, grant)).toEqual({
      ok: false,
      error: "grant_invalid",
    });
    expect(rig.probe.calls).toEqual([]);
  });
});

describe("what a module may be asked", () => {
  test("an ask that is not in the manifest is refused as ask_unknown", async () => {
    rig = await makeRig();
    expect(await ask(rig, "probe", "rows.read", { table: "orders" })).toEqual({
      ok: false,
      error: "ask_unknown",
    });
    expect(rig.probe.calls).toEqual([]);
    // The name the relay sent is not copied into the trail.
    expect((await askRecords(rig))[0]?.params).toEqual({
      module: "probe",
      ask: "unknown",
      rule: "ask_not_in_manifest",
    });
    expect(await spoolText(rig.paths)).not.toContain("rows.read");
  });

  test("a module with no manifest takes no asks, even switched on and running", async () => {
    rig = await makeRig();
    const reply = await ask(rig, "session_vault", "selftest", {});
    expect(reply).toEqual({ ok: false, error: "ask_unknown" });
    expect((await askRecords(rig))[0]?.params).toMatchObject({ rule: "module_takes_no_asks" });
    const legacy = rig.registry.get("session_vault") as unknown as { messages: unknown[] };
    expect(legacy.messages).toEqual([]);
  });

  test("a module this build does not ship is refused as module_off", async () => {
    rig = await makeRig();
    expect(await ask(rig, "payroll", "status", {})).toEqual({ ok: false, error: "module_off" });
    expect((await askRecords(rig))[0]?.params).toEqual({
      module: "unknown",
      ask: "unknown",
      rule: "module_unknown",
    });
    expect(await spoolText(rig.paths)).not.toContain("payroll");
  });

  test("arguments that do not have their shape are refused as args_invalid", async () => {
    rig = await makeRig();
    for (const args of [{ n: "21" }, { n: -1 }, { n: 1001 }, {}, { n: 1, extra: true }]) {
      const reply = await ask(rig, "probe", "count.double", args as Record<string, unknown>);
      expect(reply).toEqual({ ok: false, error: "args_invalid" });
    }
    expect(rig.probe.calls).toEqual([]);
    const rules = (await askRecords(rig)).map((record) => (record.params as { rule: string }).rule);
    expect(new Set(rules)).toEqual(
      new Set(["args_not_a_count", "args_count_too_large", "args_field_missing", "args_field_unknown"]),
    );
  });

  test("a malformed envelope is refused before anything else is read", async () => {
    rig = await makeRig();
    const grant = await rig.key.grant("probe", "count.double", { n: 1 });
    const send = (payload: unknown, module: unknown = "probe") =>
      rig.host.asks.handle({ module, id: "m1", kind: "request", payload } as never);
    expect(await send("status")).toEqual({ ok: false, error: "ask_unknown" });
    expect(await send(null)).toEqual({ ok: false, error: "ask_unknown" });
    expect(await send({ v: 2, ask: "count.double", args: { n: 1 }, grant })).toEqual({ ok: false, error: "ask_unknown" });
    expect(await send({ v: 1, ask: "Count Double!", args: { n: 1 }, grant })).toEqual({ ok: false, error: "ask_unknown" });
    expect(await send({ v: 1, ask: "count.double", args: [1], grant })).toEqual({ ok: false, error: "args_invalid" });
    expect(await send({ v: 1, ask: "count.double", args: { n: 1 }, grant }, "Not A Module")).toEqual({
      ok: false,
      error: "ask_unknown",
    });
    expect(rig.probe.calls).toEqual([]);
  });

  test("an event, or a frame with no usable id, is recorded and gets no reply", async () => {
    rig = await makeRig();
    const grant = await rig.key.grant("probe", "count.double", { n: 1 });
    const payload = { v: 1, ask: "count.double", args: { n: 1 }, grant };
    expect(await rig.host.asks.handle({ module: "probe", id: "e1", kind: "event", payload })).toBeUndefined();
    expect(await rig.host.asks.handle({ module: "probe", id: "", kind: "request", payload })).toBeUndefined();
    expect(
      await rig.host.asks.handle({ module: "probe", id: "x".repeat(200), kind: "request", payload }),
    ).toBeUndefined();
    expect(rig.probe.calls).toEqual([]);
    // The second frame with no usable id is the same refusal as the first, so it
    // is counted into the window's closing record rather than written again.
    expect((await askRecords(rig)).map((record) => record.params)).toEqual([
      { module: "probe", ask: "unknown", rule: "not_a_request" },
      { module: "probe", ask: "unknown", rule: "frame_malformed" },
      expect.objectContaining({ rule: "frame_malformed", attempts: 1 }),
    ]);
  });
});

describe("the module's switch", () => {
  test("a module that is off refuses its asks as module_off", async () => {
    rig = await makeRig({ enabled: ["session_vault"] });
    expect(await ask(rig, "probe", "count.double", { n: 1 })).toEqual({ ok: false, error: "module_off" });
    expect(rig.probe.calls).toEqual([]);
    expect((await askRecords(rig))[0]?.params).toEqual({
      module: "probe",
      ask: "count.double",
      rule: "module_off",
    });
  });

  test("without a grant, nobody learns whether a module is on", async () => {
    rig = await makeRig({ enabled: ["session_vault"] });
    const bad = await rig.key.grant("probe", "count.double", { n: 1 }, { org: "org_other", aud: "org_other" });
    // Off, unknown and on all answer the same to a caller with no good grant.
    expect(await ask(rig, "probe", "count.double", { n: 1 }, null)).toEqual({ ok: false, error: "grant_missing" });
    expect(await ask(rig, "payroll", "count.double", { n: 1 }, null)).toEqual({ ok: false, error: "grant_missing" });
    expect(await ask(rig, "probe", "count.double", { n: 1 }, bad)).toEqual({ ok: false, error: "grant_invalid" });
    expect(await ask(rig, "session_vault", "count.double", { n: 1 }, bad)).toEqual({ ok: false, error: "grant_invalid" });
  });

  test("an off module is not in the registry, so the daemon's status does not list it", async () => {
    rig = await makeRig({ enabled: ["session_vault"] });
    expect(rig.registry.snapshot().map((module) => module.id)).toEqual(["session_vault"]);
  });

  test("switching a module off refuses the very next ask, with no signal sent", async () => {
    rig = await makeRig();
    expect(await ask(rig, "probe", "count.double", { n: 1 })).toMatchObject({ ok: true });
    await setModuleEnabled(rig.paths, "probe", false);
    expect(await ask(rig, "probe", "count.double", { n: 1 })).toEqual({ ok: false, error: "module_off" });
    expect(rig.probe.calls).toHaveLength(1);
    // The host noticed the switch itself, stopped the module and unlisted it.
    expect(rig.registry.snapshot().map((module) => module.id)).toEqual(["session_vault"]);
    const switches = (await spoolRecords(rig.paths)).filter((r) => r.action === "system.module.switch");
    expect(switches.map((r) => [r.params, r.outcome])).toEqual([[{ module: "probe", state: "off" }, "done"]]);
  });

  test("switching a module on starts it, and its asks are then served", async () => {
    rig = await makeRig({ enabled: ["session_vault"] });
    await setModuleEnabled(rig.paths, "probe", true);
    await rig.host.applyRequests();
    expect(rig.registry.isRunning("probe")).toBe(true);
    expect(await ask(rig, "probe", "count.double", { n: 2 })).toEqual({ ok: true, payload: { n: 4 } });
  });

  test("a module that is on and did not start answers failed:module_not_running", async () => {
    rig = await makeRig();
    await rig.registry.stopOne("probe");
    expect(await ask(rig, "probe", "count.double", { n: 1 })).toEqual({
      ok: false,
      error: "failed:module_not_running",
    });
  });

  test("a config.json that cannot be read refuses every ask, and stops nothing", async () => {
    rig = await makeRig();
    await Bun.write(rig.paths.config, "{ not json");
    expect(await ask(rig, "probe", "count.double", { n: 1 })).toEqual({ ok: false, error: "module_off" });
    // What the daemon does every 15 seconds, and on a signal.
    await rig.host.applyRequests();
    await rig.host.follow();
    // A typo in the file is not somebody switching every module off.
    expect(rig.registry.isRunning("session_vault")).toBe(true);
    expect(rig.registry.isRunning("probe")).toBe(true);
    expect(
      (await spoolRecords(rig.paths)).filter((record) => record.action === "system.module.switch"),
    ).toEqual([]);
    // Said once in the log, however many asks arrive while it lasts.
    expect(await ask(rig, "probe", "count.double", { n: 1 })).toEqual({ ok: false, error: "module_off" });
    expect(rig.logs.filter((record) => record.msg.includes("config.json cannot be read"))).toHaveLength(1);

    // The file is fixed. Nothing was stopped, so nothing needs a restart.
    await writeConfig(rig.paths, ["session_vault", "probe"]);
    expect(await ask(rig, "probe", "count.double", { n: 2 })).toEqual({ ok: true, payload: { n: 4 } });
  });

  test("a module whose switch is read at start is neither started nor stopped afterwards", async () => {
    rig = await makeRig();
    await setModuleEnabled(rig.paths, "session_vault", false);
    await rig.host.applyRequests();
    expect(rig.registry.isRunning("session_vault")).toBe(true);
    await setModuleEnabled(rig.paths, "probe", false);
    await rig.host.applyRequests();
    // The probe's switch is followed at once; Sessions' is not.
    expect(rig.registry.has("probe")).toBe(false);
    expect(rig.registry.isRunning("session_vault")).toBe(true);
    const switched = (await spoolRecords(rig.paths)).filter((r) => r.action === "system.module.switch");
    expect(switched.map((r) => r.params)).toEqual([{ module: "probe", state: "off" }]);
  });
});

describe("a reply cannot hold a row", () => {
  test.each(["leak.row", "leak.extra", "leak.getter"])(
    "%s: a reply that breaks its shape is refused as reply_invalid",
    async (name) => {
      rig = await makeRig();
      const reply = await ask(rig, "probe", name);
      expect(reply).toEqual({ ok: false, error: "reply_invalid" });
      expect(JSON.stringify(reply)).not.toContain("Okafor");
      const records = await askRecords(rig);
      expect(records.map((record) => record.outcome)).toEqual([null, "refused"]);
      expect(records[1]?.error).toMatch(/^reply_(not_a_name at name|field_unknown)$/);
      // Nothing of the refused value is written anywhere: not the trail, not the log.
      expect(await spoolText(rig.paths)).not.toContain("Okafor");
      expect(JSON.stringify(rig.logs)).not.toContain("Okafor");
    },
  );

  test("a list longer than its shape allows is refused whole", async () => {
    rig = await makeRig();
    rig.probe.onAsk = async () => ({
      tables: Array.from({ length: 4 }, (_, i) => ({ name: `t${i}`, rows: i })),
    });
    expect(await ask(rig, "probe", "tables.list")).toEqual({ ok: false, error: "reply_invalid" });
    expect((await askRecords(rig))[1]?.error).toBe("reply_list_too_long at tables");
  });

  test("a reply that throws while it is read is refused, and what it threw goes nowhere", async () => {
    rig = await makeRig();
    const reply = await ask(rig, "probe", "leak.throws");
    expect(reply).toEqual({ ok: false, error: "reply_invalid" });
    // The ask has its outcome: an intent with nothing after it would read as a
    // daemon that stopped.
    const records = await askRecords(rig);
    expect(records.map((record) => [record.kind, record.outcome, record.error])).toEqual([
      ["intent", null, null],
      ["outcome", "refused", "reply_unreadable"],
    ]);
    const everywhere = `${await spoolText(rig.paths)}\n${JSON.stringify(rig.logs)}`;
    expect(everywhere).not.toContain("Okafor");
    expect(everywhere).not.toContain("could not load");
  });

  test("what is sent is rebuilt, so nothing undeclared can ride along", async () => {
    rig = await makeRig();
    const returned = { n: 7 };
    rig.probe.onAsk = async () => returned;
    const reply = await ask(rig, "probe", "count.double", { n: 1 });
    expect(reply).toEqual({ ok: true, payload: { n: 7 } });
    expect((reply as { payload: unknown }).payload).not.toBe(returned);
  });
});

describe("a module that fails", () => {
  test("a thrown message goes nowhere: not the relay, the trail or the log", async () => {
    rig = await makeRig();
    const reply = await ask(rig, "probe", "throw.secret");
    expect(reply).toEqual({ ok: false, error: "failed:internal" });
    const records = await askRecords(rig);
    expect(records[1]).toMatchObject({ outcome: "failed", error: "internal" });
    for (const text of [JSON.stringify(reply), await spoolText(rig.paths), JSON.stringify(rig.logs)]) {
      expect(text).not.toContain(SECRET_VALUE);
      expect(text).not.toContain("Okafor");
    }
    // The failure itself is still visible to the operator: that it happened,
    // what kind of error it was and where it was thrown.
    const logged = rig.logs.find((record) => record.msg === "a module failed while answering an ask");
    expect(logged?.fields).toMatchObject({ module: "probe", ask: "throw.secret", code: "internal", kind: "Error" });
    expect(String(logged?.fields?.where)).toMatch(/^at /);
    expect(ROW_VALUE).toContain("Okafor");
  });

  test("a secret the store does not hold is named in the log and is one word to the relay", async () => {
    rig = await makeRig();
    rig.probe.onAsk = async (_ask, _args, ctx) => {
      // Declared in the manifest, and not in the customer's store.
      await ctx.secrets.get("probe-token");
      return {};
    };
    const store = await rig.host.secretsKind();
    expect(store).toBe("file");
    // Empty the store the rig gave the host.
    rig.secrets.values = {};
    expect(await ask(rig, "probe", "throw.code")).toEqual({ ok: false, error: "failed:secret_missing" });
    const logged = rig.logs.find((record) => record.msg === "a module failed while answering an ask");
    expect(logged?.fields).toMatchObject({ code: "secret_missing", error: 'secret "probe-token" is not set' });
    expect((await askRecords(rig)).at(-1)).toMatchObject({ outcome: "failed", error: "secret_missing" });
  });

  test("a call the manifest does not allow fails the ask with the rule as its code", async () => {
    rig = await makeRig();
    rig.probe.onAsk = async (_ask, _args, ctx) => {
      await ctx.fetch("https://elsewhere.example/collect");
      return {};
    };
    expect(await ask(rig, "probe", "throw.code")).toEqual({ ok: false, error: "failed:egress_not_declared" });
  });

  test("a failure the module names reaches the relay as its code", async () => {
    rig = await makeRig();
    expect(await ask(rig, "probe", "throw.code")).toEqual({ ok: false, error: "failed:store_unreachable" });
    expect((await askRecords(rig))[1]).toMatchObject({ outcome: "failed", error: "store_unreachable" });
  });

  test("a failure nobody foresaw still gets its outcome, and one word for the relay", async () => {
    rig = await makeRig();
    // The module throws a value that itself throws when it is examined, so the
    // code that works out which word to send cannot.
    expect(await ask(rig, "probe", "throw.hostile")).toEqual({ ok: false, error: "failed:internal" });
    expect((await askRecords(rig)).map((record) => [record.kind, record.outcome, record.error])).toEqual([
      ["intent", null, null],
      ["outcome", "failed", "internal"],
    ]);
    const everywhere = `${await spoolText(rig.paths)}\n${JSON.stringify(rig.logs)}`;
    expect(everywhere).not.toContain("Okafor");
    // The slot it held is free again.
    expect(await ask(rig, "probe", "count.double", { n: 1 })).toEqual({ ok: true, payload: { n: 2 } });
  });

  test("a log that cannot be written does not cost an ask its outcome", async () => {
    rig = await makeRig();
    const bus = rig.host as unknown as { log: { error: (...args: unknown[]) => void } };
    const error = bus.log.error;
    bus.log.error = () => {
      throw new Error("ENOSPC");
    };
    try {
      expect(await ask(rig, "probe", "leak.row")).toEqual({ ok: false, error: "reply_invalid" });
      expect(await ask(rig, "probe", "throw.code")).toEqual({ ok: false, error: "failed:store_unreachable" });
    } finally {
      bus.log.error = error;
    }
    const outcomes = (await askRecords(rig)).filter((record) => record.kind === "outcome");
    expect(outcomes.map((record) => [record.outcome, record.error])).toEqual([
      ["refused", "reply_not_a_name at name"],
      ["failed", "store_unreachable"],
    ]);
  });

  test("an ask that never answers is answered failed:timeout", async () => {
    rig = await makeRig({ deps: { askDeadlineMs: 20 } });
    expect(await ask(rig, "probe", "never")).toEqual({ ok: false, error: "failed:timeout" });
    expect((await askRecords(rig))[1]).toMatchObject({ outcome: "failed", error: "timeout" });
  });

  test("an ask whose record cannot be written does not run", async () => {
    rig = await makeRig();
    rig.host.audit.intent = async () => {
      throw new Error("disk full");
    };
    expect(await ask(rig, "probe", "count.double", { n: 1 })).toEqual({
      ok: false,
      error: "failed:audit_unavailable",
    });
    expect(rig.probe.calls).toEqual([]);
  });
});

describe("capacity", () => {
  test("asks beyond the in-flight ceiling are refused as busy", async () => {
    rig = await makeRig({ deps: { env: { FORTRESS_ASK_MAX_IN_FLIGHT: "2" }, askDeadlineMs: 50 } });
    const first = ask(rig, "probe", "never");
    const second = ask(rig, "probe", "never");
    await Bun.sleep(5);
    expect(await ask(rig, "probe", "count.double", { n: 1 })).toEqual({ ok: false, error: "busy" });
    await Promise.all([first, second]);
    expect((await askRecords(rig)).some((r) => (r.params as { rule?: string } | null)?.rule === "busy_in_flight")).toBe(true);
  });

  test("asks that arrive together count each other: no more than the ceiling run at once", async () => {
    rig = await makeRig({ deps: { env: { FORTRESS_ASK_MAX_IN_FLIGHT: "2" }, askDeadlineMs: 50 } });
    // Seven asks in one turn of the event loop, as a burst on the tunnel is.
    const replies = await Promise.all(Array.from({ length: 7 }, () => ask(rig, "probe", "never")));
    const errors = replies.map((reply) => (reply && !reply.ok ? reply.error : null));
    expect(errors.filter((error) => error === "failed:timeout")).toHaveLength(2);
    expect(errors.filter((error) => error === "busy")).toHaveLength(5);
    // Only two reached the module.
    expect(rig.probe.calls).toHaveLength(2);
  });

  test("an ask that could not be recorded gives its slot back", async () => {
    rig = await makeRig({ deps: { env: { FORTRESS_ASK_MAX_IN_FLIGHT: "1" } } });
    const intent = rig.host.audit.intent.bind(rig.host.audit);
    rig.host.audit.intent = async () => {
      throw new Error("disk full");
    };
    expect(await ask(rig, "probe", "count.double", { n: 1 })).toMatchObject({ error: "failed:audit_unavailable" });
    rig.host.audit.intent = intent;
    expect(await ask(rig, "probe", "count.double", { n: 1 })).toEqual({ ok: true, payload: { n: 2 } });
  });

  test("no minute holds more asks than the limit, wherever the minute starts", async () => {
    rig = await makeRig({ deps: { env: { FORTRESS_ASK_MAX_PER_MINUTE: "3" } } });
    const at = (ms: number) => void (rig.now.value = new Date(start + ms));
    const start = rig.now.value.getTime();
    const once = async (n: number) => (await ask(rig, "probe", "count.double", { n }))?.ok;

    // One at 0 s, two at 50 s: three in the first minute.
    expect(await once(1)).toBe(true);
    at(50_000);
    expect(await once(2)).toBe(true);
    expect(await once(3)).toBe(true);
    expect(await ask(rig, "probe", "count.double", { n: 4 })).toEqual({ ok: false, error: "busy" });

    // At 59.9 s the first is still inside the minute. A limit that refilled
    // evenly, or was reset each minute, would let another through here.
    at(59_900);
    expect(await once(5)).toBe(false);

    // At 60 s the first has left: one more, and only one, because the two from
    // 50 s are still inside.
    at(60_000);
    expect(await once(6)).toBe(true);
    expect(await once(7)).toBe(false);
    at(109_900);
    expect(await once(8)).toBe(false);
    at(110_000);
    expect(await once(9)).toBe(true);
    expect(await once(10)).toBe(true);
    expect(await once(11)).toBe(false);
    expect((await askRecords(rig)).some((r) => (r.params as { rule?: string } | null)?.rule === "busy_rate")).toBe(true);
  });
});

describe("the two limits an operator may set", () => {
  test("default to 16 at once and 300 a minute", () => {
    expect(askLimits({})).toEqual({ maxInFlight: ASK_MAX_IN_FLIGHT, maxPerMinute: ASK_MAX_PER_MINUTE });
    expect(askLimits({})).toEqual({ maxInFlight: 16, maxPerMinute: 300 });
  });

  test("a whole number of one or more is used", () => {
    expect(askLimits({ FORTRESS_ASK_MAX_IN_FLIGHT: "4", FORTRESS_ASK_MAX_PER_MINUTE: " 1200 " })).toEqual({
      maxInFlight: 4,
      maxPerMinute: 1200,
    });
  });

  test("a value past the ceiling is held to it", () => {
    expect(
      askLimits({ FORTRESS_ASK_MAX_IN_FLIGHT: "100000", FORTRESS_ASK_MAX_PER_MINUTE: "999999999999999" }),
    ).toEqual({ maxInFlight: ASK_MAX_IN_FLIGHT_CEILING, maxPerMinute: ASK_MAX_PER_MINUTE_CEILING });
    expect([ASK_MAX_IN_FLIGHT_CEILING, ASK_MAX_PER_MINUTE_CEILING]).toEqual([256, 6000]);
  });

  test("anything that is not such a number leaves the default, and never removes the limit", () => {
    for (const raw of ["", "0", "-1", "1.5", "1e9", "Infinity", "NaN", "0x10", "ten", "9".repeat(40)]) {
      expect(askLimits({ FORTRESS_ASK_MAX_IN_FLIGHT: raw, FORTRESS_ASK_MAX_PER_MINUTE: raw })).toEqual({
        maxInFlight: 16,
        maxPerMinute: 300,
      });
    }
  });
});

describe("work the relay cannot make this host do without a grant", () => {
  /** A verifier that counts how often the gate lets it hash the arguments. */
  async function countingRig() {
    const hashed = { times: 0 };
    // The verifier the rig builds, with one counter added. It reads the rig's
    // key and clock when it is called, which is after the rig exists.
    const made: Rig = await makeRig({
      deps: {
        verifyGrant: (token, bind) =>
          verifyGrant(token, made.key.publicKey, ORG, {
            purpose: "module",
            sub: bind.sub,
            scopeHash: () => {
              hashed.times += 1;
              return typeof bind.scopeHash === "function" ? bind.scopeHash() : bind.scopeHash;
            },
            now: () => new Date(made.now.value.getTime()),
          }),
      },
    });
    return { made, hashed };
  }

  test("the arguments are hashed only for a grant that verifies", async () => {
    const { made, hashed } = await countingRig();
    rig = made;
    const key = made.key;
    const args = { n: 1 };
    // No signature, a signature by nobody, another purpose, another organization,
    // another ask: none of them gets the arguments hashed.
    const good = await key.grant("probe", "count.double", args);
    const refused = [
      "x",
      `${good.slice(0, -4)}AAAA`,
      await key.grant("probe", "count.double", args, { purpose: "read" }),
      await key.grant("probe", "count.double", args, { org: "org_other", aud: "org_other" }),
      await key.grant("host", "count.double", args),
    ];
    for (const grant of refused) {
      expect(await ask(rig, "probe", "count.double", args, grant)).toEqual({ ok: false, error: "grant_invalid" });
    }
    expect(hashed.times).toBe(0);
    expect(await ask(rig, "probe", "count.double", args, good)).toEqual({ ok: true, payload: { n: 2 } });
    expect(hashed.times).toBe(1);
  });

  test("arguments too large to be a value of any shape are refused unhashed", async () => {
    rig = await makeRig();
    const huge = { n: 1, pad: "x".repeat(200_000) };
    // The grant is valid for exactly these arguments, so only their size refuses them.
    const reply = await ask(rig, "probe", "count.double", huge);
    expect(reply).toEqual({ ok: false, error: "args_invalid" });
    expect((await askRecords(rig))[0]?.params).toEqual({
      module: "probe",
      ask: "count.double",
      rule: "args_too_large",
    });
    // With no valid grant the same frame is told nothing about its arguments.
    expect(await ask(rig, "probe", "count.double", huge, "x")).toEqual({ ok: false, error: "grant_invalid" });
    expect(rig.probe.calls).toEqual([]);
  });

  test("a grant far longer than any real one is refused before it is parsed", async () => {
    rig = await makeRig();
    const reply = await ask(rig, "probe", "count.double", { n: 1 }, "a".repeat(5000));
    expect(reply).toEqual({ ok: false, error: "grant_invalid" });
    expect((await askRecords(rig))[0]?.params).toMatchObject({ rule: "grant_too_long" });
  });
});

describe("a flood of refusals", () => {
  test("is two records, not one per frame, and the count is kept", async () => {
    rig = await makeRig();
    for (let i = 0; i < 250; i += 1) {
      await ask(rig, "probe", "count.double", { n: 1 }, null, `m${i}`);
    }
    await rig.host.audit.flush();
    const records = await askRecords(rig);
    expect(records).toHaveLength(2);
    expect(records[0]?.params).toEqual({ module: "probe", ask: "count.double", rule: "grant_missing" });
    expect(records[1]?.params).toMatchObject({ rule: "grant_missing", attempts: 249 });
  });

  test("names the relay invented do not make new records", async () => {
    rig = await makeRig();
    for (let i = 0; i < 100; i += 1) {
      const module = `m${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const name = `a${i}.b${i}`;
      const grant = await rig.key.mint({
        v: 2,
        purpose: "module",
        org: ORG,
        aud: ORG,
        sub: `${module}:${name}`,
        scopeHash: askScopeHash({ module, ask: name, args: {} }),
      });
      await ask(rig, module, name, {}, grant);
    }
    await rig.host.audit.flush();
    expect(await askRecords(rig)).toHaveLength(2);
  });
});
