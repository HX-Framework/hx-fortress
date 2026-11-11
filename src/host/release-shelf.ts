// The release shelf: where a release the relay offered waits for a person.
//
// The relay may OFFER a release for a module (the `moduleAdvertise` frame). An
// offer changes nothing. The Fortress checks the offer's signature, fetches the
// file from the relay's own origin (or a host the operator listed), checks its
// sha256, and puts it on the shelf as `waiting`. That is the whole effect of an
// offer.
//
// A person on this side then approves or refuses it, from this host's terminal
// or its console. Only an approval hands the file to the module, through
// `applyRelease`. The Fortress itself never executes a release: it is opaque
// bytes here, and what they mean is the module's business. The module's own
// code came with the Fortress binary.
//
// THE SIGNATURE IS REQUIRED, AND IT IS CHECKED FIRST. An offer with no
// signature is refused in every build and under every setting. The signature
// is verified before anything is fetched. Until it verifies, the only setting
// of this host that is read is the one that says which keys count
// (FORTRESS_ALLOW_DEV_RELEASES, below), and the relay is told nothing about
// which modules are on, which hosts are listed or what is on the shelf. So an
// offer nobody signed makes this host do nothing but refuse it.
//
// WHAT IS SIGNED is a statement, not the file: the module's id, the version,
// and the file's sha256, under a first line that no other signed artifact
// starts with (`releaseStatement`). So the name and the version a person sees
// when approving are the signer's, not the relay's, and a signature made over
// something else (an older release, another module's release, the Fortress
// binary) does not verify here. The file is then held to the signed sha256.
//
// A DEVELOPMENT ANCHOR COUNTS ONLY WHEN ASKED FOR. While this build carries no
// production anchor, a release signed by the development key is accepted only
// with FORTRESS_ALLOW_DEV_RELEASES=1 — a development key is one anybody with
// the repository's history could come to hold. Once a production anchor is
// baked in, the development one never counts, whatever the environment says.

// Every path this file opens is built from the fortress root, a module id that
// passed the id pattern, and a release id this file generated. None comes from
// the relay's frame.
/* eslint-disable security/detect-non-literal-fs-filename */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { AUDIT_ACTIONS } from "../console/audit-actions";
import { parseBooleanEnv } from "../env";
import { RELAY_ACTOR, type AuditParams, type ModuleAudit } from "./module-audit";
import {
  failureCode,
  failureForLog,
  isFortressModule,
  isModuleId,
  type ApprovedRelease,
  type FortressModule,
  type ModuleContextV2,
  type ReleaseRecord,
} from "./module-contract";
import type { fortressPaths } from "./paths";
import type { AuditRecord } from "../console/audit-spool";
import { writePrivateJson } from "./private-json";
import { RateWindow } from "./rate-window";
import {
  artifactUrlDefect,
  fetchReleaseArtifact,
  listedReleaseHosts,
  ReleaseFetchRefused,
  type ReleaseFetchRule,
  type ReleaseSources,
} from "./release-fetch";
import {
  hasProductionAnchor,
  isProductionAnchor,
  TRUSTED_SIGNING_KEYS,
  type TrustedSigningKey,
} from "./trust/signing-keys";
import { parseSignatureSidecar, verifyDetachedSignature } from "./trust/verify";
import { withDeadline } from "./with-deadline";
import type { Module, ScopedLogger } from "./types";

type FortressPaths = ReturnType<typeof fortressPaths>;

/** A release's version. Every character is one a `name` may hold, because the
 *  `host` module reports versions as names: a version that is not a name would
 *  make that answer fail its own shape. So there is no `+`. */
export const RELEASE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The first line of what a module release's signature is made over. */
export const RELEASE_STATEMENT_CONTEXT = "hx-fortress module release v1";

/**
 * The bytes a module release's signature is made over: four lines, each ended
 * by a newline. The context, the module id, the version, and the lowercase hex
 * sha256 of the file.
 *
 * None of the three values can hold a newline (each is held to its pattern
 * before this is called), so one statement reads one way.
 */
export function releaseStatement(moduleId: string, version: string, checksum: string): Uint8Array {
  return new TextEncoder().encode(
    `${RELEASE_STATEMENT_CONTEXT}\n${moduleId}\n${version}\n${checksum}\n`,
  );
}
/** Longest signature sidecar an offer may carry. A real one is under 200 characters. */
const SIGNATURE_MAX_CHARS = 2048;
export const RELEASE_ID_PATTERN = /^rel-[0-9a-f]{16}$/;
/** Releases that may wait at once. Each is up to 64 MiB on disk. */
export const SHELF_MAX_WAITING = 16;
/** Records kept on the shelf. Past it the oldest decided ones are dropped from
 *  the shelf; the audit trail keeps every one of them. */
