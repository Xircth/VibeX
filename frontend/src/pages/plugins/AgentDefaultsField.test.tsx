import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentDefaultsField,
  isAgentDefaultsSchema,
} from './AgentDefaultsField';

const loadCatalog = vi.hoisted(() => vi.fn());
const managedAgents = vi.hoisted(() => ({
  current: [] as Array<{
    value: string;
    label: string;
    iconLight: null;
    iconDark: null;
    iconSvg: null;
  }>,
}));

vi.mock('@/features/agent-management', () => ({
  useManagedAgentOptions: () => managedAgents.current,
}));

vi.mock('@/features/agents/sessionControlsQuery', () => ({
  loadAgentSessionControlsCatalog: (...args: unknown[]) => loadCatalog(...args),
}));

describe('isAgentDefaultsSchema', () => {
  it('accepts additionalProperties objects that declare modeId', () => {
    expect(
      isAgentDefaultsSchema('agentDefaults', {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: { modeId: { type: 'string' } },
        },
      })
    ).toBe(true);
  });

  it('does not treat closed objects as agent defaults', () => {
    expect(
      isAgentDefaultsSchema('depthLimit', {
        type: 'integer',
      })
    ).toBe(false);
    expect(
      isAgentDefaultsSchema('settings', {
        type: 'object',
        additionalProperties: false,
      })
    ).toBe(false);
  });
});

describe('AgentDefaultsField', () => {
  beforeEach(() => {
    managedAgents.current = [];
    loadCatalog.mockReset();
  });

  it('shows an empty state when no agents are enabled', () => {
    render(
      <AgentDefaultsField
        pluginId="vibex.multi-agent"
        name="agentDefaults"
        schema={{
          type: 'object',
          title: '子智能体配置',
          additionalProperties: true,
        }}
        value={{}}
        disabled={false}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByText('没有可配置的已启用智能体。')).toBeVisible();
  });

  it('lists enabled agents and their probed session controls', async () => {
    managedAgents.current = [
      {
        value: 'grok',
        label: 'Grok',
        iconLight: null,
        iconDark: null,
        iconSvg: null,
      },
    ];
    loadCatalog.mockResolvedValue({
      modes: [{ id: 'default', label: 'Default' }],
      current_mode: 'default',
      config_options: [],
    });

    render(
      <AgentDefaultsField
        pluginId="vibex.multi-agent"
        name="agentDefaults"
        schema={{
          type: 'object',
          title: '子智能体配置',
          additionalProperties: {
            type: 'object',
            properties: { modeId: { type: 'string' } },
          },
        }}
        value={{}}
        disabled={false}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText('Grok')).toBeVisible();
    await waitFor(() => {
      expect(loadCatalog).toHaveBeenCalledWith('grok');
    });
    expect(await screen.findByText('Default')).toBeVisible();
  });

  it('keeps a probe failure empty instead of inventing global defaults', async () => {
    managedAgents.current = [
      {
        value: 'grok',
        label: 'Grok',
        iconLight: null,
        iconDark: null,
        iconSvg: null,
      },
    ];
    loadCatalog.mockRejectedValue(new Error('probe failed'));

    render(
      <AgentDefaultsField
        pluginId="vibex.multi-agent"
        name="agentDefaults"
        schema={{ type: 'object', additionalProperties: true }}
        value={{}}
        disabled={false}
        onChange={vi.fn()}
      />
    );

    expect(
      await screen.findByText('无法读取该智能体的会话选项。')
    ).toBeVisible();
  });
});
