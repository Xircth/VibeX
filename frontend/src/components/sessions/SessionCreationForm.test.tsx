import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  SessionCreationForm,
  type SessionControlsPreset,
} from './SessionCreationForm';

const capabilityCatalog = vi.fn();
const refreshCapabilityCatalog = vi.fn();
const terminalProfileControls = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      typeof options?.error === 'string' ? `${key}: ${options.error}` : key,
  }),
}));
vi.mock('@/components/tasks/TerminalProfileControls', () => ({
  TerminalProfileControls: (props: unknown) => {
    terminalProfileControls(props);
    return <div data-testid="profile-controls" />;
  },
}));
vi.mock('@/components/tasks/RepoBranchSelector', () => ({
  default: () => null,
}));
vi.mock('./WorkspaceSelector', () => ({ WorkspaceSelector: () => null }));
vi.mock('@/features/agents/api', () => ({
  agentsApi: {
    capabilityCatalog: (...args: unknown[]) => capabilityCatalog(...args),
    refreshCapabilityCatalog: (...args: unknown[]) =>
      refreshCapabilityCatalog(...args),
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
  mode: 'existing_workspace' | 'new_workspace' = 'existing_workspace'
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
      onSubmit={() => {}}
      onSessionControlsPresetChange={onPreset}
    />
  );
  const result = render(form(executor, mode), { wrapper: Wrapper });
  return {
    ...result,
    switchExecutor: (selectedExecutor: typeof executor) =>
      result.rerender(form(selectedExecutor, mode)),
  };
}

describe('SessionCreationForm agent capability catalog controls', () => {
  beforeEach(() => {
    capabilityCatalog.mockReset();
    refreshCapabilityCatalog.mockReset();
    terminalProfileControls.mockReset();
    capabilityCatalog.mockResolvedValue(CONTROLS);
    refreshCapabilityCatalog.mockResolvedValue(true);
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
    expect(terminalProfileControls.mock.calls.at(-1)?.[0]).toMatchObject({
      suppressAcpManagedControls: true,
    });
    expect(onPreset).toHaveBeenLastCalledWith({
      modeOverride: 'auto',
      configOverrides: {
        model: 'sonnet',
        fast: 'false',
      },
    });
  });

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

  it('captures mode, model, and boolean picks as first-turn overrides', async () => {
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
});
