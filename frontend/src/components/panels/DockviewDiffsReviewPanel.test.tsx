import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Diff } from 'shared/types';
import DockviewDiffsReviewPanel from './DockviewDiffsReviewPanel';

const { diffState, clearTargetPathMock } = vi.hoisted(() => ({
  diffState: { current: [] as Diff[] },
  clearTargetPathMock: vi.fn(),
}));

vi.mock('@/contexts/WorktreeContext', () => ({
  useWorktree: () => ({ activeWorktreeId: 'workspace-1' }),
}));

vi.mock('@/hooks/useAttempt', () => ({
  useAttempt: () => ({ data: { id: 'workspace-1' } }),
}));

vi.mock('@/hooks/useDiffStream', () => ({
  useDiffStream: () => ({
    diffs: diffState.current,
    error: null,
    isInitialized: true,
  }),
}));

vi.mock('@/hooks/useDiffSummary', () => ({
  useDiffSummary: () => ({
    fileCount: diffState.current.length,
    added: diffState.current.reduce(
      (total, diff) => total + (diff.additions ?? 0),
      0
    ),
    deleted: diffState.current.reduce(
      (total, diff) => total + (diff.deletions ?? 0),
      0
    ),
  }),
}));

vi.mock('@/stores/useCommitDiffStore', () => ({
  useCommitDiffStore: () => ({
    commitSha: null,
    commitInfo: null,
    commitDiffs: [],
    isLoading: false,
    clearCommitDiff: vi.fn(),
  }),
}));

vi.mock('@/stores/useGitDiffNavigationStore', () => ({
  useGitDiffNavigationStore: (selector: (state: unknown) => unknown) =>
    selector({
      targetPath: null,
      requestToken: 0,
      clearTargetPath: clearTargetPathMock,
    }),
}));

vi.mock('@/components/DiffViewSwitch', () => ({
  default: () => <div data-testid="diff-view-switch" />,
}));

vi.mock('@/components/DiffCard', () => ({
  default: ({ diff, expanded }: { diff: Diff; expanded: boolean }) => (
    <div
      data-testid="diff-card"
      data-path={diff.newPath ?? diff.oldPath}
      data-expanded={String(expanded)}
    />
  ),
}));

vi.mock('@/components/diff/DiffFileTree', () => ({
  DiffFileTree: ({
    files,
    onFileClick,
  }: {
    files: { id: string; path: string }[];
    onFileClick: (id: string) => void;
  }) => (
    <div aria-label="Changed file tree">
      {files.map((file) => (
        <button key={file.id} onClick={() => onFileClick(file.id)}>
          {file.path}
        </button>
      ))}
    </div>
  ),
}));

function diff(path: string, additions: number, deletions = 0): Diff {
  return {
    change: 'modified',
    oldPath: path,
    newPath: path,
    oldContent: 'old',
    newContent: 'new',
    contentOmitted: false,
    additions,
    deletions,
    repoId: null,
  };
}

describe('DockviewDiffsReviewPanel large changes', () => {
  beforeEach(() => {
    clearTargetPathMock.mockReset();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
  });

  it('renders one expanded diff while keeping the complete file tree above 10,000 changed lines', async () => {
    diffState.current = [
      diff('src/large.ts', 10_001),
      diff('src/second.ts', 3),
      diff('src/third.ts', 2),
    ];

    render(<DockviewDiffsReviewPanel />);

    await waitFor(() =>
      expect(screen.getAllByTestId('diff-card')).toHaveLength(1)
    );
    expect(screen.getByTestId('diff-card')).toHaveAttribute(
      'data-path',
      'src/large.ts'
    );
    expect(screen.getByTestId('diff-card')).toHaveAttribute(
      'data-expanded',
      'true'
    );
    expect(
      screen.getByLabelText('Changed file tree').querySelectorAll('button')
    ).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'src/third.ts' }));

    await waitFor(() =>
      expect(screen.getByTestId('diff-card')).toHaveAttribute(
        'data-path',
        'src/third.ts'
      )
    );
    expect(screen.getAllByTestId('diff-card')).toHaveLength(1);
  });

  it('continues rendering every diff at or below 10,000 changed lines', () => {
    diffState.current = [diff('src/first.ts', 9_995), diff('src/second.ts', 5)];

    render(<DockviewDiffsReviewPanel />);

    expect(screen.getAllByTestId('diff-card')).toHaveLength(2);
  });
});
