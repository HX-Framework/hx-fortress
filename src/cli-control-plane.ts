// `hx-fortress control-plane` — the control plane this HX Fortress is connected
// to, as this host sees it, and the one decision about it that is made here:
// which key of the control plane this HX Fortress trusts.
//
//   hx-fortress control-plane          the control plane this HX Fortress is
//                                      connected to, and the keys it trusts
//   hx-fortress control-plane pin      read the key the control plane publishes
//                                      now, show its fingerprint, and pin it
//   hx-fortress control-plane unpin    stop trusting the pinned key
//
// Pinning is a gesture of a person on this host, like approving a release. The
// fingerprint is what the person compares with what the control plane states
// about itself. Nothing a control plane sends reaches this verb.
//
// WHAT IS SHOWN IS WHAT THE DAEMON GOES BY. The daemon checks the proofs, and
// its environment may name the key (FORTRESS_CONTROL_PLANE_KEY) where this
// terminal's does not, or the other way round: a service has an environment
// of its own. So the daemon writes down what its environment names
// (src/host/daemon-environment.ts), and this verb reads that for as long as
// that daemon runs. With no daemon running, it can only go by its own
// environment, and says so.

import { CliAudit } from "./cli-audit";
import { readControlPlaneAddress } from "./cloud/address";
import { FileCredentialStore } from "./cloud/credentials";
import { AUDIT_ACTIONS } from "./console/audit-actions";
import { FileSigningKeyStore } from "./gateway/signing-key-store";
import { readDaemonEnvironment } from "./host/daemon-environment";
import { liveDaemonPid } from "./host/modules-api";
import { fortressPaths } from "./host/paths";
import {
  CONTROL_PLANE_KEY_ENV,
  ControlPlaneKeyStore,
  controlPlaneKeyNamedBy,
  fetchPublishedKeys,
  keyFingerprint,
  parseKeyList,
  sameFingerprint,
  type ControlPlaneKey,
} from "./host/trust/control-plane-keys";
import { controlPlaneAddress } from "./setup/control-plane";
import { readSetupMark } from "./setup/state";

type Paths = ReturnType<typeof fortressPaths>;

export interface ControlPlaneVerbDeps {
  writeLine: (line: string) => void;
  fortressRoot?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Whether a person is at this terminal. Without one, `pin` needs a
   *  fingerprint on the command line. */
  interactive?: boolean;
  /** Ask a yes-or-no question. The default answer is no. */
  confirm?: (question: string) => Promise<boolean>;
  /** The process id of the daemon that runs now, or null. Default: read from
   *  this HX Fortress's own status. */
  daemonPid?: () => Promise<number | null>;
}

const USAGE =
  "usage: hx-fortress control-plane | hx-fortress control-plane pin [--fingerprint <fingerprint>] | " +
  "hx-fortress control-plane unpin";

const NO_CONTROL_PLANE = "No control plane. This HX Fortress runs on its own.";

const day = (iso: string | null): string => (iso && iso.length >= 10 ? iso.slice(0, 10) : "an unrecorded day");
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The control plane this HX Fortress belongs to: the one config.json names,
 * or, while an administrator has the connection switched off, the one the
 * setup wrote down at that moment. The setup asks the same two places
 * (`enrolledWith`), so the two cannot say different things about one folder.
 */
async function controlPlaneOf(paths: Paths): Promise<{ address: string; switchedOff: boolean } | null> {
  const named = await readControlPlaneAddress(paths);
  if (named) return { address: named, switchedOff: false };
  const kept = (await readSetupMark(paths))?.disconnectedFrom;
  return kept ? { address: kept, switchedOff: true } : null;
}

/** What decides the control plane's key, as far as this terminal can tell. */
type Decided =
  /** An environment names the key: the running daemon's, or this terminal's
   *  own where the running daemon's is not known: none runs, or the one that
   *  runs could not write down what its environment names. */
  | { by: "environment"; whose: "daemon" | "terminal"; keys: ControlPlaneKey[]; daemonRuns: boolean }
  /** An environment names something that is not a key. No key is trusted. */
  | { by: "environment-invalid"; whose: "daemon" | "terminal"; reason: string }
  /** No environment names a key: a pin decides, or nothing does. `note` is a
   *  line about a variable that does not count here. */
  | { by: "pin"; note: string | null };

