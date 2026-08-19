import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentManagementView } from 'shared/types';

import { AgentSelector, unavailableAgentStatusKey } from './AgentSelector';

const agentManagementBar = vi.fn();

vi.mock('@/features/agent-management', () => ({
  agentManagementApi: {
    bar: (...args: unknown[]) => agentManagementBar(...args),
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));
vi.mock('@/lib/api', () => ({
  settingsWindowApi: { open: () => Promise.resolve() },
}));

function managementView(
  overrides: Partial<AgentManagementView> & Pick<AgentManagementView, 'agent_id'>
): AgentManagementView {
  return {
    display_name: overrides.agent_id,
    description: '',
    icon_light: null,
    icon_dark: null,
    icon_svg: null,
    source: 'built_in_profile',
    built_in: true,
    retired: false,
    enabled: true,
    position: 0,
    lifecycle: 'ready',
    authentication: 'not_required',
    runtime_version: null,
    acp_version: null,
    active_operation: null,
    rollback_available: false,
    settings_features: [],
    ...overrides,
  };
}

const PROFILES = {
  grok: { DEFAULT: { grok: {} } },
  workbuddy: { DEFAULT: { workbuddy: {} } },
};

describe('AgentSelector unavailable status', () => {
  it('does not mislabel an installed Agent that needs authentication as uninstalled', () => {
    expect(unavailableAgentStatusKey('needs_auth')).toBe(
      'agentSelector.needsAuth'
    );
  });

  it('keeps the installation label only for a genuinely uninstalled Agent', () => {
    expect(unavailableAgentStatusKey('uninstalled')).toBe(
      'agentSelector.notInstalled'
    );
  });
});

describe('AgentSelector agent artwork', () => {
  beforeEach(() => {
    agentManagementBar.mockReset();
  });

  it('renders the runtime registry icon for a non-built-in agent (Workbuddy)', async () => {
    agentManagementBar.mockResolvedValue([
      managementView({
        agent_id: 'workbuddy',
        display_name: 'Workbuddy',
        icon_light: '/agents/workbuddy.svg',
        icon_dark: '/agents/workbuddy.svg',
        built_in: false,
      }),
    ]);

    render(
      <AgentSelector
        profiles={PROFILES}
        selectedExecutorProfile={{ executor: 'workbuddy', variant: null }}
        onChange={() => {}}
      />
    );

    await userEvent.click(
      screen.getByRole('button', {
        name: 'agentSelector.selectAgentAriaLabel',
      })
    );

    // The dropdown item shows the registry-provided artwork instead of the
    // generic glyph for an agent that is not in the built-in icon map.
    const items = await screen.findAllByRole('menuitem');
    const workbuddyItem = items.find((item) =>
      item.textContent?.includes('Workbuddy')
    );
    expect(workbuddyItem?.querySelector('img')).toHaveAttribute(
      'src',
      '/agents/workbuddy.svg'
    );
  });

  it('keeps the built-in artwork for grok when no runtime icon is provided', async () => {
    agentManagementBar.mockResolvedValue([
      managementView({
        agent_id: 'grok',
        display_name: 'Grok',
        icon_light: null,
        icon_dark: null,
        icon_svg: null,
      }),
    ]);

    render(
      <AgentSelector
        profiles={PROFILES}
        selectedExecutorProfile={{ executor: 'grok', variant: null }}
        onChange={() => {}}
      />
    );

    expect(await screen.findByRole('img', { name: 'Grok' })).toHaveAttribute(
      'src',
      '/agents/grok.svg'
    );
  });
});
