// `--connect <address>/i/<id>`: the control plane an HX Fortress connects to,
// and the one-time install id that connects it.
//
// A control plane writes this value into the install command it shows. The id
// works once, for a short time, for one organization there. HX Fortress
// presents it the first time it connects, and from then on holds a credential
// of its own. Nobody is asked whether to connect: giving the value is the
// answer.
//
// THE ID IS A SECRET UNTIL IT IS SPENT. It is never printed, never written to
// a settings file, and never repeated in a refusal.

import { pagesOrigin } from "../host/config";
import type { Connect } from "./run";

/** How the value is written, as a refusal says it. */
export const CONNECT_SHAPE = "<address>/i/<id>";

const SHAPE = /^(?:https:\/\/)?([A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})(?::\d{1,5})?)\/i\/([A-Za-z0-9][A-Za-z0-9_-]{3,127})$/;

export type ParsedConnect = { ok: true; connect: Connect } | { ok: false; reason: string };

/**
 * `pages` is what `--pages <origin>` gave: where the control plane shows its
 * pages to people. A control plane writes it into the command beside
 * `--connect`. It is given with `--connect`, or not at all.
 */
export function parseConnect(value: string | null | undefined, pages?: string | null): ParsedConnect {
  const match = SHAPE.exec((value ?? "").trim());
  if (!match) {
    return {
      ok: false,
      reason: `--connect needs a control plane's address and a one-time install id, written as ${CONNECT_SHAPE}`,
    };
  }
  const shown = (pages ?? "").trim();
  if (shown && pagesOrigin(shown) === null) {
    return { ok: false, reason: "--pages needs one origin, written as https://host, with no path" };
  }
  return {
    ok: true,
    connect: { address: match[1] as string, id: match[2] as string, ...(shown ? { pages: pagesOrigin(shown) as string } : {}) },
  };
}

/** The shape of a one-time install id, when it is given by itself. */
export function isInstallId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{3,127}$/.test(value);
}
