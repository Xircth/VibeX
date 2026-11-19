import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AsyncTaskRecord, ConversationRelationView } from 'shared/types';
import type { ConversationStatusNotice } from '@/contexts/ConversationStatusContext';
import { conversationApi } from '@/features/conversation/conversationApi';
import { ConversationChildrenSummary } from '@/features/conversation/ConversationChildrenSummary';
import {
  ComposerTabDock,
  splitConversationStatusNotices,
} from './ComposerTabDock';
import type { QueuedMessage } from './sessionComposerQueue';

const { mockListenToConversationEvents } = vi.hoisted(() => ({
  mockListenToConversationEvents: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock('@/features/conversation/conversationApi', () => ({
  conversationApi: {
    listRelations: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/features/conversation/events', () => ({
  listenToConversationEvents: mockListenToConversationEvents,
}));

function makeRelation(
  id: string,
  activeTurnStatus: string | null = 'running',
  title = `子会话 ${id}`
): ConversationRelationView {
  return {
    id,
    parentConversationId: 'conv-parent',
    childConversationId: `child-${id}`,
    kind: 'delegation',
    visibility: 'visible',
    metadata: {},
    child: {
      workspaceId: 'ws-1',
      title,
      status: activeTurnStatus ? 'inprogress' : 'done',
      activeTurnStatus,
      queuedInputCount: 0n,
      messageCount: 2n,
    },
  } as ConversationRelationView;
}

const sampleQueued: QueuedMessage = {
  id: 'msg-1',
  session_id: 'session-1',
  operationId: 'op-1',
  revision: 1n,
  sortKey: 1n,
  status: 'queued',
  deliverAt: null,
  data: {
    message: '等待发送的排队消息',
    agentMessage: '等待发送的排队消息',
    images: [],
    pluginActions: [],
  },
  executorProfileId: { executor: 'CLAUDE_CODE' },
  created_at: '2026-11-19T00:00:00.000Z',
  updated_at: '2026-11-19T00:00:00.000Z',
};

const sampleDelayed: QueuedMessage = {
  ...sampleQueued,
  id: 'msg-delayed-1',
  operationId: 'op-2',
  status: 'scheduled',
  deliverAt: new Date(Date.now() + 125_000).toISOString(),
  data: {
    message: '延时发送的消息',
    agentMessage: '延时发送的消息',
    images: [],
    pluginActions: [],
  },
};

const sampleTask: AsyncTaskRecord = {
  id: 'bg-task-1',
  task_type: 'bash',
  state: 'running',
  name: 'pnpm dev',
  phase: 'listening',
  current_agent: null,
  last_tool_name: null,
  output_file_path: '/tmp/dev.log',
  tool_call_id: 'call-1',
  can_stop: true,
  usage: { total_tokens: 1200n, tool_uses: 1n, duration_ms: 4000n },
};

describe('ComposerTabDock', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(conversationApi.listRelations).mockResolvedValue([]);
    mockListenToConversationEvents.mockClear();
  });

  it('splits critical/blocking notices to priority banners and non-blocking ones to tab notices', () => {
    const notices: ConversationStatusNotice[] = [
      {
        id: 'err-1',
        kind: 'turn-error',
        error: {
          message: 'connection lost',
          code: 'connection_closed',
          raw: null,
          kind: 'connection_closed',
        },
      },
      {
        id: 'int-1',
        kind: 'interrupted-turn',
        onResend: vi.fn(),
      },
      {
        id: 'conn-1',
        kind: 'session-notice',
        notice: {
          title: 'Connecting',
          message: null,
          severity: 'info',
          connection_status: {
            status: 'connecting',
            bound: false,
            connection_id: 'c1',
            message: null,
            since: '2026-11-19T00:00:00.000Z',
          },
        },
      },
      {
        id: 'rebind-1',
        kind: 'session-notice',
        notice: {
          title: 'Expired',
          message: null,
          severity: 'warning',
        },
        onRebind: vi.fn(),
      },
      {
        id: 'notice-info',
        kind: 'session-notice',
        notice: {
          title: '已自动批准权限',
          message: '已自动批准 3 项权限请求',
          severity: 'info',
        },
      },
      {
        id: 'notice-warn',
        kind: 'session-notice',
        notice: {
          title: 'Skill descriptions shortened',
          message: 'Some descriptions were shortened',
          severity: 'warning',
        },
      },
    ];

    const { priorityNotices, tabNotices } =
      splitConversationStatusNotices(notices);

    expect(priorityNotices.map((item) => item.id)).toEqual([
      'err-1',
      'int-1',
      'conn-1',
      'rebind-1',
    ]);
    expect(tabNotices.map((item) => item.id)).toEqual([
      'notice-info',
      'notice-warn',
    ]);
  });

  it('switches a single exclusive panel between queue, children, async tasks, goal, and notices, and collapses cleanly', async () => {
    vi.mocked(conversationApi.listRelations).mockResolvedValue([
      makeRelation('1', 'running', 'AI 岗位样本检索'),
    ]);

    const onDelay = vi.fn();
    render(
      <ComposerTabDock
        dismissalScope="session-1"
        queuedMessages={[sampleQueued]}
        delayedMessages={[sampleDelayed]}
        onDelayQueuedMessage={onDelay}
        childrenDock={{
          conversationId: 'conv-parent',
          onOpenChild: vi.fn(),
        }}
        asyncTasks={[sampleTask]}
        sessionGoal={{
          goal: {
            objective: '完成 UI 统一改造',
            status: 'active',
          },
          actions: ['pause', 'clear'],
        }}
        notices={[
          {
            id: 'notice-1',
            kind: 'session-notice',
            notice: {
              title: '自动批准权限',
              message: '已自动批准 2 项权限',
              severity: 'info',
            },
          },
        ]}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /子会话/ })).toBeInTheDocument();
    });

    // Collapsed by default so nothing blocks the composer or timeline
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();

    // Open queue tab
    fireEvent.click(screen.getByRole('tab', { name: /消息队列/ }));
    expect(screen.getByTestId('composer-tab-panel-queue')).toBeInTheDocument();
    expect(screen.getByText('等待发送的排队消息')).toBeInTheDocument();
    expect(screen.getByText('延时发送的消息')).toBeInTheDocument();
    expect(
      screen.getByTestId('delayed-countdown-msg-delayed-1').textContent
    ).toMatch(/\d{2}:\d{2}$/);

    // Switch to child sessions tab -> queue panel unmounts
    fireEvent.click(screen.getByRole('tab', { name: /子会话/ }));
    expect(
      screen.queryByTestId('composer-tab-panel-queue')
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId('composer-tab-panel-children')
    ).toBeInTheDocument();
    expect(screen.getByText('AI 岗位样本检索')).toBeInTheDocument();

    // Switch to async tasks tab
    fireEvent.click(screen.getByRole('tab', { name: /后台任务/ }));
    expect(
      screen.getByTestId('composer-tab-panel-asyncTasks')
    ).toBeInTheDocument();
    expect(screen.getByText('pnpm dev')).toBeInTheDocument();

    // Switch to session goal tab
    fireEvent.click(screen.getByRole('tab', { name: /会话目标/ }));
    expect(screen.getByTestId('composer-tab-panel-goal')).toBeInTheDocument();
    expect(screen.getByText('完成 UI 统一改造')).toBeInTheDocument();

    // Switch to notices tab
    fireEvent.click(screen.getByRole('tab', { name: /提示通知/ }));
    expect(screen.getByTestId('composer-tab-panel-notice')).toBeInTheDocument();
    const noticeTitle = screen.getByText('自动批准权限');
    expect(noticeTitle).toHaveClass('text-[13px]');
    const detailsTrigger = screen.getByRole('button', {
      name: '查看详情：自动批准权限',
    });
    expect(detailsTrigger).toHaveTextContent('查看详情');
    expect(detailsTrigger).toHaveClass('composer-status-disclosure');
    expect(noticeTitle.parentElement).toContainElement(detailsTrigger);
    expect(screen.queryByText('已自动批准 2 项权限')).not.toBeInTheDocument();
    fireEvent.click(detailsTrigger);
    expect(screen.getByText('已自动批准 2 项权限')).toBeInTheDocument();

    // Collapse button closes the open panel
    fireEvent.click(screen.getByTestId('composer-tab-collapse'));
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();
  });

  it('allows closing the child-session tab and resurfaces only when a new child relation arrives', async () => {
    let relations = [makeRelation('1', 'running', '子会话 A')];
    vi.mocked(conversationApi.listRelations).mockImplementation(
      async () => relations
    );
    let eventHandler:
      | ((batch: { conversation_id: string; ops: unknown[] }) => void)
      | null = null;
    mockListenToConversationEvents.mockImplementation(async (cb) => {
      eventHandler = cb;
      return () => undefined;
    });

    render(
      <ComposerTabDock
        dismissalScope="session-1"
        queuedMessages={[sampleQueued]}
        childrenDock={{
          conversationId: 'conv-parent',
          onOpenChild: vi.fn(),
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /子会话/ })).toBeInTheDocument();
    });

    // Open children panel, then dismiss it via its close button
    fireEvent.click(screen.getByRole('tab', { name: /子会话/ }));
    expect(
      screen.getByTestId('composer-tab-panel-children')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('composer-tab-dismiss-children'));
    expect(
      screen.queryByRole('tab', { name: /子会话/ })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('composer-tab-panel-children')
    ).not.toBeInTheDocument();
    // Queue tab stays accessible and unobstructed
    expect(screen.getByRole('tab', { name: /消息队列/ })).toBeInTheDocument();

    // A new child relation arrives -> child tab resurfaces
    relations = [
      makeRelation('1', 'running', '子会话 A'),
      makeRelation('2', 'running', '子会话 B'),
    ];
    await act(async () => {
      eventHandler?.({
        conversation_id: 'conv-parent',
        ops: [{ op: 'status' }],
      });
    });

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /子会话/ })).toBeInTheDocument();
    });
  });

  it('persists notice tab dismissal via conversationStatusDismissal', () => {
    const notice: ConversationStatusNotice = {
      id: 'notice-persist-1',
      kind: 'session-notice',
      notice: {
        title: '部分会话记录无法显示',
        message: '其余内容不受影响',
        severity: 'warning',
      },
    };

    const first = render(
      <ComposerTabDock dismissalScope="session-1" notices={[notice]} />
    );

    expect(screen.getByRole('tab', { name: /提示通知/ })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('composer-tab-dismiss-notice'));
    expect(screen.queryByTestId('composer-tab-dock')).not.toBeInTheDocument();
    first.unmount();

    // Re-mounting with same notice keeps it dismissed
    render(<ComposerTabDock dismissalScope="session-1" notices={[notice]} />);
    expect(screen.queryByTestId('composer-tab-dock')).not.toBeInTheDocument();
  });

  it('allows dismissing standalone ConversationChildrenSummary fallback card', async () => {
    vi.mocked(conversationApi.listRelations).mockResolvedValue([
      makeRelation('1', 'running', '独立子会话卡片'),
    ]);

    render(
      <ConversationChildrenSummary
        conversationId="conv-parent"
        onOpenChild={vi.fn()}
      />
    );

    const card = await screen.findByTestId('conversation-children-summary');
    expect(card).toHaveTextContent('独立子会话卡片');

    fireEvent.click(screen.getByRole('button', { name: '关闭子会话面板' }));
    expect(
      screen.queryByTestId('conversation-children-summary')
    ).not.toBeInTheDocument();
  });

  it('collapses the expanded panel when clicking outside the card while keeping inside interactions open', () => {
    const outsideButtonClick = vi.fn((event: React.MouseEvent) => {
      event.stopPropagation();
    });

    render(
      <div>
        <div data-testid="outside-timeline">外部消息区域</div>
        <button
          type="button"
          data-testid="outside-stop-prop-btn"
          onClick={outsideButtonClick}
        >
          外部按钮
        </button>
        <ComposerTabDock
          dismissalScope="session-1"
          queuedMessages={[sampleQueued]}
          notices={[
            {
              id: 'notice-outside-1',
              kind: 'session-notice',
              notice: {
                title: '自动批准权限',
                message: '已自动批准 2 项权限',
                severity: 'info',
              },
            },
          ]}
        />
      </div>
    );

    // Collapsed initially; outside click is a safe no-op
    fireEvent.click(screen.getByTestId('outside-timeline'));
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /消息队列/ })).toBeInTheDocument();

    // Open queue tab and click inside the panel -> stays open
    fireEvent.click(screen.getByRole('tab', { name: /消息队列/ }));
    const queuePanel = screen.getByTestId('composer-tab-panel-queue');
    fireEvent.click(queuePanel);
    expect(screen.getByTestId('composer-tab-panel-queue')).toBeInTheDocument();

    // Dragging selection from inside panel to outside -> stays open
    fireEvent.pointerDown(screen.getByText('等待发送的排队消息'));
    fireEvent.click(screen.getByTestId('outside-timeline'));
    expect(screen.getByTestId('composer-tab-panel-queue')).toBeInTheDocument();

    // Clicking outside collapses the panel (even without pointerDown, e.g. synthetic click)
    fireEvent.click(screen.getByTestId('outside-timeline'));
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();

    // Re-open notices tab, toggle inside details -> stays open, then click outside stopPropagation button -> collapses and button still receives click
    fireEvent.click(screen.getByRole('tab', { name: /提示通知/ }));
    fireEvent.click(
      screen.getByRole('button', { name: '查看详情：自动批准权限' })
    );
    expect(screen.getByText('已自动批准 2 项权限')).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByTestId('outside-stop-prop-btn'));
    fireEvent.click(screen.getByTestId('outside-stop-prop-btn'));
    expect(outsideButtonClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();
  });

  it('caps both docked and standalone child session lists inside 4-row scrollable containers when many children exist', async () => {
    vi.mocked(conversationApi.listRelations).mockResolvedValue([
      makeRelation('1', 'running', '子会话 1'),
      makeRelation('2', 'running', '子会话 2'),
      makeRelation('3', 'running', '子会话 3'),
      makeRelation('4', 'running', '子会话 4'),
      makeRelation('5', null, '子会话 5'),
      makeRelation('6', null, '子会话 6'),
    ]);

    const { unmount } = render(
      <ComposerTabDock
        dismissalScope="session-many"
        childrenDock={{
          conversationId: 'conv-parent',
          onOpenChild: vi.fn(),
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /子会话/ })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('tab', { name: /子会话/ }));
    const dockedList = screen.getByTestId('composer-children-list');
    expect(dockedList).toHaveClass('composer-cockpit-children-list');
    expect(dockedList.querySelectorAll('.composer-cockpit-row')).toHaveLength(
      6
    );
    // Summary subbar stays outside the scrolling row list so 4 full rows fit below it
    expect(dockedList).not.toHaveTextContent('4 个进行中');
    expect(
      screen.getByTestId('conversation-children-summary')
    ).toHaveTextContent('4 个进行中');

    unmount();

    render(
      <ConversationChildrenSummary
        conversationId="conv-parent"
        onOpenChild={vi.fn()}
      />
    );

    const standaloneList = await screen.findByTestId(
      'conversation-children-list'
    );
    expect(standaloneList).toHaveClass('max-h-[102px]', 'overflow-y-auto');
    expect(standaloneList.querySelectorAll('button')).toHaveLength(6);
  });
});
