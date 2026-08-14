// Interactive acquisition of a `vlt_` enrollment key at install time.
//
// A Y/n "open a browser?" prompt drives one of two paths:
//   Y → device-auth flow (pairing card + poll) with graceful fallbacks to a
//       masked paste, or an abort when Fortress is unavailable for this org.
//   n → straight to a masked paste.
// Returns a `vlt_` token or throws a friendly Error (the caller aborts).

import { confirmPrompt, passwordPrompt } from "./prompt.js";
import {
  installBaseFromCloudUrl,
  requestInstallCode,
  pollInstallToken,
  type InstallCode,
  type PollResult,
} from "./browser-enroll.js";
import { renderPairingCard } from "./pairing-card.js";
import { openBrowser as realOpenBrowser } from "./open-browser.js";

type Log = (line: string) => void;

export interface AcquireDeps {
  confirm?: (msg: string, opts?: { default?: boolean }) => Promise<boolean>;
  password?: (msg: string) => Promise<string>;
  openBrowser?: (url: string) => Promise<void>;
  requestCode?: (installBase: string) => Promise<InstallCode>;
  poll?: (
    installBase: string,
    deviceCode: string,
    o: {
      intervalMs: number;
      deadlineMs: number;
      now: () => number;
      sleep: (ms: number) => Promise<void>;
      onTick?: () => void;
    },
  ) => Promise<PollResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const PASTE_HINT =
  "Get your key from Org Settings → HX → Fortress (Install manually), then paste it here.";

async function pasteKey(password: (m: string) => Promise<string>, log: Log): Promise<string> {
  log(PASTE_HINT);
  for (;;) {
    const key = await password("let.ai hx-fortress key:");
    if (key.startsWith("vlt_")) return key;
    if (key.trim() === "") {
      throw new Error(
        "No key entered. Re-run and paste your key, or enable Fortress in Org Settings.",
      );
    }
    log("That doesn't look like a Fortress key (should start with vlt_). Try again.");
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

export async function acquireEnrollmentKey(opts: {
  cloudUrl: string;
  log: Log;
  deps?: AcquireDeps;
}): Promise<string> {
  const d = opts.deps ?? {};
  const confirm = d.confirm ?? confirmPrompt;
  const password = d.password ?? passwordPrompt;
  const openBrowser = d.openBrowser ?? realOpenBrowser;
  const requestCode = d.requestCode ?? requestInstallCode;
  const poll = d.poll ?? pollInstallToken;
  const now = d.now ?? (() => Date.now());
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const wantBrowser = await confirm("Open a browser to install hx-fortress?", { default: true });
  if (!wantBrowser) return pasteKey(password, opts.log);

  const installBase = installBaseFromCloudUrl(opts.cloudUrl);
  const code = await requestCode(installBase).catch(() => null);
  if (!code) {
    opts.log(`Couldn't reach ${installBase}. Falling back to manual key entry.`);
    return pasteKey(password, opts.log);
  }

  for (const line of renderPairingCard({
    userCode: code.userCode,
    approveHost: hostOf(code.verificationUriComplete),
  })) {
    opts.log(line);
  }
  opts.log("Check the code matches what your browser shows, then authorize there.");
  opts.log(`If your browser didn't open, visit:\n  ${code.verificationUriComplete}`);
  await openBrowser(code.verificationUriComplete).catch(() => {});
  opts.log("Waiting for authorization… (Ctrl+C to cancel)");

  const res = await poll(installBase, code.deviceCode, {
    intervalMs: (code.interval || 2) * 1000,
    deadlineMs: 10 * 60 * 1000,
    now,
    sleep,
  });
  switch (res.kind) {
    case "ready":
      return res.token;
    case "multiple_orgs":
      opts.log(
        "Multiple organizations are pending — copy the key from Org Settings and paste it here.",
      );
      return pasteKey(password, opts.log);
    case "expired":
      opts.log("Timed out waiting for authorization.");
      return pasteKey(password, opts.log);
    case "unavailable": {
      const msg =
        res.reason === "already_installed"
          ? "This organization's Fortress is already installed."
          : res.reason === "forbidden"
            ? "You don't have permission to authorize this install — ask an org admin."
            : "Enable Fortress in Org Settings → HX → Fortress, then re-run the installer.";
      throw new Error(msg);
    }
  }
}
