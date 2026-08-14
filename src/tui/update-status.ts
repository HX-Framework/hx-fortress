import type { ModuleUpdateMap } from "./types";

export interface UpdateStatusProvider {
  load(): Promise<ModuleUpdateMap>;
}

export class NoUpdateStatusProvider implements UpdateStatusProvider {
  async load(): Promise<ModuleUpdateMap> {
    return {};
  }
}
