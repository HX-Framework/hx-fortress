// The control plane's address, and the enrollment that connects this Fortress to
// one.
//
// A CONTROL PLANE IS OPTIONAL. A Fortress with none starts, runs and serves its
// console on its own. Connecting one is the last step of the setup: a person
// types its address, this Fortress asks that address for a short code, and the
// person signs in at the control plane and confirms the code there. The
// Fortress then belongs to the organization that person signed in to. Nobody
// else approves anything. The one-time token that comes back is kept for the
// first connection only.
//
// The address a person types is a host, or an https address with a path. The
// connection itself is a WebSocket at one fixed path under it, which is the
// path the protocol names. An address that already starts with `wss://` is
// taken as typed.

import { isLoopbackHost } from "../host/config";
import {
  installBaseFromCloudUrl,
  pollInstallToken,
  requestInstallCode,
  type InstallCode,
} from "../modules/session-vault/browser-enroll";

/** Where, under a control plane's address, the Fortress opens its connection. */
export const CONTROL_PLANE_PATH = "/_api/hx-gateway/vault-tunnel";

export type ControlPlaneUrl = { ok: true; url: string } | { ok: false; reason: string };

/**
 * The connection's address for what a person typed, or why it cannot be one.
 *
 * Cleartext is accepted only to this host itself, which is what a test of a
 * control plane on a laptop needs. Everywhere else the connection carries the
 * Fortress's credential, so it is `wss:`.
 */
export function controlPlaneUrl(address: string): ControlPlaneUrl {
  const typed = address.trim();
  if (!typed) return { ok: false, reason: "Give the control plane's address" };
  if (/\s/.test(typed)) return { ok: false, reason: "An address has no spaces" };

  const socket = /^wss?:\/\//i.test(typed);
  let url: URL;
  try {
    url = new URL(socket || /^https?:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    return { ok: false, reason: "This is not an address. Give a host, such as control.example" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "The address must not hold a user name or a password" };
  }
  if (url.search || url.hash) {
    return { ok: false, reason: "The address must not hold a query or a fragment" };
  }
  if (!url.hostname.includes(".") && !isLoopbackHost(url.hostname)) {
    return { ok: false, reason: "This is not an address. Give a host, such as control.example" };
  }
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  if (!secure && !isLoopbackHost(url.hostname)) {
    return { ok: false, reason: "The control plane's address must be https" };
  }
  if (socket) return { ok: true, url: typed };
  const prefix = url.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${secure ? "wss" : "ws"}://${url.host}${prefix}${CONTROL_PLANE_PATH}` };
}

/**
 * What a person would type for a stored connection address: the host, and the
 * path in front of the protocol's own. A connection address of another shape
 * is shown as it is.
 */
export function controlPlaneAddress(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!parsed.pathname.endsWith(CONTROL_PLANE_PATH)) return url;
  const prefix = parsed.pathname.slice(0, -CONTROL_PLANE_PATH.length);
  if (parsed.protocol === "wss:") return `${parsed.host}${prefix}`;
  if (parsed.protocol === "ws:") return `http://${parsed.host}${prefix}`;
  return url;
}

/** The host of a connection address, for a line a person reads. */
export function controlPlaneHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ── Enrollment ───────────────────────────────────────────────────────────────

/** An enrollment that waits for a person to sign in at the control plane. */
export interface Enrollment {
  /** The connection address the enrollment is for. */
  url: string;
  /** The code a person compares on both screens. */
  code: string;
  /** The control plane's page where the person signs in and confirms the code. */
  signInAt: string;
  /** Known to this Fortress only; it is what the token is fetched with. */
  deviceCode: string;
  /** When the code stops being asked about, on THIS host's clock. */
  deadline: number;
  /** How often the control plane wants to be asked, in seconds. */
  interval: number;
}

export type EnrollmentState =
  | { state: "waiting" }
  | { state: "ready"; token: string }
  | { state: "expired" }
  | { state: "refused"; reason: string };

export interface EnrollmentDeps {
  fetch?: typeof fetch;
  requestCode?: typeof requestInstallCode;
  poll?: typeof pollInstallToken;
  /** How long one request to the control plane may take. */
  timeoutMs?: number;
  now?: () => number;
}

const REQUEST_TIMEOUT_MS = 8_000;
/** How long a code is asked about when the control plane's own time for it
 *  cannot be used, and the longest any code is asked about. */
const DEFAULT_CODE_LIFETIME_MS = 10 * 60_000;
const MAX_CODE_LIFETIME_MS = 30 * 60_000;

