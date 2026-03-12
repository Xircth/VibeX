import { getVersion } from "@tauri-apps/api/app"
import { relaunch } from "@tauri-apps/plugin-process"
import { check, type Update } from "@tauri-apps/plugin-updater"

export interface AppUpdateCheckResult {
  currentVersion: string
  update: Update | null
}

export type AppUpdateErrorKind =
  | "source_unreachable"
  | "network"
  | "download_failed"
  | "install_failed"
  | "unknown"

export interface AppUpdateErrorInfo {
  kind: AppUpdateErrorKind
  rawMessage: string
}

export async function getCurrentAppVersion(): Promise<string> {
  return getVersion()
}

export async function checkAppUpdate(): Promise<AppUpdateCheckResult> {
  const [currentVersion, update] = await Promise.all([getVersion(), check()])
  return { currentVersion, update }
}

export async function installAppUpdate(update: Update): Promise<void> {
  await update.downloadAndInstall()
}

export async function relaunchApp(): Promise<void> {
  await relaunch()
}

export async function closeAppUpdate(update: Update): Promise<void> {
  await update.close()
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function normalizeAppUpdateError(error: unknown): AppUpdateErrorInfo {
  const rawMessage = toErrorMessage(error)
  const normalized = rawMessage.toLowerCase()

  if (
    normalized.includes("latest.json") ||
    normalized.includes("/releases/latest/download/")
  ) {
    return { kind: "source_unreachable", rawMessage }
  }

  if (
    normalized.includes("error sending request for url") ||
    normalized.includes("failed to send request") ||
    normalized.includes("network") ||
    normalized.includes("timed out") ||
    normalized.includes("dns") ||
    normalized.includes("connection refused")
  ) {
    return { kind: "network", rawMessage }
  }

  if (
    normalized.includes("download") ||
    normalized.includes("checksum") ||
    normalized.includes("content-length")
  ) {
    return { kind: "download_failed", rawMessage }
  }

  if (
    normalized.includes("install") ||
    normalized.includes("installer") ||
    normalized.includes("permission denied")
  ) {
    return { kind: "install_failed", rawMessage }
  }

  return { kind: "unknown", rawMessage }
}
