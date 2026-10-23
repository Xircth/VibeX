import { backendListen } from '@/lib/backendTransport';
import { getBackendTransport } from '@/lib/transport';

export const COLLABORATION_SPACE_CHANGED_EVENT =
  'vibex://collaboration-space-changed' as const;

export async function collaborationCall<T>(
  capability: 'collaboration' | 'workspace',
  operation: string,
  input: Record<string, unknown> = {}
): Promise<T> {
  return getBackendTransport().call('collaboration_call', {
    capability,
    operation,
    input,
  }) as Promise<T>;
}

export function listenCollaborationSpaceChanged(
  handler: (payload: unknown) => void
): Promise<() => void> {
  return backendListen(COLLABORATION_SPACE_CHANGED_EVENT, handler);
}

export async function currentWindowLabel(): Promise<string> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow().label?.trim() ?? '';
  } catch {
    return '';
  }
}
