import type { BackendTransport } from './backendTransport';
import { tauriBackendTransport } from './tauriTransport';

let configuredTransport = tauriBackendTransport;
const mountedTransports: Array<{
  token: symbol;
  transport: BackendTransport;
}> = [];

export function configureBackendTransport(transport: BackendTransport): void {
  configuredTransport = transport;
}

export function getBackendTransport(): BackendTransport {
  return mountedTransports.at(-1)?.transport ?? configuredTransport;
}

export function mountBackendTransport(transport: BackendTransport): () => void {
  const token = Symbol('backend-transport-provider');
  mountedTransports.push({ token, transport });
  return () => {
    const index = mountedTransports.findIndex((entry) => entry.token === token);
    if (index >= 0) {
      mountedTransports.splice(index, 1);
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
};
