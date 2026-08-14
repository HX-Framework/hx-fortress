import { expect, test } from "bun:test";
import { acquireEnrollmentKey } from "../src/modules/session-vault/acquire-key";

const base = {
  cloudUrl: "wss://beta.let.ai/_api/hx-gateway/vault-tunnel",
  log: () => {},
};

test("Y path returns the polled token", async () => {
  const token = await acquireEnrollmentKey({
    ...base,
    deps: {
      confirm: async () => true,
      requestCode: async () => ({
        userCode: "AAAA-BBBB",
        deviceCode: "dvc_x",
        verificationUriComplete: "https://x",
        interval: 1,
        expiresAt: "",
      }),
      poll: async () => ({ kind: "ready", token: "vlt_good" }),
      openBrowser: async () => {},
      password: async () => "unused",
      now: () => 0,
      sleep: async () => {},
    },
  });
  expect(token).toBe("vlt_good");
});

test("multiple_orgs falls back to masked paste", async () => {
  const token = await acquireEnrollmentKey({
    ...base,
    deps: {
      confirm: async () => true,
      requestCode: async () => ({
        userCode: "AAAA-BBBB",
        deviceCode: "dvc_x",
        verificationUriComplete: "https://x",
        interval: 1,
        expiresAt: "",
      }),
      poll: async () => ({ kind: "multiple_orgs" }),
      openBrowser: async () => {},
      password: async () => "vlt_pasted",
      now: () => 0,
      sleep: async () => {},
    },
  });
  expect(token).toBe("vlt_pasted");
});

test("unavailable:not_enabled aborts with guidance (no paste)", async () => {
  await expect(
    acquireEnrollmentKey({
      ...base,
      deps: {
        confirm: async () => true,
        requestCode: async () => ({
          userCode: "AAAA-BBBB",
          deviceCode: "dvc_x",
          verificationUriComplete: "https://x",
          interval: 1,
          expiresAt: "",
        }),
        poll: async () => ({ kind: "unavailable", reason: "not_enabled" }),
        openBrowser: async () => {},
        password: async () => "vlt_x",
        now: () => 0,
        sleep: async () => {},
      },
    }),
  ).rejects.toThrow(/enable fortress/i);
});

test("n path prompts masked paste and validates vlt_ prefix", async () => {
  let asked = 0;
  const token = await acquireEnrollmentKey({
    ...base,
    deps: {
      confirm: async () => false,
      requestCode: async () => {
        throw new Error("should not be called");
      },
      poll: async () => {
        throw new Error("should not be called");
      },
      openBrowser: async () => {},
      password: async () => (asked++ === 0 ? "not-a-key" : "vlt_ok"),
      now: () => 0,
      sleep: async () => {},
    },
  });
  expect(token).toBe("vlt_ok");
  expect(asked).toBe(2);
});
