// The 0600 append-only audit spool — and the reason command outcomes can be
// believed at all.
//
// The daemon's Postgres authority IS the cloud-reachable write role, so an
// adversary holding it can call complete_command/reject_command directly:
// fabricate a rotation that never ran, deny every submission, or report a
// success for work that failed. No SQL-layer fix exists — any nonce the routine
// could check is one the same role could rotate.
//
// So the daemon writes what it ACTUALLY did to a file that role cannot reach,
// and the console drains it as hx_ui (the only role with admin_audit INSERT).
// A terminal outcome with no matching spool record renders as REPORTED
// (unconfirmed); one with a matching record renders as confirmed.
//
// The intent record is fsynced BEFORE the mutation runs and the outcome is
// appended after — an append-only pair, never an in-place amend, so a crash
// between them is itself evidence.
//
// PERMISSION MODEL, single-sourced here. The directory is 0700 and owned by the
// user the daemon runs as; every file is 0600; and a writer running as ANY OTHER
// uid is refused by name. There is no group/setgid variant: a group-writable
// spool means a second account can append records that drain into the audit
// table under somebody else's name, which makes every row in it forgeable — and
// the whole value of these files is that a Postgres-role adversary cannot
// produce one.
//
// ONE FILE PER WRITING PROCESS. The ui server, each CLI invocation and the
// daemon each open their own file with a fresh 128-bit id; `seq` is monotone
// within a file, and (fileId, seq) is the drain's idempotency key. No process
// ever appends to another's file, so two writers need no lock and cannot
// interleave a torn line. Rotation, drain and deletion are the console's, and
// each acts on whole files.

import { mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { clampActor, sanitizeParams } from "./audit-actions";
import { redactCredentials } from "../ui/redact";

export type AuditOrigin = "console" | "cli" | "system";

/** Which process opened the file. Encoded in the NAME so the CLI's own cap can
 *  reclaim its own oldest files without opening any of them. */
export type SpoolWriter = "ui" | "cli" | "daemon";

const WRITER_ORIGIN: Record<SpoolWriter, AuditOrigin> = {
  ui: "console",
  cli: "cli",
  daemon: "system",
};

export interface AuditRecord {
  /** Identifies the spool FILE; with `seq` it is the drain's idempotency key. */
  fileId: string;
  seq: number;
  ts: string;
  actor: string | null;
  sessionRef: string | null;
  tier: string | null;
  action: string;
  /** Allowlisted, never secrets — the same rule the command params follow. */
  params: Record<string, unknown> | null;
  kind: "intent" | "outcome";
  /** For an outcome: the file of the intent it answers. Rotation MAY split a
   *  pair, so the seq alone does not identify one — seq restarts in the new
   *  file, and a bare `refSeq: 3` would resolve to whatever this file's third
   *  record happens to be. */
  refFileId: string | null;
  refSeq: number | null;
  outcome: string | null;
  error: string | null;
  /** `system` for records the daemon itself produced (it holds no admin_audit
   *  INSERT, so these reach Postgres only through this spool), `cli` for a
   *  terminal act, `console` for one a signed-in session took. */
  origin: AuditOrigin;
}

export const SPOOL_DIR_MODE = 0o700;
export const SPOOL_FILE_MODE = 0o600;

/** Size at which a writer retires its file and opens a fresh one. Small enough
 *  that a drained file leaves the disk quickly, large enough that rotation is
 *  rare on any real fortress. */
export const SPOOL_ROTATE_BYTES = 4 * 1024 * 1024;

/** How long a fully-drained file is kept before the console deletes it. It is
 *  not a retention policy for the TRAIL — nothing deletes a drained row, and no
 *  role holds DELETE on the table. It is the window in which the console's
 *  corroboration tail can still answer from disk, and the margin that stops the
 *  console removing a file another process is still appending to. */
export const SPOOL_RETENTION_MS = 60 * 60 * 1000;

/** The CLI's self-enforced ceiling. A fortress whose console has NEVER run
 *  drains nothing, so terminal acts would otherwise accumulate without bound;
 *  past these the CLI reclaims its own oldest files and says so in a record. */
export const SPOOL_MAX_FILES = 64;
export const SPOOL_MAX_BYTES = 32 * 1024 * 1024;

// ── Ownership ────────────────────────────────────────────────────────────────

/** Raised when the writing process is not the user that owns the spool. */
export class SpoolOwnershipError extends Error {
  constructor(readonly owner: string) {
    super(spoolOwnershipRefusal(owner));
    this.name = "SpoolOwnershipError";
  }
}

/** The refusal a root/sudo CLI invocation gets. It names the user to run as,
 *  because "permission denied" here is not a permissions problem the operator
 *  should fix with chmod — a record written under a second uid is a record the
 *  trail cannot attribute. */
export function spoolOwnershipRefusal(owner: string): string {
  return (
    `the audit spool belongs to ${owner}, and this process is not running as that user. ` +
    `Every console act is recorded before it happens, so run as ${owner} — ` +
    `a record written under another account is one the trail cannot attribute, ` +
    `and a spool a second account can write is a spool whose rows are all forgeable.`
  );
}

/** uid → login name, out of a passwd file's text. Exported for the test: there
 *  is no portable API for "the name of a uid that is not mine". */
export function userNameFromPasswd(passwd: string, uid: number): string | null {
  for (const line of passwd.split("\n")) {
    const parts = line.split(":");
    if (parts.length >= 3 && Number(parts[2]) === uid && parts[0]) return parts[0];
  }
  return null;
}

async function userLabel(uid: number): Promise<string> {
  try {
    const name = userNameFromPasswd(await readFile("/etc/passwd", "utf8"), uid);
    if (name) return name;
  } catch {
    // No passwd file (container without one, or a platform that has no such
    // concept). The uid still names the account precisely enough to act on.
  }
  return `uid ${uid}`;
}

/** The owner of the spool directory, or of the nearest ancestor that exists —
 *  the check has to work BEFORE the directory does, because a root CLI on a
 *  fresh fortress would otherwise create it root-owned and pass its own test. */
async function ownerUidOf(dir: string): Promise<number | null> {
  let probe = dir;
  for (;;) {
    try {
      return (await stat(probe)).uid;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}

/** Refuses a writer whose uid does not own the spool. Platforms without uids
 *  (Windows) have no such distinction to enforce and are left alone. */
export async function assertSpoolOwnership(dir: string): Promise<void> {
  const me = process.getuid?.();
  if (me === undefined) return;
  const owner = await ownerUidOf(dir);
  if (owner === null || owner === me) return;
  throw new SpoolOwnershipError(await userLabel(owner));
}

// ── Files ────────────────────────────────────────────────────────────────────

/** 128 random bits, hex. Not a uuid: the id is compared and stored as text, and
 *  uuid formatting spends 4 of its 128 bits on a version nibble. */
export function newSpoolFileId(): string {
  return randomBytes(16).toString("hex");
}

/** `<sortable start instant>-<writer>-<fileId>.jsonl`. The instant makes a
 *  plain name sort chronological (the drain, the retention floor and the CLI's
 *  reclaim all want oldest-first), and the writer makes the CLI's own files
 *  recognizable without opening them. */
export function spoolFileName(startedAt: Date, writer: SpoolWriter, fileId: string): string {
  const stamp = startedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${writer}-${fileId}.jsonl`;
}

export interface SpoolFile {
  name: string;
  path: string;
  bytes: number;
  writer: SpoolWriter | "unknown";
  fileId: string | null;
  /** Last write, not creation: the retention floor is about how long ago a file
   *  was last touched, since that is what bounds "a writer may still hold it". */
  modifiedAt: Date;
}

const NAME = /^(\d{8}T\d{6}Z)-(ui|cli|daemon)-([0-9a-f]{8,64})\.jsonl$/;

/** Every spool file, oldest first. */
export async function listSpoolFiles(dir: string): Promise<SpoolFile[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((e) => e.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const files: SpoolFile[] = [];
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const info = await stat(full);
      const parsed = NAME.exec(name);
      files.push({
        name,
        path: full,
        bytes: info.size,
        writer: (parsed?.[2] as SpoolWriter | undefined) ?? "unknown",
        fileId: parsed?.[3] ?? null,
        modifiedAt: info.mtime,
      });
    } catch {
      // Reclaimed by another process between the readdir and the stat.
    }
  }
  return files;
}

/** Read every spooled record, oldest file first. The drain runs as hx_ui and is
 *  `ON CONFLICT DO NOTHING` on (spool_file_id, seq), so re-reading a file that
 *  was already drained is a no-op rather than a duplicate. */
export async function readSpool(dir: string): Promise<AuditRecord[]> {
  const files = await listSpoolFiles(dir);
  const records: AuditRecord[] = [];
  for (const file of files) records.push(...(await readSpoolFile(file.path)));
  return records;
}

export async function readSpoolFile(file: string): Promise<AuditRecord[]> {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const records: AuditRecord[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as AuditRecord);
    } catch {
      // A torn final line (crash mid-append) — the pair semantics already
      // treat a missing outcome as evidence, so skipping it loses nothing.
    }
  }
  return records;
}

// ── The writer ───────────────────────────────────────────────────────────────

export interface AuditSpoolOptions {
  dir: string;
  /** Defaults to `ui`; sets the file's name and every record's origin. */
  writer?: SpoolWriter;
  fileId?: string;
  clock?: () => Date;
  rotateBytes?: number;
  /** Called once before this writer retires a file. A caller holding an open
   *  collapsed window closes it here, so the window lands in the file it
   *  belongs to rather than surviving into the next one. */
  beforeRotate?: () => Promise<void>;
}

export type AuditRecordInput = Omit<AuditRecord, "fileId" | "seq" | "ts" | "origin"> &
  Partial<Pick<AuditRecord, "origin">>;

export class AuditSpool {
  private readonly dir: string;
  private readonly writer: SpoolWriter;
  private readonly clock: () => Date;
  private readonly rotateBytes: number;
  private readonly beforeRotate: (() => Promise<void>) | null;
  private fileId: string;
  private fileName: string;
  private seq = 0;
  private bytes = 0;
  private ready: Promise<void> | null = null;
  private rotating = false;
  /** Set when a record pushed the file past its bound; consumed by the NEXT
   *  `append()`, never inside the chain. See `rotate()`. */
  private rotateDue = false;
  /** One append at a time, so `seq` and the file's bytes stay in step even when
   *  two callers write without awaiting each other. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: AuditSpoolOptions) {
    this.dir = options.dir;
    this.writer = options.writer ?? "ui";
    this.clock = options.clock ?? ((): Date => new Date());
    this.rotateBytes = options.rotateBytes ?? SPOOL_ROTATE_BYTES;
    this.beforeRotate = options.beforeRotate ?? null;
    this.fileId = options.fileId ?? newSpoolFileId();
    this.fileName = spoolFileName(this.clock(), this.writer, this.fileId);
  }

  get filePath(): string {
    return path.join(this.dir, this.fileName);
  }

  get currentFileId(): string {
    return this.fileId;
  }

  get origin(): AuditOrigin {
    return WRITER_ORIGIN[this.writer];
  }

  private ensureDir(): Promise<void> {
    this.ready ??= assertSpoolOwnership(this.dir)
      .then(() => mkdir(this.dir, { recursive: true, mode: SPOOL_DIR_MODE }))
      .then(() => undefined);
    return this.ready;
  }

  /** Append + fsync. The caller must await this BEFORE performing the mutation
   *  the record describes; a mutation whose intent never reached disk is one the
   *  console can never corroborate. */
  async append(record: AuditRecordInput): Promise<AuditRecord> {
    // Rotation happens between records, never inside one. `beforeRotate` flushes
    // pending failure windows, i.e. it appends, so it must run at a moment when
    // `this.tail` is settled and can be re-chained — which is exactly here.
    if (this.rotateDue) await this.rotate();
    const write = this.tail.then(() => this.appendOne(record));
    // The chain must not break on a refusal: an ownership error would otherwise
    // poison every later append with the FIRST caller's failure.
    this.tail = write.catch(() => undefined);
    return write;
  }

  private async appendOne(record: AuditRecordInput): Promise<AuditRecord> {
    await this.ensureDir();
    const full: AuditRecord = {
      ...record,
      actor: clampActor(record.actor),
      params: sanitizeParams(record.action, record.params),
      // AT WRITE TIME, like `params`. `error` is a thrown message — a driver's
      // connect failure quotes the whole DSN — and it was the one field of a
      // record that went to disk, and from there to the audit table and its
      // export, exactly as it arrived. Redacting it here means the column never
      // holds a credential, rather than every reader having to remember to.
      error: record.error === null || record.error === undefined ? record.error : redactCredentials(record.error),
      origin: record.origin ?? this.origin,
      fileId: this.fileId,
      seq: (this.seq += 1),
      ts: this.clock().toISOString(),
    };
    const line = `${JSON.stringify(full)}\n`;
    // One write per record, O_APPEND, then fsync: the record is on the platter
    // before the caller is told it may act.
    const handle = await open(this.filePath, "a", SPOOL_FILE_MODE);
    try {
      await handle.write(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.bytes += Buffer.byteLength(line);
    // Flag only. Rotating HERE would deadlock the whole spool: `beforeRotate`
    // appends (production wires it to flushFailures), and an append issued from
    // inside the chain waits on `this.tail` — which is this very call.
    //
    // And NOT while a rotation is in flight. `beforeRotate`'s own records land
    // in the file being retired, whose bound is already spent, so counting them
    // toward the next rotation re-armed it before the new file held anything:
    // measured at a 300-byte bound, files of 270 and 300 bytes alternating with
    // full ones, i.e. the directory filling with stubs.
    if (!this.rotating && this.bytes >= this.rotateBytes) this.rotateDue = true;
    return full;
  }

  /** Retire this file and open a fresh one. Long mutations never block it: the
   *  pair they belong to is resolved by (refFileId, refSeq), so an outcome may
   *  land in a file its intent never touched.
   *
   *  Callable directly (the CLI and tests do); the size-driven path reaches it
   *  from `append()` rather than from `appendOne()`, because `beforeRotate`
   *  appends and an append inside the chain can never be served. */
  async rotate(): Promise<void> {
    if (this.rotating) return;
    this.rotating = true;
    this.rotateDue = false;
    try {
      // Inside the guard, so a flush that appends does not recurse into another
      // rotation — its records belong to the file being retired, and `appendOne`
      // will not re-arm `rotateDue` for them.
      if (this.beforeRotate) await this.beforeRotate();
    } finally {
      this.rotating = false;
    }
    this.fileId = newSpoolFileId();
    this.fileName = spoolFileName(this.clock(), this.writer, this.fileId);
    this.seq = 0;
    this.bytes = 0;
  }

  async intent(
    action: string,
    fields: Partial<Omit<AuditRecord, "fileId" | "seq" | "ts" | "kind" | "action">> = {},
  ): Promise<AuditRecord> {
    return this.append({
      actor: fields.actor ?? null,
      sessionRef: fields.sessionRef ?? null,
      tier: fields.tier ?? null,
      action,
      params: fields.params ?? null,
      kind: "intent",
      refFileId: null,
      refSeq: null,
      outcome: null,
      error: null,
      ...(fields.origin ? { origin: fields.origin } : {}),
    });
  }

  async outcome(
    intentRecord: AuditRecord,
    outcome: string,
    error: string | null = null,
  ): Promise<AuditRecord> {
    return this.append({
      actor: intentRecord.actor,
      sessionRef: intentRecord.sessionRef,
      tier: intentRecord.tier,
      action: intentRecord.action,
      params: null,
      kind: "outcome",
      // Both halves of the reference: rotation may have retired the intent's
      // file between the two appends.
      refFileId: intentRecord.fileId,
      refSeq: intentRecord.seq,
      outcome,
      error,
      origin: intentRecord.origin,
    });
  }

  /** A single-event record: an act with no separate effect to answer for. */
  async event(
    action: string,
    fields: Partial<Omit<AuditRecord, "fileId" | "seq" | "ts" | "kind" | "action">> = {},
  ): Promise<AuditRecord> {
    return this.append({
      actor: fields.actor ?? null,
      sessionRef: fields.sessionRef ?? null,
      tier: fields.tier ?? null,
      action,
      params: fields.params ?? null,
      kind: "outcome",
      refFileId: null,
      refSeq: null,
      outcome: fields.outcome ?? null,
      error: fields.error ?? null,
      ...(fields.origin ? { origin: fields.origin } : {}),
    });
  }
}

// ── Pairing ──────────────────────────────────────────────────────────────────

/** The intent an outcome answers, resolved ACROSS files. The straddle is
 *  ordinary: a mutation that outlives a rotation writes its two halves into two
 *  files, and a resolver that only looked inside one file would report every
 *  such mutation as never having finished. */
export function resolveIntent(
  outcome: Pick<AuditRecord, "fileId" | "refFileId" | "refSeq">,
  records: readonly AuditRecord[],
): AuditRecord | null {
  if (outcome.refSeq === null) return null;
  const file = outcome.refFileId ?? outcome.fileId;
  return (
    records.find((r) => r.kind === "intent" && r.fileId === file && r.seq === outcome.refSeq) ?? null
  );
}

// ── The cap ──────────────────────────────────────────────────────────────────

export interface SpoolUsage {
  files: number;
  bytes: number;
}

export async function spoolUsage(dir: string): Promise<SpoolUsage> {
  const files = await listSpoolFiles(dir);
  return { files: files.length, bytes: files.reduce((sum, f) => sum + f.bytes, 0) };
}

export interface SpoolCaps {
  maxFiles: number;
  maxBytes: number;
}

export const DEFAULT_SPOOL_CAPS: SpoolCaps = {
  maxFiles: SPOOL_MAX_FILES,
  maxBytes: SPOOL_MAX_BYTES,
};

export function overSpoolCap(usage: SpoolUsage, caps: SpoolCaps = DEFAULT_SPOOL_CAPS): boolean {
  return usage.files > caps.maxFiles || usage.bytes > caps.maxBytes;
}

export interface ReclaimPlan {
  /** Files chosen for reclaim, oldest first. */
  files: SpoolFile[];
  records: number;
  /** The span the reclaimed records covered, for the record that announces it. */
  from: string | null;
  to: string | null;
  bytes: number;
}

/**
 * Choose the oldest files of one writer to drop, without dropping them yet.
 *
 * Two phases because the loss has to be ANNOUNCED before it happens: the caller
 * writes one record naming this span into its own fresh file, and only then
 * applies the plan. Bounded growth with a hole somebody can see beats unbounded
 * growth on a fortress whose console has never started - and beats a silent stop,
 * which would make the trail simply end.
 */
export async function planSpoolReclaim(
  dir: string,
  options: {
    writer: SpoolWriter;
    keep?: ReadonlySet<string>;
    caps?: SpoolCaps;
    /** Room the caller is about to take. A writer that checked the cap and then
     *  added its own file would sit one file over it forever. */
    reserve?: SpoolUsage;
  },
): Promise<ReclaimPlan> {
  const caps = options.caps ?? DEFAULT_SPOOL_CAPS;
  const keep = options.keep ?? new Set<string>();
  const reserve = options.reserve ?? { files: 0, bytes: 0 };
  const files = await listSpoolFiles(dir);
  const plan: ReclaimPlan = { files: [], records: 0, from: null, to: null, bytes: 0 };
  let usage: SpoolUsage = {
    files: files.length + reserve.files,
    bytes: files.reduce((sum, f) => sum + f.bytes, 0) + reserve.bytes,
  };
  for (const file of files) {
    if (!overSpoolCap(usage, caps)) break;
    if (file.writer !== options.writer || keep.has(file.name)) continue;
    const records = await readSpoolFile(file.path);
    plan.files.push(file);
    plan.records += records.length;
    plan.bytes += file.bytes;
    const first = records[0]?.ts ?? null;
    const last = records[records.length - 1]?.ts ?? null;
    if (first && (plan.from === null || first < plan.from)) plan.from = first;
    if (last && (plan.to === null || last > plan.to)) plan.to = last;
    usage = { files: usage.files - 1, bytes: usage.bytes - file.bytes };
  }
  return plan;
}

export async function applySpoolReclaim(plan: ReclaimPlan): Promise<number> {
  for (const file of plan.files) await rm(file.path, { force: true });
  return plan.files.length;
}
