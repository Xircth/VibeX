import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GitFileStatusEntry, GitLogEntry } from 'shared/types';
import { GitChangeStats } from './GitChangeStats';
import { GitCommitBox } from './GitCommitBox';
import { GitFileRow } from './GitFileRow';
import { GitLogView } from './GitLogView';
import { GitStagingArea } from './GitStagingArea';
import { GitStatusBadge } from './GitStatusBadge';

vi.mock('react-virtuoso', () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => React.ReactNode;
  }) => (
    <div data-testid="virtuoso-mock">
      {data.map((item, idx) => (
        <div key={idx}>{itemContent(idx, item)}</div>
      ))}
    </div>
  ),
}));

describe('GitStatusBadge & GitChangeStats', () => {
  it('renders GitStatusBadge as a bold letter without background or border', () => {
    render(<GitStatusBadge status="M" />);
    const badge = screen.getByText('M');
    expect(badge.className).toContain('font-bold');
    expect(badge.className).not.toContain('bg-');
    expect(badge.className).not.toContain('border');
  });

  it('renders GitChangeStats as a rounded pill component', () => {
    render(<GitChangeStats additions={14} deletions={3} />);
    expect(screen.getByText('+14')).toBeTruthy();
    expect(screen.getByText('-3')).toBeTruthy();
  });
});

describe('GitCommitBox', () => {
  it('renders single-row auto-expanding textarea without collapsible header and wraps Push button row', () => {
    const onCommit = vi.fn();
    const onCommitAndPush = vi.fn();
    const onPush = vi.fn();

    render(
      <GitCommitBox
        commitMessage="feat: update UI"
        onCommitMessageChange={vi.fn()}
        hasStagedFiles={true}
        hasUnstagedFiles={false}
        commitLoading={false}
        pushLoading={false}
        commitError={null}
        operationError={null}
        commitsAhead={2}
        onCommit={onCommit}
        onCommitAndPush={onCommitAndPush}
        onPush={onPush}
      />
    );

    const textarea = screen.getByPlaceholderText('Commit message...');
    expect(textarea.getAttribute('rows')).toBe('1');
    const inputFrame = textarea.closest('[data-control-frame]');
    expect(inputFrame?.className).toContain('astryx-text-input');
    expect(inputFrame?.className).toContain('rounded-lg');

    const actionsRow = screen.getByTestId('git-commit-actions-row');
    expect(actionsRow.className).toContain('flex-wrap');

    const group = screen.getByRole('group', { name: 'Commit actions' });
    const commitBtn = within(group).getByRole('button', { name: 'Commit' });
    const commitPushBtn = within(group).getByRole('button', {
      name: 'Commit&Push',
    });
    const pushBtn = screen.getByRole('button', { name: /Push 2 commits/i });

    expect(commitBtn).toBeTruthy();
    expect(commitPushBtn).toBeTruthy();
    expect(pushBtn).toBeTruthy();

    fireEvent.click(commitBtn);
    expect(onCommit).toHaveBeenCalledTimes(1);

    fireEvent.click(commitPushBtn);
    expect(onCommitAndPush).toHaveBeenCalledTimes(1);

    fireEvent.click(pushBtn);
    expect(onPush).toHaveBeenCalledTimes(1);
  });

  it('always renders Push 0 commits button in disabled state when commitsAhead is 0', () => {
    render(
      <GitCommitBox
        commitMessage=""
        onCommitMessageChange={vi.fn()}
        hasStagedFiles={false}
        hasUnstagedFiles={false}
        commitLoading={false}
        pushLoading={false}
        commitError={null}
        operationError={null}
        commitsAhead={0}
        onCommit={vi.fn()}
        onCommitAndPush={vi.fn()}
        onPush={vi.fn()}
      />
    );

    const pushBtn = screen.getByRole('button', { name: /Push 0 commits/i });
    expect(pushBtn.hasAttribute('disabled')).toBe(true);
  });
});

