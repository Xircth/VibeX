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

  it('surfaces Session Details at top level for session tabs and under New for all tabs', () => {
    const openSessionDetails = vi.fn();
    const openProcesses = vi.fn();
    const items = buildWorkspaceTabContextMenu(
      {
        ...labels,
        sessionDetails: '会话详情',
        processes: '进程',
      },
      {
        refresh: vi.fn(),
        isSessionTab: true,
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
      'refresh',
      'session-details',
      'close',
      'split',
      'new',
      'sort',
    ]);
    const topSessionDetails = items.find(
      (item) => item.id === 'session-details'
    );
    if (topSessionDetails && 'onSelect' in topSessionDetails) {
      topSessionDetails.onSelect?.();
    }
    expect(openSessionDetails).toHaveBeenCalledTimes(1);

    const created = items.find((item) => item.id === 'new');
    if (created?.type !== 'submenu') {
      throw new Error('expected new submenu');
    }
    expect(created.children.map((item) => item.id)).toContain(
      'new-session-details'
    );
    expect(created.children.map((item) => item.id)).toContain('new-processes');
  });
});
