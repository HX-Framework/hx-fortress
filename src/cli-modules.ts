// `hx-fortress modules` and `hx-fortress releases` — the local gestures.
//
// Two things about a Fortress can only be decided on the Fortress: which
// modules are switched on, and which releases are approved. These verbs are
// where that happens in this build. let.ai can show that a release waits; it
// cannot approve one, and nothing it sends reaches the code below.
//
// Like every terminal verb they run without a credential — whoever can type
// them already has the host — and every one that changes something is written
// to the audit trail before it acts, by a writer that refuses the act if the
// record cannot be written.

import { CLI_ACTOR, CliAudit } from "./cli-audit";
import { AUDIT_ACTIONS } from "./console/audit-actions";
import { SESSIONS_MODULE_ID, sessionsSettingFromEnv } from "./host/config";
import { catalogEntry, type CatalogEntry } from "./host/module-catalog";
import { isModuleId, type ReleaseRecord } from "./host/module-contract";
import {
  approveRelease,
  listModules,
  listReleases,
  liveDaemonPid,
  refuseRelease,
  switchModule,
  type DecideOptions,
  type DecisionOutcome,
  type ModuleView,
} from "./host/modules-api";
import { fortressPaths } from "./host/paths";
import { RELEASE_ID_PATTERN } from "./host/release-shelf";
import { describeShapeLines, SHAPE_LEGEND, type Shape } from "./host/shape";
import { FORTRESS_VERSION } from "./version";

export interface ModulesVerbDeps extends DecideOptions {
  writeLine: (line: string) => void;
  fortressRoot?: string;
  /** How long `modules on|off` watches for the daemon to act. */
  settleMs?: number;
  /** The modules of the build. A seam for tests; the terminal uses the catalog
   *  compiled into this binary. */
  catalog?: readonly CatalogEntry[];
  /** The terminal's environment. Read for FORTRESS_SESSIONS only. */
  env?: Record<string, string | undefined>;
}

const MODULES_USAGE = "usage: hx-fortress modules list | on <id> | off <id>";
const RELEASES_USAGE = "usage: hx-fortress releases list | approve <id> | refuse <id>";

function auditFor(deps: ModulesVerbDeps, dir: string): CliAudit {
  return new CliAudit({
    dir,
    ...(deps.now ? { now: deps.now } : {}),
    onWarn: (message) => deps.writeLine(`warning: the audit record was incomplete - ${message}`),
  });
}

// ── modules ──────────────────────────────────────────────────────────────────

