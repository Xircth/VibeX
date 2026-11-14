import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalHistoryImportJobSnapshot, Project } from 'shared/types';
import i18n from '@/i18n';
import { OnboardingProjects } from './OnboardingProjects';

const api = vi.hoisted(() => ({
  getAll: vi.fn(),
  create: vi.fn(),
  scanLocalHistory: vi.fn(),
  startLocalHistoryImport: vi.fn(),
  localHistoryImportSnapshot: vi.fn(),
  prepare: vi.fn(),
  openProject: vi.fn(),
  clone: vi.fn(),
  listener: null as ((snapshot: LocalHistoryImportJobSnapshot) => void) | null,
}));
vi.mock('@/lib/api/projects', () => ({ projectsApi: api }));
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
vi.mock('@/components/dialogs/projects/ProjectFormDialog', () => ({
  ProjectFormDialog: { show: api.openProject },
}));
vi.mock('@/components/dialogs/projects/CloneRepoDialog', () => ({
  CloneRepoDialog: { show: api.clone },
}));
const t = (key: string) => i18n.t(`dialogs:onboarding.${key}`);
function project(id: string, home = false): Project {
  return {
    id,
    name: id,
    root_path: `C:/Work/${id}`,
    parent_project_id: null,
    hidden: false,
    is_home: home,
    is_git: false,
    default_agent_working_dir: null,
    default_main_branch: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}
const home = project('home', true);
const work = project('work');
const empty = {
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
const history = {
  ...empty,
  folders: [
    {
      path: 'C:/Work/imported',
      name: 'imported',
      project_id: null,
      project_name: null,
      workspace_id: null,
      sessions: [
        {
          agent_id: 'codex',
          external_session_id: 'external-1',
          title: 'Build something',
          workspace_path: 'C:/Work/imported',
          message_count: 3,
          updated_at: null,
          status: 'new',
        },
      ],
    },
  ],
  total_sessions: 1,
  importable_count: 1,
};
function setup(
  sources: string[] = [],
  onFinish = vi.fn().mockResolvedValue(undefined)
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <OnboardingProjects
          sourceAgentIds={sources}
          onBack={vi.fn()}
          onFinish={onFinish}
        />
      </QueryClientProvider>
    </StrictMode>
  );
  return onFinish;
}
describe('onboarding projects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getAll.mockResolvedValue([home, work]);
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
  it('skips import without installed sources and defaults Global while allowing multiple projects', async () => {
    const finish = setup();
    await screen.findByRole('checkbox', {
      name: i18n.t('app:welcomePage.globalProject'),
    });
    expect(
      screen.getByRole('checkbox', {
        name: i18n.t('app:welcomePage.globalProject'),
      })
    ).toHaveAttribute('aria-checked', 'true');
    expect(api.scanLocalHistory).not.toHaveBeenCalled();
    expect(screen.queryByText(t('importTitle'))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'work' }));
    fireEvent.click(screen.getByRole('button', { name: t('enterWorkspace') }));
    await waitFor(() => expect(finish).toHaveBeenCalledWith(['home', 'work']));
  });
  it('automatically skips empty Agent history under StrictMode', async () => {
    setup(['codex']);
    await screen.findByRole('button', { name: t('enterWorkspace') });
    expect(api.scanLocalHistory).toHaveBeenCalledTimes(1);
  });
  it('imports selected history through the Host job and selects imported projects', async () => {
    api.scanLocalHistory.mockResolvedValue(history);
    setup(['codex']);
    await screen.findByRole('heading', { name: t('importTitle') });
    fireEvent.click(
      screen.getByRole('button', { name: t('importAndContinue') })
    );
    await waitFor(() =>
      expect(api.startLocalHistoryImport).toHaveBeenCalledWith([
        {
          agent_id: 'codex',
          external_session_id: 'external-1',
          workspace_id: 'real-workspace',
        },
      ])
    );
    expect(
      screen.getByRole('button', { name: t('importAndContinue') })
    ).toBeDisabled();
    expect(
      screen.queryByRole('heading', { name: t('projectsTitle') })
    ).not.toBeInTheDocument();
    api.getAll.mockResolvedValue([home, work, project('imported')]);
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
    expect(
      await screen.findByRole('checkbox', { name: 'imported' })
    ).toHaveAttribute('aria-checked', 'true');
  });
  it('keeps scan failures visible and allows retry or continuing', async () => {
    api.scanLocalHistory.mockRejectedValueOnce(new Error('History unreadable'));
    setup(['codex']);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'History unreadable'
    );
    fireEvent.click(screen.getByRole('button', { name: t('retry') }));
    await screen.findByRole('button', { name: t('enterWorkspace') });
    expect(api.scanLocalHistory).toHaveBeenCalledTimes(2);
  });
  it('preserves completion received before the start response', async () => {
    api.scanLocalHistory.mockResolvedValue(history);
    api.startLocalHistoryImport.mockImplementation(async () => {
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
      });
      return { ...idle, status: 'running' };
    });
    setup(['codex']);
    fireEvent.click(
      await screen.findByRole('button', { name: t('importAndContinue') })
    );
    await waitFor(() => expect(api.startLocalHistoryImport).toHaveBeenCalled());
    await screen.findByRole('heading', { name: t('projectsTitle') });
  });
  it('keeps partial failures on import for retry or explicit skip', async () => {
    api.scanLocalHistory.mockResolvedValue(history);
    setup(['codex']);
    fireEvent.click(
      await screen.findByRole('button', { name: t('importAndContinue') })
    );
    await waitFor(() => expect(api.startLocalHistoryImport).toHaveBeenCalled());
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
    expect(
      screen.getByRole('heading', { name: t('importTitle') })
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: t('importAndContinue') })
      ).toBeEnabled()
    );
    fireEvent.click(
      screen.getByRole('button', { name: t('importAndContinue') })
    );
    await waitFor(() =>
      expect(api.startLocalHistoryImport).toHaveBeenCalledTimes(2)
    );
  });
  it('continues with no import job when every session is deselected', async () => {
    api.scanLocalHistory.mockResolvedValue(history);
    setup(['codex']);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'imported' }));
    fireEvent.click(screen.getByRole('button', { name: t('next') }));
    await screen.findByRole('heading', { name: t('projectsTitle') });
    expect(api.startLocalHistoryImport).not.toHaveBeenCalled();
  });
  it('selects newly created projects and cloned repositories', async () => {
    api.openProject.mockResolvedValue({
      status: 'saved',
      project: project('new-project'),
    });
    api.clone.mockResolvedValue({
      status: 'cloned',
      repo: { name: 'clone', display_name: 'clone', path: 'C:/Work/clone' },
    });
    api.create.mockResolvedValue(project('clone'));
    setup();
    await screen.findByRole('button', { name: t('enterWorkspace') });
    fireEvent.click(
      screen.getByRole('button', { name: t('projectAction.new') })
    );
    expect(
      await screen.findByRole('checkbox', { name: 'new-project' })
    ).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(
      screen.getByRole('button', { name: t('projectAction.clone') })
    );
    expect(
      await screen.findByRole('checkbox', { name: 'clone' })
    ).toHaveAttribute('aria-checked', 'true');
  });
  it('keeps project selection open when final persistence fails', async () => {
    setup([], vi.fn().mockRejectedValue(new Error('Disk full')));
    fireEvent.click(
      await screen.findByRole('button', { name: t('enterWorkspace') })
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Disk full');
    expect(
      screen.getByRole('button', { name: t('enterWorkspace') })
    ).toBeEnabled();
  });
});
