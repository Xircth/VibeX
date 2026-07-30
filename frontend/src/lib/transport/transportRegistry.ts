import type { BackendTransport } from './backendTransport';
import { tauriBackendTransport } from './tauriTransport';

let configuredTransport = tauriBackendTransport;

export function configureBackendTransport(transport: BackendTransport): void {
  configuredTransport = transport;
}

export function getBackendTransport(): BackendTransport {
  return configuredTransport;
}
