import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { describe, expect, it, vi } from 'vitest';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { ImportRecentSessionsDialog } from './ImportRecentSessionsDialog';

function session(
  id: string,
  updatedAt: string,
  status = 'todo'
): KanbanProjectSessionRecord {
  return {
    id,
    updatedAt,
    status,
    fullName: id,
  } as KanbanProjectSessionRecord;
}

describe('ImportRecentSessionsDialog', () => {
  it('imports sessions from the selected window and skips ones already on the board', async () => {
    const user = userEvent.setup();
    const onImport = vi.fn();
    const now = Date.now();

    render(
      <HotkeysProvider initiallyActiveScopes={['dialog', 'kanban', 'projects']}>
        <ImportRecentSessionsDialog
          open
          sessions={[
            session(
              'fresh',
              new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString()
            ),
            session(
              'already',
              new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString()
            ),
            session(
              'old',
              new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString()
            ),
          ]}
          presentSessionIds={new Set(['already'])}
          onOpenChange={vi.fn()}
          onImport={onImport}
        />
      </HotkeysProvider>
    );

    expect(screen.getByText('将导入 1 个会话')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '导入' }));
    expect(onImport).toHaveBeenCalledWith(['fresh'], '最近 7 天');
  });
});
