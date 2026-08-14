// Inspect the host so the wizard can pre-fill answers and decide whether the
// cloud CLI needs bootstrapping. Pure reads — nothing here mutates the host or
// contacts let.ai.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const pexec = promisify(execFile);

async function run(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await pexec(cmd, args, { timeout: 10_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Is a command on PATH? */
export async function hasCommand(cmd: string): Promise<boolean> {
  return Boolean(await run("which", [cmd]));
}

export type PackageManager = "brew" | "apt" | "dnf" | "none";

/** The OS package manager available for installing a cloud CLI. */
export async function detectPackageManager(): Promise<PackageManager> {
  if (await hasCommand("brew")) return "brew";
  if (await hasCommand("apt-get")) return "apt";
  if (await hasCommand("dnf")) return "dnf";
  return "none";
}

export interface GcloudState {
  installed: boolean;
  /** Active authenticated account email, if any. */
  account: string | null;
  /** Default project from `gcloud config`. */
  project: string | null;
  /** Default compute region from `gcloud config`. */
  region: string | null;
  /** Whether application-default credentials are set up (needed for URL signing). */
  adcConfigured: boolean;
}

/** gcloud prints "(unset)" for an unconfigured value. */
function clean(v: string | null): string | null {
  return v && v !== "(unset)" ? v : null;
}

export async function detectGcloud(): Promise<GcloudState> {
  if (!(await hasCommand("gcloud"))) {
    return { installed: false, account: null, project: null, region: null, adcConfigured: false };
  }
  const [account, project, region] = await Promise.all([
    run("gcloud", ["config", "get-value", "account", "--quiet"]),
    run("gcloud", ["config", "get-value", "project", "--quiet"]),
    run("gcloud", ["config", "get-value", "compute/region", "--quiet"]),
  ]);
  const adcConfigured = existsSync(
    path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json"),
  );
  return {
    installed: true,
    account: clean(account),
    project: clean(project),
    region: clean(region),
    adcConfigured,
  };
}

export interface AwsState {
  installed: boolean;
  /** Caller identity ARN if credentials resolve, else null. */
  identityArn: string | null;
  region: string | null;
}

export async function detectAws(): Promise<AwsState> {
  if (!(await hasCommand("aws"))) {
    return { installed: false, identityArn: null, region: null };
  }
  const [region, identity] = await Promise.all([
    run("aws", ["configure", "get", "region"]),
    run("aws", ["sts", "get-caller-identity", "--query", "Arn", "--output", "text"]),
  ]);
  return { installed: true, identityArn: identity || null, region: region || null };
}
