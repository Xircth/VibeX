import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"

export type WelcomeErrorKey =
  | "errors.unknown"
  | "errors.invalidInput"
  | "errors.notFound"
  | "errors.alreadyExists"
  | "errors.dependencyMissing"
  | "errors.databaseError"
  | "errors.ioError"
  | "errors.externalCommandFailed"
  | "errors.windowOperationFailed"
  | "errors.gitNotInstalled"
  | "errors.targetDirectoryNotEmpty"
  | "errors.repositoryNotFound"
  | "errors.networkUnavailable"
  | "errors.authenticationFailed"
  | "errors.permissionDenied"

export interface WelcomeErrorResult {
  key: WelcomeErrorKey
  detail?: string
}

export function normalizeErrorMessage(error: unknown): string {
  return toErrorMessage(error)
}

function stripClonePrefix(message: string): string {
  return message.replace(/^clone failed:\s*/i, "").trim()
}

function mapCommonCodeToKey(code: string): WelcomeErrorKey {
  switch (code) {
    case "invalid_input":
    case "configuration_missing":
    case "configuration_invalid":
      return "errors.invalidInput"
    case "not_found":
      return "errors.notFound"
    case "already_exists":
      return "errors.alreadyExists"
    case "permission_denied":
      return "errors.permissionDenied"
    case "dependency_missing":
      return "errors.dependencyMissing"
    case "network_error":
      return "errors.networkUnavailable"
    case "authentication_failed":
      return "errors.authenticationFailed"
    case "database_error":
      return "errors.databaseError"
    case "io_error":
      return "errors.ioError"
    case "external_command_failed":
      return "errors.externalCommandFailed"
    case "window_operation_failed":
      return "errors.windowOperationFailed"
    case "task_execution_failed":
      return "errors.unknown"
    default:
      return "errors.unknown"
  }
}

export function resolveWelcomeError(error: unknown): WelcomeErrorResult {
  const appError = extractAppCommandError(error)
  if (appError) {
    const key = mapCommonCodeToKey(appError.code)
    const detail =
      key === "errors.unknown" ? appError.detail || appError.message : undefined

    return detail ? { key, detail } : { key }
  }

  return {
    key: "errors.unknown",
    detail: normalizeErrorMessage(error),
  }
}

export function resolveCloneError(error: unknown): WelcomeErrorResult {
  const appError = extractAppCommandError(error)
  if (appError) {
    switch (appError.code) {
      case "dependency_missing":
        return { key: "errors.gitNotInstalled" }
      case "already_exists":
        return { key: "errors.targetDirectoryNotEmpty" }
      case "not_found":
        return { key: "errors.repositoryNotFound" }
      case "network_error":
        return { key: "errors.networkUnavailable" }
      case "authentication_failed":
        return { key: "errors.authenticationFailed" }
      case "permission_denied":
        return { key: "errors.permissionDenied" }
      default: {
        const key = mapCommonCodeToKey(appError.code)
        const detail =
          key === "errors.unknown"
            ? appError.detail || appError.message
            : undefined
        return detail ? { key, detail } : { key }
      }
    }
  }

  const rawMessage = normalizeErrorMessage(error)
  const message = stripClonePrefix(rawMessage)
  const normalized = message.toLowerCase()

  if (normalized.includes("git is not installed")) {
    return { key: "errors.gitNotInstalled" }
  }

  if (normalized.includes("already exists and is not an empty directory")) {
    return { key: "errors.targetDirectoryNotEmpty" }
  }

  if (normalized.includes("repository not found")) {
    return { key: "errors.repositoryNotFound" }
  }

  if (
    normalized.includes("could not resolve host") ||
    normalized.includes("network is unreachable") ||
    normalized.includes("connection timed out") ||
    normalized.includes("failed to connect")
  ) {
    return { key: "errors.networkUnavailable" }
  }

  if (
    normalized.includes("authentication failed") ||
    normalized.includes("could not read username") ||
    normalized.includes("permission denied (publickey)")
  ) {
    return { key: "errors.authenticationFailed" }
  }

  if (normalized.includes("permission denied")) {
    return { key: "errors.permissionDenied" }
  }

  return {
    key: "errors.unknown",
    detail: message || rawMessage || undefined,
  }
}
