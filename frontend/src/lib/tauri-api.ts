import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';

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
    console.error(`Tauri command failed: ${cmd}`, error);
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
