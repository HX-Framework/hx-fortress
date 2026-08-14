// What this fortress tells let.ai about its console, computed PER CONNECTION
// ATTEMPT.
//
// The advertisement used to be a boot-frozen snapshot, which made the states
// that matter unreachable: `ui sso off` and `ui disable` could never clear the
// URL from the hub, because the next reconnect re-sent the value the daemon had
// read at boot. Every field below is therefore derived from a FRESH read of
// ui.json and the environment at each hello.
//
// The predicate is all three of: sso on, an https publicUrl, and the console
// effectively enabled. Advertising a URL for a console that is switched off
// would put a button in the workbench that lands on a closed port.

import { parsePublicUrl } from "./bind";
import { effectiveUiEnabled, LiveUiConfig } from "./config";
import { detectContainer } from "./container";

export interface ConsoleAdvertisement {
  /** The origin, or null — an explicit clear the hub acts on. ABSENT when this
   *  fortress could not read its own config: the three wire states are distinct
   *  for a reason, and "I could not look" is not "switch it off". */
  consoleUrl?: string | null;
  runtimeKind: "host" | "container";
}

export interface AdvertisementDeps {
  config: Pick<LiveUiConfig, "read">;
  env: Record<string, string | undefined>;
  platform?: string;
}

export async function readConsoleAdvertisement(
  deps: AdvertisementDeps,
): Promise<ConsoleAdvertisement> {
  const detected = detectContainer({
    env: deps.env,
    ...(deps.platform ? { platform: deps.platform } : {}),
  });
  // DOCKER-CLASS only. An lxc or nspawn install runs under `systemd --user`,
  // keeps the TUI and full service control, and needs the HOST rungs; calling
  // it a container would hand its operator instructions that do not work there.
  const runtimeKind: "host" | "container" = detected.dockerClass ? "container" : "host";

  let config;
  try {
    config = await deps.config.read();
  } catch {
    // OMITTED, not null. A null is a deliberate clear: the hub drops the
    // advertised URL, drops the owner's approval AND suspends their manual
    // override. An unreadable ui.json — EACCES, EIO, a hand-edit mid-write — is
    // not a decision to switch the console off, and recovering from one costs
    // two owner gestures in the workbench even after the file is fine again.
    return { runtimeKind };
  }
  if (!config.sso) return { consoleUrl: null, runtimeKind };
  if (!effectiveUiEnabled(config, deps.env)) return { consoleUrl: null, runtimeKind };
  const publicUrl = deps.env.FORTRESS_UI_PUBLIC_URL?.trim() || config.publicUrl;
  if (!publicUrl) return { consoleUrl: null, runtimeKind };
  const parsed = parsePublicUrl(publicUrl);
  // Origin only. The console SPA is root-absolute, so a URL with a path
  // advertises a console that answers on no route it names — and the workbench
  // refuses it at approval, where nobody can act on the diagnosis.
  if (!parsed.ok) return { consoleUrl: null, runtimeKind };
  return { consoleUrl: parsed.origin, runtimeKind };
}
