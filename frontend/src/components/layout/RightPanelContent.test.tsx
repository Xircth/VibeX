import { act, render, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerWorkspaceStageCreationHost } from '@/components/layout/workspaceStageCreationHost';
import {
  retainRightPanelHost,
  RightPanelSlotContext,
} from '@/contexts/RightPanelSlotContext';
import { requestWorkspaceCreateSessionOverlay } from '@/lib/requestCreateSession';
import { RightPanelContent } from './RightPanelContent';

const {
  kanbanSessionState,
  branchHeaderRenderSpy,
  conversationRenderSpy,
  openSessionTabMock,
} = vi.hoisted(() => ({
  kanbanSessionState: {
    activeViewId: 'board',
    visibleRightSession: {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
    } as { sessionId: string; workspaceId: string } | null,
    activateExecutionSession: vi.fn(),
    placeCreatedSession: vi.fn(),
    isRightSessionPending: false,
    lastActiveWorkspaceId: 'workspace-1' as string | null,
  },
  branchHeaderRenderSpy: vi.fn(),
  conversationRenderSpy: vi.fn(),
  openSessionTabMock: vi.fn(),
}));

vi.mock('@/components/layout/BranchInfoHeader', () => ({
  BranchInfoHeader: () => {
    branchHeaderRenderSpy();
    return <div data-testid="right-panel-branch-header" />;
  },
}));

vi.mock('@/components/kanban/KanbanSessionConversationView', () => ({
  KanbanSessionConversationView: (props: {
    workspaceId: string;
    sessionId?: string;
    markViewed?: boolean;
  }) => {
    conversationRenderSpy(props);
    return (
      <div
        data-testid="right-panel-conversation-view"
        data-session-id={props.sessionId ?? ''}
        data-workspace-id={props.workspaceId}
      />
    );
  },
}));

vi.mock('@/components/sessions/SessionCreationForm', () => ({
  SessionCreationForm: ({ title }: { title: string }) => (
    <div data-testid="session-creation-form">{title}</div>
  ),
}));

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({
    profiles: {
      CLAUDE_CODE: {
        DEFAULT: { CLAUDE_CODE: {} },
      },
    },
    config: {
      executor_profile: { executor: 'CLAUDE_CODE', variant: null },
      multi_agent_enabled: false,
    },
  }),
}));

vi.mock('@/contexts/KanbanSessionContext', () => ({
  useKanbanSessionContext: () => kanbanSessionState,
}));

vi.mock('@/contexts/WorktreeContext', () => ({
  useWorktree: () => ({
    activeWorktreeId: 'workspace-1',
    setActiveWorktree: vi.fn(),
  }),
}));

vi.mock('@/contexts/ProjectContext', () => ({
  useProject: () => ({
    projectId: 'project-1',
    project: { id: 'project-1', is_git: true },
  }),
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  usePanelActionsContext: () => ({
    openSessionTab: openSessionTabMock,
  }),
}));

vi.mock('@/contexts/WorkspaceOverlayContext', () => ({
  NativeSurfaceOcclusionHold: () => null,
}));

vi.mock('@/features/collaboration/space/SpaceStoreContext', () => ({
  useOptionalCollaborationSpaceStore: () => null,
}));

vi.mock('@/hooks', () => ({
  useProjectRepos: () => ({ data: [], isPending: false }),
  useProjectWorktrees: () => ({ worktrees: [], isLoading: false }),
  useRepoBranches: () => ({ data: [], isPending: false }),
  useRepoBranchSelection: () => ({
    configs: [],
    isLoading: false,
    isGitInitIncomplete: false,
    setRepoBranch: vi.fn(),
    getWorkspaceRepoInputs: () => [],
    reset: vi.fn(),
  }),
}));

vi.mock('@/hooks/useTaskAttempt', () => ({
  useTaskAttempt: () => ({ data: undefined }),
}));

vi.mock('@/hooks/useNavigateWithSearch', () => ({
  useNavigateWithSearch: () => vi.fn(),
}));

