import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ComposerAtReferenceMenu } from './ComposerAtReferenceMenu';
import type { AtReferenceGroup } from './composerAtReferences';

const groups: AtReferenceGroup[] = [
  {
    tab: 'file',
    items: [
      {
        id: 'file:a',
        tab: 'file',
        label: 'App.tsx',
        detail: 'src/App.tsx',
        insertText: '[@:App.tsx](src/App.tsx)',
      },
    ],
    truncated: false,
  },
  {
    tab: 'conversation',
    items: [],
    truncated: false,
  },
  {
    tab: 'commit',
    items: [],
    truncated: false,
  },
  {
    tab: 'instruction',
    items: [
      {
        id: 'instruction:review',
        tab: 'instruction',
        label: '#review-changes',
        insertText: '[#:review-changes](#review)',
      },
    ],
    truncated: false,
  },
];

describe('ComposerAtReferenceMenu', () => {
  it('shows tab counts and switches the visible list', async () => {
    const user = userEvent.setup();
    const onSelectTab = vi.fn();
    render(
      <ComposerAtReferenceMenu
        groups={groups}
        activeTab="file"
        selectedIndex={0}
        loading={false}
        onSelectTab={onSelectTab}
        onSelectItem={vi.fn()}
        onHighlight={vi.fn()}
      />
    );

    expect(screen.getByRole('tab', { name: /文件/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('option', { name: /App.tsx/ })).toBeVisible();

    await user.click(screen.getByRole('tab', { name: /指令/ }));
    expect(onSelectTab).toHaveBeenCalledWith('instruction');
  });
});
