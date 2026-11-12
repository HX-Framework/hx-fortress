// The interactive enroll wizard. Drives the operator through storage backend →
// CLI bootstrap → location → project → bucket → credentials → verify → connect.
// Tone: third-person, every prompt states why it's needed, never a dead end —
// any decline writes a completable template + SETUP.md and exits.

import { readFile } from "node:fs/promises";
import { selectPrompt, textPrompt, confirmPrompt, passwordPrompt } from "./prompt.js";
import { detectGcloud, detectAws, hasCommand } from "./detect.js";
import { GCS_LOCATIONS, AWS_REGIONS } from "./regions.js";
import { ensureGcloud, ensureAws } from "./provision/cli-bootstrap.js";
import {
  gcsBucketExists,
  createGcsBucket,
  gcsCreateCommand,
  s3BucketExists,
  createS3Bucket,
  s3CreateCommand,
} from "./provision/bucket.js";
import { createGcsServiceAccount, createS3IamUser } from "./provision/identity.js";
import { writeCredentialsTemplate, writeSetupMd, type TemplateContext } from "./provision/setup-md.js";
import {
  writeVaultCredentials,
  type VaultCredentials,
  type GcsServiceAccountKey,
  type S3Credentials,
} from "./credentials.js";
import { buildStore } from "./store.js";
import { acquireEnrollmentKey } from "./acquire-key.js";
import { FileCredentialStore, FilePendingEnrollmentStore } from "../../cloud/credentials.js";
import { startFortress } from "../../cli-lifecycle.js";
import { getServiceManager } from "../../service/index.js";
import {
  assertGatewayPublicUrl,
  DEFAULT_GATEWAY_PUBLIC_URL,
  ensureEnrollmentConfig,
  ensureGatewayPublicUrlConfigured,
  FileConfigStore,
  sessionsChosenOnDisk,
  setSessionsEnabled,
} from "../../host/config.js";
import { fortressPaths } from "../../host/paths.js";

type Log = (m: string) => void;

export interface WizardOpts {
  /** The control plane's address, e.g. wss://control.example/fortress/tunnel. */
  cloudUrl: string;
  token: string;
  log: Log;
  /** Override the Fortress root directory (default: ~/.let/hx-fortress). */
  fortressRoot?: string;
}

/**
 * Entry-point opts for {@link runEnrollWizard}: the token is optional here
 * because the wizard acquires it up front when it's absent. Every downstream
 * step still receives a resolved {@link WizardOpts} with a concrete token.
 */
export type WizardEntryOpts = Omit<WizardOpts, "token"> & { token?: string };

/** Injectable seams for tests. Each defaults to the real thing. */
export interface EnrollWizardDeps {
  acquireKey?: typeof acquireEnrollmentKey;
  /** Asks whether this fortress stores AI session transcripts. */
  chooseSessions?: () => Promise<"on" | "off">;
  /** Asks "Start hx-fortress now?". */
  confirmStart?: () => Promise<boolean>;
  /** Installs and starts the service. */
  start?: (opts: WizardOpts) => Promise<void>;
  /** Whether the fortress is running right now. */
  running?: () => Promise<boolean>;
  /** Asks which kind of bucket holds the transcripts. */
  chooseStore?: () => Promise<"gcs" | "s3">;
}

/** Whether the service manager reports a running fortress. Unknown counts as
 *  not running: the hint this decides is only worth printing when it is sure. */
async function fortressIsRunning(): Promise<boolean> {
  try {
    return (await getServiceManager().state()).pid !== null;
  } catch {
    return false;
  }
}

/** A fortress decides whether Sessions is on once, when it starts. One that is
 *  already running keeps what it started with, so the operator is told how to
 *  make the new choice take effect, and is not told it already has. */
const RESTART_FOR_SESSIONS = [
  "The fortress that is running now started with its earlier settings and keeps them until it restarts.",
  "To apply this choice:  hx-fortress stop  and then  hx-fortress start",
] as const;

/** The first question of the setup. Sessions is the only module that needs a
 *  bucket and an embedding key, so the answer decides what is asked next. */
function chooseSessions(): Promise<"on" | "off"> {
  return selectPrompt<"on" | "off">("Store AI session transcripts on this host (the Sessions module)?", [
    { label: "Yes - sessions rest in a bucket this organization owns", value: "on" },
    { label: "No - run without Sessions. No bucket and no embedding key are needed", value: "off" },
  ]);
}

export function resolveGatewayPublicUrlInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_GATEWAY_PUBLIC_URL;
  assertGatewayPublicUrl(trimmed);
  return trimmed;
}

type Confirm = typeof confirmPrompt;

export async function maybeKeepExistingVaultConfig(
  opts: WizardOpts,
  confirm: Confirm = confirmPrompt,
): Promise<boolean> {
  const paths = fortressPaths(opts.fortressRoot);
  const config = await new FileConfigStore(paths).load().catch(() => null);
  if (!config) return false;

  const credential = await new FileCredentialStore(paths.credentials).load().catch(() => null);
  if (!credential) return false;

  opts.log(`Existing Fortress config found for ${config.cloud.url}.`);
  const keep = await confirm("Keep the existing vault config?", { default: true });
  if (!keep) return false;

  await new FilePendingEnrollmentStore(paths.pendingEnrollment).clear();
  opts.log("Keeping the existing vault config. Start Fortress to reconnect:  hx-fortress start");
  return true;
}

export async function runEnrollWizard(
  opts: WizardEntryOpts,
  deps: EnrollWizardDeps = {},
): Promise<void> {
  const { log } = opts;
  const acquireKey = deps.acquireKey ?? acquireEnrollmentKey;
  log("");
  log("HX Fortress");
  log("This host keeps its own keys. With the Sessions module on, AI session transcripts");
  log("rest in the organization's own bucket, and the storage credentials never leave this host.");
  log("");

  // Already-enrolled guard: a re-run with no explicit token must not clobber a
  // live install (nor prompt for a fresh key). An explicit token means the
  // operator deliberately wants to re-enroll, so we skip the guard.
  if (!opts.token) {
    const paths = fortressPaths(opts.fortressRoot);
    const existing = await new FileCredentialStore(paths.credentials).load().catch(() => null);
    if (existing) {
      log("This host is already enrolled. Start it with:  hx-fortress start");
      log("(To re-enroll, pass an explicit token to `hx-fortress enroll`.)");
      return;
    }
  }

  // Acquire the enrollment key up front so auth failures surface before any
  // storage configuration work.
  const token = opts.token ?? (await acquireKey({ cloudUrl: opts.cloudUrl, log }));
  const resolved: WizardOpts = { ...opts, token };

  if (await maybeKeepExistingVaultConfig(resolved)) return;

  // MC-2382: hx uploads relay over the reverse tunnel, so the fortress needs no
  // public URL — we no longer ask for one. The gateway URL stays at its
  // local-only default; operators wanting the dormant fortress-direct path set
  // FORTRESS_PUBLIC_URL instead (see resolveGatewayConfig).
  await ensureGatewayConfig(resolved);

  const sessions = await (deps.chooseSessions ?? chooseSessions)();
  if (sessions === "off") return finishWithoutSessions(resolved, deps);
  // "On" is written down at the end: by `finishAndConnect`, once the bucket is
  // verified and the credentials are saved, or by `handOffSetup`, when the
  // setup hands the rest to the operator and says so. Written here, a setup
  // that is abandoned at the next question would leave a fortress that had
  // Sessions off with Sessions on and no bucket, and it would not start again.

  const store = await (
    deps.chooseStore ??
    ((): Promise<"gcs" | "s3"> =>
      selectPrompt<"gcs" | "s3">("Storage backend for session transcripts:", [
        { label: "Google Cloud Storage", value: "gcs" },
        { label: "Amazon S3", value: "s3" },
      ]))
  )();
  if (store === "gcs") return enrollGcs(resolved);
  return enrollS3(resolved);
}

