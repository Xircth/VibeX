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

import { CollaborationSpacePage } from './CollaborationSpacePage';

const collaborationCall = vi.hoisted(() => vi.fn());
const sessionPreviewSpy = vi.hoisted(() => vi.fn());
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

vi.mock('@/components/kanban/KanbanSessionConversationView', () => ({
  KanbanSessionConversationView: (props: Record<string, unknown>) => {
    sessionPreviewSpy(props);
    return (
      <div
        data-testid="session-preview"
        data-embedded={String(Boolean(props.embedded))}
      >
        {String(props.sessionId ?? '')}
      </div>
    );
  },
}));

vi.mock('@/components/panels/DockviewPreviewPanel', () => ({
  default: () => <div data-testid="file-preview" />,
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

  it('opens creation/edit overlays inside the message area and previews a member session on member click or message avatar click', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(screen.queryByRole('textbox', { name: '群聊名称' })).toBeNull();
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
    expect(await screen.findByText('空间成员')).toBeTruthy();
    fireEvent.mouseLeave(statsBadge);

    // Top horizontal member bar is shown, can filter messages by member, and can be collapsed/expanded
    expect(screen.getByTestId('collaboration-top-member-bar')).toBeTruthy();
    expect(screen.getByText('请查看')).toBeTruthy();
    const filterMemberABtn = screen.getByRole('button', {
      name: '筛选成员 小A',
    });
    await user.click(filterMemberABtn);
    expect(filterMemberABtn).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByText('你好').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('请查看')).toBeNull();
    await user.click(filterMemberABtn);
    expect(filterMemberABtn).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('请查看')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '收起成员列表' }));
    expect(screen.queryByTestId('collaboration-top-member-bar')).toBeNull();
    const collapsedStack = screen.getByTestId('collaboration-top-member-stack');
    expect(collapsedStack).toBeTruthy();
    expect(
      collapsedStack.querySelectorAll('.collaboration-top-member-stack-item')
    ).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: '展开成员列表' }));
    expect(screen.getByTestId('collaboration-top-member-bar')).toBeTruthy();

    // Piano-key message navigation is rendered in the message area
    expect(
      document.querySelector('.collaboration-thread .conv-message-nav-rail')
    ).toBeTruthy();

    // Setting a space tag color colors the rounded-rectangle space N-grid icon background while keeping cells gray
    await user.click(screen.getByRole('button', { name: '标签 设计' }));
    await user.click(await screen.findByRole('button', { name: '蓝色' }));
    const spaceButton = screen.getByRole('button', { name: '设计' });
    const spaceIcon = spaceButton.querySelector(
      '[data-tag-color="blue"]'
    ) as HTMLElement | null;
    expect(spaceIcon).toBeTruthy();
    expect(spaceIcon).toHaveAttribute('data-grid-size', '4');
    expect(
      spaceIcon?.querySelectorAll('.collaboration-space-icon-cell')
    ).toHaveLength(4);
    expect(spaceButton.querySelector('.collaboration-space-tag')).toBeNull();

    // Right preview area is hidden until a member or file is selected
    expect(screen.queryByLabelText('预览')).toBeNull();

    // Clicking a file link in the message area opens a file preview tab in the right Dockview
    await user.click(screen.getByRole('link', { name: '架构文档' }));
    expect(await screen.findByTestId('file-preview')).toBeTruthy();

    // When spaces exist, the 2 empty-state buttons in the left list body are not shown
    expect(screen.queryByRole('button', { name: '新建协作空间' })).toBeNull();

    // User ('你') is invisible and never shown in the collaboration space member list
    expect(screen.queryByRole('button', { name: '你' })).toBeNull();

    // Member row displays member name ('小A'), last message sent in current space ('你好'), enlarged left Bot avatar, and right Agent icon
    const memberAButton = screen.getByRole('button', { name: '小A' });
    expect(
      screen.getByTestId('collaboration-member-bot-avatar-conv-1')
    ).toBeTruthy();
    expect(
      screen.getByTestId('collaboration-member-row-agent-icon-conv-1')
    ).toBeTruthy();
    expect(
      screen.getByTestId('collaboration-message-bot-avatar-1')
    ).toBeTruthy();
    expect(
      memberAButton
        .closest('.workspace-session-row')
        ?.querySelector('.workspace-session-row-marker')
    ).toBeNull();
    expect(
      memberAButton.querySelector('.collaboration-member-name')?.textContent
    ).toBe('小A');
    expect(
      screen.getByTestId('collaboration-member-last-message-conv-1')
    ).toHaveTextContent('你好');
    expect(
      screen.getByTestId('collaboration-member-last-message-conv-2')
    ).toHaveTextContent('请查看 [架构文档](src/arch.md)');
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

    await user.click(memberAButton);
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

    // Clicking another member ('小B') opens a second tab in the right Dockview preview bar
    await user.click(screen.getByRole('button', { name: '小B' }));
    const previewPane = screen.getByLabelText('预览');
    expect(within(previewPane).getByText('小A')).toBeTruthy();
    expect(within(previewPane).getByText('小B')).toBeTruthy();

    // Clicking the member's avatar in the message area also activates that member's session preview tab
    await user.click(screen.getByRole('button', { name: '预览 小A 会话' }));
    expect(
      await within(previewPane).findAllByTestId('session-preview')
    ).toBeTruthy();

    // Clicking + in top toolbar expands menu with 新建协作空间 and 新建成员
    await user.click(screen.getByRole('button', { name: '新建群聊' }));
    const createSpaceMenuItem = await screen.findByRole('menuitem', {
      name: '新建协作空间',
    });
    expect(screen.getByRole('menuitem', { name: '新建成员' })).toBeTruthy();
    await user.click(createSpaceMenuItem);

    // Form is rendered as a white Gaussian blurred overlay inside the middle message area (.collaboration-thread)
    const threadSection = screen.getByRole('region', { name: '设计' });
    const dialogInThread = within(threadSection).getByRole('dialog', {
      name: '新建群聊',
    });
    expect(dialogInThread).toBeTruthy();
    const overlayEl = threadSection.querySelector(
      '.collaboration-thread-overlay'
    );
    expect(overlayEl).toBeTruthy();
    expect(overlayEl?.className).not.toContain('dialog-backdrop');
    expect(screen.getByRole('textbox', { name: '群聊名称' })).toBeTruthy();

    const closeDialogBtn = screen.getByRole('button', { name: 'Close' });
    expect(closeDialogBtn.querySelector('svg')).toBeTruthy();
    await user.click(closeDialogBtn);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '新建群聊' })).toBeNull();
    });

    // Clicking per-space UserPlus button opens the unified 新建成员 overlay pre-set to 基于会话
    await user.click(screen.getByRole('button', { name: '加入成员 设计' }));
    const memberDialog = await within(threadSection).findByRole('dialog', {
      name: '新建成员',
    });
    expect(memberDialog).toBeTruthy();
    const sourceSegmented = within(memberDialog).getByRole('radiogroup', {
      name: '创建方式',
    });
    expect(
      within(sourceSegmented).getByRole('radio', { name: '基于会话' })
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      within(memberDialog).getByRole('combobox', { name: '选择会话' })
    ).toBeTruthy();
    expect(
      within(memberDialog).getByRole('textbox', { name: '成员名称' })
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
  });

  it('completes @nickname via SessionComposerInput panel, sends targeted vs broadcast posts, and renders receipts', async () => {
    const user = userEvent.setup();
    renderPage();

    expect((await screen.findAllByText('你好')).length).toBeGreaterThanOrEqual(
      1
    );
    expect(await screen.findByRole('button', { name: '小A' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '选择文件' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '@成员' })).toBeTruthy();

    const editor = getComposerEditor();
    await user.click(screen.getByRole('button', { name: '@成员' }));

    const menu = await screen.findByTestId('composer-at-reference-menu');
    expect(menu).toBeVisible();
    expect(screen.getByRole('tab', { name: /成员/ })).toHaveAttribute(
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
    expect(
      screen.getByTestId('collaboration-member-last-message-conv-1')
    ).toHaveTextContent('增量消息');
    expect(collaborationCall).toHaveBeenCalledWith(
      'collaboration',
      'space.listMessages',
      { spaceId: 's1', sinceSeq: 2 }
    );

    // Drag 小A into 未定空间
    const memberButton = screen.getByRole('button', { name: '小A' });
    const memberRow = memberButton.closest(
      '.workspace-session-row'
    ) as HTMLElement;
    const unassignedGroup = screen.getByTestId(
      'collaboration-space-group-unassigned:workspace-1'
    );
    fireEvent.dragStart(memberRow);
    fireEvent.dragOver(unassignedGroup);
    fireEvent.drop(unassignedGroup);

    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'space.moveMember',
        expect.objectContaining({
          fromSpaceId: 's1',
          toSpaceId: 'unassigned:workspace-1',
          conversationId: 'conv-1',
        })
      );
    });

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
          spaceId: 's1',
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
  });

  it('supports search, filtering by agent/activity/member, and batch deleting spaces and members', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole('button', { name: '设计' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: '小A' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: '小B' })).toBeTruthy();

    // Filter by Agent using project standard DropdownMenu combobox
    await user.click(screen.getByRole('button', { name: '筛选' }));
    const agentSelect = await screen.findByRole('combobox', {
      name: '按 Agent',
    });
    await user.click(agentSelect);
    await user.click(await screen.findByRole('menuitem', { name: 'Codex' }));
    expect(screen.getByRole('button', { name: '设计' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '重置筛选' }));

    // Collapsing space '设计' renders a horizontal stacked member avatar list after the space name
    expect(
      screen.queryByTestId('collaboration-space-collapsed-stack-s1')
    ).toBeNull();
    await user.click(screen.getByRole('button', { name: '设计' }));
    const collapsedStack = await screen.findByTestId(
      'collaboration-space-collapsed-stack-s1'
    );
    expect(collapsedStack).toBeTruthy();
    expect(
      collapsedStack.querySelectorAll(
        '.collaboration-space-collapsed-stack-item'
      )
    ).toHaveLength(2);
    // Re-expand space '设计'
    await user.click(screen.getByRole('button', { name: '设计' }));
    expect(
      screen.queryByTestId('collaboration-space-collapsed-stack-s1')
    ).toBeNull();

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

    const memberACheckbox = screen.getByRole('checkbox', {
      name: '选择成员 小A',
    });
    const memberBCheckbox = screen.getByRole('checkbox', {
      name: '选择成员 小B',
    });
    expect(memberACheckbox.className).toContain(
      'collaboration-delete-checkbox'
    );
    expect(memberACheckbox.closest('.collaboration-member-row')).toBeNull();
    expect(
      memberACheckbox.closest('.collaboration-member-row-outer')
    ).toBeTruthy();
    expect(memberACheckbox).toHaveAttribute('aria-checked', 'true');
    expect(memberBCheckbox).toHaveAttribute('aria-checked', 'true');

    // Deselect 小A while keeping space '设计' selected
    await user.click(memberACheckbox);
    expect(memberACheckbox).toHaveAttribute('aria-checked', 'false');
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
          memberTargets: [{ spaceId: 's1', conversationId: 'conv-2' }],
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
          return {
            space_id: 'unassigned:workspace-1',
            member_id: 'm-created',
            conversation_id: 'conv-created',
            nickname: String(input?.nickname ?? '新成员'),
          };
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
          return { members: [] };
        }
        if (method === 'space.listMessages') {
          return { messages: [] };
        }
        return {};
      }
    );

    const { unmount } = renderPage();
    // Default space is shown in the left space list along with its 3 hover buttons (标签, 修改名称, 加入成员)
    expect(
      await screen.findByRole('button', { name: '默认空间' })
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: '标签 默认空间' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: '修改名称 默认空间' })
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: '加入成员 默认空间' })
    ).toBeTruthy();
    // Top row has 12px '协作空间' title on the left of the search button
    const topTitle = screen.getByText('协作');
    expect(topTitle.className).toContain('text-[12px]');
    // Never show '还没有消息'; composer is NOT rendered when no space is opened;
    // instead, the white-blurred 新建空间 overlay is shown by default over the message area
    expect(screen.queryByText('还没有消息')).toBeNull();
    expect(screen.queryByTestId('session-composer-editor')).toBeNull();
    const initialSpaceDialog = await screen.findByRole('dialog', {
      name: '新建群聊',
    });
    expect(initialSpaceDialog).toBeTruthy();
    // Right preview area is NOT shown by default
    expect(screen.queryByLabelText('预览')).toBeNull();

    // Closing 新建空间 dialog when no spaces exist opens Default Space message area with empty-state capsule and 2 action buttons
    await user.click(
      within(initialSpaceDialog).getByRole('button', { name: 'Close' })
    );
    expect(
      await screen.findByTestId('collaboration-empty-member-pill')
    ).toHaveTextContent('当前协作空间暂无成员，请先添加成员');
    const emptyStateAddMemberBtn = screen.getByRole('button', {
      name: '添加成员',
    });
    const emptyStateCreateSpaceBtn = screen.getByRole('button', {
      name: '新建协作空间',
    });

    // Test unified 新建成员 overlay inside message area (基于角色 / 基于会话 / 自定义, without 归属团队)
    await user.click(emptyStateAddMemberBtn);
    const memberDialog = await screen.findByRole('dialog', {
      name: '新建成员',
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
      within(memberDialog).getByRole('textbox', { name: '成员名称' }),
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

    // Test 新建协作空间 overlay: clicking dashed + switches directly to 添加成员 dialog with 选择成员 / 新建成员 tabs
    await user.click(emptyStateCreateSpaceBtn);
    const spaceDialog = await screen.findByRole('dialog', {
      name: '新建群聊',
    });
    const nameInput = within(spaceDialog).getByRole('textbox', {
      name: '群聊名称',
    });
    await user.type(nameInput, '架构评审');

    // Click dashed + button to open 添加成员 form directly
    const dashedAddBtn = within(spaceDialog).getByRole('button', {
      name: '添加或新建协作空间成员',
    });
    await user.click(dashedAddBtn);
    const addMemberDialog = await screen.findByRole('dialog', {
      name: '添加成员',
    });
    expect(
      within(addMemberDialog).getByRole('button', { name: '选择成员' })
    ).toBeTruthy();
    expect(
      within(addMemberDialog).getByRole('button', { name: '新建成员' })
    ).toBeTruthy();

    // 选择成员 tab is active by default -> shows 可选成员 with 2-level space -> member list
    expect(within(addMemberDialog).getByText('可选成员')).toBeTruthy();
    expect(
      within(addMemberDialog).getByTestId(
        'collaboration-picker-space-unassigned:workspace-1'
      )
    ).toBeTruthy();
    const convCheckbox = await within(addMemberDialog).findByRole('checkbox');
    await user.click(convCheckbox);
    await user.click(
      within(addMemberDialog).getByRole('button', { name: '完成' })
    );

    // Click dashed + button again to create a member via 添加成员 -> 新建成员 tab (no 归属团队 field)
    const spaceDialogAfterChoose = await screen.findByRole('dialog', {
      name: '新建群聊',
    });
    await user.click(
      within(spaceDialogAfterChoose).getByRole('button', {
        name: '添加或新建协作空间成员',
      })
    );
    const addMemberDialog2 = await screen.findByRole('dialog', {
      name: '添加成员',
    });
    await user.click(
      within(addMemberDialog2).getByRole('button', { name: '新建成员' })
    );
    expect(
      within(addMemberDialog2).queryByRole('combobox', { name: /归属团队/ })
    ).toBeNull();
    await user.type(
      within(addMemberDialog2).getByRole('textbox', { name: '成员名称' }),
      '内联评审员'
    );
    await user.click(
      within(addMemberDialog2).getByRole('button', { name: '添加成员' })
    );

    // Created member chip is displayed under 协作空间成员 with dashed + still after it
    const finalSpaceDialog = await screen.findByRole('dialog', {
      name: '新建群聊',
    });
    expect(
      await within(finalSpaceDialog).findByText('内联评审员')
    ).toBeTruthy();
    expect(
      within(finalSpaceDialog).getByRole('button', {
        name: '添加或新建协作空间成员',
      })
    ).toBeTruthy();

    await user.click(
      finalSpaceDialog.querySelector(
        'button[type="submit"]'
      ) as HTMLButtonElement
    );

    expect(
      await screen.findByRole('button', { name: '架构评审' })
    ).toBeTruthy();
    expect(collaborationCall).toHaveBeenCalledWith(
      'collaboration',
      'space.addMember',
      expect.objectContaining({
        spaceId: 's-new',
        conversationId: 'conv-non-member',
        nickname: expect.stringMatching(/^[A-Z][a-z]+/),
      })
    );
    expect(collaborationCall).toHaveBeenCalledWith(
      'collaboration',
      'space.addMember',
      expect.objectContaining({
        spaceId: 's-new',
        conversationId: 'conv-created',
        nickname: '内联评审员',
      })
    );
    // Once a space is created and opened, composer is rendered and the 2 empty-state buttons disappear
    expect(await screen.findByTestId('session-composer-editor')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '新建协作空间' })).toBeNull();
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

    // 2. Leftmost 4-squares Space Collection button is rendered in expanded top member bar
    const openCollectionBtn = await screen.findByTestId(
      'collaboration-open-collection-btn'
    );
    expect(openCollectionBtn).toBeTruthy();

    // Collapse top member bar and verify the collection button remains separate from avatar stack on the far left
    await user.click(screen.getByRole('button', { name: '收起成员列表' }));
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

    // 3. Click the 4-squares button to open the Space Collection tab in Dockview
    await user.click(collapsedCollectionBtn);

    const collectionPanel = await screen.findByTestId(
      'collaboration-space-collection-panel'
    );
    expect(collectionPanel).toBeTruthy();

    // Collaboration space name is rendered as a badge component in the panel header
    const spaceChip = within(collectionPanel).getByTestId(
      'collaboration-collection-space-chip'
    );
    expect(spaceChip).toHaveTextContent('设计');

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
});
