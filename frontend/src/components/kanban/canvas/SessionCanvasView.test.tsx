import type { ReactNode } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { TooltipProvider } from '@/components/ui/tooltip';
import { sessionsApi } from '@/lib/api';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { emptyGroupFootprint } from './canvasGrouping';
import { SessionCanvasView, type SessionCanvasApi } from './SessionCanvasView';

const fitView = vi.fn();
const setCenter = vi.fn();
const getViewport = vi.fn(() => ({ x: 0, y: 0, zoom: 1 }));
const screenToFlowPosition = vi.fn(() => ({ x: 40, y: 40 }));

vi.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
  ReactFlow: ({ children }: { children: ReactNode }) => (
    <div data-testid="react-flow">{children}</div>
  ),
  Background: () => <div data-testid="canvas-background" />,
  BackgroundVariant: { Dots: 'dots' },
  MiniMap: () => <div data-testid="canvas-minimap" />,
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ViewportPortal: ({ children }: { children: React.ReactNode }) => children,
  SelectionMode: { Partial: 'partial' },
  ConnectionMode: { Loose: 'loose' },
  useReactFlow: () => ({
    fitView,
    setCenter,
    screenToFlowPosition,
    getViewport,
    setViewport: vi.fn(),
  }),
  useStore: (
    selector: (state: {
      transform: number[];
      minZoom: number;
      maxZoom: number;
    }) => unknown
  ) => selector({ transform: [0, 0, 1], minZoom: 0.1, maxZoom: 2 }),
  NodeResizer: () => null,
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    sessionsApi: {
      ...actual.sessionsApi,
      markViewed: vi.fn().mockResolvedValue({}),
    },
  };
});

function renderCanvas(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (node: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <HotkeysProvider initiallyActiveScopes={['dialog', 'kanban', 'projects']}>
        <TooltipProvider>{node}</TooltipProvider>
      </HotkeysProvider>
    </QueryClientProvider>
  );
  const result = render(wrap(ui));
  return {
    ...result,
    rerender: (node: ReactNode) => result.rerender(wrap(node)),
  };
}

function session(id: string, updatedAt: string): KanbanProjectSessionRecord {
  return {
    id,
    updatedAt,
    status: 'todo',
    fullName: id,
    workspace: { id: 'ws' },
  } as KanbanProjectSessionRecord;
}

