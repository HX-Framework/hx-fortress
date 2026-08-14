// Ensure the chosen cloud CLI is installed and authenticated before
// provisioning. Each step is named and confirmed — nothing installs or runs
// silently, and any decline returns { ready: false } so the wizard falls back to
// the manual template rather than dead-ending. Browser OAuth is between the
// operator and the cloud provider; let.ai never sees it.

import { confirmPrompt } from "../prompt.js";
import {
  detectGcloud,
  detectAws,
  detectPackageManager,
  hasCommand,
  type PackageManager,
} from "../detect.js";
import { interactive } from "./exec.js";

type Log = (m: string) => void;

export interface BootstrapResult {
  ready: boolean;
  /** Why bootstrap stopped short, when ready is false. */
  reason?: string;
}

function gcloudInstallCmd(pm: PackageManager): { argv: string[]; display: string } | null {
  switch (pm) {
    case "brew":
      return {
        argv: ["brew", "install", "--cask", "google-cloud-sdk"],
        display: "brew install --cask google-cloud-sdk",
      };
    case "apt":
    case "dnf":
      // The official cross-distro installer; interactive, installs to ~/google-cloud-sdk.
      return {
        argv: ["sh", "-c", "curl https://sdk.cloud.google.com | bash"],
        display: "curl https://sdk.cloud.google.com | bash",
      };
    case "none":
      return null;
  }
}

/** gcloud: install if missing, authenticate if needed, configure ADC. */
export async function ensureGcloud(log: Log): Promise<BootstrapResult> {
  let state = await detectGcloud();

  if (!state.installed) {
    log("Google Cloud CLI not found. Required to create the bucket and service account.");
    const cmd = gcloudInstallCmd(await detectPackageManager());
    if (!cmd) {
      log("No supported package manager detected. Install the Google Cloud CLI manually:");
      log("  https://cloud.google.com/sdk/docs/install");
      return { ready: false, reason: "gcloud not installed" };
    }
    if (!(await confirmPrompt(`Install the Google Cloud CLI (${cmd.display})?`, { default: true }))) {
      log(`Install it manually, then re-run: ${cmd.display}`);
      return { ready: false, reason: "gcloud install declined" };
    }
    await interactive(cmd.argv[0], cmd.argv.slice(1));
    if (!(await hasCommand("gcloud"))) {
      log("gcloud installed but not yet on PATH. Restart the shell and re-run the installer.");
      return { ready: false, reason: "gcloud not on PATH" };
    }
    state = await detectGcloud();
  }

  if (!state.account) {
    log("gcloud is not authenticated. Required to provision storage under the organization's own credentials.");
    if (!(await confirmPrompt("Authenticate gcloud now (opens a browser)?", { default: true }))) {
      return { ready: false, reason: "gcloud auth declined" };
    }
    await interactive("gcloud", ["auth", "login"]);
    state = await detectGcloud();
    if (!state.account) {
      log("gcloud authentication did not complete.");
      return { ready: false, reason: "gcloud auth incomplete" };
    }
  }

  if (!state.adcConfigured) {
    log("Application-default credentials are not set. Required to sign storage URLs locally.");
    if (await confirmPrompt("Run gcloud auth application-default login (opens a browser)?", { default: true })) {
      await interactive("gcloud", ["auth", "application-default", "login"]);
    }
    // Not fatal: a service-account key created later signs URLs locally too.
  }

  log(`gcloud ready — authenticated as ${state.account}.`);
  return { ready: true };
}

/** aws: install if missing, configure credentials if none resolve. */
export async function ensureAws(log: Log): Promise<BootstrapResult> {
  let state = await detectAws();

  if (!state.installed) {
    log("AWS CLI not found. Required to create the bucket and IAM identity.");
    if (await hasCommand("brew")) {
      if (!(await confirmPrompt("Install the AWS CLI (brew install awscli)?", { default: true }))) {
        return { ready: false, reason: "aws install declined" };
      }
      await interactive("brew", ["install", "awscli"]);
    } else {
      log("Install the AWS CLI manually: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html");
      return { ready: false, reason: "aws not installed" };
    }
    if (!(await hasCommand("aws"))) {
      log("aws installed but not yet on PATH. Restart the shell and re-run the installer.");
      return { ready: false, reason: "aws not on PATH" };
    }
    state = await detectAws();
  }

  if (!state.identityArn) {
    log("AWS credentials are not configured. Required to provision storage under the organization's own account.");
    if (!(await confirmPrompt("Configure credentials now (aws configure)?", { default: true }))) {
      return { ready: false, reason: "aws auth declined" };
    }
    await interactive("aws", ["configure"]);
    state = await detectAws();
    if (!state.identityArn) {
      log("AWS credentials still do not resolve.");
      return { ready: false, reason: "aws auth incomplete" };
    }
  }

  log(`aws ready — ${state.identityArn}.`);
  return { ready: true };
}