export const SHELF_MAX_RECORDS = 500;
/** Offers that may be FETCHED in any minute, counted exactly (see
 *  rate-window.ts). An offer for a release already on the shelf is not fetched
 *  and does not count. */
export const INTAKE_MAX_PER_MINUTE = 6;
/** Offers that may wait their turn to be fetched. One is fetched at a time. */
export const INTAKE_MAX_QUEUED = 4;
/** How long a module may take to apply a release. */
export const APPLY_DEADLINE_MS = 10 * 60_000;
const DECIDED_BY_MAX_CHARS = 128;

/** The trust anchors a release may be signed by, in THIS build and environment. */
export function releaseAnchors(
  env: Record<string, string | undefined> = process.env,
  keys: readonly TrustedSigningKey[] = TRUSTED_SIGNING_KEYS,
): readonly TrustedSigningKey[] {
  if (hasProductionAnchor(keys)) return keys.filter(isProductionAnchor);
  return parseBooleanEnv(env.FORTRESS_ALLOW_DEV_RELEASES) ? keys : [];
}

/** Why an offer did not reach the shelf. A fixed vocabulary. */
export type OfferRule =
  | "module_unknown"
  | "version_malformed"
  | "module_takes_no_releases"
  | "module_off"
  | "signature_missing"
  | "signature_malformed"
  | "no_trusted_anchor"
  | "signer_untrusted"
  | "checksum_malformed"
  | ReleaseFetchRule
  | "version_conflict"
  | "shelf_full"
  | "busy"
  | "rate_limited"
  | "audit_unavailable"
  | "signature_invalid"
  | "checksum_mismatch"
  | "shelf_unwritable";

/** What goes back to the relay as a `moduleInstallResult` frame. */
export type InstallResult =
  | { moduleId: string; version: string; ok: true }
  | { moduleId: string; version: string; ok: false; error: string };

export type DecisionRefusal =
  | "release_unknown"
  | "not_waiting"
  | "module_off"
  | "module_not_running"
  | "module_takes_no_releases"
  | "artifact_missing"
  | "artifact_changed"
  | "signer_untrusted"
  | "still_applying";

export type DecisionResult =
  | { ok: true; release: ReleaseRecord }
  | { ok: false; reason: DecisionRefusal; release?: ReleaseRecord };

/** A record as the shelf file holds it. The three extra fields are the shelf's
 *  own bookkeeping and never leave this file. */
interface StoredRelease extends ReleaseRecord {
  /** The signature sidecar the offer carried, over `releaseStatement`. Kept so
   *  an approval can verify it again, against the keys trusted at that moment. */
  signature: string;
  /** The artifact's file name under the module's artifacts directory, while kept. */
  artifact: string | null;
  bytes: number;
  /** Whether the relay has been told how this ended. */
  reported: boolean;
}

interface ShelfFile {
  schemaVersion: 1;
  releases: StoredRelease[];
}

export interface OfferFrame {
  moduleId?: unknown;
  version?: unknown;
  artifactUrl?: unknown;
  checksum?: unknown;
  signature?: unknown;
}

export interface ReleaseModules {
  known(moduleId: string): boolean;
  /** True when this build's module of that id can apply a release at all. */
  takesReleases(moduleId: string): boolean;
  isOn(moduleId: string): Promise<boolean>;
  get(moduleId: string): Module | undefined;
  isRunning(moduleId: string): boolean;
  contextFor(module: FortressModule): ModuleContextV2;
}

export interface ReleaseShelfDeps {
  paths: FortressPaths;
  audit: ModuleAudit;
  logger: ScopedLogger;
  modules: ReleaseModules;
  /** The relay's own origin, from the enrolled cloud URL, or null when there is
   *  none to read. An artifact is fetched from there, or from a host the
   *  operator listed in FORTRESS_RELEASE_HOSTS, and from nowhere else. */
  relayOrigin: () => Promise<string | null>;
  env?: Record<string, string | undefined>;
  trustedKeys?: readonly TrustedSigningKey[];
  /** The transport, for tests. The rules about where it may go are not a seam. */
  fetchImpl?: typeof fetch;
  clock?: () => Date;
  applyDeadlineMs?: number;
}

