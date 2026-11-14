import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { StrictMode } from 'react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorType, ThemeMode, type AgentManagementView } from 'shared/types';
import { ThemeProvider } from '@/components/ThemeProvider';
import { MainLegacyScope } from '@/app/MainLegacyScope';
import { StartupOverlayContext } from '@/contexts/StartupOverlayContext';
import i18n from '@/i18n';
import { agentsApi } from '@/features/agents/api';
import { FirstRunExperience } from './FirstRunExperience';

const listeners = vi.hoisted(
  () => new Map<string, Set<(value: unknown) => void>>()
);
const api = vi.hoisted(() => ({
  bar: vi.fn(),
  discoveryProgress: vi.fn(),
  registry: vi.fn(),
  refreshRegistry: vi.fn(),
  setEnabled: vi.fn(),
  reorder: vi.fn(),
  preflight: vi.fn(),
  readConfig: vi.fn(),
  actions: vi.fn(),
  environment: vi.fn(),
  accountFlow: vi.fn(),
  addAndInstall: vi.fn(),
  repair: vi.fn(),
  authMode: vi.fn(),
  setAuthMode: vi.fn(),
}));
vi.mock('@/features/agents/api', () => ({
  agentsApi: { discoverLocalHistorySources: vi.fn() },
}));
vi.mock('@/features/agent-management/api', () => ({ agentManagementApi: api }));
vi.mock('@/features/agent-management', async (original) => ({
  ...(await original<typeof import('@/features/agent-management')>()),
  agentManagementApi: api,
}));
vi.mock('@/lib/backendTransport', async (original) => ({
  ...(await original<typeof import('@/lib/backendTransport')>()),
  backendListen: vi.fn(
    async (event: string, handler: (value: unknown) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => {
        set.delete(handler);
      };
    }
  ),
}));
vi.mock('@gsap/react', () => ({ useGSAP: vi.fn() }));
vi.mock('gsap', () => ({ default: { registerPlugin: vi.fn() } }));
vi.mock('@/components/settings/ExternalEditorPicker', () => ({
  ExternalEditorPicker: () => <div />,
}));
vi.mock('./OnboardingAccount', () => ({
  OnboardingAccount: () => <section aria-label="browser-account" />,
}));
vi.mock('./OnboardingProjects', () => ({
  OnboardingProjects: ({
    initialProjectIds,
    onFinish,
  }: {
    initialProjectIds: string[];
    onFinish: (ids: string[]) => Promise<void>;
  }) => (
    <section aria-label="projects">
      <p>{initialProjectIds.join(',')}</p>
      <button onClick={() => void onFinish(['home', 'imported'])}>
        finish projects
      </button>
    </section>
  ),
}));
vi.mock('./OnboardingHistoryImport', () => ({
  OnboardingHistoryImport: ({
    sourceAgents,
    onBack,
    onFinish,
  }: {
    sourceAgents: { agentId: string }[];
    onBack: () => void;
    onFinish: (ids: string[]) => Promise<void>;
  }) => (
    <section aria-label="history">
      <p>{sourceAgents.map((agent) => agent.agentId).join(',')}</p>
      <button onClick={onBack}>back from history</button>
      <button onClick={() => void onFinish(['imported'])}>
        finish history
      </button>
    </section>
  ),
}));