async function whatDecides(paths: Paths, deps: ControlPlaneVerbDeps): Promise<Decided> {
  const env = deps.env ?? process.env;
  const own = controlPlaneKeyNamedBy(env);
  const daemonPid = await (deps.daemonPid ?? ((): Promise<number | null> => liveDaemonPid(paths)))().catch(() => null);
  const daemon = await readDaemonEnvironment(paths, daemonPid);

  if (daemon?.running) {
    const named = daemon.controlPlaneKey;
    if (named === null) {
      return {
        by: "pin",
        note: own
          ? `This terminal's environment has ${CONTROL_PLANE_KEY_ENV}, and the running HX Fortress does not: ` +
            "it goes by what is shown here."
          : null,
      };
    }
    if ("invalid" in named) return { by: "environment-invalid", whose: "daemon", reason: named.invalid };
    try {
      // Checked again as the variable itself would be: the file is a file. The
      // variable is refused when it is empty, so a list with no key in it is
      // not something a daemon wrote.
      const keys = parseKeyList(named.value, CONTROL_PLANE_KEY_ENV);
      if (keys.length === 0) throw new Error(`${CONTROL_PLANE_KEY_ENV} names no key`);
      return { by: "environment", whose: "daemon", keys, daemonRuns: true };
    } catch (error) {
      return { by: "environment-invalid", whose: "daemon", reason: reasonOf(error) };
    }
  }

  // No record of the daemon that runs now. Either none runs, or the one that
  // runs could not write down what its environment names (it says so in its
  // log) and a record that is there is an earlier daemon's. What is said from
  // here on never claims that HX Fortress is stopped while a daemon runs.
  const daemonRuns = daemonPid !== null;
  if (own && "invalid" in own) return { by: "environment-invalid", whose: "terminal", reason: own.invalid };
  if (own) return { by: "environment", whose: "terminal", keys: own.value, daemonRuns };
  if (daemonRuns) {
    return {
      by: "pin",
      note:
        `HX Fortress runs, and what its environment names for ${CONTROL_PLANE_KEY_ENV} could not be read here. ` +
        "If it has that variable, the variable decides, and a pin is not used.",
    };
  }
  return {
    by: "pin",
    note:
      daemon && daemon.controlPlaneKey !== null
        ? `HX Fortress is not running. When it last ran, its environment had ${CONTROL_PLANE_KEY_ENV}. ` +
          "If it still has it when it starts, that variable decides, and a pin is not used."
        : null,
  };
}

const whoseWords = (whose: "daemon" | "terminal"): string =>
  whose === "daemon" ? "the environment HX Fortress runs with" : "this terminal's environment";

export async function runControlPlaneVerb(
  args: readonly string[],
  deps: ControlPlaneVerbDeps,
): Promise<number> {
  const paths = fortressPaths(deps.fortressRoot);
  const store = new ControlPlaneKeyStore(paths, deps.env ?? process.env);
  const at = await controlPlaneOf(paths);

  switch (args[0]) {
    case undefined:
      if (args.length > 0) throw new Error(USAGE);
      await show(deps, paths, store, at);
      return 0;
    case "pin":
      return pin(args.slice(1), deps, paths, store, at?.address ?? null);
    case "unpin":
      if (args.length > 1) throw new Error(USAGE);
      return unpin(deps, paths, store);
    default:
      throw new Error(USAGE);
  }
}

