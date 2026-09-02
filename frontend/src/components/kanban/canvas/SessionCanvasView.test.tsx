import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { SessionCanvasView } from './SessionCanvasView';

const fitView = vi.fn();
const setCenter = vi.fn();
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
  });

  it('offers importing recent sessions on an empty board', async () => {
    const user = userEvent.setup();
    render(
      <HotkeysProvider initiallyActiveScopes={['dialog', 'kanban', 'projects']}>
        <TooltipProvider>
          <SessionCanvasView
            projectId="p1"
            sessions={[session('fresh', new Date().toISOString())]}
            listWidth={280}
            list={<div>list</div>}
          />
        </TooltipProvider>
      </HotkeysProvider>
    );

    expect(screen.getByText('画布是空的')).toBeInTheDocument();
    await user.click(screen.getByText('导入最近的会话'));
    expect(screen.getByText(/将导入/)).toBeInTheDocument();
  });

  it('shows the create form to the right of the session list', () => {
    render(
      <HotkeysProvider initiallyActiveScopes={['dialog', 'kanban', 'projects']}>
        <TooltipProvider>
          <SessionCanvasView
            projectId="p1"
            sessions={[session('fresh', new Date().toISOString())]}
            listWidth={280}
            list={<div>list</div>}
            createPanel={<div>create form</div>}
          />
        </TooltipProvider>
      </HotkeysProvider>
    );

    expect(screen.getByText('create form')).toBeInTheDocument();
    expect(screen.getByText('create form').parentElement).toHaveClass(
      'pointer-events-auto'
    );
  });

  it('creates a blank group from the dock plus button', async () => {
    const user = userEvent.setup();
    render(
      <HotkeysProvider initiallyActiveScopes={['dialog', 'kanban', 'projects']}>
        <TooltipProvider>
          <SessionCanvasView
            projectId="p1"
            sessions={[session('fresh', new Date().toISOString())]}
            listWidth={280}
            list={<div>list</div>}
          />
        </TooltipProvider>
      </HotkeysProvider>
    );

    await user.click(screen.getByRole('button', { name: '创建分组' }));
    const raw = window.localStorage.getItem('vibex:kanban-canvas:p1');
    expect(raw).toBeTruthy();
    const saved = JSON.parse(raw ?? '{}') as {
      nodes: Array<{ kind: string; name: string }>;
    };
    expect(saved.nodes.some((node) => node.kind === 'group')).toBe(true);
    expect(saved.nodes.find((node) => node.kind === 'group')?.name).toBe(
      '分组'
    );
  });
});
