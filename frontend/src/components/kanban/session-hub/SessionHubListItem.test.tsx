import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { TooltipProvider } from '@/components/ui/tooltip';
import { exportConversation } from '@/lib/exportConversation';
import { conversationApi } from '@/features/conversation/conversationApi';
import { writeClipboardViaBridge } from '@/vscode/bridge';
import { SessionHubListItem } from './SessionHubListItem';

vi.mock('@/lib/exportConversation', () => ({
  exportConversation: vi.fn(),
}));

vi.mock('@/features/conversation/conversationApi', () => ({
  conversationApi: { fork: vi.fn() },
}));

vi.mock('@/vscode/bridge', () => ({
  writeClipboardViaBridge: vi.fn(),
}));

function session(
  overrides: Partial<KanbanProjectSessionRecord> = {}
): KanbanProjectSessionRecord {
  return {
    id: 'session-1',
    fullName: 'A fairly long session name for the card',
    firstPrompt: 'Please review the authentication flow and tighten the errors',
    branch: 'feature/auth',
    workspaceName: 'Main',
    workspaceDisplayLabel: 'Main · feature/auth',
    workspace: { id: 'workspace-1' },
    updatedAt: '2026-08-08T08:00:00.000Z',
    executor: 'codex',
    agentId: null,
    isRunning: false,
    pinnedAt: null,
    ...overrides,
  } as KanbanProjectSessionRecord;
}

function renderItem(
  overrides: Partial<ComponentProps<typeof SessionHubListItem>> = {}
) {
  return render(
    <TooltipProvider>
      <SessionHubListItem
        session={session()}
        marker={null}
        isDeleteMode={false}
        isSelected={false}
        onClick={vi.fn()}
        onToggleSelect={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onPinSession={vi.fn()}
        onArchiveSession={vi.fn()}
        {...overrides}
      />
    </TooltipProvider>
  );
}

describe('SessionHubListItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not repeat status on cards already grouped by status', () => {
    const { unmount } = renderItem({
      session: session({ isRunning: true, status: 'inprogress' }),
    });
    expect(screen.queryByText('进行中')).not.toBeInTheDocument();
    unmount();

    renderItem({
      session: session({ isRunning: false, status: 'inreview' }),
    });
    expect(screen.queryByText('待检查')).not.toBeInTheDocument();
  });

  it('keeps status pills on canvas cards that are not grouped by status', () => {
    renderItem({
      displayMode: 'canvas',
      session: session({ isRunning: false, status: 'inreview' }),
    });
    expect(screen.getByText('待检查')).toBeInTheDocument();
  });

  it('shows the session name without the first-message preview', () => {
    renderItem();

    expect(
      screen.getByText('A fairly long session name for the card')
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        'Please review the authentication flow and tighten the errors'
      )
    ).not.toBeInTheDocument();
  });

  it('uses regular weight for Chinese session names and keeps Latin titles semibold', () => {
    const { unmount } = renderItem({
      session: session({ fullName: '请参考附图，对我' }),
    });
    const chineseName = screen.getByText('请参考附图，对我');
    expect(chineseName).toHaveClass('font-normal');
    expect(chineseName).not.toHaveAttribute('title');
    unmount();

    renderItem();
    const latinName = screen.getByText(
      'A fairly long session name for the card'
    );
    expect(latinName).toHaveClass('font-semibold');
    expect(latinName).not.toHaveAttribute('title');
  });

  it('keeps hover actions out of the name row and renders 3-dot, pin, and archive buttons', () => {
    renderItem();

    const name = screen.getByText('A fairly long session name for the card');
    const moreButton = screen.getByRole('button', { name: '更多操作' });
    const pinButton = screen.getByRole('button', { name: '置顶' });
    const archiveButton = screen.getByRole('button', { name: '归档' });

    expect(
      name.compareDocumentPosition(moreButton) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(moreButton.parentElement).toHaveClass(
      'session-hub-card-actions',
      'absolute',
      'right-2',
      'top-1/2',
      '-translate-y-1/2'
    );
    expect(pinButton.parentElement).toBe(moreButton.parentElement);
    expect(archiveButton.parentElement).toBe(moreButton.parentElement);
    expect(moreButton).toHaveClass('session-hub-card-action');
    expect(pinButton).toHaveClass('session-hub-card-action');
    expect(archiveButton).toHaveClass('session-hub-card-action');
  });

  it('puts time, workspace, and delete on one row in canvas mode', () => {
    renderItem({ displayMode: 'canvas' });

    const workspace = screen.getByText('Main');
    const deleteButton = screen.getByRole('button', { name: '删除会话' });
    const row = deleteButton.parentElement?.parentElement;

    expect(deleteButton.parentElement).not.toHaveClass('absolute');
    expect(row).toContainElement(workspace);
    expect(row).toHaveClass('flex');
  });

  it('reveals the 3 hover buttons, hides agent icon on hover, and triggers pin and archive', () => {
    const onPinSession = vi.fn();
    const onArchiveSession = vi.fn();
    const { container } = renderItem({ onPinSession, onArchiveSession });
    const card = container.querySelector('.session-hub-card');
    expect(card).not.toBeNull();

    expect(screen.getByAltText('Codex')).toBeInTheDocument();

    fireEvent.mouseEnter(card as HTMLElement);

    expect(screen.queryByAltText('Codex')).not.toBeInTheDocument();

    const moreButton = screen.getByRole('button', { name: '更多操作' });
    expect(moreButton.parentElement).toHaveClass('opacity-100');
    expect(moreButton.parentElement).not.toHaveClass('pointer-events-none');

    fireEvent.click(screen.getByRole('button', { name: '置顶' }));
    expect(onPinSession).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: '归档' }));
    expect(onArchiveSession).toHaveBeenCalledTimes(1);
  });

  it('opens the 3-dot menu with rename, copy submenus, export submenus, fork, and delete', () => {
    const onDeleteSession = vi.fn();
    vi.mocked(conversationApi.fork).mockResolvedValue({
      conversationId: 'forked-1',
      continuity: 'full',
      continuityNote: null,
    } as never);

    renderItem({ onDeleteSession });

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));

    expect(
      screen.getByRole('menuitem', { name: '重命名会话' })
    ).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '复制' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '导出' })).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: '从本会话Fork' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: '删除会话' })
    ).toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: '复制' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '会话信息' }));
    expect(writeClipboardViaBridge).toHaveBeenCalledWith(
      [
        '会话名称: A fairly long session name for the card',
        'ID: session-1',
        'Agent: Codex',
        '工作区: Main · feature/auth',
      ].join('\n')
    );

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: '复制' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '会话名称' }));
    expect(writeClipboardViaBridge).toHaveBeenCalledWith(
      'A fairly long session name for the card'
    );

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: '导出' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '导出为HTML' }));
    expect(exportConversation).toHaveBeenCalledWith(
      'session-1',
      'html',
      'A fairly long session name for the card'
    );

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: '导出' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '导出为Markdown' }));
    expect(exportConversation).toHaveBeenCalledWith(
      'session-1',
      'markdown',
      'A fairly long session name for the card'
    );

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '从本会话Fork' }));
    expect(conversationApi.fork).toHaveBeenCalledWith('session-1');

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除会话' }));
    expect(onDeleteSession).toHaveBeenCalledTimes(1);
  });

  it('hides the fork menu item when the session agent does not support fork', () => {
    renderItem({
      session: session({ executor: 'gemini', agentId: 'gemini' }),
    });

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));

    expect(
      screen.queryByRole('menuitem', { name: '从本会话Fork' })
    ).not.toBeInTheDocument();
  });
});
