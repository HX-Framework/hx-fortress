// The addresses this Fortress calls, worked out from the answers.
//
// Nobody types this list. Each answer that names an outside service adds one
// line, with the reason, and the Network question of the setup shows the
// result. It is the list of what the chosen answers make this Fortress call;
// it is not yet a list the Fortress holds itself to.
//
// A LINE IS HERE ONLY WHEN THIS BUILD MAKES THE CALL. A new version is
// downloaded through the control plane in this build, so the Updates answer
// adds no line of its own: the control plane's line covers it.
//
// Free of Node: the console's pages can work the list out as a person types.

import { DEFAULT_MODEL_ADDRESS, hostOf, type SetupAnswers } from "./answers";
import { NONE } from "./list";

export interface ReachRow {
  /** A host, or a phrase when the host is not known to the setup. */
  address: string;
  /** What it is called for. */
  why: string;
  /** An https origin the setup can ask "do you answer", or null. */
  probe: string | null;
}

/** Where a Fortress that runs Postgres on its own disk downloads the database
 *  program from, the first time it starts. The host of DEFAULT_PG_BINARIES_URL:
 *  a test holds the two together. */
export const DATABASE_PROGRAM_HOST = "repo1.maven.org";

function httpsOrigin(address: string): string | null {
  const text = address.trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The list, in the order of the questions that add to it.
 *
 * `needsFiles` and `needsModel` say whether a module that is on uses the file
 * store and the model: an answer nothing uses calls nothing.
 */
export function reachOf(
  answers: SetupAnswers,
  options: { needsFiles: boolean; needsModel: boolean },
): ReachRow[] {
  const rows: ReachRow[] = [];
  const add = (address: string, why: string, probeAt: string | null = httpsOrigin(address)): void => {
    const shown = hostOf(address);
    if (shown) rows.push({ address: shown, why, probe: probeAt });
  };
  const a = answers;

  if (a.keys.store === "azure-key-vault") add(a.keys.address, "keys");
  if (a.signIn.provider === "openid-connect") add(a.signIn.issuer, "sign-in");
  if (a.data.database.store === "this-disk") add(DATABASE_PROGRAM_HOST, "database program, once");
  if (a.data.database.store === "postgres") {
    rows.push({
      address: a.data.database.address ? `the address in ${a.data.database.address}` : "your own Postgres",
      why: "database",
      probe: null,
    });
  }
  if (options.needsFiles) {
    if (a.data.files.store === "s3-compatible") add(a.data.files.address, "files");
    if (a.data.files.store === "amazon-s3") {
      add(`s3.${a.data.files.region || "us-east-1"}.amazonaws.com`, "files", null);
    }
    if (a.data.files.store === "google-cloud-storage") add("storage.googleapis.com", "files", null);
  }
  // An empty address is the default one, here as for the Fortress.
  if (options.needsModel && a.model.provider !== NONE) {
    add(a.model.address || DEFAULT_MODEL_ADDRESS, "AI model", null);
  }
  if (a.controlPlane.connect === "yes") add(a.controlPlane.address, "control plane, new versions", null);
  return rows;
}