function sha256Hex(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function publicRecord(stored: StoredRelease): ReleaseRecord {
  return {
    id: stored.id,
    moduleId: stored.moduleId,
    version: stored.version,
    checksum: stored.checksum,
    signedBy: stored.signedBy,
    offeredAt: stored.offeredAt,
    state: stored.state,
    ...(stored.decidedBy !== undefined ? { decidedBy: stored.decidedBy } : {}),
    ...(stored.decidedAt !== undefined ? { decidedAt: stored.decidedAt } : {}),
    ...(stored.handedAt !== undefined ? { handedAt: stored.handedAt } : {}),
    ...(stored.error !== undefined ? { error: stored.error } : {}),
  };
}

async function loadShelf(file: string): Promise<StoredRelease[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = JSON.parse(text) as Partial<ShelfFile>;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.releases)) {
    throw new Error("the release shelf file is not one this build can read");
  }
  return parsed.releases;
}

/** Every release on the shelf, newest offer first. A plain read of the file the
 *  daemon writes: the terminal and the console call this without a daemon. */
export async function readReleaseShelf(paths: FortressPaths): Promise<ReleaseRecord[]> {
  const stored = await loadShelf(paths.moduleReleases);
  return stored
    .map(publicRecord)
    .sort((a, b) => (a.offeredAt < b.offeredAt ? 1 : a.offeredAt > b.offeredAt ? -1 : 0));
}

/** The version each module last had installed, by module id. */
export function installedVersions(releases: readonly ReleaseRecord[]): Map<string, string> {
  const latest = new Map<string, ReleaseRecord>();
  for (const release of releases) {
    if (release.state !== "installed") continue;
    const seen = latest.get(release.moduleId);
    if (!seen || (release.decidedAt ?? "") > (seen.decidedAt ?? "")) {
      latest.set(release.moduleId, release);
    }
  }
  return new Map([...latest].map(([moduleId, release]) => [moduleId, release.version]));
}

export class ReleaseShelf {
  private readonly deps: ReleaseShelfDeps;
  private chain: Promise<unknown> = Promise.resolve();
  /** One fetch at a time: the next offer waits for the one before it. */
  private intakeChain: Promise<unknown> = Promise.resolve();
  private intakeQueued = 0;
  private readonly intakes = new RateWindow(INTAKE_MAX_PER_MINUTE);
  /** Releases a module is applying right now, by id. A release stays here until
   *  the module's own work settles, which can be after the deadline answered. */
  private readonly applying = new Set<string>();
  private reporter: ((result: InstallResult) => boolean) | null = null;

  constructor(deps: ReleaseShelfDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return (this.deps.clock ?? ((): Date => new Date()))();
  }

  private get env(): Record<string, string | undefined> {
    return this.deps.env ?? process.env;
  }

  /** One writer at a time over the shelf file. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private load(): Promise<StoredRelease[]> {
    return loadShelf(this.deps.paths.moduleReleases);
  }

  private async save(releases: StoredRelease[]): Promise<void> {
    const file: ShelfFile = { schemaVersion: 1, releases };
    await writePrivateJson(this.deps.paths.moduleReleases, file, { pretty: true });
  }

  private artifactPath(release: Pick<StoredRelease, "moduleId" | "artifact">): string | null {
    if (!release.artifact) return null;
    return path.join(this.deps.paths.moduleArtifacts(release.moduleId), release.artifact);
  }

  /** How the relay is told a result. Set once the tunnel exists; until then, and
   *  whenever the tunnel is down, a result stays unreported and is sent on the
   *  next connect. */
  setReporter(reporter: (result: InstallResult) => boolean): void {
    this.reporter = reporter;
  }

  async list(): Promise<ReleaseRecord[]> {
    return readReleaseShelf(this.deps.paths);
  }

  // ── An offer ───────────────────────────────────────────────────────────────

