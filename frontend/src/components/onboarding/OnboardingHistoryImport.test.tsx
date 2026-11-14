import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LocalHistoryImportJobSnapshot,
  LocalHistoryScanPage,
} from 'shared/types';
import i18n from '@/i18n';
import { OnboardingHistoryImport } from './OnboardingHistoryImport';

const api = vi.hoisted(() => ({
  scanLocalHistory: vi.fn(),
  discoverLocalHistorySources: vi.fn(),
  startLocalHistoryImport: vi.fn(),
  localHistoryImportSnapshot: vi.fn(),
  prepare: vi.fn(),
  listener: null as ((snapshot: LocalHistoryImportJobSnapshot) => void) | null,
}));
vi.mock('@/features/agents/api', () => ({ agentsApi: api }));
vi.mock('@/lib/backendTransport', () => ({
  backendListen: vi.fn(async (_event, listener) => {
    api.listener = listener;
    return () => undefined;
  }),
}));
vi.mock('./onboardingHistory', async (original) => ({
  ...(await original<typeof import('./onboardingHistory')>()),
  prepareOnboardingHistoryImport: api.prepare,
}));
const t = (key: string, values?: Record<string, unknown>) =>
  i18n.t(`dialogs:onboarding.${key}`, values) as string;
const empty: LocalHistoryScanPage = {
  folders: [],
  destinations: [],
  total_sessions: 0,
  importable_count: 0,
};
const idle: LocalHistoryImportJobSnapshot = {
  status: 'idle',
  progress: null,
  result: null,
  log: [],
};
function session(
  agent: string,
  id: string,
  title: string,
  updated: string | null
) {
  return {
    agent_id: agent,
    external_session_id: id,
    title,
    workspace_path: 'C:/Work/imported',
    message_count: 3,
    updated_at: updated,
    status: 'new' as const,
  };
}
const history: LocalHistoryScanPage = {
  ...empty,
  folders: [
    {
      path: 'C:/Work/imported',
      name: 'imported',
      project_id: null,
      project_name: null,
      workspace_id: null,
      sessions: [session('codex', 'external-1', 'Build something', null)],
    },
  ],
  total_sessions: 1,
  importable_count: 1,
};
function setup(
  sources: string[] = ['codex'],
  active = true,
  onBack = vi.fn()
) {
  api.discoverLocalHistorySources.mockResolvedValue(sources);
  const onFinish = vi.fn().mockResolvedValue(undefined);
  render(
    <OnboardingHistoryImport
      active={active}
      sourceAgents={[
        {
          agentId: 'codex',
          displayName: 'Codex',
          description: '',
          iconLight: null,
          iconDark: null,
          iconSvg: null,
          recommended: true,
          builtIn: true,
          added: true,
          enabled: true,
          platformSupported: true,
          runtimeInstalled: true,
          lifecycle: 'ready',
          needsInstallation: false,
        },
        {
          agentId: 'claude_code',
          displayName: 'Claude Code',
          description: '',
          iconLight: null,
          iconDark: null,
          iconSvg: null,
          recommended: true,
          builtIn: true,
          added: true,
          enabled: true,
          platformSupported: true,
          runtimeInstalled: true,
          lifecycle: 'ready',
          needsInstallation: false,
        },
      ]}
      onBack={onBack}
      onFinish={onFinish}
    />
  );
  return onFinish;
}
describe('onboarding history import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.scanLocalHistory.mockResolvedValue(empty);
    api.localHistoryImportSnapshot.mockResolvedValue(idle);
    api.startLocalHistoryImport.mockResolvedValue({
      ...idle,
      status: 'running',
    });
    api.prepare.mockResolvedValue({
      projectIds: ['imported'],
      selections: [
        {
          agent_id: 'codex',
          external_session_id: 'external-1',
          workspace_id: 'real-workspace',
        },
      ],
    });
  });
  it('renders IPC-style object errors as readable messages instead of [object Object]', async () => {
    api.discoverLocalHistorySources.mockRejectedValue({
      message: 'Host unavailable',
      name: 'InvokeError',
    });
    const onFinish = vi.fn().mockResolvedValue(undefined);
    render(
      <OnboardingHistoryImport
        key="ipc-error"
        active
        sourceAgents={[
          {
            agentId: 'codex',
            displayName: 'Codex',
            description: '',
            iconLight: null,
            iconDark: null,
            iconSvg: null,
            recommended: true,
            builtIn: true,
            added: true,
            enabled: true,
            platformSupported: true,
            runtimeInstalled: true,
            lifecycle: 'ready',
            needsInstallation: false,
          },
        ]}
        onBack={vi.fn()}
        onFinish={onFinish}
      />
    );
    expect(await screen.findByText('Host unavailable')).toBeInTheDocument();
  });
  it('offers no sources and sends the user on when nothing is importable', async () => {
    const onBack = vi.fn();
    const finish = setup([], true, onBack);
    expect(await screen.findByText(t('noHistorySources'))).toBeInTheDocument();
    expect(api.scanLocalHistory).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: t('scanSelectedAgents') })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('skipImport') }));
    expect(finish).toHaveBeenCalledWith([]);
    expect(onBack).not.toHaveBeenCalled();
  });
  it('advances to the next step instead of going back when skipping import on the sources step', async () => {
    const onBack = vi.fn();
    const finish = setup(['codex'], true, onBack);
    await screen.findByRole('checkbox', { name: 'Codex' });
    fireEvent.click(screen.getByRole('button', { name: t('skipImport') }));
    expect(finish).toHaveBeenCalledWith([]);
    expect(onBack).not.toHaveBeenCalled();
  });
  it('only claims the onboarding title anchor while it is the visible step', async () => {
    setup(['codex'], false);
    await screen.findByRole('checkbox', { name: 'Codex' });
    expect(document.querySelectorAll('#onboarding-title')).toHaveLength(0);
  });
  it('scans only the Agents the user kept and groups their projects together', async () => {
    api.scanLocalHistory.mockImplementation(async (id: string) => ({
      ...history,
      folders: [
        {
          ...history.folders[0],
          path: id === 'codex' ? 'C:/Work/imported' : 'c:\\work\\imported',
          sessions: [
            session(id, `external-${id}`, id, new Date().toISOString()),
          ],
        },
      ],
    }));
    setup(['codex', 'claude_code']);
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Claude Code' })
    );
    fireEvent.click(
      screen.getByRole('button', { name: t('scanSelectedAgents') })
    );
    expect(
      await screen.findByRole('checkbox', { name: 'imported' })
    ).toBeInTheDocument();
    expect(api.scanLocalHistory).toHaveBeenCalledTimes(1);
    expect(api.scanLocalHistory.mock.calls[0][0]).toBe('codex');
    expect(screen.getAllByText('Codex').length).toBeGreaterThan(0);
  });
  it('keeps everything scanned selected and imports only the visible time range', async () => {
    api.scanLocalHistory.mockResolvedValue({
      ...history,
      folders: [
        {
          ...history.folders[0],
          sessions: [
            session('codex', 'recent', 'Recent', new Date().toISOString()),
            session(
              'codex',
              'older',
              'Older',
              new Date(Date.now() - 15 * 86_400_000).toISOString()
            ),
          ],
        },
      ],
    });
    const finish = setup();
    fireEvent.click(
      await screen.findByRole('button', { name: t('scanSelectedAgents') })
    );
    expect(
      await screen.findByRole('checkbox', { name: 'imported' })
    ).toHaveAttribute('aria-checked', 'true');
    // A single session folder is collapsed by default; the folder checkbox
    // still drives the whole project.
    fireEvent.click(
      screen.getByRole('radio', { name: t('historyRecentDays', { count: 7 }) })
    );
    fireEvent.click(
      screen.getByRole('button', { name: t('importAndContinue') })
    );
    expect(api.prepare).toHaveBeenCalled();
    expect([...api.prepare.mock.calls[0][1]]).toEqual(['codex:recent']);
    expect(finish).not.toHaveBeenCalled();
  });
  it('imports through the Host job and hands the imported projects forward', async () => {
    api.scanLocalHistory.mockResolvedValue(history);
    const finish = setup();
    fireEvent.click(
      await screen.findByRole('button', { name: t('scanSelectedAgents') })
    );
    const importButton = await screen.findByRole('button', {
      name: t('importAndContinue'),
    });
    fireEvent.click(importButton);
    await waitFor(() =>
      expect(api.startLocalHistoryImport).toBeCalled()
    );
    expect(api.startLocalHistoryImport).toHaveBeenCalledWith([
      {
        agent_id: 'codex',
        external_session_id: 'external-1',
        workspace_id: 'real-workspace',
      },
    ]);
    expect(
      screen.getByRole('button', { name: t('importAndContinue') })
    ).toBeDisabled();
    await act(async () =>
      api.listener?.({
        ...idle,
        status: 'completed',
        result: {
          imported: 1,
          skipped: 0,
          failed: 0,
          conversation_ids: ['conversation-1'],
          errors: [],
        },
      })
    );
    expect(finish).toHaveBeenCalledWith(['imported']);
  });
  it('keeps scan failures visible and lets the user retry the scan', async () => {
    api.scanLocalHistory
      .mockRejectedValueOnce(new Error('History unreadable'))
      .mockResolvedValue(history);
    setup();
    fireEvent.click(
      await screen.findByRole('button', { name: t('scanSelectedAgents') })
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('History unreadable');
    expect(alert).toHaveTextContent(t('scanIncomplete'));
    fireEvent.click(within(alert).getByRole('button', { name: t('retry') }));
    expect(
      await screen.findByRole('checkbox', { name: 'imported' })
    ).toBeInTheDocument();
    expect(screen.queryByText('History unreadable')).not.toBeInTheDocument();
    expect(api.scanLocalHistory).toHaveBeenCalledTimes(2);
  });
  it('keeps partial import failures on the review step for retry or skip', async () => {
    api.scanLocalHistory.mockResolvedValue(history);
    const finish = setup();
    fireEvent.click(
      await screen.findByRole('button', { name: t('scanSelectedAgents') })
    );
    fireEvent.click(
      await screen.findByRole('button', { name: t('importAndContinue') })
    );
    await waitFor(() =>
      expect(api.startLocalHistoryImport).toHaveBeenCalled()
    );
    await act(async () =>
      api.listener?.({
        ...idle,
        status: 'completed',
        result: {
          imported: 0,
          skipped: 0,
          failed: 1,
          conversation_ids: [],
          errors: ['Unreadable session'],
        },
      })
    );
    expect(await screen.findByText('Unreadable session')).toBeInTheDocument();
    expect(finish).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: t('importAndContinue') })
    ).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: t('skipImport') }));
    expect(finish).toHaveBeenCalledWith([]);
  });
  it('cancels a pending scan without reopening the review step', async () => {
    let resolveScan!: (value: LocalHistoryScanPage) => void;
    api.scanLocalHistory.mockReturnValue(
      new Promise((resolve) => {
        resolveScan = resolve;
      })
    );
    setup();
    fireEvent.click(
      await screen.findByRole('button', { name: t('scanSelectedAgents') })
    );
    await screen.findByText(t('scanningAgent'));
    fireEvent.click(screen.getByRole('button', { name: t('cancelScan') }));
    await screen.findByRole('checkbox', { name: 'Codex' });
    expect(screen.queryByText(t('scanningAgent'))).not.toBeInTheDocument();
    await act(async () => resolveScan(history));
    expect(
      screen.queryByRole('checkbox', { name: 'imported' })
    ).not.toBeInTheDocument();
  });
});
