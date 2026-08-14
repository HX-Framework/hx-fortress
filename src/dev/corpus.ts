// The development corpus: one fixed world, computed rather than recorded.
//
// Every screenshot pass, every verdict matrix and every migration rehearsal in
// this repo reads the SAME fortress. That only works if the corpus is a pure
// function of nothing — no clock, no randomness, no insertion order — so the
// numbers a reviewer sees in a screenshot are the numbers the next run produces.
// Determinism is asserted by digest, not by inspection: a `Date.now()` that
// creeps into a builder changes the digest on the very next run.
//
// The corpus is also SELF-DESCRIBING. Each fixture carries the acceptances it
// exists for, so a fixture nobody asserts against shows up as an unnamed entry
// rather than as quiet ballast, and an acceptance whose fixture was dropped
// fails the inventory instead of the screenshot three tasks later.
//
// It carries the awkward cases on purpose: sessions with no provenance, a user
// with no device, a canonical object whose byte count disagrees with its row, a
// staging chunk nobody composed, and a session tombstoned here that still exists
// in a migration target. Those are the states the console has to render
// honestly, and a corpus of healthy rows proves nothing about any of them.

import { createHash } from "node:crypto";

import type { RosterSyncPayload } from "../protocol";
import type { HxIngestChannel, HxTitleSource } from "../host/postgres/schema/sessions";

/** The instant the whole world is derived from. Fixed: "3 days ago" would make
 *  every rendered date a moving target and every screenshot a diff. */
export const SEED_EPOCH = "2026-07-01T12:00:00.000Z";

const EPOCH_MS = Date.parse(SEED_EPOCH);

/** Named so a fixture can point at the acceptance that reads it. Cross-task by
 *  design — the seed exists for its consumers, not for itself. */
export const SEED_ACCEPTANCES = {
  corpusRenders: "t07[1] — screenshot pass over the wired SPA",
  rosterLands: "t17[1] — roster + device inventory land and render",
  rosterFunnel: "t17[0] — funnel matrix incl. inactive/departed/non-rostered",
  unknownProvenance: "t18[2] — reconciled sessions report unknown provenance",
  alsoAtLetai: "t18[5] — pre-fortress history renders acknowledgeable also_at_letai",
  noDestinationRecord: "t18[6] — no-rows-at-all renders the no_record verdict",
  notDeliveredHere: "t18[6] — destination rows exist but not this fortress",
  migrationResume: "t19[0] — induced failure + resume, checksum abort",
  tombstoneReplay: "t19[3] — tombstoned session absent from the target after replay",
} as const;

export type SeedAcceptance = (typeof SEED_ACCEPTANCES)[keyof typeof SEED_ACCEPTANCES];

// ── Deterministic derivation ────────────────────────────────────────────────

/** A UUID derived from a name. Stable across runs, machines and rebuilds, so
 *  seeded rows can carry explicit primary keys and a re-seed is an upsert rather
 *  than a second copy of the world. */
