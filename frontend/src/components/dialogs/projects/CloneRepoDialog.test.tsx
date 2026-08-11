import type { ComponentType } from 'react';
import NiceModal, { type NiceModalHocProps } from '@ebay/nice-modal-react';
import { render, screen } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { describe, expect, it } from 'vitest';

import { CloneRepoDialog } from './CloneRepoDialog';

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
});
