import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceWithSession } from '@/types/attempt';
import { getConversationTimelineView } from '@/features/conversation/conversationTimelineRegistry';
import type { ConversationTimelineTurn } from '@/features/conversation/conversationStore';
import ConversationTimeline from './ConversationTimeline';

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
  id: 'scroll-workspace',
  project_id: 'scroll-project',
  task_id: 'scroll-task',
  parent_workspace_id: null,
  container_ref: null,
  branch: 'main',
  use_worktree: false,
  agent_working_dir: null,
  setup_completed_at: null,
  created_at: '2026-11-13T00:00:00Z',
  updated_at: '2026-11-13T00:00:00Z',
  archived: false,
  pinned: false,
  name: 'Scroll test',
  session: {
    id: 'scroll-session',
    workspace_id: 'scroll-workspace',
    task_id: null,
    name: 'Scroll test',
    initial_prompt: null,
    status: 'todo',
    executor: null,
    external_session_id: null,
    agent_id: null,
    parent_session_id: null,
    parent_tool_use_id: null,
    delegation_call_id: null,
    created_at: '2026-11-13T00:00:00Z',
    updated_at: '2026-11-13T00:00:00Z',
  },
};

let viewportHeight = 0;
const resizeObservers = new Set<() => void>();
const layoutMocks: { mockRestore: () => void }[] = [];
const scrollToDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollTo'
);
let queryClient: QueryClient;

function historyView(
  count: number
): ReturnType<typeof getConversationTimelineView> {
  const timeline: ConversationTimelineTurn[] = Array.from(
    { length: count },
    (_, index) => ({
      key: `message-${index}`,
      phase: 'persisted',
      revision: 1n,
      turn: {
        id: `turn-${index}:user`,
        role: 'user',
        timestamp: '2026-11-13T00:00:00Z',
        blocks: [{ type: 'text', text: `Message ${index}` }],
      },
    })
  );
  return {
    ...getConversationTimelineView(null),
    timeline,
    items: timeline.map((item) => ({ kind: 'message', revision: 1n, item })),
    loading: false,
  };
}

beforeEach(() => {
  viewportHeight = 0;
  history.view = historyView(20);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(['attemptRepo', attempt.id], []);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private targets = new Set<Element>();
      constructor(private callback: (entries: { target: Element }[]) => void) {}
      private notify = () => {
        this.callback(Array.from(this.targets, (target) => ({ target })));
      };
      observe(target: Element) {
        this.targets.add(target);
        resizeObservers.add(this.notify);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
        resizeObservers.delete(this.notify);
      }
    }
  );
  layoutMocks.push(
    vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.panel === 'conversation-logs'
          ? viewportHeight
          : 120;
      }),
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600),
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(128),
    vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.panel === 'conversation-logs' && viewportHeight > 0
          ? 2560
          : 0;
      })
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: function (this: HTMLElement, options: ScrollToOptions | number) {
      if (typeof options !== 'number') this.scrollTop = options.top ?? 0;
    },
  });
});

afterEach(() => {
  queryClient.clear();
  layoutMocks.splice(0).forEach((mock) => mock.mockRestore());
  vi.unstubAllGlobals();
  resizeObservers.clear();
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

function timelineElement(workspace = attempt) {
  return (
    <MemoryRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <QueryClientProvider client={queryClient}>
        <ConversationTimeline attempt={workspace} task={null} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function resizeViewport(height: number) {
  act(() => {
    viewportHeight = height;
    Array.from(resizeObservers).forEach((notify) => notify());
  });
}

async function nextFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

describe('opening a conversation', () => {
  it('opens at the latest message when a hidden panel acquires its size', async () => {
    const { container } = render(timelineElement());
    const viewport = container.querySelector<HTMLElement>(
      '[data-panel="conversation-logs"]'
    );
    expect(viewport).not.toBeNull();
    await nextFrame();
    resizeViewport(400);
    await waitFor(() =>
      expect(viewport?.scrollTop).toBeGreaterThanOrEqual(2000)
    );
  });

  it('keeps the reading position on resize after the user scrolls up', async () => {
    viewportHeight = 400;
    const { container } = render(timelineElement());
    const viewport = container.querySelector<HTMLElement>(
      '[data-panel="conversation-logs"]'
    );
    if (!viewport) throw new Error('Conversation viewport was not rendered');
    await waitFor(() =>
      expect(viewport.scrollTop).toBeGreaterThanOrEqual(2000)
    );
    fireEvent.wheel(viewport, { deltaY: -100 });
    viewport.scrollTop = 1000;
    fireEvent.scroll(viewport);

    resizeViewport(0);
    resizeViewport(500);
    await nextFrame();

    expect(viewport.scrollTop).toBe(1000);
  });

  it('pins asynchronously loaded history when its panel becomes visible', async () => {
    history.view = { ...historyView(0), loading: true };
    const { container, rerender } = render(timelineElement());
    await nextFrame();

    history.view = historyView(20);
    rerender(timelineElement());
    await nextFrame();
    resizeViewport(400);

    const viewport = container.querySelector<HTMLElement>(
      '[data-panel="conversation-logs"]'
    );
    await waitFor(() =>
      expect(viewport?.scrollTop).toBeGreaterThanOrEqual(2000)
    );
  });

  it('opens another session at the bottom after reading older messages', async () => {
    viewportHeight = 400;
    const { container, rerender } = render(timelineElement());
    const viewport = container.querySelector<HTMLElement>(
      '[data-panel="conversation-logs"]'
    );
    if (!viewport) throw new Error('Conversation viewport was not rendered');
    await nextFrame();
    fireEvent.wheel(viewport, { deltaY: -100 });
    viewport.scrollTop = 1000;
    fireEvent.scroll(viewport);

    if (!attempt.session) throw new Error('Missing test session');
    rerender(
      timelineElement({
        ...attempt,
        session: { ...attempt.session, id: 'another-scroll-session' },
      })
    );
    await nextFrame();

    expect(viewport.scrollTop).toBeGreaterThanOrEqual(2000);
  });
});
