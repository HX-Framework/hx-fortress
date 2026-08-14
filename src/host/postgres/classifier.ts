import { existsSync } from "node:fs";

export type ZonkyClassifier =
  | "darwin-arm64v8"
  | "darwin-amd64"
  | "linux-amd64"
  | "linux-amd64-alpine"
  | "linux-arm64v8";

export function detectMusl(): boolean {
  return existsSync("/etc/alpine-release");
}

export function resolveZonkyClassifier(
  platform: NodeJS.Platform,
  arch: string,
  isMusl: boolean,
): ZonkyClassifier {
  if (platform === "win32") {
    throw new Error("Windows is not supported by hx-fortress embedded Postgres");
  }
  if (platform === "darwin") {
    if (arch === "arm64") return "darwin-arm64v8";
    if (arch === "x64") return "darwin-amd64";
  }
  if (platform === "linux") {
    if (arch === "x64") return isMusl ? "linux-amd64-alpine" : "linux-amd64";
    if (arch === "arm64") return "linux-arm64v8";
  }
  throw new Error(`unsupported platform/arch for embedded Postgres: ${platform}/${arch}`);
}
