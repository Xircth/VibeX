import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  SessionCreationForm,
  type SessionControlsPreset,
} from './SessionCreationForm';

const prepareSession = vi.fn();
const setPreparedSessionMode = vi.fn();
const setPreparedSessionConfig = vi.fn();
const discardPreparedSession = vi.fn();
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
    prepareSession: (...args: unknown[]) => prepareSession(...args),
    setPreparedSessionMode: (...args: unknown[]) =>
      setPreparedSessionMode(...args),
    setPreparedSessionConfig: (...args: unknown[]) =>
      setPreparedSessionConfig(...args),
    discardPreparedSession: (...args: unknown[]) =>
      Promise.resolve(discardPreparedSession(...args)),
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

function prepared(controls: {
  modes: Array<{ id: string; label: string; description: null }>;
  current_mode: string | null;
  config_options: Array<{
    key: string;
    label: string;
    description: null;
    category: string;
    value: string | boolean | null;
    choices: Array<{
      value: string | boolean;
      label: string;
      description: null;
    }>;
  }>;
}) {
  return {
    session: {
      id: 'prepared-session',
      connection_id: 'connection-1',
      acp_session_id: 'acp-session-1',
      status: 'ready',
      active_prompt_id: null,
      queued_prompt_ids: [],
      created_at: '2026-07-16T00:00:00Z',
      updated_at: '2026-07-16T00:00:00Z',
    },
    controls,
  };
}

function renderForm(
  executor: 'claude_code' | 'codex' | 'gemini',
  onPreset: (preset: SessionControlsPreset | null) => void,
  reactStrictMode = false
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }
  const form = (selectedExecutor: typeof executor) => (
    <SessionCreationForm
      mode="existing_workspace"
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
  const result = render(form(executor), {
    wrapper: Wrapper,
    reactStrictMode,
  });
  return {
    ...result,
    switchExecutor: (selectedExecutor: typeof executor) =>
      result.rerender(form(selectedExecutor)),
  };
}

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