function TestHarness({
  children,
  initialEntry = '/projects/project-1/workspaces/workspace-1/sessions/session-1',
}: {
  children: React.ReactNode;
  initialEntry?: string;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/projects/:projectId/workspaces/:workspaceId/sessions/:sessionId"
            element={children}
          />
          <Route path="/projects/:projectId" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('RightPanelContent detached host deduplication', () => {
  beforeEach(() => {
    branchHeaderRenderSpy.mockReset();
    conversationRenderSpy.mockReset();
    openSessionTabMock.mockReset();
    kanbanSessionState.visibleRightSession = {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
    };
  });

  it('preserves standalone rendering when mounted directly without a detached slot host (host === null)', () => {
    render(
      <TestHarness>
        <RightPanelContent />
      </TestHarness>
    );

    expect(screen.getByTestId('right-panel-branch-header')).toBeInTheDocument();
    expect(
      screen.getByTestId('right-panel-conversation-view')
    ).toBeInTheDocument();
  });

  it('does not mount BranchInfoHeader or KanbanSessionConversationView while RightPanelSlotContext host is detached, yet still portals CreateSessionOverlay into stageCreationHost', () => {
    const detachedHost = document.createElement('div');
    const stageCreationHost = document.createElement('div');
    document.body.appendChild(stageCreationHost);
    const unregisterStageHost =
      registerWorkspaceStageCreationHost(stageCreationHost);

    try {
      const view = render(
        <TestHarness>
          <RightPanelSlotContext.Provider
            value={{ host: detachedHost, placement: 'workspace' }}
          >
            {createPortal(<RightPanelContent />, detachedHost)}
          </RightPanelSlotContext.Provider>
        </TestHarness>
      );

      // Zero duplicate mounts while detached in Free Tabs mode!
      expect(branchHeaderRenderSpy).not.toHaveBeenCalled();
      expect(conversationRenderSpy).not.toHaveBeenCalled();
      expect(
        detachedHost.querySelector(
          '[data-testid="right-panel-conversation-view"]'
        )
      ).toBeNull();

      // Requesting session creation still portals CreateSessionOverlay into stageCreationHost!
      act(() => {
        requestWorkspaceCreateSessionOverlay('right-group');
      });
      expect(
        stageCreationHost.querySelector('[data-testid="session-creation-form"]')
      ).not.toBeNull();

      // Attaching the host (e.g. KanbanSessionSlot or unbound ai-chat panel) mounts header + conversation.
      let releaseHost!: () => void;
      act(() => {
        document.body.appendChild(detachedHost);
        releaseHost = retainRightPanelHost(detachedHost);
      });

      expect(
        detachedHost.querySelector('[data-testid="right-panel-branch-header"]')
      ).not.toBeNull();
      expect(
        detachedHost.querySelector(
          '[data-testid="right-panel-conversation-view"]'
        )
      ).not.toBeNull();

      // Releasing the host unmounts header + conversation again.
      act(() => {
        releaseHost();
        detachedHost.remove();
      });

      expect(
        detachedHost.querySelector('[data-testid="right-panel-branch-header"]')
      ).toBeNull();
      expect(
        detachedHost.querySelector(
          '[data-testid="right-panel-conversation-view"]'
        )
      ).toBeNull();

      view.unmount();
    } finally {
      unregisterStageHost();
      stageCreationHost.remove();
    }
  });

  it('also suppresses detached rendering when portaled as a sibling outside RightPanelSlotContext.Provider (IDELayout portal topology)', () => {
    const detachedHost = document.createElement('div');

    render(
      <TestHarness>
        <>
          <RightPanelSlotContext.Provider
            value={{ host: detachedHost, placement: 'workspace' }}
          >
            <div data-testid="stage-sibling" />
          </RightPanelSlotContext.Provider>
          {createPortal(<RightPanelContent />, detachedHost)}
        </>
      </TestHarness>
    );

    expect(
      detachedHost.querySelector('[data-testid="right-panel-branch-header"]')
    ).toBeNull();
    expect(
      detachedHost.querySelector(
        '[data-testid="right-panel-conversation-view"]'
      )
    ).toBeNull();

    let releaseHost!: () => void;
    act(() => {
      document.body.appendChild(detachedHost);
      releaseHost = retainRightPanelHost(detachedHost);
    });

    expect(
      detachedHost.querySelector(
        '[data-testid="right-panel-conversation-view"]'
      )
    ).not.toBeNull();

    act(() => {
      releaseHost();
      detachedHost.remove();
    });

    expect(
      detachedHost.querySelector(
        '[data-testid="right-panel-conversation-view"]'
      )
    ).toBeNull();
  });
});
