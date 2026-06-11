import type { JsonValue } from 'shared/types';
import type { AgentMcpConfig } from '@/lib/api/config';

type JsonObject = Record<string, JsonValue>;

function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cloneJsonObject(value: JsonValue | undefined): JsonObject {
  const cloned: JsonValue = JSON.parse(JSON.stringify(value ?? {}));
  return isJsonObject(cloned) ? cloned : {};
}

function pathLabel(path: string[]): string {
  return path.join('.');
}

function readValueAtPath(root: JsonValue, path: string[]): JsonValue {
  let current: JsonValue = root;
  for (const key of path) {
    if (!isJsonObject(current)) {
      throw new Error(`Expected object at path: ${pathLabel(path)}`);
    }
    current = current[key];
    if (current === undefined) {
      throw new Error(`Missing required field at path: ${pathLabel(path)}`);
    }
  }
  return current;
}

function ensureObjectPath(root: JsonObject, path: string[]): JsonObject {
  let current = root;
  for (const key of path) {
    const next = current[key];
    if (!isJsonObject(next)) {
      current[key] = {};
    }
    current = current[key] as JsonObject;
  }
  return current;
}

export class McpConfigStrategyGeneral {
  static createFullConfig(cfg: AgentMcpConfig): JsonObject {
    const fullConfig = cloneJsonObject(cfg.template);
    if (cfg.servers_path.length > 0) {
      const current = ensureObjectPath(fullConfig, cfg.servers_path.slice(0, -1));
      const lastKey = cfg.servers_path[cfg.servers_path.length - 1];
      current[lastKey] = cfg.servers;
    }
    return fullConfig;
  }
  static validateFullConfig(
    mcp_config: AgentMcpConfig,
    full_config: JsonValue
  ): void {
    const current = readValueAtPath(full_config, mcp_config.servers_path);
    if (!isJsonObject(current)) {
      throw new Error('Servers configuration must be an object');
    }
  }
  static extractServersForApi(
    mcp_config: AgentMcpConfig,
    full_config: JsonValue
  ): JsonObject {
    const current = readValueAtPath(full_config, mcp_config.servers_path);
    if (!isJsonObject(current)) {
      throw new Error('Servers configuration must be an object');
    }
    return current;
  }

  static addPreconfiguredToConfig(
    mcp_config: AgentMcpConfig,
    existingConfig: JsonValue,
    serverKey: string
  ): JsonObject {
    const preconfVal = mcp_config.preconfigured;
    if (!isJsonObject(preconfVal) || !(serverKey in preconfVal)) {
      throw new Error(`Unknown preconfigured server '${serverKey}'`);
    }

    const updated = cloneJsonObject(existingConfig);

    if (mcp_config.servers_path.length === 0) {
      updated[serverKey] = preconfVal[serverKey];
      return updated;
    }

    const current = ensureObjectPath(
      updated,
      mcp_config.servers_path.slice(0, -1)
    );
    const lastKey = mcp_config.servers_path[mcp_config.servers_path.length - 1];
    if (!isJsonObject(current[lastKey])) current[lastKey] = {};
    (current[lastKey] as JsonObject)[serverKey] = preconfVal[serverKey];

    return updated;
  }
}
