// The addresses HX Fortress calls, worked out from the answers.
//
// Nobody types this list. Each answer that names an outside service adds one
// line, with the reason, and the Network question of the setup shows the
// result. It is the list of what the chosen answers make HX Fortress call; it
// is not yet a list HX Fortress holds itself to.
//
// A LINE IS HERE ONLY WHEN THIS BUILD MAKES THE CALL. A new version comes from
// the project's own releases, or from an address the organization names, and
// never through a control plane: so the Updates answer has a line of its own,
// and the control plane's line is for the connection alone.
//
// Free of Node: the console's pages can work the list out as a person types.

import {
  DEFAULT_MODEL_ADDRESS,
  hostOf,
  UPDATES_FROM_OWN,
  UPDATES_FROM_UNREADABLE,
  type SetupAnswers,
} from "./answers";
import { NONE, isCloudPlace, placeInfo } from "./list";

export interface ReachRow {
  /** A host, or a phrase when the host is not known to the setup. */
  address: string;
  /** What it is called for. */
  why: string;
  /** An https origin the setup can ask "do you answer", or null. */
  probe: string | null;
}

/**
 * Whether HX Fortress holds itself to this list: it calls these addresses and
 * refuses every other. This build does not yet. The list is what the chosen
 * answers make it call, shown so that an organization can set its own
 * firewall from it. A page says "and no other" only while this is true.
 */
export const REACH_IS_HELD = false;

/** The words over the list: how many addresses, and what the number means. */
export function reachLabel(count: number): string {
  const addresses = `${count} ${count === 1 ? "address" : "addresses"}`;
  return REACH_IS_HELD ? `${addresses}, and no other` : addresses;
}

/** Where the project's releases are. */
export const PROJECT_RELEASES = "github.com/HX-Framework/hx-fortress";

/** The host that is asked for a release of the project. It sends the request
 *  on to the hosts its files are kept at. The host of PROJECT_RELEASES_URL: a
 *  test holds the two together. */
export const RELEASES_HOST = "github.com";

/** What the Network list says for those other hosts: which they are is
 *  GitHub's to decide, and a firewall has to let them through as well. */
export const RELEASES_FILES_AT = "the hosts GitHub serves release files from";

/** What the lists say in place of a host when this host's update settings
 *  cannot be understood. Never the project's releases: the settings may have
 *  turned away from them. Letters and spaces only: the list of hosts shows a
 *  phrase as it is only when it is plain words (`describedAs`). */
export const NEW_VERSIONS_UNREADABLE = "not known because the update settings of this host cannot be read";

/** The same, for the box of the picture beside the pages. A box holds a
 *  host's name, so it has room for two words: the Updates page and the
 *  Network list beside it say why. */
export const NEW_VERSIONS_NOT_KNOWN = "not known";

/** The host new versions come from, for these answers: the project's
 *  releases, or the address the organization names. With update settings
 *  that cannot be read it is no host: the words that it is not known. */
export function newVersionsHost(answers: SetupAnswers): string {
  if (answers.updates.from === UPDATES_FROM_UNREADABLE) return NEW_VERSIONS_NOT_KNOWN;
  return answers.updates.from === UPDATES_FROM_OWN ? hostOf(answers.updates.address) : RELEASES_HOST;
}

/** Where an HX Fortress that runs Postgres on its own disk downloads the
 *  database program from, the first time it starts. The host of
 *  DEFAULT_PG_BINARIES_URL: a test holds the two together. */
export const DATABASE_PROGRAM_HOST = "repo1.maven.org";

/** The host each model provider answers at when it is reached directly. */
export const MODEL_HOSTS: Readonly<Record<string, string>> = {
  anthropic: "api.anthropic.com",
  openai: hostOfDefault(),
  google: "generativelanguage.googleapis.com",
};

function hostOfDefault(): string {
  return hostOf(DEFAULT_MODEL_ADDRESS);
}

/** The host the model is asked at, for these answers. Empty when it has none. */
export function modelHost(answers: SetupAnswers): string {
  const m = answers.model;
  if (m.provider === NONE) return "";
  if (m.route === "amazon-bedrock") return `bedrock-runtime.${m.region || "region"}.amazonaws.com`;
  if (m.route === "google-vertex-ai") return `${m.region || "region"}-aiplatform.googleapis.com`;
  if (m.route === "microsoft-foundry") return hostOf(m.address);
  // An address of the organization's own, where a settings file gives one.
  if (m.address) return hostOf(m.address);
  return Object.prototype.hasOwnProperty.call(MODEL_HOSTS, m.provider)
    ? String(MODEL_HOSTS[m.provider as keyof typeof MODEL_HOSTS])
    : "";
}

