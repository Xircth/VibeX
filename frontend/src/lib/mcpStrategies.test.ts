import { describe, expect, it } from 'vitest';

import type { AgentMcpConfig } from '@/lib/api/config';

import { McpConfigStrategyGeneral } from './mcpStrategies';

function mcpConfig(overrides: Partial<AgentMcpConfig> = {}): AgentMcpConfig {
  return {
    servers: {},
    servers_path: ['mcp', 'servers'],
    template: {},
    preconfigured: {},
    is_toml_config: false,
    ...overrides,
  };
}

describe('McpConfigStrategyGeneral', () => {
  it('creates full config at a nested path and replaces non-object intermediates', () => {
    const config = mcpConfig({
      template: { mcp: 'legacy-value' },
      servers: {
        filesystem: { command: 'npx' },
      },
    });

    expect(McpConfigStrategyGeneral.createFullConfig(config)).toEqual({
      mcp: {
        servers: {
          filesystem: { command: 'npx' },
        },
      },
    });
  });

  it('extracts nested server config and rejects missing paths', () => {
    const config = mcpConfig();
    const fullConfig = {
      mcp: {
        servers: {
          filesystem: { command: 'npx' },
        },
      },
    };

    expect(
      McpConfigStrategyGeneral.extractServersForApi(config, fullConfig)
    ).toEqual({
      filesystem: { command: 'npx' },
    });
    expect(() =>
      McpConfigStrategyGeneral.validateFullConfig(config, {})
    ).toThrow('Missing required field at path: mcp.servers');
  });

  it('rejects server configs that are present but not objects', () => {
    const config = mcpConfig();

    expect(() =>
      McpConfigStrategyGeneral.extractServersForApi(config, {
        mcp: { servers: 'bad' },
      })
    ).toThrow('Servers configuration must be an object');
  });

  it('adds preconfigured servers at the root when path is empty', () => {
    const config = mcpConfig({
      servers_path: [],
      preconfigured: {
        filesystem: { command: 'npx' },
      },
    });

    expect(
      McpConfigStrategyGeneral.addPreconfiguredToConfig(
        config,
        {},
        'filesystem'
      )
    ).toEqual({
      filesystem: { command: 'npx' },
    });
  });
});
