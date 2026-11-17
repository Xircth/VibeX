import type { ComponentType } from 'react';
import NiceModal, { type NiceModalHocProps } from '@ebay/nice-modal-react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { describe, expect, it, vi } from 'vitest';

import { CloneRepoDialog } from './CloneRepoDialog';

const pickHostDirectoryMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/hostFs', () => ({
  pickHostDirectory: pickHostDirectoryMock,
}));

const Dialog = CloneRepoDialog as unknown as ComponentType<NiceModalHocProps>;

describe('CloneRepoDialog', () => {
  it('uses the welcome project form surface', async () => {
    render(
      <HotkeysProvider initiallyActiveScopes={['dialog', 'kanban', 'projects']}>
        <NiceModal.Provider>
          <Dialog id="clone-repo-dialog-test" defaultVisible />
        </NiceModal.Provider>
      </HotkeysProvider>
    );

    const dialog = await screen.findByRole('dialog');

    expect(dialog).toHaveClass('welcome-project-form-surface');
  });

  it('surfaces an error instead of throwing when pickHostDirectory fails', async () => {
    const user = userEvent.setup();
    pickHostDirectoryMock.mockRejectedValueOnce(
      new Error('Browse unavailable')
    );

    render(
      <HotkeysProvider initiallyActiveScopes={['dialog', 'kanban', 'projects']}>
        <NiceModal.Provider>
          <Dialog id="clone-repo-dialog-err" defaultVisible />
        </NiceModal.Provider>
      </HotkeysProvider>
    );

    await user.click(
      await screen.findByRole('button', { name: /浏览|Browse/i })
    );

    expect(await screen.findByText('Browse unavailable')).toBeInTheDocument();
  });
});
