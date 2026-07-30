export type {
  ApplicationCommandArgs,
  ApplicationCommandMap,
  ApplicationCommandName,
  ApplicationCommandResult,
  BackendTransport,
  BackendEnvironment,
} from './transport';
export {
  configuredBackendTransport,
  TauriTransport,
  tauriBackendTransport,
} from './transport';
export { callApplicationCommand } from './transport';

import {
  configureBackendTransport,
  getBackendTransport,
} from './transport/transportRegistry';

export { configureBackendTransport };

export function backendCall<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  return getBackendTransport().call(command, args) as Promise<T>;
}

export async function backendListen<T>(
  event: string,
  handler: (payload: T) => void
): Promise<() => void> {
  const transport = getBackendTransport();
  if (!transport.listen) {
    return () => undefined;
  }
  return transport.listen(event, handler);
}

export async function backendEmit(
  event: string,
  payload?: unknown
): Promise<void> {
  const transport = getBackendTransport();
  if (!transport.emit) {
    return;
  }
  await transport.emit(event, payload);
}
