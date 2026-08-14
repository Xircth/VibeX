export const VIBEX_PLUGIN_API_VERSION = "1.0" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface PluginContext {
  pluginId: string;
  pluginVersion: string;
  generation: number;
  /** VibeX product plugins execute with the same local authority as the Host. */
  trust?: "full";
  /** @deprecated Full-trust packages receive `['*']`; do not use this as a gate. */
  grantedCapabilities: string[];
}

export type WorkerRequest =
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
