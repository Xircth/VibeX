import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineRow } from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import {
  ConversationStatusProvider,
  useConversationStatus,
} from '@/contexts/ConversationStatusContext';
import { EntriesProvider, useEntries } from '@/contexts/EntriesContext';
import { ConversationStatusDock } from '@/components/tasks/follow-up/ConversationStatusDock';
import { hasPendingToolApproval } from '@/components/tasks/follow-up/sessionComposerSubmit';
import { getConversationTimelineView } from '@/features/conversation/conversationTimelineRegistry';
import type { ConversationTimelineTurn } from '@/features/conversation/conversationStore';
import { AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID } from '@/features/conversation/sessionNoticeNeedsRebind';
import ConversationTimeline, {
  buildResendTurnPayload,
  timelineToPatchEntries,
} from './ConversationTimeline';

const AGENT_CONNECTION_STATUS_ROW_ID = 'runtime:connection';
const AGENT_REQUEST_STATUS_ROW_ID = 'runtime:request';

const history = vi.hoisted<{
  view: ReturnType<typeof getConversationTimelineView> | null;
}>(() => ({ view: null }));

vi.mock('@/features/conversation/useConversationTimeline', () => ({
  useConversationTimeline: () => history.view,
}));
vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({ config: null }),
  useOptionalUserSystem: () => null,
}));
vi.mock('@/components/context-menu', () => ({
  useAppContextMenu: () => ({ openSurfaceMenu: vi.fn() }),
}));

const attempt: WorkspaceWithSession = {
  id: 'runtime-workspace',
  project_id: 'runtime-project',
  task_id: 'runtime-task',
  parent_workspace_id: null,
  container_ref: null,
  branch: 'main',
  use_worktree: false,
  agent_working_dir: null,
  setup_completed_at: null,
  created_at: '2026-11-15T00:00:00Z',
  updated_at: '2026-11-15T00:00:00Z',
  archived: false,
  pinned: false,
  name: 'Runtime status test',
  session: {
    id: 'runtime-session',
    workspace_id: 'runtime-workspace',
    task_id: null,
    name: 'Runtime status test',
    initial_prompt: null,
    status: 'todo',
    executor: null,
    external_session_id: null,
    agent_id: null,
    provider_instance_id: null,
    parent_session_id: null,
    parent_tool_use_id: null,
    delegation_call_id: null,
    created_at: '2026-11-15T00:00:00Z',
    updated_at: '2026-11-15T00:00:00Z',
  },
};

function DockMirror() {
  const { notices } = useConversationStatus();
  return <ConversationStatusDock notices={notices} />;
}

const layoutMocks: { mockRestore: () => void }[] = [];
const scrollToDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollTo'
);
let queryClient: QueryClient;

function makeView(
  timeline: ConversationTimelineTurn[],
  sideRows: TimelineRow[],
  overrides: Partial<ReturnType<typeof getConversationTimelineView>> = {}
): ReturnType<typeof getConversationTimelineView> {
  return {
    ...getConversationTimelineView(null),
    loading: false,
    timeline,
    sideRows,
    items: [
      ...timeline.map((item) => ({
        kind: 'message' as const,
        revision: item.revision,
        item,
      })),
      ...sideRows.map((row) => ({
        kind: 'side' as const,
        revision: 1n,
        row,
      })),
    ],
    ...overrides,
  };
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(['attemptRepo', attempt.id], []);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  layoutMocks.push(
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600),
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600),
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120),
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(600)
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: () => {},
  });
});

afterEach(() => {
  queryClient.clear();
  layoutMocks.splice(0).forEach((mock) => mock.mockRestore());
  vi.unstubAllGlobals();
  if (scrollToDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      'scrollTo',
      scrollToDescriptor
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  }
});

