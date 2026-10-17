import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Diff } from 'shared/types';
import DockviewDiffsReviewPanel from './DockviewDiffsReviewPanel';

const { diffState, commitDiffState, clearTargetPathMock } = vi.hoisted(() => ({
  diffState: { current: [] as Diff[] },
  commitDiffState: {
    current: {
      commitSha: null as string | null,
      commitInfo: null as {
        sha: string;
        summary: string;
        body?: string;
        author: string;
        timestamp: number;
      } | null,
      commitDiffs: [] as Diff[],
      isLoading: false,
      clearCommitDiff: vi.fn(),
    },
  },
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
  useCommitDiffStore: () => commitDiffState.current,
}));

vi.mock('@/stores/useGitDiffNavigationStore', () => ({
  useGitDiffNavigationStore: (selector: (state: unknown) => unknown) =>
    selector({
      targetPath: null,
      requestToken: 0,
      clearTargetPath: clearTargetPathMock,
    }),
}));

vi.mock('@/components/DiffViewSwitch', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/DiffViewSwitch')>();
  return {
    ...actual,
    default: ({ visibleLabelCount }: { visibleLabelCount?: number }) => (
      <div
        data-testid="diff-view-switch"
        data-visible-labels={String(visibleLabelCount ?? 4)}
      />
    ),
  };
});

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

  it('puts the file count beside Changes and resizes from the left edge', () => {
    diffState.current = [
      diff('src/first.ts', 160, 140),
      diff('src/second.ts', 4, 2),
    ];

    render(<DockviewDiffsReviewPanel />);

    expect(screen.getByText('Changes')).toBeInTheDocument();
    expect(screen.getByText('2 Files')).toBeInTheDocument();
    expect(screen.queryByText(/个文件已更改/)).not.toBeInTheDocument();
    expect(screen.queryByText(/个文件$/)).not.toBeInTheDocument();
    expect(screen.getByTestId('diff-view-switch')).toBeInTheDocument();

    const stats = screen.getByTestId('changes-line-stats');
    expect(stats).toHaveTextContent('+164');
    expect(stats).toHaveTextContent('-142');
    expect(stats.className).toContain('hidden');

    const sidebar = screen.getByRole('separator').parentElement;
    expect(sidebar).toHaveStyle({ width: '240px' });
    fireEvent.pointerDown(screen.getByRole('separator'), { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 40 });
    expect(sidebar).toHaveStyle({ width: '300px' });
    fireEvent.pointerMove(window, { clientX: -1000 });
    expect(sidebar).toHaveStyle({ width: '480px' });
    fireEvent.pointerUp(window);
  });

  it('progressively hides DiffViewSwitch button labels from right to left as available width shrinks while keeping all icons', async () => {
    const actualModule = await vi.importActual<
      typeof import('@/components/DiffViewSwitch')
    >('@/components/DiffViewSwitch');
    const RealDiffViewSwitch = actualModule.default;
    const { computeDiffViewVisibleLabelCount } = actualModule;

    expect(computeDiffViewVisibleLabelCount(320)).toBe(4);
    expect(computeDiffViewVisibleLabelCount(280)).toBe(3);
    expect(computeDiffViewVisibleLabelCount(230)).toBe(2);
    expect(computeDiffViewVisibleLabelCount(180)).toBe(1);
    expect(computeDiffViewVisibleLabelCount(130)).toBe(0);

    const { rerender, container } = render(
      <RealDiffViewSwitch visibleLabelCount={4} />
    );
    expect(container.querySelectorAll('.diff-toolbar-btn-label')).toHaveLength(
      4
    );
    expect(container.querySelectorAll('button svg')).toHaveLength(4);

    // Narrow step 1: rightmost label (4th button) hides first
    rerender(<RealDiffViewSwitch visibleLabelCount={3} />);
    expect(container.querySelectorAll('.diff-toolbar-btn-label')).toHaveLength(
      3
    );
    expect(
      container
        .querySelectorAll('button')[3]
        ?.querySelector('.diff-toolbar-btn-label')
    ).toBeNull();
    expect(container.querySelectorAll('button svg')).toHaveLength(4);

    // Narrow step 2: 3rd button label hides next
    rerender(<RealDiffViewSwitch visibleLabelCount={2} />);
    expect(container.querySelectorAll('.diff-toolbar-btn-label')).toHaveLength(
      2
    );
    expect(
      container
        .querySelectorAll('button')[2]
        ?.querySelector('.diff-toolbar-btn-label')
    ).toBeNull();
    expect(container.querySelectorAll('button svg')).toHaveLength(4);

    // Narrow step 3: 2nd button label hides next
    rerender(<RealDiffViewSwitch visibleLabelCount={1} />);
    expect(container.querySelectorAll('.diff-toolbar-btn-label')).toHaveLength(
      1
    );
    expect(
      container
        .querySelectorAll('button')[0]
        ?.querySelector('.diff-toolbar-btn-label')
    ).not.toBeNull();
    expect(container.querySelectorAll('button svg')).toHaveLength(4);

    // Narrow step 4: all labels hidden, all 4 icons still rendered
    rerender(<RealDiffViewSwitch visibleLabelCount={0} />);
    expect(container.querySelectorAll('.diff-toolbar-btn-label')).toHaveLength(
      0
    );
    expect(container.querySelectorAll('button svg')).toHaveLength(4);
  });

  it('renders Commit Diff info card with rounded corners, bottom spacing, widened description, and left-aligned ButtonGroup with right-aligned Expand All button', () => {
    commitDiffState.current = {
      commitSha: '3ab7835d80de',
      commitInfo: {
        sha: '3ab7835d80de1234',
        summary: 'merge(workspace): reshape the right sidebar',
        body: 'Bring the session timeline, diff review, notes quoting, and the\nelement-picker removal onto master.',
        author: 'Xircth',
        timestamp: 1700000000,
      },
      commitDiffs: [diff('crates/agents/src/conversation.rs', 6, 0)],
      isLoading: false,
      clearCommitDiff: vi.fn(),
    };

    const { container } = render(<DockviewDiffsReviewPanel />);

    const infoCard = screen.getByTestId('commit-diff-info-card');
    expect(infoCard.className).toContain('rounded-xl');
    expect(infoCard.className).toContain('mb-2.5');

    const bodyEl = screen.getByTestId('commit-diff-body');
    expect(bodyEl.className).toContain('w-full');
    expect(bodyEl.className).toContain('max-w-none');
    expect(bodyEl.textContent).toBe(
      'Bring the session timeline, diff review, notes quoting, and the element-picker removal onto master.'
    );

    const toolbar = container.querySelector('.diff-review-toolbar');
    expect(toolbar?.className).toContain('justify-between');
    expect(toolbar?.className).not.toContain('justify-end');

    const expandGroup = container.querySelector('.diff-expand-button-group');
    expect(expandGroup?.className).toContain('ml-auto');
  });
});
