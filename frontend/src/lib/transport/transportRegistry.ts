import type { BackendTransport } from './backendTransport';
import { tauriBackendTransport } from './tauriTransport';

let configuredTransport = tauriBackendTransport;
let mountedTransport:
  | {
      token: symbol;
      transport: BackendTransport;
    }
  | undefined;

export function configureBackendTransport(transport: BackendTransport): void {
  configuredTransport = transport;
}

export function getBackendTransport(): BackendTransport {
  return mountedTransport?.transport ?? configuredTransport;
}

export function mountBackendTransport(transport: BackendTransport): () => void {
  if (mountedTransport) {
    throw new Error('Only one BackendTransportProvider may be mounted');
  }
  const token = Symbol('backend-transport-provider');
  mountedTransport = { token, transport };
  return () => {
    if (mountedTransport?.token === token) {
      mountedTransport = undefined;
    }
  };
}

/// Stable indirection for exported API singletons. It resolves the selected
/// provider at call time instead of capturing the desktop adapter at import.
export const configuredBackendTransport: BackendTransport = {
  get environment() {
    return getBackendTransport().environment;
  },
  call(command, args) {
    return getBackendTransport().call(command, args);
  },
  subscribe(request) {
    const transport = getBackendTransport();
    if (!transport.subscribe) {
      throw new Error(
        `Backend transport ${transport.environment} does not support subscriptions`
      );
    }
    return transport.subscribe(request);
  },
  capabilities() {
    const transport = getBackendTransport();
    if (!transport.capabilities) {
      throw new Error(
        `Backend transport ${transport.environment} does not expose capabilities`
      );
    }
    return transport.capabilities();
  },
  listen(event, handler) {
    const transport = getBackendTransport();
    if (!transport.listen) {
      throw new Error(
        `Backend transport ${transport.environment} does not support event channels`
      );
    }
    return transport.listen(event, handler);
  },
  emit(event, payload) {
    const transport = getBackendTransport();
    if (!transport.emit) {
      throw new Error(
        `Backend transport ${transport.environment} does not support event emission`
      );
    }
    return transport.emit(event, payload);
  },
  artifactPreviewUrl(lease) {
    const transport = getBackendTransport();
    return (
      transport.artifactPreviewUrl?.(lease) ??
      `http://127.0.0.1:${lease.loopbackPort}/`
    );
  },
};
