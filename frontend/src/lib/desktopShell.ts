import type { DesktopShellCommand } from 'shared/hostCommands';

import type { BackendEnvironment } from '@/lib/transport/backendTransport';
import { useBackendTransport } from '@/lib/transport/BackendTransportProvider';
import { getBackendTransport } from '@/lib/transport/transportRegistry';

export class DesktopCapabilityError extends Error {
  readonly code = 'capability_unavailable';

  constructor(command: string) {
    super(`Desktop ability ${command} is not available`);
    this.name = 'DesktopCapabilityError';
  }
}

export function isLocalDesktopHost(
  environment: BackendEnvironment = getBackendTransport().environment
): boolean {
  return environment === 'desktop';
}

export function isTauriClient(
  environment: BackendEnvironment = getBackendTransport().environment
): boolean {
  return environment === 'desktop' || environment === 'remote-desktop';
}

export function useLocalDesktopHost(): boolean {
  return isLocalDesktopHost(useBackendTransport().environment);
}

export function useTauriClient(): boolean {
  return isTauriClient(useBackendTransport().environment);
}

export async function desktopShellCall<T>(
  command: DesktopShellCommand,
  args?: Record<string, unknown>
): Promise<T> {
  if (!isTauriClient()) {
    throw new DesktopCapabilityError(command);
  }
  const { tauriInvoke } = await import('@/lib/tauriApi');
  return tauriInvoke<T>(command, args);
}
