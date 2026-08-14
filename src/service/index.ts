import { homedir, platform, userInfo } from "node:os";

import { LaunchdServiceManager } from "./launchd";
import { SystemdServiceManager } from "./systemd";
import type {
  ServiceInstallOptions,
  ServiceManager,
  ServiceState,
  ServiceUnit,
  UnitIdentity,
} from "./types";

export {
  CONSOLE_UNIT,
  DAEMON_UNIT,
} from "./types";
export type {
  CommandResult,
  CommandRunner,
  RestartDiscipline,
  ServiceInstallOptions,
  ServiceManager,
  ServiceState,
  ServiceUnit,
  UnitIdentity,
} from "./types";

interface ServiceManagerOptions {
  platform?: string;
  home?: string;
  uid?: number;
  /** Which unit this manager drives. Defaults to the daemon's. */
  unit?: UnitIdentity;
}

export function getServiceManager(
  options: ServiceManagerOptions = {},
): ServiceManager {
  const currentPlatform = options.platform ?? platform();
  const home = options.home ?? homedir();
  const uid = options.uid ?? userInfo().uid;

  if (currentPlatform === "darwin") {
    return new LaunchdServiceManager({ home, uid, ...(options.unit ? { unit: options.unit } : {}) });
  }
  if (currentPlatform === "linux") {
    return new SystemdServiceManager({ home, ...(options.unit ? { unit: options.unit } : {}) });
  }
  return new UnsupportedServiceManager(currentPlatform);
}

class UnsupportedServiceManager implements ServiceManager {
  readonly name = "unsupported";

  constructor(private readonly currentPlatform: string) {}

  install(options: ServiceInstallOptions): Promise<void> {
    void options;
    return Promise.reject(this.error());
  }

  start(): Promise<void> {
    return Promise.reject(this.error());
  }

  restart(): Promise<void> {
    return Promise.reject(this.error());
  }

  stop(): Promise<{ wasRunning: boolean }> {
    return Promise.reject(this.error());
  }

  state(): Promise<ServiceState> {
    return Promise.reject(this.error());
  }

  /** Answers rather than throws: "is a unit installed here" has a true answer on
   *  a host this build cannot drive, and every caller of it branches on the
   *  answer instead of on an exception. */
  unit(): Promise<ServiceUnit> {
    return Promise.resolve({ path: "", present: false, executablePath: null });
  }

  uninstall(): Promise<void> {
    return Promise.reject(this.error());
  }

  ensureLogDir(serviceLogPath: string): Promise<void> {
    void serviceLogPath;
    return Promise.resolve();
  }

  private error(): Error {
    return new Error(
      `Fortress background service is not supported on ${this.currentPlatform}.`,
    );
  }
}