describe('SessionCreationForm prepared ACP session controls', () => {
  beforeEach(() => {
    prepareSession.mockReset();
    setPreparedSessionMode.mockReset();
    setPreparedSessionConfig.mockReset();
    discardPreparedSession.mockReset();
    discardPreparedSession.mockResolvedValue(undefined);
    terminalProfileControls.mockReset();
    prepareSession.mockResolvedValue(prepared(CONTROLS));
  });

  it('prepares a concrete session as soon as agent and workspace are known', async () => {
    const onPreset = vi.fn();
    renderForm('codex', onPreset);

    await waitFor(() => expect(prepareSession).toHaveBeenCalledTimes(1));
    expect(prepareSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: 'codex',
        workspaceId: 'workspace-1',
      })
    );
    expect(terminalProfileControls.mock.calls.at(-1)?.[0]).toMatchObject({
      suppressAcpManagedControls: true,
    });
    await waitFor(() =>
      expect(screen.getByTestId('session-settings-summary')).toBeInTheDocument()
    );
    expect(onPreset).toHaveBeenLastCalledWith({
      preparedSessionId: expect.any(String),
    });
  });

  it('applies changes to the same ACP session and replaces the complete controls response', async () => {
    const modeChanged = {
      ...CONTROLS,
      current_mode: 'plan',
    };
    const configChanged = {
      ...modeChanged,
      config_options: CONTROLS.config_options.map((option) =>
        option.key === 'model' ? { ...option, value: 'opus' } : option
      ),
    };
    setPreparedSessionMode.mockResolvedValue(modeChanged);
    setPreparedSessionConfig.mockResolvedValue(configChanged);
    renderForm('claude_code', vi.fn());
    const user = userEvent.setup();

    await screen.findByTestId('session-settings-summary');
    await user.click(screen.getByTestId('session-settings-summary'));
    await user.click(screen.getByText('sessionModeSelector.title'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Plan' }));
    await waitFor(() =>
      expect(setPreparedSessionMode).toHaveBeenCalledWith(
        expect.any(String),
        'plan'
      )
    );

    await user.click(screen.getByTestId('session-settings-summary'));
    await user.click(screen.getByText('Model'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Opus' }));
    await waitFor(() =>
      expect(setPreparedSessionConfig).toHaveBeenCalledWith(
        expect.any(String),
        'model',
        'opus'
      )
    );
  });

  it('renders and sends boolean Fast as a boolean value', async () => {
    setPreparedSessionConfig.mockResolvedValue({
      ...CONTROLS,
      config_options: CONTROLS.config_options.map((option) =>
        option.key === 'fast' ? { ...option, value: true } : option
      ),
    });
    renderForm('codex', vi.fn());
    const user = userEvent.setup();

    await screen.findByTestId('session-settings-summary');
    await user.click(screen.getByTestId('session-settings-summary'));
    await user.click(screen.getByText('Fast mode'));
    expect(setPreparedSessionConfig).toHaveBeenCalledWith(
      expect.any(String),
      'fast',
      true
    );
  });

  it('keeps dangerous permissions separate from the Claude mode picker', async () => {
    const permissionControls = {
      ...CONTROLS,
      modes: [
        ...CONTROLS.modes,
        {
          id: 'bypassPermissions',
          label: 'Bypass permissions',
          description: null,
        },
      ],
    };
    prepareSession.mockResolvedValue(prepared(permissionControls));
    setPreparedSessionMode.mockResolvedValue({
      ...permissionControls,
      current_mode: 'bypassPermissions',
    });
    renderForm('claude_code', vi.fn());
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
    await screen.findByRole('menuitem', {
      name: /sessionModeSelector\.allowDangerousOperationssessionSettings\.on/,
    });
    await user.click(screen.getByTestId('session-settings-summary'));
    await user.click(screen.getByTestId('session-settings-summary'));
    await user.click(screen.getByText('sessionModeSelector.title'));
    fireEvent.click(await screen.findByText('Bypass permissions'));
    await waitFor(() =>
      expect(setPreparedSessionMode).toHaveBeenCalledWith(
        expect.any(String),
        'bypassPermissions'
      )
    );
    await waitFor(() =>
      expect(screen.getByTestId('session-settings-summary')).toHaveAttribute(
        'aria-label',
        expect.stringContaining('Bypass permissions')
      )
    );
  });

  it('hides Codex collaboration mode from the creation summary and menu', async () => {
    prepareSession.mockResolvedValue(
      prepared({
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
      })
    );
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

  it('adds preparation context when switching to Codex returns a missing session', async () => {
    const missingSessionId = '6d74708a-398b-4167-b082-cbec47726dcd';
    const view = renderForm('claude_code', vi.fn());

    await screen.findByTestId('session-settings-summary');
    prepareSession.mockRejectedValueOnce(`Not found: ${missingSessionId}`);
    view.switchExecutor('codex');

    expect(
      await screen.findByText(
        `sessionCreation.controlsPrepareFailed: Not found: ${missingSessionId}`
      )
    ).toBeInTheDocument();
  });

  it('adds operation context when a Codex option update fails', async () => {
    const missingSessionId = '6d74708a-398b-4167-b082-cbec47726dcd';
    setPreparedSessionMode.mockRejectedValueOnce(
      `Not found: ${missingSessionId}`
    );
    renderForm('codex', vi.fn());
    const user = userEvent.setup();

    await screen.findByTestId('session-settings-summary');
    await user.click(screen.getByTestId('session-settings-summary'));
    await user.click(screen.getByText('sessionModeSelector.title'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Plan' }));

    expect(
      await screen.findByText(
        `sessionCreation.controlsUpdateFailed: Not found: ${missingSessionId}`
      )
    ).toBeInTheDocument();
  });

  it('does not discard the active prepared session under React strict effects', async () => {
    renderForm('codex', vi.fn(), true);

    await screen.findByTestId('session-settings-summary');
    const activeSessionId = prepareSession.mock.calls.at(-1)?.[0].sessionId;
    expect(activeSessionId).toEqual(expect.any(String));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(discardPreparedSession).not.toHaveBeenCalledWith(activeSessionId);
  });

  it('discards only the superseded session when the executor changes', async () => {
    const view = renderForm('claude_code', vi.fn());

    await screen.findByTestId('session-settings-summary');
    const claudeSessionId = prepareSession.mock.calls.at(-1)?.[0].sessionId;
    view.switchExecutor('codex');
    await waitFor(() => expect(prepareSession).toHaveBeenCalledTimes(2));
    const codexSessionId = prepareSession.mock.calls.at(-1)?.[0].sessionId;

    await waitFor(() =>
      expect(discardPreparedSession).toHaveBeenCalledWith(claudeSessionId)
    );
    expect(codexSessionId).not.toBe(claudeSessionId);
    expect(discardPreparedSession).not.toHaveBeenCalledWith(codexSessionId);
  });
});