describe('GitFileRow & GitStagingArea', () => {
  const sampleFile: GitFileStatusEntry = {
    path: 'src/components/App.tsx',
    status: 'M',
    additions: 8,
    deletions: 2,
  };

  it('renders bold file name, status letter to the left of stats, no hover path title attribute, and Review/Stage/Discard in a ButtonGroup', () => {
    const onSelect = vi.fn();
    const onReviewFile = vi.fn();
    const onStageFile = vi.fn();
    const onRevertFile = vi.fn();

    const { container } = render(
      <GitFileRow
        file={sampleFile}
        section="unstaged"
        isActive={false}
        onSelect={onSelect}
        onReviewFile={onReviewFile}
        onStageFile={onStageFile}
        onUnstageFile={vi.fn()}
        onRevertFile={onRevertFile}
      />
    );

    const fileRow = container.querySelector('[data-section="unstaged"]');
    expect(fileRow?.getAttribute('title')).toBeNull();

    const fileName = screen.getByText('App.tsx');
    expect(fileName.className).toContain('font-bold');
    expect(screen.getByText('src/components/App.tsx')).toBeTruthy();
    expect(screen.getByText('M')).toBeTruthy();
    expect(screen.getByText('+8')).toBeTruthy();
    expect(screen.getByText('-2')).toBeTruthy();

    const reviewBtn = screen.getByRole('button', { name: 'Review' });
    const stageBtn = screen.getByRole('button', { name: 'Stage' });
    const discardBtn = screen.getByRole('button', { name: 'Discard Changes' });

    fireEvent.click(reviewBtn);
    expect(onReviewFile).toHaveBeenCalledWith(sampleFile.path);

    fireEvent.click(stageBtn);
    expect(onStageFile).toHaveBeenCalledWith(sampleFile.path);

    fireEvent.click(discardBtn);
    expect(onRevertFile).toHaveBeenCalledWith(sampleFile.path);
  });

  it('renders STAGED and CHANGES section headers with rounded background', () => {
    const stagedFile: GitFileStatusEntry = {
      ...sampleFile,
      path: 'src/staged.ts',
      status: 'A',
    };

    render(
      <GitStagingArea
        stagedFiles={[stagedFile]}
        unstagedFiles={[sampleFile]}
        selectedPath={null}
        viewMode="flat"
        onSelectFile={vi.fn()}
        onStageFile={vi.fn()}
        onUnstageFile={vi.fn()}
        onRevertFile={vi.fn()}
        onStageAll={vi.fn()}
        onRevertAll={vi.fn()}
      />
    );

    const stagedHeader = screen.getByTestId('git-section-header-staged');
    const changesHeader = screen.getByTestId('git-section-header-changes');
    expect(stagedHeader.className).toContain('rounded-md');
    expect(stagedHeader.className).toContain('bg-muted/60');
    expect(changesHeader.className).toContain('rounded-md');
    expect(changesHeader.className).toContain('bg-muted/60');

    // Clicking STAGED header collapses and expands its child file items
    expect(screen.getByText('staged.ts')).toBeTruthy();
    fireEvent.click(stagedHeader);
    expect(screen.queryByText('staged.ts')).toBeNull();
    fireEvent.click(stagedHeader);
    expect(screen.getByText('staged.ts')).toBeTruthy();

    // Clicking CHANGES header collapses and expands its child file items
    expect(screen.getByText('App.tsx')).toBeTruthy();
    fireEvent.click(changesHeader);
    expect(screen.queryByText('App.tsx')).toBeNull();
    fireEvent.click(changesHeader);
    expect(screen.getByText('App.tsx')).toBeTruthy();
  });
});

