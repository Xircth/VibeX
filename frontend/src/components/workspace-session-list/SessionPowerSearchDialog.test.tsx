import { fireEvent, render, screen } from '@testing-library/react';
import { Theme as AstryxTheme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ThemeMode } from 'shared/types';
import {
  filterSessionListPreferences,
  INACTIVE_SESSION_THRESHOLD_MS,
  isSessionInactiveForSevenDays,
} from '@/lib/sessionListFilters';
import {
  ANY_BOT_FILTER_VALUE,
  matchesPowerSearchFilters,
  NO_BOT_FILTER_VALUE,
  SessionPowerSearchDialog,
} from './SessionPowerSearchDialog';

vi.mock('@/features/conversation/conversationApi', () => ({
  conversationApi: {
    search: vi.fn().mockResolvedValue([]),
  },
}));

function makeSession(
  overrides: Partial<KanbanProjectSessionRecord> & {
    id: string;
    workspaceId?: string;
    useWorktree?: boolean;
  }
): KanbanProjectSessionRecord {
  const workspaceId = overrides.workspaceId ?? 'ws-worktree';
  const useWorktree = overrides.useWorktree ?? true;
  return {
    id: overrides.id,
    placement: { sessionId: overrides.id, workspaceId },
    workspace: {
      id: workspaceId,
      project_id: 'proj-1',
      task_id: 'task-1',
      parent_workspace_id: null,
      container_ref: null,
      branch: overrides.branch ?? 'feat/search',
      use_worktree: useWorktree,
      agent_working_dir: null,
      setup_completed_at: null,
      created_at: '2026-11-10T00:00:00Z',
      updated_at: '2026-11-10T00:00:00Z',
      archived: false,
      pinned: false,
      name: overrides.workspaceName ?? 'feat-search',
    },
    task: null,
    taskId: 'task-1',
    name: overrides.name ?? 'Implement global search',
    status: overrides.status ?? 'inprogress',
    branch: overrides.branch ?? 'feat/search',
    workspaceName: overrides.workspaceName ?? 'feat-search',
    workspaceDisplayLabel: overrides.workspaceDisplayLabel ?? 'feat-search',
    executor: overrides.executor ?? 'claude_code',
    agentId: overrides.agentId ?? 'claude_code',
    updatedAt: overrides.updatedAt ?? '2026-11-11T04:00:00Z',
    createdAt: overrides.createdAt ?? '2026-11-10T00:00:00Z',
    firstPrompt: overrides.firstPrompt ?? null,
    model: overrides.model ?? null,
    fullName: overrides.fullName ?? overrides.name ?? 'Implement global search',
    shortName: overrides.shortName ?? 'Impleme',
    taskTitle: overrides.taskTitle ?? null,
    isCompleted: overrides.isCompleted ?? false,
    isRunning: overrides.isRunning ?? false,
    isErrored: overrides.isErrored ?? false,
    pinnedAt: overrides.pinnedAt ?? null,
    collaboration: overrides.collaboration ?? null,
  };
}

describe('sessionListFilters', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const recentIso = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const staleIso = new Date(
    now - INACTIVE_SESSION_THRESHOLD_MS - 60_000
  ).toISOString();

  it('filters default workspace, Bot sessions, and 7-day inactive non-running sessions', () => {
    const defaultWsSession = makeSession({
      id: 's-default',
      workspaceId: 'ws-main',
      useWorktree: false,
      updatedAt: recentIso,
    });
    const botSession = makeSession({
      id: 's-bot',
      updatedAt: recentIso,
      collaboration: {
        memberId: 'm-1',
        memberName: 'UI设计师',
        threadId: 'direct:1',
        threadKind: 'direct',
        threadName: 'UI设计师',
      },
    });
    const staleIdleSession = makeSession({
      id: 's-stale',
      updatedAt: staleIso,
      isRunning: false,
    });
    const staleRunningSession = makeSession({
      id: 's-stale-running',
      updatedAt: staleIso,
      isRunning: true,
    });
    const activeWorktreeSession = makeSession({
      id: 's-active',
      updatedAt: recentIso,
    });

    const all = [
      defaultWsSession,
      botSession,
      staleIdleSession,
      staleRunningSession,
      activeWorktreeSession,
    ];

    expect(isSessionInactiveForSevenDays(staleIdleSession, now)).toBe(true);
    expect(isSessionInactiveForSevenDays(staleRunningSession, now)).toBe(false);

    expect(
      filterSessionListPreferences(all, {
        hideDefaultWorkspace: true,
        hideBotSessions: false,
        hideInactiveSessions: false,
        now,
      }).map((s) => s.id)
    ).toEqual(['s-bot', 's-stale', 's-stale-running', 's-active']);

    expect(
      filterSessionListPreferences(all, {
        hideDefaultWorkspace: false,
        hideBotSessions: true,
        hideInactiveSessions: false,
        now,
      }).map((s) => s.id)
    ).toEqual(['s-default', 's-stale', 's-stale-running', 's-active']);

    expect(
      filterSessionListPreferences(all, {
        hideDefaultWorkspace: true,
        hideBotSessions: true,
        hideInactiveSessions: true,
        now,
      }).map((s) => s.id)
    ).toEqual(['s-stale-running', 's-active']);
  });
});