/** The host of the chosen key store, when it is an outside service. */
export function keysHost(answers: SetupAnswers): string {
  const k = answers.keys;
  if (k.store === "azure-key-vault") return k.address ? hostOf(k.address) : k.vault ? `${k.vault}.vault.azure.net` : "";
  if (k.store === "aws-secrets-manager") {
    return `secretsmanager.${k.region || answers.where.region || "region"}.amazonaws.com`;
  }
  if (k.store === "google-secret-manager") return "secretmanager.googleapis.com";
  return "";
}

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
 * store and the model. A file store nothing uses calls nothing. A model is on
 * the list whenever one is chosen: the organization chose where its data may
 * go, whether or not a module asks it today.
 */
export function reachOf(
  answers: SetupAnswers,
  options: { needsFiles: boolean; needsModel?: boolean },
): ReachRow[] {
  const rows: ReachRow[] = [];
  const add = (address: string, why: string, probeAt: string | null = httpsOrigin(address)): void => {
    const shown = hostOf(address);
    if (shown) rows.push({ address: shown, why, probe: probeAt });
  };
  const a = answers;
  const place = placeInfo(a.where.place);

  const keys = keysHost(a);
  if (keys) add(keys, "keys", a.keys.store === "azure-key-vault" && a.keys.address ? httpsOrigin(a.keys.address) : null);
  if (a.data.database.store === "managed") {
    rows.push({ address: `the ${place.postgres ?? "managed Postgres"} that is made`, why: "database", probe: null });
  }
  if (a.data.database.store === "beside" && a.where.place === "here") {
    add(DATABASE_PROGRAM_HOST, "database program, once");
  }
  if (a.data.database.store === "existing") {
    rows.push({
      address: a.data.database.address ? `the address in ${a.data.database.address}` : "an existing Postgres",
      why: "database",
      probe: null,
    });
  }
  if (options.needsFiles) {
    if (a.data.files.store === "s3-compatible") add(a.data.files.address, "files");
    if (a.data.files.store === "amazon-s3") {
      // The bucket's own host, which is how the bucket is addressed.
      const region = a.data.files.region || a.where.region || "us-east-1";
      add(`${a.data.files.bucket ? `${a.data.files.bucket}.` : ""}s3.${region}.amazonaws.com`, "files", null);
    }
    if (a.data.files.store === "google-cloud-storage") add("storage.googleapis.com", "files", null);
    if (a.data.files.store === "azure-blob" && isCloudPlace(a.where.place)) {
      rows.push({ address: "the Azure Blob Storage account that is made", why: "files", probe: null });
    }
  }
  if (a.signIn.provider === "openid-connect") {
    add(a.signIn.issuer, "sign-in");
    // A provider says where its keys and its tokens are, and that may be
    // another host than the issuer's. Which one is known only once it is asked.
    if (hostOf(a.signIn.issuer)) {
      rows.push({ address: "the addresses this provider names for its keys and tokens", why: "sign-in", probe: null });
    }
  }
  const model = modelHost(a);
  if (model) add(model, "AI model", null);
  if (a.auditTrail.copyTo === "syslog" || a.auditTrail.copyTo === "webhook") {
    add(a.auditTrail.copyAddress, "audit trail copy", null);
  }
  // New versions, and the search extension of a Postgres on HX Fortress's own
  // disk: both are files of a release, so both come from the same place.
  if (a.updates.from === UPDATES_FROM_OWN) {
    add(a.updates.address, "new versions");
  } else if (a.updates.from === UPDATES_FROM_UNREADABLE) {
    rows.push({ address: NEW_VERSIONS_UNREADABLE, why: "new versions", probe: null });
  } else {
    add(RELEASES_HOST, "new versions");
    rows.push({ address: RELEASES_FILES_AT, why: "new versions", probe: null });
  }
  if (a.controlPlane.connect === "yes" && a.controlPlane.connected !== "off") {
    add(a.controlPlane.address, "control plane", null);
  }
  return rows;
}