async function enrollGcs(opts: WizardOpts): Promise<void> {
  const { cloudUrl, token, log } = opts;
  const boot = await ensureGcloud(log);
  const state = await detectGcloud();

  const project = await textPrompt("GCP project (holds the bucket and service account):", {
    default: state.project ?? undefined,
  });
  if (!project) {
    log("A project is required.");
    process.exit(2);
  }
  const location = await selectPrompt(
    "Bucket location (where transcripts rest):",
    GCS_LOCATIONS.map((r) => ({ label: r.label, value: r.value })),
    { filter: true, defaultIndex: indexOf(GCS_LOCATIONS, state.region) },
  );
  const bucket = await requireBucketName(log);

  const ctx: TemplateContext = {
    store: "gcs",
    bucket,
    region: location,
    projectId: project,
    cloudUrl,
    token,
    fortressRoot: opts.fortressRoot,
  };

  // No usable gcloud → can't auto-provision; offer paste, else template.
  if (!boot.ready) {
    return pasteKeyOrDefer(ctx, opts);
  }

  const probe = await gcsBucketExists(bucket, project);
  if (probe.error) {
    log(`Could not verify gs://${bucket} in ${project}: ${probe.error}`);
    return defer(ctx, log);
  }
  if (!probe.exists) {
    log(`Bucket ${bucket} not found in ${project}.`);
    if (
      await confirmPrompt("Create it (public access blocked, uniform access, versioning)?", {
        default: true,
      })
    ) {
      const kmsKey = await maybeKmsKey();
      if (!(await createGcsBucket({ bucket, project, location, kmsKey }, log))) return defer(ctx, log);
      log(`Created gs://${bucket} (${location}).`);
    } else {
      log("Create it manually, then re-run:");
      log(`  ${gcsCreateCommand({ bucket, project, location })}`);
      return defer(ctx, log);
    }
  }

  let key: GcsServiceAccountKey | undefined;
  if (await confirmPrompt("Create a least-privilege GCP service account to store sessions?", { default: true })) {
    const created = await createGcsServiceAccount({ project, bucket }, log);
    if (created) {
      key = created;
      log("Created a service account with bucket-scoped roles/storage.objectAdmin.");
    }
  }
  if (!key) key = await pasteGcsKey(log);
  if (!key) return defer(ctx, log);

  await finishAndConnect(
    { store: "gcs", bucket, region: location, projectId: project, gcs: key },
    opts,
    log,
  );
}

async function enrollS3(opts: WizardOpts): Promise<void> {
  const { log } = opts;
  const state = await detectAws();
  const region = await selectPrompt(
    "Bucket region (where transcripts rest):",
    AWS_REGIONS.map((r) => ({ label: r.label, value: r.value })),
    { filter: true, defaultIndex: indexOf(AWS_REGIONS, state.region) },
  );
  const bucket = await requireBucketName(log);
  const ctx: TemplateContext = {
    store: "s3",
    bucket,
    region,
    cloudUrl: opts.cloudUrl,
    token: opts.token,
    fortressRoot: opts.fortressRoot,
  };

  const method = await selectPrompt<"create" | "paste">("Credentials:", [
    { label: "Create a least-privilege IAM user (requires an aws admin login)", value: "create" },
    { label: "Paste an existing access key", value: "paste" },
  ]);

  let creds: S3Credentials | undefined;
  if (method === "create") {
    const boot = await ensureAws(log);
    if (boot.ready) {
      await ensureS3Bucket(bucket, region, undefined, log);
      const user = await createS3IamUser({ bucket }, log);
      if (user) {
        creds = user;
        log("Created an IAM user with a bucket-scoped policy.");
      }
    }
  }
  if (!creds) {
    creds = await pasteS3Key(log);
    // Paste path: check the bucket with the pasted creds and offer a create.
    if (creds) await ensureS3Bucket(bucket, region, creds, log);
  }
  if (!creds) return defer(ctx, log);

  await finishAndConnect({ store: "s3", bucket, region, s3: creds }, opts, log);
}

/** Ensure the S3 bucket exists, offering a secure create. Uses `creds` when
 *  given (paste path) by exporting them for the aws CLI; otherwise the active
 *  profile (create path). Skips silently when the aws CLI is absent — the
 *  pre-connect self-test then surfaces a missing bucket with a clear message. */
async function ensureS3Bucket(
  bucket: string,
  region: string,
  creds: S3Credentials | undefined,
  log: Log,
): Promise<void> {
  if (!(await hasCommand("aws"))) return;
  if (creds) {
    process.env.AWS_ACCESS_KEY_ID = creds.accessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = creds.secretAccessKey;
    if (creds.sessionToken) process.env.AWS_SESSION_TOKEN = creds.sessionToken;
  }
  if (await s3BucketExists(bucket, region)) return;
  log(`Bucket ${bucket} not found in ${region}.`);
  if (await confirmPrompt("Create it (public access blocked, versioning, SSE)?", { default: true })) {
    const kmsKey = await maybeKmsKey();
    if (await createS3Bucket({ bucket, region, kmsKey }, log)) {
      log(`Created s3://${bucket} (${region}).`);
      return;
    }
  }
  log("Create it manually, then re-run:");
  log(`  ${s3CreateCommand({ bucket, region })}`);
}

