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
});