async function show(
  deps: ControlPlaneVerbDeps,
  paths: Paths,
  store: ControlPlaneKeyStore,
  at: { address: string; switchedOff: boolean } | null,
): Promise<void> {
  const { writeLine } = deps;
  if (!at) {
    writeLine(NO_CONTROL_PLANE);
    return;
  }
  const { address } = at;
  const credential = await new FileCredentialStore(paths.credentials).load().catch(() => null);
  const organizationKey = await new FileSigningKeyStore(paths.signingKey).loadRecord().catch(() => null);

  writeLine(`Control plane:  ${controlPlaneAddress(address)}`);
  writeLine(`  Address:      ${address}`);
  if (credential) {
    writeLine(`  Organization: ${credential.orgId}`);
    writeLine(`  This HX Fortress: ${credential.fortressId}`);
  } else {
    writeLine("  Not connected yet: this HX Fortress holds no credential for it.");
  }
  writeLine(
    at.switchedOff
      ? "  The connection is switched off. HX Fortress keeps what it needs to connect again."
      : "  `hx-fortress status` says whether the connection is open now.",
  );

  writeLine("");
  writeLine("The organization's key, which the control plane signs its grants with");
  if (organizationKey) {
    writeLine(`  ${keyFingerprint({ publicKey: organizationKey.key })}   pinned ${day(organizationKey.pinnedAt)}`);
    writeLine(
      organizationKey.rootVerified
        ? "  It came with a proof that was checked against the control plane's key."
        : "  It was pinned when first seen, with no proof checked.",
    );
  } else {
    writeLine("  none pinned yet. It is pinned when this HX Fortress first connects.");
  }

  writeLine("");
  writeLine("The control plane's key, which a change of the organization's key is checked against");
  const decided = await whatDecides(paths, deps);
  if (decided.by === "environment-invalid") {
    writeLine(`  The key named in ${whoseWords(decided.whose)} cannot be used: ${decided.reason}.`);
    writeLine(
      decided.whose === "daemon"
        ? "  No key is trusted until that setting is corrected."
        : "  With the same value in the environment HX Fortress runs with, no key is trusted until that setting is corrected.",
    );
    return;
  }
  if (decided.by === "environment") {
    for (const key of decided.keys) writeLine(`  ${keyFingerprint(key)}   ${key.id}`);
    writeLine(
      `  Named by ${CONTROL_PLANE_KEY_ENV} in ${whoseWords(decided.whose)}. ` +
        "Nothing a control plane publishes changes it.",
    );
    if (decided.whose === "terminal") {
      writeLine(
        decided.daemonRuns
          ? "  HX Fortress runs, and what its own environment names could not be read here. It goes by this key only if its environment has the variable too."
          : "  HX Fortress is not running. It goes by this key only if the environment it starts with has the variable too.",
      );
    }
    return;
  }

  const pinned = await store.pinFor(address);
  if (pinned) {
    for (const key of pinned.keys) writeLine(`  ${keyFingerprint(key)}   ${key.id}`);
    writeLine(
      pinned.how === "person"
        ? `  Pinned by a person on this host on ${day(pinned.pinnedAt)}.`
        : `  Pinned on ${day(pinned.pinnedAt)}, when this HX Fortress first connected. Nobody compared the fingerprint then.`,
    );
  } else {
    const other = await store.readPin();
    writeLine(
      other
        ? `  none for this control plane. A key is pinned for ${controlPlaneAddress(other.address)}, which is another one.`
        : "  none pinned.",
    );
    writeLine("  With no key pinned, a change of the organization's key is refused.");
    writeLine("  To pin the key the control plane publishes: hx-fortress control-plane pin");
  }
  if (decided.note) writeLine(`  ${decided.note}`);
}

function fingerprintsIn(args: readonly string[]): string[] {
  const given: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    // An index this loop counts.
    // eslint-disable-next-line security/detect-object-injection
    if (args[i] !== "--fingerprint") throw new Error(USAGE);
    const value = args[i + 1];
    if (!value || value.startsWith("--")) throw new Error(USAGE);
    given.push(value);
    i += 1;
  }
  return given;
}

