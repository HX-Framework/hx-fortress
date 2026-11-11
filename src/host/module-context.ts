// What the host hands a module: its secrets, its audit port, its state and its
// way out to the network — each one narrowed to what the module's manifest
// declares.
//
// The manifest is what the module declares in the open: it is compiled into the
// binary, `hx-fortress modules list` prints it, and the console lists it under
// data paths. This file is where the host holds the module to it: a secret name
// the manifest does not list is refused, and so is a host the manifest does not
// list.
//
// WHAT THIS IS NOT. A module is code inside this process, so these ports do not
// confine it: nothing in the process stops code from importing `node:net`. Two
// other things do the confining. A lint rule over `src/modules/` fails the
// build when a module reaches the network any other way (see eslint.config.js).
// And module code only ever arrives inside the Fortress binary, never from the
// relay. Who made the binary is therefore the boundary against code written to
// get out; SECURITY.md says how far a release of the binary is verified today.

// Every path this file opens is a module's own state directory, and the file
// name is a state key that passed the key pattern: one segment, never a path.
/* eslint-disable security/detect-non-literal-fs-filename */

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { AUDIT_ACTIONS } from "../console/audit-actions";
import type { SecretProvider } from "../secrets/types";
import { bareHost, isPrivateAddressLiteral } from "./address-literal";
import type { ModuleAudit } from "./module-audit";
import {
  egressAllows,
  EgressRefused,
  MODULE_ACTION_PATTERN,
  SecretNotDeclared,
  STATE_KEY_PATTERN,
  type EgressRule,
  type ModuleContextV2,
  type ModuleManifest,
  type ModuleStatePort,
} from "./module-contract";
import type { fortressPaths } from "./paths";
import { writePrivateJson } from "./private-json";
import type { EnrolledIdentity, ScopedLogger } from "./types";

type FortressPaths = ReturnType<typeof fortressPaths>;

/** Largest value one state key may hold, as JSON. State is bookkeeping — a
 *  cursor, a deployment id, a version — not a place to keep data. */
export const MODULE_STATE_MAX_BYTES = 1024 * 1024;

/**
 * The customer's secret store, built the first time something needs it.
 *
 * Which store this fortress uses is a setting, and building one reads that
 * setting. Doing it on first use means a fortress whose modules read no secret
 * never fails over a store it never needed, and a setting that was wrong at
 * boot is read again the next time a module asks.
 *
 * `kind` is the store's kind once it has been built. Until then, and while the
 * setting cannot be read, it is `env`: the kind a fortress has when nothing is
 * set. `store()` is the way to ask and be told when the answer is not known.
 */
export class DeferredSecrets implements SecretProvider {
  private built: SecretProvider | null = null;

  constructor(private readonly build: () => Promise<SecretProvider>) {}

  get kind(): SecretProvider["kind"] {
    return this.built?.kind ?? "env";
  }

  /** The store itself. Rejects while the secrets setting is one this build
   *  cannot read; the next call tries again. */
  async store(): Promise<SecretProvider> {
    this.built = await this.build();
    return this.built;
  }

  async get(name: string): Promise<string> {
    return (await this.store()).get(name);
  }

  async has(name: string): Promise<boolean> {
    return (await this.store()).has(name);
  }
}

export interface ModuleContextDeps {
  paths: FortressPaths;
  logger: (moduleId: string) => ScopedLogger;
  identity: () => EnrolledIdentity | null;
  secrets: SecretProvider;
  audit: ModuleAudit;
  fetchImpl?: typeof fetch;
}

