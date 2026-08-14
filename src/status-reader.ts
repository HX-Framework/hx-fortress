import { readFile } from "node:fs/promises";

import { MODULE_ID_PATTERN } from "./host/paths";
import type {
  ConnectionState,
  HostState,
  HostStatusSnapshot,
  ModuleRuntimeStatus,
  ModuleState,
  PostgresPhase,
} from "./host/types";

export interface StatusReader {
  read(): Promise<HostStatusSnapshot | null>;
}

const HOST_STATES = new Set<HostState>([
  "stopped",
  "starting",
  "running",
  "draining",
  "failed",
]);
const CONNECTION_STATES = new Set<ConnectionState>([
  "offline",
  "connecting",
  "connected",
  "closing",
]);
const MODULE_STATES = new Set<ModuleState>([
  "stopped",
  "starting",
  "running",
  "stopping",
  "failed",
]);
/** Phases this build knows about — exported for tests. The parser deliberately
 *  does NOT reject phases outside this set (cross-version tolerance). */
export const KNOWN_PG_PHASES = new Set<PostgresPhase>([
  "acquiring",
  "initializing",
  "retrying",
  "ready",
  "failed",
]);

export class FileStatusReader implements StatusReader {
  constructor(private readonly statusPath: string) {}

  async read(): Promise<HostStatusSnapshot | null> {
    let contents: string;
    try {
      contents = await readFile(this.statusPath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw invalidStatus("unable to read status.json");
    }

    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      throw invalidStatus("malformed JSON");
    }

    return parseStatus(value);
  }
}

function parseStatus(value: unknown): HostStatusSnapshot {
  try {
    if (!isRecord(value)) throw new Error("root must be an object");
    if (value.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
    if (!isRecord(value.host)) throw new Error("host must be an object");
    if (!HOST_STATES.has(value.host.state as HostState)) {
      throw new Error("host.state is invalid");
    }
    if (!Number.isInteger(value.host.pid) || Number(value.host.pid) <= 0) {
      throw new Error("host.pid must be a positive integer");
    }
    assertNullableString(value.host.startedAt, "host.startedAt");
    assertString(value.host.updatedAt, "host.updatedAt");
    assertNullableString(value.host.error, "host.error");
    // OPTIONAL, both of them. Every enrolled fortress in the field holds a
    // status.json written before either existed, and a parse error there would
    // turn an upgrade into "Fortress: unavailable" — so absence is a state to
    // render (age unknown, root unknown), never a refusal.
    assertOptionalString(value.host.writtenAt, "host.writtenAt");
    assertOptionalString(value.host.root, "host.root");

    if (!isRecord(value.connection)) {
      throw new Error("connection must be an object");
    }
    if (!CONNECTION_STATES.has(value.connection.state as ConnectionState)) {
      throw new Error("connection.state is invalid");
    }
    assertNullableString(value.connection.reason, "connection.reason");
    assertNullableString(value.connection.message, "connection.message");

    if (!isRecord(value.postgres)) {
      throw new Error("postgres must be an object");
    }
    // Unknown phases PASS THROUGH as their raw string instead of throwing:
    // the 0.16.1 reader crashed the status command and the TUI launch the
    // moment a newer host wrote a phase it didn't know ("retrying") — a
    // display surface must tolerate cross-version skew. Known phases still
    // validate via PG_PHASES (kept for exhaustiveness + tests).
    if (typeof value.postgres.phase !== "string" || value.postgres.phase.length === 0) {
      throw new Error("postgres.phase is invalid");
    }
    assertNullableString(value.postgres.reason, "postgres.reason");

    if (!Array.isArray(value.modules)) {
      throw new Error("modules must be an array");
    }

    const modules = value.modules.map(parseModule);
    return {
      schemaVersion: 1,
      host: {
        state: value.host.state as HostState,
        pid: Number(value.host.pid),
        startedAt: value.host.startedAt as string | null,
        updatedAt: value.host.updatedAt as string,
        error: value.host.error as string | null,
        ...(typeof value.host.writtenAt === "string" ? { writtenAt: value.host.writtenAt } : {}),
        ...(typeof value.host.root === "string" ? { root: value.host.root } : {}),
      },
      connection: {
        state: value.connection.state as ConnectionState,
        reason: value.connection.reason as string | null,
        message: value.connection.message as string | null,
      },
      postgres: {
        phase: value.postgres.phase as PostgresPhase,
        reason: value.postgres.reason as string | null,
      },
      modules,
    };
  } catch (error) {
    throw invalidStatus(errorMessage(error));
  }
}

function parseModule(value: unknown, index: number): ModuleRuntimeStatus {
  if (!isRecord(value)) throw new Error(`modules[${index}] must be an object`);
  if (typeof value.id !== "string" || !MODULE_ID_PATTERN.test(value.id)) {
    throw new Error(`modules[${index}].id is invalid`);
  }
  if (!MODULE_STATES.has(value.state as ModuleState)) {
    throw new Error(`modules[${index}].state is invalid`);
  }
  assertNullableString(value.error, `modules[${index}].error`);
  return {
    id: value.id,
    state: value.state as ModuleState,
    error: value.error as string | null,
  };
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
}

function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${field} must be a string when present`);
  }
}

function assertNullableString(
  value: unknown,
  field: string,
): asserts value is string | null {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${field} must be a string or null`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function invalidStatus(reason: string): Error {
  return new Error(`Invalid Fortress status: ${reason}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown validation error";
}
