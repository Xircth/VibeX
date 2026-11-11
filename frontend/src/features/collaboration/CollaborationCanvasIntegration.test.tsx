import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CanvasPanelHeaderSlotContext } from '@/components/kanban/canvas/CanvasPanelHeaderSlotContext';
import { registerCanvasWorkspaceController } from '@/components/kanban/canvas/canvasWorkspaceBridge';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { renderWithQueryClient as render } from '@/test/QueryClientHarness';
import { useCollaborationLayoutStore } from './collaborationLayoutStore';
import { CollaborationSpaceLayout } from './CollaborationSpacePage';
import { resetSharedSpaceComposerDrafts } from './spaceComposerDrafts';
import { CollaborationSpaceProvider } from './space/SpaceContext';
import WorkspaceBotsDockPanel from './WorkspaceBotsDockPanel';

const collaborationCall = vi.hoisted(() => vi.fn());

vi.mock('./collaborationApi', () => ({
  COLLABORATION_SPACE_CHANGED_EVENT: 'vibex://collaboration-space-changed',
  collaborationCall,
  currentWindowLabel: vi.fn(async () => 'main'),
  listenCollaborationSpaceChanged: vi.fn(async () => () => undefined),
}));

vi.mock('@/lib/backendTransport', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/backendTransport')>();
  return {
    ...actual,
    backendListen: vi.fn(async () => () => undefined),
  };
});

vi.mock('@/hooks/useAttemptRepo', () => ({
  useAttemptRepo: () => ({ repos: [] }),
}));

vi.mock('@/features/conversation/useConversationTimeline', () => ({
  useConversationTimeline: () => ({
    timeline: [],
    items: [],
    sideRows: [],
    sessionConfigOptions: [],
    currentTurnId: null,
    respondPermission: vi.fn(),
  }),
  useConversationSessionFacts: () => ({
    sessionId: 'conv-1',
    hasDetail: true,
    error: null,
    title: 'Bot 会话',
    status: null,
    agentId: 'CLAUDE_CODE',
    model: 'claude-sonnet-4',
    acpSessionId: null,
    externalSessionId: null,
    turnInFlight: false,
    sessionStats: null,
  }),
}));

