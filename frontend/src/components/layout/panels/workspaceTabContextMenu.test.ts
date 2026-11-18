import { describe, expect, it, vi } from 'vitest';
import { buildWorkspaceTabContextMenu } from './workspaceTabContextMenu';

const labels = {
  refresh: '刷新',
  close: '关闭',
  closeCurrent: '关闭当前页',
  closeOthers: '关闭其他页',
  split: '拆分',
  splitDown: '向下拆分',
  splitLeft: '向左拆分',
  splitRight: '向右拆分',
  new: '新建',
  note: '笔记',
  review: '审阅',
  terminal: '终端',
  browser: '浏览器',
  sort: '排序',
  sortByName: '按名称排序',
};

function menu(openBrowser?: () => void, refresh = vi.fn()) {
  return buildWorkspaceTabContextMenu(labels, {
    refresh,
    closeCurrent: vi.fn(),
    closeOthers: vi.fn(),
    canSplit: true,
    splitDown: vi.fn(),
    splitLeft: vi.fn(),
    splitRight: vi.fn(),
    openNote: vi.fn(),
    openReview: vi.fn(),
    openTerminal: vi.fn(),
    shells: [
      { value: 'powershell.exe', label: 'PowerShell' },
      { value: 'cmd.exe', label: 'CMD' },
    ],
    openBrowser,
    sortByName: vi.fn(),
  });
}

