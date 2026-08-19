export const VIBEX_PLUGIN_API_VERSION = "1.0" as const;
export const VIBEX_PLUGIN_PROTOCOL_VERSION = "1.1" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type PackageClass = "full-trust" | "isolated";

export interface InitializeParams {
  protocolRange: ["1.1"];
  hostVersion: string;
  pluginIdentity: { publisher: string; id: string };
  packageVersion: string;
  packageDigest: string;
  generationId: number;
  declaredContributions: string[];
  packageClass: PackageClass;
  features: string[];
  limits: { maxFrameBytes: number; requestTimeoutMs: number };
  runtime: { id: string; version: string; target: string; digest: string };
}

export interface InitializedResult {
  protocolVersion: "1.1";
  sdkVersion: string;
  registrations: string[];
  requestedFeatures: string[];
}

export interface PluginContext {
  pluginId: string;
  pluginVersion: string;
  generation: number;
  packageClass: PackageClass;
  grantedCapabilities: string[];
}

export type WorkerRequest =
  | { id: string; method: "initialize"; params: InitializeParams }
  | { id: string; method: "activate"; params: PluginContext }
  | {
      id: string;
      method: "invoke";
      params: { handler: string; input: JsonValue };
    }
  | { id: string; method: "dispose"; params: { reason: string } }
  | { id: string; method: "ping"; params: Record<string, never> };

export type WorkerResponse =
  | { id: string; ok: true; result: JsonValue }
  | {
      id: string;
      ok: false;
      error: { code: string; message: string; details?: JsonValue };
    };

export type HostRequest = {
  id: string;
  method: "host.call";
  params: {
    capability: string;
    operation: string;
    input: JsonValue;
  };
};

export type HostResponse = WorkerResponse;
