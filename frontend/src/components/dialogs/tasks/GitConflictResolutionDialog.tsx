import { useMemo, useState } from 'react';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { AlertTriangle, Copy, SendHorizonal } from 'lucide-react';
import type {
  BaseCodingAgent,
  ConflictOp,
  ExecutorProfileId,
} from 'shared/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { defineModal } from '@/lib/modals';
import { buildResolveConflictsInstructions } from '@/lib/conflicts';
import { useTaskAttemptWithSession } from '@/hooks/useTaskAttempt';
import { useExecutionProcesses } from '@/hooks/useExecutionProcesses';
import { useUserSystem } from '@/components/ConfigProvider';
import { getFirstAvailableProfile, getLatestProfileFromProcesses } from '@/utils/executor';
import { sessionsApi } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';

export interface GitConflictResolutionDialogProps {
  workspaceId: string;
  sourceBranch: string | null;
  targetBranch: string;
  conflictedFiles: string[];
  op?: ConflictOp | null;
  repoName?: string;
}

export type GitConflictResolutionDialogResult = {
  action: 'sent' | 'canceled';
};

const GitConflictResolutionDialogImpl =
  NiceModal.create<GitConflictResolutionDialogProps>(
    ({
      workspaceId,
      sourceBranch,
      targetBranch,
      conflictedFiles,
      op = null,
      repoName,
    }) => {
      const modal = useModal();
      const queryClient = useQueryClient();
      const { config, profiles } = useUserSystem();
      const { data: attempt } = useTaskAttemptWithSession(workspaceId);
      const { executionProcesses } = useExecutionProcesses(attempt?.session?.id);
      const [isSending, setIsSending] = useState(false);
      const [isCopying, setIsCopying] = useState(false);
      const [error, setError] = useState<string | null>(null);

      const instructions = useMemo(
        () =>
          buildResolveConflictsInstructions(
            sourceBranch,
            targetBranch,
            conflictedFiles,
            op,
            repoName
          ),
        [conflictedFiles, op, repoName, sourceBranch, targetBranch]
      );

      const executorProfile = useMemo<ExecutorProfileId | null>(() => {
        const latestProfile = getLatestProfileFromProcesses(executionProcesses);
        if (latestProfile) return latestProfile;
        if (attempt?.session?.executor) {
          return {
            executor: attempt.session.executor as BaseCodingAgent,
            variant: null,
          };
        }
        if (config?.executor_profile) return config.executor_profile;
        return getFirstAvailableProfile(profiles);
      }, [
        attempt?.session?.executor,
        config?.executor_profile,
        executionProcesses,
        profiles,
      ]);

      const handleClose = () => {
        modal.resolve({ action: 'canceled' } as GitConflictResolutionDialogResult);
        modal.hide();
      };

      const handleCopy = async () => {
        try {
          setIsCopying(true);
          await navigator.clipboard.writeText(instructions);
        } catch (copyError) {
          const copyMessage =
            copyError instanceof Error ? copyError.message : 'Unknown error';
          setError(`Failed to copy conflict instructions: ${copyMessage}`);
        } finally {
          setIsCopying(false);
        }
      };

      const handleSendToAi = async () => {
        if (!executorProfile) {
          setError('No available AI executor profile was found.');
          return;
        }

        try {
          setIsSending(true);
          setError(null);

          let sessionId = attempt?.session?.id;
          if (!sessionId) {
            const session = await sessionsApi.create({
              workspace_id: workspaceId,
              executor: executorProfile.executor,
            });
            sessionId = session.id;
          }

          await sessionsApi.followUp(sessionId, {
            prompt: instructions,
            executor_profile_id: executorProfile,
            retry_process_id: null,
            force_when_dirty: null,
            perform_git_reset: null,
          });

          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: ['workspaceSessions', workspaceId],
            }),
            queryClient.invalidateQueries({
              queryKey: ['taskAttemptWithSession', workspaceId],
            }),
          ]);

          modal.resolve({ action: 'sent' } as GitConflictResolutionDialogResult);
          modal.hide();
        } catch (sendError) {
          const sendMessage =
            sendError instanceof Error ? sendError.message : 'Unknown error';
          setError(`Failed to send conflict instructions to AI: ${sendMessage}`);
        } finally {
          setIsSending(false);
        }
      };

      return (
        <Dialog open={modal.visible} onOpenChange={(open) => !open && handleClose()}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-warning" />
                Resolve rebase conflicts with AI
              </DialogTitle>
              <DialogDescription>
                A Git operation hit conflicts. Review the generated template below,
                then send it to AI so it can resolve the conflicted files and continue
                the rebase onto the target branch.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
                <div className="font-medium">
                  Target branch: <span className="font-mono">{targetBranch}</span>
                </div>
                {repoName && (
                  <div className="mt-1 text-muted-foreground">
                    Repository: <span className="font-mono">{repoName}</span>
                  </div>
                )}
                <div className="mt-2 text-muted-foreground">
                  Conflicted files: {conflictedFiles.length}
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium">Prompt template</div>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-xs leading-5">
                  {instructions}
                </pre>
              </div>

              {error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={handleClose}
                disabled={isSending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleCopy}
                disabled={isCopying || isSending}
              >
                <Copy className="mr-2 h-4 w-4" />
                {isCopying ? 'Copying...' : 'Copy template'}
              </Button>
              <Button
                type="button"
                onClick={handleSendToAi}
                disabled={isSending}
              >
                <SendHorizonal className="mr-2 h-4 w-4" />
                {isSending ? 'Sending...' : 'Send to AI'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      );
    }
  );

export const GitConflictResolutionDialog = defineModal<
  GitConflictResolutionDialogProps,
  GitConflictResolutionDialogResult
>(GitConflictResolutionDialogImpl);
