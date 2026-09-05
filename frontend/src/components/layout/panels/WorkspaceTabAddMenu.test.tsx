import { act, fireEvent, render, screen } from '@testing-library/react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceOverlayContext } from '@/contexts/WorkspaceOverlayContext';
import { WorkspaceTabAddMenu } from './WorkspaceTabAddMenu';

const { openDiffPreview, openNotes, openWebPreview, openTerminalEditorTab } =
  vi.hoisted(() => ({
    openDiffPreview: vi.fn(),
    openNotes: vi.fn(),
    openWebPreview: vi.fn(),
    openTerminalEditorTab: vi.fn(),
  }));

vi.mock('@/contexts/PanelActionsContext', () => ({
  usePanelActionsContext: () => ({
    openDiffPreview,
    openNotes,
    openWebPreview,
    openTerminalEditorTab,
  }),
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
  });

  it('offers browser, review, note, and terminal from the editor tab strip', () => {
    const props = headerProps();
    const setTabCreationMenuOpen = vi.fn();

    render(
      <WorkspaceOverlayContext.Provider
        value={{
          setTabCreationMenuOpen,
          setHtmlOverlayOpen: vi.fn(),
          subscribeNativeSurfaceOcclusion: () => () => {},
        }}
      >
        <WorkspaceTabAddMenu {...props} />
      </WorkspaceOverlayContext.Provider>
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });

    expect(screen.getAllByRole('menuitem')).toHaveLength(4);
    expect(screen.getByRole('menuitem', { name: '浏览器' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '审阅' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '笔记' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '终端' })).toBeVisible();

    fireEvent.click(screen.getByRole('menuitem', { name: '浏览器' }));

    expect(props.api.setActive).toHaveBeenCalledOnce();
    expect(openWebPreview).toHaveBeenCalledWith();
    expect(openDiffPreview).not.toHaveBeenCalled();
    expect(openNotes).not.toHaveBeenCalled();
    expect(openTerminalEditorTab).not.toHaveBeenCalled();
  });

  it('renders the menu before starting native-surface occlusion work', () => {
    const props = headerProps();
    const animationFrames: FrameRequestCallback[] = [];
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      });
    const setTabCreationMenuOpen = vi.fn();

    render(
      <WorkspaceOverlayContext.Provider
        value={{
          setTabCreationMenuOpen,
          setHtmlOverlayOpen: vi.fn(),
          subscribeNativeSurfaceOcclusion: () => () => {},
        }}
      >
        <WorkspaceTabAddMenu {...props} />
      </WorkspaceOverlayContext.Provider>
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });

    expect(screen.getByRole('menuitem', { name: '浏览器' })).toBeVisible();
    expect(setTabCreationMenuOpen).not.toHaveBeenCalled();

    act(() => {
      const currentFrame = animationFrames.splice(0);
      currentFrame.forEach((callback) => callback(16));
    });

    expect(setTabCreationMenuOpen).toHaveBeenCalledWith(true);
    requestAnimationFrameSpy.mockRestore();
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
