export type { BackendTransport, BackendEnvironment } from './transport';
export { TauriTransport, tauriBackendTransport } from './transport';

import { tauriBackendTransport } from './transport';

export function backendCall<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  return tauriBackendTransport.call(command, args) as Promise<T>;
}

export async function backendListen<T>(
  event: string,
  handler: (payload: T) => void
): Promise<() => void> {
  const { tauriListen } = await import('./tauriApi');
  return tauriListen(event, handler);
}
