import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { deriveMemberBotAvatar } from '@/features/collaboration/MemberBotAvatar';
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

  it('docks as a composer card and hides the tab-list scrollbar', () => {
    render(
      <ComposerAtReferenceMenu
        groups={groups}
        activeTab="file"
        selectedIndex={0}
        loading={false}
        onSelectTab={vi.fn()}
        onSelectItem={vi.fn()}
        onHighlight={vi.fn()}
      />
    );

    const menu = screen.getByTestId('composer-at-reference-menu');
    expect(menu.className).toContain('composer-status-surface');
    expect(menu.className).not.toContain('dialog-surface');
    expect(screen.getByRole('tablist')).toHaveClass(
      'composer-at-reference-tabs'
    );
  });

  it('keeps the selected option when another row is hovered', () => {
    const onHighlight = vi.fn();
    render(
      <ComposerAtReferenceMenu
        groups={[
          {
            tab: 'file',
            truncated: false,
            items: [
              {
                id: 'file:a',
                tab: 'file',
                label: 'App.tsx',
                insertText: '[@:App.tsx](src/App.tsx)',
              },
              {
                id: 'file:b',
                tab: 'file',
                label: 'Main.tsx',
                insertText: '[@:Main.tsx](src/Main.tsx)',
              },
            ],
          },
        ]}
        activeTab="file"
        selectedIndex={0}
        loading={false}
        onSelectTab={vi.fn()}
        onSelectItem={vi.fn()}
        onHighlight={onHighlight}
      />
    );

    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.mouseEnter(options[1]);
    expect(onHighlight).not.toHaveBeenCalled();
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('renders the broadcast member as bold black text with a leading @ icon', () => {
    render(
      <ComposerAtReferenceMenu
        groups={[
          {
            tab: 'member',
            truncated: false,
            items: [
              {
                id: 'member:all',
                tab: 'member',
                label: '全体成员',
                detail: '通知本群所有成员',
                insertText: '@全体成员',
                mentionAll: true,
              },
              {
                id: 'member:master',
                tab: 'member',
                label: 'Master',
                detail: 'conv-1',
                insertText: '@Master',
                memberAvatar: deriveMemberBotAvatar('Master'),
              },
            ],
          },
        ]}
        activeTab="member"
        selectedIndex={1}
        loading={false}
        onSelectTab={vi.fn()}
        onSelectItem={vi.fn()}
        onHighlight={vi.fn()}
      />
    );

    const allMembers = screen.getByRole('option', { name: /全体成员/ });
    expect(allMembers.querySelector('[data-bot-shape]')).toBeNull();
    const mentionAllIcon = allMembers.querySelector(
      '[data-composer-at-mention-all-icon]'
    );
    expect(mentionAllIcon).not.toBeNull();
    expect(mentionAllIcon).toHaveClass('h-7', 'w-7');
    expect(mentionAllIcon?.querySelector('svg')).not.toBeNull();
    const label = allMembers.querySelector(
      '[data-composer-at-reference-label]'
    );
    expect(label).toHaveClass('font-bold');
    expect(label).toHaveClass('text-foreground');
    expect(label).not.toHaveAttribute('style');
  });
});
