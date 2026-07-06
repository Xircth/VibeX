import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import WYSIWYGEditor, {
  SESSION_INPUT_EDITOR_CLASS_NAME,
  SESSION_INPUT_MARKDOWN_PRESET,
} from '@/components/ui/wysiwyg';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Loader2, Send, X } from 'lucide-react';
import type { WorkspaceWithSession } from '@/types/attempt';
import { useAttemptExecution } from '@/hooks/useAttemptExecution';
import { useBranchStatus } from '@/hooks/useBranchStatus';
import { useRetryProcess } from '@/hooks/useRetryProcess';
import { extractProfileFromAction } from '@/utils/executor';

export function RetryEditorInline({
  attempt,
  executionProcessId,
  initialContent,
  onCancelled,
}: {
  attempt: WorkspaceWithSession;
  executionProcessId: string;
  initialContent: string;
  onCancelled?: () => void;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const attemptId = attempt.id;
  const { isAttemptRunning, attemptData } = useAttemptExecution(attemptId);
  const { data: branchStatus } = useBranchStatus(attemptId);

  const [message, setMessage] = useState(initialContent);
  const [sendError, setSendError] = useState<string | null>(null);
  const sessionId = attempt.session?.id;

  const processProfile = useMemo(() => {
    const process = attemptData.processes?.find(
      (p) => p.id === executionProcessId
    );
    if (!process?.executor_action) return null;
    return extractProfileFromAction(process.executor_action);
  }, [attemptData.processes, executionProcessId]);

  const retryMutation = useRetryProcess(
    attemptId,
    sessionId ?? '',
    () => onCancelled?.(),
    (err) => setSendError((err as Error)?.message || 'Failed to send retry')
  );

  const isSending = retryMutation.isPending;
  const canSend =
    !isAttemptRunning && !!message.trim() && !!sessionId && !!processProfile;

  const onCancel = () => {
    onCancelled?.();
  };

  const onSend = useCallback(() => {
    if (!canSend || !processProfile) return;
    setSendError(null);
    retryMutation.mutate({
      message,
      executor: processProfile.executor,
      variant: processProfile.variant ?? null,
      executionProcessId,
      branchStatus,
      processes: attemptData.processes,
    });
  }, [
    canSend,
    retryMutation,
    message,
    processProfile,
    executionProcessId,
    branchStatus,
    attemptData.processes,
  ]);

  const handleCmdEnter = useCallback(() => {
    if (canSend && !isSending) {
      onSend();
    }
  }, [canSend, isSending, onSend]);

  return (
    <div className="retry-editor-inline space-y-3">
      <div className="relative">
        <WYSIWYGEditor
          placeholder={t('retryEditor.placeholder')}
          value={message}
          onChange={setMessage}
          disabled={isSending}
          onCmdEnter={handleCmdEnter}
          className={cn(
            SESSION_INPUT_EDITOR_CLASS_NAME,
            'retry-editor-input'
          )}
          markdownPreset={SESSION_INPUT_MARKDOWN_PRESET}
          taskAttemptId={attemptId}
        />
        {isSending && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg bg-background/60">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSending}
          className="h-9 min-w-20 gap-1.5"
        >
          <X className="h-3.5 w-3.5" />
          {t('common:cancel')}
        </Button>
        <Button
          type="button"
          onClick={onSend}
          disabled={!canSend || isSending}
          title={t('retryEditor.retryHere')}
          aria-label={t('retryEditor.retryHere')}
          className="h-9 min-w-20 gap-1.5"
        >
          <Send className="h-3.5 w-3.5" />
          {t('retryEditor.send')}
        </Button>
      </div>

      {sendError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{sendError}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