  /**
   * One `moduleAdvertise` frame. Returns the result frame to send, or null when
   * nothing is sent: the release is now waiting, or it was already on the shelf.
   */
  async offer(frame: OfferFrame): Promise<InstallResult | null> {
    const moduleId = isModuleId(frame.moduleId) ? frame.moduleId : null;
    const label = moduleId && this.deps.modules.known(moduleId) ? moduleId : null;
    const version =
      typeof frame.version === "string" && RELEASE_VERSION_PATTERN.test(frame.version)
        ? frame.version
        : null;
    const refuse = async (rule: OfferRule): Promise<InstallResult | null> => {
      // Collapsed, and keyed on nothing the relay can vary: a module id this
      // build ships (or "unknown") and a rule from the list above. The version
      // is not written: until the signature verifies it is the relay's text.
      await this.deps.audit.refused(AUDIT_ACTIONS.relayReleaseOffer, {
        module: label ?? "unknown",
        rule,
      });
      // A frame that names no module or version this host could repeat back
      // gets no answer at all.
      return label && version
        ? { moduleId: label, version, ok: false, error: `refused:${rule}` }
        : null;
    };

    if (!moduleId || !label) return refuse("module_unknown");
    if (!version) return refuse("version_malformed");

    // ── The signature, before anything else ──────────────────────────────────
    // Nothing is fetched, and no switch, host list or shelf record is read,
    // until the offer has been shown to be one somebody with a trusted key
    // signed. The one setting read before that says which keys count.
    const signature = frame.signature;
    if (typeof signature !== "string" || signature.length === 0) return refuse("signature_missing");
    if (signature.length > SIGNATURE_MAX_CHARS) return refuse("signature_malformed");
    let keyid: string;
    try {
      keyid = parseSignatureSidecar(signature).keyid;
    } catch {
      return refuse("signature_malformed");
    }
    const anchors = releaseAnchors(this.env, this.deps.trustedKeys);
    if (anchors.length === 0) return refuse("no_trusted_anchor");
    if (!anchors.some((anchor) => anchor.keyid === keyid)) return refuse("signer_untrusted");
    const checksum = typeof frame.checksum === "string" ? frame.checksum.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(checksum)) return refuse("checksum_malformed");
    try {
      await verifyDetachedSignature(releaseStatement(moduleId, version, checksum), signature, anchors);
    } catch {
      return refuse("signature_invalid");
    }

    // ── From here the module, the version and the checksum are the signer's ──
    const sources: ReleaseSources = {
      relayOrigin: await this.deps.relayOrigin().catch(() => null),
      hosts: listedReleaseHosts(this.env),
    };
    const urlDefect = artifactUrlDefect(frame.artifactUrl, sources);
    if (urlDefect) return refuse(urlDefect);
    const artifactUrl = frame.artifactUrl as string;

    if (!this.deps.modules.takesReleases(moduleId)) return refuse("module_takes_no_releases");
    if (!(await this.deps.modules.isOn(moduleId))) return refuse("module_off");

    const known = await this.known(moduleId, version, checksum);
    if (known === "same") return null;
    if (known === "conflict") return refuse("version_conflict");
    if (
      known === null &&
      (await this.load()).filter((r) => r.state === "waiting").length >= SHELF_MAX_WAITING
    ) {
      return refuse("shelf_full");
    }
    if (this.intakeQueued >= INTAKE_MAX_QUEUED) return refuse("busy");
    if (!this.takeIntakeToken()) return refuse("rate_limited");

