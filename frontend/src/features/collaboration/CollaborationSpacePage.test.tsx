import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithQueryClient as render } from '@/test/QueryClientHarness';
import { sessionsApi } from '@/lib/api';

import { useCollaborationLayoutStore } from './collaborationLayoutStore';
import { CollaborationSpacePage } from './CollaborationSpacePage';
import { deriveMemberBotAvatar } from './MemberBotAvatar';

const collaborationCall = vi.hoisted(() => vi.fn());
const sessionPreviewSpy = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const toastInfo = vi.hoisted(() => vi.fn());
const spaceEventListeners = vi.hoisted(
  () => new Set<(payload: unknown) => void>()
);
const workspaceSessionsListeners = vi.hoisted(
  () => new Set<(payload: unknown) => void>()
);

vi.mock('@/lib/backendTransport', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/backendTransport')>();
  return {
    ...actual,
    backendListen: vi.fn(
      async (event: string, handler: (payload: unknown) => void) => {
        if (event === 'workspace-sessions-changed') {
          workspaceSessionsListeners.add(handler);
          return () => {
            workspaceSessionsListeners.delete(handler);
          };
        }
        return () => undefined;
      }
    ),
  };
});

vi.mock('@/components/ui/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/toast')>();
  return {
    ...actual,
    toast: { ...actual.toast, error: toastError, info: toastInfo },
  };
});

vi.mock('./collaborationApi', () => ({
  COLLABORATION_SPACE_CHANGED_EVENT: 'vibex://collaboration-space-changed',
  collaborationCall,
  currentWindowLabel: vi.fn(async () => 'main'),
  listenCollaborationSpaceChanged: vi.fn(
    async (handler: (payload: unknown) => void) => {
      spaceEventListeners.add(handler);
      return () => {
        spaceEventListeners.delete(handler);
      };
    }
  ),
}));

vi.mock('@/hooks/useAttemptRepo', () => ({
  useAttemptRepo: () => ({ repos: [] }),
}));

vi.mock('@/components/kanban/KanbanSessionConversationView', async () => {
  const { useSessionSurfaceChrome } = await import(
    '@/contexts/SessionSurfaceChromeContext'
  );
  return {
    KanbanSessionConversationView: (props: Record<string, unknown>) => {
      sessionPreviewSpy(props);
      const chrome = useSessionSurfaceChrome();
      return (
        <div
          data-testid="session-preview"
          data-embedded={String(Boolean(props.embedded))}
          data-hide-persona={String(Boolean(chrome.hidePersonaHostNotes))}
        >
          {String(props.sessionId ?? '')}
          {chrome.composerIdentity}
        </div>
      );
    },
  };
});

vi.mock('@/components/panels/DockviewPreviewPanel', () => ({
  default: () => <div data-testid="file-preview" />,
}));

vi.mock('@/features/conversation/useConversationTimeline', () => ({
  useConversationTimeline: () => ({
    timeline: [],
    items: [],
    sideRows: [],
    sessionConfigOptions: [],
    currentTurnId: null,
  }),
  useConversationSessionFacts: () => ({
    sessionId: 'conv-1',
    hasDetail: true,
    error: null,
    title: '设计会话',
    status: null,
    agentId: 'CLAUDE_CODE',
    model: 'claude-sonnet-4',
    acpSessionId: null,
    externalSessionId: null,
    turnInFlight: false,
    sessionStats: {
      total_usage: { input_tokens: 120, output_tokens: 80 },
    },
    truncated: false,
    loading: false,
  }),
}));

function renderPage(workspaceId: string | null = 'workspace-1') {
  return render(
    <HotkeysProvider initiallyActiveScopes={['dialog']}>
      <CollaborationSpacePage workspaceId={workspaceId} />
    </HotkeysProvider>
  );
}

function getComposerEditor(): HTMLDivElement {
  const surface = screen.getByTestId('session-composer-editor');
  const editable = surface.querySelector<HTMLDivElement>(
    '[contenteditable="true"], [contenteditable="false"][role="combobox"]'
  );
  if (!editable) {
    throw new Error('Composer editable element not found');
  }
  return editable;
}