describe('SessionCanvasView', () => {
  beforeEach(() => {
    localStorage.clear();
    fitView.mockReset();
    setCenter.mockReset();
    getViewport.mockReset();
    getViewport.mockReturnValue({ x: 0, y: 0, zoom: 1 });
    vi.mocked(sessionsApi.markViewed).mockClear();
  });

  it('shows the minimap by default', () => {
    renderCanvas(
      <SessionCanvasView
        projectId="p1"
        sessions={[session('fresh', new Date().toISOString())]}
        listWidth={280}
        list={<div>list</div>}
      />
    );

    expect(screen.getByTestId('canvas-minimap')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '后退' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '前进' })).toBeDisabled();
  });

  it('offers importing recent sessions on an empty board', async () => {
    const user = userEvent.setup();
    renderCanvas(
      <SessionCanvasView
        projectId="p1"
        sessions={[session('fresh', new Date().toISOString())]}
        listWidth={280}
        list={<div>list</div>}
      />
    );

    expect(screen.getByText('画布是空的')).toBeInTheDocument();
    await user.click(screen.getByText('导入最近的会话'));
    expect(screen.getByText(/将导入/)).toBeInTheDocument();
  });

  it('shows the create form to the right of the session list', () => {
    renderCanvas(
      <SessionCanvasView
        projectId="p1"
        sessions={[session('fresh', new Date().toISOString())]}
        listWidth={280}
        list={<div>list</div>}
        createPanel={<div>create form</div>}
      />
    );

    expect(screen.getByText('create form')).toBeInTheDocument();
    expect(screen.getByText('create form').parentElement).toHaveClass(
      'pointer-events-auto'
    );
  });

  it('creates a two-by-two blank group from the dock plus menu', async () => {
    const user = userEvent.setup();
    renderCanvas(
      <SessionCanvasView
        projectId="p1"
        sessions={[session('fresh', new Date().toISOString())]}
        listWidth={280}
        list={<div>list</div>}
      />
    );

    await user.click(screen.getByRole('button', { name: '新建' }));
    await user.click(await screen.findByRole('menuitem', { name: '空白分组' }));
    const raw = window.localStorage.getItem('vibex:kanban-canvas:p1');
    expect(raw).toBeTruthy();
    const saved = JSON.parse(raw ?? '{}') as {
      nodes: Array<{
        kind: string;
        name: string;
        width: number;
        height: number;
      }>;
    };
    const group = saved.nodes.find((node) => node.kind === 'group');
    const footprint = emptyGroupFootprint();
    expect(group?.name).toBe('分组');
    expect(group?.width).toBe(footprint.width);
    expect(group?.height).toBe(footprint.height);
    await waitFor(() => {
      expect(setCenter).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(Number),
        expect.objectContaining({ zoom: 1, duration: 280 })
      );
    });
    expect(fitView).not.toHaveBeenCalled();
  });

  it('places a created session as a collapsed card and focuses it at the current zoom', async () => {
    let api: SessionCanvasApi | null = null;
    getViewport.mockReturnValue({ x: 12, y: 8, zoom: 0.35 });
    renderCanvas(
      <SessionCanvasView
        projectId="p1"
        sessions={[]}
        sessionsReady
        listWidth={280}
        list={<div>list</div>}
        onApiReady={(next) => {
          api = next;
        }}
      />
    );

    act(() => {
      api?.addSession('created-1');
    });

    const saved = JSON.parse(
      window.localStorage.getItem('vibex:kanban-canvas:p1') ?? '{}'
    ) as { nodes: Array<{ sessionId: string; expanded: boolean }> };
    expect(
      saved.nodes.some(
        (node) => node.sessionId === 'created-1' && node.expanded === false
      )
    ).toBe(true);

    await waitFor(() => {
      expect(setCenter).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(Number),
        expect.objectContaining({ zoom: 0.35, duration: 280 })
      );
    });
    expect(fitView).not.toHaveBeenCalled();
  });

  it('marks a session viewed when focusing it from the session list', async () => {
    let api: SessionCanvasApi | null = null;
    const record = {
      ...session('review-1', new Date().toISOString()),
      status: 'inreview' as const,
    };
    renderCanvas(
      <SessionCanvasView
        projectId="p1"
        sessions={[record]}
        listWidth={280}
        list={<div>list</div>}
        onApiReady={(next) => {
          api = next;
        }}
      />
    );

    act(() => {
      api?.addOrFocus(record);
    });

    await waitFor(() => {
      expect(sessionsApi.markViewed).toHaveBeenCalledWith('review-1');
    });
    await waitFor(() => {
      expect(setCenter).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(Number),
        expect.objectContaining({ zoom: 1, duration: 280 })
      );
    });
  });

  it('keeps the workspace execution session when the catalog refreshes', () => {
    const onSelectedSessionChange = vi.fn();
    const current = session('alpha', '2026-10-15T00:00:00.000Z');
    current.placement = { sessionId: 'alpha', workspaceId: 'ws' };
    let api: SessionCanvasApi | null = null;
    const view = (sessions: KanbanProjectSessionRecord[]) => (
      <SessionCanvasView
        projectId="p1"
        sessions={sessions}
        sessionsReady
        listWidth={280}
        list={<div>list</div>}
        onApiReady={(next) => {
          api = next;
        }}
        onSelectedSessionChange={onSelectedSessionChange}
      />
    );

    const { rerender } = renderCanvas(view([current]));
    act(() => {
      api?.addOrFocus(current);
    });

    expect(onSelectedSessionChange).toHaveBeenCalledTimes(1);
    expect(onSelectedSessionChange).toHaveBeenCalledWith({
      sessionId: 'alpha',
      workspaceId: 'ws',
    });
    onSelectedSessionChange.mockClear();

    rerender(
      view([
        {
          ...current,
          updatedAt: '2026-10-15T00:00:01.000Z',
        },
      ])
    );

    expect(onSelectedSessionChange).not.toHaveBeenCalled();

    const next = session('beta', '2026-10-15T00:00:02.000Z');
    next.placement = { sessionId: 'beta', workspaceId: 'ws' };
    rerender(view([current, next]));
    act(() => {
      api?.addOrFocus(next);
    });

    expect(onSelectedSessionChange).toHaveBeenCalledTimes(1);
    expect(onSelectedSessionChange).toHaveBeenCalledWith({
      sessionId: 'beta',
      workspaceId: 'ws',
    });
  });

  it('binds execution once when a selected session arrives in the catalog', () => {
    const onSelectedSessionChange = vi.fn();
    let api: SessionCanvasApi | null = null;
    const view = (sessions: KanbanProjectSessionRecord[]) => (
      <SessionCanvasView
        projectId="p1"
        sessions={sessions}
        sessionsReady
        listWidth={280}
        list={<div>list</div>}
        onApiReady={(next) => {
          api = next;
        }}
        onSelectedSessionChange={onSelectedSessionChange}
      />
    );

    const { rerender } = renderCanvas(view([]));
    act(() => {
      api?.addSession('late');
    });
    expect(onSelectedSessionChange).not.toHaveBeenCalled();

    const arrived = session('late', '2026-10-15T00:00:00.000Z');
    arrived.placement = { sessionId: 'late', workspaceId: 'ws' };
    rerender(view([arrived]));
    expect(onSelectedSessionChange).toHaveBeenCalledTimes(1);
    expect(onSelectedSessionChange).toHaveBeenCalledWith({
      sessionId: 'late',
      workspaceId: 'ws',
    });

    onSelectedSessionChange.mockClear();
    rerender(
      view([
        {
          ...arrived,
          updatedAt: '2026-10-15T00:00:01.000Z',
        },
      ])
    );
    expect(onSelectedSessionChange).not.toHaveBeenCalled();
  });

  it('opens the same create-session flow from the dock plus menu', async () => {
    const user = userEvent.setup();
    const onCreateSession = vi.fn();
    renderCanvas(
      <SessionCanvasView
        projectId="p1"
        sessions={[session('fresh', new Date().toISOString())]}
        listWidth={280}
        list={<div>list</div>}
        onCreateSession={onCreateSession}
      />
    );

    await user.click(screen.getByRole('button', { name: '新建' }));
    await user.click(await screen.findByRole('menuitem', { name: '新建会话' }));
    expect(onCreateSession).toHaveBeenCalledTimes(1);
  });

  it('undoes and redoes canvas edits from the history dock', async () => {
    const user = userEvent.setup();
    renderCanvas(
      <SessionCanvasView
        projectId="p1"
        sessions={[session('fresh', new Date().toISOString())]}
        listWidth={280}
        list={<div>list</div>}
      />
    );

    await user.click(screen.getByRole('button', { name: '新建' }));
    await user.click(await screen.findByRole('menuitem', { name: '空白分组' }));
    expect(
      JSON.parse(
        window.localStorage.getItem('vibex:kanban-canvas:p1') ?? '{}'
      ).nodes.some((node: { kind: string }) => node.kind === 'group')
    ).toBe(true);

    await user.click(screen.getByRole('button', { name: '后退' }));
    expect(
      JSON.parse(window.localStorage.getItem('vibex:kanban-canvas:p1') ?? '{}')
        .nodes
    ).toEqual([]);

    await user.click(screen.getByRole('button', { name: '前进' }));
    expect(
      JSON.parse(
        window.localStorage.getItem('vibex:kanban-canvas:p1') ?? '{}'
      ).nodes.some((node: { kind: string }) => node.kind === 'group')
    ).toBe(true);
  });

  it('opens a group-or-remove menu on middle-click after a selection', async () => {
    const user = userEvent.setup();
    const { container } = renderCanvas(
      <SessionCanvasView
        projectId="p1"
        sessions={[session('fresh', new Date().toISOString())]}
        listWidth={280}
        list={<div>list</div>}
      />
    );

    await user.click(screen.getByRole('button', { name: '新建' }));
    await user.click(await screen.findByRole('menuitem', { name: '空白分组' }));
    const overlay = document.createElement('div');
    overlay.className = 'react-flow__nodesselection';
    container.querySelector('.canvas-surface')!.appendChild(overlay);
    fireEvent(
      overlay,
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 1,
        clientX: 24,
        clientY: 24,
      })
    );
    fireEvent(
      overlay,
      new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 1,
        clientX: 24,
        clientY: 24,
      })
    );
    expect(screen.getByRole('menuitem', { name: '组成分组' })).toBeDisabled();
    expect(
      screen.getByRole('menuitem', { name: '移除节点' })
    ).toBeInTheDocument();
  });
});
