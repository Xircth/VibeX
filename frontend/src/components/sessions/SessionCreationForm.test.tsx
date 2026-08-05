import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { AgentManagementView } from 'shared/types';
import {
  SessionCreationForm,
  type SessionControlsPreset,
} from './SessionCreationForm';

const capabilityCatalog = vi.fn();
const capabilityCatalogFresh = vi.fn();
const refreshCapabilityCatalog = vi.fn();
const sessionDefaults = vi.fn();
const setSessionDefaults = vi.fn();
const listRemoteSessions = vi.fn();
const importRemoteSession = vi.fn();
const agentManagementBar = vi.fn();
const userSystemConfig = vi.hoisted(() => ({
  previousSessionContinuationEnabled: false,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      typeof options?.error === 'string' ? `${key}: ${options.error}` : key,
  }),
}));
vi.mock('@/components/tasks/RepoBranchSelector', () => ({
  default: () => null,
}));
vi.mock('./WorkspaceSelector', () => ({ WorkspaceSelector: () => null }));
vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({
    config: {
      previous_session_continuation_enabled:
        userSystemConfig.previousSessionContinuationEnabled,
    },
  }),
}));
vi.mock('@/features/agent-management', () => ({
  agentManagementApi: {
    bar: (...args: unknown[]) => agentManagementBar(...args),
  },
}));
vi.mock('@/features/agents/api', () => ({
  agentsApi: {
    capabilityCatalog: (...args: unknown[]) => capabilityCatalog(...args),
    capabilityCatalogFresh: (...args: unknown[]) =>
      capabilityCatalogFresh(...args),
    refreshCapabilityCatalog: (...args: unknown[]) =>
      refreshCapabilityCatalog(...args),
    sessionDefaults: (...args: unknown[]) => sessionDefaults(...args),
    setSessionDefaults: (...args: unknown[]) => setSessionDefaults(...args),
    listRemoteSessions: (...args: unknown[]) => listRemoteSessions(...args),
    importRemoteSession: (...args: unknown[]) => importRemoteSession(...args),
  },
}));

const WORKSPACE_OPTION = {
  value: 'workspace:workspace-1',
  branch: 'main',
  workspace: null,
  existingWorkspaceId: 'workspace-1',
  directWorkspaceId: 'workspace-1',
  useWorktree: true,
  isCurrentProjectBranch: true,
};

const CONTROLS = {
  modes: [
    { id: 'auto', label: 'Auto', description: null },
    { id: 'plan', label: 'Plan', description: null },
  ],
  current_mode: 'auto',
  config_options: [
    {
      key: 'model',
      label: 'Model',
      description: null,
      category: 'model',
      value: 'sonnet',
      choices: [
        { value: 'sonnet', label: 'Sonnet', description: null },
        { value: 'opus', label: 'Opus', description: null },
      ],
    },
    {
      key: 'fast',
      label: 'Fast mode',
      description: null,
      category: 'model_config',
      value: false,
      choices: [
        { value: false, label: 'Off', description: null },
        { value: true, label: 'On', description: null },
      ],
    },
  ],
};

function renderForm(
  executor: 'claude_code' | 'codex' | 'gemini',
  onPreset: (preset: SessionControlsPreset | null) => void,
  mode: 'existing_workspace' | 'new_workspace' = 'existing_workspace',
  compact = false
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }
  const form = (
    selectedExecutor: typeof executor,
    selectedMode: typeof mode
  ) => (
    <SessionCreationForm
      mode={selectedMode}
      onModeChange={() => {}}
      workspaceBranchOptions={[WORKSPACE_OPTION]}
      selectedWorkspaceValue={WORKSPACE_OPTION.value}
      onSelectedWorkspaceValueChange={() => {}}
      sessionName=""
      onSessionNameChange={() => {}}
      profiles={{}}
      selectedExecutorProfile={{ executor: selectedExecutor, variant: null }}
      onSelectedExecutorProfileChange={() => {}}
      repoBranchConfigs={[]}
      onRepoBranchChange={() => {}}
      isLoadingBranches={false}
      canSubmit={true}
      isSubmitting={false}
      compact={compact}
      onSubmit={() => {}}
      onSessionControlsPresetChange={onPreset}
    />
  );
  const result = render(form(executor, mode), { wrapper: Wrapper });
  return {
    ...result,
    client,
    form,
    Wrapper,
    switchExecutor: (selectedExecutor: typeof executor) =>
      result.rerender(form(selectedExecutor, mode)),
  };
}