/**
 * The door both enrollment requests go through. Each has a deadline, so a
 * control plane that takes the connection and never answers cannot hold the
 * setup. And none follows a redirect: the device code is sent to the address
 * a person gave, held to https by `controlPlaneUrl`, and to no address that an
 * answer from there names.
 */
function bounded(calls: typeof fetch, timeoutMs: number): typeof fetch {
  return ((input, init) =>
    calls(input, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) })) as typeof fetch;
}

/** Only an https page, or one on this host, is offered as the place to sign
 *  in. The address comes from the other side. */
function safeSignInAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === "https:") return url.toString();
    if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url.toString();
    return null;
  } catch {
    return null;
  }
}

/**
 * Ask a control plane for a code to sign in with.
 *
 * Throws one plain sentence when nothing at the address answers as a control
 * plane. What the other side sent is never repeated: only whether it answered.
 */
export async function startEnrollment(url: string, deps: EnrollmentDeps = {}): Promise<Enrollment> {
  const base = installBaseFromCloudUrl(url);
  const calls = bounded(deps.fetch ?? fetch, deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
  let code: InstallCode | null;
  try {
    code = await (deps.requestCode ?? requestInstallCode)(base, calls);
  } catch {
    throw new Error("No control plane answers at this address");
  }
  const signInAt = safeSignInAddress(code?.verificationUriComplete);
  if (
    !code ||
    typeof code.userCode !== "string" ||
    !/^[A-Za-z0-9-]{4,32}$/.test(code.userCode) ||
    typeof code.deviceCode !== "string" ||
    code.deviceCode.length === 0 ||
    code.deviceCode.length > 512 ||
    !signInAt
  ) {
    throw new Error("The address answered, but not as a control plane does");
  }
  const interval = Number.isFinite(code.interval) && code.interval > 0 ? Math.min(code.interval, 30) : 2;
  // How long the code lives is read from the control plane's own time for it,
  // and then counted on this host's clock from now. The two clocks are never
  // compared after this: a host whose clock is wrong would otherwise see every
  // code as run out, or never. A time that is past already, absent or far off
  // gets the usual lifetime.
  const now = (deps.now ?? Date.now)();
  const stated = typeof code.expiresAt === "string" ? Date.parse(code.expiresAt) - now : Number.NaN;
  const lifetime = stated > 0 && stated <= MAX_CODE_LIFETIME_MS ? stated : DEFAULT_CODE_LIFETIME_MS;
  return {
    url,
    code: code.userCode,
    signInAt,
    deviceCode: code.deviceCode,
    deadline: now + lifetime,
    interval,
  };
}

/** Ask once whether a person has signed in and confirmed the code. Never waits. */
export async function checkEnrollment(enrollment: Enrollment, deps: EnrollmentDeps = {}): Promise<EnrollmentState> {
  const base = installBaseFromCloudUrl(enrollment.url);
  // One look. The poll reads the clock once to start and once before each
  // request, so a clock that stands still for those two reads and then moves
  // past the deadline lets it ask exactly once.
  let reads = 0;
  const waiting = (): EnrollmentState =>
    enrollment.deadline <= (deps.now ?? Date.now)() ? { state: "expired" } : { state: "waiting" };
  let result: Awaited<ReturnType<typeof pollInstallToken>>;
  try {
    result = await (deps.poll ?? pollInstallToken)(base, enrollment.deviceCode, {
      intervalMs: 0,
      deadlineMs: 1,
      now: () => {
        reads += 1;
        return reads <= 2 ? 0 : 1;
      },
      sleep: async () => {},
      fetchImpl: bounded(deps.fetch ?? fetch, deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch {
    // An answer that is not what a control plane sends. Nothing was learned.
    return waiting();
  }
  if (result.kind === "ready") {
    // A token is a short line of printable text. Anything else is not one.
    if (!/^[\x21-\x7e]{8,512}$/.test(result.token)) {
      return { state: "refused", reason: "The control plane sent something that is not a token" };
    }
    return { state: "ready", token: result.token };
  }
  if (result.kind === "unavailable") {
    return {
      state: "refused",
      reason:
        result.reason === "already_installed"
          ? "The control plane says this organization has a Fortress enrolled already"
          : result.reason === "forbidden"
            ? "The person who signed in may not connect a Fortress to that organization"
            : "The control plane does not take a new Fortress for this organization",
    };
  }
  if (result.kind === "multiple_orgs") {
    return {
      state: "refused",
      reason:
        "More than one organization is waiting at the control plane. Take an enrollment token for one of " +
        "them there, and give it with hx-fortress enroll",
    };
  }
  // `expired` is also what one look returns while nobody has signed in yet.
  return waiting();
}