function renderTimelineWithDock() {
  return render(
    <MemoryRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <QueryClientProvider client={queryClient}>
        <ConversationStatusProvider>
          <ConversationTimeline attempt={attempt} task={null} />
          <DockMirror />
        </ConversationStatusProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe('ConversationTimeline runtime status placement & localization', () => {
  it('places pre-send connection status in the composer dock and not at the top of the message stream', () => {
    history.view = makeView(
      [],
      [
        {
          row_id: AGENT_CONNECTION_STATUS_ROW_ID,
          revision: 1n,
          row: {
            kind: 'session_notice',
            notice: {
              title: 'Agent connection',
              severity: 'warning',
              connection_status: {
                status: 'recovering',
                bound: false,
                connection_id: 'conn-1',
                message: null,
                since: '2026-11-15T00:00:00Z',
              },
            },
          },
        },
        {
          row_id: AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID,
          revision: 1n,
          row: {
            kind: 'session_notice',
            notice: {
              title: '会话加载异常，正在重连 3/10 次…',
              message: null,
              severity: 'warning',
            },
          },
        },
      ],
      { connecting: true }
    );

    const { container } = renderTimelineWithDock();

    const logsArea = container.querySelector(
      '[data-panel="conversation-logs"]'
    ) as HTMLElement;
    expect(
      within(logsArea).queryByTestId('agent-connection-status')
    ).toBeNull();

    const dock = screen.getByTestId('conversation-status-dock');
    expect(dock).toHaveAttribute('data-expanded', 'true');
    expect(
      within(dock).getByTestId('agent-connection-status')
    ).toHaveTextContent('会话加载异常，正在重连 3/10 次…');
  });

  it('renders lightweight connecting/retry text in the stream after send and suppresses Driving placeholder', () => {
    history.view = makeView(
      [
        {
          key: 'u1',
          phase: 'streaming',
          revision: 1n,
          turn: {
            id: 'turn-1:user',
            role: 'user',
            timestamp: '2026-11-15T00:00:00Z',
            blocks: [{ type: 'text', text: 'hello' }],
          },
        },
        {
          key: 'a1',
          phase: 'streaming',
          revision: 2n,
          turn: {
            id: 'turn-1:assistant',
            role: 'assistant',
            timestamp: '2026-11-15T00:00:01Z',
            blocks: [],
          },
        },
      ],
      [
        {
          row_id: AGENT_REQUEST_STATUS_ROW_ID,
          revision: 1n,
          row: {
            kind: 'session_notice',
            notice: {
              title: 'Agent request',
              severity: 'info',
              request_status: {
                turn_id: 'turn-1',
                prompt_id: 'prompt-1',
                connection_id: 'conn-1',
                since: '2026-11-15T00:00:01Z',
                activity: {
                  phase: 'retrying',
                  retry: {
                    attempt: 2,
                    max_attempts: 5,
                    delay_ms: 2000n,
                    reason: 'busy',
                    code: null,
                  },
                },
              },
            },
          },
        },
      ]
    );

    const { container } = renderTimelineWithDock();

    const logsArea = container.querySelector(
      '[data-panel="conversation-logs"]'
    ) as HTMLElement;
    const streamStatus = within(logsArea).getByTestId('agent-request-status');
    expect(streamStatus).toHaveClass('conv-thinking-placeholder');
    expect(streamStatus).not.toHaveClass('rounded-lg');
    expect(streamStatus).toHaveTextContent('连接中... 正在重试 2/5 次');

    expect(within(logsArea).getAllByRole('status')).toHaveLength(1);
    expect(container.textContent).not.toContain('runtime.request.');
    expect(screen.queryByTestId('conversation-status-dock')).toBeNull();
  });

  it('shows 连接中... before assistant blocks arrive and localized LiveTurnStats status once streaming starts', () => {
    history.view = makeView(
      [
        {
          key: 'u1',
          phase: 'streaming',
          revision: 1n,
          turn: {
            id: 'turn-1:user',
            role: 'user',
            timestamp: '2026-11-15T00:00:00Z',
            blocks: [{ type: 'text', text: 'hello' }],
          },
        },
        {
          key: 'a1',
          phase: 'streaming',
          revision: 2n,
          turn: {
            id: 'turn-1:assistant',
            role: 'assistant',
            timestamp: '2026-11-15T00:00:01Z',
            blocks: [],
          },
        },
      ],
      [
        {
          row_id: AGENT_REQUEST_STATUS_ROW_ID,
          revision: 1n,
          row: {
            kind: 'session_notice',
            notice: {
              title: 'Agent request',
              severity: 'info',
              request_status: {
                turn_id: 'turn-1',
                prompt_id: 'prompt-1',
                connection_id: 'conn-1',
                since: '2026-11-15T00:00:01Z',
                activity: {
                  phase: 'waiting_agent',
                  retry: null,
                },
              },
            },
          },
        },
      ]
    );

    const { container, rerender } = renderTimelineWithDock();
    const logsArea = container.querySelector(
      '[data-panel="conversation-logs"]'
    ) as HTMLElement;
    expect(
      within(logsArea).getByTestId('agent-request-status')
    ).toHaveTextContent('连接中...');
    expect(within(logsArea).getAllByRole('status')).toHaveLength(1);
    expect(container.textContent).not.toContain(
      'runtime.request.waiting_agent'
    );

    history.view = makeView(
      [
        {
          key: 'u1',
          phase: 'streaming',
          revision: 1n,
          turn: {
            id: 'turn-1:user',
            role: 'user',
            timestamp: '2026-11-15T00:00:00Z',
            blocks: [{ type: 'text', text: 'hello' }],
          },
        },
        {
          key: 'a1',
          phase: 'streaming',
          revision: 3n,
          turn: {
            id: 'turn-1:assistant',
            role: 'assistant',
            timestamp: '2026-11-15T00:00:01Z',
            blocks: [{ type: 'text', text: 'Partial reply' }],
          },
        },
      ],
      history.view.sideRows
    );

    rerender(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <QueryClientProvider client={queryClient}>
          <ConversationStatusProvider>
            <ConversationTimeline attempt={attempt} task={null} />
            <DockMirror />
          </ConversationStatusProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );

    expect(container.textContent).not.toContain(
      'runtime.request.waiting_agent'
    );
    expect(container.textContent).toContain('等待 Agent 响应');
  });

  it('populates EntriesContext.entries from ConversationTimeline including pending tool approvals', () => {
    function EntriesMirror() {
      const { entries } = useEntries();
      return (
        <div
          data-testid="entries-mirror"
          data-count={entries.length}
          data-pending-approval={String(hasPendingToolApproval(entries))}
        />
      );
    }

    history.view = makeView(
      [
        {
          key: 'u1',
          phase: 'settled',
          revision: 1n,
          turn: {
            id: 'turn-1:user',
            role: 'user',
            timestamp: '2026-11-15T00:00:00Z',
            blocks: [{ type: 'text', text: 'Run tests' }],
          },
        },
        {
          key: 'a1',
          phase: 'streaming',
          revision: 2n,
          turn: {
            id: 'turn-1:assistant',
            role: 'assistant',
            timestamp: '2026-11-15T00:00:01Z',
            blocks: [
              {
                type: 'tool_use',
                tool_use_id: 'call-1',
                tool_name: 'Bash',
                input_preview: JSON.stringify({ command: 'pnpm test' }),
              },
            ],
          },
        },
      ],
      [
        {
          row_id: 'perm-row-1',
          revision: 1n,
          row: {
            kind: 'permission_request',
            request: {
              permission_id: 'perm-1',
              title: 'Run pnpm test',
              status: 'pending',
              details: {
                toolCallId: 'call-1',
                toolName: 'Bash',
              },
              options: [],
            },
          },
        },
      ]
    );

    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <QueryClientProvider client={queryClient}>
          <EntriesProvider>
            <ConversationStatusProvider>
              <ConversationTimeline attempt={attempt} task={null} />
              <EntriesMirror />
            </ConversationStatusProvider>
          </EntriesProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );

    const mirror = screen.getByTestId('entries-mirror');
    expect(Number(mirror.getAttribute('data-count'))).toBe(2);
    expect(mirror).toHaveAttribute('data-pending-approval', 'true');

    expect(
      timelineToPatchEntries(history.view.timeline, history.view.sideRows, [])
    ).toHaveLength(2);
  });

  it('preserves images, fileRefs, workflowRefs, modeOverride, and configOverrides in buildResendTurnPayload', () => {
    const payload = buildResendTurnPayload({
      turn: {
        id: 'turn-retry:user',
        role: 'user',
        timestamp: '2026-11-15T00:00:00Z',
        blocks: [
          {
            type: 'text',
            text: 'Check [@:App.tsx](src/App.tsx) [!:vibex.office/create-presentation|PPT]()',
          },
          {
            type: 'image',
            data: '',
            mime_type: 'image/png',
            uri: '.vibe-images/mock.png',
          },
        ],
      },
      sessionModes: {
        current: 'architect',
        modes: [{ id: 'architect', label: 'Architect', description: null }],
      },
      sessionConfigOptions: [
        {
          key: 'model',
          label: 'Model',
          value: 'gpt-5.4',
        },
        {
          key: 'reasoning_effort',
          label: 'Reasoning',
          value: 'high',
        },
      ],
    });

    expect(payload).toEqual({
      text: 'Check src/App.tsx',
      displayText:
        'Check [@:App.tsx](src/App.tsx) [!:vibex.office/create-presentation|PPT]()',
      images: ['.vibe-images/mock.png'],
      fileRefs: [{ path: 'src/App.tsx' }],
      workflowRefs: [
        {
          pluginId: 'vibex.office',
          workflowId: 'create-presentation',
        },
      ],
      modeOverride: 'architect',
      configOverrides: [
        { key: 'model', value: 'gpt-5.4' },
        { key: 'reasoning_effort', value: 'high' },
      ],
    });
  });
});
