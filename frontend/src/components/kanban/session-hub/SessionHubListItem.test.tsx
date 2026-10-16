import type { ComponentProps } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
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

  it('puts time, workspace, and archive on one row in canvas mode', () => {
    const onArchiveSession = vi.fn();
    const onDeleteSession = vi.fn();
    renderItem({ displayMode: 'canvas', onArchiveSession, onDeleteSession });

    const workspace = screen.getByText('Main');
    const archiveButton = screen.getByRole('button', { name: '归档' });
    const row = archiveButton.parentElement?.parentElement;
    const agentIcon = screen.getByAltText('Codex');
    const title = screen.getByText('A fairly long session name for the card');

    expect(
      screen.queryByRole('button', { name: '删除会话' })
    ).not.toBeInTheDocument();
    expect(archiveButton.parentElement).not.toHaveClass('absolute');
    expect(row).toContainElement(workspace);
    expect(row).toHaveClass('flex');
    expect(agentIcon.closest('.session-hub-card-agent')).not.toHaveClass(
      'absolute'
    );
    expect(title.parentElement).toContainElement(agentIcon);

    fireEvent.click(archiveButton);
    expect(onArchiveSession).toHaveBeenCalledTimes(1);
    expect(onDeleteSession).not.toHaveBeenCalled();
  });

  it('reveals the 3 hover buttons, hides agent icon on hover, and triggers pin and archive', () => {
    const onPinSession = vi.fn();
    const onArchiveSession = vi.fn();
    const { container } = renderItem({ onPinSession, onArchiveSession });
    const card = container.querySelector('.session-hub-card');
    expect(card).not.toBeNull();

    const agentIcon = screen.getByAltText('Codex');
    expect(agentIcon.closest('.session-hub-card-agent')).toHaveClass(
      'absolute',
      'right-3',
      'top-1/2',
      '-translate-y-1/2'
    );
    expect(
      screen.getByText('A fairly long session name for the card').parentElement
    ).not.toContainElement(agentIcon);

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

  it('keeps rename open when the menu click lands on the card', async () => {
    const onRenameSession = vi.fn();
    const onClick = vi.fn();
    renderItem({ onRenameSession, onClick });

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: '重命名会话' }));

    const input = await screen.findByRole('textbox');
    fireEvent.click(input.closest('.session-hub-card') as HTMLElement);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onRenameSession).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toBe(input);

    fireEvent.change(input, { target: { value: '新会话名' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(onRenameSession).toHaveBeenCalledWith('新会话名');
  });

  it('leaves rename open when the new name fails to save', async () => {
    const onRenameSession = vi.fn().mockRejectedValue(new Error('nope'));
    renderItem({ onRenameSession });

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: '重命名会话' }));
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: '新会话名' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(onRenameSession).toHaveBeenCalledWith('新会话名')
    );
    expect(screen.getByRole('textbox')).toHaveValue('新会话名');
  });

  it('cancels rename on Escape without saving', async () => {
    const onRenameSession = vi.fn();
    renderItem({ onRenameSession });

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: '重命名会话' }));
    const input = await screen.findByRole('textbox');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onRenameSession).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
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
