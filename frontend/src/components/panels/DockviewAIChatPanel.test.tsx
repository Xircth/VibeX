import { useSyncExternalStore } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getRightPanelHostConsumerCount,
  RightPanelSlotContext,
} from '@/contexts/RightPanelSlotContext';
import DockviewAIChatPanel, {
  type SessionTabPanelParams,
} from './DockviewAIChatPanel';
import { resetDockviewPanelKeepAliveStore } from './workspaceTabKeepAlive';

type MockProjectSession = {
  id: string;
  name: string | null;
  executor: string | null;
  taskId?: string | null;
};

const {
  projectState,
  kanbanSessionsStore,
  replaceRightSessionMock,
  setActiveWorktreeMock,
  openSessionTabMock,
  conversationRenderSpy,
  branchHeaderRenderSpy,
} = vi.hoisted(() => {
  let sessions: MockProjectSession[] = [];
  const listeners = new Set<() => void>();
  return {
    projectState: {
      projectId: 'project-1',
      project: { id: 'project-1', is_git: true },
    },
    kanbanSessionsStore: {
      getSessions: () => sessions,
      setSessions: (next: MockProjectSession[]) => {
        sessions = next;
        for (const listener of listeners) {
          listener();
        }
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    replaceRightSessionMock: vi.fn(),
    setActiveWorktreeMock: vi.fn(),
    openSessionTabMock: vi.fn(),
    conversationRenderSpy: vi.fn(),
    branchHeaderRenderSpy: vi.fn(),
  };
});

vi.mock('@/contexts/ProjectContext', () => ({
  useOptionalProject: () => projectState,
}));

vi.mock('@/contexts/KanbanSessionContext', () => ({
  useOptionalKanbanSessionContext: () => ({
    replaceRightSession: replaceRightSessionMock,
  }),
}));

vi.mock('@/contexts/WorktreeContext', () => ({
  useOptionalWorktree: () => ({
    activeWorktreeId: 'workspace-initial',
    setActiveWorktree: setActiveWorktreeMock,
  }),
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  usePanelActionsContext: () => ({
    openSessionTab: openSessionTabMock,
  }),
}));

vi.mock('@/hooks/useKanbanProjectSessions', () => ({
  useKanbanProjectSessions: () => ({
    sessions: useSyncExternalStore(
      kanbanSessionsStore.subscribe,
      kanbanSessionsStore.getSessions
    ),
  }),
}));

vi.mock(
  '@/components/workspace-session-list/workspaceSessionListModel',
  () => ({
    sessionListTitle: (session: { name?: string | null; id: string }) =>
      session.name ?? session.id,
  })
);

vi.mock('@/components/kanban/session-hub/utils', () => ({
  sessionListAgentKey: (session: { executor?: string | null }) =>
    session.executor ?? null,
}));

vi.mock('@/components/layout/BranchInfoHeader', () => ({
  BranchInfoHeader: ({ workspaceId }: { workspaceId?: string }) => {
    branchHeaderRenderSpy(workspaceId);
    return (
      <div
        data-testid={`branch-header-${workspaceId ?? 'default'}`}
        data-workspace-id={workspaceId}
      />
    );
  },
}));

vi.mock('@/components/kanban/KanbanSessionConversationView', () => ({
  KanbanSessionConversationView: (props: {
    sessionId?: string;
    workspaceId: string;
    markViewed?: boolean;
  }) => {
    conversationRenderSpy(props);
    return (
      <div
        data-testid={`conversation-view-${props.sessionId ?? 'unbound'}`}
        data-mark-viewed={String(Boolean(props.markViewed))}
      />
    );
  },
}));

interface MockDockviewTabApi {
  api: IDockviewPanelProps<SessionTabPanelParams>['api'];
  setVisible: (visible: boolean) => void;
  setActive: (active: boolean) => void;
  setTitleSpy: ReturnType<typeof vi.fn>;
  updateParametersSpy: ReturnType<typeof vi.fn>;
}

function createPanelApi(
  id: string,
  options?: { isVisible?: boolean; isActive?: boolean; groupId?: string }
): MockDockviewTabApi {
  let visible = options?.isVisible ?? true;
  let active = options?.isActive ?? visible;
  let title = '';
  let params: SessionTabPanelParams = {};
  const visibilityListeners = new Set<
    (event: { isVisible: boolean }) => void
  >();
  const activeListeners = new Set<(event: { isActive: boolean }) => void>();
  const setTitleSpy = vi.fn((nextTitle: string) => {
    title = nextTitle;
  });
  const updateParametersSpy = vi.fn((nextParams: SessionTabPanelParams) => {
    params = { ...params, ...nextParams };
  });

  const api = {
    id,
    get isVisible() {
      return visible;
    },
    get isActive() {
      return active;
    },
    get title() {
      return title;
    },
    group: { id: options?.groupId ?? 'right-group' },
    setTitle: setTitleSpy,
    getParameters: () => params,
    updateParameters: updateParametersSpy,
    onDidVisibilityChange: (
      listener: (event: { isVisible: boolean }) => void
    ) => {
      visibilityListeners.add(listener);
      return {
        dispose: () => {
          visibilityListeners.delete(listener);
        },
      };
    },
    onDidActiveChange: (listener: (event: { isActive: boolean }) => void) => {
      activeListeners.add(listener);
      return {
        dispose: () => {
          activeListeners.delete(listener);
        },
      };
    },
  } as unknown as IDockviewPanelProps<SessionTabPanelParams>['api'];

  return {
    api,
    setVisible(nextVisible: boolean) {
      visible = nextVisible;
      for (const listener of visibilityListeners) {
        listener({ isVisible: nextVisible });
      }
    },
    setActive(nextActive: boolean) {
      active = nextActive;
      for (const listener of activeListeners) {
        listener({ isActive: nextActive });
      }
    },
    setTitleSpy,
    updateParametersSpy,
  };
}

function renderChatPanel(
  controller: MockDockviewTabApi,
  params: SessionTabPanelParams = {},
  slotValue?: { host: HTMLElement | null; placement: 'workspace' | 'kanban' }
) {
  const element = (
    <DockviewAIChatPanel
      api={controller.api}
      containerApi={
        {} as IDockviewPanelProps<SessionTabPanelParams>['containerApi']
      }
      params={params}
    />
  );

  if (!slotValue) {
    return render(element);
  }

  return render(
    <RightPanelSlotContext.Provider value={slotValue}>
      {element}
    </RightPanelSlotContext.Provider>
  );
}

describe('DockviewAIChatPanel', () => {
  beforeEach(() => {
    resetDockviewPanelKeepAliveStore();
    projectState.project = { id: 'project-1', is_git: true };
    kanbanSessionsStore.setSessions([]);
    replaceRightSessionMock.mockReset();
    setActiveWorktreeMock.mockReset();
    openSessionTabMock.mockReset();
    conversationRenderSpy.mockReset();
    branchHeaderRenderSpy.mockReset();
  });

  afterEach(() => {
    cleanup();
    resetDockviewPanelKeepAliveStore();
  });

  it('retains the shared RightPanelSlotContext host only for unbound workspace ai-chat panels', () => {
    const host = document.createElement('div');
    host.setAttribute('data-testid', 'shared-session-host');

    const unboundController = createPanelApi('ai-chat');
    const unboundView = renderChatPanel(
      unboundController,
      {},
      { host, placement: 'workspace' }
    );

    expect(getRightPanelHostConsumerCount(host)).toBe(1);
    expect(screen.getByTestId('shared-session-host')).toBeInTheDocument();

    unboundView.unmount();
    expect(getRightPanelHostConsumerCount(host)).toBe(0);

    // Bound session tabs render their own WorkspaceSessionTabContent and NEVER attach `host`.
    const boundController = createPanelApi('ai-chat:session-1');
    const boundView = renderChatPanel(
      boundController,
      { sessionId: 'session-1', workspaceId: 'workspace-1' },
      { host, placement: 'workspace' }
    );

    expect(getRightPanelHostConsumerCount(host)).toBe(0);
    expect(host.isConnected).toBe(false);
    expect(
      screen.getByTestId('conversation-view-session-1')
    ).toBeInTheDocument();
    expect(
      boundView.container.querySelector('.workspace-right-panel')
    ).toHaveClass('relative');

    boundView.unmount();
  });

  it('keeps 5 recent hidden session tabs warm without BranchInfoHeader or markViewed, hibernates older tabs, and wakes immediately', () => {
    const tabs = Array.from({ length: 7 }, (_, index) => {
      const sessionId = `session-${index + 1}`;
      const workspaceId = `workspace-${index + 1}`;
      const controller = createPanelApi(`ai-chat:${sessionId}`, {
        isVisible: true,
        isActive: true,
      });
      return { sessionId, workspaceId, controller };
    });

    // Open tabs 1..7 sequentially so tabs 1..6 become hidden and tab 7 remains visible.
    const views = tabs.map((tab, index) => {
      if (index > 0) {
        act(() => {
          tabs[index - 1].controller.setActive(false);
          tabs[index - 1].controller.setVisible(false);
        });
      }
      return renderChatPanel(tab.controller, {
        sessionId: tab.sessionId,
        workspaceId: tab.workspaceId,
      });
    });

    // Active visible tab (session-7): BranchInfoHeader mounted + conversation mounted with markViewed=true.
    expect(screen.getByTestId('branch-header-workspace-7')).toBeInTheDocument();
    expect(screen.getByTestId('conversation-view-session-7')).toHaveAttribute(
      'data-mark-viewed',
      'true'
    );

    // Warm hidden tabs (session-2..session-6): conversation stays mounted with markViewed=false, BranchInfoHeader unmounted!
    for (let index = 2; index <= 6; index += 1) {
      expect(
        screen.queryByTestId(`branch-header-workspace-${index}`)
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId(`conversation-view-session-${index}`)
      ).toHaveAttribute('data-mark-viewed', 'false');
    }

    // 6th hidden tab (session-1): hibernated placeholder rendered, heavy conversation unmounted.
    expect(
      screen.queryByTestId('conversation-view-session-1')
    ).not.toBeInTheDocument();
    expect(
      views[0].container.querySelector('[data-testid="hibernated-session-tab"]')
    ).not.toBeNull();

    // Keep lightweight title/agent parameter sync active even while session-1 is hibernated!
    act(() => {
      kanbanSessionsStore.setSessions([
        {
          id: 'session-1',
          name: 'Renamed While Hibernated',
          executor: 'CLAUDE_CODE',
          taskId: 'task-1',
        },
      ]);
    });
    expect(tabs[0].controller.setTitleSpy).toHaveBeenCalledWith(
      'Renamed While Hibernated'
    );
    expect(tabs[0].controller.updateParametersSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        agentId: 'CLAUDE_CODE',
      })
    );

    // Clicking hibernated session-1 wakes it immediately with BranchInfoHeader and markViewed=true,
    // and evicts session-2 (now the 6th hidden tab).
    act(() => {
      tabs[6].controller.setActive(false);
      tabs[6].controller.setVisible(false);
      tabs[0].controller.setVisible(true);
      tabs[0].controller.setActive(true);
    });

    expect(screen.getByTestId('branch-header-workspace-1')).toBeInTheDocument();
    expect(screen.getByTestId('conversation-view-session-1')).toHaveAttribute(
      'data-mark-viewed',
      'true'
    );
    expect(
      views[0].container.querySelector('[data-testid="hibernated-session-tab"]')
    ).toBeNull();
    expect(
      screen.queryByTestId('conversation-view-session-2')
    ).not.toBeInTheDocument();
  });

  it('keeps both side-by-side split-column visible tabs mounted without consuming warm hidden slots', () => {
    const splitLeft = createPanelApi('ai-chat:split-left', {
      isVisible: true,
      isActive: true,
      groupId: 'right-group-1',
    });
    const splitRight = createPanelApi('ai-chat:split-right', {
      isVisible: true,
      isActive: true,
      groupId: 'right-group-2',
    });

    renderChatPanel(splitLeft, {
      sessionId: 'split-left',
      workspaceId: 'workspace-left',
    });
    renderChatPanel(splitRight, {
      sessionId: 'split-right',
      workspaceId: 'workspace-right',
    });

    for (let index = 1; index <= 5; index += 1) {
      const hidden = createPanelApi(`ai-chat:warm-${index}`, {
        isVisible: false,
        isActive: false,
      });
      renderChatPanel(hidden, {
        sessionId: `warm-${index}`,
        workspaceId: `workspace-warm-${index}`,
      });
    }

    // Both visible split tabs AND all 5 warm hidden tabs stay mounted simultaneously (7 total).
    expect(screen.getByTestId('conversation-view-split-left')).toHaveAttribute(
      'data-mark-viewed',
      'true'
    );
    expect(screen.getByTestId('conversation-view-split-right')).toHaveAttribute(
      'data-mark-viewed',
      'true'
    );
    expect(
      screen.getByTestId('branch-header-workspace-left')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('branch-header-workspace-right')
    ).toBeInTheDocument();
    for (let index = 1; index <= 5; index += 1) {
      expect(
        screen.getByTestId(`conversation-view-warm-${index}`)
      ).toHaveAttribute('data-mark-viewed', 'false');
    }
  });

  it('pins actively running hidden session tabs so background streams are never evicted beyond 5 hidden tabs', () => {
    kanbanSessionsStore.setSessions([
      {
        id: 'streaming-session',
        isRunning: true,
        status: 'inprogress',
        pinnedAt: null,
        taskId: null,
      } as never,
    ]);

    const streamingTab = createPanelApi('ai-chat:streaming-session', {
      isVisible: false,
      isActive: false,
    });
    renderChatPanel(streamingTab, {
      sessionId: 'streaming-session',
      workspaceId: 'workspace-stream',
    });

    for (let index = 1; index <= 6; index += 1) {
      const idleHidden = createPanelApi(`ai-chat:idle-${index}`, {
        isVisible: false,
        isActive: false,
      });
      renderChatPanel(idleHidden, {
        sessionId: `idle-${index}`,
        workspaceId: `workspace-idle-${index}`,
      });
    }

    // Streaming tab remains mounted despite 6 newer hidden tabs; oldest idle tab hibernates.
    expect(
      screen.getByTestId('conversation-view-streaming-session')
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('conversation-view-idle-1')
    ).not.toBeInTheDocument();
  });
});
