import { tauriInvoke } from '@/lib/tauriApi';

/**
 * The call-only slice of the platform BackendTransport used by feature
 * facades today. Subscription and capability methods remain owned by the
 * transport milestone; feature code can already avoid importing Tauri.
 */
export interface BackendTransport {
  readonly environment: 'desktop' | 'web' | 'remote-desktop';
  call(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

export const tauriBackendTransport: BackendTransport = {
  environment: 'desktop',
  call: (command, args) => tauriInvoke(command, args),
};
