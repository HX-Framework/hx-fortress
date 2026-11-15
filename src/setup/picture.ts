// The picture beside each page of the setup: what is being set up.
//
// HX Fortress on the organization's side, with its keys and its database; the
// few addresses it calls; and a person's browser below. Each page lights up
// its own part. This file works out WHAT the picture holds from the answers,
// as plain data. A page draws it; the terminal has no use for it.
//
// Free of Node: the console's pages import it and redraw as a person types.

import { hostOf, publicAddress, type SetupAnswers } from "./answers";
import { NONE, isCloudPlace, placeInfo, type StepId } from "./list";
import { NEW_VERSIONS_FROM } from "./reach";

export interface Picture {
  /** The caption of the organization's side: "Your Azure · East US 2". */
  band: string;
  /** Two short lines for the keys box, and two for the database box. */
  keys: [string, string];
  database: [string, string];
  /** True when the database is one the organization already runs. */
  databaseIsTheirs: boolean;
  organization: string;
  /** The titles of the modules that are on. */
  modules: string[];
  /** The outside addresses HX Fortress calls, top to bottom. */
  calls: { id: "controlPlane" | "model" | "signIn" | "releases"; caption: string; name: string }[];
  proxy: boolean;
  /** What a person's browser shows in its address bar. */
  address: string;
  /** Whether that address is served with a certificate of its own. */
  lock: boolean;
  /** How the browser reaches HX Fortress: "https", or "through your proxy". */
  via: string;
  /** What a person signs in with: a password form, or one button. */
  signIn: "local" | "provider";
}

/** The part of the picture each page lights up. */
export const PICTURE_PART: Partial<Record<StepId, string>> = {
  where: "band",
  organization: "hx-fortress",
  keys: "keys",
  address: "browser",
  signIn: "signIn",
  modules: "hx-fortress",
  data: "database",
  model: "model",
  network: "calls",
  updates: "releases",
};

/** Where new versions come from. */
export const RELEASES_HOST = "github.com";

/** The name of an identity provider, from its issuer's host. */
export function identityProviderName(issuer: string): string {
  const host = hostOf(issuer);
  if (/(^|\.)microsoftonline\.com$/.test(host)) return "Microsoft Entra ID";
  if (/(^|\.)okta\.com$/.test(host)) return "Okta";
  if (/(^|\.)accounts\.google\.com$/.test(host)) return "Google";
  return "Identity provider";
}

const ROUTE_SHORT: Readonly<Record<string, string>> = {
  "amazon-bedrock": "Bedrock",
  "google-vertex-ai": "Vertex AI",
  "microsoft-foundry": "Foundry",
};

const PROVIDER_NAME: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

const KEYS_LINES: Readonly<Record<string, [string, string]>> = {
  "azure-key-vault": ["Azure", "Key Vault"],
  "aws-secrets-manager": ["AWS Secrets", "Manager"],
  "google-secret-manager": ["Google Secret", "Manager"],
  env: ["In its", "settings"],
  file: ["A folder", "of files"],
};

export function pictureOf(
  answers: SetupAnswers,
  options: { moduleTitles: Readonly<Record<string, string>> },
): Picture {
  const a = answers;
  const place = placeInfo(a.where.place);
  const cloud = isCloudPlace(place.id);
  const region = place.regions.find((r) => r.id === a.where.region)?.name ?? a.where.region;
  const machine = hostOf(a.where.ssh.replace(/^[^@]*@/, ""));
  const band =
    place.id === "here"
      ? "This machine"
      : cloud
        ? [`Your ${place.short}`, region].filter(Boolean).join(" · ")
        : ["Your machine", machine].filter(Boolean).join(" · ");

  const store = a.data.database.store;
  const database: [string, string] =
    store === "managed" ? ["Postgres", `by ${place.short}`] : store === "existing" ? ["Postgres", "existing"] : ["Postgres", "beside it"];

  const calls: Picture["calls"] = [];
  if (a.controlPlane.connect === "yes" && a.controlPlane.connected !== "off") {
    calls.push({
      id: "controlPlane",
      caption: NEW_VERSIONS_FROM === "control-plane" ? "control plane, new versions" : "control plane",
      name: hostOf(a.controlPlane.address) || "not named yet",
    });
  }
  if (a.model.provider !== NONE) {
    const via = Object.prototype.hasOwnProperty.call(ROUTE_SHORT, a.model.route)
      ? `AI model, via ${ROUTE_SHORT[a.model.route as keyof typeof ROUTE_SHORT]}`
      : "AI model";
    calls.push({
      id: "model",
      caption: via,
      name: Object.prototype.hasOwnProperty.call(PROVIDER_NAME, a.model.provider)
        ? String(PROVIDER_NAME[a.model.provider as keyof typeof PROVIDER_NAME])
        : a.model.provider,
    });
  }
  if (a.signIn.provider === "openid-connect") {
    calls.push({ id: "signIn", caption: "sign-in", name: identityProviderName(a.signIn.issuer) });
  }
  // A line only for a call this build makes: see `NEW_VERSIONS_FROM`.
  if (NEW_VERSIONS_FROM === "project-releases") {
    calls.push({ id: "releases", caption: "new versions", name: RELEASES_HOST });
  }

  const titles = options.moduleTitles;
  const modules = Object.keys(a.modules)
    .filter((id) => a.modules[id] === true)
    .map((id) => (Object.prototype.hasOwnProperty.call(titles, id) ? String(titles[id as keyof typeof titles]) : id));

  const address = publicAddress(a);
  const behindProxy = a.address.certificate === NONE && address !== "";
  return {
    band,
    keys: Object.prototype.hasOwnProperty.call(KEYS_LINES, a.keys.store)
      ? (KEYS_LINES[a.keys.store as keyof typeof KEYS_LINES] as [string, string])
      : ["Keys", ""],
    database,
    databaseIsTheirs: store === "existing",
    organization: a.organization.name.trim(),
    modules,
    calls,
    proxy: a.network.route === "proxy",
    // With no address, HX Fortress on its own machine answers there only. An
    // install has simply not been given its address yet.
    address: address || (place.id === "here" ? "this machine only" : "no address yet"),
    lock: address !== "" && !behindProxy,
    via: behindProxy ? "through your proxy" : address || place.id !== "here" ? "https" : "on this machine",
    signIn: a.signIn.provider === "openid-connect" ? "provider" : "local",
  };
}
