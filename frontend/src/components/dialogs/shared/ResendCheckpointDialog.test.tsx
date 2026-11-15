import type { ComponentType } from 'react';
import NiceModal, { type NiceModalHocProps } from '@ebay/nice-modal-react';
import { fireEvent, render, screen } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';

import {
  ResendCheckpointDialog,
  shouldConfirmResendCheckpoint,
  type ResendCheckpointDialogProps,
} from './ResendCheckpointDialog';

const Dialog = ResendCheckpointDialog as ComponentType<
  ResendCheckpointDialogProps & NiceModalHocProps
>;

describe('shouldConfirmResendCheckpoint', () => {
  it('skips the dialog when rollback would change no files and safety is safe', () => {
    expect(
      shouldConfirmResendCheckpoint({
        files: [],
        previewUnavailable: false,
        safetyReport: { status: 'safe', engineSupportsRevert: true },
      })
    ).toBe(false);
  });

  it('asks before resend when files would roll back', () => {
    expect(
      shouldConfirmResendCheckpoint({
        files: [
          {
            path: 'src/app.ts',
            change_kind: 'modified',
          },
        ],
        previewUnavailable: false,
      })
    ).toBe(true);
  });

  it('asks before resend when rollback files cannot be previewed', () => {
    expect(
      shouldConfirmResendCheckpoint({
        files: [],
        previewUnavailable: true,
      })
    ).toBe(true);
  });

  it('asks before resend when safety report is degraded or unsafe even with zero file diff', () => {
    expect(
      shouldConfirmResendCheckpoint({
        files: [],
        previewUnavailable: false,
        safetyReport: { status: 'degraded', reason: 'ACP continuation' },
      })
    ).toBe(true);
    expect(
      shouldConfirmResendCheckpoint({
        files: [],
        previewUnavailable: false,
        safetyReport: { status: 'unsafe', reason: 'Workspace lease conflict' },
      })
    ).toBe(true);
  });
});

describe('ResendCheckpointDialog', () => {
  it('renders one bounded dialog material without a nested glass renderer', async () => {
    const { container } = render(
      <HotkeysProvider
        initiallyActiveScopes={['dialog', 'kanban', 'projects']}
      >
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

  it('renders Safe state with restore button enabled and engine memory rewind description', async () => {
    render(
      <HotkeysProvider
        initiallyActiveScopes={['dialog', 'kanban', 'projects']}
      >
        <NiceModal.Provider>
          <Dialog
            id="resend-checkpoint-safe"
            defaultVisible
            title="重发这条消息"
            files={[{ path: 'src/index.ts', change_kind: 'modified' }]}
            safetyReport={{ status: 'safe', engineSupportsRevert: true }}
          />
        </NiceModal.Provider>
      </HotkeysProvider>
    );

    await screen.findByText(
      i18n.t('panels:timeline.restoreAndResendSafeDescription')
    );
    const restoreBtn = screen.getByTestId('resend-checkpoint-restore-btn');
    expect(restoreBtn).not.toBeDisabled();
    expect(screen.queryByTestId('rollback-safety-degraded')).toBeNull();
    expect(screen.queryByTestId('rollback-safety-unsafe')).toBeNull();
  });

  it('renders Degraded state with explicit file-only continuation notice and enabled restore button', async () => {
    render(
      <HotkeysProvider
        initiallyActiveScopes={['dialog', 'kanban', 'projects']}
      >
        <NiceModal.Provider>
          <Dialog
            id="resend-checkpoint-degraded"
            defaultVisible
            title="重发这条消息"
            files={[{ path: 'src/index.ts', change_kind: 'modified' }]}
            safetyReport={{
              status: 'degraded',
              reason: 'ACP 引擎不支持会话内存回退',
            }}
          />
        </NiceModal.Provider>
      </HotkeysProvider>
    );

    const degradedBanner = await screen.findByTestId(
      'rollback-safety-degraded'
    );
    expect(degradedBanner).toHaveTextContent(
      i18n.t('panels:timeline.rollbackDegradedNotice')
    );
    expect(degradedBanner).toHaveTextContent('ACP 引擎不支持会话内存回退');

    const restoreBtn = screen.getByTestId('resend-checkpoint-restore-btn');
    expect(restoreBtn).not.toBeDisabled();
  });

  it('renders Unsafe state with blocking reason and disables confirm rollback button', async () => {
    let resolvedChoice: string | null = null;

    function TriggerHarness() {
      return (
        <button
          type="button"
          data-testid="open-unsafe"
          onClick={() => {
            void ResendCheckpointDialog.show({
              title: '重发这条消息',
              files: [{ path: 'src/index.ts', change_kind: 'modified' }],
              safetyReport: {
                status: 'unsafe',
                reason: '其他活跃线程正在使用此工作区',
              },
            }).then((res) => {
              resolvedChoice = res;
            });
          }}
        >
          open
        </button>
      );
    }

    render(
      <HotkeysProvider
        initiallyActiveScopes={['dialog', 'kanban', 'projects']}
      >
        <NiceModal.Provider>
          <TriggerHarness />
        </NiceModal.Provider>
      </HotkeysProvider>
    );

    fireEvent.click(screen.getByTestId('open-unsafe'));

    const unsafeBanner = await screen.findByTestId('rollback-safety-unsafe');
    expect(unsafeBanner).toHaveTextContent(
      i18n.t('panels:timeline.rollbackUnsafeTitle')
    );
    expect(unsafeBanner).toHaveTextContent('其他活跃线程正在使用此工作区');

    const restoreBtn = screen.getByTestId('resend-checkpoint-restore-btn');
    expect(restoreBtn).toBeDisabled();

    fireEvent.click(restoreBtn);
    expect(resolvedChoice).toBeNull();
  });
});