/** The context for one module, built from its manifest. */
export function createModuleContext(
  manifest: ModuleManifest,
  deps: ModuleContextDeps,
): ModuleContextV2 {
  const moduleId = manifest.id;
  const declaredSecrets = new Set(manifest.secrets);
  const doFetch = deps.fetchImpl ?? fetch;

  const refuseSecret = (): never => {
    void deps.audit.refused(
      AUDIT_ACTIONS.moduleRefused,
      { module: moduleId, rule: "secret_not_declared" },
      null,
    );
    throw new SecretNotDeclared(moduleId, manifest.secrets);
  };

  const secrets: SecretProvider = {
    get kind(): SecretProvider["kind"] {
      return deps.secrets.kind;
    },
    // `async`, so a refusal is a rejected promise like every other failure of
    // these two, and never a throw out of the call itself.
    async get(name: string): Promise<string> {
      if (!declaredSecrets.has(name)) refuseSecret();
      return deps.secrets.get(name);
    },
    async has(name: string): Promise<boolean> {
      if (!declaredSecrets.has(name)) refuseSecret();
      return deps.secrets.has(name);
    },
  };

  const refuseEgress = (rule: EgressRule): never => {
    void deps.audit.refused(AUDIT_ACTIONS.moduleRefused, { module: moduleId, rule }, null);
    throw new EgressRefused(moduleId, rule);
  };

  return {
    moduleId,
    logger: deps.logger(moduleId),
    // Read when asked, not when the context was built: a module initialized
    // before enrollment completes must not keep answering "not enrolled".
    get fortressIdentity(): EnrolledIdentity | null {
      return deps.identity();
    },
    secrets,
    audit: {
      record(action: string, detail: Record<string, string | number | boolean>): void {
        if (action.length > 64 || !MODULE_ACTION_PATTERN.test(action)) {
          throw new TypeError("a module's audit action must be lower-case words joined by dots");
        }
        void deps.audit.event(`${AUDIT_ACTIONS.modulePrefix}${moduleId}.${action}`, {
          params: detail,
          outcome: "done",
        });
      },
    },
    state: createModuleState(deps.paths.moduleState(moduleId)),
    async fetch(url: string, init?: RequestInit): Promise<Response> {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        return refuseEgress("egress_malformed");
      }
      if (target.protocol !== "https:") refuseEgress("egress_not_https");
      if (target.username || target.password) refuseEgress("egress_malformed");
      const host = bareHost(target.hostname);
      if (!egressAllows(manifest.egress, host)) refuseEgress("egress_not_declared");
      // A host written as an address in a private range is refused even when a
      // manifest lists it. A NAME is not checked this way: the manifest is the
      // control for names, and what a name resolves to is not looked at.
      if (isPrivateAddressLiteral(host)) refuseEgress("egress_private_address");
      // Only these four things of `init` are passed on. The runtime's `fetch`
      // takes more (a proxy, a Unix socket, TLS settings), and each of those is
      // a way to send the request somewhere the checks above never saw.
      const passed: RequestInit = {
        ...(init?.method !== undefined ? { method: init.method } : {}),
        ...(init?.headers !== undefined ? { headers: init.headers } : {}),
        ...(init?.body !== undefined ? { body: init.body } : {}),
        ...(init?.signal !== undefined ? { signal: init.signal } : {}),
        // A redirect is the other side choosing the next host. Following it
        // could reach a host the manifest does not list, so a redirect is an
        // error unless the module asked to see the redirect itself.
        redirect: init?.redirect === "manual" ? "manual" : "error",
      };
      return doFetch(target, passed);
    },
  };
}

/** A module's state: one 0600 JSON file per key, under the fortress root. */
export function createModuleState(dir: string): ModuleStatePort {
  const fileFor = (key: string): string => {
    if (!STATE_KEY_PATTERN.test(key)) {
      throw new TypeError("a state key is 1 to 64 characters of a-z, 0-9, _ and -");
    }
    return path.join(dir, `${key}.json`);
  };
  return {
    async read<T>(key: string): Promise<T | null> {
      const file = fileFor(key);
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      return (JSON.parse(text) as { value: T }).value;
    },
    async write<T>(key: string, value: T): Promise<void> {
      const file = fileFor(key);
      const body = JSON.stringify({ value });
      if (Buffer.byteLength(body) > MODULE_STATE_MAX_BYTES) {
        throw new RangeError(`a state value may be at most ${MODULE_STATE_MAX_BYTES} bytes of JSON`);
      }
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writePrivateJson(file, { value });
    },
  };
}
