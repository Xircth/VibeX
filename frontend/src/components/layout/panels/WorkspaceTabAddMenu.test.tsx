import { fireEvent, render, screen } from '@testing-library/react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceOverlayContext } from '@/contexts/WorkspaceOverlayContext';
import { getTerminalShellOptions } from '@/lib/terminalPreferences';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { WorkspaceTabAddMenu } from './WorkspaceTabAddMenu';

const {
  openDiffPreview,
  openNotes,
  openOrFocusPanel,
  openTerminalEditorTab,
  openPluginPanel,
  runInEditorGroup,
  usePluginHostContributions,
  useSelectableAgents,
  requestCreateAgentSessionInExecutionArea,
} = vi.hoisted(() => ({
  openDiffPreview: vi.fn(),
  openNotes: vi.fn(),
  openOrFocusPanel: vi.fn(),
  openTerminalEditorTab: vi.fn(),
  openPluginPanel: vi.fn(),
  runInEditorGroup: vi.fn((_groupId: string, action: () => void) => action()),
  usePluginHostContributions: vi.fn((): unknown[] => []),
  useSelectableAgents: vi.fn((): unknown[] => []),
  requestCreateAgentSessionInExecutionArea: vi.fn(),
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  usePanelActionsContext: () => ({
    openDiffPreview,
    openNotes,
    openOrFocusPanel,
    openTerminalEditorTab,
    openPluginPanel,
    runInEditorGroup,
  }),
}));

vi.mock('@/hooks/usePluginHostContributions', () => ({
  usePluginHostContributions,
  contributionMetadata: (item: { metadata?: Record<string, unknown> }) =>
    item.metadata ?? {},
}));

vi.mock('@/features/agents/useSelectableAgents', () => ({
  useSelectableAgents,
}));

vi.mock('@/lib/requestCreateSession', () => ({
  requestCreateAgentSessionInExecutionArea,
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
    useSelectableAgents.mockReturnValue([
      {
        agentId: 'CODEX',
        displayName: 'Codex',
        enabled: true,
        lifecycle: 'ready',
      },
      {
        agentId: 'CLAUDE_CODE',
        displayName: 'Claude Code',
        enabled: true,
        lifecycle: 'ready',
      },
      {
        agentId: 'DISABLED_AGENT',
        displayName: 'Disabled Agent',
        enabled: false,
        lifecycle: 'ready',
      },
    ]);
  });

  it('offers categorized features, info, enabled agents, and terminal from the tab strip', () => {
    const props = headerProps();
    const setTabCreationMenuOpen = vi.fn();

    render(
      <WorkspaceOverlayContext.Provider
        value={{
          setTabCreationMenuOpen,
          setHtmlOverlayOpen: vi.fn(),
          setHtmlOverlayRect: vi.fn(),
          setChromeOccluded: vi.fn(),
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

    expect(screen.getByText('功能')).toBeVisible();
    expect(screen.getByText('信息')).toBeVisible();
    expect(screen.getByText('Agent')).toBeVisible();
    expect(screen.getByText('其他')).toBeVisible();

    expect(screen.getByRole('menuitem', { name: '文件树' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Git 面板' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '会话列表' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '笔记' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '审阅' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '执行进程' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '会话详情' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Codex' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Claude Code' })).toBeVisible();
    expect(
      screen.queryByRole('menuitem', { name: 'Disabled Agent' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '终端' })).toBeVisible();

    const menu = screen.getByRole('menu');
    expect(menu).toHaveClass('product-context-menu', 'bg-white');
    expect(menu).not.toHaveClass('tahoe-popover');
    expect(screen.getByRole('menuitem', { name: '审阅' })).toHaveClass(
      'hover:bg-accent'
    );

    fireEvent.click(screen.getByRole('menuitem', { name: '审阅' }));

    expect(props.api.setActive).toHaveBeenCalledOnce();
    expect(openDiffPreview).toHaveBeenCalledOnce();
    expect(openNotes).not.toHaveBeenCalled();
    expect(openTerminalEditorTab).not.toHaveBeenCalled();
  });

  it('opens feature and info panels in the current group', () => {
    const props = headerProps();
    render(<WorkspaceTabAddMenu {...props} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: '文件树' }));

    expect(runInEditorGroup).toHaveBeenCalledWith(
      'group-editor-1',
      expect.any(Function)
    );
    expect(openOrFocusPanel).toHaveBeenCalledWith(
      PANEL_IDS.FILE_TREE,
      '文件树'
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: '执行进程' }));
    expect(openOrFocusPanel).toHaveBeenCalledWith(
      PANEL_IDS.PROCESSES,
      '执行进程'
    );
  });

  it('creates a new agent session immediately when an enabled agent is selected', () => {
    const props = headerProps();
    render(<WorkspaceTabAddMenu {...props} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Codex' }));

    expect(requestCreateAgentSessionInExecutionArea).toHaveBeenCalledWith(
      'CODEX',
      'group-editor-1'
    );
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
          setChromeOccluded: vi.fn(),
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

  it('opens the chosen shell from the terminal submenu in this group', () => {
    const props = headerProps();
    const shell = getTerminalShellOptions()[1] ?? getTerminalShellOptions()[0];
    if (!shell) throw new Error('expected a terminal shell option');

    render(<WorkspaceTabAddMenu {...props} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: '新建标签页' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: '终端' }));
    expect(openTerminalEditorTab).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('menuitem', { name: shell.label }));

    expect(props.api.setActive).toHaveBeenCalledOnce();
    expect(runInEditorGroup).toHaveBeenCalledWith(
      'group-editor-1',
      expect.any(Function)
    );
    expect(openTerminalEditorTab).toHaveBeenCalledWith(shell.value);
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

  it('renders the tab add button on B and C tab groups, but not on Zone A or bottom groups', () => {
    const leftProps = headerProps();
    Object.assign(leftProps.group, {
      id: 'group-left',
      panels: [{ id: 'file-tree' }],
    });

    const { unmount: unmountLeft } = render(
      <WorkspaceTabAddMenu {...leftProps} />
    );
    expect(
      screen.queryByRole('button', { name: '新建标签页' })
    ).not.toBeInTheDocument();
    unmountLeft();

    const rightProps = headerProps();
    Object.assign(rightProps.group, {
      id: 'group-right',
      panels: [{ id: 'ai-chat' }],
    });
    const { unmount: unmountRight } = render(
      <WorkspaceTabAddMenu {...rightProps} />
    );
    expect(
      screen.getByRole('button', { name: '新建标签页' })
    ).toBeInTheDocument();
    unmountRight();

    const bottomProps = headerProps();
    Object.assign(bottomProps.group, {
      id: 'group-bottom',
      panels: [{ id: 'terminal' }],
    });
    render(<WorkspaceTabAddMenu {...bottomProps} />);
    expect(
      screen.queryByRole('button', { name: '新建标签页' })
    ).not.toBeInTheDocument();
  });
});
