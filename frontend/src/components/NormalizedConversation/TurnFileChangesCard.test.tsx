import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TurnFileChangesCard } from './TurnFileChangesCard';

vi.mock('@/contexts/PanelActionsContext', () => ({
  usePanelActionsContext: () => ({ openDiffPreview: vi.fn() }),
}));

describe('TurnFileChangesCard', () => {
  it('starts collapsed by default and can be expanded', () => {
    render(
      <TurnFileChangesCard
        expansionKey="turn-files:default-collapsed"
        summary={
          {
            files: [
              {
                path: 'src/main.ts',
                old_path: null,
                change_kind: 'modified',
                additions: 3,
                deletions: 1,
              },
            ],
          } as never
        }
      />
    );

    expect(screen.queryByText('src/main.ts')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /1 个文件已更改/ }));

    expect(screen.getByText('src/main.ts')).toBeInTheDocument();
  });
});