describe('SessionCreationForm agent capability catalog controls', () => {
  beforeEach(() => {
    capabilityCatalog.mockReset();
    capabilityCatalogFresh.mockReset();
    refreshCapabilityCatalog.mockReset();
    sessionDefaults.mockReset();
    setSessionDefaults.mockReset();
    listRemoteSessions.mockReset();
    importRemoteSession.mockReset();
    agentManagementBar.mockReset();
    userSystemConfig.previousSessionContinuationEnabled = false;
    capabilityCatalog.mockResolvedValue(CONTROLS);
    capabilityCatalogFresh.mockResolvedValue(true);
    refreshCapabilityCatalog.mockResolvedValue(true);
    sessionDefaults.mockResolvedValue({
      values: {},
      staleIds: [],
    });
    setSessionDefaults.mockResolvedValue(undefined);
    listRemoteSessions.mockResolvedValue({
      sessions: [],
      next_cursor: null,
      meta: null,
    });
    importRemoteSession.mockResolvedValue({ id: 'conversation-imported' });
    agentManagementBar.mockResolvedValue([
      {
        agent_id: 'codex',
        display_name: 'Codex',
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
        authentication: 'account',
        runtime_version: '1.0.0',
        acp_version: '1.0.0',
        active_operation: null,
        rollback_available: false,
      } satisfies AgentManagementView,
    ]);
  });

  it('loads editable controls for the first session in a new workspace', async () => {
    const onPreset = vi.fn();
    renderForm('codex', onPreset, 'new_workspace');

    await waitFor(() =>
      expect(capabilityCatalog).toHaveBeenCalledWith('codex')
    );
    expect(
      await screen.findByTestId('session-settings-summary')
    ).toBeInTheDocument();
    expect(
      screen.queryByText('sessionCreation.controlsUnavailable')
    ).not.toBeInTheDocument();
    expect(onPreset).toHaveBeenLastCalledWith({
      modeOverride: 'auto',
      configOverrides: {
        model: 'sonnet',
        fast: 'false',
      },
    });
  });

  it.each([false, true])(
    'keeps the agent selector chevron on the trigger row when compact=%s',
    async (compact) => {
      renderForm('codex', vi.fn(), 'new_workspace', compact);

      const trigger = await screen.findByRole('button', {
        name: 'agentSelector.selectAgentAriaLabel',
      });
      const chevron = trigger.querySelector('svg.lucide-arrow-down');
      expect(trigger).toHaveClass('w-full');
      expect(trigger).not.toHaveClass('flex-wrap', 'grid');
      expect(chevron).toBe(trigger.lastElementChild);
      expect(chevron).toHaveClass('shrink-0');
    }
  );

  it('discovers and persists controls once when no verified catalog exists yet', async () => {
    capabilityCatalog
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(CONTROLS);
    renderForm('gemini', vi.fn(), 'new_workspace');

    expect(
      await screen.findByTestId('session-settings-summary')
    ).toBeInTheDocument();
    expect(refreshCapabilityCatalog).toHaveBeenCalledTimes(1);
    expect(refreshCapabilityCatalog).toHaveBeenCalledWith('gemini');
    expect(capabilityCatalog).toHaveBeenCalledTimes(2);
  });

  it('shows stale cached controls while refreshing them in the background', async () => {
    capabilityCatalogFresh
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    renderForm('gemini', vi.fn(), 'new_workspace');

    expect(
      await screen.findByTestId('session-settings-summary')
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(refreshCapabilityCatalog).toHaveBeenCalledWith('gemini')
    );
    await waitFor(() => expect(capabilityCatalog).toHaveBeenCalledTimes(2));
  });

  it('reuses each agent catalog from the shared query cache', async () => {
    const view = renderForm('claude_code', vi.fn());
    await screen.findByTestId('session-settings-summary');

    view.switchExecutor('codex');
    await waitFor(() =>
      expect(capabilityCatalog).toHaveBeenCalledWith('codex')
    );
    view.switchExecutor('claude_code');

    await waitFor(() => {
      expect(
        capabilityCatalog.mock.calls.filter(
          ([agent]) => agent === 'claude_code'
        )
      ).toHaveLength(1);
    });
    expect(refreshCapabilityCatalog).not.toHaveBeenCalled();
  });

  it('captures mode, model, and boolean picks as new-session controls', async () => {
    const onPreset = vi.fn();
    renderForm('claude_code', onPreset);
    const user = userEvent.setup();

    await screen.findByTestId('session-settings-summary');
    await user.click(screen.getByTestId('session-settings-summary'));
    await user.click(screen.getByText('sessionModeSelector.title'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Plan' }));

    await user.click(screen.getByTestId('session-settings-summary'));
    await user.click(screen.getByText('Model'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Opus' }));

    await user.click(screen.getByTestId('session-settings-summary'));
    await user.click(screen.getByText('Fast mode'));

    await waitFor(() =>
      expect(onPreset).toHaveBeenLastCalledWith({
        modeOverride: 'plan',
        configOverrides: {
          model: 'opus',
          fast: 'true',
        },
      })
    );
  });

  it('does not present a legacy Session Mode override as a persisted Agent default', async () => {
    renderForm('claude_code', vi.fn());
    const user = userEvent.setup();

    await screen.findByTestId('session-settings-summary');
    await user.click(screen.getByTestId('session-settings-summary'));
    await user.click(screen.getByText('sessionModeSelector.title'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Plan' }));

    expect(
      screen.queryByRole('button', {
        name: 'sessionCreation.saveAgentDefaults',
      })
    ).not.toBeInTheDocument();
  });

  it('shows a matching default pill only while session controls differ from their initial values', async () => {
    renderForm('claude_code', vi.fn());
    const user = userEvent.setup();

    const summary = await screen.findByTestId('session-settings-summary');
    expect(summary).toHaveClass('rounded-full');
    expect(
      screen.queryByRole('button', {
        name: 'sessionCreation.saveAgentDefaults',
      })
    ).not.toBeInTheDocument();

    await user.click(summary);
    await user.click(screen.getByText('Model'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Opus' }));

    const saveDefaults = await screen.findByRole('button', {
      name: 'sessionCreation.saveAgentDefaults',
    });
    expect(saveDefaults).toHaveClass('rounded-full');

    await user.click(saveDefaults);
    await waitFor(() =>
      expect(setSessionDefaults).toHaveBeenCalledWith('claude_code', {
        model: 'opus',
        fast: false,
      })
    );
    expect(
      screen.queryByRole('button', {
        name: 'sessionCreation.saveAgentDefaults',
      })
    ).not.toBeInTheDocument();
  });

  it('reuses a newly saved Agent default when the create form is opened again', async () => {
    const firstPreset = vi.fn();
    const first = renderForm('claude_code', firstPreset);
    const user = userEvent.setup();

    const summary = await screen.findByTestId('session-settings-summary');
    await user.click(summary);
    await user.click(screen.getByText('Model'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Opus' }));
    await user.click(
      await screen.findByRole('button', {
        name: 'sessionCreation.saveAgentDefaults',
      })
    );
    await waitFor(() => expect(setSessionDefaults).toHaveBeenCalledTimes(1));

    first.unmount();
    const reopenedPreset = vi.fn();
    render(
      <SessionCreationForm
        mode="existing_workspace"
        onModeChange={() => {}}
        workspaceBranchOptions={[WORKSPACE_OPTION]}
        selectedWorkspaceValue={WORKSPACE_OPTION.value}
        onSelectedWorkspaceValueChange={() => {}}
        sessionName=""
        onSessionNameChange={() => {}}
        profiles={{}}
        selectedExecutorProfile={{
          executor: 'claude_code',
          variant: null,
        }}
        onSelectedExecutorProfileChange={() => {}}
        repoBranchConfigs={[]}
        onRepoBranchChange={() => {}}
        isLoadingBranches={false}
        canSubmit={true}
        isSubmitting={false}
        onSubmit={() => {}}
        onSessionControlsPresetChange={reopenedPreset}
      />,
      { wrapper: first.Wrapper }
    );

    await waitFor(() =>
      expect(reopenedPreset).toHaveBeenLastCalledWith({
        modeOverride: 'auto',
        configOverrides: { model: 'opus', fast: 'false' },
      })
    );
    expect(sessionDefaults).toHaveBeenCalledTimes(1);
  });

  it('hides the default pill when the user restores the initial session controls', async () => {
    renderForm('claude_code', vi.fn());
    const user = userEvent.setup();

    const summary = await screen.findByTestId('session-settings-summary');
    await user.click(summary);
    await user.click(screen.getByText('Model'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Opus' }));
    expect(
      await screen.findByRole('button', {
        name: 'sessionCreation.saveAgentDefaults',
      })
    ).toBeInTheDocument();

    await user.click(summary);
    await user.click(screen.getByText('Model'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sonnet' }));

    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: 'sessionCreation.saveAgentDefaults',
        })
      ).not.toBeInTheDocument()
    );
  });

  it('loads raw Agent defaults without exposing stale option diagnostics', async () => {
    sessionDefaults.mockResolvedValue({
      values: { model: 'opus' },
      staleIds: ['removed-option'],
    });
    renderForm('claude_code', vi.fn());
    const user = userEvent.setup();

    await screen.findByTestId('session-settings-summary');
    expect(
      screen.queryByText('sessionCreation.staleDefaults')
    ).not.toBeInTheDocument();
    await user.click(screen.getByTestId('session-settings-summary'));
    await user.click(screen.getByText('Fast mode'));
    await user.click(
      screen.getByRole('button', { name: 'sessionCreation.saveAgentDefaults' })
    );

    await waitFor(() =>
      expect(setSessionDefaults).toHaveBeenCalledWith('claude_code', {
        model: 'opus',
        fast: true,
      })
    );
  });

  it('submits one Codex mode override and keeps string-valued Fast configuration', async () => {
    capabilityCatalog.mockResolvedValue({
      modes: [
        { id: 'read-only', label: 'Read-only', description: null },
        { id: 'agent', label: 'Agent', description: null },
        {
          id: 'agent-full-access',
          label: 'Agent (full access)',
          description: null,
        },
      ],
      current_mode: 'agent',
      config_options: [
        {
          key: 'mode',
          label: 'Mode',
          description: null,
          category: 'mode',
          value: 'agent',
          choices: [
            { value: 'read-only', label: 'Read-only', description: null },
            { value: 'agent', label: 'Agent', description: null },
            {
              value: 'agent-full-access',
              label: 'Agent (full access)',
              description: null,
            },
          ],
        },
        CONTROLS.config_options[0],
        {
          key: 'fast-mode',
          label: 'Fast mode',
          description: null,
          category: 'model_config',
          value: 'off',
          choices: [
            { value: 'off', label: 'Off', description: null },
            { value: 'on', label: 'On', description: null },
          ],
        },
      ],
    });
    const onPreset = vi.fn();
    renderForm('codex', onPreset, 'new_workspace');
    const user = userEvent.setup();

    await screen.findByTestId('session-settings-summary');
    await user.click(screen.getByTestId('session-settings-summary'));
    await user.click(screen.getByText('Fast mode'));

    await waitFor(() =>
      expect(onPreset).toHaveBeenLastCalledWith({
        modeOverride: 'agent-full-access',
        configOverrides: {
          model: 'sonnet',
          'fast-mode': 'on',
        },
      })
    );
  });

  it('keeps dangerous permissions behind the explicit safety toggle', async () => {
    capabilityCatalog.mockResolvedValue({
      ...CONTROLS,
      modes: [
        ...CONTROLS.modes,
        {
          id: 'bypassPermissions',
          label: 'Bypass permissions',
          description: null,
        },
      ],
    });
    const onPreset = vi.fn();
    renderForm('claude_code', onPreset);
    const user = userEvent.setup();

    await screen.findByTestId('session-settings-summary');
    await user.click(screen.getByTestId('session-settings-summary'));
    await user.click(screen.getByText('sessionModeSelector.title'));
    expect(screen.queryByText('Bypass permissions')).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('menuitem', {
        name: /sessionModeSelector\.allowDangerousOperations/,
      })
    );
    await user.click(screen.getByTestId('session-settings-summary'));
    await user.click(screen.getByTestId('session-settings-summary'));
    await user.click(screen.getByText('sessionModeSelector.title'));
    fireEvent.click(await screen.findByText('Bypass permissions'));

    await waitFor(() =>
      expect(onPreset).toHaveBeenLastCalledWith({
        modeOverride: 'bypassPermissions',
        configOverrides: {
          model: 'sonnet',
          fast: 'false',
        },
      })
    );
  });

  it('hides Codex collaboration mode from the creation summary and menu', async () => {
    capabilityCatalog.mockResolvedValue({
      ...CONTROLS,
      config_options: [
        ...CONTROLS.config_options,
        {
          key: 'collaboration_mode',
          label: 'Collaboration mode',
          description: null,
          category: 'other',
          value: 'default',
          choices: [
            { value: 'default', label: 'Default', description: null },
            { value: 'plan', label: 'Plan', description: null },
          ],
        },
      ],
    });
    renderForm('codex', vi.fn());
    const user = userEvent.setup();

    const summary = await screen.findByTestId('session-settings-summary');
    expect(summary).not.toHaveAttribute(
      'aria-label',
      expect.stringContaining('Default')
    );
    await user.click(summary);
    expect(screen.queryByText('Collaboration mode')).not.toBeInTheDocument();
  });

  it('shows a contextual error instead of the misleading unavailable hint', async () => {
    capabilityCatalog.mockResolvedValue(null);
    refreshCapabilityCatalog.mockResolvedValue(false);
    renderForm('codex', vi.fn(), 'new_workspace');

    expect(
      await screen.findByText(
        'sessionCreation.controlsPrepareFailed: Error: Agent session controls discovery failed'
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText('sessionCreation.controlsUnavailable')
    ).not.toBeInTheDocument();
  });

  it('keeps previous-session continuation hidden until the preference is enabled', async () => {
    capabilityCatalog.mockResolvedValue({
      ...CONTROLS,
      capabilities: {
        list_sessions: true,
      },
    });

    renderForm('gemini', vi.fn());

    await screen.findByTestId('session-settings-summary');
    expect(
      screen.queryByRole('button', {
        name: 'sessionCreation.continuePreviousSession',
      })
    ).not.toBeInTheDocument();
  });

  it('connects a listed previous session without exposing its path or deletion', async () => {
    userSystemConfig.previousSessionContinuationEnabled = true;
    capabilityCatalog.mockResolvedValue({
      ...CONTROLS,
      capabilities: {
        list_sessions: true,
        delete_session: true,
      },
    });
    listRemoteSessions.mockResolvedValue({
      sessions: [
        {
          acp_session_id: 'acp-session-1',
          cwd: '/workspace',
          additional_directories: [],
          title: 'Fixture session',
          updated_at: '2026-07-30T00:00:00Z',
          meta: null,
        },
      ],
      next_cursor: null,
      meta: null,
    });
    renderForm('gemini', vi.fn());
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('button', {
        name: 'sessionCreation.continuePreviousSession',
      })
    );
    expect(await screen.findByText('Fixture session')).toBeInTheDocument();
    expect(screen.queryByText('/workspace')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: 'sessionCreation.deleteAgentSession',
      })
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole('button', {
        name: 'sessionCreation.connectThisSession',
      })
    );

    await waitFor(() =>
      expect(importRemoteSession).toHaveBeenCalledWith(
        'gemini',
        'workspace-1',
        'acp-session-1',
        'Fixture session'
      )
    );
  });
});