describe('Collaboration canvas integration', () => {
  const dropPanelAt = vi.fn();
  let unregisterController: (() => void) | null = null;
  let canvasSurface: HTMLDivElement | null = null;
  const originalElementsFromPoint = document.elementsFromPoint;
  const originalElementFromPoint = document.elementFromPoint;

  beforeEach(() => {
    localStorage.clear();
    resetSharedSpaceComposerDrafts();
    useCollaborationLayoutStore.getState().resetCollaborationLayout();
    dropPanelAt.mockReset();
    collaborationCall.mockReset();
    collaborationCall.mockImplementation(
      async (_ns: string, method: string) => {
        if (method === 'thread.listSidebar') {
          return {
            supervisor_member_id: 'mem-sup',
            items: [
              {
                thread_id: 'direct:mem-sup',
                kind: 'dm',
                space_id: 'unassigned:ws-1',
                name: 'Master',
                unread_count: 0,
                member: {
                  member_id: 'mem-sup',
                  identity_member_id: 'mem-sup',
                  conversation_id: 'conv-sup',
                  name: 'Master',
                  agent: 'claude-code',
                  is_supervisor: true,
                },
              },
              {
                thread_id: 'direct:mem-bot',
                kind: 'dm',
                space_id: 'unassigned:ws-1',
                name: 'Pixel',
                unread_count: 0,
                member: {
                  member_id: 'mem-bot',
                  identity_member_id: 'mem-bot',
                  conversation_id: 'conv-bot',
                  name: 'Pixel',
                  agent: 'claude-code',
                  is_supervisor: false,
                },
              },
              {
                thread_id: 'space-design',
                kind: 'group',
                space_id: 'space-design',
                name: '设计协作群',
                unread_count: 0,
                member_count: 2,
                members_preview: [
                  {
                    member_id: 'mem-sup',
                    identity_member_id: 'mem-sup',
                    conversation_id: 'conv-sup',
                    name: 'Master',
                    agent: 'claude-code',
                  },
                  {
                    member_id: 'mem-bot',
                    identity_member_id: 'mem-bot',
                    conversation_id: 'conv-bot',
                    name: 'Pixel',
                    agent: 'claude-code',
                  },
                ],
              },
            ],
          };
        }
        if (method === 'space.list') {
          return {
            spaces: [{ space_id: 'space-design', name: '设计协作群' }],
          };
        }
        if (method === 'space.listMembers') {
          return {
            members: [
              {
                member_id: 'mem-sup',
                conversation_id: 'conv-sup',
                nickname: 'Master',
                kind: 'agent',
              },
              {
                member_id: 'mem-bot',
                conversation_id: 'conv-bot',
                nickname: 'Pixel',
                kind: 'agent',
              },
            ],
          };
        }
        if (method === 'contactGroup.list') {
          return { groups: [] };
        }
        if (method === 'space.listConversations') {
          return { conversations: [] };
        }
        if (method === 'role.list') {
          return { roles: [] };
        }
        if (method === 'role.agents') {
          return { agents: [] };
        }
        return { messages: [], scheduled: [], cards: [] };
      }
    );

    unregisterController = registerCanvasWorkspaceController({
      openOrFocusSession: vi.fn(),
      dropSessionAt: vi.fn(),
      openOrFocusPanel: vi.fn(),
      dropPanelAt,
      closeNode: vi.fn(),
      closeOtherNodes: vi.fn(),
      closeAllNodes: vi.fn(),
      duplicateNode: vi.fn(),
    });
    canvasSurface = document.createElement('div');
    canvasSurface.className = 'canvas-surface';
    document.body.appendChild(canvasSurface);
    document.elementsFromPoint = vi.fn(() => [canvasSurface!]);
    document.elementFromPoint = vi.fn(() => canvasSurface);
  });

  afterEach(() => {
    unregisterController?.();
    unregisterController = null;
    canvasSurface?.remove();
    canvasSurface = null;
    document.elementsFromPoint = originalElementsFromPoint;
    document.elementFromPoint = originalElementFromPoint;
  });

  it('portals MemberPanel into the canvas Space node header slot and removes the inner overlay bar', async () => {
    const headerSlot = document.createElement('div');
    headerSlot.setAttribute('data-testid', 'canvas-space-header-slot');
    document.body.appendChild(headerSlot);

    const { container } = render(
      <HotkeysProvider>
        <TooltipProvider>
          <CanvasPanelHeaderSlotContext.Provider value={headerSlot}>
            <CollaborationSpaceProvider
              workspaceId="ws-1"
              initialTarget={{
                targetType: 'group',
                spaceId: 'space-design',
                spaceName: '设计协作群',
                threadId: 'space-design',
              }}
            >
              <CollaborationSpaceLayout hideSpacesPane />
            </CollaborationSpaceProvider>
          </CanvasPanelHeaderSlotContext.Provider>
        </TooltipProvider>
      </HotkeysProvider>
    );

    await waitFor(() => {
      const portaledBar = headerSlot.querySelector(
        '[data-testid="collaboration-top-member-bar"]'
      );
      expect(portaledBar).not.toBeNull();
      expect(portaledBar).toHaveClass('is-canvas-header');
      expect(headerSlot.textContent).toContain('Master');
      expect(headerSlot.textContent).toContain('Pixel');
    });

    const threadSection = container.querySelector('.collaboration-thread');
    expect(threadSection).toHaveAttribute('data-header-member-bar', 'external');
    expect(
      threadSection?.querySelector('[data-testid="collaboration-top-member-bar"]')
    ).toBeNull();

    headerSlot.remove();
  });

  it('drags Supervisor, Bot, and Group rows from Zone A Bot list onto the Infinite Canvas as Space nodes', async () => {
    render(
      <HotkeysProvider>
        <TooltipProvider>
          <CollaborationSpaceProvider workspaceId="ws-1">
            <WorkspaceBotsDockPanel />
          </CollaborationSpaceProvider>
        </TooltipProvider>
      </HotkeysProvider>
    );

    const supervisorBtn = await screen.findByTestId(
      'collaboration-supervisor-button'
    );
    fireEvent.pointerDown(supervisorBtn, {
      button: 0,
      clientX: 30,
      clientY: 30,
    });
    fireEvent.pointerMove(window, { clientX: 420, clientY: 220 });
    fireEvent.pointerUp(window, { clientX: 420, clientY: 220 });

    expect(dropPanelAt).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `${PANEL_IDS.COLLABORATION_SPACE}:direct:mem-sup`,
        component: PANEL_IDS.COLLABORATION_SPACE,
        title: 'Master',
        expanded: true,
        params: expect.objectContaining({
          targetType: 'direct',
          threadId: 'direct:mem-sup',
          conversationId: 'conv-sup',
          memberId: 'mem-sup',
          memberNickname: 'Master',
        }),
      }),
      { x: 420, y: 220 }
    );

    dropPanelAt.mockClear();

    const groupRow = await screen.findByRole('button', { name: '设计协作群' });
    fireEvent.pointerDown(groupRow, {
      button: 0,
      clientX: 40,
      clientY: 120,
    });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 300 });
    fireEvent.pointerUp(window, { clientX: 500, clientY: 300 });

    expect(dropPanelAt).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `${PANEL_IDS.COLLABORATION_SPACE}:space-design`,
        component: PANEL_IDS.COLLABORATION_SPACE,
        title: '设计协作群',
        expanded: true,
        params: expect.objectContaining({
          targetType: 'group',
          spaceId: 'space-design',
          spaceName: '设计协作群',
        }),
      }),
      { x: 500, y: 300 }
    );

    dropPanelAt.mockClear();

    const botRow = await screen.findByRole('button', { name: 'Pixel' });
    fireEvent.pointerDown(botRow, {
      button: 0,
      clientX: 40,
      clientY: 180,
    });
    fireEvent.pointerMove(window, { clientX: 520, clientY: 340 });
    fireEvent.pointerUp(window, { clientX: 520, clientY: 340 });

    expect(dropPanelAt).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `${PANEL_IDS.COLLABORATION_SPACE}:direct:mem-bot`,
        component: PANEL_IDS.COLLABORATION_SPACE,
        title: 'Pixel',
        expanded: true,
        params: expect.objectContaining({
          targetType: 'direct',
          threadId: 'direct:mem-bot',
          conversationId: 'conv-bot',
          memberId: 'mem-bot',
          memberNickname: 'Pixel',
        }),
      }),
      { x: 520, y: 340 }
    );
  });
});
