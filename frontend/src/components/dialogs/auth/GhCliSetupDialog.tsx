import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { defineModal, getErrorMessage } from '@/lib/modals';
import { attemptsApi } from '@/lib/api';
import type { GhCliSetupError } from 'shared/types';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2 } from 'lucide-react';
interface GhCliSetupDialogProps {
  attemptId: string;
}

export type GhCliSupportVariant = 'homebrew' | 'manual';

export interface GhCliSupportContent {
  message: string;
  variant: GhCliSupportVariant | null;
}

export const mapGhCliErrorToUi = (
  error: GhCliSetupError | null,
  fallbackMessage: string
): GhCliSupportContent => {
  if (!error) {
    return { message: fallbackMessage, variant: null };
  }

  if (error === 'BREW_MISSING') {
    return {
      message: i18n.t('dialogs:ghCliSetup.brewMissing'),
      variant: 'homebrew',
    };
  }

  if (error === 'SETUP_HELPER_NOT_SUPPORTED') {
    return {
      message: i18n.t('dialogs:ghCliSetup.helperNotSupported'),
      variant: 'manual',
    };
  }

  if (typeof error === 'object' && 'OTHER' in error) {
    return {
      message: error.OTHER.message || fallbackMessage,
      variant: null,
    };
  }

  return { message: fallbackMessage, variant: null };
};

export const GhCliHelpInstructions = ({
  variant,
}: {
  variant: GhCliSupportVariant;
}) => {
  const { t } = useTranslation(['dialogs', 'common']);

  if (variant === 'homebrew') {
    return (
      <div className="space-y-2 text-sm">
        <p>
          {t('ghCliSetup.homebrewIntroBefore')}{' '}
          <a
            href="https://brew.sh/"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            {'brew.sh'}
          </a>{' '}
          {t('ghCliSetup.homebrewIntroAfter')}
        </p>
        <pre className="rounded bg-muted px-2 py-1 text-xs">
          brew install gh
        </pre>
        <p>
          {t('ghCliSetup.homebrewAuthPrompt')}
          <br />
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            gh auth login --web --git-protocol https
          </code>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 text-sm">
      <p>
        {t('ghCliSetup.manualIntroBefore')}{' '}
        <a
          href="https://cli.github.com/"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          {t('ghCliSetup.manualDocsLinkText')}
        </a>{' '}
        {t('ghCliSetup.manualIntroAfter')}
      </p>
      <pre className="rounded bg-muted px-2 py-1 text-xs">
        gh auth login --web --git-protocol https
      </pre>
    </div>
  );
};

const GhCliSetupDialogImpl = NiceModal.create<GhCliSetupDialogProps>(
  ({ attemptId }) => {
    const modal = useModal();
    const { t } = useTranslation(['dialogs', 'common']);
    const [isRunning, setIsRunning] = useState(false);
    const [errorInfo, setErrorInfo] = useState<{
      error: GhCliSetupError;
      message: string;
      variant: GhCliSupportVariant | null;
    } | null>(null);
    const pendingResultRef = useRef<GhCliSetupError | null>(null);
    const hasResolvedRef = useRef(false);

    const handleRunSetup = async () => {
      setIsRunning(true);
      setErrorInfo(null);
      pendingResultRef.current = null;

      try {
        await attemptsApi.setupGhCli(attemptId);
        hasResolvedRef.current = true;
        modal.resolve(null);
        modal.hide();
      } catch (err: unknown) {
        const rawMessage =
          getErrorMessage(err) || t('ghCliSetup.runFailed');

        const maybeErrorData =
          typeof err === 'object' && err !== null && 'error_data' in err
            ? (err as { error_data?: unknown }).error_data
            : undefined;

        const isGhCliSetupError = (x: unknown): x is GhCliSetupError =>
          x === 'BREW_MISSING' ||
          x === 'SETUP_HELPER_NOT_SUPPORTED' ||
          (typeof x === 'object' && x !== null && 'OTHER' in x);

        const errorData = isGhCliSetupError(maybeErrorData)
          ? maybeErrorData
          : undefined;

        const resolvedError: GhCliSetupError = errorData ?? {
          OTHER: { message: rawMessage },
        };
        const ui = mapGhCliErrorToUi(resolvedError, rawMessage);

        pendingResultRef.current = resolvedError;
        setErrorInfo({
          error: resolvedError,
          message: ui.message,
          variant: ui.variant,
        });
      } finally {
        setIsRunning(false);
      }
    };

    const handleClose = () => {
      if (!hasResolvedRef.current) {
        modal.resolve(pendingResultRef.current);
      }
      modal.hide();
    };

    return (
      <Dialog
        open={modal.visible}
        onOpenChange={(open) => !open && handleClose()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('ghCliSetup.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p>{t('ghCliSetup.description')}</p>

            <div className="space-y-2">
              <p className="text-sm">{t('ghCliSetup.setupWill')}</p>
              <ol className="text-sm list-decimal list-inside space-y-1 ml-2">
                <li>{t('ghCliSetup.step1')}</li>
                <li>{t('ghCliSetup.step2')}</li>
                <li>{t('ghCliSetup.step3')}</li>
              </ol>
              <p className="text-sm text-muted-foreground mt-4">
                {t('ghCliSetup.runNote')}
              </p>
            </div>
            {errorInfo && (
              <Alert variant="destructive">
                <AlertDescription className="space-y-2">
                  <p>{errorInfo.message}</p>
                  {errorInfo.variant && (
                    <GhCliHelpInstructions variant={errorInfo.variant} />
                  )}
                </AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button onClick={handleRunSetup} disabled={isRunning}>
              {isRunning ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('ghCliSetup.running')}
                </>
              ) : (
                t('ghCliSetup.runSetup')
              )}
            </Button>
            <Button
              variant="outline"
              onClick={handleClose}
              disabled={isRunning}
            >
              {t('common:close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

export const GhCliSetupDialog = defineModal<
  GhCliSetupDialogProps,
  GhCliSetupError | null
>(GhCliSetupDialogImpl);