const t = (key: string) => i18n.t(`dialogs:onboarding.${key}`);
const editor = {
  editor_type: EditorType.FILE_MANAGER,
  custom_command: null,
  remote_ssh_host: null,
  remote_ssh_user: null,
};
function agent(id: string, ready: boolean): AgentManagementView {
  return {
    agent_id: id,
    display_name: id,
    description: '',
    source: 'built_in_profile',
    built_in: true,
    retired: false,
    enabled: ready,
    position: 0,
    lifecycle: ready ? 'ready' : 'uninstalled',
    authentication: ready ? 'account' : 'not_logged_in',
    runtime_version: null,
    acp_version: ready ? '1.0' : null,
    icon_light: null,
    icon_dark: null,
    icon_svg: null,
    active_operation: null,
    rollback_available: false,
  };
}
function setup(
  props: Partial<
    import('react').ComponentProps<typeof FirstRunExperience>
  > = {},
  strict = false
) {
  const onPersist = vi.fn().mockResolvedValue(undefined);
  const onFinish = vi.fn().mockResolvedValue(undefined);
  const component = (
    <FirstRunExperience
      open
      initialEditor={editor}
      initialDefaultAgentId="codex"
      onPersist={onPersist}
      onFinish={onFinish}
      {...props}
    />
  );
  render(strict ? <StrictMode>{component}</StrictMode> : component);
  return { onPersist, onFinish };
}
async function configure() {
  fireEvent.click(screen.getByRole('button', { name: t('next') }));
  await screen.findByText(t('agentStatus.ready'));
  await waitFor(() =>
    expect(
      within(screen.getByRole('region', { name: t('rosterTitle') })).getByRole(
        'button',
        { name: 'codex' }
      )
    ).toBeInTheDocument()
  );
}
describe('production first-run flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.clear();
    localStorage.clear();
    vi.mocked(agentsApi.discoverLocalHistorySources).mockResolvedValue([]);
    api.bar.mockResolvedValue([
      agent('codex', true),
      agent('claude_code', false),
    ]);
    api.discoveryProgress.mockResolvedValue({
      phase: 'complete',
      completed: 2,
      total: 2,
      found: 1,
      checked_agent_ids: ['codex', 'claude_code'],
      timed_out: false,
    });
    api.registry.mockResolvedValue({
      installed: [],
      uninstalled: [],
      fresh: true,
    });
    api.preflight.mockImplementation(async (id: string) => ({
      agent_id: id,
      checked_at: '',
      items: [
        {
          id: 'acp',
          label: 'ACP',
          status: 'pass',
          detail: '',
          version: '1',
          path: null,
          source: null,
          repairable: false,
          update_available: false,
          available_version: null,
          update_group: null,
        },
      ],
    }));
    api.readConfig.mockImplementation(async (id: string) => ({
      agent_id: id,
      fields: [],
      files: [],
      paths: [],
      settings_features: [],
    }));
    api.actions.mockImplementation(async (id: string) => ({
      agent_id: id,
      actions: [],
    }));
    api.environment.mockImplementation(async (id: string) => ({
      agent_id: id,
      revision: '1',
      entries: [],
    }));
    api.accountFlow.mockResolvedValue({ status: 'idle' });
    api.reorder.mockResolvedValue([]);
    api.setEnabled.mockResolvedValue(undefined);
  });
  it('replaces folded screenshots with optional browser account sign-in', async () => {
    setup();
    expect(
      screen.getByRole('region', { name: 'browser-account' })
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('onboarding-product-stack')
    ).not.toBeInTheDocument();
    await waitFor(() => expect(api.bar).toHaveBeenCalled());
  });
  it('keeps auth confirmation interactive while the background workspace is inert', async () => {
    const auth = {
      agent_id: 'codex',
      mode: 'api_key',
      modes: ['api_key', 'chatgpt_subscription'],
      options: [
        { value: 'api_key', kind: 'official_api' },
        { value: 'chatgpt_subscription', kind: 'subscription' },
      ],
      credential_present: true,
    };
    api.authMode.mockResolvedValue(auth);
    api.readConfig.mockResolvedValue({
      agent_id: 'codex',
      fields: [],
      files: [],
      paths: [],
      settings_features: ['authentication_mode'],
    });
    api.setAuthMode.mockResolvedValue({
      ...auth,
      mode: 'chatgpt_subscription',
    });
    render(
      <ThemeProvider initialTheme={ThemeMode.LIGHT}>
        <HotkeysProvider>
          <StartupOverlayContext.Provider
            value={
              <FirstRunExperience
                open
                initialEditor={editor}
                initialDefaultAgentId="codex"
                onPersist={vi.fn()}
                onFinish={vi.fn()}
              />
            }
          >
            <MainLegacyScope pageSuspense={false}>
              <button>Background workspace</button>
            </MainLegacyScope>
          </StartupOverlayContext.Provider>
        </HotkeysProvider>
      </ThemeProvider>
    );
    await configure();
    fireEvent.click(
      screen.getByRole('button', {
        name: i18n.t('dialogs:onboarding.viewDetailsAria', { agent: 'codex' }),
      })
    );
    const subscription = await screen.findByRole('tab', {
      name: i18n.t('settings:agents.authModeTabOfficialSubscription'),
    });
    fireEvent.click(subscription);
    const dialog = await screen.findByRole('dialog');
    for (let node: HTMLElement | null = dialog; node; node = node.parentElement)
      expect(node.inert).not.toBe(true);
    expect(screen.getByText('Background workspace').inert).toBe(true);
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: i18n.t('common:cancel'),
      })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(subscription);
    const confirmation = await screen.findByRole('dialog');
    fireEvent.click(
      within(confirmation).getByRole('button', {
        name: i18n.t('settings:agents.authSwitchAwayFromKeyConfirm'),
      })
    );
    await waitFor(() =>
      expect(api.setAuthMode).toHaveBeenCalledWith(
        'codex',
        'chatgpt_subscription',
        null
      )
    );
  });
  it('loads the catalogue under StrictMode and retains enabled/default choices', async () => {
    setup({}, true);
    await configure();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: t('rosterTitle') })).getByRole(
        'button',
        { name: 'codex' }
      )
    ).toBeInTheDocument();
    expect(api.bar).toHaveBeenCalled();
  });
  it('skips history import when no Agent has local history and continues to projects', async () => {
    const callbacks = setup();
    await configure();
    fireEvent.click(screen.getByRole('button', { name: t('next') }));
    await screen.findByRole('region', { name: 'projects' });
    expect(agentsApi.discoverLocalHistorySources).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region', { name: 'history' })).toBeNull();
    expect(callbacks.onPersist).toHaveBeenCalledWith({
      editor,
      defaultAgentId: 'codex',
      skipped: false,
    });
    expect(screen.getByRole('region', { name: 'projects' })).toBeInTheDocument();
    expect(callbacks.onFinish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'finish projects' }));
    await screen.findByRole('heading', { name: t('appearanceTitle') });
    expect(callbacks.onFinish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t('enterWorkspace') }));
    await waitFor(() =>
      expect(callbacks.onFinish).toHaveBeenCalledWith(['home', 'imported'])
    );
  });
  it('offers history import before projects and preselects what it imported', async () => {
    setup();
    vi.mocked(agentsApi.discoverLocalHistorySources).mockResolvedValue([
      'codex',
    ]);
    await configure();
    fireEvent.click(screen.getByRole('button', { name: t('next') }));
    const history = await screen.findByRole('region', { name: 'history' });
    expect(history).toHaveTextContent('codex');
    fireEvent.click(screen.getByRole('button', { name: 'back from history' }));
    await screen.findByRole('region', { name: t('rosterTitle') });
    fireEvent.click(screen.getByRole('button', { name: t('next') }));
    await screen.findByRole('region', { name: 'history' });
    fireEvent.click(screen.getByRole('button', { name: 'finish history' }));
    const projects = await screen.findByRole('region', { name: 'projects' });
    expect(projects).toHaveTextContent('imported');
  });
  it('still opens the history step when source discovery fails, so it can be retried', async () => {
    setup();
    vi.mocked(agentsApi.discoverLocalHistorySources).mockRejectedValue(
      new Error('Host unavailable')
    );
    await configure();
    fireEvent.click(screen.getByRole('button', { name: t('next') }));
    await screen.findByRole('region', { name: 'history' });
  });
  it('keeps configuration open if the selected Agent loses its environment readiness', async () => {
    const callbacks = setup();
    await configure();
    api.preflight.mockRejectedValue(new Error('Host unavailable'));
    fireEvent.click(screen.getByRole('button', { name: t('next') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      t('rosterCheckFailed')
    );
    expect(callbacks.onPersist).not.toHaveBeenCalled();
  });
  it('retains the initial default when its check finishes after another Agent', async () => {
    api.bar.mockResolvedValue([
      agent('codex', true),
      agent('claude_code', true),
    ]);
    const check = api.preflight.getMockImplementation()!;
    let finishCodex!: () => void;
    const codexCheck = new Promise<void>((resolve) => {
      finishCodex = resolve;
    });
    api.preflight.mockImplementation(async (id: string) => {
      if (id === 'codex') await codexCheck;
      return check(id);
    });
    const callbacks = setup();
    fireEvent.click(screen.getByRole('button', { name: t('next') }));
    const roster = await screen.findByRole('region', {
      name: t('rosterTitle'),
    });
    await within(roster).findByRole('button', { name: 'claude_code' });
    await act(async () => finishCodex());
    await within(roster).findByRole('button', { name: 'codex' });
    fireEvent.click(screen.getByRole('button', { name: t('next') }));
    await screen.findByRole('region', { name: 'projects' });
    expect(callbacks.onPersist).toHaveBeenCalledWith({
      editor,
      defaultAgentId: 'codex',
      skipped: false,
    });
    expect(api.reorder).toHaveBeenCalledWith(['codex', 'claude_code']);
  });
  it('enables the reordered roster including Agents without authentication, and leaves removed Agents disabled', async () => {
    const claude = {
      ...agent('claude_code', true),
      lifecycle: 'needs_auth' as const,
    };
    api.bar.mockResolvedValue([agent('codex', true), claude]);
    const callbacks = setup();
    await configure();
    const roster = screen.getByRole('region', { name: t('rosterTitle') });
    const icon = await within(roster).findByRole('button', {
      name: 'claude_code',
    });
    fireEvent.keyDown(icon, { key: 'ArrowLeft', altKey: true });
    fireEvent.keyDown(within(roster).getByRole('button', { name: 'codex' }), {
      key: 'Delete',
    });
    fireEvent.click(screen.getByRole('button', { name: t('next') }));
    await screen.findByRole('region', { name: 'projects' });
    expect(callbacks.onPersist).toHaveBeenCalledWith({
      editor,
      defaultAgentId: 'claude_code',
      skipped: false,
    });
    expect(api.setEnabled).toHaveBeenCalledWith('codex', false);
    expect(api.reorder).toHaveBeenCalledWith(['claude_code', 'codex']);
  });
  it('opens installation details immediately and refreshes status and roster when installation completes', async () => {
    let resolveInstall!: (receipt: unknown) => void;
    api.addAndInstall.mockReturnValue(
      new Promise((resolve) => {
        resolveInstall = resolve;
      })
    );
    setup();
    await configure();
    fireEvent.click(
      screen.getByRole('button', {
        name: i18n.t('dialogs:onboarding.installOneClickAria', {
          agent: 'claude_code',
        }),
      })
    );
    expect(
      await screen.findByRole('complementary', {
        name: i18n.t('dialogs:onboarding.agentDetail', {
          agent: 'claude_code',
        }),
      })
    ).toBeInTheDocument();
    expect(screen.getByText(t('installingAgent'))).toBeInTheDocument();
    await act(async () =>
      resolveInstall({
        operation_id: 'install-1',
        agent_id: 'claude_code',
        kind: 'install',
        status: 'queued',
      })
    );
    const installed = {
      ...agent('claude_code', true),
      lifecycle: 'needs_auth' as const,
    };
    api.bar.mockResolvedValue([agent('codex', true), installed]);
    await act(async () => {
      listeners.get('agent-management-event')?.forEach((handler) =>
        handler({
          operation_id: 'install-1',
          agent_id: 'claude_code',
          kind: 'install',
          status: 'succeeded',
          progress_percent: 100,
          message: 'Installed',
          sequence: 1,
        })
      );
    });
    expect(
      await screen.findAllByText(t('agentStatus.needs_auth'))
    ).toHaveLength(2);
    await waitFor(() =>
      expect(
        within(
          screen.getByRole('region', { name: t('rosterTitle') })
        ).getByRole('button', { name: 'claude_code' })
      ).toBeInTheDocument()
    );
  });
  it('requires acknowledgment of failed installations before continuing and never enables them', async () => {
    api.addAndInstall.mockRejectedValueOnce(new Error('Download failed'));
    const callbacks = setup();
    await configure();
    fireEvent.click(
      screen.getByRole('button', {
        name: i18n.t('dialogs:onboarding.installOneClickAria', {
          agent: 'claude_code',
        }),
      })
    );
    await screen.findAllByText(t('agentStatus.install_failed'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: t('next') })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: t('next') }));
    const dialog = await screen.findByRole('dialog', {
      name: t('failedAgentsTitle'),
    });
    expect(within(dialog).getByText('claude_code')).toBeInTheDocument();
    expect(callbacks.onPersist).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole('button', { name: t('acknowledge') })
    );
    await screen.findByRole('region', { name: 'projects' });
    expect(api.setEnabled).not.toHaveBeenCalledWith('claude_code', true);
  });
  it('keeps the welcome page retryable if finishing a skipped setup fails', async () => {
    const onFinish = vi
      .fn()
      .mockRejectedValue(new Error('Cannot save preferences'));
    setup({ onFinish });
    fireEvent.click(screen.getByRole('button', { name: t('skip') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cannot save preferences'
    );
    expect(screen.getByRole('button', { name: t('skip') })).toBeEnabled();
  });
  it('shows a recoverable catalogue failure and retries without dismissing onboarding', async () => {
    api.bar.mockRejectedValue(new Error('Host unavailable'));
    setup();
    await configure().catch(() => undefined);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Host unavailable'
    );
    api.bar.mockResolvedValue([
      agent('codex', true),
      agent('claude_code', false),
    ]);
    fireEvent.click(screen.getByRole('button', { name: t('retry') }));
    await screen.findByText(t('agentStatus.ready'));
  });
  it('preflights and auto-installs confirmed locally detected Agents before adding them to the roster', async () => {
    let resolveInstall!: (receipt: unknown) => void;
    api.addAndInstall.mockReturnValue(
      new Promise((resolve) => {
        resolveInstall = resolve;
      })
    );
    const localClaude: AgentManagementView = {
      ...agent('claude_code', false),
      local_runtime: {
        path: 'C:\\Users\\developer\\AppData\\Roaming\\npm\\claude.cmd',
        version: '2.1.173',
      },
    };
    const localCursor: AgentManagementView = {
      ...agent('cursor', false),
      desktop_client: {
        path: 'C:\\Users\\developer\\AppData\\Local\\Programs\\cursor\\Cursor.exe',
        version: null,
      },
    };
    api.bar.mockResolvedValue([agent('codex', true), localClaude, localCursor]);
    setup();
    fireEvent.click(screen.getByRole('button', { name: t('next') }));
    const dialog = await screen.findByRole('dialog', {
      name: t('localAgentsDetectedTitle'),
    });
    const claudeCheckbox = within(dialog).getByRole('checkbox', {
      name: /claude_code/i,
    });
    const cursorCheckbox = within(dialog).getByRole('checkbox', {
      name: /cursor/i,
    });
    expect(claudeCheckbox).toBeChecked();
    expect(cursorCheckbox).toBeChecked();

    fireEvent.click(cursorCheckbox);
    expect(cursorCheckbox).not.toBeChecked();

    fireEvent.click(
      within(dialog).getByRole('button', { name: t('localAgentsConfirm') })
    );

    const roster = screen.getByRole('region', { name: t('rosterTitle') });
    expect(
      within(roster).queryByRole('button', { name: 'claude_code' })
    ).toBeNull();
    expect(within(roster).queryByRole('button', { name: 'cursor' })).toBeNull();

    await waitFor(() => {
      expect(api.preflight).toHaveBeenCalledWith('claude_code');
      expect(api.addAndInstall).toHaveBeenCalledWith('claude_code');
    });
    expect(api.addAndInstall).not.toHaveBeenCalledWith('cursor');
    expect(
      within(roster).queryByRole('button', { name: 'claude_code' })
    ).toBeNull();

    await act(async () =>
      resolveInstall({
        operation_id: 'install-local-claude',
        agent_id: 'claude_code',
        kind: 'install',
        status: 'queued',
      })
    );

    const installedClaude: AgentManagementView = {
      ...localClaude,
      lifecycle: 'ready',
      acp_version: '1.0',
    };
    api.bar.mockResolvedValue([
      agent('codex', true),
      installedClaude,
      localCursor,
    ]);

    await act(async () => {
      listeners.get('agent-management-event')?.forEach((handler) =>
        handler({
          operation_id: 'install-local-claude',
          agent_id: 'claude_code',
          kind: 'install',
          status: 'succeeded',
          progress_percent: 100,
          message: 'Installed',
          sequence: 1,
        })
      );
    });

    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: t('rosterTitle') })).getByRole(
          'button',
          { name: 'claude_code' }
        )
      ).toBeInTheDocument()
    );
    expect(
      within(screen.getByRole('region', { name: t('rosterTitle') })).queryByRole(
        'button',
        { name: 'cursor' }
      )
    ).toBeNull();
  });
  it('leaves locally detected Agents disabled when skipping the local detection dialog', async () => {
    const localClaude: AgentManagementView = {
      ...agent('claude_code', true),
      local_runtime: {
        path: 'C:\\Users\\developer\\AppData\\Roaming\\npm\\claude.cmd',
        version: '2.1.173',
      },
    };
    api.bar.mockResolvedValue([agent('codex', true), localClaude]);
    setup();
    fireEvent.click(screen.getByRole('button', { name: t('next') }));
    const dialog = await screen.findByRole('dialog', {
      name: t('localAgentsDetectedTitle'),
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: t('localAgentsSkip') })
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: t('rosterTitle') })).getByRole(
          'button',
          { name: 'codex' }
        )
      ).toBeInTheDocument()
    );
    expect(
      within(screen.getByRole('region', { name: t('rosterTitle') })).queryByRole(
        'button',
        { name: 'claude_code' }
      )
    ).toBeNull();
  });
});
