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
      message: '未安装 Homebrew。安装它以启用自动设置。',
      variant: 'homebrew',
    };
  }

  if (error === 'SETUP_HELPER_NOT_SUPPORTED') {
    return {
      message: '此平台不支持自动设置。请手动安装 GitHub CLI。',
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
  if (variant === 'homebrew') {
    return (
      <div className="space-y-2 text-sm">
        <p>
          {'自动安装需要 Homebrew。从'}{' '}
          <a
            href="https://brew.sh/"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            {'brew.sh'}
          </a>{' '}
          {
            '安装 Homebrew，然后重新运行设置。或者，使用以下命令手动安装 GitHub CLI：'
          }
        </p>
        <pre className="rounded bg-muted px-2 py-1 text-xs">
          brew install gh
        </pre>
        <p>
          {'安装后，使用以下命令进行身份验证：'}
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
        {'从'}{' '}
        <a
          href="https://cli.github.com/"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          {'官方文档'}
        </a>{' '}
        {'安装 GitHub CLI，然后使用您的 GitHub 账户进行身份验证。'}
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
        const rawMessage = getErrorMessage(err) || '运行 GitHub CLI 设置失败。';

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
            <DialogTitle>{'GitHub CLI 设置'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p>
              {'需要 GitHub CLI 身份验证才能创建拉取请求并与 GitHub 仓库交互。'}
            </p>

            <div className="space-y-2">
              <p className="text-sm">{'此设置将：'}</p>
              <ol className="text-sm list-decimal list-inside space-y-1 ml-2">
                <li>{'检查是否安装了 GitHub CLI (gh)'}</li>
                <li>{'如果需要，通过 Homebrew 安装它（macOS）'}</li>
                <li>{'使用 OAuth 进行 GitHub 身份验证'}</li>
              </ol>
              <p className="text-sm text-muted-foreground mt-4">
                {'设置将在聊天窗口中运行。您需要在浏览器中完成身份验证。'}
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
                  {'运行中...'}
                </>
              ) : (
                '运行设置'
              )}
            </Button>
            <Button
              variant="outline"
              onClick={handleClose}
              disabled={isRunning}
            >
              {'关闭'}
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
