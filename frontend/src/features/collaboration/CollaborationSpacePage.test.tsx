import { useState } from 'react';
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
import { resetSharedSpaceComposerDrafts } from './spaceComposerDrafts';
import { mentionNicknames, strayMentions } from './spaceModel';

const collaborationCall = vi.hoisted(() => vi.fn());
const writeClipboard = vi.hoisted(() => vi.fn(async () => true));
const sessionPreviewSpy = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const toastInfo = vi.hoisted(() => vi.fn());
const { uploadForAttemptMock, uploadMock } = vi.hoisted(() => ({
  uploadForAttemptMock: vi.fn(),
  uploadMock: vi.fn(),
}));
const spaceEventListeners = vi.hoisted(
  () => new Set<(payload: unknown) => void>()
);
const workspaceSessionsListeners = vi.hoisted(
  () => new Set<(payload: unknown) => void>()
);
const agentEventListeners = vi.hoisted(
  () => new Set<(payload: unknown) => void>()
);

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    imagesApi: {
      ...actual.imagesApi,
      uploadForAttempt: uploadForAttemptMock,
      upload: uploadMock,
    },
  };
});

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
        if (event === 'agent-events') {
          agentEventListeners.add(handler);
          return () => {
            agentEventListeners.delete(handler);
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

vi.mock('@/vscode/bridge', () => ({
  writeClipboardViaBridge: writeClipboard,
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

const useConversationTimeline = vi.hoisted(() =>
  vi.fn((_id: string | null) => ({
    timeline: [] as unknown[],
    items: [] as unknown[],
    sideRows: [] as unknown[],
    sessionConfigOptions: [] as unknown[],
    currentTurnId: null as string | null,
    respondPermission: vi.fn(),
  }))
);

vi.mock('@/features/conversation/useConversationTimeline', () => ({
  useConversationTimeline,
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
    resetSharedSpaceComposerDrafts();
    useCollaborationLayoutStore.setState({
      isSpacesVisible: true,
      isThreadVisible: true,
      isPreviewVisible: true,
      hasOpenedSpaceThread: false,
      hasMountedPreviewTabs: false,
      sessionFocus: null,
    });
    collaborationCall.mockReset();
    useConversationTimeline.mockReset();
    useConversationTimeline.mockImplementation(() => ({
      timeline: [],
      items: [],
      sideRows: [],
      sessionConfigOptions: [],
      currentTurnId: null,
      respondPermission: vi.fn(),
    }));
    sessionPreviewSpy.mockReset();
    writeClipboard.mockReset();
    writeClipboard.mockResolvedValue(true);
    uploadForAttemptMock.mockReset();
    uploadMock.mockReset();
    uploadForAttemptMock.mockResolvedValue({
      id: 'img-1',
      original_name: 'shot.png',
      file_path: '.vibe-images/shot.png',
    });
    uploadMock.mockResolvedValue({
      id: 'img-1',
      original_name: 'shot.png',
      file_path: '.vibe-images/shot.png',
    });
    spaceEventListeners.clear();
    workspaceSessionsListeners.clear();
    agentEventListeners.clear();
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
                  envelope: { sender: '小A', content: '增量消息' },
                },
              ],
            };
          }
          return {
            messages: [
              {
                seq: 1,
                envelope: { sender: '小A', content: '你好' },
              },
              {
                seq: 2,
                envelope: {
                  sender: '小B',
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
        if (method === 'space.warmup') {
          return { nicknames: [], started: 0, alreadyRunning: 0 };
        }
        if (method === 'space.post') {
          return {
            message_id: String(input?.operationId ?? 'msg-1'),
            seq: 4,
            receipts: [
              {
                conversation_id: 'conv-1',
                nickname: '小A',
                delivered: 'queued',
              },
            ],
          };
        }
        if (method === 'space.react') {
          return {
            reactions: [
              {
                emoji: String(input?.emoji ?? ''),
                actor: 'user',
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

    // Bot-only logs have no piano-key ticks; user messages are tested below.
    expect(
      document.querySelector('.collaboration-thread .conv-message-nav-rail')
    ).toBeNull();

    // Setting a space tag color draws it as an outline ring around the group avatar, with bold 颜色标签 title and 取消标签 action
    await user.click(screen.getByRole('button', { name: '标签 设计' }));
    const tagHeading = await screen.findByText('颜色标签');
    expect(tagHeading).toHaveClass('font-bold');
    const clearTagBtn = screen.getByRole('button', { name: '取消标签' });
    expect(clearTagBtn).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: '蓝色' }));
    const spaceButton = screen.getByRole('button', { name: '设计' });
    const groupAvatar = within(spaceButton).getByTestId(
      'collaboration-group-avatar'
    );
    expect(groupAvatar).toHaveClass('has-tag', 'is-breathing');
    expect(groupAvatar).toHaveAttribute('data-count', '2');
    expect(groupAvatar).toHaveAttribute('data-session-active', 'true');
    expect(groupAvatar).toHaveStyle({ width: '40px', height: '40px' });
    expect(groupAvatar.style.getPropertyValue('--group-avatar-tag')).toBe(
      'hsl(214 88% 56%)'
    );
    await user.click(clearTagBtn);
    expect(groupAvatar).not.toHaveClass('has-tag');
    expect(groupAvatar).toHaveClass('is-breathing');
    expect(groupAvatar.style.getPropertyValue('--group-avatar-tag')).toBe(
      'hsl(152 68% 42%)'
    );
    await user.click(await screen.findByRole('button', { name: '蓝色' }));
    expect(groupAvatar).toHaveClass('has-tag', 'is-breathing');

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
      width: '40px',
      height: '40px',
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
    const createAssistantMenuItem = screen.getByRole('menuitem', {
      name: '创建助手',
    });
    const createGroupMenuItem = screen.getByRole('menuitem', {
      name: '新建分组',
    });
    expect(createSpaceMenuItem.querySelector('svg')).toBeTruthy();
    expect(createAssistantMenuItem.querySelector('svg')).toBeTruthy();
    expect(createGroupMenuItem.querySelector('svg')).toBeTruthy();
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
    const noTagBtn = within(dialogInThread).getByRole('button', {
      name: '无标签',
    });
    expect(noTagBtn).toHaveClass('is-selected');
    await user.click(
      within(dialogInThread).getByRole('button', { name: '绿色' })
    );
    expect(
      within(dialogInThread).queryByRole('textbox', { name: '标签名称' })
    ).toBeNull();
    expect(noTagBtn).not.toHaveClass('is-selected');
    await user.click(noTagBtn);
    expect(noTagBtn).toHaveClass('is-selected');

    const createBotList = within(dialogInThread).getByTestId(
      'collaboration-create-bot-list'
    );
    await user.click(
      within(createBotList).getByRole('button', { name: '小B' })
    );
    expect(
      within(createBotList).queryByRole('button', { name: '小B' })
    ).toBeNull();
    const selectedChips = within(dialogInThread).getByTestId(
      'collaboration-space-members-list'
    );
    const chipB = within(selectedChips).getByTestId(
      'collaboration-space-member-chip-conv-2'
    );
    expect(chipB).toHaveTextContent('小B');
    await user.click(within(chipB).getByRole('button', { name: /小B/ }));
    expect(
      within(createBotList).getByRole('button', { name: '小B' })
    ).toBeTruthy();
    await user.click(
      within(createBotList).getByRole('button', { name: '小A' })
    );
    await user.click(
      within(createBotList).getByRole('button', { name: '小B' })
    );
    expect(
      within(dialogInThread).getByRole('button', { name: '创建群聊' })
    ).not.toBeDisabled();

    const closeDialogBtn = screen.getByRole('button', {
      name: /^(关闭|Close)$/,
    });
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
  }, 45_000);

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
    expect(within(menu).getByRole('tab', { name: /助手/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(
      within(menu).getByRole('option', { name: /全体成员/ })
    ).toBeVisible();
    expect(within(menu).queryByRole('option', { name: /^全体$/ })).toBeNull();
    expect(within(menu).queryByRole('option', { name: /你/ })).toBeNull();

    await user.click(within(menu).getByRole('option', { name: /小A/ }));
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
    expect(screen.queryByText('小A 已收到')).toBeNull();
    const ticks = await screen.findAllByTestId('collaboration-message-ticks');
    expect(
      ticks.some((el) => el.getAttribute('data-status') === 'queued')
    ).toBe(true);
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

  it('warms the group composer target after debounce and does not toast on failure', async () => {
    const user = userEvent.setup();
    const defaultImpl = collaborationCall.getMockImplementation();
    collaborationCall.mockImplementation(
      async (
        capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'space.warmup') {
          throw new Error('warmup boom');
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
    await user.type(editor, '开工');
    await waitFor(
      () => {
        expect(collaborationCall).toHaveBeenCalledWith(
          'collaboration',
          'space.warmup',
          expect.objectContaining({
            spaceId: 's1',
            content: expect.stringContaining('开工'),
            to: [],
          })
        );
      },
      { timeout: 2000 }
    );
    const warmupCalls = collaborationCall.mock.calls.filter(
      (call) => call[1] === 'space.warmup'
    );
    expect(warmupCalls.length).toBe(1);
    expect(toastError).not.toHaveBeenCalled();
    await user.type(editor, '再写一点');
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(
      collaborationCall.mock.calls.filter((call) => call[1] === 'space.warmup')
        .length
    ).toBe(1);
  }, 15_000);

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

  it('clears the attachment drawer before space.post resolves', async () => {
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

    Object.assign(URL, {
      createObjectURL: () => 'blob:shot',
      revokeObjectURL: () => undefined,
    });
    const imageFile = new File(['png'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(getComposerEditor(), {
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
    await waitFor(() => {
      expect(
        uploadForAttemptMock.mock.calls.length + uploadMock.mock.calls.length
      ).toBeGreaterThan(0);
    });
    expect(
      await screen.findByTestId('session-composer-attachment-drawer')
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => {
      expect(
        screen.queryByTestId('session-composer-attachment-drawer')
      ).toBeNull();
    });
    expect(
      collaborationCall.mock.calls.some((call) => call[1] === 'space.post')
    ).toBe(true);
    const postCall = collaborationCall.mock.calls.find(
      (call) => call[1] === 'space.post'
    );
    expect(postCall?.[2]).toEqual(
      expect.objectContaining({
        content: expect.stringContaining('shot.png'),
      })
    );

    releasePost?.({});
  });

  it('restores the attachment drawer when space.post fails', async () => {
    const user = userEvent.setup();
    collaborationCall.mockImplementation(
      async (
        _capability: string,
        method: string,
        _input?: Record<string, unknown>
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
            ],
          };
        }
        if (method === 'space.listMessages') {
          return { messages: [] };
        }
        if (method === 'space.post') {
          throw new Error('post failed');
        }
        return {};
      }
    );

    renderPage();
    expect(await screen.findByRole('button', { name: '小A' })).toBeTruthy();

    Object.assign(URL, {
      createObjectURL: () => 'blob:shot',
      revokeObjectURL: () => undefined,
    });
    const imageFile = new File(['png'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(getComposerEditor(), {
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
    await waitFor(() => {
      expect(
        uploadForAttemptMock.mock.calls.length + uploadMock.mock.calls.length
      ).toBeGreaterThan(0);
    });
    expect(
      await screen.findByTestId('session-composer-attachment-drawer')
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('post failed')).toBeTruthy();
    expect(
      await screen.findByTestId('session-composer-attachment-drawer')
    ).toBeTruthy();
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
    expect(editor).toHaveTextContent('小A 重试这条');
    expect(
      editor.querySelector(
        '[data-token-kind="member_mention"][data-token-value="@小A"]'
      )
    ).not.toBeNull();

    await user.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('没有送达')).toBeTruthy();
    expect(await screen.findByText('小A 失败')).toBeTruthy();
    expect(editor).toHaveTextContent('小A 重试这条');

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

  it('restores composer draft after switching space and coming back', async () => {
    const user = userEvent.setup();
    collaborationCall.mockImplementation(
      async (
        _capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'space.list') {
          return {
            spaces: [
              { space_id: 's1', name: '设计' },
              { space_id: 's2', name: '研发' },
            ],
          };
        }
        if (method === 'thread.listSidebar') {
          return {
            items: [
              {
                kind: 'group',
                thread_id: 's1',
                space_id: 's1',
                name: '设计',
                last_message: null,
                unread_count: 0,
                member_count: 1,
              },
              {
                kind: 'group',
                thread_id: 's2',
                space_id: 's2',
                name: '研发',
                last_message: null,
                unread_count: 0,
                member_count: 1,
              },
            ],
          };
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
            ],
          };
        }
        if (method === 'space.listMessages') {
          return {
            messages: [
              {
                seq: 1,
                envelope: {
                  sender: '小A',
                  content:
                    String(input?.spaceId) === 's2' ? '研发消息' : '设计消息',
                },
              },
            ],
          };
        }
        return {};
      }
    );

    renderPage();
    const spacesPane = await screen.findByLabelText('协作空间');
    expect(
      await within(spacesPane).findByRole('button', { name: '研发' })
    ).toBeTruthy();
    const editor = getComposerEditor();
    await user.click(editor);
    await user.type(editor, 'keep-this-draft');
    expect(editor).toHaveTextContent('keep-this-draft');

    await user.click(within(spacesPane).getByRole('button', { name: '研发' }));
    await waitFor(() => {
      expect(screen.getByTestId('composer-current-space')).toHaveTextContent(
        '研发'
      );
    });
    expect(getComposerEditor()).toHaveTextContent('');

    await user.click(within(spacesPane).getByRole('button', { name: '设计' }));
    await waitFor(() => {
      expect(screen.getByTestId('composer-current-space')).toHaveTextContent(
        '设计'
      );
    });
    expect(getComposerEditor()).toHaveTextContent('keep-this-draft');
  });

  it('keeps composer draft when unmounting and remounting the page (switching pages)', async () => {
    const user = userEvent.setup();
    const firstMount = renderPage('workspace-1');
    await screen.findByTestId('composer-current-space');
    const editor = getComposerEditor();
    await user.click(editor);
    await user.type(editor, 'draft-across-page-switch');
    expect(editor).toHaveTextContent('draft-across-page-switch');

    firstMount.unmount();

    renderPage('workspace-1');
    await screen.findByTestId('composer-current-space');
    await waitFor(() => {
      expect(getComposerEditor()).toHaveTextContent('draft-across-page-switch');
    });
  });

  it('keeps composer draft when switching projects and switching back', async () => {
    const user = userEvent.setup();
    collaborationCall.mockImplementation(
      async (
        _capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        const ws = String(input?.workspaceId ?? '');
        if (method === 'space.list') {
          return {
            spaces:
              ws === 'workspace-2'
                ? [{ space_id: 's2-w2', name: '项目二空间' }]
                : [{ space_id: 's1-w1', name: '项目一空间' }],
          };
        }
        if (method === 'thread.listSidebar') {
          return {
            items: [
              ws === 'workspace-2'
                ? {
                    kind: 'group',
                    thread_id: 's2-w2',
                    space_id: 's2-w2',
                    name: '项目二空间',
                    last_message: null,
                    unread_count: 0,
                    member_count: 1,
                  }
                : {
                    kind: 'group',
                    thread_id: 's1-w1',
                    space_id: 's1-w1',
                    name: '项目一空间',
                    last_message: null,
                    unread_count: 0,
                    member_count: 1,
                  },
            ],
          };
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
            ],
          };
        }
        if (method === 'space.listMessages') {
          return { messages: [] };
        }
        return {};
      }
    );

    let setActiveWorkspaceId: ((next: string) => void) | null = null;
    function ProjectSwitchHost() {
      const [wsId, setWsId] = useState('workspace-1');
      setActiveWorkspaceId = setWsId;
      return (
        <HotkeysProvider initiallyActiveScopes={['dialog']}>
          <CollaborationSpacePage workspaceId={wsId} />
        </HotkeysProvider>
      );
    }

    render(<ProjectSwitchHost />);
    await waitFor(() => {
      expect(screen.getByTestId('composer-current-space')).toHaveTextContent(
        '项目一空间'
      );
    });
    const editor1 = getComposerEditor();
    await user.click(editor1);
    await user.type(editor1, 'draft-in-project-1');
    expect(editor1).toHaveTextContent('draft-in-project-1');

    act(() => {
      setActiveWorkspaceId?.('workspace-2');
    });
    await waitFor(() => {
      expect(screen.getByTestId('composer-current-space')).toHaveTextContent(
        '项目二空间'
      );
    });
    expect(getComposerEditor()).toHaveTextContent('');

    act(() => {
      setActiveWorkspaceId?.('workspace-1');
    });
    await waitFor(() => {
      expect(screen.getByTestId('composer-current-space')).toHaveTextContent(
        '项目一空间'
      );
    });
    await waitFor(() => {
      expect(getComposerEditor()).toHaveTextContent('draft-in-project-1');
    });
  });

  it('keeps composer images with the space that attached them', async () => {
    const user = userEvent.setup();
    collaborationCall.mockImplementation(
      async (
        _capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'space.list') {
          return {
            spaces: [
              { space_id: 's1', name: '设计' },
              { space_id: 's2', name: '研发' },
            ],
          };
        }
        if (method === 'thread.listSidebar') {
          return {
            items: [
              {
                kind: 'group',
                thread_id: 's1',
                space_id: 's1',
                name: '设计',
                last_message: null,
                unread_count: 0,
                member_count: 1,
              },
              {
                kind: 'group',
                thread_id: 's2',
                space_id: 's2',
                name: '研发',
                last_message: null,
                unread_count: 0,
                member_count: 1,
              },
            ],
          };
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
            ],
          };
        }
        if (method === 'space.listMessages') {
          return {
            messages: [
              {
                seq: 1,
                envelope: {
                  sender: '小A',
                  content:
                    String(input?.spaceId) === 's2' ? '研发消息' : '设计消息',
                },
              },
            ],
          };
        }
        return {};
      }
    );

    renderPage();
    const spacesPane = await screen.findByLabelText('协作空间');
    expect(
      await within(spacesPane).findByRole('button', { name: '研发' })
    ).toBeTruthy();

    Object.assign(URL, {
      createObjectURL: () => 'blob:shot',
      revokeObjectURL: () => undefined,
    });
    const imageFile = new File(['png'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(getComposerEditor(), {
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
    expect(
      await screen.findByTestId('session-composer-attachment-drawer')
    ).toBeTruthy();

    await user.click(within(spacesPane).getByRole('button', { name: '研发' }));
    await waitFor(() => {
      expect(screen.getByTestId('composer-current-space')).toHaveTextContent(
        '研发'
      );
    });
    expect(
      screen.queryByTestId('session-composer-attachment-drawer')
    ).toBeNull();

    await user.click(within(spacesPane).getByRole('button', { name: '设计' }));
    await waitFor(() => {
      expect(screen.getByTestId('composer-current-space')).toHaveTextContent(
        '设计'
      );
    });
    expect(
      await screen.findByTestId('session-composer-attachment-drawer')
    ).toBeTruthy();
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
    const createBtn = screen.getByRole('button', { name: '创建' });
    expect(
      Boolean(
        searchBtn.compareDocumentPosition(createBtn) &
          Node.DOCUMENT_POSITION_FOLLOWING
      )
    ).toBe(true);
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
    const filterNameItem = await screen.findByTestId(
      'collaboration-filter-name'
    );
    const filterTypeItem = screen.getByTestId('collaboration-filter-type');
    const filterActivityItem = screen.getByTestId(
      'collaboration-filter-activity'
    );
    expect(filterNameItem).toHaveTextContent('按名称');
    expect(filterTypeItem).toHaveTextContent('按类型 · 群聊');
    expect(filterActivityItem).toHaveTextContent('按活跃时间');
    expect(filterNameItem.querySelector('svg')).toBeTruthy();
    expect(filterTypeItem.querySelector('svg')).toBeTruthy();
    expect(
      filterActivityItem.querySelectorAll('svg').length
    ).toBeGreaterThanOrEqual(2);
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
    fireEvent.pointerDown(spacesResizer, { clientX: 266 });
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
            identity_member_id: 'm-created',
            direct_thread_id: 'direct:m-created',
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
              {
                id: 'role-1',
                name: '前端专家',
                agent_id: 'CLAUDE_CODE',
                persona_prompt: '擅长前端架构的搭档',
              },
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
          if (String(input?.spaceId ?? '').startsWith('direct:')) {
            const error = new Error('space was not found') as Error & {
              code: string;
            };
            error.code = 'not_found';
            throw error;
          }
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
    // Default space is no longer shown; instead a default Master bot is auto-created and its private chat opens on the right
    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'space.createMember',
        expect.objectContaining({
          workspaceId: 'workspace-1',
          spaceId: '',
          nickname: 'Master',
          source: 'custom',
          agentId: 'CLAUDE_CODE',
          modeId: '',
          configValues: {},
          color: '#000000',
          avatar: JSON.stringify({
            color: '#000000',
            shape: 'circle',
            expression: 'neutral',
          }),
          personaPrompt: expect.stringContaining('全能管家'),
        })
      );
    });
    expect(screen.queryByRole('button', { name: '默认空间' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: '新建空间' })).toBeNull();
    expect(screen.queryByText('协作空间')).toBeNull();
    expect(screen.queryByLabelText('预览')).toBeNull();
    expect(
      await screen.findByRole('button', { name: '打开 Master 会话' })
    ).toBeTruthy();
    const masterAvatar = screen.getByTestId(
      'collaboration-member-bot-avatar-conv-created'
    );
    expect(masterAvatar).toHaveAttribute('data-bot-color', '#000000');
    expect(masterAvatar).toHaveAttribute('data-bot-shape', 'circle');
    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'space.post',
        expect.objectContaining({
          spaceId: 'direct:m-created',
          content: expect.stringMatching(
            /<vibex-private-bootstrap>[\s\S]*你刚被设为用户的总管 Bot[\s\S]*如果人设另有说明，以人设为准。[\s\S]*<\/vibex-private-bootstrap>/
          ),
        })
      );
    });

    // Test unified 新建助手 overlay inside message area (基于角色 / 基于会话 / 自定义, without 归属团队)
    await user.click(screen.getByRole('button', { name: '创建' }));
    await user.click(await screen.findByRole('menuitem', { name: '创建助手' }));
    const memberDialog = await screen.findByRole('dialog', {
      name: '新建助手',
    });
    expect(memberDialog).toBeTruthy();
    expect(
      within(memberDialog).queryByRole('combobox', { name: /归属团队/ })
    ).toBeNull();
    const avatarPropertySelector = within(memberDialog).getByRole(
      'radiogroup',
      {
        name: '头像属性',
      }
    );
    const avatarPropertyRadios = within(avatarPropertySelector).getAllByRole(
      'radio'
    );
    expect(avatarPropertyRadios).toHaveLength(2);
    expect(avatarPropertyRadios[0].querySelector('svg')).not.toBeNull();
    expect(avatarPropertyRadios[1].querySelector('svg')).not.toBeNull();

    const sourceSelector = within(memberDialog).getByRole('radiogroup', {
      name: '创建方式',
    });
    const sourceRadioItems = within(sourceSelector).getAllByRole('radio');
    expect(sourceRadioItems.map((opt) => opt.textContent)).toEqual([
      '基于角色',
      '基于会话',
      '自定义',
    ]);
    await user.click(sourceRadioItems[1]);
    const sessionPersonaTextarea = within(memberDialog).getByRole('textbox', {
      name: '人设（可选）',
    });
    expect(sessionPersonaTextarea).toHaveValue('');
    expect(sessionPersonaTextarea).toHaveAttribute(
      'placeholder',
      '例如：你是资深前端工程师，擅长 React 与交互设计，回答简洁直接。'
    );
    await user.click(sourceRadioItems[2]);
    const customPersonaTextarea = within(memberDialog).getByRole('textbox', {
      name: '人设（可选）',
    });
    expect(customPersonaTextarea).toHaveValue('');
    expect(customPersonaTextarea).toHaveAttribute(
      'placeholder',
      '例如：你是资深前端工程师，擅长 React 与交互设计，回答简洁直接。'
    );
    await user.click(sourceRadioItems[0]);
    const rolePersonaTextarea = within(memberDialog).getByRole('textbox', {
      name: '人设（可选）',
    });
    expect(rolePersonaTextarea).toHaveValue('擅长前端架构的搭档');
    await user.clear(rolePersonaTextarea);
    await user.type(rolePersonaTextarea, '擅长前端架构与设计系统的搭档');

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
          personaPrompt: '擅长前端架构与设计系统的搭档',
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
    expect(screen.queryByRole('button', { name: '默认空间' })).toBeNull();
    expect(screen.queryByLabelText('预览')).toBeNull();
    expect(
      await screen.findByTestId('collaboration-top-member-bar')
    ).toBeTruthy();
    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'space.post',
        expect.objectContaining({
          spaceId: 'direct:m-created',
          content: expect.stringMatching(
            /<vibex-private-bootstrap>[\s\S]*用户刚创建了你。请用一句简短的话向用户打个招呼[\s\S]*如果人设另有说明，以人设为准。[\s\S]*<\/vibex-private-bootstrap>/
          ),
        })
      );
    });
    expect(screen.queryByText(/vibex-private-bootstrap/)).toBeNull();
    await act(async () => {
      for (const listener of spaceEventListeners) {
        listener({
          workspaceId: 'workspace-1',
          spaceId: 'direct:m-created',
          memberId: 'm-created',
        });
      }
    });
    await waitFor(() => {
      expect(screen.queryByText('昵称不存在')).toBeNull();
    });
    expect(
      collaborationCall.mock.calls.filter(
        (call) =>
          call[1] === 'space.listMembers' &&
          String(
            (call[2] as { spaceId?: string } | undefined)?.spaceId ?? ''
          ).startsWith('direct:')
      )
    ).toHaveLength(0);

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
                  sender: '小A',
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
          return {
            spaces: [{ space_id: 's1', name: '设计', kind: 'group' }],
          };
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
                  sender: 'Person',
                  content: '请查看附件\n\n![spec.pdf](.vibe-images/spec.pdf)',
                },
              },
            ],
            scheduled: [],
          };
        }
        if (method === 'space.listCollection') {
          return {
            collectionDir: 'C:/Users/test/.vibex/spaces/s1/collection',
            collection_dir: 'C:/Users/test/.vibex/spaces/s1/collection',
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
    await user.click(
      within(collectionPanel).getByTestId('collaboration-assets-tab-collection')
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
    ).toHaveTextContent('你');
    expect(
      within(collectionPanel).queryByTestId('collaboration-collection-path')
    ).toBeNull();
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

  it('copies text and image collection items and deletes a saved item', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    let items: Array<Record<string, unknown>> = [
      {
        id: 'col-text',
        space_id: 's1',
        project_id: 'proj-1',
        kind: 'text',
        name: 'api-contract.md',
        file_path: 'C:/tmp/col-text.md',
        mime_type: 'text/plain',
        byte_size: 42,
        note: '',
        creator_nickname: '小A',
        creator_conversation_id: 'conv-1',
        created_at: '2026-10-23T01:00:00Z',
        text_content: 'GET /api/v1/spaces',
        reads: [],
      },
      {
        id: 'col-image',
        space_id: 's1',
        project_id: 'proj-1',
        kind: 'image',
        name: 'shot.png',
        file_path: 'C:/tmp/shot.png',
        mime_type: 'image/png',
        byte_size: 128,
        note: '',
        creator_nickname: 'User',
        created_at: '2026-10-23T01:02:00Z',
        reads: [],
      },
      {
        id: 'col-file',
        space_id: 's1',
        project_id: 'proj-1',
        kind: 'file',
        name: 'spec.pdf',
        file_path: 'C:/tmp/spec.pdf',
        mime_type: 'application/pdf',
        byte_size: 2048,
        note: '',
        creator_nickname: 'User',
        created_at: '2026-10-23T01:03:00Z',
        reads: [],
      },
    ];
    const defaultImpl = collaborationCall.getMockImplementation();
    collaborationCall.mockImplementation(
      async (
        capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'space.listCollection') {
          return { items };
        }
        if (method === 'space.removeCollectionItem') {
          items = items.filter((item) => item.id !== input?.itemId);
          return { removed: true, id: input?.itemId };
        }
        return defaultImpl?.(capability, method, input);
      }
    );

    renderPage();
    await user.click(
      await screen.findByTestId('collaboration-open-collection-btn')
    );
    const collectionPanel = await screen.findByTestId(
      'collaboration-space-collection-panel'
    );
    await user.click(
      within(collectionPanel).getByTestId(
        'collaboration-group-details-tab-collection'
      )
    );
    await user.click(
      within(collectionPanel).getByTestId('collaboration-assets-tab-collection')
    );

    const textKind = await within(collectionPanel).findByTestId(
      'collection-item-kind-col-text'
    );
    const textOpenTab = within(collectionPanel).getByTestId(
      'collection-item-open-tab-col-text'
    );
    const textCopy = within(collectionPanel).getByTestId(
      'collection-item-copy-col-text'
    );
    expect(textKind).toHaveTextContent('文本');
    expect(textKind.nextElementSibling).toBe(textOpenTab);
    expect(textOpenTab.nextElementSibling).toBe(textCopy);
    expect(textCopy).toHaveAttribute('aria-label', '复制');
    expect(textCopy.textContent).toBe('');

    const imageKind = within(collectionPanel).getByTestId(
      'collection-item-kind-col-image'
    );
    const imageCopy = within(collectionPanel).getByTestId(
      'collection-item-copy-col-image'
    );
    expect(imageKind).toHaveTextContent('图片');
    expect(imageKind.nextElementSibling).toBe(imageCopy);
    expect(
      within(collectionPanel).queryByTestId('collection-item-copy-col-file')
    ).toBeNull();
    const fileKind = within(collectionPanel).getByTestId(
      'collection-item-kind-col-file'
    );
    const fileDelete = within(collectionPanel).getByTestId(
      'collection-item-delete-col-file'
    );
    expect(fileKind.nextElementSibling).toBe(fileDelete);

    const uploadBtn = within(collectionPanel).getByTestId(
      'collaboration-collection-upload-file-btn'
    );
    const headerDelete = within(collectionPanel).getByTestId(
      'collaboration-collection-delete-btn'
    );
    expect(uploadBtn.nextElementSibling).toBe(headerDelete);
    expect(headerDelete).toHaveAttribute('aria-label', '删除');
    expect(headerDelete.textContent).toBe('');
    expect(headerDelete.className).toContain(
      'collaboration-collection-delete-btn'
    );
    expect(headerDelete).toBeDisabled();

    const textDelete = within(collectionPanel).getByTestId(
      'collection-item-delete-col-text'
    );
    expect(textCopy.nextElementSibling).toBe(textDelete);
    expect(textDelete).toHaveAttribute('aria-label', '删除');
    expect(textDelete.textContent).toBe('');

    await user.click(textCopy);
    expect(writeText).toHaveBeenCalledWith('GET /api/v1/spaces');

    await user.click(
      within(collectionPanel).getByTestId('collection-item-delete-col-text')
    );
    expect(collaborationCall).toHaveBeenCalledWith(
      'collaboration',
      'space.removeCollectionItem',
      expect.objectContaining({
        spaceId: 's1',
        itemId: 'col-text',
      })
    );
    await waitFor(() => {
      expect(
        within(collectionPanel).queryByTestId('collection-item-col-text')
      ).toBeNull();
    });

    await user.click(imageKind);
    expect(headerDelete).not.toBeDisabled();
    await user.click(headerDelete);
    expect(collaborationCall).toHaveBeenCalledWith(
      'collaboration',
      'space.removeCollectionItem',
      expect.objectContaining({
        spaceId: 's1',
        itemId: 'col-image',
      })
    );
    await waitFor(() => {
      expect(
        within(collectionPanel).queryByTestId('collection-item-col-image')
      ).toBeNull();
    });
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
    const groupLast = await screen.findByTestId(
      'collaboration-contact-last-message-group:s1'
    );
    expect(groupLast).toHaveTextContent('最新进展');
    const groupMeta = await screen.findByTestId(
      'collaboration-chat-meta-group:s1'
    );
    expect(groupMeta).toHaveTextContent('2');
    expect(groupMeta).not.toHaveTextContent('最新进展');
    const groupNameLine = groupMeta.closest('.collaboration-contact-name-line');
    expect(groupNameLine).toBeTruthy();
    expect(groupNameLine).toHaveTextContent('设计');
    expect(groupNameLine).toHaveTextContent('2');
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

  it('immediately clears unread count badge in sidebar when clicking into a space or DM', async () => {
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
                last_message: { id: 2, seq: 5, preview: '私聊消息' },
                unread_count: 3,
                member: {
                  member_id: 'mem-a',
                  name: '小A',
                  conversation_id: 'conv-1',
                },
              },
            ],
          };
        }
        if (method === 'thread.markRead') {
          return {};
        }
        return defaultImpl?.(capability, method, input);
      }
    );

    renderPage();
    expect(
      await screen.findByTestId('collaboration-chat-meta-group:s1')
    ).toHaveTextContent('2');
    expect(
      await screen.findByTestId('collaboration-chat-meta-direct:direct:mem-a')
    ).toHaveTextContent('3');

    await user.click(screen.getByRole('button', { name: '小A' }));
    await waitFor(() => {
      expect(
        screen.queryByTestId('collaboration-chat-meta-direct:direct:mem-a')
      ).toBeNull();
    });

    await user.click(screen.getByRole('button', { name: '设计' }));
    await waitFor(() => {
      expect(
        screen.queryByTestId('collaboration-chat-meta-group:s1')
      ).toBeNull();
    });
  });

  it('hides 已回复 and 已跳过 receipts and still shows failed or cancelled outcomes', async () => {
    const defaultImpl = collaborationCall.getMockImplementation();
    collaborationCall.mockImplementation(
      async (
        capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'space.listMessages') {
          return {
            messages: [
              {
                seq: 1,
                envelope: {
                  sender: 'Person',
                  content: '全员看一下',
                },
                receipts: [
                  {
                    conversation_id: 'conv-1',
                    nickname: '小A',
                    state: 'replied',
                  },
                  {
                    conversation_id: 'conv-2',
                    nickname: '小B',
                    state: 'replied',
                  },
                  {
                    conversation_id: 'conv-3',
                    nickname: '小C',
                    state: 'failed',
                    delivered: 'failed',
                  },
                  {
                    conversation_id: 'conv-4',
                    nickname: '小D',
                    state: 'passed',
                  },
                  {
                    conversation_id: 'conv-5',
                    nickname: '小E',
                    state: 'cancelled',
                  },
                ],
              },
            ],
          };
        }
        return defaultImpl?.(capability, method, input);
      }
    );

    renderPage();
    expect(
      (await screen.findAllByText('全员看一下')).length
    ).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('已回复')).toBeNull();
    expect(screen.queryByText('小A 已回复')).toBeNull();
    expect(screen.queryByText('小B 已回复')).toBeNull();
    expect(screen.queryByText('小D 已跳过')).toBeNull();
    expect(screen.getByText('小C 失败')).toBeTruthy();
    expect(screen.getByText('小E 已取消')).toBeTruthy();
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
      const newSection = screen.getByTestId(
        'collaboration-contact-section-g-new'
      );
      expect(
        newSection.querySelector('.collaboration-contact-section-chevron')
      ).not.toBeNull();
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
          sender: '小A',
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
    expect(
      await screen.findByTestId('collaboration-member-last-message-conv-1')
    ).toHaveTextContent('私聊历史');
    const dmUnread = await screen.findByTestId(
      'collaboration-chat-meta-direct:direct:mem-a'
    );
    expect(dmUnread).toHaveTextContent('1');
    expect(
      dmUnread.closest('.collaboration-contact-name-line')
    ).toHaveTextContent('小A');
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
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(collaborationCall).not.toHaveBeenCalledWith(
      'collaboration',
      'space.warmup',
      expect.anything()
    );
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
          sender: 'Person',
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

    // Turn starts for 小B -> workspace-sessions-changed fires -> status dot becomes yellow (inprogress)
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

    // Turn finishes unviewed -> status dot becomes red (inreview) and stays red even with preview open
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

    // User clicks member to view preview (or interacts with space/preview) -> marks viewed and status dot becomes blue (done)
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
                envelope: { sender: '小A', content: '第一条' },
              },
              {
                seq: 2,
                envelope: { sender: '小A', content: '第二条' },
              },
              {
                seq: 3,
                envelope: { sender: '小A', content: '第三条' },
              },
              {
                seq: 4,
                envelope: { sender: 'Person', content: '我的回复' },
              },
              {
                seq: 5,
                envelope: { sender: '小B', content: '单独一条' },
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
      color: deriveMemberBotAvatar('小A').color,
    });
    expect(within(solo).getByText('小B')).toHaveStyle({
      color: deriveMemberBotAvatar('小B').color,
    });
  });

  it('shows working status for in-flight bots in the current group chat', async () => {
    renderPage();
    await screen.findByRole('button', { name: '设计' });
    const status = await screen.findByTestId('collaboration-working-status');
    expect(status).toHaveTextContent('小A 正在工作...');
    expect(
      within(status).getByTestId('collaboration-working-avatar')
    ).toHaveAttribute('data-working-name', '小A');
  });

  it('keeps message-area avatars static while working chrome animates independently', async () => {
    renderPage();
    await screen.findByRole('button', { name: '设计' });
    await screen.findByText('你好');

    const messageAvatar = await screen.findByTestId(
      'collaboration-message-bot-avatar-1'
    );
    expect(messageAvatar).toHaveAttribute('data-bot-session-active', 'false');
    expect(messageAvatar).not.toHaveClass(
      'collaboration-bot-avatar--session-active'
    );

    const sidebarAvatar = screen.getByTestId(
      'collaboration-member-bot-avatar-conv-1'
    );
    expect(sidebarAvatar).toHaveAttribute('data-bot-session-active', 'true');

    const workingAvatar = within(
      await screen.findByTestId('collaboration-working-status')
    )
      .getByTestId('collaboration-working-avatar')
      .querySelector('svg');
    expect(workingAvatar).toHaveAttribute('data-bot-session-active', 'true');

    expect(
      screen.getByRole('button', { name: '收起助手列表' })
    ).toBeInTheDocument();
    const topAvatar = screen.getByTestId(
      'collaboration-top-member-bot-avatar-小A'
    );
    expect(topAvatar).toHaveAttribute('data-bot-session-active', 'true');

    const nonces = [
      sidebarAvatar.getAttribute('data-bot-animation-nonce'),
      topAvatar.getAttribute('data-bot-animation-nonce'),
      workingAvatar?.getAttribute('data-bot-animation-nonce'),
    ];
    expect(nonces.every((nonce) => Boolean(nonce))).toBe(true);
    expect(new Set(nonces).size).toBe(3);
  });

  it('joins every in-flight bot in the working-status copy', async () => {
    const defaultImpl = collaborationCall.getMockImplementation();
    collaborationCall.mockImplementation(
      async (
        capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
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
                member_id: 'm3',
                nickname: '小C',
                kind: 'agent',
                visible_to_agents: 1,
                conversation_id: 'conv-3',
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
                turn_in_flight: true,
              },
              {
                conversation_id: 'conv-2',
                title: '前端会话',
                turn_in_flight: true,
              },
              {
                conversation_id: 'conv-3',
                title: '后端会话',
                turn_in_flight: true,
              },
            ],
          };
        }
        return defaultImpl?.(capability, method, input);
      }
    );
    renderPage();
    await screen.findByRole('button', { name: '设计' });
    expect(
      await screen.findByTestId('collaboration-working-status')
    ).toHaveTextContent('小A、小B和小C 正在工作...');
  });

  it('shows working status in a private chat', async () => {
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
        if (
          input?.spaceId === 'direct:mem-a' &&
          method === 'space.listMessages'
        ) {
          return { messages: [] };
        }
        return defaultImpl?.(capability, method, input);
      }
    );
    renderPage();
    await user.click(await screen.findByRole('button', { name: '小A' }));
    expect(
      await screen.findByTestId('collaboration-working-status')
    ).toHaveTextContent('小A 正在工作...');
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
                  sender: '小A',
                  content: '私聊一条',
                },
              },
            ],
          };
        }
        return defaultImpl?.(capability, method, input);
      }
    );
    useConversationTimeline.mockImplementation(() => ({
      timeline: [
        {
          turn: {
            id: 'turn-user-1',
            role: 'user',
            blocks: [{ type: 'text', text: '私聊一条' }],
          },
        },
      ],
      items: [],
      sideRows: [],
      sessionConfigOptions: [],
      currentTurnId: null,
      respondPermission: vi.fn(),
    }));
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
    expect(within(panel).queryByText('消息导航')).toBeNull();
    expect(within(panel).queryByTestId('session-message-nav')).toBeNull();
    expect(within(panel).queryByText('群收藏')).toBeNull();
    expect(within(panel).getByText('资产')).toBeTruthy();
    expect(within(panel).getByText('自定义')).toBeTruthy();
    expect(within(panel).queryByText('成员')).toBeNull();

    await user.click(
      within(panel).getByTestId('collaboration-group-details-tab-collection')
    );
    await user.click(
      within(panel).getByTestId('collaboration-assets-tab-collection')
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
      expect(within(panel).getByLabelText('人设（可选）')).toHaveValue(
        '你是小A'
      );
    });
  });

  it('displays cross-chat interaction notices with @member mention chips when interacting across chats', async () => {
    const user = userEvent.setup();
    const defaultImpl = collaborationCall.getMockImplementation();
    const directAMessages: Array<Record<string, unknown>> = [];
    const directBMessages: Array<Record<string, unknown>> = [];
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
                unread_count: 0,
                member: {
                  member_id: 'mem-a',
                  name: '小A',
                  conversation_id: 'conv-1',
                },
              },
              {
                kind: 'dm',
                thread_id: 'direct:mem-b',
                space_id: 'unassigned:workspace-1',
                name: '小B',
                unread_count: 0,
                member: {
                  member_id: 'mem-b',
                  name: '小B',
                  conversation_id: 'conv-2',
                },
              },
            ],
          };
        }
        if (method === 'thread.markRead') return {};
        if (input?.spaceId === 'direct:mem-a') {
          if (method === 'space.listMessages')
            return { messages: directAMessages };
          if (method === 'space.post') {
            directAMessages.push({
              seq: directAMessages.length + 1,
              operationId: input?.operationId,
              envelope: {
                sender: 'Person',
                content: input?.content,
                crossChatSentTo: ['小B'],
              },
            });
            directBMessages.push({
              seq: directBMessages.length + 1,
              operationId: input?.operationId,
              envelope: {
                sender: '小A',
                content: '',
                crossChatReceivedFrom: ['小A'],
              },
            });
            return { seq: directAMessages.length };
          }
        }
        if (input?.spaceId === 'direct:mem-b') {
          if (method === 'space.listMessages')
            return { messages: directBMessages };
          if (method === 'space.post') {
            directBMessages.push({
              seq: directBMessages.length + 1,
              operationId: input?.operationId,
              envelope: {
                sender: '小A',
                content: input?.content,
              },
            });
            return { seq: directBMessages.length };
          }
        }
        return defaultImpl?.(capability, method, input);
      }
    );
    renderPage();

    expect(await screen.findByRole('button', { name: '小A' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: '小B' })).toBeTruthy();

    // Open private chat with 小A
    await user.click(screen.getByRole('button', { name: '小A' }));

    // In private chat with 小A, mention @小B (cross-chat target)
    const editor = getComposerEditor();
    await user.click(editor);
    await user.type(editor, '@小B 请协助');
    await user.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => {
      expect(screen.getByText('已发送给')).toBeTruthy();
    });
    expect(screen.getByText('请协助')).toBeTruthy();
    const sentNotice = screen
      .getByText('已发送给')
      .closest('.collaboration-cross-chat-notice');
    expect(sentNotice).toBeTruthy();
    expect(
      within(sentNotice as HTMLElement).getByTestId(
        'collaboration-member-mention-chip-小B'
      )
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '小B' }));
    await waitFor(() => {
      expect(screen.getByText('已收到')).toBeTruthy();
      expect(screen.getByText('的消息')).toBeTruthy();
    });
    expect(screen.queryByText('请协助')).toBeNull();
    const recvNotice = screen
      .getByText('已收到')
      .closest('.collaboration-cross-chat-notice');
    expect(recvNotice).toBeTruthy();
    expect(
      within(recvNotice as HTMLElement).getByTestId(
        'collaboration-member-mention-chip-小A'
      )
    ).toBeTruthy();
  });

  it('opens the @助手 panel in a private chat with other assistants and without 全体成员', async () => {
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
                unread_count: 0,
                member: {
                  member_id: 'mem-a',
                  name: '小A',
                  conversation_id: 'conv-1',
                },
              },
              {
                kind: 'dm',
                thread_id: 'direct:mem-b',
                space_id: 'unassigned:workspace-1',
                name: '小B',
                unread_count: 0,
                member: {
                  member_id: 'mem-b',
                  name: '小B',
                  conversation_id: 'conv-2',
                },
              },
            ],
          };
        }
        if (method === 'thread.markRead') return {};
        if (
          method === 'space.listMessages' &&
          String(input?.spaceId ?? '').startsWith('direct:')
        ) {
          return { messages: [] };
        }
        return defaultImpl?.(capability, method, input);
      }
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: '小A' }));
    await user.click(screen.getByRole('button', { name: '@助手' }));

    const menu = await screen.findByTestId('composer-at-reference-menu');
    expect(menu).toBeVisible();
    expect(screen.getByRole('tab', { name: /助手/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('option', { name: /小B/ })).toBeVisible();
    expect(screen.getByRole('option', { name: /小A/ })).toBeVisible();
    expect(screen.queryByRole('option', { name: /全体成员/ })).toBeNull();
  });

  it('mirrors a pending bot permission request into the collaboration message log', async () => {
    useConversationTimeline.mockImplementation((id: string | null) => ({
      timeline: [],
      items: [],
      sideRows:
        id === 'conv-1'
          ? [
              {
                row: {
                  kind: 'permission_request',
                  request: {
                    permission_id: 'perm-collab-1',
                    title: 'Edit README.md',
                    status: 'pending',
                    details: {
                      fields: {
                        kind: 'edit',
                        content: [
                          {
                            type: 'diff',
                            path: 'README.md',
                            oldText: 'old',
                            newText: 'new',
                          },
                        ],
                      },
                    },
                    options: [
                      { id: 'allow', label: 'Allow', kind: 'allow_once' },
                      { id: 'deny', label: 'Deny', kind: 'reject_once' },
                    ],
                  },
                },
              },
            ]
          : [],
      sessionConfigOptions: [],
      currentTurnId: null,
      respondPermission: vi.fn(),
    }));
    renderPage();

    expect(await screen.findByText('你好')).toBeTruthy();
    expect(
      await screen.findByTestId('collaboration-thread-permission-dock-conv-1')
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: '权限申请' })).toBeTruthy();
    expect(screen.getByText('Edit README.md')).toBeTruthy();
  });

  it('opens a message bubble menu to react, reply, copy and copy request id', async () => {
    const user = userEvent.setup();
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
                id: 'msg-hello',
                seq: 1,
                envelope: { sender: '小A', content: '你好' },
              },
              {
                id: 'msg-doc',
                seq: 2,
                envelope: {
                  sender: '小B',
                  content: '请查看 [架构文档](src/arch.md)',
                },
              },
            ],
          };
        }
        return defaultImpl?.(capability, method, input);
      }
    );

    renderPage();
    const bubble = await screen.findByTestId('collaboration-message-1');
    fireEvent.contextMenu(bubble);
    expect(screen.getByRole('menuitem', { name: '回复' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '复制' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '复制请求 ID' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '👍' }));
    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'space.react',
        { spaceId: 's1', messageId: 'msg-hello', emoji: '👍' }
      );
    });
    expect(
      await screen.findByTestId('collaboration-bubble-reaction')
    ).toHaveTextContent('👍');

    fireEvent.contextMenu(screen.getByTestId('collaboration-message-1'));
    fireEvent.click(screen.getByRole('menuitem', { name: '回复' }));
    expect(screen.getByTestId('collaboration-reply-capsule')).toHaveTextContent(
      '你好'
    );
    const editor = getComposerEditor();
    await user.click(editor);
    await user.type(editor, '收到');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'space.post',
        expect.objectContaining({
          spaceId: 's1',
          content: '收到',
          inReplyTo: 'msg-hello',
        })
      );
    });
    expect(screen.queryByTestId('collaboration-reply-capsule')).toBeNull();

    fireEvent.contextMenu(screen.getByTestId('collaboration-message-1'));
    fireEvent.click(screen.getByRole('menuitem', { name: '复制请求 ID' }));
    expect(writeClipboard).toHaveBeenCalledWith('msg-hello');
  });

  it('right-clicks a chat avatar to mention, open private chat, or open the session', async () => {
    renderPage();
    const avatar = await screen.findByTestId(
      'collaboration-message-bot-avatar-1'
    );
    fireEvent.contextMenu(avatar);
    const mention = screen.getByRole('menuitem', { name: '小A' });
    expect(mention).toHaveTextContent('小A');
    expect(mention).not.toHaveTextContent('@小A');
    expect(
      mention.querySelector('svg.collaboration-member-mention-avatar')
    ).toBeTruthy();
    expect(within(mention).getByText('小A')).toHaveStyle({
      color: deriveMemberBotAvatar('小A').color,
      fontWeight: '600',
    });

    fireEvent.click(mention);
    await waitFor(() => {
      expect(getComposerEditor().textContent).toContain('小A');
    });

    fireEvent.contextMenu(avatar);
    fireEvent.click(screen.getByRole('menuitem', { name: '打开会话' }));
    expect(await screen.findByTestId('session-preview')).toBeTruthy();

    fireEvent.contextMenu(avatar);
    fireEvent.click(screen.getByRole('menuitem', { name: '进入私聊' }));
    await waitFor(() => {
      expect(screen.getByTestId('composer-current-space')).toHaveTextContent(
        '小A'
      );
    });
  });

  it('only draws piano-key ticks for user messages and scrolls to messages with UUID ids on click', async () => {
    const user = userEvent.setup();
    const defaultImpl = collaborationCall.getMockImplementation();
    collaborationCall.mockImplementation(
      async (
        capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'space.listMessages') {
          return {
            messages: [
              {
                id: 'msg-uuid-1',
                seq: 1,
                envelope: {
                  id: 'msg-uuid-1',
                  sender: 'Person',
                  content: '用户第一条',
                },
              },
              {
                id: 'msg-uuid-2',
                seq: 2,
                envelope: {
                  id: 'msg-uuid-2',
                  sender: '小A',
                  content: '助手回复',
                },
              },
              {
                id: 'msg-uuid-3',
                seq: 3,
                envelope: {
                  id: 'msg-uuid-3',
                  sender: 'Person',
                  content: '用户第二条',
                },
              },
            ],
          };
        }
        return defaultImpl?.(capability, method, input);
      }
    );

    renderPage();
    expect(await screen.findByText('用户第一条')).toBeTruthy();
    const ticks = screen.getAllByRole('button', {
      name: /跳转到第 \d+ 条消息/,
    });
    expect(ticks).toHaveLength(2);
    expect(
      screen.queryByRole('button', { name: '跳转到第 3 条消息' })
    ).toBeNull();

    const firstMsgEl = screen.getByTestId('collaboration-message-1');
    const scrollIntoViewSpy = vi.fn();
    firstMsgEl.scrollIntoView = scrollIntoViewSpy;

    await user.click(screen.getByRole('button', { name: '跳转到第 1 条消息' }));
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
    });
    expect(
      screen.getByRole('button', { name: '跳转到第 1 条消息' })
    ).toHaveAttribute('aria-current', 'true');
  });

  it('pins the message log to the bottom on enter and offers a back-to-bottom control', async () => {
    const user = userEvent.setup();
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollHeight'
    );
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientHeight'
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return this.classList?.contains('collaboration-thread-log') ? 2000 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return this.classList?.contains('collaboration-thread-log') ? 400 : 0;
      },
    });
    try {
      renderPage();
      await screen.findByText('你好');
      const log = document.querySelector(
        '.collaboration-thread-log'
      ) as HTMLDivElement;
      expect(log.scrollTop).toBeGreaterThanOrEqual(1600);
      expect(screen.queryByTestId('collaboration-back-to-bottom')).toBeNull();

      log.scrollTop = 0;
      fireEvent.scroll(log);
      const backToBottom = await screen.findByTestId(
        'collaboration-back-to-bottom'
      );
      expect(backToBottom).toHaveAttribute('aria-label', '回到消息底部');
      await user.click(backToBottom);
      expect(log.scrollTop).toBeGreaterThanOrEqual(1600);
      await waitFor(() => {
        expect(screen.queryByTestId('collaboration-back-to-bottom')).toBeNull();
      });
    } finally {
      if (originalScrollHeight) {
        Object.defineProperty(
          HTMLElement.prototype,
          'scrollHeight',
          originalScrollHeight
        );
      } else {
        delete (HTMLElement.prototype as { scrollHeight?: unknown })
          .scrollHeight;
      }
      if (originalClientHeight) {
        Object.defineProperty(
          HTMLElement.prototype,
          'clientHeight',
          originalClientHeight
        );
      } else {
        delete (HTMLElement.prototype as { clientHeight?: unknown })
          .clientHeight;
      }
    }
  });

  it('keeps the active BotSpace view steady when another GroupSpace receives a new message and triggers space refresh', async () => {
    const user = userEvent.setup();
    const baseImpl = collaborationCall.getMockImplementation()!;
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
                unread_count: 0,
              },
              {
                kind: 'dm',
                thread_id: 'direct:mem-a',
                space_id: 'unassigned:workspace-1',
                name: '小A',
                last_message: { id: 5, seq: 5, preview: '我是小A私聊消息' },
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
        if (method === 'thread.markRead') return {};
        if (
          method === 'space.listMessages' &&
          input?.spaceId === 'direct:mem-a'
        ) {
          return {
            messages: [
              {
                seq: 5,
                conversationId: 'conv-1',
                envelope: { sender: '小A', content: '我是小A私聊消息' },
              },
            ],
          };
        }
        if (method === 'space.listEvents') {
          const spaceId = String(input?.spaceId ?? '');
          if (spaceId === 's1') {
            return {
              generation: 1,
              nextSeq: 2,
              events: [
                { seq: 1, kind: 'space' },
                { seq: 2, kind: 'message' },
              ],
            };
          }
        }
        return baseImpl(capability, method, input);
      }
    );

    renderPage();
    await screen.findByText('你好');
    expect(screen.getByTestId('composer-current-space')).toHaveTextContent(
      '设计'
    );

    // Switch to BotSpace (小A)
    await user.click(await screen.findByRole('button', { name: '小A' }));
    await waitFor(() => {
      expect(
        Array.from(document.querySelectorAll('.collaboration-message')).some(
          (node) => node.textContent?.includes('我是小A私聊消息')
        )
      ).toBe(true);
    });
    expect(screen.getByTestId('composer-current-space')).toHaveTextContent(
      '小A'
    );

    // Emit a new message event in GroupSpace s1 while viewing BotSpace 小A
    await act(async () => {
      for (const listener of spaceEventListeners) {
        listener({
          workspaceId: 'workspace-1',
          spaceId: 's1',
          seq: 3,
          kind: 'message',
          generation: 1,
        });
      }
    });

    // The page must remain in BotSpace 小A and not jump to GroupSpace 设计
    expect(screen.getByTestId('composer-current-space')).toHaveTextContent(
      '小A'
    );
    expect(
      Array.from(document.querySelectorAll('.collaboration-message')).some(
        (node) => node.textContent?.includes('我是小A私聊消息')
      )
    ).toBe(true);
    expect(screen.queryByText('请查看')).toBeNull();
  });

  it('renders Supervisor bot in top slot, hides it from lower list, protects it from delete, and supports stepping down and drag-to-replace', async () => {
    const user = userEvent.setup();
    const baseImpl = collaborationCall.getMockImplementation()!;
    let currentSupervisorId: string | null = 'mem-master';
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
                thread_id: 'direct:mem-master',
                space_id: 'unassigned:workspace-1',
                name: '大总管',
                member: {
                  member_id: 'mem-master',
                  name: '大总管',
                  conversation_id: 'conv-master',
                  agent: 'claude-code',
                  is_supervisor: currentSupervisorId === 'mem-master',
                },
              },
              {
                kind: 'dm',
                thread_id: 'direct:mem-a',
                space_id: 'unassigned:workspace-1',
                name: '小A',
                member: {
                  member_id: 'mem-a',
                  name: '小A',
                  conversation_id: 'conv-1',
                  agent: 'claude-code',
                  is_supervisor: currentSupervisorId === 'mem-a',
                },
              },
              {
                kind: 'group',
                thread_id: 's1',
                space_id: 's1',
                name: '专业团队 1',
                member_count: 2,
                members_preview: [],
              },
            ],
          };
        }
        if (method === 'contactGroup.list') {
          return { groups: [] };
        }
        if (method === 'member.setSupervisor') {
          currentSupervisorId =
            (input?.memberId as string | null | undefined) ?? null;
          return { supervisor_member_id: currentSupervisorId };
        }
        return baseImpl(capability, method, input);
      }
    );

    renderPage();

    const supervisorSlot = await screen.findByTestId(
      'collaboration-supervisor-slot'
    );
    await waitFor(() => {
      expect(supervisorSlot).toHaveAttribute('data-supervisor-empty', 'false');
    });
    expect(
      within(supervisorSlot).getByRole('button', { name: '大总管' })
    ).toBeTruthy();
    expect(supervisorSlot.querySelector('[data-gaze="up-right"]')).toBeTruthy();

    // Supervisor bot is NOT duplicated in the regular contact list below
    expect(
      screen.queryByTestId('collaboration-contact-row-direct:direct:mem-master')
    ).toBeNull();
    // Normal bot 小A IS in the regular contact list below
    expect(
      await screen.findByTestId('collaboration-contact-row-direct:direct:mem-a')
    ).toBeTruthy();

    // Entering delete mode shows no checkbox on the Supervisor bot, but shows one on 小A
    await user.click(screen.getByRole('button', { name: '批量删除' }));
    expect(within(supervisorSlot).queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('checkbox', { name: '选择助手 小A' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '取消' }));

    // Right-clicking Supervisor slot shows 卸任主管 and no 删除
    fireEvent.contextMenu(supervisorSlot, { clientX: 80, clientY: 80 });
    const menu = await screen.findByRole('menu', { name: '联系人菜单' });
    expect(within(menu).queryByRole('menuitem', { name: '删除' })).toBeNull();
    const stepDownItem = within(menu).getByRole('menuitem', {
      name: '卸任主管',
    });
    await user.click(stepDownItem);

    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'member.setSupervisor',
        { workspaceId: 'workspace-1', memberId: null }
      );
    });
    // Supervisor slot is now empty, and 大总管 appears in the regular list below
    await waitFor(() => {
      expect(
        screen.getByTestId('collaboration-supervisor-slot')
      ).toHaveAttribute('data-supervisor-empty', 'true');
    });
    expect(
      await screen.findByTestId(
        'collaboration-contact-row-direct:direct:mem-master'
      )
    ).toBeTruthy();

    // Drag 小A into the empty Supervisor slot -> 小A becomes Supervisor
    const emptySlot = screen.getByTestId('collaboration-supervisor-slot');
    fireEvent.drop(emptySlot, {
      dataTransfer: {
        getData: (type: string) =>
          type === 'application/x-vibex-space-member'
            ? JSON.stringify({
                fromSpaceId: 'unassigned:workspace-1',
                conversationId: 'conv-1',
                nickname: '小A',
                memberId: 'mem-a',
              })
            : '',
      },
    });

    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'member.setSupervisor',
        { workspaceId: 'workspace-1', memberId: 'mem-a' }
      );
    });
    await waitFor(() => {
      expect(
        within(screen.getByTestId('collaboration-supervisor-slot')).getByRole(
          'button',
          { name: '小A' }
        )
      ).toBeTruthy();
    });
    expect(
      screen.queryByTestId('collaboration-contact-row-direct:direct:mem-a')
    ).toBeNull();

    // Drag 大总管 onto the occupied Supervisor slot -> replaces 小A, returning 小A to the list below
    fireEvent.drop(screen.getByTestId('collaboration-supervisor-slot'), {
      dataTransfer: {
        getData: (type: string) =>
          type === 'application/x-vibex-space-member'
            ? JSON.stringify({
                fromSpaceId: 'unassigned:workspace-1',
                conversationId: 'conv-master',
                nickname: '大总管',
                memberId: 'mem-master',
              })
            : '',
      },
    });

    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'member.setSupervisor',
        { workspaceId: 'workspace-1', memberId: 'mem-master' }
      );
    });
    await waitFor(() => {
      expect(
        within(screen.getByTestId('collaboration-supervisor-slot')).getByRole(
          'button',
          { name: '大总管' }
        )
      ).toBeTruthy();
    });
    expect(
      await screen.findByTestId('collaboration-contact-row-direct:direct:mem-a')
    ).toBeTruthy();
    expect(
      screen.queryByTestId('collaboration-contact-row-direct:direct:mem-master')
    ).toBeNull();
  });

  it('defaults group lead to Supervisor when included in user-created group, or to the first selected Bot otherwise', async () => {
    const user = userEvent.setup();
    const baseImpl = collaborationCall.getMockImplementation()!;
    const createdSpaces: Array<{
      space_id: string;
      name: string;
      lead_member_id?: string;
    }> = [];
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
                thread_id: 'direct:mem-master',
                name: '大总管',
                member_count: 1,
                members_preview: [
                  {
                    member_id: 'mem-master',
                    name: '大总管',
                    conversation_id: 'conv-master',
                    agent: 'CLAUDE_CODE',
                    is_supervisor: true,
                  },
                ],
                member: {
                  member_id: 'mem-master',
                  name: '大总管',
                  conversation_id: 'conv-master',
                  agent: 'CLAUDE_CODE',
                  is_supervisor: true,
                },
                last_activity_at: '2026-04-12T10:02:00Z',
                unread_count: 0,
              },
              {
                kind: 'dm',
                thread_id: 'direct:mem-a',
                name: '小A',
                member_count: 1,
                members_preview: [
                  {
                    member_id: 'mem-a',
                    name: '小A',
                    conversation_id: 'conv-1',
                    agent: 'CLAUDE_CODE',
                    is_supervisor: false,
                  },
                ],
                member: {
                  member_id: 'mem-a',
                  name: '小A',
                  conversation_id: 'conv-1',
                  agent: 'CLAUDE_CODE',
                  is_supervisor: false,
                },
                last_activity_at: '2026-04-12T10:01:00Z',
                unread_count: 0,
              },
              {
                kind: 'dm',
                thread_id: 'direct:mem-b',
                name: '小B',
                member_count: 1,
                members_preview: [
                  {
                    member_id: 'mem-b',
                    name: '小B',
                    conversation_id: 'conv-2',
                    agent: 'CODEX',
                    is_supervisor: false,
                  },
                ],
                member: {
                  member_id: 'mem-b',
                  name: '小B',
                  conversation_id: 'conv-2',
                  agent: 'CODEX',
                  is_supervisor: false,
                },
                last_activity_at: '2026-04-12T10:00:00Z',
                unread_count: 0,
              },
            ],
          };
        }
        if (method === 'space.listMembers') {
          if (String(input?.spaceId ?? '').startsWith('unassigned:')) {
            return {
              members: [
                {
                  member_id: 'seat-master-dm',
                  identity_member_id: 'mem-master',
                  nickname: '大总管',
                  kind: 'agent',
                  visible_to_agents: 1,
                  conversation_id: 'conv-master',
                  is_supervisor: true,
                },
                {
                  member_id: 'seat-a-dm',
                  identity_member_id: 'mem-a',
                  nickname: '小A',
                  kind: 'agent',
                  visible_to_agents: 1,
                  conversation_id: 'conv-1',
                  is_supervisor: false,
                },
                {
                  member_id: 'seat-b-dm',
                  identity_member_id: 'mem-b',
                  nickname: '小B',
                  kind: 'agent',
                  visible_to_agents: 1,
                  conversation_id: 'conv-2',
                  is_supervisor: false,
                },
              ],
            };
          }
          return { members: [] };
        }
        if (method === 'space.create') {
          const next = {
            space_id: `space-${createdSpaces.length + 1}`,
            name: String(input?.name ?? '新群'),
          };
          createdSpaces.push(next);
          return next;
        }
        if (method === 'space.addMember') {
          const cid = String(input?.conversationId ?? '');
          const seatId =
            cid === 'conv-master'
              ? 'group-seat-master'
              : cid === 'conv-1'
                ? 'group-seat-a'
                : 'group-seat-b';
          return {
            member_id: seatId,
            conversation_id: cid,
            nickname: String(input?.nickname ?? ''),
            is_supervisor: cid === 'conv-master',
          };
        }
        if (method === 'space.update') {
          const sid = String(input?.spaceId ?? '');
          const lead = String(input?.leadMemberId ?? '');
          const found = createdSpaces.find((s) => s.space_id === sid);
          if (found) found.lead_member_id = lead;
          return { space_id: sid, lead_member_id: lead };
        }
        if (method === 'space.list') {
          return { spaces: [...createdSpaces] };
        }
        return baseImpl(capability, method, input);
      }
    );

    renderPage();
    await screen.findByTestId('collaboration-supervisor-slot');

    // 1. Create group with [小A, 大总管] (小A selected first, Supervisor selected second) -> Supervisor (group-seat-master) becomes lead
    await user.click(screen.getByRole('button', { name: '创建' }));
    await user.click(await screen.findByRole('menuitem', { name: '创建群聊' }));
    const dialog1 = await screen.findByRole('dialog', { name: '创建群聊' });
    const botList1 = within(dialog1).getByTestId(
      'collaboration-create-bot-list'
    );
    await user.click(within(botList1).getByRole('button', { name: '小A' }));
    await user.click(within(botList1).getByRole('button', { name: '大总管' }));
    await user.click(
      dialog1.querySelector('button[type="submit"]') as HTMLButtonElement
    );

    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'space.update',
        {
          spaceId: 'space-1',
          leadMemberId: 'group-seat-master',
        }
      );
    });

    // 2. Create group with [小B, 小A] (without Supervisor, 小B selected first) -> first selected Bot (group-seat-b) becomes lead
    await user.click(screen.getByRole('button', { name: '创建' }));
    await user.click(await screen.findByRole('menuitem', { name: '创建群聊' }));
    const dialog2 = await screen.findByRole('dialog', { name: '创建群聊' });
    const botList2 = within(dialog2).getByTestId(
      'collaboration-create-bot-list'
    );
    await user.click(within(botList2).getByRole('button', { name: '小B' }));
    await user.click(within(botList2).getByRole('button', { name: '小A' }));
    await user.click(
      dialog2.querySelector('button[type="submit"]') as HTMLButtonElement
    );

    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'space.update',
        {
          spaceId: 'space-2',
          leadMemberId: 'group-seat-b',
        }
      );
    });
  });

  it('parses @Bot A mentions with spaces in nickname or CJK text immediately following @mention', () => {
    const roster = [
      {
        member_id: 'seat-a',
        nickname: 'Bot A',
        kind: 'agent',
        visible_to_agents: 1,
      },
      {
        member_id: 'seat-b',
        nickname: 'BotB',
        kind: 'agent',
        visible_to_agents: 1,
      },
    ];

    expect(mentionNicknames('@Bot A 请检查配置', roster)).toEqual(['Bot A']);
    expect(strayMentions('@Bot A 请检查配置', roster)).toEqual([]);

    expect(mentionNicknames('@Bot A帮我看看 @BotB顺便确认', roster)).toEqual([
      'Bot A',
      'BotB',
    ]);
    expect(strayMentions('@Bot A帮我看看 @BotB顺便确认', roster)).toEqual([]);

    expect(mentionNicknames('@UnknownBot 请看', roster)).toEqual([]);
    expect(strayMentions('@UnknownBot 请看', roster)).toEqual(['UnknownBot']);
  });

  it('docks request_approval cards at the bottom permission dock instead of rendering a chat bubble', async () => {
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
                id: 'msg-hello',
                seq: 1,
                envelope: { sender: '小A', content: '准备执行删除' },
              },
              {
                id: 'msg-approval',
                seq: 2,
                envelope: {
                  sender: '小A',
                  content:
                    '<card kind="approval" id="card-appr-1">\n<action>\n删除旧 Bot\n</action>\n<command>\nmanage_bot delete\n</command>\n<reason>\n清理废弃成员\n</reason>\n</card>',
                },
              },
            ],
          };
        }
        if (method === 'card.resolve') {
          return { card: { id: 'card-appr-1', status: 'resolved' } };
        }
        return defaultImpl?.(capability, method, input);
      }
    );

    renderPage();
    expect(await screen.findByText('准备执行删除')).toBeTruthy();
    expect(screen.queryByTestId('collaboration-message-2')).toBeNull();
    const dock = await screen.findByTestId(
      'collaboration-thread-approval-dock'
    );
    expect(dock).toBeTruthy();
    expect(
      within(dock).getByRole('heading', { name: '权限申请' })
    ).toBeTruthy();
    expect(within(dock).getByText('删除旧 Bot')).toBeTruthy();

    fireEvent.click(within(dock).getByRole('button', { name: '允许' }));
    await waitFor(() =>
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'card.resolve',
        {
          cardId: 'card-appr-1',
          decision: 'allow_once',
        }
      )
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId('collaboration-thread-approval-dock')
      ).toBeNull()
    );
  });

  it('shows 正在加载Bot会话... Notice in BotSpace Composer when an inactive Bot session is re-spinning up, keeps input editable, and disables only the send button until ready', async () => {
    const user = userEvent.setup();
    let timelineConnecting = true;
    useConversationTimeline.mockImplementation((id: string | null) => ({
      timeline: [],
      items: [],
      sideRows: [],
      sessionConfigOptions: [],
      currentTurnId: null,
      respondPermission: vi.fn(),
      connecting: id === 'conv-1' ? timelineConnecting : false,
      loading: false,
      sessionBindReady: id === 'conv-1' ? !timelineConnecting : true,
    }));

    renderPage();

    const supervisorSlot = await screen.findByTestId(
      'collaboration-supervisor-slot'
    );
    expect(supervisorSlot.closest('.collaboration-space-list')).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: '小A' }));

    // When a Bot session is merely inactive (not yet actively connecting), the Composer remains editable.
    expect(screen.queryByText('正在加载Bot会话...')).toBeNull();
    expect(getComposerEditor().getAttribute('contenteditable')).toBe('true');

    await act(async () => {
      for (const listener of agentEventListeners) {
        listener({
          session_id: 'conv-1',
          event: {
            kind: 'connection_status_changed',
            snapshot: { status: 'connecting' },
          },
        });
      }
    });

    const statusDock = await screen.findByTestId('conversation-status-dock');
    expect(within(statusDock).getByText('正在加载Bot会话...')).toBeTruthy();

    // Input remains editable even while loading, only the Send button is disabled
    const editor = getComposerEditor();
    expect(editor.getAttribute('contenteditable')).toBe('true');
    await user.click(editor);
    await user.type(editor, '测试在加载期间输入文字');
    const sendButton = screen.getByRole('button', { name: '发送' });
    expect(sendButton).toBeDisabled();

    // Pressing Enter while Bot session is loading must NOT clear the message draft
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' });
    expect(editor.textContent).toContain('测试在加载期间输入文字');
    expect(sendButton).toBeDisabled();

    timelineConnecting = false;
    await act(async () => {
      for (const listener of agentEventListeners) {
        listener({
          session_id: 'conv-1',
          event: {
            kind: 'session_bind_ready',
          },
        });
      }
    });

    await waitFor(() =>
      expect(screen.queryByText('正在加载Bot会话...')).toBeNull()
    );
    expect(getComposerEditor().getAttribute('contenteditable')).toBe('true');
    expect(getComposerEditor().textContent).toContain('测试在加载期间输入文字');
    expect(screen.getByRole('button', { name: '发送' })).not.toBeDisabled();
  });

  it('shows 正在加载Bot会话... Notice in BotSpace Composer when a newly created Bot is bootstrapping, keeps input editable, and enables send once ready', async () => {
    const user = userEvent.setup();
    let resolveBootstrapPost: ((value: unknown) => void) | null = null;
    const defaultImpl = collaborationCall.getMockImplementation();
    collaborationCall.mockImplementation(
      async (
        capability: string,
        method: string,
        input?: Record<string, unknown>
      ) => {
        if (method === 'space.list') {
          return { spaces: [] };
        }
        if (method === 'space.unassignedSpace') {
          return {
            space: { space_id: 'unassigned:workspace-1', name: '待分配' },
          };
        }
        if (method === 'space.listSidebar') {
          return { items: [], supervisor_member_id: null };
        }
        if (method === 'space.listMembers') {
          return { members: [] };
        }
        if (method === 'space.createMember') {
          return {
            member_id: 'member-new-1',
            identity_member_id: 'member-new-1',
            conversation_id: 'conv-new-1',
            private_conversation_id: 'conv-new-1',
            nickname: 'Master',
          };
        }
        if (
          method === 'space.post' &&
          input?.spaceId === 'direct:member-new-1'
        ) {
          return await new Promise((resolve) => {
            resolveBootstrapPost = resolve;
          });
        }
        return defaultImpl?.(capability, method, input);
      }
    );

    renderPage();

    const statusDock = await screen.findByTestId('conversation-status-dock');
    expect(within(statusDock).getByText('正在加载Bot会话...')).toBeTruthy();
    const editor = getComposerEditor();
    expect(editor.getAttribute('contenteditable')).toBe('true');
    await user.click(editor);
    await user.type(editor, '新Bot初始化期间输入草稿');
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();

    expect(resolveBootstrapPost).not.toBeNull();
    await act(async () => {
      resolveBootstrapPost?.({ seq: 1, receipts: [] });
    });

    await waitFor(() =>
      expect(screen.queryByText('正在加载Bot会话...')).toBeNull()
    );
    expect(getComposerEditor().getAttribute('contenteditable')).toBe('true');
    expect(screen.getByRole('button', { name: '发送' })).not.toBeDisabled();
  });
});
