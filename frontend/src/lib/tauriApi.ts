import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';

function getErrorField(
  error: unknown,
  key: 'message' | 'name'
): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    key in error &&
    typeof (error as Record<string, unknown>)[key] === 'string'
  ) {
    return (error as Record<string, string>)[key];
  }

  return '';
}

function isExpectedBinaryTextReadError(cmd: string, error: unknown) {
  if (cmd !== 'read_file_content' && cmd !== 'get_file_at_head') {
    return false;
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : getErrorField(error, 'message');
  const normalized = message.toLowerCase();

  return (
    normalized.includes('binary file cannot be opened as text') ||
    normalized.includes('valid utf-8')
  );
}

function isExpectedAttachTerminalNotFoundError(cmd: string, error: unknown) {
  if (cmd !== 'attach_terminal') {
    return false;
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : getErrorField(error, 'message');
  const normalized = message.toLowerCase();

  return normalized.includes('terminal') && normalized.includes('not found');
}

function isExpectedRepoRemoteConfigError(cmd: string, error: unknown) {
  if (cmd !== 'list_repo_issues' && cmd !== 'list_open_prs') {
    return false;
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : getErrorField(error, 'message');
  const normalized = message.toLowerCase();

  return (
    normalized.includes('invalid repository') &&
    normalized.includes('no remotes configured')
  );
}

export function isCanceledError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : getErrorField(error, 'message');
  const name = error instanceof Error ? error.name : getErrorField(error, 'name');
  const normalized = `${name} ${message}`.toLowerCase();

  return (
    normalized.includes('canceled') || normalized.includes('cancelled')
  );
}

/**
 * Wrapper around Tauri invoke with unified error handling.
 */
export async function tauriInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (error) {
    if (
      !isCanceledError(error) &&
      !isExpectedBinaryTextReadError(cmd, error) &&
      !isExpectedAttachTerminalNotFoundError(cmd, error) &&
      !isExpectedRepoRemoteConfigError(cmd, error)
    ) {
      console.error(`Tauri command failed: ${cmd}`, error);
    }
    throw error;
  }
}

/**
 * Wrapper around Tauri event listener that returns an unsubscribe function.
 */
export async function tauriListen<T>(
  event: string,
  handler: (payload: T) => void
): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload));
}

/**
 * Wrapper around Tauri event emit.
 */
export async function tauriEmit(
  event: string,
  payload?: unknown
): Promise<void> {
  await emit(event, payload);
}

/**
 * Health check to verify the Tauri IPC communication channel.
 */
export async function healthCheck(): Promise<string> {
  return tauriInvoke<string>('health_check');
}