/** Optional customer-managed encryption key (CMEK / SSE-KMS). */
async function maybeKmsKey(): Promise<string | undefined> {
  const k = await textPrompt("Customer-managed KMS key for encryption (Enter for provider-managed):");
  return k || undefined;
}

// ── shared steps ─────────────────────────────────────────────────────────────

/** MC-2465: collect the OpenAI key (required — MC-2471 refuses to start without
 *  it). Written only to this host's 0600 credentials file, never sent to a control plane;
 *  the user can verify that in the open-source hx-fortress repo. */
async function promptOpenAiKey(log: Log): Promise<string> {
  log("");
  log("OpenAI API key — hx-fortress creates vector embeddings so you can search");
  log("your sessions by meaning. It is written ONLY to this host's credentials");
  log("file (chmod 600) and is never sent to a control plane — you can verify that in the");
  log("open-source repo: https://github.com/hx-framework/hx-fortress");
  while (true) {
    const key = (await passwordPrompt("OpenAI API key (sk-...):")).trim();
    if (key) return key;
    log("An OpenAI key is required — hx-fortress will not start without it (Ctrl-C to abort).");
  }
}

async function finishAndConnect(creds: VaultCredentials, opts: WizardOpts, log: Log): Promise<void> {
  const openaiApiKey = await promptOpenAiKey(log);
  // MC-2464: a bad bucket/creds must not crash the installer — verify in a loop
  // and let the operator re-enter the bucket name and retry, staying in the TUI.
  let current: VaultCredentials = { ...creds, openaiApiKey };
  while (true) {
    await writeVaultCredentials(current);
    log("Verifying write + read access to the bucket…");
    try {
      await buildStore(current).selfTest();
      log("Storage verified.");
      break;
    } catch (e) {
      log(`Storage check failed: ${(e as Error).message}`);
      if (!(await confirmPrompt("Re-enter the bucket name and try again?", { default: true }))) {
        log("credentials.json was written; fix the bucket access and re-run enroll.");
        return;
      }
      current = { ...current, bucket: await requireBucketName(log) };
    }
  }

  // Write the enrollment token to the Fortress identity directory so the host
  // can authenticate on first connect without the vault module knowing the token.
  const paths = fortressPaths(opts.fortressRoot);
  // Only now is Sessions on: there is a verified bucket and a saved key to run
  // it with. This also turns it on for a fortress that had it off.
  const wasOn = await sessionsChosenOnDisk(paths);
  await setSessionsEnabled(paths, true);
  const pendingStore = new FilePendingEnrollmentStore(paths.pendingEnrollment);
  await pendingStore.save({ token: opts.token, cloudUrl: opts.cloudUrl });

  log("");
  log(`Session Vault credentials saved. Transcripts will rest in ${current.bucket}.`);
  if (!wasOn && (await fortressIsRunning())) {
    log("Sessions is switched on in this fortress's settings.");
    for (const line of RESTART_FOR_SESSIONS) log(line);
  }
  if (await confirmPrompt("Start hx-fortress now? (Y/n)", { default: true })) {
    await startFortress({
      manager: getServiceManager(),
      executablePath: process.execPath,
      paths: fortressPaths(opts.fortressRoot),
      writeLine: log,
    });
  } else {
    log("Start Fortress when ready:  hx-fortress start");
  }
}

/**
 * Finish a setup that stores no sessions: record the choice, leave the
 * enrollment token for the daemon, and offer to start it. No bucket is asked
 * for and no credentials file is written.
 */
async function finishWithoutSessions(opts: WizardOpts, deps: EnrollWizardDeps): Promise<void> {
  const { log } = opts;
  const paths = fortressPaths(opts.fortressRoot);
  // Throws when the choice cannot be saved. Nothing below says "off" unless
  // config.json really says it.
  await setSessionsEnabled(paths, false);
  await new FilePendingEnrollmentStore(paths.pendingEnrollment).save({
    token: opts.token,
    cloudUrl: opts.cloudUrl,
  });

  log("");
  if (await (deps.running ?? fortressIsRunning)()) {
    log("Sessions is switched off in this fortress's settings.");
    for (const line of RESTART_FOR_SESSIONS) log(line);
  } else {
    log("Sessions is off. This fortress stores no AI session transcripts and needs no bucket.");
  }
  log("To turn it on later, run `hx-fortress enroll` again with a new enrollment token.");
  const confirmStart =
    deps.confirmStart ?? ((): Promise<boolean> => confirmPrompt("Start hx-fortress now? (Y/n)", { default: true }));
  if (await confirmStart()) {
    const start =
      deps.start ??
      (async (o: WizardOpts): Promise<void> => {
        await startFortress({
          manager: getServiceManager(),
          executablePath: process.execPath,
          paths: fortressPaths(o.fortressRoot),
          writeLine: o.log,
        });
      });
    await start(opts);
  } else {
    log("Start Fortress when ready:  hx-fortress start");
  }
}

