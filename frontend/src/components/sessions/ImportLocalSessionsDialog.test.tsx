import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LocalHistoryImportJobSnapshot,
  LocalHistoryScanPage,
} from 'shared/types';
import { ImportLocalSessionsDialog } from './ImportLocalSessionsDialog';

const scanLocalHistory = vi.fn();
const startLocalHistoryImport = vi.fn();
const importJob = vi.hoisted(() => ({
  value: {
    status: 'idle',
    progress: null,
    result: null,
    log: [],
  } as LocalHistoryImportJobSnapshot,
}));

vi.mock('@/features/agents/api', () => ({
  agentsApi: {
    scanLocalHistory: (...args: unknown[]) => scanLocalHistory(...args),
    startLocalHistoryImport: (...args: unknown[]) =>
      startLocalHistoryImport(...args),
  },
}));

vi.mock('@/features/history-import/useLocalHistoryImportJob', () => ({
  useLocalHistoryImportJob: () => importJob.value,
}));

vi.mock('@/features/agents/useSelectableAgents', () => ({
  useSelectableAgents: () => [
    {
      agentId: 'codex',
      displayName: 'Codex',
      enabled: true,
      lifecycle: 'ready',
      runnable: true,
      settingsFeatures: [],
      iconLight: null,
      iconDark: null,
      iconSvg: null,
    },
    {
      agentId: 'claude_code',
      displayName: 'Claude Code',
      enabled: true,
      lifecycle: 'ready',
      runnable: false,
      settingsFeatures: [],
      iconLight: null,
      iconDark: null,
      iconSvg: null,
    },
  ],
}));

vi.mock('@/components/agents/AgentIcon', () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span>{agent}</span>,
  getAgentName: (agent: string) => agent,
}));

const layout = vi.hoisted(() => ({
  currentProjectKey: 'project-1',
}));

