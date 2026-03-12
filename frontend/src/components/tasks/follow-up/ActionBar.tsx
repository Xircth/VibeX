import {
  Loader2,
  Send,
  StopCircle,
  X,
  Paperclip,
  CheckSquare,
  FileSearch,
  Clock,
} from 'lucide-react';
import { useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { TerminalProfileControls } from '@/components/tasks/TerminalProfileControls';
import type { ExecutorConfig, ExecutorProfileId } from 'shared/types';

interface TodoItem {
  content: string;
  status: string;
}

interface ActionBarProps {
  profiles: Record<string, ExecutorConfig> | null;
  effectiveExecutorProfile: ExecutorProfileId | null;
  onChangeExecutorProfile: (profile: ExecutorProfileId | null) => void;
  isEditable: boolean;
  isAttemptRunning: boolean;
  isQueued: boolean;
  isQueueLoading: boolean;
  isStopping: boolean;
  isSendingFollowUp: boolean;
  canSendFollowUp: boolean;
  sessionId?: string;
  localMessage: string;
  conflictResolutionInstructions: string | null;
  reviewMarkdown: string | null;
  clickedMarkdown: string | null;
  todos: TodoItem[];
  comments: unknown[];
  onQueueMessage: () => void;
  onCancelQueue: () => void;
  onStopExecution: () => void;
  onSendFollowUp: () => void;
  onClearComments: () => void;
  onReviewChanges: () => void;
  onPasteFiles: (files: File[]) => void;
}

export function ActionBar({
  profiles,
  effectiveExecutorProfile,
  onChangeExecutorProfile,
  isEditable,
  isAttemptRunning,
  isQueued,
  isQueueLoading,
  isStopping,
  isSendingFollowUp,
  canSendFollowUp,
  sessionId,
  localMessage,
  conflictResolutionInstructions,
  reviewMarkdown,
  clickedMarkdown,
  todos,
  comments,
  onQueueMessage,
  onCancelQueue,
  onStopExecution,
  onSendFollowUp,
  onClearComments,
  onReviewChanges,
  onPasteFiles,
}: ActionBarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []).filter((f) =>
        f.type.startsWith('image/')
      );
      if (files.length > 0) {
        onPasteFiles(files);
      }
      e.target.value = '';
    },
    [onPasteFiles]
  );

  const hasQueueableContent =
    localMessage.trim() ||
    conflictResolutionInstructions ||
    reviewMarkdown ||
    clickedMarkdown;

  return (
    <div className="flex flex-wrap gap-1 items-center pt-1 border-t border-border/50">
      <TerminalProfileControls
        profiles={profiles}
        selectedProfile={effectiveExecutorProfile}
        onChange={onChangeExecutorProfile}
        disabled={!isEditable}
        lockExecutor={true}
        className="flex flex-wrap gap-1 items-center"
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
      />

      <Button
        onClick={handleAttachClick}
        disabled={!isEditable}
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0"
        title="Attach image"
        aria-label="Attach image"
      >
        <Paperclip className="h-3.5 w-3.5" />
      </Button>

      <Button
        onClick={onReviewChanges}
        disabled={!isEditable || !sessionId}
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0"
        title="Review Changes"
        aria-label="Review Changes"
      >
        <FileSearch className="h-3.5 w-3.5" />
      </Button>

      <Popover>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            title="查看待办事项"
            className={cn('h-7 w-7 p-0', todos.length === 0 && 'opacity-50')}
          >
            <CheckSquare className="h-3.5 w-3.5" />
            {todos.length > 0 && (
              <span className="ml-0.5 text-[10px]">{todos.length}</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-2">
          {todos.length === 0 ? (
            <div className="text-xs text-muted-foreground py-2 text-center">
              暂无待办事项
            </div>
          ) : (
            <>
              <div className="text-xs font-medium mb-1.5">
                待办事项 ({todos.length})
              </div>
              <ul className="space-y-1 max-h-48 overflow-auto">
                {todos.map((todo, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs">
                    <span
                      className={`shrink-0 mt-0.5 ${
                        todo.status === 'completed'
                          ? 'text-green-500'
                          : todo.status === 'in_progress' ||
                              todo.status === 'in-progress'
                            ? 'text-blue-500'
                            : 'text-muted-foreground'
                      }`}
                    >
                      {todo.status === 'completed'
                        ? '\u2713'
                        : todo.status === 'in_progress' ||
                            todo.status === 'in-progress'
                          ? '\u25CF'
                          : '\u25CB'}
                    </span>
                    <span
                      className={
                        todo.status === 'cancelled'
                          ? 'line-through text-muted-foreground'
                          : ''
                      }
                    >
                      {todo.content}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </PopoverContent>
      </Popover>

      <div className="flex-1" />

      {isAttemptRunning ? (
        <div className="flex items-center gap-1">
          {isQueued ? (
            <Button
              onClick={onCancelQueue}
              disabled={isQueueLoading || !sessionId}
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
            >
              {isQueueLoading ? (
                <Loader2 className="animate-spin h-3.5 w-3.5" />
              ) : (
                <>
                  <X className="h-3.5 w-3.5 mr-1" />
                  {'取消队列'}
                </>
              )}
            </Button>
          ) : (
            <Button
              onClick={onQueueMessage}
              disabled={isQueueLoading || !sessionId || !hasQueueableContent}
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
            >
              {isQueueLoading ? (
                <Loader2 className="animate-spin h-3.5 w-3.5" />
              ) : (
                <>
                  <Clock className="h-3.5 w-3.5 mr-1" />
                  {'队列'}
                </>
              )}
            </Button>
          )}
          <Button
            onClick={onStopExecution}
            disabled={isStopping}
            size="sm"
            variant="destructive"
            className="h-7 px-2 text-xs"
          >
            {isStopping ? (
              <Loader2 className="animate-spin h-3.5 w-3.5" />
            ) : (
              <>
                <StopCircle className="h-3.5 w-3.5 mr-1" />
                {'停止'}
              </>
            )}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          {comments.length > 0 && (
            <Button
              onClick={onClearComments}
              size="sm"
              variant="destructive"
              disabled={!isEditable}
              className="h-7 px-2 text-xs"
            >
              {'清除审查'}
            </Button>
          )}
          <Button
            onClick={onSendFollowUp}
            disabled={!canSendFollowUp || !isEditable}
            size="sm"
            className="h-7 px-2 text-xs rounded-lg"
          >
            {isSendingFollowUp ? (
              <Loader2 className="animate-spin h-3.5 w-3.5" />
            ) : (
              <>
                <Send className="h-3.5 w-3.5 mr-1" />
                {conflictResolutionInstructions ? '解决冲突' : '发送'}
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
