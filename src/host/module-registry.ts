import type { MsgData, MsgReply } from "../protocol";
import { LogBus } from "./logging";
import { assertModuleId } from "./paths";
import type {
  EnrolledIdentity,
  LoadableRegistry,
  Module,
  ModuleRuntimeStatus,
  ModuleStartResult,
  ModuleState,
  ModuleStopResult,
  ModuleSupervisor,
} from "./types";

interface RegisteredModule {
  id: string;
  module: Module | null;
  state: ModuleState;
  error: string | null;
}

export class ModuleRegistry implements ModuleSupervisor, LoadableRegistry {
  private readonly modules = new Map<string, RegisteredModule>();
  private enrolledIdentity: EnrolledIdentity | null = null;

  constructor(private readonly bus: LogBus) {}

  /** Set the enrolled Fortress identity. Call this after the cloud connection
   *  authenticates, before starting modules. */
  setFortressIdentity(identity: EnrolledIdentity | null): void {
    this.enrolledIdentity = identity;
  }

  register(module: Module): void {
    assertModuleId(module.id);
    if (this.modules.has(module.id)) {
      throw new Error(`Module already registered: ${module.id}`);
    }
    this.modules.set(module.id, {
      id: module.id,
      module,
      state: "stopped",
      error: null,
    });
  }

  has(id: string): boolean {
    return this.modules.get(id)?.module != null;
  }

  get(id: string): Module | undefined {
    return this.modules.get(id)?.module ?? undefined;
  }

  snapshot(): readonly ModuleRuntimeStatus[] {
    return [...this.modules.values()].map((entry) => ({
      id: entry.id,
      state: entry.state,
      error: entry.error,
    }));
  }

  async startAll(
    moduleIds: readonly string[],
  ): Promise<readonly ModuleStartResult[]> {
    const results: ModuleStartResult[] = [];
    for (const id of moduleIds) {
      const entry = this.modules.get(id);
      if (!entry?.module) {
        const error = `Module not registered: ${id}`;
        this.modules.set(id, { id, module: null, state: "failed", error });
        results.push({ id, ok: false, error });
        continue;
      }
      try {
        entry.state = "starting";
        entry.error = null;
        await entry.module.init?.({
          moduleId: id,
          logger: this.bus.scopeFor(id),
          fortressIdentity: this.enrolledIdentity,
        });
        await entry.module.start?.();
        entry.state = "running";
        results.push({ id, ok: true });
      } catch (error) {
        const message = errorMessage(error);
        entry.state = "failed";
        entry.error = message;
        results.push({ id, ok: false, error: message });
      }
    }
    return results;
  }

  async stopAll(): Promise<readonly ModuleStopResult[]> {
    const results: ModuleStopResult[] = [];
    for (const entry of this.modules.values()) {
      if (entry.state !== "running" || !entry.module) continue;
      const { id, module } = entry;
      try {
        entry.state = "stopping";
        await module.stop?.();
        entry.state = "stopped";
        entry.error = null;
        results.push({ id, ok: true });
      } catch (error) {
        const message = errorMessage(error);
        entry.state = "failed";
        entry.error = message;
        this.bus.host.error(`Failed to stop Fortress module: ${id}`, { error: errorMessage(error) });
        results.push({ id, ok: false, error: message });
      }
    }
    return results;
  }

  async startOne(id: string): Promise<ModuleStartResult> {
    const results = await this.startAll([id]);
    return results[0] ?? { id, ok: false, error: "Module not registered" };
  }

  async stopOne(id: string): Promise<ModuleStopResult> {
    const entry = this.modules.get(id);
    if (!entry?.module || entry.state !== "running") {
      return { id, ok: true };
    }
    try {
      entry.state = "stopping";
      await entry.module.stop?.();
      entry.state = "stopped";
      entry.error = null;
      return { id, ok: true };
    } catch (error) {
      const message = errorMessage(error);
      entry.state = "failed";
      entry.error = message;
      this.bus.host.error(`Failed to stop Fortress module: ${id}`, { error: errorMessage(error) });
      return { id, ok: false, error: message };
    }
  }

  unregister(id: string): void {
    const entry = this.modules.get(id);
    if (!entry) return;
    if (entry.state === "running" || entry.state === "starting" || entry.state === "stopping") {
      throw new Error(`Cannot unregister module that is ${entry.state}: ${id}`);
    }
    this.modules.delete(id);
  }

  async dispatch(data: MsgData): Promise<MsgReply | undefined> {
    const entry = this.modules.get(data.module);
    if (!entry?.module || entry.state !== "running") {
      if (data.kind === "event") {
        this.bus.host.error(`Dropped event for module not running: ${data.module}`);
        return undefined;
      }
      return { ok: false, error: `Module not running: ${data.module}` };
    }

    let reply: MsgReply | void;
    try {
      reply = await entry.module.onMessage(data);
    } catch (error) {
      if (data.kind === "event") {
        this.bus.host.error(`Module event handler failed: ${data.module}`, { error: errorMessage(error) });
        return undefined;
      }
      return { ok: false, error: errorMessage(error) };
    }

    if (data.kind === "event") return undefined;
    if (!reply) {
      return { ok: false, error: `Module returned no reply for request: ${data.id}` };
    }
    return reply;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
