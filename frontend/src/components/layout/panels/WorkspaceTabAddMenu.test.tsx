import { fireEvent, render, screen } from '@testing-library/react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceOverlayContext } from '@/contexts/WorkspaceOverlayContext';
import { WorkspaceTabAddMenu } from './WorkspaceTabAddMenu';

const {
  openDiffPreview,
  openNotes,
  openTerminalEditorTab,
  openPluginPanel,
  usePluginHostContributions,
} = vi.hoisted(() => ({
  openDiffPreview: vi.fn(),
  openNotes: vi.fn(),
  openTerminalEditorTab: vi.fn(),
  openPluginPanel: vi.fn(),
  usePluginHostContributions: vi.fn((): unknown[] => []),
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  usePanelActionsContext: () => ({
    openDiffPreview,
    openNotes,
    openTerminalEditorTab,
    openPluginPanel,
  }),
}));

vi.mock('@/hooks/usePluginHostContributions', () => ({
  usePluginHostContributions,
  contributionMetadata: (item: { metadata?: Record<string, unknown> }) =>
    item.metadata ?? {},
}));

function headerProps(): IDockviewHeaderActionsProps {
  return {
    api: { setActive: vi.fn() },
    group: {
      id: 'group-editor-1',
      panels: [{ id: 'welcome' }],
    },
    panels: [],
    activePanel: undefined,
    isGroupActive: true,
    headerPosition: 'top',
    containerApi: {},
  } as unknown as IDockviewHeaderActionsProps;
}

describe('WorkspaceTabAddMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePluginHostContributions.mockReturnValue([]);
  });

  it('offers review, note, and terminal from the editor tab strip', () => {
    const props = headerProps();
    const setTabCreationMenuOpen = vi.fn();

    render(
      <WorkspaceOverlayContext.Provider
        value={{
          setTabCreationMenuOpen,
          setHtmlOverlayOpen: vi.fn(),
          setHtmlOverlayRect: vi.fn(),
          subscribeNativeSurfaceOcclusion: () => () => {},
          registerNativeSurfaceHost: () => () => {},
          ackOverlayReady: () => {},
          waitForOverlayReady: () => Promise.resolve(),
          isOverlayReady: () => true,
        }}
      >
        <WorkspaceTabAddMenu {...props} />
      </WorkspaceOverlayContext.Provider>
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });

    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    expect(screen.queryByRole('menuitem', { name: '浏览器' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '审阅' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '笔记' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '终端' })).toBeVisible();

    fireEvent.click(screen.getByRole('menuitem', { name: '审阅' }));

    expect(props.api.setActive).toHaveBeenCalledOnce();
    expect(openDiffPreview).toHaveBeenCalledOnce();
    expect(openNotes).not.toHaveBeenCalled();
    expect(openTerminalEditorTab).not.toHaveBeenCalled();
  });

  it('occludes the native surface while the tab creation menu is open', () => {
    const props = headerProps();
    const setTabCreationMenuOpen = vi.fn();

    render(
      <WorkspaceOverlayContext.Provider
        value={{
          setTabCreationMenuOpen,
          setHtmlOverlayOpen: vi.fn(),
          setHtmlOverlayRect: vi.fn(),
          subscribeNativeSurfaceOcclusion: () => () => {},
          registerNativeSurfaceHost: () => () => {},
          ackOverlayReady: () => {},
          waitForOverlayReady: () => Promise.resolve(),
          isOverlayReady: () => true,
        }}
      >
        <WorkspaceTabAddMenu {...props} />
      </WorkspaceOverlayContext.Provider>
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });

    expect(screen.getByRole('menuitem', { name: '审阅' })).toBeVisible();
    expect(setTabCreationMenuOpen).toHaveBeenCalledWith(true);
  });

  it('opens the terminal from the tab creation menu', () => {
    const props = headerProps();

    render(<WorkspaceTabAddMenu {...props} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: '终端' }));

    expect(props.api.setActive).toHaveBeenCalledOnce();
    expect(openTerminalEditorTab).toHaveBeenCalledOnce();
  });

  it('does not make the workspace inert while the tab menu is open', () => {
    const props = headerProps();
    const { container } = render(
      <div>
        <main aria-label="Workspace content" />
        <WorkspaceTabAddMenu {...props} />
      </div>
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });

    expect(container).not.toHaveAttribute('aria-hidden', 'true');
  });

  it('opens a plugin panel from the tab creation menu', () => {
    usePluginHostContributions.mockReturnValue([
      {
        pluginId: 'vibex.host-surface',
        id: 'sample-panel',
        label: '示例面板',
        kind: 'app_panel',
        generation: 1,
        metadata: { icon: 'bookmark' },
      },
    ]);
    const props = headerProps();

    render(<WorkspaceTabAddMenu {...props} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: '示例面板' }));

    expect(openPluginPanel).toHaveBeenCalledWith({
      title: '示例面板',
      pluginId: 'vibex.host-surface',
      contributionId: 'sample-panel',
      icon: 'bookmark',
      multiInstance: false,
      instance: 'focus',
    });
  });

  it('does not add the control to non-editor groups', () => {
    const props = headerProps();
    Object.assign(props.group, {
      id: 'group-left',
      panels: [{ id: 'file-tree' }],
    });

    render(<WorkspaceTabAddMenu {...props} />);

    expect(
      screen.queryByRole('button', { name: '新建标签页' })
    ).not.toBeInTheDocument();
  });
});
