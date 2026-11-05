import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { deriveMemberBotAvatar } from '@/features/collaboration/MemberBotAvatar';
import {
  ComposerAtReferenceMenu,
  ComposerAtReferencePanel,
} from './ComposerAtReferenceMenu';
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
    expect(options[0]).toHaveAttribute('data-active', 'true');
    expect(options[0]).toHaveClass('bg-accent', 'text-accent-foreground');
    expect(options[1]).not.toHaveClass('bg-accent');
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
                isLead: true,
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

    const master = screen.getByRole('option', { name: /Master/ });
    expect(
      master.querySelector('[data-testid="collaboration-bot-avatar-lead-star"]')
    ).toBeTruthy();
  });

  it('portals onto the composer body anchor so an expanded drawer stays underneath', () => {
    const stack = document.createElement('div');
    stack.dataset.testid = 'session-composer-stack';
    const drawer = document.createElement('div');
    drawer.dataset.testid = 'session-composer-attachment-drawer';
    const anchor = document.createElement('div');
    anchor.dataset.testid = 'session-composer-anchor';
    const body = document.createElement('div');
    body.dataset.testid = 'session-composer-body';
    const dropZone = document.createElement('div');
    dropZone.dataset.testid = 'session-composer-file-drop-zone';
    body.append(dropZone);
    anchor.append(body);
    stack.append(drawer, anchor);
    document.body.append(stack);

    render(
      <ComposerAtReferencePanel
        groups={groups}
        activeTab="file"
        selectedIndex={0}
        loading={false}
        anchor={dropZone}
        onSelectTab={vi.fn()}
        onSelectItem={vi.fn()}
      />
    );

    const menu = screen.getByTestId('composer-at-reference-menu');
    expect(anchor).toContainElement(menu);
    expect(body).not.toContainElement(menu);
    expect(drawer.contains(menu)).toBe(false);
    stack.remove();
  });
});
