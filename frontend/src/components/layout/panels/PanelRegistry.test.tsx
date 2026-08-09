import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  IDockviewPanelHeaderProps,
  IDockviewPanelProps,
} from 'dockview-react';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { panelComponents, WorkspaceDockviewTab } from './PanelRegistry';

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

function tabProps({
  component,
  id = component,
  params = {},
  title,
}: {
  component: string;
  id?: string;
  params?: Record<string, unknown>;
  title: string;
}) {
  let notifyParametersChange:
    | ((nextParams: Record<string, unknown>) => void)
    | undefined;
  const api = {
    close: vi.fn(),
    component,
    getParameters: vi.fn(() => params),
    id,
    onDidParametersChange: vi.fn(
      (listener: (nextParams: Record<string, unknown>) => void) => {
        notifyParametersChange = listener;
        return { dispose: vi.fn() };
      }
    ),
    onDidTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
    title,
  };

  return {
    props: {
      api,
      containerApi: {},
      params,
      tabLocation: 'header',
    } as unknown as IDockviewPanelHeaderProps,
    updateParams(nextParams: Record<string, unknown>) {
      params = nextParams;
      api.getParameters.mockReturnValue(nextParams);
      notifyParametersChange?.(nextParams);
    },
  };
}

describe('WorkspaceDockviewTab', () => {
  it('renders a file-tree icon for file tabs', () => {
    const { props } = tabProps({
      component: PANEL_IDS.PREVIEW,
      id: 'file:/workspace/src/App.tsx',
      params: { filePath: '/workspace/src/App.tsx' },
      title: 'App.tsx',
    });

    render(<WorkspaceDockviewTab {...props} />);

    expect(screen.getByTestId('workspace-tab-icon')).toHaveAttribute(
      'data-tab-icon',
      'file'
    );
  });

  it('uses a browser fallback icon and reacts to favicon parameter updates', () => {
    const model = tabProps({
      component: PANEL_IDS.WEB_PREVIEW,
      params: { faviconUrl: null },
      title: 'Web Preview',
    });

    render(<WorkspaceDockviewTab {...model.props} />);

    expect(screen.getByTestId('workspace-tab-icon')).toHaveAttribute(
      'data-tab-icon',
      'browser'
    );

    act(() => {
      model.updateParams({ faviconUrl: 'https://example.test/favicon.ico' });
    });

    expect(screen.getByTestId('workspace-tab-favicon')).toHaveAttribute(
      'src',
      'https://example.test/favicon.ico'
    );

    fireEvent.error(screen.getByTestId('workspace-tab-favicon'));

    expect(screen.getByTestId('workspace-tab-icon')).toHaveAttribute(
      'data-tab-icon',
      'browser'
    );
  });

  it.each([
    [PANEL_IDS.DIFFS, 'diff'],
    [PANEL_IDS.TERMINAL, 'terminal'],
    [PANEL_IDS.NOTES, 'note'],
    [PANEL_IDS.GIT, 'git'],
  ])('renders the %s panel icon', (component, iconKind) => {
    const { props } = tabProps({ component, title: component });

    render(<WorkspaceDockviewTab {...props} />);

    expect(screen.getByTestId('workspace-tab-icon')).toHaveAttribute(
      'data-tab-icon',
      iconKind
    );
  });
});