describe('matchesPowerSearchFilters', () => {
  const botSession = makeSession({
    id: 's-bot',
    name: 'Polish toolbar icons',
    status: 'inreview',
    workspaceId: 'ws-ui',
    workspaceDisplayLabel: 'feat/ui-polish',
    executor: 'antigravity',
    agentId: 'antigravity',
    collaboration: {
      memberId: 'm-ui',
      memberName: 'UI设计师',
      threadId: 'direct:1',
      threadKind: 'direct',
      threadName: 'UI设计师',
    },
  });

  const codeSession = makeSession({
    id: 's-code',
    name: 'Refactor query cache',
    status: 'done',
    workspaceId: 'ws-core',
    workspaceDisplayLabel: 'feat/core',
    executor: 'codex',
    agentId: 'codex',
    collaboration: null,
  });

  it('evaluates status, worktree, bot, agent, and live text filters', () => {
    expect(
      matchesPowerSearchFilters(botSession, [
        {
          field: 'status',
          operator: 'is',
          value: { type: 'enum', value: 'inreview' },
        },
      ])
    ).toBe(true);
    expect(
      matchesPowerSearchFilters(codeSession, [
        {
          field: 'status',
          operator: 'is',
          value: { type: 'enum', value: 'inreview' },
        },
      ])
    ).toBe(false);

    expect(
      matchesPowerSearchFilters(botSession, [
        {
          field: 'worktree',
          operator: 'is',
          value: { type: 'enum', value: 'ws-ui' },
        },
      ])
    ).toBe(true);

    expect(
      matchesPowerSearchFilters(botSession, [
        {
          field: 'bot',
          operator: 'is',
          value: { type: 'enum', value: ANY_BOT_FILTER_VALUE },
        },
      ])
    ).toBe(true);
    expect(
      matchesPowerSearchFilters(codeSession, [
        {
          field: 'bot',
          operator: 'is',
          value: { type: 'enum', value: NO_BOT_FILTER_VALUE },
        },
      ])
    ).toBe(true);
    expect(
      matchesPowerSearchFilters(botSession, [
        {
          field: 'bot',
          operator: 'is',
          value: { type: 'enum', value: 'UI设计师' },
        },
      ])
    ).toBe(true);

    expect(
      matchesPowerSearchFilters(codeSession, [
        {
          field: 'agent',
          operator: 'is',
          value: { type: 'enum', value: 'codex' },
        },
      ])
    ).toBe(true);

    expect(
      matchesPowerSearchFilters(codeSession, [], { liveQuery: 'cache' })
    ).toBe(true);
    expect(
      matchesPowerSearchFilters(botSession, [], { liveQuery: 'cache' })
    ).toBe(false);
  });
});

describe('SessionPowerSearchDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderDialog(
    props: Partial<Parameters<typeof SessionPowerSearchDialog>[0]> = {}
  ) {
    const sessions = props.sessions ?? [
      makeSession({
        id: 's-1',
        name: 'First Session',
        updatedAt: '2026-11-11T05:00:00Z',
      }),
      makeSession({
        id: 's-2',
        name: 'Second Session',
        updatedAt: '2026-11-11T04:00:00Z',
      }),
    ];
    const onOpenChange = props.onOpenChange ?? vi.fn();
    const onSelectSession = props.onSelectSession ?? vi.fn();

    return {
      onOpenChange,
      onSelectSession,
      ...render(
        <ThemeProvider initialTheme={ThemeMode.LIGHT}>
          <AstryxTheme theme={neutralTheme} mode="light">
            <SessionPowerSearchDialog
              open={props.open ?? true}
              onOpenChange={onOpenChange}
              sessions={sessions}
              activeSessionId={props.activeSessionId ?? null}
              onSelectSession={onSelectSession}
            />
          </AstryxTheme>
        </ThemeProvider>
      ),
    };
  }

  it('renders Astryx PowerSearch input, shortcut hints, and navigates/opens sessions with keyboard', () => {
    const { onOpenChange, onSelectSession } = renderDialog();

    const dialog = screen.getByRole('dialog', { name: '全局搜索会话' });
    expect(dialog).toBeInTheDocument();

    const combobox = screen.getByRole('combobox');
    expect(combobox).toBeInTheDocument();

    expect(screen.getByText('进入')).toBeInTheDocument();
    expect(screen.getByText('打开')).toBeInTheDocument();
    expect(screen.getByText('Esc键')).toBeInTheDocument();
    expect(screen.getByText('关闭')).toBeInTheDocument();
    expect(screen.getByText('↑↓')).toBeInTheDocument();
    expect(screen.getByText('移动')).toBeInTheDocument();
    expect(screen.getByText('Tab')).toBeInTheDocument();
    expect(screen.getByText('筛选')).toBeInTheDocument();

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(dialog, { key: 'ArrowDown' });
    expect(options[1]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(onSelectSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's-2' })
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes on Escape when no filter popover is open', () => {
    const { onOpenChange } = renderDialog({ sessions: [] });

    expect(screen.getByText('暂无可搜索的会话')).toBeInTheDocument();
    const dialog = screen.getByRole('dialog', { name: '全局搜索会话' });

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
