import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  useTranslation: () => ({ t: (key: string) => key }),
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
      discardPreparedSession(...args),
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
  onPreset: (preset: SessionControlsPreset | null) => void
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }
  return render(
    <SessionCreationForm
      mode="existing_workspace"
      onModeChange={() => {}}
      workspaceBranchOptions={[WORKSPACE_OPTION]}
      selectedWorkspaceValue={WORKSPACE_OPTION.value}
      onSelectedWorkspaceValueChange={() => {}}
      sessionName=""
      onSessionNameChange={() => {}}
      profiles={{}}
      selectedExecutorProfile={{ executor, variant: null }}
      onSelectedExecutorProfileChange={() => {}}
      repoBranchConfigs={[]}
      onRepoBranchChange={() => {}}
      isLoadingBranches={false}
      canSubmit={true}
      isSubmitting={false}
      onSubmit={() => {}}
      onSessionControlsPresetChange={onPreset}
    />,
    { wrapper: Wrapper }
  );
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
      expect(screen.getByTestId('session-control-model')).toBeInTheDocument()
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

    await waitFor(() =>
      expect(screen.getByTestId('session-control-mode')).toBeInTheDocument()
    );
    await user.click(screen.getByTestId('session-control-mode'));
    await user.click(screen.getByText('Plan'));
    expect(setPreparedSessionMode).toHaveBeenCalledWith(
      expect.any(String),
      'plan'
    );

    await user.click(screen.getByTestId('session-control-model'));
    await user.click(screen.getByText('Opus'));
    expect(setPreparedSessionConfig).toHaveBeenCalledWith(
      expect.any(String),
      'model',
      'opus'
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

    const fast = await screen.findByRole('switch', { name: 'Fast mode' });
    await user.click(fast);
    expect(setPreparedSessionConfig).toHaveBeenCalledWith(
      expect.any(String),
      'fast',
      true
    );
  });
});