describe('GitLogView', () => {
  it('renders a permanent TextInput search bar with left magnifying glass button and does not render branch header', () => {
    const entries: GitLogEntry[] = [
      {
        sha: 'abc1234567890',
        summary: 'feat: initial commit',
        author: 'Alice',
        timestamp: 1700000000,
        refs: ['HEAD -> main'],
      },
    ];

    render(
      <GitLogView
        entries={entries}
        total={1}
        ahead={1}
        behind={0}
        upstream="origin/main"
        branchName="feature/hidden-branch-header"
        loading={false}
        workspaceId={null}
        repoId="repo-1"
      />
    );

    const searchInput = screen.getByPlaceholderText('Search commits...');
    expect(searchInput.closest('.astryx-text-input')).toBeTruthy();
    expect(
      searchInput.closest('.git-log-search-input.astryx-text-input')
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Search commits' })).toBeTruthy();
    expect(screen.queryByText('feature/hidden-branch-header')).toBeNull();

    // Clicking TO PUSH section header collapses and expands its commit entries
    const toPushHeader = screen.getByTestId('git-log-section-header-to-push');
    expect(screen.getByText('feat: initial commit')).toBeTruthy();
    fireEvent.click(toPushHeader);
    expect(screen.queryByText('feat: initial commit')).toBeNull();
    fireEvent.click(toPushHeader);
    expect(screen.getByText('feat: initial commit')).toBeTruthy();
  });

  it('renders Issue and PR empty states with in-panel GitHub CLI setup modal trigger instead of crashing when gh is missing', async () => {
    const { GitIssuesView } = await import('./GitIssuesView');
    const { GitPRsView } = await import('./GitPRsView');

    const { unmount } = render(
      <GitIssuesView
        issues={[]}
        isLoading={false}
        error="GitHub CLI (`gh`) executable not found or not runnable"
        issueState="open"
        onSetIssueState={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByText('暂无可用 Issue')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /安装 \/ 登录 GitHub CLI/ })
    ).toBeTruthy();
    unmount();

    render(
      <GitPRsView
        prs={[]}
        isLoading={false}
        error="GitHub CLI authentication failed: try running gh auth login"
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByText('暂无可用 Pull Request')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /安装 \/ 登录 GitHub CLI/ })
    ).toBeTruthy();
  });
});

