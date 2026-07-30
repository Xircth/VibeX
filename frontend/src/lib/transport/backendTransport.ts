export type BackendEnvironment = 'desktop' | 'web' | 'remote-desktop';
export type CapabilityId = string;
export type ServerCapabilities = {
  server_version: string;
  protocol_version: string;
  minimum_client_version: string;
  capabilities: CapabilityId[];
};
export type SubscriptionRequest = {
  subscription_id: string;
  resource: 'conversation';
  conversation_id: string;
  after_sequence: number;
};
export type RemoteEvent = {
  sequence: number;
  kind: string;
  payload: unknown;
};

export interface BackendTransport {
  readonly environment: BackendEnvironment;
  call(command: string, args?: Record<string, unknown>): Promise<unknown>;
  subscribe?(request: SubscriptionRequest): AsyncIterable<RemoteEvent>;
  capabilities?(): Promise<ServerCapabilities>;
}
