import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { fortressPaths } from "./paths";

type FortressPaths = ReturnType<typeof fortressPaths>;

export interface InstalledModuleRecord {
  moduleId: string;
  version: string;
  artifactPath: string;
  checksum: string;
  installedAt: string;
}

export interface ModuleInventoryStore {
  load(): Promise<InstalledModuleRecord[]>;
  add(record: InstalledModuleRecord): Promise<void>;
  remove(moduleId: string): Promise<void>;
}

interface InventoryFile {
  schemaVersion: 1;
  modules: InstalledModuleRecord[];
}

export class FsModuleInventoryStore implements ModuleInventoryStore {
  constructor(private readonly paths: FortressPaths) {}

  async load(): Promise<InstalledModuleRecord[]> {
    let contents: string;
    try {
      contents = await readFile(this.paths.moduleInventory, "utf8");
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(contents) as InventoryFile;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.modules)) return [];
      return parsed.modules;
    } catch {
      return [];
    }
  }

  async add(record: InstalledModuleRecord): Promise<void> {
    const modules = await this.load();
    const existing = modules.findIndex((m) => m.moduleId === record.moduleId);
    if (existing >= 0) {
      modules[existing] = record;
    } else {
      modules.push(record);
    }
    await this.write(modules);
  }

  async remove(moduleId: string): Promise<void> {
    const modules = await this.load();
    const filtered = modules.filter((m) => m.moduleId !== moduleId);
    await this.write(filtered);
  }

  private async write(modules: InstalledModuleRecord[]): Promise<void> {
    const inventory: InventoryFile = { schemaVersion: 1, modules };
    await mkdir(path.dirname(this.paths.moduleInventory), { recursive: true });
    const tmp = `${this.paths.moduleInventory}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(inventory, null, 2)}\n`);
    await rename(tmp, this.paths.moduleInventory);
  }
}