describe('GitBranchList', () => {
  const sampleBranches = [
    {
      name: 'main',
      is_current: true,
      is_remote: false,
      is_worktree: false,
      worktree_path: null,
      last_commit_date: new Date(),
    },
    {
      name: 'feature/login',
      is_current: false,
      is_remote: false,
      is_worktree: false,
      worktree_path: null,
      last_commit_date: new Date(),
    },
    {
      name: 'origin/main',
      is_current: false,
      is_remote: true,
      is_worktree: false,
      worktree_path: null,
      last_commit_date: new Date(),
    },
  ];

  it('removes top Branches header, styles LOCAL & REMOTE like STAGED with right-aligned counts and create button, and styles groups/branches with rounded bg, bold names, no group icons, and no branch click checkout', async () => {
    const { GitBranchList } = await import('./GitBranchList');
    const onCheckout = vi.fn();
    const onCreate = vi.fn();
    const onDelete = vi.fn();

    const { rerender } = render(
      <GitBranchList
        branches={sampleBranches}
        remotes={[{ name: 'origin', url: 'https://github.com/org/repo.git' }]}
        isLoading={false}
        error={null}
        onCheckout={onCheckout}
        onCreate={onCreate}
        onDelete={onDelete}
        onRefresh={vi.fn()}
      />
    );

    // 1. Top "Branches" header and "remote" badge are removed
    expect(screen.queryByText('Branches')).toBeNull();
    expect(screen.queryByText(/1 remote/i)).toBeNull();

    // 2. LOCAL and REMOTE headers match STAGED rounded background, right counts, create button on LOCAL, and provider icon on REMOTE
    const localHeader = screen.getByTestId('git-branch-section-header-local');
    const remoteHeader = screen.getByTestId('git-branch-section-header-remote');
    expect(localHeader.className).toContain('rounded-md');
    expect(localHeader.className).toContain('bg-muted/60');
    expect(remoteHeader.className).toContain('rounded-md');
    expect(remoteHeader.className).toContain('bg-muted/60');

    expect(within(localHeader).getByTitle('Create new branch')).toBeTruthy();
    expect(screen.getByTestId('git-branch-local-count').textContent).toBe('2');
    expect(screen.getByTestId('git-branch-remote-count').textContent).toBe('1');
    expect(
      within(remoteHeader).getByTestId('remote-provider-icon-github')
    ).toBeTruthy();

    // Verify Gitee icon and fallback default git icon on REMOTE
    rerender(
      <GitBranchList
        branches={sampleBranches}
        remotes={[{ name: 'origin', url: 'https://gitee.com/org/repo.git' }]}
        isLoading={false}
        error={null}
        onCheckout={onCheckout}
        onCreate={onCreate}
        onDelete={onDelete}
        onRefresh={vi.fn()}
      />
    );
    expect(
      within(
        screen.getByTestId('git-branch-section-header-remote')
      ).getByTestId('remote-provider-icon-gitee')
    ).toBeTruthy();

    rerender(
      <GitBranchList
        branches={sampleBranches}
        remotes={[
          { name: 'origin', url: 'https://git.internal.corp/org/repo.git' },
        ]}
        isLoading={false}
        error={null}
        onCheckout={onCheckout}
        onCreate={onCreate}
        onDelete={onDelete}
        onRefresh={vi.fn()}
      />
    );
    expect(
      within(
        screen.getByTestId('git-branch-section-header-remote')
      ).getByTestId('remote-provider-icon-default')
    ).toBeTruthy();

    // 3. Branch groups have rounded-md background, no scope icon, and 3-level hierarchy indentation
    const localBody = screen.getByTestId('git-branch-section-body-local');
    expect(localBody.className).toContain('ml-2.5');
    expect(localBody.className).toContain('border-l');

    const featureGroup = within(localBody).getByTestId(
      'git-branch-group-feature'
    );
    expect(featureGroup.className).toContain('rounded-md');
    expect(featureGroup.querySelectorAll('svg').length).toBe(1);

    // Expand the feature group to inspect the branch row inside
    fireEvent.click(featureGroup);

    const featureGroupItems = within(localBody).getByTestId(
      'git-branch-group-items-feature'
    );
    expect(featureGroupItems.className).toContain('ml-2.5');
    expect(featureGroupItems.className).toContain('border-l');

    // Branch rows have rounded-md background, bold branch name, and clicking does not trigger checkout
    const featureRow = within(featureGroupItems).getByTestId(
      'git-branch-row-feature/login'
    );
    expect(featureRow.className).toContain('rounded-md');
    expect(featureRow.className).not.toContain('cursor-pointer');
    const loginLabel = within(featureRow).getByText('login');
    expect(loginLabel.className).toContain('font-bold');

    fireEvent.click(featureRow);
    expect(onCheckout).not.toHaveBeenCalled();

    // Clicking LOCAL header collapses all local branches/groups, clicking again expands them
    fireEvent.click(screen.getByTestId('git-branch-section-header-local'));
    expect(screen.queryByTestId('git-branch-group-feature')).toBeNull();
    fireEvent.click(screen.getByTestId('git-branch-section-header-local'));
    expect(screen.getByTestId('git-branch-group-feature')).toBeTruthy();

    // Clicking REMOTE header collapses all remote branches, clicking again expands them
    expect(screen.getByTestId('git-branch-row-origin/main')).toBeTruthy();
    fireEvent.click(screen.getByTestId('git-branch-section-header-remote'));
    expect(screen.queryByTestId('git-branch-row-origin/main')).toBeNull();
    fireEvent.click(screen.getByTestId('git-branch-section-header-remote'));
    expect(screen.getByTestId('git-branch-row-origin/main')).toBeTruthy();
  });

  it('defines gap between Selector listbox options and margin-block between Selector trigger and popover menu', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const css = fs.readFileSync(
      path.resolve(__dirname, '../../../styles/legacy/index.css'),
      'utf8'
    );

    expect(css).toMatch(
      /\.legacy-design \[popover\]:has\(\[role='listbox'\]\)\s*\{[^}]*margin-block:\s*4px !important;/
    );
    expect(css).toMatch(
      /\.legacy-design \[popover\]:has\(\[role='listbox'\]\) \[role='listbox'\][\s\S]*?\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*gap:\s*6px;/
    );
  });
});
