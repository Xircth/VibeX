import { tauriInvoke } from '@/lib/tauriApi';
import type { BaseCodingAgent } from 'shared/types';

/**
 * Native configuration files for each agent (config.toml, auth.json, etc.).
 * These are read from / written to the agent's own config directory on disk.
 */
export interface AgentNativeConfigs {
  /** Codex: ~/.codex/config.toml content */
  codex_config_toml: string | null;
  /** Codex: ~/.codex/auth.json content */
  codex_auth_json: string | null;
  /** Codex home directory path */
  codex_home_path: string | null;
  /** OpenCode: config directory json content */
  opencode_config_json: string | null;
  /** OpenCode: auth.json content */
  opencode_auth_json: string | null;
  /** OpenCode config directory path */
  opencode_config_path: string | null;
}

/**
 * Read an agent's native configuration files from the filesystem.
 */
export async function readAgentNativeConfigs(
  agentType: BaseCodingAgent
): Promise<AgentNativeConfigs> {
  return tauriInvoke<AgentNativeConfigs>('read_agent_native_configs', {
    agentType,
  });
}

/**
 * Write an agent's native configuration files to the filesystem.
 */
export async function writeAgentNativeConfig(params: {
  agentType: BaseCodingAgent;
  codexConfigToml?: string | null;
  codexAuthJson?: string | null;
  opencodeConfigJson?: string | null;
  opencodeAuthJson?: string | null;
}): Promise<void> {
  return tauriInvoke<void>('write_agent_native_config', {
    agentType: params.agentType,
    codex_config_toml: params.codexConfigToml ?? null,
    codex_auth_json: params.codexAuthJson ?? null,
    opencode_config_json: params.opencodeConfigJson ?? null,
    opencode_auth_json: params.opencodeAuthJson ?? null,
  });
}
