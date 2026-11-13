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
import { DETAIL_CARD_HEIGHT, DETAIL_CARD_WIDTH } from './canvasModel';
import { getCanvasWorkspaceController } from './canvasWorkspaceBridge';
import { SessionCanvasView, type SessionCanvasApi } from './SessionCanvasView';

const fitView = vi.fn();
const setCenter = vi.fn();
const getViewport = vi.fn(() => ({ x: 0, y: 0, zoom: 1 }));
const screenToFlowPosition = vi.fn(() => ({ x: 40, y: 40 }));

let latestOnNodesChange: ((changes: unknown[]) => void) | undefined;

vi.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
  ReactFlow: ({
    children,
    onNodesChange,
  }: {
    children: ReactNode;
    onNodesChange?: (changes: unknown[]) => void;
  }) => {
    latestOnNodesChange = onNodesChange;
    return <div data-testid="react-flow">{children}</div>;
  },
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
    await user.click(await screen.findByRole('menuitem', { name: '新建分组' }));
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
    await user.click(await screen.findByRole('menuitem', { name: '新建分组' }));
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
    await user.click(await screen.findByRole('menuitem', { name: '新建分组' }));
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

  it('updates dashed session connection lines in real time while dragging a session node or parent group', () => {
    window.localStorage.setItem(
      'vibex:kanban-canvas:p1',
      JSON.stringify({
        version: 4,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [
          {
            id: 'group-1',
            kind: 'group',
            sessionId: '',
            parentId: null,
            name: '分组',
            createdAt: 1,
            showAll: false,
            x: 10,
            y: 20,
            width: 608,
            height: 156,
            expanded: false,
          },
          {
            id: 'card-1',
            kind: 'session',
            sessionId: 'alpha',
            parentId: 'group-1',
            name: '',
            createdAt: 2,
            showAll: false,
            x: 12,
            y: 44,
            width: 286,
            height: 44,
            expanded: false,
          },
          {
            id: 'win-1',
            kind: 'session',
            sessionId: 'alpha',
            parentId: null,
            openedFromId: 'card-1',
            name: '',
            createdAt: 3,
            showAll: false,
            x: 700,
            y: 100,
            width: 760,
            height: 620,
            expanded: true,
          },
        ],
      })
    );

    const { container } = renderCanvas(
      <SessionCanvasView
        projectId="p1"
        sessions={[session('alpha', new Date().toISOString())]}
        listWidth={280}
        list={<div>list</div>}
      />
    );

    const getLineCoords = () => {
      const line = container.querySelector('line.canvas-session-link');
      expect(line).not.toBeNull();
      return {
        x1: Number(line?.getAttribute('x1')),
        y1: Number(line?.getAttribute('y1')),
        x2: Number(line?.getAttribute('x2')),
        y2: Number(line?.getAttribute('y2')),
      };
    };

    const initial = getLineCoords();
    expect(initial.x2).toBe(700 + 760 / 2);

    act(() => {
      latestOnNodesChange?.([
        {
          id: 'session-win-1',
          type: 'position',
          dragging: true,
          position: { x: 920, y: 260 },
        },
      ]);
    });

    expect(getLineCoords()).toEqual({
      x1: initial.x1,
      y1: initial.y1,
      x2: initial.x2 + (920 - 700),
      y2: initial.y2 + (260 - 100),
    });

    act(() => {
      latestOnNodesChange?.([
        {
          id: 'session-group-1',
          type: 'position',
          dragging: true,
          position: { x: 110, y: 140 },
        },
      ]);
    });

    expect(getLineCoords()).toEqual({
      x1: initial.x1 + (110 - 10),
      y1: initial.y1 + (140 - 20),
      x2: initial.x2 + (920 - 700),
      y2: initial.y2 + (260 - 100),
    });
  });

  it('creates panel nodes from the dock + menu, links child nodes to parent nodes, and disconnects links via the centered X button', async () => {
    const user = userEvent.setup();
    let api: SessionCanvasApi | undefined;
    const { container } = renderCanvas(
      <SessionCanvasView
        projectId="p1"
        sessions={[session('alpha', new Date().toISOString())]}
        listWidth={280}
        list={<div>list</div>}
        onApiReady={(ready) => {
          api = ready;
        }}
      />
    );

    await user.click(screen.getByRole('button', { name: '新建' }));
    await user.click(await screen.findByRole('menuitem', { name: '笔记' }));

    const storedAfterNote = JSON.parse(
      window.localStorage.getItem('vibex:kanban-canvas:p1') ?? '{}'
    );
    expect(storedAfterNote.nodes).toHaveLength(1);
    expect(storedAfterNote.nodes[0]).toMatchObject({
      panelId: 'notes',
      panelComponent: 'notes',
      panelTitle: '笔记',
      expanded: true,
    });

    const parentId = storedAfterNote.nodes[0].id as string;
    let childId = '';
    act(() => {
      childId =
        api?.openOrFocusPanel({
          id: 'diffs',
          component: 'diffs',
          title: '审阅',
          expanded: true,
          parentNodeId: parentId,
        }) ?? '';
    });

    expect(childId).toBeTruthy();
    const lines = container.querySelectorAll('line.canvas-session-link');
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const disconnectBtn = screen.getAllByRole('button', {
      name: '断开连接',
    })[0];
    expect(disconnectBtn).toBeInTheDocument();

    fireEvent.click(disconnectBtn);

    await waitFor(() => {
      const afterDisconnect = JSON.parse(
        window.localStorage.getItem('vibex:kanban-canvas:p1') ?? '{}'
      );
      expect(afterDisconnect.links ?? []).toHaveLength(0);
    });
  });

  it('opens a detached full panel node linked to a grouped minimized panel node when expanded', () => {
    window.localStorage.setItem(
      'vibex:kanban-canvas:p1',
      JSON.stringify({
        version: 4,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [
          {
            id: 'group-1',
            kind: 'group',
            sessionId: '',
            parentId: null,
            name: '分组',
            createdAt: 1,
            showAll: false,
            x: 10,
            y: 20,
            width: 440,
            height: 140,
            expanded: false,
          },
          {
            id: 'term-card-1',
            kind: 'session',
            sessionId: '',
            parentId: 'group-1',
            name: 'Terminal',
            panelId: 'terminal-1',
            panelComponent: 'terminal',
            panelTitle: 'pwsh',
            createdAt: 2,
            showAll: false,
            x: 12,
            y: 44,
            width: 196,
            height: 72,
            expanded: false,
          },
        ],
      })
    );

    const { container } = renderCanvas(
      <SessionCanvasView
        projectId="p1"
        sessions={[]}
        listWidth={280}
        list={<div>list</div>}
      />
    );

    act(() => {
      latestOnNodesChange?.([
        {
          id: 'session-term-card-1',
          type: 'select',
          selected: true,
        },
      ]);
    });

    const expandButton = screen.getByRole('button', { name: '展开会话' });
    fireEvent.click(expandButton);

    const stored = JSON.parse(
      window.localStorage.getItem('vibex:kanban-canvas:p1') ?? '{}'
    );
    const detached = stored.nodes.find(
      (node: { id: string; openedFromId?: string }) =>
        node.openedFromId === 'term-card-1'
    );
    expect(detached).toBeDefined();
    expect(detached).toMatchObject({
      panelComponent: 'terminal',
      panelTitle: 'pwsh',
      expanded: true,
      parentId: null,
    });
    expect(container.querySelector('line.canvas-session-link')).not.toBeNull();
  });

  it('registers dropSessionAt for minimized session cards and dropPanelAt for expanded 4:3 panel nodes', () => {
    screenToFlowPosition.mockReturnValue({ x: 300, y: 240 });
    renderCanvas(
      <SessionCanvasView
        projectId="p1"
        sessions={[session('sess-drop-1', new Date().toISOString())]}
        listWidth={280}
        list={<div>list</div>}
      />
    );

    const controller = getCanvasWorkspaceController();
    expect(controller).not.toBeNull();

    act(() => {
      controller?.dropSessionAt('sess-drop-1', { x: 400, y: 300 }, 240);
      controller?.dropPanelAt(
        {
          id: 'file:/repo/App.tsx',
          component: 'preview',
          title: 'App.tsx',
          params: { filePath: '/repo/App.tsx' },
          expanded: true,
        },
        { x: 640, y: 420 }
      );
    });

    const stored = JSON.parse(
      window.localStorage.getItem('vibex:kanban-canvas:p1') ?? '{}'
    );
    const droppedSession = stored.nodes.find(
      (node: { sessionId?: string }) => node.sessionId === 'sess-drop-1'
    );
    expect(droppedSession).toMatchObject({
      sessionId: 'sess-drop-1',
      expanded: false,
      width: 240,
    });

    const droppedPanel = stored.nodes.find(
      (node: { panelId?: string }) => node.panelId === 'file:/repo/App.tsx'
    );
    expect(droppedPanel).toMatchObject({
      panelId: 'file:/repo/App.tsx',
      panelComponent: 'preview',
      panelTitle: 'App.tsx',
      expanded: true,
      width: DETAIL_CARD_WIDTH,
      height: DETAIL_CARD_HEIGHT,
    });
  });
});

