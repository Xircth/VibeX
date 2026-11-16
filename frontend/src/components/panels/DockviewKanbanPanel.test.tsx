import { render, screen, waitFor } from '@testing-library/react';
import { kanbanViewRegistry } from '@dimoai/plugin-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanBoard } from './DockviewKanbanPanel';

const mocks = vi.hoisted(() => ({
  activeViewId: 'builtin:pulse',
  setActiveViewId: vi.fn(),
  kanbanArrangement: {
    left: 'list' as const,
    center: 'monitor' as const,
    right: 'session' as const,
  },
}));

vi.mock('@/contexts/KanbanSessionContext', () => ({
  useKanbanSessionContext: () => ({
    activeViewId: mocks.activeViewId,
    setActiveViewId: mocks.setActiveViewId,
  }),
}));

vi.mock('@/contexts/ProjectContext', () => ({
  useOptionalProject: () => ({ projectId: 'proj-1' }),
}));

vi.mock('@/lib/layoutArrangement', () => ({
  useKanbanArrangement: () => mocks.kanbanArrangement,
  kanbanSlotOfZone: () => 'right' as const,
}));

vi.mock('@/components/kanban/KanbanUsageDashboard', () => ({
  KanbanUsageDashboard: () => (
    <div data-testid="mock-kanban-usage-dashboard">Usage</div>
  ),
}));

vi.mock('@/components/kanban/PulseDeckView', () => ({
  PulseDeckView: ({ projectId }: { projectId?: string | null }) => (
    <div data-testid="mock-pulse-deck-view" data-project-id={projectId ?? ''}>
      Pulse
    </div>
  ),
}));

vi.mock('@/components/kanban/KanbanSessionHub', () => ({
  KanbanSessionHub: () => <div data-testid="mock-session-hub" />,
}));

vi.mock('@/components/kanban/KanbanSessionSlot', () => ({
  KanbanSessionSlot: () => <div data-testid="mock-session-slot" />,
}));

vi.mock('@/components/plugins/PluginRemoteView', () => ({
  PluginRemoteView: ({
    item,
    slot,
  }: {
    item: { pluginId: string; id: string } | null;
    slot: string;
  }) => (
    <div
      data-testid="mock-plugin-remote-view"
      data-plugin-id={item?.pluginId ?? ''}
      data-contribution-id={item?.id ?? ''}
      data-slot={slot}
    />
  ),
}));

describe('DockviewKanbanPanel / KanbanBoard', () => {
  beforeEach(() => {
    mocks.activeViewId = 'builtin:pulse';
    mocks.setActiveViewId.mockReset();
  });

  it('mounts only the active kanban page independently without chevron buttons or carousel tracks', async () => {
    const { container } = render(<KanbanBoard />);

    await waitFor(() => {
      expect(screen.getByTestId('mock-pulse-deck-view')).toBeInTheDocument();
    });

    // No chevron navigation arrows anywhere
    expect(container.querySelector('.kanban-nav-arrow')).toBeNull();
    expect(container.querySelector('[data-kanban-nav]')).toBeNull();

    // Only the active view is mounted independently (no sibling carousel pages)
    const mountedViews = container.querySelectorAll('[data-kanban-view]');
    expect(mountedViews).toHaveLength(1);
    expect(mountedViews[0]).toHaveAttribute(
      'data-kanban-view',
      'builtin:pulse'
    );
    expect(
      screen.queryByTestId('mock-kanban-usage-dashboard')
    ).not.toBeInTheDocument();
  });

  it('switches independently to usage and plugin kanban pages when activeViewId changes', async () => {
    const disposePluginView = kanbanViewRegistry.register(
      {
        pluginId: 'acme.demo',
        id: 'roadmap',
        title: 'Roadmap',
        icon: 'flag',
        hidesBottomDock: true,
      },
      'acme.demo'
    );

    try {
      mocks.activeViewId = 'builtin:usage';
      const { container, rerender } = render(<KanbanBoard />);

      await waitFor(() => {
        expect(
          screen.getByTestId('mock-kanban-usage-dashboard')
        ).toBeInTheDocument();
      });
      let mountedViews = container.querySelectorAll('[data-kanban-view]');
      expect(mountedViews).toHaveLength(1);
      expect(mountedViews[0]).toHaveAttribute(
        'data-kanban-view',
        'builtin:usage'
      );
      expect(
        screen.queryByTestId('mock-pulse-deck-view')
      ).not.toBeInTheDocument();

      mocks.activeViewId = 'plugin:acme.demo/roadmap';
      rerender(<KanbanBoard />);

      const pluginView = screen.getByTestId('mock-plugin-remote-view');
      expect(pluginView).toHaveAttribute('data-plugin-id', 'acme.demo');
      expect(pluginView).toHaveAttribute('data-contribution-id', 'roadmap');
      expect(pluginView).toHaveAttribute('data-slot', 'app.kanban.view');

      mountedViews = container.querySelectorAll('[data-kanban-view]');
      expect(mountedViews).toHaveLength(1);
      expect(mountedViews[0]).toHaveAttribute(
        'data-kanban-view',
        'plugin:acme.demo/roadmap'
      );
    } finally {
      disposePluginView();
    }
  });
});
