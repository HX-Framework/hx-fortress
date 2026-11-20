// What a Secure Data Island needs to know of this HX Fortress's own settings,
// read from config.json as it is now.
//
// Two facts:
//
//   - which origin's pages may frame a Secure Data Island. One function of the
//     daemon's config decides it (`controlPlanePages`), and this file asks
//     nothing else. It answers "none" for an HX Fortress with no control
//     plane, and for one whose administrator cut the connection;
//   - the organization's name, as its setup gave it. It is shown on the
//     sign-in window's pages.
//
// OPEN OR CLOSED IS ONE QUESTION, asked in one place: `islandsOpen`. Closed
// means that no page may be framed, that this HX Fortress says nothing of
// itself to a page file, and that no route of the door signs anybody in or
// hands anything over.
//
// EVERY FAILURE READS AS CLOSED. No file, a file that cannot be read, a file
// that is not JSON, and a `cloud` or `controlPlane` key that the daemon itself
// would refuse. Only those two keys and the organization's name are read: a
// value elsewhere in the file that the daemon would refuse closes nothing
// here, because it says nothing about who may frame a page.
//
// The file is read again whenever it changed, so a setting that a person
// changes lands on a running console with no restart. A read that FAILED is
// not remembered: the next request reads again, so a failure that passes
// (too many open files, a disk that did not answer) closes the door only
// while it lasts. Each kind of failure is said once, not once per request.

import { open, type FileHandle } from "node:fs/promises";

import {
  controlPlanePages,
  parseCloudConfig,
  parseControlPlaneConfig,
  parseOrganizationConfig,
} from "../host/config";

export interface IslandSettings {
  /** The one origin whose pages may frame a Secure Data Island. Null when no
   *  page may: see `islandsOpen`. */
  pages: string | null;
  /** The organization's name, or null when the setup gave none. */
  organization: string | null;
}

/** What every unreadable state reads as. */
export const ISLANDS_CLOSED: IslandSettings = { pages: null, organization: null };

/**
 * Whether this HX Fortress shows any Secure Data Island now. THE ONE PLACE
 * THAT DECIDES IT: the frame's header, what a page file is told, and every
 * route of the door ask this, so they cannot disagree.
 */
export function islandsOpen(settings: IslandSettings): settings is IslandSettings & { pages: string } {
  return settings.pages !== null;
}

/** The error's code when it has one, such as ENOENT. Never its message, which
 *  can hold a piece of the file. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "unknown";
}

export class LiveIslandSettings {
  private last: { signature: string; value: IslandSettings } | null = null;
  /** The last thing said, so that it is said once and not at every request. */
  private said: string | null = null;

  constructor(
    private readonly configFile: string,
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly onWarn: (message: string) => void = () => {},
  ) {}

  async read(): Promise<IslandSettings> {
    // ONE OPEN FILE answers both questions: whether config.json changed, and
    // what it holds now. Asking the path twice would let the file be swapped
    // between the two answers, and the text of one file would then be
    // remembered under the other's signature.
    let file: FileHandle;
    try {
      // The daemon's own config.json, under this HX Fortress's root.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      file = await open(this.configFile, "r");
    } catch (error) {
      this.last = null;
      // No config.json: an HX Fortress that is not set up yet. The daemon says
      // so, and this door has nothing to add.
      if (codeOf(error) !== "ENOENT") this.unreadable(error);
      return ISLANDS_CLOSED;
    }
    try {
      const found = await file.stat();
      const signature = `${found.dev}:${found.ino}:${found.mtimeMs}:${found.size}`;
      if (this.last?.signature === signature) return this.last.value;
      const value = this.settingsOf(await file.readFile("utf8"));
      this.last = { signature, value };
      return value;
    } catch (error) {
      // Nothing is known of the file, so nothing is remembered about it.
      this.last = null;
      this.unreadable(error);
      return ISLANDS_CLOSED;
    } finally {
      await file.close().catch(() => {});
    }
  }

  private unreadable(error: unknown): void {
    this.say(
      `${this.configFile} could not be read (${codeOf(error)}), so no Secure Data Island is shown until it can be`,
    );
  }

  private settingsOf(text: string): IslandSettings {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return this.closed("is not JSON");
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return this.closed("is not JSON");
    const held = raw as Record<string, unknown>;

    let pages: string | null;
    try {
      pages = controlPlanePages(
        { cloud: parseCloudConfig(held.cloud), controlPlane: parseControlPlaneConfig(held.controlPlane) },
        this.env,
      );
    } catch {
      return this.closed("holds a control plane setting that is not valid");
    }

    let organization: string | null = null;
    try {
      organization = parseOrganizationConfig(held.organization)?.name ?? null;
    } catch {
      // A name that is not one is not shown. It closes nothing.
    }
    this.said = null;
    return { pages, organization };
  }

  private closed(why: string): IslandSettings {
    this.say(`${this.configFile} ${why}, so no Secure Data Island is shown until it is fixed`);
    return ISLANDS_CLOSED;
  }

  private say(message: string): void {
    if (this.said === message) return;
    this.said = message;
    this.onWarn(message);
  }
}
