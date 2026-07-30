export type BackendEnvironment = 'desktop' | 'web' | 'remote-desktop';

/**
 * Transport boundary consumed by feature-facing API facades.
 *
 * Subscription and capability methods are added by the replay slice; command
 * calls already cross this boundary so feature tests never load Tauri.
 */
export interface BackendTransport {
  readonly environment: BackendEnvironment;
  call(command: string, args?: Record<string, unknown>): Promise<unknown>;
}
