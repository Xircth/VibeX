import type { ComponentType } from 'react';
import NiceModal, { type NiceModalHocProps } from '@ebay/nice-modal-react';
import { render, screen } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { describe, expect, it } from 'vitest';

import {
  ResendCheckpointDialog,
  type ResendCheckpointDialogProps,
} from './ResendCheckpointDialog';

describe('ResendCheckpointDialog', () => {
  it('renders one bounded dialog material without a nested glass renderer', async () => {
    const Dialog = ResendCheckpointDialog as ComponentType<
      ResendCheckpointDialogProps & NiceModalHocProps
    >;

    const { container } = render(
      <HotkeysProvider initiallyActiveScopes={['dialog', 'kanban', 'projects']}>
        <NiceModal.Provider>
          <Dialog
            id="resend-checkpoint-test"
            defaultVisible
            title="重发这条消息"
            files={[]}
          />
        </NiceModal.Provider>
      </HotkeysProvider>
    );

    await screen.findByText('重发这条消息');

    const surface = container.querySelector('.dialog-surface');
    expect(surface).not.toBeNull();
    expect(surface?.querySelector('.glass')).toBeNull();
    expect(container.querySelectorAll('.dialog-surface')).toHaveLength(1);
  });
});
