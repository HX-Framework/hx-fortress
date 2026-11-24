import { controlPlaneHttpBase } from "../../cloud/address";
import { FORTRESS_VERSION } from "../../version.js";

const UA = { "User-Agent": `hx-fortress/${FORTRESS_VERSION}` };

/**
 * The https address that the requests of an enrollment from a terminal go to:
 * beside the control plane's connection address, as src/cloud/address.ts works
 * it out. `wss://control.example/v1/connection` gives
 * `https://control.example/v1`.
 *
 * Throws on a value that is not a control plane's address. The answer to these
 * requests is an enrollment token, so nothing is asked of an address this
 * program cannot read, and nothing is asked in clear text of another host.
 */
export function installBaseFromCloudUrl(cloudUrl: string): string {
  return controlPlaneHttpBase(cloudUrl);
}

export interface InstallCode {
  userCode: string;
  deviceCode: string;
  verificationUriComplete: string;
  interval: number;
  expiresAt: string;
}

export async function requestInstallCode(
  installBase: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InstallCode> {
  const res = await fetchImpl(`${installBase}/vault/install/code`, {
    method: "POST",
    headers: { ...UA, "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`install/code → ${res.status} ${res.statusText}`);
  return (await res.json()) as InstallCode;
}

export type PollResult =
  | { kind: "ready"; token: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "multiple_orgs" }
  | { kind: "expired" };

export interface PollInstallTokenOpts {
  intervalMs: number;
  deadlineMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  onTick?: () => void;
}

export async function pollInstallToken(
  installBase: string,
  deviceCode: string,
  opts: PollInstallTokenOpts,
): Promise<PollResult> {
  const start = opts.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  while (opts.now() - start < opts.deadlineMs) {
    opts.onTick?.();
    let body: { status: string; reason?: string; token?: string };
    try {
      const res = await fetchImpl(`${installBase}/vault/install/poll`, {
        method: "POST",
        headers: { ...UA, "content-type": "application/json" },
        body: JSON.stringify({ deviceCode }),
      });
      body = (await res.json()) as typeof body;
    } catch {
      // Transient network failure — back off and retry rather than crash.
      await opts.sleep(opts.intervalMs);
      continue;
    }
    if (body.status === "ready" && body.token) return { kind: "ready", token: body.token };
    if (body.status === "unavailable") return { kind: "unavailable", reason: body.reason ?? "not_enabled" };
    if (body.status === "multiple_orgs") return { kind: "multiple_orgs" };
    if (body.status === "expired") return { kind: "expired" };
    await opts.sleep(opts.intervalMs);
  }
  return { kind: "expired" };
}
