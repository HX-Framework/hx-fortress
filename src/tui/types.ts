import type { InstalledModuleRecord } from "../host/module-inventory";
import type { HostStatusSnapshot, ModuleState } from "../host/types";
import type { ServiceState } from "../service/types";

export type MainScreenRowId =
  | "session_vault"
  | "session_computer"
  | "devops_utility";

export type MainScreenAvailability = "live" | "unavailable";

export type MainScreenActionKind =
  | "start"
  | "stop"
  | "update"
  | "view-details";

export type MainScreenAction =
  | { kind: "start"; enabled: boolean }
  | { kind: "stop"; enabled: boolean }
  | { kind: "update"; enabled: boolean; version: string }
  | { kind: "view-details"; enabled: boolean };

export interface MainScreenRow {
  id: MainScreenRowId;
  label: string;
  availability: MainScreenAvailability;
  statusLabel: ModuleState | "unavailable";
  installedVersion: string | null;
  availableVersion: string | null;
  actions: MainScreenAction[];
}

export interface MainScreenModel {
  rows: MainScreenRow[];
  footerNote: string;
}

export interface ModuleUpdateStatus {
  kind: "module" | "binary";
  version: string;
}

export type ModuleUpdateMap = Partial<Record<MainScreenRowId, ModuleUpdateStatus>>;

export interface BuildMainScreenModelParams {
  service: ServiceState;
  snapshot: HostStatusSnapshot | null;
  installedModules: InstalledModuleRecord[];
  updates: ModuleUpdateMap;
}

export type DetailsScreenAction =
  | { kind: "update"; enabled: boolean; version: string }
  | { kind: "uninstall"; enabled: boolean; reason: string | null }
  | { kind: "back"; enabled: boolean };

export interface DetailsScreenModel {
  id: MainScreenRowId;
  label: string;
  installedVersion: string | null;
  availableVersion: string | null;
  isBundledCore: boolean;
  actions: DetailsScreenAction[];
}

export interface BuildDetailsScreenModelParams {
  id: MainScreenRowId;
  installedVersion: string | null;
  availableVersion: string | null;
}