async function pin(
  args: readonly string[],
  deps: ControlPlaneVerbDeps,
  paths: Paths,
  store: ControlPlaneKeyStore,
  address: string | null,
): Promise<number> {
  const { writeLine } = deps;
  const given = fingerprintsIn(args);
  if (!address) {
    throw new Error("this HX Fortress has no control plane, so there is no key to pin");
  }
  // A pin that would not be used is not made: the person would believe that
  // the pinned key is the one in force.
  const decided = await whatDecides(paths, deps);
  if (decided.by === "environment-invalid") {
    throw new Error(
      `the key named in ${whoseWords(decided.whose)} (${CONTROL_PLANE_KEY_ENV}) cannot be used: ${decided.reason}. ` +
        "Correct or remove that setting first: while it is there, a pin is not used",
    );
  }
  if (decided.by === "environment") {
    throw new Error(
      `${whoseWords(decided.whose)} names the control plane's key in ${CONTROL_PLANE_KEY_ENV}, so a pin would not be used. ` +
        (decided.whose === "daemon"
          ? "Change that setting to change the key"
          : "Change that setting to change the key, or run this command without the variable to pin one"),
    );
  }

  const shown = controlPlaneAddress(address);
  const published = await fetchPublishedKeys(address, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
  if (published.length === 0) {
    writeLine(`The control plane at ${shown} publishes no key. Nothing was pinned.`);
    return 1;
  }
  writeLine(`The control plane at ${shown} publishes ${published.length === 1 ? "this key" : "these keys"}:`);
  for (const key of published) writeLine(`  ${keyFingerprint(key)}   ${key.id}`);

  let chosen: ControlPlaneKey[];
  if (given.length > 0) {
    // Only what the person named is pinned: a key they did not compare is not
    // one they vouched for.
    const unknown = given.filter((fingerprint) => !published.some((key) => sameFingerprint(keyFingerprint(key), fingerprint)));
    if (unknown.length > 0) {
      throw new Error(
        `the control plane publishes no key with the fingerprint ${unknown.join(", ")}. Nothing was pinned`,
      );
    }
    chosen = published.filter((key) => given.some((fingerprint) => sameFingerprint(keyFingerprint(key), fingerprint)));
  } else {
    const interactive = deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!interactive) {
      throw new Error(
        "nobody is at this terminal to compare the fingerprint. Give --fingerprint <fingerprint> for each key to pin, as the control plane states it",
      );
    }
    writeLine("Compare each fingerprint with what the control plane states about itself.");
    const confirm = deps.confirm ?? defaultConfirm;
    if (!(await confirm(published.length === 1 ? "Pin this key?" : `Pin these ${published.length} keys?`))) {
      writeLine("Nothing was pinned.");
      return 1;
    }
    chosen = published;
  }

  const before = await store.pinFor(address);
  const same =
    before !== null &&
    before.how === "person" &&
    before.keys.length === chosen.length &&
    chosen.every((key) => before.keys.some((held) => held.id === key.id && held.publicKey === key.publicKey));
  if (same) {
    writeLine(chosen.length === 1 ? "This key is already pinned." : "These keys are already pinned.");
    return 0;
  }

  const audit = new CliAudit({
    dir: paths.auditSpool,
    ...(deps.now ? { now: deps.now } : {}),
    onWarn: (message) => writeLine(`warning: the audit record was incomplete - ${message}`),
  });
  await audit.run(
    AUDIT_ACTIONS.cliControlPlanePin,
    {
      controlPlane: shown,
      ids: chosen.map((key) => key.id).join(", "),
      fingerprints: chosen.map((key) => keyFingerprint(key)).join(", "),
    },
    () => store.pin(address, chosen, "person", deps.now?.() ?? new Date()),
  );
  writeLine(chosen.length === 1 ? "Pinned." : `Pinned ${chosen.length} keys.`);
  writeLine("A change of the organization's key is checked against it from the next connection on.");
  writeLine("If such a change was refused before, restart HX Fortress to take it now: hx-fortress stop, then hx-fortress start");
  if (decided.note) writeLine(decided.note);
  return 0;
}

async function unpin(deps: ControlPlaneVerbDeps, paths: Paths, store: ControlPlaneKeyStore): Promise<number> {
  const pinned = await store.readPin();
  if (!pinned) {
    deps.writeLine("No key of a control plane is pinned.");
    return 0;
  }
  const shown = controlPlaneAddress(pinned.address);
  const audit = new CliAudit({
    dir: paths.auditSpool,
    ...(deps.now ? { now: deps.now } : {}),
    onWarn: (message) => deps.writeLine(`warning: the audit record was incomplete - ${message}`),
  });
  await audit.run(
    AUDIT_ACTIONS.cliControlPlaneUnpin,
    {
      controlPlane: shown,
      ids: pinned.keys.map((key) => key.id).join(", "),
      fingerprints: pinned.keys.map((key) => keyFingerprint(key)).join(", "),
    },
    () => store.forget(),
  );
  deps.writeLine(`The key pinned for ${shown} is no longer trusted.`);
  const decided = await whatDecides(paths, deps);
  deps.writeLine(
    decided.by === "environment"
      ? `The key that ${whoseWords(decided.whose)} names in ${CONTROL_PLANE_KEY_ENV} is still the one in force.`
      : decided.by === "environment-invalid"
        ? // A new pin would not end the refusal: while that value is there no
          // key is trusted, and `pin` itself refuses.
          `The value of ${CONTROL_PLANE_KEY_ENV} in ${whoseWords(decided.whose)} is not a key (${decided.reason}). ` +
          "While it is there, no key is trusted and a pin is not used: correct or remove that setting."
        : "Until a key is pinned again, a change of the organization's key is refused.",
  );
  return 0;
}

async function defaultConfirm(question: string): Promise<boolean> {
  const { confirmPrompt } = await import("./modules/session-vault/prompt.js");
  return confirmPrompt(question, { default: false });
}
