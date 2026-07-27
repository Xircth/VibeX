import { act, render, screen } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview-react';
import { describe, expect, it, vi } from 'vitest';
import { RightPanelSlotContext } from '@/contexts/RightPanelSlotContext';
import DockviewWebPreviewPanel from './DockviewWebPreviewPanel';

const {
  browserPanelMock,
  useKanbanSessionContextMock,
  usePreviewSettingsMock,
  useWorktreeMock,
} = vi.hoisted(() => ({
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
  usePreviewSettingsMock: vi.fn(() => ({
    overrideUrl: 'https://www.baidu.com',
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
  usePreviewSettings: usePreviewSettingsMock,
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

  it('opens a fresh blank browser when no URL was explicitly requested', () => {
    const props = panelProps();
    props.params = {};

    render(<DockviewWebPreviewPanel {...props} />);

    expect(browserPanelMock.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ initialUrl: null })
    );
  });

  it('keeps the browser surface visible when the panel loses focus', () => {
    const props = panelProps();
    let notifyActiveChange: (() => void) | undefined;
    vi.mocked(props.api.onDidActiveChange).mockImplementation((listener) => {
      notifyActiveChange = () =>
        listener({ isActive: false } as Parameters<typeof listener>[0]);
      return { dispose: vi.fn() };
    });
    render(<DockviewWebPreviewPanel {...props} />);

    Object.defineProperty(props.api, 'isActive', {
      configurable: true,
      value: false,
    });
    act(() => notifyActiveChange?.());

    expect(screen.getByTestId('browser-panel')).toHaveAttribute(
      'data-visible',
      'true'
    );
  });

  it('uses the Dockview visibility event as the source of truth', () => {
    const props = panelProps();
    let notifyVisibilityChange:
      | ((event: { isVisible: boolean }) => void)
      | undefined;
    vi.mocked(props.api.onDidVisibilityChange).mockImplementation(
      (listener) => {
        notifyVisibilityChange = listener;
        return { dispose: vi.fn() };
      }
    );
    render(<DockviewWebPreviewPanel {...props} />);

    act(() => notifyVisibilityChange?.({ isVisible: false }));

    expect(screen.getByTestId('browser-panel')).toHaveAttribute(
      'data-visible',
      'false'
    );
  });

  it('hides the native browser surface when Kanban covers the workspace', () => {
    render(
      <RightPanelSlotContext.Provider
        value={{ host: null, placement: 'kanban' }}
      >
        <DockviewWebPreviewPanel {...panelProps()} />
      </RightPanelSlotContext.Provider>
    );

    expect(screen.getByTestId('browser-panel')).toHaveAttribute(
      'data-visible',
      'false'
    );
  });
});
