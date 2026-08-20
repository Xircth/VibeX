// Generated from docs/protocol/v1/schema.json. Do not edit.

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ServerCapabilities {
  server_version: string;
  protocol_version: string;
  minimum_client_version: string;
  capabilities: CapabilityId[];
  host_id?: string;
  reachability?: ReachabilityOrigin[];
}

export type CapabilityId = string;

export interface ReachabilityOrigin {
  origin: string;
  kind: string;
}

export interface CommandRequest {
  operation_id: string;
  args: JsonValue;
}

export interface CommandResponse {
  operation_id: string;
  data: JsonValue;
}

export interface ErrorEnvelope {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  operation_id: string;
  details?: JsonValue;
}

export type ErrorCode = "bad_request" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "capability_unavailable" | "internal";

export type SubscriptionClientMessage = ({ request: SubscriptionRequest; type: "attach" } | { subscription_id: string; type: "detach" } | { type: "ping" });

export type SubscriptionRequest = { subscription_id: string } & ({ conversation_id: string; after_sequence: number; resource: "conversation" } | { run_id: string; after_sequence: number; resource: "workflow_run" });

export type SubscriptionServerMessage = ({ subscription_id: string; type: "ready" } | { subscription_id: string; snapshot: SubscriptionSnapshot; type: "snapshot" } | { subscription_id: string; event: RemoteEvent; type: "event" } | { subscription_id: string; high_water_mark: number; type: "live" } | { subscription_id: string; reason: string; type: "detached" } | { type: "pong" } | { error: ErrorEnvelope; type: "error" });

export interface SubscriptionSnapshot {
  through_sequence: number;
  payload: JsonValue;
}

export interface RemoteEvent {
  sequence: number;
  kind: string;
  payload: JsonValue;
}

export interface CreatePairingRequest {
  preset?: DevicePermissionPreset | JsonValue | null;
  requested_scopes?: string[];
  ttl_seconds?: number | null;
}

export type DevicePermissionPreset = "workstation" | "companion";

export interface PairingChallenge {
  pairing_id: string;
  pairing_token: string;
  expires_at: string;
  requested_scopes: string[];
}

export interface RedeemPairingRequest {
  pairing_token: string;
  device_name: string;
}

export interface DeviceCredential {
  device_id: string;
  access_token: string;
  scopes: string[];
}

export interface RevokeDeviceResponse {
  device_id: string;
  revoked: boolean;
}

export interface TerminalNotificationSummary {
  source: NotificationSource;
  outcome: NotificationOutcome;
  occurred_at: string;
  operation_id: string;
}

export type NotificationSource = ({ conversation_id: string; kind: "conversation" } | { automation_id: string; run_id: string; conversation_id?: string | null; kind: "automation" });

export type NotificationOutcome = "completed" | "failed" | "cancelled" | "interrupted";

export interface OfflineConversationCache {
  conversation_id: string;
  confirmed_through: number;
  read_only?: true;
  events?: RemoteEvent[];
}
