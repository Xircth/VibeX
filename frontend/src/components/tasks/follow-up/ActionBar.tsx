import {
  Archive,
  CheckSquare,
  Clock,
  Lightbulb,
  Loader2,
  Paperclip,
  Send,
  StopCircle,
  X,
} from 'lucide-react';
import { useCallback, useRef, type ChangeEvent } from 'react';
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
  showProfileControls?: boolean;
  isAwaitingNewSessionConfirmation?: boolean;
  isEditable: boolean;
  isAttemptRunning: boolean;
  isQueued: boolean;
  isQueueLoading: boolean;
  canCompactContext: boolean;
  isCompactingContext: boolean;
  isStopping: boolean;
  isSendingFollowUp: boolean;
  canSendFollowUp: boolean;
  promptEnhancementEnabled: boolean;
  isEnhancingPrompt: boolean;
  canEnhancePrompt: boolean;
  sessionId?: string;
  localMessage: string;
  conflictResolutionInstructions: string | null;
  reviewMarkdown: string | null;
  todos: TodoItem[];
  comments: unknown[];
  onCompactContext: () => void;
  onQueueMessage: () => void;
  onCancelQueue: () => void;
  onStopExecution: () => void;
  onSendFollowUp: () => void;
  onEnhancePrompt: () => void;
  onClearComments: () => void;
  onPasteFiles: (files: File[]) => void;
}

export function ActionBar({
  profiles,
  effectiveExecutorProfile,
  onChangeExecutorProfile,
  showProfileControls = true,
  isAwaitingNewSessionConfirmation = false,
  isEditable,
  isAttemptRunning,
  isQueued,
  isQueueLoading,
  canCompactContext,
  isCompactingContext,
  isStopping,
  isSendingFollowUp,
  canSendFollowUp,
  promptEnhancementEnabled,
  isEnhancingPrompt,
  canEnhancePrompt,
  sessionId,
  localMessage,
  conflictResolutionInstructions,
  reviewMarkdown,
  todos,
  comments,
  onCompactContext,
  onQueueMessage,
  onCancelQueue,
  onStopExecution,
  onSendFollowUp,
  onEnhancePrompt,
  onClearComments,
  onPasteFiles,
}: ActionBarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []).filter((file) =>
        file.type.startsWith('image/')
      );
      if (files.length > 0) {
        onPasteFiles(files);
      }
      event.target.value = '';
    },
    [onPasteFiles]
  );

  const hasQueueableContent =
    localMessage.trim() || conflictResolutionInstructions || reviewMarkdown;

  return (
    <div className="flex flex-wrap items-center gap-1 border-t border-border/50 pt-1">
      {showProfileControls ? (
        <TerminalProfileControls
          profiles={profiles}
          selectedProfile={effectiveExecutorProfile}
          onChange={onChangeExecutorProfile}
          disabled={!isEditable}
          lockExecutor={true}
          iconOnly={true}
          dropdownSide="top"
          className="flex flex-wrap items-center gap-1"
        />
      ) : null}

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
        title={'\u9644\u52a0\u56fe\u7247'}
        aria-label={'\u9644\u52a0\u56fe\u7247'}
      >
        <Paperclip className="h-3.5 w-3.5" />
      </Button>

      <Button
        onClick={onCompactContext}
        disabled={!canCompactContext || isCompactingContext}
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0"
        title={'压缩上下文'}
        aria-label={'压缩上下文'}
      >
        {isCompactingContext ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Archive className="h-3.5 w-3.5" />
        )}
      </Button>

      {promptEnhancementEnabled ? (
        <Button
          onClick={onEnhancePrompt}
          disabled={!canEnhancePrompt || isEnhancingPrompt}
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          title={'\u63d0\u793a\u8bcd\u4f18\u5316'}
          aria-label={'\u63d0\u793a\u8bcd\u4f18\u5316'}
        >
          {isEnhancingPrompt ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Lightbulb className="h-3.5 w-3.5" />
          )}
        </Button>
      ) : null}

      <div className="hidden">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              title={'\u67e5\u770b\u5f85\u529e\u4e8b\u9879'}
              className={cn('h-7 w-7 p-0', todos.length === 0 && 'opacity-50')}
            >
              <CheckSquare className="h-3.5 w-3.5" />
              {todos.length > 0 ? (
                <span className="ml-0.5 text-[10px]">{todos.length}</span>
              ) : null}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-2">
            {todos.length === 0 ? (
              <div className="py-2 text-center text-xs text-muted-foreground">
                {'\u6682\u65e0\u5f85\u529e\u4e8b\u9879'}
              </div>
            ) : (
              <>
                <div className="mb-1.5 text-xs font-medium">
                  {'\u5f85\u529e\u4e8b\u9879'} ({todos.length})
                </div>
                <ul className="max-h-48 space-y-1 overflow-auto">
                  {todos.map((todo, index) => (
                    <li
                      key={index}
                      className="flex items-start gap-1.5 text-xs"
                    >
                      <span
                        className={cn(
                          'mt-0.5 shrink-0',
                          todo.status === 'completed'
                            ? 'text-green-500'
                            : todo.status === 'in_progress' ||
                                todo.status === 'in-progress'
                              ? 'text-blue-500'
                              : 'text-muted-foreground'
                        )}
                      >
                        {todo.status === 'completed'
                          ? '\u2713'
                          : todo.status === 'in_progress' ||
                              todo.status === 'in-progress'
                            ? '\u25cf'
                            : '\u25cb'}
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
      </div>

      <div className="flex-1" />

      {isAttemptRunning ? (
        <div className="flex items-center gap-1">
          {!isCompactingContext
            ? isQueued
              ? (
                  <Button
                    onClick={onCancelQueue}
                    disabled={isQueueLoading || !sessionId}
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                  >
                    {isQueueLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <>
                        <X className="mr-1 h-3.5 w-3.5" />
                        {'\u53d6\u6d88\u961f\u5217'}
                      </>
                    )}
                  </Button>
                )
              : (
                  <Button
                    onClick={onQueueMessage}
                    disabled={
                      isQueueLoading || !sessionId || !hasQueueableContent
                    }
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                  >
                    {isQueueLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <>
                        <Clock className="mr-1 h-3.5 w-3.5" />
                        {'\u961f\u5217'}
                      </>
                    )}
                  </Button>
                )
            : null}
          <Button
            onClick={onStopExecution}
            disabled={isStopping}
            size="sm"
            variant="destructive"
            className="h-7 px-2 text-xs"
          >
            {isStopping ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <>
                <StopCircle className="mr-1 h-3.5 w-3.5" />
                {'\u505c\u6b62'}
              </>
            )}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          {comments.length > 0 ? (
            <Button
              onClick={onClearComments}
              size="sm"
              variant="destructive"
              disabled={!isEditable}
              className="h-7 px-2 text-xs"
            >
              {'\u6e05\u9664\u5ba1\u67e5'}
            </Button>
          ) : null}
          <Button
            onClick={onSendFollowUp}
            disabled={
              !canSendFollowUp ||
              !isEditable ||
              isAwaitingNewSessionConfirmation
            }
            size="sm"
            className="h-7 rounded-lg px-2 text-xs"
          >
            {isSendingFollowUp ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <>
                <Send className="mr-1 h-3.5 w-3.5" />
                {conflictResolutionInstructions
                  ? '\u89e3\u51b3\u51b2\u7a81'
                  : '\u53d1\u9001'}
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