describe('CollaborationSpacePage', () => {
  beforeEach(() => {
    useCollaborationLayoutStore.setState({
      isSpacesVisible: true,
      isThreadVisible: true,
      isPreviewVisible: true,
      hasOpenedSpaceThread: false,
      hasMountedPreviewTabs: false,
      sessionFocus: null,
    });
    collaborationCall.mockReset();
    sessionPreviewSpy.mockReset();
    spaceEventListeners.clear();
    workspaceSessionsListeners.clear();
    collaborationCall.mockImplementation(
      async (
        _capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'space.list') {
          return { spaces: [{ space_id: 's1', name: '设计' }] };
        }
        if (method === 'space.listMembers') {
          return {
            members: [
              {
                member_id: 'm1',
                nickname: '小A',
                kind: 'agent',
                visible_to_agents: 1,
                conversation_id: 'conv-1',
              },
              {
                member_id: 'm2',
                nickname: '小B',
                kind: 'agent',
                visible_to_agents: 1,
                conversation_id: 'conv-2',
              },
              {
                member_id: 'u1',
                nickname: '你',
                kind: 'user',
                visible_to_agents: 0,
                conversation_id: null,
              },
            ],
          };
        }
        if (method === 'space.listMessages') {
          if (input?.sinceSeq === 1 || input?.sinceSeq === 2) {
            return {
              messages: [
                {
                  seq: 3,
                  envelope: { actor: 'space/member/小A', content: '增量消息' },
                },
              ],
            };
          }
          return {
            messages: [
              {
                seq: 1,
                envelope: { actor: 'space/member/小A', content: '你好' },
              },
              {
                seq: 2,
                envelope: {
                  actor: 'space/member/小B',
                  content: '请查看 [架构文档](src/arch.md)',
                },
              },
            ],
          };
        }
        if (method === 'space.listConversations') {
          return {
            conversations: [
              {
                conversation_id: 'conv-1',
                title: '设计会话',
                workspace_name: '主工作区',
                agent_id: 'CLAUDE_CODE',
                turn_in_flight: true,
                updated_at: new Date().toISOString(),
              },
              {
                conversation_id: 'conv-2',
                title: '前端会话',
                workspace_name: '前端工作区',
                agent_id: 'CODEX',
                turn_in_flight: false,
                updated_at: new Date().toISOString(),
              },
              {
                conversation_id: 'conv-3',
                title: '后端会话',
                workspace_name: '后端工作区',
                agent_id: 'CLAUDE_CODE',
                turn_in_flight: false,
                updated_at: new Date().toISOString(),
              },
            ],
          };
        }
        if (method === 'team.list') {
          return { teams: [{ id: 'team-1', name: '核心平台组' }] };
        }
        if (method === 'role.list') {
          return {
            roles: [
              {
                id: 'role-1',
                name: '架构师',
                agent_id: 'CLAUDE_CODE',
              },
            ],
          };
        }
        if (method === 'role.agents') {
          return {
            agents: [
              { agent_id: 'CLAUDE_CODE', name: 'Claude Code' },
              { agent_id: 'CODEX', name: 'Codex' },
            ],
          };
        }
        if (method === 'space.post') {
          return {
            message_id: String(input?.operationId ?? 'msg-1'),
            seq: 3,
            receipts: [
              {
                conversation_id: 'conv-1',
                nickname: '小A',
                delivered: 'queued',
              },
            ],
          };
        }
        return {};
      }
    );
  });

  it('opens creation/edit overlays inside the message area; contact rows open chat, message avatars open the session tab', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(screen.queryByRole('textbox', { name: '空间名称' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: '昵称' })).toBeNull();
    expect(await screen.findByRole('button', { name: '设计' })).toBeTruthy();
    expect(screen.getByTestId('session-composer-editor')).toBeTruthy();
    expect((await screen.findAllByText('你好')).length).toBeGreaterThanOrEqual(
      1
    );
    expect(screen.queryByText(/个成员在活跃/)).toBeNull();
    expect(screen.getByTestId('composer-current-space')).toHaveTextContent(
      '设计'
    );
    const statsBadge = screen.getByTestId('composer-space-stats');
    expect(statsBadge).toHaveTextContent(/^2$/);
    expect(statsBadge.querySelector('svg')).toBeNull();
    fireEvent.mouseEnter(statsBadge);
    expect(await screen.findByText('空间助手')).toBeTruthy();
    fireEvent.mouseLeave(statsBadge);

    // Top horizontal member bar is shown and can be collapsed/expanded
    expect(screen.getByTestId('collaboration-top-member-bar')).toBeTruthy();
    expect(screen.getByText('请查看')).toBeTruthy();
    const chipA = screen.getByRole('button', {
      name: '打开 小A 会话',
    });
    expect(
      chipA.querySelector('.collaboration-top-member-chip-name')
    ).toHaveTextContent('小A');
    expect(chipA).toHaveClass('collaboration-top-member-chip');
    const chrome = screen.getByTestId('collaboration-top-member-chrome');
    expect(
      within(chrome).getByTestId('collaboration-open-collection-btn')
    ).toBeTruthy();
    expect(
      within(chrome).getByRole('button', { name: '收起助手列表' })
    ).toBeTruthy();
    expect(chrome.querySelector('.collaboration-expand')).toBeNull();
    const designRow = screen.getByRole('button', { name: '设计' });
    const groupSlot = within(designRow).getAllByTestId(
      'collaboration-group-avatar-slot'
    )[0] as HTMLElement;
    const listAvatar = chipA.querySelector(
      '.collaboration-list-avatar'
    ) as HTMLElement;
    expect(listAvatar.style.width).toBe(groupSlot.style.width);
    expect(listAvatar.style.height).toBe(groupSlot.style.height);

    await user.click(screen.getByRole('button', { name: '收起助手列表' }));
    expect(screen.queryByTestId('collaboration-top-member-bar')).toBeNull();
    const collapsedStack = screen.getByTestId('collaboration-top-member-stack');
    expect(collapsedStack).toBeTruthy();
    expect(
      collapsedStack.querySelectorAll('.collaboration-top-member-stack-item')
    ).toHaveLength(2);
    const collapsedAvatar = collapsedStack.querySelector(
      '.collaboration-list-avatar'
    ) as HTMLElement;
    expect(collapsedAvatar.style.width).toBe(groupSlot.style.width);
    await user.click(screen.getByRole('button', { name: '展开助手列表' }));
    expect(screen.getByTestId('collaboration-top-member-bar')).toBeTruthy();

    // Piano-key message navigation is rendered in the message area
    expect(
      document.querySelector('.collaboration-thread .conv-message-nav-rail')
    ).toBeTruthy();

    // Setting a space tag color draws it as an outline ring around the group avatar
    await user.click(screen.getByRole('button', { name: '标签 设计' }));
    await user.click(await screen.findByRole('button', { name: '蓝色' }));
    const spaceButton = screen.getByRole('button', { name: '设计' });
    const groupAvatar = within(spaceButton).getByTestId(
      'collaboration-group-avatar'
    );
    expect(groupAvatar).toHaveClass('has-tag');
    expect(groupAvatar).toHaveAttribute('data-count', '2');
    expect(groupAvatar).toHaveStyle({ width: '72px', height: '72px' });
    expect(groupAvatar.style.getPropertyValue('--group-avatar-tag')).toContain(
      'hsl('
    );

    // Right preview area is hidden until a member or file is selected
    expect(screen.queryByLabelText('预览')).toBeNull();

    // Clicking a file link in the message area opens a file preview tab in the right Dockview
    await user.click(screen.getByRole('link', { name: '架构文档' }));
    expect(await screen.findByTestId('file-preview')).toBeTruthy();

    // When spaces exist, the 2 empty-state buttons in the left list body are not shown
    expect(screen.queryByRole('button', { name: '创建群聊' })).toBeNull();

    // User ('你') is invisible and never shown in the collaboration space member list
    expect(screen.queryByRole('button', { name: '你' })).toBeNull();

    // Member row displays member name ('小A'), last message sent in current space ('你好'), enlarged left Bot avatar, and right Agent icon
    const memberAButton = screen.getByRole('button', { name: '小A' });
    expect(
      screen.getByTestId('collaboration-member-bot-avatar-conv-1')
    ).toBeTruthy();
    expect(memberAButton.querySelector('.workspace-session-icon')).toHaveStyle({
      width: '72px',
      height: '72px',
    });
    expect(
      screen.getByTestId('collaboration-member-row-agent-icon-conv-1')
    ).toBeTruthy();
    expect(
      screen.getByTestId('collaboration-message-bot-avatar-1')
    ).toHaveClass('h-10', 'w-10');
    expect(
      memberAButton
        .closest('.workspace-session-row')
        ?.querySelector('.workspace-session-row-marker')
    ).toBeNull();
    expect(
      memberAButton.querySelector('.collaboration-member-name')?.textContent
    ).toBe('小A');
    // Flat list: group '设计' plus private chats 小A and 小B
    expect(document.querySelectorAll('[data-chat-type="direct"]')).toHaveLength(
      2
    );
    expect(
      screen.getByRole('button', { name: '修改昵称 小A' }).className
    ).toContain('collaboration-edit-name-btn');

    // Hovering member row shows member info tooltip at cursor position without duplicate 名称/Agent rows in meta
    fireEvent.mouseMove(memberAButton, { clientX: 160, clientY: 220 });
    await user.hover(memberAButton);
    const hoverInfo = await screen.findByTestId(
      'collaboration-member-hover-info-conv-1'
    );
    expect(hoverInfo).toHaveTextContent('小A');
    expect(hoverInfo).toHaveTextContent('Claude Code');
    expect(within(hoverInfo).queryByText('名称')).toBeNull();
    expect(within(hoverInfo).queryByText('Agent')).toBeNull();
    expect(
      screen.getByTestId('collaboration-member-hover-workspace-conv-1')
    ).toHaveTextContent('主工作区');
    expect(
      screen.getByTestId('collaboration-member-hover-team-conv-1')
    ).toHaveTextContent('-');
    const tooltipContentEl = hoverInfo.closest(
      '.collaboration-member-hover-info'
    ) as HTMLElement | null;
    expect(tooltipContentEl).toHaveAttribute('data-cursor-positioned', 'true');
    expect(tooltipContentEl?.style.left).toBe('172px');
    expect(tooltipContentEl?.style.top).toBe('232px');
    await user.unhover(memberAButton);

    // Clicking a private-chat row opens that member's private chat message
    // area (row selected), not the member session preview.
    await user.click(memberAButton);
    await waitFor(() => {
      expect(memberAButton.closest('.is-selected')).toBeTruthy();
    });
    expect(screen.queryByTestId('session-preview')).toBeNull();

    // Back in the group, clicking a member's avatar in the message area opens
    // that member's session preview tab.
    await user.click(screen.getByRole('button', { name: '设计' }));
    await user.click(
      await screen.findByRole('button', { name: '预览 小A 会话' })
    );
    const preview = await screen.findByTestId('session-preview');
    expect(preview).toHaveTextContent('conv-1');
    expect(preview).toHaveAttribute('data-embedded', 'true');
    expect(sessionPreviewSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        sessionId: 'conv-1',
        embedded: true,
        interactive: true,
        showSessionSelector: false,
        conversationWidthMode: 'workspace',
      })
    );
    expect(screen.getByLabelText('预览')).toBeTruthy();

    // Clicking + in top toolbar expands menu with 创建群聊 / 创建助手 / 新建分组
    await user.click(screen.getByRole('button', { name: '创建' }));
    const createSpaceMenuItem = await screen.findByRole('menuitem', {
      name: '创建群聊',
    });
    expect(screen.getByRole('menuitem', { name: '创建助手' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '新建分组' })).toBeTruthy();
    await user.click(createSpaceMenuItem);

    // Form is rendered as a white Gaussian blurred overlay inside the middle message area (.collaboration-thread)
    const threadSection = screen.getByRole('region', { name: '设计' });
    const dialogInThread = within(threadSection).getByRole('dialog', {
      name: '创建群聊',
    });
    expect(dialogInThread).toBeTruthy();
    const overlayEl = threadSection.querySelector(
      '.collaboration-thread-overlay'
    );
    expect(overlayEl).toBeTruthy();
    expect(overlayEl?.className).not.toContain('dialog-backdrop');
    expect(screen.getByRole('textbox', { name: '群聊名称' })).toBeTruthy();
    expect(within(dialogInThread).getByText('群聊成员')).toBeTruthy();
    expect(
      within(dialogInThread).getByTestId('collaboration-create-bot-list')
    ).toBeTruthy();
    expect(
      within(dialogInThread).getByRole('button', { name: '小A' })
    ).toBeTruthy();
    expect(
      within(dialogInThread).getByRole('button', { name: '小B' })
    ).toBeTruthy();
    expect(
      within(dialogInThread).queryByTestId('collaboration-picker-space-s1')
    ).toBeNull();
    expect(
      within(dialogInThread).queryByRole('button', {
        name: '添加或新建协作空间助手',
      })
    ).toBeNull();
    expect(
      within(dialogInThread).queryByRole('button', { name: '新建助手' })
    ).toBeNull();
    expect(
      within(dialogInThread).getByRole('button', { name: '创建群聊' })
    ).toBeDisabled();
    await user.click(within(dialogInThread).getByRole('button', { name: '小A' }));
    await user.click(within(dialogInThread).getByRole('button', { name: '小B' }));
    expect(
      within(dialogInThread).getByRole('button', { name: '创建群聊' })
    ).not.toBeDisabled();

    const closeDialogBtn = screen.getByRole('button', { name: /^(关闭|Close)$/ });
    expect(closeDialogBtn.querySelector('svg')).toBeTruthy();
    await user.click(closeDialogBtn);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '创建群聊' })).toBeNull();
    });

    // Group rows no longer expose a hover 加入助手 control; create from the + menu.
    expect(screen.queryByRole('button', { name: '加入助手 设计' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '创建' }));
    await user.click(await screen.findByRole('menuitem', { name: '创建助手' }));
    const memberDialog = await within(threadSection).findByRole('dialog', {
      name: '新建助手',
    });
    expect(memberDialog).toBeTruthy();
    const sourceSegmented = within(memberDialog).getByRole('radiogroup', {
      name: '创建方式',
    });
    expect(
      within(sourceSegmented).getByRole('radio', { name: '基于角色' })
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      within(memberDialog).getByRole('textbox', { name: '助手名称' })
    ).toBeTruthy();

    // Avatar customizer field is rendered with 颜色/形状 SegmentedControl on the right of 头像 label, no 表情 tab, no text in color/shape panels, no shadows/highlights/eyeballs
    const avatarPicker = within(memberDialog).getByTestId(
      'member-bot-avatar-picker'
    );
    expect(avatarPicker).toBeTruthy();
    const previewBox = within(avatarPicker).getByTestId(
      'member-bot-avatar-preview'
    );
    expect(previewBox.querySelector('defs')).toBeNull();
    expect(previewBox.querySelector('.collaboration-bot-3d-shadow')).toBeNull();
    expect(
      previewBox.querySelector('.collaboration-bot-avatar-face circle')
    ).toBeNull();
    // Idle avatar faces the user directly with neutral expression and idle blink class
    expect(
      previewBox.querySelector(
        '.collaboration-bot-avatar--idle-blink[data-bot-emote="idle"][data-bot-expression="neutral"]'
      )
    ).toBeTruthy();

    const avatarAttrSegmented = within(avatarPicker).getByRole('radiogroup', {
      name: '头像属性',
    });
    expect(
      within(avatarAttrSegmented).getByRole('radio', { name: '颜色' })
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      within(avatarAttrSegmented).queryByRole('radio', { name: '表情' })
    ).toBeNull();

    const colorPanel = within(avatarPicker).getByTestId(
      'member-avatar-panel-color'
    );
    expect(colorPanel.textContent).toBe('');
    await user.click(
      within(colorPanel).getByRole('button', { name: '紫罗兰' })
    );
    expect(previewBox.querySelector('[data-bot-color="#8b52ff"]')).toBeTruthy();
    expect(
      previewBox.querySelector('.collaboration-bot-avatar-stage.is-reacting')
    ).toBeTruthy();

    await user.click(
      within(avatarAttrSegmented).getByRole('radio', { name: '形状' })
    );
    const shapePanel = within(avatarPicker).getByTestId(
      'member-avatar-panel-shape'
    );
    expect(shapePanel.textContent).toBe('');
    await user.click(within(shapePanel).getByRole('button', { name: '心形' }));
    expect(previewBox.querySelector('[data-bot-shape="heart"]')).toBeTruthy();

    // Creation source SegmentedControl items each include an icon
    for (const radioEl of within(sourceSegmented).getAllByRole('radio')) {
      expect(radioEl.querySelector('svg')).toBeTruthy();
    }
  }, 30_000);

  it('completes @nickname via SessionComposerInput panel, sends targeted vs broadcast posts, and renders receipts', async () => {
    const user = userEvent.setup();
    renderPage();

    expect((await screen.findAllByText('你好')).length).toBeGreaterThanOrEqual(
      1
    );
    expect(await screen.findByRole('button', { name: '小A' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '选择文件' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '@助手' })).toBeTruthy();

    const editor = getComposerEditor();
    await user.click(screen.getByRole('button', { name: '@助手' }));

    const menu = await screen.findByTestId('composer-at-reference-menu');
    expect(menu).toBeVisible();
    expect(screen.getByRole('tab', { name: /助手/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.queryByRole('option', { name: /你/ })).toBeNull();

    await user.click(screen.getByRole('option', { name: /小A/ }));
    await user.type(editor, '请看 diff');
    await user.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'space.post',
        expect.objectContaining({
          spaceId: 's1',
          content: '@小A 请看 diff',
          to: ['小A'],
        })
      );
    });
    expect(await screen.findByText('小A 已收到')).toBeTruthy();
    // User message does not render '你' header
    expect(screen.queryByRole('button', { name: '预览 你 会话' })).toBeNull();

    await user.click(editor);
    await user.type(editor, '全员同步一下');
    await user.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'space.post',
        expect.objectContaining({
          spaceId: 's1',
          content: '全员同步一下',
          to: [],
        })
      );
    });
  });

  it('shows a group message in the log before space.post resolves', async () => {
    const user = userEvent.setup();
    const defaultImpl = collaborationCall.getMockImplementation();
    let releasePost: ((value: unknown) => void) | undefined;
    const postGate = new Promise((resolve) => {
      releasePost = resolve;
    });
    collaborationCall.mockImplementation(
      async (
        capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'space.post') {
          await postGate;
          return {
            message_id: String(input?.operationId ?? 'msg-1'),
            seq: 3,
            receipts: [
              {
                conversation_id: 'conv-1',
                nickname: '小A',
                delivered: 'queued',
              },
            ],
          };
        }
        return defaultImpl?.(capability, method, input);
      }
    );

    renderPage();
    expect((await screen.findAllByText('你好')).length).toBeGreaterThanOrEqual(
      1
    );
    const editor = getComposerEditor();
    await user.click(editor);
    await user.type(editor, '即时出现');
    await user.click(screen.getByRole('button', { name: '发送' }));

    const postCall = await waitFor(() => {
      const call = collaborationCall.mock.calls.find(
        (item) => item[1] === 'space.post'
      );
      expect(call).toBeTruthy();
      return call!;
    });
    const op = String(
      (postCall[2] as { operationId?: string } | undefined)?.operationId ?? ''
    );
    const pending = await screen.findByTestId(
      `collaboration-pending-message-${op}`
    );
    expect(pending).toHaveTextContent('即时出现');

    releasePost?.({});
    await waitFor(() => {
      expect(
        Array.from(document.querySelectorAll('.collaboration-message')).some(
          (node) => node.textContent?.includes('即时出现')
        )
      ).toBe(true);
    });
  });

  it('retains draft and operationId when delivery receipt fails, and keeps draft on image paste', async () => {
    const user = userEvent.setup();
    collaborationCall.mockImplementation(
      async (
        _capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'space.list') {
          return { spaces: [{ space_id: 's1', name: '设计' }] };
        }
        if (method === 'space.listMembers') {
          if (String(input?.spaceId ?? '').startsWith('unassigned:')) {
            return { members: [] };
          }
          return {
            members: [
              {
                member_id: 'm1',
                nickname: '小A',
                kind: 'agent',
                visible_to_agents: 1,
                conversation_id: 'conv-1',
              },
            ],
          };
        }
        if (method === 'space.listMessages') {
          return { messages: [] };
        }
        if (method === 'space.post') {
          return {
            message_id: String(input?.operationId ?? 'msg-fail'),
            seq: 1,
            receipts: [
              {
                conversation_id: 'conv-1',
                nickname: '小A',
                delivered: 'failed',
                error_code: 'not_found',
              },
            ],
          };
        }
        return {};
      }
    );

    renderPage();
    expect(await screen.findByRole('button', { name: '小A' })).toBeTruthy();

    const editor = getComposerEditor();
    await user.click(editor);
    await user.type(editor, '@小A 重试这条');

    const imageFile = new File(['png'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(editor, {
      clipboardData: {
        files: [imageFile],
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => imageFile,
          },
        ],
        getData: () => '',
      },
    });
    expect(editor).toHaveTextContent('@小A 重试这条');

    await user.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('没有送达')).toBeTruthy();
    expect(await screen.findByText('小A 失败')).toBeTruthy();
    expect(editor).toHaveTextContent('@小A 重试这条');

    const firstPostCall = collaborationCall.mock.calls.find(
      (call) => call[1] === 'space.post'
    );
    const firstOperationId = (
      firstPostCall?.[2] as { operationId?: string } | undefined
    )?.operationId;
    expect(firstOperationId).toEqual(expect.any(String));

    await user.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => {
      const postCalls = collaborationCall.mock.calls.filter(
        (call) => call[1] === 'space.post'
      );
      expect(postCalls).toHaveLength(2);
      expect(
        (postCalls[1]?.[2] as { operationId?: string } | undefined)?.operationId
      ).toBe(firstOperationId);
    });
  });

  it('renames a member via space.setIdentity, moves members via drag-and-drop, and updates log on space event', async () => {
    const user = userEvent.setup();
    renderPage();

    expect((await screen.findAllByText('你好')).length).toBeGreaterThanOrEqual(
      1
    );

    await act(async () => {
      for (const listener of spaceEventListeners) {
        listener({
          workspaceId: 'workspace-1',
          spaceId: 's1',
          seq: 3,
        });
      }
    });

    expect(
      (await screen.findAllByText('增量消息')).length
    ).toBeGreaterThanOrEqual(1);
    expect(collaborationCall).toHaveBeenCalledWith(
      'collaboration',
      'space.listMessages',
      { spaceId: 's1', sinceSeq: 2 }
    );

    // Drag private chat 小A onto group '设计'
    const memberButton = screen.getByRole('button', { name: '小A' });
    const memberRow = memberButton.closest(
      '.workspace-session-row'
    ) as HTMLElement;
    const unassignedGroup = screen.getByTestId('collaboration-space-group-s1');
    // 小A is already a member of 设计 (space.listMembers): the drop is
    // refused with a toast instead of a duplicate space.addMember.
    fireEvent.dragStart(memberRow);
    fireEvent.dragOver(unassignedGroup);
    expect(unassignedGroup).not.toHaveClass('is-drop-target');
    fireEvent.drop(unassignedGroup);
    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith('小A 已在该群中')
    );
    expect(collaborationCall).not.toHaveBeenCalledWith(
      'collaboration',
      'space.addMember',
      expect.anything()
    );

    // Clicking rename button turns the member name directly into an inline input with X and Check buttons (no message area dialog overlay)
    await user.click(screen.getByRole('button', { name: '修改昵称 小A' }));
    expect(screen.queryByRole('dialog', { name: '修改昵称' })).toBeNull();
    const input = screen.getByRole('textbox', { name: '昵称' });
    expect(input).toHaveValue('小A');
    expect(screen.getByRole('button', { name: '取消修改昵称' })).toBeTruthy();
    await user.clear(input);
    await user.type(input, '评审A');
    await user.click(screen.getByRole('button', { name: /^修改昵称$/ }));

    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'space.setIdentity',
        expect.objectContaining({
          spaceId: 'unassigned:workspace-1',
          conversationId: 'conv-1',
          nickname: '评审A',
        })
      );
    });

    // Clicking space rename button turns space name into an inline input with X and Check buttons
    await user.click(screen.getByRole('button', { name: '修改名称 设计' }));
    const spaceNameInput = screen.getByRole('textbox', {
      name: '修改空间名称输入框',
    });
    expect(spaceNameInput).toHaveValue('设计');
    expect(
      screen.getByRole('button', { name: '取消修改空间名称' })
    ).toBeTruthy();
    await user.clear(spaceNameInput);
    await user.type(spaceNameInput, '视觉设计');
    await user.click(screen.getByRole('button', { name: '确认修改空间名称' }));

    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'space.rename',
        expect.objectContaining({
          spaceId: 's1',
          name: '视觉设计',
        })
      );
    });
    expect(
      await screen.findByRole('button', { name: '视觉设计' })
    ).toBeTruthy();
  }, 30_000);

  it('supports search, filtering by agent/activity/member, and batch deleting spaces and members', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole('button', { name: '设计' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: '小A' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: '小B' })).toBeTruthy();

    const searchBtn = screen.getByTestId('collaboration-global-search-button');
    await user.click(searchBtn);
    const searchModal = await screen.findByTestId(
      'collaboration-global-search-modal'
    );
    expect(searchModal).toBeVisible();
    const searchInput = within(searchModal).getByTestId(
      'collaboration-global-search-input'
    );
    expect(searchInput.tagName).toBe('INPUT');
    expect(searchInput.className).toContain(
      'border-[var(--color-border-emphasized'
    );
    expect(
      within(searchModal).getByTestId('collaboration-global-search-item-小A')
    ).toBeTruthy();
    expect(
      within(searchModal).getByTestId('collaboration-global-search-item-设计')
    ).toHaveTextContent('小A, 小B');
    await user.type(searchInput, '小B');
    expect(
      within(searchModal).queryByTestId('collaboration-global-search-item-小A')
    ).toBeNull();
    expect(
      within(searchModal).getByTestId('collaboration-global-search-item-小B')
    ).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(
      screen.queryByTestId('collaboration-global-search-modal')
    ).toBeNull();

    await user.click(screen.getByRole('button', { name: '筛选' }));
    expect(
      await screen.findByTestId('collaboration-filter-name')
    ).toHaveTextContent('按名称');
    expect(screen.getByTestId('collaboration-filter-type')).toHaveTextContent(
      '按类型 · 群聊'
    );
    expect(
      screen.getByTestId('collaboration-filter-activity')
    ).toHaveTextContent('按活跃时间');
    await user.click(screen.getByTestId('collaboration-filter-type'));
    expect(screen.getByRole('button', { name: '设计' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '小A' })).toBeNull();
    await user.click(screen.getByTestId('collaboration-filter-type'));
    expect(screen.getByTestId('collaboration-filter-type')).toHaveTextContent(
      '按类型 · 助手'
    );
    expect(screen.queryByRole('button', { name: '设计' })).toBeNull();
    expect(screen.getByRole('button', { name: '小A' })).toBeTruthy();
    await user.click(screen.getByTestId('collaboration-filter-activity'));
    expect(screen.getByRole('button', { name: '设计' })).toBeTruthy();

    // Group rows never expand into a member list or a collapsed stack
    await user.click(screen.getByRole('button', { name: '设计' }));
    expect(
      screen.queryByTestId('collaboration-space-collapsed-stack-s1')
    ).toBeNull();
    expect(screen.getByRole('button', { name: '设计' })).not.toHaveAttribute(
      'aria-expanded'
    );
    // Dragging the pane resizer between spaces pane and message thread adjusts --collaboration-spaces-width
    const spacesResizer = screen.getByTestId('collaboration-spaces-resizer');
    fireEvent.pointerDown(spacesResizer, { clientX: 296 });
    fireEvent.pointerMove(window, { clientX: 346 });
    fireEvent.pointerUp(window);
    const shell = spacesResizer.closest('.collaboration-shell') as HTMLElement;
    expect(
      shell.style.getPropertyValue('--collaboration-spaces-width')
    ).toBeTruthy();

    // Batch delete mode: checkboxes are placed outside the space and member row components with bolder border class
    // Selecting space '设计' automatically selects both 小A and 小B;
    // deselecting 小A keeps '设计' and 小B selected so 小A moves to 未定空间 and 小B is archived
    await user.click(screen.getByRole('button', { name: '批量删除' }));
    const spaceCheckbox = screen.getByRole('checkbox', {
      name: '选择空间 设计',
    });
    expect(spaceCheckbox.className).toContain('collaboration-delete-checkbox');
    expect(spaceCheckbox.closest('.collaboration-space-row')).toBeNull();
    expect(
      spaceCheckbox.closest('.collaboration-space-row-outer')
    ).toBeTruthy();
    await user.click(spaceCheckbox);

    expect(spaceCheckbox).toHaveAttribute('aria-checked', 'true');

    // Confirm batch delete
    const confirmButton = await screen.findByRole('button', {
      name: '确认删除',
    });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'space.batchDelete',
        expect.objectContaining({
          workspaceId: 'workspace-1',
          spaceIds: ['s1'],
        })
      );
    });
  });

  it('renders openWorkspaceFirst when no workspace is open', () => {
    renderPage(null);
    expect(screen.getByText('先打开一个工作区')).toBeTruthy();
  });

  it('shows left space list + middle message area (without right preview) when no spaces exist, renders only 2 centered buttons, and hides them once a space is created', async () => {
    const user = userEvent.setup();
    let storedSpaces: Array<{ space_id: string; name: string }> = [];
    let storedUnassignedMembers: Array<{
      member_id: string;
      nickname: string;
      kind: string;
      visible_to_agents: number;
      conversation_id: string;
    }> = [];
    collaborationCall.mockImplementation(
      async (
        _capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'space.list') {
          return { spaces: storedSpaces };
        }
        if (method === 'space.create') {
          const created = {
            space_id: 's-new',
            name: String(input?.name ?? '新房间'),
          };
          storedSpaces = [created];
          return created;
        }
        if (method === 'space.createMember') {
          const created = {
            space_id: 'unassigned:workspace-1',
            member_id: 'm-created',
            conversation_id: 'conv-created',
            nickname: String(input?.nickname ?? '新成员'),
          };
          storedUnassignedMembers = [
            {
              member_id: created.member_id,
              nickname: created.nickname,
              kind: 'agent',
              visible_to_agents: 1,
              conversation_id: created.conversation_id,
            },
          ];
          return created;
        }
        if (method === 'space.listConversations') {
          return {
            conversations: [
              { conversation_id: 'conv-non-member', title: '独立会话' },
            ],
          };
        }
        if (method === 'role.list') {
          return {
            roles: [
              { id: 'role-1', name: '前端专家', agent_id: 'CLAUDE_CODE' },
            ],
          };
        }
        if (method === 'role.agents') {
          return {
            agents: [{ agent_id: 'CLAUDE_CODE', name: 'Claude Code' }],
          };
        }
        if (method === 'team.list') {
          return { teams: [{ id: 'team-1', name: '产品研发组' }] };
        }
        if (method === 'space.listMembers') {
          if (String(input?.spaceId ?? '').startsWith('unassigned:')) {
            return { members: storedUnassignedMembers };
          }
          return { members: [] };
        }
        if (method === 'space.listMessages') {
          return { messages: [] };
        }
        return {};
      }
    );

    const { unmount } = renderPage();
    // Default space is shown in the left space list with hover 标签 / 修改名称
    expect(
      await screen.findByRole('button', { name: '默认空间' })
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: '标签 默认空间' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: '修改名称 默认空间' })
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: '加入助手 默认空间' })
    ).toBeNull();
    // The list no longer has a '协作空间' title heading
    expect(screen.queryByText('协作空间')).toBeNull();
    // Never show '还没有消息'; composer is NOT rendered when no space is opened;
    // instead, the white-blurred 创建群聊 overlay is shown by default over the message area
    expect(screen.queryByText('还没有消息')).toBeNull();
    expect(screen.queryByTestId('session-composer-editor')).toBeNull();
    const initialSpaceDialog = await screen.findByRole('dialog', {
      name: '创建群聊',
    });
    expect(initialSpaceDialog).toBeTruthy();
    // Right preview area is NOT shown by default
    expect(screen.queryByLabelText('预览')).toBeNull();

    // Closing 创建群聊 dialog when no spaces exist opens Default Space message area with empty-state capsule and 2 action buttons
    await user.click(
      within(initialSpaceDialog).getByRole('button', { name: /^(关闭|Close)$/ })
    );
    expect(
      await screen.findByTestId('collaboration-empty-member-pill')
    ).toHaveTextContent('当前协作空间暂无助手，请先添加助手');
    const emptyStateAddMemberBtn = screen.getByRole('button', {
      name: '添加助手',
    });
    const emptyStateCreateSpaceBtn = screen.getByRole('button', {
      name: '创建群聊',
    });

    // Test unified 新建助手 overlay inside message area (基于角色 / 基于会话 / 自定义, without 归属团队)
    await user.click(emptyStateAddMemberBtn);
    const memberDialog = await screen.findByRole('dialog', {
      name: '新建助手',
    });
    expect(memberDialog).toBeTruthy();
    expect(
      within(memberDialog).queryByRole('combobox', { name: /归属团队/ })
    ).toBeNull();
    const sourceSelector = within(memberDialog).getByRole('radiogroup', {
      name: '创建方式',
    });
    const sourceRadioItems = within(sourceSelector).getAllByRole('radio');
    expect(sourceRadioItems.map((opt) => opt.textContent)).toEqual([
      '基于角色',
      '基于会话',
      '自定义',
    ]);
    await user.click(sourceRadioItems[0]);

    await user.type(
      within(memberDialog).getByRole('textbox', { name: '助手名称' }),
      '架构助手'
    );
    await user.click(
      memberDialog.querySelector('button[type="submit"]') as HTMLButtonElement
    );

    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'space.createMember',
        expect.objectContaining({
          workspaceId: 'workspace-1',
          nickname: '架构助手',
          source: 'role',
          roleId: 'role-1',
        })
      );
    });

    // After creation the member's private chat opens: the empty state is gone
    // and no member session/preview tab is shown.
    await waitFor(() => {
      expect(
        screen.queryByTestId('collaboration-empty-member-pill')
      ).toBeNull();
    });
    expect(emptyStateCreateSpaceBtn).not.toBeInTheDocument();
    expect(screen.queryByLabelText('预览')).toBeNull();

    // Create-group form lists existing bots inline; name is optional.
    await user.click(screen.getByRole('button', { name: '创建' }));
    await user.click(await screen.findByRole('menuitem', { name: '创建群聊' }));
    const spaceDialog = await screen.findByRole('dialog', {
      name: '创建群聊',
    });
    expect(
      within(spaceDialog).getByRole('textbox', { name: '群聊名称' })
    ).toHaveValue('');
    expect(within(spaceDialog).getByText('群聊成员')).toBeTruthy();
    expect(
      within(spaceDialog).queryByRole('button', { name: '选择助手' })
    ).toBeNull();
    expect(
      within(spaceDialog).queryByRole('button', { name: '新建助手' })
    ).toBeNull();
    expect(
      within(spaceDialog).queryByRole('button', {
        name: '添加或新建协作空间助手',
      })
    ).toBeNull();
    expect(
      within(spaceDialog).queryByTestId(
        'collaboration-picker-space-unassigned:workspace-1'
      )
    ).toBeNull();
    const botList = within(spaceDialog).getByTestId(
      'collaboration-create-bot-list'
    );
    expect(botList.className).toContain('collaboration-create-member-list');
    expect(within(botList).queryByText('独立会话')).toBeNull();
    const createdBot = await within(botList).findByRole('button', {
      name: '架构助手',
    });
    await user.click(createdBot);
    expect(within(spaceDialog).getByText('架构助手')).toBeTruthy();
    expect(
      within(botList).queryByRole('button', { name: '架构助手' })
    ).toBeNull();

    await user.click(
      spaceDialog.querySelector('button[type="submit"]') as HTMLButtonElement
    );

    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'space.create',
        expect.objectContaining({
          workspaceId: 'workspace-1',
          name: '架构助手',
        })
      );
    });
    expect(collaborationCall).toHaveBeenCalledWith(
      'collaboration',
      'space.addMember',
      expect.objectContaining({
        spaceId: 's-new',
        conversationId: 'conv-created',
        nickname: '架构助手',
      })
    );
    // Once a space is created and opened, composer is rendered and the 2 empty-state buttons disappear
    expect(await screen.findByTestId('session-composer-editor')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '创建群聊' })).toBeNull();
    unmount();

    collaborationCall.mockImplementation(
      async (_capability: string, method: string) => {
        if (method === 'space.list') {
          throw { code: 'capability_unimplemented', message: 'disabled' };
        }
        return {};
      }
    );
    renderPage();
    expect(await screen.findByText('暂不可用')).toBeTruthy();
  });

  it('shows flowing blue glow on top member bar chip when member has delayed messages and displays scheduled queue with countdown on hover', async () => {
    const deliverAt = new Date(Date.now() + 125_000).toISOString();
    collaborationCall.mockImplementation(
      async (
        _capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'space.list') {
          return { spaces: [{ space_id: 's1', name: '设计' }] };
        }
        if (method === 'space.listMembers') {
          if (String(input?.spaceId ?? '').startsWith('unassigned:')) {
            return { members: [] };
          }
          return {
            members: [
              {
                member_id: 'm1',
                nickname: '小A',
                kind: 'agent',
                visible_to_agents: 1,
                conversation_id: 'conv-1',
              },
              {
                member_id: 'm2',
                nickname: '小B',
                kind: 'agent',
                visible_to_agents: 1,
                conversation_id: 'conv-2',
              },
            ],
          };
        }
        if (method === 'space.listMessages') {
          return {
            messages: [
              {
                seq: 1,
                envelope: {
                  actor: 'space/member/小A',
                  content: '我先处理一下',
                },
              },
            ],
            scheduled: [
              {
                delayed_input_id: 'space_delayed_1',
                space_id: 's1',
                sender_conversation_id: 'conv-1',
                sender_nickname: '小A',
                content: '@小B 5分钟后同步检查结果',
                summary: null,
                to: ['小B'],
                deliver_at: deliverAt,
                status: 'scheduled',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            ],
          };
        }
        if (method === 'space.listConversations') {
          return { conversations: [] };
        }
        return {};
      }
    );

    renderPage();
    const chipA = await screen.findByTestId('top-member-filter-小A');
    const chipB = await screen.findByTestId('top-member-filter-小B');

    expect(chipA).toHaveClass('has-delayed-messages');
    expect(chipA).toHaveAttribute('data-has-delayed-messages', 'true');
    expect(chipB).not.toHaveClass('has-delayed-messages');
    expect(chipB).toHaveAttribute('data-has-delayed-messages', 'false');

    fireEvent.mouseEnter(chipA);
    const popover = await screen.findByTestId('member-delayed-queue-小A');
    expect(popover).toHaveTextContent('定时消息队列');
    expect(popover).toHaveTextContent('@小B 5分钟后同步检查结果');

    const timer = screen.getByTestId(
      'member-delayed-queue-timer-space_delayed_1'
    );
    expect(timer.textContent).toMatch(/\d{2}:\d{2}/);
  });

  it('opens space collection tab from leftmost 4-squares button and displays items, expandable read receipts, and user message attachments', async () => {
    const user = userEvent.setup();
    let currentNote = '核心接口契约';
    let groupMembers: Array<Record<string, unknown>> = [
      {
        member_id: 'm1',
        nickname: '小A',
        kind: 'agent',
        visible_to_agents: 1,
        conversation_id: 'conv-1',
      },
    ];
    collaborationCall.mockImplementation(
      async (
        _capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'space.list') {
          return { spaces: [{ space_id: 's1', name: '设计' }] };
        }
        if (method === 'space.listMembers') {
          if (String(input?.spaceId ?? '').startsWith('unassigned:')) {
            return { members: [] };
          }
          return { members: groupMembers };
        }
        if (method === 'space.moveMember') {
          groupMembers = [];
          return {};
        }
        if (method === 'space.listMessages') {
          return {
            messages: [
              {
                seq: 1,
                envelope: {
                  actor: 'space/s1/user',
                  content: '请查看附件\n\n![spec.pdf](.vibe-images/spec.pdf)',
                },
              },
            ],
            scheduled: [],
          };
        }
        if (method === 'space.listCollection') {
          return {
            items: [
              {
                id: 'col-1',
                space_id: 's1',
                project_id: 'proj-1',
                kind: 'text',
                name: 'api-contract.md',
                file_path:
                  'C:/Users/test/.vibex/proj-1/TeamSpaces/s1/Collection/col-1_api-contract.md',
                mime_type: 'text/plain',
                byte_size: 42,
                note: currentNote,
                creator_conversation_id: 'conv-1',
                creator_nickname: '小A',
                created_at: '2026-10-23T01:00:00Z',
                text_content: 'GET /api/v1/spaces',
                reads: [
                  {
                    id: 'read-1',
                    item_id: 'col-1',
                    space_id: 's1',
                    reader_conversation_id: 'conv-2',
                    reader_nickname: '小B',
                    read_at: '2026-10-23T01:05:00Z',
                  },
                ],
              },
              {
                id: 'col-2',
                space_id: 's1',
                project_id: 'proj-1',
                kind: 'text',
                name: 'user-note.md',
                file_path:
                  'C:/Users/test/.vibex/proj-1/TeamSpaces/s1/Collection/col-2_user-note.md',
                mime_type: 'text/plain',
                byte_size: 16,
                note: '用户备注',
                creator_conversation_id: null,
                creator_nickname: '你',
                created_at: '2026-10-23T01:10:00Z',
                text_content: '用户添加的收藏内容',
                reads: [],
              },
            ],
          };
        }
        if (method === 'space.updateCollectionItem') {
          currentNote = String(input?.note ?? '');
          return {
            id: 'col-1',
            space_id: 's1',
            project_id: 'proj-1',
            kind: 'text',
            name: 'api-contract.md',
            file_path:
              'C:/Users/test/.vibex/proj-1/TeamSpaces/s1/Collection/col-1_api-contract.md',
            byte_size: 42,
            note: currentNote,
            creator_nickname: '小A',
            created_at: '2026-10-23T01:00:00Z',
            text_content: 'GET /api/v1/spaces',
            reads: [],
          };
        }
        if (method === 'space.addCollectionItem') {
          return {
            item: {
              id: 'col-2',
              space_id: 's1',
              project_id: 'proj-1',
              kind: 'text',
              name: 'note.txt',
              file_path:
                'C:/Users/test/.vibex/proj-1/TeamSpaces/s1/Collection/col-2_note.txt',
              byte_size: 12,
              note: '新增备注',
              creator_nickname: '你',
              created_at: '2026-10-23T01:10:00Z',
              text_content: '新的收藏内容',
              reads: [],
            },
          };
        }
        if (method === 'space.listConversations') {
          return { conversations: [] };
        }
        return {};
      }
    );

    renderPage();

    // 1. User message attachment card is rendered with stripped markdown text
    expect(await screen.findByText('请查看附件')).toBeTruthy();
    expect(await screen.findByText('spec.pdf')).toBeTruthy();

    // 2. Leftmost 4-squares group-details button is rendered in expanded top member bar
    const openCollectionBtn = await screen.findByTestId(
      'collaboration-open-collection-btn'
    );
    expect(openCollectionBtn).toHaveAttribute('aria-label', '群组详情');

    // Collapse top member bar and verify the collection button remains separate from avatar stack on the far left
    await user.click(screen.getByRole('button', { name: '收起助手列表' }));
    const collapsedBar = await screen.findByTestId(
      'collaboration-top-member-collapsed-bar'
    );
    const collapsedCollectionBtn = within(collapsedBar).getByTestId(
      'collaboration-open-collection-btn'
    );
    const avatarStack = within(collapsedBar).getByTestId(
      'collaboration-top-member-stack'
    );
    expect(avatarStack.contains(collapsedCollectionBtn)).toBe(false);

    // 3. Click the 4-squares button to open the group-details tab in Dockview
    await user.click(collapsedCollectionBtn);

    const collectionPanel = await screen.findByTestId(
      'collaboration-space-collection-panel'
    );
    expect(collectionPanel).toBeTruthy();
    expect(within(collectionPanel).getByText('设计')).toBeTruthy();
    expect(
      within(collectionPanel).getByTestId(
        'collaboration-group-details-tab-members'
      )
    ).toHaveAttribute('aria-selected', 'true');
    expect(
      within(collectionPanel).queryByTestId(
        'collaboration-collection-space-chip'
      )
    ).toBeNull();
    expect(
      await within(collectionPanel).findByTestId(
        'collaboration-group-member-小A'
      )
    ).toBeTruthy();
    expect(
      within(collectionPanel).getByTestId('collaboration-group-details-avatar')
    ).toHaveAttribute('data-count', '1');
    await user.click(
      within(collectionPanel).getByRole('button', { name: '移除 小A' })
    );
    expect(collaborationCall).toHaveBeenCalledWith(
      'collaboration',
      'space.moveMember',
      expect.objectContaining({
        fromSpaceId: 's1',
        toSpaceId: 'unassigned:workspace-1',
        conversationId: 'conv-1',
      })
    );
    await waitFor(() => {
      expect(
        within(collectionPanel).queryByTestId('collaboration-group-member-小A')
      ).toBeNull();
    });
    expect(
      within(collectionPanel).getByTestId('collaboration-group-details-avatar')
    ).toHaveAttribute('data-count', '0');
    await user.click(
      within(collectionPanel).getByTestId(
        'collaboration-group-details-tab-details'
      )
    );
    expect(
      within(collectionPanel).getByTestId('collaboration-group-details-tab')
    ).toBeTruthy();
    expect(
      within(collectionPanel).queryByTestId('group-details-usage-conv-1')
    ).toBeNull();
    await user.click(
      within(collectionPanel).getByTestId(
        'collaboration-group-details-tab-collection'
      )
    );

    // Dropzone is placed at the bottom (after the list)
    const listEl = within(collectionPanel).getByTestId(
      'collaboration-collection-list'
    );
    const dropzoneEl = within(collectionPanel).getByTestId(
      'collaboration-collection-dropzone'
    );
    expect(
      Boolean(
        listEl.compareDocumentPosition(dropzoneEl) &
          Node.DOCUMENT_POSITION_FOLLOWING
      )
    ).toBe(true);

    expect(
      await within(collectionPanel).findByTestId(
        'collection-item-creator-col-1'
      )
    ).toHaveTextContent('小A');
    expect(
      within(collectionPanel).getByTestId('collection-item-creator-col-2')
    ).toHaveTextContent('User');
    expect(
      within(collectionPanel).getByTestId('collection-item-content-col-1')
    ).toHaveTextContent('GET /api/v1/spaces');
    expect(
      within(collectionPanel).getByTestId('collection-item-note-col-1')
    ).toHaveTextContent('核心接口契约');

    // Edit note inline
    await user.click(
      within(collectionPanel).getByTestId('collection-item-note-edit-col-1')
    );
    const noteInput = within(collectionPanel).getByTestId(
      'collection-item-note-input-col-1'
    );
    await user.clear(noteInput);
    await user.type(noteInput, '已更新的接口契约备注');
    await user.click(
      within(collectionPanel).getByTestId('collection-item-note-save-col-1')
    );
    expect(collaborationCall).toHaveBeenCalledWith(
      'collaboration',
      'space.updateCollectionItem',
      expect.objectContaining({
        spaceId: 's1',
        itemId: 'col-1',
        note: '已更新的接口契约备注',
      })
    );
    expect(
      await within(collectionPanel).findByText('已更新的接口契约备注')
    ).toBeTruthy();

    // Read receipts are collapsed by default and expand on click
    expect(
      within(collectionPanel).queryByTestId('collection-item-reads-list-col-1')
    ).toBeNull();
    await user.click(
      within(collectionPanel).getByTestId('collection-item-reads-toggle-col-1')
    );
    const readsList = await within(collectionPanel).findByTestId(
      'collection-item-reads-list-col-1'
    );
    expect(readsList).toHaveTextContent('小B');

    // Collapse the collection item -> only header row (avatar, member name, content type) remains visible
    await user.click(
      within(collectionPanel).getByTestId(
        'collection-item-collapse-toggle-col-1'
      )
    );
    expect(
      within(collectionPanel).getByTestId('collection-item-col-1')
    ).toHaveAttribute('data-collapsed', 'true');
    expect(
      within(collectionPanel).getByTestId('collection-item-creator-col-1')
    ).toHaveTextContent('小A');
    expect(
      within(collectionPanel).getByTestId('collection-item-kind-col-1')
    ).toHaveTextContent('文本');
    expect(
      within(collectionPanel).queryByTestId('collection-item-content-col-1')
    ).toBeNull();
    expect(
      within(collectionPanel).queryByTestId('collection-item-note-col-1')
    ).toBeNull();
  });

  it('uses thread.listSidebar when available: unread/preview, markRead on open, tag via thread.update', async () => {
    const user = userEvent.setup();
    const defaultImpl = collaborationCall.getMockImplementation();
    collaborationCall.mockImplementation(
      async (
        capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'thread.listSidebar') {
          return {
            items: [
              {
                kind: 'group',
                thread_id: 's1',
                space_id: 's1',
                name: '设计',
                tag_color: null,
                last_message: { id: 1, seq: 1, preview: '最新进展' },
                last_activity_at: '2026-10-24T10:00:00Z',
                unread_count: 2,
                members_preview: [
                  {
                    member_id: 'mem-a',
                    name: '小A',
                    conversation_id: 'conv-1',
                  },
                ],
                member_count: 2,
              },
              {
                kind: 'dm',
                thread_id: 'direct:mem-a',
                space_id: 'unassigned:workspace-1',
                name: '小A',
                last_message: null,
                unread_count: 0,
                member: {
                  member_id: 'mem-a',
                  name: '小A',
                  conversation_id: 'conv-1',
                },
              },
            ],
          };
        }
        if (method === 'thread.markRead' || method === 'thread.update') {
          return {};
        }
        return defaultImpl?.(capability, method, input);
      }
    );

    renderPage();
    const groupMeta = await screen.findByTestId(
      'collaboration-chat-meta-group:s1'
    );
    expect(groupMeta).toHaveTextContent('最新进展');
    expect(groupMeta).toHaveTextContent('2');
    // DM rows with no last message / unread render no meta at all.
    expect(
      screen.queryByTestId('collaboration-chat-meta-direct:direct:mem-a')
    ).toBeNull();
    expect(document.querySelectorAll('[data-chat-type="direct"]')).toHaveLength(
      1
    );

    await user.click(screen.getByRole('button', { name: '小A' }));
    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'thread.markRead',
        { threadId: 'direct:mem-a' }
      );
    });
    expect(screen.queryByTestId('session-preview')).toBeNull();

    await user.click(screen.getByRole('button', { name: '标签 设计' }));
    await user.click(await screen.findByRole('button', { name: '蓝色' }));
    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'thread.update',
        expect.objectContaining({ spaceId: 's1' })
      );
    });
  });

  it('titles a member tab opened from a group chat with the group name', async () => {
    const user = userEvent.setup();
    const defaultImpl = collaborationCall.getMockImplementation();
    collaborationCall.mockImplementation(
      async (
        capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'thread.listSidebar') {
          return {
            items: [
              {
                kind: 'group',
                thread_id: 's1',
                space_id: 's1',
                name: '设计',
                members_preview: [
                  {
                    member_id: 'mem-a',
                    name: '小A',
                    conversation_id: 'conv-1',
                  },
                ],
                member_count: 1,
              },
            ],
          };
        }
        if (method === 'member.session.resolve') return {};
        if (method === 'thread.markRead') return {};
        return defaultImpl?.(capability, method, input);
      }
    );
    renderPage();
    await user.click(await screen.findByRole('button', { name: '设计' }));
    await user.click(
      await screen.findByRole('button', { name: '预览 小A 会话' })
    );
    await screen.findByTestId('session-preview');
    expect(screen.getByTestId('dockview-dv-default-tab')).toHaveAttribute(
      'title',
      '设计'
    );
  });

  it('opens the matching group chat and session tab from a session-list focus', async () => {
    const defaultImpl = collaborationCall.getMockImplementation();
    collaborationCall.mockImplementation(
      async (
        capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'thread.listSidebar') {
          return {
            items: [
              {
                kind: 'group',
                thread_id: 's1',
                space_id: 's1',
                name: '设计',
                members_preview: [
                  {
                    member_id: 'mem-a',
                    name: '小A',
                    conversation_id: 'conv-1',
                  },
                ],
                member_count: 1,
              },
            ],
          };
        }
        if (method === 'member.session.resolve') return {};
        if (method === 'thread.markRead') return {};
        return defaultImpl?.(capability, method, input);
      }
    );
    useCollaborationLayoutStore.getState().requestSessionFocus({
      conversationId: 'conv-1',
      memberId: 'mem-a',
      memberName: '小A',
      threadId: 's1',
      threadKind: 'group',
      threadName: '设计',
    });
    renderPage();
    await screen.findByTestId('session-preview');
    expect(screen.getByTestId('dockview-dv-default-tab')).toHaveAttribute(
      'title',
      '设计'
    );
  });

  it('opens the matching private chat and session tab from a session-list focus', async () => {
    const defaultImpl = collaborationCall.getMockImplementation();
    collaborationCall.mockImplementation(
      async (
        capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'thread.listSidebar') {
          return {
            items: [
              {
                kind: 'dm',
                thread_id: 'direct:mem-a',
                name: '小A',
                member: {
                  member_id: 'mem-a',
                  name: '小A',
                  conversation_id: 'conv-1',
                },
                member_count: 1,
              },
            ],
          };
        }
        if (method === 'member.session.resolve') return {};
        if (method === 'thread.markRead') return {};
        return defaultImpl?.(capability, method, input);
      }
    );
    useCollaborationLayoutStore.getState().requestSessionFocus({
      conversationId: 'conv-1',
      memberId: 'mem-a',
      memberName: '小A',
      threadId: 'direct:mem-a',
      threadKind: 'direct',
      threadName: '小A',
    });
    renderPage();
    await screen.findByTestId('session-preview');
    expect(screen.getByTestId('dockview-dv-default-tab')).toHaveAttribute(
      'title',
      '小A'
    );
    const memberAButton = await screen.findByRole('button', { name: '小A' });
    expect(memberAButton.closest('.is-selected')).toBeTruthy();
  });

  describe('sidebar pointer drag', () => {
    const member = (id: string, name: string, conv: string) => ({
      member_id: id,
      name,
      conversation_id: conv,
    });
    const others = [1, 2, 3, 4].map((n) =>
      member(`mem-${n}`, `成员${n}`, `conv-x${n}`)
    );
    const setup = () => {
      const defaultImpl = collaborationCall.getMockImplementation();
      const groupOf: Record<string, string | null> = { s2: 'g1', s3: 'g2' };
      collaborationCall.mockImplementation(
        async (
          capability: string,
          method: string,
          input?: Record<string, unknown>
        ) => {
          if (method === 'thread.listSidebar')
            return {
              items: [
                {
                  kind: 'group',
                  thread_id: 's2',
                  space_id: 's2',
                  name: '产品',
                  members_preview: [others[0]],
                  member_count: 1,
                  group_id: groupOf.s2,
                },
                {
                  // 6 members, preview truncated to 4 (小A not among them).
                  kind: 'group',
                  thread_id: 's3',
                  space_id: 's3',
                  name: '大群',
                  members_preview: others,
                  member_count: 6,
                  group_id: groupOf.s3,
                },
                {
                  kind: 'dm',
                  thread_id: 'direct:mem-a',
                  space_id: 'unassigned:workspace-1',
                  name: '小A',
                  member: member('mem-a', '小A', 'conv-1'),
                  group_id: groupOf['direct:mem-a'] ?? null,
                },
              ],
            };
          if (method === 'contactGroup.list')
            return {
              groups: [
                { group_id: 'g1', name: '核心', sort_order: 0 },
                { group_id: 'g2', name: '外部', sort_order: 1 },
              ],
            };
          if (method === 'space.listMembers' && input?.spaceId === 's2')
            return {
              members: [{ ...others[0], kind: 'agent', nickname: '成员1' }],
            };
          if (method === 'space.listMembers' && input?.spaceId === 's3')
            return {
              members: [
                ...others.map((m) => ({ ...m, kind: 'agent' })),
                { member_id: 'mem-5', kind: 'agent', conversation_id: 'c5' },
                {
                  member_id: 'mem-a',
                  kind: 'agent',
                  conversation_id: 'conv-1',
                },
              ],
            };
          if (method === 'thread.setGroup') {
            groupOf[String(input?.threadId)] =
              (input?.groupId as string | null) ?? null;
            return { threadId: input?.threadId, groupId: input?.groupId };
          }
          if (method === 'space.addMember') return {};
          return defaultImpl?.(capability, method, input);
        }
      );
    };
    // Pointer drag (the real app's mechanism); elementsFromPoint is stubbed
    // to report `target` under the pointer.
    const startDrag = (source: HTMLElement, target: HTMLElement) => {
      document.elementsFromPoint = vi.fn(() => [target]);
      fireEvent.pointerDown(source, { button: 0, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(window, { clientX: 30, clientY: 30 });
    };
    const drop = () =>
      fireEvent.pointerUp(window, { clientX: 30, clientY: 30 });
    const dmRow = () =>
      within(
        screen.getByTestId('collaboration-contact-row-direct:direct:mem-a')
      )
        .getByRole('button', { name: '小A' })
        .closest('.workspace-session-row') as HTMLElement;
    const groupRow = (spaceId: string) =>
      within(
        screen.getByTestId(`collaboration-contact-row-group:${spaceId}`)
      ).getByRole('button', { name: spaceId === 's2' ? '产品' : '大群' });

    it('drags a group chat row into another contact group (body area)', async () => {
      setup();
      renderPage();
      await screen.findByTestId('collaboration-contact-row-group:s2');
      // Drop on the 外部 section's rows (over the 大群 group-chat row).
      startDrag(groupRow('s2'), groupRow('s3'));
      const section = screen.getByTestId('collaboration-contact-section-g2');
      await waitFor(() => expect(section).toHaveClass('is-drop-target'));
      expect(
        screen.getByTestId('collaboration-space-group-s3')
      ).not.toHaveClass('is-drop-target');
      drop();
      await waitFor(() =>
        expect(collaborationCall).toHaveBeenCalledWith(
          'collaboration',
          'thread.setGroup',
          { threadId: 's2', groupId: 'g2' }
        )
      );
      expect(collaborationCall).not.toHaveBeenCalledWith(
        'collaboration',
        'space.addMember',
        expect.anything()
      );
    });

    it('drags a DM row onto a contact-group header', async () => {
      setup();
      renderPage();
      await screen.findByTestId(
        'collaboration-contact-row-direct:direct:mem-a'
      );
      startDrag(
        dmRow(),
        screen.getByTestId('collaboration-contact-section-header-g1')
      );
      await waitFor(() =>
        expect(
          screen.getByTestId('collaboration-contact-section-g1')
        ).toHaveClass('is-drop-target')
      );
      drop();
      await waitFor(() =>
        expect(collaborationCall).toHaveBeenCalledWith(
          'collaboration',
          'thread.setGroup',
          { threadId: 'direct:mem-a', groupId: 'g1' }
        )
      );
    });

    it('adds a member to a group chat, but blocks one already in it (>4 members)', async () => {
      setup();
      renderPage();
      await screen.findByTestId('collaboration-contact-row-group:s3');
      // Not a member of 产品: highlighted, drop -> space.addMember.
      startDrag(dmRow(), groupRow('s2'));
      await waitFor(() =>
        expect(
          screen.getByTestId('collaboration-space-group-s2')
        ).toHaveAttribute('data-drop-state', 'target')
      );
      drop();
      await waitFor(() =>
        expect(collaborationCall).toHaveBeenCalledWith(
          'collaboration',
          'space.addMember',
          expect.objectContaining({ spaceId: 's2', conversationId: 'conv-1' })
        )
      );
      collaborationCall.mockClear();

      // 大群 has 6 members; 小A is only in the full list, not the preview.
      startDrag(dmRow(), groupRow('s3'));
      const big = screen.getByTestId('collaboration-space-group-s3');
      await waitFor(() =>
        expect(big).toHaveAttribute('data-drop-state', 'blocked')
      );
      expect(big).not.toHaveClass('is-drop-target');
      expect(document.body).toHaveClass('is-drag-blocked');
      drop();
      expect(document.body).not.toHaveClass('is-drag-blocked');
      await act(async () => {});
      expect(collaborationCall).not.toHaveBeenCalledWith(
        'collaboration',
        'space.addMember',
        expect.anything()
      );
    });
  });

  describe('contact groups', () => {
    const sidebarItems = (groupOf: Record<string, string | null>) => [
      {
        kind: 'group',
        thread_id: 's1',
        space_id: 's1',
        name: '设计',
        members_preview: [],
        member_count: 1,
        group_id: groupOf.s1 ?? null,
      },
      {
        kind: 'dm',
        thread_id: 'direct:mem-a',
        space_id: 'unassigned:workspace-1',
        name: '小A',
        member: { member_id: 'mem-a', name: '小A', conversation_id: 'conv-1' },
        group_id: groupOf['direct:mem-a'] ?? null,
      },
    ];

    const mockGroups = (groups: Array<{ group_id: string; name: string }>) => {
      const defaultImpl = collaborationCall.getMockImplementation();
      const full = (g: { group_id: string; name: string }, i: number) => ({
        ...g,
        workspace_id: 'workspace-1',
        sort_order: i,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      });
      const state = {
        groups: groups.map(full),
        groupOf: { s1: 'g1' } as Record<string, string | null>,
      };
      collaborationCall.mockImplementation(
        async (
          capability: string,
          method: string,
          input?: Record<string, unknown>
        ) => {
          if (method === 'thread.listSidebar')
            return { items: sidebarItems(state.groupOf) };
          if (method === 'contactGroup.list')
            return { groups: [...state.groups] };
          if (method === 'contactGroup.create') {
            const group = full(
              { group_id: 'g-new', name: String(input?.name) },
              state.groups.length
            );
            state.groups = [...state.groups, group];
            return { group };
          }
          if (method === 'contactGroup.rename') {
            const current = state.groups.find(
              (group) => group.group_id === input?.groupId
            );
            if (!current) return {};
            const group = { ...current, name: String(input?.name ?? '') };
            state.groups = state.groups.map((item) =>
              item.group_id === group.group_id ? group : item
            );
            return { group };
          }
          if (method === 'contactGroup.delete') {
            state.groups = state.groups.filter(
              (g) => g.group_id !== input?.groupId
            );
            const ungroupedThreadIds: string[] = [];
            for (const key of Object.keys(state.groupOf))
              if (state.groupOf[key] === input?.groupId) {
                state.groupOf[key] = null;
                ungroupedThreadIds.push(key);
              }
            return {
              groupId: input?.groupId,
              deleted: true,
              ungroupedThreadIds,
            };
          }
          if (method === 'thread.setGroup') {
            state.groupOf[String(input?.threadId)] =
              (input?.groupId as string | null) ?? null;
            return {
              threadId: input?.threadId,
              groupId: input?.groupId ?? null,
            };
          }
          return defaultImpl?.(capability, method, input);
        }
      );
      return state;
    };

    const sectionOf = (testId: string) =>
      screen
        .getByTestId(testId)
        .closest('[data-testid^="collaboration-contact-section-"]')
        ?.getAttribute('data-testid');

    beforeEach(() => window.localStorage.clear());

    it('keeps the flat list when there are no groups', async () => {
      mockGroups([]);
      renderPage();
      await screen.findByTestId(
        'collaboration-direct-chat-direct:direct:mem-a'
      );
      expect(
        document.querySelector('.collaboration-contact-section')
      ).toBeNull();
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: '创建' }));
      expect(
        await screen.findByRole('menuitem', { name: '新建分组' })
      ).toBeInTheDocument();
    });

    it('renders sections, collapses, moves and deletes groups', async () => {
      const user = userEvent.setup();
      mockGroups([
        { group_id: 'g1', name: '核心' },
        { group_id: 'g2', name: '外部' },
      ]);
      renderPage();
      await screen.findByTestId('collaboration-contact-section-g1');
      const ids = Array.from(
        document.querySelectorAll('.collaboration-contact-section')
      ).map((node) => node.getAttribute('data-testid'));
      expect(ids).toEqual([
        'collaboration-contact-section-g1',
        'collaboration-contact-section-g2',
        'collaboration-contact-section-__ungrouped__',
      ]);
      expect(
        screen.getByTestId('collaboration-contact-section-header-__ungrouped__')
      ).toHaveTextContent('未分组1');
      expect(sectionOf('collaboration-contact-row-group:s1')).toBe(
        'collaboration-contact-section-g1'
      );

      fireEvent.contextMenu(
        screen.getByTestId('collaboration-contact-row-group:s1')
      );
      expect(
        await screen.findByRole('menuitem', { name: '重命名群组' })
      ).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: '置顶' })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: '删除' })).toHaveClass(
        'text-destructive'
      );
      fireEvent.keyDown(window, { key: 'Escape' });

      // Collapse persists locally.
      await user.click(
        screen.getByTestId('collaboration-contact-section-header-g1')
      );
      expect(
        screen.queryByTestId('collaboration-contact-row-group:s1')
      ).toBeNull();
      expect(
        window.localStorage.getItem(
          'vibex.collaboration.contactGroups.collapsed.workspace-1'
        )
      ).toBe('["g1"]');
      await user.click(
        screen.getByTestId('collaboration-contact-section-header-g1')
      );

      // Context menu: move the DM to 外部.
      fireEvent.contextMenu(
        screen.getByTestId('collaboration-contact-row-direct:direct:mem-a')
      );
      const moveItem = await screen.findByRole('menuitem', { name: '移至' });
      fireEvent.mouseEnter(moveItem);
      await user.click(await screen.findByRole('menuitem', { name: '外部' }));
      await waitFor(() =>
        expect(collaborationCall).toHaveBeenCalledWith(
          'collaboration',
          'thread.setGroup',
          { threadId: 'direct:mem-a', groupId: 'g2' }
        )
      );
      await waitFor(() =>
        expect(sectionOf('collaboration-contact-row-direct:direct:mem-a')).toBe(
          'collaboration-contact-section-g2'
        )
      );

      // Drop on a section header moves to that group.
      const data = new Map<string, string>([
        ['application/x-vibex-contact', 'direct:mem-a'],
      ]);
      const dataTransfer = {
        types: [...data.keys()],
        getData: (type: string) => data.get(type) ?? '',
        setData: vi.fn(),
        dropEffect: 'move',
      };
      fireEvent.drop(
        screen.getByTestId(
          'collaboration-contact-section-header-__ungrouped__'
        ),
        { dataTransfer }
      );
      await waitFor(() =>
        expect(collaborationCall).toHaveBeenCalledWith(
          'collaboration',
          'thread.setGroup',
          { threadId: 'direct:mem-a', groupId: null }
        )
      );

      // Delete 核心: its contacts go back to 未分组.
      fireEvent.contextMenu(
        screen.getByTestId('collaboration-contact-section-header-g1')
      );
      await user.click(
        await screen.findByRole('menuitem', { name: '删除分组' })
      );
      await waitFor(() =>
        expect(
          screen.queryByTestId('collaboration-contact-section-g1')
        ).toBeNull()
      );
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'contactGroup.delete',
        { groupId: 'g1' }
      );
      expect(sectionOf('collaboration-contact-row-group:s1')).toBe(
        'collaboration-contact-section-__ungrouped__'
      );
    });

    it('creates a group immediately and focuses the section title', async () => {
      const user = userEvent.setup();
      mockGroups([]);
      renderPage();
      await screen.findByTestId(
        'collaboration-direct-chat-direct:direct:mem-a'
      );
      await user.click(screen.getByRole('button', { name: '创建' }));
      await user.click(
        await screen.findByRole('menuitem', { name: '新建分组' })
      );
      await waitFor(() =>
        expect(collaborationCall).toHaveBeenCalledWith(
          'collaboration',
          'contactGroup.create',
          { workspaceId: 'workspace-1', name: '新分组' }
        )
      );
      expect(
        screen.queryByTestId('collaboration-new-contact-group-input')
      ).toBeNull();
      const renameInput = await screen.findByTestId(
        'collaboration-contact-group-rename-input'
      );
      expect(renameInput).toHaveValue('新分组');
      expect(renameInput).toHaveFocus();
      await user.clear(renameInput);
      await user.type(renameInput, '伙伴{Enter}');
      await waitFor(() =>
        expect(collaborationCall).toHaveBeenCalledWith(
          'collaboration',
          'contactGroup.rename',
          { groupId: 'g-new', name: '伙伴' }
        )
      );
      expect(
        screen.getByTestId('collaboration-contact-section-g-new')
      ).toHaveTextContent('伙伴');
      expect(
        screen.getByTestId('collaboration-contact-section-__ungrouped__')
      ).toBeInTheDocument();
    });

    it('offers pin, unread, rename 助手, copy id, hide and delete on a DM row', async () => {
      const user = userEvent.setup();
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });
      mockGroups([
        { group_id: 'g1', name: '核心' },
        { group_id: 'g2', name: '外部' },
      ]);
      renderPage();
      const row = await screen.findByTestId(
        'collaboration-contact-row-direct:direct:mem-a'
      );
      fireEvent.contextMenu(row);
      expect(
        await screen.findByRole('menuitem', { name: '置顶' })
      ).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: '移至' })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: '标为未读' })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: '重命名助手' })).toBeTruthy();
      expect(
        screen.getByRole('menuitem', { name: '复制对话 ID' })
      ).toBeTruthy();
      expect(
        screen.getByRole('menuitem', { name: '从侧边栏隐藏' })
      ).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: '删除' })).toHaveClass(
        'text-destructive'
      );

      await user.click(screen.getByRole('menuitem', { name: '置顶' }));
      expect(
        JSON.parse(
          window.localStorage.getItem(
            'vibex.collaboration.contactChrome.workspace-1'
          ) ?? '{}'
        ).pinned
      ).toEqual(['direct:mem-a']);

      fireEvent.contextMenu(row);
      await user.click(screen.getByRole('menuitem', { name: '复制对话 ID' }));
      expect(writeText).toHaveBeenCalledWith('conv-1');

      fireEvent.contextMenu(row);
      await user.click(screen.getByRole('menuitem', { name: '标为未读' }));
      await waitFor(() =>
        expect(collaborationCall).toHaveBeenCalledWith(
          'collaboration',
          'thread.markUnread',
          { threadId: 'direct:mem-a' }
        )
      );

      fireEvent.contextMenu(row);
      await user.click(screen.getByRole('menuitem', { name: '从侧边栏隐藏' }));
      expect(
        screen.getByTestId('collaboration-contact-section-hidden')
      ).toBeTruthy();
      fireEvent.contextMenu(
        screen.getByTestId('collaboration-contact-row-direct:direct:mem-a')
      );
      expect(
        screen.getByRole('menuitem', { name: '在侧边栏显示' })
      ).toBeTruthy();
    });
  });

  it('private chat uses direct:<id> listMessages/post/markRead, shows queued message optimistically and reconciles', async () => {
    const user = userEvent.setup();
    const defaultImpl = collaborationCall.getMockImplementation();
    let directMessages: Array<Record<string, unknown>> = [
      {
        seq: 5,
        conversationId: 'conv-1',
        envelope: {
          actor: 'vibex://space/direct/member/小A',
          content: '私聊历史',
        },
      },
    ];
    collaborationCall.mockImplementation(
      async (
        capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'thread.listSidebar') {
          return {
            items: [
              {
                kind: 'dm',
                thread_id: 'direct:mem-a',
                space_id: 'unassigned:workspace-1',
                name: '小A',
                last_message: { id: 5, seq: 5, preview: '私聊历史' },
                unread_count: 1,
                member: {
                  member_id: 'mem-a',
                  name: '小A',
                  conversation_id: 'conv-1',
                },
              },
            ],
          };
        }
        if (method === 'thread.markRead') return {};
        if (input?.spaceId === 'direct:mem-a') {
          if (method === 'space.listMessages') {
            const since = Number(input?.sinceSeq ?? 0);
            return {
              messages: directMessages.filter((m) => Number(m.seq) > since),
            };
          }
          if (method === 'space.post') return {};
        }
        return defaultImpl?.(capability, method, input);
      }
    );

    renderPage();
    await user.click(await screen.findByRole('button', { name: '小A' }));
    expect(
      await screen.findByTestId('collaboration-top-member-bar')
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开 小A 会话' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '群组详情' })).toBeNull();
    expect(screen.getByRole('button', { name: '助手详情' })).toBeTruthy();
    await waitFor(() => {
      expect(
        Array.from(document.querySelectorAll('.collaboration-message')).some(
          (node) => node.textContent?.includes('私聊历史')
        )
      ).toBe(true);
    });
    expect(collaborationCall).toHaveBeenCalledWith(
      'collaboration',
      'space.listMessages',
      { spaceId: 'direct:mem-a', latest: true, limit: 200 }
    );
    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'thread.markRead',
        { threadId: 'direct:mem-a', seq: 5 }
      );
    });

    const editor = getComposerEditor();
    await user.click(editor);
    await user.type(editor, '忙的时候也要收到');
    await user.click(screen.getByRole('button', { name: '发送' }));

    const postCall = await waitFor(() => {
      const call = collaborationCall.mock.calls.find(
        (c) => c[1] === 'space.post' && c[2]?.spaceId === 'direct:mem-a'
      );
      expect(call).toBeTruthy();
      return call!;
    });
    const posted = postCall[2] as Record<string, unknown>;
    expect(posted).toEqual({
      spaceId: 'direct:mem-a',
      content: '忙的时候也要收到',
      operationId: expect.any(String),
    });
    const op = String(posted.operationId);
    const pending = await screen.findByTestId(
      `collaboration-pending-message-${op}`
    );
    expect(pending).toHaveTextContent('忙的时候也要收到');
    expect(
      within(pending).getByTestId('collaboration-pending-tick')
    ).toBeTruthy();
    expect(pending.querySelector('[data-status="queued"]')).not.toBeNull();

    // The member's turn starts: the message is now listed with its operationId.
    directMessages = [
      ...directMessages,
      {
        seq: 6,
        operationId: op,
        envelope: {
          actor: 'vibex://space/direct/user',
          content: '忙的时候也要收到',
        },
      },
    ];
    act(() => {
      for (const listener of spaceEventListeners) {
        listener({
          workspaceId: 'workspace-1',
          spaceId: 'direct:mem-a',
          seq: 6,
        });
      }
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId(`collaboration-pending-message-${op}`)
      ).toBeNull();
    });
    expect(screen.getByText('忙的时候也要收到')).toBeTruthy();
  });

  it('updates member avatar status indicator dots in real time on turn lifecycle events', async () => {
    let conv2State = {
      conversation_id: 'conv-2',
      title: '小B会话',
      workspace_name: '主工作区',
      agent_id: 'CODEX',
      turn_in_flight: false,
      status: 'todo',
      updated_at: new Date().toISOString(),
    };

    const defaultImpl = collaborationCall.getMockImplementation();
    collaborationCall.mockImplementation(
      async (
        capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'space.listConversations') {
          return {
            conversations: [
              {
                conversation_id: 'conv-1',
                title: '设计会话',
                workspace_name: '主工作区',
                agent_id: 'CLAUDE_CODE',
                turn_in_flight: true,
                status: 'inprogress',
                updated_at: new Date().toISOString(),
              },
              conv2State,
            ],
          };
        }
        return defaultImpl?.(capability, method, input);
      }
    );

    renderPage();

    const memberAButton = await screen.findByRole('button', { name: '小A' });
    const memberBButton = await screen.findByRole('button', { name: '小B' });

    expect(
      memberAButton.querySelector('.workspace-session-status--inprogress')
    ).not.toBeNull();
    expect(
      memberBButton.querySelector('.workspace-session-status--todo')
    ).not.toBeNull();

    // Turn starts for 小B -> workspace-sessions-changed fires -> status dot becomes green (inprogress)
    conv2State = {
      ...conv2State,
      turn_in_flight: true,
      status: 'inprogress',
    };
    await act(async () => {
      for (const listener of workspaceSessionsListeners) {
        listener({
          workspace_id: 'workspace-1',
          conversation_id: 'conv-2',
        });
      }
    });

    await waitFor(() => {
      expect(
        memberBButton.querySelector('.workspace-session-status--inprogress')
      ).not.toBeNull();
    });

    // Open 小B's preview while turn is in flight
    await userEvent.click(memberBButton);
    const markViewedSpy = vi
      .spyOn(sessionsApi, 'markViewed')
      .mockImplementation(async (sessionId: string) => {
        if (sessionId === 'conv-2') {
          conv2State = {
            ...conv2State,
            turn_in_flight: false,
            status: 'done',
          };
        }
        return {} as never;
      });

    // Turn finishes unviewed -> status dot becomes yellow (inreview) and stays yellow even with preview open
    conv2State = {
      ...conv2State,
      turn_in_flight: false,
      status: 'inreview',
    };
    await act(async () => {
      for (const listener of workspaceSessionsListeners) {
        listener({
          workspace_id: 'workspace-1',
          conversation_id: 'conv-2',
        });
      }
    });

    await waitFor(() => {
      expect(
        memberBButton.querySelector('.workspace-session-status--inreview')
      ).not.toBeNull();
    });
    expect(markViewedSpy).not.toHaveBeenCalled();

    // User clicks member to view preview (or interacts with space/preview) -> marks viewed and status dot becomes gray (done)
    await userEvent.click(memberBButton);

    await waitFor(() => {
      expect(markViewedSpy).toHaveBeenCalledWith('conv-2');
      expect(
        memberBButton.querySelector('.workspace-session-status--done')
      ).not.toBeNull();
    });
    markViewedSpy.mockRestore();
  });

  it('clusters consecutive assistant bubbles: name on first, avatar on last', async () => {
    const defaultImpl = collaborationCall.getMockImplementation();
    collaborationCall.mockImplementation(
      async (
        capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'space.listMessages') {
          if (input?.sinceSeq) return { messages: [] };
          return {
            messages: [
              {
                seq: 1,
                envelope: { actor: 'space/member/小A', content: '第一条' },
              },
              {
                seq: 2,
                envelope: { actor: 'space/member/小A', content: '第二条' },
              },
              {
                seq: 3,
                envelope: { actor: 'space/member/小A', content: '第三条' },
              },
              {
                seq: 4,
                envelope: { actor: 'space/user', content: '我的回复' },
              },
              {
                seq: 5,
                envelope: { actor: 'space/member/小B', content: '单独一条' },
              },
            ],
          };
        }
        return defaultImpl?.(capability, method, input);
      }
    );

    renderPage();
    const first = await screen.findByTestId('collaboration-message-1');
    const second = screen.getByTestId('collaboration-message-2');
    const third = screen.getByTestId('collaboration-message-3');
    const userMsg = screen.getByTestId('collaboration-message-4');
    const solo = screen.getByTestId('collaboration-message-5');

    expect(first).toHaveAttribute('data-cluster', 'start');
    expect(second).toHaveAttribute('data-cluster', 'middle');
    expect(third).toHaveAttribute('data-cluster', 'end');
    expect(userMsg).not.toHaveAttribute('data-cluster');
    expect(solo).toHaveAttribute('data-cluster', 'solo');

    expect(within(first).getByText('小A')).toHaveClass(
      'collaboration-message-name'
    );
    expect(within(second).queryByText('小A')).toBeNull();
    expect(within(third).queryByText('小A')).toBeNull();
    expect(within(solo).getByText('小B')).toHaveClass(
      'collaboration-message-name'
    );

    expect(
      screen.queryByTestId('collaboration-message-bot-avatar-1')
    ).toBeNull();
    expect(
      screen.queryByTestId('collaboration-message-bot-avatar-2')
    ).toBeNull();
    expect(
      screen.getByTestId('collaboration-message-bot-avatar-3')
    ).toHaveClass('h-10', 'w-10');
    expect(
      screen.getByTestId('collaboration-message-bot-avatar-5')
    ).toHaveClass('h-10', 'w-10');

    expect(within(first).getByText('小A')).toHaveStyle({
      color: deriveMemberBotAvatar('conv-1').color,
    });
    expect(within(solo).getByText('小B')).toHaveStyle({
      color: deriveMemberBotAvatar('conv-2').color,
    });
  });

  it('opens the current-chat bot session from the assistant list and the message sender', async () => {
    const user = userEvent.setup();
    const defaultImpl = collaborationCall.getMockImplementation();
    collaborationCall.mockImplementation(
      async (
        capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'member.session.resolve') {
          const memberId = String(input?.memberId ?? '');
          const threadId = String(input?.threadId ?? '');
          return {
            conversationId: `${memberId}:${threadId}`,
          };
        }
        return defaultImpl?.(capability, method, input);
      }
    );
    renderPage();
    await screen.findByRole('button', { name: '设计' });
    await user.click(
      await screen.findByRole('button', { name: '打开 小A 会话' })
    );
    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'member.session.resolve',
        expect.objectContaining({ memberId: 'm1', threadId: 's1' })
      );
    });
    const groupSession = await screen.findByTestId('session-preview');
    expect(groupSession).toHaveTextContent('m1:s1');
    expect(groupSession).toHaveAttribute('data-hide-persona', 'true');
    expect(
      within(groupSession).getByTestId('composer-member-identity')
    ).toHaveTextContent('小A');

    await user.click(
      await screen.findByRole('button', { name: '预览 小B 会话' })
    );
    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'member.session.resolve',
        expect.objectContaining({ memberId: 'm2', threadId: 's1' })
      );
    });
    const nextSession = await screen.findByTestId('session-preview');
    expect(nextSession).toHaveTextContent('m2:s1');
    expect(
      within(nextSession).getByTestId('composer-member-identity')
    ).toHaveTextContent('小B');
  });

  it('opens the private-chat bot session and assistant details tabs', async () => {
    const user = userEvent.setup();
    const defaultImpl = collaborationCall.getMockImplementation();
    collaborationCall.mockImplementation(
      async (
        capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'thread.listSidebar') {
          return {
            items: [
              {
                kind: 'dm',
                thread_id: 'direct:mem-a',
                space_id: 'unassigned:workspace-1',
                name: '小A',
                member: {
                  member_id: 'mem-a',
                  name: '小A',
                  conversation_id: 'conv-1',
                },
              },
            ],
          };
        }
        if (method === 'member.session.resolve') {
          return { conversationId: 'conv-dm-a' };
        }
        if (method === 'space.listCollection') {
          return { items: [] };
        }
        if (method === 'member.config.get') {
          return {
            memberId: 'mem-a',
            config: {
              agent_id: 'CLAUDE_CODE',
              mode_id: 'default',
              config_values: { model: 'grok-4.6' },
              persona_prompt: '你是小A',
            },
          };
        }
        if (
          input?.spaceId === 'direct:mem-a' &&
          method === 'space.listMessages'
        ) {
          return {
            messages: [
              {
                seq: 1,
                envelope: {
                  actor: 'vibex://space/direct/member/小A',
                  content: '私聊一条',
                },
              },
            ],
          };
        }
        return defaultImpl?.(capability, method, input);
      }
    );
    renderPage();
    await user.click(await screen.findByRole('button', { name: '小A' }));
    expect(
      await screen.findByTestId('collaboration-top-member-bar')
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '打开 小A 会话' }));
    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'member.session.resolve',
        expect.objectContaining({
          memberId: 'mem-a',
          threadId: 'direct:mem-a',
        })
      );
    });
    const dmSession = await screen.findByTestId('session-preview');
    expect(dmSession).toHaveTextContent('conv-dm-a');
    expect(dmSession).toHaveAttribute('data-hide-persona', 'true');
    expect(
      within(dmSession).getByTestId('composer-member-identity')
    ).toHaveTextContent('小A');

    await user.click(screen.getByRole('button', { name: '助手详情' }));
    const panel = await screen.findByTestId(
      'collaboration-space-collection-panel'
    );
    expect(within(panel).getByText('小A')).toBeTruthy();
    expect(
      within(panel).getByTestId('collaboration-group-details-tab-details')
    ).toHaveAttribute('aria-selected', 'true');
    expect(
      within(panel).getByTestId('collaboration-assistant-details-session')
    ).toBeTruthy();
    expect(within(panel).queryByText('群收藏')).toBeNull();
    expect(within(panel).getByText('收藏')).toBeTruthy();
    expect(within(panel).getByText('自定义')).toBeTruthy();
    expect(within(panel).queryByText('成员')).toBeNull();

    await user.click(
      within(panel).getByTestId('collaboration-group-details-tab-collection')
    );
    expect(
      within(panel).getByTestId('collaboration-collection-dropzone')
    ).toBeTruthy();

    await user.click(
      within(panel).getByTestId('collaboration-group-details-tab-customize')
    );
    expect(
      await within(panel).findByTestId('collaboration-assistant-customize-form')
    ).toBeTruthy();
    expect(
      within(panel).getByRole('textbox', { name: '助手名称' })
    ).toHaveValue('小A');
    expect(
      within(panel).queryByRole('combobox', { name: '选择 Agent' })
    ).toBeNull();
    await waitFor(() => {
      expect(within(panel).getByLabelText('人设提示词（可选）')).toHaveValue(
        '你是小A'
      );
    });
  });
});
