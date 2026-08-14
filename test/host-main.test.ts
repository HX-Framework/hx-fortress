import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  isPendingEnrollmentTrusted,
  resolvePendingEnrollmentForStartup,
  runFortressHost,
} from "../src/host/main";
import { FilePendingEnrollmentStore, type WsCloudConnectionDeps } from "../src/cloud";
import type { FortressIdentity } from "../src/protocol";
import type { ModuleRegistry } from "../src/host/module-registry";
import type { CloudConnection } from "../src/host/types";
import { fortressPaths } from "../src/host/paths";

describe("runFortressHost", () => {
  // MC-2471: the host refuses to start without an OpenAI key (used to create the
  // semantic-search embeddings). Provide a dummy so the composition test exercises
  // the real runtime wiring instead of tripping the fail-fast.
  const priorOpenAiKey = process.env.FORTRESS_OPENAI_API_KEY;
  beforeEach(() => {
    process.env.FORTRESS_OPENAI_API_KEY = "sk-test-fortress-openai-key";
  });
  afterEach(() => {
    if (priorOpenAiKey === undefined) delete process.env.FORTRESS_OPENAI_API_KEY;
    else process.env.FORTRESS_OPENAI_API_KEY = priorOpenAiKey;
  });

  test("composes the production host runtime", async () => {
    let capturedRuntime: {
      start(): Promise<void>;
      stop(): Promise<void>;
    } | null = null;
    let capturedConnection: CloudConnection | null = null;
    let capturedDeps: WsCloudConnectionDeps | null = null;

    await runFortressHost({
      root: "/tmp/fortress",
      version: "0.0.0-test",
      createConnection(dependencies) {
        capturedDeps = dependencies;
        capturedConnection = {
          state: () => "offline",
          status: () => ({
            state: "offline",
            reason: null,
            message: null,
          }),
          open: async () => {},
          close: async () => {},
          notifyIngest: () => {},
        };
        return capturedConnection;
      },
      run: async (runtime) => {
        capturedRuntime = runtime;
      },
    });

    expect(capturedRuntime).not.toBeNull();
    expect(capturedConnection).not.toBeNull();
    expect(capturedDeps).not.toBeNull();
    if (!capturedDeps) {
      throw new Error("expected capturedDeps");
    }
    const dependencies = capturedDeps as WsCloudConnectionDeps;
    // Composed per connection attempt, so the console advertisement reflects
    // ui.json as it stands at that moment rather than at boot.
    expect(typeof dependencies.identity).toBe("function");
    const identity = await (dependencies.identity as () => Promise<FortressIdentity>)();
    expect(identity).toMatchObject({
      version: "0.0.0-test",
      protocolVersion: 1,
      consoleUrl: null,
      runtimeKind: "host",
    });
    const registry = dependencies.dispatcher as ModuleRegistry;
    expect(registry.snapshot()).toEqual([
      { id: "session_vault", state: "stopped", error: null },
    ]);
  });

  describe("pending enrollment", () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), "hx-fortress-host-main-"));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    test("keeps a pending enrollment when credentials already exist", async () => {
      const paths = fortressPaths(root);
      await mkdir(path.dirname(paths.credentials), { recursive: true });
      await writeFile(
        paths.credentials,
        JSON.stringify({
          orgId: "org-1",
          fortressId: "fortress-1",
          credential: "credential-1",
        }),
      );
      await writeFile(
        paths.pendingEnrollment,
        JSON.stringify({
          token: "fresh-token",
          cloudUrl: "wss://new.let.ai/_api/hx-gateway/vault-tunnel",
        }),
      );

      const pendingEnrollment = await resolvePendingEnrollmentForStartup(
        new FilePendingEnrollmentStore(paths.pendingEnrollment),
      );

      expect(pendingEnrollment).toEqual({
        token: "fresh-token",
        cloudUrl: "wss://new.let.ai/_api/hx-gateway/vault-tunnel",
      });
      await expect(readFile(paths.pendingEnrollment, "utf8")).resolves.toContain("fresh-token");
    });
  });

  describe("pending-enrollment hijack gate (M-8)", () => {
    const enrolled = "wss://hub.let.ai/_api/hx-gateway/vault-tunnel";

    test("honors a pending enrollment on a fresh install (no saved credential)", () => {
      expect(
        isPendingEnrollmentTrusted({
          savedCredentialExists: false,
          pendingCloudUrl: "wss://attacker.example/tunnel",
          enrolledCloudUrl: null,
          allowReenroll: false,
        }),
      ).toBe(true);
    });

    test("ignores a different-origin pending enrollment once a credential is saved", () => {
      expect(
        isPendingEnrollmentTrusted({
          savedCredentialExists: true,
          pendingCloudUrl: "wss://attacker.example/tunnel",
          enrolledCloudUrl: enrolled,
          allowReenroll: false,
        }),
      ).toBe(false);
    });

    test("honors a same-origin pending enrollment for an enrolled fortress", () => {
      expect(
        isPendingEnrollmentTrusted({
          savedCredentialExists: true,
          pendingCloudUrl: "wss://hub.let.ai/some/other/path",
          enrolledCloudUrl: enrolled,
          allowReenroll: false,
        }),
      ).toBe(true);
    });

    test("FORTRESS_ALLOW_REENROLL overrides the origin check", () => {
      expect(
        isPendingEnrollmentTrusted({
          savedCredentialExists: true,
          pendingCloudUrl: "wss://attacker.example/tunnel",
          enrolledCloudUrl: enrolled,
          allowReenroll: true,
        }),
      ).toBe(true);
    });
  });
});
