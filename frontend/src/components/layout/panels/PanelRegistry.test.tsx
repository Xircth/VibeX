import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { IDockviewPanelProps } from 'dockview-react';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { panelComponents } from './PanelRegistry';

vi.mock('@/components/panels/DockviewKanbanPanel', () => ({
  default: () => <div data-testid="kanban-panel" />,
}));
vi.mock('@/components/panels/DockviewFileTreePanel', () => ({
  default: () => null,
}));
vi.mock('@/components/panels/DockviewPreviewPanel', () => ({
  default: () => null,
}));
vi.mock('@/components/panels/DockviewWebPreviewPanel', () => ({
  default: () => null,
}));
vi.mock('@/components/panels/DockviewDiffsReviewPanel', () => ({
  default: () => null,
}));
vi.mock('@/components/panels/DockviewTerminalPanel', () => ({
  default: () => null,
}));
vi.mock('@/components/panels/DockviewAIChatPanel', () => ({
  default: () => null,
}));
vi.mock('@/components/panels/DockviewGitPanel', () => ({
  default: () => null,
}));
vi.mock('@/components/panels/DockviewWelcomePanel', () => ({
  default: () => null,
}));
vi.mock('@/components/panels/DockviewLogsPanel', () => ({
  default: () => null,
}));
vi.mock('@/components/panels/DockviewNotesPanel', () => ({
  default: () => null,
}));
vi.mock('@/components/panels/DockviewSearchPanel', () => ({
  default: () => null,
}));
vi.mock(
  '@/components/workspace-session-list/WorkspaceSessionListPanel',
  () => ({ default: () => null })
);

describe('panelComponents', () => {
  it('resolves workspace panels synchronously without a lazy module boundary', () => {
    const Panel = panelComponents[PANEL_IDS.KANBAN];

    render(React.createElement(Panel, {} as IDockviewPanelProps));

    expect(screen.getByTestId('kanban-panel')).toBeInTheDocument();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
  });
});