describe('buildWorkspaceTabContextMenu', () => {
  it('exposes refresh, close, split, new, and sort as the top-level rows', () => {
    const refresh = vi.fn();
    const items = menu(undefined, refresh);
    expect(items.map((item) => ('label' in item ? item.label : ''))).toEqual([
      '刷新',
      '关闭',
      '拆分',
      '新建',
      '排序',
    ]);
    const refreshItem = items[0];
    if (refreshItem && 'onSelect' in refreshItem && refreshItem.onSelect) {
      refreshItem.onSelect();
    }
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('nests shell choices under terminal and omits browser when it is disabled', () => {
    const items = menu();
    const created = items.find((item) => item.id === 'new');
    expect(created?.type).toBe('submenu');
    if (created?.type !== 'submenu') return;
    expect(created.children.map((item) => item.id)).toEqual([
      'new-note',
      'new-review',
      'new-terminal',
    ]);
    const terminal = created.children.find(
      (item) => item.id === 'new-terminal'
    );
    expect(terminal?.type).toBe('submenu');
    if (terminal?.type !== 'submenu') return;
    expect(terminal.onSelect).toEqual(expect.any(Function));
    expect(
      terminal.children.map((item) => ('label' in item ? item.label : ''))
    ).toEqual(['PowerShell', 'CMD']);
  });

  it('includes browser only when a host browser can be opened', () => {
    const items = menu(() => undefined);
    const created = items.find((item) => item.id === 'new');
    if (created?.type !== 'submenu') {
      throw new Error('expected new submenu');
    }
    expect(created.children.map((item) => item.id)).toContain('new-browser');
  });

  it('builds grouped Basic and New sections for session tabs without refresh or sort', () => {
    const openSessionDetails = vi.fn();
    const openProcesses = vi.fn();
    const openSession = vi.fn();
    const items = buildWorkspaceTabContextMenu(
      {
        ...labels,
        basicGroup: '基础',
        newGroup: '新建',
        session: '会话',
        sessionDetails: '会话详情',
        processes: '执行进程',
      },
      {
        tabKind: 'session',
        openSession,
        agents: [
          { id: 'CLAUDE_CODE', label: 'Claude Code' },
          { id: 'CODEX', label: 'Codex' },
        ],
        openSessionDetails,
        openProcesses,
        closeCurrent: vi.fn(),
        closeOthers: vi.fn(),
        canSplit: true,
        splitDown: vi.fn(),
        splitLeft: vi.fn(),
        splitRight: vi.fn(),
        openNote: vi.fn(),
        openReview: vi.fn(),
        openTerminal: vi.fn(),
        shells: [{ value: 'powershell.exe', label: 'PowerShell' }],
        sortByName: vi.fn(),
      }
    );

    expect(items.map((item) => item.id)).toEqual([
      'group-basic',
      'close',
      'split',
      'sep-new',
      'group-new',
      'new-session',
      'new-processes',
      'new-session-details',
      'new-terminal',
      'new-note',
      'new-review',
    ]);

    const canvasItems = buildWorkspaceTabContextMenu(
      {
        ...labels,
        basicGroup: '基础',
        newGroup: '新建',
        session: '会话',
        sessionDetails: '会话详情',
        processes: '执行进程',
      },
      {
        tabKind: 'session',
        includeLayoutActions: false,
        openSession,
        agents: [
          { id: 'CLAUDE_CODE', label: 'Claude Code' },
          { id: 'CODEX', label: 'Codex' },
        ],
        openSessionDetails,
        openProcesses,
        closeCurrent: vi.fn(),
        closeOthers: vi.fn(),
        canSplit: true,
        splitDown: vi.fn(),
        splitLeft: vi.fn(),
        splitRight: vi.fn(),
        openNote: vi.fn(),
        openReview: vi.fn(),
        openTerminal: vi.fn(),
        shells: [{ value: 'powershell.exe', label: 'PowerShell' }],
        sortByName: vi.fn(),
      }
    );
    expect(canvasItems.map((item) => item.id)).toEqual([
      'group-new',
      'new-session',
      'new-processes',
      'new-session-details',
      'new-terminal',
      'new-note',
      'new-review',
    ]);
    expect(
      canvasItems.some((item) => item.id === 'close' || item.id === 'split')
    ).toBe(false);
    const newSessionItem = items.find((item) => item.id === 'new-session');
    expect(newSessionItem?.type).toBe('submenu');
    if (newSessionItem?.type === 'submenu') {
      expect(newSessionItem.children.map((c) => c.id)).toEqual([
        'agent-CLAUDE_CODE',
        'agent-CODEX',
      ]);
      const firstChild = newSessionItem.children[0];
      if (firstChild && 'onSelect' in firstChild) {
        firstChild.onSelect?.();
      }
      expect(openSession).toHaveBeenCalledWith('CLAUDE_CODE');
    }
  });

  it('builds terminal tab menu with refresh and duplicate-terminal in Basic and omits processes/session-details/review in New', () => {
    const refresh = vi.fn();
    const duplicateTerminal = vi.fn();
    const items = buildWorkspaceTabContextMenu(
      {
        ...labels,
        basicGroup: '基础',
        newGroup: '新建',
        duplicateTerminal: '复制Terminal',
        session: '会话',
      },
      {
        tabKind: 'terminal',
        refresh,
        duplicateTerminal,
        openSession: vi.fn(),
        agents: [{ id: 'CLAUDE_CODE', label: 'Claude Code' }],
        closeCurrent: vi.fn(),
        closeOthers: vi.fn(),
        canSplit: true,
        splitDown: vi.fn(),
        splitLeft: vi.fn(),
        splitRight: vi.fn(),
        openNote: vi.fn(),
        openReview: vi.fn(),
        openTerminal: vi.fn(),
        shells: [{ value: 'powershell.exe', label: 'PowerShell' }],
        sortByName: vi.fn(),
      }
    );

    expect(items.map((item) => item.id)).toEqual([
      'group-basic',
      'refresh',
      'close',
      'split',
      'duplicate-terminal',
      'sep-new',
      'group-new',
      'new-session',
      'new-terminal',
      'new-note',
    ]);
    const dupItem = items.find((item) => item.id === 'duplicate-terminal');
    if (dupItem && 'onSelect' in dupItem) {
      dupItem.onSelect?.();
    }
    expect(duplicateTerminal).toHaveBeenCalledTimes(1);
  });

  it('builds space tab menu with space-details in Basic and new-assistant / new-group-chat in New while omitting processes and session-details', () => {
    const openSpaceDetails = vi.fn();
    const openNewAssistant = vi.fn();
    const openNewGroupChat = vi.fn();
    const items = buildWorkspaceTabContextMenu(
      {
        ...labels,
        basicGroup: '基础',
        newGroup: '新建',
        spaceDetails: '详情信息',
        newAssistant: '新助手',
        newGroupChat: '新群聊',
        session: '会话',
      },
      {
        tabKind: 'space',
        openSpaceDetails,
        openNewAssistant,
        openNewGroupChat,
        openSession: vi.fn(),
        agents: [{ id: 'CLAUDE_CODE', label: 'Claude Code' }],
        closeCurrent: vi.fn(),
        closeOthers: vi.fn(),
        canSplit: true,
        splitDown: vi.fn(),
        splitLeft: vi.fn(),
        splitRight: vi.fn(),
        openNote: vi.fn(),
        openReview: vi.fn(),
        openTerminal: vi.fn(),
        shells: [{ value: 'powershell.exe', label: 'PowerShell' }],
        sortByName: vi.fn(),
      }
    );

    expect(items.map((item) => item.id)).toEqual([
      'group-basic',
      'space-details',
      'close',
      'split',
      'sep-new',
      'group-new',
      'new-assistant',
      'new-group-chat',
      'new-session',
      'new-terminal',
      'new-note',
      'new-review',
    ]);
    const detailsItem = items.find((item) => item.id === 'space-details');
    if (detailsItem && 'onSelect' in detailsItem) {
      detailsItem.onSelect?.();
    }
    expect(openSpaceDetails).toHaveBeenCalledTimes(1);
  });

  it('includes the session creation submenu under New on default tabs (such as Welcome) when openSession is provided', () => {
    const openSession = vi.fn();
    const items = buildWorkspaceTabContextMenu(
      {
        ...labels,
        session: '会话',
      },
      {
        openSession,
        agents: [{ id: 'CODEX', label: 'Codex' }],
        closeCurrent: vi.fn(),
        closeOthers: vi.fn(),
        canSplit: true,
        splitDown: vi.fn(),
        splitLeft: vi.fn(),
        splitRight: vi.fn(),
        openNote: vi.fn(),
        openReview: vi.fn(),
        openTerminal: vi.fn(),
        shells: [{ value: 'powershell.exe', label: 'PowerShell' }],
        sortByName: vi.fn(),
      }
    );

    const created = items.find((item) => item.id === 'new');
    expect(created?.type).toBe('submenu');
    if (created?.type !== 'submenu') return;
    expect(created.children.map((item) => item.id)).toEqual([
      'new-session',
      'new-note',
      'new-review',
      'new-terminal',
    ]);
  });
});

describe('useWorkspaceEditorTabMenu', () => {
  it('defers translation lookup until open() and deduplicates agentManagementApi.bar() across tabs while guarding Close Others on dirty preview tabs', async () => {
    const { renderHook } = await import('@testing-library/react');
    const i18nModule = await import('@/i18n');
    const contextMenuModule = await import('@/components/context-menu');
    const { agentManagementApi } = await import('@/features/agent-management');
    const { resetPreviewPanelDirtyForTests, setPreviewPanelDirty } =
      await import('@/components/panels/previewPanelDirty');
    const { EDITOR_GROUP_PREFIX, PANEL_IDS } = await import(
      '@/stores/useLayoutStore'
    );
    const { resetWorkspaceTabMenuCacheForTests, useWorkspaceEditorTabMenu } =
      await import('./workspaceTabContextMenu');

    resetPreviewPanelDirtyForTests();
    resetWorkspaceTabMenuCacheForTests();

    const openSurfaceMenuSpy = vi.fn();
    vi.spyOn(contextMenuModule, 'useAppContextMenu').mockReturnValue({
      openSurfaceMenu: openSurfaceMenuSpy,
    } as unknown as ReturnType<typeof contextMenuModule.useAppContextMenu>);

    const barSpy = vi.spyOn(agentManagementApi, 'bar').mockResolvedValue([]);
    const getFixedTSpy = vi.spyOn(i18nModule.default, 'getFixedT');

    const closeOtherDirty = vi.fn();
    const closeOtherClean = vi.fn();
    const group = {
      id: `${EDITOR_GROUP_PREFIX}1`,
      panels: [
        {
          id: 'file:/workspace/current.ts',
          api: { close: vi.fn(), component: PANEL_IDS.PREVIEW },
        },
        {
          id: 'file:/workspace/dirty.ts',
          api: { close: closeOtherDirty, component: PANEL_IDS.PREVIEW },
        },
        {
          id: 'file:/workspace/clean.ts',
          api: { close: closeOtherClean, component: PANEL_IDS.PREVIEW },
        },
      ],
    };

    const hookA = renderHook(() =>
      useWorkspaceEditorTabMenu(
        {
          id: 'file:/workspace/current.ts',
          component: PANEL_IDS.PREVIEW,
          group,
        },
        vi.fn()
      )
    );
    const hookB = renderHook(() =>
      useWorkspaceEditorTabMenu(
        {
          id: 'file:/workspace/dirty.ts',
          component: PANEL_IDS.PREVIEW,
          group,
        },
        vi.fn()
      )
    );

    expect(hookA.result.current).not.toBeNull();
    expect(hookB.result.current).not.toBeNull();
    // Zero translation calls during tab renders, and only 1 shared bar() IPC call across multiple tabs
    expect(getFixedTSpy).not.toHaveBeenCalled();
    expect(barSpy).toHaveBeenCalledTimes(1);

    setPreviewPanelDirty('file:/workspace/dirty.ts', true, 'src/dirty.ts');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    const mouseEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 20,
    });
    hookA.result.current?.open(mouseEvent);
    expect(getFixedTSpy).toHaveBeenCalledTimes(1);
    expect(openSurfaceMenuSpy).toHaveBeenCalledTimes(1);

    const builtItems = openSurfaceMenuSpy.mock.calls[0]?.[1] ?? [];
    const closeSubmenu = builtItems.find(
      (item: { id: string }) => item.id === 'close'
    );
    expect(closeSubmenu?.type).toBe('submenu');
    const closeOthersItem = closeSubmenu?.children?.find(
      (item: { id: string }) => item.id === 'close-others'
    );
    expect(closeOthersItem).toBeDefined();
    closeOthersItem?.onSelect?.();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(closeOtherDirty).not.toHaveBeenCalled();
    expect(closeOtherClean).toHaveBeenCalledTimes(1);

    resetPreviewPanelDirtyForTests();
    resetWorkspaceTabMenuCacheForTests();
    vi.restoreAllMocks();
  });
});
