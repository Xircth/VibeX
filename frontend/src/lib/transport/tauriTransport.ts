import type { BackendTransport } from './BackendTransport';

/**
 * Desktop adapter. The dynamic import keeps @tauri-apps/api out of feature
 * tests and non-desktop bundles until a desktop call is actually made.
 */
export class TauriTransport implements BackendTransport {
  readonly environment = 'desktop' as const;

  async call(
    command: string,
    args?: Record<string, unknown>
  ): Promise<unknown> {
    const { tauriInvoke } = await import('@/lib/tauriApi');
    return tauriInvoke(command, args);
  }
}

export const tauriBackendTransport: BackendTransport = new TauriTransport();
