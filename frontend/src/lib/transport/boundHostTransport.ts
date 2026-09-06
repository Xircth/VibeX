import { HOST_COMMANDS } from 'shared/hostCommands';

import type {
  BackendTransport,
  RemoteEvent,
  ServerCapabilities,
  SubscriptionRequest,
} from './backendTransport';
import type { RemoteDesktopTransport } from './remoteDesktopTransport';
import { tauriBackendTransport } from './tauriTransport';

const HOST_COMMAND_SET = new Set<string>(HOST_COMMANDS);

const HOST_PUSH_EVENT_PREFIXES = [
  'conversation-events',
  'workspace-sessions-changed',
  'agent-management-event',
  'agent-management-snapshot-invalidated',
  'agent-management-discovery-progress',
  'agent-terminal-events',
  'desktop-session-attention',
  'file-tree-stream',
  'projects-stream',
  'project-workspaces-stream',
  'execution-processes-stream',
  'diff-stream',
  'conversation-stream',
  'scratch-stream',
  'slash-commands-stream',
  'log-stream',
  'vibex://settings-file-changed',
  'theme-changed',
  'log-settings://changed',
  'logs://appended',
  'local-history-import-progress',
  'local-history-scan-progress',
  'agent-events',
  'terminal-output',
  'plugin-contributions-changed',
  'provider-bind-confirm',
] as const;

function isHostPushEvent(event: string): boolean {
  return HOST_PUSH_EVENT_PREFIXES.some(
    (prefix) => event === prefix || event.startsWith(`${prefix}:`)
  );
}

/**
 * App-shell transport: Host product commands go to the connected Server,
 * desktop chrome stays on the local Tauri process.
 *
 * `environment` is the Host data plane. The process is still Tauri; chrome
 * that needs the local window should use `isTauriRuntime()`, not this flag.
 */
export class BoundHostTransport implements BackendTransport {
  readonly environment = 'remote-desktop' as const;

  constructor(private readonly remote: RemoteDesktopTransport) {}

  call(
    command: string,
    args?: Record<string, unknown>,
    options?: { operationId?: string }
  ): Promise<unknown> {
    if (HOST_COMMAND_SET.has(command)) {
      return this.remote.call(command, args, options);
    }
    return tauriBackendTransport.call(command, args, options);
  }

  stream<T>(
    command: string,
    args: Record<string, unknown>,
    onMessage: (message: unknown) => void
  ): Promise<T> {
    if (HOST_COMMAND_SET.has(command) && this.remote.stream) {
      return this.remote.stream(command, args, onMessage);
    }
    if (!tauriBackendTransport.stream) {
      return this.call(command, args) as Promise<T>;
    }
    return tauriBackendTransport.stream(command, args, onMessage);
  }

  capabilities(): Promise<ServerCapabilities> {
    return this.remote.capabilities();
  }

  async listen<T>(
    event: string,
    handler: (payload: T) => void
  ): Promise<() => void> {
    if (isHostPushEvent(event)) {
      return this.remote.listen(event, handler);
    }
    if (!tauriBackendTransport.listen) {
      return () => undefined;
    }
    return tauriBackendTransport.listen(event, handler);
  }

  subscribe(request: SubscriptionRequest): AsyncIterable<RemoteEvent> {
    return this.remote.subscribe(request);
  }

  artifactPreviewUrl(lease: {
    leaseId: string;
    capabilityToken: string;
    loopbackPort: number;
  }): string {
    if (this.remote.artifactPreviewUrl) {
      return this.remote.artifactPreviewUrl(lease);
    }
    return tauriBackendTransport.artifactPreviewUrl?.(lease) ?? '';
  }
}