async function pasteKeyOrDefer(ctx: TemplateContext, opts: WizardOpts): Promise<void> {
  const { log } = opts;
  const key = await pasteGcsKey(log);
  if (!key) return defer(ctx, log);
  await finishAndConnect(
    { store: "gcs", bucket: ctx.bucket, region: ctx.region, projectId: ctx.projectId, gcs: key },
    opts,
    log,
  );
}

async function pasteGcsKey(log: Log): Promise<GcsServiceAccountKey | undefined> {
  const p = await textPrompt("Path to an existing service-account key JSON (Enter to finish manually):");
  if (!p) return undefined;
  try {
    return JSON.parse(await readFile(p, "utf8")) as GcsServiceAccountKey;
  } catch (e) {
    log(`Could not read ${p}: ${String(e)}`);
    return undefined;
  }
}

async function pasteS3Key(log: Log): Promise<S3Credentials | undefined> {
  const id = await textPrompt("AWS access key ID (Enter to finish manually):");
  if (!id) return undefined;
  const secret = await passwordPrompt("AWS secret access key:");
  if (!secret) {
    log("No secret provided.");
    return undefined;
  }
  return { accessKeyId: id, secretAccessKey: secret };
}

/**
 * Hand the rest of the setup to the operator: a credentials file to complete,
 * the exact commands, and the enrollment token left for the daemon.
 *
 * The operator answered Yes to Sessions and is told to start the fortress once
 * the file is complete. So the choice is saved here. Without it, that start
 * would come up with Sessions off on a fortress that had it off: it would
 * ignore the completed file and use up the new enrollment token doing so, and
 * nothing would say why.
 *
 * This is not the case the comment in `runEnrollWizard` is about. There a
 * setup is abandoned and nothing was said. Here the setup ends on purpose, and
 * its last lines say what was switched and how to switch it back.
 */
export async function handOffSetup(
  ctx: TemplateContext,
  log: Log,
  deps: { running?: () => Promise<boolean> } = {},
): Promise<void> {
  const paths = fortressPaths(ctx.fortressRoot);
  const wasOn = await sessionsChosenOnDisk(paths);
  const credsPath = await writeCredentialsTemplate(ctx);
  const setupPath = await writeSetupMd(ctx);
  // Throws when the choice cannot be saved, and then nothing below is said.
  await setSessionsEnabled(paths, true);
  log("");
  log(`Template written to ${credsPath} — complete the ${ctx.store} block to finish.`);
  log(`Exact commands: ${setupPath}`);
  if (!wasOn) {
    log("Sessions is switched on in this fortress's settings.");
    log("With Sessions on, the fortress does not start until that file is complete and an embedding key is set.");
    log("To leave Sessions off instead:  hx-fortress modules off session_vault");
    if (await (deps.running ?? fortressIsRunning)()) {
      for (const line of RESTART_FOR_SESSIONS) log(line);
    }
  }
  log("Then run: hx-fortress start");
}

async function defer(ctx: TemplateContext, log: Log): Promise<void> {
  await handOffSetup(ctx, log);
  process.exit(0);
}

async function requireBucketName(log: Log): Promise<string> {
  // MC-2464: never dead-end — loop until a name is given (Ctrl-C still aborts)
  // instead of exiting the installer.
  while (true) {
    const bucket = await textPrompt("Bucket name (must be globally unique):");
    if (bucket) return bucket;
    log("A bucket name is required.");
  }
}

function indexOf(list: { value: string }[], value: string | null): number {
  if (!value) return 0;
  const i = list.findIndex((r) => r.value === value);
  return i >= 0 ? i : 0;
}

async function ensureGatewayConfig(
  opts: WizardOpts,
  gatewayPublicUrl: string = DEFAULT_GATEWAY_PUBLIC_URL,
): Promise<void> {
  const paths = fortressPaths(opts.fortressRoot);
  await ensureEnrollmentConfig(paths, opts.cloudUrl, gatewayPublicUrl);
  await ensureGatewayPublicUrlConfigured(paths, gatewayPublicUrl);
}
