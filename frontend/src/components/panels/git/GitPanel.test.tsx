import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GitFileStatusEntry } from 'shared/types';
import { GitChangeStats } from './GitChangeStats';
import { GitCommitBox } from './GitCommitBox';
import { GitFileRow } from './GitFileRow';
import { GitStagingArea } from './GitStagingArea';
import { GitStatusBadge } from './GitStatusBadge';

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
  it('renders single-row auto-expanding textarea and Commit / Commit&Push ButtonGroup + Push xx commits button', () => {
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
  });
});
