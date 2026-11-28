// How the console's Settings page shows the connection to the control plane:
// what it reads from the daemon's status file, and the line it draws from that
// and the answer that is saved.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ORGANIZATION_CHANGED, REASON_WITHHELD } from "../src/cloud/connection";
import { FilePendingEnrollmentStore } from "../src/cloud/credentials";
import { ConsoleStatusUnavailable, readConsoleStatus } from "../src/console/connection-shown";
import { STATUS_STALE_MS } from "../src/daemon-state";
import { NO_CONTROL_PLANE } from "../src/host/runtime";
import type { ConnectionShown } from "../src/ui/settings-wire";
import { connectionLine } from "../ui/src/views/settings/sections";
import { tempRoot, type Paths } from "./host/_module-rig";
import { CONTROL, EARLIER_CONTROL, INSTALL_ID } from "./setup-rig";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function root(): Promise<Paths> {
  const made = await tempRoot();
  cleanups.push(made.cleanup);
  return made.paths;
}

/** The daemon's status file, as it writes one, with this connection part:
 *  by a daemon that runs, written just now, unless `host` says otherwise. */
async function status(
  paths: Paths,
  connection: Record<string, unknown>,
  host: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(path.dirname(paths.status), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(
    paths.status,
    JSON.stringify({
      schemaVersion: 1,
      host: { state: "running", pid: 0, startedAt: now, updatedAt: now, error: null, writtenAt: now, ...host },
      connection: { message: null, ...connection },
      postgres: { phase: "ready", reason: null },
      modules: [],
    }),
  );
}

describe("what the console reads of the connection", () => {
  test("with no status file, nothing is known and nothing was refused", async () => {
    const paths = await root();
    expect(await readConsoleStatus(paths)).toEqual(ConsoleStatusUnavailable);
    expect(ConsoleStatusUnavailable).toEqual({ state: "unknown", reason: null, refused: false, idWaiting: false });
  });

  test("a connected daemon", async () => {
    const paths = await root();
    await status(paths, { state: "connected", reason: null });
    expect(await readConsoleStatus(paths)).toEqual({ state: "connected", reason: null, refused: false, idWaiting: false });
  });

  test("offline with a reason is a refusal by the control plane, with the daemon's own word", async () => {
    const paths = await root();
    for (const reason of ["invalid_credential", "protocol.version:2", REASON_WITHHELD, ORGANIZATION_CHANGED]) {
      await status(paths, { state: "offline", reason });
      expect(await readConsoleStatus(paths)).toEqual({ state: "offline", reason, refused: true, idWaiting: false });
    }
  });

  test("offline because no control plane is named is no refusal", async () => {
    const paths = await root();
    expect(NO_CONTROL_PLANE).toBe("no_control_plane");
    await status(paths, { state: "offline", reason: NO_CONTROL_PLANE });
    expect(await readConsoleStatus(paths)).toEqual({
      state: "offline",
      reason: NO_CONTROL_PLANE,
      refused: false,
      idWaiting: false,
    });
  });

  test("offline with no reason, or a reason while connecting, is no refusal", async () => {
    const paths = await root();
    await status(paths, { state: "offline", reason: null });
    expect((await readConsoleStatus(paths)).refused).toBe(false);
    await status(paths, { state: "connecting", reason: "invalid_credential" });
    expect(await readConsoleStatus(paths)).toEqual({
      state: "connecting",
      reason: "invalid_credential",
      refused: false,
      idWaiting: false,
    });
  });

  test("a reason that is not a word by the daemon's rule is neither shown nor taken as a refusal", async () => {
    const paths = await root();
    await status(paths, { state: "offline", reason: "this credential was revoked by an administrator" });
    expect(await readConsoleStatus(paths)).toEqual({ state: "offline", reason: null, refused: false, idWaiting: false });
  });

  test("a field the daemon does not write is not read", async () => {
    const paths = await root();
    await status(paths, { state: "offline", reason: null, stoppedBy: "control_plane" });
    expect(await readConsoleStatus(paths)).toEqual({ state: "offline", reason: null, refused: false, idWaiting: false });
  });

  test("the file of a daemon that is not running, or that is old, says nothing of how the connection stands now", async () => {
    const paths = await root();
    const connected = { state: "connected", reason: null };
    for (const state of ["stopped", "failed", "starting", "draining"]) {
      await status(paths, connected, { state });
      expect(await readConsoleStatus(paths)).toEqual(ConsoleStatusUnavailable);
    }
    // Written more than a few heartbeats ago, or by another clock ahead of
    // this one: a daemon that stopped writing is not known to run.
    const at = (ms: number): string => new Date(Date.now() + ms).toISOString();
    for (const writtenAt of [at(-(STATUS_STALE_MS + 5_000)), at(STATUS_STALE_MS + 5_000)]) {
      await status(paths, connected, { writtenAt, updatedAt: writtenAt });
      expect(await readConsoleStatus(paths)).toEqual(ConsoleStatusUnavailable);
    }
    // A daemon from before the heartbeat writes no `writtenAt`: its last
    // change counts.
    await status(paths, connected, { writtenAt: undefined, updatedAt: at(-1_000) });
    expect((await readConsoleStatus(paths)).state).toBe("connected");
    await status(paths, connected, { writtenAt: undefined, updatedAt: at(-(STATUS_STALE_MS + 5_000)) });
    expect((await readConsoleStatus(paths)).state).toBe("unknown");
  });

  test("a refusal is the last thing a daemon knew of the connection: it counts whatever the file's state and age", async () => {
    const paths = await root();
    const refusal = { state: "offline", reason: "invalid_credential" };
    const old = new Date(Date.now() - (STATUS_STALE_MS + 60_000)).toISOString();
    const refused = { ...ConsoleStatusUnavailable, reason: "invalid_credential", refused: true };

    // The start that met the refusal failed, and its last write says so.
    await status(paths, refusal, { state: "failed", error: "The control plane refused the connection" });
    expect(await readConsoleStatus(paths)).toEqual(refused);
    // A file of a running daemon that stopped writing long ago.
    await status(paths, refusal, { writtenAt: old, updatedAt: old });
    expect(await readConsoleStatus(paths)).toEqual(refused);
    // A start that never got past `starting`, gone quiet.
    await status(paths, refusal, { state: "starting", writtenAt: old, updatedAt: old });
    expect(await readConsoleStatus(paths)).toEqual(refused);
    // Having no control plane is no refusal, old or new.
    await status(paths, { state: "offline", reason: NO_CONTROL_PLANE }, { state: "failed" });
    expect(await readConsoleStatus(paths)).toEqual(ConsoleStatusUnavailable);
    // An old file that says "connected" says nothing.
    await status(paths, { state: "connected", reason: null }, { writtenAt: old, updatedAt: old });
    expect(await readConsoleStatus(paths)).toEqual(ConsoleStatusUnavailable);
  });

  test("an install id waits only for the control plane this HX Fortress names", async () => {
    const paths = await root();
    await status(paths, { state: "offline", reason: "invalid_credential" });
    // Nothing waits yet.
    expect((await readConsoleStatus(paths, { controlPlane: CONTROL })).idWaiting).toBe(false);
    await new FilePendingEnrollmentStore(paths.pendingEnrollment).save({ token: INSTALL_ID, cloudUrl: CONTROL });
    expect((await readConsoleStatus(paths, { controlPlane: CONTROL })).idWaiting).toBe(true);
    // The same control plane at the path of an earlier build is the same one.
    expect((await readConsoleStatus(paths, { controlPlane: EARLIER_CONTROL })).idWaiting).toBe(true);
    // Another control plane's id, or no control plane named, is not one that waits here.
    expect((await readConsoleStatus(paths, { controlPlane: "wss://elsewhere.example/v1/connection" })).idWaiting).toBe(false);
    expect((await readConsoleStatus(paths, { controlPlane: null })).idWaiting).toBe(false);
    expect((await readConsoleStatus(paths)).idWaiting).toBe(false);
    // With no status file it still says that an id waits: it waits for a start.
    await writeFile(paths.status, "not json");
    expect(await readConsoleStatus(paths, { controlPlane: CONTROL })).toEqual({ ...ConsoleStatusUnavailable, idWaiting: true });
  });
});

describe("the line on the Settings page", () => {
  const shown = (state: string, reason: string | null, refused: boolean): ConnectionShown => ({
    state,
    reason,
    refused,
    idWaiting: false,
  });

  test("connected, and when the saved answer is off, that the connection ends at the next start", () => {
    expect(connectionLine(shown("connected", null, false), false)).toEqual({ text: "Connected", word: null, tone: "ok", then: null });
    expect(connectionLine(shown("connected", null, false), true)).toEqual({
      text: "Connected",
      word: null,
      tone: "ok",
      then: "The connection ends when HX Fortress starts again.",
    });
  });

  test("switched off here, when the saved answer is off and the daemon is not connected", () => {
    for (const connection of [shown("offline", null, false), shown("unknown", null, false), shown("offline", "invalid_credential", true)]) {
      expect(connectionLine(connection, true)).toEqual({ text: "Switched off here", word: null, tone: "off", then: null });
    }
  });

  test("refused by the control plane, with the daemon's word", () => {
    expect(connectionLine(shown("offline", "invalid_credential", true), false)).toEqual({
      text: "The control plane refused the connection",
      word: "invalid_credential",
      tone: "bad",
      then: null,
    });
  });

  test("not connected otherwise", () => {
    for (const connection of [
      shown("unknown", null, false),
      shown("offline", NO_CONTROL_PLANE, false),
      shown("connecting", null, false),
      shown("offline", null, false),
    ]) {
      expect(connectionLine(connection, false)).toEqual({ text: "Not connected", word: null, tone: "off", then: null });
    }
  });
});