    // One fetch at a time. An offer that arrives during another's fetch waits
    // its turn; the same release offered twice in a row is then found on the
    // shelf by the second and is not fetched again.
    this.intakeQueued += 1;
    const turn = this.intakeChain.then(async () => {
      const again = await this.known(moduleId, version, checksum);
      if (again === "same") return null;
      if (again === "conflict") return refuse("version_conflict");
      return this.intake({ moduleId, version, artifactUrl, checksum, keyid, sources, signature });
    });
    this.intakeChain = turn.catch(() => undefined);
    try {
      return await turn;
    } finally {
      this.intakeQueued -= 1;
    }
  }

  /**
   * Whether this version of this module is already on the shelf.
   *
   * `same`: it is, with these bytes. `conflict`: it is, with other bytes, which
   * is not a new release but a contradiction. `repair`: it is, it failed, and
   * its file is no longer on disk, so this offer may bring the file back. A
   * release a person refused stays refused: the same offer does not undo that.
   */
  private async known(
    moduleId: string,
    version: string,
    checksum: string,
  ): Promise<"same" | "conflict" | "repair" | null> {
    const held = (await this.load()).find((r) => r.moduleId === moduleId && r.version === version);
    if (!held) return null;
    if (held.checksum !== checksum) return "conflict";
    if (held.state !== "failed" || this.applying.has(held.id)) return "same";
    const file = this.artifactPath(held);
    const present = file !== null && (await stat(file).then(() => true, () => false));
    return present ? "same" : "repair";
  }

  private async intake(offer: {
    moduleId: string;
    version: string;
    artifactUrl: string;
    checksum: string;
    keyid: string;
    sources: ReleaseSources;
    signature: string;
  }): Promise<InstallResult | null> {
    const { moduleId, version, checksum } = offer;
    // A failed release that is offered again keeps its id: it is the same
    // release, and the trail and the terminal already know it by that id.
    const prior = (await this.load().catch(() => [] as StoredRelease[])).find(
      (r) => r.moduleId === moduleId && r.version === version && r.checksum === checksum,
    );
    const id = prior?.state === "failed" ? prior.id : `rel-${randomBytes(8).toString("hex")}`;
    const refused = (rule: OfferRule): InstallResult => ({
      moduleId,
      version,
      ok: false,
      error: `refused:${rule}`,
    });

    let intent;
    try {
      intent = await this.deps.audit.intent(AUDIT_ACTIONS.relayReleaseOffer, {
        actor: RELAY_ACTOR,
        sessionRef: id,
        params: { module: moduleId, version, release: id, signedBy: offer.keyid },
      });
    } catch {
      // A fetch on the relay's word, with no record that it was asked for, is
      // not one this host makes.
      this.deps.logger.error("refused a release offer: its audit record could not be written", {
        module: moduleId,
      });
      return refused("audit_unavailable");
    }

    // Every way out of here writes the outcome. An offer whose record says it
    // was taken in and then says nothing more reads as a daemon that stopped.
    let written: string | null = null;
    try {
      let bytes: Uint8Array;
      try {
        bytes = await fetchReleaseArtifact(offer.artifactUrl, {
          sources: offer.sources,
          ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        });
      } catch (thrown) {
        const rule = thrown instanceof ReleaseFetchRefused ? thrown.rule : "fetch_failed";
        await this.deps.audit.outcome(intent, "refused", rule);
        return refused(rule);
      }
      // The signature was made over this sha256. A file with another one is not
      // the file that was signed, whatever checksum the frame carried.
      if (sha256Hex(bytes) !== checksum) {
        await this.deps.audit.outcome(intent, "refused", "checksum_mismatch");
        return refused("checksum_mismatch");
      }

      const shelved = await this.exclusive(
        async (): Promise<OfferRule | "known" | null> => {
          const shelf = await this.load();
          // Decided again under the lock: two offers can pass the first look together.
          const held = shelf.find((r) => r.moduleId === moduleId && r.version === version);
          const repair =
            held &&
            held.id === id &&
            held.checksum === checksum &&
            held.state === "failed" &&
            !this.applying.has(held.id)
              ? held
              : null;
          if (held && !repair) return "known";
          if (!repair && shelf.filter((r) => r.state === "waiting").length >= SHELF_MAX_WAITING) {
            return "shelf_full";
          }
          const artifact = `${id}.bin`;
          const dir = this.deps.paths.moduleArtifacts(moduleId);
          await mkdir(dir, { recursive: true, mode: 0o700 });
          const file = path.join(dir, artifact);
          await writeFile(file, bytes, { mode: 0o600 });
          written = file;
          await chmod(file, 0o600).catch(() => {});
          if (repair) {
            repair.state = "waiting";
            repair.artifact = artifact;
            repair.bytes = bytes.byteLength;
            repair.signedBy = offer.keyid;
            repair.signature = offer.signature;
            delete repair.error;
            // Nothing is owed to the relay for a release that only waits.
            repair.reported = true;
          } else {
            shelf.push({
              id,
              moduleId,
              version,
              checksum,
              signedBy: offer.keyid,
              signature: offer.signature,
              offeredAt: this.now().toISOString(),
              state: "waiting",
              artifact,
              bytes: bytes.byteLength,
              reported: true,
            });
          }
          await this.save(await this.trim(shelf));
          return null;
        },
      );
      if (shelved === "known") {
        // Shelved by another offer while this one was being fetched.
        await this.deps.audit.outcome(intent, "refused", "busy");
        return null;
      }
      if (shelved) {
        await this.deps.audit.outcome(intent, "refused", shelved);
        return refused(shelved);
      }
      await this.deps.audit.outcome(intent, "waiting");
      this.deps.logger.info("a release is waiting for approval", {
        release: id,
        module: moduleId,
        version,
        signedBy: offer.keyid,
      });
      return null;
    } catch (thrown) {
      // The shelf file or the artifact could not be written. The file, if it
      // got as far as the disk, has no record that names it: remove it.
      if (written) await rm(written, { force: true }).catch(() => {});
      this.deps.logger.error("a release offer could not be shelved", {
        module: moduleId,
        ...failureForLog(thrown),
      });
      await this.deps.audit.outcome(intent, "failed", "shelf_unwritable");
      return refused("shelf_unwritable");
    }
  }

  private takeIntakeToken(): boolean {
    return this.intakes.take(this.now().getTime());
  }

  /** Drop the oldest decided records past the ceiling, and their artifacts. */
  private async trim(shelf: StoredRelease[]): Promise<StoredRelease[]> {
    if (shelf.length <= SHELF_MAX_RECORDS) return shelf;
    const decided = shelf
      .filter((r) => r.state === "installed" || r.state === "refused")
      .sort((a, b) => ((a.decidedAt ?? "") < (b.decidedAt ?? "") ? -1 : 1));
    const drop = new Set(decided.slice(0, shelf.length - SHELF_MAX_RECORDS).map((r) => r.id));
    for (const release of shelf) {
      if (drop.has(release.id)) await this.removeArtifact(release);
    }
    return shelf.filter((r) => !drop.has(r.id));
  }

  private async removeArtifact(release: StoredRelease): Promise<void> {
    const file = this.artifactPath(release);
    if (file) await rm(file, { force: true }).catch(() => {});
    release.artifact = null;
  }

  // ── A decision ─────────────────────────────────────────────────────────────

  /**
   * Carry out a person's decision about one release.
   *
   * `decidedBy` is who decided, as the caller knows them: the terminal's
   * operator, or a console login. It is written to the trail and to the record.
   */
  async decide(request: {
    id: string;
    decision: "approve" | "refuse";
    decidedBy: string;
  }): Promise<DecisionResult> {
    const decidedBy = request.decidedBy.slice(0, DECIDED_BY_MAX_CHARS) || "unknown";
    if (!RELEASE_ID_PATTERN.test(request.id)) return { ok: false, reason: "release_unknown" };
    return request.decision === "refuse"
      ? this.refuseRelease(request.id, decidedBy)
      : this.approveRelease(request.id, decidedBy);
  }

  private async refuseRelease(id: string, decidedBy: string): Promise<DecisionResult> {
    const result = await this.exclusive(async (): Promise<DecisionResult> => {
      const shelf = await this.load();
      const release = shelf.find((r) => r.id === id);
      if (!release) return { ok: false, reason: "release_unknown" };
      if (this.applying.has(id)) {
        return { ok: false, reason: "still_applying", release: publicRecord(release) };
      }
      if (release.state !== "waiting" && release.state !== "failed") {
        return { ok: false, reason: "not_waiting", release: publicRecord(release) };
      }
      release.state = "refused";
      release.decidedBy = decidedBy;
      release.decidedAt = this.now().toISOString();
      delete release.error;
      release.reported = false;
      await this.removeArtifact(release);
      await this.save(shelf);
      return { ok: true, release: publicRecord(release) };
    });
    if (!result.ok) return result;
    const { release } = result;
    await this.deps.audit.event(AUDIT_ACTIONS.releaseRefused, {
      actor: decidedBy,
      sessionRef: release.id,
      params: { release: release.id, module: release.moduleId, version: release.version, decidedBy },
      outcome: "refused",
    });
    await this.report(release.id);
    return result;
  }

  private async approveRelease(id: string, decidedBy: string): Promise<DecisionResult> {
    type Started =
      | { refused: DecisionResult; failedNow?: boolean }
      | { release: StoredRelease; module: FortressModule; bytes: Uint8Array };

    const started = await this.exclusive(async (): Promise<Started> => {
      const shelf = await this.load();
      const release = shelf.find((r) => r.id === id);
      if (!release) return { refused: { ok: false, reason: "release_unknown" } };
      const stop = (reason: DecisionRefusal, failedNow = false): Started => ({
        refused: { ok: false, reason, release: publicRecord(release) },
        failedNow,
      });
      // A module that is still working on this release is not handed it again,
      // whatever the record says: the deadline answers for a slow apply, it
      // does not end it.
      if (this.applying.has(id)) return stop("still_applying");
      if (release.state !== "waiting" && release.state !== "failed") return stop("not_waiting");
      if (!(await this.deps.modules.isOn(release.moduleId))) return stop("module_off");
      const module = this.deps.modules.get(release.moduleId);
      if (!module || !this.deps.modules.isRunning(release.moduleId)) return stop("module_not_running");
      if (!isFortressModule(module) || typeof module.applyRelease !== "function") {
        return stop("module_takes_no_releases");
      }
      // The signature is verified again, now, against the keys this build and
      // these settings trust at this moment. A release that was shelved under a
      // key that no longer counts is not installed.
      try {
        await verifyDetachedSignature(
          releaseStatement(release.moduleId, release.version, release.checksum),
          release.signature,
          releaseAnchors(this.env, this.deps.trustedKeys),
        );
      } catch {
        return stop("signer_untrusted");
      }
      // And the bytes on disk are held to the signed sha256 again: they were
      // checked when they arrived, and they have sat in a file since.
      const file = this.artifactPath(release);
      let bytes: Uint8Array | null = null;
      if (file) bytes = await readFile(file).catch(() => null);
      if (!bytes || sha256Hex(bytes) !== release.checksum) {
        const reason: DecisionRefusal = bytes ? "artifact_changed" : "artifact_missing";
        release.state = "failed";
        release.error = reason;
        release.reported = false;
        await this.save(shelf);
        return stop(reason, true);
      }
      release.state = "approved";
      release.decidedBy = decidedBy;
      release.decidedAt = this.now().toISOString();
      release.handedAt = release.decidedAt;
      delete release.error;
      release.reported = false;
      await this.save(shelf);
      this.applying.add(id);
      return { release: { ...release }, module, bytes };
    });

    if ("refused" in started) {
      const refused = started.refused;
      if (started.failedNow && refused.release) {
        const release = refused.release;
        await this.deps.audit.event(AUDIT_ACTIONS.releaseInstall, {
          sessionRef: release.id,
          params: { release: release.id, module: release.moduleId, version: release.version },
          outcome: "failed",
          error: release.error ?? "internal",
        });
        await this.report(release.id);
      }
      return refused;
    }

    const { release, module, bytes } = started;
    const params: AuditParams = {
      release: release.id,
      module: release.moduleId,
      version: release.version,
      signedBy: release.signedBy,
      decidedBy,
    };
    await this.deps.audit.event(AUDIT_ACTIONS.releaseApproved, {
      actor: decidedBy,
      sessionRef: release.id,
      params,
      outcome: "approved",
    });

    let intent = null;
    try {
      intent = await this.deps.audit.intent(AUDIT_ACTIONS.releaseInstall, {
        sessionRef: release.id,
        params,
      });
    } catch {
      // The module is about to change something on this side. Without a record
      // that it was about to, it does not.
      this.applying.delete(id);
      return { ok: true, release: await this.finish(release, "audit_unavailable") };
    }

    const approved: ApprovedRelease = {
      id: release.id,
      moduleId: release.moduleId,
      version: release.version,
      checksum: release.checksum,
      signedBy: release.signedBy,
      approvedBy: decidedBy,
      approvedAt: release.decidedAt ?? this.now().toISOString(),
      artifact: bytes,
    };
    let work: Promise<unknown>;
    try {
      work = Promise.resolve(module.applyRelease?.(approved, this.deps.modules.contextFor(module)));
    } catch (thrown) {
      work = Promise.reject(thrown);
    }
    // The release is the module's until its own work settles, not until the
    // deadline answers for it.
    let answered = false;
    void work.then(
      () => {
        this.applying.delete(id);
        if (answered) void this.finishedLate(release, intent).catch(() => {});
      },
      () => {
        this.applying.delete(id);
      },
    );

    let code: string | null = null;
    try {
      await withDeadline(work, this.deps.applyDeadlineMs ?? APPLY_DEADLINE_MS, "deadline", {
        error: () => new ApplyDeadline("deadline"),
        // A daemon that is told to stop does not wait ten minutes for this.
        unref: true,
      });
    } catch (thrown) {
      // One word. The thrown message stays where it was thrown, except for
      // the failures this host words itself.
      code = thrown instanceof ApplyDeadline ? "timeout" : failureCode(thrown);
      this.deps.logger.error("a module could not apply an approved release", {
        release: release.id,
        module: release.moduleId,
        version: release.version,
        ...(thrown instanceof ApplyDeadline ? { code } : failureForLog(thrown)),
      });
    }
    answered = true;
    await this.deps.audit.outcome(intent, code ? "failed" : "installed", code);
    return { ok: true, release: await this.finish(release, code) };
  }

  /** Write how an approved release ended, and tell the relay. */
  private async finish(release: StoredRelease, code: string | null): Promise<ReleaseRecord> {
    const final = await this.exclusive(async (): Promise<ReleaseRecord> => {
      const shelf = await this.load();
      const current = shelf.find((r) => r.id === release.id);
      if (!current) return publicRecord(release);
      current.state = code ? "failed" : "installed";
      if (code) current.error = code;
      else {
        delete current.error;
        // Applied: the bytes have done their work, and the record keeps their
        // checksum and who signed them.
        await this.removeArtifact(current);
      }
      current.reported = false;
      await this.save(shelf);
      return publicRecord(current);
    });
    await this.report(final.id);
    return final;
  }

  /**
   * A module finished applying a release after the deadline had already
   * answered `failed:timeout` for it. The release WAS applied, so the record
   * says so: a shelf that kept saying `failed` would invite a second approval
   * of something that is already installed.
   */
  private async finishedLate(release: StoredRelease, intent: AuditRecord): Promise<void> {
    const changed = await this.exclusive(async (): Promise<boolean> => {
      const shelf = await this.load();
      const current = shelf.find((r) => r.id === release.id);
      if (!current || current.state !== "failed" || current.error !== "timeout") return false;
      current.state = "installed";
      delete current.error;
      await this.removeArtifact(current);
      current.reported = false;
      await this.save(shelf);
      return true;
    });
    if (!changed) return;
    await this.deps.audit.event(AUDIT_ACTIONS.releaseInstall, {
      sessionRef: release.id,
      params: { release: release.id, module: release.moduleId, version: release.version },
      outcome: "installed",
      error: "after_deadline",
    });
    this.deps.logger.warn("a module finished applying a release after its deadline", {
      release: release.id,
      module: release.moduleId,
      version: release.version,
      intent: intent.seq,
    });
    await this.report(release.id);
  }

  // ── Telling the relay ──────────────────────────────────────────────────────

  /** What the relay is told about a release in this state, or null while there
   *  is nothing to tell: one place, so a result sent when it happens and the
   *  same result sent again after a reconnect say the same words. */
  private resultOf(release: StoredRelease): InstallResult | null {
    const { moduleId, version } = release;
    if (release.state === "installed") return { moduleId, version, ok: true };
    if (release.state === "refused") return { moduleId, version, ok: false, error: "refused:operator" };
    if (release.state === "failed") {
      return { moduleId, version, ok: false, error: `failed:${release.error ?? "internal"}` };
    }
    return null;
  }

  /** Tell the relay how a release stands, and remember that it was told. */
  private async report(id: string): Promise<void> {
    await this.exclusive(async () => {
      const shelf = await this.load();
      const release = shelf.find((r) => r.id === id);
      if (!release || release.reported) return;
      const result = this.resultOf(release);
      if (!result) return;
      let sent: boolean;
      try {
        sent = this.reporter?.(result) ?? false;
      } catch {
        sent = false;
      }
      if (!sent) return;
      release.reported = true;
      await this.save(shelf);
    }).catch(() => {});
  }

  /** Send every result the relay has not been told. Called on each connect: a
   *  decision made while the tunnel was down is otherwise never heard. */
  async reportPending(): Promise<void> {
    const shelf = await this.load().catch(() => [] as StoredRelease[]);
    for (const release of shelf) {
      if (!release.reported) await this.report(release.id);
    }
  }

  /**
   * At boot: an approval whose install never finished is marked failed.
   *
   * The daemon stopped between "a person approved this" and "the module said it
   * was done". Whether the module finished is unknown, and running it again on
   * no one's word would be the host deciding to install something. So it is
   * `failed`, with the reason, and a person may approve it again.
   */
  async recover(): Promise<void> {
    const interrupted = await this.exclusive(async () => {
      const shelf = await this.load().catch(() => [] as StoredRelease[]);
      const hit = shelf.filter((r) => r.state === "approved");
      if (hit.length === 0) return [];
      for (const release of hit) {
        release.state = "failed";
        release.error = "interrupted";
        release.reported = false;
      }
      await this.save(shelf);
      return hit.map(publicRecord);
    });
    for (const release of interrupted) {
      await this.deps.audit.event(AUDIT_ACTIONS.releaseInstall, {
        sessionRef: release.id,
        params: { release: release.id, module: release.moduleId, version: release.version },
        outcome: "failed",
        error: "interrupted",
      });
    }
  }
}

class ApplyDeadline extends Error {}
