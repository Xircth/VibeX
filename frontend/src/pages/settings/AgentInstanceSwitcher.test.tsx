import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderInstanceConfig } from '@/lib/providerInstancesApi';
import { AgentInstanceSwitcher } from './AgentInstanceSwitcher';

const INSTANCES: ProviderInstanceConfig[] = [
  {
    instanceId: 'claude-work',
    agentId: 'claude-code',
    displayName: 'Work Instance',
    authMode: { mode: 'OfficialOAuth' },
    isDefault: false,
    hasActiveSessions: false,
  },
  {
    instanceId: 'claude-busy',
    agentId: 'claude-code',
    displayName: 'Busy Instance',
    authMode: { mode: 'ApiKey' },
    isDefault: true,
    hasActiveSessions: true,
  },
];

describe('AgentInstanceSwitcher', () => {
  it('defaults to 本地实例, creates a clean instance, renames, sets default, and disables delete for active sessions', async () => {
    const user = userEvent.setup();
    const onSelectInstance = vi.fn().mockResolvedValue(true);
    const onCreateInstance = vi.fn().mockResolvedValue(INSTANCES[0]);
    const onRenameInstance = vi.fn().mockResolvedValue({
      ...INSTANCES[0],
      displayName: 'Renamed Work',
    });
    const onSetDefaultInstance = vi.fn().mockResolvedValue(true);
    const onDeleteInstance = vi.fn().mockResolvedValue(true);

    const { rerender } = render(
      <AgentInstanceSwitcher
        agentDisplayName="Claude Code"
        instances={INSTANCES}
        selectedInstanceId="local"
        onSelectInstance={onSelectInstance}
        onCreateInstance={onCreateInstance}
        onRenameInstance={onRenameInstance}
        onSetDefaultInstance={onSetDefaultInstance}
        onDeleteInstance={onDeleteInstance}
      />
    );

    const trigger = screen.getByTestId('agent-instance-switcher-trigger');
    expect(trigger).toHaveTextContent('本地实例');
    expect(
      screen.queryByTestId('agent-instance-add-button')
    ).not.toBeInTheDocument();

    // Open dropdown and verify pinned add button sits above the scrollable options list
    await user.click(trigger);
    const addButton = screen.getByTestId('agent-instance-add-button');
    const pinnedTop = addButton.closest('.astryx-select-pinned-top');
    const optionsScroll = screen
      .getByTestId('agent-instance-option-local')
      .closest('.astryx-select-options-scroll');
    expect(pinnedTop).toBeInTheDocument();
    expect(optionsScroll).toBeInTheDocument();
    expect(pinnedTop?.contains(optionsScroll ?? null)).toBe(false);
    expect(optionsScroll?.contains(addButton)).toBe(false);

    // Create instance from pinned action
    await user.click(addButton);
    await user.type(
      screen.getByTestId('agent-instance-create-name-input'),
      '  New Clean Instance  '
    );
    await user.click(screen.getByTestId('agent-instance-create-submit'));
    await waitFor(() =>
      expect(onCreateInstance).toHaveBeenCalledWith('New Clean Instance')
    );

    // Re-open menu: verify default setting on local, delete disabled on active-session instance, delete enabled on idle instance
    await user.click(trigger);
    expect(
      screen.getByTestId('agent-instance-option-local')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('agent-instance-delete-claude-busy')
    ).toBeDisabled();
    expect(
      screen.getByTestId('agent-instance-delete-claude-work')
    ).not.toBeDisabled();

    await user.click(screen.getByTestId('agent-instance-set-default-local'));
    expect(onSetDefaultInstance).toHaveBeenCalledWith('local');

    await user.click(screen.getByTestId('agent-instance-delete-claude-work'));
    expect(onDeleteInstance).toHaveBeenCalledWith('claude-work');

    // Rename instance closes menu cleanly before opening dialog
    await user.click(screen.getByTestId('agent-instance-rename-claude-work'));
    const renameInput = screen.getByTestId('agent-instance-rename-input');
    fireEvent.change(renameInput, { target: { value: 'Renamed Work' } });
    await user.click(screen.getByTestId('agent-instance-rename-submit'));
    await waitFor(() =>
      expect(onRenameInstance).toHaveBeenCalledWith(
        'claude-work',
        'Renamed Work'
      )
    );

    // Selecting an instance switches active view
    rerender(
      <AgentInstanceSwitcher
        agentDisplayName="Claude Code"
        instances={INSTANCES}
        selectedInstanceId="claude-work"
        onSelectInstance={onSelectInstance}
        onCreateInstance={onCreateInstance}
        onRenameInstance={onRenameInstance}
        onSetDefaultInstance={onSetDefaultInstance}
        onDeleteInstance={onDeleteInstance}
      />
    );
    expect(
      screen.getByTestId('agent-instance-switcher-trigger')
    ).toHaveTextContent('Work Instance');
  });
});