vi.mock('@/stores/useLayoutStore', () => ({
  useLayoutStore: (
    selector: (state: { currentProjectKey: string }) => unknown
  ) => selector(layout),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

const page: LocalHistoryScanPage = {
  folders: [
    {
      path: '/tmp/scratch',
      name: 'scratch',
      project_id: null,
      project_name: null,
      workspace_id: null,
      sessions: [
        {
          agent_id: 'codex',
          external_session_id: 'codex-loose',
          title: 'Loose session',
          workspace_path: '/tmp/scratch',
          message_count: 1,
          updated_at: '2026-08-28T00:00:00Z',
          status: 'new',
        },
      ],
    },
    {
      path: '/Users/mac/Projects/Other',
      name: 'Other',
      project_id: 'project-2',
      project_name: 'Other',
      workspace_id: 'workspace-2',
      sessions: [
        {
          agent_id: 'codex',
          external_session_id: 'codex-other',
          title: 'Other project session',
          workspace_path: '/Users/mac/Projects/Other',
          message_count: 3,
          updated_at: '2026-08-28T00:00:00Z',
          status: 'new',
        },
      ],
    },
    {
      path: '/Users/mac/Projects/VibeX/.worktrees/feature',
      name: 'feature',
      project_id: 'project-1',
      project_name: 'VibeX',
      workspace_id: 'workspace-tree',
      sessions: [
        {
          agent_id: 'codex',
          external_session_id: 'codex-tree',
          title: 'Worktree session',
          workspace_path: '/Users/mac/Projects/VibeX/.worktrees/feature',
          message_count: 2,
          updated_at: null,
          status: 'new',
        },
      ],
    },
    {
      path: '/Users/mac/Projects/VibeX',
      name: 'VibeX',
      project_id: 'project-1',
      project_name: 'VibeX',
      workspace_id: 'workspace-1',
      sessions: [
        {
          agent_id: 'codex',
          external_session_id: 'codex-1',
          title: 'Continue the importer',
          workspace_path: '/Users/mac/Projects/VibeX',
          message_count: 6,
          updated_at: '2026-08-17T00:00:00Z',
          status: 'new',
        },
        {
          agent_id: 'codex',
          external_session_id: 'codex-old',
          title: 'Ancient session',
          workspace_path: '/Users/mac/Projects/VibeX',
          message_count: 1,
          updated_at: '2000-01-01T00:00:00Z',
          status: 'new',
        },
      ],
    },
  ],
  destinations: [
    {
      project_id: 'project-1',
      project_name: 'VibeX',
      workspace_id: 'workspace-1',
      workspace_name: 'main',
    },
    {
      project_id: 'project-2',
      project_name: 'Other',
      workspace_id: 'workspace-2',
      workspace_name: 'main',
    },
  ],
  total_sessions: 5,
  importable_count: 5,
};

const idleJob = (): LocalHistoryImportJobSnapshot => ({
  status: 'idle',
  progress: null,
  result: null,
  log: [],
});

async function chooseCodex(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole('combobox', { name: /importSessions.chooseAgent/i })
  );
  await user.click(await screen.findByRole('option', { name: 'Codex' }));
}

async function startScan(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole('button', { name: 'importSessions.startScan' })
  );
  await waitFor(() =>
    expect(scanLocalHistory).toHaveBeenCalledWith('codex', expect.any(Function))
  );
}

async function chooseCodexAndSelect(user: ReturnType<typeof userEvent.setup>) {
  await chooseCodex(user);
  await startScan(user);
  await user.click(
    (await screen.findAllByRole('button', { name: 'importSessions.expand' }))[0]
  );
  await user.click(
    await screen.findByRole('checkbox', { name: 'Continue the importer' })
  );
}

describe('ImportLocalSessionsDialog', () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', {
      configurable: true,
      value: () => false,
    });
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  beforeEach(() => {
    scanLocalHistory.mockReset();
    startLocalHistoryImport.mockReset();
    importJob.value = idleJob();
    layout.currentProjectKey = 'project-1';
    scanLocalHistory.mockResolvedValue(page);
    startLocalHistoryImport.mockResolvedValue({
      status: 'running',
      progress: null,
      result: null,
      log: [],
    });
  });

  it('scans the selected enabled Agent, then imports into the matched workspace', async () => {
    const onImported = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <ImportLocalSessionsDialog
        open
        onOpenChange={vi.fn()}
        onImported={onImported}
      />
    );

    expect(scanLocalHistory).not.toHaveBeenCalled();
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();

    await chooseCodexAndSelect(user);
    await user.click(
      screen.getByRole('button', {
        name: 'importSessions.importSelected:{"count":1}',
      })
    );

    await waitFor(() =>
      expect(startLocalHistoryImport).toHaveBeenCalledWith([
        {
          agent_id: 'codex',
          external_session_id: 'codex-1',
          workspace_id: 'workspace-1',
        },
      ])
    );

    importJob.value = {
      status: 'completed',
      progress: {
        current: 1,
        total: 1,
        agent_id: 'codex',
        external_session_id: 'codex-1',
        title: 'Continue the importer',
        phase: 'imported',
        imported: 1,
        skipped: 0,
        failed: 0,
        conversation_id: 'conversation-1',
        workspace_id: 'workspace-1',
      },
      result: {
        imported: 1,
        skipped: 0,
        failed: 0,
        conversation_ids: ['conversation-1'],
        errors: [],
      },
      log: [
        {
          phase: 'imported',
          agent_id: 'codex',
          external_session_id: 'codex-1',
          title: 'Continue the importer',
          conversation_id: 'conversation-1',
        },
      ],
    };
    view.rerender(
      <ImportLocalSessionsDialog
        open
        onOpenChange={vi.fn()}
        onImported={onImported}
      />
    );

    expect(onImported).toHaveBeenCalledWith(['conversation-1']);
    expect(
      await screen.findByText('importSessions.doneTitle')
    ).toBeInTheDocument();
  });

  it('shows determinate import progress while the job is running', async () => {
    const user = userEvent.setup();
    const view = render(
      <ImportLocalSessionsDialog open onOpenChange={vi.fn()} />
    );
    await chooseCodexAndSelect(user);
    await user.click(
      screen.getByRole('button', {
        name: 'importSessions.importSelected:{"count":1}',
      })
    );

    importJob.value = {
      status: 'running',
      progress: {
        current: 1,
        total: 2,
        agent_id: 'codex',
        external_session_id: 'codex-1',
        title: 'Continue the importer',
        phase: 'importing',
        imported: 0,
        skipped: 0,
        failed: 0,
        conversation_id: null,
        workspace_id: null,
      },
      result: null,
      log: [],
    };
    view.rerender(<ImportLocalSessionsDialog open onOpenChange={vi.fn()} />);

    const progress = await screen.findByRole('progressbar', {
      name: 'importSessions.importingTitle',
    });
    expect(progress).toHaveAttribute('aria-valuenow', '25');
    expect(
      screen.getByText('importSessions.importingCount:{"current":1,"total":2}')
    ).toBeInTheDocument();
    expect(screen.getByText('Continue the importer')).toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: 'Continue the importer' })
    ).not.toBeInTheDocument();
  });

  it('shows a centered spinner and live scan totals while scanning', async () => {
    let finishScan!: (value: LocalHistoryScanPage) => void;
    const scanPromise = new Promise<LocalHistoryScanPage>((resolve) => {
      finishScan = resolve;
    });
    scanLocalHistory.mockImplementation(
      async (
        _agentId: string,
        onProgress?: (progress: {
          session_count: number;
          bytes_scanned: number;
        }) => void
      ) => {
        onProgress?.({ session_count: 3, bytes_scanned: 2048 });
        return scanPromise;
      }
    );
    const user = userEvent.setup();
    render(<ImportLocalSessionsDialog open onOpenChange={vi.fn()} />);
    await chooseCodex(user);
    expect(scanLocalHistory).not.toHaveBeenCalled();
    await startScan(user);

    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.getByText('importSessions.scanning')).toBeInTheDocument();
    expect(
      screen.getByText(
        'importSessions.scanningStats:{"count":3,"size":"2.0 KB"}'
      )
    ).toBeInTheDocument();

    finishScan(page);
    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });

  it('starts import and closes the dialog when importing in the background', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<ImportLocalSessionsDialog open onOpenChange={onOpenChange} />);
    await chooseCodexAndSelect(user);
    await user.click(
      screen.getByRole('button', { name: 'importSessions.importInBackground' })
    );
    await waitFor(() =>
      expect(startLocalHistoryImport).toHaveBeenCalledWith([
        {
          agent_id: 'codex',
          external_session_id: 'codex-1',
          workspace_id: 'workspace-1',
        },
      ])
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not scan until Start scan is clicked', async () => {
    const user = userEvent.setup();
    render(<ImportLocalSessionsDialog open onOpenChange={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: 'importSessions.startScan' })
    ).toBeDisabled();
    await chooseCodex(user);
    expect(scanLocalHistory).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'importSessions.startScan' })
    ).toBeEnabled();
  });

  it('puts the current project and its worktrees above other folders', async () => {
    const user = userEvent.setup();
    render(<ImportLocalSessionsDialog open onOpenChange={vi.fn()} />);
    await chooseCodex(user);
    await startScan(user);

    await screen.findByRole('checkbox', { name: 'VibeX' });
    const folders = screen
      .getAllByRole('checkbox')
      .map((node) => node.getAttribute('aria-label'))
      .filter(
        (label) =>
          label === 'VibeX' ||
          label === 'feature' ||
          label === 'Other' ||
          label === 'scratch'
      );
    expect(folders).toEqual(['VibeX', 'feature', 'Other']);
  });

  it('can show every folder when the scan scope is global', async () => {
    const user = userEvent.setup();
    render(<ImportLocalSessionsDialog open onOpenChange={vi.fn()} />);
    await chooseCodex(user);
    await startScan(user);
    await screen.findByRole('checkbox', { name: 'VibeX' });

    await user.click(
      screen.getByRole('button', { name: /importSessions.scanScope/i })
    );
    await user.click(
      await screen.findByRole('menuitemradio', {
        name: /importSessions.scanScopeGlobal/,
      })
    );

    expect(
      screen.getByRole('checkbox', { name: 'scratch' })
    ).toBeInTheDocument();
    const folders = screen
      .getAllByRole('checkbox')
      .map((node) => node.getAttribute('aria-label'))
      .filter(
        (label) =>
          label === 'VibeX' ||
          label === 'feature' ||
          label === 'Other' ||
          label === 'scratch'
      );
    expect(folders).toEqual(['VibeX', 'feature', 'Other', 'scratch']);
  });

  it('hides sessions older than the entered number of days', async () => {
    const user = userEvent.setup();
    render(<ImportLocalSessionsDialog open onOpenChange={vi.fn()} />);
    await chooseCodex(user);
    await startScan(user);
    await user.click(
      (
        await screen.findAllByRole('button', { name: 'importSessions.expand' })
      )[0]
    );
    expect(
      await screen.findByRole('checkbox', { name: 'Ancient session' })
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: /importSessions.timeRange/i })
    );
    const days = await screen.findByRole('spinbutton', {
      name: /importSessions.timeRange/i,
    });
    await user.clear(days);
    await user.type(days, '7');

    expect(
      screen.queryByRole('checkbox', { name: 'Ancient session' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: 'feature' })
    ).toBeInTheDocument();
  });

  it('expands search over the time range and scan scope options', async () => {
    const user = userEvent.setup();
    render(<ImportLocalSessionsDialog open onOpenChange={vi.fn()} />);
    await chooseCodex(user);
    await startScan(user);
    await screen.findByRole('checkbox', { name: 'VibeX' });

    expect(
      screen.queryByPlaceholderText('importSessions.searchPlaceholder')
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /importSessions.timeRange/i })
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: /importSessions.scanScope/i })
    ).toBeVisible();

    await user.click(
      screen.getByRole('button', { name: 'importSessions.search' })
    );

    expect(
      screen.getByPlaceholderText('importSessions.searchPlaceholder')
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /importSessions.timeRange/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /importSessions.scanScope/i })
    ).not.toBeInTheDocument();
  });
});
