import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
import { registerCanvasCreationHost } from '@/components/kanban/canvas/canvasCreationHost';
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
  let unregisterCreationHost: (() => void) | null = null;
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
    unregisterCreationHost = registerCanvasCreationHost(canvasSurface);
    document.elementsFromPoint = vi.fn(() => [canvasSurface!]);
    document.elementFromPoint = vi.fn(() => canvasSurface);
  });

  afterEach(() => {
    unregisterController?.();
    unregisterController = null;
    act(() => unregisterCreationHost?.());
    canvasSurface?.remove();
    canvasSurface = null;
    document.elementsFromPoint = originalElementsFromPoint;
    document.elementFromPoint = originalElementFromPoint;
  });

  it.each(['outer', 'nested'])(
    'opens a single editable canvas form from the %s collaboration provider',
    async (scope) => {
      const user = userEvent.setup();
      render(
        <HotkeysProvider>
          <TooltipProvider>
            <CollaborationSpaceProvider workspaceId="ws-1">
              {scope === 'outer' ? <WorkspaceBotsDockPanel /> : null}
              <CollaborationSpaceProvider workspaceId="ws-1">
                {scope === 'nested' ? <WorkspaceBotsDockPanel /> : null}
                <CollaborationSpaceLayout hideSpacesPane />
              </CollaborationSpaceProvider>
            </CollaborationSpaceProvider>
          </TooltipProvider>
        </HotkeysProvider>
      );

      await user.click(
        (await screen.findAllByRole('button', { name: '创建' }))[0]!
      );
      await user.click(
        await screen.findByRole('menuitem', { name: '创建群聊' })
      );
      await waitFor(() =>
        expect(screen.getAllByRole('dialog')).toHaveLength(1)
      );
      const dialog = screen.getByRole('dialog');
      expect(canvasSurface).toContainElement(dialog);
      const name = within(dialog).getByRole('textbox', { name: '群聊名称' });
      await user.type(name, '测试群组');
      expect(name).toHaveValue('测试群组');
      await user.click(within(dialog).getByRole('button', { name: '关闭' }));
      expect(screen.queryByRole('dialog')).toBeNull();

      await user.click(screen.getAllByRole('button', { name: '创建' })[0]!);
      await user.click(
        await screen.findByRole('menuitem', { name: '创建助手' })
      );
      await waitFor(() =>
        expect(screen.getAllByRole('dialog')).toHaveLength(1)
      );
      expect(canvasSurface).toContainElement(screen.getByRole('dialog'));
    }
  );

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
      threadSection?.querySelector(
        '[data-testid="collaboration-top-member-bar"]'
      )
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
