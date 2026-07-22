import { render, screen } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview-react';
import { describe, expect, it, vi } from 'vitest';
import DockviewWebPreviewPanel from './DockviewWebPreviewPanel';

const { browserPanelMock, useKanbanSessionContextMock, useWorktreeMock } =
  vi.hoisted(() => ({
    browserPanelMock: vi.fn(
      (props: {
        initialUrl: string | null;
        requestNonce: number;
        workspaceId?: string;
        visible: boolean;
      }) => (
        <div
          data-testid="browser-panel"
          data-url={props.initialUrl}
          data-request-nonce={props.requestNonce}
          data-workspace-id={props.workspaceId}
          data-visible={props.visible}
        />
      )
    ),
    useKanbanSessionContextMock: vi.fn(() => ({
      visibleRightSession: { workspaceId: 'workspace-session' },
    })),
    useWorktreeMock: vi.fn(() => ({ activeWorktreeId: 'workspace-tree' })),
  }));

vi.mock('@/features/browser/BrowserPanel', () => ({
  BrowserPanel: browserPanelMock,
}));

vi.mock('@/contexts/WorktreeContext', () => ({
  useWorktree: useWorktreeMock,
}));

vi.mock('@/contexts/ClickedElementsProvider', () => ({
  useClickedElements: vi.fn(() => ({ addElement: vi.fn() })),
}));

vi.mock('@/contexts/KanbanSessionContext', () => ({
  useKanbanSessionContext: useKanbanSessionContextMock,
}));

vi.mock('@/hooks/useTaskAttempt', () => ({
  useTaskAttemptWithSession: vi.fn(() => ({ data: undefined })),
}));

vi.mock('@/contexts/ExecutionProcessesContext', () => ({
  ExecutionProcessesProvider: ({ children }: { children: React.ReactNode }) =>
    children,
  useExecutionProcessesContext: vi.fn(() => ({
    executionProcessesVisible: [],
  })),
}));

vi.mock('@/hooks/useLogStream', () => ({
  useLogStream: vi.fn(() => ({ logs: [], error: null })),
}));

vi.mock('@/hooks/useDevserverUrl', () => ({
  useDevserverUrlFromLogs: vi.fn(() => null),
}));

vi.mock('@/hooks/usePreviewSettings', () => ({
  usePreviewSettings: vi.fn(() => ({ overrideUrl: null })),
}));

function panelProps(): IDockviewPanelProps {
  const disposable = { dispose: vi.fn() };
  return {
    params: {
      requestedUrl: 'https://example.test',
      requestedUrlNonce: 7,
    },
    api: {
      isActive: true,
      isVisible: true,
      onDidVisibilityChange: vi.fn(() => disposable),
      onDidDimensionsChange: vi.fn(() => disposable),
      onDidActiveChange: vi.fn(() => disposable),
      setTitle: vi.fn(),
    },
  } as unknown as IDockviewPanelProps;
}

describe('DockviewWebPreviewPanel', () => {
  it('mounts the CEF browser for the active workspace and requested URL', () => {
    render(<DockviewWebPreviewPanel {...panelProps()} />);

    expect(screen.getByTestId('browser-panel')).toHaveAttribute(
      'data-url',
      'https://example.test'
    );
    expect(screen.getByTestId('browser-panel')).toHaveAttribute(
      'data-request-nonce',
      '7'
    );
    expect(screen.getByTestId('browser-panel')).toHaveAttribute(
      'data-workspace-id',
      'workspace-session'
    );
    expect(screen.getByTestId('browser-panel')).toHaveAttribute(
      'data-visible',
      'true'
    );
  });
});
