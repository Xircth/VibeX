import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionHubListItem } from './SessionHubListItem';

vi.mock('@/lib/exportConversation', () => ({
  exportConversation: vi.fn(),
}));

vi.mock('@/features/conversation/conversationApi', () => ({
  conversationApi: { fork: vi.fn() },
}));

function session(): KanbanProjectSessionRecord {
  return {
    id: 'session-1',
    fullName: 'A fairly long session name for the card',
    firstPrompt: 'Please review the authentication flow and tighten the errors',
    branch: 'feature/auth',
    workspaceName: 'Main',
    updatedAt: '2026-08-08T08:00:00.000Z',
    executor: 'codex',
    isRunning: false,
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
        {...overrides}
      />
    </TooltipProvider>
  );
}

describe('SessionHubListItem', () => {
  it('keeps hover actions out of the name row so the title can use the card width', () => {
    renderItem();

    const name = screen.getByText('A fairly long session name for the card');
    const deleteButton = screen.getByRole('button', { name: '删除会话' });
    const renameButton = screen.getByRole('button', { name: '重命名会话' });

    expect(
      name.compareDocumentPosition(deleteButton) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(deleteButton.parentElement).toHaveClass(
      'absolute',
      'bottom-1.5',
      'right-1.5'
    );
    expect(renameButton.parentElement).toBe(deleteButton.parentElement);
    expect(deleteButton.parentElement).toHaveClass(
      'pointer-events-none',
      'opacity-0'
    );
  });

  it('reveals the corner actions on hover without reserving layout space', () => {
    const { container } = renderItem();
    const card = container.querySelector('.session-hub-card');
    expect(card).not.toBeNull();

    fireEvent.mouseEnter(card as HTMLElement);

    expect(
      screen.getByRole('button', { name: '删除会话' }).parentElement
    ).toHaveClass('opacity-100');
    expect(
      screen.getByRole('button', { name: '删除会话' }).parentElement
    ).not.toHaveClass('pointer-events-none');
  });
});
