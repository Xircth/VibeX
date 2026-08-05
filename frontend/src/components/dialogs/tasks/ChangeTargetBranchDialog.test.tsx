import type { ComponentType } from 'react';
import NiceModal, { type NiceModalHocProps } from '@ebay/nice-modal-react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { describe, expect, it } from 'vitest';

import {
  ChangeTargetBranchDialog,
  type ChangeTargetBranchDialogProps,
} from './ChangeTargetBranchDialog';

describe('ChangeTargetBranchDialog', () => {
  it('keeps the branch choice primary and places actions beside it', async () => {
    const user = userEvent.setup();
    const Dialog = ChangeTargetBranchDialog as ComponentType<
      ChangeTargetBranchDialogProps & NiceModalHocProps
    >;

    const { container } = render(
      <HotkeysProvider initiallyActiveScopes={['dialog', 'kanban', 'projects']}>
        <NiceModal.Provider>
          <Dialog id="change-target-branch-test" defaultVisible branches={[]} />
        </NiceModal.Provider>
      </HotkeysProvider>
    );

    const title = await screen.findByText('更改目标分支');
    const selector = screen.getByLabelText('目标分支');
    const cancel = screen.getByRole('button', { name: '取消' });
    const confirm = screen.getByRole('button', { name: '更改分支' });

    expect(title).toHaveClass('sr-only');
    expect(screen.queryByText('为任务尝试选择新的目标分支。')).toBeNull();

    const field = selector.parentElement;
    const actions = cancel.parentElement;
    const layout = field?.parentElement;

    expect(layout).toBe(actions?.parentElement);
    expect(layout).toHaveClass('sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]');
    expect(actions).toContainElement(confirm);

    expect(container.querySelector('.dialog-surface')).toHaveClass(
      'sm:max-w-lg'
    );
    expect(cancel).toHaveClass('h-7');
    expect(confirm).toHaveClass('h-7');

    await user.click(selector);
    const menu = (await screen.findByText('未找到分支')).closest(
      '[role="menu"]'
    );
    expect(menu).toHaveClass(
      'branch-selector-menu',
      'w-[var(--radix-dropdown-menu-trigger-width)]'
    );
  });
});
