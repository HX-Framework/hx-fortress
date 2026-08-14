import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface CloudCredential {
  orgId: string;
  fortressId: string;
  credential: string;
}

export interface CredentialStore {
  load(): Promise<CloudCredential | null>;
  save(credential: CloudCredential): Promise<void>;
}

export class FileCredentialStore implements CredentialStore {
  constructor(private readonly credentialPath: string) {}

  async load(): Promise<CloudCredential | null> {
    let contents: string;
    try {
      contents = await readFile(this.credentialPath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw invalidCredentials("unable to read credentials.json");
    }

    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      throw invalidCredentials("malformed JSON");
    }

    return parseCredential(value);
  }

  async save(credential: CloudCredential): Promise<void> {
    const value = parseCredential(credential);
    await mkdir(path.dirname(this.credentialPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.credentialPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.credentialPath);
  }
}

function parseCredential(value: unknown): CloudCredential {
  if (!isRecord(value)) throw invalidCredentials("root must be an object");
  const orgId = requireNonEmptyString(value.orgId, "orgId");
  const fortressId = requireNonEmptyString(value.fortressId, "fortressId");
  const credential = requireNonEmptyString(value.credential, "credential");
  return { orgId, fortressId, credential };
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidCredentials(`${field} must be a non-empty string`);
  }
  return value;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidCredentials(reason: string): Error {
  return new Error(`Invalid Fortress credentials: ${reason}`);
}

// ── Pending enrollment ────────────────────────────────────────────────────────

/** A not-yet-consumed enrollment token left by the wizard. Fortress reads this
 *  once on startup to perform the first-run enroll handshake, then clears it. */
export interface PendingEnrollment {
  token: string;
  /** WebSocket URL of the let.ai hub — written by the wizard so Fortress can
   *  write/update config.json before connecting. */
  cloudUrl: string;
}

export class FilePendingEnrollmentStore {
  constructor(private readonly enrollmentPath: string) {}

  async load(): Promise<PendingEnrollment | null> {
    let contents: string;
    try {
      contents = await readFile(this.enrollmentPath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    const value = JSON.parse(contents) as unknown;
    if (!isRecord(value)) return null;
    const token = value.token;
    const cloudUrl = value.cloudUrl;
    if (typeof token !== "string" || token.length === 0) return null;
    if (typeof cloudUrl !== "string" || cloudUrl.length === 0) return null;
    return { token, cloudUrl };
  }

  async save(enrollment: PendingEnrollment): Promise<void> {
    await mkdir(path.dirname(this.enrollmentPath), { recursive: true, mode: 0o700 });
    const tmp = `${this.enrollmentPath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(enrollment, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.enrollmentPath);
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.enrollmentPath);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}
