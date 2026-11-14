// The setup's own lines in the audit trail.
//
// A setup changes settings, so it is recorded like every other act on this
// host: in the same append-only spool the terminal and the console write to,
// through the terminal's own writer, so its records are held to the same cap.
// What is recorded is THAT the setup ran, how, which questions it wrote, and
// the login of the first administrator's account when it made one. No other
// answer is recorded: an answer can be an address, and a record is kept for as
// long as the trail is.

import { CLI_ACTOR, CliAudit } from "../cli-audit";
import { AUDIT_ACTIONS } from "../console/audit-actions";
import type { StepId } from "./list";
import type { SetupWay } from "./state";

/** Who a browser setup is attributed to. The link is the whole credential, and
 *  whoever holds it is all that is known. */
export const BROWSER_SETUP_ACTOR = "holder of the one-time setup link (browser)";

export class SetupAudit {
  private readonly audit: CliAudit;

  constructor(dir: string, onWarn?: (message: string) => void) {
    this.audit = new CliAudit({ dir, ...(onWarn ? { onWarn } : {}) });
  }

  /** The one-time link was opened. */
  async opened(remote: string): Promise<void> {
    await this.audit.event(AUDIT_ACTIONS.fortressSetupOpened, {
      actor: BROWSER_SETUP_ACTOR,
      params: { way: "browser", remote },
      outcome: "done",
    });
  }

  /** A link that is not the one, or that was already opened, was tried. */
  async linkRefused(remote: string, attempts: number): Promise<void> {
    await this.audit.event(AUDIT_ACTIONS.fortressSetupLinkRefused, {
      actor: null,
      params: { way: "browser", remote, attempts },
      outcome: "refused",
    });
  }

  /**
   * Write the answers inside a pair of records: the intent is on disk before
   * anything is written, and the outcome after. A record that cannot be written
   * stops the setup, as it stops every other act of the terminal.
   *
   * `account` is the login of the first administrator's account when this end
   * of the setup makes it, or null.
   */
  finish<T extends { ok: boolean }>(
    way: SetupWay,
    changing: readonly StepId[],
    account: string | null,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.audit.pair(
      AUDIT_ACTIONS.fortressSetupFinished,
      {
        actor: way === "browser" ? BROWSER_SETUP_ACTOR : CLI_ACTOR,
        params: { way, changed: changing.join(",") || "nothing", ...(account ? { account } : {}) },
      },
      work,
    );
  }
}