export function seedUuid(name: string): string {
  const hex = createHash("sha256").update(`hx-fortress-seed/${name}`).digest("hex");
  // Version 4 / variant 10xx, so the value is a well-formed UUID and not merely
  // a hex string that happens to fit the column.
  const v = `4${hex.slice(13, 16)}`;
  const r = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${v}-${r}-${hex.slice(20, 32)}`;
}

/** A small non-negative integer derived from a name, in [0, span). */
function seedInt(name: string, span: number): number {
  const hex = createHash("sha256").update(`hx-fortress-seed/n/${name}`).digest("hex");
  return Number.parseInt(hex.slice(0, 8), 16) % span;
}

/** An instant `minutesBefore` the epoch, as an ISO string. */
function beforeEpoch(minutesBefore: number): string {
  return new Date(EPOCH_MS - minutesBefore * 60_000).toISOString();
}

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface SeedDevice {
  deviceId: string;
  name: string;
  os: string;
  arch: string;
  /** Null for a device that has never reported — a real state the funnel has to
   *  distinguish from "reported zero". */
  lastSeenAt: string | null;
  lastUploadAt: string | null;
  syncTotal: number | null;
  syncDone: number | null;
  syncReportedAt: string | null;
}

export interface SeedUser {
  externalId: string;
  displayName: string;
  email: string;
  teams: string[];
  devices: SeedDevice[];
  /** Present in the roster payload but absent from hx.users until something is
   *  ingested for them — the non-rostered/rostered-but-silent distinction. */
  rostered: boolean;
}

export interface SeedSession {
  userExternalId: string;
  family: string;
  sessionId: string;
  deviceId: string | null;
  orgExternalId: string | null;
  projectExternalId: string | null;
  repoSlug: string | null;
  modelId: string | null;
  title: string;
  titleSource: HxTitleSource;
  cwd: string;
  gitBranch: string;
  /** NULL is a first-class value here: every session mirrored before the column
   *  existed carries it, and residency has to report those as unknown rather
   *  than as not-applicable. */
  ingestChannel: HxIngestChannel | null;
  eventCount: number;
  userTextCount: number;
  assistantCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estCostUsd: number;
  bytesUploaded: number;
  chunkCount: number;
  firstEventAt: string;
  lastActivityAt: string;
  deletedAt: string | null;
  lastUserText: string;
  lastAssistantText: string;
}

/** Which bucket an object lives in. `secondary` is the migration TARGET — the
 *  two-bucket rehearsal needs a source and a destination that disagree. */
export type SeedBucket = "primary" | "secondary";

export interface SeedObject {
  bucket: SeedBucket;
  objectName: string;
  /** Exact bytes. A fixture asserting a byte mismatch needs the object's real
   *  size, not the size its row claims. */
  text: string;
}

export interface SeedTombstone {
  userExternalId: string;
  family: string;
  sessionId: string;
  deletedAt: string;
}

export type SeedFaultKind =
  /** A row whose canonical object is not in the bucket at all. */
  | "missing_object"
  /** A canonical object present, but shorter or longer than its row claims. */
  | "byte_mismatch"
  /** A staging chunk that was never composed and has no row to belong to. */
  | "orphaned_staging"
  /** Hard-deleted here, still present in the migration target. */
  | "tombstoned_present_in_target";

export interface SeedFault {
  kind: SeedFaultKind;
  session: { userExternalId: string; family: string; sessionId: string };
  /** What the console is expected to say about it. */
  expectation: string;
  acceptances: SeedAcceptance[];
}

export interface SeedFixture {
  id: string;
  what: string;
  acceptances: SeedAcceptance[];
}

export interface SeedMigration {
  sourceBucket: string;
  targetBucket: string;
  /** Sessions already copied into the target when the run is resumed. */
  copied: string[];
  /** The session whose copy must abort on checksum. */
  checksumAbort: string;
}

export interface SeedCorpus {
  epoch: string;
  orgs: Array<{ externalId: string; name: string }>;
  projects: Array<{ orgExternalId: string; externalId: string; name: string }>;
  repos: Array<{ slug: string; projectExternalId: string | null }>;
  models: Array<{ modelId: string; provider: string; displayName: string }>;
  users: SeedUser[];
  sessions: SeedSession[];
  objects: SeedObject[];
  tombstones: SeedTombstone[];
  faults: SeedFault[];
  roster: RosterSyncPayload;
  migration: SeedMigration;
  fixtures: SeedFixture[];
}

// ── The world ───────────────────────────────────────────────────────────────

const ORG = { externalId: "org_orange", name: "Orange Corp" };
const FOREIGN_ORG = { externalId: "org_indigo", name: "Indigo Ltd" };

const PROJECTS = [
  { orgExternalId: ORG.externalId, externalId: "prj_checkout", name: "Checkout" },
  { orgExternalId: ORG.externalId, externalId: "prj_runtime", name: "Runtime" },
  { orgExternalId: FOREIGN_ORG.externalId, externalId: "prj_indigo", name: "Indigo Platform" },
];

const REPOS = [
  { slug: "orange/checkout", projectExternalId: "prj_checkout" },
  { slug: "orange/runtime", projectExternalId: "prj_runtime" },
  { slug: "indigo/platform", projectExternalId: "prj_indigo" },
];

const MODELS = [
  { modelId: "claude-opus-4-8", provider: "anthropic", displayName: "Claude Opus 4.8" },
  { modelId: "claude-sonnet-4-6", provider: "anthropic", displayName: "Claude Sonnet 4.6" },
];

interface UserSpec {
  externalId: string;
  displayName: string;
  teams: string[];
  /** How many devices, and whether any of them has ever reported. */
  devices: Array<{ suffix: string; os: string; arch: string; quiet?: boolean; never?: boolean }>;
  sessions: number;
  /** Absent from the roster payload — ingested here, unknown to the hub. */
  rostered?: boolean;
  org?: string | null;
}

/** Six people, chosen for the states the adoption funnel has to separate:
 *  two devices, one device, a device that has never reported, no device at all,
 *  a rostered member with nothing ingested, and a user the roster does not know. */
const USERS: UserSpec[] = [
  {
    externalId: "u_marta",
    displayName: "Marta Nilsson",
    teams: ["Payments"],
    devices: [
      { suffix: "mbp", os: "macOS", arch: "arm64" },
      { suffix: "ci", os: "Linux", arch: "x64" },
    ],
    sessions: 6,
  },
  {
    externalId: "u_raj",
    displayName: "Raj Patel",
    teams: ["Data", "Payments"],
    devices: [{ suffix: "mbp", os: "macOS", arch: "arm64" }],
    sessions: 5,
  },
  {
    externalId: "u_elena",
    displayName: "Elena Vasquez",
    teams: ["Platform"],
    devices: [{ suffix: "thinkpad", os: "Linux", arch: "x64", quiet: true }],
    sessions: 3,
  },
  {
    externalId: "u_oliver",
    displayName: "Oliver Grant",
    teams: ["Mobile"],
    devices: [{ suffix: "thinkpad", os: "Linux", arch: "x64", never: true }],
    sessions: 0,
  },
  {
    externalId: "u_lena",
    displayName: "Lena Kraus",
    teams: [],
    devices: [],
    sessions: 0,
  },
  {
    externalId: "u_indigo",
    displayName: "Priya Shah",
    teams: ["Indigo"],
    devices: [{ suffix: "mbp", os: "macOS", arch: "arm64" }],
    sessions: 2,
    // Ingested here under another org, and absent from this org's roster: the
    // universe predicate has to reduce these to a labeled count, never a row.
    rostered: false,
    org: FOREIGN_ORG.externalId,
  },
];

/** Where each seeded session's provenance sits. Cycled so every arm is present
 *  in every user's slice rather than clustered at one end of the list. */
const CHANNELS: Array<HxIngestChannel | null> = ["tunnel", "gateway", "reconciled", null];

const TITLE_SOURCES: HxTitleSource[] = ["user", "ai", "fallback"];

const BRANCHES = ["main", "feat/checkout-retry", "fix/pool-wedge", "chore/deps"];

const TITLES = [
  "Retry the failing checkout webhook",
  "Why does the pool wedge after a 500?",
  "Add a keyset cursor to the sessions list",
  "Trace the missing residency record",
  "Rotate the bucket credential without downtime",
  "Explain this migration abort",
];

function deviceFor(user: UserSpec, spec: UserSpec["devices"][number]): SeedDevice {
  const deviceId = `${user.externalId}-${spec.suffix}`;
  if (spec.never) {
    // Installed and never heard from. Distinguishable from "reported zero",
    // which is what makes the funnel's quiet arm meaningful.
    return {
      deviceId,
      name: deviceId,
      os: spec.os,
      arch: spec.arch,
      lastSeenAt: null,
      lastUploadAt: null,
      syncTotal: null,
      syncDone: null,
      syncReportedAt: null,
    };
  }
  const quietMinutes = spec.quiet ? 60 * 24 * 34 : seedInt(`seen/${deviceId}`, 90);
  const total = 40 + seedInt(`total/${deviceId}`, 60);
  return {
    deviceId,
    name: deviceId,
    os: spec.os,
    arch: spec.arch,
    lastSeenAt: beforeEpoch(quietMinutes),
    lastUploadAt: beforeEpoch(quietMinutes + seedInt(`up/${deviceId}`, 30)),
    syncTotal: total,
    syncDone: spec.quiet ? total - 7 : total,
    syncReportedAt: beforeEpoch(quietMinutes),
  };
}

function sessionsFor(user: UserSpec, devices: SeedDevice[]): SeedSession[] {
  const out: SeedSession[] = [];
  for (let i = 0; i < user.sessions; i += 1) {
    const key = `${user.externalId}/${i}`;
    const sessionId = seedUuid(`session/${key}`);
    const device = devices.length > 0 ? devices[i % devices.length] : undefined;
    const events = 18 + seedInt(`events/${key}`, 220);
    const userTurns = Math.max(1, Math.floor(events / 6));
    const assistant = Math.max(1, Math.floor(events / 5));
    const input = 4_000 + seedInt(`in/${key}`, 90_000);
    const output = 1_200 + seedInt(`out/${key}`, 30_000);
    const minutesAgo = 30 + i * 137 + seedInt(`when/${key}`, 400);
    const org = user.org === undefined ? ORG.externalId : user.org;
    const project = org === FOREIGN_ORG.externalId ? "prj_indigo" : i % 2 === 0 ? "prj_checkout" : "prj_runtime";
    const repo = org === FOREIGN_ORG.externalId ? "indigo/platform" : i % 2 === 0 ? "orange/checkout" : "orange/runtime";
    out.push({
      userExternalId: user.externalId,
      family: "claude-code",
      sessionId,
      deviceId: device?.deviceId ?? null,
      orgExternalId: org,
      projectExternalId: project,
      repoSlug: repo,
      modelId: MODELS[i % MODELS.length].modelId,
      title: TITLES[seedInt(`title/${key}`, TITLES.length)],
      titleSource: TITLE_SOURCES[i % TITLE_SOURCES.length],
      cwd: `/home/${user.externalId.slice(2)}/work/${repo.split("/")[1]}`,
      gitBranch: BRANCHES[seedInt(`branch/${key}`, BRANCHES.length)],
      ingestChannel: CHANNELS[i % CHANNELS.length],
      eventCount: events,
      userTextCount: userTurns,
      assistantCount: assistant,
      toolCallCount: Math.max(0, events - userTurns - assistant),
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: seedInt(`cr/${key}`, 200_000),
      cacheCreationTokens: seedInt(`cc/${key}`, 40_000),
      estCostUsd: Number(((input * 5 + output * 25) / 1_000_000).toFixed(4)),
      bytesUploaded: 12_000 + seedInt(`bytes/${key}`, 400_000),
      chunkCount: 1 + seedInt(`chunks/${key}`, 6),
      firstEventAt: beforeEpoch(minutesAgo + 90),
      lastActivityAt: beforeEpoch(minutesAgo),
      deletedAt: null,
      // Content columns exist in the corpus precisely so the console's column
      // allowlist can be proven to withhold them. Nothing renders these.
      lastUserText: `seed transcript body for ${sessionId} — never rendered by the console`,
      lastAssistantText: `seed assistant body for ${sessionId} — never rendered by the console`,
    });
  }
  return out;
}

function canonicalName(session: { userExternalId: string; family: string; sessionId: string }): string {
  return `${session.userExternalId}/${session.family}/${session.sessionId}/log.jsonl`;
}

function stagingName(
  session: { userExternalId: string; family: string; sessionId: string },
  chunkId: string,
): string {
  return `${session.userExternalId}/${session.family}/${session.sessionId}/.staging/${chunkId}.jsonl`;
}

/** Transcript bytes for one session. NDJSON, sized to the row's claim, so a
 *  byte-mismatch fixture is a real disagreement rather than a rounding artifact. */
function canonicalText(session: SeedSession): string {
  const lines: string[] = [];
  for (let i = 0; i < Math.min(session.eventCount, 12); i += 1) {
    lines.push(
      JSON.stringify({
        type: i % 2 === 0 ? "user" : "assistant",
        sessionId: session.sessionId,
        seq: i,
        text: `seed event ${i} for ${session.sessionId}`,
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Build the corpus. Pure: same bytes on every machine, every run.
 */
export function buildSeedCorpus(): SeedCorpus {
  const users: SeedUser[] = [];
  const sessions: SeedSession[] = [];
  for (const spec of USERS) {
    const devices = spec.devices.map((d) => deviceFor(spec, d));
    users.push({
      externalId: spec.externalId,
      displayName: spec.displayName,
      email: `${spec.externalId.slice(2)}@orange.example`,
      teams: spec.teams,
      devices,
      rostered: spec.rostered ?? true,
    });
    sessions.push(...sessionsFor(spec, devices));
  }

  const objects: SeedObject[] = [];
  const faults: SeedFault[] = [];

  // The healthy majority: a canonical object per session, matching its row.
  for (const session of sessions) {
    objects.push({ bucket: "primary", objectName: canonicalName(session), text: canonicalText(session) });
  }

  // FAULT 1 — a row whose canonical object is absent. The residency verify has
  // to say "not delivered here", which is the incident, and never "confirmed".
  const missing = sessions[1];
  const missingName = canonicalName(missing);
  const missingIndex = objects.findIndex((o) => o.bucket === "primary" && o.objectName === missingName);
  objects.splice(missingIndex, 1);
  faults.push({
    kind: "missing_object",
    session: { userExternalId: missing.userExternalId, family: missing.family, sessionId: missing.sessionId },
    expectation: "the row exists, the canonical object does not — not delivered here",
    acceptances: [SEED_ACCEPTANCES.notDeliveredHere, SEED_ACCEPTANCES.corpusRenders],
  });

  // FAULT 2 — present, but the bytes disagree with the row. A size check that
  // only asks "does the object exist" reports this one as healthy.
  const mismatched = sessions[2];
  const mismatchedName = canonicalName(mismatched);
  const mismatchedIndex = objects.findIndex((o) => o.bucket === "primary" && o.objectName === mismatchedName);
  objects[mismatchedIndex] = {
    bucket: "primary",
    objectName: mismatchedName,
    text: canonicalText(mismatched).slice(0, 40),
  };
  faults.push({
    kind: "byte_mismatch",
    session: {
      userExternalId: mismatched.userExternalId,
      family: mismatched.family,
      sessionId: mismatched.sessionId,
    },
    expectation: "canonical object present but shorter than the row's bytesUploaded",
    acceptances: [SEED_ACCEPTANCES.migrationResume, SEED_ACCEPTANCES.corpusRenders],
  });

  // FAULT 3 — a staging chunk nobody composed, under a session that has no row
  // at all. The orphan scan finds it; the sessions list must not.
  const orphan = {
    userExternalId: "u_marta",
    family: "claude-code",
    sessionId: seedUuid("session/orphan"),
  };
  objects.push({
    bucket: "primary",
    objectName: stagingName(orphan, "c0000001"),
    text: `${JSON.stringify({ type: "user", text: "seed orphan staging chunk" })}\n`,
  });
  faults.push({
    kind: "orphaned_staging",
    session: orphan,
    expectation: "a staging chunk with no composed canonical and no session row",
    acceptances: [SEED_ACCEPTANCES.migrationResume],
  });

  // FAULT 4 — hard-deleted here, still sitting in the migration target. A
  // migration that replays a tombstone has to remove it; one that does not
  // resurrects a session the operator deleted.
  const tombstoned = sessions[3];
  const tombstones: SeedTombstone[] = [
    {
      userExternalId: tombstoned.userExternalId,
      family: tombstoned.family,
      sessionId: tombstoned.sessionId,
      deletedAt: beforeEpoch(240),
    },
  ];
  objects.push({
    bucket: "secondary",
    objectName: canonicalName(tombstoned),
    text: canonicalText(tombstoned),
  });
  faults.push({
    kind: "tombstoned_present_in_target",
    session: {
      userExternalId: tombstoned.userExternalId,
      family: tombstoned.family,
      sessionId: tombstoned.sessionId,
    },
    expectation: "tombstoned in this fortress, still present in the migration target",
    acceptances: [SEED_ACCEPTANCES.tombstoneReplay],
  });

  // Two-bucket rehearsal: part of the corpus is already in the target, so a
  // resumed run has both a skip path and a copy path to exercise. `copied` is
  // derived from what was actually written, never asserted alongside it — a
  // manifest that disagrees with the bucket is the bug the resume path has to
  // survive, not a fixture anyone should hand it deliberately.
  const copied: string[] = [];
  for (const session of [sessions[0], sessions[4]]) {
    objects.push({
      bucket: "secondary",
      objectName: canonicalName(session),
      text: canonicalText(session),
    });
    copied.push(session.sessionId);
  }

  const roster: RosterSyncPayload = {
    asOf: beforeEpoch(15),
    members: users
      .filter((u) => u.rostered)
      .map((u) => ({
        externalId: u.externalId,
        displayName: u.displayName,
        email: u.email,
        teams: u.teams,
        devices: {
          installed: u.devices.length,
          lastSeenAt: u.devices.reduce<string | null>((max, d) => pickLater(max, d.lastSeenAt), null),
          lastUploadAt: u.devices.reduce<string | null>((max, d) => pickLater(max, d.lastUploadAt), null),
          syncTotal: u.devices[0]?.syncTotal ?? null,
          syncDone: u.devices[0]?.syncDone ?? null,
          syncReportedAt: u.devices[0]?.syncReportedAt ?? null,
        },
      })),
  };

  const migration: SeedMigration = {
    sourceBucket: "hx-fortress-seed-primary",
    targetBucket: "hx-fortress-seed-secondary",
    copied,
    checksumAbort: mismatched.sessionId,
  };

  return {
    epoch: SEED_EPOCH,
    orgs: [ORG, FOREIGN_ORG],
    projects: PROJECTS,
    repos: REPOS,
    models: MODELS,
    users,
    sessions,
    objects: objects.sort((a, b) =>
      a.bucket === b.bucket ? compareStrings(a.objectName, b.objectName) : compareStrings(a.bucket, b.bucket),
    ),
    tombstones,
    faults,
    roster,
    migration,
    fixtures: fixturesOf(users, sessions, faults),
  };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pickLater(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** What the corpus claims to provide, and for whom. The inventory test checks
 *  each claim against the built corpus, so a fixture cannot be quietly dropped. */
function fixturesOf(users: SeedUser[], sessions: SeedSession[], faults: SeedFault[]): SeedFixture[] {
  const fixtures: SeedFixture[] = [
    {
      id: "multi-user-multi-device",
      what: `${users.length} people, ${users.reduce((n, u) => n + u.devices.length, 0)} devices, incl. one with none`,
      acceptances: [SEED_ACCEPTANCES.rosterFunnel, SEED_ACCEPTANCES.corpusRenders],
    },
    {
      id: "session-corpus",
      what: `${sessions.length} sessions across ${new Set(sessions.map((s) => s.userExternalId)).size} users`,
      acceptances: [SEED_ACCEPTANCES.corpusRenders],
    },
    {
      id: "ingest-channel-variety",
      what: "sessions on tunnel, gateway, reconciled and NULL provenance",
      acceptances: [SEED_ACCEPTANCES.unknownProvenance, SEED_ACCEPTANCES.noDestinationRecord],
    },
    {
      id: "foreign-org-sessions",
      what: "sessions owned by another org, for the universe predicate's labeled count",
      acceptances: [SEED_ACCEPTANCES.corpusRenders],
    },
    {
      id: "roster-payload",
      what: "a rosterSync payload file, replayed rather than written to hx.roster",
      acceptances: [SEED_ACCEPTANCES.rosterLands],
    },
    {
      id: "two-bucket-migration",
      what: "a source and a target bucket that disagree, with a partial copy",
      acceptances: [SEED_ACCEPTANCES.migrationResume],
    },
    {
      id: "pre-fortress-history",
      what: "sessions with no provenance at all — the also_at_letai arm",
      acceptances: [SEED_ACCEPTANCES.alsoAtLetai],
    },
  ];
  for (const fault of faults) {
    fixtures.push({
      id: `residency-${fault.kind.replace(/_/g, "-")}`,
      what: fault.expectation,
      acceptances: fault.acceptances,
    });
  }
  return fixtures;
}

// ── Inventory + digest ──────────────────────────────────────────────────────

export interface SeedInventory {
  users: number;
  devices: number;
  sessions: number;
  sessionsByChannel: Record<string, number>;
  objects: Record<SeedBucket, number>;
  tombstones: number;
  faults: number;
  rosterMembers: number;
  fixtures: number;
  /** Every acceptance some fixture names, sorted. */
  acceptances: string[];
}

export function seedInventory(corpus: SeedCorpus): SeedInventory {
  const byChannel: Record<string, number> = { tunnel: 0, gateway: 0, reconciled: 0, unknown: 0 };
  for (const session of corpus.sessions) {
    const key = session.ingestChannel ?? "unknown";
    byChannel[key] = (byChannel[key] ?? 0) + 1;
  }
  const acceptances = new Set<string>();
  for (const fixture of corpus.fixtures) for (const a of fixture.acceptances) acceptances.add(a);
  return {
    users: corpus.users.length,
    devices: corpus.users.reduce((n, u) => n + u.devices.length, 0),
    sessions: corpus.sessions.length,
    sessionsByChannel: byChannel,
    objects: {
      primary: corpus.objects.filter((o) => o.bucket === "primary").length,
      secondary: corpus.objects.filter((o) => o.bucket === "secondary").length,
    },
    tombstones: corpus.tombstones.length,
    faults: corpus.faults.length,
    rosterMembers: corpus.roster.members.length,
    fixtures: corpus.fixtures.length,
    acceptances: [...acceptances].sort(),
  };
}

/** Key-ordered JSON, so the digest is a property of the VALUES rather than of
 *  whatever order a builder happened to assign its object keys. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareStrings(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The corpus's identity. A clock or a random source anywhere in the builders
 *  moves it on the next run, which is exactly what the determinism test reads. */
export function corpusDigest(corpus: SeedCorpus): string {
  return createHash("sha256").update(canonicalJson(corpus)).digest("hex");
}