export async function runModulesVerb(args: readonly string[], deps: ModulesVerbDeps): Promise<number> {
  const [verb, id, extra] = args;
  const paths = fortressPaths(deps.fortressRoot);
  const view = {
    ...(deps.catalog ? { catalog: deps.catalog } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };
  if (verb === "list" && id === undefined) {
    const running = (await liveDaemonPid(paths, (deps.now ?? ((): Date => new Date()))())) !== null;
    printModules(await listModules(paths, view), running, deps.writeLine);
    return 0;
  }
  if ((verb !== "on" && verb !== "off") || !id || extra !== undefined) throw new Error(MODULES_USAGE);

  const on = verb === "on";
  const result = await auditFor(deps, paths.auditSpool).run(
    on ? AUDIT_ACTIONS.cliModuleOn : AUDIT_ACTIONS.cliModuleOff,
    { module: isModuleId(id) ? id : "unknown", state: verb },
    () => switchModule(paths, id, on, deps),
  );

  if (!result.changed) {
    deps.writeLine(`${id} is already switched ${verb}.`);
    return 0;
  }
  deps.writeLine(`${id} is switched ${verb}.`);
  if (id === SESSIONS_MODULE_ID) {
    // A container sets FORTRESS_SESSIONS, and the Fortress applies it to
    // config.json at every start. Where this terminal sees the same variable
    // and it says the opposite, the switch just made will not last.
    const raw = (deps.env ?? process.env).FORTRESS_SESSIONS?.trim();
    let setting: "on" | "off" | null = null;
    try {
      setting = sessionsSettingFromEnv({ FORTRESS_SESSIONS: raw });
    } catch {
      // A value that is neither on nor off stops the Fortress from starting,
      // and says so there. Nothing to add here.
    }
    if (setting !== null && setting !== verb) {
      deps.writeLine(
        `FORTRESS_SESSIONS is set to ${setting} here. The Fortress applies it at every start, ` +
          `so it will switch Sessions ${setting} again. Change that setting to keep this.`,
      );
    }
  }
  const startOnly = catalogEntry(id, deps.catalog)?.startOnly ?? false;
  if (startOnly && result.daemonTold) {
    // The daemon wired this module into the rest of itself when it started, and
    // it reads this switch only then.
    deps.writeLine(
      "The running Fortress reads this switch only when it starts. Restart the Fortress to apply it.",
    );
    return 0;
  }
  if (!result.daemonTold) {
    deps.writeLine(
      on
        ? "The Fortress is not running. The module starts with it."
        : "The Fortress is not running. The module stays off when it starts.",
    );
    return 0;
  }
  const settled = await awaitModuleState(paths, id, on, deps);
  if (settled === "failed") {
    deps.writeLine(`The Fortress could not start ${id}. \`hx-fortress logs --module ${id}\` says why.`);
    return 1;
  }
  if (settled === null) {
    deps.writeLine(
      "The running Fortress has been told. `hx-fortress modules list` shows when it has acted.",
    );
  } else {
    deps.writeLine(
      on
        ? `The running Fortress started it. let.ai may now ask ${id} what its list allows.`
        : `The running Fortress stopped it. Every ask to ${id} is refused from now on.`,
    );
  }
  return 0;
}

/** Watch the daemon's published status until the module is where the switch
 *  puts it. Null when the wait ran out, which is not a failure: the status file
 *  is rewritten on a five-second heartbeat. */
async function awaitModuleState(
  paths: ReturnType<typeof fortressPaths>,
  id: string,
  on: boolean,
  deps: ModulesVerbDeps,
): Promise<"settled" | "failed" | null> {
  const waitMs = deps.settleMs ?? 8_000;
  const pollMs = deps.pollMs ?? 250;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let waited = 0; waited <= waitMs; waited += pollMs) {
    const view = {
      ...(deps.catalog ? { catalog: deps.catalog } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    };
    const state = (await listModules(paths, view)).find((module) => module.id === id)?.state;
    if (on && state === "running") return "settled";
    if (on && state === "failed") return "failed";
    if (!on && (state === "stopped" || state === "failed")) return "settled";
    if (waited + pollMs > waitMs) break;
    await sleep(pollMs);
  }
  return null;
}

function printModules(
  modules: readonly ModuleView[],
  daemonRunning: boolean,
  writeLine: (line: string) => void,
): void {
  writeLine(`Modules in this build (hx-fortress ${FORTRESS_VERSION})`);
  if (!daemonRunning) writeLine("The Fortress is not running, so no module is.");
  for (const module of modules) {
    writeLine("");
    writeLine(`${module.id} (${module.title}): ${module.on ? "on" : "off"}`);
    writeLine(`  Does:     ${module.summary}`);
    writeLine(`  State:    ${stateWord(module, daemonRunning)}`);
    writeLine(`  Version:  ${module.version}`);
    if (!module.declared) {
      // No manifest, so nothing below is KNOWN to be empty. Saying "no hosts"
      // of a module that writes to a bucket would be false.
      writeLine("  Calls:    not listed. This module has no manifest, so it is held to no list of hosts.");
      writeLine("            The console's list of data paths shows what it reaches, and what reaches it.");
      writeLine("  Secrets:  not listed.");
      writeLine("  Asks:     none. let.ai can send this module no ask.");
      continue;
    }
    writeLine(`  Calls:    ${module.egress.length === 0 ? "no hosts" : module.egress.join(", ")}`);
    writeLine(`  Secrets:  ${module.secrets.length === 0 ? "none" : module.secrets.join(", ")}`);
    if (module.asks.length === 0) {
      writeLine("  Asks:     none. let.ai can send this module no ask.");
      continue;
    }
    writeLine(`  Asks:     ${module.asks.length}. let.ai may ask it these and nothing else:`);
    for (const ask of module.asks) {
      writeLine(`    ${ask.name}`);
      printShape("takes", ask.argsShape, writeLine);
      printShape("answers", ask.replyShape, writeLine);
    }
  }
  if (modules.some((module) => module.asks.length > 0)) {
    writeLine("");
    for (const line of SHAPE_LEGEND) writeLine(line);
  }
  writeLine("");
  writeLine("Switch one with `hx-fortress modules on <id>` or `hx-fortress modules off <id>`.");
}

/** One shape under its label, a field to a line. */
function printShape(label: string, shape: Shape, writeLine: (line: string) => void): void {
  const [first, ...rest] = describeShapeLines(shape);
  writeLine(`      ${label.padEnd(8)} ${first}`);
  for (const line of rest) writeLine(`      ${"".padEnd(8)} ${line}`);
}

function stateWord(module: ModuleView, daemonRunning: boolean): string {
  const state = module.state === "failed" ? "failed to start" : module.state;
  // A switch the daemon reads only when it starts can differ from what is
  // running now. Say so, or the two lines above read as a contradiction.
  const differs =
    daemonRunning && module.startOnly && module.on !== (module.state === "running");
  return differs
    ? `${state}. The switch is read when the Fortress starts: restart it to apply.`
    : state;
}

// ── releases ─────────────────────────────────────────────────────────────────

export async function runReleasesVerb(args: readonly string[], deps: ModulesVerbDeps): Promise<number> {
  const [verb, id, extra] = args;
  const paths = fortressPaths(deps.fortressRoot);
  if (verb === "list" && id === undefined) {
    printReleases(await listReleases(paths), deps.writeLine);
    return 0;
  }
  if ((verb !== "approve" && verb !== "refuse") || !id || extra !== undefined) {
    throw new Error(RELEASES_USAGE);
  }
  if (!RELEASE_ID_PATTERN.test(id)) {
    throw new Error("that is not a release id. `hx-fortress releases list` shows them.");
  }
  const release = (await listReleases(paths)).find((candidate) => candidate.id === id);
  if (!release) {
    throw new Error(`there is no release ${id} on this Fortress. \`hx-fortress releases list\` shows them.`);
  }

  const outcome = await auditFor(deps, paths.auditSpool).run(
    verb === "approve" ? AUDIT_ACTIONS.cliReleaseApprove : AUDIT_ACTIONS.cliReleaseRefuse,
    { release: release.id, module: release.moduleId, version: release.version },
    async () => {
      const answer =
        verb === "approve"
          ? await approveRelease(paths, id, CLI_ACTOR, deps)
          : await refuseRelease(paths, id, CLI_ACTOR, deps);
      // A decision the daemon would not carry out is a failed act, and is
      // recorded as one.
      if (answer && !answer.ok) throw new Error(refusalSentence(answer, release));
      return answer;
    },
  );
  return reportDecision(verb, release, outcome, deps.writeLine);
}

function label(release: Pick<ReleaseRecord, "moduleId" | "version">): string {
  return `${release.moduleId} ${release.version}`;
}

function refusalSentence(answer: NonNullable<DecisionOutcome>, release: ReleaseRecord): string {
  switch (answer.reason) {
    case "release_unknown":
      return `there is no release ${release.id} on this Fortress.`;
    case "not_waiting":
      return `${label(release)} is ${answer.state ?? release.state}, so there is nothing to decide.`;
    case "module_off":
      return `${release.moduleId} is switched off. Switch it on with \`hx-fortress modules on ${release.moduleId}\`, then approve again.`;
    case "module_not_running":
      return `${release.moduleId} is switched on and is not running. \`hx-fortress logs --module ${release.moduleId}\` says why.`;
    case "module_takes_no_releases":
      return `${release.moduleId} takes no releases in this build.`;
    case "still_applying":
      return `${release.moduleId} is still applying ${label(release)}. Nothing can be decided about it until that ends.`;
    case "signer_untrusted":
      return `${label(release)} was signed by ${release.signedBy}, a key this Fortress does not trust now. It was not applied. Refuse it, or run a build that trusts that key.`;
    case "artifact_missing":
      return `the file of ${label(release)} is no longer on disk, so it cannot be applied. It is marked failed. If let.ai offers the release again, the file comes back.`;
    case "artifact_changed":
      return `the artifact of ${label(release)} no longer matches its checksum, so it was not applied. It is marked failed.`;
    case "expired":
      return "the Fortress took too long to pick the request up. Nothing was changed. Run this again.";
    default:
      return `the Fortress could not carry this out (${answer.reason ?? "no reason given"}).`;
  }
}

function reportDecision(
  verb: "approve" | "refuse",
  release: ReleaseRecord,
  outcome: DecisionOutcome,
  writeLine: (line: string) => void,
): number {
  if (outcome === null) {
    writeLine(`Asked the Fortress to ${verb} ${label(release)}.`);
    writeLine("It has not answered yet. `hx-fortress releases list` shows where the release stands.");
    return 0;
  }
  if (verb === "refuse") {
    writeLine(
      release.handedAt
        ? `${label(release)} is refused. It was handed to ${release.moduleId} once, at ${release.handedAt}, and that did not finish. It will not be handed to it again.`
        : `${label(release)} is refused. It was never handed to ${release.moduleId}.`,
    );
    return 0;
  }
  if (outcome.state === "installed") {
    writeLine(`${label(release)} is approved and installed.`);
    return 0;
  }
  writeLine(
    `${label(release)} is approved, and ${release.moduleId} could not apply it (${outcome.error ?? "no code given"}).`,
  );
  writeLine(
    outcome.error === "timeout"
      ? `${release.moduleId} may still be working on it. \`hx-fortress releases list\` shows it as installed if it finishes.`
      : "Fix the cause, then approve it again.",
  );
  return 1;
}

function printReleases(releases: readonly ReleaseRecord[], writeLine: (line: string) => void): void {
  if (releases.length === 0) {
    writeLine("let.ai has offered no release to this Fortress.");
    return;
  }
  writeLine("Releases let.ai has offered, newest first");
  for (const release of releases) {
    writeLine("");
    writeLine(`${release.id}: ${label(release)}, ${release.state}`);
    writeLine(`  Offered:   ${release.offeredAt}`);
    writeLine(`  Signed by: ${release.signedBy}`);
    writeLine(`  sha256:    ${release.checksum}`);
    if (release.decidedAt) {
      const how = release.state === "refused" ? "Refused: " : "Approved:";
      writeLine(`  ${how}  ${release.decidedAt} by ${release.decidedBy ?? "unknown"}`);
    }
    if (release.error) writeLine(`  Failed:    ${release.error}`);
    if (release.handedAt && release.state === "failed") {
      writeLine(`  Handed to ${release.moduleId} at ${release.handedAt}. It may have been applied in part.`);
    }
  }
  if (releases.some((release) => release.state === "waiting" || release.state === "failed")) {
    writeLine("");
    writeLine("Decide one with `hx-fortress releases approve <id>` or `hx-fortress releases refuse <id>`.");
  }
}
