import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithQueryClient as render } from '@/test/QueryClientHarness';

import { CollaborationSpacePage } from './CollaborationSpacePage';

const collaborationCall = vi.hoisted(() => vi.fn());
const sessionPreviewSpy = vi.hoisted(() => vi.fn());
const spaceEventListeners = vi.hoisted(
  () => new Set<(payload: unknown) => void>()
);

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
          if (input?.sinceSeq === 1) {
            return {
              messages: [
                {
                  seq: 2,
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
            ],
          };
        }
        if (method === 'space.listConversations') {
          return {
            conversations: [
              {
                conversation_id: 'conv-1',
                title: '设计会话',
                agent_id: 'CLAUDE_CODE',
                turn_in_flight: true,
              },
              {
                conversation_id: 'conv-2',
                title: '前端会话',
                agent_id: 'CODEX',
                turn_in_flight: false,
              },
              {
                conversation_id: 'conv-3',
                title: '后端会话',
                agent_id: 'CLAUDE_CODE',
                turn_in_flight: false,
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
            seq: 2,
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

    expect(screen.queryByRole('textbox', { name: '空间名称' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: '昵称' })).toBeNull();
    expect(await screen.findByRole('button', { name: '设计' })).toBeTruthy();
    expect(screen.getByTestId('session-composer-editor')).toBeTruthy();
    expect(await screen.findByText('你好')).toBeTruthy();
    expect(screen.getAllByText('1个成员在活跃').length).toBeGreaterThan(0);

    // Right preview area is hidden until a member or file is selected
    expect(screen.queryByLabelText('预览')).toBeNull();

    // When spaces exist, the 2 empty-state buttons in the left list body are not shown
    expect(
      screen.queryByRole('button', { name: '新建协作空间' })
    ).toBeNull();

    await user.click(screen.getByRole('button', { name: '小A' }));
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

    await user.click(screen.getByRole('button', { name: '你' }));
    expect(await screen.findByText('没有会话')).toBeTruthy();
    expect(screen.queryByTestId('session-preview')).toBeNull();

    // Clicking the member's avatar in the message area also opens that member's session preview
    await user.click(screen.getByRole('button', { name: '预览 小A 会话' }));
    expect(await screen.findByTestId('session-preview')).toHaveTextContent(
      'conv-1'
    );

    // Clicking + in top toolbar expands menu with 新建协作空间 and 新建成员
    await user.click(screen.getByRole('button', { name: '新建空间' }));
    const createSpaceMenuItem = await screen.findByRole('menuitem', {
      name: '新建协作空间',
    });
    expect(
      screen.getByRole('menuitem', { name: '新建成员' })
    ).toBeTruthy();
    await user.click(createSpaceMenuItem);

    // Form is rendered as a blurred overlay inside the middle message area (.collaboration-thread)
    const threadSection = screen.getByRole('region', { name: '设计' });
    const dialogInThread = within(threadSection).getByRole('dialog', {
      name: '新建空间',
    });
    expect(dialogInThread).toBeTruthy();
    expect(
      threadSection.querySelector('.collaboration-thread-overlay')
    ).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '空间名称' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '新建空间' })).toBeNull();
    });

    // Clicking per-space UserPlus button opens the unified 新建成员 overlay pre-set to 从会话新建
    await user.click(screen.getByRole('button', { name: '加入成员 设计' }));
    const memberDialog = await within(threadSection).findByRole('dialog', {
      name: '新建成员',
    });
    expect(memberDialog).toBeTruthy();
    const sourceSelect = within(memberDialog).getByRole('combobox', {
      name: '创建方式',
    }) as HTMLSelectElement;
    expect(sourceSelect.value).toBe('session');
    expect(
      within(memberDialog).getByRole('combobox', { name: '选择会话' })
    ).toBeTruthy();
    expect(
      within(memberDialog).getByRole('textbox', { name: '成员名称' })
    ).toBeTruthy();
  });

  it('completes @nickname via SessionComposerInput panel, sends targeted vs broadcast posts, and renders receipts', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('你好')).toBeTruthy();
    expect(await screen.findByRole('button', { name: '小A' })).toBeTruthy();

    const editor = getComposerEditor();
    await user.click(editor);
    await user.type(editor, '@');

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
    expect(await screen.findByText('小A · 已排队')).toBeTruthy();

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
    expect(await screen.findByText('空间消息只发送文字')).toBeTruthy();
    expect(editor).toHaveTextContent('@小A 重试这条');

    await user.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('没有送达')).toBeTruthy();
    expect(await screen.findByText('小A · 失败')).toBeTruthy();
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

    expect(await screen.findByText('你好')).toBeTruthy();

    await act(async () => {
      for (const listener of spaceEventListeners) {
        listener({
          workspaceId: 'workspace-1',
          spaceId: 's1',
          seq: 2,
        });
      }
    });

    expect(await screen.findByText('增量消息')).toBeTruthy();
    expect(collaborationCall).toHaveBeenCalledWith(
      'collaboration',
      'space.listMessages',
      { spaceId: 's1', sinceSeq: 1 }
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

    await user.click(screen.getByRole('button', { name: '修改昵称 小A' }));
    expect(
      await screen.findByRole('dialog', { name: '修改昵称' })
    ).toBeTruthy();
    const input = screen.getByRole('textbox', { name: '昵称' });
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
  });

  it('supports search, filtering by agent/activity/member, and batch deleting spaces and members', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole('button', { name: '设计' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: '小A' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: '小B' })).toBeTruthy();

    // Filter by Agent
    await user.click(screen.getByRole('button', { name: '筛选' }));
    const agentSelect = await screen.findByRole('combobox', {
      name: '按 Agent',
    });
    await user.selectOptions(agentSelect, 'CODEX');
    expect(screen.getByRole('button', { name: '设计' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '重置筛选' }));

    // Batch delete mode: selecting space '设计' automatically selects both 小A and 小B;
    // deselecting 小A keeps '设计' and 小B selected so 小A moves to 未定空间 and 小B is archived
    await user.click(screen.getByRole('button', { name: '批量删除' }));
    const spaceCheckbox = screen.getByRole('checkbox', {
      name: '选择空间 设计',
    });
    await user.click(spaceCheckbox);

    const memberACheckbox = screen.getByRole('checkbox', {
      name: '选择成员 小A',
    });
    const memberBCheckbox = screen.getByRole('checkbox', {
      name: '选择成员 小B',
    });
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
    // Default space is shown in the left space list
    expect(await screen.findByRole('button', { name: '默认空间' })).toBeTruthy();
    // Left pane shows ONLY 2 centered buttons (新建协作空间, 新建成员) and no 从会话新建成员 button
    expect(screen.getByRole('button', { name: '新建协作空间' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '新建成员' })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: '从会话新建成员' })
    ).toBeNull();
    // Middle message area is shown by default even when no user space exists
    expect(screen.getByTestId('session-composer-editor')).toBeTruthy();
    expect(screen.getByText('还没有消息')).toBeTruthy();
    // Right preview area is NOT shown by default
    expect(screen.queryByLabelText('预览')).toBeNull();

    // Test unified 新建成员 overlay inside message area (从角色新建 / 从会话新建 / 自定义)
    await user.click(screen.getByRole('button', { name: '新建成员' }));
    const memberDialog = await screen.findByRole('dialog', {
      name: '新建成员',
    });
    expect(memberDialog).toBeTruthy();
    const sourceSelector = within(memberDialog).getByRole('combobox', {
      name: '创建方式',
    }) as HTMLSelectElement;
    expect(
      Array.from(sourceSelector.options).map((opt) => opt.textContent)
    ).toEqual(['从角色新建', '从会话新建', '自定义']);

    await user.type(
      within(memberDialog).getByRole('textbox', { name: '成员名称' }),
      '架构助手'
    );
    await user.selectOptions(
      within(memberDialog).getByRole('combobox', { name: '归属团队（可选）' }),
      'team-1'
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
          teamId: 'team-1',
        })
      );
    });

    // Test 新建协作空间 overlay with a non-member session selected (auto English nickname)
    await user.click(screen.getByRole('button', { name: '新建协作空间' }));
    const spaceDialog = await screen.findByRole('dialog', {
      name: '新建空间',
    });
    const nameInput = within(spaceDialog).getByRole('textbox', {
      name: '空间名称',
    });
    await user.type(nameInput, '架构评审');
    const convCheckbox = await within(spaceDialog).findByRole('checkbox');
    await user.click(convCheckbox);
    await user.click(
      spaceDialog.querySelector('button[type="submit"]') as HTMLButtonElement
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
    // Once a space exists, the 2 empty-state buttons in the left pane disappear
    expect(
      screen.queryByRole('button', { name: '新建协作空间' })
    ).toBeNull();
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
});
